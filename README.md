# MOSS-AI

一个本地部署的多供应商 AI 对话 Web 应用。前端使用 Vue 3 + Vite 构建，后端使用 Express + SQLite，统一代理 OpenAI 兼容协议的多家模型服务（DeepSeek、OpenAI、豆包、通义、SiliconFlow、智谱、MiniMax 及自定义网关），并提供会话持久化、分组管理、联网搜索、图片/PDF 解析、多版本回答等能力。

API Key 由后端统一托管，浏览器不直接持有供应商密钥。

---

## 一、项目概述与核心功能

### 1.1 项目定位

MOSS-AI 是一个**单机/内网可用的 AI 对话客户端**：

- 前端只负责交互与渲染，所有模型请求经后端 `/api/v1/chat/completions` 转发；
- 后端统一处理鉴权、Key 解析、流式透传（SSE）、文件上传与 OCR；
- 数据落地在本地 SQLite（WAL 模式），刷新或重启不丢失；
- `localStorage` 仅作为离线缓存，服务端 SQLite 是单一事实来源。

### 1.2 核心功能

| 功能 | 说明 |
| --- | --- |
| 多供应商对话 | 一套 OpenAI 兼容请求格式对接 7 家预置供应商 + 自定义 OpenAI 兼容网关 |
| 多模型配置 | 可保存多套「模型配置」（供应商 / Base URL / 模型 ID / Key / 温度 / 最大 token / System Prompt），一键切换当前激活模型 |
| 流式回答 | 后端将上游 SSE 原样管道给前端，前端逐字渲染；可随时停止生成 |
| 联网搜索 | DeepSeek 走 Function Calling + 服务端 `/tools/search` 代理；豆包走内置 `web_search_options`，回答附带参考来源 |
| 图片 / PDF 输入 | 支持粘贴、拖拽、选择文件；图片自动压缩并校验真实类型；支持视觉模型直传图片，非视觉模型自动 OCR 兜底；PDF 优先提取文本层，扫描件自动渲染页面 OCR |
| 多版本回答 | 同一次提问并发生成 2～4 个回答并列对比（与联网搜索、附件互斥） |
| 提示词优化 | 调用当前模型将输入改写为更清晰、可执行的提示词，支持一键撤回 |
| 会话管理 | 新建、重命名、置顶（可拖拽排序）、自定义分组、批量删除 / 批量移动、按标题实时搜索 |
| 消息操作 | 复制、重新生成、失败重试、编辑后重发、删除单条消息 |
| 数据导入导出 | 单个会话导出 Markdown / JSON；JSON 会话可导入 |
| 用量统计 | 展示每次回答的 token 用量（上游支持 `stream_options.include_usage` 时） |
| 主题外观 | 浅色 / 深色 / 跟随系统，7 套配色方案 |
| 安全细节 | 上传文件按 magic byte 校验、随机 UUID 文件名；Markdown 渲染过滤危险协议；前端禁用右键 / F12 / Ctrl+U / Ctrl+S |

### 1.3 界面快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Enter` | 发送消息（中文输入法组合输入中不触发） |
| `Shift + Enter` | 输入框换行 |
| `Ctrl/Cmd + K` | 聚焦侧栏「搜索对话」 |
| `Alt + N` | 新建对话 |
| `Esc` | 按优先级关闭确认弹窗（删除确认 → 批量删除 → 删除分组）；设置面板与模型编辑弹窗内部也支持 `Esc` 逐层关闭 |

> `Ctrl/Cmd + N` 被浏览器占用，因此新建对话使用 `Alt + N`。

---

## 二、技术栈说明

### 2.1 前端（`client/`）

| 类别 | 选型 |
| --- | --- |
| 框架 | Vue 3.5（`<script setup>` 单文件组件） |
| 构建工具 | Vite 8 + `@vitejs/plugin-vue` |
| 语法高亮 | highlight.js 11（按需注册约 20 种语言，非全量引入） |
| 样式 | 原生 CSS（`src/styles/globals.css`），CSS 变量 + `data-palette` 主题切换 |
| 状态管理 | 无 Vuex / Pinia，使用 Vue `reactive` / `ref` + composables |
| 路由 | 无 Vue Router，单页面布局（侧栏 + 对话区 + 设置弹层） |
| 网络 | 原生 `fetch` 封装，支持超时、AbortController 取消、错误文案翻译 |

### 2.2 后端（`server/`）

| 类别 | 选型 |
| --- | --- |
| 运行时 | Node.js（ESM，`"type": "module"`） |
| Web 框架 | Express 4 |
| 数据库 | better-sqlite3 11（同步 API，WAL，外键约束） |
| 鉴权 | 单用户固定 Token / 多用户 JWT（`jsonwebtoken`） |
| 文件上传 | multer 2（内存存储 + 大小/数量限制） |
| OCR | tesseract.js 7（`chi_sim + eng`） |
| PDF | pdf-parse（文本层）、pdf-to-img（扫描件渲染后 OCR） |
| 配置 | dotenv（`server/.env`） |
| 跨域 | cors |

### 2.3 通信协议

- 普通接口：JSON over HTTP，`Authorization: Bearer <token>`。
- 对话接口：`POST /api/v1/chat/completions`，`stream: true` 时返回 `text/event-stream`（SSE）。
- 开发期由 Vite 将 `/api`、`/uploads` 代理到 `http://localhost:3000`，并针对 SSE 关闭缓冲；生产期前后端同源。

---

## 三、项目目录结构

```text
MOSS-AI/
├─ client/                       # 前端（Vue 3 + Vite）
│  ├─ index.html                 # HTML 入口（标题 MOSS-AI）
│  ├─ vite.config.js             # /api、/uploads 代理；SSE 防缓冲
│  ├─ package.json
│  └─ src/
│     ├─ main.js                 # 挂载 Vue 应用
│     ├─ App.vue                 # 页面骨架、全局快捷键、删除确认弹窗
│     ├─ api/
│     │  ├─ http.js              # fetch 封装：Token、超时、错误翻译
│     │  ├─ providers.js         # 供应商预设、聊天/搜索/工具调用、Key 管理
│     │  ├─ conversations.js     # 会话 / 分组 / 消息 API
│     │  ├─ models.js            # 模型配置 API
│     │  ├─ settings.js          # UI 设置 API
│     │  └─ uploads.js           # 上传 / OCR / PDF 提取 API
│     ├─ composables/
│     │  ├─ useChat.js           # 会话与消息核心逻辑（发送、搜索 Agent、多版本、导入导出）
│     │  ├─ useModels.js         # 多模型配置管理
│     │  ├─ useSettings.js       # 全局设置（本地 + 后端双向同步）
│     │  └─ useTheme.js          # 主题模式与配色方案
│     ├─ components/
│     │  ├─ Sidebar.vue          # 搜索、分组、置顶拖拽、会话菜单
│     │  ├─ MessageList.vue      # 消息列表、欢迎页、自动滚动
│     │  ├─ MessageItem.vue      # Markdown 渲染、来源、用量、多版本、消息操作
│     │  ├─ ChatInput.vue        # 输入框、附件、联网搜索、多版本、提示词优化
│     │  ├─ SettingsPanel.vue    # 通用 / 对话 / 模型设置
│     │  ├─ ConfirmDialog.vue    # 二次确认弹窗
│     │  ├─ ImagePreview.vue     # 图片预览
│     │  └─ Icon.vue             # 内置图标集
│     ├─ utils/
│     │  ├─ markdown.js          # 轻量 Markdown 解析 + 代码高亮 + XSS 过滤
│     │  └─ clipboard.js         # 复制工具
│     ├─ styles/globals.css      # 全局样式与主题变量
│     └─ assets/                 # favicon、品牌图
├─ server/                       # 后端（Express + SQLite）
│  ├─ src/
│  │  ├─ app.js                  # 服务入口：中间件、路由挂载、静态托管、端口占用提示
│  │  ├─ db.js                   # SQLite 建表、迁移、默认用户初始化
│  │  ├─ middleware/
│  │  │  ├─ auth.js              # 单用户 Token / JWT 鉴权
│  │  │  └─ error.js             # 统一错误与 404 处理
│  │  ├─ routes/
│  │  │  ├─ auth.js              # 登录 / 注册 / 鉴权信息
│  │  │  ├─ chat.js              # 供应商列表、Key 管理、连通性测试、对话与搜索代理
│  │  │  ├─ conversations.js     # 分组 / 会话 / 消息 CRUD、批量操作
│  │  │  ├─ models.js            # 模型配置 CRUD、激活、Key 读写
│  │  │  ├─ settings.js          # UI 设置读写（白名单）
│  │  │  └─ uploads.js           # 上传、OCR、PDF 文本提取
│  │  └─ services/
│  │     ├─ aiProxy.js           # 供应商预设、Key 解析、流式代理、搜索代理
│  │     ├─ models.js            # 模型配置数据访问
│  │     ├─ providerKeys.js      # 供应商级 Key 存取
│  │     └─ userSettings.js      # UI 设置存取
│  ├─ data/                      # 运行时数据（默认，可被 DATA_DIR 覆盖）
│  │  ├─ moss-ai.db              # SQLite 主库（WAL：另有 -shm / -wal）
│  │  ├─ uploads/                # 上传的图片 / PDF
│  │  └─ tessdata/               # OCR 语言包缓存
│  ├─ inspect-db.mjs             # 终端查看数据库（敏感字段脱敏）
│  ├─ .env.example               # 配置模板
│  └─ package.json
├─ logs/                         # start.bat 启动后的运行日志
│  ├─ server.log / server.err.log
│  └─ client.log / client.err.log
├─ start.bat                     # Windows 一键启动（自动安装依赖、后台运行、健康检查）
├─ stop.bat                      # Windows 一键停止（PID + 端口兜底）
├─ server.pid / client.pid       # 运行时 PID 文件（自动生成）
└─ web.html                      # 早期独立的 DeepSeek 直连调试页（非主应用，勿部署）
```

---

## 四、环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 20.19**（Vite 8 的最低要求），建议使用 22 LTS；后端依赖 Node 18+ 的全局 `fetch` 与 `Readable.fromWeb` |
| npm | 随 Node.js 安装即可 |
| 操作系统 | Windows（`start.bat` / `stop.bat` 依赖 cmd + PowerShell）；macOS / Linux 可手动启动 |
| 浏览器 | 支持 SSE、`createImageBitmap`、Canvas 的现代浏览器（Chrome / Edge / Firefox / Safari 新版本） |
| 原生依赖 | `better-sqlite3` 为原生模块，通常使用预编译二进制；若安装失败需具备 Python + C++ 构建工具链 |
| 网络 | 能访问所选 AI 供应商 API；使用 OCR 首次识别时需联网下载语言包（也可提前放入 `server/data/tessdata/`） |

---

## 五、快速开始指南

### 5.1 获取代码与安装依赖

在项目根目录执行：

```bash
# 后端
cd server
npm install

# 前端
cd ../client
npm install
```

安装完成后回到根目录。`start.bat` 检测到 `node_modules` 缺失时也会自动执行安装。

### 5.2 配置后端环境变量

复制模板并填写：

```bash
cd server
copy .env.example .env      # Windows
# cp .env.example .env      # macOS / Linux
```

`server/.env` 关键配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端监听端口 |
| `AUTH_MODE` | `single` | `single` 单用户固定 Token；`multi` 多用户 JWT |
| `SINGLE_USER_TOKEN` | `moss-local-dev-token-2026` | 单用户模式访问 Token，**必须与前端 `VITE_SERVER_TOKEN` 一致** |
| `JWT_SECRET` | — | 多用户模式 JWT 密钥，生产必须改为长随机串 |
| `JWT_EXPIRES_IN` | `7d` | JWT 有效期 |
| `DEEPSEEK_API_KEY` 等 | 空 | 各供应商 Key；留空则该供应商显示「未配置」 |
| `DEFAULT_PROVIDER` / `DEFAULT_MODEL` | `deepseek` / `deepseek-chat` | 模板中保留的默认回退配置（当前界面的实际模型以「模型设置」为准） |
| `DATA_DIR` | `server/data` | 可选。数据库、上传文件、OCR 缓存的存放目录（适用于只读文件系统部署） |

> 也可以不写 `.env`，直接在应用内「设置 → 模型设置」为每个模型配置填写 Key，Key 会保存到 SQLite 的 `models.api_key` 字段。

**前端可选环境变量**（`client/.env`，构建时注入）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_SERVER_TOKEN` | `moss-local-dev-token-2026` | 前端默认携带的访问 Token，需与后端一致 |
| `VITE_API_BASE` | `/api/v1` | API 前缀，同源部署时无需修改 |
| `VITE_DIRECT_MODE` | 未设置 | 设为 `true` 时前端直连供应商（调试用，需在前端持有 Key） |

### 5.3 启动

#### 方式 A：Windows 一键启动（推荐）

双击根目录 `start.bat`：

1. 检查 Node.js；
2. 缺少依赖时自动 `npm install`；
3. 后台启动后端（3000）与前端（5173），日志写入 `logs/`；
4. 健康检查 `http://127.0.0.1:3000`。

访问前端：**http://localhost:5173**

停止：双击 `stop.bat`（优先按 PID 文件结束，再按 3000 / 5173 端口兜底）。

#### 方式 B：手动分别启动（跨平台）

```bash
# 终端 1：后端（热重载）
cd server
npm run dev

# 终端 2：前端
cd client
npm run dev
```

- 后端：http://localhost:3000
- 前端：http://localhost:5173
- 健康检查：http://localhost:3000/api/health

### 5.4 首次使用配置

1. 打开 http://localhost:5173 ；
2. 点击左下角「设置」→「模型设置」；
3. 首次启动会自动创建默认模型「默认 - DeepSeek」；
4. 编辑该配置，选择供应商、填写 Base URL 与模型 ID，并在「API Key」中粘贴密钥；
5. 点击「测试连接」确认可达，保存并设为激活；
6. 返回对话页开始提问。

> 联网搜索需在输入框工具栏开启；仅 DeepSeek（tools 模式）与豆包（native 模式）已适配。

---

## 六、功能使用说明

### 6.1 模型设置（设置 → 模型设置）

- 一套「模型配置」包含：配置名称、Provider、请求地址（Base URL）、模型 ID、API Key、Temperature、最大 token、System Prompt。
- 「请求地址」默认按供应商预设自动填充；若填入的是**完整请求地址**，可关闭「自动拼接 `/chat/completions`」（`appendPath = false`）。
- 「测试连接」会以 `max_tokens: 5` 发起一次最小请求验证 Key 与地址。
- 「测试搜索」按供应商搜索模式真实发起一次搜索：tools 模式请求 `/tools/search`，native 模式在对话中开启内置搜索并检查引用标注。
- Key 解析优先级：**请求显式传入 > 模型配置 `models.api_key` > 供应商级 Key（`settings.provider_key:*`）> `.env`**。

### 6.2 对话与消息

- 发送后自动以首条消息前 20 个字符作为会话标题；
- 助手消息气泡可复制、重新生成、失败重试、编辑用户消息后重发、删除；
- 联网搜索结果以「参考来源 N」折叠展示；
- 多版本回答以标签页并列展示，每个版本独立显示 token 用量；
- 生成过程中可点击「停止」，已生成内容保留并追加 `[已停止]` 标记。

### 6.3 会话侧栏

- 顶部搜索框按标题实时过滤（`Ctrl/Cmd + K` 聚焦）；
- 「置顶」区块独立展示，可拖拽调整顺序；
- 自定义分组可新建、重命名、折叠、删除（删除后组内会话回到「未分组」）；
- 会话右键/更多菜单支持置顶、移动到分组、导出 Markdown、导出 JSON、删除；
- 多选模式支持批量删除与批量移动。

### 6.4 附件（图片 / PDF）

- 支持粘贴、拖拽、文件选择；单次最多 4 个，单个不超过 10MB；
- 支持 PNG / JPG / WEBP / GIF / PDF，服务端按文件头（magic byte）判定真实类型；
- 图片大于 400KB 时前端压缩（长边 1568、JPEG 0.85）；
- 视觉模型（如 `deepseek-flash`、`gpt-4o`、`doubao-seed-*`）：最近两轮图片以 data URL 直传；
- 非视觉模型：图片自动 OCR 后以文本注入；PDF 始终提取文本层，扫描件自动渲染前 5 页 OCR；
- 历史轮次附件会以占位文本省略，避免上下文无限膨胀。

### 6.5 导入 / 导出

- 导出：会话菜单 →「导出对话」→ Markdown 或 JSON；
- 导入：设置 →「对话设置」→「导入对话」，选择 JSON 文件；
- 导入会逐一写入后端；格式非法时给出具体到第几条消息的错误提示。

### 6.6 外观

- 主题模式：浅色 / 深色 / 跟随系统；
- 配色方案：靛蓝、海洋、森林、樱花、日落、紫罗兰、石墨；
- 主题与配色保存在 `localStorage`，不写入服务端。

---

## 七、开发指南

### 7.1 启动脚本

| 目录 | 命令 | 说明 |
| --- | --- | --- |
| `server` | `npm run dev` | `node --watch src/app.js` 热重载 |
| `server` | `npm start` | 生产模式启动 |
| `server` | `npm run init-db` | 执行 `src/db.js`，建表并补迁移 |
| `server` | `node inspect-db.mjs [表名]` | 打印数据库内容（Key / 密码脱敏） |
| `client` | `npm run dev` | Vite 开发服务器（5173） |
| `client` | `npm run build` | 构建到 `client/dist` |
| `client` | `npm run preview` | 预览构建产物 |

### 7.2 后端架构

- **入口** [server/src/app.js](server/src/app.js)：
  - 公开路由：`/api/health`、`/api/v1/auth/*`、`/uploads/*` 静态文件；
  - 鉴权路由：`requireAuth` 后挂载 models / settings / chat / conversations / uploads；
  - 若存在 `server/public/`，自动托管前端构建产物并做 SPA fallback；
  - 端口占用时用 `netstat` 解析占用 PID 并给出处理提示。
- **鉴权** [server/src/middleware/auth.js](server/src/middleware/auth.js)：
  - `single`：Token 与 `SINGLE_USER_TOKEN` 全等即通过，用户固定为 `default`；
  - `multi`：校验 JWT，`payload.uid` 作为用户 ID；
  - Token 支持 `Authorization: Bearer` 或 `?token=`。
- **AI 代理** [server/src/services/aiProxy.js](server/src/services/aiProxy.js)：
  - 供应商预设（baseUrl / 默认模型）、env Key 映射、搜索能力表；
  - `resolveProvider()` 完成 Key 优先级解析；
  - 流式时用 `Readable.fromWeb(upstream.body).pipe(res)` 透传，并监听 `res` 关闭以中止上游请求。
- **数据层** [server/src/db.js](server/src/db.js)：
  - 启动即建表并执行幂等迁移（补列、清理历史 settings 键）；
  - 自动创建单用户默认用户与内置分组。

### 7.3 数据库结构

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | `id`, `username`, `password_hash` | 单用户模式只有 `default` |
| `groups` | `id`, `user_id`, `name`, `builtin`, `collapsed` | 内置分组不可改名/删除 |
| `conversations` | `id`, `user_id`, `group_id`, `title`, `pinned`, `pin_order` | `group_id` 为空表示未分组 |
| `messages` | `id`, `conversation_id`, `role`, `content`, `timestamp`, `sources`, `searching`, `search_query`, `usage`, `variants`, `attachments` | JSON 字段以 TEXT 存储 |
| `models` | `id`, `user_id`, `name`, `provider`, `model`, `base_url`, `append_path`, `api_key`, `temperature`, `max_tokens`, `system_prompt`, `is_active` | 每用户至多一个 `is_active = 1`（唯一索引保证） |
| `settings` | `user_id`, `key`, `value` | UI 设置（JSON 编码）与 `provider_key:*` |

所有业务表通过 `user_id` / `conversation_id` 做归属隔离；删除会话级联删除消息，删除分组会把会话置为未分组。

### 7.4 后端 API 一览

所有 `/api/v1/*` 接口（除 `auth`）均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/v1/auth/info` | 鉴权模式与 Token 提示 |
| POST | `/api/v1/auth/login` | 登录（single 模式直接返回 Token） |
| POST | `/api/v1/auth/register` | 注册（仅 multi 模式） |
| GET | `/api/v1/providers` | 供应商列表、搜索能力、Key 配置来源 |
| PUT | `/api/v1/providers/:provider/key` | 保存供应商级 Key |
| DELETE | `/api/v1/providers/:provider/key` | 清除供应商级 Key |
| POST | `/api/v1/test-connection` | 测试供应商连通性 |
| POST | `/api/v1/chat/completions` | 统一对话代理（流式 / 非流式） |
| POST | `/api/v1/tools/search` | 联网搜索代理（tools 模式） |
| GET | `/api/v1/models` | 模型配置列表（不含 Key） |
| POST | `/api/v1/models` | 新建模型配置 |
| GET | `/api/v1/models/:id` | 模型配置详情（含 Key） |
| PUT | `/api/v1/models/:id` | 更新模型配置（不触碰 Key） |
| DELETE | `/api/v1/models/:id` | 删除模型配置 |
| POST | `/api/v1/models/:id/activate` | 设为当前激活模型 |
| GET | `/api/v1/models/:id/key` | 读取有效 Key 及来源 |
| PUT | `/api/v1/models/:id/key` | 保存模型专属 Key |
| DELETE | `/api/v1/models/:id/key` | 清除模型专属 Key |
| GET | `/api/v1/settings` | 读取 UI 设置（白名单） |
| PUT | `/api/v1/settings` | 批量保存 UI 设置 |
| GET | `/api/v1/conversations` | 会话列表（支持 `?groupId=`） |
| POST | `/api/v1/conversations` | 新建会话 |
| GET | `/api/v1/conversations/:id` | 会话详情 + 消息 |
| PATCH | `/api/v1/conversations/:id` | 更新标题 / 置顶 / 排序 / 分组 |
| DELETE | `/api/v1/conversations/:id` | 删除会话 |
| POST | `/api/v1/conversations/batch-delete` | 批量删除 |
| POST | `/api/v1/conversations/batch-move` | 批量移动分组 |
| POST | `/api/v1/conversations/:id/messages` | 追加消息 |
| PATCH | `/api/v1/messages/:id` | 更新消息 |
| DELETE | `/api/v1/messages/:id` | 删除消息 |
| GET / POST | `/api/v1/groups` | 分组列表 / 新建 |
| PATCH / DELETE | `/api/v1/groups/:id` | 重命名、折叠 / 删除 |
| POST | `/api/v1/uploads` | 上传图片 / PDF（`files` 字段，最多 4 个） |
| POST | `/api/v1/ocr` | 图片 OCR |
| POST | `/api/v1/pdf/extract` | PDF 文本提取（含 OCR 兜底） |
| GET | `/uploads/:file` | 上传文件静态访问（7 天缓存） |

### 7.5 前端架构

- **状态来源**：`useChat`（会话/消息）、`useModels`（模型配置）、`useSettings`（全局设置）、`useTheme`（主题）。均为模块级单例，组件间共享同一状态。
- **初始化顺序**：
  1. `useSettings` 从后端拉取 `stream / webSearch / branchMode / branchCount` 并合并本地值；
  2. `useModels` 拉取模型列表，后端为空时自动创建默认 DeepSeek 配置；
  3. `useChat` 拉取分组与会话列表（消息懒加载），若服务端没有任何会话则尝试把旧 `localStorage` 数据迁移上去。
- **持久化策略**：先更新内存与 `localStorage` 保证 UI 即时响应，再异步写后端；失败仅告警不回滚。
- **渲染安全**：`utils/markdown.js` 自实现轻量解析，链接协议白名单 + HTML 转义，代码块使用 highlight.js。

### 7.6 扩展新的 AI 供应商

1. 后端 [aiProxy.js](server/src/services/aiProxy.js)：在 `PROVIDERS` 增加预设，在 `PROVIDER_ENV` 增加 env 变量映射；如支持联网搜索，补充 `SEARCH_MODES`。
2. 前端 [providers.js](client/src/api/providers.js)：在 `PROVIDERS` 增加同名配置（label、baseUrl、defaultModel、models、searchMode）。
3. 若支持图片输入：在前端 `VISION_MODEL_PATTERNS` 增加模型名正则。
4. 在 `server/.env.example` 增加对应 Key 占位。
5. 前端「模型设置」选择该供应商后即可测试连通性。

### 7.7 新增后端接口

1. 在 `server/src/routes/` 新建路由文件，使用 `createError()` 抛业务错误；
2. 在 `app.js` 中以 `app.use('/api/v1', requireAuth, xxxRoutes)` 挂载；
3. 在 `client/src/api/` 增加对应调用函数，统一走 `http.js` 的 `getJSON / postJSON / ...`。

---

## 八、部署流程

项目没有内置 Dockerfile 或 CI 配置，推荐按「前端构建产物交给后端同源托管」的方式部署。

### 8.1 构建前端

```bash
cd client
# 生产构建前请确保 Token 与后端一致（构建时注入，之后不可修改）
# Windows PowerShell: $env:VITE_SERVER_TOKEN="你的生产Token"; npm run build
VITE_SERVER_TOKEN=你的生产Token npm run build
```

> 若未设置 `VITE_SERVER_TOKEN`，前端会使用默认 Token `moss-local-dev-token-2026`，必须保证后端 `SINGLE_USER_TOKEN` 与之一致，否则所有请求 401。

### 8.2 交由后端托管

`server/src/app.js` 会检测 `server/public/`：存在即托管静态文件并做 SPA fallback。

```bash
# 在项目根目录
# Windows
xcopy /E /I /Y client\dist server\public

# macOS / Linux
cp -r client/dist server/public
```

### 8.3 配置并启动后端

```bash
cd server
# 生产环境建议：
#   AUTH_MODE=single + 强随机 SINGLE_USER_TOKEN，或 AUTH_MODE=multi + 强随机 JWT_SECRET
#   NODE_ENV=production
#   如文件系统只读，设置 DATA_DIR=/var/lib/moss-ai（或容器可写卷）
npm start
```

访问 `http://<服务器>:3000` 即为完整应用（前端 + API 同源）。

### 8.4 反向代理注意事项

- SSE 必须关闭响应缓冲：
  - Nginx：`proxy_buffering off; proxy_set_header X-Accel-Buffering no;`
  - 后端已主动设置 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`；
- 上传大小：后端单文件上限 10MB、单次最多 4 个，反向代理的 `client_max_body_size` 需大于该值；
- `/uploads/` 为随机 UUID 文件名，建议保持 7 天静态缓存；
- 应用本身只提供固定 Token 鉴权，**公网部署前请在反向代理层增加 HTTPS 与额外访问控制**。

### 8.5 数据备份

备份 `DATA_DIR`（默认 `server/data`）即可，包含：

- `moss-ai.db`（及 `-wal` / `-shm`，建议先停服或执行 WAL checkpoint）；
- `uploads/`（附件）；
- `tessdata/`（OCR 语言包，可重新下载）。

---

## 九、常见问题（FAQ）

**Q1：所有请求返回 401，提示「Token 无效」？**

前端 `VITE_SERVER_TOKEN`（或构建时注入值 / `localStorage` 中的 `ai-chat-server-token`）与后端 `SINGLE_USER_TOKEN` 不一致。两者改为同一值后刷新；必要时清除 `localStorage` 中的旧 Token。

**Q2：启动后端报「端口 3000 已被占用」？**

服务端会自动用 `netstat` 打印占用 PID。执行 `taskkill /PID <pid> /F`，或修改 `server/.env` 的 `PORT`（同时需改 `client/vite.config.js` 的代理目标）。

**Q3：流式回答卡住、一直不显示？**

通常是代理缓冲导致。开发期已由 `vite.config.js` 的 `selfHandleResponse` 关闭缓冲；生产环境请确认 Nginx 关闭 `proxy_buffering`，并保留 `X-Accel-Buffering: no`。

**Q4：`npm install` 时 better-sqlite3 编译失败？**

确认 Node 版本与平台匹配；Windows 可安装「Desktop development with C++」构建工具，或改用 Node LTS 版本以命中预编译包。

**Q5：上传图片后模型看不懂图片？**

仅部分模型支持视觉输入。非视觉模型会自动 OCR（中英文），准确率有限；PDF 始终提取文本层。可在输入框附件按钮的提示中确认当前模型是否支持识图。

**Q6：首次 OCR 很慢或失败？**

tesseract.js 首次需要下载 `chi_sim` / `eng` 语言包到 `DATA_DIR/tessdata`。内网环境可提前把语言包放入该目录；也可适当放宽 `uploads.js` 中的超时配置。

**Q7：联网搜索开关是灰的 / 搜索报错？**

当前仅适配 DeepSeek（服务端 `/tools/search`，需该接口可用）与豆包（需在火山方舟控制台开通内置搜索）。其他供应商会提示未适配；可在「模型设置 → 测试搜索」中自查。

**Q8：对话记录会不会丢？**

服务端 SQLite 是主数据源，`localStorage` 只是缓存。只要 `server/data` 未被删除，重启不丢。若首次启动服务端为空，会自动把浏览器里的旧数据迁移上去。

**Q9：为什么右键和 F12 没反应？**

`App.vue` 主动屏蔽了右键、F12、`Ctrl+U`、`Ctrl+S`，减少误操作。调试时可直接通过浏览器菜单打开开发者工具。

**Q10：`start.bat` 启动后看不到窗口？**

服务以隐藏窗口后台运行，日志在 `logs/`。查看 `logs/server.err.log`、`logs/client.err.log` 排查；`stop.bat` 可全部结束。

**Q11：可以公网多人使用吗？**

可以切换到 `AUTH_MODE=multi`（JWT + 注册/登录），但当前密码为明文比较（代码中预留了 bcrypt 位置），且供应商 Key 在 SQLite 中明文存储。公网场景请自行加固：HTTPS、反向代理鉴权、密码哈希、密钥加密与访问限流。

**Q12：根目录 `web.html` 是什么？**

早期用于验证 DeepSeek 直连与流式解析的独立调试页，内含明文 Key 示例，**不属于主应用，请勿部署或提交到公开仓库**。

---

## 十、贡献指南

欢迎提交 Issue 与 Pull Request。

### 10.1 开发约定

- **语言与风格**：JavaScript（ESM）+ Vue 3 `<script setup>`；沿用现有 2 空格缩进、无分号风格（与仓库一致）。
- **注释**：仅解释「为什么」，不重复代码字面含义。
- **前端**：新增网络请求统一放在 `client/src/api/`，通过 `http.js` 发送；新增共享状态使用 composable。
- **后端**：路由只做参数校验与响应，业务逻辑放 `services/`，错误统一用 `createError(status, message)`。
- **安全**：不要在前端硬编码供应商 Key；不要拼接未过滤的路径或 SQL；新增外部链接渲染需经过 `sanitizeUrl`。

### 10.2 提交前自检

1. `cd server && npm run dev` 正常启动，`GET /api/health` 返回 `{ status: "ok" }`；
2. `cd client && npm run build` 构建无错误；
3. 至少手动验证：发送消息、流式停止、切换会话、上传图片、打开设置；
4. 不提交 `.env`、`server/data/`、`logs/`、`node_modules/` 等运行时或敏感内容。

### 10.3 提交信息建议

```text
feat: 支持 xxx 供应商
fix: 修复流式响应在 xxx 场景中断
docs: 更新部署说明
refactor: 抽取 xxx 服务
```

### 10.4 新增功能时的检查清单

- [ ] 是否同时处理「后端代理模式」与「直连模式」（`VITE_DIRECT_MODE`）？
- [ ] 是否兼容旧数据库（需要时在 `db.js` 中补幂等迁移）？
- [ ] 是否处理了失败、取消（`AbortError`）与超时？
- [ ] 是否避免把供应商 Key 或敏感信息返回给前端 / 写入日志？
- [ ] 是否会显著增大上下文或请求体积（附件、历史消息）？
