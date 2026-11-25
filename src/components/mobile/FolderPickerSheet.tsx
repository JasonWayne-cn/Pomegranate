import { useEffect, useState } from "react";
import { Folder as FolderIcon, CornerUpLeft } from "lucide-react";
import { folderApi } from "@/lib/api";
import type { Folder } from "@/types";
import { MSheet } from "./MSheet";

/** 把文件夹树拍平成带层级的列表 */
function flatten(
  list: Folder[],
  depth = 0,
): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  for (const f of list) {
    out.push({ folder: f, depth });
    if (f.children?.length) out.push(...flatten(f.children, depth + 1));
  }
  return out;
}

export interface FolderPickerSheetProps {
  open: boolean;
  title?: string;
  /** 当前所在文件夹；null = 未分类/根 */
  currentFolderId?: number | null;
  onClose: () => void;
  onPick: (folderId: number | null) => void | Promise<void>;
}

/**
 * 移动端目录选择面板（移动笔记用）。
 * 打开时拉取最新目录树，避免与桌面端/其他页面的目录变更脱节。
 */
export function FolderPickerSheet({
  open,
  title = "移动到目录",
  currentFolderId = null,
  onClose,
  onPick,
}: FolderPickerSheetProps) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    folderApi
      .list()
      .then((list) => {
        if (alive) setFolders(list);
      })
      .catch(() => {
        if (alive) setFolders([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const flat = flatten(folders);

  async function pick(id: number | null) {
    await onPick(id);
    onClose();
  }

  return (
    <MSheet open={open} title={title} onClose={onClose} maxHeight="80vh">
      <div className="pb-2">
        <button
          onClick={() => void pick(null)}
          className={`flex w-full items-center gap-2 px-5 text-left active:bg-[var(--m-well)] ${
            currentFolderId == null ? "text-[var(--m-primary)]" : "text-[var(--m-ink-1)]"
          }`}
          style={{ minHeight: 52 }}
        >
          <CornerUpLeft size={16} />
          <span className="text-sm font-medium">根目录 / 未分类</span>
        </button>

        {loading ? (
          <div className="px-5 py-4 text-center text-xs text-[var(--m-ink-3)]">
            加载目录…
          </div>
        ) : flat.length === 0 ? (
          <div className="px-5 py-4 text-center text-xs text-[var(--m-ink-3)]">
            还没有文件夹
          </div>
        ) : (
          flat.map(({ folder, depth }) => {
            const active = currentFolderId === folder.id;
            return (
              <button
                key={folder.id}
                onClick={() => void pick(folder.id)}
                className={`flex w-full items-center gap-2 pr-4 text-left active:bg-[var(--m-well)] ${
                  active ? "text-[var(--m-primary)]" : "text-[var(--m-ink-1)]"
                }`}
                style={{ minHeight: 52, paddingLeft: 20 + depth * 16 }}
              >
                <FolderIcon size={16} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate text-sm">{folder.name}</span>
                {folder.note_count > 0 && (
                  <span className="text-[11px] text-[var(--m-ink-3)]">
                    {folder.note_count}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </MSheet>
  );
}
