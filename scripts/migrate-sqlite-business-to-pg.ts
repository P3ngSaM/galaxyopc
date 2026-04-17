import "dotenv/config";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createPool, initDatabase, type Db } from "../src/db.js";

type ColumnInfo = {
  name: string;
  pk: number;
};

type TablePlan = {
  name: string;
  required?: boolean;
};

const TABLES: TablePlan[] = [
  { name: "opc_users", required: true },
  { name: "opc_companies", required: true },
  { name: "opc_user_companies" },
  { name: "opc_employees" },
  { name: "opc_transactions" },
  { name: "opc_contacts" },
  { name: "opc_invoices" },
  { name: "opc_contracts" },
  { name: "opc_projects" },
  { name: "opc_tool_config" },
  { name: "opc_canvas" },
  { name: "opc_compass" },
  { name: "opc_biz_models" },
  { name: "opc_alerts" },
  { name: "opc_todos" },
  { name: "opc_company_documents" },
  { name: "opc_channel_config" },
  { name: "opc_closures" },
  { name: "opc_staff_config" },
  { name: "opc_opportunity_battles" },
  { name: "opc_skills" },
  { name: "opc_cities" },
  { name: "opc_seats" },
  { name: "opc_chat_conversations" },
  { name: "opc_chat_messages" },
  { name: "opc_work_logs" },
];

function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

function argValue(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function getSqliteTableColumns(db: Database.Database, tableName: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as ColumnInfo[];
}

function sqliteTableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

async function getPgColumns(pool: Db, tableName: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows.map((row: { column_name: string }) => row.column_name);
}

function buildUpsertSql(tableName: string, columns: string[], primaryKeys: string[]): string {
  const quotedColumns = columns.map(quoteIdent);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const nonPrimaryColumns = columns.filter((column) => !primaryKeys.includes(column));

  if (primaryKeys.length === 0) {
    return `INSERT INTO ${quoteIdent(tableName)} (${quotedColumns.join(", ")})
      VALUES (${placeholders.join(", ")})
      ON CONFLICT DO NOTHING`;
  }

  const updateSql = nonPrimaryColumns.length
    ? nonPrimaryColumns
      .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
      .join(", ")
    : `${quoteIdent(primaryKeys[0])} = EXCLUDED.${quoteIdent(primaryKeys[0])}`;

  return `INSERT INTO ${quoteIdent(tableName)} (${quotedColumns.join(", ")})
    VALUES (${placeholders.join(", ")})
    ON CONFLICT (${primaryKeys.map(quoteIdent).join(", ")})
    DO UPDATE SET ${updateSql}`;
}

async function migrateTable(
  sqlite: Database.Database,
  pool: Db,
  table: TablePlan,
  batchSize: number,
): Promise<{ table: string; copied: number; skipped: boolean }> {
  if (!sqliteTableExists(sqlite, table.name)) {
    if (table.required) {
      throw new Error(`SQLite 中缺少必需表: ${table.name}`);
    }
    console.log(`[sqlite->pg] 跳过不存在的表: ${table.name}`);
    return { table: table.name, copied: 0, skipped: true };
  }

  const sqliteColumns = getSqliteTableColumns(sqlite, table.name);
  const pgColumns = await getPgColumns(pool, table.name);
  const columnSet = new Set(pgColumns);
  const sharedColumns = sqliteColumns
    .map((column) => column.name)
    .filter((column) => columnSet.has(column));

  if (sharedColumns.length === 0) {
    console.log(`[sqlite->pg] 跳过无公共列的表: ${table.name}`);
    return { table: table.name, copied: 0, skipped: true };
  }

  const primaryKeys = sqliteColumns
    .filter((column) => column.pk > 0 && sharedColumns.includes(column.name))
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);

  const selectSql = `SELECT ${sharedColumns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table.name)}`;
  const rows = sqlite.prepare(selectSql).all() as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log(`[sqlite->pg] 表为空，跳过: ${table.name}`);
    return { table: table.name, copied: 0, skipped: false };
  }

  const upsertSql = buildUpsertSql(table.name, sharedColumns, primaryKeys);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const batch of chunks(rows, batchSize)) {
      for (const row of batch) {
        const params = sharedColumns.map((column) => row[column]);
        await client.query(upsertSql, params);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(`[sqlite->pg] 已迁移 ${table.name}: ${rows.length} 行`);
  return { table: table.name, copied: rows.length, skipped: false };
}

async function main() {
  const sqlitePath = argValue("--sqlite-path", env("SQLITE_PATH", "xhopc-local.db"));
  const batchSize = Math.max(1, Number(argValue("--batch-size", "200")) || 200);
  const onlyTables = argValue("--only", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!existsSync(sqlitePath)) {
    throw new Error(`找不到 SQLite 文件: ${sqlitePath}`);
  }

  // 目标库必须是 PostgreSQL，避免误把导入目标也指向本地 SQLite。
  delete process.env.DB_TYPE;
  delete process.env.SQLITE_PATH;

  const db = new Database(sqlitePath, { readonly: true });
  const pool = await createPool({
    host: env("DB_HOST", "127.0.0.1"),
    port: parseInt(env("DB_PORT", "5432"), 10),
    user: env("DB_USER", "postgres"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "opc_db"),
  });

  try {
    if (hasArg("--dry-run")) {
      console.log("[sqlite->pg] dry-run 模式，不会写入 PostgreSQL");
      for (const table of TABLES) {
        if (onlyTables.length > 0 && !onlyTables.includes(table.name)) continue;
        const exists = sqliteTableExists(db, table.name);
        console.log(` - ${table.name}: ${exists ? "存在" : "缺失"}`);
      }
      return;
    }

    await initDatabase(pool);

    const summary: Array<{ table: string; copied: number; skipped: boolean }> = [];
    const plans = onlyTables.length > 0
      ? TABLES.filter((table) => onlyTables.includes(table.name))
      : TABLES;

    for (const table of plans) {
      summary.push(await migrateTable(db, pool, table, batchSize));
    }

    const copied = summary.reduce((total, item) => total + item.copied, 0);
    const migratedTables = summary.filter((item) => !item.skipped).length;
    console.log("[sqlite->pg] 迁移完成", {
      sqlitePath,
      migratedTables,
      copiedRows: copied,
      skippedTables: summary.filter((item) => item.skipped).map((item) => item.table),
    });
  } finally {
    db.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[sqlite->pg] 迁移失败", error);
  process.exit(1);
});
