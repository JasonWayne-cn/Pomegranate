import { useState } from "react";
import { Button, Dropdown, Space, message, type MenuProps } from "antd";
import type { SizeType } from "antd/es/config-provider/SizeContext";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  ChevronDown,
  LayoutTemplate,
  FolderOpen,
  PenTool,
  Network,
} from "lucide-react";

import { FileTypeIcon } from "./FileTypeIcon";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { ImportPreviewModal } from "./ImportPreviewModal";
import { importApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { ScannedFile } from "@/types";
import {
  createBlankAndOpen,
  createMindMapAndOpen,
  createWhiteboardAndOpen,
  importPdfsFlow,
  importTextFlow,
  importWordFlow,
} from "@/lib/noteCreator";

interface Props {
  /** 创建/导入时归入的文件夹 id；顶层创建传 null */
  folderId?: number | null;
  /** 侧边栏折叠态：只显示 + 图标，不带下拉 */
  collapsed?: boolean;
  /** 图标按钮 + 下拉菜单：单图标入口，菜单里包含新建空白/模板/导入等全部方式 */
  iconOnly?: boolean;
  /** 块级占满父容器宽度（首页/文档页大按钮用） */
  block?: boolean;
  /** 主按钮文字，默认"新建文档" */
  label?: string;
  /** 外层样式扩展 */
  style?: React.CSSProperties;
  /** 按钮尺寸（透传给内部 Button），默认 middle；首页大按钮用 large */
  size?: SizeType;
}

/**
 * "+ 新建文档"分段按钮：主按钮直接创建空白文档并跳转编辑器，
 * 右侧 ▼ 下拉承载"从模板 / 导入 MD / PDF / Word"的次要入口。
 *
 * 取代了旧的 CreateNoteModal（Tab 切换式）—— 常用路径 1 次点击可达，
 * 模板/导入仍然发现性足够。
 */
export function NewNoteButton({
  folderId = null,
  collapsed = false,
  iconOnly = false,
  block = false,
  label = "新建文档",
  style,
  size,
}: Props) {
  const navigate = useNavigate();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    files: ScannedFile[];
    rootPath: string;
    folderId: number | null;
  } | null>(null);

  // 没有文件夹上下文时（顶部+按钮 / 首页大按钮）套用全局默认；
  // 有 folderId（NotesPanel 文件夹下嵌入）就遵循上下文
  const handleCreate = () =>
    createBlankAndOpen(folderId, navigate, { useDefaults: folderId == null });

  const handleCreateWhiteboard = () =>
    createWhiteboardAndOpen(folderId, navigate);

  const handleCreateMindMap = () =>
    createMindMapAndOpen(folderId, navigate);

  // 选目录 → 扫描 → 弹 ImportPreviewModal。与 NotesPanel.handleImportMdFolder 同源。
  // Why: 文件夹导入要让用户选副本策略 + 是否保留根目录层级，所以单独走 Modal 流，
  // 不能像 importTextFlow 那样"选完直接建"。
  async function handleImportMdFolder() {
    try {
      const picked = await openDialog({
        directory: true,
        title: "选择要导入的 Markdown 文件夹",
      });
      if (!picked || Array.isArray(picked)) return;
      const rootPath = picked;
      const hide = message.loading("扫描中…", 0);
      let files: ScannedFile[];
      try {
        files = await importApi.scan(rootPath);
      } catch (e) {
        hide();
        message.error(`扫描失败: ${e}`);
        return;
      }
      hide();
      if (files.length === 0) {
        message.info("该文件夹下没有 .md 文件");
        return;
      }
      setImportPreview({ files, rootPath, folderId });
    } catch (e) {
      message.error(`选择目录失败: ${e}`);
    }
  }

  // 模板 / 导入等次要入口；「新建白板」由外层菜单组合，避免重复项
  const secondaryMenuItems: MenuProps["items"] = [
    {
      key: "template",
      label: "从模板…",
      icon: <LayoutTemplate size={14} />,
      onClick: () => setTemplateOpen(true),
    },
    { type: "divider" },
    {
      key: "import-text",
      label: "导入 Markdown / TXT…",
      icon: <FileTypeIcon type="md" size={14} />,
      onClick: () => importTextFlow(folderId, navigate),
    },
    {
      key: "import-md-folder",
      label: "导入 Markdown 文件夹…",
      icon: <FolderOpen size={14} />,
      onClick: () => {
        void handleImportMdFolder();
      },
    },
    {
      key: "import-pdf",
      label: "导入 PDF…",
      icon: <FileTypeIcon type="pdf" size={14} />,
      onClick: () => importPdfsFlow(folderId, navigate),
    },
    {
      key: "import-docx",
      label: "导入 Word…",
      icon: <FileTypeIcon type="docx" size={14} />,
      onClick: () => importWordFlow(folderId, navigate),
    },
  ];

  /** 主按钮旁 ▼ 下拉：新建白板 + 模板 / 导入 */
  const menuItems: MenuProps["items"] = [
    {
      key: "whiteboard",
      label: "新建白板",
      icon: <PenTool size={14} />,
      onClick: () => {
        void handleCreateWhiteboard();
      },
    },
    {
      key: "mindmap",
      label: "新建思维导图",
      icon: <Network size={14} />,
      onClick: () => {
        void handleCreateMindMap();
      },
    },
    { type: "divider" },
    ...(secondaryMenuItems ?? []),
  ];

  /** 图标按钮模式：把"新建空白文档"和原有次要入口合并进一个下拉菜单 */
  const iconMenuItems: MenuProps["items"] = [
    {
      key: "blank",
      label: "新建空白文档",
      icon: <Plus size={14} />,
      onClick: handleCreate,
    },
    {
      key: "whiteboard",
      label: "新建白板",
      icon: <PenTool size={14} />,
      onClick: () => {
        void handleCreateWhiteboard();
      },
    },
    {
      key: "mindmap",
      label: "新建思维导图",
      icon: <Network size={14} />,
      onClick: () => {
        void handleCreateMindMap();
      },
    },
    { type: "divider" },
    ...(secondaryMenuItems ?? []),
  ];

  const templatePickerModal = (
    <TemplatePickerModal
      open={templateOpen}
      folderId={folderId}
      onClose={() => setTemplateOpen(false)}
    />
  );

  const importPreviewModal = importPreview ? (
    <ImportPreviewModal
      open
      files={importPreview.files}
      rootPath={importPreview.rootPath}
      onCancel={() => setImportPreview(null)}
      onConfirm={async ({ policy, preserveRoot }) => {
        const { files, rootPath, folderId: targetFolderId } = importPreview;
        setImportPreview(null);
        const paths = files.map((f) => f.path);
        const hide = message.loading(`正在导入 ${paths.length} 个文件…`, 0);
        try {
          const result = await importApi.importSelected(
            paths,
            targetFolderId,
            rootPath,
            preserveRoot,
            policy,
          );
          hide();
          const parts: string[] = [];
          if (result.imported > 0) parts.push(`导入 ${result.imported} 篇`);
          if (result.duplicated > 0) parts.push(`副本 ${result.duplicated} 篇`);
          if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 篇`);
          if (result.tags_attached && result.tags_attached > 0) {
            parts.push(`关联标签 ${result.tags_attached} 条`);
          }
          if (result.attachments_copied && result.attachments_copied > 0) {
            parts.push(`复制图片 ${result.attachments_copied} 张`);
          }
          if (parts.length > 0) message.success(parts.join("，"));
          const missCount = result.attachments_missing?.length ?? 0;
          if (missCount > 0) {
            message.warning(
              `${missCount} 张图片在 vault 里找不到，已保留原引用`,
            );
            console.warn(
              "[import] 缺失图片清单:",
              result.attachments_missing,
            );
          }
          if (result.errors.length > 0) {
            message.warning(
              `${result.errors.length} 个文件失败，详见控制台`,
            );
            console.warn("[import] 失败明细:", result.errors);
          }
          useAppStore.getState().bumpNotesRefresh();
          useAppStore.getState().bumpFoldersRefresh();
        } catch (e) {
          hide();
          message.error(`导入失败: ${e}`);
        }
      }}
    />
  ) : null;

  // 折叠态：只显示单图标按钮（下拉菜单在折叠态占地方也没意义）
  if (collapsed) {
    return (
      <>
        <Button
          type="primary"
          icon={<Plus size={16} />}
          onClick={handleCreate}
          title="新建文档 (Ctrl+N)"
          style={style}
        />
        {templatePickerModal}
      </>
    );
  }

  // 图标 + 下拉：单图标入口，菜单包含全部新建方式（侧栏/工具栏用）
  if (iconOnly) {
    return (
      <>
        <Dropdown
          trigger={["click"]}
          menu={{ items: iconMenuItems }}
          placement="bottomRight"
        >
          <Button
            type="text"
            size="small"
            icon={<Plus size={14} />}
            title="新建文档"
            style={{ width: 24, height: 24, padding: 0, ...style }}
          />
        </Dropdown>
        {templatePickerModal}
        {importPreviewModal}
      </>
    );
  }

  return (
    <>
      <Space.Compact style={block ? { width: "100%", ...style } : style}>
        <Button
          type="primary"
          size={size}
          icon={<Plus size={14} />}
          onClick={handleCreate}
          title="新建文档 (Ctrl+N)"
          style={block ? { flex: 1 } : undefined}
        >
          {label}
        </Button>
        <Dropdown
          menu={{ items: menuItems }}
          trigger={["click"]}
          placement="bottomRight"
        >
          <Button
            type="primary"
            size={size}
            icon={<ChevronDown size={14} />}
            title="更多创建方式"
          />
        </Dropdown>
      </Space.Compact>
      {templatePickerModal}
      {importPreviewModal}
    </>
  );
}
