import {
  Bot,
  Calendar,
  CheckSquare,
  GitBranch,
  HardDrive,
  Home,
  Info,
  Layers,
  NotebookText,
  Plug,
  Search,
  Sparkles,
  Tags,
  Trash2,
  EyeOff,
  Bell,
  FlaskConical,
} from "lucide-react";
import type { ActiveView } from "@/store";
import type { ModuleMeta } from "./types";

/**
 * 模块设置中心注册表。
 *
 * 首批落地 5 个高频模块：文档 / 日记 / 待办 / 搜索 / AI 问答。
 * 其余模块先登记基础信息与使用说明，配置面板在后续批次补齐。
 *
 * 新增配置项时优先复用 app_config 现有 key（storageKey），
 * 避免抽屉与设置页出现两套数据。
 */
export const MODULE_REGISTRY: Record<ActiveView, ModuleMeta> = {
  home: {
    view: "home",
    label: "首页",
    icon: Home,
    description: "仪表盘、最近笔记与今日概览",
    helpFile: "home.md",
    panels: [
      {
        id: "widgets",
        title: "首页卡片",
        kind: "component",
        load: () =>
          import("@/components/home/HomeWidgetsSection").then((m) => ({
            default: m.HomeWidgetsSection,
          })),
      },
    ],
  },

  notes: {
    view: "notes",
    label: "文档",
    icon: NotebookText,
    description: "Markdown 笔记、白板与思维导图",
    helpFile: "notes.md",
    shortcuts: [
      { keys: "Ctrl + N", desc: "新建笔记" },
      { keys: "Ctrl + K", desc: "打开命令面板" },
      { keys: "F11", desc: "切换专注模式" },
      { keys: "Alt + ← / →", desc: "历史后退 / 前进" },
    ],
    groups: [
      { id: "external", label: "外部目录设置" },
      { id: "tags", label: "标签" },
      { id: "history", label: "历史版本" },
      { id: "general", label: "常规" },
      { id: "editor", label: "编辑器排版" },
    ],
    panels: [
      {
        id: "mounts",
        title: "外部目录",
        kind: "component",
        group: "external",
        load: () =>
          import("@/components/settings/MountSettingsSection").then((m) => ({
            default: m.MountSettingsSection,
          })),
      },
      {
        id: "tags",
        title: "标签",
        kind: "link",
        group: "tags",
        description:
          "标签属于文档模块：用于跨文件夹组织笔记。挂载的 Markdown 文档打标签会写回源文件 frontmatter；PDF / Word / Excel 的标签来自源文件解析。",
        link: { to: "/tags", label: "打开标签管理" },
      },
      {
        id: "general",
        title: "常规",
        kind: "schema",
        group: "general",
        fields: [
          {
            key: "auto_save_delay",
            label: "自动保存延迟",
            type: "number",
            defaultValue: 1.2,
            min: 0.5,
            max: 10,
            step: 0.5,
            unit: "秒",
            description: "编辑停止后多久执行保存（0.5–10 秒）",
          },
          {
            key: "default_sort",
            label: "默认排序",
            type: "select",
            defaultValue: "default",
            options: [
              { label: "最近更新", value: "default" },
              { label: "最近创建", value: "created" },
              { label: "标题 A–Z", value: "title" },
              { label: "自定义（拖拽）", value: "custom" },
            ],
          },
          {
            key: "show_word_count",
            label: "显示字数统计",
            type: "switch",
            defaultValue: true,
          },
        ],
      },
      {
        id: "snapshot",
        title: "历史快照",
        kind: "component",
        group: "history",
        load: () =>
          import("@/components/settings/SnapshotSection").then((m) => ({
            default: m.SnapshotSection,
          })),
      },
      {
        id: "orphan",
        title: "附件清理",
        kind: "component",
        group: "general",
        load: () => import("@/components/settings/OrphanAssetsPanel"),
      },
      {
        id: "import",
        title: "导入笔记",
        kind: "component",
        group: "general",
        load: () =>
          import("@/components/settings/ImportSection").then((m) => ({
            default: m.ImportSection,
          })),
      },
      {
        id: "export",
        title: "导出笔记",
        kind: "component",
        group: "general",
        load: () =>
          import("@/components/settings/ExportSection").then((m) => ({
            default: m.ExportSection,
          })),
      },
      {
        id: "ocr",
        title: "OCR 识别",
        kind: "component",
        group: "general",
        load: () =>
          import("@/components/settings/OcrSection").then((m) => ({
            default: m.OcrSection,
          })),
      },
      {
        id: "editor-typography",
        title: "编辑器排版",
        kind: "component",
        group: "editor",
        load: () =>
          import("@/components/settings/EditorTypographySection").then((m) => ({
            default: m.EditorTypographySection,
          })),
      },
    ],
  },

  daily: {
    view: "daily",
    label: "日记",
    icon: Calendar,
    description: "按日期记录日记与工作日志",
    helpFile: "daily.md",
    shortcuts: [
      { keys: "Ctrl + N", desc: "新建笔记" },
      { keys: "Ctrl + K", desc: "命令面板中跳转今日日记" },
    ],
    panels: [
      {
        id: "general",
        title: "常规",
        kind: "schema",
        fields: [
          {
            key: "auto_create_today",
            label: "自动创建今日日记",
            type: "switch",
            defaultValue: false,
            description: "打开日记模块时，如果今天还没有日记则自动创建",
          },
          {
            key: "date_format",
            label: "日期标题格式",
            type: "select",
            defaultValue: "YYYY-MM-DD",
            options: [
              { label: "2026-10-23", value: "YYYY-MM-DD" },
              { label: "2026年10月23日", value: "YYYY年MM月DD日" },
              { label: "10月23日 周四", value: "MM月DD日 dddd" },
            ],
          },
          {
            key: "default_template_id",
            storageKey: "daily.default_template_id",
            label: "默认模板 ID",
            type: "text",
            defaultValue: "",
            placeholder: "留空则使用空白日记",
            description: "模板管理中的模板 ID，可在模板页面查看",
          },
        ],
      },
      {
        id: "storage",
        title: "存储位置",
        kind: "component",
        load: () =>
          import("@/components/settings/DailyStorageSection").then((m) => ({
            default: m.DailyStorageSection,
          })),
      },
      {
        id: "editor-link",
        title: "编辑器排版",
        kind: "link",
        description: "字体、字号、行距等排版设置与文档编辑器共用。",
        link: { to: "/notes?config=editor", label: "打开编辑器排版" },
      },
    ],
  },

  tasks: {
    view: "tasks",
    label: "待办",
    icon: CheckSquare,
    description: "任务管理、提醒与重复任务",
    helpFile: "tasks.md",
    shortcuts: [
      { keys: "Ctrl + N", desc: "新建笔记（可在待办中转换为任务）" },
      { keys: "Shift + F1", desc: "打开当前模块使用说明" },
    ],
    panels: [
      {
        id: "general",
        title: "常规",
        kind: "schema",
        fields: [
          {
            key: "default_reminder_time",
            storageKey: "all_day_reminder_time",
            label: "全天任务默认提醒时间",
            type: "time",
            defaultValue: "09:00",
          },
          {
            key: "show_completed",
            label: "默认显示已完成任务",
            type: "switch",
            defaultValue: false,
          },
          {
            key: "default_priority",
            label: "默认优先级",
            type: "select",
            defaultValue: "medium",
            options: [
              { label: "低", value: "low" },
              { label: "中", value: "medium" },
              { label: "高", value: "high" },
            ],
          },
          {
            key: "repeat_default",
            label: "重复任务默认规则",
            type: "select",
            defaultValue: "none",
            options: [
              { label: "不重复", value: "none" },
              { label: "每天", value: "daily" },
              { label: "每周", value: "weekly" },
              { label: "每月", value: "monthly" },
            ],
          },
        ],
      },
      {
        id: "reminder-sound",
        title: "提醒声音",
        kind: "component",
        load: () => import("@/components/settings/ReminderSoundSection"),
      },
      {
        id: "recognize",
        title: "智能识别",
        kind: "component",
        load: () => import("@/components/settings/TaskRecognizeModeRow"),
      },
      {
        id: "templates",
        title: "任务模板",
        kind: "link",
        description: "任务模板与笔记模板统一在全局模板管理中维护。",
        link: { to: "/settings?tab=personal", label: "打开模板管理" },
      },
    ],
  },
  cards: {
    view: "cards",
    label: "卡片复习",
    icon: Layers,
    description: "基于间隔重复的卡片复习",
    helpFile: "cards.md",
    panels: [],
  },
  mounts: {
    view: "mounts",
    label: "外部目录",
    icon: HardDrive,
    description: "挂载并浏览本地外部目录",
    helpFile: "mounts.md",
    panels: [],
  },

  search: {
    view: "search",
    label: "搜索",
    icon: Search,
    description: "全库笔记与附件检索",
    helpFile: "search.md",
    shortcuts: [
      { keys: "Ctrl + K", desc: "打开命令面板 / 快速搜索" },
      { keys: "Shift + F1", desc: "打开当前模块使用说明" },
    ],
    panels: [
      {
        id: "general",
        title: "常规",
        kind: "schema",
        fields: [
          {
            key: "default_scope",
            label: "默认结果类型",
            type: "select",
            defaultValue: "all",
            options: [
              { label: "笔记 + 任务", value: "all" },
              { label: "仅笔记", value: "notes" },
              { label: "仅任务", value: "tasks" },
            ],
            description: "进入搜索页时默认选中的结果类型；URL 中显式指定时以 URL 为准",
          },
          {
            key: "title_only",
            label: "仅搜索标题",
            type: "switch",
            defaultValue: false,
            description: "开启后不检索正文，结果更快但可能漏掉正文中的关键词",
          },
          {
            key: "max_results",
            label: "结果数量上限",
            type: "number",
            defaultValue: 50,
            min: 10,
            max: 200,
            unit: "条",
            description: "后端单次搜索最多返回 200 条",
          },
        ],
      },
    ],
  },

  tags: {
    view: "tags",
    label: "标签",
    icon: Tags,
    description: "标签分类、颜色与层级",
    helpFile: "tags.md",
    panels: [],
  },
  graph: {
    view: "graph",
    label: "文档关系",
    icon: GitBranch,
    description: "文档之间的双向链接关系",
    helpFile: "graph.md",
    panels: [],
  },

  ai: {
    view: "ai",
    label: "AI 问答",
    icon: Bot,
    description: "基于本地笔记的 AI 对话与提问",
    helpFile: "ai.md",
    shortcuts: [
      { keys: "Ctrl + K", desc: "命令面板中发起 AI 提问" },
      { keys: "Shift + F1", desc: "打开当前模块使用说明" },
    ],
    groups: [
      { id: "models", label: "模型" },
      { id: "asr", label: "语音识别" },
      { id: "mcp", label: "MCP" },
      { id: "prompts", label: "提示词" },
    ],
    panels: [
      {
        id: "models",
        title: "模型配置",
        kind: "component",
        group: "models",
        load: () =>
          import("@/components/settings/AiModelsSection").then((m) => ({
            default: m.AiModelsSection,
          })),
      },
      {
        id: "asr",
        title: "语音识别",
        kind: "component",
        group: "asr",
        load: () =>
          import("@/components/settings/AsrSection").then((m) => ({
            default: m.AsrSection,
          })),
      },
      {
        id: "mcp",
        title: "MCP 工具",
        kind: "component",
        group: "mcp",
        load: () =>
          import("@/components/settings/MCPServerSection").then((m) => ({
            default: m.MCPServerSection,
          })),
      },
      {
        id: "embedding",
        title: "向量检索",
        kind: "component",
        group: "mcp",
        load: () =>
          import("@/components/settings/EmbeddingSection").then((m) => ({
            default: m.EmbeddingSection,
          })),
      },
      {
        id: "agent",
        title: "Claude Agent",
        kind: "component",
        group: "mcp",
        load: () => import("@/components/ai/ClaudeAgentRunnerCard"),
      },
      {
        id: "prompts",
        title: "提示词",
        kind: "component",
        group: "prompts",
        load: () =>
          import("@/components/settings/PromptsSection").then((m) => ({
            default: m.PromptsSection,
          })),
      },
    ],
  },

  prompts: {
    view: "prompts",
    label: "提示词",
    icon: Sparkles,
    description: "可复用的提示词模板",
    helpFile: "prompts.md",
    panels: [],
  },
  push: {
    view: "push",
    label: "定时推送",
    icon: Bell,
    description: "定时把笔记或提醒推送到桌面",
    helpFile: "push.md",
    panels: [],
  },
  plugins: {
    view: "plugins",
    label: "插件",
    icon: Plug,
    description: "扩展应用能力的插件系统",
    helpFile: "plugins.md",
    panels: [
      {
        id: "plugin-settings",
        title: "插件设置",
        kind: "component",
        load: () =>
          import("@/components/settings/PluginSettingsTabs").then((m) => ({
            default: m.PluginSettingsTabs,
          })),
      },
      {
        id: "manage",
        title: "插件管理",
        kind: "link",
        description: "安装、启用插件，查看插件声明的权限与命令。",
        link: { to: "/plugins", label: "打开插件管理" },
      },
    ],
  },

  research: {
    view: "research",
    label: "助研",
    icon: FlaskConical,
    description: "围绕课题组织文献、前沿追踪、学术写作与数据分析",
    helpFile: "research.md",
    panels: [
      {
        id: "open",
        title: "助研工作台",
        kind: "link",
        description: "按课题管理文献与 AI 产出，支持导出为笔记。",
        link: { to: "/research", label: "打开助研工作台" },
      },
    ],
  },

  hidden: {
    view: "hidden",
    label: "隐藏文档",
    icon: EyeOff,
    description: "需要 PIN 解锁的私密文档",
    helpFile: "hidden.md",
    panels: [
      {
        id: "pin",
        title: "隐藏 PIN",
        kind: "component",
        load: () =>
          import("@/components/hidden/HiddenPinSection").then((m) => ({
            default: m.HiddenPinSection,
          })),
      },
    ],
  },
  trash: {
    view: "trash",
    label: "回收站",
    icon: Trash2,
    description: "已删除笔记的恢复与清理",
    helpFile: "trash.md",
    panels: [],
  },
  about: {
    view: "about",
    label: "关于",
    icon: Info,
    description: "版本信息、数据目录与开源许可",
    helpFile: "about.md",
    panels: [],
  },
};

/** 当前模块是否具备任何配置面板 */
export function moduleHasConfig(meta: ModuleMeta | null): boolean {
  return !!meta && meta.panels.length > 0;
}
