# PPT 扩展包（Engine Pack）设计与使用

> 目标：让主程序在不内置 Python / 不增大安装包的前提下，通过本地 zip 安装可选的 PPT 生成能力。

## 1. 架构

```
主程序（始终存在）
├── React /ppt           文档选择、模板选择、进度、结果
├── React /extensions    扩展包安装、启停、完整性校验
└── Rust
    ├── ExtensionService        zip 预检 / 安装 / 卸载 / 哈希
    ├── ExtensionRunner         受控子进程 + JSONL 事件
    ├── PptExtensionService     多文档收集 / AI 规划 / 作业状态
    └── Database v81            extensions / extension_versions / ppt_jobs

扩展包（按需安装，本地 zip）
└── ppt-master/
    ├── extension.json
    ├── entry.py               Python Executor
    ├── templates/layouts/     方案 A：版式模板
    ├── templates/charts/      图表模板
    ├── ppt-master/            可选：上游脚本（svg_to_pptx 等）
    └── runtime/python/        可选：内嵌 Python
```

未安装扩展时：不注册入口、不创建进程、不写作业目录，主程序行为与安装前一致。

## 2. 数据目录

```
<app_data>/
├── extensions/
│   ├── ppt-master/
│   │   ├── current.json
│   │   └── versions/1.0.0/
│   └── .tmp-<uuid>/          安装临时目录，成功/失败后清理
└── ppt-workspace/
    └── <jobId>/
        ├── job.json
        ├── plan.json
        ├── input/source.md
        ├── input/source_manifest.json
        ├── project/
        │   ├── design_spec.md
        │   ├── spec_lock.md
        │   ├── slide_plan.json
        │   ├── svg_output/
        │   ├── notes/total.md
        │   └── exports/
        ├── output/*.pptx
        └── logs/
```

中间文件默认保留，便于排查与重跑；导出目录只做复制，不移动工程。

## 3. 扩展包清单

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "protocolVersion": 1,
  "id": "ppt-master",
  "name": "PPT Master 生成引擎",
  "version": "1.2.1",
  "kind": "ppt-engine",
  "minAppVersion": "2.1.0",
  "platforms": ["windows-x86_64"],
  "runtime": {
    "type": "python-embedded",
    "entry": "entry.py",
    "protocol": "jsonl-stdio",
    "python": { "min": "3.8", "max": "3.13", "path": "runtime/python/python.exe" }
  },
  "permissions": ["docs:read-selected", "fs:write-job", "process:spawn"],
  "contributes": {
    "ppt": {
      "layoutsIndex": "templates/layouts/layouts_index.json",
      "chartsIndex": "templates/charts/charts_index.json"
    }
  }
}
```

安装预检会校验：id、版本、应用版本、平台、入口文件、Python 路径、文件数、解压体积、路径穿越、内容哈希。

## 4. 生成流程（五阶段，已实现）

```
素材与设置 → 风格确认 → 大纲确认 → 草稿修改 → 最终导出
```

### 4.1 流程

```
前端选择多个文档 / 日记 / 挂载文件
  → AI 根据素材标题/摘要建议 PPT 标题与汇报对象（手动修改后不覆盖）
  → 风格确认：版式封面预览、中文名称/说明、图表与原生图表开关
  → 点击“生成大纲”：
      Rust 收集正文（跳过加密笔记，按源截断并标记）
      → input/source.md + source_manifest.json
      → AI 生成 plan.json（指定页数时先出标题清单再逐页扩展；最多 2 次，失败则按标题降级；支持取消/超时）
  → 大纲确认：编辑 plan.json / job.json
  → 点击“生成草稿”：先在草稿页选择生成方式
      - 程序化（默认）：Rust 渲染 13 种页面结构，每页最多 3 个 motif 候选
      - 一次性：每页 1 次 AI 连续生成，失败修复 1 次
      - 多次：每页自适应 1–3 个 AI 候选 + LLM 评审
      → 逐页写入 project/svg_output/*.svg，并发送 draft-page 事件（AI 模式两页并发）
      → 程序化与 AI 候选都保存到 project/candidates/Pxx_1..3.svg
      → 不导出 PPTX；作业 stage = draft_ready
  → 草稿修改：逐页预览；程序化页可切换结构候选；支持单页重新生成
  → 点击“导出 PPTX”：
      job.json options.stage = "export"
      → entry.py 跳过渲染，对现有 svg_output 执行质量检查与导出
      → 主程序校验 output/*.pptx（zip 结构 + 路径越界）
      → 复制到用户导出目录；stage = done
```

### 4.2 阶段状态机

```text
stage: style → outline_ready → rendering_draft → draft_ready → exporting → done
status: ready | running | succeeded | failed | cancelled
```

| 阶段 | 行为 | 负责层 |
| --- | --- | --- |
| 素材与设置 | 选文档/本地文件，AI 建议标题与汇报对象 | React + Rust |
| 风格确认 | 版式封面预览、中文名称/说明、图表与原生图表开关 | React + 扩展 asset |
| 大纲确认 | 编辑 `plan.json`，调整页序/标题/要点 | React + Rust |
| 草稿修改 | 逐页预览；选择生成方式；程序化页可切换结构候选；可单页重新生成 | React + Rust + 引擎 |
| 最终导出 | 质量门禁 + `svg_to_pptx.py` / python-pptx | Rust + 引擎 |

- `ppt_jobs.stage` 持久化作业阶段；历史作业可“继续”到对应步骤。
- 大纲或版式变化会清空旧 `svg_output`，避免导出过期草稿。
- 重新渲染前引擎会先清理旧 SVG，防止删减页数后残留过期页面。
- 阶段前进复用：内容未变时直接返回已有大纲/草稿/导出结果；修改大纲或版式后自动重新渲染。
- 大纲阶段支持设置页数并“重新生成大纲”，复用 `input/source.md` 与标题/听众设置，只重跑 AI 规划。

引擎阶段参数：

```json
{
  "options": {
    "stage": "render"
  }
}
```

| stage | 行为 |
| --- | --- |
| `render` | 只写设计说明/大纲并生成 `svg_output/`，不导出 PPTX |
| `export` | 跳过渲染，对现有 `svg_output/` 执行质量检查与导出 |
| `full` | 保持一次性渲染+导出行为，兼容旧作业 |

草稿修改范围：

- 内容级编辑：标题、核心信息、要点、页序。
- 生成方式：程序化（默认）/ 一次性 / 多次，可在草稿页顶部切换。
- 程序化页与 AI 模式都保存最多 3 个页面候选，草稿页可点击缩略图切换。
- 支持单页重新生成；程序化模式不调用 AI 生成 SVG。
- 打开历史作业时从 `job.json` 恢复生成方式、原生图表开关与页数。
- 编辑 `plan.json` 后重新渲染草稿，再做最终导出。
- 不做 SVG 元素自由拖拽；该能力属于后续可视化编辑器阶段。

安全约束：

- 草稿页只允许读取 `<jobId>/project/svg_output/` 下的 `.svg` 文件名，拒绝路径穿越。
- 版式封面预览只允许读取扩展包 layouts 索引目录下的 `<layoutId>`。
- 草稿页与封面大小分别限制为 8 MB / 4 MB。

### 多文档

- 笔记：`noteApi.list` + `get`
- 日记：同笔记通道
- 挂载：`mountApi.entries` 返回的 `noteId` 作为影子笔记 id
- 单个来源最多 40,000 字符，总计最多 200,000 字符
- 加密笔记、空正文、抽取失败条目自动跳过
- `source.md` 中保留来源边界注释，`source_manifest.json` 记录来源清单

### 字段说明

| 字段 | 必填 | 用途 |
| --- | --- | --- |
| PPT 标题 | 是 | AI 规划主题；任务名称；导出文件名；`design_spec.md` 标题 |
| 汇报对象 | 否 | 告诉 AI 讲给谁听，影响内容深度、语气、案例与页面组织；写入设计说明与 `spec_lock.md` |
| 版式模板 | 否 | 按页型选择 cover/chapter/content/ending 等 SVG 骨架，并填充占位符；资源复制到 `templates/layout_<id>/` |
| 图表模板 | 否 | 选择 33 种可视化模板（中文名称 + 适用说明）；读取其类型与配色，将数据绘制为可编辑 SVG 片段嵌入内容区域 |
| 页数 | 否 | 可指定 1–40 页；指定 ≥3 页时启用两阶段页级大纲，否则由 AI 根据素材决定 |
| 导出目录 | 否 | 选择后复制最终 PPTX；最近一次选择会自动记住 |

### 进度与交互

- 生成过程通过 `ppt-extension://log` 流式推送：素材收集、AI 规划、作业创建、引擎渲染、质量检查、导出。
- 大纲阶段发送 `plan-progress`（理解/规划/校验/修复、当前块或页）。
- 草稿阶段发送 `draft-page`（页号、状态、分数、候选数），前端逐页加入草稿列表。
- 引擎的 JSONL 事件会在界面中解析为可读进度与日志，不再显示原始 JSON。
- 支持取消：Windows 下会终止整个扩展进程树。
- 已支持风格确认、大纲确认、草稿预览/修改、候选切换和导出前确认。
- 草稿阶段只渲染 `svg_output`，最终导出阶段复用现有草稿，二者分两次引擎运行。
- 作业事件同时携带 `stage`，前端据此切换步骤。

### 中间文件

| 文件 | 作用 |
| --- | --- |
| `design_spec.md` | 人类可读设计说明 |
| `spec_lock.md` | 机器可执行契约（配色/字体/页面） |
| `slide_plan.json` | 页面大纲 |
| `input/understanding.md` | 素材分块理解结果 |
| `svg_output/` | 渲染出的页面 |
| `candidates/` | 程序化与 AI 模式的页面候选（`Pxx_1..3.svg`） |
| `page_selection.json` | 每页评分、候选文件、选中索引 |
| `images/` / `assets/` | 从版式复制的图片等外部资源（供 SVG 引用） |
| `notes/total.md` | 讲稿 |
| `exports/` | 上游引擎导出的原始 pptx |

主程序“生成详情”会展示工程目录、PPT 路径，并支持打开工程目录。

## 5. 命令清单

| Command | 说明 |
| --- | --- |
| `extension_list` | 已安装扩展包 |
| `extension_inspect_zip` | 预检 zip |
| `extension_install_zip` | 安装 zip |
| `extension_enable` / `disable` | 启停 |
| `extension_uninstall` | 卸载 |
| `extension_verify` | 内容哈希校验 |
| `extension_ppt_catalog` | 读取 layouts/charts 索引与 `layoutSupport` |
| `extension_ppt_layout_preview` | 读取版式首张封面 SVG（风格确认预览） |
| `extension_list_versions` | 列出已安装版本 |
| `extension_rollback` | 切换到已安装的旧版本 |
| `ppt_extension_status` | 扩展状态、平台兼容性与 Win7 提示 |
| `ppt_extension_suggest_meta` | 根据素材标题/摘要建议 PPT 标题与汇报对象 |
| `ppt_extension_create_job` | 收集文档、生成 plan、创建作业 |
| `ppt_extension_cancel_planning` | 取消大纲规划 |
| `ppt_extension_get_plan` | 读取作业大纲 |
| `ppt_extension_update_plan` | 更新作业大纲 |
| `ppt_extension_validate_plan` | 校验并规范化大纲 |
| `ppt_extension_regenerate_plan` | 复用素材与设置重新生成大纲（可指定页数/模型） |
| `ppt_extension_start_job` | 启动扩展进程（兼容旧的一次性流程） |
| `ppt_extension_render_draft` | 生成草稿，只写 `svg_output/` |
| `ppt_extension_render_ai_draft` | 按模式生成草稿（programmatic / oneShot / bestOf） |
| `ppt_extension_regenerate_ai_page` | 单页重新生成（可选模型） |
| `ppt_extension_job_options` | 读取作业渲染选项（生成方式/原生图表/页数），并回显标题、版式与图表模板 |
| `ppt_extension_source_file` | 返回作业固化素材 `input/source.md` 的绝对路径 |
| `ppt_extension_page_selection` | 读取每页评分、候选与选中索引 |
| `ppt_extension_page_candidates` | 读取程序化或 AI 页面候选 SVG |
| `ppt_extension_select_page_candidate` | 手动切换页面候选 |
| `ppt_extension_rerender_draft` | 修改大纲/选项后重新生成草稿 |
| `ppt_extension_export_draft` | 对现有草稿执行质量门禁并导出 PPTX |
| `ppt_extension_list_draft_pages` | 列出草稿页面 |
| `ppt_extension_read_draft_page` | 读取单页草稿 SVG |
| `ppt_extension_cancel_job` | 取消（Windows 杀进程树） |
| `ppt_extension_get_job` | 查询作业 |
| `ppt_extension_list_jobs` | 历史作业 |
| `ppt_extension_retry_job` | 复用原素材/大纲重试 |
| `ppt_extension_delete_job` | 删除单个作业 |
| `ppt_extension_cleanup_jobs` | 清理旧作业目录 |
| `ppt_extension_export_diagnostics` | 导出诊断 zip |

事件：

- `ppt-extension://log` `{ jobId, stream, line }`
- `ppt-extension://plan-progress` `{ jobId, stage, current, total, message }`
- `ppt-extension://draft-page` `{ jobId, page, total, status, score, candidateCount, issues }`
- `ppt-extension://job` `{ jobId, status, stage, job }`
- `ppt-extension://done` / `ppt-extension://error` `{ jobId, status, stage, job }`

## 6. 构建扩展包

```bash
# 仅内置 Executor（使用系统 Python）
node scripts/build-ppt-extension.mjs

# 带上游 ppt-master 脚本与模板
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/path/to/ppt-master"

# 带内嵌 Python（目录需包含 python.exe）
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/path/to/ppt-master" \
  --python-runtime "D:/path/to/python-embed"

# 可选：Ed25519 签名（构建日志会输出 base64 公钥）
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/path/to/ppt-master" \
  --signing-key "D:/keys/extension-private.pem"
```

输出：`src-tauri/target/release/bundle/nsis/ppt-master-extension-<version>-win7-x64.zip`

可选参数：

- `--layouts-dir <dir>`：只打包指定目录下的版式（例如 `test-data/ppt-templates/system/layouts`）。
- `--version <ver>`：覆盖 `extension.json` 中的版本号，便于构建测试包。
- `--out <dir>`：覆盖输出目录。

签名包安装前，主程序需要配置 `PPT_EXTENSION_PUBLIC_KEY`（base64 32 字节公钥）；\
未配置时会拒绝安装带签名的包。未签名包不受影响。

构建脚本会：

- 复制 `extensions/ppt-master/` 源码
- 复制上游 `skills/ppt-master/scripts` 与 `templates/layouts|charts`；若上游只有 `templates-old/charts`，自动作为图表模板回退
- 复制 `LICENSE` / `SPONSORS.md` / `SPONSORS_CN.md` / `SKILL.md`（`svg_to_pptx.py` 会校验归属文件，缺一不可）
- 可选复制内嵌 Python，并改写 `runtime.python.path`
- 生成 `checksums.json`
- 使用 PowerShell `Compress-Archive` 打包 zip

Lite 包（不带 Python）运行前需保证系统 Python 已安装 `python-pptx`；带上游 scripts 时，导出优先走 `svg_to_pptx.py`，并自动执行 `svg_quality_checker.py` 的质量门禁。质量门禁未通过时回退到内置 `python-pptx` 导出。

## 7. Win7 与 Python

- Executor 已按 Python 3.8+ 语法兼容编写（使用 `from __future__ import annotations`），并有 AST 兼容测试。
- 官方 CPython 3.10+ 不支持 Win7；若必须在 Win7 上运行，需要：
  1. 使用可在 Win7 运行的内嵌 Python 构建；或
  2. 使用 Python 3.8.10 并保持 Executor 语法兼容；或
  3. 在 Win7 上暂不启用 PPT 生成。
- `ppt_extension_status` 会返回 `win7`、`platformCompatible`、`embeddedPython`，前端据此展示兼容性警告。
- 内嵌 Python 目录至少包含：`python.exe`、`python3xx.dll`、`Lib/`、`site-packages/`。
- 建议同时附带 VC/UCRT 运行库，避免目标机缺少依赖。
- 所有子进程均使用 `CREATE_NO_WINDOW`，打包后不会弹黑窗。

## 8. 安全约束

- 仅本地 zip 导入，不做在线下载。
- 安装前预检并展示权限；兼容性不通过不允许安装。
- zip 解压拒绝绝对路径、`..`、符号链接、超大体积/文件数。
- 扩展包目录只读；运行写入限制在 `<jobId>/`。
- 只执行清单声明的固定入口，不接受用户传入脚本路径。
- 作业超时默认 900 秒；取消时杀进程树。
- 输出只接受 `output/` 下的 `.pptx`。
- AI 密钥始终留在主程序，扩展只拿到 `plan.json`。

## 9. 验收清单

- [ ] 未安装扩展：应用正常启动，无 PPT 入口，无新进程

- [ ] 安装 zip：预检通过后安装成功，入口出现

- [ ] 禁用/卸载：入口消失，进程不再可启动

- [ ] 多文档：至少 2 个文档 + 1 个挂载文件生成成功

- [ ] 中间文件：工程目录包含 design_spec/spec_lock/slide_plan/svg_output

- [ ] 风格确认：版式卡片显示封面预览与中文说明

- [ ] 草稿阶段：生成 svg_output 但不产生 pptx，stage=draft_ready

- [ ] 草稿模式：程序化/一次性/多次可切换，程序化不调用页级 AI

- [ ] 程序化候选：每页最多 3 个结构候选，可点击切换并同步预览

- [ ] 大纲进度：理解/规划/校验/修复阶段有 `plan-progress` 事件

- [ ] 草稿进度：逐页出现草稿图，`draft-page` 事件携带页号与分数

- [ ] 草稿修改：编辑内容/页序后重新生成，预览同步刷新

- [ ] 历史续作：按 stage 恢复到草稿/导出步骤

- [ ] 导出：选择目录后 pptx 复制成功，stage=done

- [ ] 取消/超时：状态正确，进程被终止

- [ ] 损坏包/缺 Python：给出明确错误

- [ ] Win7 目标环境验证（或明确标记不支持）

## 10. 已知限制

- 模板方案 A：仅 layouts + charts，不支持 brand/deck/融合。
- 支持 `{{PLACEHOLDER}}` 与 `data-pptx-placeholder` 两类 layout；未标注的复杂模板会回退内置渲染器。
- 默认使用 SVG 矢量图表；开启原生图表后，图表页使用 python-pptx 原生图表（沿用模板调色板、图例、数据标签与网格线），但不叠加版式 SVG。
- Executor 是内置的确定性渲染器，不包含 ppt-master 的 Agent 规划能力。
- 扩展包签名可选；未签名包仍依赖哈希与本地来源信任。
- 不支持在线更新，升级需重新导入 zip；已支持版本回滚。
- 草稿修改只做内容级编辑（标题/核心信息/要点/页序），不做 SVG 元素拖拽。
- 支持单页重新生成；程序化模式支持切换结构候选。
- 程序化渲染为 14 种页面结构（含图表页）的精简实现，不是上游 12 layout × 15 motif 的全量体系。
- 程序化与 AI 模式的候选缩略图都保留最多 3 个；AI 草稿按两页并发，跨页去重使用视觉签名集合。
- 风格预览使用版式首张封面 SVG；复杂模板的外部字体/图片在 WebView 预览中可能缺失。