import { useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Typography,
  message,
  type ButtonProps,
} from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { packageApi, pluginApi } from "@/lib/api";
import { extensionApi } from "@/lib/api/extension";
import type { PackageKind, PluginInfo, PluginInspection } from "@/types";
import type { ExtensionInfo, ExtensionInspection } from "@/types/extension";

const { Text } = Typography;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type PendingInspection =
  | { kind: "plugin"; path: string; inspection: PluginInspection }
  | { kind: "extension"; path: string; inspection: ExtensionInspection };

export interface PackageInstallButtonProps {
  label?: string;
  icon?: ReactNode;
  /** 安装成功后回调；插件与扩展共用同一入口，通过 kind 区分 */
  onInstalled?: (
    kind: PackageKind,
    result: PluginInfo | ExtensionInfo,
  ) => void | Promise<void>;
  buttonProps?: Omit<ButtonProps, "onClick" | "loading" | "children" | "icon">;
}

/**
 * 统一安装入口（自动识别内部类型）。
 *
 * 流程：选择 zip → 读取清单判定类型 → 对应预检 → 统一确认弹窗 → 对应安装。
 * 对用户只呈现“安装扩展”，不展示插件 / 扩展包的区分；
 * 内部仍保留各自的安全边界：插件走权限授权，扩展走兼容性校验。
 */
export function PackageInstallButton({
  label = "安装包",
  icon,
  onInstalled,
  buttonProps,
}: PackageInstallButtonProps) {
  const [installing, setInstalling] = useState(false);
  const [pending, setPending] = useState<PendingInspection | null>(null);

  async function handlePick() {
    let picked: string | string[] | null = null;
    try {
      picked = await openDialog({
        multiple: false,
        directory: false,
        title: "选择安装包",
        filters: [{ name: "插件 / 扩展包", extensions: ["zip"] }],
      });
    } catch (e) {
      message.error(String(e));
      return;
    }
    if (!picked || Array.isArray(picked)) return;

    setInstalling(true);
    try {
      const kind = await packageApi.detectKind(picked);
      if (kind === "plugin") {
        const inspection = await pluginApi.inspectZip(picked);
        setPending({ kind, path: picked, inspection });
      } else {
        const inspection = await extensionApi.inspectZip(picked);
        setPending({ kind, path: picked, inspection });
      }
    } catch (e) {
      message.error(`无法识别或预检安装包：${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    setInstalling(true);
    try {
      const kind = pending.kind;
      let result: PluginInfo | ExtensionInfo;
      if (kind === "plugin") {
        result = await pluginApi.installFromZip(pending.path);
      } else {
        result = await extensionApi.installZip(pending.path);
      }
      setPending(null);
      message.success("已安装");
      // 两个管理页共享同一入口，安装后统一通知双方刷新
      window.dispatchEvent(new Event("app:plugins-changed"));
      window.dispatchEvent(new Event("app:extensions-changed"));
      await onInstalled?.(kind, result);
    } catch (e) {
      message.error(`安装失败：${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  const manifest = pending?.inspection.manifest;
  const permissions = manifest?.permissions ?? [];
  const allowed =
    !pending ||
    pending.kind === "plugin" ||
    pending.inspection.compatible;
  const blockedReason =
    pending?.kind === "extension"
      ? (pending.inspection.reason ?? "当前环境不兼容该安装包。")
      : null;

  return (
    <>
      <Button
        type="primary"
        icon={icon}
        loading={installing}
        onClick={() => void handlePick()}
        {...buttonProps}
      >
        {label}
      </Button>

      <Modal
        open={!!pending}
        title={manifest ? `安装 ${manifest.name} v${manifest.version}` : "安装"}
        width={560}
        okText="确认安装"
        cancelText="取消"
        confirmLoading={installing}
        okButtonProps={{ disabled: !allowed }}
        onOk={() => void handleConfirm()}
        onCancel={() => {
          if (!installing) setPending(null);
        }}
      >
        {pending && (
          <div className="space-y-3">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="ID">
                {pending.inspection.manifest.id}
              </Descriptions.Item>
              <Descriptions.Item label="文件数">
                {pending.inspection.fileCount}
              </Descriptions.Item>
              <Descriptions.Item label="解压体积">
                {formatBytes(pending.inspection.uncompressedBytes)}
              </Descriptions.Item>
            </Descriptions>

            <Alert
              type="info"
              showIcon
              message="权限声明"
              description={
                permissions.length ? permissions.join("、") : "无额外权限"
              }
            />

            {!allowed && (
              <Alert
                type="warning"
                showIcon
                message="当前环境无法安装"
                description={blockedReason}
              />
            )}

            <Text type="secondary" style={{ fontSize: 12 }}>
              安装前请确认来源可信。
            </Text>
          </div>
        )}
      </Modal>
    </>
  );
}
