/**
 * 鉴权中间件
 * 运行模式由 AUTH_MODE 决定：
 *   - single:  固定 Token（SINGLE_USER_TOKEN），不查库，轻量
 *   - multi:   JWT 校验 + users 表查询（预留）
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'

const AUTH_MODE = (process.env.AUTH_MODE || 'single').toLowerCase()
// 注意：此兜底值必须与 client/src/api/http.js 中的 DEFAULT_TOKEN 保持一致
// 生产部署时请通过 .env 的 SINGLE_USER_TOKEN 和前端构建时的 VITE_SERVER_TOKEN 统一覆盖
const SINGLE_TOKEN = process.env.SINGLE_USER_TOKEN || 'moss-local-dev-token-2026'
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'

export function authMode() {
  return AUTH_MODE
}

/**
 * 生成 JWT（多用户模式注册/登录成功时调用）
 */
export function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

function extractToken(req) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  // 也允许 query 参数（方便 curl）
  return req.query.token || ''
}

export function requireAuth(req, res, next) {
  const token = extractToken(req)

  if (AUTH_MODE === 'single') {
    // 单用户：Token 匹配即可
    if (!token) {
      return res.status(401).json({
        error: '未提供访问 Token',
        hint: '请检查前端 VITE_SERVER_TOKEN 与后端 SINGLE_USER_TOKEN 是否一致',
      })
    }
    if (token !== SINGLE_TOKEN) {
      return res.status(401).json({
        error: 'Token 无效',
        hint: '请检查前端 VITE_SERVER_TOKEN 与后端 SINGLE_USER_TOKEN 是否一致',
      })
    }
    req.user = { id: 'default', username: 'default' }
    return next()
  }

  // multi 模式
  if (!token) return res.status(401).json({ error: '未登录' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = { id: payload.uid }
    next()
  } catch {
    res.status(401).json({ error: 'Token 已过期或无效' })
  }
}
