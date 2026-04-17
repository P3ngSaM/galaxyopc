# Quick Start

## 开发启动

1. 安装 Node.js 20+ 与 PostgreSQL 14+
2. 执行 `npm install`
3. 复制 `.env.example` 为 `.env`
4. 配置 `JWT_SECRET` 和数据库连接
5. 执行 `npm run dev`

## 本地 SQLite 模式

适合单机体验：

```env
DB_TYPE=sqlite
SQLITE_PATH=xhopc-local.db
LOCAL_MODE=true
```

然后执行：

```bash
npm run dev
```

## PostgreSQL 模式

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your-password
DB_NAME=opc_db
```

首次启动会自动执行迁移。
