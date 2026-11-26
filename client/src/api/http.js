/**
 * 统一 HTTP 请求模块
 * - baseURL: 开发期 /api 通过 Vite proxy → 后端；生产期直接同源 /api
 * - 自动带 Authorization: Bearer <token>
 * - token 存在 localStorage
 */

const TOKEN_KEY = 'ai-chat-server-token'

// baseURL：开发时走 vite proxy；生产部署时同源（前端 dist 和后端同端口）
export const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

// 默认单用户 Token（匹配 server/.env 的 SINGLE_USER_TOKEN）
// 生产环境可以通过 VITE_SERVER_TOKEN 覆盖
const DEFAULT_TOKEN = import.meta.env.VITE_SERVER_TOKEN || 'moss-local-dev-token-2026'

export function getToken() {
  try {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (stored !== null && stored !== '') return stored
  } catch {}
  // 没存过，用默认 Token
  return DEFAULT_TOKEN
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch {}
}

// 默认请求超时：避免后端/上游挂起时界面永久停留在「生成中」
const DEFAULT_TIMEOUT = 60_000

/**
 * 把 HTTP 状态码与上游原始信息翻译成用户能看懂、能照着做的提示
 */
export function friendlyError(status, serverMsg = '') {
  const map = {
    400: '请求参数有误，请检查输入内容',
    401: 'API Key 或访问 Token 无效，请到「设置 → 模型设置」重新填写',
    403: '没有访问权限，请检查访问 Token 配置',
    404: '接口不存在，请确认前后端版本一致',
    413: '请求内容过大，请缩短输入后重试',
    429: '请求过于频繁，请稍等几秒后重试',
    500: 'AI 服务出错了，请稍后重试',
    502: 'AI 服务暂时不可用，请稍后重试',
    503: 'AI 服务暂时不可用，请稍后重试',
    504: 'AI 服务响应超时，请稍后重试',
  }
  const base = map[status] || ''
  const detail = String(serverMsg || '').trim()
  if (base) return detail && !base.includes(detail) ? `${base}（${detail}）` : base
  return detail || `请求失败（HTTP ${status}）`
}

/**
 * 带超时的 fetch：外部 signal（如用户点停止）与超时 signal 同时生效
 * - 超时抛出普通 Error（不走 AbortError 分支），便于上层展示友好文案
 * - 用户主动取消仍保留 AbortError，交给上层做「已停止」处理
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : null

  const outer = options.signal
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (timedOut) throw new Error('请求超时，请检查网络后重试')
    if (e?.name === 'AbortError') throw e
    if (e instanceof TypeError) throw new Error('网络连接失败，请确认后端服务已启动')
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 从失败响应中提取可读错误信息（优先后端 error 字段）
async function readError(res) {
  const text = await res.text().catch(() => '')
  let serverMsg = ''
  try {
    const j = JSON.parse(text)
    serverMsg = j.error || j.message || ''
  } catch {}
  return friendlyError(res.status, serverMsg)
}

/**
 * 通用 fetch 封装
 */
export async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const token = getToken()
  const { timeout = DEFAULT_TIMEOUT, ...rest } = options

  const headers = {
    'Content-Type': 'application/json',
    ...(rest.headers || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetchWithTimeout(url, { ...rest, headers }, timeout)

  // 401 说明 token 失效，清掉让用户重新输入
  if (res.status === 401) {
    clearToken()
    let hint = ''
    try { hint = (await res.clone().json())?.hint || '' } catch {}
    console.warn('[HTTP] 401 Unauthorized, token cleared', hint ? `— ${hint}` : '')
  }

  return res
}

/**
 * GET JSON 便捷方法
 */
export async function getJSON(path, options = {}) {
  const res = await request(path, { ...options, method: 'GET' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * POST JSON 便捷方法
 */
export async function postJSON(path, body, options = {}) {
  const res = await request(path, {
    ...options,
    method: 'POST',
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * PATCH JSON 便捷方法
 */
export async function patchJSON(path, body, options = {}) {
  const res = await request(path, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * PUT JSON 便捷方法
 */
export async function putJSON(path, body, options = {}) {
  const res = await request(path, {
    ...options,
    method: 'PUT',
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/**
 * DELETE JSON 便捷方法
 */
export async function delJSON(path, options = {}) {
  const res = await request(path, { ...options, method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
