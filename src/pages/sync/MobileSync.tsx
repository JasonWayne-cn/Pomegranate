import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  CloudUpload,
  CloudDownload,
  Plus,
  Plug,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Pencil,
  Share2,
  Download,
  ScanLine,
  Wifi,
  Smartphone,
  ChevronRight,
} from "lucide-react";
import { ShareConfigModal } from "@/components/config-share/ShareConfigModal";
import { ImportConfigModal } from "@/components/config-share/ImportConfigModal";
import { QrScanner } from "@/components/mobile/QrScanner";
import { MobileLanHostSheet } from "@/components/mobile/MobileLanHostSheet";
import {
  exportSyncBackend,
  exportWebDavBackend,
  type Envelope,
} from "@/lib/configShare";
import { Modal, Form, Input, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { syncV1Api } from "@/lib/api";
import { useAppStore } from "@/store";
import type {
  SyncBackend,
  SyncV1ProgressEvent,
  WebDavConfig,
} from "@/types";
import { relativeTime } from "@/lib/utils";

/**
 * 移动端云端同步管理（设计：基于 11-sync.html，简化为只支持 WebDAV）
 *
 * 路由 /sync —— 移动端独立路由（不在 LayoutSwitch 子路由下）
 *
 * 功能：
 * - 列出所有 V1 同步后端 + 上次推送/拉取时间 + 启用状态
 * - 每个后端单独的 推送 / 拉取 / 测试 / 编辑 / 删除 操作
 * - 新增 / 编辑 backend：仅支持 WebDAV（移动端 S3 已被 cfg gate 掉）
 *
 * 桌面端零影响：MobileSync 只通过 /sync 路由触达，且桌面端入口在 settings/SyncSettings 里走另一套。
 */

interface WebDavForm {
  name: string;
  url: string;
  username: string;
  password: string;
}

/** 电脑端「设置 → 数据同步与备份 → 局域网同步」二维码内容（对应 Rust PairingPayload） */
interface LanPairing {
  t: "kb-lan";
  v: number;
  name: string;
  hosts: string[];
  port: number;
  fp: string;
  token: string;
}

/** 解析配对码；不是局域网配对码 / 缺字段返回 null */
function parseLanPairing(text: string): LanPairing | null {
  try {
    const p = JSON.parse(text.trim()) as Partial<LanPairing>;
    if (
      p.t !== "kb-lan" ||
      !Array.isArray(p.hosts) ||
      !p.port ||
      !p.fp ||
      !p.token
    ) {
      return null;
    }
    return p as LanPairing;
  } catch {
    return null;
  }
}

export function MobileSync() {
  const navigate = useNavigate();
  const [backends, setBackends] = useState<SyncBackend[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncV1ProgressEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form] = Form.useForm<WebDavForm>();
  // 配置分享 / 导入
  const [shareEnv, setShareEnv] = useState<Envelope | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // 局域网：扫电脑的配对二维码直接建同步源
  const [lanScanOpen, setLanScanOpen] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);

  // 监听后端推/拉进度事件，渲染到对应 backend 卡片下
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void (async () => {
      const fn = await listen<SyncV1ProgressEvent>("sync_v1:progress", (e) => {
        setProgress(e.payload);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await syncV1Api.listBackends();
      setBackends(list);
    } catch (e) {
      console.error("[MobileSync] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      name: "WebDAV",
      url: "https://",
      username: "",
      password: "",
    });
    setEditorOpen(true);
  }

  function openEdit(b: SyncBackend) {
    if (b.kind === "lan") {
      message.info("局域网同步源由扫码创建；要换电脑请删除后重新扫码");
      return;
    }
    let cfg: WebDavConfig = { url: "", username: "" };
    try {
      cfg = JSON.parse(b.configJson) as WebDavConfig;
    } catch {
      // 静默失败：表单显示空值
    }
    setEditingId(b.id);
    form.setFieldsValue({
      name: b.name,
      url: cfg.url ?? "",
      username: cfg.username ?? "",
      password: "",
    });
    setEditorOpen(true);
  }

  async function submitForm() {
    try {
      const values = await form.validateFields();
      const cfg: WebDavConfig = {
        url: values.url.trim(),
        username: values.username,
        ...(values.password ? { password: values.password } : {}),
      };
      const input = {
        kind: "webdav" as const,
        name: values.name.trim(),
        configJson: JSON.stringify(cfg),
      };
      if (editingId !== null) {
        await syncV1Api.updateBackend(editingId, input);
        message.success("已更新");
      } else {
        await syncV1Api.createBackend(input);
        message.success("已添加");
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      if ((e as { errorFields?: unknown }).errorFields) return;
      message.error(`保存失败: ${e}`);
    }
  }

  async function testConn(id: number) {
    setBusyId(id);
    try {
      await syncV1Api.testConnection(id);
      message.success("连接正常");
    } catch (e) {
      message.error(`连接失败: ${e}`);
    } finally {
      setBusyId(null);
    }
  }

  async function push(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.push(id);
      message.success(
        `推送完成：上传 ${r.uploaded} · 删除 ${r.deletedRemote} · 跳过 ${r.skipped}` +
          (r.errors.length > 0 ? ` · ${r.errors.length} 错误` : ""),
      );
      await load();
    } catch (e) {
      message.error(`推送失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  async function pull(id: number) {
    setBusyId(id);
    setProgress(null);
    try {
      const r = await syncV1Api.pull(id);
      message.success(
        `拉取完成：下载 ${r.downloaded} · 删除本地 ${r.deletedLocal}` +
          (r.conflicts > 0 ? ` · ${r.conflicts} 冲突` : ""),
      );
      useAppStore.getState().bumpNotesRefresh();
      await load();
    } catch (e) {
      message.error(`拉取失败: ${e}`);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  /** 扫电脑上的配对二维码 → 建一个 lan 同步源（token 由 DAO 加密入库） */
  async function handleLanScanned(text: string) {
    const p = parseLanPairing(text);
    if (!p) {
      message.error("这不是局域网配对二维码，请扫电脑「局域网同步」里的二维码");
      return;
    }
    setLanBusy(true);
    try {
      await syncV1Api.createBackend({
        kind: "lan",
        name: `局域网 · ${p.name}`,
        configJson: JSON.stringify({
          hosts: p.hosts,
          port: p.port,
          fp: p.fp,
          token: p.token,
        }),
        autoSync: false,
      });
      message.success(`已添加「${p.name}」，点推送 / 拉取即可同步`);
      setLanScanOpen(false);
      await load();
    } catch (e) {
      message.error(`添加失败：${e}`);
    } finally {
      setLanBusy(false);
    }
  }

  function remove(b: SyncBackend) {
    Modal.confirm({
      title: `删除「${b.name}」？`,
      content: "本地的同步配置将被清除（远端数据不动）。",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await syncV1Api.deleteBackend(b.id);
          message.success("已删除");
          await load();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        }
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[var(--m-page)]"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-[var(--m-ink-2)]" />
        </button>
        <h1 className="text-base font-semibold">云端同步</h1>
        <div className="flex">
          <button
            onClick={() => setLanScanOpen(true)}
            aria-label="扫描局域网配对码"
            className="flex h-10 w-10 items-center justify-center text-[var(--m-ink-2)]"
          >
            <ScanLine size={20} />
          </button>
          <button
            onClick={() => setImportOpen(true)}
            aria-label="导入配置"
            className="flex h-10 w-10 items-center justify-center text-[var(--m-ink-2)]"
          >
            <Download size={20} />
          </button>
          <button
            onClick={openAdd}
            aria-label="新增"
            className="flex h-10 w-10 items-center justify-center text-[var(--m-primary)]"
          >
            <Plus size={22} />
          </button>
        </div>
      </header>

      {/* 信息横幅 */}
      <div className="flex items-start gap-2 border-b border-[var(--m-primary)] bg-[var(--m-tint-primary)] px-4 py-2.5 shrink-0">
        <CloudUpload size={16} className="mt-0.5 shrink-0 text-[var(--m-primary)]" />
        <p className="text-xs leading-relaxed text-[var(--m-ink-1)]">
          移动端只支持手动同步，建议每次记录后手动 ↑推送，需要时再 ↓拉取。
          支持 WebDAV 与局域网直连（右上角扫码添加）。
        </p>
      </div>

      {/* 列表 */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* 手机之间直连：本机当主机，另一台手机扫码同步 */}
        <button
          type="button"
          onClick={() => setHostOpen(true)}
          className="mb-3 flex w-full items-center gap-3 rounded-2xl bg-[var(--m-surface)] px-3 py-3 text-left shadow-sm active:bg-[var(--m-well)]"
        >
          <Smartphone size={20} className="shrink-0 text-[var(--m-primary)]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-[var(--m-ink-1)]">让本机当主机</span>
            <span className="text-[11px] text-[var(--m-ink-3)]">
              手机之间同步：另一台手机扫码即可，不用电脑
            </span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-[var(--m-ink-3)]" />
        </button>
        {loading ? (
          <div className="text-center text-sm text-[var(--m-ink-3)] py-8">加载中…</div>
        ) : backends.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-[var(--m-ink-3)]">
            <CloudUpload size={40} className="text-[var(--m-ink-3)]" />
            <span className="text-sm">还没有配置同步</span>
            <span className="text-xs text-[var(--m-ink-3)]">点右上 + 添加 WebDAV</span>
          </div>
        ) : (
          <div className="space-y-3">
            {backends.map((b) => (
              <BackendCard
                key={b.id}
                backend={b}
                busy={busyId === b.id}
                progress={
                  busyId === b.id && progress?.backendId === b.id
                    ? progress
                    : null
                }
                onPush={() => push(b.id)}
                onPull={() => pull(b.id)}
                onTest={() => testConn(b.id)}
                onEdit={() => openEdit(b)}
                onDelete={() => remove(b)}
                onShare={() =>
                  setShareEnv(
                    b.kind === "lan"
                      ? exportSyncBackend(b)
                      : exportWebDavBackend(b),
                  )
                }
              />
            ))}
          </div>
        )}
      </main>

      {/* 添加 / 编辑 Modal */}
      <Modal
        title={editingId === null ? "添加 WebDAV 同步" : "编辑同步"}
        open={editorOpen}
        onOk={submitForm}
        onCancel={() => setEditorOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="如：坚果云 / Nextcloud" />
          </Form.Item>
          <Form.Item
            name="url"
            label="WebDAV 地址"
            rules={[{ required: true, message: "请输入完整 URL" }]}
          >
            <Input placeholder="https://dav.jianguoyun.com/dav/knowledge_base" />
          </Form.Item>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input placeholder="账号 / 邮箱" />
          </Form.Item>
          <Form.Item
            name="password"
            label="应用密码"
            tooltip="坚果云需在「账户信息 → 安全选项」生成第三方应用密码"
            rules={
              editingId === null ? [{ required: true, message: "请输入密码" }] : []
            }
          >
            <Input.Password placeholder={editingId === null ? "" : "留空 = 不修改密码"} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 配置分享 */}
      <ShareConfigModal
        open={shareEnv !== null}
        onClose={() => setShareEnv(null)}
        envelope={shareEnv}
      />

      {/* 配置导入 */}
      <ImportConfigModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />

      <MobileLanHostSheet
        open={hostOpen}
        onClose={() => {
          setHostOpen(false);
          void load();
        }}
      />

      {/* 局域配对：扫电脑上的二维码 */}
      <Modal
        title="扫描电脑的配对二维码"
        open={lanScanOpen}
        footer={null}
        onCancel={() => setLanScanOpen(false)}
        destroyOnClose
      >
        <p className="mb-2 text-xs leading-relaxed text-[var(--m-ink-2)]">
          在电脑上打开「设置 → 数据同步与备份 → 局域网同步」，开启后扫描二维码。
          手机和电脑需要连同一个 Wi-Fi。
        </p>
        {lanBusy && <div className="mb-2 text-xs text-[var(--m-ink-2)]">正在添加…</div>}
        <QrScanner
          onResult={(text) => {
            if (!lanBusy) void handleLanScanned(text);
          }}
        />
      </Modal>
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  compute: "计算清单",
  diff: "对比远端",
  upload: "上传",
  download: "下载",
  manifest: "更新清单",
  apply: "应用本地",
  done: "完成",
};

function BackendCard({
  backend,
  busy,
  progress,
  onPush,
  onPull,
  onTest,
  onEdit,
  onDelete,
  onShare,
}: {
  backend: SyncBackend;
  busy: boolean;
  progress: SyncV1ProgressEvent | null;
  onPush: () => void;
  onPull: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const lastPush = backend.lastPushTs
    ? relativeTime(backend.lastPushTs)
    : "从未";
  const lastPull = backend.lastPullTs
    ? relativeTime(backend.lastPullTs)
    : "从未";
  const kindLabel =
    backend.kind === "lan"
      ? "局域网"
      : backend.kind === "s3"
        ? "S3"
        : backend.kind === "local"
          ? "本地"
          : "WebDAV";
  return (
    <div className="rounded-2xl bg-[var(--m-surface)] p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--m-tint-primary)]">
          {backend.kind === "lan" ? (
            <Wifi size={20} className="text-[var(--m-primary)]" />
          ) : (
            <CloudUpload size={20} className="text-[var(--m-primary)]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--m-ink-1)]">
              {backend.name}
            </span>
            <span className="rounded bg-[var(--m-well)] px-1.5 py-0.5 text-[10px] text-[var(--m-ink-2)]">
              {kindLabel}
            </span>
            {backend.enabled ? (
              <CheckCircle2 size={12} className="text-[var(--m-success)]" />
            ) : (
              <AlertCircle size={12} className="text-[var(--m-ink-3)]" />
            )}
          </div>
          <div className="mt-1 grid grid-cols-2 text-[11px] text-[var(--m-ink-2)]">
            <span>↑ 推送 · {lastPush}</span>
            <span>↓ 拉取 · {lastPull}</span>
          </div>
          {backend.lastError && (
            <div className="mt-1 truncate text-[11px] text-[var(--m-danger)]" title={backend.lastError}>
              上次失败：{backend.lastError}
            </div>
          )}
        </div>
      </div>

      {/* 进度条（仅在 busy 时显示） */}
      {busy && (
        <div className="mt-3 rounded-lg bg-[var(--m-tint-primary)] px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-[var(--m-primary)]">
            <span className="font-medium">
              {progress
                ? PHASE_LABELS[progress.phase] ?? progress.phase
                : "准备中…"}
            </span>
            {progress && progress.total > 0 && (
              <span>
                {progress.current} / {progress.total}
              </span>
            )}
          </div>
          {progress?.message && (
            <div className="mt-0.5 truncate text-[10px] text-[var(--m-primary)]/80">
              {progress.message}
            </div>
          )}
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--m-tint-primary)]">
            <div
              className="h-full bg-[var(--m-primary)] transition-all"
              style={{
                width:
                  progress && progress.total > 0
                    ? `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`
                    : "8%",
              }}
            />
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={onPush}
          disabled={busy}
          className="flex h-10 items-center justify-center gap-1 rounded-lg bg-[var(--m-primary)] text-sm font-medium text-[var(--m-on-primary)] active:scale-95 transition-transform disabled:opacity-50"
        >
          <CloudUpload size={14} /> 推送
        </button>
        <button
          onClick={onPull}
          disabled={busy}
          className="flex h-10 items-center justify-center gap-1 rounded-lg bg-[var(--m-well)] text-sm font-medium text-[var(--m-ink-2)] active:bg-[var(--m-well)] disabled:opacity-50"
        >
          <CloudDownload size={14} /> 拉取
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        <button
          onClick={onTest}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-[var(--m-line)] bg-[var(--m-surface)] text-xs text-[var(--m-ink-2)] active:bg-[var(--m-well)] disabled:opacity-50"
        >
          <Plug size={12} /> 测试
        </button>
        <button
          onClick={onShare}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-[var(--m-line)] bg-[var(--m-surface)] text-xs text-[var(--m-ink-2)] active:bg-[var(--m-well)] disabled:opacity-50"
        >
          <Share2 size={12} /> 分享
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-[var(--m-line)] bg-[var(--m-surface)] text-xs text-[var(--m-ink-2)] active:bg-[var(--m-well)] disabled:opacity-50"
        >
          <Pencil size={12} /> 编辑
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1 rounded-lg border border-red-200 bg-[var(--m-surface)] text-xs text-[var(--m-danger)] active:bg-[var(--m-tint-danger)] disabled:opacity-50"
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>
    </div>
  );
}
