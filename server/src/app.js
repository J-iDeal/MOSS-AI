/**
 * MOSS AI Web 后端主入口
 *
 * 启动：
 *   node src/app.js          — 直接运行
 *   npm run dev              — --watch 热重载
 *
 * 配置：复制 .env.example → .env 并填入各供应商 Key
 */
import 'dotenv/config'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

import { requireAuth } from './middleware/auth.js'
import { errorHandler, notFound } from './middleware/error.js'

import chatRoutes from './routes/chat.js'
import convRoutes from './routes/conversations.js'
import authRoutes from './routes/auth.js'
import settingsRoutes from './routes/settings.js'
import modelsRoutes from './routes/models.js'
import uploadsRoutes, { UPLOAD_DIR } from './routes/uploads.js'

const PORT = Number(process.env.PORT) || 3000
const app = express()

// ==================== 中间件 ====================
app.use(cors({
  origin: true,
  credentials: true,
}))
app.use(express.json({ limit: '2mb' }))

// 请求日志
app.use((req, _res, next) => {
  const t = new Date().toISOString().slice(11, 23)
  console.log(`[${t}] ${req.method.padEnd(6)} ${req.url}`)
  next()
})

// ==================== 公开路由 ====================
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }))
app.use('/api/v1/auth', authRoutes)

// 上传的图片：文件名是随机 UUID，靠不可猜测性保护，供 <img> 直接加载
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  dotfiles: 'deny',
  maxAge: '7d',
  immutable: true,
}))

// ==================== 鉴权路由 ====================
// 单用户模式下 requireAuth 只是比较固定字符串，非常轻量
app.use('/api/v1', requireAuth, modelsRoutes)
app.use('/api/v1', requireAuth, settingsRoutes)
app.use('/api/v1', requireAuth, chatRoutes)
app.use('/api/v1', requireAuth, convRoutes)
app.use('/api/v1', requireAuth, uploadsRoutes)

// ==================== 生产环境静态托管（前端构建产物） ====================
// 仅当 public/ 存在时生效（部署后由 build.sh 拷入）；本地开发无此目录则跳过，
// 由 Vite dev server 托管前端。与 API 同源，匹配 client 的生产部署假设。
const publicDir = path.resolve(__dirname, '..', 'public')
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: 'index.html' }))
  // SPA fallback：非 /api 开头的 GET 请求回退到 index.html，交给前端路由
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

// ==================== 兜底 ====================
app.use(notFound)
app.use(errorHandler)

// ==================== 启动 ====================
const server = app.listen(PORT, () => {
  const mode = (process.env.AUTH_MODE || 'single').toLowerCase()
  const token = process.env.SINGLE_USER_TOKEN || '未设置'
  console.log('')
  console.log('╔══════════════════════════════════════════╗')
  console.log('║        MOSS AI Server 已启动              ║')
  console.log('╠══════════════════════════════════════════╣')
  console.log(`║  端口:        http://localhost:${PORT}`.padEnd(43) + '║')
  console.log(`║  鉴权模式:    ${mode}`.padEnd(43) + '║')
  console.log(`║  Token:       ${mode === 'single' ? token.slice(0, 20) + '...' : '(JWT)'}`.padEnd(43) + '║')
  console.log('╚══════════════════════════════════════════╝')
  console.log('')
  console.log('接口列表:')
  console.log('  GET    /api/health                      — 健康检查')
  console.log('  GET    /api/v1/auth/info                — 鉴权模式 + Token 提示')
  console.log('  POST   /api/v1/auth/login               — 登录（单用户模式返回 Token）')
  console.log('  GET    /api/v1/providers                — 可用供应商列表')
  console.log('  POST   /api/v1/test-connection          — 测试供应商连通性')
  console.log('  POST   /api/v1/chat/completions         — 统一对话代理（流式透传）')
  console.log('  POST   /api/v1/tools/search             — 联网搜索代理')
  console.log('  POST   /api/v1/uploads                  — 图片 / PDF 上传')
  console.log('  POST   /api/v1/ocr                      — 图片文字识别（OCR 兜底）')
  console.log('  POST   /api/v1/pdf/extract              — PDF 文本提取')
  console.log('  GET    /uploads/:file                   — 已上传图片静态访问')
  console.log('  GET    /api/v1/conversations            — 会话列表')
  console.log('  POST   /api/v1/conversations            — 新建会话')
  console.log('  GET    /api/v1/conversations/:id        — 会话详情 + 消息')
  console.log('  PATCH  /api/v1/conversations/:id        — 更新会话')
  console.log('  DELETE /api/v1/conversations/:id        — 删除会话')
  console.log('  POST   /api/v1/conversations/:id/messages  — 追加消息')
  console.log('  PATCH  /api/v1/messages/:id              — 更新消息')
  console.log('  DELETE /api/v1/messages/:id              — 删除消息')
  console.log('  GET    /api/v1/groups                   — 分组列表')
  console.log('  POST   /api/v1/groups                   — 新建分组')
  console.log('  PATCH  /api/v1/groups/:id               — 更新分组')
  console.log('  DELETE /api/v1/groups/:id               — 删除分组')
  console.log('')
})

// 监听启动失败（如端口被占用），给出友好提示，避免抛 Unhandled 'error' 直接崩溃
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const pid = findPidOnPort(PORT)
    console.error('')
    console.error(`✖ 端口 ${PORT} 已被占用，MOSS AI Server 无法启动。`)
    if (pid) {
      console.error(`  占用进程 PID: ${pid}`)
      console.error(`  结束它:  taskkill /PID ${pid} /F`)
    } else {
      console.error(`  未能解析占用进程 PID，请运行: netstat -ano | findstr :${PORT}`)
    }
    console.error('  或者修改 server/.env 里的 PORT 换一个端口。')
    console.error('')
    process.exit(1)
  }
  console.error('Server listen error:', err)
  process.exit(1)
})

// Windows 下用 netstat 解析占用指定端口的 LISTENING 进程 PID
function findPidOnPort(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const cols = line.trim().split(/\s+/)
        const pid = cols[cols.length - 1]
        if (/^\d+$/.test(pid)) return pid
      }
    }
  } catch (_) {
    // 解析失败则降级为通用提示
  }
  return null
}
