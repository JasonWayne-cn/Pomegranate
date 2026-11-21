import { lazy, Suspense } from "react";
import { Modal, Spin } from "antd";

/** 搜索页内涵较重（虚拟滚动 / 日期选择器 / 移动端分支），只在首次打开弹窗时加载 */
const DesktopSearchPage = lazy(() =>
  import("@/pages/search").then((m) => ({ default: m.DesktopSearchPage })),
);

interface Props {
  open: boolean;
  /** 打开时带入的关键词（可为空，用户在弹窗里继续输入） */
  initialQuery?: string;
  onClose: () => void;
}

/**
 * 首页搜索模态窗。
 *
 * 搜索不再占用 ActivityBar / 独立页面：首页回车或点「搜索记录」在这里展开。
 * 内容复用 DesktopSearchPage 的 embedded 模式 —— 不读写 URL，Tab 用本地状态，
 * 结果点击仍走应用内路由（跳转后首页卸载，弹窗自动关闭）。
 */
export function SearchModal({ open, initialQuery = "", onClose }: Props) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnClose
      title="搜索"
      styles={{ body: { maxHeight: "72vh", overflowY: "auto" } }}
    >
      {open && (
        <Suspense
          fallback={
            <div className="flex justify-center py-12">
              <Spin />
            </div>
          }
        >
          <DesktopSearchPage embedded initialQuery={initialQuery} />
        </Suspense>
      )}
    </Modal>
  );
}
