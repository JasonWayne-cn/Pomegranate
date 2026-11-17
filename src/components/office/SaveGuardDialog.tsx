/** 关闭未保存文档时的三选一确认。 */
import { Button, Modal } from "antd";

interface SaveGuardDialogProps {
  open: boolean;
  fileName: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function SaveGuardDialog({
  open,
  fileName,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: SaveGuardDialogProps) {
  return (
    <Modal
      open={open}
      title="文档尚未保存"
      closable={false}
      maskClosable={false}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="discard" danger onClick={onDiscard}>
          不保存
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={onSave}>
          保存并关闭
        </Button>,
      ]}
    >
      <p className="m-0">
        「{fileName}」有未保存的修改。关闭前是否保存？
      </p>
    </Modal>
  );
}
