#!/usr/bin/env node
/**
 * UI v4 颜色审计
 *
 * 目标：页面/组件代码只消费 --kb-* 语义变量或 antd token，不得写死主题色。
 * 画布 / 图表 / 第三方渲染器 / 打印导出等有意保留颜色的文件在 allowlist 中。
 *
 * 用法：
 *   node scripts/check-theme-colors.mjs           # 报告
 *   node scripts/check-theme-colors.mjs --strict  # 有违规时退出码 1（可用于 CI）
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src");
const exts = new Set([".ts", ".tsx"]);

const allowDirs = [
  "vendor",
  "assets",
  "pages/graph",
  "pages/whiteboard",
  "pages/office",
  "pages/ppt",
  "pages/pptx-spike",
  "pages/print",
  "pages/migration-splash",
  "components/graph",
  "components/whiteboard",
  "components/office",
  "components/preview",
  "components/notes/SlideshowView.tsx",
  "components/editor/SlideshowView.tsx",
  "components/notes/MindMapView.tsx",
  "components/editor/MermaidPreview.tsx",
  "components/editor/CodeBlockEnhanced.tsx",
  "components/editor/TiptapEditor.tsx",
  "components/editor/AnnotationButton.tsx",
  "lib/office",
  "lib/printNote.ts",
  "lib/highlight.tsx",
  "lib/exportPdf.ts",
];

/**
 * 允许写死颜色的文件：
 * - 主题定义 / 颜色选择器（用户明确选择具体色值，必须持久化 hex）
 * - 品牌文件类型图标
 * - 独立崩溃页 / 迁移 splash（不依赖主题挂载）
 */
const allowFiles = new Set([
  "theme/tokens.ts",
  "types/index.ts",
  "main.tsx",
  "store/index.ts",
  "pages/settings/index.tsx",
  "components/FileTypeIcon.tsx",
  "components/TagColorPicker.tsx",
  "components/tasks/TaskCategoryManageModal.tsx",
  "components/tasks/CreateTaskModal.tsx",
  "components/tasks/ProjectManageModal.tsx",
  "components/editor/EditorToolbar.tsx",
  "components/editor/AnnotationButton.tsx",
  "components/editor/DiffMergeModal.tsx",
  "components/ui/RootErrorBoundary.tsx",
  "components/ui/UpdateBadge.tsx",
  "components/ui/UpdateModal.tsx",
  "components/ui/ExitConfirmListener.tsx",
  "components/ai/TaskSessionPlanSidebar.tsx",
  "components/AsrToggleController.tsx",
  "components/MicButton.tsx",
  "components/QuickCaptureAsrModal.tsx",
  "components/LayoutSwitch.tsx",
  "components/layout/InstanceBadge.tsx",
  "pages/cards/index.tsx",
  "pages/project-sessions/index.tsx",
  "pages/emergency-reminder/index.tsx",
]);

/** 中性色 / 语义状态色：不随主题变化，允许保留 */
const neutralOrStatus = new Set([
  "#fff",
  "#ffffff",
  "#000",
  "#000000",
  "#52c41a",
  "#faad14",
  "#ff4d4f",
  "#fa8c16",
  "#f5222d",
  "#cf1322",
  "#ff7875",
  "#d4380d",
  "#e81123",
]);

/** 去掉块注释与行注释，避免把 issue 编号（#108 / #2791）误判为颜色 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const isAllowedLiteral = (literal) => {
  const v = literal.toLowerCase().replace(/\s+/g, "");
  if (neutralOrStatus.has(v)) return true;
  if (/^rgba?\((0,0,0|255,255,255)(,[0-9.]+)?\)$/.test(v)) return true;
  // 形如 rgba(..., ${expr}) 的动态模板，无法静态判断，放行
  return literal.includes("${");
};

const violations = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (fs.statSync(full).isDirectory()) {
      if (allowDirs.some((d) => rel === d || rel.startsWith(d + "/"))) continue;
      walk(full);
      continue;
    }
    if (!exts.has(path.extname(name)) || name.includes(".test.")) continue;
    if (allowFiles.has(rel)) continue;
    if (allowDirs.some((d) => rel === d)) continue;

    const lines = stripComments(fs.readFileSync(full, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      const matches = line.match(colorRe);
      if (!matches) return;
      for (const literal of matches) {
        if (!isAllowedLiteral(literal)) {
          violations.push(`${rel}:${i + 1}  ${literal}`);
        }
      }
    });
  }
}

walk(root);

if (violations.length) {
  console.error(`✗ 发现 ${violations.length} 处未接入主题的写死颜色：`);
  for (const v of violations) console.error("  " + v);
  if (process.argv.includes("--strict")) process.exit(1);
} else {
  console.log("✓ 颜色审计通过：页面/组件未发现写死主题色");
}
