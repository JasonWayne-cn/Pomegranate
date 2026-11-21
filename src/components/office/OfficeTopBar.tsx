/** Office 工作台顶栏：文件信息、保存状态、撤销/重做与文件操作。 */
import { Button, Space, Tag, Tooltip, theme as antdTheme } from "antd";
import {
  ArrowLeft,
  ExternalLink,
  Redo2,
  Save,
  SaveAll,
  Undo2,
} from "lucide-react";
import { FORMAT_LABEL } from "@/lib/office/formats";
import type { OfficeSessionMeta } from "@/store/office";

interface OfficeTopBarProps {
  session: OfficeSessionMeta | null;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  onBack: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExternal: () => void;
}

function saveStateTag(session: OfficeSessionMeta): { text: string; color: string } {
  if (session.status === "loading") return { text: "打开中", color: "processing" };
  if (session.status === "error") return { text: "打开失败", color: "error" };
  if (session.saving) return { text: "保存中", color: "processing" };
  if (session.dirty) return { text: "未保存", color: "warning" };
  return { text: "已保存", color: "success" };
}

export function OfficeTopBar({
  session,
  canUndo,
  canRedo,
  busy,
  onBack,
  onSave,
  onSaveAs,
  onUndo,
  onRedo,
  onExternal,
}: OfficeTopBarProps) {
  const { token } = antdTheme.useToken();
  const state = session ? saveStateTag(session) : null;
  const editable =
    session &&
    session.status === "ready" &&
    !session.readOnly &&
    (session.format === "pptx" || session.format === "docx");
  const hasHistory =
    session?.format === "pptx" || session?.format === "docx" || session?.format === "xlsx";

  return (
    <div
      className="flex h-12 shrink-0 items-center gap-3 px-3"
      style={{
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Button icon={<ArrowLeft size={16} />} onClick={onBack}>
        返回
      </Button>

      {session ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={session.path}>
            {session.name}
          </span>
          <Tag className="m-0">{FORMAT_LABEL[session.format]}</Tag>
          {session.readOnly && (
            <Tag className="m-0" color="default">
              只读挂载
            </Tag>
          )}
          {state && (
            <Tag className="m-0" color={state.color}>
              {state.text}
            </Tag>
          )}
        </div>
      ) : (
        <span className="text-sm" style={{ color: token.colorTextSecondary }}>
          Office 工作台
        </span>
      )}

      <div className="flex-1" />

      {session && (
        <Space size={4}>
          {hasHistory && (
            <>
              <Tooltip title="撤销 (Ctrl+Z)">
                <Button
                  icon={<Undo2 size={16} />}
                  disabled={!canUndo || busy}
                  onClick={onUndo}
                />
              </Tooltip>
              <Tooltip title="重做 (Ctrl+Y)">
                <Button
                  icon={<Redo2 size={16} />}
                  disabled={!canRedo || busy}
                  onClick={onRedo}
                />
              </Tooltip>
            </>
          )}
          <Tooltip title={session.readOnly ? "只读挂载，无法保存" : "保存 (Ctrl+S)"}>
            <Button
              type="primary"
              icon={<Save size={16} />}
              loading={session.saving}
              disabled={!editable || session.status !== "ready"}
              onClick={onSave}
            >
              保存
            </Button>
          </Tooltip>
          <Tooltip
            title={session.readOnly ? "只读挂载，无法另存为" : "另存为 (Ctrl+Shift+S)"}
          >
            <Button
              icon={<SaveAll size={16} />}
              disabled={!editable || session.status !== "ready"}
              onClick={onSaveAs}
            >
              另存为
            </Button>
          </Tooltip>
          <Tooltip title="用系统默认程序打开">
            <Button icon={<ExternalLink size={16} />} onClick={onExternal} />
          </Tooltip>
        </Space>
      )}
    </div>
  );
}
