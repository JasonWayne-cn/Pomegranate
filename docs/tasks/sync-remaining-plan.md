# 同步体系剩余方案（数据安全 + 文件夹同步 + 内容同步）

> 创建：2026-11-23
> 参照：knowledge-base 提交 `0dbb2c2`（文件夹同步）、`0c68715`（只移动文件夹的笔记也能同步）、`3e1c81f`（闪卡/复习/提示词/模板同步）、`b39fa8a`（资产备份 1→3）、`918487e`（数据目录不覆盖）、`6055f63`（升级失败不换库）及对应实现文件
> 本仓基线：Pomegranate 2.2.0，schema 90，`sync_v1` 已有 local / webdav / s3、projects / tasks / task_categories 同步
> 关联：`remaining-improvements-plan.md` §2.B、`v3.5.0-upgrade-plan.md` P3、`lan-sync-plan.md` L0（同步凭据加密，独立推进）
> 结论：拆成三段——**S0 数据安全（先行、不依赖新 schema）→ S1 文件夹同步（schema 91）→ S2 内容同步（schema 92）**。三者可分别发布。

## 1. 范围

| 批次 | 内容 | 依赖 |
|------|------|------|
| **S0 数据安全** | 资产备份 1→3 份、数据目录迁移不覆盖、升级失败不换库 + 升级前备份、导入备份含 WAL、孤儿清理保护 | 无 schema 变更 |
| **S1 文件夹同步** | 空文件夹 / 改名 / 移动 / 删除 / 排序 / 颜色跨端；笔记只换文件夹也能同步 | schema 91 |
| **S2 内容同步** | 闪卡（内容 + 调度）、复习记录、AI 提示词、笔记模板跨端 | schema 92 |

**非目标（已另有方案或明确不做）**

- 局域网同步、同步凭据加密 → `lan-sync-plan.md`（L0 先于 LAN）。
- AI 会话置顶/分叉、页面行为、移动端 v4、UI 换皮 → `remaining-improvements-plan.md` 其它条目。
- 设置备份 `.kbconfig`、窗口位置记忆、打包/升级钩子 → 各自独立方案。
- 任务 / 项目 / 分类同步：本仓已完成，不在本次范围。

## 2. 现状对比（本仓 vs KB）

| 维度 | 本仓现状（证据） | KB 参考 | 缺口 |
|------|------------------|---------|------|
| 文件夹 manifest | 只有笔记条目携带 `folder_path`（`services/sync_v1/manifest.rs:271,309`） | `folders` 整棵树单独进 manifest | 空文件夹/改名/排序/颜色传不过去 |
| 文件夹同步列 | `folders` 仅 `id/name/parent_id/sort_order/created_at` 加后补的 `color`（`schema.rs:1739-1741`）与 `mount_id`（`schema.rs:2787`）；无 `stable_uuid`、`updated_at` | v73 加两列 + 索引 + 触发器 | 无跨端标识、无变更时间 |
| 笔记移动时间 | 无 `folder_moved_at`（全仓 grep 为空） | v71 加列 + `notes_folder_moved` 触发器 | 只移动文件夹的笔记 hash 不变，同步看不到 |
| 墓碑表 | 无 `sync_tombstones` | v72 建表 + 删除触发器 | 文件夹/提示词/模板删除无法传播 |
| 闪卡 | 表存在（`schema.rs:1439`），无 `stable_uuid` | v72 加列 + 回填 + 索引 | 不能同步 |
| 复习记录 | 表存在（`schema.rs:1469`），无 `stable_uuid` | 同上 | 不能同步 |
| 提示词 | 表存在（`schema.rs:800`），无 `stable_uuid` | `builtin:<code>` + uuid | 不能同步 |
| 笔记模板 | 表存在（`schema.rs:397`），无 `stable_uuid`、无 `updated_at` | `preset:<名称>` + uuid + `updated_at` | 不能同步 |
| manifest 字段 | 仅 `entries/projects/tasks/task_categories`（`models/mod.rs:1733-1762`） | 加 `cards/card_review_logs/prompts/note_templates/folders` | 缺字段 |
| manifest 合流点 | `merge_manifests` `manifest.rs:608`；push 写远端 `push.rs:575` | 同构 | 需扩展 merge/diff |
| 资产备份份数 | `DIR_BACKUP_KEEP = 1`（`services/sync.rs:36`） | 3 | 连续替换导入两次，附件回不去 |
| 数据目录迁移 | 直接 `create_dir_all(to)` 后逐项 rename/copy（`services/data_dir.rs:541-685`），无目标已有库检查、无 inspect | 目标已有库默认拒绝/直接使用，替换需显式确认 | 线上事故同款风险 |
| 升级恢复 | `services/db_recovery.rs` 已实现，但 **`lib.rs:633` 直接 `Database::init`，从未调用**；且 `should_attempt_recovery` 只排除 `SchemaTooNew`（IO/磁盘满也会被当损坏） | 仅 SQLite 明确报损坏才恢复；恢复前提示 | 恢复未接线 + 误杀风险 |
| 升级前备份 | 无（`Database::init` 直接 `schema::migrate`，`database/mod.rs:98`） | `VACUUM INTO` 整库备份，留 2 份，失败不升级 | 迁移脚本出错无退路 |
| 导入前备份 | `fs::copy` 只复制主文件（`services/sync.rs:548-563`） | 只读连接导出完整副本；导不出时连 WAL 一起复制 | WAL 未落盘时备份是空壳 |
| 孤儿清理 | `services/orphan_scan.rs` 直接扫描/清理 | 空库拒绝清理、孤儿>笔记警告、文案收敛 | 打开空库时可能把真实素材判孤儿 |

## 3. S0 数据安全批次

### 3.1 S0-1 资产目录备份 1 → 3 份

- 改 `services/sync.rs:36`：`DIR_BACKUP_KEEP = 3`，注释写清「与 `DB_BACKUP_KEEP` 对齐；只在完全替换导入时产生」。
- 同步改测试 `services/sync.rs:2010`：造 5 份备份，断言留最新 3 份、现用目录不受影响。
- 验收：`cargo test --lib services::sync`；连续两次「完全替换」导入后，`kb_assets.bak-*` 仍有两次导入前的目录。

### 3.2 S0-2 数据目录迁移不覆盖已有库

对齐 KB `918487e`，本仓 `services/data_dir.rs` 是旧实现，需要移植：

1. **只读探查**：新增 `DataDirInspect { has_db, note_count, size, mtime, items }` 与 `inspect(dir)`；库内容可能在 WAL 里，主文件与 `-wal` 一起统计。
2. **入口拦截**：`set_pending_dir_with_migration` 增加 `replace_existing`；目标已有 `app.db` / `app.db-wal` 时：
   - `replace_existing=false` → 拒绝迁移，提示「直接使用该目录的数据」；
   - 只有用户明确选「替换」才放行。
3. **最后兜底**：`run_migration` 在复制前把目标的 `app.db` / `-wal` / `-shm` **整组**改名为 `app.db.before-migrate-<时间戳>` 并写 `_REPLACED_README.txt`；改名失败就中止，绝不覆盖。中断重试时若已完成留档则不再留档第二次。
4. **复制安全**：跨盘分支先写 `*.tmp`，校验大小后再 `rename`；资源目录合并时同名文件内容相同跳过、不同则目标那份改名留档。
5. **不再静默建空目录**：指针目录不存在时回落默认目录并提示，指针保留，目录恢复后自动生效。
6. **前端**：`src/components/settings/DataDirSection.tsx` 选择目录后先调 inspect，展示两边笔记数/大小/修改时间，默认「直接使用该目录的数据」；`src/lib/api/index.ts`、`src/types/index.ts` 增加 `inspect_data_dir`。

测试：目标有库拒绝、确认替换后整组留档、中断重试不重复留档、跨盘复制半途失败无半截文件、同名资源不同则留档。

### 3.3 S0-3 升级失败不换库 + 升级前备份

对齐 KB `6055f63`，分三件事：

1. **升级前备份**（`database/mod.rs::Database::init`，在 `schema::migrate` 之前）：
   - 仅当 `user_version < SCHEMA_VERSION` 时做；
   - `VACUUM INTO` 到临时文件 → 校验 → rename 为 `app.db.before-upgrade-<时间戳>-v<旧版本>`；
   - 保留最近 2 份；
   - **备份失败直接返回 Err，不升级**（宁可这次打不开并说清原因，也不在没有退路时改写库）。
2. **收紧恢复条件**（`services/db_recovery.rs::should_attempt_recovery`）：
   - 只在 `AppError::Database` 且 SQLite 明确报 `SQLITE_CORRUPT` / `SQLITE_NOTADB` 时恢复；
   - `Io`（磁盘满、权限）、`SchemaTooNew`、普通 SQL 错误一律不恢复，避免把好库 `quarantine` 成 `.corrupt-*`。
3. **接线**：`lib.rs:633` 改为
   ```rust
   let db = match database::Database::init(&db_path_str) {
       Ok(db) => db,
       Err(e) if db_recovery::should_attempt_recovery(&e) => {
           db_recovery::recover_or_fresh(&db_path, &e)?
       }
       Err(e) => return Err(e.into()),
   };
   ```
   恢复发生过后写提示文件；进界面弹窗说明用了哪份备份、原库留档在哪，点「知道了」清除（新增 `src/components/datadir/DbRecoveryNotice.tsx`）。

测试：迁移脚本中途失败时库文件哈希不变；升级前备份在仅 WAL 有内容时也完整；版本已最新不产生备份；`SchemaTooNew` 不触发恢复；恢复后原库留档存在且不被覆盖。

### 3.4 S0-4 导入/整包拉取备份完整（含 WAL）

`services/sync.rs:548` 的 `backup_existing_db` 改为：

- 以 **只读连接** 打开现有库，`VACUUM INTO` 临时文件 → 校验 → 复制/改名到 `app.db.bak-<时间戳>`；
- 导不出时退化为复制 `app.db` + `app.db-wal` + `-shm`（整组）；
- 仍保留 `DB_BACKUP_KEEP = 3` 的滚动清理。

测试：内容全在 WAL 的库，备份后能 `quick_check` 且笔记数与源库一致。

### 3.5 S0-5 孤儿清理保护（建议同批）

`services/orphan_scan.rs`：

- 库里 `notes` 为 0 时后端拒绝清理，返回 `blocked`；界面不给按钮；
- 孤儿数 > 笔记数时返回 `warn`，文案改成「可能打开了错误的库，请先确认」；
- 文案不再断言「笔记已被永久删除」。

## 4. S1 文件夹同步（schema 91）

### 4.1 迁移 `migrate_v90_to_v91`（schema.rs）

1. `folders` 加 `stable_uuid TEXT`、`updated_at TEXT`（`list_columns` 幂等检查）。
2. `notes` 加 `folder_moved_at TEXT`。
3. 回填：`updated_at = created_at`；`stable_uuid` 用 `SQL_UUID_V4` 常量（复制 KB `schema.rs:2603-2605`）。
4. 建 `sync_tombstones(kind, stable_uuid, deleted_at, PRIMARY KEY(kind, stable_uuid))`。
5. 建索引与触发器：
   - `idx_folders_stable_uuid`（partial unique）；
   - `folders_fill_sync_cols`（INSERT 补 uuid / updated_at）；
   - `folders_touch_updated_at`（改名/移动/排序/颜色且未显式改时间时刷新）；
   - `folders_tombstone`（物理删除记墓碑）；
   - `notes_folder_moved`（`AFTER UPDATE OF folder_id` 且值变化时写 `folder_moved_at`）。
6. `set_version(conn, 91)`。

**本仓适配（关键）**：挂载镜像文件夹也在这张表里（`folders.mount_id` 非空）。必须：

- `folders_tombstone` 触发器加 `AND OLD.mount_id IS NULL`，避免删除挂载点时把从未同步过的镜像文件夹墓碑推给别端；
- `folders_touch_updated_at` 可保留（无害），但 `list_folders_for_sync` / `list_folder_sync_rows` 必须 `WHERE mount_id IS NULL`；
- `list_folders_for_sync` 的父级 join 也要带 `p.mount_id IS NULL`，否则父级缺失会被当根层。

### 4.2 模型（`models/mod.rs`）

- 新增 `FolderManifestEntry { stable_id, content_hash, updated_at, name, parent_stable_id, sort_order, color, tombstone }`（`serde(default)` 兼容旧端）。
- `ManifestEntry` 增加 `folder_uuid: Option<String>`、`folder_moved_at: Option<String>`（`serde(default, skip_serializing_if = "Option::is_none")`）。
- `SyncManifestV1` 增加 `folders: Vec<FolderManifestEntry>`（`default` + 空不序列化）。
- `ManifestDiff` 增加 `folders_to_pull`（推送侧靠 `merge_manifests` 整份写，不需要 `_to_push`）。

### 4.3 服务层（新文件 `services/sync_v1/folder_sync.rs`，移植 KB 500 行）

- `folder_content_hash`：name + parent_stable_id + sort_order + color + tombstone 全拼接。
- `build_folder_entries`：本地文件夹 + 墓碑（30 天窗口，`is_deleted`/现存行优先）。
- `parents_first`：按父子链深度排序，防环。
- `plan_folder_adoption` / `adopt_remote_folder_ids`：升级后首次同步按「同一父级 + 同名」配对，改用远端 `stable_uuid`；push / pull 都要在算本地 manifest 前调用。
- `merge_folders` / `diff_folders`：复用 LWW（见 5.3 抽出的 `LwwEntry`）。
- `apply_pulled_folders`：父级先建/改，再删；父级缺失放根层；成环改放根层；删除时把笔记移到未分类、子文件夹提到根层。

### 4.4 笔记移动检测

- `compute_local_manifest` 查询补 `notes.folder_moved_at`，写入条目。
- `merge_manifests`：双方内容一致时按 `folder_moved_at` 较新者采纳 `folder_path/folder_moved_at/folder_uuid`。
- `diff_manifests`：`content_hash` 相同但 `folder_path` 不同时，仅当远端移动更晚才进 `to_pull`；本地更晚的靠 push 的 merge 写回远端。
- `pull.rs` 拉笔记：先按 `folder_uuid` 找本地文件夹，找不到才按路径补建；本地 `folder_moved_at` 更晚则保留本地位置，并回写远端的移动时间。

### 4.5 DAO（新文件 `database/sync_content.rs`，`database/mod.rs` 加 `pub mod sync_content;`）

| 函数 | 说明 |
|------|------|
| `list_folders_for_sync` | `WHERE f.stable_uuid IS NOT NULL AND f.mount_id IS NULL`；父级 join 同样排除挂载 |
| `list_folder_sync_rows` | `(id, stable_uuid, parent_id, name)`，排除 `mount_id` |
| `set_folder_stable_uuid` | 只改 uuid，不触发 `updated_at` |
| `get_folder_id_by_stable_uuid` | 拉笔记/父级解析 |
| `upsert_folder_synced` | 有则覆盖（含挪父级、防环），无则插入；清掉本地墓碑 |
| `delete_folder_synced` | 按远端删除时间删本地并记墓碑；笔记移未分类、子级提根 |
| `list_sync_tombstones(kind, cutoff)` | 三类（folder/prompt/note_template）共用 |
| `delete_synced_by_uuid` | 墓碑落库（表名映射） |

### 4.6 push / pull 接入

- **push**（`push.rs:74/86`）：先读远端 manifest → `adopt_remote_folder_ids` → 配上了就重算本地 manifest → 走既有 diff/merge；`merge_manifests` 末尾写回 `folders`（`manifest.rs:608`）。
- **pull**（`pull.rs:214`）：读远端 → `adopt_remote_folder_ids` → 重算本地 → `diff_manifests` → **在 `to_pull` 笔记循环（`pull.rs:375`）之前** `apply_pulled_folders`。
- 顺序：文件夹 → 附件 → 笔记 → 任务 → 闪卡 → 复习记录 → 提示词 → 模板。

### 4.7 测试

- 迁移：回填 uuid/`updated_at`/`folder_moved_at`；重复执行幂等；挂载镜像文件夹不产生墓碑。
- 配对：同父同名配对自上而下；同名多个只配一次；已在远端清单的 uuid 不重复配对；配过再调是空操作。
- 树操作：子级先到也能建对；改名/删除不影响笔记；成环改放根层；空文件夹可来回传。
- 笔记移动：只换文件夹、内容不变的笔记能双向同步；两端先后移动按 `folder_moved_at` 决胜。
- 兼容：旧 manifest 无 `folders` / `folder_uuid` 时不报错，按路径补建。

## 5. S2 内容同步（schema 92）

### 5.1 迁移 `migrate_v91_to_v92`（schema.rs）

对齐 KB v72：

1. `cards` / `card_review_logs` / `prompt_templates` / `note_templates` 各加 `stable_uuid TEXT`。
2. `note_templates` 加 `updated_at TEXT`。
3. 回填：
   - 内置提示词 `stable_uuid = 'builtin:' || builtin_code`；
   - 预置笔记模板按 `PRESET_NOTE_TEMPLATES`（会议记录/读书文档/周报/项目文档）取每个名称最早一行，设为 `preset:<名称>`；
   - `updated_at = created_at`；
   - 其余行逐行 `SQL_UUID_V4`。
4. 四个 partial unique 索引。
5. INSERT 触发器补 uuid（提示词优先取 `builtin:<code>`）。
6. 删除触发器写 `sync_tombstones`：`prompt_templates_tombstone`、`note_templates_tombstone`。
7. `set_version(conn, 92)`。

**本仓适配**：

- 闪卡本来就是软删（`cards.is_deleted`），条目 `tombstone` 由该列映射，**不需要**删除触发器；
- 当前 4 个预置模板在 v7 迁移插入、名称固定，回填逻辑可直接复用；
- `sync_tombstones` 已在 91 建好，本迁移只加触发器。

### 5.2 模型（`models/mod.rs`）

- `CardManifestEntry`（正反面、deck、note_uuid、FSRS 全调度字段、last_review、tombstone）
- `CardReviewLogManifestEntry`（只增不改）
- `PromptManifestEntry`（含 `builtin_code`、`sort_order`、`enabled`）
- `NoteTemplateManifestEntry`
- `CARD_LOG_RETENTION_DAYS = 365`
- `SyncManifestV1` 加 `cards / card_review_logs / prompts / note_templates`
- `ManifestDiff` 加 `cards_to_pull / card_logs_to_pull / prompts_to_pull / note_templates_to_pull`

### 5.3 服务层（新文件 `services/sync_v1/content_sync.rs`，移植 KB 632 行）

- `card_content_hash` / `prompt_content_hash` / `note_template_content_hash`：参与同步字段全拼接。
- `merge_lww` / `diff_lww` / `LwwEntry` trait：提示词、模板、文件夹共用（放本文件，folder_sync 引用）。
- 闪卡特例：
  - 内容按 `updated_at` 新者赢；
  - 调度字段（due/stability/difficulty/elapsed_days/scheduled_days/reps/lapses/state/last_review）按 `last_review` 晚者取——「电脑改正面、手机随后复习」两边都保留。
- 复习记录：按 `stable_id` 并集，只带最近 365 天。
- `build_*` / `merge_*` / `diff_*` / `apply_pulled_*`；卡片落库在笔记之后、复习记录之前。

### 5.4 DAO（追加到 `database/sync_content.rs`）

- `list_cards_for_sync(cutoff)`：联 `notes` 取 `note_uuid`，`is_deleted=0 OR updated_at>=cutoff`。
- `get_card_sync_ref` / `upsert_card_synced(entry, note_id, keep_local_schedule)`。
- `list_card_logs_for_sync(since)` / `insert_card_log_synced`。
- `list_prompts_for_sync` / `upsert_prompt_synced` / `list_note_templates_for_sync` / `upsert_note_template_synced`。
- `delete_synced_by_uuid` 表名映射：`prompt → prompt_templates`、`note_template → note_templates`。

### 5.5 测试

- 合并：正反面取新、调度取晚；只更新调度也会拉；旧内容不覆盖新内容。
- 记录：并集、过期（>365 天）丢弃、卡片不在本地时跳过。
- 模板：删除晚于编辑 → 删除赢；删除后又有编辑 → 编辑赢；远端独有墓碑不拉。
- 端到端双库：A 建卡/改模板 → manifest 合并 → B 落库；B 再算 manifest 无差异、预置模板不重复。

## 6. 兼容与回滚

- manifest 新字段全部 `serde(default)` + 空 Vec 不序列化：旧客户端读到忽略，不会报错；旧端写回时丢字段，新端下次同步会重新补齐。
- schema 迁移全部为加列/加索引/加触发器，不改旧列；升级前有 `before-upgrade` 备份（S0-3）。
- 旧版应用打开新库 → `SchemaTooNew`，S0-3 后不会被误判为损坏、不会被 `quarantine`。
- 文件夹首次配对解决「各端各有一份同名文件夹」；配对是幂等的。
- 关闭功能没有开关：同步是可选中后端的行为，不选同步源时这些逻辑不跑。
- 回滚：代码回退后新列/新表无害；墓碑表可保留，旧代码不读。

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 挂载镜像文件夹被同步/墓碑 | `mount_id IS NULL` 过滤 + 墓碑触发器加条件（第 4.1 节） |
| 文件夹改名与笔记路径错位 | 笔记条目带 `folder_uuid`，拉取优先按 uuid 找；路径只作兜底 |
| 双端同时移动文件夹 | `folder_moved_at` LWW；成环改放根层 |
| 闪卡两端同时改/复习 | 内容与调度分开取新，测试覆盖 |
| 复习记录无限增长 | 365 天保留窗口 |
| 升级备份占用磁盘 | 只留 2 份；备份失败才阻断升级 |
| 恢复流程误杀好库 | 只认 SQLite 明确损坏码；IO/版本过高不恢复 |
| 数据目录目标已有库被覆盖 | 默认拒绝 + 显式替换 + 整组留档 + 临时文件改名 |
| WAL 未落盘的库备份为空 | 只读连接 `VACUUM INTO`，退化时连 `-wal` 一起复制 |
| 旧端不认识新字段 | `serde(default)` + 空不序列化；双端收敛测试 |
| Win7 | 无新 crate；SQLite 触发器与 uuid 表达式可用；随构建验证 |

## 8. 测试矩阵与验收门禁

```bash
cd src-tauri && cargo check && cargo test --lib
npx tsc --noEmit
pnpm test
pnpm build
```

- 每个 schema 迁移单独测试：幂等、旧库升级、坏行不阻断。
- 同步：manifest 兼容（旧字段缺失）、双库收敛、墓碑 30 天窗口、文件夹首次配对。
- 数据安全：备份含 WAL、迁移失败库哈希不变、目标有库拒绝/确认后留档、空库孤儿清理拦截。
- 手工回归：两台设备（或 local 后端模拟）各建同名文件夹、空文件夹、改名、移动笔记、删文件夹；闪卡两端改内容/复习后合并。

## 9. 实施顺序

| 顺序 | 批次 | 理由 |
|------|------|------|
| 1 | S0-1 资产备份 3 份 | 一行常量 + 测试，风险最低 |
| 2 | S0-4 导入备份含 WAL | 独立函数，先堵「备份空壳」 |
| 3 | S0-2 数据目录不覆盖 | 入口 + 命令 + UI，改动面较大但独立 |
| 4 | S0-3 升级不换库 | 接线 + 收紧恢复条件，发布前必须完成 |
| 5 | S0-5 孤儿清理保护 | 可跟随 S0 一起发 |
| 6 | S1 文件夹同步（schema 91） | 先建墓碑表与文件夹同步列 |
| 7 | S2 内容同步（schema 92） | 复用墓碑表与 LWW 工具 |

每批独立提交，commit message 附 `[scope: data-safety]` / `[scope: sync]`，便于分批回滚。
