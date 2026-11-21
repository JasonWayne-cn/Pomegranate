import { useState } from "react";
import {
  Button,
  Dropdown,
  Input,
  Modal,
  message,
  theme as antdTheme,
} from "antd";
import { useNavigate } from "react-router-dom";
import { ChevronDown, FolderPlus, FolderSync } from "lucide-react";

import { folderApi } from "@/lib/api";
import { useAppStore } from "@/store";

interface Props {
  /** 图标按钮模式（窄侧栏/工具栏用） */
  iconOnly?: boolean;
  /** 新虚拟文件夹的父目录；null / undefined = 根目录 */
  parentId?: number | null;
  /** 外层样式扩展 */
  style?: React.CSSProperties;
}

/**
 * 「新建文件夹」下拉按钮。
 *
 * 两个入口与页面语义一致：
 * - 创建虚拟文件夹：系统原有文件夹（可嵌套在当前目录下）
 * - 外部目录设置：打开同步文件夹（外部挂载）配置
 *
 * 右侧文档页与左侧文档面板复用同一组件，保证行为一致。
 */
export function FolderCreateButton({ iconOnly, parentId, style }: Props) {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning("请输入文件夹名称");
      return;
    }
    setCreating(true);
    try {
      await folderApi.create(trimmed, parentId ?? undefined);
      message.success(`已创建文件夹「${trimmed}」`);
      setModalOpen(false);
      setName("");
      useAppStore.getState().bumpFoldersRefresh();
    } catch (e) {
      message.error(`创建文件夹失败：${e}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            {
              key: "virtual",
              icon: <FolderPlus size={14} />,
              label: "创建虚拟文件夹",
              onClick: () => {
                setName("");
                setModalOpen(true);
              },
            },
            {
              key: "sync",
              icon: <FolderSync size={14} />,
              label: "外部目录设置",
              onClick: () => navigate("/notes?config=mounts"),
            },
          ],
        }}
      >
        {iconOnly ? (
          <Button
            type="text"
            size="small"
            icon={<FolderPlus size={14} />}
            title="新建文件夹"
            style={{ width: 24, height: 24, padding: 0, ...style }}
          />
        ) : (
          <Button icon={<FolderPlus size={14} />} style={style}>
            新建文件夹
            <ChevronDown size={12} />
          </Button>
        )}
      </Dropdown>

      <Modal
        title="新建虚拟文件夹"
        open={modalOpen}
        onOk={() => void handleCreate()}
        confirmLoading={creating}
        onCancel={() => {
          if (!creating) setModalOpen(false);
        }}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void handleCreate()}
          placeholder="文件夹名称"
          autoFocus
        />
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: token.colorTextTertiary,
          }}
        >
          {parentId ? "将创建在当前文件夹下" : "将创建在根目录"}
        </div>
      </Modal>
    </>
  );
}
