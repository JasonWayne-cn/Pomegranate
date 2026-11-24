/**
 * UI v4 主题令牌（L1 主题调色板 → L3 Ant Design token）
 *
 * 单一事实来源约定：每套主题的颜色写两处，改色必须同步
 * - 本文件 PALETTES：给 Ant Design（含 Modal / Dropdown 等 portal 弹层）
 * - src/styles/themes.css 的 [data-theme="…"] 变量块：给应用自有样式
 *
 * 旧主题（light-glass / light-warm / light-jade / dark-starry / dark-mocha）
 * 通过 normalizeThemeMode 归一为新主题，T4 再删除旧 CSS 块。
 */
import type { ThemeConfig } from "antd";

/** 主题模式（9 套） */
export type ThemeMode =
  | "light-lilac"
  | "light-celadon"
  | "light-mist"
  | "light-peach"
  | "light-gold"
  | "dark-ember"
  | "dark-ocean"
  | "dark-amber"
  | "dark-black";

/** 旧版本主题 id，仅用于持久化归一 */
export type LegacyThemeMode =
  | "light-glass"
  | "light-warm"
  | "light-jade"
  | "dark-starry"
  | "dark-mocha";

/** 主题分类 */
export type ThemeCategory = "light" | "dark";

/** 主题调色板 */
export interface ThemePalette {
  key: ThemeMode;
  label: string;
  category: ThemeCategory;
  description: string;
  /** 预览色块 */
  colors: [string, string, string, string];
  primary: string;
  primaryHover: string;
  primaryActive: string;
  /** 主色上的文字颜色 */
  primaryContrast: string;
  primaryLight: string;
  accent: string;
  bgApp: string;
  bgCard: string;
  bgElevated: string;
  bgSidebar: string;
  bgHeader: string;
  bgHover: string;
  bgActive: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderSecondary: string;
  borderCard: string;
  /** 自定义背景图下面板的 rgb 三元组 */
  surfaceBase: string;
  surfaceHover: string;
  surfaceBorder: string;
  shadowSm: string;
  shadowMd: string;
  scrollbarThumb: string;
  scrollbarHover: string;
}

const LIGHT_SHADOW_SM = "0 1px 2px rgba(0, 0, 0, 0.04)";
const LIGHT_SHADOW_MD = "0 6px 20px rgba(0, 0, 0, 0.06)";
const DARK_SHADOW_SM = "0 1px 2px rgba(0, 0, 0, 0.32)";
const DARK_SHADOW_MD = "0 8px 24px rgba(0, 0, 0, 0.38)";

/** 9 套主题调色板 */
export const PALETTES: Record<ThemeMode, ThemePalette> = {
  "light-lilac": {
    key: "light-lilac",
    label: "淡紫",
    category: "light",
    description: "淡紫底色 + 白纸内容区",
    colors: ["#E9E4F8", "#7C63DC", "#C86A9E", "#27233B"],
    primary: "#7C63DC",
    primaryHover: "#6B4FD1",
    primaryActive: "#5B3FC0",
    primaryContrast: "#FFFFFF",
    primaryLight: "rgba(124, 99, 220, 0.10)",
    accent: "#C86A9E",
    bgApp: "#E9E4F8",
    bgCard: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSidebar: "#F1EDFB",
    bgHeader: "#F4F0FC",
    bgHover: "rgba(124, 99, 220, 0.08)",
    bgActive: "rgba(124, 99, 220, 0.14)",
    textPrimary: "#27233B",
    textSecondary: "#5E5872",
    textTertiary: "#948EA8",
    border: "rgba(39, 35, 59, 0.10)",
    borderSecondary: "rgba(39, 35, 59, 0.06)",
    borderCard: "rgba(39, 35, 59, 0.08)",
    surfaceBase: "255, 255, 255",
    surfaceHover: "rgba(39, 35, 59, 0.05)",
    surfaceBorder: "rgba(39, 35, 59, 0.08)",
    shadowSm: LIGHT_SHADOW_SM,
    shadowMd: LIGHT_SHADOW_MD,
    scrollbarThumb: "rgba(124, 99, 220, 0.18)",
    scrollbarHover: "rgba(124, 99, 220, 0.30)",
  },
  "light-celadon": {
    key: "light-celadon",
    label: "青瓷",
    category: "light",
    description: "青瓷绿底色 + 白纸内容区",
    colors: ["#E2EFEC", "#258A7E", "#C9793F", "#1F3431"],
    primary: "#258A7E",
    primaryHover: "#1F7A6F",
    primaryActive: "#196A60",
    primaryContrast: "#FFFFFF",
    primaryLight: "rgba(37, 138, 126, 0.10)",
    accent: "#C9793F",
    bgApp: "#E2EFEC",
    bgCard: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSidebar: "#EAF4F1",
    bgHeader: "#EDF6F3",
    bgHover: "rgba(37, 138, 126, 0.08)",
    bgActive: "rgba(37, 138, 126, 0.14)",
    textPrimary: "#1F3431",
    textSecondary: "#4E6A65",
    textTertiary: "#8AA39E",
    border: "rgba(31, 52, 49, 0.10)",
    borderSecondary: "rgba(31, 52, 49, 0.06)",
    borderCard: "rgba(31, 52, 49, 0.08)",
    surfaceBase: "255, 255, 255",
    surfaceHover: "rgba(31, 52, 49, 0.05)",
    surfaceBorder: "rgba(31, 52, 49, 0.08)",
    shadowSm: LIGHT_SHADOW_SM,
    shadowMd: LIGHT_SHADOW_MD,
    scrollbarThumb: "rgba(37, 138, 126, 0.18)",
    scrollbarHover: "rgba(37, 138, 126, 0.30)",
  },
  "light-mist": {
    key: "light-mist",
    label: "晨雾蓝",
    category: "light",
    description: "晨雾蓝底色 + 白纸内容区",
    colors: ["#E3EAF6", "#3D74D6", "#7A63C9", "#1F2A3D"],
    primary: "#3D74D6",
    primaryHover: "#3265C2",
    primaryActive: "#2956AF",
    primaryContrast: "#FFFFFF",
    primaryLight: "rgba(61, 116, 214, 0.10)",
    accent: "#7A63C9",
    bgApp: "#E3EAF6",
    bgCard: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSidebar: "#EBF1FA",
    bgHeader: "#EEF3FB",
    bgHover: "rgba(61, 116, 214, 0.08)",
    bgActive: "rgba(61, 116, 214, 0.14)",
    textPrimary: "#1F2A3D",
    textSecondary: "#56657E",
    textTertiary: "#93A0B5",
    border: "rgba(31, 42, 61, 0.10)",
    borderSecondary: "rgba(31, 42, 61, 0.06)",
    borderCard: "rgba(31, 42, 61, 0.08)",
    surfaceBase: "255, 255, 255",
    surfaceHover: "rgba(31, 42, 61, 0.05)",
    surfaceBorder: "rgba(31, 42, 61, 0.08)",
    shadowSm: LIGHT_SHADOW_SM,
    shadowMd: LIGHT_SHADOW_MD,
    scrollbarThumb: "rgba(61, 116, 214, 0.18)",
    scrollbarHover: "rgba(61, 116, 214, 0.30)",
  },
  "light-peach": {
    key: "light-peach",
    label: "杏桃",
    category: "light",
    description: "杏桃底色 + 白纸内容区",
    colors: ["#F6E9E1", "#C65F45", "#A9783F", "#3A2925"],
    primary: "#C65F45",
    primaryHover: "#B05038",
    primaryActive: "#99412C",
    primaryContrast: "#FFFFFF",
    primaryLight: "rgba(198, 95, 69, 0.10)",
    accent: "#A9783F",
    bgApp: "#F6E9E1",
    bgCard: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSidebar: "#FAF1EB",
    bgHeader: "#FBF4EF",
    bgHover: "rgba(198, 95, 69, 0.08)",
    bgActive: "rgba(198, 95, 69, 0.14)",
    textPrimary: "#3A2925",
    textSecondary: "#77605A",
    textTertiary: "#B29C93",
    border: "rgba(58, 41, 37, 0.10)",
    borderSecondary: "rgba(58, 41, 37, 0.06)",
    borderCard: "rgba(58, 41, 37, 0.08)",
    surfaceBase: "255, 255, 255",
    surfaceHover: "rgba(58, 41, 37, 0.05)",
    surfaceBorder: "rgba(58, 41, 37, 0.08)",
    shadowSm: LIGHT_SHADOW_SM,
    shadowMd: LIGHT_SHADOW_MD,
    scrollbarThumb: "rgba(198, 95, 69, 0.18)",
    scrollbarHover: "rgba(198, 95, 69, 0.30)",
  },
  "light-gold": {
    key: "light-gold",
    label: "香槟",
    category: "light",
    description: "香槟金底色 + 白纸内容区",
    colors: ["#F5EEDC", "#A87B1E", "#7C8B3F", "#33291A"],
    primary: "#A87B1E",
    primaryHover: "#936A16",
    primaryActive: "#7E5A0F",
    primaryContrast: "#FFFFFF",
    primaryLight: "rgba(168, 123, 30, 0.10)",
    accent: "#7C8B3F",
    bgApp: "#F5EEDC",
    bgCard: "#FFFFFF",
    bgElevated: "#FFFFFF",
    bgSidebar: "#F8F3E6",
    bgHeader: "#FAF5EA",
    bgHover: "rgba(168, 123, 30, 0.08)",
    bgActive: "rgba(168, 123, 30, 0.14)",
    textPrimary: "#33291A",
    textSecondary: "#71643F",
    textTertiary: "#AC9F7D",
    border: "rgba(51, 41, 26, 0.10)",
    borderSecondary: "rgba(51, 41, 26, 0.06)",
    borderCard: "rgba(51, 41, 26, 0.08)",
    surfaceBase: "255, 255, 255",
    surfaceHover: "rgba(51, 41, 26, 0.05)",
    surfaceBorder: "rgba(51, 41, 26, 0.08)",
    shadowSm: LIGHT_SHADOW_SM,
    shadowMd: LIGHT_SHADOW_MD,
    scrollbarThumb: "rgba(168, 123, 30, 0.18)",
    scrollbarHover: "rgba(168, 123, 30, 0.30)",
  },
  "dark-ember": {
    key: "dark-ember",
    label: "暖炭",
    category: "dark",
    description: "暖炭底 + 紫罗兰点缀",
    colors: ["#161514", "#A992FA", "#E08C6A", "#EFEBE4"],
    primary: "#A992FA",
    primaryHover: "#B7A4FC",
    primaryActive: "#9580E8",
    primaryContrast: "#1B1725",
    primaryLight: "rgba(169, 146, 250, 0.14)",
    accent: "#E08C6A",
    bgApp: "#161514",
    bgCard: "#1F1E1C",
    bgElevated: "#262420",
    bgSidebar: "#1B1A18",
    bgHeader: "#191817",
    bgHover: "rgba(169, 146, 250, 0.10)",
    bgActive: "rgba(169, 146, 250, 0.18)",
    textPrimary: "#EFEBE4",
    textSecondary: "#B3ADA3",
    textTertiary: "#7E786E",
    border: "rgba(239, 235, 228, 0.10)",
    borderSecondary: "rgba(239, 235, 228, 0.06)",
    borderCard: "rgba(239, 235, 228, 0.08)",
    surfaceBase: "31, 30, 28",
    surfaceHover: "rgba(239, 235, 228, 0.07)",
    surfaceBorder: "rgba(239, 235, 228, 0.12)",
    shadowSm: DARK_SHADOW_SM,
    shadowMd: DARK_SHADOW_MD,
    scrollbarThumb: "rgba(239, 235, 228, 0.16)",
    scrollbarHover: "rgba(239, 235, 228, 0.28)",
  },
  "dark-ocean": {
    key: "dark-ocean",
    label: "深海",
    category: "dark",
    description: "深海蓝底 + 天蓝点缀",
    colors: ["#12171E", "#5AA9F0", "#4FD1C5", "#E6ECF3"],
    primary: "#5AA9F0",
    primaryHover: "#4A99E0",
    primaryActive: "#3C89CE",
    primaryContrast: "#0E1720",
    primaryLight: "rgba(90, 169, 240, 0.14)",
    accent: "#4FD1C5",
    bgApp: "#12171E",
    bgCard: "#1A2129",
    bgElevated: "#212A34",
    bgSidebar: "#161D24",
    bgHeader: "#151B22",
    bgHover: "rgba(90, 169, 240, 0.10)",
    bgActive: "rgba(90, 169, 240, 0.18)",
    textPrimary: "#E6ECF3",
    textSecondary: "#A7B4C2",
    textTertiary: "#73808D",
    border: "rgba(230, 236, 243, 0.10)",
    borderSecondary: "rgba(230, 236, 243, 0.06)",
    borderCard: "rgba(230, 236, 243, 0.08)",
    surfaceBase: "26, 33, 41",
    surfaceHover: "rgba(230, 236, 243, 0.07)",
    surfaceBorder: "rgba(230, 236, 243, 0.12)",
    shadowSm: DARK_SHADOW_SM,
    shadowMd: DARK_SHADOW_MD,
    scrollbarThumb: "rgba(230, 236, 243, 0.16)",
    scrollbarHover: "rgba(230, 236, 243, 0.28)",
  },
  "dark-amber": {
    key: "dark-amber",
    label: "琥珀",
    category: "dark",
    description: "深棕底 + 琥珀点缀",
    colors: ["#17130E", "#E9B95A", "#C97A4A", "#F0E8DC"],
    primary: "#E9B95A",
    primaryHover: "#DDA945",
    primaryActive: "#CC9735",
    primaryContrast: "#1E170D",
    primaryLight: "rgba(233, 185, 90, 0.14)",
    accent: "#C97A4A",
    bgApp: "#17130E",
    bgCard: "#201B14",
    bgElevated: "#28221A",
    bgSidebar: "#1C1711",
    bgHeader: "#1A150F",
    bgHover: "rgba(233, 185, 90, 0.10)",
    bgActive: "rgba(233, 185, 90, 0.18)",
    textPrimary: "#F0E8DC",
    textSecondary: "#BAAE99",
    textTertiary: "#877C68",
    border: "rgba(240, 232, 220, 0.10)",
    borderSecondary: "rgba(240, 232, 220, 0.06)",
    borderCard: "rgba(240, 232, 220, 0.08)",
    surfaceBase: "32, 27, 20",
    surfaceHover: "rgba(240, 232, 220, 0.07)",
    surfaceBorder: "rgba(240, 232, 220, 0.12)",
    shadowSm: DARK_SHADOW_SM,
    shadowMd: DARK_SHADOW_MD,
    scrollbarThumb: "rgba(240, 232, 220, 0.16)",
    scrollbarHover: "rgba(240, 232, 220, 0.28)",
  },
  "dark-black": {
    key: "dark-black",
    label: "纯黑",
    category: "dark",
    description: "纯黑底 + 紫罗兰点缀",
    colors: ["#0A0A0B", "#A992FA", "#E08C6A", "#ECECEE"],
    primary: "#A992FA",
    primaryHover: "#B7A4FC",
    primaryActive: "#9580E8",
    primaryContrast: "#1B1725",
    primaryLight: "rgba(169, 146, 250, 0.14)",
    accent: "#E08C6A",
    bgApp: "#0A0A0B",
    bgCard: "#131315",
    bgElevated: "#1A1A1D",
    bgSidebar: "#101011",
    bgHeader: "#0D0D0E",
    bgHover: "rgba(169, 146, 250, 0.10)",
    bgActive: "rgba(169, 146, 250, 0.18)",
    textPrimary: "#ECECEE",
    textSecondary: "#A9A9B0",
    textTertiary: "#6F6F78",
    border: "rgba(236, 236, 238, 0.10)",
    borderSecondary: "rgba(236, 236, 238, 0.06)",
    borderCard: "rgba(236, 236, 238, 0.08)",
    surfaceBase: "19, 19, 21",
    surfaceHover: "rgba(236, 236, 238, 0.07)",
    surfaceBorder: "rgba(236, 236, 238, 0.12)",
    shadowSm: DARK_SHADOW_SM,
    shadowMd: DARK_SHADOW_MD,
    scrollbarThumb: "rgba(236, 236, 238, 0.16)",
    scrollbarHover: "rgba(236, 236, 238, 0.28)",
  },
};

/** 所有主题列表 */
export const themes: ThemePalette[] = Object.values(PALETTES);

/** 主题元信息（兼容旧引用） */
export type ThemeMeta = ThemePalette;

/** 判断主题分类 */
export function getThemeCategory(mode: ThemeMode): ThemeCategory {
  return PALETTES[mode]?.category ?? (mode.startsWith("light") ? "light" : "dark");
}

/** 获取同类别的主题列表 */
export function getThemesByCategory(category: ThemeCategory): ThemePalette[] {
  return themes.filter((t) => t.category === category);
}

const LEGACY_LIGHT: Record<string, ThemeMode> = {
  "light-glass": "light-lilac",
  "light-warm": "light-peach",
  "light-jade": "light-celadon",
};
const LEGACY_DARK: Record<string, ThemeMode> = {
  "dark-starry": "dark-ember",
  "dark-mocha": "dark-ember",
};

/**
 * 旧主题 id 归一。刷新/重启后老配置仍能落到一套有效的新主题上。
 */
export function normalizeThemeMode(
  input: string | null | undefined,
  fallback: ThemeMode = "light-lilac",
): ThemeMode {
  if (!input) return fallback;
  const has = (obj: object, key: string) =>
    Object.prototype.hasOwnProperty.call(obj, key);
  if (has(PALETTES, input)) return input as ThemeMode;
  if (has(LEGACY_LIGHT, input)) return LEGACY_LIGHT[input];
  if (has(LEGACY_DARK, input)) return LEGACY_DARK[input];
  return fallback;
}

type AntdToken = NonNullable<ThemeConfig["token"]>;
type AntdComponents = NonNullable<ThemeConfig["components"]>;

/** Ant Design ConfigProvider token 映射（含 portal 弹层） */
export function getAntdTokens(mode: ThemeMode): AntdToken {
  const p = PALETTES[mode];
  const isDark = p.category === "dark";
  return {
    colorPrimary: p.primary,
    colorPrimaryHover: p.primaryHover,
    colorPrimaryActive: p.primaryActive,
    colorPrimaryBg: p.primaryLight,
    colorPrimaryBgHover: p.bgActive,
    colorPrimaryBorder: p.primary,
    colorInfo: p.primary,
    colorLink: p.primary,
    colorLinkHover: p.primaryHover,
    colorText: p.textPrimary,
    colorTextSecondary: p.textSecondary,
    colorTextTertiary: p.textTertiary,
    colorTextQuaternary: p.textTertiary,
    colorTextHeading: p.textPrimary,
    colorTextBase: p.textPrimary,
    colorBgBase: p.bgApp,
    colorBgLayout: p.bgApp,
    colorBgContainer: p.bgCard,
    colorBgElevated: p.bgElevated,
    colorBgMask: isDark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.38)",
    colorBorder: p.border,
    colorBorderSecondary: p.borderSecondary,
    colorSplit: p.borderSecondary,
    colorFill: p.bgHover,
    colorFillSecondary: p.bgHover,
    colorFillTertiary: p.borderSecondary,
    colorFillQuaternary: p.borderCard,
    borderRadius: 8,
    borderRadiusSM: 6,
    borderRadiusLG: 12,
    borderRadiusXS: 4,
    boxShadow: p.shadowMd,
    boxShadowSecondary: p.shadowMd,
    boxShadowTertiary: p.shadowSm,
    controlOutline: p.primaryLight,
    controlOutlineWidth: 3,
  };
}

/** Ant Design 组件级覆盖（圆角 / 按钮无投影 / 弹层底色） */
export function getAntdComponents(mode: ThemeMode): AntdComponents {
  const p = PALETTES[mode];
  return {
    Button: {
      borderRadius: 8,
      defaultShadow: "none",
      primaryShadow: "none",
      dangerShadow: "none",
      defaultBg: p.bgCard,
      defaultColor: p.textPrimary,
      defaultBorderColor: p.border,
      defaultHoverBg: p.primaryLight,
      defaultHoverColor: p.primary,
      defaultHoverBorderColor: p.primary,
      defaultActiveBg: p.bgActive,
      defaultActiveColor: p.primaryActive,
      defaultActiveBorderColor: p.primaryActive,
      primaryColor: p.primaryContrast,
    },
    Card: {
      borderRadiusLG: 14,
      colorBgContainer: p.bgCard,
      headerBg: "transparent",
    },
    Modal: {
      borderRadiusLG: 16,
      contentBg: p.bgElevated,
      headerBg: "transparent",
      titleColor: p.textPrimary,
    },
    Dropdown: {
      borderRadiusLG: 11,
      colorBgElevated: p.bgElevated,
      controlItemBgHover: p.bgHover,
      controlItemBgActive: p.primaryLight,
      controlItemBgActiveHover: p.bgActive,
    },
    Menu: {
      itemBorderRadius: 6,
      itemBg: "transparent",
      itemColor: p.textSecondary,
      itemHoverBg: p.bgHover,
      itemHoverColor: p.textPrimary,
      itemSelectedBg: p.bgActive,
      itemSelectedColor: p.primary,
      subMenuItemBg: "transparent",
    },
    Input: {
      activeBorderColor: p.primary,
      hoverBorderColor: p.primary,
      activeShadow: `0 0 0 3px ${p.primaryLight}`,
      colorBgContainer: p.bgCard,
    },
    InputNumber: {
      activeBorderColor: p.primary,
      hoverBorderColor: p.primary,
      activeShadow: `0 0 0 3px ${p.primaryLight}`,
      colorBgContainer: p.bgCard,
    },
    Select: {
      optionSelectedBg: p.primaryLight,
      optionSelectedColor: p.primary,
      optionActiveBg: p.bgHover,
      colorBgElevated: p.bgElevated,
    },
    Table: {
      headerBg: p.bgHover,
      headerColor: p.textSecondary,
      rowHoverBg: p.bgHover,
      borderColor: p.border,
      headerSplitColor: "transparent",
    },
    Tabs: {
      itemSelectedColor: p.primary,
      itemHoverColor: p.primaryHover,
      inkBarColor: p.primary,
    },
    Segmented: {
      trackBg: p.bgHover,
      itemSelectedBg: p.bgCard,
      itemSelectedColor: p.textPrimary,
      itemColor: p.textSecondary,
    },
    Tooltip: {
      borderRadius: 8,
    },
  };
}
