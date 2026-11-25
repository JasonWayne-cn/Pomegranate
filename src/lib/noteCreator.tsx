/**
 * 文档创建 / 导入统一入口 —— 从旧 CreateNoteModal 拆出来的公共函数，
 * 让"+ 新建文档"按钮能直接调用，不必再走 Tab 选择的 Modal 流程。
 */
import { List, Modal, Typography, message } from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { NavigateFunction } from "react-router-dom";

import { noteApi, whiteboardApi, importApi, pdfApi, sourceFileApi, tagApi, folderApi } from "./api";
import { importWordFiles } from "./wordImport";
import { useAppStore } from "@/store";

/**
 * 导入完成后的统一跳转规则（业界 Bear / Apple Notes / VS Code 路线）：
 *   · 1 篇新建            → 直开编辑器
 *   · 0 新建 + 1 命中已有 → 跳那篇已有的（"我导入是为了打开它"）
 *   · ≥ 2 篇              → 跳文档列表（默认时间倒序，新导入在顶部）
 *   · 全失败/全跳过       → 留在原地，让 message/Modal 提示就够
 *
 * navigate 可选：调用方不传就静默不跳，兼容旧用法（少数地方还没接 router）。
 */
function navigateAfterImport(
  navigate: NavigateFunction | undefined,
  newIds: number[],
  existingIds: number[],
): void {
  if (!navigate) return;
  const total = newIds.length + existingIds.length;
  if (total === 0) return;
  if (total === 1) {
    const only = newIds[0] ?? existingIds[0];
    if (only != null) navigate(`/notes/${only}`);
    return;
  }
  navigate("/notes");
}

/** 未命名文档标题，带时间戳避免同名堆叠时难区分 */
function untitledTitle(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `未命名文档 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 创建一篇空白文档并跳转到编辑器。用户想写就写，不想保留可直接删除。
 *
 * `opts.useDefaults`：true 时套用全局"默认文件夹/默认标签"偏好——仅在
 * 调用方完全没有文件夹上下文时（顶部新建按钮、Ctrl+N、托盘"新建文档"等）
 * 才传 true。文件夹右键 / ?folder=X 等已声明 folderId 的入口保持 false，
 * 不被默认覆盖。套用后给 toast 提示，方便用户感知"是否吃到默认"。
 */
export async function createBlankAndOpen(
  folderId: number | null,
  navigate: NavigateFunction,
  opts?: { useDefaults?: boolean },
): Promise<void> {
  try {
    let finalFolderId = folderId;
    let appliedTagIds: number[] = [];
    let appliedFolderName: string | null = null;
    let appliedTagNames: string[] = [];

    if (opts?.useDefaults && folderId == null) {
      const { defaultFolderId, defaultTagIds } = useAppStore.getState();
      if (defaultFolderId != null) {
        finalFolderId = defaultFolderId;
        // 拉一下文件夹名给 toast 用；失败不影响创建
        try {
          const allFolders = await folderApi.list();
          appliedFolderName =
            findFolderName(allFolders, defaultFolderId) ?? null;
        } catch {
          /* ignore */
        }
      }
      if (defaultTagIds.length > 0) {
        appliedTagIds = defaultTagIds;
        try {
          const allTags = await tagApi.list();
          appliedTagNames = defaultTagIds
            .map((id) => allTags.find((t) => t.id === id)?.name)
            .filter((n): n is string => !!n);
        } catch {
          /* ignore */
        }
      }
    }

    const note = await noteApi.create({
      title: untitledTitle(),
      content: "",
      folder_id: finalFolderId,
    });

    // 套用默认标签：循环 addToNote（避免改动 noteApi.create 签名波及其他调用方）
    if (appliedTagIds.length > 0) {
      await Promise.all(
        appliedTagIds.map((tid) =>
          tagApi.addToNote(note.id, tid).catch((e) => {
            console.warn(`套用默认标签 ${tid} 失败:`, e);
          }),
        ),
      );
    }

    useAppStore.getState().bumpNotesRefresh();
    navigate(`/notes/${note.id}`);

    // 反馈：让用户知道默认有没有生效
    if (appliedFolderName || appliedTagNames.length > 0) {
      const parts: string[] = [];
      if (appliedFolderName) parts.push(`文件夹「${appliedFolderName}」`);
      if (appliedTagNames.length > 0) {
        parts.push(`标签 ${appliedTagNames.map((n) => `「${n}」`).join("、")}`);
      }
      message.success(`已新建文档 · 默认套用 ${parts.join(" + ")}`, 3);
    }
  } catch (e) {
    message.error(String(e));
  }
}

/**
 * 创建一块空白整页白板并跳转画布。
 *
 * 白板本质是 `note_type='whiteboard'` 的文档，创建后走 `/whiteboard/:id`；
 * 与新建空白文档共用"刷新列表 + 直达目标"的行为。
 */
export async function createWhiteboardAndOpen(
  folderId: number | null,
  navigate: NavigateFunction,
): Promise<void> {
  try {
    const note = await whiteboardApi.create(undefined, folderId);
    useAppStore.getState().bumpNotesRefresh();
    navigate(`/whiteboard/${note.id}`);
  } catch (e) {
    message.error(`创建白板失败：${e}`);
  }
}

/**
 * 新建思维导图：本质是一篇普通文档（正文 = 嵌套列表），跳到编辑页时带上
 * `openMindMap: "edit"`，编辑页据此直接打开导图分栏并进入编辑模式。
 * 中心主题 = 标题，先给一个占位标题，用户在导图里双击中心主题就能改。
 *
 * 不套用"默认标签"偏好 —— 那个偏好是给文字文档设的，导图同样按需自行打标签。
 */
export async function createMindMapAndOpen(
  folderId: number | null,
  navigate: NavigateFunction,
): Promise<void> {
  try {
    const note = await noteApi.create({
      title: "新思维导图",
      content: "",
      folder_id: folderId,
    });
    useAppStore.getState().bumpNotesRefresh();
    navigate(`/notes/${note.id}`, { state: { openMindMap: "edit" } });
  } catch (e) {
    message.error(`新建思维导图失败：${e}`);
  }
}

/** 在文件夹树里按 id 找名字（深度优先） */
function findFolderName(
  folders: { id: number; name: string; children?: typeof folders }[],
  id: number,
): string | null {
  for (const f of folders) {
    if (f.id === id) return f.name;
    if (f.children) {
      const r = findFolderName(f.children, id);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 文本文档导入流程（同质合并版）：md / markdown / txt 共用一条通路。
 *
 * 后端 `import_selected_files` 已能识别这三种扩展名，并自动嗅探编码
 * （UTF-8 / GBK / GB18030 / Big5 等老 .txt 也能正确读出中文）。
 * 用户可一次混选不同扩展名的文件批量导入。
 */
export async function importTextFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const picked = await openDialog({
    multiple: true,
    filters: [
      { name: "Markdown / 纯文本", extensions: ["md", "markdown", "txt"] },
    ],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  const hide = message.loading(`正在导入 ${paths.length} 个文件...`, 0);
  try {
    const result = await importApi.importSelected(paths, folderId);
    hide();
    if (result.imported > 0) {
      let msg = `成功导入 ${result.imported} 篇`;
      if (result.skipped > 0) msg += `，跳过 ${result.skipped} 篇`;
      if (result.tags_attached && result.tags_attached > 0) {
        msg += `；自动关联 ${result.tags_attached} 条 frontmatter 标签`;
      }
      if (result.attachments_copied && result.attachments_copied > 0) {
        msg += `；复制 ${result.attachments_copied} 张图`;
      }
      const missCount = result.attachments_missing?.length ?? 0;
      if (missCount > 0) {
        msg += `（${missCount} 张图缺失，详见日志）`;
      }
      message.success(msg);
    } else if (result.skipped > 0) {
      message.warning(`全部 ${result.skipped} 篇已跳过`);
    }
    if (result.errors.length > 0) {
      Modal.warning({
        title: `${result.errors.length} 个文件导入失败`,
        content: (
          <List
            size="small"
            dataSource={result.errors}
            renderItem={(err) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {err}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    useAppStore.getState().bumpFoldersRefresh();
    navigateAfterImport(navigate, result.noteIds ?? [], result.existingNoteIds ?? []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}

/** PDF 导入流程 */
export async function importPdfsFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  const hide = message.loading(`正在导入 ${paths.length} 个 PDF...`, 0);
  try {
    const results = await pdfApi.importPdfs(paths, folderId);
    const ok = results.filter((r) => r.noteId !== null);
    const fail = results.filter((r) => r.noteId === null);
    const totalImages = ok.reduce((sum, r) => sum + r.imageCount, 0);
    const warnings = ok.flatMap((r) =>
      r.warnings.map(
        (w) => `${r.sourcePath.split(/[\\/]/).pop()}: ${w}`,
      ),
    );
    hide();
    if (ok.length > 0) {
      message.success(
        `成功导入 ${ok.length} 个 PDF${totalImages > 0 ? `，保留 ${totalImages} 张图片` : ""}`,
      );
    }
    if (fail.length > 0) {
      Modal.warning({
        title: `${fail.length} 个 PDF 导入失败`,
        content: (
          <List
            size="small"
            dataSource={fail}
            renderItem={(r) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    if (warnings.length > 0) {
      Modal.info({
        title: "PDF 导入提示",
        content: (
          <List
            size="small"
            dataSource={warnings}
            renderItem={(w) => (
              <List.Item>
                <Typography.Text style={{ fontSize: 12 }}>{w}</Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    const ids = ok.map((r) => r.noteId).filter((v): v is number => v != null);
    navigateAfterImport(navigate, ids, []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}

/** Word 导入流程：.doc 需本机装 LibreOffice / Office / WPS */
export async function importWordFlow(
  folderId: number | null,
  navigate?: NavigateFunction,
): Promise<void> {
  const converter = await sourceFileApi
    .getConverterStatus()
    .catch(() => "none" as const);
  const exts = converter === "none" ? ["docx"] : ["docx", "doc"];
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "Word", extensions: exts }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length === 0) return;
  if (
    converter === "none" &&
    paths.some((p) => p.toLowerCase().endsWith(".doc"))
  ) {
    Modal.warning({
      title: ".doc 暂不可用",
      content: "未检测到 LibreOffice 或 Microsoft Office / WPS。安装后可导入 .doc。",
    });
    return;
  }
  const hide = message.loading(`正在导入 ${paths.length} 个 Word 文件...`, 0);
  try {
    const results = await importWordFiles(paths, folderId);
    const ok = results.filter((r) => r.noteId !== null);
    const fail = results.filter((r) => r.noteId === null);
    hide();
    if (ok.length > 0) message.success(`成功导入 ${ok.length} 个 Word 文件`);
    if (fail.length > 0) {
      Modal.warning({
        title: `${fail.length} 个 Word 文件导入失败`,
        content: (
          <List
            size="small"
            dataSource={fail}
            renderItem={(r) => (
              <List.Item>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {r.sourcePath.split(/[\\/]/).pop()}: {r.error}
                </Typography.Text>
              </List.Item>
            )}
          />
        ),
      });
    }
    useAppStore.getState().bumpNotesRefresh();
    const ids = ok.map((r) => r.noteId).filter((v): v is number => v != null);
    navigateAfterImport(navigate, ids, []);
  } catch (e) {
    hide();
    message.error(`导入失败: ${e}`);
  }
}
