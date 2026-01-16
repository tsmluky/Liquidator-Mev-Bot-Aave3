import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath));
  const payload = JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  await fs.writeFile(filePath, payload, "utf8");
}

export async function writeJsonl(filePath: string, rows: unknown[]) {
  await ensureDir(path.dirname(filePath));
  const payload =
    rows.map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + "\n";
  await fs.writeFile(filePath, payload, "utf8");
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function writeCsv(
  filePath: string,
  headers: string[],
  rows: Record<string, unknown>[]
) {
  await ensureDir(path.dirname(filePath));
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
}
