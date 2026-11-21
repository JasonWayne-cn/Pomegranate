/** 工作台空状态：打开入口 + 最近文件。 */
import { Button, Empty, List, Popconfirm, Tag, theme as antdTheme } from "antd";
import { FilePlus2, FolderOpen, Trash2, X } from "lucide-react";
import { FORMAT_LABEL } from "@/lib/office/formats";
import type { RecentFile } from "@/store/office";

interface OfficeEmptyStateProps {
  recent: RecentFile[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  /** 清空全部最近文件记录 */
  onClearRecent: () => void;
  busy?: boolean;
  /** 上次会话可恢复时展示的入口 */
  restorable?: {
    count: number;
    onRestore: () => void;
    onDismiss: () => void;
  } | null;
}

export function OfficeEmptyState({
  recent,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  onClearRecent,
  busy,
  restorable,
}: OfficeEmptyStateProps) {
  const { token } = antdTheme.useToken();

  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-hidden p-6">
      {/* 打开入口固定在顶部，不随最近文件列表增长被挤出可视区 */}
      <div className="w-full max-w-lg shrink-0">
        <Empty
          image={<FilePlus2 size={72} strokeWidth={1} color={token.colorTextQuaternary} />}
          description={
            <div className="space-y-1">
              <div className="text-base font-medium">打开一个 Office 文档</div>
              <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                支持 .pptx / .docx / .xlsx / .pdf，也可以把文件拖到窗口
              </div>
            </div>
          }
        >
          <Button type="primary" icon={<FolderOpen size={16} />} loading={busy} onClick={onOpen}>
            选择文件
          </Button>
        </Empty>

        {restorable && restorable.count > 0 && (
          <div
            className="mt-6 flex items-center justify-between rounded-lg border px-3 py-2"
            style={{ borderColor: token.colorBorderSecondary }}
          >
            <div className="text-sm">
              上次会话 · {restorable.count} 个文档
              <div className="text-[11px]" style={{ color: token.colorTextTertiary }}>
                恢复后会重新打开这些文件（未保存的修改不会保留）
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="small" onClick={restorable.onDismiss}>
                忽略
              </Button>
              <Button size="small" type="primary" loading={busy} onClick={restorable.onRestore}>
                恢复
              </Button>
            </div>
          </div>
        )}

      </div>

      {recent.length > 0 && (
        <div className="mt-6 flex min-h-0 w-full max-w-lg flex-1 flex-col">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <span
              className="text-xs font-medium"
              style={{ color: token.colorTextSecondary }}
            >
              最近文件
            </span>
            <Popconfirm
              title="清空所有最近文件记录？"
              description="只清除历史列表，不会删除磁盘上的文件。"
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={onClearRecent}
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<Trash2 size={12} />}
                style={{ fontSize: 12 }}
              >
                清空历史记录
              </Button>
            </Popconfirm>
          </div>
          {/* 历史列表独立滚动，避免长列表把顶部打开入口挤出窗口 */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <List
              size="small"
              dataSource={recent}
              renderItem={(item) => (
                <List.Item
                  className="cursor-pointer rounded px-2 hover:bg-black/5"
                  onClick={() => onOpenRecent(item.path)}
                  actions={[
                    <button
                      key="remove"
                      type="button"
                      aria-label={`从最近文件移除 ${item.name}`}
                      className="rounded p-1 opacity-50 hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveRecent(item.path);
                      }}
                    >
                      <X size={12} />
                    </button>,
                  ]}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Tag className="m-0 shrink-0">{FORMAT_LABEL[item.format]}</Tag>
                    <div className="min-w-0">
                      <div className="truncate text-sm">{item.name}</div>
                      <div
                        className="truncate text-[11px]"
                        style={{ color: token.colorTextTertiary }}
                      >
                        {item.path}
                      </div>
                    </div>
                  </div>
                </List.Item>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
