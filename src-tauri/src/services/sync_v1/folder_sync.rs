//! 文件夹树的 manifest 构建、合并、对比与拉取落库。
//!
//! 以前文件夹只靠笔记条目带的路径在对端补建：空文件夹传不过去，改名 / 删除 / 排序
//! 也传不过去。现在整棵树单独进 manifest，规则同提示词：按 stable_id outer-join，
//! `updated_at` 新者赢，删除靠 tombstone 传播。
//!
//! 存量文件夹是各端各自建的，stable_uuid 对不上：升级后第一次同步先按「同一父级 + 同名」
//! 配对，否则每个文件夹都会在对端多出一份。

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use super::manifest::TOMBSTONE_RETENTION_DAYS;
use crate::database::sync_content::{FolderSyncRow, TOMBSTONE_KIND_FOLDER};
use crate::database::Database;
use crate::error::AppError;
use crate::models::{FolderManifestEntry, SyncPullResult};

fn tombstone_cutoff() -> String {
    (chrono::Local::now() - chrono::Duration::days(TOMBSTONE_RETENTION_DAYS))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

pub fn folder_content_hash(f: &FolderManifestEntry) -> String {
    let mut h = Sha256::new();
    for part in [
        f.name.as_str(),
        f.parent_stable_id.as_deref().unwrap_or(""),
        &f.sort_order.to_string(),
        f.color.as_deref().unwrap_or(""),
        if f.tombstone { "1" } else { "0" },
    ] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

pub fn build_folder_entries(db: &Database) -> Result<Vec<FolderManifestEntry>, AppError> {
    let mut out = db.list_folders_for_sync()?;
    let live: HashSet<String> = out.iter().map(|f| f.stable_id.clone()).collect();
    for (uuid, deleted_at) in
        db.list_sync_tombstones(TOMBSTONE_KIND_FOLDER, &tombstone_cutoff())?
    {
        if live.contains(&uuid) {
            continue; // 删了又从远端拉回来过，以现存行为准
        }
        out.push(FolderManifestEntry {
            stable_id: uuid,
            content_hash: String::new(),
            updated_at: deleted_at,
            name: String::new(),
            parent_stable_id: None,
            sort_order: 0,
            color: None,
            tombstone: true,
        });
    }
    for f in &mut out {
        f.content_hash = folder_content_hash(f);
    }
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    Ok(out)
}

pub fn merge_folders(
    local: &[FolderManifestEntry],
    remote: &[FolderManifestEntry],
) -> Vec<FolderManifestEntry> {
    let cutoff = tombstone_cutoff();
    let mut map: HashMap<String, FolderManifestEntry> =
        local.iter().map(|e| (e.stable_id.clone(), e.clone())).collect();
    for re in remote {
        match map.get(&re.stable_id) {
            Some(le) if le.updated_at >= re.updated_at => {}
            _ => {
                map.insert(re.stable_id.clone(), re.clone());
            }
        }
    }
    let mut out: Vec<_> = map
        .into_values()
        .filter(|e| !e.tombstone || e.updated_at >= cutoff)
        .collect();
    out.sort_by(|a, b| a.stable_id.cmp(&b.stable_id));
    out
}

/// 要拉的条目：远端独有且不是 tombstone，或双方都有、指纹不同且远端更新
pub fn diff_folders(
    local: &[FolderManifestEntry],
    remote: &[FolderManifestEntry],
) -> Vec<FolderManifestEntry> {
    let local_map: HashMap<&str, &FolderManifestEntry> =
        local.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    remote
        .iter()
        .filter(|re| match local_map.get(re.stable_id.as_str()) {
            None => !re.tombstone,
            Some(le) => le.content_hash != re.content_hash && re.updated_at > le.updated_at,
        })
        .cloned()
        .collect()
}

/// 父级排在子级前面（按父子链算深度；父级不在这批里的算根层）。链上有环时截断。
fn parents_first(entries: &[FolderManifestEntry]) -> Vec<&FolderManifestEntry> {
    let by_id: HashMap<&str, &FolderManifestEntry> =
        entries.iter().map(|e| (e.stable_id.as_str(), e)).collect();
    let depth = |e: &FolderManifestEntry| {
        let mut d = 0usize;
        let mut cur = e.parent_stable_id.as_deref();
        while let Some(p) = cur {
            match by_id.get(p) {
                Some(pe) if d < entries.len() => {
                    d += 1;
                    cur = pe.parent_stable_id.as_deref();
                }
                _ => break,
            }
        }
        d
    };
    let mut out: Vec<(usize, &FolderManifestEntry)> =
        entries.iter().map(|e| (depth(e), e)).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.stable_id.cmp(&b.1.stable_id)));
    out.into_iter().map(|(_, e)| e).collect()
}

/// 算出本地哪些文件夹要改用远端的 stable_uuid：`(本地 id, 远端 stable_uuid)`。
fn plan_folder_adoption(
    local_rows: &[FolderSyncRow],
    remote: &[FolderManifestEntry],
) -> Vec<(i64, String)> {
    let remote_ids: HashSet<&str> = remote.iter().map(|e| e.stable_id.as_str()).collect();
    let local_by_uuid: HashMap<&str, i64> = local_rows
        .iter()
        .filter_map(|(id, uuid, _, _)| uuid.as_deref().map(|u| (u, *id)))
        .collect();
    let mut mapped: HashMap<String, i64> = remote
        .iter()
        .filter_map(|e| {
            local_by_uuid
                .get(e.stable_id.as_str())
                .map(|id| (e.stable_id.clone(), *id))
        })
        .collect();
    let mut claimed: HashSet<i64> = mapped.values().copied().collect();
    let mut plan = Vec::new();

    let alive: Vec<FolderManifestEntry> = remote.iter().filter(|e| !e.tombstone).cloned().collect();
    for re in parents_first(&alive) {
        if mapped.contains_key(&re.stable_id) {
            continue;
        }
        let parent_local: Option<i64> = match re.parent_stable_id.as_deref() {
            None => None,
            Some(pu) => match mapped.get(pu) {
                Some(id) => Some(*id),
                None => continue,
            },
        };
        let candidate = local_rows
            .iter()
            .filter(|(id, uuid, parent, name)| {
                *parent == parent_local
                    && *name == re.name
                    && !claimed.contains(id)
                    && !uuid
                        .as_deref()
                        .is_some_and(|u| remote_ids.contains(u))
            })
            .map(|(id, _, _, _)| *id)
            .min();
        if let Some(id) = candidate {
            plan.push((id, re.stable_id.clone()));
            mapped.insert(re.stable_id.clone(), id);
            claimed.insert(id);
        }
    }
    plan
}

/// 首次同步配对：把本地与远端「同一父级 + 同名」的文件夹改用远端 uuid。返回改了几个。
pub fn adopt_remote_folder_ids(
    db: &Database,
    remote: &[FolderManifestEntry],
) -> Result<usize, AppError> {
    if remote.is_empty() {
        return Ok(0);
    }
    let plan = plan_folder_adoption(&db.list_folder_sync_rows()?, remote);
    for (id, uuid) in &plan {
        db.set_folder_stable_uuid(*id, uuid)?;
    }
    if !plan.is_empty() {
        log::info!(
            "[sync_v1] 首次同步配对：{} 个文件夹改用远端的 stable_uuid",
            plan.len()
        );
    }
    Ok(plan.len())
}

/// 拉取落库。要在笔记之前跑：笔记按 `folder_uuid` 找文件夹，找不到才按路径补建。
/// 先建 / 改（父级在前），再删。
pub fn apply_pulled_folders(
    db: &Database,
    entries: &[FolderManifestEntry],
    result: &mut SyncPullResult,
) {
    let (dead, alive): (Vec<_>, Vec<_>) = entries.iter().cloned().partition(|e| e.tombstone);
    for e in parents_first(&alive) {
        let parent_id = match e.parent_stable_id.as_deref() {
            None => None,
            Some(pu) => match db.get_folder_id_by_stable_uuid(pu) {
                Ok(Some(id)) => Some(id),
                Ok(None) => {
                    log::warn!("[sync_v1] 文件夹「{}」的父级本地不存在，先放根层", e.name);
                    None
                }
                Err(err) => {
                    result
                        .errors
                        .push(format!("查文件夹 {} 的父级失败: {}", e.name, err));
                    continue;
                }
            },
        };
        if let Err(err) = db.upsert_folder_synced(&e, parent_id) {
            result
                .errors
                .push(format!("同步文件夹 {} 失败: {}", e.name, err));
        }
    }
    for e in &dead {
        if let Err(err) = db.delete_folder_synced(&e.stable_id, &e.updated_at) {
            result
                .errors
                .push(format!("同步删除文件夹失败: {}", err));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: &str, name: &str, parent: Option<&str>, updated: &str) -> FolderManifestEntry {
        let mut f = FolderManifestEntry {
            stable_id: id.into(),
            content_hash: String::new(),
            updated_at: updated.into(),
            name: name.into(),
            parent_stable_id: parent.map(String::from),
            sort_order: 0,
            color: None,
            tombstone: false,
        };
        f.content_hash = folder_content_hash(&f);
        f
    }

    fn tombstone(id: &str, deleted_at: &str) -> FolderManifestEntry {
        let mut f = folder(id, "", None, deleted_at);
        f.tombstone = true;
        f.content_hash = folder_content_hash(&f);
        f
    }

    fn row(id: i64, uuid: &str, parent: Option<i64>, name: &str) -> FolderSyncRow {
        (id, Some(uuid.into()), parent, name.into())
    }

    #[test]
    fn adoption_pairs_same_name_same_parent_top_down() {
        let local = vec![row(1, "l-work", None, "工作"), row(2, "l-week", Some(1), "周报")];
        let remote = vec![
            folder("r-week", "周报", Some("r-work"), "2026-11-01 00:00:00"),
            folder("r-work", "工作", None, "2026-11-01 00:00:00"),
        ];
        let plan = plan_folder_adoption(&local, &remote);
        assert_eq!(
            plan,
            vec![(1, "r-work".to_string()), (2, "r-week".to_string())]
        );
    }

    #[test]
    fn diff_pulls_newer_rename_and_newer_tombstone_only() {
        let local = vec![
            folder("a", "旧名", None, "2026-11-01 10:00:00"),
            folder("b", "B", None, "2026-11-05 10:00:00"),
            folder("c", "C", None, "2026-11-01 10:00:00"),
        ];
        let remote = vec![
            folder("a", "新名", None, "2026-11-02 10:00:00"),
            tombstone("b", "2026-11-03 10:00:00"),
            tombstone("c", "2026-11-03 10:00:00"),
            folder("d", "空文件夹", None, "2026-11-01 10:00:00"),
        ];
        let mut ids: Vec<String> = diff_folders(&local, &remote)
            .into_iter()
            .map(|f| f.stable_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "c", "d"]);
    }

    #[test]
    fn apply_creates_tree_renames_and_deletes_without_losing_notes() {
        let db = Database::init(":memory:").unwrap();
        let mut result = SyncPullResult::default();
        apply_pulled_folders(
            &db,
            &[
                folder("r-week", "周报", Some("r-work"), "2026-11-01 00:00:00"),
                folder("r-work", "工作", None, "2026-11-01 00:00:00"),
                folder("r-empty", "空文件夹", None, "2026-11-01 00:00:00"),
            ],
            &mut result,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let work = db.get_folder_id_by_stable_uuid("r-work").unwrap().unwrap();
        let week = db.get_folder_id_by_stable_uuid("r-week").unwrap().unwrap();

        db.conn_lock()
            .unwrap()
            .execute(
                "INSERT INTO notes (title, content, folder_id) VALUES ('周报一', '', ?1)",
                rusqlite::params![week],
            )
            .unwrap();
        apply_pulled_folders(
            &db,
            &[
                folder("r-work", "工作（改名）", None, "2026-11-02 00:00:00"),
                tombstone("r-week", "2026-11-02 00:00:00"),
            ],
            &mut result,
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let name: String = db
            .conn_lock()
            .unwrap()
            .query_row(
                "SELECT name FROM folders WHERE id = ?1",
                rusqlite::params![work],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "工作（改名）");
        assert!(db.get_folder_id_by_stable_uuid("r-week").unwrap().is_none());
        let folder_null: i64 = db
            .conn_lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title = '周报一' AND folder_id IS NULL AND is_deleted = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folder_null, 1, "删除文件夹不删笔记，移到未分类");
    }

    #[test]
    fn mount_folders_are_never_in_manifest_nor_tombstoned() {
        let db = Database::init(":memory:").unwrap();
        // 造一个挂载点 + 镜像文件夹
        db.conn_lock()
            .unwrap()
            .execute(
                "INSERT INTO external_mounts (name, root_path) VALUES ('m', 'C:/x')",
                [],
            )
            .unwrap();
        let mount_id = db.conn_lock().unwrap().last_insert_rowid();
        db.conn_lock()
            .unwrap()
            .execute(
                "INSERT INTO folders (name, mount_id) VALUES ('镜像', ?1)",
                rusqlite::params![mount_id],
            )
            .unwrap();
        let mirror_id = db.conn_lock().unwrap().last_insert_rowid();

        let entries = build_folder_entries(&db).unwrap();
        assert!(entries.iter().all(|e| e.name != "镜像"), "镜像文件夹不进 manifest");

        db.conn_lock()
            .unwrap()
            .execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![mirror_id])
            .unwrap();
        let tombstones = db
            .list_sync_tombstones(TOMBSTONE_KIND_FOLDER, "2000-01-01 00:00:00")
            .unwrap();
        assert!(tombstones.is_empty(), "挂载镜像文件夹不写墓碑: {tombstones:?}");
    }

    #[test]
    fn parents_first_orders_by_depth_and_survives_cycles() {
        let entries = vec![
            folder("c", "C", Some("b"), "t"),
            folder("b", "B", Some("a"), "t"),
            folder("a", "A", None, "t"),
            folder("x", "X", Some("y"), "t"),
            folder("y", "Y", Some("x"), "t"),
        ];
        let order: Vec<&str> = parents_first(&entries).iter().map(|e| e.stable_id.as_str()).collect();
        let pos = |id: &str| order.iter().position(|o| *o == id).unwrap();
        assert!(pos("a") < pos("b") && pos("b") < pos("c"));
        assert_eq!(order.len(), 5);
    }
}
