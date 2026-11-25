import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, message } from "antd";
import QRCode from "qrcode";
import { lanSyncApi, syncV1Api } from "@/lib/api";
import type { LanSyncStatus } from "@/types";
import { relativeTime } from "@/lib/utils";
import { useAppStore } from "@/store";

/** 手机当主机用的端口，和电脑端默认一致；对方扫码拿到的就是它，不需要用户改 */
const HOST_PORT = 47321;

type Phase = "starting" | "ready" | "failed";

/**
 * 手机「当主机」面板：让另一台手机扫码直接局域网同步，不用电脑。
 *
 * - 打开即起服务（与电脑端同一套 lan_sync），并先把本机笔记同步进中转库
 * - 只在面板开着时提供服务：关闭面板 / 离开本页都会停
 * - 开着时尽量保持屏幕常亮，免得息屏后系统冻结应用、对方连不上
 */
export function MobileLanHostSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<LanSyncStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const renderQr = useCallback(async () => {
    const payload = await lanSyncApi.pairingPayload();
    setQr(
      await QRCode.toDataURL(payload, {
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
      }),
    );
  }, []);

  // 打开：起服务 → 本机笔记同步进中转库 → 出二维码；关闭 / 卸载：停服务
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("starting");
    setError(null);
    setQr(null);
    (async () => {
      try {
        const s = await lanSyncApi.enable(HOST_PORT);
        if (cancelled) return;
        setStatus(s);
        if (s.backendId != null) {
          try {
            await syncV1Api.push(s.backendId);
            await syncV1Api.pull(s.backendId);
          } catch (e) {
            message.warning(`本机笔记同步到中转库失败，对方可能暂时拉不到：${e}`);
          }
        }
        if (cancelled) return;
        await renderQr();
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setPhase("failed");
      }
    })();
    return () => {
      cancelled = true;
      void lanSyncApi.disable().catch(() => {});
    };
  }, [open, renderQr]);

  // 开着时轮询状态：显示最近一次收到对方改动的时间 / 合并失败原因
  useEffect(() => {
    if (!open || phase !== "ready") return;
    let lastSeen = status?.lastClientSync ?? null;
    const timer = window.setInterval(async () => {
      try {
        const s = await lanSyncApi.status();
        setStatus(s);
        if (s.lastClientSync && s.lastClientSync !== lastSeen) {
          lastSeen = s.lastClientSync;
          useAppStore.getState().bumpNotesRefresh();
        }
      } catch {
        // 轮询失败不打扰用户，下一轮再试
      }
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  // 保持常亮：息屏后应用会被冻结，对方就连不上了
  useEffect(() => {
    if (!open || phase !== "ready") return;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
      };
    };
    let released = false;
    nav.wakeLock
      ?.request("screen")
      .then((lock) => {
        if (released) void lock.release();
        else wakeLockRef.current = lock;
      })
      .catch(() => {});
    return () => {
      released = true;
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [open, phase]);

  async function resetPairing() {
    setResetting(true);
    try {
      setStatus(await lanSyncApi.resetPairing());
      await renderQr();
      message.success("已重新生成配对码，之前扫过的手机需要重新扫");
    } catch (e) {
      message.error(`重新生成失败：${e}`);
    } finally {
      setResetting(false);
    }
  }

  const host = status?.hosts[0];

  return (
    <Modal
      title="让本机当主机"
      open={open}
      footer={null}
      onCancel={onClose}
      destroyOnClose
      centered
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      <p className="mb-3 text-xs text-slate-500">
        另一台手机扫码即可直接同步，不经过电脑和云端
      </p>
      <div className="flex flex-col items-center gap-3">
        {phase === "starting" && (
          <div className="py-10 text-sm text-slate-400">正在开启…</div>
        )}

        {phase === "failed" && (
          <div className="py-6 text-center">
            <div className="text-sm text-red-500">开启失败</div>
            <div className="mt-1 break-all text-xs text-slate-500">{error}</div>
          </div>
        )}

        {phase === "ready" && (
          <>
            {qr && (
              <img
                src={qr}
                alt="局域网同步配对二维码"
                width={240}
                height={240}
                className="rounded-lg bg-white p-2"
              />
            )}
            <div className="text-center">
              <div className="text-sm text-slate-800">{status?.deviceName}</div>
              <div className="text-xs text-slate-500">
                {host
                  ? `${host}:${status?.port}`
                  : "没有找到 Wi-Fi 地址，请先连上 Wi-Fi 或打开热点"}
              </div>
            </div>
            <ol className="w-full list-decimal space-y-1 pl-5 text-xs leading-relaxed text-slate-500">
              <li>两台手机连同一个 Wi-Fi，或者一台开热点、另一台连上</li>
              <li>在另一台手机打开「同步 → 右上角扫码 → 扫这个码」</li>
              <li>对方点「推送 / 拉取」，改动会自动合并进本机</li>
            </ol>
            <div className="w-full text-xs text-slate-500">
              {status?.lastClientSync
                ? `最近收到对方改动：${relativeTime(status.lastClientSync)}`
                : "还没有设备同步过"}
            </div>
            {status?.hostLastError && (
              <div className="w-full break-all text-xs text-red-500">
                合并对方改动失败：{status.hostLastError}
              </div>
            )}
            <div className="w-full text-xs text-slate-400">
              开着本面板时才能同步；关闭后服务立即停止。
            </div>
            <Button
              size="small"
              disabled={resetting}
              onClick={() => void resetPairing()}
            >
              {resetting ? "正在重新生成…" : "重新生成配对码（之前扫过的设备失效）"}
            </Button>
          </>
        )}
      </div>
      <div className="mt-4 text-right">
        <Button onClick={onClose}>停止并关闭</Button>
      </div>
    </Modal>
  );
}
