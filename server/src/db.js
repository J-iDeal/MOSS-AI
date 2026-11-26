/**
 * SQLite 数据库层
 * 使用 better-sqlite3（同步 API，简单可靠）
 *
 * Schema:
 *   users            — 用户表（预留，单用户模式下只存一个默认用户）
 *   conversations    — 会话
 *   messages         — 消息
 *   groups           — 对话分组（与前端 Sidebar 对应）
 *   settings         — 用户级设置（API Key 加密存储、主题、System Prompt 等）
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 部署平台的包文件系统是只读的：通过 DATA_DIR 环境变量把数据库写到临时目录；
// 本地开发未设置时回退到项目内的 data/，保持原有行为不变
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data')

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const DB_PATH = path.join(DATA_DIR, 'moss-ai.db')
const db = new Database(DB_PATH)

// 开启 WAL 模式，读写并发更好
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  -- 会话分组
  CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    builtin    INTEGER NOT NULL DEFAULT 0,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- 会话
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    group_id   TEXT,
    title      TEXT NOT NULL DEFAULT '新对话',
    pinned     INTEGER NOT NULL DEFAULT 0,
    pin_order  INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
  );

  -- 消息
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content         TEXT NOT NULL DEFAULT '',
    timestamp       INTEGER NOT NULL,
    -- 联网搜索相关字段（JSON 存储，可空）
    sources         TEXT,
    searching       INTEGER NOT NULL DEFAULT 0,
    search_query    TEXT,
    -- token 用量（JSON：{prompt, completion, total}，可空）
    usage           TEXT,
    -- 多版本回答（JSON 数组，每项 {content, usage, error}，可空）
    variants        TEXT,
    -- 图片附件（JSON 数组，每项 {id,name,mime,size,url,ocrText?}，可空）
    attachments     TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);

  -- 用户设置（键值对）—— 仅存全局偏好（stream/webSearch）与供应商级 Key 回退
  CREATE TABLE IF NOT EXISTS settings (
    user_id    TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- 模型配置表（单一事实来源）：一行一个模型配置，is_active 标记当前选中
  CREATE TABLE IF NOT EXISTS models (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL DEFAULT '',
    base_url      TEXT,
    api_key       TEXT,
    temperature   REAL NOT NULL DEFAULT 0.7,
    max_tokens    INTEGER NOT NULL DEFAULT 0,
    system_prompt TEXT,
    is_active     INTEGER NOT NULL DEFAULT 0,
    sort_order    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  -- 每个用户最多一个激活模型
  CREATE UNIQUE INDEX IF NOT EXISTS idx_models_user_active ON models(user_id) WHERE is_active = 1;
  CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id, sort_order);
`)

// 兼容旧数据库：为 models 表补上「请求地址是否自动拼接 /chat/completions」字段
const modelColumns = db.prepare('PRAGMA table_info(models)').all().map((c) => c.name)
if (!modelColumns.includes('append_path')) {
  db.exec('ALTER TABLE models ADD COLUMN append_path INTEGER NOT NULL DEFAULT 1')
}

// 兼容旧数据库：为 messages 表补上 token 用量字段
const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
if (!messageColumns.includes('usage')) {
  db.exec('ALTER TABLE messages ADD COLUMN usage TEXT')
}
if (!messageColumns.includes('variants')) {
  db.exec('ALTER TABLE messages ADD COLUMN variants TEXT')
}
// 兼容旧数据库：为 messages 表补上图片附件字段
if (!messageColumns.includes('attachments')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT')
}

/**
 * 初始化单用户模式的默认数据
 * 单用户模式下只有一个 "default" 用户
 */
function ensureDefaultUser() {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get('default')
  if (row) return row.id

  const now = Date.now()
  db.prepare(
    'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('default', 'default', '', now, now)

  // 创建默认分组
  db.prepare(
    'INSERT INTO groups (id, user_id, name, builtin, collapsed, created_at) VALUES (?, ?, ?, 1, 0, ?)'
  ).run('default', 'default', '全部对话', now)

  return 'default'
}

ensureDefaultUser()

/**
 * 一次性迁移：清理上一版散落到 settings 表的模型字段（已迁入 models 表）
 * - provider/model/baseUrl/temperature/maxTokens/systemPrompt/activeProfileId：模型配置，迁到 models
 * - profile_key:*：模型专属 Key，迁到 models.api_key
 * 保留：stream/webSearch（全局偏好）、provider_key:*（供应商级 Key 回退）
 */
function cleanupLegacySettings() {
  const legacyKeys = [
    'provider', 'model', 'baseUrl', 'temperature',
    'maxTokens', 'systemPrompt', 'activeProfileId',
  ]
  const placeholders = legacyKeys.map(() => '?').join(',')
  db.prepare(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...legacyKeys)
  db.prepare(`DELETE FROM settings WHERE key LIKE 'profile_key:%'`).run()
}
cleanupLegacySettings()

export { db, DATA_DIR }
export default db
