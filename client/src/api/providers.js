/**
 * 多模型API适配器 v2 — 后端代理模式
 *
 * 所有请求通过本地后端 Express 转发（默认 /api/v1/chat/completions）
 * API Key 由后端托管：优先读取数据库（界面配置），.env 兜底
 *
 * 如需直连（开发调试），设置 VITE_DIRECT_MODE=true 的环境变量即可切回旧逻辑。
 */
import { getToken, fetchWithTimeout, friendlyError } from './http.js'

// ==================== 预设供应商配置 ====================
// baseUrl 和 apiKey 仅在 VITE_DIRECT_MODE=true 时使用
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  deepseek: {
    label: 'DeepSeek (深度求索)',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    // deepseek-flash 支持图片输入；chat / reasoner 仍为纯文本
    models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
    // 联网搜索：客户端 Function Calling + 服务端 /tools/search 代理
    searchMode: 'tools',
  },
  doubao: {
    label: '豆包 (火山引擎)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 联网搜索：方舟内置 web_search_options，模型自行搜索并返回引用标注
    searchMode: 'native',
    // 火山方舟只接受「带版本号的模型 ID」或「接入点 ep-xxx」，短名如 doubao-pro-32k 已下线
    defaultModel: 'doubao-seed-2-0-pro-260215',
    models: [
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260215',
      'doubao-seed-2-0-mini-260215',
      'doubao-seed-1-6-250615',
      'doubao-seed-1-6-flash-250615',
      'doubao-1-5-pro-32k-250115',
      'doubao-1-5-lite-32k-250115',
    ],
  },
  qwen: {
    label: '通义 (阿里云百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long', 'qwq-32b-preview'],
  },
  siliconflow: {
    label: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    models: [
      'Qwen/Qwen2.5-7B-Instruct',
      'Qwen/Qwen2.5-32B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'meta-llama/Llama-3.3-70B-Instruct',
    ],
  },
  zhipu: {
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4',
    models: ['glm-4', 'glm-4-flash', 'glm-4-plus', 'glm-4-air'],
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    models: ['abab6.5s-chat', 'abab6.5-chat', 'abab5.5-chat'],
  },
  custom: {
    label: '自定义 (OpenAI兼容)',
    baseUrl: '',
    defaultModel: '',
    models: [],
  },
}

// 是否直连模式（调试用）
const DIRECT_MODE = import.meta.env.VITE_DIRECT_MODE === 'true'

/**
 * 供应商的联网搜索模式
 *   - 'tools'  ：客户端 Function Calling + 服务端 /tools/search 代理（DeepSeek、自定义网关）
 *   - 'native' ：供应商内置搜索，请求里开启开关即可（豆包 web_search_options）
 *   - null     ：未适配
 * 与服务端 aiProxy.js 的供应商能力表保持一致。
 */
export function providerSearchMode(provider) {
  if (provider === 'custom') return 'tools'
  return PROVIDERS[provider]?.searchMode || null
}

export function providerSupportsSearch(provider) {
  return !!providerSearchMode(provider)
}

// ==================== 视觉（图片输入）能力 ====================
// 按 provider + 模型名判断是否支持 OpenAI 兼容的 image_url content parts。
// 未命中或自定义供应商一律按「不支持」处理，改走 OCR 文本兜底，避免把图片发给纯文本模型导致报错。
const VISION_MODEL_PATTERNS = {
  deepseek: [/^deepseek-flash/i, /vision/i],
  openai: [/^gpt-4o/, /^gpt-4\.1/, /^gpt-4-turbo/, /^o[134]/],
  doubao: [/vision/i, /seed-1[.-]6/i, /seed-2[.-]0/i],
  qwen: [/(^|[-/])vl([.-]|$)/i, /qwen-vl/i],
  zhipu: [/glm-4(?:\.\d+)?v/i],
  siliconflow: [/vl/i, /vision/i, /internvl/i, /llava/i],
  minimax: [/vl/i, /vision/i],
}

export function providerSupportsVision(provider, model) {
  const patterns = VISION_MODEL_PATTERNS[provider]
  if (!patterns) return false
  const name = String(model || '').toLowerCase()
  if (!name) return false
  return patterns.some((re) => re.test(name))
}

// 后端代理地址（默认 /api/v1 同源）
const BACKEND_BASE = import.meta.env.VITE_API_BASE || '/api/v1'

// ==================== 请求地址拼装（直连模式） ====================
// 与后端 buildChatUrl / buildSearchUrl 保持一致：
// appendPath=true 拼 /chat/completions；false 则把输入地址当作完整地址
function resolveBase(config) {
  return String(config.baseUrl || PROVIDERS[config.provider]?.baseUrl || '').trim().replace(/\/+$/, '')
}

function buildDirectChatUrl(config) {
  const base = resolveBase(config)
  if (!base) return ''
  return config.appendPath === false ? base : `${base}/chat/completions`
}

function buildDirectSearchUrl(config) {
  let base = resolveBase(config)
  if (!base) return ''
  if (config.appendPath === false) base = base.replace(/\/chat\/completions$/i, '')
  return `${base}/tools/search`
}

// ==================== 核心API调用 ====================

/**
 * 把供应商返回的引用标注（annotations / citations / references）统一成来源结构
 * 兼容两种形状：{ type:'url_citation', url_citation:{title,url} } 与 { title, url }
 */
export function normalizeCitations(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const c = item?.url_citation || item || {}
    const url = c.url || ''
    if (!url || out.some((x) => x.url === url)) continue
    let site = c.site_name || ''
    if (!site) {
      try { site = new URL(url).hostname } catch {}
    }
    out.push({
      title: c.title || url,
      url,
      site_name: site,
      snippet: c.summary || c.snippet || '',
    })
  }
  return out
}

/**
 * 发送聊天请求（支持流式和非流式）
 * @param {Object} config - { provider, baseUrl?, apiKey?, model, messages, stream, temperature, maxTokens,
 *                           nativeSearch?, onAnnotations?, signal }
 *   - nativeSearch: 供应商内置联网搜索（豆包 web_search_options）
 *   - onAnnotations: 收到引用标注时回调 (sources[]) => void
 * @param {Function} onStream - 流式回调 (delta) => void
 * @returns {Promise<string>} 完整回复内容
 */
/**
 * 把各供应商不同的 usage 字段统一成 { prompt, completion, total }
 */
export function normalizeUsage(u) {
  if (!u) return null
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0
  const total = Number(u.total_tokens ?? 0) || prompt + completion
  if (!total && !prompt && !completion) return null
  return { prompt, completion, total }
}

// 这些 OpenAI 兼容供应商支持 stream_options.include_usage，流式时能拿到 token 用量
const STREAM_USAGE_PROVIDERS = new Set(['openai', 'deepseek', 'siliconflow', 'custom', 'zhipu', 'qwen', 'moonshot'])

export async function chatCompletion(config, onStream = null) {
  const { model, messages, stream = true, temperature = 0.7, maxTokens, signal, onAnnotations, onUsage } = config

  if (!model) throw new Error('未选择模型，请先在设置中选择')
  if (!messages || !Array.isArray(messages)) throw new Error('messages 参数不合法')

  const body = {
    provider: config.provider,
    profileId: config.profileId,
    model,
    messages,
    stream,
    temperature,
    appendPath: config.appendPath !== false,
  }
  if (maxTokens) body.max_tokens = maxTokens
  // 豆包等供应商：传空对象即可开启内置联网搜索（与 tools 互斥，native 模式不传 tools）
  if (config.nativeSearch) body.web_search_options = {}
  // 流式时请求 usage，便于统计 token 消耗
  if (stream && STREAM_USAGE_PROVIDERS.has(config.provider)) {
    body.stream_options = { include_usage: true }
  }

  // 自定义供应商可以显式传 baseUrl + apiKey（后端会覆盖 .env 配置）
  if (config.baseUrl) body.baseUrl = config.baseUrl
  if (config.apiKey) body.apiKey = config.apiKey

  const url = DIRECT_MODE
    ? buildDirectChatUrl(config)
    : `${BACKEND_BASE}/chat/completions`

  const headers = { 'Content-Type': 'application/json' }
  if (!DIRECT_MODE) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  // 首字节超时 120s：拿到响应头即解除，流式传输本身由用户手动停止控制
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, 120_000)

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let serverMsg = ''
    try {
      const errJson = JSON.parse(errText)
      serverMsg = errJson.error?.message || errJson.message || ''
    } catch {}
    throw new Error(friendlyError(response.status, serverMsg))
  }

  if (!stream) {
    const data = await response.json()
    const msg = data.choices?.[0]?.message || {}
    const citations = normalizeCitations(msg.annotations || msg.citations || msg.references)
    if (citations.length && onAnnotations) onAnnotations(citations)
    const usage = normalizeUsage(data.usage)
    if (usage && onUsage) onUsage(usage)
    return msg.content || ''
  }

  if (!response.body) throw new Error('浏览器不支持流式响应')
  return parseStream(response.body, onStream, onAnnotations, onUsage)
}

/**
 * 解析 SSE 流式响应（同时收集引用标注与 token 用量）
 */
async function parseStream(reader, onStream, onAnnotations, onUsage) {
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  const citations = []
  const stream = reader.getReader()

  // 各供应商的标注可能放在 delta / 最后一条 message / 顶层字段
  function collect(obj) {
    const list = obj?.annotations || obj?.citations || obj?.references
    if (!Array.isArray(list)) return
    for (const c of normalizeCitations(list)) {
      if (!citations.some((x) => x.url === c.url)) citations.push(c)
    }
  }

  function flushCitations() {
    if (citations.length && onAnnotations) onAnnotations(citations)
  }

  try {
    while (true) {
      const { done, value } = await stream.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        if (trimmed === 'data: [DONE]') {
          flushCitations()
          return fullContent
        }

        try {
          const data = JSON.parse(trimmed.slice(5).trim())
          const choice = data.choices?.[0]
          const delta = choice?.delta?.content
          if (delta) {
            fullContent += delta
            if (onStream) onStream(delta)
          }
          if (choice?.delta) collect(choice.delta)
          if (choice?.message) collect(choice.message)
          collect(data)
          // usage 通常出现在最后一个 chunk（需要 include_usage）
          if (data.usage) {
            const usage = normalizeUsage(data.usage)
            if (usage && onUsage) onUsage(usage)
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
  } finally {
    try { stream.releaseLock() } catch {}
  }

  flushCitations()
  return fullContent
}

// ==================== 联网搜索 ====================

export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '搜索互联网获取实时、最新的信息。当用户的问题涉及最新动态、实时数据、近期事件，或你的知识无法覆盖时调用。可以多次调用以获取更全面的结果。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。请将用户的口语化问题改写为精准、适合搜索引擎的查询词；必要时拆解为多个关键词分别调用。',
        },
      },
      required: ['query'],
    },
  },
}

/**
 * 搜索：后端代理模式 → POST /tools/search
 */
export async function webSearch(config, query, count = 5) {
  const { provider, profileId, baseUrl, apiKey, appendPath, signal } = config
  if (!query) throw new Error('搜索词不能为空')

  const body = { provider, profileId, query, count, need_content: true, appendPath: appendPath !== false }
  if (baseUrl) body.baseUrl = baseUrl
  if (apiKey) body.apiKey = apiKey

  const url = DIRECT_MODE
    ? buildDirectSearchUrl(config)
    : `${BACKEND_BASE}/tools/search`

  const headers = { 'Content-Type': 'application/json' }
  if (!DIRECT_MODE) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let errMsg = `搜索失败 (${response.status})`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errMsg
    } catch {}
    throw new Error(errMsg)
  }

  const data = await response.json()
  const results = data?.results || []
  return results.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    site_name: r.site_name || '',
    snippet: r.snippet || r.summary || '',
    content: r.content || '',
    date: r.date || '',
  }))
}

// ==================== 供应商 Key 管理（服务端数据库） ====================

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * 获取某个模型配置的 Key（后端会回退到供应商 Key / .env）
 */
export async function fetchProfileKey(profileId, provider) {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  const res = await fetch(`${BACKEND_BASE}/models/${encodeURIComponent(profileId)}/key${qs}`, {
    headers: authHeaders(),
    // Key 会随时被修改，禁止浏览器缓存，否则会读到保存前的旧值
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/** 保存某个模型配置专属的 Key */
export async function saveProfileKey(profileId, apiKey) {
  const res = await fetch(`${BACKEND_BASE}/models/${encodeURIComponent(profileId)}/key`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ apiKey }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/** 删除某个模型配置的专属 Key（回退到供应商 Key / .env） */
export async function clearProfileKey(profileId) {
  const res = await fetch(`${BACKEND_BASE}/models/${encodeURIComponent(profileId)}/key`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ==================== 带工具调用的聊天 ====================

/**
 * 带 Function Calling 的聊天请求（流式 + tool_calls）
 */
export async function chatCompletionWithTools(config, onStream = null) {
  const { model, messages, tools, stream = true, temperature = 0.7, maxTokens, signal, onUsage } = config

  if (!model) throw new Error('未选择模型')

  const body = {
    provider: config.provider,
    profileId: config.profileId,
    model, messages, stream, temperature, tools, tool_choice: 'auto',
    appendPath: config.appendPath !== false,
  }
  if (maxTokens) body.max_tokens = maxTokens
  if (stream && STREAM_USAGE_PROVIDERS.has(config.provider)) {
    body.stream_options = { include_usage: true }
  }
  if (config.baseUrl) body.baseUrl = config.baseUrl
  if (config.apiKey) body.apiKey = config.apiKey

  const url = DIRECT_MODE
    ? buildDirectChatUrl(config)
    : `${BACKEND_BASE}/chat/completions`

  const headers = { 'Content-Type': 'application/json' }
  if (!DIRECT_MODE) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, 120_000)

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    let serverMsg = ''
    try {
      const errJson = JSON.parse(errText)
      serverMsg = errJson.error?.message || errJson.message || ''
    } catch {}
    throw new Error(friendlyError(response.status, serverMsg))
  }

  if (!stream) {
    const data = await response.json()
    const msg = data.choices?.[0]?.message || {}
    const usage = normalizeUsage(data.usage)
    if (usage && onUsage) onUsage(usage)
    return { content: msg.content || '', toolCalls: msg.tool_calls || null }
  }

  if (!response.body) throw new Error('浏览器不支持流式响应')
  return parseStreamWithTools(response.body, onStream, onUsage)
}

/**
 * 解析 SSE 响应 + tool_calls 累积
 */
async function parseStreamWithTools(reader, onStream, onUsage) {
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  const toolCallMap = new Map()

  const stream = reader.getReader()
  try {
    while (true) {
      const { done, value } = await stream.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        if (trimmed === 'data: [DONE]') return buildResult()

        try {
          const data = JSON.parse(trimmed.slice(5).trim())
          if (data.usage) {
            const usage = normalizeUsage(data.usage)
            if (usage && onUsage) onUsage(usage)
          }
          const delta = data.choices?.[0]?.delta
          if (!delta) continue

          if (delta.content) {
            fullContent += delta.content
            if (onStream) onStream(delta.content)
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              let entry = toolCallMap.get(tc.index)
              if (!entry) {
                entry = { id: tc.id || '', name: '', args: '' }
                toolCallMap.set(tc.index, entry)
              }
              if (tc.id) entry.id = tc.id
              if (tc.function?.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.args += tc.function.arguments
            }
          }
        } catch {
          // 忽略单条解析错误
        }
      }
    }
  } finally {
    try { stream.releaseLock() } catch {}
  }

  return buildResult()

  function buildResult() {
    const toolCalls = [...toolCallMap.values()]
      .filter((e) => e.id && e.name)
      .map((e) => ({
        id: e.id,
        type: 'function',
        function: { name: e.name, arguments: e.args },
      }))
    return { content: fullContent, toolCalls: toolCalls.length ? toolCalls : null }
  }
}
