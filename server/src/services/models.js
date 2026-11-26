/**
 * 模型配置存取（models 表，单一事实来源）
 *
 * - 每行一个模型配置，is_active=1 表示当前选中（每用户至多一个，由唯一索引保证）
 * - api_key 直接存本表；列表接口不返回，单个查询/Key 接口才返回
 * - Key 解析优先级（见 aiProxy.resolveProvider）：请求直传 > models.api_key > provider_key > .env
 */
import { db } from '../db.js'
import { getProviderKey } from './providerKeys.js'

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 数据库行 → 前端对象；withKey 控制是否带 api_key */
function rowToModel(row, { withKey = false } = {}) {
  if (!row) return null
  const m = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model || '',
    baseUrl: row.base_url || '',
    // 请求地址是否自动拼接 /chat/completions（false=输入的是完整地址）
    appendPath: row.append_path !== 0,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    systemPrompt: row.system_prompt || '',
    isActive: !!row.is_active,
  }
  if (withKey) m.apiKey = row.api_key || ''
  return m
}

/** 列表（不含 api_key） */
export function listModels(userId) {
  const rows = db
    .prepare(
      `SELECT * FROM models WHERE user_id = ?
       ORDER BY is_active DESC, sort_order IS NULL, sort_order, created_at`
    )
    .all(userId)
  return rows.map((r) => rowToModel(r))
}

/** 单个（含 api_key，供编辑） */
export function getModel(userId, id) {
  const row = db.prepare('SELECT * FROM models WHERE user_id = ? AND id = ?').get(userId, id)
  return row ? rowToModel(row, { withKey: true }) : null
}

export function createModel(userId, data) {
  const id = data.id || genId()
  const now = Date.now()
  db.prepare(
    `INSERT INTO models
      (id, user_id, name, provider, model, base_url, append_path, api_key,
       temperature, max_tokens, system_prompt, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    userId,
    data.name || '未命名模型',
    data.provider || 'deepseek',
    data.model || '',
    data.baseUrl || null,
    data.appendPath === false ? 0 : 1,
    data.apiKey || null,
    data.temperature ?? 0.7,
    data.maxTokens ?? 0,
    data.systemPrompt || null,
    data.sortOrder ?? now,
    now,
    now
  )
  return getModel(userId, id)
}

export function updateModel(userId, id, data) {
  // 注意：api_key 不在此映射中——Key 只能由 setModelKey 单独写入，
  // 避免「保存配置时把刚存好的 Key 覆盖成空」的竞态
  const map = {
    name: 'name', provider: 'provider', model: 'model', baseUrl: 'base_url',
    appendPath: 'append_path',
    temperature: 'temperature', maxTokens: 'max_tokens', systemPrompt: 'system_prompt',
  }
  const sets = []
  const vals = []
  for (const [k, col] of Object.entries(map)) {
    if (data[k] !== undefined) {
      sets.push(`${col} = ?`)
      if (k === 'appendPath') vals.push(data[k] === false ? 0 : 1)
      else vals.push(data[k] === '' ? null : data[k])
    }
  }
  if (!sets.length) return getModel(userId, id)
  sets.push('updated_at = ?')
  vals.push(Date.now())
  vals.push(userId)
  vals.push(id)
  db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).run(...vals)
  return getModel(userId, id)
}

export function deleteModel(userId, id) {
  const wasActive = !!db
    .prepare('SELECT is_active FROM models WHERE user_id = ? AND id = ?')
    .get(userId, id)?.is_active
  db.prepare('DELETE FROM models WHERE user_id = ? AND id = ?').run(userId, id)
  // 删的是激活模型 → 自动激活剩下的第一个
  if (wasActive) {
    const first = db
      .prepare(
        `SELECT id FROM models WHERE user_id = ?
         ORDER BY sort_order IS NULL, sort_order, created_at LIMIT 1`
      )
      .get(userId)
    if (first) setActive(userId, first.id)
  }
}

/** 设为当前激活（事务：先全部置 0，再目标置 1） */
export function setActive(userId, id) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE models SET is_active = 0 WHERE user_id = ?').run(userId)
    db.prepare(
      'UPDATE models SET is_active = 1, updated_at = ? WHERE user_id = ? AND id = ?'
    ).run(Date.now(), userId, id)
  })
  tx()
  return getModel(userId, id)
}

/** 取模型专属 Key（供 resolveProvider 使用） */
export function getModelKey(userId, id) {
  if (!id) return ''
  const row = db.prepare('SELECT api_key FROM models WHERE user_id = ? AND id = ?').get(userId, id)
  return row?.api_key || ''
}

/** 单独写入/清除模型专属 Key（配置更新接口不再触碰 api_key，避免覆盖） */
export function setModelKey(userId, id, apiKey) {
  const val = (apiKey ?? '').trim()
  db.prepare('UPDATE models SET api_key = ?, updated_at = ? WHERE user_id = ? AND id = ?')
    .run(val ? val : null, Date.now(), userId, id)
  return getModel(userId, id)
}

/**
 * 解析模型的有效 Key 及来源（供 GET /models/:id/key）
 * 优先级：models.api_key > provider_key > .env
 */
export function resolveModelKey(userId, id) {
  const own = getModelKey(userId, id)
  if (own) return { apiKey: own, source: 'model' }
  const m = db
    .prepare('SELECT provider FROM models WHERE user_id = ? AND id = ?')
    .get(userId, id)
  if (m?.provider) {
    const pk = getProviderKey(userId, m.provider)
    if (pk) return { apiKey: pk, source: 'provider' }
  }
  return { apiKey: '', source: 'env' }
}
