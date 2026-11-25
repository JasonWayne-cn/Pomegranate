# 设置配置备份方案（.kbconfig）

> 创建：2026-11-24
> 参照：knowledge-base `d9cc7dd`（设置备份）、`815f841`（配置包支持界面偏好与应用设置）
> 本仓：`src/lib/configShare.ts`、`src/lib/configCrypto.ts`、`src/store/index.ts`、`src/components/settings/`
> 关联：`v3.5.0-upgrade-plan.md` P5、`remaining-improvements-plan.md` §2.C

## 1. 目标

把散在三处的设置导出成一个 `.kbconfig` 文件，换机器 / 重装后按分类恢复：

1. 界面与编辑器偏好（Zustand + tauri-plugin-store）。
2. 应用行为（`app_config` 表白名单键）。
3. 模型服务、同步源、语音识别（复用现有配置分享序列化）。

**不包含**：笔记数据、附件、localStorage 零碎记忆、仅对本机/本库有效的设置。

## 2. 现状

| 能力 | 本仓 |
|------|------|
| 配置分享 envelope | 有（`configShare.ts`：ai-model / sync-backend / asr / bundle） |
| PIN 加密 | 有（`configCrypto.ts`） |
| 导出/导入弹窗 | 有（`ShareConfigModal` / `ImportConfigModal`） |
| 设置备份 | 无 |
| BundleData | 仅 `webdavBackends / aiModels / asrConfig / featureToggles` |
| 界面偏好收集 | 无统一函数 |

## 3. 设计

### 3.1 数据格式

复用配置分享 envelope：`kind = "bundle"`，新增字段：

```ts
interface BundleData {
  uiPrefs?: Record<string, unknown>;      // 界面/编辑器偏好
  appConfig?: Record<string, string>;     // 白名单 app_config
  aiModels?: AiModelData[];
  syncBackends?: SyncBackendData[];
  asrConfig?: AsrConfig;
  featureToggles?: FeatureTogglesData;    // 兼容旧包
}
```

- 老版本应用遇到新字段会忽略；新版本遇到旧包按现有默认值补齐。
- 含密钥时由前端强制 PIN 加密（与现有配置分享一致）。

### 3.2 可移植键

`src/lib/configShare.ts`

- `PORTABLE_CONFIG_KEYS`：启动/关闭行为、自动更新、提醒音、功能模块、全局快捷键、MCP 权限等。
- `SECRET_CONFIG_KEYS`：API Key、同步密码、Jina Key 等（仅在勾选「包含密钥」时导出）。
- 排除：默认文件夹/标签 id、本机路径、PIN 哈希、MCP HTTP 端口/token、同步时间戳、速记草稿。

### 3.3 收集 / 导入

新增 `src/lib/settingsBackup.ts`

```ts
collectPortablePrefs(): Record<string, unknown>
collectSettingsBackup(categories, includeSecrets): { envelope, hasSecrets }
describeBackup(data): BackupPreviewItem[]
pickBackup(data, categories): BundleData
```

- uiPrefs：从 store 读取持久化偏好（只读快照，不改状态）。
- appConfig：`configApi.getAll()` 过滤白名单；密钥按开关处理。
- aiModels / syncBackends / asr：复用 `exportAiModel` / `exportSyncBackend` / `asrApi.getConfig`。
- 导入：按分类调用现有 `applyEnvelope` / 设置接口；`uiPrefs` 通过 store 的 setter 批量恢复。

### 3.4 UI

`src/components/settings/SettingsBackupSection.tsx`

- 导出：分类勾选 + 「包含密钥」 + PIN 设置 → 原生保存对话框写盘（`dialog.save`）。
- 导入：`dialog.open` 选文件 → 加密包先输 PIN → 预览分类与条数 → 勾选后写入。
- 生成文件名：`Pomegranate-settings-YYYYMMDD.kbconfig`。
- 设置页「数据同步与备份」下新增「配置备份」区块。

## 4. 文件清单

| 文件 | 改动 |
|------|------|
| `src/lib/configShare.ts` | BundleData 扩展、可移植键、导出函数 |
| `src/lib/settingsBackup.ts` | 新增收集/预览/筛选 |
| `src/components/settings/SettingsBackupSection.tsx` | 新增 UI |
| `src/pages/settings/index.tsx` | 接入区块 |
| `src/lib/api/index.ts` | 如需批量恢复的设置 API |
| 测试 | `settingsBackup.test.ts`、`configShare.test.ts` |

## 5. 验收

- 导出→删除本地设置→导入→界面/行为/模型/同步源恢复。
- 不含密钥：对方导入后模型/同步源存在但需补填密钥。
- 含密钥：必须 PIN；PIN 错误不写入。
- 旧版本 bundle（无 uiPrefs/appConfig）导入不报错。
- 恶意/损坏文件：解析失败不写入任何设置。

## 6. 风险

| 风险 | 应对 |
|------|------|
| 导入任意 app_config 键 | 白名单过滤，密钥键单独判断 |
| 界面偏好结构变化 | 版本字段 + 未知键忽略 |
| 恢复后布局错乱 | uiPrefs 只恢复已知键；分栏宽度等本机记忆不入包 |
| PIN 泄露 | 复用现有加密格式；文件仅本地保存，提示用户保管 |
