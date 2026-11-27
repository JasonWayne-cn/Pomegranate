import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Skeleton, Space, Tag, Typography, message } from "antd";
import { ArrowLeft, BookPlus, FileText, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Components } from "react-markdown";

import { MarkdownContent } from "@/components/ai/MarkdownContent";
import { importApi } from "@/lib/api";
import { useAppStore } from "@/store";
import type { MarkdownFilePreview } from "@/types";

import "@/styles/markdown-reader.css";

const { Text, Title } = Typography;

/**
 * 外部 Markdown「仅浏览」页（/notes/browse?path=...）。
 *
 * 只读读取磁盘文件并渲染，不创建文档、不写数据库、不修改原文件。
 * 用户改变主意时，可用「加入文档库」走正常导入流程。
 */
export default function BrowseNotePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const path = searchParams.get("path");

  const [preview, setPreview] = useState<MarkdownFilePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      setError("缺少文件路径");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    importApi
      .readPreview(path)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  async function handleAddToLibrary() {
    if (!preview || importing) return;
    setImporting(true);
    try {
      const result = await importApi.openMarkdownFile(preview.path);
      useAppStore.getState().bumpNotesRefresh();
      message.success("已加入文档库");
      navigate(`/notes/${result.noteId}`, { replace: true });
    } catch (e) {
      message.error(`加入文档库失败: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full" style={{ maxWidth: 880 }}>
        <div
          className="flex items-center gap-2"
          style={{ marginBottom: 16, color: "var(--kb-text-secondary)" }}
        >
          <FileText size={16} />
          <Text type="secondary">正在读取文件…</Text>
        </div>
        <Skeleton active title={{ width: "40%" }} paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="mx-auto w-full" style={{ maxWidth: 880 }}>
        <Alert
          type="error"
          showIcon
          message="无法打开文件"
          description={error ?? "未知错误"}
          style={{ marginBottom: 16 }}
        />
        <Space>
          <Button icon={<ArrowLeft size={14} />} onClick={() => navigate("/notes")}>
            返回文档列表
          </Button>
          {path && (
            <Button
              icon={<RefreshCw size={14} />}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              重试
            </Button>
          )}
        </Space>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full" style={{ maxWidth: 880 }}>
      <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 12 }}>
        <FileText size={20} style={{ color: "var(--kb-text-secondary)", flex: "none" }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <Title level={4} style={{ margin: 0 }}>
            {preview.title}
          </Title>
          <Text
            type="secondary"
            style={{ fontSize: 12, wordBreak: "break-all" }}
            ellipsis={{ tooltip: cleanDisplayPath(preview.path) }}
          >
            {cleanDisplayPath(preview.path)}
          </Text>
        </div>
        <Tag color="gold">只读浏览</Tag>
        <Space>
          <Button icon={<ArrowLeft size={14} />} onClick={() => navigate(-1)}>
            返回
          </Button>
          <Button
            type="primary"
            icon={<BookPlus size={14} />}
            loading={importing}
            onClick={handleAddToLibrary}
          >
            加入文档库
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="当前为只读预览，文件未加入文档库，内容修改不会被保存。"
      />

      <div className="md-reader-card">
        {preview.content.trim() ? (
          <div className="md-reader">
            <MarkdownContent components={components}>{preview.content}</MarkdownContent>
          </div>
        ) : (
          <Text type="secondary">（空文件）</Text>
        )}
      </div>
    </div>
  );
}

/** Windows canonicalize 会给路径加 `\\?\`（UNC 为 `\\?\UNC\`）前缀，显示时去掉 */
function cleanDisplayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`;
  }
  return path.replace(/^\\\\\?\\/, "");
}

/** 链接交给系统浏览器打开，避免 WebView 内部导航离开应用 */
const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (href && /^(https?:|mailto:)/i.test(href)) {
            event.preventDefault();
            void openUrl(href).catch((e) => message.error(`打开链接失败: ${e}`));
          }
        }}
      >
        {children}
      </a>
    );
  },
};
