所有任务完成。以下是改动总结：

---

## 改动总结

**文件**: `desktop/electron/services/node16Server.ts` (1404 → 2763 行)

### 任务 1: Bug Fix
- 删除 `message_complete` 后的 `status:idle`（成功和错误路径各1处）
- 与 Bun 服务端行为一致

### 任务 2: 流式响应
- 新增 `httpStreamRequest` — SSE 流式请求，解析 `event:` / `data:` 格式
- 新增 `streamAnthropic` — POST `/v1/messages` + `stream: true`
- 新增 `streamOpenAi` — POST `/v1/chat/completions` + `stream: true`
- 保留 `generateAssistantReplyNonStreaming` 作为 fallback
- `generateAssistantReply` 重构为流式优先，解析 content blocks（text + tool_use）

### 任务 3: Tool 定义与执行（13 个工具）

| 工具 | 实现 |
|------|------|
| **Read** | `fs.readFileSync` + 行号分页 |
| **Write** | 原子写入（tmp + rename） |
| **Edit** | `String.indexOf` 唯一性检查 + 替换 |
| **Bash** | `child_process.execSync` + timeout |
| **Grep** | ripgrep 优先 + Node.js 回退 |
| **Glob** | `fs.readdirSync` 递归 + 简单 glob 匹配 |
| **WebFetch** | `http.get` 异步请求 |
| **WebSearch** | Stub（Win7 模式不可用） |
| **AskUserQuestion** | 返回问题文本 |
| **TaskCreate** | JSON 文件写入 |
| **TaskUpdate** | 读 → patch → 原子写入 |
| **TaskList** | 目录扫描 JSON 文件 |
| **TaskGet** | 读单个 JSON 文件 |

### 任务 4: Tool Loop
- `handleUserMessageWithTools` — 循环调用 API + 执行 tools
- 25 次迭代上限防无限循环
- `buildApiMessages` — Anthropic/OpenAI 双格式消息转换，兼容旧 string 和新 content block 格式

### 任务 5: 集成
- `handleClientWsMessage` 简化为调用 `handleUserMessageWithTools`
- TypeScript 编译通过 (`npx tsc --noEmit`)