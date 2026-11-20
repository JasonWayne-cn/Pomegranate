# AI 提示词分组与划词快捷框改造方案

> 状态：实施中（v87 迁移）
> 关联代码：`src/components/editor/AiWriteMenu.tsx`、`src/components/settings/PromptsSection.tsx`、`src-tauri/src/database/prompt.rs`、`src-tauri/src/database/schema.rs`

## 1. 背景

当前划词浮条把全部启用提示词平铺成一行，内置 7 条 + 用户自建后很快超宽；且浮条锚定选区末端向外展开，靠近右边缘时被视口截断。

同时提示词库只有全局 `sort_order`，没有分组概念；「自定义」入口语义模糊，实际是单次指令执行，与多轮「问AI」容易混淆。

## 2. 目标

1. 修复划词浮条超出屏幕（水平 clamp + 垂直翻转）。
2. 提示词支持分组，每组在快捷框中对应一个折叠下拉。
3. 分组与组内提示词均可排序，快捷框顺序与配置一致。
4. 「自定义」更名为「AI指令」，紧跟「问AI」；默认组命名「快捷指令」。

## 3. 数据模型（迁移 v86 → v87）

新增 `prompt_groups`：

```sql
CREATE TABLE prompt_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  builtin_code TEXT UNIQUE,              -- 'quick' / 'translate'
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

`prompt_templates` 增加 `group_id INTEGER`（不用外键，删除组时由 DAO 迁移模板）。

迁移内置数据：

| 分组 | builtin_code | sort_order | 包含模板 |
|------|--------------|-----------|----------|
| 快捷指令 | `quick` | 10 | continue / summarize / rewrite / expand / shorten + 用户自建 |
| 翻译 | `translate` | 20 | translate_en / translate_zh |

- 用户自建模板默认进入「快捷指令」组。
- 组内 `sort_order` 复用 `prompt_templates.sort_order`，新增时取同组 `max + 10`。
- 快捷框渲染顺序：组 `sort_order ASC` → 模板 `sort_order ASC, id ASC`。

## 4. 后端接口

| 命令 | 说明 |
|------|------|
| `list_prompt_groups` | 组列表（按 sort_order） |
| `create_prompt_group(name)` | 新建自定义组，排到末尾 |
| `update_prompt_group(id, name)` | 改名（内置组也允许改名，`builtin_code` 不变） |
| `delete_prompt_group(id)` | 删除自定义组，组内模板迁回「快捷指令」；内置组禁止删除 |
| `reorder_prompt_groups(ids)` | 组排序，事务批量写 sort_order |
| `reorder_prompts(group_id, ids)` | 组内模板排序，事务批量写 sort_order |

`PromptTemplateInput` 增加 `group_id: Option<i64>`；新建缺省默认组，更新时可移动分组（sort_order 落到目标组末尾）。

## 5. 划词快捷框

布局：`格式按钮组 | 🤖 问AI | ✎ AI指令 | 分隔线 | 各分组下拉…`

- 每个组一个 Ant Design `Dropdown`，按钮文案为组名，菜单项执行 `handlePrompt`。
- 空组不渲染；无 `group_id` 的模板兜底并入「快捷指令」。
- 「AI指令」保持原自定义 Popover（指令输入 + AI 建议），位置移到问AI之后。
- 每次选区弹出时重新拉取分组与模板，保证管理页排序即时生效。

## 6. 溢出修复

- 测量浮条实际宽高后：`left = clamp(x, 8, viewportW - width - 8)`。
- 下方空间不足时翻转到选区上方：`top = anchorTop - height - 4`。
- 仍保留 `maxWidth: min(720px, 100vw - 24px)` + 条内横向滚动兜底。

## 7. 管理页

- 按组渲染卡片：组头（拖拽手柄、组名/改名、条数、新建到本组、删除）+ 组内表格。
- 分组使用 `@dnd-kit/sortable` 拖拽排序；组内使用表格「顺序」列的上下箭头排序
  （避免行级拖拽与编辑/开关/右键菜单操作冲突），两者都调用 reorder 接口事务保存。
- 新建/编辑弹窗增加「所属分组」选择。
- 内置组不可删除；自定义组删除后模板回落到「快捷指令」。

## 8. 边界

- 旧库升级后全部自动归组，行为等价于旧版折叠一层。
- 组重名允许（以 id 区分）。
- 排序接口校验 ids 属于同一组，防止跨组脏写。

## 9. 验收

1. 1024/1280 宽度、选区在行首/行尾时浮条完整可见；下方不足时上翻。
2. 快捷框只显示：格式、问AI、AI指令、各组下拉。
3. 管理页调整组/组内顺序后，重新选中文字顺序一致。
4. 新建组、改名、删除组、移动模板均正常。
5. 旧数据库 v86 升级后内置模板分组正确。

## 10. 实施清单

- [x] 方案文档落盘
- [x] v86 → v87 迁移
- [x] 后端模型 / DAO / Commands / 注册
- [x] 前端类型与 API 封装
- [x] 划词快捷框改造 + 溢出修复
- [x] 管理页分组与排序
- [x] `cargo check` / `tsc --noEmit` 校验
