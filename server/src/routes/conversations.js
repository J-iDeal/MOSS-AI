/**
 * 会话 / 分组 / 消息 CRUD 路由
 *
 * 服务端是持久化数据源；前端 localStorage 仅作离线缓存。
 * 创建接口接受可选的 id / 时间戳，用于无损迁移既有浏览器数据。
 *
 * 所有接口自动关联 req.user.id（单用户模式下是 "default"）
 */
import { Router } from 'express'
import { db } from '../db.js'
import { createError } from '../middleware/error.js'

const router = Router()

// ==================== 工具函数 ====================

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ==================== 分组 ====================

// GET  /groups         列表（含内置 "全部对话" + 自定义分组）
// POST /groups         新建
// PATCH /groups/:id    重命名 / 折叠
// DELETE /groups/:id

router.get('/groups', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM groups WHERE user_id = ? ORDER BY builtin DESC, created_at ASC'
  ).all(req.user.id)
  res.json({ groups: rows })
})

router.post('/groups', (req, res, next) => {
  const { id: requestedId, name, collapsed, createdAt } = req.body || {}
  if (!name?.trim()) return next(createError(400, '分组名不能为空'))
  const id = typeof requestedId === 'string' && requestedId.trim()
    ? requestedId.trim()
    : 'g_' + genId()
  const created = Number.isFinite(createdAt) ? createdAt : Date.now()
  const isCollapsed = collapsed === undefined ? true : !!collapsed
  db.prepare(
    'INSERT INTO groups (id, user_id, name, builtin, collapsed, created_at) VALUES (?, ?, ?, 0, ?, ?)'
  ).run(id, req.user.id, name.trim(), isCollapsed ? 1 : 0, created)
  res.json({ group: { id, name: name.trim(), builtin: false, collapsed: isCollapsed, created_at: created } })
})

router.patch('/groups/:id', (req, res, next) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!g) return next(createError(404, '分组不存在'))

  const { name, collapsed } = req.body || {}
  if (g.builtin && name !== undefined) {
    return next(createError(400, '内置分组不可重命名'))
  }
  if (name !== undefined) {
    if (!name.trim()) return next(createError(400, '分组名不能为空'))
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name.trim(), g.id)
  }
  if (collapsed !== undefined) {
    db.prepare('UPDATE groups SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, g.id)
  }
  res.json({ ok: true })
})

router.delete('/groups/:id', (req, res, next) => {
  const g = db.prepare('SELECT * FROM groups WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!g) return next(createError(404, '分组不存在'))
  if (g.builtin) return next(createError(400, '内置分组不可删除'))

  // 对话移到 default 分组
  db.prepare('UPDATE conversations SET group_id = NULL WHERE group_id = ?').run(g.id)
  db.prepare('DELETE FROM groups WHERE id = ?').run(g.id)
  res.json({ ok: true })
})

// ==================== 会话 ====================

// GET    /conversations?groupId=xxx   列表（带 pinned 排序）
// POST   /conversations               新建
// GET    /conversations/:id            详情 + 消息
// PATCH  /conversations/:id            更新标题/置顶/分组
// DELETE /conversations/:id
// POST   /conversations/:id/reorder   置顶排序

router.get('/conversations', (req, res) => {
  const { groupId } = req.query
  let rows
  if (groupId && groupId !== 'all') {
    rows = db.prepare(
      'SELECT * FROM conversations WHERE user_id = ? AND (group_id = ? OR (group_id IS NULL AND ? = \'default\'))'
    ).all(req.user.id, groupId, groupId)
  } else {
    rows = db.prepare('SELECT * FROM conversations WHERE user_id = ?').all(req.user.id)
  }

  // 格式化 + 排序：置顶的按 pin_order，其他按 updated_at
  const convs = rows.map((r) => ({
    ...r,
    pinned: !!r.pinned,
  })).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned) {
      const ao = a.pin_order ?? Infinity
      const bo = b.pin_order ?? Infinity
      if (ao !== bo) return ao - bo
    }
    return (b.updated_at || b.created_at) - (a.updated_at || a.created_at)
  })

  res.json({ conversations: convs })
})

router.post('/conversations', (req, res) => {
  const {
    id: requestedId, groupId, title, pinned, pinOrder, createdAt, updatedAt,
  } = req.body || {}
  const now = Date.now()
  const id = typeof requestedId === 'string' && requestedId.trim()
    ? requestedId.trim()
    : genId()
  const gid = groupId && groupId !== 'default' ? groupId : null
  const created = Number.isFinite(createdAt) ? createdAt : now
  const updated = Number.isFinite(updatedAt) ? updatedAt : created
  const order = Number.isFinite(pinOrder) ? pinOrder : null
  db.prepare(
    `INSERT INTO conversations
       (id, user_id, group_id, title, pinned, pin_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, gid, title?.trim() || '新对话', pinned ? 1 : 0, order, created, updated)
  res.json({
    conversation: {
      id, title: title?.trim() || '新对话', pinned: !!pinned,
      group_id: gid, pin_order: order, created_at: created, updated_at: updated,
    },
  })
})

router.get('/conversations/:id', (req, res, next) => {
  const conv = db.prepare(
    'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id)
  if (!conv) return next(createError(404, '对话不存在'))

  const msgs = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
  ).all(conv.id)

  // sources / usage / attachments 字段是 JSON，反序列化
  const messages = msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    sources: m.sources ? JSON.parse(m.sources) : [],
    searching: !!m.searching,
    searchQuery: m.search_query || '',
    usage: m.usage ? JSON.parse(m.usage) : null,
    variants: m.variants ? JSON.parse(m.variants) : null,
    attachments: m.attachments ? JSON.parse(m.attachments) : [],
  }))

  res.json({
    conversation: {
      ...conv,
      pinned: !!conv.pinned,
    },
    messages,
  })
})

router.patch('/conversations/:id', (req, res, next) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!conv) return next(createError(404, '对话不存在'))

  const { title, pinned, pinOrder, groupId } = req.body || {}
  const now = Date.now()

  if (title !== undefined) {
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title || '新对话', now, conv.id)
  }
  if (pinned !== undefined) {
    db.prepare('UPDATE conversations SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, now, conv.id)
  }
  if (pinOrder !== undefined) {
    db.prepare('UPDATE conversations SET pin_order = ?, updated_at = ? WHERE id = ?')
      .run(Number.isFinite(pinOrder) ? pinOrder : null, now, conv.id)
  }
  if (groupId !== undefined) {
    const gid = groupId && groupId !== 'default' ? groupId : null
    db.prepare('UPDATE conversations SET group_id = ?, updated_at = ? WHERE id = ?')
      .run(gid, now, conv.id)
  }

  res.json({ ok: true })
})

router.delete('/conversations/:id', (req, res, next) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!conv) return next(createError(404, '对话不存在'))
  // 级联删消息
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id)
  res.json({ ok: true })
})

router.post('/conversations/batch-delete', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true })
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(
    `DELETE FROM conversations WHERE id IN (${placeholders}) AND user_id = ?`
  ).run(...ids, req.user.id)
  res.json({ ok: true })
})

router.post('/conversations/batch-move', (req, res) => {
  const { ids, groupId } = req.body || {}
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: true })
  const gid = groupId && groupId !== 'default' ? groupId : null
  const stmt = db.prepare('UPDATE conversations SET group_id = ? WHERE id = ? AND user_id = ?')
  const tx = db.transaction((arr) => arr.forEach((id) => stmt.run(gid, id, req.user.id)))
  tx(ids)
  res.json({ ok: true })
})

// ==================== 消息 ====================

// POST   /conversations/:id/messages     追加一条
// PATCH  /messages/:id                   更新内容 / 搜索状态
// DELETE /messages/:id

router.post('/conversations/:id/messages', (req, res, next) => {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!conv) return next(createError(404, '对话不存在'))

  const {
    id: requestedId, role, content, timestamp: requestedTimestamp,
    sources, searching, searchQuery, usage, variants, attachments,
  } = req.body || {}
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
    return next(createError(400, 'role 不合法'))
  }

  const timestamp = Number.isFinite(requestedTimestamp) ? requestedTimestamp : Date.now()
  const id = typeof requestedId === 'string' && requestedId.trim()
    ? requestedId.trim()
    : genId()
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, role, content, timestamp, sources, searching, search_query, usage, variants, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, conv.id, role, content || '', timestamp,
    sources ? JSON.stringify(sources) : null,
    searching ? 1 : 0,
    searchQuery || null,
    usage ? JSON.stringify(usage) : null,
    variants ? JSON.stringify(variants) : null,
    Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null,
  )
  db.prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?')
    .run(timestamp, conv.id)

  res.json({ message: { id, role, content, timestamp, sources: sources || [], searching: !!searching, searchQuery: searchQuery || '', usage: usage || null, variants: variants || null, attachments: attachments || [] } })
})

router.patch('/messages/:id', (req, res, next) => {
  const { content, sources, searching, searchQuery, usage, variants, attachments } = req.body || {}
  const m = db.prepare(
    `SELECT m.* FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  ).get(req.params.id, req.user.id)
  if (!m) return next(createError(404, '消息不存在'))

  const updates = []
  const args = []
  if (content !== undefined) { updates.push('content = ?'); args.push(content) }
  if (sources !== undefined) { updates.push('sources = ?'); args.push(JSON.stringify(sources)) }
  if (searching !== undefined) { updates.push('searching = ?'); args.push(searching ? 1 : 0) }
  if (searchQuery !== undefined) { updates.push('search_query = ?'); args.push(searchQuery || null) }
  if (usage !== undefined) { updates.push('usage = ?'); args.push(usage ? JSON.stringify(usage) : null) }
  if (variants !== undefined) { updates.push('variants = ?'); args.push(variants ? JSON.stringify(variants) : null) }
  if (attachments !== undefined) {
    updates.push('attachments = ?')
    args.push(Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null)
  }
  if (updates.length === 0) return res.json({ ok: true })

  args.push(m.id)
  db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(...args)
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(Date.now(), m.conversation_id)

  res.json({ ok: true })
})

router.delete('/messages/:id', (req, res, next) => {
  const m = db.prepare(
    `SELECT m.* FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`
  ).get(req.params.id, req.user.id)
  if (!m) return next(createError(404, '消息不存在'))
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id)
  res.json({ ok: true })
})

export default router
