import { Modal, Button, Progress, Typography, Space } from "antd";
import {
  CheckCircleOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUpdater } from "@/components/updater/UpdaterProvider";

const { Text, Paragraph } = Typography;

/**
 * 自动更新失败时的"手动下载"备选地址（顺序与发布配置一致）。
 * 下载由 Rust 自动换源；全部失败时再给用户一个能手动打开的 release 页。
 */
const FALLBACK_DOWNLOAD_PAGES = [
  {
    label: "Gitee Releases（国内推荐）",
    url: "https://gitee.com/kadywen/Pomegranate-release/releases",
  },
  {
    label: "GitHub Releases（海外）",
    url: "https://github.com/JasonWayne-cn/Pomegranate/releases",
  },
];

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * 软件更新弹窗。状态与动作全部来自 `useUpdater()`（Rust 单路下载），
 * 这里只负责把快照渲染成下载 / 暂停 / 取消 / 重启 / 手动下载入口。
 */
export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const updater = useUpdater();
  if (!updater) return null;

  const {
    update,
    phase,
    progress,
    downloadedSize,
    totalSize,
    speed,
    source,
    error,
    failures,
    installOnNextLaunch,
    startDownload,
    pauseDownload,
    cancelDownload,
    installAndRelaunch,
    installCurrentOnNextLaunch,
  } = updater;

  const downloading = phase === "downloading";
  const verifying = phase === "verifying";
  const ready = phase === "ready";
  const installing = phase === "installing";
  const busy = downloading || verifying || installing;
  const failed = phase === "error";
  const paused = phase === "paused";

  function handleClose() {
    if (busy) return;
    onClose();
  }

  function handleRetryWithPages() {
    Modal.error({
      title: "更新下载失败",
      icon: <ExclamationCircleOutlined />,
      width: 480,
      content: (
        <div>
          <Paragraph style={{ marginBottom: 12 }}>
            <Text>自动下载失败，建议从下方任一镜像页手动下载安装：</Text>
          </Paragraph>
          <Space direction="vertical" style={{ width: "100%" }}>
            {FALLBACK_DOWNLOAD_PAGES.map((page) => (
              <Button
                key={page.url}
                block
                onClick={() => void openUrl(page.url)}
                style={{ textAlign: "left" }}
              >
                {page.label}
              </Button>
            ))}
          </Space>
          {failures.length > 0 && (
            <Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
            >
              失败原因：
              {failures.map((f) => `${f.source} ${f.reason}`).join("；")}
            </Paragraph>
          )}
          {error && (
            <Paragraph
              type="secondary"
              style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
            >
              错误详情：{error}
            </Paragraph>
          )}
        </div>
      ),
      okText: "知道了",
    });
  }

  const footer = (() => {
    if (installing) return null;
    if (downloading || verifying) {
      return (
        <Space>
          <Button onClick={cancelDownload}>取消下载</Button>
          {downloading && <Button onClick={pauseDownload}>暂停</Button>}
        </Space>
      );
    }
    if (ready) {
      return (
        <Space>
          {!installOnNextLaunch && (
            <Button onClick={() => void installCurrentOnNextLaunch()}>
              下次启动时安装
            </Button>
          )}
          <Button onClick={onClose}>稍后</Button>
          <Button type="primary" onClick={() => void installAndRelaunch()}>
            重启应用
          </Button>
        </Space>
      );
    }
    if (failed) {
      return (
        <Space>
          <Button onClick={onClose}>稍后</Button>
          <Button onClick={handleRetryWithPages}>手动下载</Button>
          <Button type="primary" onClick={startDownload}>
            重试
          </Button>
        </Space>
      );
    }
    return (
      <Space>
        <Button onClick={onClose}>稍后</Button>
        <Button type="primary" onClick={startDownload}>
          {paused ? "继续下载" : "开始下载"}
        </Button>
      </Space>
    );
  })();

  return (
    <Modal
      title="软件更新"
      open={open}
      onCancel={handleClose}
      closable={!busy}
      mask={{ closable: !busy }}
      footer={footer}
    >
      {update && (
        <div>
          <Paragraph>
            <Text strong>新版本：</Text>
            <Text>{update.version}</Text>
          </Paragraph>

          {update.body && (
            <Paragraph>
              <Text strong>更新日志：</Text>
              <div
                className="mt-2 p-3 rounded-md"
                style={{
                  background: "rgba(0,0,0,0.04)",
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                <Text style={{ whiteSpace: "pre-wrap" }}>{update.body}</Text>
              </div>
            </Paragraph>
          )}

          {(downloading || verifying) && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <SyncOutlined spin />
                <Text>
                  {verifying ? "正在校验更新包签名..." : "正在下载更新..."}
                </Text>
              </div>
              <Progress percent={verifying ? 100 : progress} />
              {totalSize > 0 && (
                <Text type="secondary" className="text-xs">
                  {formatSize(downloadedSize)} / {formatSize(totalSize)}
                  {speed > 0 && ` · ${formatSpeed(speed)}`}
                  {source && ` · 来源 ${source}`}
                </Text>
              )}
            </div>
          )}

          {paused && (
            <div className="mt-4">
              <Text type="secondary">
                已暂停，已下载 {formatSize(downloadedSize)}
                {totalSize > 0 && ` / ${formatSize(totalSize)}`}（继续时会从断点接着下）
              </Text>
              <Progress percent={progress} status="exception" />
            </div>
          )}

          {ready && (
            <div className="mt-4 flex items-center gap-2">
              <CheckCircleOutlined style={{ color: "#52c41a", fontSize: 18 }} />
              <Text>下载并验签完成，重启应用以完成更新</Text>
            </div>
          )}

          {installing && (
            <div className="mt-4 flex items-center gap-2">
              <SyncOutlined spin />
              <Text>正在安装更新...</Text>
            </div>
          )}

          {failed && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <ExclamationCircleOutlined style={{ color: "#ff4d4f", fontSize: 18 }} />
                <Text>下载失败</Text>
              </div>
              {error && (
                <Paragraph
                  type="secondary"
                  style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}
                >
                  {error}
                </Paragraph>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
