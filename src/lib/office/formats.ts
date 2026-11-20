/** Office 工作台：格式识别与对话框过滤器。 */

export type OfficeFormat = "pptx" | "docx" | "xlsx" | "pdf";

export const OFFICE_FORMATS: OfficeFormat[] = ["pptx", "docx", "xlsx", "pdf"];

export const FORMAT_LABEL: Record<OfficeFormat, string> = {
  pptx: "PowerPoint",
  docx: "Word",
  xlsx: "Excel",
  pdf: "PDF",
};

export const FORMAT_EXTENSION: Record<OfficeFormat, string> = {
  pptx: "pptx",
  docx: "docx",
  xlsx: "xlsx",
  pdf: "pdf",
};

/** 统一打开对话框的过滤器。 */
export const OFFICE_OPEN_FILTERS = [
  {
    name: "Office / PDF",
    extensions: ["pptx", "pptm", "docx", "docm", "xlsx", "xlsm", "pdf"],
  },
];

export function formatOf(nameOrPath: string): OfficeFormat | null {
  const ext = nameOrPath.toLowerCase().split(".").pop() ?? "";
  if (ext === "pptx" || ext === "pptm") return "pptx";
  if (ext === "docx" || ext === "docm") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pdf") return "pdf";
  return null;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function isEditable(format: OfficeFormat): boolean {
  return format !== "pdf";
}

/**
 * 文档（笔记/外部文档）对应的 Office 工作台路由；不支持的类型返回 null。
 *
 * 外部 PDF/Word/Excel 以只读方式打开，避免误写回源文件。
 */
export function officePathForSource(sourcePath: string | null | undefined): string | null {
  if (!sourcePath) return null;
  const format = formatOf(sourcePath);
  if (!format) return null;
  // t 保证重复点击同一文件也会触发 Office 的 query effect
  const params = new URLSearchParams({
    path: sourcePath,
    readonly: "1",
    t: String(Date.now()),
  });
  return `/office?${params.toString()}`;
}
