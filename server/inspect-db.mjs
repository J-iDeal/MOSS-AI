/**
 * 数据库查看工具 —— 在终端打印 moss-ai.db 的表内容
 *
 * 用法（在 server 目录下）：
 *   node inspect-db.mjs            查看所有表
 *   node inspect-db.mjs models     只看 models 表（可换成任意表名）
 *
 * 说明：
 *   - 运行前自动把 WAL 日志合并回主文件，确保看到最新数据
 *   - api_key / password_hash 等敏感字段会脱敏显示
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.join(__dirname, 'data', 'moss-ai.db'))

try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}

const only = process.argv[2]
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((t) => t.name)

const SENSITIVE = new Set(['api_key', 'password_hash'])
function mask(col, val) {
  if (val == null) return val
  const s = typeof val === 'string' ? val : JSON.stringify(val)
  if (SENSITIVE.has(col) && s.length > 6) return s.slice(0, 4) + '…(已隐藏)'
  if (s.length > 80) return s.slice(0, 80) + '…'
  return val
}

for (const t of tables) {
  if (only && t !== only) continue
  const rows = db.prepare(`SELECT * FROM ${t}`).all()
  console.log(`\n=== ${t}（${rows.length} 行）===`)
  if (!rows.length) { console.log('  (空表)'); continue }
  for (const r of rows) {
    const out = {}
    for (const [k, v] of Object.entries(r)) out[k] = mask(k, v)
    console.log('  ' + JSON.stringify(out))
  }
}

db.close()
