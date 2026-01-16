export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(","); // v0: simple CSV, no quoted commas
    if (cols.length < header.length) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = (cols[j] ?? "").trim();
    rows.push(row);
  }
  return rows;
}
