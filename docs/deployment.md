# Deployment

## 直接启动

```bash
npm install
npm run build
npm start
```

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Nginx

仓库提供了 [nginx.conf.example](../nginx.conf.example) 作为反向代理参考。

## 生产建议

- 使用 HTTPS
- 配置进程守护
- 配置数据库自动备份
- 将 `uploads/` 与数据库分开备份
- 给 `.env`、日志与备份目录设置最小权限
