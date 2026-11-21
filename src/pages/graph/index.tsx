import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Spin,
  Empty,
  theme as antdTheme,
  Segmented,
  Tooltip,
  Button,
  message,
} from "antd";
import { listen } from "@tauri-apps/api/event";
import {
  Maximize2,
  Minimize2,
  RotateCcw,
  ExternalLink,
  Crosshair,
  ArrowLeft,
} from "lucide-react";
import { Graph } from "@antv/g6";
import { linkApi, llmGraphApi } from "@/lib/api";
import type { GraphData, LlmGraphData, LlmGraphProgress } from "@/types";
import { useContextMenu } from "@/hooks/useContextMenu";
import {
  ContextMenuOverlay,
  type ContextMenuEntry,
} from "@/components/ui/ContextMenuOverlay";
import {
  ExtractionProgress,
  entityTypeColor,
} from "@/components/graph/LlmGraphUi";

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = antdTheme.useToken();

  // ?folder=<id> → 只看该文件夹及其子文件夹；无参数 = 全库
  const folderId = useMemo<number | null>(() => {
    const raw = searchParams.get("folder");
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [searchParams]);

  // ?note=<id> → 单篇文档图谱（强制 LLM 模式）
  const noteId = useMemo<number | null>(() => {
    const raw = searchParams.get("note");
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [searchParams]);

  const [mode, setMode] = useState<"rule" | "llm">(
    noteId != null ? "llm" : "rule",
  );
  const [ruleLoading, setRuleLoading] = useState(true);
  const [llmLoading, setLlmLoading] = useState(false);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [llmData, setLlmData] = useState<LlmGraphData | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState<LlmGraphProgress | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");

  // 当前作用域文件夹名（从返回的 folder 节点里取；拿不到时退化为 id）
  const scopeFolder = useMemo(() => {
    if (folderId == null) return null;
    const node = graphData?.nodes.find(
      (n) => n.node_type === "folder" && n.id === folderId,
    );
    return node?.title ?? `文件夹 #${folderId}`;
  }, [folderId, graphData]);

  // LLM 图谱作用域标题：单篇文档优先，其次文件夹，最后全库
  const llmScopeTitle = useMemo(() => {
    if (noteId != null) {
      const title = llmData?.note_titles[0];
      return `文档「${title ?? `#${noteId}`}」图谱`;
    }
    if (folderId != null) {
      return `文件夹「${scopeFolder ?? `#${folderId}`}」图谱`;
    }
    if (llmData && llmData.note_count === 1 && llmData.note_titles[0]) {
      return `文档「${llmData.note_titles[0]}」图谱`;
    }
    return "全库图谱";
  }, [noteId, folderId, scopeFolder, llmData]);

  const llmSourceHint = useMemo(() => {
    if (!llmData || llmData.note_count === 0) return null;
    const titles = llmData.note_titles.slice(0, 3);
    const more = llmData.note_count - titles.length;
    const suffix = titles.length
      ? `（${titles.join("、")}${more > 0 ? ` 等 ${more} 篇` : ""}）`
      : "";
    return `来源：${llmData.note_count} 篇文档${suffix}`;
  }, [llmData]);

  // ─── 节点右键菜单 ────────────────────────────
  // gid = G6 节点 id（带 n/f 前缀）；realId = 数据库真实 id；nodeType 决定菜单项
  const ctx = useContextMenu<{
    gid: string;
    realId: number;
    nodeType: "note" | "folder" | "entity";
    title: string;
    noteIds?: number[];
  }>();

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    const p = ctx.state.payload;
    if (!p) return [];
    const items: ContextMenuEntry[] = [];
    // 文件夹节点没有对应文档；实体节点打开首个来源文档
    if (p.nodeType === "note") {
      items.push({
        key: "open",
        label: "打开文档",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          navigate(`/notes/${p.realId}`);
        },
      });
    } else if (p.nodeType === "entity" && p.noteIds?.length) {
      items.push({
        key: "open-source",
        label: "打开来源文档",
        icon: <ExternalLink size={13} />,
        onClick: () => {
          ctx.close();
          navigate(`/notes/${p.noteIds![0]}`);
        },
      });
    }
    items.push({
      key: "focus",
      label: "居中此节点",
      icon: <Crosshair size={13} />,
      onClick: () => {
        ctx.close();
        // G6 v5：把指定节点移到视图中心
        try {
          graphRef.current?.focusElement(p.gid);
        } catch {
          // focusElement 可能在某些版本叫 focus；失败时退到 fitCenter
          graphRef.current?.fitCenter();
        }
      },
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.state.payload, navigate]);

  useEffect(() => {
    if (mode === "rule") {
      void loadRuleGraphData();
    } else {
      void loadLlmGraphData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, noteId, mode]);

  // 给 G6 画布容器原生挂 contextmenu capture-phase listener，吞 WebView 默认菜单。
  // G6 v5 的 canvas 内部会拦截 contextmenu 不冒泡到 React 外层 div，所以
  // 顶层 <div onContextMenu> 收不到画布空白处的右键事件。capture phase 的
  // 原生 listener 比 G6 内部 bubble-phase 监听器先触发，主动 preventDefault
  // 让 WebView 默认菜单不弹；节点的 graph.on("node:contextmenu") 仍然能跑
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", handler, true);
    return () => el.removeEventListener("contextmenu", handler, true);
  }, []);

  async function loadRuleGraphData() {
    setRuleLoading(true);
    try {
      const data = await linkApi.getGraphData(folderId);
      setGraphData(data);
    } catch (e) {
      console.error("加载文档关系失败:", e);
    } finally {
      setRuleLoading(false);
    }
  }

  async function loadLlmGraphData() {
    setLlmLoading(true);
    try {
      const data = await llmGraphApi.getGraphData(folderId, 3000, noteId);
      setLlmData(data);
    } catch (e) {
      console.error("加载 LLM 图谱失败:", e);
    } finally {
      setLlmLoading(false);
    }
  }

  async function handleExtract() {
    setExtracting(true);
    setProgress(null);
    const unlisten = await listen<LlmGraphProgress>(
      "llm-graph:progress",
      (e) => setProgress(e.payload),
    );
    try {
      if (noteId != null) {
        const r = await llmGraphApi.extractNote(noteId);
        message.success(
          `文档抽取完成：${r.entity_count} 个实体 / ${r.relation_count} 条关系`,
        );
      } else {
        const items = await llmGraphApi.extractFolder(folderId, 20);
        const ok = items.filter((i) => i.ok).length;
        message.success(`抽取完成：${ok}/${items.length} 篇成功`);
      }
      await loadLlmGraphData();
    } catch (e) {
      message.error(String(e));
    } finally {
      unlisten();
      setExtracting(false);
      window.setTimeout(() => setProgress(null), 1500);
    }
  }

  // 渲染图谱
  useEffect(() => {
    const active = mode === "llm" ? llmData : graphData;
    if (!containerRef.current || !active || active.nodes.length === 0) {
      return;
    }

    // 销毁旧实例
    if (graphRef.current) {
      graphRef.current.destroy();
      graphRef.current = null;
    }

    let nodes: any[];
    let edges: any[];

    if (mode === "llm") {
      // 实体节点 id 统一带 `e` 前缀
      nodes = (llmData?.nodes ?? []).map((n) => ({
        id: `e${n.id}`,
        data: {
          kind: "entity",
          label: n.name,
          entityType: n.entity_type,
          description: n.description,
          degree: n.degree,
          noteIds: n.note_ids,
          realId: n.id,
        },
      }));
      edges = (llmData?.edges ?? []).map((e, i) => ({
        id: `le-${i}`,
        source: `e${e.source}`,
        target: `e${e.target}`,
        data: {
          kind: "llm",
          description: e.description,
          keywords: e.keywords,
          noteIds: e.note_ids,
        },
      }));
    } else {
      // note 节点 id 加 `n` 前缀、folder 加 `f` 前缀——两表自增 id 可能相同，必须区分
      nodes = (graphData?.nodes ?? []).map((n) => ({
        id: (n.node_type === "folder" ? "f" : "n") + n.id,
        data: {
          kind: "rule",
          label: n.title,
          nodeType: n.node_type,
          realId: n.id,
          isDaily: n.is_daily,
          isPinned: n.is_pinned,
          tagCount: n.tag_count,
          linkCount: n.link_count,
          folderColor: n.color,
          // 文件夹范围外的关联文档：弱化显示，提示"它不属于当前范围"
          isBoundary: !!n.is_boundary,
        },
      }));
      // 按 edge_type 给两端拼对应前缀：
      //   link  n→n      folder_child  f→f      folder_note  f→n
      edges = (graphData?.edges ?? []).map((e, i) => ({
        id: `edge-${i}`,
        source: (e.edge_type === "link" ? "n" : "f") + e.source,
        target: (e.edge_type === "folder_child" ? "f" : "n") + e.target,
        data: { kind: "rule", edgeType: e.edge_type },
      }));
    }

    const graph = new Graph({
      container: containerRef.current,
      // 用对象写法：内容溢出才缩放（when: "overflow"），装得下就保持原尺寸；
      // 两者兼顾——首屏能看到全部节点，字也不会被无谓缩小
      autoFit: {
        type: "view",
        options: { when: "overflow", direction: "both" },
        animation: { duration: 300, easing: "ease-out" },
      },
      data: { nodes, edges },
      node: {
        // 文件夹用方形（rect）、文档用圆形（circle）——形状先于颜色区分两类节点
        type: (d: any) =>
          d.data?.kind === "entity"
            ? "circle"
            : d.data?.nodeType === "folder"
              ? "rect"
              : "circle",
        style: {
          size: (d: any) => {
            if (d.data?.kind === "entity") {
              const degree = d.data?.degree || 0;
              return Math.max(22, Math.min(46, 22 + degree * 3));
            }
            // 文件夹固定尺寸；文档按链接数放大
            if (d.data?.nodeType === "folder") return 30;
            const linkCount = d.data?.linkCount || 0;
            return Math.max(20, Math.min(52, 20 + linkCount * 6));
          },
          fill: (d: any) => {
            if (d.data?.kind === "entity")
              return entityTypeColor(d.data?.entityType || "", token);
            // 文件夹优先用自定义颜色，否则中性填充
            if (d.data?.nodeType === "folder")
              return d.data?.folderColor || token.colorFillSecondary;
            // 范围外边界文档：不参与配色，弱化为背景色
            if (d.data?.isBoundary) return token.colorBgContainer;
            if (d.data?.isDaily) return token.colorWarning;
            if (d.data?.isPinned) return token.colorError;
            if ((d.data?.linkCount || 0) > 3) return token.colorPrimary;
            return token.colorPrimaryBg;
          },
          stroke: (d: any) => {
            if (d.data?.kind === "entity")
              return entityTypeColor(d.data?.entityType || "", token);
            if (d.data?.nodeType === "folder")
              return d.data?.folderColor || token.colorBorder;
            if (d.data?.isBoundary) return token.colorTextQuaternary;
            if (d.data?.isDaily) return token.colorWarningBorder;
            if (d.data?.isPinned) return token.colorErrorBorder;
            return token.colorPrimaryBorder;
          },
          // 边界节点用虚线描边，与范围内实心节点区分
          lineDash: (d: any) =>
            d.data?.kind !== "entity" && d.data?.isBoundary ? [4, 3] : undefined,
          // 文件夹方块加圆角；圆形节点 radius 无副作用
          radius: (d: any) => (d.data?.nodeType === "folder" ? 6 : 0),
          lineWidth: 2,
          labelText: (d: any) => {
            const raw = d.data?.label || "";
            const label =
              d.data?.kind === "entity"
                ? raw
                : d.data?.nodeType === "folder"
                  ? `📁 ${raw}`
                  : raw;
            const limit = d.data?.kind === "entity" ? 14 : 12;
            return label.length > limit ? label.slice(0, limit) + "..." : label;
          },
          labelFontSize: 13,
          labelFontWeight: (d: any) =>
            d.data?.nodeType === "folder" ? 600 : 500,
          labelFill: (d: any) =>
            d.data?.isBoundary ? token.colorTextTertiary : token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 6,
        },
      },
      edge: {
        style: {
          // LLM 推断边：细实线带箭头；wiki 双链：实线带箭头；层级边：浅色虚线无箭头
          stroke: (d: any) =>
            d.data?.kind === "llm"
              ? token.colorInfo
              : d.data?.edgeType === "link"
                ? token.colorPrimary
                : token.colorTextQuaternary,
          strokeOpacity: (d: any) =>
            d.data?.kind === "llm"
              ? 0.35
              : d.data?.edgeType === "link"
                ? 0.45
                : 0.7,
          lineWidth: (d: any) =>
            d.data?.kind === "llm" ? 1 : d.data?.edgeType === "link" ? 1.5 : 1,
          lineDash: (d: any) =>
            d.data?.kind === "llm"
              ? undefined
              : d.data?.edgeType === "link"
                ? undefined
                : [4, 4],
          endArrow: (d: any) => d.data?.kind === "llm" || d.data?.edgeType === "link",
          endArrowSize: 8,
          endArrowFill: (d: any) =>
            d.data?.kind === "llm" ? token.colorInfo : token.colorPrimary,
        },
      },
      layout:
        layout === "d3-force"
          ? {
              // G6 v5 的 d3-force 走子对象 API（link / manyBody / collide / center）
              // 小图（<20 节点）用紧凑参数：节点不会散到画布外，autoFit 也就
              // 不需要缩放，字得以保持原尺寸
              type: "d3-force",
              link: { distance: 110, strength: 0.5 },
              manyBody: { strength: -180 },
              collide: { radius: 48, strength: 0.9 },
              center: { strength: 0.08 },
            }
          : layout === "radial"
            ? { type: "radial", unitRadius: 110, preventOverlap: true, nodeSize: 50 }
            : { type: layout },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        {
          type: "click-select",
          multiple: false,
        },
      ],
    });

    graph.render();

    // 双击：规则图谱的文档 → 打开文档；LLM 实体 → 打开首个来源文档
    graph.on("node:dblclick", (evt: any) => {
      const gid = String(evt.target?.id ?? "");
      if (mode === "llm") {
        const entity = llmData?.nodes.find((n) => `e${n.id}` === gid);
        if (entity?.note_ids.length) {
          navigate(`/notes/${entity.note_ids[0]}`);
        }
        return;
      }
      const node = graphData?.nodes.find(
        (n) => (n.node_type === "folder" ? "f" : "n") + n.id === gid,
      );
      if (node && node.node_type === "note") {
        navigate(`/notes/${node.id}`);
      }
    });

    // 节点右键弹自定义菜单
    graph.on("node:contextmenu", (evt: any) => {
      // 阻止 WebView 默认右键菜单（不同 G6 版本字段名可能不同，逐个试）
      const native: MouseEvent | undefined =
        evt?.nativeEvent ?? evt?.originalEvent ?? evt?.event;
      native?.preventDefault?.();
      const gid = String(evt?.target?.id ?? "");
      if (!gid) return;
      const x = native?.clientX ?? evt?.client?.x ?? 0;
      const y = native?.clientY ?? evt?.client?.y ?? 0;

      if (mode === "llm") {
        const entity = llmData?.nodes.find((n) => `e${n.id}` === gid);
        if (!entity) return;
        ctx.open(
          { clientX: x, clientY: y },
          {
            gid,
            realId: entity.id,
            nodeType: "entity",
            title: entity.name,
            noteIds: entity.note_ids,
          },
        );
        return;
      }

      const node = graphData?.nodes.find(
        (n) => (n.node_type === "folder" ? "f" : "n") + n.id === gid,
      );
      if (!node) return;
      ctx.open(
        { clientX: x, clientY: y },
        {
          gid,
          realId: node.id,
          nodeType: node.node_type,
          title: node.title,
        },
      );
    });

    graphRef.current = graph;

    return () => {
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, llmData, mode, layout, token]);

  /** 返回文档：单篇回编辑器，文件夹保持上下文，全库回列表 */
  function backToDocs() {
    if (noteId != null) {
      navigate(`/notes/${noteId}`);
      return;
    }
    navigate(folderId ? `/notes?folder=${folderId}` : "/notes");
  }

  function handleFitView() {
    graphRef.current?.fitView();
  }

  function handleFitCenter() {
    graphRef.current?.fitCenter();
  }

  function handleRefresh() {
    if (mode === "llm") {
      void loadLlmGraphData();
    } else {
      void loadRuleGraphData();
    }
  }

  const activeData = mode === "llm" ? llmData : graphData;
  const loading = mode === "llm" ? llmLoading : ruleLoading;
  const nodeCount = activeData?.nodes.length ?? 0;
  const edgeCount = activeData?.edges.length ?? 0;

  // 工具栏紧凑作用域标签：只显示文件夹/文档名，其余信息悬停展示
  const scopeLabel = useMemo(() => {
    if (noteId != null) {
      return `文档「${llmData?.note_titles[0] ?? `#${noteId}`}」`;
    }
    if (folderId != null) {
      return `文件夹「${scopeFolder ?? `#${folderId}`}」`;
    }
    return "全库";
  }, [noteId, folderId, scopeFolder, llmData]);

  const scopeDetail = useMemo(() => {
    const parts = [`${nodeCount} 个节点 / ${edgeCount} 条连线`];
    if (mode === "llm" && llmSourceHint) parts.push(llmSourceHint);
    if (folderId != null && noteId == null) parts.push("点击查看全库图谱");
    return parts.join(" · ");
  }, [nodeCount, edgeCount, mode, llmSourceHint, folderId, noteId]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 shrink-0">
          <Button size="small" icon={<ArrowLeft size={14} />} onClick={backToDocs}>
            返回文档
          </Button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Spin
            size="large"
            tip={mode === "llm" ? "加载 LLM 图谱..." : "加载文档关系..."}
          />
        </div>
      </div>
    );
  }

  if (!activeData || activeData.nodes.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 shrink-0">
          <Button size="small" icon={<ArrowLeft size={14} />} onClick={backToDocs}>
            返回文档
          </Button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          {noteId == null && (
            <Segmented
              size="small"
              value={mode}
              options={[
                { label: "规则关系", value: "rule" },
                { label: "LLM 图谱", value: "llm" },
              ]}
              onChange={(v) => setMode(v as "rule" | "llm")}
            />
          )}
          {mode === "llm" && (
            <div
              className="font-semibold text-base"
              style={{ color: token.colorText }}
            >
              {llmScopeTitle}
            </div>
          )}
          <Empty
            description={
              noteId != null
                ? "该文档尚未生成 LLM 图谱，点击下方按钮开始抽取"
                : mode === "llm"
                  ? "尚无 LLM 图谱数据，点击下方按钮开始抽取"
                  : folderId == null
                    ? "暂无文档关系，请先创建文档并添加链接"
                    : "该文件夹下暂无文档或关联"
            }
          />
          {mode === "llm" && (
            <Button
              type="primary"
              size="small"
              loading={extracting}
              onClick={handleExtract}
            >
              {noteId != null ? "抽取本文档" : "抽取当前范围"}
            </Button>
          )}
          {extracting && progress && (
            <ExtractionProgress progress={progress} token={token} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      // 顶层兜底：节点右键由 G6 监听并自管 preventDefault；其他位置（画布空白 /
      // 工具栏 / 图例）右键不弹 WebView 默认菜单。本页无 input
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0 kb-surface"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <div className="flex items-center gap-3">
          <Button
            size="small"
            icon={<ArrowLeft size={14} />}
            onClick={backToDocs}
          >
            返回文档
          </Button>
          <Tooltip title={scopeDetail}>
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                color: token.colorTextSecondary,
                background: token.colorFillQuaternary,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 260,
                cursor:
                  folderId != null && noteId == null ? "pointer" : "default",
              }}
              onClick={() => {
                if (folderId != null && noteId == null) navigate("/graph");
              }}
            >
              {scopeLabel}
            </span>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2">
          {noteId == null && (
            <Segmented
              size="small"
              value={mode}
              options={[
                { label: "规则关系", value: "rule" },
                { label: "LLM 图谱", value: "llm" },
              ]}
              onChange={(v) => setMode(v as "rule" | "llm")}
            />
          )}
          {extracting && progress && (
            <ExtractionProgress progress={progress} token={token} />
          )}
          {mode === "llm" && (
            <Button size="small" loading={extracting} onClick={handleExtract}>
              {noteId != null ? "抽取本文档" : "抽取当前范围"}
            </Button>
          )}
          <Segmented
            size="small"
            value={layout}
            options={[
              { label: "力导向", value: "d3-force" },
              { label: "环形", value: "circular" },
              { label: "径向", value: "radial" },
              { label: "网格", value: "grid" },
            ]}
            onChange={(v) => setLayout(v as string)}
          />

          <div className="flex items-center gap-1 ml-2">
            <Tooltip title="适应画布">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitView}
              >
                <Maximize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="居中">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleFitCenter}
              >
                <Minimize2 size={14} />
              </button>
            </Tooltip>
            <Tooltip title="刷新数据">
              <button
                className="p-1.5 rounded hover:bg-black/5 transition-colors"
                onClick={handleRefresh}
              >
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* 图例 */}
      <div
        className="flex items-center gap-4 px-4 py-1.5 text-xs shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorTextSecondary,
        }}
      >
        {mode === "rule" ? (
          <>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimaryBg }}
          />
          普通文档
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorPrimary }}
          />
          热门文档
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorError }}
          />
          置顶文档
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: token.colorWarning }}
          />
          日记
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{
              background: token.colorFillSecondary,
              border: `1px solid ${token.colorBorder}`,
            }}
          />
          文件夹
        </span>
        {scopeFolder && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{
                background: token.colorBgContainer,
                border: `1px dashed ${token.colorTextQuaternary}`,
              }}
            />
            范围外关联
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>双击文档打开</span>
          </>
        ) : (
          <>
            <span style={{ marginRight: 4 }}>实体类型：</span>
            {[
              ["artifact", "产物"],
              ["concept", "概念"],
              ["method", "方法"],
              ["data", "数据"],
              ["person", "人物"],
              ["content", "内容"],
              ["organization", "组织"],
              ["event", "事件"],
            ].map(([type, label]) => (
              <span key={type} className="flex items-center gap-1">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ background: entityTypeColor(type, token) }}
                />
                {label}
              </span>
            ))}
            <span style={{ marginLeft: "auto" }}>双击实体打开来源文档</span>
          </>
        )}
      </div>

      {/* 图谱画布 */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ minHeight: 0, background: token.colorBgLayout }}
      />

      <ContextMenuOverlay
        open={!!ctx.state.payload}
        x={ctx.state.x}
        y={ctx.state.y}
        items={menuItems}
        onClose={ctx.close}
      />
    </div>
  );
}
