# AI 助手增强方案

> 创建：2026-11-24
> 参照：knowledge-base v3.x AI 相关提交（`1df0be6` 置顶、`c850637` 克隆/存为笔记/分叉、`e1f447d` 提问导航、`3479f6c` 自动续写、`2dca28e` 工具轮次、`13854db` 鉴权提示、`134e4f7` 删除确认）
> 本仓基线：schema 92；AI 相关代码在 `services/ai.rs`、`database/ai.rs`、`commands/ai.rs`、`components/ai/`、`pages/ai/`
> 关联：`remaining-improvements-plan.md` §2.A

## 1. 目标

在不改变现有「模型服务 / 会话 / 消息」数据结构的前提下，补齐高频会话操作与生成可靠性：

1. 会话置顶、克隆、存为笔记、从回答分叉。
2. 右侧提问导航 + Alt+↑/↓ 跳转。
3. 回答因长度上限截断时自动续写。
4. 工具轮次用满时不再因消息结构触发部分模型 500。
5. 模型服务错误提示与删除确认更准确。

## 2. 现状与差距

| 项 | 本仓 | KB |
|----|------|----|
| 会话置顶 | `ai_conversations` 无 `is_pinned` | schema v70 加列 + 排序 |
| 克隆会话 | 无 | 复制会话与消息 |
| 存为笔记 | 无 | 会话内容落成笔记 |
| 从回答分叉 | 无 | 复制到指定消息为新会话 |
| 提问导航 | 无 | `AskNav` 贴在消息区右边缘；`data-ask-id` 定位 |
| Alt+↑/↓ | 无 | 上/下一条提问 |
| 截断自动续写 | 无（只有写作提示词的「续写」） | `finish_reason=length` 时最多续写 3 次 |
| 工具轮次 system 合并 | 未见 | 轮次用满时并入首条，修 Jan/Qwen3 500 |
| 鉴权错误提示 | 统一「密钥无效或已过期」 | 按 401/403/模型不存在细分 |
| 删除模型确认 | 无「对话会一并删除」提示 | 有 |

## 3. 设计

### 3.1 数据层

**schema（当前 92，实施时取最新 +1）**

```sql
ALTER TABLE ai_conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ai_conv_pinned
  ON ai_conversations(is_pinned DESC, updated_at DESC);
```

- 迁移幂等：先检查列是否存在。
- 不新增表；克隆/分叉复用 `ai_conversations` + `ai_messages`。

**database/ai.rs**

- `list_ai_conversations`：`ORDER BY is_pinned DESC, updated_at DESC`
- `set_ai_conversation_pinned(id, bool)`
- `clone_ai_conversation(id, title?)`：事务内复制会话 + 全部消息，返回新 id
- `fork_ai_conversation(id, up_to_message_id)`：复制到指定消息（含）为止
- `delete_ai_model` 返回受影响会话数或在命令层先查

### 3.2 命令层（commands/ai.rs）

- `pin_ai_conversation(id, pinned)`
- `clone_ai_conversation(id)`
- `fork_ai_conversation(id, up_to_message_id)`
- `save_ai_conversation_as_note(id)`：标题 + Markdown 正文，调用现有笔记创建服务
- 全部注册到 `lib.rs`；返回 `Result<T, String>`

### 3.3 生成可靠性（services/ai.rs）

**自动续写**

- 流式结束读取 `finish_reason`；为 `length` 且未达上限时自动追加一轮：
  原请求消息 + 已输出正文（assistant）+ 「请接着写，不要重复已有内容」（user）
- 最多 3 次（总长度最多为单次上限约 4 倍）；用户手动停止/取消立即终止
- UI：续写期间显示「继续生成…」，不产生额外会话消息

**工具轮次 system 合并**

- 当 `round == max_tool_rounds` 时，把 system 提示并入首条 user 消息再发最后一次请求，
  避免部分模型（Jan/Qwen3）对「system 只允许出现在首条」直接 500
- 逻辑集中在 `build_tool_round_messages()`，加单测

**鉴权错误**

- 401/403 区分：密钥无效、权限不足、模型不可用；错误文案带服务商名
- 不暴露请求头/密钥

### 3.4 前端

**pages/ai/index.tsx**

- 会话列表项：置顶图标；右键菜单「置顶 / 取消置顶、克隆、存为笔记、复制 Markdown」
- 消息区：每条回答右上角「从这里分叉」
- `AskNav` 组件：右边缘细线，一条 = 一次提问；点击滚动定位；悬停显示摘要
- Alt+↑/↓ 跳上/下一条提问（输入框聚焦时不拦截）
- 会话列表按「置顶 / 今天 / 更早」分组
- 删除模型确认框注明「其下对话会一并删除」

**移动端**：置顶/克隆先复用桌面命令；提问导航在移动端仅保留上下按钮（视排期）。

## 4. 文件清单

| 层 | 文件 |
|----|------|
| schema | `src-tauri/src/database/schema.rs` |
| DB | `src-tauri/src/database/ai.rs` |
| 服务 | `src-tauri/src/services/ai.rs` |
| 命令 | `src-tauri/src/commands/ai.rs`、`lib.rs` |
| 类型/API | `src/types/index.ts`、`src/lib/api/index.ts` |
| 前端 | `src/pages/ai/index.tsx`、`src/components/ai/AskNav.tsx`、会话列表组件 |
| 移动端 | `src/pages/ai/MobileAi.tsx`（按需） |

## 5. 阶段与验收

| 阶段 | 内容 | 验收 |
|------|------|------|
| A1 | schema 置顶 + 列表排序 + 右键置顶 | 重启保持；排序正确 |
| A2 | 克隆 / 分叉 / 存为笔记 / 复制 Markdown | 消息条数与顺序一致；笔记内容可编辑 |
| A3 | AskNav + Alt+↑/↓ | 长会话定位准确；输入框内不误触 |
| A4 | 自动续写 | 截断回答继续；手动停止生效；上限 3 次 |
| A5 | 工具轮次合并 + 鉴权提示 + 删除确认 | 对应模型不再 500；错误文案可操作 |

**测试**

- DB：置顶排序、克隆/分叉事务、删除级联。
- 服务：finish_reason 解析、续写消息构造、工具轮次消息构造（单测，不真实请求）。
- 前端：`pnpm test`、`tsc`、`build`；手工长会话验证。

## 6. 风险

| 风险 | 应对 |
|------|------|
| 自动续写烧 token | 次数上限 + 用户可停止 + 设置项（可选关闭） |
| 克隆大会话占用磁盘 | 只在用户显式操作时复制；无后台自动克隆 |
| 分叉后消息 id 冲突 | 新会话重新生成自增 id，保留原 created_at |
| schema 冲突 | 与其它批次约定版本号，实施时以当前 SCHEMA_VERSION+1 为准 |
