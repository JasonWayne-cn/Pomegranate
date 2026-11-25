# AI 助研插件

纯 JS 插件实现，不新增宿主数据表、不新增 Rust 业务命令。

## 功能

- 课题管理（多课题、状态、关键词、说明）
- 文献库（手动新增、从检索结果导入、阅读笔记、导出知识库笔记、勾选导出 GB/T 7714 / BibTeX 参考文献索引）
- 发现（Crossref / Europe PMC / arXiv / DBLP / PubMed / Semantic Scholar）
- 从已选文档 / 本地文献 / 文献库用 AI 提取研究主题与关键词，结果可编辑、缓存并回填检索
- 写作（前沿追踪、文献综述、论文框架、语言润色、规范检查、数据分析）
- 精读（1–5 篇 PDF → 结构化分析 → SVG 知识图谱）
- 产出（查看、复制、导出为普通笔记）

## 权限

| 权限 | 用途 |
|---|---|
| `ai:chat` | AI 生成与入库建议 |
| `ai:models` | 读取默认模型列表 |
| `notes:read` / `notes:write` | 导出论文/产出为知识库笔记 |
| `settings:read` / `settings:write` | 插件自身数据存储 |
| `network:request` | 通过宿主白名单代理访问 6 个论文源 |

## 数据存储

全部使用宿主 `plugin_settings`，按插件 ID 自动隔离：

- `meta`：课题索引与当前课题
- `lit:<projectId>`：文献数组
- `out:<projectId>`：产出数组
- `cache:<hash>`：检索缓存
- `settings`：模型、来源、缓存时长、结果数

## 开发

插件入口是 `main.js`，宿主用 `new Function` 执行并读取 `module.exports`。

```bash
# 语法检查
node --check dev-plugins/research-assistant/main.js

# 纯函数测试
node --test dev-plugins/research-assistant/test/core.test.mjs
```

安装：把本文件夹打成 zip（根目录含 `plugin.json`），在应用「插件」页选择插件包安装；也可解压后放入应用数据目录的 `plugins/research-assistant/` 再扫描。

安装后在插件详情里**授予清单声明的权限**（AI、笔记、设置、network:request），否则对应功能会被宿主拒绝。

宿主卸载前会把插件设置备份到 `<数据目录>/plugin-data-backups/research-assistant.json`，重装后自动恢复；权限需要重新授权。

## 限制

- UI 使用原生 DOM/CSS，不使用 Ant Design。
- AI 不联网；论文元数据来自公开 API，需人工核验。
- 扫描版 PDF 可能无法抽取文本。
- 插件运行在宿主 WebView 内，属于“安装即信任”模型，仅安装可信插件。
