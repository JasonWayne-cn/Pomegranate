import { useState, useCallback, useEffect, useMemo } from "react";
import type { Editor } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { Button, Divider, Tooltip, Modal, Input, message, Dropdown, Select, ColorPicker, Segmented, Popover } from "antd";
import type { MenuProps } from "antd";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Code,
   Search,
  Superscript as SuperscriptIcon, 
  Subscript as SubscriptIcon,
  IndentIncrease,
  IndentDecrease,
  Eraser,
  Paintbrush,
  Palette,
  Smile,
  Lightbulb,
  ChevronsUpDown,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  CodeSquare,
  Minus,
  Undo2,
  Redo2,
  Link as LinkIcon,
  ImagePlus,
  Captions,
  Film,
  Globe,
  Paperclip,
  Box,
  MapPin,
  Table as TableIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Rows3,
  Columns3,
  Trash2,
  ChevronDown,
  Type,
  Sparkles,
  Plus,
  Sigma,
  Calculator,
  PenTool,
  Scissors,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toKbAsset } from "@/lib/assetUrl";
import { VIEWER3D_IMPORT_EXTS } from "@/lib/viewer3d";
import { attachmentApi, imageApi, videoApi, noteApi, systemApi } from "@/lib/api";
import {
  EDITOR_FONT_LABELS,
  EDITOR_FONT_STACKS,
  resolveEditorFontStack,
  type EditorFontPreset,
} from "@/store";
import { createFakeSelectionPlugin, setFakeSelection } from "./fakeSelection";
import { cleanText, isBlankText } from "@/lib/editorCleanup";
import { MicButton } from "@/components/MicButton";
import { insertVideoTimestamp } from "./VideoTimestamp";
import { EmojiPanel } from "./EmojiPicker";
import { parseEmbedUrl, SUPPORTED_PROVIDERS } from "./embedVideoProviders";
import { useFormatPainter } from "./useFormatPainter";
import { CompareMergeDropdown } from "./CompareMergeDropdown";
import { AnnotationButton } from "./AnnotationButton";
import { mergeParagraphs, splitHardBreaks } from "./lineBreakCleanup";
import { PluginToolbarButtons } from "./PluginToolbarButtons";

interface ToolbarProps {
  editor: Editor;
  noteId?: number;
  /** 与 TiptapEditor 的同名 prop 含义一致：noteId 缺失时用它按需建档 */
  ensureNoteId?: () => Promise<number>;
}

interface ToolItem {
  icon: React.ReactNode;
  title: string;
  /** 普通按钮的点击；带 dropdownItems 时由下拉菜单各 item 自己 onClick，可省略 */
  action?: () => void;
  isActive?: () => boolean;
  /** T-017: 提供后按钮渲染为 Dropdown trigger，菜单展示 dropdownItems */
  dropdownItems?: MenuProps["items"];
  /** 完全自定义渲染（颜色选择 / Select 下拉等非 Button 控件用），提供则跳过默认 Button 渲染 */
  customRender?: () => React.ReactNode;
}

export function EditorToolbar({ editor, noteId, ensureNoteId }: ToolbarProps) {
  const formatPainter = useFormatPainter(editor);
  /** 合并颜色下拉的当前作用对象：文字颜色 / 背景颜色 */
  const [colorTarget, setColorTarget] = useState<"text" | "highlight">("text");
  /** 批注 / Emoji 合并下拉的展开状态 */
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  /** 收纳面板（排版等低频项）同一时间只开一个；点外部 / Esc 由 Popover 自行关闭 */
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  /** 「插入」两列面板 */
  const [insertOpen, setInsertOpen] = useState(false);

  /**
   * 统一换行：从 Word / 网页复制来的内容常混着「段内换行」和「真分段」，
   * 间距忽大忽小。这里只在用户显式点击时改写当前文档一次，并先弹确认。
   */
  function runLineBreakCleanup(mode: "split" | "merge") {
    const label =
      mode === "split"
        ? "把全文的段内换行（Shift+Enter）改成独立段落"
        : "把选中的相邻段落合并成一段（用段内换行连接）";
    Modal.confirm({
      title: mode === "split" ? "统一换行" : "合并段落",
      content: `将${label}。此操作会改写正文，可用 Ctrl+Z 撤销。`,
      okText: "继续",
      cancelText: "取消",
      onOk: () => {
        const res =
          mode === "split"
            ? splitHardBreaks(editor.state)
            : mergeParagraphs(editor.state);
        if (!res) {
          message.info(
            mode === "split" ? "没有可拆分的段内换行" : "请先选中至少两段相邻的文字",
          );
          return;
        }
        editor.view.dispatch(res.tr);
        editor.commands.focus();
        message.success(
          mode === "split"
            ? `已把 ${res.count} 处段内换行改为分段`
            : `已合并 ${res.count + 1} 段`,
        );
        setOpenPanel(null);
      },
    });
  }
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  /** 时间戳弹窗 state */
  const [tsModalOpen, setTsModalOpen] = useState(false);
  const [tsVideoId, setTsVideoId] = useState<string>("");
  const [tsTimeText, setTsTimeText] = useState<string>("00:00");
  /** 图注 / Alt 弹窗：选中图片 → 编辑 caption（图注）和 alt（替代文本） */
  const [captionModalOpen, setCaptionModalOpen] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [altDraft, setAltDraft] = useState("");
  /** 嵌入网络视频弹窗：粘贴 B站/YouTube/腾讯/优酷链接 → iframe 节点 */
  const [embedModalOpen, setEmbedModalOpen] = useState(false);
  const [embedUrlInput, setEmbedUrlInput] = useState("");
  /** 剪藏网页到当前文档光标处 */
  const [clipModalOpen, setClipModalOpen] = useState(false);
  const [clipUrlInput, setClipUrlInput] = useState("");
  /** 「字体」下拉的系统字体列表（模块级单飞缓存，多个编辑器实例只枚举一次） */
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void loadSystemFontsOnce().then((fonts) => {
      if (alive) setSystemFonts(fonts);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 伪选区 plugin：antd Select 打开会夺焦、原生选区蓝底消失，用它保持可见
  useEffect(() => {
    const plugin = createFakeSelectionPlugin(TOOLBAR_FAKE_SELECTION_KEY);
    editor.unregisterPlugin(TOOLBAR_FAKE_SELECTION_KEY);
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(TOOLBAR_FAKE_SELECTION_KEY);
    };
  }, [editor]);
  /**
   * 「字体」下拉选项。value 直接是完整 CSS font-family 值，与 textStyle mark 同构，
   * 选中态判定就是字符串相等；预设里的 system（空 stack）跳过——它和「默认」是一回事。
   */
  const fontFamilyOptions = useMemo(() => {
    const preset = (Object.keys(EDITOR_FONT_LABELS) as EditorFontPreset[])
      .filter((key) => !!EDITOR_FONT_STACKS[key])
      .map((key) => ({
        value: EDITOR_FONT_STACKS[key],
        searchText: `${EDITOR_FONT_LABELS[key]} ${key}`,
        label: (
          <span style={{ fontFamily: EDITOR_FONT_STACKS[key] }}>
            {EDITOR_FONT_LABELS[key]}
          </span>
        ),
      }));
    const system = systemFonts.map((name) => ({
      value: resolveEditorFontStack(name),
      searchText: name,
      label: (
        <span style={{ fontFamily: `"${name.replace(/["\\]/g, "")}"` }}>
          {name}
        </span>
      ),
    }));
    const clear = {
      value: FONT_FAMILY_CLEAR,
      searchText: "默认 清除字体 default",
      label: <span>默认（清除字体）</span>,
    };
    return system.length > 0
      ? [
          { label: "默认", options: [clear] },
          { label: "预设", options: preset },
          { label: `系统字体（${system.length}）`, options: system },
        ]
      : [
          { label: "默认", options: [clear] },
          { label: "预设", options: preset },
        ];
  }, [systemFonts]);

  function openCaptionModal() {
    if (!editor.isActive("imageResize")) {
      message.info("请先点击一张图片再编辑图注");
      return;
    }
    const attrs = editor.getAttributes("imageResize");
    setCaptionDraft(String(attrs.caption ?? ""));
    setAltDraft(String(attrs.alt ?? ""));
    setCaptionModalOpen(true);
  }

  function applyCaption() {
    const caption = captionDraft.trim();
    const alt = altDraft.trim();
    editor
      .chain()
      .focus()
      .updateAttributes("imageResize", {
        caption: caption || null,
        alt: alt || null,
      })
      .run();
    setCaptionModalOpen(false);
  }
  async function insertImage() {
    // 与 TiptapEditor.handleImageFiles 行为对齐：优先显式 noteId，
    // 缺失时尝试 ensureNoteId（日记按需建档），仍拿不到才 warning
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存文档后再插入图片");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const relPath = await imageApi.saveFromPath(effectiveNoteId, filePath);
        editor.chain().focus().insertContent({
          type: "imageResize",
          attrs: { src: toKbAsset(relPath) },
        }).run();
      } catch (e) {
        message.error(`图片插入失败: ${e}`);
      }
    }
  }

  /** 与 insertImage 对称：从文件选择器导入视频走 saveFromPath（零拷贝），
   *  插入 video node。复用 TiptapEditor 已有的 VideoNode 渲染。
   *  视频文件大（GB 级），用 saveFromPath 而非 base64 上传，避免主进程内存爆。 */
  async function insertVideo() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`视频插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存文档后再插入视频");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "视频",
          extensions: ["mp4", "mov", "webm", "m4v", "ogv", "mkv", "avi"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const relPath = await videoApi.saveFromPath(effectiveNoteId, filePath);
        editor.chain().focus().insertContent({
          type: "video",
          attrs: { src: toKbAsset(relPath), id: Math.random().toString(36).slice(2, 10) },
        }).run();
      } catch (e) {
        message.error(`视频插入失败: ${e}`);
      }
    }
  }

  /** 嵌入网络视频：解析 URL → iframe 节点。
   *  与 insertVideo 不同，这里不落本地文件，纯靠 iframe 在线播放。
   *  支持 B站 / YouTube / 腾讯视频 / 优酷（详见 embedVideoProviders.ts）。 */
  function handleEmbedConfirm() {
    const raw = embedUrlInput.trim();
    if (!raw) {
      message.warning("请输入视频链接");
      return;
    }
    const parsed = parseEmbedUrl(raw);
    if (!parsed) {
      message.error(`无法识别的链接，目前支持：${SUPPORTED_PROVIDERS}`);
      return;
    }
    editor
      .chain()
      .focus()
      .setEmbedVideo({
        src: parsed.embedUrl,
        originalUrl: parsed.originalUrl,
        provider: parsed.provider,
      })
      .run();
    setEmbedUrlInput("");
    setEmbedModalOpen(false);
    message.success(`已嵌入${parsed.providerName}视频`);
  }

  /** 与 insertVideo 对称：从文件选择器选附件 → saveFromPath 零拷贝 →
   *  插入 `📎 文件名 (大小)` Link 节点（与 TiptapEditor 拖入逻辑同款渲染，
   *  保持 markdown 序列化零改造）。
   *  PDF/Office/ZIP/音视频/通用文件都走这里；exe/bat 等被后端黑名单拦掉。 */
  async function insertAttachment() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`附件插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存文档后再插入附件");
      return;
    }
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "附件",
          // 与后端 mime_for_ext 列表对齐；不含 exe/bat（后端黑名单）
          extensions: [
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "zip", "rar", "7z", "tar", "gz",
            "mp3", "wav", "ogg", "flac", "m4a",
            "csv", "json", "xml", "yaml", "yml", "txt", "md",
          ],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];

    const nodes: Array<
      | { type: "text"; text: string; marks: Array<{ type: "link"; attrs: { href: string } }> }
      | { type: "text"; text: string }
    > = [];
    for (const filePath of paths) {
      try {
        const info = await attachmentApi.saveFromPath(effectiveNoteId, filePath);
        const label = `📎 ${info.fileName} (${formatSize(info.size)})`;
        // info.path 是相对 data_dir 的 POSIX 路径；存 kb-asset:// 跨数据目录可移植
        const href = toKbAsset(info.path);
        nodes.push({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] });
        nodes.push({ type: "text", text: "\n" });
      } catch (e) {
        message.error(`附件插入失败: ${e}`);
      }
    }
    if (nodes.length > 0) {
      editor.chain().focus().insertContent(nodes).run();
    }
  }

  /**
   * 插入三维模型：选中文件 → 零拷贝保存到文档附件目录 → 插入 viewer3d 节点。
   *
   * 节点只存 `kb-asset://<rel>`；真正的引擎在点击卡片后由预览 Modal 按需加载。
   * 当前内置引擎支持 core 格式；CAD（step/iges/3dm/ifc）待扩展包接入。
   */
  async function insertViewer3d() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`三维模型插入失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存文档后再插入三维模型");
      return;
    }

    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "三维模型",
          extensions: [...VIEWER3D_IMPORT_EXTS],
        },
      ],
    });
    if (typeof selected !== "string") return;

    try {
      const info = await attachmentApi.saveFromPath(effectiveNoteId, selected);
      editor.chain().focus().setViewer3D({
        src: toKbAsset(info.path),
        name: info.fileName,
        size: info.size,
      }).run();
      message.success("已插入三维模型，点击卡片可预览");
    } catch (e) {
      message.error(`三维模型插入失败: ${e}`);
    }
  }

  /** 收集当前文档所有 video 节点（含 id + 显示名 + src 文件名），给时间戳弹窗下拉用 */
  function collectVideosInDoc(): Array<{ id: string; label: string; src: string }> {
    const list: Array<{ id: string; label: string; src: string }> = [];
    let autoIdx = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name !== "video") return true;
      autoIdx += 1;
      const id = String(n.attrs.id ?? "");
      const userLabel = String(n.attrs.label ?? "");
      const src = String(n.attrs.src ?? "");
      const label = userLabel || `视频 ${autoIdx}`;
      list.push({ id, label, src });
      return true;
    });
    return list;
  }

  /** 打开"插入时间戳"弹窗：自动选中第一个视频 */
  function openTimestampModal() {
    const videos = collectVideosInDoc();
    if (videos.length === 0) {
      message.warning("当前文档还没有视频，请先插入视频");
      return;
    }
    const valid = videos.filter((v) => v.id);
    if (valid.length === 0) {
      message.warning("视频缺少 ID。请重新打开此文档触发自动补 ID 后再试");
      return;
    }
    setTsVideoId(valid[0].id);
    setTsTimeText("00:00");
    setTsModalOpen(true);
  }

  /** 弹窗确认：解析 mm:ss / hh:mm:ss → 秒数 → insertVideoTimestamp */
  function handleTimestampConfirm() {
    const seconds = parseTimeToSeconds(tsTimeText);
    if (seconds == null) {
      message.error("时间格式不对，请用 mm:ss 或 hh:mm:ss（如 01:40）");
      return;
    }
    const videos = collectVideosInDoc();
    const target = videos.find((v) => v.id === tsVideoId);
    if (!target) {
      message.error("未找到选中的视频");
      return;
    }
    insertVideoTimestamp(editor, {
      videoId: tsVideoId,
      seconds,
      label: `📹 ${target.label} · ${formatTimeShort(seconds)}`,
    });
    setTsModalOpen(false);
  }

  const openLinkModal = useCallback(() => {
    const previousUrl = editor.getAttributes("link").href || "";
    setLinkUrl(previousUrl);
    setLinkModalOpen(true);
  }, [editor]);

  const handleLinkConfirm = useCallback(() => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    setLinkModalOpen(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

  // ── 「插入」两列面板（对齐 KB 的插入面板）──────────────────
  type InsertAction = {
    key: string;
    label: string;
    icon: React.ReactNode;
    action?: () => void;
    items?: MenuProps["items"];
  };
  const insertActions: InsertAction[] = [
    { key: "link", label: "链接", icon: <LinkIcon size={15} />, action: openLinkModal },
    { key: "image", label: "图片", icon: <ImagePlus size={15} />, action: insertImage },
    { key: "caption", label: "图注 / Alt", icon: <Captions size={15} />, action: openCaptionModal },
    { key: "video", label: "视频", icon: <Film size={15} />, action: insertVideo },
    {
      key: "whiteboard",
      label: "白板",
      icon: <PenTool size={15} />,
      action: () => editor.chain().focus().insertWhiteboard().run(),
    },
    {
      key: "columns",
      label: "分栏",
      icon: <Columns3 size={15} />,
      items: [2, 3, 4, 5].map((n) => ({
        key: `columns-${n}`,
        label: `${n} 栏`,
        onClick: () => editor.chain().focus().setColumns(n).run(),
      })),
    },
    {
      key: "callout",
      label: "Callout",
      icon: <Lightbulb size={15} />,
      items: [
        { key: "info", label: <span><span style={{ marginRight: 6 }}>ℹ️</span>信息</span>, onClick: () => editor.chain().focus().toggleCallout("info").run() },
        { key: "tip", label: <span><span style={{ marginRight: 6 }}>💡</span>提示</span>, onClick: () => editor.chain().focus().toggleCallout("tip").run() },
        { key: "warning", label: <span><span style={{ marginRight: 6 }}>⚠️</span>警告</span>, onClick: () => editor.chain().focus().toggleCallout("warning").run() },
        { key: "danger", label: <span><span style={{ marginRight: 6 }}>❌</span>危险</span>, onClick: () => editor.chain().focus().toggleCallout("danger").run() },
      ],
    },
    {
      key: "code",
      label: "代码块",
      icon: <CodeSquare size={15} />,
      items: [
        { key: "plain", label: "普通代码块", onClick: () => editor.chain().focus().toggleCodeBlock().run() },
        {
          key: "mermaid",
          label: "Mermaid 流程图",
          onClick: () =>
            editor
              .chain()
              .focus()
              .insertContent({
                type: "codeBlock",
                attrs: { language: "mermaid" },
                content: [
                  {
                    type: "text",
                    text: "flowchart TD\n  A[开始] --> B{判断}\n  B -- 是 --> C[执行]\n  B -- 否 --> D[结束]",
                  },
                ],
              })
              .run(),
        },
      ],
    },
    {
      key: "toggle",
      label: "折叠块",
      icon: <ChevronsUpDown size={15} />,
      action: () => editor.chain().focus().setToggle().run(),
    },
    {
      key: "math",
      label: "公式",
      icon: <Sigma size={15} />,
      items: [
        {
          key: "inline",
          icon: <Calculator size={14} />,
          label: "行内公式 $…$",
          onClick: () =>
            editor.chain().focus().insertContent({ type: "inlineMath", attrs: { latex: "" } }).run(),
        },
        {
          key: "block",
          icon: <Sigma size={14} />,
          label: "块级公式 $$…$$",
          onClick: () =>
            editor.chain().focus().insertContent({ type: "blockMath", attrs: { latex: "" } }).run(),
        },
      ],
    },
    {
      key: "embed",
      label: "嵌入视频",
      icon: <Globe size={15} />,
      action: () => {
        setEmbedUrlInput("");
        setEmbedModalOpen(true);
      },
    },
    { key: "viewer3d", label: "三维模型", icon: <Box size={15} />, action: insertViewer3d },
    {
      key: "clip",
      label: "剪藏网页",
      icon: <Scissors size={15} />,
      action: () => {
        setClipUrlInput("");
        setClipModalOpen(true);
      },
    },
    { key: "timestamp", label: "视频时间戳", icon: <MapPin size={15} />, action: openTimestampModal },
    { key: "attachment", label: "附件", icon: <Paperclip size={15} />, action: insertAttachment },
    {
      key: "hr",
      label: "分割线",
      icon: <Minus size={15} />,
      action: () => editor.chain().focus().setHorizontalRule().run(),
    },
  ];

  const groups: ToolItem[][] = [
    // 清除格式 / 格式刷（最左）
    [
      {
        icon: <Eraser size={15} />,
        title: "清除格式",
        action: () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
      },
      {
        icon: null,
        title: "格式刷",
        customRender: () => (
          <Tooltip
            title="格式刷（单击应用一次，双击持续）"
            mouseEnterDelay={0.5}
          >
            <Button
              type="text"
              size="small"
              icon={<Paintbrush size={15} />}
              onClick={() => formatPainter.pickOnce()}
              onDoubleClick={() => formatPainter.pickPersist()}
              className={formatPainter.mode !== "idle" ? "toolbar-btn-active" : ""}
              style={{ minWidth: 26, height: 26, padding: 0 }}
            />
          </Tooltip>
        ),
      },
    ],
    // 输入辅助
    [
      {
        icon: null,
        title: "语音输入",
        customRender: () => (
          <MicButton
            onTranscribed={(text) =>
              editor.chain().focus().insertContent(text).run()
            }
          />
        ),
      },
    ],
    // 撤销 / 重做
    [
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <Undo2 size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "撤销 / 重做",
        dropdownItems: [
          {
            key: "undo",
            icon: <Undo2 size={14} />,
            label: "撤销",
            onClick: () => editor.chain().focus().undo().run(),
          },
          {
            key: "redo",
            icon: <Redo2 size={14} />,
            label: "重做",
            onClick: () => editor.chain().focus().redo().run(),
          },
        ],
      },
    ],
    // 段落 / 字号 / 行高 / 格式
    [
      {
        icon: null,
        title: "段落格式",
        customRender: () => (
          <Dropdown
            trigger={["click"]}
            placement="bottomLeft"
            menu={{
              items: [
                { key: "p",  label: <span>正文</span> },
                { key: "h1", label: <span style={{ fontSize: 18, fontWeight: 700 }}>H1 一级标题</span> },
                { key: "h2", label: <span style={{ fontSize: 16, fontWeight: 700 }}>H2 二级标题</span> },
                { key: "h3", label: <span style={{ fontSize: 15, fontWeight: 600 }}>H3 三级标题</span> },
                { key: "h4", label: <span style={{ fontSize: 14, fontWeight: 600 }}>H4 四级标题</span> },
                { key: "h5", label: <span style={{ fontSize: 13 }}>H5 五级标题</span> },
                { key: "h6", label: <span style={{ fontSize: 13 }}>H6 六级标题</span> },
              ],
              onClick: ({ key }) => applyBlockType(editor, key as BlockType),
              selectedKeys: [getCurrentBlockType(editor)],
            }}
          >
            <Button
              type="text"
              size="small"
              style={{ minWidth: 72, height: 28, padding: "0 6px" }}
            >
              <span className="inline-flex items-center gap-1">
                {labelOfBlockType(getCurrentBlockType(editor))}
                <ChevronDown size={12} style={{ opacity: 0.6 }} />
              </span>
            </Button>
          </Dropdown>
        ),
      },
      {
        icon: null,
        title: "字号",
        customRender: () => {
          const cur = (editor.getAttributes("textStyle").fontSize as string) || "";
          return (
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              menu={{
                items: [
                  { key: "__clear__", label: "默认字号" },
                  { type: "divider" } as const,
                  ...FONT_SIZE_OPTIONS.map((o) => ({ key: o.value, label: o.label })),
                ],
                selectedKeys: cur ? [cur] : ["__clear__"],
                onClick: ({ key }) => {
                  if (key === "__clear__") {
                    editor.chain().focus().unsetFontSize().run();
                  } else {
                    editor.chain().focus().setFontSize(key).run();
                  }
                },
              }}
            >
              <Button type="text" size="small" style={{ minWidth: 56, height: 28, padding: "0 6px" }}>
                <span className="inline-flex items-center gap-1">
                  {cur ? cur.replace("px", "") : "字号"}
                  <ChevronDown size={12} style={{ opacity: 0.6 }} />
                </span>
              </Button>
            </Dropdown>
          );
        },
      },
      {
        icon: null,
        title: "行间距",
        customRender: () => {
          const cur =
            (editor.getAttributes("paragraph").lineHeight as string) ||
            (editor.getAttributes("heading").lineHeight as string) ||
            "";
          return (
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              menu={{
                items: [
                  { key: "__clear__", label: "默认行高" },
                  { type: "divider" } as const,
                  ...LINE_HEIGHT_OPTIONS.map((o) => ({ key: o.value, label: o.label })),
                ],
                selectedKeys: cur ? [cur] : ["__clear__"],
                onClick: ({ key }) => {
                  if (key === "__clear__") {
                    editor.chain().focus().unsetLineHeight().run();
                  } else {
                    editor.chain().focus().setLineHeight(key).run();
                  }
                },
              }}
            >
              <Button type="text" size="small" style={{ minWidth: 56, height: 28, padding: "0 6px" }}>
                <span className="inline-flex items-center gap-1">
                  {cur ? cur : "行高"}
                  <ChevronDown size={12} style={{ opacity: 0.6 }} />
                </span>
              </Button>
            </Dropdown>
          );
        },
      },
      {
        // 字体族（作用于选中文字）
        icon: null,
        title: "字体",
        customRender: () => {
          const cur = (editor.getAttributes("textStyle").fontFamily as string) || "";
          return (
            <Tooltip title="字体（作用于选中文字）" mouseEnterDelay={0.5}>
              <Select
                size="small"
                showSearch
                value={cur || FONT_FAMILY_CLEAR}
                // 面板一行放下「下拉 + 名称」，110px 内显示首个字体名足够
                style={{ width: 110 }}
                // 选中态只显示首个字体名，不把整条 fallback 链塞进 128px 的框里
                labelRender={({ value }) => (
                  <span>{shortFontLabel(String(value))}</span>
                )}
                filterOption={(input, option) => {
                  const opt = option as
                    | { searchText?: string; value?: string }
                    | undefined;
                  const t = String(opt?.searchText ?? opt?.value ?? "");
                  return t.toLowerCase().includes(input.trim().toLowerCase());
                }}
                options={fontFamilyOptions}
                // 打开时铺伪选区（Select 会夺焦，原生蓝底会消失），关闭即清
                onOpenChange={(open) => {
                  const { from, to } = editor.state.selection;
                  setFakeSelection(
                    editor,
                    TOOLBAR_FAKE_SELECTION_KEY,
                    open && from !== to ? { from, to } : null,
                  );
                }}
                onChange={(v) => {
                  if (v === FONT_FAMILY_CLEAR) {
                    editor.chain().focus().unsetFontFamily().run();
                  } else {
                    editor.chain().focus().setFontFamily(String(v)).run();
                  }
                  setFakeSelection(editor, TOOLBAR_FAKE_SELECTION_KEY, null);
                }}
              />
            </Tooltip>
          );
        },
      },
      {
        // 从网页 / Word 复制来的内容：空行、空格、中英文挤在一起
        icon: null,
        title: "格式规整",
        customRender: () => (
          <Tooltip title="格式规整（清理从别处复制来的内容）" mouseEnterDelay={0.5}>
            <Dropdown
              trigger={["click"]}
              placement="bottomLeft"
              menu={{
                items: [
                  {
                    key: "cleanup-blank",
                    label: "删除多余空行",
                    onClick: dropBlankParagraphs,
                  },
                  {
                    key: "cleanup-linebreaks",
                    label: "统一换行（段内换行改为分段）",
                    onClick: () => runLineBreakCleanup("split"),
                  },
                  {
                    key: "cleanup-merge",
                    label: "选中段落合并为紧凑行",
                    onClick: () => runLineBreakCleanup("merge"),
                  },
                  { type: "divider" },
                  {
                    key: "cleanup-spaces",
                    label: "去除首尾空格 / 压缩连续空格",
                    onClick: () =>
                      cleanAllText({ trim: true, squeeze: true }, "整理空格"),
                  },
                  {
                    key: "cleanup-cjk",
                    label: "中英文之间补空格",
                    onClick: () => cleanAllText({ cjkSpacing: true }, "补空格"),
                  },
                ],
              }}
            >
              <Button type="text" size="small" icon={<Sparkles size={15} />} />
            </Dropdown>
          </Tooltip>
        ),
      },
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <Bold size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "文本修饰",
        isActive: () =>
          editor.isActive("bold") ||
          editor.isActive("italic") ||
          editor.isActive("underline") ||
          editor.isActive("strike") ||
          editor.isActive("highlight") ||
          editor.isActive("code") ||
          editor.isActive("superscript") ||
          editor.isActive("subscript"),
        dropdownItems: [
          {
            key: "bold",
            icon: <Bold size={14} />,
            label: "粗体",
            onClick: () => editor.chain().focus().toggleBold().run(),
          },
          {
            key: "italic",
            icon: <Italic size={14} />,
            label: "斜体",
            onClick: () => editor.chain().focus().toggleItalic().run(),
          },
          {
            key: "underline",
            icon: <Underline size={14} />,
            label: "下划线",
            onClick: () => editor.chain().focus().toggleUnderline().run(),
          },
          {
            key: "strikethrough",
            icon: <Strikethrough size={14} />,
            label: "删除线",
            onClick: () => editor.chain().focus().toggleStrike().run(),
          },
          {
            key: "highlight",
            icon: <Highlighter size={14} />,
            label: "高亮",
            onClick: () => editor.chain().focus().toggleHighlight().run(),
          },
          {
            key: "inline-code",
            icon: <Code size={14} />,
            label: "行内代码",
            onClick: () => editor.chain().focus().toggleCode().run(),
          },
          {
            key: "superscript",
            icon: <SuperscriptIcon size={14} />,
            label: "上标",
            onClick: () => editor.chain().focus().toggleSuperscript().run(),
          },
          {
            key: "subscript",
            icon: <SubscriptIcon size={14} />,
            label: "下标",
            onClick: () => editor.chain().focus().toggleSubscript().run(),
          },
        ],
      },
    ],
    // 字体颜色 / 背景颜色（合并为一个下拉）
    [
      {
        icon: null,
        title: "字体颜色 / 背景颜色",
        customRender: () => (
          <Tooltip title="字体颜色 / 背景颜色" mouseEnterDelay={0.5}>
            <ColorPicker
              size="small"
              value={
                colorTarget === "text"
                  ? (editor.getAttributes("textStyle").color as string) || "#000000"
                  : (editor.getAttributes("highlight").color as string) || "#ffe58f"
              }
              allowClear
              onChange={(c) => {
                const hex = c.toHexString();
                if (colorTarget === "text") {
                  editor.chain().focus().setColor(hex).run();
                } else {
                  editor.chain().focus().toggleHighlight({ color: hex }).run();
                }
              }}
              onClear={() => {
                if (colorTarget === "text") {
                  editor.chain().focus().unsetColor().run();
                } else {
                  editor.chain().focus().unsetHighlight().run();
                }
              }}
              presets={[
                {
                  label: "常用",
                  colors:
                    colorTarget === "text"
                      ? [
                          "#000000", "#595959", "var(--kb-text-tertiary)", "var(--kb-border)", "#ffffff",
                          "#ff4d4f", "#fa8c16", "#fadb14", "#52c41a", "var(--kb-primary)",
                          "#722ed1", "#eb2f96",
                        ]
                      : [
                          "#ffe58f", "#ffadd2", "#b7eb8f", "#91d5ff", "#ffd6e7",
                          "#fff1b8", "#d9f7be", "#bae7ff", "#f0f5ff", "#fff7e6",
                        ],
                },
              ]}
              panelRender={(panel) => (
                <div>
                  <Segmented
                    size="small"
                    block
                    value={colorTarget}
                    onChange={(v) => setColorTarget(v as "text" | "highlight")}
                    options={[
                      { label: "字体颜色", value: "text" },
                      { label: "背景颜色", value: "highlight" },
                    ]}
                    style={{ marginBottom: 8 }}
                  />
                  {panel}
                </div>
              )}
            >
              <Button
                type="text"
                size="small"
                style={{ minWidth: 40, height: 26, padding: "0 4px" }}
              >
                <span className="inline-flex items-center gap-0.5">
                  <Palette size={15} />
                  <ChevronDown size={11} style={{ opacity: 0.6 }} />
                </span>
              </Button>
            </ColorPicker>
          </Tooltip>
        ),
      },
    ],
    // 对齐
    [
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <AlignLeft size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "对齐",
        isActive: () =>
          editor.isActive({ textAlign: "left" }) ||
          editor.isActive({ textAlign: "center" }) ||
          editor.isActive({ textAlign: "right" }),
        dropdownItems: [
          {
            key: "left",
            icon: <AlignLeft size={14} />,
            label: "左对齐",
            onClick: () => editor.chain().focus().setTextAlign("left").run(),
          },
          {
            key: "center",
            icon: <AlignCenter size={14} />,
            label: "居中",
            onClick: () => editor.chain().focus().setTextAlign("center").run(),
          },
          {
            key: "right",
            icon: <AlignRight size={14} />,
            label: "右对齐",
            onClick: () => editor.chain().focus().setTextAlign("right").run(),
          },
          { type: "divider" } as const,
          {
            key: "outdent",
            icon: <IndentDecrease size={14} />,
            label: "减少缩进",
            onClick: () => editor.chain().focus().outdent().run(),
          },
          {
            key: "indent",
            icon: <IndentIncrease size={14} />,
            label: "增加缩进",
            onClick: () => editor.chain().focus().indent().run(),
          },
        ],
      },
    ],
    // 列表 & 引用
    [
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <List size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "列表",
        isActive: () =>
          editor.isActive("bulletList") ||
          editor.isActive("orderedList") ||
          editor.isActive("taskList") ||
          editor.isActive("blockquote"),
        dropdownItems: [
          {
            key: "bullet",
            icon: <List size={14} />,
            label: "无序列表",
            onClick: () => editor.chain().focus().toggleBulletList().run(),
          },
          {
            key: "ordered",
            icon: <ListOrdered size={14} />,
            label: "有序列表",
            onClick: () => editor.chain().focus().toggleOrderedList().run(),
          },
          {
            key: "task",
            icon: <ListTodo size={14} />,
            label: "任务列表",
            onClick: () => editor.chain().focus().toggleTaskList().run(),
          },
          { type: "divider" } as const,
          {
            // 引用并入列表下拉（Callout 在「插入」面板）
            key: "blockquote",
            icon: <Quote size={14} />,
            label: "引用",
            onClick: () => editor.chain().focus().toggleBlockquote().run(),
          },
        ],
      },
    ],
    // 表格 — T-017 全部命令折叠到 Dropdown 菜单，避免工具栏过挤
    [
      {
        icon: (
          <span className="inline-flex items-center gap-0.5">
            <TableIcon size={15} />
            <ChevronDown size={11} style={{ opacity: 0.6 }} />
          </span>
        ),
        title: "表格",
        isActive: () => editor.isActive("table"),
        dropdownItems: [
          {
            key: "insert",
            icon: <TableIcon size={14} />,
            label: "插入 3×3 表格",
            onClick: () =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run(),
          },
          { type: "divider" },
          {
            key: "add-col",
            icon: <Columns3 size={14} />,
            label: "在右侧加列",
            disabled: !editor.can().addColumnAfter(),
            onClick: () => editor.chain().focus().addColumnAfter().run(),
          },
          {
            key: "add-row",
            icon: <Rows3 size={14} />,
            label: "在下方加行",
            disabled: !editor.can().addRowAfter(),
            onClick: () => editor.chain().focus().addRowAfter().run(),
          },
          { type: "divider" },
          {
            key: "merge-cells",
            label: "合并单元格",
            disabled: !editor.can().mergeCells(),
            onClick: () => editor.chain().focus().mergeCells().run(),
          },
          {
            key: "split-cell",
            label: "拆分单元格",
            disabled: !editor.can().splitCell(),
            onClick: () => editor.chain().focus().splitCell().run(),
          },
          { type: "divider" },
          {
            key: "delete-row",
            label: "删除当前行",
            disabled: !editor.can().deleteRow(),
            onClick: () => editor.chain().focus().deleteRow().run(),
          },
          {
            key: "delete-col",
            label: "删除当前列",
            disabled: !editor.can().deleteColumn(),
            onClick: () => editor.chain().focus().deleteColumn().run(),
          },
          { type: "divider" },
          {
            key: "toggle-header-row",
            label: "切换首行表头",
            disabled: !editor.can().toggleHeaderRow(),
            onClick: () => editor.chain().focus().toggleHeaderRow().run(),
          },
          {
            key: "toggle-header-col",
            label: "切换首列表头",
            disabled: !editor.can().toggleHeaderColumn(),
            onClick: () => editor.chain().focus().toggleHeaderColumn().run(),
          },
          { type: "divider" },
          {
            key: "delete-table",
            icon: <Trash2 size={14} />,
            label: "删除整个表格",
            danger: true,
            disabled: !editor.can().deleteTable(),
            onClick: () => editor.chain().focus().deleteTable().run(),
          },
        ],
      },
    ],
    // 链接 & 媒体
    [
      {
        // 两列插入面板：图标 + 名称，带下拉的条目（分栏 / Callout / 代码块 / 公式）各自展开
        icon: null,
        title: "插入",
        customRender: () => (
          <Popover
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            open={insertOpen}
            onOpenChange={setInsertOpen}
            content={
              <div className="grid grid-cols-2 gap-1" style={{ width: 320 }}>
                {insertActions.map((it) =>
                  it.items ? (
                    <Dropdown
                      key={it.key}
                      trigger={["click"]}
                      placement="bottomLeft"
                      menu={{ items: it.items }}
                    >
                      <Button
                        type="text"
                        size="small"
                        style={{ height: 30, justifyContent: "flex-start" }}
                      >
                        <span className="inline-flex items-center gap-2">
                          {it.icon}
                          <span className="text-[12px]">{it.label}</span>
                          <ChevronDown size={11} style={{ opacity: 0.5 }} />
                        </span>
                      </Button>
                    </Dropdown>
                  ) : (
                    <Button
                      key={it.key}
                      type="text"
                      size="small"
                      style={{ height: 30, justifyContent: "flex-start" }}
                      onClick={() => {
                        it.action?.();
                        setInsertOpen(false);
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        {it.icon}
                        <span className="text-[12px]">{it.label}</span>
                      </span>
                    </Button>
                  ),
                )}
              </div>
            }
          >
            <Tooltip title="插入" mouseEnterDelay={0.5}>
              <Button type="text" size="small" className="kb-fmt-drop">
                <Plus size={15} />
                <span>插入</span>
                <ChevronDown size={11} style={{ opacity: 0.6 }} />
              </Button>
            </Tooltip>
          </Popover>
        ),
      },
      {
        // 真实批注按钮 + Emoji 下拉（批注需在选中文字后使用）
        icon: null,
        title: "批注 / 插入 Emoji",
        customRender: () => (
          <span className="inline-flex items-center">
            <AnnotationButton editor={editor} />
            <Tooltip title="插入 Emoji" mouseEnterDelay={0.5}>
              <Dropdown
                open={insertMenuOpen}
                onOpenChange={setInsertMenuOpen}
                trigger={["click"]}
                placement="bottomLeft"
                popupRender={() => (
                  <div
                    style={{
                      padding: 8,
                      background: "var(--ant-color-bg-elevated, #fff)",
                      borderRadius: 8,
                      boxShadow:
                        "var(--ant-box-shadow-secondary, 0 6px 16px rgba(0, 0, 0, 0.12))",
                    }}
                  >
                    <EmojiPanel
                      editor={editor}
                      onInsert={() => setInsertMenuOpen(false)}
                    />
                  </div>
                )}
              >
                <Button
                  type="text"
                  size="small"
                  style={{ minWidth: 40, height: 26, padding: "0 4px" }}
                >
                  <span className="inline-flex items-center gap-0.5">
                    <Smile size={15} />
                    <ChevronDown size={11} style={{ opacity: 0.6 }} />
                  </span>
                </Button>
              </Dropdown>
            </Tooltip>
          </span>
        ),
      },
    ],
    // 查找 & 对比
    [
      {
        icon: <Search size={15} />,
        title: "查找替换",
        action: () => {
          const sel = window.getSelection()?.toString() || "";
          document.dispatchEvent(new CustomEvent("kb:find-replace", { detail: { searchText: sel } }));
        },
      },
      {
        // 对比 / 合并下拉：与剪贴板、与其它文档
        icon: null,
        title: "对比 / 合并",
        customRender: () => (
          <CompareMergeDropdown editor={editor} noteId={noteId} />
        ),
      },
    ],
  ];

  // ── v4 布局：以上 groups 的条目定义（图标 / 行为 / 下拉 / 弹窗）一个都不动，
  // 这里只决定「摆在哪」。低频的排版项收进「排版」面板，其余保持常驻；
  // 没被点名摆放的条目（含日后新增的）自动追加到最后一组，绝不因改版悄悄消失。
  const renderItem = (item: ToolItem, key: React.Key) => {
    if (item.customRender) {
      return (
        <span key={key} className="inline-flex items-center">
          {item.customRender()}
        </span>
      );
    }
    const btn = (
      <Button
        type="text"
        size="small"
        icon={item.icon}
        onClick={item.dropdownItems ? undefined : item.action}
        className={item.isActive?.() ? "toolbar-btn-active" : ""}
        style={{
          // 带 dropdownItems 双图标按钮宽 40，普通单图标 26 紧凑
          minWidth: item.dropdownItems ? 40 : 26,
          height: 26,
          padding: item.dropdownItems ? "0 4px" : 0,
        }}
      />
    );
    if (item.dropdownItems) {
      return (
        <Tooltip key={key} title={item.title} mouseEnterDelay={0.5}>
          <Dropdown
            menu={{ items: item.dropdownItems }}
            trigger={["click"]}
            placement="bottomLeft"
          >
            {btn}
          </Dropdown>
        </Tooltip>
      );
    }
    return (
      <Tooltip key={key} title={item.title} mouseEnterDelay={0.5}>
        {btn}
      </Tooltip>
    );
  };

  /** 收纳面板：触发按钮 + 弹层里逐行列出原条目（图标 + 名称），各自的下拉 / 控件照常工作 */
  const panel = (
    key: string,
    trigger: React.ReactNode,
    title: string,
    items: ToolItem[],
  ): ToolItem | null => {
    if (items.length === 0) return null;
    return {
      icon: null,
      title,
      customRender: () => (
        <Popover
          trigger="click"
          placement="bottomLeft"
          arrow={false}
          open={openPanel === key}
          onOpenChange={(o) => setOpenPanel(o ? key : null)}
          content={
            <div style={{ minWidth: 200 }} onKeyDown={(e) => {
              if (e.key === "Escape") setOpenPanel(null);
            }}>
              {items.map((it, i) => (
                <div
                  key={it.title}
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-black/5 transition-colors"
                  onClick={() => {
                    // 普通按钮：点整行都算点按钮，点完收起面板；带下拉 / 自定义控件的行交给控件自己处理
                    if (it.action && !it.dropdownItems && !it.customRender) {
                      it.action();
                      setOpenPanel(null);
                    }
                  }}
                >
                  <span className="inline-flex min-w-[64px] shrink-0 items-center justify-center">
                    {renderItem(it, i)}
                  </span>
                  <span className="text-[12px] whitespace-nowrap">{it.title}</span>
                </div>
              ))}
            </div>
          }
        >
          <Tooltip title={title} mouseEnterDelay={0.5}>
            <Button
              type="text"
              size="small"
              className={
                openPanel === key ? "kb-fmt-drop toolbar-btn-active" : "kb-fmt-drop"
              }
            >
              {trigger}
              <ChevronDown size={11} />
            </Button>
          </Tooltip>
        </Popover>
      ),
    };
  };

  const byTitle = new Map(groups.flat().map((it) => [it.title, it] as const));
  const placed = new Set<string>();
  const pick = (...titles: string[]): ToolItem[] =>
    titles.flatMap((t) => {
      const it = byTitle.get(t);
      if (!it) return [];
      placed.add(t);
      return [it];
    });
  const layoutGroupsRaw: (ToolItem | null)[][] = [
    // 清除格式 / 格式刷固定在工具栏最左侧（老位置，高频）
    pick("清除格式", "格式刷"),
    pick("撤销 / 重做"),
    // 块级：标题 / 对齐 / 列表(编号，含引用)
    pick("段落格式", "对齐", "列表"),
    // 行内：字体（含在排版面板） / 字体颜色 / 文本修饰
    [
      ...pick("字体颜色 / 背景颜色"),
      // 字体 / 字号 / 行间距合并进同一个下拉面板（对齐 KB 的排版面板）
      panel(
        "typo",
        <Type size={15} />,
        "字体 / 字号 / 行间距 / 格式规整",
        pick("字体", "字号", "行间距", "格式规整"),
      ),
      ...pick("文本修饰"),
    ],
    pick("表格", "插入"),
    pick("批注 / 插入 Emoji", "语音输入", "查找替换", "对比 / 合并"),
  ];
  const leftovers = groups.flat().filter((it) => !placed.has(it.title));
  const layoutGroups: ToolItem[][] = [
    ...layoutGroupsRaw.map((g) => g.filter((it): it is ToolItem => it != null)),
    leftovers,
  ].filter((g) => g.length > 0);

  /** 删除连续空段落（连着的只保留第一个），一次 transaction 可整体撤销 */
  function dropBlankParagraphs() {
    const { state, view } = editor;
    const tr = state.tr;
    const ranges: { from: number; to: number }[] = [];
    let prevBlank = false;
    state.doc.forEach((node, offset) => {
      const blank =
        node.type.name === "paragraph" && isBlankText(node.textContent ?? "");
      if (blank && prevBlank) ranges.push({ from: offset, to: offset + node.nodeSize });
      prevBlank = blank;
    });
    if (ranges.length === 0) {
      message.info("没有多余空行");
      return;
    }
    // 从后往前删，避免前面的删除让后面的偏移失效
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      tr.delete(ranges[i].from, ranges[i].to);
    }
    view.dispatch(tr);
    message.success(`已删除 ${ranges.length} 个多余空行`);
  }

  /** 按规则清洗所有正文文字；行内 code / 代码块跳过（空格有语义） */
  function cleanAllText(
    rules: { trim?: boolean; squeeze?: boolean; cjkSpacing?: boolean },
    label: string,
  ) {
    const { state, view, schema } = editor;
    const tr = state.tr;
    let count = 0;
    state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      if (node.marks.some((m) => m.type.name === "code")) return true;
      if (state.doc.resolve(pos).parent.type.name === "codeBlock") return false;
      const cleaned = cleanText(node.text, rules);
      if (cleaned === node.text) return true;
      const from = tr.mapping.map(pos);
      const to = tr.mapping.map(pos + node.text.length);
      tr.replaceWith(from, to, cleaned ? schema.text(cleaned, node.marks) : []);
      count += 1;
      return true;
    });
    if (count === 0) {
      message.info(`没有需要${label}的内容`);
      return;
    }
    view.dispatch(tr);
    message.success(`已${label} ${count} 处`);
  }

  /** 剪藏网页正文，插入到当前文档光标处（不新建文档） */
  async function clipWebPage() {
    let effectiveNoteId = noteId;
    if (!effectiveNoteId && ensureNoteId) {
      try {
        effectiveNoteId = await ensureNoteId();
      } catch (e) {
        message.error(`剪藏失败: ${e}`);
        return;
      }
    }
    if (!effectiveNoteId) {
      message.warning("请先保存文档后再剪藏网页");
      return;
    }
    const url = clipUrlInput.trim();
    if (!url) return;
    try {
      const html = await noteApi.clipUrlToHtml(url, effectiveNoteId);
      if (!html?.trim()) {
        message.warning("没有抓到正文，请检查链接或剪藏服务配置");
        return;
      }
      editor.chain().focus().insertContent(html).run();
      message.success("已剪藏网页正文到光标处");
      setClipModalOpen(false);
      setClipUrlInput("");
    } catch (e) {
      message.error(`剪藏失败：${e}`);
    }
  }

  /**
   * 阻止 toolbar 内 mousedown 默认 focus 切换。
   * Why: 用户在编辑器选中文本后点 toolbar 按钮 / Select / ColorPicker 时，
   *      浏览器原生行为会把 focus 移到目标元素 → ProseMirror selection
   *      虽然数据上还在，但浏览器不再渲染选区蓝色高亮（视觉上"失焦"）。
   *      preventDefault mousedown 能阻止 focus 切换，但不影响 click 事件，
   *      antd Select/ColorPicker 仍能正常打开 popup。Modal/portal 弹层位于
   *      document.body 末尾，事件不会冒泡到这里，互不影响。
   */
  function handleToolbarMouseDown(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    // antd Select / ColorPicker 依赖 mousedown 默认行为打开 popup，跳过这些
    // （它们自己内部 focus 处理；onChange 时我们再 chain().focus() 恢复 editor）
    if (t.closest(".ant-select, .ant-color-picker, .ant-select-selector, .ant-popover")) {
      return;
    }
    e.preventDefault();
  }

  return (
    <>
      <div className="tiptap-toolbar" onMouseDown={handleToolbarMouseDown}>
        {layoutGroups.map((group, gi) => (
          <span key={gi} className="inline-flex items-center">
            {gi > 0 && (
              <Divider orientation="vertical" style={{ height: 18, margin: "0 1px", borderColor: "var(--ant-color-border-secondary, var(--kb-border))" }} />
            )}
            {group.map((item, ii) => renderItem(item, ii))}
          </span>
        ))}
        <PluginToolbarButtons editor={editor} noteId={noteId} />
      </div>

      <Modal
        title="插入链接"
        open={linkModalOpen}
        onOk={handleLinkConfirm}
        onCancel={() => { setLinkModalOpen(false); setLinkUrl(""); }}
        okText="确定"
        cancelText="取消"
        width={420}
        destroyOnHidden
      >
        <Input
          placeholder="请输入链接地址，如 https://example.com"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          onPressEnter={handleLinkConfirm}
          autoFocus
        />
        <div className="mt-2 text-xs" style={{ color: "var(--ant-color-text-quaternary)" }}>
          留空并确定将移除当前链接
        </div>
      </Modal>

      {/* 插入视频时间戳弹窗 */}
      <Modal
        title="插入视频时间戳"
        open={tsModalOpen}
        onOk={handleTimestampConfirm}
        onCancel={() => setTsModalOpen(false)}
        okText="插入"
        cancelText="取消"
        width={460}
        destroyOnHidden
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--ant-color-text-secondary)" }}>
              选择视频
            </div>
            <Select
              style={{ width: "100%" }}
              value={tsVideoId}
              onChange={(v) => setTsVideoId(v)}
              options={collectVideosInDoc()
                .filter((v) => v.id)
                .map((v) => ({
                  value: v.id,
                  label: `${v.label} · ${shortFileName(v.src)}`,
                }))}
            />
          </div>
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--ant-color-text-secondary)" }}>
              时间（mm:ss 或 hh:mm:ss）
            </div>
            <Input
              value={tsTimeText}
              onChange={(e) => setTsTimeText(e.target.value)}
              onPressEnter={handleTimestampConfirm}
              placeholder="如 01:40 或 1:23:45"
              autoFocus
            />
            <div className="mt-1 text-xs" style={{ color: "var(--ant-color-text-quaternary)" }}>
              提示：在视频块顶部点「📍 加时间戳」可一键采用当前播放位置
            </div>
          </div>
        </div>
      </Modal>

      {/* 嵌入网络视频弹窗：粘贴 URL → iframe */}
      <Modal
        title="嵌入网络视频"
        open={embedModalOpen}
        onOk={handleEmbedConfirm}
        onCancel={() => setEmbedModalOpen(false)}
        okText="嵌入"
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <div className="space-y-2">
          <Input
            value={embedUrlInput}
            onChange={(e) => setEmbedUrlInput(e.target.value)}
            onPressEnter={handleEmbedConfirm}
            placeholder="粘贴视频链接，如 https://www.bilibili.com/video/BVxxx"
            autoFocus
          />
          <div
            className="text-xs"
            style={{
              color: "var(--ant-color-text-quaternary)",
              lineHeight: 1.6,
            }}
          >
            支持平台：{SUPPORTED_PROVIDERS}
            <br />
            提示：嵌入视频依赖联网播放，离线时无法观看；导出 HTML
            会保留嵌入，导出 Markdown 也可保留 iframe 标签。
          </div>
        </div>
      </Modal>

      {/* 剪藏网页正文到当前文档 */}
      <Modal
        title="剪藏网页到当前文档"
        open={clipModalOpen}
        onOk={() => void clipWebPage()}
        onCancel={() => setClipModalOpen(false)}
        okText="剪藏并插入"
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <div className="space-y-2">
          <Input
            value={clipUrlInput}
            onChange={(e) => setClipUrlInput(e.target.value)}
            onPressEnter={() => void clipWebPage()}
            placeholder="粘贴网页链接，如 https://example.com/article"
            autoFocus
          />
          <div className="text-xs" style={{ color: "var(--ant-color-text-quaternary)", lineHeight: 1.6 }}>
            抓取正文并插入到当前光标处（不新建文档）；图片会保存到本文档的附件目录。
          </div>
        </div>
      </Modal>

      {/* 图注 / Alt 弹窗：选中图片后用 */}
      <Modal
        title="编辑图注与替代文本"
        open={captionModalOpen}
        onCancel={() => setCaptionModalOpen(false)}
        onOk={applyCaption}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>图注（caption）</div>
            <Input.TextArea
              value={captionDraft}
              onChange={(e) => setCaptionDraft(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="例：图 1：系统架构图"
              autoFocus
            />
          </div>
          <div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              替代文本（alt，无障碍 / 搜索用）
            </div>
            <Input
              value={altDraft}
              onChange={(e) => setAltDraft(e.target.value)}
              placeholder="不显示给用户，但搜索引擎和读屏器会读"
            />
          </div>
          <div
            className="text-xs"
            style={{ color: "var(--ant-color-text-quaternary)", lineHeight: 1.5 }}
          >
            提示：只有"图注"非空时，导出 markdown 才会落 HTML &lt;figure&gt; 块；
            否则保持标准 ![alt](url) 写法，与其他文档工具兼容。
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── 段落格式下拉 helpers ─────────────────────────

type BlockType = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function getCurrentBlockType(editor: Editor): BlockType {
  for (let lv = 1; lv <= 6; lv++) {
    if (editor.isActive("heading", { level: lv })) {
      return `h${lv}` as BlockType;
    }
  }
  return "p";
}

function labelOfBlockType(t: BlockType): string {
  if (t === "p") return "正文";
  return t.toUpperCase();
}

function applyBlockType(editor: Editor, type: BlockType): void {
  if (type === "p") {
    editor.chain().focus().setParagraph().run();
    return;
  }
  const lv = parseInt(type.slice(1), 10);
  if (lv >= 1 && lv <= 6) {
    editor
      .chain()
      .focus()
      .setHeading({ level: lv as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
  }
}

/** 「字体」下拉里代表"清除字体"的哨兵 value（不会与真实 font-family 值撞车） */
const FONT_FAMILY_CLEAR = "__clear__";

/** 工具栏用的伪选区 key：与 AI 写作菜单各用各的，互不干扰 */
const TOOLBAR_FAKE_SELECTION_KEY = new PluginKey<DecorationSet>(
  "kb-toolbar-fake-selection",
);

/**
 * 把一条 font-family 值压成短标签：只取首个字体名并去掉引号。
 * 完整 fallback 链动辄上百字符塞不进工具栏；从 Word 粘进来的未知字体也能显示名字。
 */
function shortFontLabel(value: string): string {
  if (!value || value === FONT_FAMILY_CLEAR) return "字体";
  const first = value.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || "字体";
}

/**
 * 系统已装字体的模块级单飞缓存：枚举一次要跑 Rust 侧，工具栏会随每个编辑器实例挂载，
 * 没必要各枚举一遍。失败时缓存空数组 → 下拉只剩预设，不反复重试。
 */
let systemFontsPromise: Promise<string[]> | null = null;
function loadSystemFontsOnce(): Promise<string[]> {
  if (!systemFontsPromise) {
    systemFontsPromise = systemApi.listSystemFonts().catch(() => []);
  }
  return systemFontsPromise;
}

const FONT_SIZE_OPTIONS = [
  { value: "12px", label: "12" },
  { value: "13px", label: "13" },
  { value: "14px", label: "14" },
  { value: "15px", label: "15" },
  { value: "16px", label: "16" },
  { value: "18px", label: "18" },
  { value: "20px", label: "20" },
  { value: "24px", label: "24" },
  { value: "30px", label: "30" },
  { value: "36px", label: "36" },
  { value: "48px", label: "48" },
];

const LINE_HEIGHT_OPTIONS = [
  { value: "1", label: "1.0" },
  { value: "1.15", label: "1.15" },
  { value: "1.4", label: "1.4" },
  { value: "1.6", label: "1.6" },
  { value: "1.8", label: "1.8" },
  { value: "2", label: "2.0" },
];

/** 解析 mm:ss 或 hh:mm:ss 文本为秒数；非法返回 null */
function parseTimeToSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  if (parts.length === 1) {
    return parseInt(parts[0], 10);
  }
  if (parts.length === 2) {
    const [m, s] = parts.map((p) => parseInt(p, 10));
    if (s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts.map((p) => parseInt(p, 10));
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/** 秒数 → 短格式（mm:ss 或 h:mm:ss） */
function formatTimeShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** 取 src 路径里的文件名（视频路径太长时下拉里更可读） */
function shortFileName(src: string): string {
  if (!src) return "(未命名)";
  try {
    const decoded = decodeURIComponent(src);
    const last = decoded.split(/[\\/]/).pop() || decoded;
    return last.length > 40 ? last.slice(0, 37) + "..." : last;
  } catch {
    return src.slice(-40);
  }
}

/** 字节数 → 人类可读（与 TiptapEditor.humanSize 同实现，避免跨文件 import） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

