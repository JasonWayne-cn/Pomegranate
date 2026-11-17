# PDF / Word 导入保留图片开发计划

> 状态：已完成并通过自动化与真实文件 UI 验收；旋转/加密 PDF、Word 回归仍待补充。
> 范围：笔记 PDF 导入保留图片；Word 导入回归验证；不包含 OCR 引擎接线与 PPT 扩展素材改造。

## 1. 目标

1. 笔记 PDF 导入时，把 PDF 中的位图图片按页内坐标与文本交错写入笔记内容。
2. 原 PDF 文件继续完整保留在 `pdfs/<note_id>/`。
3. Word 笔记导入维持 mammoth 的内联图片位置，并补充回归测试。
4. 不引入 Python / PyMuPDF / AGPL 依赖。

## 2. 非目标

- RapidOCR sidecar 接线与扫描件 OCR。
- PPT 扩展本地素材的图片保留（需要改 `PptLocalFileSource` 与生成提示词）。
- 矢量图表区域栅格化。

## 3. 架构决策

| 决策 | 内容 |
|---|---|
| 抽取引擎 | `pdfium-render 0.8.37`（项目已内置 PDFium） |
| 文本定位 | `page.text().segments()` |
| 图片抽取 | `page.objects()` → `as_image_object()` → `get_raw_image()` |
| 图片落盘 | `ImageService::save_bytes()` → `kb_assets/images/<note_id>/` |
| 内容引用 | `kb-asset://<相对 data_dir 的 POSIX 路径>` |
| 降级 | PDFium 不可用/解析失败 → 回退现有纯文本抽取 |
| OCR | 本期不启用 |

## 4. 任务分解

### M0 — 基线

- [x] 确认 PDFium 初始化与现有 PDF 导入行为。
- [x] 真实样张验收：C919 图文 PDF、双栏学术论文 PDF；旋转/加密 PDF 未覆盖。

### M1 — 结构化抽取服务

- [x] 新增 `src-tauri/src/services/pdf_layout.rs`。
- [x] 定义 `PdfBlock` / `PdfImage` / `PdfLayout`。
- [x] 文本段与图片对象抽取、坐标转换、排序、段落合并。
- [x] 装饰性图片过滤、SHA-256 去重、数量与体积上限。
- [x] 在 `services/mod.rs` 注册模块。
- [x] `Cargo.toml` 增加 `image = "0.25"`（仅启用 png 编码）。
- [x] 单元测试覆盖排序、合并、过滤、HTML 渲染、真实 PDF 文本/图片抽取。

### M2 — 接入 PDF 笔记导入

- [x] `PdfImportResult` 增加 `image_count` / `warnings` / `extraction`。
- [x] `import_one` 使用结构化抽取；失败时回退纯文本。
- [x] 创建笔记后保存图片，`db.update_note_content` 写入交错 HTML。
- [x] `import_pdfs` 增加 `keep_images` / `max_images` 可选参数。
- [x] 移除前端无效的 `enableOcr` 参数。

### M3 — 前端

- [x] `src/types/index.ts` 同步 `PdfImportResult`。
- [x] `src/lib/api/index.ts` 更新 `importPdfs` 签名。
- [x] `noteCreator.tsx` / `ImportSection.tsx` 展示图片数量与警告。

### M4 — Word 验证

- [ ] 确认 mammoth 内联图片位置保持。
- [ ] 记录浮动/锚定图片限制。
- [ ] 不改动 PPT 扩展的 `DocExtractService`。

### M5 — 测试

- [x] 单元测试：坐标排序、段落合并、图片过滤、HTML 转义。
- [x] 真实 PDF 测试：文本段抽取、图片抽取、导入笔记并落盘图片。
- [x] 回归：`services::pdf` 既有 27 项测试通过。
- [x] 手工测试：C919 + 学术论文 UI 导入；双栏阅读顺序、图片渲染通过。
- [ ] 旋转图片、加密 PDF 手工测试。
- [ ] Word 导入回归（现有 mammoth 链路，未改代码）。

### M6 — 文档与提交

- [x] 更新能力说明与限制（本文档）。
- [x] 已完成两个提交：`6ec8b13`、`843e78b`。
- [x] 仅提交本次 PDF 文件，未触碰其他会话改动。

## 5. API 契约

```rust
#[tauri::command]
pub fn import_pdfs(
    state: State<'_, AppState>,
    paths: Vec<String>,
    folder_id: Option<i64>,
    keep_images: Option<bool>,
    max_images: Option<usize>,
) -> Result<Vec<PdfImportResult>, String>
```

```ts
export interface PdfImportResult {
  sourcePath: string;
  noteId: number | null;
  title: string | null;
  error: string | null;
  imageCount: number;
  warnings: string[];
  extraction: "structured" | "text";
}
```

## 6. 验收标准

- [x] 含文字与图片的 PDF 导入后，图片与上下文顺序正确。
- [x] 图片重启后可正常显示。
- [x] 原 PDF 仍可预览/打开。
- [x] 装饰性小图、重复图不进入笔记。
- [x] 扫描件仍给出明确提示，不生成空内容笔记。
- [x] PDFium 异常时回退纯文本。
- [ ] Word 内联图片位置回归通过。
- [ ] 删除笔记后图片目录被清理（当前仅验证软删除，资源随永久删除清理）。

## 7. 风险

| 风险 | 应对 |
|---|---|
| PDF 对象顺序与视觉顺序不一致 | 按视觉坐标排序；双栏样张验证 |
| 特殊编码图片解码失败 | 跳过并写入 warnings |
| 图片体积过大 | 最大边长 2000 px、最多 200 张、总大小 100 MB |
| 大 PDF 内存峰值 | 抽取阶段限制图片数量与总字节 |
| 移动端无 PDFium | `cfg(desktop)` 隔离，移动端走纯文本 |
| 与 PPT 未提交改动冲突 | 本期不修改相关文件 |

## 8. 实施记录

| 模块 | 改动 |
|---|---|
| `services/pdf_layout.rs` | 新增 PDFium 结构化抽取：文本段坐标、图片对象、排序、段落合并、过滤、PNG 编码、HTML 渲染 |
| `services/pdf.rs` | 两阶段导入：先文本判定扫描件，再抽取图片；图片写入 `kb_assets` 并更新笔记正文；失败回退纯文本 |
| `commands/pdf.rs` | `import_pdfs` 增加 `keep_images` / `max_images` |
| `types` / `api` / UI | 结果类型、图片数量与警告提示 |
| `Cargo.toml` | `image 0.25`（仅 png 编码） |

### 已知限制

1. PDFium 只遍历页面顶层对象；嵌套在 Form XObject 内的图片可能遗漏。
2. 双栏版面目前按视觉坐标排序，复杂分栏可能出现阅读顺序交叉。
3. 矢量图表（Path 对象）不会作为图片保留。
4. 扫描件仍不启用 OCR，维持原有提示。
5. `keep_images=false` 时完全走原纯文本链，行为与旧版本一致。

## 9. 验证结果

| 检查 | 结果 |
|---|---|
| `cargo check --lib` | 通过 |
| `cargo clippy --lib`（新增文件） | 无告警 |
| `cargo test services::pdf::tests` | 27 passed |
| `cargo test pdf_layout` | 15 passed，1 ignored（手工探针） |
| `npx tsc --noEmit` | 通过 |
| 真实文件 UI 验收 | 通过 |

其中 `pdf_layout` 测试包含：

- 视觉坐标转换、段落合并、跨页不合并
- 字符级同行合并、数字/章节号连写、CJK 换行拼接
- 装饰图过滤、HTML 图片插在文本之间、文本转义、分页标记
- 真实生成的文本 PDF / 图片 PDF 抽取
- 完整导入：创建笔记、写入 `<img>`、图片落盘、原 PDF 落盘

## 10. 真实文件验收

### C919机场运行指南.pdf

| 指标 | 结果 |
|---|---|
| 页数 | 25 |
| 文本字数 | 13,009 |
| 抽取方式 | `structured` |
| 图片 | 5 张 |
| 笔记 `<img>` | 5 个 |
| 段落 | 1,008 |
| 图片落盘 | 5 个文件 |
| 原 PDF | 1 个文件 |
| 耗时 | 约 450 ms |
| warnings | 无 |

UI 验收：首图 COMAC 标志、标题、日期与目录正常显示，图片通过 `kb-asset://` 加载。

### 学术论文 PDF

| 指标 | 结果 |
|---|---|
| 页数 | 24 |
| 抽取方式 | `structured` |
| 图片 | 2 张 |
| 笔记 `<img>` | 2 个 |
| 段落 | 2,329 |
| 图片落盘 | 2 个文件 |
| 原 PDF | 1 个文件 |
| 耗时 | 约 3.0 s |
| warnings | 无 |

UI 验收：期刊封面与树状示意图按顺序渲染，正文可见。

### 手工探针命令

```bash
cd src-tauri
KB_TEST_PDFS="D:/AI/ALL-PPT/ppt-master/C919机场运行指南.pdf;D:/Wen/Downloads/A-large-language-model-enabled-machining-process-knowle_2025_Advanced-Engine.pdf" \
cargo test manual_import_real_pdfs --lib -- --ignored --nocapture --test-threads=1
```

## 11. 已知问题

1. C919 目录中的“目/录”等宽字距标题仍可能拆成两段。
2. 部分章节号显示为 `1. 1`。
3. 学术论文第 1 页可能形成一个超大文本段，部分英文单词空格丢失。
4. 上述问题不影响图片保留与正文导入，属于后续文本质量优化项。
