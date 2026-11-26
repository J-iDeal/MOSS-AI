/**
 * 用户设置路由
 *   GET /api/v1/settings  — 读取当前用户的 UI 设置
 *   PUT /api/v1/settings  — 批量保存（仅白名单字段）
 *
 * 鉴权由 app.js 挂载时统一 requireAuth，本文件不再重复。
 */
import { Router } from 'express'
import { createError } from '../middleware/error.js'
import { getAllSettings, setSettings } from '../services/userSettings.js'

const router = Router()

// 允许持久化到 settings 表的前端 UI 设置白名单。
// 模型相关字段已迁至 models 表，这里只保留纯 UI 开关，避免写入僵尸 KV：
//   - apiKey      敏感，走 providerKeys / .env，不落本表
//   - serverMode  由构建环境（VITE_DIRECT_MODE）决定，不需要存
const ALLOWED_KEYS = new Set(['stream', 'webSearch', 'branchMode', 'branchCount'])

/**
 * GET /api/v1/settings
 * 返回当前用户已保存的 UI 设置（白名单过滤后）
 */
router.get('/settings', (req, res) => {
  const all = getAllSettings(req.user.id)
  const out = {}
  for (const [k, v] of Object.entries(all)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v
  }
  res.json({ settings: out })
})

/**
 * PUT /api/v1/settings
 * 批量保存，body 为 { key: value, ... }，只接收白名单字段
 */
router.put('/settings', (req, res, next) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(createError(400, '请求体必须是键值对象'))
  }
  const kv = {}
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(k)) kv[k] = v
  }
  setSettings(req.user.id, kv)
  res.json({ ok: true, saved: Object.keys(kv) })
})

export default router
