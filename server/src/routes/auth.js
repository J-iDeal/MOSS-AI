/**
 * 鉴权路由 — 单用户模式提供 /token 便捷获取；多用户模式提供注册/登录
 */
import { Router } from 'express'
import 'dotenv/config'
import { authMode, signToken } from '../middleware/auth.js'
import { db } from '../db.js'
import { createError } from '../middleware/error.js'

const router = Router()

/**
 * GET /api/v1/auth/info
 * 返回当前运行模式 + 可用供应商（公开）
 */
router.get('/info', (req, res) => {
  res.json({
    authMode: authMode(),
    singleTokenHint: authMode() === 'single' ? process.env.SINGLE_USER_TOKEN : null,
  })
})

/**
 * POST /api/v1/auth/login
 *   single:  始终返回 default user
 *   multi:   校验密码 → 返回 JWT
 */
router.post('/login', (req, res, next) => {
  const { username, password } = req.body || {}

  if (authMode() === 'single') {
    return res.json({
      token: process.env.SINGLE_USER_TOKEN,
      user: { id: 'default', username: 'default' },
      mode: 'single',
    })
  }

  if (!username || !password) return next(createError(400, '缺少用户名或密码'))
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  // 预留 bcrypt.compare(password, u.password_hash)
  if (!u) return next(createError(401, '用户不存在'))
  if (u.password_hash !== password) return next(createError(401, '密码错误'))

  res.json({ token: signToken(u.id), user: { id: u.id, username: u.username }, mode: 'multi' })
})

/**
 * POST /api/v1/auth/register  — 仅 multi 模式
 */
router.post('/register', (req, res, next) => {
  if (authMode() !== 'multi') return next(createError(400, '当前是单用户模式，不需要注册'))
  const { username, password } = req.body || {}
  if (!username || !password) return next(createError(400, '缺少用户名或密码'))
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) return next(createError(409, '用户名已存在'))

  const now = Date.now()
  const id = 'u_' + Date.now().toString(36)
  db.prepare(
    'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, password, now, now)
  db.prepare(
    'INSERT INTO groups (id, user_id, name, builtin, collapsed, created_at) VALUES (?, ?, ?, 1, 0, ?)'
  ).run('default', id, '全部对话', now)

  res.json({ token: signToken(id), user: { id, username }, mode: 'multi' })
})

export default router
