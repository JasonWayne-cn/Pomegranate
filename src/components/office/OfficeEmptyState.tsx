/** 工作台空状态：打开入口 + 最近文件。 */
import { Button, Empty, List, Tag, theme as antdTheme } from "antd";
import { FilePlus2, FolderOpen, X } from "lucide-react";
import { FORMAT_LABEL } from "@/lib/office/formats";
import type { RecentFile } from "@/store/office";

interface OfficeEmptyStateProps {
  recent: RecentFile[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  busy?: boolean;
}

export function OfficeEmptyState({
  recent,
  onOpen,
  onOpenRecent,
  onRemoveRecent,
  busy,
}: OfficeEmptyStateProps) {
  const { token } = antdTheme.useToken();

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg">
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

        {recent.length > 0 && (
          <div className="mt-8">
            <div
              className="mb-2 text-xs font-medium"
              style={{ color: token.colorTextSecondary }}
            >
              最近文件
            </div>
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
        )}
      </div>
    </div>
  );
}
