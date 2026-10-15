# friday-agent-next

把原 `friday-agent`（FastAPI 后端 + Next.js 前端，两个进程）重写成**同源全栈 Next.js 应用**：
页面与 `/api/*` 后端跑在**同一个 Node 进程、同一个端口（3333）**，不再有独立的 Python 后端。

- **流式对话**：AI SDK v7 + SSE，支持「深度思考」「联网搜索」开关
- **两级记忆**：会话级滚动摘要（超预算自动压缩）+ 用户级长期记忆（GLM 抽取）
- **Agent 工具**：内置 Bash / Read / Write / Edit / Glob / Grep + 任务清单；外挂 MCP 工具（医学 RAG 检索、联网搜索）
- **鉴权**：JWT（jose）+ argon2id 口令 + svg-captcha 图形验证码
- **UI**：antd 5 + Tailwind v4 + zustand；Markdown / KaTeX / Mermaid 渲染；深浅色主题由 cookie SSR 直出（无闪动）

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16.4（App Router + Turbopack）+ React 19.3 + TypeScript 5 |
| 样式 | Tailwind v4（`@tailwindcss/turbopack` 加载器）+ antd 5 + CSS 变量主题 |
| 数据库 | PostgreSQL 16（Docker）+ Drizzle ORM / drizzle-kit |
| 模型 | AI SDK v7 + `@ai-sdk/openai-compatible`：DeepSeek（主对话）、GLM（摘要/记忆） |
| 鉴权 | `jose`（JWT）+ `@node-rs/argon2`（口令）+ `svg-captcha`（验证码） |
| 工具 | `@modelcontextprotocol/sdk` / `@ai-sdk/mcp`（连 mcp-server）+ 自研内置工具 |
| 状态 | zustand（`src/store`） |

## 目录结构

```
src/
  app/
    layout.tsx              根布局：cookie 读主题/侧栏状态 → <html data-theme>，AntdRegistry + Providers
    globals.css             Tailwind 入口、层序声明（antd reset 分层）、设计 token、.md 排版
    page.tsx                / → 重定向到 /chat
    login/ register/        登录、注册页
    (main)/
      layout.tsx            挂一次 Shell（侧栏/顶栏），路由切换不重挂
      chat/                 新对话页
      chat/[conversationId]/ 会话页
      history/              历史记录（搜索 + 分页）
    api/                    后端（Route Handlers，见下方 API 一览）
  components/               AuthPage / Shell / ChatWorkspace / Markdown / LoadMore / Logo / ThemeToggle
  db/                       Drizzle 实例与 schema（users / conversations / messages / user_memories）
  lib/
    agent/                  mcp.ts（MCP 接线与白名单）、tools.ts（内置工具）、paths.ts（会话工作目录）、prompts.ts
    auth/                   captcha.ts、jwt.ts、password.ts、guard.ts
    chat/context.ts         会话级记忆：回放窗口裁剪 + 滚动摘要
    api.ts http.ts env.ts models.ts conversations.ts files.ts
  store/                    zustand：auth（token/user）、ui（侧栏折叠）
drizzle/                    迁移 SQL 与快照（0000、0001）
scripts/dev-seed-user.mts   本地建测试用户并打印 JWT（绕过验证码，便于 curl 调试）
files/                      上传的附件（运行时数据）
workspaces/                 Agent 各会话的工作目录（运行时数据）
```

## 快速开始

前置：**Node ≥ 20.9**（Next 16 要求，本机 22.x）、**Docker**（起 Postgres）。

```bash
# 1. 依赖
npm install

# 2. 配置环境变量（JWT_SECRET 必须设置，弱值会直接启动失败）
cp .env.example .env
openssl rand -hex 32        # 把输出填到 .env 的 JWT_SECRET

# 3. 一键启动本地服务（PostgreSQL + Next.js，日志写入 .run/）
npm run local:start

# 4. 建表（应用 drizzle/ 下的迁移）
npx drizzle-kit migrate

# 停止本地服务（保留 PostgreSQL 数据卷）
npm run local:stop

# 也可以分别执行：docker compose up -d / npm run dev
```

打开启动脚本输出的 Next.js 地址（默认是 **http://localhost:3333**；如果端口被占用会自动顺延）→ 注册一个账号，或直接建开发账号：

```bash
npx tsx scripts/dev-seed-user.mts devtester   # 口令固定 test123456；输出 { user_id, token }
```

脚本会把 JWT 一并打印出来，方便绕过验证码直接 curl 调试：

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:<实际端口>/api/auth/me
```

> 想看假流（不需要任何模型 key）：`.env` 里保持 `MODEL_PROVIDER=demo` 即可，回复由本地假流生成。
> 想接真模型：`MODEL_PROVIDER=deepseek` + 填 `OPENAI_API_KEY`（智谱 key 可选，只影响摘要/长期记忆）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_ENV` | `development` | 运行环境标记 |
| `DATABASE_URL` | `postgresql://friday:friday@localhost:5433/friday_agent` | 本项目的库（**与旧项目不同实例**，见下） |
| `JWT_SECRET` | 无（必填） | 签发 token 与验证码签名；弱值/空值会让进程启动即抛错 |
| `JWT_EXPIRE_MINUTES` | `10080` | token 有效期（分钟），默认 7 天 |
| `MODEL_PROVIDER` | `demo` | `demo` = 本地假流；`deepseek` = OpenAI 兼容直连 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 空 / `https://api.deepseek.com` | 主对话模型 |
| `OPENAI_MODEL` / `OPENAI_THINKING_MODEL` | `deepseek-flash` | 普通 / 深度思考模式用模型，均支持图片输入；思考模式由按钮控制 |
| `ZHIPU_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL` | 空 / 智谱地址 / `glm-5.3-flash` | 滚动摘要与长期记忆抽取 |
| `MCP_SERVER_URL` | `http://127.0.0.1:8806/mcp` | MCP 工具服务（沿用旧项目的实例，勿改其配置） |
| `MCP_AUTH_TOKEN` | 空 | MCP 服务鉴权；与旧项目保持一致 |
| `CONTEXT_TOKEN_BUDGET` | `1000` | 会话回放窗口的 token 预算 |
| `SUMMARY_MAX_TOKENS` / `SUMMARY_MIN_OVERFLOW_TOKENS` | `500` / `200` | 滚动摘要长度与触发阈值 |
| `MEMORY_ENABLED` | `true` | 是否启用用户级长期记忆 |
| `MEMORY_EXTRACT_MIN_MESSAGES` / `MEMORY_MAX_TOKENS` | `1` / `500` | 长期记忆抽取频率与长度 |
| `AGENT_TOOLS_ENABLED` | `true` | 是否启用内置 Agent 工具 |
| `WORKSPACES_DIR` | `workspaces` | 会话工作目录根路径 |

## 数据库

- 连接串：`postgresql://friday:friday@localhost:5433/friday_agent`（容器 `friday-agent-next-postgres`，数据卷 `friday_agent_next_pgdata`）
- 表：`users`、`conversations`、`messages`、`user_memories`（定义见 [src/db/schema.ts](src/db/schema.ts)）
- 迁移命令：

```bash
npx drizzle-kit generate   # 改完 schema 后生成新的 SQL
npx drizzle-kit migrate    # 应用 drizzle/ 下未执行的迁移
npx drizzle-kit push       # 开发期直接把 schema 同步到库（不走迁移文件）
npx drizzle-kit studio     # 可视化查看数据
```

- 直连：`docker exec -it friday-agent-next-postgres psql -U friday -d friday_agent`

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/captcha` | 签发图形验证码（返回 `image` + 签名 `token`） |
| POST | `/api/auth/register` | 注册（用户名 / 口令 / 验证码） |
| POST | `/api/auth/login` | 登录，返回 `access_token` |
| GET | `/api/auth/me` | 当前用户（需 `Authorization: Bearer <token>`） |
| GET / POST | `/api/conversations` | 会话列表（分页）/ 新建会话 |
| GET / PATCH / DELETE | `/api/conversations/[id]` | 会话详情（含消息）/ 改标题 / 删除 |
| POST | `/api/conversations/[id]/messages` | **发消息 + 流式回复**（SSE） |
| DELETE | `/api/conversations/[id]/messages/[messageId]` | 删除单条消息 |
| POST | `/api/files` | 上传附件 |
| GET | `/api/files/[name]` | 读取附件（鉴权路由，`<img>` 场景由前端转 blob） |
| GET | `/api/workspaces/[cid]/[...path]` | 读取会话工作目录里的产出文件 |

## 架构要点

- **同源全栈**：[src/lib/api.ts](src/lib/api.ts) 里 `API_URL = '/api'`，前端不跨进程调用；原先指向独立 FastAPI 后端。
- **鉴权**：除注册/登录/验证码/健康检查外，所有 API 走 `Authorization: Bearer`；页面本身是客户端应用，未登录由客户端跳 `/login`。
- **流式对话**：`POST /api/conversations/[id]/messages` 用 `streamText` 生成并回传 UI 消息流；每轮请求临时建立 MCP 会话，不可达时静默降级（不阻断对话）。
- **两级记忆**：`lib/chat/context.ts` 按 `CONTEXT_TOKEN_BUDGET` 裁剪回放窗口，溢出部分交给 GLM 滚动摘要；用户级长期记忆异步抽取到 `user_memories`。
- **工具执行目录**：每个会话固定一个 `workspaces/<conversationId>` 作为 cwd，内置工具的读写都被限制在该目录语义内。
- **主题**：`friday_theme` / `friday_sidebar` 两个 cookie 由根布局在服务端读取并写到 `<html data-theme/data-sidebar>`，首帧即最终外观。

## 与 friday-agent（旧项目）的数据边界

| 数据 | 是否共享 |
|---|---|
| PostgreSQL（用户、会话、消息、长期记忆） | ❌ 各自独立（本项目 5433，旧项目 5432，同名不同实例） |
| 上传附件 `files/`、会话工作目录 `workspaces/`、`skills/` | ❌ 各自独立 |
| JWT 密钥（token 不通用） | ❌ 各自独立 |
| **MCP 工具服务** `http://127.0.0.1:8806/mcp` | ✅ 同一个实例（`MCP_AUTH_TOKEN` 相同） |
| 医学 RAG 语料（`med-es` Elasticsearch，索引 `medical_documents` / `medical_chunks_v2`） | ✅ 经 MCP 工具间接共用 |

由此带来一个耦合：**MCP 服务由旧项目的 `start.sh` 负责拉起**，停掉旧项目会让本项目的联网搜索 / 医学检索工具不可用。

## 注意事项（踩过的坑）

1. **端口**：直接执行 `npm run dev` / `npm start` 时固定为 3333；执行 `npm run local:start` 时从 3333 开始自动寻找可用端口，并在启动输出中显示实际地址。**在 `.env` 里写 `PORT` 无效** —— Next CLI 在读取 `.env` 之前就已确定端口，只认进程环境变量（`PORT=3333 npm run dev` 也有效，但 CLI 的 `-p` 优先级更高）。
2. **antd 的 CSS-in-JS 必须只有一份 `@ant-design/cssinjs`**（`package.json` 里显式锁 `^1.24.0` + `overrides`）。`@ant-design/nextjs-registry` 的 peer 是 `>=1.0.0`，npm 默认会装 v2，而 antd 用 v1 —— 两个实例的 React Context 不互通，SSR 抽取结果为空、首帧完全没有 antd 样式，水合后才补上（表现为**刷新时样式挤压/抖动**）。升级依赖后跑一次 `npm ls @ant-design/cssinjs`，确认只剩一份。
3. **antd reset 必须分层**：`antd/dist/reset.css` 是无层级（unlayered）样式，会压过 Tailwind v4 放在 `@layer utilities` 里的所有工具类（层叠规则：无层级 > 有层级，与特异性无关）。因此它在 [globals.css](src/app/globals.css) 里以 `@import "..." layer(antd-reset)` 引入，并在文件顶部声明层序。用包名（`@import "antd/dist/reset.css"`）而非相对路径会**被静默丢弃**。
4. **用 `127.0.0.1` 打开时必须配 `allowedDevOrigins`**（已在 [next.config.ts](next.config.ts) 配好）。否则 Next 会把 `/_next/*` 开发资源当跨源请求拦掉，页面只渲染 SSR 首帧、**完全不水合**（验证码不加载、按钮点了没反应）。
5. **验证码是无状态签名 token**：答案只以 HMAC 指纹形式存在 token 里（服务端不落库/不落内存），TTL 10 分钟、一次性核销。改后端代码触发热更新或重启 dev server **不会**让已发出的验证码失效；但登录失败后前端会自动换图并清空输入框，需要重新看图输入。
6. `files/`（上传附件）和 `workspaces/`（各会话工作目录）是运行时数据，目前没有进 `.gitignore`，提交前留意别把本地上传/产出一起提交。根目录的 `skills/` 是空目录、代码里没有任何引用（旧项目的技能在 `friday-agent/backend/skills/`）。

## 常用命令

```bash
npm run dev            # 开发服务器（Turbopack，端口 3333）
npm run build          # 生产构建
npm start              # 生产启动（端口 3333）
npm run lint           # ESLint
npx tsc --noEmit       # 类型检查
npx drizzle-kit migrate
npx tsx scripts/dev-seed-user.mts <username>
docker compose up -d / docker compose stop
```
