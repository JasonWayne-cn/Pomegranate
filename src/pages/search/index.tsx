import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Input,
  Button,
  Typography,
  Empty,
  Spin,
  Segmented,
  TreeSelect,
  Select,
  DatePicker,
  Checkbox,
  Tooltip,
  theme as antdTheme,
} from "antd";
import {
  Search as SearchIcon,
  NotebookText,
  CheckSquare,
  AlertTriangle,
  Check,
  SlidersHorizontal,
  History,
  Trash2,
  X as XIcon,
} from "lucide-react";
import dayjs from "dayjs";
import {
  hasActiveFilters,
  parseSearchUrl,
  writeSearchUrl,
  type SearchUrlState,
} from "@/lib/searchUrlState";
import { searchApi, taskApi, folderApi, tagApi } from "@/lib/api";
import { useModuleConfig } from "@/hooks/useModuleConfig";
import { MicButton } from "@/components/MicButton";
import { useAppStore } from "@/store";
import { highlightText, highlightSnippet } from "@/lib/highlight";
import type {
  SearchResult,
  TaskSearchHit,
  SearchFilters,
  Folder,
  Tag,
  NoteType,
} from "@/types";

const { Text } = Typography;

/** "全部" 模式下文档最多展示这么多条，再多就让用户切到「文档」Tab 看全 */
const ALL_MODE_NOTES_PREVIEW = 20;

type Scope = "all" | "notes" | "tasks";

/** 把文件夹树拍平成"该节点 + 全部子孙"的 id 列表 */
function collectSubtreeIds(folders: Folder[], targetIds: number[]): number[] {
  const out = new Set<number>();
  const walk = (nodes: Folder[], inside: boolean) => {
    for (const n of nodes) {
      const hit = inside || targetIds.includes(n.id);
      if (hit) out.add(n.id);
      const children = (n as Folder & { children?: Folder[] }).children;
      if (children?.length) walk(children, hit);
    }
  };
  walk(folders, false);
  return [...out];
}

/**
 * RangePicker 给出的 [起, 止] 日期串 → 后端要的时间范围（任一端为空返回 null = 不筛选）。
 *
 * 后端比的是 notes 表的 `YYYY-MM-DD HH:MM:SS`，补上时分秒才能让"选到今天"
 * 含当天全部文档，而不是卡在 00:00:00。
 */
function toDayRange(strs: [string, string]): [string, string] | null {
  return strs[0] && strs[1] ? [`${strs[0]} 00:00:00`, `${strs[1]} 23:59:59`] : null;
}

/**
 * 组装成后端要的 filters。
 *
 * 🔴 没勾的维度必须**省略字段**而不是传 `[]` —— 后端 fail-closed，
 * 空数组表示"勾了但没选中"会直接返回零结果（见 types/SearchFilters 注释）。
 * 抽成纯函数：外部跳转时要按 URL 里的新条件立刻搜，不能等 state 更新后再读 useMemo。
 */
function buildSearchFilters(
  s: {
    folders: number[];
    tags: number[];
    types: NoteType[];
    dateRange: [string, string] | null;
    createdRange: [string, string] | null;
    titleOnly: boolean;
  },
  folderTree: Folder[],
): SearchFilters | undefined {
  const f: SearchFilters = {};
  if (s.folders.length > 0) {
    // 选了「工作」应当含其下所有子文件夹，否则用户会觉得"明明在这个目录里却搜不到"。
    // 🔴 从 URL 恢复时文件夹树可能还没拉到：此时子树展开会得到 []，后端 fail-closed 直接零结果。
    //    先用选中的 id 本身，树到了 filtersKey 变化会自动按子树重搜。
    f.folderIds =
      folderTree.length > 0 ? collectSubtreeIds(folderTree, s.folders) : s.folders;
  }
  if (s.tags.length > 0) f.tagIds = s.tags;
  if (s.types.length > 0) f.noteTypes = s.types;
  if (s.dateRange) {
    f.updatedAfter = s.dateRange[0];
    f.updatedBefore = s.dateRange[1];
  }
  if (s.createdRange) {
    f.createdAfter = s.createdRange[0];
    f.createdBefore = s.createdRange[1];
  }
  // 只在勾选时才传：不勾 = 省略字段，保持与旧版请求完全一致
  if (s.titleOnly) f.titleOnly = true;
  return Object.keys(f).length > 0 ? f : undefined;
}

/**
 * 搜索主体。
 *
 * `embedded` = 在首页模态窗里渲染：不读写 URL（否则会把首页地址污染成
 * `/?q=...`），Tab 切换改为本地状态；其余搜索/筛选逻辑完全一致。
 */
export function DesktopSearchPage({
  embedded = false,
  initialQuery = "",
}: {
  embedded?: boolean;
  initialQuery?: string;
} = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token } = antdTheme.useToken();
  // 首页模态窗里的搜索记录（横排 chips）；独立搜索页不展示
  const recentSearches = useAppStore((s) => s.recentSearches);
  const removeRecentSearch = useAppStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useAppStore((s) => s.clearRecentSearches);
  // 进入页面时从 URL 恢复条件：点进文档再返回、刷新都不丢（见 lib/searchUrlState）
  const [initialUrl] = useState<SearchUrlState>(() => {
    if (!embedded) return parseSearchUrl(searchParams);
    return {
      q: initialQuery.trim(),
      folders: [],
      tags: [],
      types: [],
      updated: null,
      created: null,
      titleOnly: false,
    };
  });

  // 模块设置中心：默认结果类型 / 仅标题 / 结果上限
  const { values: searchConfig, loaded: searchConfigLoaded } = useModuleConfig(
    "search",
    {
      default_scope: "all",
      title_only: false,
      max_results: 50,
    },
  );

  const [query, setQuery] = useState(initialUrl.q);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [taskResults, setTaskResults] = useState<TaskSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 本页最后一次写进 URL 的 q：区分「自己写回」和「外部跳转」（见读 URL 的 effect） */
  const lastWrittenQRef = useRef(initialUrl.q);
  /** 外部跳转那一轮跳过写回 URL */
  const skipNextUrlWriteRef = useRef(false);
  const searchSeqRef = useRef(0);
  /** 最近一次发起搜索的关键词 + 条件，防止条件 state 追上来后重复搜 */
  const lastSearchRef = useRef<{ q: string; filtersKey: string } | null>(null);

  // ─── 筛选（P1-2）────────────────────────────────
  // 带着筛选条件回来时直接展开面板，让用户看到条件还在
  const [showFilters, setShowFilters] = useState(() => hasActiveFilters(initialUrl));
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [pickedFolders, setPickedFolders] = useState<number[]>(initialUrl.folders);
  const [pickedTags, setPickedTags] = useState<number[]>(initialUrl.tags);
  const [pickedTypes, setPickedTypes] = useState<NoteType[]>(initialUrl.types);
  const [dateRange, setDateRange] = useState<[string, string] | null>(() =>
    initialUrl.updated ? toDayRange(initialUrl.updated) : null,
  );
  const [createdRange, setCreatedRange] = useState<[string, string] | null>(() =>
    initialUrl.created ? toDayRange(initialUrl.created) : null,
  );
  const [titleOnly, setTitleOnly] = useState(initialUrl.titleOnly);
  // 「仅搜索标题」默认值只应用一次，避免用户手动切换后被配置反复覆盖
  const titleOnlyDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (!searchConfigLoaded || titleOnlyDefaultAppliedRef.current) return;
    titleOnlyDefaultAppliedRef.current = true;
    // URL 显式带条件时以 URL 为准；embedded 模式没有 URL 条件，直接套配置
    if (embedded || !searchParams.has("titleOnly")) {
      setTitleOnly(searchConfig.title_only);
    }
  }, [searchConfigLoaded, searchConfig.title_only, searchParams, embedded]);
  // RangePicker 是非受控的：清空筛选时靠换 key 重挂载，才能把选择器上残留的日期也清掉
  const [pickerResetKey, setPickerResetKey] = useState(0);

  // 展开筛选面板时才拉数据 —— 大多数搜索用不上筛选，没必要每次进页面都拉两张表
  useEffect(() => {
    if (!showFilters || folders.length > 0 || tags.length > 0) return;
    folderApi.list().then(setFolders).catch(() => {});
    tagApi.list().then(setTags).catch(() => {});
  }, [showFilters, folders.length, tags.length]);

  /** 组装成后端要的 filters（规则见 buildSearchFilters） */
  const filters = useMemo<SearchFilters | undefined>(
    () =>
      buildSearchFilters(
        {
          folders: pickedFolders,
          tags: pickedTags,
          types: pickedTypes,
          dateRange,
          createdRange,
          titleOnly,
        },
        folders,
      ),
    [pickedFolders, pickedTags, pickedTypes, dateRange, createdRange, titleOnly, folders],
  );

  const activeFilterCount =
    (pickedFolders.length > 0 ? 1 : 0) +
    (pickedTags.length > 0 ? 1 : 0) +
    (pickedTypes.length > 0 ? 1 : 0) +
    (dateRange ? 1 : 0) +
    (createdRange ? 1 : 0) +
    (titleOnly ? 1 : 0);

  function clearFilters() {
    setPickedFolders([]);
    setPickedTags([]);
    setPickedTypes([]);
    setDateRange(null);
    setCreatedRange(null);
    setTitleOnly(false);
    setPickerResetKey((k) => k + 1);
  }

  // 筛选变化后立即用当前关键词重搜（用户改了条件却要再敲一次回车是很别扭的）
  const filtersKey = JSON.stringify(filters ?? {});
  useEffect(() => {
    if (!searched || !query.trim()) return;
    // 外部跳转时已经按新条件搜过了，条件 state 随后才更新到这里，别再搜一遍
    const last = lastSearchRef.current;
    if (last && last.q === query.trim() && last.filtersKey === filtersKey) return;
    doSearch(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // Tab（全部 / 文档 / 待办）：独立页面用 URL ?type=，embedded 用本地 state
  const [embeddedScope, setEmbeddedScope] = useState<Scope>(
    (searchConfig.default_scope as Scope) ?? "all",
  );
  const scope: Scope = embedded
    ? embeddedScope
    : ((searchParams.get("type") ?? searchConfig.default_scope) as Scope);

  // 结果列表直接渲染、不再套内层滚动容器：
  // 独立页面由 Content 滚动，模态窗由 Modal body 滚动 —— 全链路只保留一条竖直滚动条。
  // 结果上限由 searchConfig.max_results 限制（≤200 条），无需虚拟化。

  // URL ?q= 驱动搜索：外部（移动端 / 标签页跳转 / 手动改地址）改变 URL 时
  // 同步输入框并触发重搜；用户在输入框 typing 走下方本地 debounce，不走这里
  //
  // 🔴 读 URL 和写 URL 两个 effect 在同一次提交里都会跑：外部跳转那一轮 query 还是旧值，
  //    写回 effect 若照常执行会把旧 q 写回去，下一轮读 effect 又把旧 q 当成"外部跳转"，
  //    关键词就在新旧之间来回切、反复搜。所以用 lastWrittenQRef 记住本页最后写进 URL 的 q：
  //    与它相同 = 自己写的，忽略；不同才是外部跳转，并让写回 effect 跳过这一轮。
  const urlQ = (searchParams.get("q") ?? "").trim();
  useEffect(() => {
    // embedded（首页模态窗）：不响应 URL，关键词由 initialQuery 一次性带入
    if (embedded) return;
    if (!urlQ || urlQ === lastWrittenQRef.current) return;
    lastWrittenQRef.current = urlQ;
    skipNextUrlWriteRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    // 外部跳转（侧栏历史 / 首页搜索框 / 后退）按 URL 里的条件来：只带 q 就等于清空筛选。
    // 否则沿用旧筛选，用户看不出结果被过滤了，会以为搜不到
    const next = parseSearchUrl(searchParams);
    const nextDate = next.updated ? toDayRange(next.updated) : null;
    const nextCreated = next.created ? toDayRange(next.created) : null;
    setQuery(urlQ);
    setPickedFolders(next.folders);
    setPickedTags(next.tags);
    setPickedTypes(next.types);
    setDateRange(nextDate);
    setCreatedRange(nextCreated);
    setTitleOnly(next.titleOnly);
    setPickerResetKey((k) => k + 1);
    if (hasActiveFilters(next)) setShowFilters(true);
    doSearch(
      urlQ,
      buildSearchFilters(
        {
          folders: next.folders,
          tags: next.tags,
          types: next.types,
          dateRange: nextDate,
          createdRange: nextCreated,
          titleOnly: next.titleOnly,
        },
        folders,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  // 首次进入：URL 里带着关键词（含从文档返回）就按恢复的条件搜一次
  useEffect(() => {
    if (initialUrl.q) doSearch(initialUrl.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 条件变化 → 写回 URL（replace，不往历史栈里塞记录，后退仍是回到上一页）
  useEffect(() => {
    // embedded：不写 URL（否则首页地址会变成 /?q=…）
    if (embedded) return;
    // 外部跳转那一轮的 state 还是旧的，写回会把新 URL 覆盖掉（见上方读 URL 的 effect）
    if (skipNextUrlWriteRef.current) {
      skipNextUrlWriteRef.current = false;
      return;
    }
    lastWrittenQRef.current = query.trim();
    const day = (r: [string, string] | null): [string, string] | null =>
      r ? [r[0].slice(0, 10), r[1].slice(0, 10)] : null;
    const next = writeSearchUrl(searchParams, {
      q: query,
      folders: pickedFolders,
      tags: pickedTags,
      types: pickedTypes,
      updated: day(dateRange),
      created: day(createdRange),
      titleOnly,
    });
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [
    query,
    pickedFolders,
    pickedTags,
    pickedTypes,
    dateRange,
    createdRange,
    titleOnly,
    searchParams,
    setSearchParams,
  ]);

  /** 并发拉文档 + 待办；任意一边失败不阻塞另一边 */
  async function doSearch(keyword: string, f: SearchFilters | undefined = filters) {
    // 请求序号：连续输入 / 改条件会有多个请求同时在跑，慢的旧结果回来不能盖掉新结果
    const seq = ++searchSeqRef.current;
    lastSearchRef.current = { q: keyword, filtersKey: JSON.stringify(f ?? {}) };
    setLoading(true);
    setSearched(true);
    const limit = Math.max(10, Math.min(200, searchConfig.max_results || 50));
    const [notes, tasks] = await Promise.all([
      searchApi.search(keyword, limit, f).catch((e) => {
        console.error("文档搜索失败:", e);
        return [] as SearchResult[];
      }),
      taskApi.search(keyword, limit).catch((e) => {
        console.error("待办搜索失败:", e);
        return [] as TaskSearchHit[];
      }),
    ]);
    if (seq !== searchSeqRef.current) return;
    setResults(notes);
    setTaskResults(tasks);
    // 历史只在拿到任一结果时才记（避免空查询污染）
    if (notes.length + tasks.length > 0) {
      useAppStore.getState().pushRecentSearch(keyword);
    }
    setLoading(false);
  }

  /** 索引-only 的外部二进制文档直接进 Office 打开原文件，其余仍进文档编辑器 */
  function openResult(item: SearchResult) {
    if (item.ext_index_only && item.abs_path) {
      const readOnly = item.read_only ? "1" : "0";
      navigate(
        `/office?path=${encodeURIComponent(item.abs_path)}&readonly=${readOnly}&t=${Date.now()}`,
      );
      return;
    }
    navigate(`/notes/${item.id}?q=${encodeURIComponent(query)}`);
  }

  function handleInputChange(value: string) {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      // 作废还在跑的请求，免得清空后旧结果又冒出来
      searchSeqRef.current++;
      lastSearchRef.current = null;
      setLoading(false);
      setResults([]);
      setTaskResults([]);
      setSearched(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      doSearch(value.trim());
    }, 300);
  }

  /** 切换 Tab：独立页面写回 URL；embedded 只改本地状态 */
  function setScope(next: Scope) {
    if (embedded) {
      setEmbeddedScope(next);
      return;
    }
    const sp = new URLSearchParams(searchParams);
    if (next === "all") sp.delete("type");
    else sp.set("type", next);
    setSearchParams(sp, { replace: true });
  }

  const showNotes = scope === "all" || scope === "notes";
  const showTasks = scope === "all" || scope === "tasks";
  const totalHits = results.length + taskResults.length;
  // "全部" 模式下文档只展示 preview，超出由"查看全部"链接引导切到文档 Tab
  const notesToRender =
    scope === "all" ? results.slice(0, ALL_MODE_NOTES_PREVIEW) : results;

  return (
    // 与 AI 问答页对齐：内容列限制在 max-w-4xl 并居中，宽窗口下左右留出呼吸空间
    <div className="mx-auto w-full max-w-4xl">
      {/* 搜索框：与首页 / 文档列表搜索同款（普通 Input + 独立搜索按钮） */}
      <div className="mb-4 flex items-stretch gap-1.5" style={{ width: "100%" }}>
        <Input
          size="large"
          placeholder="搜索文档内容 / 待办标题…"
          prefix={<SearchIcon size={18} />}
          suffix={
            <MicButton
              size="small"
              stripTrailingPunctuation
              onTranscribed={(text) =>
                handleInputChange(query ? `${query} ${text}` : text)
              }
            />
          }
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onPressEnter={() => handleInputChange(query)}
          allowClear
          style={{ flex: 1, borderRadius: 8 }}
        />
        <Button
          size="large"
          type="primary"
          onClick={() => handleInputChange(query)}
        >
          搜索
        </Button>
      </div>

      {/* 首页模态窗：搜索记录横排 chips，风格对齐文档列表的「子文件夹」条 */}
      {embedded && recentSearches.length > 0 && (
        <div className="mb-4 flex items-center gap-2" style={{ fontSize: 12 }}>
          <span
            style={{
              color: token.colorTextSecondary,
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            搜索记录
          </span>
          <div
            className="flex items-center gap-2"
            style={{ flex: 1, minWidth: 0, flexWrap: "wrap" }}
          >
            {recentSearches.map((q) => (
              <span
                key={q}
                role="button"
                tabIndex={0}
                onClick={() => handleInputChange(q)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleInputChange(q);
                  }
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  maxWidth: 220,
                  height: 26,
                  padding: "0 8px",
                  border: `1px solid ${token.colorBorder}`,
                  borderRadius: 6,
                  background: token.colorBgContainer,
                  color: token.colorTextSecondary,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <History
                  size={12}
                  style={{ flexShrink: 0, color: token.colorTextTertiary }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {q}
                </span>
                <XIcon
                  size={12}
                  aria-label={`删除搜索记录 ${q}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecentSearch(q);
                  }}
                  style={{ flexShrink: 0, color: token.colorTextTertiary }}
                />
              </span>
            ))}
            {/* 行尾垃圾桶：清空全部搜索历史 */}
            <Tooltip title="清除搜索历史">
              <button
                type="button"
                aria-label="清除搜索历史"
                onClick={() => clearRecentSearches()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  border: `1px solid ${token.colorBorder}`,
                  borderRadius: 6,
                  background: token.colorBgContainer,
                  color: token.colorTextTertiary,
                  cursor: "pointer",
                }}
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* 范围切换：仅在已搜索时显示，免得空状态有个孤零零的切换器 */}
      {searched && (
        <div className="mb-4 flex items-center justify-between">
          <Segmented
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { value: "all", label: `全部 ${totalHits}` },
              { value: "notes", label: `文档 ${results.length}` },
              { value: "tasks", label: `待办 ${taskResults.length}` },
            ]}
          />
          <div className="flex items-center gap-3">
            {!loading && totalHits > 0 && (
              <Text type="secondary" className="text-xs">
                共 {totalHits} 条结果
              </Text>
            )}
            {/* 筛选只作用于文档，待办 Tab 下没有意义，故隐藏 */}
            {scope !== "tasks" && (
              <Button
                size="small"
                type={activeFilterCount > 0 ? "primary" : "default"}
                icon={<SlidersHorizontal size={14} />}
                onClick={() => setShowFilters((v) => !v)}
                title="按文件夹 / 标签 / 时间 / 类型筛选"
              >
                筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 筛选栏（P1-2）：仅文档结果生效 */}
      {searched && showFilters && scope !== "tasks" && (
        <div
          className="mb-4 flex flex-wrap items-center gap-2 rounded-lg p-3"
          style={{ background: token.colorFillQuaternary }}
        >
          <TreeSelect
            style={{ minWidth: 180, flex: "1 1 180px" }}
            size="small"
            multiple
            treeCheckable
            showCheckedStrategy={TreeSelect.SHOW_PARENT}
            maxTagCount={1}
            value={pickedFolders}
            onChange={(v) => setPickedFolders(v as number[])}
            treeData={folders as unknown as Record<string, unknown>[]}
            fieldNames={{ label: "name", value: "id", children: "children" }}
            placeholder="文件夹"
            allowClear
            treeNodeFilterProp="name"
          />
          <Select
            style={{ minWidth: 160, flex: "1 1 160px" }}
            size="small"
            mode="multiple"
            maxTagCount={1}
            value={pickedTags}
            onChange={setPickedTags}
            options={tags.map((t) => ({ label: t.name, value: t.id }))}
            placeholder="标签（需同时含有）"
            allowClear
            optionFilterProp="label"
          />
          <Select
            style={{ minWidth: 120 }}
            size="small"
            mode="multiple"
            maxTagCount={1}
            value={pickedTypes}
            onChange={setPickedTypes}
            options={[
              { label: "文档", value: "markdown" },
              { label: "白板", value: "whiteboard" },
            ]}
            placeholder="类型"
            allowClear
          />
          <DatePicker.RangePicker
            key={`updated-${pickerResetKey}`}
            defaultValue={
              dateRange ? [dayjs(dateRange[0]), dayjs(dateRange[1])] : undefined
            }
            size="small"
            style={{ minWidth: 220 }}
            onChange={(_, strs) => setDateRange(toDayRange(strs))}
            placeholder={["修改时间从", "至"]}
          />
          <DatePicker.RangePicker
            key={`created-${pickerResetKey}`}
            defaultValue={
              createdRange ? [dayjs(createdRange[0]), dayjs(createdRange[1])] : undefined
            }
            size="small"
            style={{ minWidth: 220 }}
            onChange={(_, strs) => setCreatedRange(toDayRange(strs))}
            placeholder={["创建时间从", "至"]}
          />
          <Checkbox
            checked={titleOnly}
            onChange={(e) => setTitleOnly(e.target.checked)}
          >
            仅搜标题
          </Checkbox>
          {activeFilterCount > 0 && (
            <Button
              size="small"
              type="text"
              icon={<XIcon size={14} />}
              onClick={clearFilters}
              title="清空全部筛选条件"
            >
              清空
            </Button>
          )}
        </div>
      )}

      {/* 结果区 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" tip="搜索中..." />
        </div>
      ) : !searched ? (
        <div className="flex flex-col items-center py-12">
          <SearchIcon size={48} style={{ opacity: 0.15 }} />
          <Text type="secondary" className="mt-4" style={{ fontSize: 14 }}>
            输入关键词同时搜索文档与待办
          </Text>
        </div>
      ) : totalHits === 0 ? (
        <Empty
          description={`未找到与 "${query}" 相关的内容`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        // 不设内层滚动容器：滚动统一交给外层（页面 Content / Modal body）
        <div>
          {/* 待办分组（"全部" 或 "待办" Tab 显示） */}
          {showTasks && taskResults.length > 0 && (
            <section className="mb-6">
              <SectionHeader
                icon={<CheckSquare size={14} />}
                label="待办"
                count={taskResults.length}
                token={token}
              />
              <div>
                {taskResults.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    token={token}
                    keyword={query}
                    onClick={() => navigate(`/tasks?taskId=${task.id}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 文档分组 */}
          {showNotes && results.length > 0 && (
            <section>
              <SectionHeader
                icon={<NotebookText size={14} />}
                label="文档"
                count={results.length}
                token={token}
              />
              {scope === "notes" ? (
                <div>
                  {results.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      token={token}
                      keyword={query}
                      onClick={() => openResult(item)}
                    />
                  ))}
                </div>
              ) : (
                // 全部 Tab：只渲染预览前 N 条，多余的引导切 Tab
                <>
                  {notesToRender.map((item) => (
                    <NoteRow
                      key={item.id}
                      item={item}
                      token={token}
                      keyword={query}
                      onClick={() =>
                        navigate(
                          `/notes/${item.id}?q=${encodeURIComponent(query)}`,
                        )
                      }
                    />
                  ))}
                  {results.length > ALL_MODE_NOTES_PREVIEW && (
                    <div className="py-2 text-center">
                      <a
                        onClick={() => setScope("notes")}
                        style={{ fontSize: 12, color: token.colorPrimary }}
                      >
                        查看全部 {results.length} 条文档 →
                      </a>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 分组标题 */
function SectionHeader({
  icon,
  label,
  count,
  token,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  token: ReturnType<typeof antdTheme.useToken>["token"];
}) {
  return (
    <div
      className="flex items-center gap-2 mb-2"
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: token.colorTextSecondary,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      <span style={{ color: token.colorPrimary }}>{icon}</span>
      <span>
        {label} · {count}
      </span>
    </div>
  );
}

/** 文档结果行（与原虚拟滚动样式一致） */
function NoteRow({
  item,
  token,
  keyword,
  onClick,
}: {
  item: SearchResult;
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 0",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: "pointer",
        display: "flex",
        gap: 12,
      }}
    >
      <NotebookText size={20} style={{ marginTop: 4, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          ellipsis
          style={{ display: "block", maxWidth: 500, fontWeight: 500 }}
        >
          {highlightText(item.title, keyword)}
        </Text>
        <div
          style={{
            fontSize: 13,
            marginTop: 4,
            marginBottom: 4,
            // 2 行截断让高亮大概率落在可见区域，避免单行被截走
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
            lineHeight: "1.5",
          }}
        >
          {highlightSnippet(item.snippet, keyword)}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {item.updated_at.slice(0, 10)}
        </Text>
      </div>
    </div>
  );
}

/** 待办结果行（与 CommandPalette 风格一致） */
function TaskRow({
  task,
  token,
  keyword,
  onClick,
}: {
  task: TaskSearchHit;
  token: ReturnType<typeof antdTheme.useToken>["token"];
  keyword: string;
  onClick: () => void;
}) {
  const done = task.status === 1;
  const urgent = task.priority === 0;
  const due = task.dueDate?.slice(0, 10) ?? null;
  return (
    <div
      onClick={onClick}
      style={{
        padding: "10px 0",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        cursor: "pointer",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      {done ? (
        <Check size={18} style={{ color: token.colorSuccess, marginTop: 2, flexShrink: 0 }} />
      ) : urgent ? (
        <AlertTriangle
          size={18}
          style={{ color: token.colorError, marginTop: 2, flexShrink: 0 }}
        />
      ) : (
        <CheckSquare
          size={18}
          style={{ color: token.colorTextSecondary, marginTop: 2, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          ellipsis
          style={{
            display: "block",
            maxWidth: 600,
            fontWeight: 500,
            textDecoration: done ? "line-through" : undefined,
            color: done ? token.colorTextTertiary : undefined,
          }}
        >
          {task.title ? highlightText(task.title, keyword) : "无标题"}
        </Text>
        {(due || task.snippet) && (
          <div
            style={{
              fontSize: 12,
              color: token.colorTextDescription,
              marginTop: 2,
            }}
          >
            {due && <span style={{ marginRight: 8 }}>📅 {due}</span>}
            {task.snippet && (
              <span
                style={{
                  display: "inline-block",
                  maxWidth: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
              >
                {task.snippet}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { MobileSearch } from "./MobileSearch";

export default function SearchPage() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileSearch /> : <DesktopSearchPage />;
}
