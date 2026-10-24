import { useEffect, useState } from "react";
import { Empty, Skeleton, theme as antdTheme, Typography } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadModuleHelp } from "@/modules/helpLoader";
import type { ModuleMeta } from "@/modules/types";

const { Text } = Typography;

interface Props {
  meta: ModuleMeta;
}

/**
 * 模块使用说明。
 *
 * 内容为随应用打包的 Markdown，按需加载；不启用 rehype-raw，
 * 避免说明文件里的原始 HTML 被当作可执行内容渲染。
 */
export function ModuleHelpPanel({ meta }: Props) {
  const { token } = antdTheme.useToken();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setContent(null);

    loadModuleHelp(meta.helpFile)
      .then((text) => {
        if (alive) setContent(text);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [meta.helpFile]);

  if (loading) {
    return (
      <div style={{ padding: "20px 24px" }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (!content) {
    return (
      <div style={{ padding: 32 }}>
        <Empty
          description={
            <span>
              「{meta.label}」的使用说明正在整理中
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                可先查看全局设置或快捷键面板
              </Text>
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="module-help-scroll"
      style={{
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        padding: "20px 24px 32px",
        color: token.colorText,
      }}
    >
      <div className="ai-markdown module-help-md" style={{ maxWidth: 680 }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
