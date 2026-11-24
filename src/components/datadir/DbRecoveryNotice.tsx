/**
 * 启动期数据库恢复提示
 *
 * 背景：`app.db` 打不开且判定为 SQLite 损坏时，Rust 侧会自动从最近可用备份恢复，
 * 或把损坏文件留档后用空库启动。这个组件把「用了哪份备份 / 原库在哪」告诉用户，
 * 避免用户以为数据凭空消失。
 *
 * 仅挂在主窗口（见 App.tsx）。
 */
import { useEffect, useState } from "react";
import { Alert, App as AntdApp, Button, Modal, Typography } from "antd";
import { dataDirApi } from "@/lib/api";
import type { DbRecoveryNotice as Notice } from "@/types";

const { Text, Paragraph } = Typography;

export function DbRecoveryNotice() {
  const { message } = AntdApp.useApp();
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setNotice(await dataDirApi.getDbRecoveryNotice());
      } catch {
        // 恢复提示是兜底信息，读不到不打扰用户
      }
    })();
  }, []);

  async function dismiss() {
    try {
      await dataDirApi.clearDbRecoveryNotice();
    } catch (e) {
      message.warning(`清除恢复提示失败: ${e}`);
    }
    setNotice(null);
  }

  if (!notice) return null;

  return (
    <Modal
      title="数据库已自动恢复"
      open
      onCancel={dismiss}
      width={640}
      footer={
        <Button type="primary" onClick={dismiss}>
          知道了
        </Button>
      }
    >
      <div className="text-sm leading-6">
        {notice.usedBackup ? (
          <Alert
            type="warning"
            showIcon
            className="mb-3"
            message="已从自动备份恢复，最后一次导入之后的改动可能丢失"
            description={
              <span style={{ fontSize: 12 }}>
                使用备份：
                <Paragraph
                  copyable={{ text: notice.usedBackup }}
                  style={{ margin: "4px 0 0", fontSize: 12 }}
                >
                  <Text code>{notice.usedBackup}</Text>
                </Paragraph>
              </span>
            }
          />
        ) : (
          <Alert
            type="error"
            showIcon
            className="mb-3"
            message="没有可用备份，已用空库启动"
            description={
              <span style={{ fontSize: 12 }}>
                原损坏文件已改名留档在数据目录（<Text code>.corrupt-*</Text>），没有被删除。
                可以在「设置 → 导入备份」里选择之前的备份包恢复数据。
              </span>
            }
          />
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          恢复时间：{notice.recoveredAt}
        </Text>
      </div>
    </Modal>
  );
}
