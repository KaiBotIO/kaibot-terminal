export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

function escapeCsv(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], cols: CsvColumn<T>[]): string {
  const lines = [cols.map((c) => escapeCsv(c.header)).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCsv(c.value(row))).join(","));
  }
  return lines.join("\r\n");
}

/** Blob + anchor download; the DOM-attached anchor also works in a Tauri webview. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
