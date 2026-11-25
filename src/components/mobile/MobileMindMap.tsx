import { useMemo, useRef, useState } from "react";
import { message, theme as antdTheme } from "antd";
import {
  ArrowRightToLine,
  Columns2,
  CornerDownRight,
  Ellipsis,
  Maximize2,
  PencilLine,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { MindMapView, LAYOUT_KEY } from "@/components/notes/MindMapView";
import {
  MindMapEditor,
  type MindAction,
  type MindEditorState,
  type MindMapEditorHandle,
} from "@/components/mindmap/MindMapEditor";
import { parseMindMap } from "@/components/mindmap/tree";

interface Props {
  markdown: string;
  title: string;
  onClose: () => void;
  /** 传了才能编辑：改动以 Markdown 交回（父组件写进正文并自动保存） */
  onMarkdownChange?: (markdown: string) => void;
  /** 改中心主题 = 改文档标题 */
  onTitleChange?: (title: string) => void;
  /** 打开时直接进编辑（「新建思维导图」用） */
  defaultEditing?: boolean;
  /** 父页面暂时不允许编辑的原因（加密 / 阅读模式）；有值时编辑按钮置灰，点了提示原因 */
  editBlockedReason?: string;
}

/** 首次进编辑时提示一次手势（之后不再打扰） */
const TIP_KEY = "kb.mindmap.mobileTipShown";

/**
 * 手机端思维导图（全屏）：只读时沿用 markmap 视图；纯大纲文档可点「编辑」切到自研编辑器的触屏模式。
 *
 * 手机没有键盘快捷键和右键，所以：顶栏放撤销 / 重做 / 布局 / 适应，底部操作栏放加子节点 / 加同级 /
 * 改文字 / 删除 / 更多（更多 = 长按节点出的同一个面板）。见 docs/tasks/mindmap-plan.md
 */
export function MobileMindMap({
  markdown,
  title,
  onClose,
  onMarkdownChange,
  onTitleChange,
  defaultEditing = false,
  editBlockedReason,
}: Props) {
  const { token } = antdTheme.useToken();
  // 自己持有一份正文：编辑器写回后父组件不一定重渲染，切回只读视图时要显示最新的
  const [md, setMd] = useState(markdown);
  const [ttl, setTtl] = useState(title);
  const editability = useMemo(() => parseMindMap(md, ttl), [md, ttl]);
  const canEdit = !!onMarkdownChange;
  const disabledReason = editBlockedReason ?? (editability.editable ? undefined : editability.reason);
  const [editing, setEditing] = useState(defaultEditing && canEdit && !disabledReason);
  const [st, setSt] = useState<MindEditorState | null>(null);
  const [layoutMode, setLayoutMode] = useState<"both" | "right">(() =>
    localStorage.getItem(LAYOUT_KEY) === "right" ? "right" : "both",
  );
  const editorRef = useRef<MindMapEditorHandle | null>(null);
  const palette = [token.colorPrimary, token.colorInfo, token.colorSuccess, token.colorWarning];

  function close() {
    // 关之前把编辑器里的改动交出去，父组件才能拿最新正文重灌编辑器
    editorRef.current?.flush();
    onClose();
  }

  function toggleEditing() {
    if (editing) {
      editorRef.current?.flush();
      setEditing(false);
      return;
    }
    if (disabledReason) {
      message.info(disabledReason);
      return;
    }
    setEditing(true);
    if (!localStorage.getItem(TIP_KEY)) {
      localStorage.setItem(TIP_KEY, "1");
      message.info("点节点选中，再点一次改文字；长按节点更多操作；双指缩放", 4);
    }
  }

  function toggleLayout() {
    const next = layoutMode === "both" ? "right" : "both";
    setLayoutMode(next);
    localStorage.setItem(LAYOUT_KEY, next);
  }

  const act = (a: MindAction) => () => editorRef.current?.act(a);
  const isRoot = st?.isRoot ?? true;

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-12 shrink-0 items-center gap-0.5 pr-1.5 pl-1"
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <IconBtn label="关闭思维导图" onClick={close}>
          <X size={22} />
        </IconBtn>
        <span
          className="min-w-0 flex-1 truncate text-[15px] font-semibold"
          style={{ color: token.colorText }}
        >
          思维导图
        </span>
        {editing && (
          <>
            <IconBtn label="撤销" disabled={!st?.canUndo} onClick={() => editorRef.current?.undo()}>
              <Undo2 size={20} />
            </IconBtn>
            <IconBtn label="重做" disabled={!st?.canRedo} onClick={() => editorRef.current?.redo()}>
              <Redo2 size={20} />
            </IconBtn>
            <IconBtn
              label={layoutMode === "both" ? "布局：左右分布，点按改为全部向右" : "布局：全部向右，点按改为左右分布"}
              onClick={toggleLayout}
            >
              {layoutMode === "both" ? <Columns2 size={20} /> : <ArrowRightToLine size={20} />}
            </IconBtn>
            <IconBtn label="适应屏幕" onClick={() => editorRef.current?.fit()}>
              <Maximize2 size={20} />
            </IconBtn>
          </>
        )}
        {canEdit && (
          <button
            type="button"
            className="ml-1 h-[32px] shrink-0 rounded-lg px-3 text-[14px] font-semibold"
            style={
              editing
                ? { background: "var(--kb-primary)", color: "var(--kb-primary-contrast)" }
                : {
                    background: "var(--kb-surface-hover)",
                    color: disabledReason ? "var(--kb-text-tertiary)" : "var(--kb-text-primary)",
                  }
            }
            onClick={toggleEditing}
          >
            {editing ? "完成" : "编辑"}
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        {editing && onMarkdownChange ? (
          <MindMapEditor
            ref={editorRef}
            touch
            markdown={md}
            title={ttl}
            onChange={(next) => {
              setMd(next);
              onMarkdownChange(next);
            }}
            onTitleChange={
              onTitleChange &&
              ((t) => {
                setTtl(t);
                onTitleChange(t);
              })
            }
            palette={palette}
            layoutMode={layoutMode}
            onStateChange={setSt}
          />
        ) : (
          <MindMapView open onClose={close} markdown={md} title={ttl} variant="standalone" />
        )}
      </div>

      {editing && (
        <nav
          className="flex shrink-0"
          style={{
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            background: "var(--kb-bg-card)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
        >
          <BarBtn label="子节点" icon={<Plus size={20} />} onClick={act("child")} />
          <BarBtn label="同级" icon={<CornerDownRight size={20} />} disabled={isRoot} onClick={act("sibling")} />
          <BarBtn label="改文字" icon={<PencilLine size={20} />} disabled={isRoot && !onTitleChange} onClick={act("edit")} />
          <BarBtn label="删除" icon={<Trash2 size={20} />} disabled={isRoot} danger onClick={act("delete")} />
          <BarBtn label="更多" icon={<Ellipsis size={20} />} onClick={() => editorRef.current?.openMenu()} />
        </nav>
      )}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg active:bg-black/5 disabled:opacity-35"
      style={{ color: "var(--kb-text-primary)" }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function BarBtn({
  label,
  icon,
  disabled,
  danger,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[12px] disabled:opacity-35"
      style={{ color: danger ? "#d4380d" : "var(--kb-text-secondary)" }}
      disabled={disabled}
      // 按下不让焦点挪到按钮上：否则「子节点 / 改文字」弹出的输入框虽然拿到焦点，键盘却不出来（真机实测）
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
