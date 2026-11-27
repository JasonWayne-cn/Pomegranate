import { Button, Modal, Typography } from "antd";
import { BookPlus, Eye, FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";

import "./ExternalOpenPrompt.css";

const { Text } = Typography;

interface Props {
  /** 待处理的外部文件路径；null 表示弹窗关闭 */
  path: string | null;
  onClose: () => void;
}

/**
 * 外部 Markdown 打开方式选择弹窗。
 *
 * 从资源管理器双击 .md / 应用已运行时被单实例转交文件时，先询问用户：
 * - 加入文档库：走 /notes/opening 导入并建立源文件同步
 * - 仅浏览：走 /notes/browse 只读查看，不写数据库、不修改原文件
 */
export function ExternalOpenPrompt({ path, onClose }: Props) {
  const navigate = useNavigate();
  const fileName = path ? path.split(/[\\/]/).pop() || path : "";

  function choose(target: "library" | "browse") {
    if (!path) return;
    onClose();
    const encoded = encodeURIComponent(path);
    navigate(
      target === "library"
        ? `/notes/opening?path=${encoded}`
        : `/notes/browse?path=${encoded}`,
    );
  }

  return (
    <Modal
      open={!!path}
      title="打开 Markdown 文件"
      footer={null}
      width={560}
      centered
      destroyOnClose
      onCancel={onClose}
    >
      <div className="external-open-file">
        <FileText size={16} />
        <div className="external-open-file-text">
          <Text strong ellipsis={{ tooltip: fileName }}>
            {fileName}
          </Text>
          <Text type="secondary" className="external-open-file-path" ellipsis={{ tooltip: path }}>
            {path}
          </Text>
        </div>
      </div>

      <div className="external-open-options">
        <button
          type="button"
          className="external-open-option"
          onClick={() => choose("library")}
        >
          <BookPlus size={20} className="external-open-option-icon" />
          <span>
            <span className="external-open-option-title">加入文档库</span>
            <span className="external-open-option-desc">
              导入到知识库，可在应用内编辑，并同步回原文件
            </span>
          </span>
        </button>

        <button
          type="button"
          className="external-open-option"
          onClick={() => choose("browse")}
        >
          <Eye size={20} className="external-open-option-icon" />
          <span>
            <span className="external-open-option-title">仅浏览（只读）</span>
            <span className="external-open-option-desc">
              直接查看内容，不加入文档库，也不会修改原文件
            </span>
          </span>
        </button>
      </div>

      <div className="external-open-footer">
        <Button type="text" onClick={onClose}>
          取消
        </Button>
      </div>
    </Modal>
  );
}
