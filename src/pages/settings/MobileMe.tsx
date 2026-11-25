import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { message } from "antd";
import { getVersion } from "@tauri-apps/api/app";
import {
  Settings,
  Layers,
  GitFork,
  MessageSquareText,
  CloudUpload,
  Folder,
  FileArchive,
  Trash2,
  Moon,
  Palette,
  LockKeyhole,
  KeyRound,
  Boxes,
  Sparkles,
  Plug,
  Info,
  ChevronRight,
} from "lucide-react";
import {
  systemApi,
  cardApi,
  trashApi,
  aiModelApi,
  promptApi,
} from "@/lib/api";
import type { DashboardStats } from "@/types";

/**
 * 移动端「我的」页（设计稿：10-me.html）
 *
 * 这是 5 Tab 之一，路由 /settings 在 isMobile=true 时渲染本组件。
 * 大部分二级入口（同步/导入/导出/外观/隐藏 PIN/Vault）暂不跳转 — 现状下他们大多是
 * 桌面专属功能，移动端要么走完整重写要么禁用。本页先把信息架构 + 数据搭起来，
 * 二级页跳转随后逐个 wire。
 */

interface CountStats {
  dueCards: number;
  trashCount: number;
  modelCount: number;
  promptCount: number;
}

export function MobileMe() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [version, setVersion] = useState("");
  const [counts, setCounts] = useState<CountStats>({
    dueCards: 0,
    trashCount: 0,
    modelCount: 0,
    promptCount: 0,
  });

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, due, trash, models, prompts] = await Promise.all([
          systemApi.getDashboardStats(),
          cardApi.listDue().catch(() => []),
          trashApi.list(1, 1).catch(() => ({
            items: [],
            total: 0,
            page: 1,
            page_size: 1,
          })),
          aiModelApi.list().catch(() => []),
          promptApi.list().catch(() => []),
        ]);
        if (!alive) return;
        setStats(s);
        setCounts({
          dueCards: (due as unknown[]).length,
          trashCount: trash.total ?? 0,
          modelCount: models.length,
          promptCount: prompts.length,
        });
      } catch (e) {
        console.error("[MobileMe] load failed:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 头部 banner */}
      <div className="bg-gradient-to-br from-[var(--m-primary)] to-[var(--m-primary-strong)] px-5 pt-4 pb-12 text-[var(--m-on-primary)]">
        <div className="flex items-start gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--m-surface)]/20 text-2xl backdrop-blur">
            🦊
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold">wenjq</h2>
            <p className="mt-0.5 text-sm text-[var(--m-on-primary)] opacity-80">
              Pomegranate · 共 {stats?.total_notes ?? 0} 篇
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-[var(--m-surface)]/20 px-2 py-0.5">
                📝 {stats?.total_notes ?? 0} 文档
              </span>
              <span className="rounded bg-[var(--m-surface)]/20 px-2 py-0.5">
                🏷️ {stats?.total_tags ?? 0} 标签
              </span>
            </div>
          </div>
          <button
            onClick={() => navigate("/about")}
            aria-label="设置"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--m-surface)]/15 active:bg-[var(--m-surface)]/25"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* 数据统计卡（从 banner 下方上提） */}
      <div className="-mt-7 mx-4 grid grid-cols-3 gap-2">
        <StatCard
          value={counts.dueCards}
          label="今日待复习"
          color="text-[var(--m-ink-1)]"
        />
        <StatCard
          value={stats?.total_words ?? 0}
          label="总字数"
          color="text-[var(--m-ink-1)]"
        />
        <StatCard
          value={stats?.today_updated ?? 0}
          label="今日更新"
          color="text-[var(--m-success)]"
        />
      </div>

      {/* 学习与思考 */}
      <SectionLabel text="学习与思考" />
      <div className="px-4">
        <div className="grid grid-cols-3 gap-3">
          <LearnCard
            icon={<Layers size={20} className="text-[var(--m-accent)]" />}
            iconBg="bg-[var(--m-tint-accent)]"
            label="闪卡复习"
            badge={counts.dueCards > 0 ? `${counts.dueCards} 待复` : undefined}
            badgeColor="text-[var(--m-accent)] bg-[var(--m-tint-accent)]"
            onClick={() => navigate("/cards")}
          />
          <LearnCard
            icon={<GitFork size={20} className="text-[var(--m-primary)]" />}
            iconBg="bg-[var(--m-tint-primary)]"
            label="文档关系"
            sub={`${stats?.total_notes ?? 0} 节点`}
            onClick={() => navigate("/graph")}
          />
          <LearnCard
            icon={<MessageSquareText size={20} className="text-[var(--m-accent)]" />}
            iconBg="bg-[var(--m-tint-accent)]"
            label="Prompt 库"
            sub={`${counts.promptCount} 条`}
            onClick={() => navigate("/prompts")}
          />
        </div>
      </div>

      {/* 数据与同步 */}
      <SectionLabel text="数据与同步" />
      <ListGroup>
        <Row
          icon={<CloudUpload size={20} className="text-[var(--m-primary)]" />}
          label="云端同步"
          right={<span className="text-xs text-[var(--m-ink-3)]">WebDAV</span>}
          onClick={() => navigate("/sync")}
        />
        <Row
          icon={<Folder size={20} className="text-[var(--m-warning)]" />}
          label="导入文档"
          right={<span className="text-xs text-[var(--m-ink-3)]">.md / .txt</span>}
          onClick={() => navigate("/quick-create")}
        />
        <Row
          icon={<FileArchive size={20} className="text-[var(--m-accent)]" />}
          label="导出 / 备份"
          info="桌面专属"
        />
        <Row
          icon={<Trash2 size={20} className="text-[var(--m-danger)]" />}
          label="回收站"
          right={
            counts.trashCount > 0 ? (
              <span className="text-xs text-[var(--m-ink-3)]">
                {counts.trashCount} 项
              </span>
            ) : undefined
          }
          onClick={() => navigate("/trash")}
        />
      </ListGroup>

      {/* 外观与隐私 */}
      <SectionLabel text="外观与隐私" />
      <ListGroup>
        <Row
          icon={<Moon size={20} className="text-[var(--m-ink-2)]" />}
          label="深色模式"
          right={<span className="text-xs text-[var(--m-ink-3)]">跟随系统</span>}
          info="跟随系统设置，暂不支持手动切换"
        />
        <Row
          icon={<Palette size={20} className="text-[var(--m-accent)]" />}
          label="主题与字体"
          info="桌面专属"
        />
        <Row
          icon={<LockKeyhole size={20} className="text-[var(--m-danger)]" />}
          label="隐藏文档 PIN"
          onClick={() => navigate("/hidden")}
        />
        <Row
          icon={<KeyRound size={20} className="text-[var(--m-warning)]" />}
          label="文档加密 Vault"
          info="桌面专属（移动端只读已加密文档）"
        />
      </ListGroup>

      {/* 功能与扩展 */}
      <SectionLabel text="功能与扩展" />
      <ListGroup>
        <Row
          icon={<Boxes size={20} className="text-[var(--m-primary)]" />}
          label="功能模块"
          onClick={() => navigate("/feature-toggle")}
        />
        <Row
          icon={<Sparkles size={20} className="text-[var(--m-accent)]" />}
          label="AI 模型管理"
          right={
            <span className="text-xs text-[var(--m-ink-3)]">
              {counts.modelCount} 个
            </span>
          }
          onClick={() => navigate("/ai")}
        />
        <Row
          icon={<Plug size={20} className="text-[var(--m-primary)]" />}
          label="MCP 服务器"
          info="MCP 走子进程 sidecar，移动端沙盒禁止 spawn"
        />
        <Row
          icon={<Info size={20} className="text-[var(--m-ink-2)]" />}
          label="关于"
          right={
            <span className="text-xs text-[var(--m-ink-3)]">
              {version ? `v${version}` : "—"}
            </span>
          }
          onClick={() => navigate("/about")}
        />
      </ListGroup>

      <div className="h-24" />
    </div>
  );
}

function LearnCard({
  icon,
  iconBg,
  label,
  badge,
  badgeColor,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  badge?: string;
  badgeColor?: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-2xl bg-[var(--m-surface)] py-4 shadow-sm active:scale-95 transition-transform"
    >
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconBg}`}
      >
        {icon}
      </div>
      <span className="text-xs font-medium text-[var(--m-ink-2)]">{label}</span>
      {badge && (
        <span
          className={`rounded-full px-1.5 text-[10px] font-medium ${badgeColor}`}
        >
          {badge}
        </span>
      )}
      {!badge && sub && <span className="text-[10px] text-[var(--m-ink-2)]">{sub}</span>}
    </button>
  );
}

function StatCard({
  value,
  label,
  color = "text-[var(--m-ink-1)]",
}: {
  value: number | string;
  label: string;
  color?: string;
}) {
  return (
    <div className="rounded-2xl bg-[var(--m-surface)] py-3 text-center shadow-sm">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--m-ink-2)]">{label}</div>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="px-4 pt-4 pb-2 text-xs font-medium text-[var(--m-ink-3)]">
      {text}
    </div>
  );
}

function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4">
      <div className="divide-y divide-[var(--m-line-weak)] rounded-2xl bg-[var(--m-surface)]">
        {children}
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  right,
  onClick,
  info,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
  onClick?: () => void;
  /** 仅信息提示（点击后弹 toast 解释为什么不可用），不显示 chevron */
  info?: string;
}) {
  const isInteractive = !!onClick && !info;
  const handleClick = () => {
    if (info) {
      message.info(info);
      return;
    }
    onClick?.();
  };
  return (
    <button
      onClick={handleClick}
      className={`flex w-full items-center gap-3 px-4 py-3 ${
        isInteractive ? "active:bg-[var(--m-well)]" : "active:bg-[var(--m-well)]"
      } ${info ? "opacity-70" : ""}`}
    >
      {icon}
      <span className="flex-1 text-left text-sm text-[var(--m-ink-1)]">{label}</span>
      {info ? (
        <span className="text-xs text-[var(--m-ink-3)]">不可用</span>
      ) : (
        right
      )}
      {isInteractive && (
        <ChevronRight size={16} className="text-[var(--m-ink-3)]" />
      )}
    </button>
  );
}

