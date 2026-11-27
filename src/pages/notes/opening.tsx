import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Skeleton, Typography, message } from "antd";
import { FileText } from "lucide-react";
import { importApi } from "@/lib/api";
import { useAppStore } from "@/store";

const { Text } = Typography;

/**
 * 外部 .md 打开中间页（shell-first）。
 *
 * 打开外部 Markdown（双击文件 / 「打开 md」/ 系统单实例转交）时先跳到这里渲染
 * 文档外壳，再异步 `open_markdown_file`（可能含图片下载、去重扫描）。导入完成后
 * `replace` 到真实文档，避免"点开文件后白屏几秒"的观感。
 */
export default function OpeningNotePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const path = searchParams.get("path");
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      navigate("/notes", { replace: true });
      return;
    }
    // 同一路径只启动一次；不同路径（再次打开另一个文件）允许重新导入
    if (startedRef.current === path) return;
    startedRef.current = path;

    let cancelled = false;
    (async () => {
      try {
        const result = await importApi.openMarkdownFile(path);
        if (cancelled) return;
        if (result.wasSynced) {
          message.info("已根据最新 md 文件同步文档内容");
        }
        useAppStore.getState().bumpNotesRefresh();
        navigate(`/notes/${result.noteId}`, { replace: true });
      } catch (e) {
        if (cancelled) return;
        message.error(`打开失败: ${e}`);
        navigate("/notes", { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, navigate]);

  // useSearchParams 已解码，不能再 decodeURIComponent（文件名含 % 会抛 URIError）
  const fileName = path
    ? path.split(/[\\/]/).pop() || path
    : "外部文档";

  return (
    <div className="mx-auto w-full" style={{ maxWidth: "56rem", padding: "24px 48px" }}>
      <div
        className="flex items-center gap-2"
        style={{ marginBottom: 16, color: "var(--kb-text-secondary)" }}
      >
        <FileText size={16} />
        <Text type="secondary">正在打开 {fileName}…</Text>
      </div>
      <Skeleton active title={{ width: "40%" }} paragraph={{ rows: 6 }} />
      <div style={{ marginTop: 16 }}>
        <Button size="small" onClick={() => navigate("/notes", { replace: true })}>
          返回文档列表
        </Button>
      </div>
    </div>
  );
}
