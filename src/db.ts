/**
 * OPC Server 数据库 — PostgreSQL / SQLite 双引擎
 *
 * 当环境变量 DB_TYPE=sqlite 时使用 SQLite（本地版），
 * 否则使用 PostgreSQL（线上版）。
 */

import pg from "pg";

export type Db = pg.Pool | import("./db-sqlite.js").SqlitePool;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const isSqlite = () => process.env.DB_TYPE === "sqlite";

export async function createPool(cfg: DbConfig): Promise<Db> {
  if (isSqlite()) {
    const dbPath = process.env.SQLITE_PATH || "xhopc-local.db";
    console.log(`[OPC] 使用 SQLite 引擎: ${dbPath}`);
    const { createSqlitePool } = await import("./db-sqlite.js");
    return createSqlitePool(dbPath);
  }
  return new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: parseInt(process.env.DB_POOL_MAX || "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function initDatabase(pool: Db): Promise<void> {
  await runMigrations(pool);
}

// ─── 建表 SQL (PostgreSQL) ────────────────────────────────────────────

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS opc_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    industry TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    registration_mode TEXT NOT NULL DEFAULT 'virtual',
    registration_stage TEXT NOT NULL DEFAULT 'simulated',
    startup_stage TEXT NOT NULL DEFAULT 'setup',
    first_order_stage TEXT NOT NULL DEFAULT 'not_started',
    owner_name TEXT NOT NULL DEFAULT '',
    owner_contact TEXT NOT NULL DEFAULT '',
    registered_capital TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    core_offer TEXT NOT NULL DEFAULT '',
    target_customer_profile TEXT NOT NULL DEFAULT '',
    customer_pain_point TEXT NOT NULL DEFAULT '',
    delivery_model TEXT NOT NULL DEFAULT '',
    revenue_strategy TEXT NOT NULL DEFAULT '',
    monthly_revenue_target DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    onboarding_data TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS opc_employees (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    salary DOUBLE PRECISION NOT NULL DEFAULT 0,
    hire_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE TABLE IF NOT EXISTS opc_transactions (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    type TEXT NOT NULL DEFAULT 'expense',
    category TEXT NOT NULL DEFAULT '',
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    transaction_date TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_contacts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    pipeline_stage TEXT NOT NULL DEFAULT 'lead',
    deal_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    follow_up_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_company_opportunities (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    customer_role TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_detail TEXT NOT NULL DEFAULT '',
    fit_score INTEGER NOT NULL DEFAULT 70,
    stage TEXT NOT NULL DEFAULT 'todo',
    expected_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    next_action TEXT NOT NULL DEFAULT '',
    next_action_at TIMESTAMPTZ,
    owner_user_id TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_delivery_orders (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
    opportunity_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    contract_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    delivery_stage TEXT NOT NULL DEFAULT 'preparing',
    invoice_status TEXT NOT NULL DEFAULT 'not_started',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    milestones_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_company_autopilot_runs (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
    rule_key TEXT NOT NULL DEFAULT '',
    related_id TEXT NOT NULL DEFAULT '',
    created_todo_id TEXT NOT NULL DEFAULT '',
    created_alert_id TEXT NOT NULL DEFAULT '',
    created_document_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_invoices (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    invoice_number TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'receivable',
    contact_id TEXT NOT NULL DEFAULT '',
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    tax_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    issue_date TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT '',
    paid_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_contracts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    title TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'service',
    value DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'low',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_projects (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planning',
    budget DOUBLE PRECISION NOT NULL DEFAULT 0,
    spent DOUBLE PRECISION NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    document TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_tool_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS opc_canvas (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL UNIQUE,
    track TEXT NOT NULL DEFAULT '',
    target_customer TEXT NOT NULL DEFAULT '',
    pain_point TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
    unique_value TEXT NOT NULL DEFAULT '',
    channels TEXT NOT NULL DEFAULT '',
    revenue_model TEXT NOT NULL DEFAULT '',
    cost_structure TEXT NOT NULL DEFAULT '',
    key_resources TEXT NOT NULL DEFAULT '',
    key_activities TEXT NOT NULL DEFAULT '',
    key_partners TEXT NOT NULL DEFAULT '',
    unfair_advantage TEXT NOT NULL DEFAULT '',
    metrics TEXT NOT NULL DEFAULT '',
    non_compete TEXT NOT NULL DEFAULT '',
    scaling_strategy TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_compass (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL UNIQUE,
    passions TEXT NOT NULL DEFAULT '',
    positions TEXT NOT NULL DEFAULT '',
    possessions TEXT NOT NULL DEFAULT '',
    powers TEXT NOT NULL DEFAULT '',
    potentials TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_biz_models (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    name TEXT NOT NULL DEFAULT '',
    who TEXT NOT NULL DEFAULT '',
    problem TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
    revenue_method TEXT NOT NULL DEFAULT '',
    excitement INTEGER NOT NULL DEFAULT 3,
    fit_score INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'idea',
    source TEXT NOT NULL DEFAULT '',
    selected INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_alerts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    title TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'info',
    category TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_todos (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    title TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    category TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_company_documents (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    doc_type TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_channel_config (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    channel TEXT NOT NULL DEFAULT '',
    app_id TEXT NOT NULL DEFAULT '',
    app_secret TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'inactive',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_closures (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    type TEXT NOT NULL DEFAULT 'acquisition',
    name TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    details TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_staff_config (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    role TEXT NOT NULL DEFAULT '',
    role_name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    system_prompt TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_opportunity_battles (
    opportunity_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL DEFAULT '',
    follow_status TEXT NOT NULL DEFAULT '',
    monetization_stage TEXT NOT NULL DEFAULT '',
    commercial_package TEXT NOT NULL DEFAULT '',
    quote_amount TEXT NOT NULL DEFAULT '',
    owner_company_id TEXT NOT NULL DEFAULT '',
    owner_company_name TEXT NOT NULL DEFAULT '',
    owner_person TEXT NOT NULL DEFAULT '',
    assignment_role TEXT NOT NULL DEFAULT '',
    recommended_by TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_by_user_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_users (
    id TEXT PRIMARY KEY,
    phone TEXT DEFAULT NULL,
    email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    city_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    onboarding_data TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS opc_skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES opc_users(id),
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    prompt TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_user_companies (
    user_id TEXT NOT NULL REFERENCES opc_users(id),
    company_id TEXT NOT NULL REFERENCES opc_companies(id),
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, company_id)
  )`,
  `CREATE TABLE IF NOT EXISTS opc_cities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      cover_images TEXT NOT NULL DEFAULT '',
      total_seats INTEGER NOT NULL DEFAULT 0,
      used_seats INTEGER NOT NULL DEFAULT 0,
      contact_name TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_seats (
    id TEXT PRIMARY KEY,
    city_id TEXT NOT NULL REFERENCES opc_cities(id),
    seat_number TEXT NOT NULL,
    company_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES opc_users(id),
    expires_at TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES opc_users(id),
    company_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_chat_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES opc_users(id),
    company_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS opc_work_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    log_date TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    feishu_doc_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

const INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_users_phone ON opc_users(phone)",
  "CREATE INDEX IF NOT EXISTS idx_users_city ON opc_users(city_id)",
  "CREATE INDEX IF NOT EXISTS idx_users_role ON opc_users(role)",
  "CREATE INDEX IF NOT EXISTS idx_user_companies_user ON opc_user_companies(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_companies_company ON opc_user_companies(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_cities_status ON opc_cities(status)",
  "CREATE INDEX IF NOT EXISTS idx_seats_city ON opc_seats(city_id)",
  "CREATE INDEX IF NOT EXISTS idx_seats_status ON opc_seats(status)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON opc_sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON opc_sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON opc_chat_messages(conversation_id)",
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON opc_chat_messages(user_id, company_id)",
  "CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON opc_chat_conversations(user_id, company_id)",
  "CREATE INDEX IF NOT EXISTS idx_companies_status ON opc_companies(status)",
  "CREATE INDEX IF NOT EXISTS idx_transactions_company ON opc_transactions(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_contacts_company ON opc_contacts(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_invoices_company ON opc_invoices(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_contracts_company ON opc_contracts(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_projects_company ON opc_projects(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_employees_company ON opc_employees(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_company_documents_company ON opc_company_documents(company_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skills_user ON opc_skills(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_work_logs_user_date ON opc_work_logs(user_id, log_date)",
];

async function runMigrations(pool: Db): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS opc_server_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const { rows } = await pool.query("SELECT version FROM opc_server_migrations");
  const applied = new Set(rows.map((r: { version: number }) => r.version));

  if (!applied.has(1)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sql of TABLES) await client.query(sql);
      for (const sql of INDEXES) await client.query(sql);
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [1]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(2)) {
    try {
      await pool.query("ALTER TABLE opc_transactions ADD COLUMN IF NOT EXISTS counterparty TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [2]);
    } catch {
      /* column may already exist */
    }
  }

  if (!applied.has(3)) {
    try {
      await pool.query("ALTER TABLE opc_projects ADD COLUMN IF NOT EXISTS document TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [3]);
    } catch { /* column may already exist */ }
  }

  if (!applied.has(4)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_users ALTER COLUMN phone DROP NOT NULL");
      await client.query("ALTER TABLE opc_users ALTER COLUMN phone SET DEFAULT NULL");
      await client.query("ALTER TABLE opc_users DROP CONSTRAINT IF EXISTS opc_users_phone_key");
      await client.query("DROP INDEX IF EXISTS opc_users_phone_key");
      await client.query("UPDATE opc_users SET phone = NULL WHERE phone = ''");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON opc_users (email) WHERE email IS NOT NULL AND email != ''");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [4]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(5)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS quota_total INTEGER NOT NULL DEFAULT 500");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS quota_used INTEGER NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS plan_expires TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS verified INTEGER NOT NULL DEFAULT 0");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_usage_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id),
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_points DOUBLE PRECISION NOT NULL DEFAULT 0,
        tool_name TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [5]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(6)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_scheduled_tasks (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id  TEXT,
        name        TEXT NOT NULL,
        task_type   TEXT NOT NULL,
        cron_expr   TEXT,
        run_at      TIMESTAMPTZ,
        payload     JSONB NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL DEFAULT 'pending',
        run_count   INTEGER NOT NULL DEFAULT 0,
        max_runs    INTEGER,
        last_run    TIMESTAMPTZ,
        last_error  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON opc_scheduled_tasks(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_run_at ON opc_scheduled_tasks(status, run_at)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [6]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(7)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 模型计费配置表
      await client.query(`CREATE TABLE IF NOT EXISTS opc_model_prices (
        model_id             TEXT PRIMARY KEY,
        display_name         TEXT NOT NULL,
        input_per_1k         NUMERIC NOT NULL,
        output_per_1k        NUMERIC NOT NULL,
        points_per_exchange  INTEGER NOT NULL,
        enabled              BOOLEAN NOT NULL DEFAULT true,
        min_plan             TEXT NOT NULL DEFAULT 'free',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`
        INSERT INTO opc_model_prices (model_id, display_name, input_per_1k, output_per_1k, points_per_exchange, enabled, min_plan) VALUES
          ('qwen-turbo',   '通义千问 Turbo', 0.0008, 0.0048,  4, true, 'free'),
          ('minimax-m2.5', 'MiniMax M2.5',  0.0021, 0.0084,  9, true, 'plus'),
          ('glm-5',        '智谱 GLM-5',    0.004,  0.018,  17, true, 'pro'),
          ('kimi-k2.5',    'Kimi K2.5',     0.004,  0.021,  19, true, 'pro')
        ON CONFLICT (model_id) DO NOTHING
      `);
      // 扩展 opc_users
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS selected_model TEXT NOT NULL DEFAULT 'qwen-turbo'");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS quota_reset_at TIMESTAMPTZ");
      // 扩展 opc_usage_log
      await client.query("ALTER TABLE opc_usage_log ADD COLUMN IF NOT EXISTS model_id TEXT NOT NULL DEFAULT 'qwen-turbo'");
      await client.query("ALTER TABLE opc_usage_log ADD COLUMN IF NOT EXISTS conversation_id TEXT");
      await client.query("ALTER TABLE opc_usage_log ADD COLUMN IF NOT EXISTS api_cost_yuan DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [7]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(8)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 重命名 qwen-turbo → qwen3.5-plus（用户指定的实际模型名）
      await client.query(`
        INSERT INTO opc_model_prices (model_id, display_name, input_per_1k, output_per_1k, points_per_exchange, enabled, min_plan)
        VALUES ('qwen3.5-plus', '通义千问 3.5 Plus', 0.0008, 0.0048, 4, true, 'free')
        ON CONFLICT (model_id) DO NOTHING
      `);
      await client.query(`UPDATE opc_model_prices SET enabled = false WHERE model_id = 'qwen-turbo'`);
      // 将已选 qwen-turbo 的用户迁移到 qwen3.5-plus
      await client.query(`UPDATE opc_users SET selected_model = 'qwen3.5-plus' WHERE selected_model = 'qwen-turbo'`);
      // 更新 selected_model 默认值
      await client.query(`ALTER TABLE opc_users ALTER COLUMN selected_model SET DEFAULT 'qwen3.5-plus'`);
      // 新增支付订单表
      await client.query(`CREATE TABLE IF NOT EXISTS opc_orders (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES opc_users(id),
        plan_id       TEXT NOT NULL,
        amount_fen    INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        pay_type      TEXT NOT NULL DEFAULT 'wechat',
        qr_url        TEXT NOT NULL DEFAULT '',
        paid_at       TIMESTAMPTZ,
        expired_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_orders_user ON opc_orders(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_orders_status ON opc_orders(status)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [8]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(9)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_user_memories (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id     TEXT,
        category       TEXT NOT NULL DEFAULT 'fact',
        content        TEXT NOT NULL,
        importance     INTEGER NOT NULL DEFAULT 5,
        source_conv_id TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active      BOOLEAN NOT NULL DEFAULT true
      )`);
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_user_memories_user ON opc_user_memories(user_id, is_active, importance DESC, updated_at DESC)"
      );
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [9]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(10)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN NOT NULL DEFAULT false"
      );
      // 已有对话的老用户标记为已完成，不再触发 onboarding
      await client.query(`
        UPDATE opc_users SET onboarding_done = true
        WHERE id IN (
          SELECT user_id FROM opc_chat_messages
          WHERE role = 'user'
          GROUP BY user_id
          HAVING COUNT(*) >= 3
        )
      `);
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [10]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Migration 12: AI 蜂群 + 跨用户 Agent 社交 ──
  if (!applied.has(12)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // --- 蜂群 ---
      await client.query(`CREATE TABLE IF NOT EXISTS opc_swarm_sessions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id         TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id      TEXT NOT NULL DEFAULT '',
        mode            TEXT NOT NULL DEFAULT 'parallel',
        status          TEXT NOT NULL DEFAULT 'running',
        conductor_summary TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at     TIMESTAMPTZ
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_swarm_turns (
        id              TEXT PRIMARY KEY,
        swarm_session_id TEXT NOT NULL REFERENCES opc_swarm_sessions(id) ON DELETE CASCADE,
        agent_role      TEXT NOT NULL,
        agent_role_name TEXT NOT NULL DEFAULT '',
        input_prompt    TEXT NOT NULL DEFAULT '',
        output_text     TEXT NOT NULL DEFAULT '',
        tokens_in       INTEGER NOT NULL DEFAULT 0,
        tokens_out      INTEGER NOT NULL DEFAULT 0,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        handoff_to      TEXT,
        sequence        INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at     TIMESTAMPTZ
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_swarm_sessions_conv ON opc_swarm_sessions(conversation_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_swarm_sessions_user ON opc_swarm_sessions(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_swarm_turns_session ON opc_swarm_turns(swarm_session_id, sequence)");

      // --- 好友系统 ---
      await client.query(`CREATE TABLE IF NOT EXISTS opc_friends (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        friend_id   TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        alias       TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'accepted',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, friend_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_friend_requests (
        id            TEXT PRIMARY KEY,
        from_user_id  TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        to_user_id    TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        message       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_friends_user ON opc_friends(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_friends_friend ON opc_friends(friend_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON opc_friend_requests(to_user_id, status)");

      // --- Agent 房间 ---
      await client.query(`CREATE TABLE IF NOT EXISTS opc_agent_rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        type        TEXT NOT NULL DEFAULT 'dm',
        creator_id  TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_agent_room_members (
        id            TEXT PRIMARY KEY,
        room_id       TEXT NOT NULL REFERENCES opc_agent_rooms(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id    TEXT NOT NULL DEFAULT '',
        agent_role    TEXT NOT NULL DEFAULT 'assistant',
        share_scope   JSONB NOT NULL DEFAULT '["basic_info"]',
        joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(room_id, user_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_agent_messages (
        id               TEXT PRIMARY KEY,
        room_id          TEXT NOT NULL REFERENCES opc_agent_rooms(id) ON DELETE CASCADE,
        sender_user_id   TEXT NOT NULL,
        sender_agent_role TEXT NOT NULL DEFAULT '',
        content          TEXT NOT NULL DEFAULT '',
        msg_type         TEXT NOT NULL DEFAULT 'agent',
        reply_to         TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_rooms_creator ON opc_agent_rooms(creator_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_room_members_room ON opc_agent_room_members(room_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_room_members_user ON opc_agent_room_members(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_messages_room ON opc_agent_messages(room_id, created_at)");

      // staff_config 新增 swarm_enabled 列
      await client.query("ALTER TABLE opc_staff_config ADD COLUMN IF NOT EXISTS swarm_enabled INTEGER NOT NULL DEFAULT 1");

      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [12]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(11)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 邮件账户配置表
      await client.query(`CREATE TABLE IF NOT EXISTS opc_email_accounts (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        email        TEXT NOT NULL,
        display_name TEXT,
        imap_host    TEXT NOT NULL,
        imap_port    INTEGER NOT NULL DEFAULT 993,
        smtp_host    TEXT NOT NULL,
        smtp_port    INTEGER NOT NULL DEFAULT 465,
        password     TEXT NOT NULL,
        enabled      BOOLEAN NOT NULL DEFAULT true,
        last_uid     BIGINT NOT NULL DEFAULT 0,
        last_poll    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // 收件箱表
      await client.query(`CREATE TABLE IF NOT EXISTS opc_email_inbox (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES opc_email_accounts(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL,
        uid             BIGINT NOT NULL,
        message_id      TEXT,
        from_addr       TEXT NOT NULL,
        from_name       TEXT,
        subject         TEXT,
        body_text       TEXT,
        received_at     TIMESTAMPTZ NOT NULL,
        is_read         BOOLEAN NOT NULL DEFAULT false,
        ai_summary      TEXT,
        ai_action       TEXT,
        reply_draft     TEXT,
        task_suggestion JSONB,
        status          TEXT NOT NULL DEFAULT 'new',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON opc_email_accounts(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_email_inbox_account ON opc_email_inbox(account_id, uid)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_email_inbox_user ON opc_email_inbox(user_id, status, created_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [11]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #13：Agent 对话会话（指令式多轮） ──
  if (!applied.has(13)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_agent_dialogue_sessions (
        id              TEXT PRIMARY KEY,
        room_id         TEXT NOT NULL REFERENCES opc_agent_rooms(id) ON DELETE CASCADE,
        initiator_id    TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        topic           TEXT NOT NULL DEFAULT '',
        max_turns       INTEGER NOT NULL DEFAULT 10,
        current_turn    INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'running',
        summary         TEXT NOT NULL DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at     TIMESTAMPTZ
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_dialogue_sessions_room ON opc_agent_dialogue_sessions(room_id, status)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [13]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(14)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_chat_conversations ALTER COLUMN company_id DROP NOT NULL");
      await client.query("ALTER TABLE opc_chat_conversations ALTER COLUMN company_id SET DEFAULT ''");
      await client.query("ALTER TABLE opc_chat_messages ALTER COLUMN company_id DROP NOT NULL");
      await client.query("ALTER TABLE opc_chat_messages ALTER COLUMN company_id SET DEFAULT ''");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [14]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #15：Agent 房间成员邀请制（status 字段）──
  if (!applied.has(15)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_agent_room_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted'");
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_room_members_status ON opc_agent_room_members(user_id, status)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [15]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #16：日程管理表 opc_schedules ──
  if (!applied.has(16)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_schedules (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id  TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL,
        date        TEXT NOT NULL,
        start_time  TEXT NOT NULL DEFAULT '',
        end_time    TEXT NOT NULL DEFAULT '',
        location    TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL DEFAULT 'work',
        status      TEXT NOT NULL DEFAULT 'scheduled',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_schedules_user_date ON opc_schedules(user_id, date)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_schedules_company_date ON opc_schedules(company_id, date)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [16]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #17：蜂群会话增加 plan_json 列 ──
  if (!applied.has(17)) {
    try {
      await pool.query("ALTER TABLE opc_swarm_sessions ADD COLUMN IF NOT EXISTS plan_json TEXT NOT NULL DEFAULT '{}'");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [17]);
    } catch { /* column may already exist */ }
  }

  // ── 迁移 #18：蜂群审计日志 + 审阅修订列 ──
  if (!applied.has(18)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_swarm_audit_log (
        id               TEXT PRIMARY KEY,
        swarm_session_id TEXT NOT NULL REFERENCES opc_swarm_sessions(id) ON DELETE CASCADE,
        phase            TEXT NOT NULL,
        agent_role       TEXT,
        detail           TEXT NOT NULL DEFAULT '',
        tokens_in        INTEGER NOT NULL DEFAULT 0,
        tokens_out       INTEGER NOT NULL DEFAULT 0,
        duration_ms      INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_swarm_audit_session ON opc_swarm_audit_log(swarm_session_id, created_at)");
      await client.query("ALTER TABLE opc_swarm_turns ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_swarm_turns ADD COLUMN IF NOT EXISTS review_score TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_swarm_turns ADD COLUMN IF NOT EXISTS review_feedback TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_swarm_turns ADD COLUMN IF NOT EXISTS compressed_output TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_swarm_turns ADD COLUMN IF NOT EXISTS full_output TEXT NOT NULL DEFAULT ''");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [18]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #19：邀请码 + 反馈论坛 + 积分日志 + 加群奖励 ──
  if (!applied.has(19)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 用户表新增字段：邀请码、被谁邀请、是否已领取加群奖励
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS invite_code TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS invited_by TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS group_bonus_claimed BOOLEAN NOT NULL DEFAULT false");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON opc_users(invite_code) WHERE invite_code != ''");

      // 积分变动日志
      await client.query(`CREATE TABLE IF NOT EXISTS opc_points_log (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        amount     INTEGER NOT NULL,
        reason     TEXT NOT NULL,
        detail     TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_points_log_user ON opc_points_log(user_id, created_at DESC)");

      // 反馈论坛
      await client.query(`CREATE TABLE IF NOT EXISTS opc_feedback (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        type          TEXT NOT NULL DEFAULT 'bug',
        title         TEXT NOT NULL,
        content       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'open',
        admin_reply   TEXT NOT NULL DEFAULT '',
        upvotes       INTEGER NOT NULL DEFAULT 0,
        reward_given  BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_feedback_status ON opc_feedback(status, created_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_feedback_user ON opc_feedback(user_id)");

      // 反馈投票（防重复）
      await client.query(`CREATE TABLE IF NOT EXISTS opc_feedback_votes (
        user_id     TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        feedback_id TEXT NOT NULL REFERENCES opc_feedback(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, feedback_id)
      )`);

      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [19]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ── 迁移 #20：opc_projects.company_id 允许为空（支持无公司场景文档生成）──
  if (!applied.has(20)) {
    try {
      await pool.query("ALTER TABLE opc_projects ALTER COLUMN company_id DROP NOT NULL");
      await pool.query("ALTER TABLE opc_projects ALTER COLUMN company_id SET DEFAULT ''");
      // 动态查找并删除所有 company_id 外键约束
      const { rows: fks } = await pool.query(`
        SELECT con.conname FROM pg_constraint con
        JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
        WHERE con.conrelid = 'opc_projects'::regclass
          AND con.contype = 'f'
          AND att.attname = 'company_id'
      `);
      for (const fk of fks) {
        await pool.query(`ALTER TABLE opc_projects DROP CONSTRAINT IF EXISTS "${(fk as any).conname}"`);
      }
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [20]);
    } catch (e) { console.error("[Migration #20 error]", e); }
  }

  // Migration #21: 兑换密钥表
  if (!applied.has(21)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_redeem_keys (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        points INTEGER NOT NULL DEFAULT 500,
        created_by TEXT,
        used_by TEXT,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_redeem_keys_key ON opc_redeem_keys(key)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [21]);
    } catch (e) { console.error("[Migration #21 error]", e); }
  }

  // Migration #22: 给已有 opc_redeem_keys 补 points 列
  if (!applied.has(22)) {
    try {
      await pool.query("ALTER TABLE opc_redeem_keys ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 500");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [22]);
    } catch (e) { console.error("[Migration #22 error]", e); }
  }

  // Migration #23: 多人协作 — 公司成员邀请表
  if (!applied.has(23)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_company_invites (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        inviter_id TEXT NOT NULL,
        invitee_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_company_invites_invitee ON opc_company_invites(invitee_id, status)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_company_invites_company ON opc_company_invites(company_id)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [23]);
    } catch (e) { console.error("[Migration #23 error]", e); }
  }

  // Migration #24: 本地操作 — 任务表 + 审计日志
  if (!applied.has(24)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_local_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        steps JSONB DEFAULT '[]',
        summary TEXT,
        source TEXT DEFAULT 'web',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_local_tasks_user ON opc_local_tasks(user_id, created_at DESC)");

      await pool.query(`CREATE TABLE IF NOT EXISTS opc_local_audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args JSONB,
        result TEXT,
        risk_level TEXT,
        approved BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_local_audit_user ON opc_local_audit_log(user_id, created_at DESC)");

      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [24]);
      console.log("[Migration #24] 本地操作表创建完成");
    } catch (e) { console.error("[Migration #24 error]", e); }
  }

  // Migration #26: 公司表增加 city_id 字段（城市/地域筛选）
  if (!applied.has(26)) {
    try {
      await pool.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS city_id TEXT NOT NULL DEFAULT ''");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_companies_city ON opc_companies(city_id)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [26]);
      console.log("[Migration #26] opc_companies.city_id 字段已添加");
    } catch (e) { console.error("[Migration #26 error]", e); }
  }

  // Migration #27: 地图可视化 — 园区/用户增加经纬度、园区招募信息
  if (!applied.has(27)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS city_name TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS creator_id TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS recruit_info TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS recruit_open BOOLEAN NOT NULL DEFAULT false");
      await client.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS user_city TEXT NOT NULL DEFAULT ''");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [27]);
      await client.query("COMMIT");
      console.log("[Migration #27] 地图经纬度+招募字段已添加");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #27 error]", e);
    } finally { client.release(); }
  }

  // Migration #25: 智能工作流 + 自动报告
  if (!applied.has(25)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_workflows (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        company_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        trigger_type TEXT NOT NULL,
        trigger_config JSONB DEFAULT '{}',
        conditions JSONB DEFAULT '[]',
        actions JSONB DEFAULT '[]',
        enabled BOOLEAN DEFAULT true,
        last_run_at TIMESTAMPTZ,
        run_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_workflows_user ON opc_workflows(user_id, enabled)");

      await pool.query(`CREATE TABLE IF NOT EXISTS opc_workflow_logs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        steps JSONB DEFAULT '[]',
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_wf_logs_wf ON opc_workflow_logs(workflow_id, started_at DESC)");

      await pool.query(`CREATE TABLE IF NOT EXISTS opc_auto_reports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        company_id TEXT,
        report_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        last_generated_at TIMESTAMPTZ,
        enabled BOOLEAN DEFAULT true,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);

      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [25]);
      console.log("[Migration #25] 工作流 + 自动报告表创建完成");
    } catch (e) { console.error("[Migration #25 error]", e); }
  }

  if (!applied.has(28)) {
    try {
      await pool.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS user_province TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS user_district TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [28]);
      console.log("[Migration #28] 用户省份/区县字段添加完成");
    } catch (e) { console.error("[Migration #28 error]", e); }
  }

  if (!applied.has(29)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_park_applications (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL REFERENCES opc_cities(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES opc_users(id),
        message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(park_id, user_id, status)
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_park_app_park ON opc_park_applications(park_id)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_park_app_user ON opc_park_applications(user_id)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [29]);
      console.log("[Migration #29] 园区入驻申请表创建完成");
    } catch (e) { console.error("[Migration #29 error]", e); }
  }

  if (!applied.has(30)) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS opc_checkins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id),
        checkin_date DATE NOT NULL,
        streak INTEGER NOT NULL DEFAULT 1,
        reward INTEGER NOT NULL DEFAULT 100,
        bonus INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, checkin_date)
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON opc_checkins(user_id, checkin_date DESC)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [30]);
      console.log("[Migration #30] 签到表创建完成");
    } catch (e) { console.error("[Migration #30 error]", e); }
  }

  if (!applied.has(31)) {
    try {
      await pool.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS swarm_reset_baseline INTEGER NOT NULL DEFAULT 0");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [31]);
      console.log("[Migration #31] 用户蜂群重置基线字段添加完成");
    } catch (e) { console.error("[Migration #31 error]", e); }
  }

  if (!applied.has(32)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_intel_runs (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL DEFAULT '',
        scope_name TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        source_file TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL DEFAULT '',
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        document_count INTEGER NOT NULL DEFAULT 0,
        opportunity_count INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}'
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_intel_regions (
        id TEXT PRIMARY KEY,
        region_key TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL DEFAULT 'county',
        scope_name TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        center_address TEXT NOT NULL DEFAULT '',
        longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        document_count INTEGER NOT NULL DEFAULT 0,
        opportunity_count INTEGER NOT NULL DEFAULT 0,
        top_demands TEXT NOT NULL DEFAULT '[]',
        assessment TEXT NOT NULL DEFAULT '[]',
        meta_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_intel_documents (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES opc_intel_runs(id) ON DELETE CASCADE,
        region_id TEXT NOT NULL REFERENCES opc_intel_regions(id) ON DELETE CASCADE,
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_points TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        target_orgs TEXT NOT NULL DEFAULT '[]',
        money TEXT NOT NULL DEFAULT '[]',
        full_text TEXT NOT NULL DEFAULT '',
        discovered_by_query TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL DEFAULT '',
        official BOOLEAN NOT NULL DEFAULT false,
        fallback_used BOOLEAN NOT NULL DEFAULT false,
        opportunity_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_intel_opportunities (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES opc_intel_runs(id) ON DELETE CASCADE,
        region_id TEXT NOT NULL REFERENCES opc_intel_regions(id) ON DELETE CASCADE,
        dataset_kind TEXT NOT NULL DEFAULT 'county_pool',
        source_record_id TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        target_org TEXT NOT NULL DEFAULT '',
        target_orgs TEXT NOT NULL DEFAULT '[]',
        address TEXT NOT NULL DEFAULT '',
        longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        budget TEXT NOT NULL DEFAULT '',
        money TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        key_points TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        services TEXT NOT NULL DEFAULT '[]',
        fit_profiles TEXT NOT NULL DEFAULT '[]',
        stage_tag TEXT NOT NULL DEFAULT '',
        entry_focus TEXT NOT NULL DEFAULT '',
        next_actions TEXT NOT NULL DEFAULT '[]',
        priority_label TEXT NOT NULL DEFAULT '',
        priority_text TEXT NOT NULL DEFAULT '',
        priority_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        source_url TEXT NOT NULL DEFAULT '',
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        discovered_by_query TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL DEFAULT '',
        official BOOLEAN NOT NULL DEFAULT false,
        fallback_used BOOLEAN NOT NULL DEFAULT false,
        opportunity_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        battle_json TEXT NOT NULL DEFAULT '{}',
        raw_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_runs_scope ON opc_intel_runs(scope_type, province, city, county)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_regions_location ON opc_intel_regions(province, city, county)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_documents_region ON opc_intel_documents(region_id, source_type, date)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_documents_url ON opc_intel_documents(url)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_opps_region ON opc_intel_opportunities(region_id, dataset_kind, date)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_opps_location ON opc_intel_opportunities(province, city, county)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_opps_priority ON opc_intel_opportunities(priority_score DESC, score DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [32]);
      await client.query("COMMIT");
      console.log("[Migration #32] 情报数据表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #32 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(33)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_intel_industries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES opc_intel_runs(id) ON DELETE CASCADE,
        region_id TEXT NOT NULL REFERENCES opc_intel_regions(id) ON DELETE CASCADE,
        source_record_id TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        county TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        services TEXT NOT NULL DEFAULT '[]',
        top_demands TEXT NOT NULL DEFAULT '[]',
        document_count INTEGER NOT NULL DEFAULT 0,
        opportunity_count INTEGER NOT NULL DEFAULT 0,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_industries_region ON opc_intel_industries(region_id, score DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_industries_location ON opc_intel_industries(province, city, county)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [33]);
      await client.query("COMMIT");
      console.log("[Migration #33] 产业地图点表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #33 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(34)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_opportunity_matches (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL REFERENCES opc_intel_opportunities(id) ON DELETE CASCADE,
        company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
        company_name TEXT NOT NULL DEFAULT '',
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT '',
        recommended BOOLEAN NOT NULL DEFAULT false,
        reasons TEXT NOT NULL DEFAULT '[]',
        keyword_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        location_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        status_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'system',
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(opportunity_id, company_id)
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_opportunity_matches_opp ON opc_opportunity_matches(opportunity_id, score DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_opportunity_matches_company ON opc_opportunity_matches(company_id, updated_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [34]);
      await client.query("COMMIT");
      console.log("[Migration #34] 机会撮合快照表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #34 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(35)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_intel_opportunities ADD COLUMN IF NOT EXISTS opportunity_kind TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_intel_opportunities ADD COLUMN IF NOT EXISTS business_stage TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_intel_opportunities ADD COLUMN IF NOT EXISTS commercial_strength TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_intel_opportunities ADD COLUMN IF NOT EXISTS commercial_rank INTEGER NOT NULL DEFAULT 0");
      await client.query("ALTER TABLE opc_intel_opportunities ADD COLUMN IF NOT EXISTS structured_brief TEXT NOT NULL DEFAULT ''");
      await client.query("CREATE INDEX IF NOT EXISTS idx_intel_opps_strength ON opc_intel_opportunities(commercial_rank DESC, priority_score DESC, score DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [35]);
      await client.query("COMMIT");
      console.log("[Migration #35] 结构化机会字段创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #35 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(36)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_opportunity_battles (
        opportunity_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL DEFAULT '',
        follow_status TEXT NOT NULL DEFAULT '',
        monetization_stage TEXT NOT NULL DEFAULT '',
        commercial_package TEXT NOT NULL DEFAULT '',
        quote_amount TEXT NOT NULL DEFAULT '',
        owner_company_id TEXT NOT NULL DEFAULT '',
        owner_company_name TEXT NOT NULL DEFAULT '',
        owner_person TEXT NOT NULL DEFAULT '',
        assignment_role TEXT NOT NULL DEFAULT '',
        recommended_by TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        updated_by_user_id TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("ALTER TABLE opc_opportunity_battles ADD COLUMN IF NOT EXISTS monetization_stage TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_opportunity_battles ADD COLUMN IF NOT EXISTS commercial_package TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_opportunity_battles ADD COLUMN IF NOT EXISTS quote_amount TEXT NOT NULL DEFAULT ''");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [36]);
      await client.query("COMMIT");
      console.log("[Migration #36] 作战台变现字段创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #36 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(37)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO opc_model_prices (model_id, display_name, input_per_1k, output_per_1k, points_per_exchange, enabled, min_plan)
        VALUES ('qwen3.6-plus', '通义千问 3.6 Plus', 0.002, 0.012, 10, true, 'free')
        ON CONFLICT (model_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          input_per_1k = EXCLUDED.input_per_1k,
          output_per_1k = EXCLUDED.output_per_1k,
          points_per_exchange = EXCLUDED.points_per_exchange,
          enabled = true,
          min_plan = EXCLUDED.min_plan
      `);
      await client.query(`UPDATE opc_users SET selected_model = 'qwen3.6-plus' WHERE selected_model IN ('qwen-turbo', 'qwen3.5-plus')`);
      await client.query(`ALTER TABLE opc_users ALTER COLUMN selected_model SET DEFAULT 'qwen3.6-plus'`);
      await client.query(`INSERT INTO opc_server_migrations (version) VALUES ($1)`, [37]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  if (!applied.has(38)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS onboarding_data TEXT NOT NULL DEFAULT '{}'");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS registration_mode TEXT NOT NULL DEFAULT 'virtual'");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS registration_stage TEXT NOT NULL DEFAULT 'not_started'");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS startup_stage TEXT NOT NULL DEFAULT 'idea'");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS first_order_stage TEXT NOT NULL DEFAULT 'not_started'");
      await client.query("ALTER TABLE opc_companies ALTER COLUMN registration_stage SET DEFAULT 'simulated'");
      await client.query("ALTER TABLE opc_companies ALTER COLUMN startup_stage SET DEFAULT 'setup'");
      await client.query(
        `UPDATE opc_users
         SET onboarding_data = '{}'
         WHERE onboarding_data IS NULL OR onboarding_data = ''`
      );
      await client.query(
        `UPDATE opc_companies
         SET registration_mode = CASE WHEN status = 'active' THEN 'real' ELSE registration_mode END,
             registration_stage = CASE
               WHEN registration_stage = '' OR registration_stage = 'not_started'
                 THEN CASE WHEN registration_mode = 'virtual' THEN 'simulated' ELSE 'preparing' END
               ELSE registration_stage
             END,
             startup_stage = CASE WHEN startup_stage = '' OR startup_stage = 'idea' THEN 'setup' ELSE startup_stage END`
      );
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [38]);
      await client.query("COMMIT");
      console.log("[Migration #38] 创业状态字段创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #38 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(39)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_company_documents (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES opc_companies(id),
        doc_type TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_company_documents_company ON opc_company_documents(company_id, updated_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [39]);
      await client.query("COMMIT");
      console.log("[Migration #39] 公司经营文档表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #39 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(40)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_opportunity_enrichments (
        opportunity_id TEXT PRIMARY KEY REFERENCES opc_intel_opportunities(id) ON DELETE CASCADE,
        source_snapshot TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        model_id TEXT NOT NULL DEFAULT '',
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_opportunity_enrichments_updated ON opc_opportunity_enrichments(updated_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [40]);
      await client.query("COMMIT");
      console.log("[Migration #40] 机会 AI 资源画像缓存表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #40 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(41)) {
    try {
      await pool.query("ALTER TABLE opc_swarm_sessions ADD COLUMN IF NOT EXISTS task_board_json TEXT NOT NULL DEFAULT '{}'");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [41]);
      console.log("[Migration #41] 龙宫共享任务板字段创建完成");
    } catch (e) {
      console.error("[Migration #41 error]", e);
    }
  }

  if (!applied.has(42)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_video_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        script_json TEXT NOT NULL DEFAULT '{}',
        output_url TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        requester_id TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_video_jobs_created ON opc_video_jobs(created_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_video_jobs_requester ON opc_video_jobs(requester_id, created_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [42]);
      await client.query("COMMIT");
      console.log("[Migration #42] 视频任务持久化表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #42 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(43)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_geocode_cache (
        address_key TEXT PRIMARY KEY,
        address TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        longitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        latitude DOUBLE PRECISION NOT NULL DEFAULT 0,
        formatted_address TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'amap',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_geocode_cache_updated ON opc_geocode_cache(updated_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [43]);
      await client.query("COMMIT");
      console.log("[Migration #43] 地理编码缓存表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #43 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(44)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS apply_reason TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS company_projects TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS monetization_plan TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS contact_mobile TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS expectation TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_park_applications ADD COLUMN IF NOT EXISTS approved_points INTEGER NOT NULL DEFAULT 0");

      await client.query(`CREATE TABLE IF NOT EXISTS opc_park_memberships (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL REFERENCES opc_cities(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        application_id TEXT REFERENCES opc_park_applications(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active',
        initial_points INTEGER NOT NULL DEFAULT 0,
        points_balance INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        checkin_code TEXT NOT NULL DEFAULT '',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(park_id, user_id)
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_memberships_park ON opc_park_memberships(park_id, joined_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_memberships_user ON opc_park_memberships(user_id, joined_at DESC)");

      await client.query(`CREATE TABLE IF NOT EXISTS opc_park_resources (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL REFERENCES opc_cities(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        resource_type TEXT NOT NULL DEFAULT 'desk',
        description TEXT NOT NULL DEFAULT '',
        points_cost INTEGER NOT NULL DEFAULT 0,
        capacity INTEGER NOT NULL DEFAULT 1,
        unit_label TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_resources_park ON opc_park_resources(park_id, is_active, resource_type)");

      await client.query(`CREATE TABLE IF NOT EXISTS opc_park_bookings (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL REFERENCES opc_cities(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES opc_park_resources(id) ON DELETE CASCADE,
        membership_id TEXT NOT NULL REFERENCES opc_park_memberships(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        booking_date DATE NOT NULL,
        start_slot TEXT NOT NULL DEFAULT '',
        end_slot TEXT NOT NULL DEFAULT '',
        quantity INTEGER NOT NULL DEFAULT 1,
        points_cost INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'confirmed',
        note TEXT NOT NULL DEFAULT '',
        checkin_code TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_bookings_park_date ON opc_park_bookings(park_id, booking_date DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_bookings_membership ON opc_park_bookings(membership_id, created_at DESC)");

      await client.query(`CREATE TABLE IF NOT EXISTS opc_park_points_log (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL REFERENCES opc_cities(id) ON DELETE CASCADE,
        membership_id TEXT NOT NULL REFERENCES opc_park_memberships(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        booking_id TEXT DEFAULT '',
        change_points INTEGER NOT NULL DEFAULT 0,
        balance_after INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_park_points_log_membership ON opc_park_points_log(membership_id, created_at DESC)");

      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [44]);
      await client.query("COMMIT");
      console.log("[Migration #44] 园区社区成员、资源预约与积分体系创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #44 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(45)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS core_offer TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS target_customer_profile TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS customer_pain_point TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS revenue_strategy TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE opc_companies ADD COLUMN IF NOT EXISTS monthly_revenue_target DOUBLE PRECISION NOT NULL DEFAULT 0");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [45]);
      await client.query("COMMIT");
      console.log("[Migration #45] 一人公司经营配置字段创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #45 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(46)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_company_opportunities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        customer_role TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_detail TEXT NOT NULL DEFAULT '',
        fit_score INTEGER NOT NULL DEFAULT 70,
        stage TEXT NOT NULL DEFAULT 'todo',
        expected_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        next_action TEXT NOT NULL DEFAULT '',
        next_action_at TIMESTAMPTZ,
        owner_user_id TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_company_opportunities_company ON opc_company_opportunities(company_id, updated_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_company_opportunities_stage ON opc_company_opportunities(company_id, stage)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [46]);
      await client.query("COMMIT");
      console.log("[Migration #46] 一人公司机会 pipeline 表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #46 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(47)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_delivery_orders (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        contract_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        delivery_stage TEXT NOT NULL DEFAULT 'preparing',
        invoice_status TEXT NOT NULL DEFAULT 'not_started',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        due_date TEXT NOT NULL DEFAULT '',
        next_action TEXT NOT NULL DEFAULT '',
        milestones_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_delivery_orders_company ON opc_delivery_orders(company_id, updated_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_delivery_orders_payment ON opc_delivery_orders(company_id, payment_status, delivery_stage)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [47]);
      await client.query("COMMIT");
      console.log("[Migration #47] 一人公司交付单与回款节点表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #47 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(48)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_company_autopilot_runs (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES opc_companies(id) ON DELETE CASCADE,
        rule_key TEXT NOT NULL DEFAULT '',
        related_id TEXT NOT NULL DEFAULT '',
        created_todo_id TEXT NOT NULL DEFAULT '',
        created_alert_id TEXT NOT NULL DEFAULT '',
        created_document_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_rule_unique ON opc_company_autopilot_runs(company_id, rule_key, related_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_autopilot_company_created ON opc_company_autopilot_runs(company_id, created_at DESC)");
      await client.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [48]);
      await client.query("COMMIT");
      console.log("[Migration #48] 一人公司自动经营规则日志表创建完成");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[Migration #48 error]", e);
    } finally {
      client.release();
    }
  }

  if (!applied.has(49)) {
    try {
      await pool.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS cover_image TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE opc_cities ADD COLUMN IF NOT EXISTS cover_images TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [49]);
      console.log("[Migration #49] 园区图片字段创建完成");
    } catch (e) {
      console.error("[Migration #49 error]", e);
    }
  }

  if (!applied.has(50)) {
    const client = "connect" in pool ? await (pool as any).connect() : pool;
    try {
      if ("query" in client && "release" in client) await client.query("BEGIN");
      const q = (sql: string) => client.query(sql);
      await q(`CREATE TABLE IF NOT EXISTS opc_subscription_keys (
        id            TEXT PRIMARY KEY,
        user_email    TEXT NOT NULL,
        plan_id       TEXT NOT NULL,
        secret_key    TEXT NOT NULL UNIQUE,
        status        TEXT NOT NULL DEFAULT 'pending',
        activated_by  TEXT,
        amount_fen    INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at  TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ
      )`);
      await q("CREATE INDEX IF NOT EXISTS idx_subkeys_email ON opc_subscription_keys(user_email)");
      await q("CREATE INDEX IF NOT EXISTS idx_subkeys_key ON opc_subscription_keys(secret_key)");
      await q("ALTER TABLE opc_users ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0");
      if ("release" in client) await client.query("COMMIT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [50]);
      console.log("[Migration #50] 订阅密钥表创建完成");
    } catch (e) {
      if ("release" in client) try { await client.query("ROLLBACK"); } catch {}
      console.error("[Migration #50 error]", e);
    } finally {
      if ("release" in client) client.release();
    }
  }

  // ── Migration #51: 支付字段扩展 ──
  const { rows: v51 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 51");
  if (v51.length === 0) {
    try {
      await pool.query("ALTER TABLE opc_subscription_keys ADD COLUMN IF NOT EXISTS trade_no TEXT");
      await pool.query("ALTER TABLE opc_subscription_keys ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_subkeys_trade ON opc_subscription_keys(trade_no)");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [51]);
      console.log("[Migration #51] 订阅表支付字段扩展完成");
    } catch (e) {
      console.error("[Migration #51 error]", e);
    }
  }

  // ── Migration #52: 微信支付字段 ──
  const { rows: v52 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 52");
  if (v52.length === 0) {
    try {
      await pool.query("ALTER TABLE opc_subscription_keys ADD COLUMN IF NOT EXISTS wx_transaction_id TEXT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [52]);
      console.log("[Migration #52] 微信支付字段添加完成");
    } catch (e) {
      console.error("[Migration #52 error]", e);
    }
  }

  // ── Migration #53: Agent reflections ──
  const { rows: v53 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 53");
  if (v53.length === 0) {
    const client = "connect" in pool ? await (pool as any).connect() : pool;
    try {
      if ("release" in client) await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_agent_reflections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id TEXT,
        source_conv_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        lessons_json TEXT NOT NULL DEFAULT '[]',
        style_adjustments_json TEXT NOT NULL DEFAULT '[]',
        tools_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT true
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_agent_reflections_user ON opc_agent_reflections(user_id, is_active, updated_at DESC)");
      if ("release" in client) await client.query("COMMIT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [53]);
      console.log("[Migration #53] Agent 复盘表创建完成");
    } catch (e) {
      if ("release" in client) try { await client.query("ROLLBACK"); } catch {}
      console.error("[Migration #53 error]", e);
    } finally {
      if ("release" in client) client.release();
    }
  }

  // ── Migration #54: Skill usage log ──
  const { rows: v54 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 54");
  if (v54.length === 0) {
    const client = "connect" in pool ? await (pool as any).connect() : pool;
    try {
      if ("release" in client) await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_skill_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        skill_name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'custom',
        task TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'success',
        output_preview TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_skill_usage_user ON opc_skill_usage(user_id, created_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON opc_skill_usage(user_id, skill_name, created_at DESC)");
      if ("release" in client) await client.query("COMMIT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [54]);
      console.log("[Migration #54] 技能使用日志表创建完成");
    } catch (e) {
      if ("release" in client) try { await client.query("ROLLBACK"); } catch {}
      console.error("[Migration #54 error]", e);
    } finally {
      if ("release" in client) client.release();
    }
  }

  // ── Migration #55: 租户白标配置（OPC 页面生成器） ──
  const { rows: v55 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 55");
  if (v55.length === 0) {
    const client = "connect" in pool ? await (pool as any).connect() : pool;
    try {
      if ("release" in client) await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_tenant_configs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE,
        company_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        theme_style TEXT NOT NULL DEFAULT 'dark-indigo',
        accent_color TEXT NOT NULL DEFAULT '#5E6AD2',
        accent_color_2 TEXT NOT NULL DEFAULT '#7C86E8',
        bg_color TEXT NOT NULL DEFAULT '#080A12',
        panel_color TEXT NOT NULL DEFAULT '#0D101C',
        text_color TEXT NOT NULL DEFAULT '#F5F7FF',
        secondary_text_color TEXT NOT NULL DEFAULT '#98A2C6',
        border_color TEXT NOT NULL DEFAULT 'rgba(45,55,84,0.7)',
        font_family TEXT NOT NULL DEFAULT 'Inter, Noto Sans SC, system-ui, sans-serif',
        topbar_title TEXT NOT NULL DEFAULT '',
        topbar_subtitle TEXT NOT NULL DEFAULT '',
        login_badge TEXT NOT NULL DEFAULT '',
        login_slogan TEXT NOT NULL DEFAULT '',
        custom_css TEXT NOT NULL DEFAULT '',
        enabled_modules TEXT NOT NULL DEFAULT '["dashboard","companies","chat","contacts"]',
        is_published BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_tenant_configs_user ON opc_tenant_configs(user_id)");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_configs_slug ON opc_tenant_configs(slug)");
      if ("release" in client) await client.query("COMMIT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [55]);
      console.log("[Migration #55] 租户白标配置表创建完成");
    } catch (e) {
      if ("release" in client) try { await client.query("ROLLBACK"); } catch {}
      console.error("[Migration #55 error]", e);
    } finally {
      if ("release" in client) client.release();
    }
  }

  // ── Migration #56: 物联网空间 & 设备推荐 ──
  const { rows: v56 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 56");
  if (v56.length === 0) {
    const client = "connect" in pool ? await (pool as any).connect() : pool;
    try {
      if ("release" in client) await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS opc_iot_spaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES opc_users(id) ON DELETE CASCADE,
        company_id TEXT,
        name TEXT NOT NULL DEFAULT '我的办公空间',
        total_area REAL NOT NULL DEFAULT 0,
        floor_plan_url TEXT NOT NULL DEFAULT '',
        photo_urls TEXT NOT NULL DEFAULT '[]',
        layout_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_iot_rooms (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES opc_iot_spaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '',
        room_type TEXT NOT NULL DEFAULT 'office',
        area REAL NOT NULL DEFAULT 0,
        position_x REAL NOT NULL DEFAULT 0,
        position_y REAL NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 4,
        depth REAL NOT NULL DEFAULT 4,
        height REAL NOT NULL DEFAULT 2.8,
        photo_url TEXT NOT NULL DEFAULT '',
        products_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS opc_iot_product_catalog (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'furniture',
        sub_category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        default_quantity INTEGER NOT NULL DEFAULT 1,
        min_area REAL NOT NULL DEFAULT 0,
        price_range TEXT NOT NULL DEFAULT '',
        specs_json TEXT NOT NULL DEFAULT '{}',
        is_iot BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_iot_spaces_user ON opc_iot_spaces(user_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_iot_rooms_space ON opc_iot_rooms(space_id)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_iot_products_cat ON opc_iot_product_catalog(category)");

      // 预置产品目录
      const products = [
        { id: "prod_desk_exec", name: "行政办公桌", category: "furniture", sub_category: "desk", icon: "🪑", default_quantity: 1, min_area: 4, price_range: "800-3000", is_iot: false },
        { id: "prod_chair_ergo", name: "人体工学椅", category: "furniture", sub_category: "chair", icon: "💺", default_quantity: 1, min_area: 2, price_range: "500-2000", is_iot: false },
        { id: "prod_cabinet", name: "文件柜", category: "furniture", sub_category: "cabinet", icon: "🗄️", default_quantity: 1, min_area: 6, price_range: "300-800", is_iot: false },
        { id: "prod_conf_table", name: "会议桌", category: "furniture", sub_category: "table", icon: "🪵", default_quantity: 1, min_area: 10, price_range: "2000-8000", is_iot: false },
        { id: "prod_conf_chair", name: "会议椅", category: "furniture", sub_category: "chair", icon: "🪑", default_quantity: 4, min_area: 10, price_range: "200-600", is_iot: false },
        { id: "prod_sofa", name: "接待沙发", category: "furniture", sub_category: "sofa", icon: "🛋️", default_quantity: 1, min_area: 8, price_range: "1500-5000", is_iot: false },
        { id: "prod_sensor_temp", name: "温湿度传感器", category: "iot_sensor", sub_category: "environment", icon: "🌡️", default_quantity: 1, min_area: 0, price_range: "80-300", is_iot: true },
        { id: "prod_sensor_motion", name: "人体感应传感器", category: "iot_sensor", sub_category: "motion", icon: "📡", default_quantity: 1, min_area: 0, price_range: "60-200", is_iot: true },
        { id: "prod_sensor_air", name: "空气质量检测仪", category: "iot_sensor", sub_category: "air_quality", icon: "💨", default_quantity: 1, min_area: 15, price_range: "200-800", is_iot: true },
        { id: "prod_camera", name: "智能摄像头", category: "iot_sensor", sub_category: "camera", icon: "📷", default_quantity: 1, min_area: 0, price_range: "200-1000", is_iot: true },
        { id: "prod_smart_light", name: "智能灯控面板", category: "iot_control", sub_category: "lighting", icon: "💡", default_quantity: 1, min_area: 0, price_range: "150-500", is_iot: true },
        { id: "prod_smart_ac", name: "智能空调控制器", category: "iot_control", sub_category: "hvac", icon: "❄️", default_quantity: 1, min_area: 10, price_range: "300-800", is_iot: true },
        { id: "prod_smart_curtain", name: "智能窗帘电机", category: "iot_control", sub_category: "curtain", icon: "🪟", default_quantity: 1, min_area: 8, price_range: "400-1200", is_iot: true },
        { id: "prod_smart_lock", name: "智能门锁", category: "iot_control", sub_category: "access", icon: "🔐", default_quantity: 1, min_area: 0, price_range: "500-2000", is_iot: true },
        { id: "prod_screen", name: "会议大屏/投影", category: "equipment", sub_category: "display", icon: "📺", default_quantity: 1, min_area: 12, price_range: "3000-15000", is_iot: false },
        { id: "prod_whiteboard", name: "智能白板", category: "equipment", sub_category: "whiteboard", icon: "📝", default_quantity: 1, min_area: 10, price_range: "2000-8000", is_iot: true },
        { id: "prod_printer", name: "网络打印机", category: "equipment", sub_category: "printer", icon: "🖨️", default_quantity: 1, min_area: 20, price_range: "1500-5000", is_iot: false },
        { id: "prod_router", name: "企业级路由器", category: "network", sub_category: "router", icon: "📶", default_quantity: 1, min_area: 30, price_range: "500-3000", is_iot: true },
        { id: "prod_ap", name: "无线AP", category: "network", sub_category: "ap", icon: "📡", default_quantity: 1, min_area: 20, price_range: "300-1500", is_iot: true },
        { id: "prod_switch", name: "网络交换机", category: "network", sub_category: "switch", icon: "🔌", default_quantity: 1, min_area: 30, price_range: "200-2000", is_iot: false },
      ];
      for (const p of products) {
        await client.query(
          `INSERT INTO opc_iot_product_catalog (id,name,category,sub_category,icon,default_quantity,min_area,price_range,is_iot,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [p.id, p.name, p.category, p.sub_category, p.icon, p.default_quantity, p.min_area, p.price_range, p.is_iot, 0]
        );
      }

      if ("release" in client) await client.query("COMMIT");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [56]);
      console.log("[Migration #56] 物联网空间表与产品目录创建完成");
    } catch (e) {
      if ("release" in client) try { await client.query("ROLLBACK"); } catch {}
      console.error("[Migration #56 error]", e);
    } finally {
      if ("release" in client) client.release();
    }
  }

  // ── Migration #57: tenant logo_url_light ──
  const { rows: v57 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 57");
  if (v57.length === 0) {
    try {
      await pool.query("ALTER TABLE opc_tenant_configs ADD COLUMN IF NOT EXISTS logo_url_light TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [57]);
      console.log("[Migration #57] 租户浅色 Logo 字段添加完成");
    } catch (e) {
      console.error("[Migration #57 error]", e);
    }
  }

  // ── Migration #58: tenant login tags ──
  const { rows: v58 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 58");
  if (v58.length === 0) {
    try {
      await pool.query("ALTER TABLE opc_tenant_configs ADD COLUMN IF NOT EXISTS login_tag1 TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE opc_tenant_configs ADD COLUMN IF NOT EXISTS login_tag2 TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE opc_tenant_configs ADD COLUMN IF NOT EXISTS login_tag3 TEXT NOT NULL DEFAULT ''");
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [58]);
      console.log("[Migration #58] 租户登录标签字段添加完成");
    } catch (e) {
      console.error("[Migration #58 error]", e);
    }
  }

  // ── Migration #59: 更新日志 & 用户已读记录 ──
  const { rows: v59 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 59");
  if (v59.length === 0) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS opc_changelogs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          version TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          tag TEXT NOT NULL DEFAULT 'feature',
          published BOOLEAN NOT NULL DEFAULT false,
          published_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS opc_changelog_reads (
          user_id UUID NOT NULL,
          changelog_id UUID NOT NULL REFERENCES opc_changelogs(id) ON DELETE CASCADE,
          read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, changelog_id)
        )
      `);
      // 插入第一条更新日志
      await pool.query(`
        INSERT INTO opc_changelogs (version, title, content, tag, published, published_at) VALUES
        ($1, $2, $3, $4, true, now())
      `, [
        '2.5.0',
        '专属 OPC 白标系统 & IoT 数字孪生平台上线',
        `🏢 专属 OPC 白标系统
• 每位用户可创建一套完全定制化的品牌 OPC 系统
• 支持 Logo（深色/浅色双模式）、品牌配色、字体全面自定义
• 66 套预制主题一键应用，覆盖科技、金融、教育等行业
• 自定义登录页标语和标签，提升品牌辨识度
• 独立 /vip/ 入口链接，可直接分享给用户
• 登录页颜色自动跟随租户主题色变化

🌐 IoT 数字孪生平台
• Three.js 驱动的 3D 沉浸式办公空间渲染
• AI 自动规划房间布局，智能推荐 IoT 设备
• 全新 AI 布局助手：通过自然语言对话实时调整房间布局
• 支持设备清单一键导出为 CSV 采购清单
• 动态租户品牌：公司名、Logo、Favicon 自动适配
• 深绿科技风配色，支持旋转/平移/缩放交互

🎨 UI/UX 优化
• 侧边栏统一为"OPC 管理后台"纯文字风格
• 专属 OPC 和物联网平台页面内容全面丰富
• 操作区域改为四格卡片式快捷入口
• 新增更新管理模块，支持版本发布与用户通知`,
        'feature'
      ]);
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [59]);
      console.log("[Migration #59] 更新日志表创建完成，已插入首条更新日志");
    } catch (e) {
      console.error("[Migration #59 error]", e);
    }
  }

  // ── Migration #60: 更新初始日志内容 & 重置已读 ──
  const { rows: v60 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 60");
  if (v60.length === 0) {
    try {
      await pool.query(`UPDATE opc_changelogs SET version = $1, title = $2, content = $3, published = true, published_at = now(), updated_at = now() WHERE version = '2.5.0'`, [
        '2.6.0',
        '专属 OPC 白标系统 & IoT 数字孪生平台 & 更新管理上线',
        `🏢 专属 OPC 白标系统\n• 每位用户可创建一套完全定制化的品牌 OPC 系统\n• 支持 Logo（深色/浅色双模式）、品牌配色、字体全面自定义\n• 66 套预制主题一键应用，主题配色自动适配深色/浅色模式\n• 自定义登录页标语和标签，提升品牌辨识度\n• 独立 /vip/ 入口链接，可直接分享给用户\n• 登录页颜色自动跟随租户主题色变化\n\n🌐 IoT 数字孪生平台\n• Three.js 驱动的 3D 沉浸式办公空间渲染\n• AI 自动规划房间布局，智能推荐 IoT 设备\n• 全新 AI 布局助手：通过自然语言对话实时调整房间布局\n• 支持设备清单一键导出为 CSV 采购清单\n• 动态租户品牌：公司名、Logo、Favicon 自动适配\n• 深绿科技风配色，支持旋转/平移/缩放交互\n\n🎨 UI/UX 优化\n• 侧边栏统一为"OPC 管理后台"纯文字风格\n• 专属 OPC 和物联网平台页面内容全面丰富\n• 操作区域改为四格卡片式快捷入口\n• 所有主题配色自动保证在深色/浅色模式下文字可读\n\n📋 更新管理\n• 管理员可创建、编辑、删除系统更新日志\n• 支持版本号、标签（新功能/优化/修复/重要更新）分类\n• 用户登录时自动弹窗展示未读更新说明\n• 一键「我知道了」标记已读，不再重复提醒`
      ]);
      await pool.query(`DELETE FROM opc_changelog_reads`);
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [60]);
      console.log("[Migration #60] 更新日志内容已更新，已读状态已重置");
    } catch (e) {
      console.error("[Migration #60 error]", e);
    }
  }

  // ── Migration #61: IoT rooms 添加 floor 列 ──
  const { rows: v61 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 61");
  if (v61.length === 0) {
    try {
      await pool.query(`ALTER TABLE opc_iot_rooms ADD COLUMN IF NOT EXISTS floor INTEGER NOT NULL DEFAULT 1`);
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [61]);
      console.log("[Migration #61] opc_iot_rooms 添加 floor 列");
    } catch (e) {
      console.error("[Migration #61 error]", e);
    }
  }

  // ── Migration #62: 新增 v2.7.0 更新日志 ──
  const { rows: v62 } = await pool.query("SELECT 1 FROM opc_server_migrations WHERE version = 62");
  if (v62.length === 0) {
    try {
      await pool.query(`INSERT INTO opc_changelogs (version, title, content, tag, published, published_at) VALUES ($1, $2, $3, $4, true, now())`, [
        '2.7.0',
        'IoT 数字孪生平台全场景升级 & 系统体验优化',
        `🌐 IoT 数字孪生 — 全场景多楼层支持\n• 新增 25 种房间类型：餐饮（大堂/包厢/厨房/餐厅）、教育（教室/实验室）、酒店（客房/休息室）、工业（车间/仓库/展厅）等\n• 支持多楼层 3D 渲染：不同楼层在立体空间中分层展示，楼层间有半透明分隔板\n• AI 规划 prompt 全面升级：根据用户描述自动识别场景类型，不再局限于办公空间\n• 每次生成新空间自动替换旧空间，确保 3D 视图始终加载最新布局\n• 3D 空间支持跨账户公开查看，分享链接他人可直接访问\n\n📋 更新管理模块\n• 管理员可创建/编辑/删除更新日志，支持版本号和标签分类\n• 用户登录后自动弹窗显示未读更新，点击「我知道了」标记已读\n\n🎨 UI/UX 优化\n• 字体 CDN 改为国内源 + 异步加载，页面不再被字体阻塞\n• 所有关键操作（删除空间/页面/日志）替换为自定义确认弹窗\n• 66 套主题配色自动适配深色/浅色模式，保证文字始终可读\n• 更新管理路由修复，侧边栏点击可正常进入`,
        'feature'
      ]);
      await pool.query(`DELETE FROM opc_changelog_reads`);
      await pool.query("INSERT INTO opc_server_migrations (version) VALUES ($1)", [62]);
      console.log("[Migration #62] 新增 v2.7.0 更新日志");
    } catch (e) {
      console.error("[Migration #62 error]", e);
    }
  }
}
