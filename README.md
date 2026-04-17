# GalaxyOPC

`GalaxyOPC` 是 `opc-server` 的独立开源仓库。

它提供一套基于 Node.js + TypeScript 的经营协作服务端，覆盖账号认证、公司管理、AI 对话、工作流、白标租户、IoT 空间、导出与任务调度等能力，适合二次开发、私有部署和功能扩展。

## 项目描述

在 AI 能力快速跃迁的今天，“一人公司”正在从概念变成现实。越来越多懂业务、懂市场、懂行业的人，已经可以借助大模型和自动化工具，用极小的团队完成过去需要多人协同才能完成的工作。

但真正挡在超级个体面前的，往往不是创意，而是基建。

不会写代码的人，很难自己搭起一套可用的系统；想做 OPC 孵化的平台方，也常常卡在“有想法、没抓手”；资源、算力、空间和流程彼此割裂，让很多本来可以起飞的个体创业者，只能继续单兵作战。

`GalaxyOPC` 想解决的，就是这层“看不见但最耗人”的阻力。

它不是一个孤立的聊天工具，也不是单一的后台系统，而是一套面向“一人公司 / 超级个体 / 小微运营团队 / 孵化平台”的创业操作系统。我们希望把创业中那些最繁琐、最重复、最需要系统化支撑的部分抽出来，做成一个可部署、可扩展、可白标、可开源的底座。

通过这个项目，你可以用更低的技术门槛获得：

- 一个能承载经营流程的业务后台
- 一组可直接接入的 AI 协作能力
- 一套支持白标化与私有部署的系统骨架
- 一条从空间、资源到任务、交付的数字化链路

我们开源 `GalaxyOPC`，不是为了把“源码丢出来”，而是希望把已经被验证过的产品骨架交给更多人，让不懂技术的创业者不再被技术劝退，让想做 OPC 平台的组织不必从零搭建，让更多超级个体不再孤军奋战。

## 开源信息

- License: `Apache-2.0`
- Runtime: `Node.js + TypeScript`
- Database: `PostgreSQL / SQLite`
- Repository: `https://github.com/P3ngSaM/galaxyopc`

## 主要能力

- 账号体系：手机号/邮箱验证码、JWT、管理员初始化
- 公司经营：公司、联系人、项目、合同、发票、交付、待办
- AI 协作：对话、流式输出、工具调用、蜂群协同
- 白标能力：租户主题、Logo、登录页定制、独立入口
- IoT 空间：多房间空间建模、设备推荐、3D 页面入口
- 本地/云端双模式：PostgreSQL 线上版、SQLite 本地版
- 导出与自动化：文档导出、视频任务、计划任务、工作流调度

## 仓库结构

```text
src/          服务端源码
scripts/      数据处理与运维脚本
tests/        基础测试
e2e-tests/    端到端测试
docs/         开源文档
research/     示例商机地图数据
public/       公共静态资源
uploads/      运行时上传目录占位
```

## 适用场景

- 单机体验或本地部署
- 小团队经营协作后台
- 需要白标化的私有运营后台
- 需要把 AI 对话、业务数据和自动化流程放在同一服务中的项目

## 快速开始

### 1. 环境要求

- Node.js 20+
- npm 10+
- PostgreSQL 14+（线上模式）
- 或 SQLite（本地模式）

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

至少补齐这些配置：

- `JWT_SECRET`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

如果使用本地模式：

- `DB_TYPE=sqlite`
- `SQLITE_PATH=xhopc-local.db`

### 4. 启动开发环境

```bash
npm run dev
```

默认访问地址：

```text
http://localhost:3000
```

### 5. 构建与启动

```bash
npm run build
npm start
```

## 常用脚本

```bash
npm run dev
npm run build
npm start
npm run db:migrate
npm run test:smoke
npm run test:e2e
```

仓库还保留了 `scripts/` 下的数据采集与机会地图生成脚本，但公开仓库中仅附带最小示例数据，不包含原业务数据、客户数据、日志、证书和本地数据库文件。

## 发布文档

- [CHANGELOG.md](CHANGELOG.md)
- [docs/quick-start.md](docs/quick-start.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/deployment.md](docs/deployment.md)

## 配置说明

详细配置见：

- [docs/quick-start.md](docs/quick-start.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/deployment.md](docs/deployment.md)

## 开源范围说明

本仓库已经移除以下内容：

- 私有 `.env` 配置
- 本地数据库与 WAL 文件
- 上传素材与租户图片
- 证书、日志、调试导出文件
- 原始研究样本、业务数据和内部说明文档
- 本地构建产物

`research/` 中仅保留最小示例 JSON，用于帮助项目在开源状态下正常启动和演示。

## License

本项目使用 [Apache-2.0](LICENSE) 开源。

## Notice

版权和归属声明见 [NOTICE](NOTICE)。
