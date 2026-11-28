import { useEffect, useState } from "react";
import { Button, Typography } from "antd";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { pluginManager } from "@/services/pluginManager";

const { Text } = Typography;

/** 插件运行时错误日志（无错误时不渲染）。 */
export function PluginErrorLog() {
  const [logs, setLogs] = useState<
    ReturnType<typeof pluginManager.getErrorLog>
  >([]);

  const refresh = () => setLogs(pluginManager.getErrorLog());

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  if (logs.length === 0) return null;

  type LogEntry = {
    pluginId: string;
    time: string;
    kind: string;
    message: string;
  };
  const byPlugin = new Map<string, LogEntry[]>();
  for (const entry of logs) {
    const bucket = byPlugin.get(entry.pluginId);
    if (bucket) {
      bucket.push({ ...entry });
    } else {
      byPlugin.set(entry.pluginId, [{ ...entry }]);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 8,
          color: "var(--ant-color-text-secondary)",
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <AlertTriangle size={14} style={{ color: "var(--ant-color-warning)" }} />
        错误日志（{logs.length} 条）
        <Button
          size="small"
          type="text"
          onClick={refresh}
          style={{ marginLeft: "auto" }}
        >
          <RefreshCw size={12} />
        </Button>
      </div>
      {Array.from(byPlugin.entries()).map(([pluginId, entries]) => (
        <div
          key={pluginId}
          style={{
            marginBottom: 8,
            padding: "8px 12px",
            background: "var(--ant-color-bg-container)",
            borderRadius: 6,
            border: "1px solid var(--ant-color-border-secondary)",
          }}
        >
          <Text strong style={{ fontSize: 12 }}>
            {pluginManager.getPluginName(pluginId) ?? pluginId}
          </Text>
          {entries.slice(-10).map((entry, index) => (
            <div
              key={index}
              style={{
                fontSize: 11,
                color: "var(--ant-color-text-tertiary)",
                marginTop: 4,
                paddingLeft: 8,
                borderLeft: "2px solid var(--ant-color-warning)",
              }}
            >
              <span style={{ opacity: 0.6 }}>
                {entry.time.slice(11, 19)} {entry.kind}
              </span>
              <br />
              {entry.message.slice(0, 200)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
