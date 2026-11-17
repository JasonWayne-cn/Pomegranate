import type { OnboardingTourDef, OnboardingTourId } from "./types";

/**
 * 各页面的新手引导定义（数据驱动）。
 *
 * 约定：
 * - target 指向带 data-tour 属性的元素；元素不存在时该步自动跳过
 * - 文案集中在这里维护，页面组件只负责加锚点
 */
export const TOURS: Record<OnboardingTourId, OnboardingTourDef> = {
  app: {
    id: "app",
    title: "应用总览",
    steps: [
      {
        target: '[data-tour="nav-home"]',
        title: "首页工作台",
        description:
          "汇总搜索、待办、最近文档与写作统计，每次启动先看一眼今天的重点。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-notes"]',
        title: "文档",
        description:
          "所有笔记按文件夹组织，支持列表、卡片、时间线三种视图和批量操作。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-daily"]',
        title: "日记",
        description:
          "按日期记录，输入即自动保存；可以按历史日期翻看，也能让 AI 规划今天。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-tasks"]',
        title: "待办",
        description:
          "集中管理任务与紧急事项，侧边栏角标会提示临期数量。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-search"]',
        title: "全局搜索",
        description:
          "按标题、正文或标签检索全部内容，快捷键 Ctrl+K 可随时唤起。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-ai"]',
        title: "AI 问答",
        description:
          "基于你的笔记内容提问，也可以选择不同模型进行深度分析。",
        placement: "right",
      },
      {
        target: '[data-tour="nav-extensions"]',
        title: "扩展包",
        description:
          "PPT 生成等能力按需安装，主程序保持轻量；安装后入口会自动出现。",
        placement: "right",
      },
    ],
  },
  home: {
    id: "home",
    title: "首页导览",
    steps: [
      {
        target: '[data-tour="home-search"]',
        title: "搜索与新建",
        description:
          "顶部搜索可直达文档与待办；右侧按钮一键新建笔记，Ctrl+K 可全局搜索。",
        placement: "bottom",
      },
      {
        target: '[data-tour="home-quick-actions"]',
        title: "快速操作",
        description:
          "添加待办、打开今日笔记、AI 问答、文档关系等高频入口集中在这里。",
        placement: "bottom",
      },
      {
        target: '[data-tour="home-widget-todo"]',
        title: "待办速览",
        description:
          "今天与逾期的任务一眼可见，可直接勾选完成或跳转到完整待办页。",
        placement: "bottom",
      },
      {
        target: '[data-tour="home-widget-recent"]',
        title: "最近文档",
        description:
          "最近编辑过的笔记，点击即可继续写作；不需要再去文件夹里翻。",
        placement: "bottom",
      },
      {
        target: '[data-tour="home-widget-ai"]',
        title: "问 AI",
        description:
          "基于当前笔记内容快速提问，也可以进入完整对话查看所有会话。",
        placement: "bottom",
      },
      {
        target: '[data-tour="home-widget-writing-stat"]',
        title: "写作活力",
        description:
          "展示文档总数、字数、连续写作天数与近 14 天趋势，帮你保持节奏。",
        placement: "top",
      },
    ],
  },
  notes: {
    id: "notes",
    title: "文档导览",
    steps: [
      {
        target: '[data-tour="notes-toolbar"]',
        title: "视图与新建",
        description:
          "在列表、卡片、时间线之间切换视图；右上角可新建文档或批量移到回收站。",
        placement: "bottom",
      },
      {
        target: '[data-tour="notes-search"]',
        title: "筛选文档",
        description:
          "按标题搜索文档，支持语音输入；搜索结果同样可以批量操作。",
        placement: "bottom",
      },
      {
        target: '[data-tour="notes-tree"]',
        title: "文档树",
        description:
          "左侧按文件夹组织文档，支持拖拽排序、嵌套与右键菜单管理。",
        placement: "right",
      },
      {
        target: '[data-tour="notes-list"]',
        title: "文档列表",
        description:
          "勾选后可批量移动、打标签或导出；右键单篇文档可查看更多操作。",
        placement: "top",
      },
    ],
  },
  daily: {
    id: "daily",
    title: "日记导览",
    steps: [
      {
        target: '[data-tour="daily-toolbar"]',
        title: "日期与工具",
        description:
          "左右翻页切换日期，点日期可打开日历；这里还能 AI 规划今日、导入历史日记、显示大纲和手动保存。",
        placement: "bottom",
      },
      {
        target: '[data-tour="daily-title"]',
        title: "日记标题",
        description:
          "默认使用当天日期，也可以改成更有辨识度的标题。",
        placement: "bottom",
      },
      {
        target: '[data-tour="daily-editor"]',
        title: "正文编辑",
        description:
          "输入即自动保存；输入 / 可插入标题、待办、代码块等内容，右侧大纲可快速定位。",
        placement: "top",
      },
    ],
  },
};
