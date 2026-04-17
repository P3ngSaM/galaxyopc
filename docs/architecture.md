# Architecture

## 技术栈

- Node.js HTTP Server
- TypeScript
- PostgreSQL / SQLite 双引擎
- 原生路由层，不依赖 Express
- 前端页面通过服务端生成与输出

## 核心模块

- `src/auth`: 认证、JWT、验证码、鉴权
- `src/api`: 业务接口
- `src/chat`: AI 对话、工具执行、蜂群协作
- `src/router`: 路由拆分与聚合
- `src/local-agent`: 本地代理、工作流、飞书桥接
- `src/web`: 页面模板与前端 UI 输出
- `src/scheduler`: 定时任务与计划调度

## 数据层

服务启动时自动执行迁移。

- PostgreSQL 用于线上部署
- SQLite 用于单机体验或本地版

## 运行模式

- 线上模式：PostgreSQL + 多用户 + 可接云代理
- 本地模式：SQLite + 本地代理 + 可选云端转发
