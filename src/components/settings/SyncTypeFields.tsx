import { Form, Switch } from "antd";

interface Props {
  counts?: Record<string, number>;
}

/** 外部目录同步文件类型开关（嵌套在 Form 的 syncTypes 字段下） */
export function SyncTypeFields({ counts }: Props) {
  const rows = [
    { key: "text", label: "Markdown / 纯文本" },
    { key: "pdf", label: "PDF" },
    { key: "word", label: "Word" },
    { key: "slide", label: "PowerPoint" },
    { key: "sheet", label: "Excel / CSV" },
    { key: "ocr", label: "扫描件 OCR（较慢）" },
  ];

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-3">
          <Form.Item
            name={["syncTypes", row.key]}
            valuePropName="checked"
            noStyle
          >
            <Switch size="small" />
          </Form.Item>
          <span className="flex-1 text-sm">{row.label}</span>
          {counts && row.key !== "ocr" && (
            <span className="text-xs opacity-60">
              已索引 {counts[row.key] ?? 0} 个
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default SyncTypeFields;
