/**
 * R-005b 专用打印窗口。
 *
 * 由 Rust `open_print_window` 创建，窗口 label 形如 `print-<ts>`，URL 是
 * `index.html#/print`。打印流程：
 *   1. 通过命令拿到本窗口对应的自包含 HTML 字符串
 *   2. 用 `srcdoc` 渲染到同源 iframe（不能用 asset 文件 URL：跨源无法调 print）
 *   3. iframe 就绪后自动拉起一次打印对话框，工具栏「打印」可再次触发
 *   4. afterprint 触发后清理临时文件并关窗；未触发则保留窗口供手动关闭
 *
 * 关键：window.print() 会阻塞所在渲染进程，所以打印必须发生在独立窗口里；
 * 主窗口只负责准备 HTML，不会被阻塞。
 */
import { useEffect, useRef, useState } from "react";
import { Button, Spin } from "antd";
import { Printer, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exportApi } from "@/lib/api";

const TOOLBAR_HEIGHT = 44;

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

export default function PrintPage() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const finishedRef = useRef(false);
  const autoPrintedRef = useRef(false);
  const [html, setHtml] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = currentLabel();

  useEffect(() => {
    if (!label.startsWith("print-")) {
      setError("此页面仅用于打印");
      return;
    }
    getCurrentWindow()
      .title()
      .then(setTitle)
      .catch(() => undefined);
    exportApi
      .printPageHtml(label)
      .then(setHtml)
      .catch((e) => setError(String(e)));
  }, [label]);

  async function finish() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try {
      await exportApi.printPageDone(label);
    } catch {
      /* 清理失败不阻断关窗（窗口销毁时 Rust 侧还会再清一次） */
    }
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }

  function doPrint() {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      win.focus();
      win.print();
    } catch (e) {
      setError(String(e));
    }
  }

  function handleFrameLoad() {
    const win = frameRef.current?.contentWindow;
    if (win) {
      const onAfterPrint = () => {
        win.removeEventListener("afterprint", onAfterPrint);
        setTimeout(() => void finish(), 500);
      };
      win.addEventListener("afterprint", onAfterPrint);
    }
    if (autoPrintedRef.current) return;
    autoPrintedRef.current = true;
    // 留一帧让 iframe 完成布局，再自动拉起一次打印对话框
    setTimeout(doPrint, 400);
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#f5f5f5",
      }}
    >
      <div
        style={{
          height: TOOLBAR_HEIGHT,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          background: "#fff",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            color: "#555",
          }}
        >
          {title || "打印预览"}
        </span>
        <Button
          type="primary"
          size="small"
          icon={<Printer size={14} />}
          disabled={!html}
          onClick={doPrint}
        >
          打印
        </Button>
        <Button
          size="small"
          icon={<X size={14} />}
          onClick={() => void finish()}
        >
          关闭
        </Button>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {error ? (
          <div style={{ padding: 24, fontSize: 14 }}>打印失败：{error}</div>
        ) : !html ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Spin />
          </div>
        ) : (
          <iframe
            ref={frameRef}
            srcDoc={html}
            onLoad={handleFrameLoad}
            title="打印内容"
            style={{
              width: "100%",
              height: "100%",
              border: 0,
              background: "#fff",
            }}
          />
        )}
      </div>
    </div>
  );
}
