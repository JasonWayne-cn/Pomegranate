/** 电子表格视图工具：Excel 列字母与“表头行作为首行”的网格数据。 */

export interface SheetLike {
  headers: string[];
  rows: string[][];
}

export interface SheetGridRow {
  /** -1 = 文件里的表头行 */
  key: number;
  cells: string[];
  header: boolean;
}

/** 0 → A，25 → Z，26 → AA。 */
export function columnLabel(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1;
  let label = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    label = String.fromCharCode(65 + mod) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** 表头行作为第 1 行，数据行从第 2 行开始（与 Excel 一致）。 */
export function buildSheetGrid(sheet: SheetLike): SheetGridRow[] {
  return [
    { key: -1, cells: sheet.headers, header: true },
    ...sheet.rows.map((cells, index) => ({ key: index, cells, header: false })),
  ];
}

export function excelRowNumber(row: SheetGridRow): number {
  return row.header ? 1 : row.key + 2;
}

/** 追加并限制栈深（用于 XLSX 字节撤销栈）。 */
export function pushCapped<T>(stack: T[], item: T, max = 20): T[] {
  const next = [...stack, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
