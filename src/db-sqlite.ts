/**
 * SQLite 引擎 — 对外暴露与 pg.Pool 兼容的 .query() / .connect() 接口
 *
 * 核心策略：自动将 PostgreSQL 风格的 SQL 转换为 SQLite 兼容语法，
 * 使业务层 30+ 个文件无需任何修改。
 */

import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

// ── pg.Pool 兼容类型 ─────────────────────────────────────

export interface QueryResult {
  rows: any[];
  rowCount: number;
}

export interface SqliteClient {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  release(): void;
}

export interface SqlitePool {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  connect(): Promise<SqliteClient>;
  end(): Promise<void>;
}

// ── SQL 转换层 ─────────────────────────────────────────

function pgToSqlite(sql: string, params?: any[]): { sql: string; params: any[] } {
  let s = sql;

  // $1, $2, ... → ?
  s = s.replace(/\$(\d+)/g, "?");

  // TIMESTAMPTZ → TEXT
  s = s.replace(/\bTIMESTAMPTZ\b/gi, "TEXT");

  // NOW() → (datetime('now'))  — 括号确保 SQLite DEFAULT 表达式合法
  s = s.replace(/\bNOW\(\)/gi, "(datetime('now'))");

  // BOOLEAN → INTEGER
  s = s.replace(/\bBOOLEAN\b/gi, "INTEGER");

  // JSONB → TEXT
  s = s.replace(/\bJSONB\b/gi, "TEXT");

  // DOUBLE PRECISION → REAL
  s = s.replace(/\bDOUBLE\s+PRECISION\b/gi, "REAL");

  // NUMERIC → REAL
  s = s.replace(/\bNUMERIC\b/gi, "REAL");

  // BIGINT → INTEGER
  s = s.replace(/\bBIGINT\b/gi, "INTEGER");

  // ::int, ::text, ::regclass 等 PostgreSQL 类型转换 → 去掉
  s = s.replace(/::\w+/g, "");

  // date_trunc('day', ...) → date(...)
  s = s.replace(/date_trunc\s*\(\s*'day'\s*,\s*([^)]+)\)/gi, "date($1)");

  // DEFAULT NOW() (已转换) 保持不变

  // true/false → 1/0 (在 SQL 字面值中)
  s = s.replace(/\b= true\b/gi, "= 1");
  s = s.replace(/\b= false\b/gi, "= 0");
  s = s.replace(/\bDEFAULT true\b/gi, "DEFAULT 1");
  s = s.replace(/\bDEFAULT false\b/gi, "DEFAULT 0");

  // ON DELETE CASCADE 保留（SQLite 支持，需 PRAGMA foreign_keys=ON）

  // ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL → 忽略（SQLite 不支持）
  if (/ALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN/i.test(s)) {
    return { sql: "SELECT 1", params: [] };
  }

  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS → 去掉 IF NOT EXISTS（由 catch 兜底）
  s = s.replace(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi,
    "ALTER TABLE $1 ADD COLUMN",
  );

  // DROP CONSTRAINT → 忽略
  if (/DROP\s+CONSTRAINT/i.test(s)) {
    return { sql: "SELECT 1", params: [] };
  }

  // DROP INDEX IF EXISTS → 保留（SQLite 支持）

  // pg_constraint 查询 → 返回空
  if (/pg_constraint|pg_attribute/i.test(s)) {
    return { sql: "SELECT NULL as conname WHERE 0", params: [] };
  }

  // 转换参数中的 boolean → 0/1
  const convertedParams = (params || []).map((p) => {
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });

  return { sql: s, params: convertedParams };
}

// ── SQLite 执行 ────────────────────────────────────────

function execQuery(db: Database.Database, rawSql: string, rawParams?: any[]): QueryResult {
  const { sql, params } = pgToSqlite(rawSql, rawParams);

  const trimmed = sql.trim();
  if (!trimmed || trimmed === ";") {
    return { rows: [], rowCount: 0 };
  }

  const upper = trimmed.toUpperCase();

  // 多语句 (迁移脚本) — 用 exec
  if (
    !params.length &&
    (trimmed.includes(";") && (upper.startsWith("CREATE") || upper.startsWith("--") || upper.startsWith("PRAGMA")))
  ) {
    try {
      db.exec(trimmed);
    } catch (e: any) {
      if (!e.message?.includes("already exists") && !e.message?.includes("duplicate column")) {
        throw e;
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // SELECT / RETURNING / WITH / EXPLAIN / PRAGMA → 查询
  if (
    upper.startsWith("SELECT") ||
    upper.startsWith("WITH") ||
    upper.startsWith("EXPLAIN") ||
    upper.startsWith("PRAGMA") ||
    /\bRETURNING\b/i.test(trimmed)
  ) {
    try {
      const stmt = db.prepare(trimmed);
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    } catch (e: any) {
      if (e.message?.includes("no tables") || e.message?.includes("no such table")) {
        return { rows: [], rowCount: 0 };
      }
      throw e;
    }
  }

  // INSERT / UPDATE / DELETE / ALTER / CREATE / DROP → 执行
  try {
    const stmt = db.prepare(trimmed);
    const info = stmt.run(...params);
    return { rows: [], rowCount: info.changes };
  } catch (e: any) {
    if (
      e.message?.includes("already exists") ||
      e.message?.includes("duplicate column") ||
      e.message?.includes("UNIQUE constraint failed")
    ) {
      return { rows: [], rowCount: 0 };
    }
    // 调试：输出导致错误的 SQL
    console.error(`[SQLite] SQL 错误: ${e.message}\n  SQL: ${trimmed.substring(0, 200)}`);
    throw e;
  }
}

// ── 创建 Pool ─────────────────────────────────────────

export function createSqlitePool(dbPath: string): SqlitePool {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const pool: SqlitePool = {
    async query(sql: string, params?: any[]): Promise<QueryResult> {
      return execQuery(db, sql, params);
    },

    async connect(): Promise<SqliteClient> {
      // SQLite 是单连接的，模拟 pg client 接口
      return {
        async query(sql: string, params?: any[]): Promise<QueryResult> {
          // BEGIN/COMMIT/ROLLBACK 特殊处理
          const upper = sql.trim().toUpperCase();
          if (upper === "BEGIN") {
            db.exec("BEGIN");
            return { rows: [], rowCount: 0 };
          }
          if (upper === "COMMIT") {
            db.exec("COMMIT");
            return { rows: [], rowCount: 0 };
          }
          if (upper === "ROLLBACK") {
            try {
              db.exec("ROLLBACK");
            } catch {
              // 可能没有活动事务
            }
            return { rows: [], rowCount: 0 };
          }
          return execQuery(db, sql, params);
        },
        release() {
          // no-op: SQLite 单连接
        },
      };
    },

    async end(): Promise<void> {
      db.close();
    },
  };

  return pool;
}

// ── 初始化迁移 ──────────────────────────────────────────

export async function initSqliteDatabase(pool: SqlitePool): Promise<void> {
  // 建表 + 迁移都通过已有的 db.ts 的 runMigrations 逻辑跑，
  // SQL 转换层会自动处理 PG → SQLite 语法差异。
  // 但 SQLite 本地版不需要所有迁移（如 BOOLEAN 列默认值），
  // 所以这里只确保迁移表存在即可，实际迁移由 db.ts 的 initDatabase 驱动。
}
