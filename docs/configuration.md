# Configuration

## 核心变量

### 服务

- `PORT`: 服务端口，默认 `3000`
- `JWT_SECRET`: JWT 密钥，生产环境必须使用随机长字符串
- `LOCAL_MODE`: 是否启用本地模式
- `AI_MODE`: `local`、`cloud` 或 `hybrid`

### 数据库

- `DB_TYPE`: `postgres` 或 `sqlite`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `SQLITE_PATH`

### AI

- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`
- `UAPI_KEY`
- `UAPI_URL`

### 邮件

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

### 地图

- `AMAP_KEY`
- `AMAP_SERVER_KEY`

### 初始化管理员

- `ADMIN_PHONE`
- `ADMIN_PASSWORD`

## 建议

- 生产环境不要提交 `.env`
- 数据库密码和 API Key 使用密钥管理系统保存
- 如启用云代理，单独配置网络白名单和访问控制
