import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Info,
  Lock,
  SlidersHorizontal,
  Home,
  FileText,
  Search,
  Trash2,
  Info as InfoIcon,
  Calendar,
  CheckSquare,
  Layers,
  GitFork,
  Bot,
  Bell,
  EyeOff,
  // 移动端 Dashboard 项 / Tab 选择器额外用到
  Home as HomeIcon,
  TrendingUp,
  BarChart3,
  Clock,
  Zap,
  CalendarDays,
  MessageSquareText,
  Sparkles as SparklesIcon,
  Layers as LayersIcon,
  User,
} from "lucide-react";
import { Drawer, Switch, message } from "antd";
import { useAppStore, OPTIONAL_VIEWS } from "@/store";
import type { ActiveView, MobileDashboardItem, MobileTabKey } from "@/store";
import { MOBILE_TAB_REGISTRY, MOBILE_TAB_KEYS } from "@/lib/mobileTabRegistry";

/**
 * 移动端「功能模块」开关页（设计稿：16-feature-toggle.html）
 *
 * 路由 /feature-toggle —— 移动端专用
 * 入口：MobileMe 「功能模块」一行
 *
 * 复用桌面端 useAppStore.enabledViews + toggleEnabledView：
 * - 数据存到 app_config.enabled_views（同一个 key，桌面 / 移动共用）
 * - 同步到 PC：通过 V1 sync push enabled_views 后桌面端也跟着变（T-M015 范围）
 *
 * MVP 不实装：
 * - 底部 Tab 配置（设计稿那块网格）— 需要新 app_config key + MobileLayout 动态读取
 * - 主页 Dashboard 显示项 — 需要新 app_config key + MobileHome 动态读取
 * 这两个移动端独有特性放下迭代，先把桌面端已有的 8 个可选模块开关接上去
 */

interface OptionMeta {
  view: ActiveView;
  label: string;
  desc: string;
  icon: React.ReactNode;
  iconBg: string;
  defaultOff?: boolean;
}

const CORE_MODULES = [
  {
    icon: <Home size={16} className="text-[var(--m-ink-2)]" />,
    label: "主页",
    desc: "每日仪表盘 · 数据总览",
  },
  {
    icon: <FileText size={16} className="text-[var(--m-ink-2)]" />,
    label: "文档",
    desc: "文档 CRUD / 文件夹",
  },
  {
    icon: <Search size={16} className="text-[var(--m-ink-2)]" />,
    label: "搜索",
    desc: "全文 / 标签 / 双链",
  },
  {
    icon: <Trash2 size={16} className="text-[var(--m-ink-2)]" />,
    label: "回收站",
    desc: "已删除文档 30 天保留",
  },
  {
    icon: <InfoIcon size={16} className="text-[var(--m-ink-2)]" />,
    label: "关于",
    desc: "版本 / 许可 / 反馈",
  },
];

const OPTIONS: OptionMeta[] = [
  {
    view: "daily",
    label: "日记",
    desc: "按日期写日记 / 工作日志",
    icon: <Calendar size={16} className="text-[var(--m-success)]" />,
    iconBg: "bg-[var(--m-tint-success)]",
  },
  {
    view: "tasks",
    label: "待办",
    desc: "任务管理 / 提醒 / 重复任务",
    icon: <CheckSquare size={16} className="text-[var(--m-primary)]" />,
    iconBg: "bg-[var(--m-tint-primary)]",
  },
  {
    view: "cards",
    label: "闪卡复习",
    desc: "FSRS 间隔重复 · 从批注一键转卡",
    icon: <Layers size={16} className="text-[var(--m-accent)]" />,
    iconBg: "bg-[var(--m-tint-accent)]",
    defaultOff: true,
  },
  {
    view: "ai",
    label: "AI 问答",
    desc: "和 AI 对话，让它读你的文档",
    icon: <Bot size={16} className="text-[var(--m-accent)]" />,
    iconBg: "bg-[var(--m-tint-accent)]",
  },
  {
    view: "push",
    label: "定时推送",
    desc: "定时让 AI 生成内容并推送到桌面",
    icon: <Bell size={16} className="text-[var(--m-warning)]" />,
    iconBg: "bg-[var(--m-tint-warning)]",
  },
  {
    view: "hidden",
    label: "隐藏文档",
    desc: "PIN 锁保护的私密文档空间",
    icon: <EyeOff size={16} className="text-[var(--m-danger)]" />,
    iconBg: "bg-[var(--m-tint-danger)]",
  },
];

/** 把 registry 的 icon key 翻译成 Lucide 组件（移动端 Tab 网格用） */
const TAB_ICONS: Record<MobileTabKey, React.ReactNode> = {
  home: <HomeIcon size={20} className="text-[var(--m-primary)]" />,
  notes: <FileText size={20} className="text-[var(--m-primary)]" />,
  ai: <SparklesIcon size={20} className="text-[var(--m-accent)]" />,
  tasks: <CheckSquare size={20} className="text-[var(--m-primary)]" />,
  daily: <CalendarDays size={20} className="text-[var(--m-success)]" />,
  cards: <LayersIcon size={20} className="text-[var(--m-accent)]" />,
  prompts: <MessageSquareText size={20} className="text-[var(--m-warning)]" />,
  hidden: <EyeOff size={20} className="text-[var(--m-danger)]" />,
  graph: <GitFork size={20} className="text-[var(--m-primary)]" />,
  search: <Search size={20} className="text-[var(--m-ink-2)]" />,
  trash: <Trash2 size={20} className="text-[var(--m-danger)]" />,
};

interface DashItemMeta {
  key: MobileDashboardItem;
  label: string;
  icon: React.ReactNode;
}

const DASH_ITEM_META: DashItemMeta[] = [
  {
    key: "today_words",
    label: "今日字数（蓝渐变卡）",
    icon: <TrendingUp size={16} className="text-[var(--m-primary)]" />,
  },
  {
    key: "due_cards",
    label: "待复习闪卡（紫渐变卡）",
    icon: <Layers size={16} className="text-[var(--m-accent)]" />,
  },
  {
    key: "today_tasks_card",
    label: "今日待办计数",
    icon: <CheckSquare size={16} className="text-[var(--m-success)]" />,
  },
  {
    key: "total_notes",
    label: "文档总数",
    icon: <HomeIcon size={16} className="text-[var(--m-ink-2)]" />,
  },
  {
    key: "quick_actions",
    label: "快速操作（4 按钮）",
    icon: <Zap size={16} className="text-[var(--m-warning)]" />,
  },
  {
    key: "today_tasks_list",
    label: "今日待办速览",
    icon: <CheckSquare size={16} className="text-[var(--m-success)]" />,
  },
  {
    key: "heatmap",
    label: "30 天写作热力图",
    icon: <BarChart3 size={16} className="text-[var(--m-primary)]" />,
  },
  {
    key: "recent_notes",
    label: "最近编辑",
    icon: <Clock size={16} className="text-[var(--m-ink-2)]" />,
  },
];

export default function FeatureTogglePage() {
  const navigate = useNavigate();
  const enabledViews = useAppStore((s) => s.enabledViews);
  const toggleEnabledView = useAppStore((s) => s.toggleEnabledView);
  const mobileDashItems = useAppStore((s) => s.mobileDashboardItems);
  const toggleMobileDashItem = useAppStore(
    (s) => s.toggleMobileDashboardItem,
  );
  const mobileTabKeys = useAppStore((s) => s.mobileTabKeys);
  const setMobileTabKey = useAppStore((s) => s.setMobileTabKey);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);

  function reset() {
    // 重置：除 cards 外全开
    OPTIONAL_VIEWS.forEach((v) => {
      const shouldOn = v !== "cards";
      const isOn = enabledViews.has(v);
      if (shouldOn !== isOn) {
        toggleEnabledView(v);
      }
    });
    message.success("已重置为默认");
  }

  const enabledCount = OPTIONAL_VIEWS.filter((v) =>
    enabledViews.has(v),
  ).length;

  return (
    <div className="text-[var(--m-ink-1)]">
      {/* 顶栏 */}
      <header className="flex h-12 items-center justify-between border-b border-[var(--m-line)] bg-[var(--m-surface)] px-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="flex h-10 w-10 items-center justify-center"
        >
          <ChevronLeft size={24} className="text-[var(--m-ink-2)]" />
        </button>
        <h1 className="text-base font-semibold">功能模块</h1>
        <button
          onClick={reset}
          className="px-2 text-sm text-[var(--m-ink-2)] active:text-[var(--m-ink-2)]"
        >
          重置
        </button>
      </header>

      {/* 信息横幅 */}
      <div className="flex items-start gap-2 border-b border-[var(--m-primary)] bg-[var(--m-tint-primary)] px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-[var(--m-primary)]" />
        <p className="text-xs leading-relaxed text-[var(--m-ink-1)]">
          关闭后入口隐藏，但<strong>数据保留</strong>，重新开启即可恢复。
          <br />
          核心模块（主页 / 文档 / 搜索 / 回收站 / 关于）不可关闭。
        </p>
      </div>

      <div className="bg-[var(--m-page)] pb-12">
        {/* 底部 Tab 配置（移动端独有） */}
        <SectionLabel text={`底部 Tab · 已选 ${mobileTabKeys.length}/4 + 我的`} />
        <div className="mx-4 mb-2 rounded-2xl bg-[var(--m-surface)] p-3">
          <div className="mb-2 text-[11px] leading-relaxed text-[var(--m-ink-2)]">
            点击任意格子可换成其它功能。「我的」永远占最后一格，无需配置。
          </div>
          <div className="grid grid-cols-5 gap-2">
            {mobileTabKeys.map((k, idx) => (
              <button
                key={`${k}-${idx}`}
                onClick={() => setPickerSlot(idx)}
                className="flex flex-col items-center gap-1 rounded-xl border-2 border-[var(--m-primary)] bg-[var(--m-tint-primary)] py-2.5 active:scale-95 transition-transform"
              >
                {TAB_ICONS[k]}
                <span className="text-[10px] font-medium text-[var(--m-primary)]">
                  {MOBILE_TAB_REGISTRY[k].label}
                </span>
              </button>
            ))}
            <div className="flex flex-col items-center gap-1 rounded-xl border-2 border-dashed border-[var(--m-line)] bg-[var(--m-page)] py-2.5">
              <User size={20} className="text-[var(--m-ink-3)]" />
              <span className="text-[10px] text-[var(--m-ink-3)]">我的（固定）</span>
            </div>
          </div>
        </div>

        {/* 核心模块 */}
        <SectionLabel
          icon={<Lock size={12} />}
          text="核心模块 · 始终启用"
        />
        <ListGroup>
          {CORE_MODULES.map((m) => (
            <CoreRow key={m.label} {...m} />
          ))}
        </ListGroup>

        {/* 可选模块 */}
        <SectionLabel
          icon={<SlidersHorizontal size={12} />}
          text={`可选模块 · ${OPTIONAL_VIEWS.length} 个，已开启 ${enabledCount}`}
        />
        <ListGroup>
          {OPTIONS.map((o) => (
            <OptionRow
              key={o.view}
              meta={o}
              checked={enabledViews.has(o.view)}
              onChange={() => toggleEnabledView(o.view)}
            />
          ))}
        </ListGroup>

        {/* 主页 Dashboard 显示 */}
        <SectionLabel
          icon={<HomeIcon size={12} />}
          text="主页 Dashboard 显示 · 移动端独有"
        />
        <ListGroup>
          {DASH_ITEM_META.map((m) => (
            <DashItemRow
              key={m.key}
              meta={m}
              checked={mobileDashItems.has(m.key)}
              onChange={() => toggleMobileDashItem(m.key)}
            />
          ))}
        </ListGroup>

        <div className="px-4 py-4 text-center text-[11px] text-[var(--m-ink-3)]">
          💾 配置写入 app_config · 自动同步到桌面端
        </div>
      </div>

      {/* Tab 选择 Drawer */}
      <Drawer
        title={`选择 Tab（第 ${(pickerSlot ?? 0) + 1} 格）`}
        placement="bottom"
        height={Math.min(MOBILE_TAB_KEYS.length * 60 + 80, 560)}
        open={pickerSlot !== null}
        onClose={() => setPickerSlot(null)}
      >
        <div className="grid grid-cols-3 gap-2">
          {MOBILE_TAB_KEYS.map((k) => {
            const meta = MOBILE_TAB_REGISTRY[k];
            const inUse = mobileTabKeys.includes(k);
            const inOtherSlot =
              inUse &&
              pickerSlot !== null &&
              mobileTabKeys[pickerSlot] !== k;
            return (
              <button
                key={k}
                onClick={() => {
                  if (pickerSlot !== null) {
                    setMobileTabKey(pickerSlot, k);
                    setPickerSlot(null);
                    message.success(`已设置第 ${pickerSlot + 1} 格为「${meta.label}」`);
                  }
                }}
                className={`flex flex-col items-center gap-1 rounded-xl py-3 ${
                  pickerSlot !== null && mobileTabKeys[pickerSlot] === k
                    ? "border-2 border-[var(--m-primary)] bg-[var(--m-tint-primary)]"
                    : inOtherSlot
                      ? "border border-amber-200 bg-[var(--m-tint-warning)]"
                      : "border border-[var(--m-line-weak)] bg-[var(--m-surface)]"
                } active:scale-95 transition-transform`}
              >
                {TAB_ICONS[k]}
                <span className="text-[11px] font-medium text-[var(--m-ink-2)]">
                  {meta.label}
                </span>
                {inOtherSlot && (
                  <span className="text-[9px] text-[var(--m-warning)]">已选 · 会自动换位</span>
                )}
              </button>
            );
          })}
        </div>
      </Drawer>
    </div>
  );
}

function SectionLabel({
  icon,
  text,
}: {
  icon?: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1 px-4 pt-3 pb-1 text-xs font-medium text-[var(--m-ink-3)]">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-4 mb-2 divide-y divide-[var(--m-line-weak)] rounded-2xl bg-[var(--m-surface)]">
      {children}
    </div>
  );
}

function CoreRow({
  icon,
  label,
  desc,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 opacity-90">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--m-well)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--m-ink-2)]">{label}</div>
        <div className="text-[11px] text-[var(--m-ink-3)]">{desc}</div>
      </div>
      <Switch checked disabled />
    </div>
  );
}

function DashItemRow({
  meta,
  checked,
  onChange,
}: {
  meta: DashItemMeta;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="shrink-0">{meta.icon}</div>
      <span className="flex-1 text-sm text-[var(--m-ink-2)]">{meta.label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function OptionRow({
  meta,
  checked,
  onChange,
}: {
  meta: OptionMeta;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 ${
        meta.defaultOff && !checked ? "bg-[var(--m-tint-warning)]/40" : ""
      }`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.iconBg}`}
      >
        {meta.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--m-ink-1)]">
          {meta.label}
          {meta.defaultOff && (
            <span className="rounded bg-[var(--m-tint-warning)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--m-warning)]">
              默认关
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--m-ink-2)]">{meta.desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
