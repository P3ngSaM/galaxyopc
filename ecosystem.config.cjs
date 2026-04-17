/**
 * PM2 配置文件
 *
 * 上线步骤：
 *   1. 复制 .env.example → .env，填写所有真实值
 *   2. npm run build        # 编译 TypeScript → dist/
 *   3. pm2 start ecosystem.config.cjs
 *   4. pm2 save && pm2 startup
 *
 * 常用命令：
 *   pm2 logs opc-server     # 查看日志
 *   pm2 monit               # 实时监控
 *   pm2 reload opc-server   # 零停机重启
 */
module.exports = {
  apps: [{
    name: "opc-server",
    // 使用编译产物（需先 npm run build）
    script: "node",
    args: "dist/server.js",
    cwd: __dirname,

    // ── 进程管理 ──
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "1G",

    // 崩溃保护：避免快速重启死循环
    min_uptime: "10s",       // 启动后存活 10s 才算成功
    max_restarts: 10,        // 10次内还崩就报警
    restart_delay: 5000,     // 每次重启间隔 5s

    // ── 日志 ──
    error_file: "logs/err.log",
    out_file: "logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,

    // ── 环境变量 ──
    // 敏感值（DB密码、JWT密钥、API Key）统一写在 .env 文件，不要放这里
    // server.ts 已 import "dotenv/config"，会自动读取 .env
    env: {
      NODE_ENV: "production",
      PORT: 3000,
    },
  }],
};
