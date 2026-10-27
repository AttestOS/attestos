// @ts-nocheck: Node-side test helper (the tsconfig carries Workers types only, by design).
// Minimal Cloudflare D1 stand-in over sql.js (real SQLite) with the real migrations applied, so tests exercise the
// actual SQL. Like D1, binding `undefined` throws (a classic production-only crash).
import initSqlJs from "sql.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "migrations");

/** opts.upTo: apply migrations only up to (and including) this file prefix, e.g. "0004" (to test data migrations). */
export async function makeD1(opts: { upTo?: string } = {}) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (opts.upTo && f.slice(0, 4) > opts.upTo) continue;
    db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  const migrate = (prefix: string) => { for (const f of readdirSync(MIGRATIONS).filter((n) => n.startsWith(prefix))) db.exec(readFileSync(join(MIGRATIONS, f), "utf8")); };

  const exec = (sql: string, binds: unknown[]) => {
    binds.forEach((b, i) => { if (b === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${i}`); });
    const st = db.prepare(sql);
    try {
      st.bind(binds.map((b) => (typeof b === "boolean" ? (b ? 1 : 0) : b)) as any);
      const rows: any[] = [];
      while (st.step()) rows.push(st.getAsObject());
      // D1 reports billed rows in meta: approximate with rows returned (reads) and rows changed (writes).
      const write = !/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql) && !/^\s*SELECT/i.test(sql);
      const changes = write ? db.getRowsModified() : 0;
      return { rows, changes, meta: { changes, rows_read: rows.length, rows_written: changes } };
    } finally { st.free(); }
  };
  const stmt = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    all: async () => { const r = exec(sql, binds); return { results: r.rows, success: true, meta: r.meta }; },
    first: async (col?: string) => { const r = exec(sql, binds).rows[0] ?? null; return r && col ? r[col] : r; },
    run: async () => { const r = exec(sql, binds); return { success: true, results: r.rows, meta: r.meta }; },
    raw: async () => exec(sql, binds).rows.map((r) => Object.values(r)),
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => Promise.all(list.map((s) => s.run())),
    exec: async (sql: string) => { db.exec(sql); return { count: 1 }; },
  };
  const q = (sql: string, ...b: unknown[]) => exec(sql, b).rows;
  return { DB, q, migrate };
}
