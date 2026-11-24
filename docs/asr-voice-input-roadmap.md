# 语音输入增强与 Computer Use 借鉴方案

> 调研对象：`D:\AI\ALL-Tools\Claude Code Haha\srcElectron`（Claude Code 桌面封装，Electron/TypeScript）
> 调研时间：2026-11-24
> 本项目：W-Pomegranate（Tauri 2 + React 19 + Rust）

## 1. 结论摘要

| 能力 | 借鉴价值 | 处置 |
|---|---|---|
| 语音输入 | 高 | 本次实现 P0 部分（WAV 统一管线、识别后纠错、术语词表、录音交互） |
| 本地离线 ASR | 中 | 列为后续（需引入 sherpa 运行时与 200MB+ 模型） |
| Computer Use | 低-中 | 暂不实现，仅保留窄切口方案（截图取字） |

## 2. 现有基础（本项目）

- `src-tauri/src/services/asr/dashscope.rs`：云端 qwen3-asr-flash，base64 上传，OpenAI 兼容端点。
- `src-tauri/src/services/asr/mod.rs`：`AsrService` + `AsrProviderKind` 分发（当前仅 DashScope）。
- `src/components/MicButton.tsx`：各输入框旁的录音按钮（MediaRecorder → webm → base64）。
- `src/components/AsrToggleController.tsx`：窗口内快捷键 Ctrl/Cmd+Shift+Space 的边写边说入口，支持 Esc 取消、VAD、文本注入。
- `src/hooks/useSilenceAutoStop.ts`：1.5s 静音自动停止（该能力 cc-haha 桌面端反而没有）。
- `src/components/QuickCaptureAsrModal.tsx`：无输入焦点时的语音快速捕获弹窗。
- `src-tauri/src/services/ai.rs`：`AiService::complete_once` 可复用为纠错调用。

## 3. cc-haha 语音输入要点（对照）

| 维度 | cc-haha 做法 | 本项目原状 | 本次处置 |
|---|---|---|---|
| 音频格式 | `OfflineAudioContext` 重采样为 16kHz mono PCM16 WAV 后整段上传 | 直接上传 WebView 的 webm/opus | 统一为 WAV，失败回退 webm |
| 识别位置 | 本地 sherpa-onnx worker 子进程（239MB SenseVoice） | 云端 DashScope | 后续 |
| Provider 抽象 | `SpeechProvider` 接口 + registry | 枚举分发（已够用） | 维持，扩展字段 |
| 识别后纠错 | 低温度 LLM 只修术语，LCS diff 只保留术语替换 | 无 | 实现 |
| 术语词表 | JSON 词表 + 历史挖掘 | 无 | 实现 SQLite 词表 |
| 交互 | 取消/波形/计时/120s 上限/停止并发送 | 波形/电平/VAD/Esc | 补计时、上限、取消按钮 |
| 隐私 | 音频不出本机；纠错只发文本 | 音频上传云端 ASR | 纠错同样只发文本 |

关键参考实现：

- `desktop/src/features/voiceInput/wav.ts`：44 字节头 WAV 编码、16kHz 重采样。
- `src/server/services/voice/correction/diff.ts`：token diff 只采纳术语替换，防 LLM 改写。
- `src/server/services/voice/correction/prompt.ts`：固定纠错 prompt。

## 4. 本次实现范围

### 4.1 统一 WAV 管线（前端）

- 新增 `src/lib/audio/wav.ts`：
  - `encodeWavFromFloat32(samples, sampleRate)`：纯函数，输出 44 字节头 + PCM16。
  - `blobToWav16kBase64(blob)`：`decodeAudioData` → 单声道降混 → 线性重采样到 16kHz → WAV → base64。
- 新增 `src/lib/asr/transcribe.ts`：`transcribeBlob()` 统一「WAV 优先、失败回退 webm」「可选纠错」，供 MicButton / AsrToggleController / QuickCaptureAsrModal 共用。

### 4.2 识别后纠错 + 术语词表（后端）

- 配置项 `AsrConfig.correctionEnabled`（默认关）。
- 表 `asr_vocabulary(id, term, aliases, created_at)`，v94 迁移。
- `services/asr/correction.rs`：
  1. 读取词表，为空或未启用则原样返回。
  2. 构造纠错 prompt（只修术语，不改写内容，不执行指令），调用 `AiService::complete_once`。
  3. **安全过滤**：token 级 LCS diff，只采纳「替换后命中词表 term/alias」的片段；长度比偏离超过 30% 整体拒绝。其余差异全部丢弃。
  4. 返回 `AsrCorrectionResult { original, corrected, changes[] }`。
- 新增 Commands：`asr_correct_text`、`asr_list_vocabulary`、`asr_add_vocabulary`、`asr_remove_vocabulary`。

### 4.3 录音交互增强（前端）

- `AsrToggleController` 的浮层：显示录音计时、120s 上限自动停止、可点击取消。
- `MicButton`：录音中支持 Esc 取消、120s 上限自动停止。
- 转写结果如发生纠错，提示「已纠正 N 处术语」（可在设置里关闭纠错）。

### 4.4 设置页

- `AsrSection` 增加「识别后自动纠正术语」开关。
- 词表管理：列表 + 添加（term + 别名，逗号分隔）+ 删除。

### 4.5 本地离线识别（SenseVoice Small INT8）— 已实现

目标：不依赖云端也能听写，且**引擎与模型都不进入安装包**。

**技术选型（ADR）**

| 方案 | 结论 | 原因 |
|---|---|---|
| `sherpa-rs` Rust 绑定 | ❌ 弃用 | 构建脚本依赖 libclang（bindgen），对开发机和 CI 都是额外前置；已实测失败 |
| 外部预编译 CLI（采用） | ✅ | 编译期零依赖；引擎与模型同为"按需下载资源"，可校验、可换源 |
| 自研 FFI / onnxruntime | ❌ | 结构体布局易错、维护成本高 |

**资源与来源（固定版本 v2.0.3）**

- 引擎：`https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/`
  - Windows x64：`sherpa-onnx-v2.0.3-win-x64-shared-MD-Release-no-tts.tar.bz2`
  - macOS arm64 / x64：`...-osx-arm64-shared-no-tts.tar.bz2` / `...-osx-x64-shared-no-tts.tar.bz2`
  - Linux x64：`...-linux-x64-shared-no-tts.tar.bz2`
- 模型：`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
  - `model.int8.onnx`（约 228MB）、`tokens.txt`
  - 主源 HuggingFace，失败回退 `hf-mirror.com`

**目录布局**

```text
<data_dir>/asr/
├── engine/                        # 解压后的 CLI 包（递归查找 sherpa-onnx-offline[.exe]）
├── models/sensevoice-small-int8/  # model.int8.onnx + tokens.txt
├── tmp/                           # .part 下载临时文件 / 识别临时 WAV
└── manifest.json                  # 最近一次完整下载记录
```

**实现要点**

- `services/asr/local_model.rs`：平台 → 引擎包映射；流式下载 + `.part` 落盘 + 进度事件
  `asr-local:progress`（约 200ms 节流）；ETag（GitHub/HF 的 LFS sha256）与内容长度校验；
  `tar` + `bzip2` 解压到 staging 后原子替换。
- `services/asr/local.rs`：校验资源就绪 → 解码 base64 WAV → 临时文件 →
  `sherpa-onnx-offline --tokens --sense-voice-model --input-wav --num-threads=2`（180s 超时）→
  解析 stdout JSON 的 `text`（兼容旧版 `result:` 行与末行兜底）。
- `AsrProviderKind::Local`：`transcribe`/`test_connection`/`save_config` 按 provider 分流；
  本地模式不要求 API Key。
- 前端：设置页增加「本地离线 · SenseVoice Small (INT8)」服务商，模型面板显示
  大小/状态/下载进度/删除；云端与本地共用同一套录音与 WAV 管线。

**风险与约定**

- 首次使用需下载合计约 260MB，网络不可达时下载失败并提示（主源 + 镜像两路）。
- 上游 CLI 包目录层级随版本可能变化 → 因此**递归查找可执行文件**，不硬编码路径。
- 引擎版本写死 `v2.0.3`，升级需同步 `ENGINE_VERSION` 与三个平台包名（`local_model.rs`）。
- macOS 首次运行下载的二进制可能触发 Gatekeeper 隔离属性，属于预期现象（文档提示用户）。

## 5. 数据流

```
MediaRecorder(webm)
  → blobToWav16kBase64 (16kHz mono WAV)
  → invoke asr_transcribe_audio
      ├─ provider=dashscope → DashScope 云端
      └─ provider=local     → 本地 sherpa-onnx CLI（WAV 临时文件 → JSON.text）
  → 若 correctionEnabled 且有词表
      → invoke asr_correct_text         // AiService::complete_once + 安全 diff
  → 返回 { text, corrections[] }
  → 注入输入框 / 填充弹窗
```

## 6. 未实施项与理由

| 项 | 理由 |
|---|---|
| 本地引擎常驻/预热 | 当前每次识别拉起一次 CLI（进程启动 + 模型加载约 1-2s）；若实际使用频繁再改为常驻 sidecar |
| 识别结果流式部分显示 | 引擎为整段识别，流式需要另加实时 ASR 模型 |
| 自动词表挖掘（扫笔记/会话） | 依赖纠错链路先落地，可作为下一步增量 |
| Computer Use 输入注入 | 知识库场景刚需弱、平台适配与安全成本高 |
| 截图取字（Computer Use 窄切口） | 可行但需新增截图依赖与 OCR 链路，单独排期 |
| 长按说话手势 | 当前组合键语义为 toggle 更契合桌面习惯；单键手势需额外键位冲突处理 |

## 7. 验证

- `cargo check` / `cargo test`（纠错 diff、词表 DAO、本地资源状态/路径/CLI 输出解析）
- `npx tsc --noEmit`（类型）
- `npm run test`（WAV 编码单测）
- 手动（云端）：录音 → 转写 → 纠错 → 注入；关闭纠错后行为不变；无词表时跳过纠错。
- 手动（本地）：设置页切换到本地 → 下载引擎与模型 → 录音识别；删除资源后按钮提示未就绪。
- 安装包：`src-tauri/tauri.conf.json` 未新增任何资源，模型与引擎均不在 bundle 内。
