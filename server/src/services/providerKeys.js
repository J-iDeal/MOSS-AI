/**
 * 供应商 API Key 存取（SQLite settings 表）
 *
 * Key 存在 settings 表的 provider_key:<provider> 项下（明文，本地单用户场景）
 * 取值优先级：请求显式传入 > 数据库 > .env 兜底
 */
import { db } from '../db.js'

const PREFIX = 'provider_key:'

export function getProviderKey(userId, provider) {
  if (!userId || !provider) return ''
  const row = db
    .prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
    .get(userId, PREFIX + provider)
  return (row?.value || '').trim()
}

export function setProviderKey(userId, provider, apiKey) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, PREFIX + provider, apiKey.trim(), now)
}

export function deleteProviderKey(userId, provider) {
  db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?')
    .run(userId, PREFIX + provider)
}
