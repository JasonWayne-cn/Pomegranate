# 打包与发布加固方案（Windows）

> 创建：2026-11-24
> 参照：knowledge-base `f591963`（钉 Rust 1.99.1）、`634150c`（补 rustfmt）、`d09e812`（kb-mcp 升级让位）、`b7b6d45`（升级不提示卸载）、`40c265c`（卸载提示会删笔记）、`8fd5cc5`/`72a6f13`（安装模板以框架为准）
> 本仓：`.github/workflows/release.yml`、`src-tauri/installer-hooks.nsi`、`.claude/release-config.json`
> 关联：`remaining-improvements-plan.md` §2.D

## 1. 目标

1. CI 构建可复现：工具链与 sidecar 复制行为稳定。
2. 升级安装不打断外部 AI 会话（`kb-mcp` 正被 Claude Code 等占用）。
3. 安装 / 升级 / 卸载文案与行为准确，不误删数据。
4. 安装包模板与框架保持一致，升级 CLI 后可重新生成。

## 2. 现状与差距

| 项 | 本仓 | KB |
|----|------|----|
| Rust 工具链 | `dtolnay/rust-toolchain@stable` | 固定 `1.99.1` + `rustfmt` |
| sidecar 复制 | 依赖当前工具链布局 | 固定版本避开 1.100 build 目录变化 |
| 升级时 kb-mcp | 直接覆盖/可能 taskkill | `SIDECAR_ASIDE` 改名让位，不杀进程 |
| 升级安装 | 可能走卸载流程 | 直接装回原目录，不提示卸载 |
| 卸载文案 | 无「会删除笔记」提示 | 明确提示 |
| 安装模板 | 手维护 `installer-hooks.nsi` | 框架模板生成 + 构建前版本检查 |

## 3. 方案

### P1 CI 工具链固定

`.github/workflows/release.yml`

```yaml
- uses: dtolnay/rust-toolchain@master
  with:
    toolchain: 1.99.1
    components: rustfmt
```

- 记录固定原因：1.100 新 build 目录布局导致 sidecar 复制路径失效。
- 升级工具链时同步验证 `target/release/build/` 下的 sidecar 产物。
- 保留 `rustfmt`：bindgen 依赖（如 apple-sys）需要。

### P2 sidecar 升级让位（SIDECAR_ASIDE）

`src-tauri/installer-hooks.nsi`

- 新增标准宏：`SIDECAR_ASIDE "kb-mcp.exe" "kb_mcp"`
  - 安装前：旧 exe 依次 `Rename` 为 `.old`、`.old1`…`.old5`
  - 五个名字都被占用才 `taskkill` 兜底
  - 安装后：`Delete "$INSTDIR\kb-mcp.exe.old*"`
  - 卸载后：同样清理 `.old*`，再 `RMDir "$INSTDIR"`
- 目的：外部 MCP host 通过 stdio 占着 exe 时，升级仍能写入新文件且 AI 会话不断。
- 回归：升级时保持 Claude Code 会话运行，确认不被杀、重连正常。

### P3 升级安装不提示卸载

- NSIS 安装脚本依据注册表/原安装目录判断「升级」：
  - 升级：直接覆盖安装到原目录，不弹卸载确认。
  - 全新安装：正常流程。
- 手工验证：已装旧版 → 运行新安装包 → 不出现卸载提示 → 数据保留。

### P4 卸载文案

- 卸载页面明确：「卸载会删除本地笔记与配置，请先导出/同步」。
- 若保留用户数据选项不可实现，至少文字如实说明。

### P5 安装模板以框架为准

- 使用框架提供的模板生成脚本（`scripts/installer-std/` 或框架对应位置），不再手改大段 NSIS。
- 构建前检查模板版本；升级 Tauri CLI 后重新生成。
- 自定义项（中文快捷方式名、sidecar 宏）通过模板参数/片段注入。

## 4. 文件清单

| 文件 | 改动 |
|------|------|
| `.github/workflows/release.yml` | 固定工具链 + rustfmt |
| `src-tauri/installer-hooks.nsi` | SIDECAR_ASIDE、升级判断、卸载文案 |
| `scripts/installer-std/*`（如引入） | 模板生成与版本检查 |
| `.claude/release-config.json` | 如需记录工具链/模板版本 |

## 5. 验收

| 场景 | 预期 |
|------|------|
| CI 构建 | 固定工具链成功；sidecar 在安装包内 |
| 旧版 → 新版覆盖安装 | 不提示卸载；数据在；外部 AI 会话不断 |
| kb-mcp 正被占用 | 改名让位成功；新 exe 就位 |
| 全新安装 | 正常；快捷方式中文名正确 |
| 卸载 | 明确提示删除数据；`.old*` 清理 |
| 回滚 | 用安装包覆盖回旧版可启动；数据库升级备份可恢复 |

## 6. 风险

| 风险 | 应对 |
|------|------|
| 固定旧工具链缺少新依赖支持 | 仅固定到当前验证版本；升级单独验证 |
| 改名让位失败 | 五级 `.old` + taskkill 兜底；失败时安装器报错而非静默 |
| 模板生成覆盖自定义 | 自定义项走模板参数；生成后 diff 检查 |
| macOS 发布 | 当前矩阵仅 Windows；如启用需另加签名/公证方案 |
