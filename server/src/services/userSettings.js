/**
 * 用户级设置存取（SQLite settings 表，键值对）
 *
 * 与 providerKeys.js 共用同一张 settings 表，但互不干扰：
 *   - providerKeys 管 provider_key:* / profile_key:*（API Key，原始字符串存储）
 *   - 本模块管前端 UI 设置（provider / model / ...），值统一 JSON 编码存储
 *
 * 路由层通过白名单（ALLOWED_KEYS）过滤，确保不会把 API Key 行读给前端。
 */
import { db } from '../db.js'

/**
 * 读取该用户的全部设置行，值尝试 JSON 解码
 * @returns {Record<string, any>}
 */
export function getAllSettings(userId) {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .all(userId)
  const out = {}
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      out[r.key] = r.value
    }
  }
  return out
}

/**
 * 批量写入（upsert）设置，值统一 JSON 编码，事务保证原子性
 * @param {string} userId
 * @param {Record<string, any>} kv
 */
export function setSettings(userId, kv) {
  const now = Date.now()
  const stmt = db.prepare(`
    INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      stmt.run(userId, key, JSON.stringify(value), now)
    }
  })
  tx(Object.entries(kv || {}))
}
