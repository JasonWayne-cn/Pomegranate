# PPT 用户模板导入

> 状态：P0/P1 已实施  
> 决策日期：2026-11-02  
> 目标：用户在 PPT-Master 中生成模板后，可以不修改主程序、不重打扩展包，直接把模板导入 Pomegranate 并使用。

## 1. 范围

| 做 | 不做 |
|---|---|
| 用户在 PPT-Master 中生成模板 | 在应用内从 PPTX 生成模板 |
| 导入文件夹 / zip 到用户模板库 | 调用 AI 写 SVG |
| 解析 `design_spec.md` + SVG，自动建索引 | 运行上游 `pptx_template_import.py` |
| 模板库列出、预览、启停、删除、更新 | 依赖 Python |
| 导入后立即被 PPT 生成使用 | 修改 `ppt-master` 扩展包 |

模板是数据。导入功能随应用发布一次，之后新增模板只需拷贝文件或点击导入。

## 2. 导入契约

> 如何从零构建一个模板，见 [§14 用户模板构建指南](#14-用户模板构建指南)。

### 2.1 单 Layout 工作区

```text
my-template/
├── templates/
│   ├── design_spec.md
│   ├── 01_cover.svg
│   ├── 02_content.svg
│   └── ...
├── images/            # 可选
└── icons/imported/    # 可选
```

同时兼容：

- `design_spec.layout.<id>.md`（项目范围命名）
- 没有 `templates/` 子目录，SVG 直接放在根目录
- `kind: deck` 工作区（按 Layout 使用，界面标注来源）

### 2.2 模板库包

```text
pack/
├── layouts/
│   ├── aviation_training_blue/templates/...
│   └── ...
├── decks/              # 可选
└── layouts_index.json  # 可选，仅展示，不信任
```

### 2.3 必需与可选

| 文件 | 要求 | 缺失时 |
|---|---|---|
| 至少一个 `.svg` | 必需 | 拒绝导入 |
| `design_spec.md` | 推荐 | 允许导入，画布/页型从 SVG 推导 |
| frontmatter `layout_id`/`deck_id` | 推荐 | 用目录名或用户输入 |
| `summary` | 推荐 | 作为描述，可留空 |
| `page_types` | 可选 | 从文件名推导 |
| `images/` / `icons/` | 可选 | 保留并原样复制 |
| `exports/` | 忽略 | 不导入 |

默认保留模板自带图片；导入时可选择“仅导入矢量（丢弃图片）”。

## 3. 存储结构

```text
app_data/
├── extensions/                  # 现有引擎包，不修改
└── ppt-templates/
    ├── aviation_training_blue/
    │   ├── meta.json
    │   ├── design_spec.md
    │   ├── templates/
    │   │   ├── 01_cover.svg
    │   │   └── ...
    │   ├── images/
    │   └── icons/imported/
    └── my-other-template/
```

### meta.json

```json
{
  "schemaVersion": 1,
  "id": "aviation_training_blue",
  "displayName": "航空维修蓝",
  "description": "航空装备与系统培训课件结构",
  "sourceKind": "layout",
  "sourcePack": "aviation_training_blue.zip",
  "canvasFormat": "ppt169",
  "canvasWidth": 1280,
  "canvasHeight": 720,
  "pageCount": 11,
  "pageTypes": ["cover", "toc", "chapter", "content_1", "content_2", "ending"],
  "supportsStructured": true,
  "supportsLegacy": true,
  "coverFile": "01_cover.svg",
  "contentHash": "sha256:...",
  "importedAt": "2026-11-02T..."
}
```

运行时只依赖 `meta.json` 和 SVG；`design_spec.md` 原样保留。

## 4. 导入流程

```text
选择文件夹 / zip
      ↓
Inspect：解压到临时目录或扫描文件夹
      ↓
识别模板单元（一个或多个）
      ↓
校验 + 推导索引 + 检测冲突
      ↓
返回预览：名称、页数、页型、画布、封面、警告、冲突
      ↓
用户选择模板 + 冲突策略
      ↓
Install：复制到 .tmp-<uuid> → 校验 → 原子 rename
      ↓
写 DB + emit ppt-template://changed
```

核心函数：

```rust
inspect(path) -> Vec<TemplatePreview>
install(path, selections, conflict_policy) -> Vec<PptUserTemplate>
reconcile() -> ReconcileReport
```

启动时扫描 `app_data/ppt-templates/*/`：

- 有 `meta.json` → 对账 DB
- 无 `meta.json` 但有 SVG → 自动生成 meta 并注册
- DB 有行但目录不存在 → 标记 `missing`

## 5. 校验与安全

- zip：拒绝 `..`、绝对路径、盘符、symlink；限制文件数与解压体积。
- 文件夹：canonicalize，不跟随 symlink，只读。
- SVG：`quick-xml` 解析；拒绝 `<script>`、`<foreignObject>`、`on*`、外部 `href`、`javascript:`。
- 结构：至少一个 SVG；至少一页可读画布；页数上限；输出警告但不阻断。
- 安装：先写 `.tmp-<uuid>`，校验通过后原子 rename，避免半成品。

## 6. 索引推导

### 页型

与 `entry.py` 保持一致：去掉 `^\d+[a-z]?_` 前缀，转小写，空格换 `_`。

### 重复页型必须去重

`entry.py` 用 dict 按 page_type 存路径，重复会覆盖：

```text
01_cover.svg   → cover
02_content.svg → content_1
03_content.svg → content_2
04_content.svg → content_3
05_ending.svg  → ending
```

首次出现保留原名，后续追加 `_2`、`_3`，按文件名排序保证稳定。

### 画布与封面

- 画布优先取 `design_spec` frontmatter，否则取第一张 SVG。
- 封面优先 `cover` 页型，否则排序第一张。
- 内容哈希用于检测更新和完整性。

## 7. 数据模型

Schema v84：

```sql
CREATE TABLE IF NOT EXISTS ppt_user_templates (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  description       TEXT,
  dir_path          TEXT NOT NULL,
  source_kind       TEXT NOT NULL DEFAULT 'layout',
  source_pack       TEXT,
  canvas_format     TEXT NOT NULL DEFAULT 'ppt169',
  canvas_width      INTEGER NOT NULL DEFAULT 1280,
  canvas_height     INTEGER NOT NULL DEFAULT 720,
  page_count        INTEGER NOT NULL DEFAULT 0,
  page_types_json   TEXT NOT NULL DEFAULT '[]',
  supports_structured INTEGER NOT NULL DEFAULT 0,
  supports_legacy   INTEGER NOT NULL DEFAULT 0,
  cover_file        TEXT,
  content_hash      TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'ok',
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

文件系统是资产权威，DB 是索引。

## 8. Commands

| Command | 作用 |
|---|---|
| `ppt_template_inspect` | 预览文件夹/zip，不安装 |
| `ppt_template_install` | 安装选中的模板 |
| `ppt_template_list` | 用户模板列表 |
| `ppt_template_catalog` | 合并后的版式 catalog |
| `ppt_template_preview` | 读取封面 SVG |
| `ppt_template_rename` | 修改名称/描述 |
| `ppt_template_set_enabled` | 启用/禁用 |
| `ppt_template_delete` | 删除目录 + DB 行 |
| `ppt_template_reconcile` | 重新扫描目录 |
| `ppt_template_reveal` | 打开模板目录 |

事件：`ppt-template://changed`。

冲突策略：`Reject` / `Overwrite` / `Rename`。与内置模板 id 冲突时强制 `Rename` 为 `<id>-user`。

## 9. 运行时接入

### Catalog 合并

`ppt_template_catalog` 返回扩展模板 + 用户模板，每项带 `source: "extension" | "user"`。前端不再硬编码 `"ppt-master"`。

### 渲染解析

```rust
resolve_layout_dir(db, data_dir, extension, layout_id) -> Option<PathBuf> {
    // 1. app_data/ppt-templates/<id>/templates
    // 2. extension/templates/layouts/<id>/templates
}
```

替换现有三处解析（`ppt_extension.rs` 的 programmatic / AI draft / regenerate page）。

### 作业快照

创建或首次渲染时复制到 `workspace/templates/layout_<id>/`；Rust 与 Python 都优先读快照，保证历史作业可复现。

### AI 模板提示

优先取 `content*` 页型的第一张，其次任意非封面页，不再硬编码 `06_content_cards.svg`。

### 当前限制

- Rust 路径（程序化渲染、AI 草稿、调色板、参考页、作业快照）完整支持用户模板。
- Python 引擎的模板填充回退仍从扩展包读取版式；用户模板在导出阶段直接复用已生成的 SVG，因此不影响导出结果。
- 若后续需要 Python 回退也使用用户模板，可在下一次扩展版本中让 `entry.py` 优先读取作业目录的快照（`workspace/templates/layout_<id>/`）。这属于一次性的扩展升级，不影响新增模板。

## 10. UI

在「扩展包」页新增「模板库」tab：

- 列表卡片：封面、名称、描述、页数、画布、来源徽标
- 操作：预览、重命名、启用/禁用、删除、打开目录
- 主按钮：导入模板（文件夹 / zip）

导入弹窗：选择来源 → Inspect 结果 → 冲突策略 → 安装。

PPT 风格页中用户模板与内置模板并列，增加「用户」徽标。

## 11. 更新与迁移

| 场景 | 行为 |
|---|---|
| 重新导出同名模板 | 选“覆盖”，原子替换，保留 id |
| 保留旧版 | 选“另存为”，自动 `<id>-2` |
| 删除模板 | 删除目录 + DB 行，不影响扩展包 |
| 手动拷贝目录 | 启动或重扫时自动注册 |
| 扩展包升级/卸载 | 用户模板不受影响 |
| 换电脑 | 拷贝 `ppt-templates/` 即可 |

## 12. 实施拆分

### P0

1. Schema v84 + CRUD
2. 共享安全解压
3. `services/ppt_template.rs`：inspect/install/list/delete/rename/enable/reconcile
4. Commands + 注册
5. 前端类型 + API
6. 模板库 tab + 导入弹窗
7. catalog 合并 + 渲染解析 + 作业快照

### P1

1. 手动拷贝自动扫描
2. content hash / “已更新”提示
3. 拖拽导入
4. 导出模板包
5. 在文件夹中显示

## 13. 测试

- Rust：frontmatter 解析、页型去重、zip 穿越、SVG 安全校验、冲突策略、catalog 合并、reconcile
- 集成：导入 `templates-new/layouts/aviation_training_blue` 文件夹与 zip，并用于一次 PPT 作业
- 前端：导入弹窗与列表交互

### 13.1 测试模板包

运行：

```bash
pnpm prepare:ppt-template-packs
```

生成到 `test-data/ppt-templates/`：

| 路径 | 用途 |
|---|---|
| `user/aviation_training_blue/` | 用户自定义模板包，通过模板库导入 |
| `user/aviation_training_blue-user.zip` | 同一模板的 zip，测试 zip 导入 |
| `system/layouts/` | 其余 6 套系统默认模板 |
| `system-templates-6.zip` | 系统包压缩存档 |
| `extension-build/` | 使用 `--layouts-dir` 构建的 6 套模板测试扩展包 |

系统默认包构建命令：

```bash
node scripts/build-ppt-extension.mjs \
  --ppt-master-root "D:/AI/ALL-PPT/ppt-master-main" \
  --layouts-dir "test-data/ppt-templates/system/layouts" \
  --out "test-data/ppt-templates/extension-build" \
  --version "1.2.6-system6"
```

测试包保留各模板的 `exports/*_template_preview.pptx` 供人工对照；应用导入时会忽略 `exports/`。

生产扩展包默认输出到：

```text
src-tauri/target/release/bundle/nsis/ppt-master-extension-<version>-win7-x64.zip
```

---

## 14. 用户模板构建指南

### 14.1 两种构建方式

**方式 A：用 PPT-Master 生成（推荐）**

在 `D:\AI\ALL-PPT\ppt-master-main` 中使用上游的 Create Template 工作流：

- 品牌中立的结构：`skills/ppt-master/workflows/create-template/create-layout.md`
- 带品牌身份：`skills/ppt-master/workflows/create-template/create-deck.md`
- 规范说明：`docs/zh/templates-architecture.md`

产出标准工作区：

```text
my-template/
├── templates/
│   ├── design_spec.md
│   ├── 01_cover.svg
│   ├── 02_content.svg
│   └── ...
├── images/            # 可选
└── icons/imported/    # 可选
```

现有的「航空维修蓝」就是这种方式构建的。

**方式 B：手工最小模板**

只要满足下面的结构即可，最小只需要 1 个 SVG：

```text
my-template/
├── templates/
│   ├── design_spec.md
│   ├── 01_cover.svg
│   └── 02_content.svg
└── images/            # 可选
```

### 14.2 `design_spec.md`

```markdown
---
layout_id: my_layout
kind: layout
category: scenario
summary: 我的自定义内容结构，覆盖封面与标准内容页
keywords: [custom, content, simple]
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 2
page_types: [cover, content]
placeholders:
  01_cover: ['{{TITLE}}', '{{SUBTITLE}}']
  02_content: ['{{PAGE_TITLE}}', '{{SUBTITLE}}', '{{BODY}}']
---

# My Layout — Design Specification

## IV. Signature Design Elements

- 顶部 4px 识别线
- 深色标题区 + 浅色内容区
- 页脚来源行 + 右对齐页码

## V. Page Roster

| File | Layout key | Picker name | Content shape |
|---|---|---|---|
| `01_cover.svg` | cover | Cover | 标题 + 副标题 |
| `02_content.svg` | content | Content | 标题 + 正文区 |
```

说明：

- `layout_id` 会作为安装目录名；只能包含小写字母、数字、`-`、`_`。
- `page_count` / `page_types` 可以省略，导入时会从文件名推导。
- `design_spec.md` 本身也可以省略；此时名称/描述回退为目录名，导入时会给出警告。
- 建议保留 `design_spec.md`，AI 草稿生成会读取 §IV 和 §V 作为风格参考。

### 14.3 SVG 要求

**画布**

```svg
<svg xmlns="http://www.w3.org/2000/svg"
     width="1280" height="720" viewBox="0 0 1280 720">
```

所有页建议统一 1280×720（或同一比例）。

**结构化占位符（推荐）**

```svg
<g data-pptx-placeholder="title"
   data-pptx-bounds="80 50 1000 60">
  <text data-pptx-carrier="true"
        x="80" y="100"
        font-size="26" fill="#F8FAFC" font-weight="bold">
    {{PAGE_TITLE}}
  </text>
</g>
```

**旧版写法（仅 `{{}}`）**

```svg
<text x="80" y="100" font-size="26" fill="#F8FAFC">
  {{PAGE_TITLE}}
</text>
```

支持的槽位 key：

`title`、`subtitle`、`body`、`content`、`object`、`chart`、`picture`、`footer`、`slide-number`

**装饰层**

```svg
<rect data-pptx-layer="master" data-pptx-editable="false"
      x="0" y="0" width="1280" height="720" fill="#0B1220"/>

<rect data-pptx-layer="layout" data-pptx-editable="false"
      x="80" y="140" width="1120" height="1" fill="#334155"/>
```

**页面命名**

```text
01_cover.svg
02_content.svg
03_content.svg
04_ending.svg
```

- 前缀 `数字_` 会被去掉，作为页型。
- 重复页型导入时会自动去重：`content`、`content_2`、`content_3`…
- 页型用于 PPT 生成的版式选择，建议使用有意义的名称。

### 14.4 图片与图标

- 图片放在模板根目录的 `images/`，SVG 中写 `../images/logo.png`。
- 图标放在 `icons/imported/`。
- 导入时默认保留图片；也可以勾选“仅导入矢量”丢弃 `images/`，但 `icons/` 会保留。
- 不要使用 `http(s)://` 外链图片，导入会被拒绝。

### 14.5 导入步骤

1. 打开 **扩展包 → 模板库**。
2. 点击 **导入文件夹**，选择 `my-template/` 根目录（不要只选 `templates/` 子目录）。
3. 或者把整个目录打成 zip，点击 **导入 zip**；也可以直接把文件夹/zip 拖进页面。
4. 检查封面、页数、页型、警告。
5. 有同名模板时选择：覆盖 / 另存为新 id / 跳过。
6. 点击导入。

安装后的结构：

```text
app_data/ppt-templates/my_layout/
├── meta.json
├── templates/
│   ├── design_spec.md
│   ├── 001_cover.svg
│   └── 002_content.svg
└── images/
```

之后在 PPT 生成 → 风格确认页就能看到带「用户」标记的模板。

### 14.6 导入校验规则

会自动拒绝：

- 没有任何 SVG
- SVG 不是合法 XML
- 含 `<script>`、`<foreignObject>`、`on*` 事件
- 含 `http(s)://`、`file://`、`javascript:` 外部引用
- zip 路径穿越、符号链接、超大文件

会提示但允许导入：

- 没有 `design_spec.md`
- 没有发现任何占位符（生成时会回退内置渲染器）
- 页型重复（自动重命名）
- 画布尺寸不一致

### 14.7 最小可用示例

`01_cover.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#0F172A"/>
  <g data-pptx-placeholder="title" data-pptx-bounds="80 260 1120 120">
    <text data-pptx-carrier="true" x="80" y="340" font-size="48" fill="#F8FAFC" font-weight="bold">
      {{TITLE}}
    </text>
  </g>
  <g data-pptx-placeholder="subtitle" data-pptx-bounds="80 400 1120 60">
    <text data-pptx-carrier="true" x="80" y="440" font-size="22" fill="#94A3B8">
      {{SUBTITLE}}
    </text>
  </g>
</svg>
```

`02_content.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#F8FAFC"/>
  <g data-pptx-placeholder="title" data-pptx-bounds="80 50 1120 70">
    <text data-pptx-carrier="true" x="80" y="100" font-size="30" fill="#0F172A" font-weight="bold">
      {{PAGE_TITLE}}
    </text>
  </g>
  <g data-pptx-placeholder="body" data-pptx-bounds="80 160 1120 480">
    <text data-pptx-carrier="true" x="80" y="200" font-size="18" fill="#334155">
      {{BODY}}
    </text>
  </g>
</svg>
```

把这两个文件放进 `my-template/templates/`，直接导入即可。

### 14.8 不需要重新打包扩展

新增用户模板只是往 `app_data/ppt-templates/` 写数据：

- 不修改主程序代码（导入功能已随应用发布）
- 不修改 `ppt-master` 扩展包
- 不需要重新生成扩展 zip
- 扩展包升级/卸载不会影响用户模板
