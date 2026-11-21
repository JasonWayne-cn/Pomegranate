import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Dropdown,
  Empty,
  Spin,
  Tooltip,
  message,
  theme as antdTheme,
} from "antd";
import { Graph } from "@antv/g6";
import { listen } from "@tauri-apps/api/event";
import {
  ExternalLink,
  FileText,
  LayoutGrid,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { llmGraphApi } from "@/lib/api";
import type {
  LlmEntityNote,
  LlmGraphData,
  LlmGraphProgress,
} from "@/types";
import {
  ExtractionProgress,
  entityTypeColor,
} from "@/components/graph/LlmGraphUi";

interface Props {
  /** 是否挂载；由编辑器分栏控制 */
  open: boolean;
  noteId: number;
  onClose: () => void;
}

const LAYOUT_ITEMS = [
  { key: "d3-force", label: "力导向" },
  { key: "circular", label: "环形" },
  { key: "radial", label: "径向" },
  { key: "grid", label: "网格" },
];

/**
 * 单文档 LLM 图谱：编辑器右侧嵌入式分栏，交互参考思维导图。
 *
 * - 宽度 / 分隔条由父级控制，本组件只负责工具栏、画布与节点详情；
 * - 未抽取时显示空态与「抽取本文档」；
 * - 抽取期间显示进度与预计剩余时间。
 */
export function NoteGraphView({ open, noteId, onClose }: Props) {
  const { token } = antdTheme.useToken();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  const [data, setData] = useState<LlmGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState<LlmGraphProgress | null>(null);
  const [layout, setLayout] = useState<string>("d3-force");
  const [selected, setSelected] = useState<{
    name: string;
    type: string;
    description: string;
  } | null>(null);
  const [relatedDocs, setRelatedDocs] = useState<LlmEntityNote[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);

  async function load() {
    if (!Number.isFinite(noteId)) return;
    setLoading(true);
    try {
      setData(await llmGraphApi.getGraphData(null, 3000, noteId));
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, noteId]);

  useEffect(() => {
    if (!open || !containerRef.current || !data || data.nodes.length === 0) {
      return;
    }
    graphRef.current?.destroy();

    const nodes = data.nodes.map((n) => ({
      id: `e${n.id}`,
      data: {
        label: n.name,
        entityType: n.entity_type,
        description: n.description,
        degree: n.degree,
      },
    }));
    const edges = data.edges.map((e, i) => ({
      id: `le-${i}`,
      source: `e${e.source}`,
      target: `e${e.target}`,
      data: { description: e.description, keywords: e.keywords },
    }));

    const graph = new Graph({
      container: containerRef.current,
      autoFit: {
        type: "view",
        options: { when: "overflow", direction: "both" },
        animation: { duration: 200, easing: "ease-out" },
      },
      data: { nodes, edges },
      node: {
        type: "circle",
        style: {
          size: (d: any) =>
            Math.max(16, Math.min(38, 16 + (d.data?.degree || 0) * 2)),
          fill: (d: any) => entityTypeColor(d.data?.entityType || "", token),
          stroke: (d: any) => entityTypeColor(d.data?.entityType || "", token),
          lineWidth: 1.5,
          labelText: (d: any) => {
            const raw = d.data?.label || "";
            return raw.length > 12 ? raw.slice(0, 12) + "..." : raw;
          },
          labelFontSize: 11,
          labelFill: token.colorText,
          labelPlacement: "bottom",
          labelOffsetY: 4,
        },
      },
      edge: {
        style: {
          stroke: token.colorInfo,
          strokeOpacity: 0.3,
          lineWidth: 1,
          endArrow: true,
          endArrowSize: 6,
          endArrowFill: token.colorInfo,
        },
      },
      layout:
        layout === "d3-force"
          ? {
              type: "d3-force",
              link: { distance: 70, strength: 0.6 },
              manyBody: { strength: -120 },
              collide: { radius: 30, strength: 0.9 },
              center: { strength: 0.1 },
            }
          : layout === "radial"
            ? {
                type: "radial",
                unitRadius: 70,
                preventOverlap: true,
                nodeSize: 40,
              }
            : { type: layout },
      behaviors: [
        "drag-canvas",
        "zoom-canvas",
        "drag-element",
        { type: "click-select", multiple: false },
      ],
    });

    graph.render();
    // 力导向布局稳定后再 fit 一次，避免首屏图表缩在角落
    const fitTimer = window.setTimeout(() => {
      try {
        graph.fitView();
      } catch {
        // 画布已销毁时忽略
      }
    }, 600);

    graph.on("node:click", (evt: any) => {
      const gid = String(evt.target?.id ?? "");
      const n = data.nodes.find((x) => `e${x.id}` === gid);
      if (!n) return;
      setSelected({
        name: n.name,
        type: n.entity_type,
        description: n.description,
      });
      setRelatedDocs([]);
      setRelatedLoading(true);
      llmGraphApi
        .getEntityNotes(n.name, 20)
        .then(setRelatedDocs)
        .catch(() => setRelatedDocs([]))
        .finally(() => setRelatedLoading(false));
    });

    graphRef.current = graph;
    return () => {
      window.clearTimeout(fitTimer);
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, [open, data, layout, token]);

  async function handleExtract() {
    if (!Number.isFinite(noteId)) return;
    setExtracting(true);
    setProgress(null);
    const unlisten = await listen<LlmGraphProgress>(
      "llm-graph:progress",
      (e) => setProgress(e.payload),
    );
    try {
      const r = await llmGraphApi.extractNote(noteId);
      message.success(
        `抽取完成：${r.entity_count} 个实体 / ${r.relation_count} 条关系`,
      );
      await load();
    } catch (e) {
      message.error(String(e));
    } finally {
      unlisten();
      setExtracting(false);
      window.setTimeout(() => setProgress(null), 1200);
    }
  }

  if (!open) return null;

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: token.colorBgContainer }}
    >
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            fontSize: 13,
            color: token.colorText,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          文档图谱
        </span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
            whiteSpace: "nowrap",
          }}
        >
          {data ? `${data.nodes.length} 节点 / ${data.edges.length} 关系` : ""}
        </span>
        <Tooltip title="在新页面打开">
          <Button
            size="small"
            type="text"
            icon={<ExternalLink size={14} />}
            onClick={() => navigate(`/graph?note=${noteId}`)}
            title="在新页面打开"
            aria-label="在新页面打开"
          />
        </Tooltip>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: LAYOUT_ITEMS,
            selectedKeys: [layout],
            onClick: ({ key }) => setLayout(key),
          }}
        >
          <Button
            size="small"
            type="text"
            icon={<LayoutGrid size={14} />}
            title="图谱布局"
            aria-label="图谱布局"
          />
        </Dropdown>
        <Tooltip title="抽取 / 更新图谱">
          <Button
            size="small"
            type="text"
            loading={extracting}
            icon={<Sparkles size={14} />}
            onClick={handleExtract}
            title="抽取/更新图谱"
            aria-label="抽取/更新图谱"
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            loading={loading}
            icon={<RefreshCw size={14} />}
            onClick={() => void load()}
            title="刷新图谱"
            aria-label="刷新图谱"
          />
        </Tooltip>
        <Tooltip title="关闭">
          <Button
            size="small"
            type="text"
            icon={<X size={14} />}
            onClick={onClose}
            title="关闭图谱"
            aria-label="关闭图谱"
          />
        </Tooltip>
      </div>

      {extracting && progress && (
        <div
          style={{
            padding: "4px 10px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <ExtractionProgress progress={progress} token={token} />
        </div>
      )}

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {loading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
            }}
          >
            <Spin tip="加载文档图谱..." />
          </div>
        )}
        {!loading && (!data || data.nodes.length === 0) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: 16,
            }}
          >
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚未生成文档图谱"
            />
            <Button
              size="small"
              type="primary"
              loading={extracting}
              onClick={handleExtract}
            >
              抽取本文档
            </Button>
          </div>
        )}
        <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        {selected && (
          <div
            style={{
              position: "absolute",
              left: 10,
              right: 10,
              bottom: 10,
              maxHeight: 210,
              overflow: "auto",
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 12,
              color: token.colorTextSecondary,
              boxShadow: token.boxShadowSecondary,
            }}
          >
            <div
              style={{
                fontWeight: 600,
                color: token.colorText,
                marginBottom: 4,
              }}
            >
              {selected.name}{" "}
              <span style={{ fontWeight: 400, color: token.colorTextTertiary }}>
                · {selected.type}
              </span>
            </div>
            <div style={{ marginBottom: 6 }}>{selected.description}</div>
            <div
              style={{
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                paddingTop: 6,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: token.colorText,
                  marginBottom: 2,
                }}
              >
                相关文档
              </div>
              {relatedLoading ? (
                <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
                  查询中...
                </div>
              ) : relatedDocs.length === 0 ? (
                <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
                  仅当前文档
                </div>
              ) : (
                relatedDocs.map((doc) => (
                  <div
                    key={doc.note_id}
                    onClick={() => navigate(`/notes/${doc.note_id}`)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 0",
                      cursor: "pointer",
                      fontSize: 12,
                      color: token.colorTextSecondary,
                    }}
                    title={doc.note_title}
                  >
                    <FileText size={12} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {doc.note_title}
                    </span>
                    {doc.note_id === noteId && (
                      <span
                        style={{
                          fontSize: 10,
                          color: token.colorTextTertiary,
                        }}
                      >
                        当前
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
