/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. The first row is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // Excel's byte-order mark
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function csvCell(v: unknown): string {
  const s =
    v == null
      ? ""
      : typeof v === "string"
        ? v
        : v instanceof Date
          ? v.toISOString()
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** A CSV document from a header and rows of cells. */
export const toCsv = (header: string[], rows: unknown[][]) =>
  [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
