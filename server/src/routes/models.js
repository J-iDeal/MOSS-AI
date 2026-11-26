/**
 * 模型配置路由（单一事实来源：models 表）
 *   GET    /api/v1/models           — 列表（不含 api_key）
 *   POST   /api/v1/models           — 新建
 *   GET    /api/v1/models/:id       — 单个（含 api_key，供编辑）
 *   PUT    /api/v1/models/:id       — 更新
 *   DELETE /api/v1/models/:id       — 删除
 *   POST   /api/v1/models/:id/activate — 设为当前激活
 *   GET    /api/v1/models/:id/key   — 取有效 Key 及来源（model/provider/env）
 *   PUT    /api/v1/models/:id/key   — 保存模型专属 Key
 *   DELETE /api/v1/models/:id/key   — 清除模型专属 Key
 *
 * 鉴权由 app.js 挂载时统一 requireAuth。
 */
import { Router } from 'express'
import { createError } from '../middleware/error.js'
import {
  listModels, getModel, createModel, updateModel, deleteModel, setActive,
  resolveModelKey, getModelKey, setModelKey,
} from '../services/models.js'

const router = Router()

router.get('/models', (req, res) => {
  res.json({ models: listModels(req.user.id) })
})

router.post('/models', (req, res, next) => {
  const body = req.body || {}
  if (!body.name) return next(createError(400, '模型名称 name 不能为空'))
  const created = createModel(req.user.id, body)
  res.status(201).json(created)
})

router.get('/models/:id', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  res.json(m)
})

router.put('/models/:id', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  res.json(updateModel(req.user.id, req.params.id, req.body || {}))
})

router.delete('/models/:id', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  deleteModel(req.user.id, req.params.id)
  res.json({ ok: true })
})

router.post('/models/:id/activate', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  res.json(setActive(req.user.id, req.params.id))
})

// ---- Key ----
router.get('/models/:id/key', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  res.json(resolveModelKey(req.user.id, req.params.id))
})

router.put('/models/:id/key', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  const apiKey = (req.body?.apiKey ?? '').trim()
  setModelKey(req.user.id, req.params.id, apiKey)
  res.json({ ok: true, source: apiKey ? 'model' : 'cleared' })
})

router.delete('/models/:id/key', (req, res, next) => {
  const m = getModel(req.user.id, req.params.id)
  if (!m) return next(createError(404, '模型不存在'))
  setModelKey(req.user.id, req.params.id, '')
  res.json({ ok: true })
})

export default router
