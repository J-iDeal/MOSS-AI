/**
 * AI 供应商配置 + 代理转发服务
 *
 * 设计原则：
 *   - 前端传 provider 名称（deepseek/openai/...），后端查配置拿到 baseUrl + apiKey
 *   - 前端也可以直接传 baseUrl 覆盖（兼容自定义供应商）
 *   - 流式对话：后端 fetch AI API → 拿到 ReadableStream → 管道给前端 res
 *   - 非流式：正常 JSON 转发
 */

import 'dotenv/config'
import { getProviderKey } from './providerKeys.js'
import { getModelKey } from './models.js'

// ==================== 供应商预设 ====================
// baseUrl + 默认模型（与前端保持一致）
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  doubao: {
    label: '豆包(火山引擎)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 火山方舟只接受「带版本号的模型 ID」或「接入点 ep-xxx」，短名如 doubao-pro-32k 已下线
    defaultModel: 'doubao-seed-2-0-pro-260215',
  },
  qwen: {
    label: '通义(阿里云百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  zhipu: {
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4',
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
  },
}

// Provider → env key 映射
const PROVIDER_ENV = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  doubao: 'DOUBAO_API_KEY',
  qwen: 'QWEN_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  minimax: 'MINIMAX_API_KEY',
}

// 支持 stream_options.include_usage 的 OpenAI 兼容供应商（流式也能拿到 token 用量）
const STREAM_USAGE_PROVIDERS = new Set([
  'openai', 'deepseek', 'siliconflow', 'custom', 'zhipu', 'qwen', 'moonshot',
])

/** 读取某个供应商在 .env 中配置的 Key */
export function getEnvKey(provider) {
  const envName = PROVIDER_ENV[provider]
  return envName ? (process.env[envName] || '').trim() : ''
}

/**
 * 供应商联网搜索能力
 *   - tools ：服务端 /tools/search 代理（DeepSeek）
 *   - native：供应商内置搜索，对话请求里开启即可（豆包 web_search_options）
 * 其余供应商的联网机制不同（OpenAI web_search 工具、通义 enable_search 等），尚未接入。
 * 新增适配后需同步客户端 providers.js 的 searchMode。
 */
export const SEARCH_MODES = {
  deepseek: 'tools',
  doubao: 'native',
}

export function searchMode(provider) {
  return SEARCH_MODES[provider] || null
}

export function supportsSearch(provider) {
  return !!searchMode(provider)
}

const CHAT_PATH = '/chat/completions'

function trimBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/**
 * 生成对话请求地址
 * - appendPath=true：在地址后拼接 /chat/completions
 * - appendPath=false：输入的本身就是完整地址，原样请求
 */
export function buildChatUrl(baseUrl, appendPath = true) {
  const base = trimBaseUrl(baseUrl)
  if (!base) return ''
  return appendPath === false ? base : base + CHAT_PATH
}

/** 生成联网搜索地址；不拼接模式下先从完整对话地址中去掉 /chat/completions */
export function buildSearchUrl(baseUrl, appendPath = true) {
  let base = trimBaseUrl(baseUrl)
  if (!base) return ''
  if (appendPath === false) base = base.replace(new RegExp(`${CHAT_PATH}$`, 'i'), '')
  return base ? `${base}/tools/search` : ''
}

/**
 * 解析请求参数，拿到最终要请求的 { baseUrl, apiKey }
 * baseUrl 优先级：前端显式传 > 后端 provider 预设
 * apiKey 优先级：前端显式传 > 模型配置专属 Key > 供应商 Key > .env 兜底
 */
export function resolveProvider(provider, baseUrl, apiKey, userId, profileId) {
  const preset = PROVIDERS[provider]
  const finalBaseUrl = (baseUrl && baseUrl.trim())
    ? baseUrl.trim()
    : preset?.baseUrl || ''

  let finalKey = (apiKey && apiKey.trim()) ? apiKey.trim() : ''
  let keySource = finalKey ? 'request' : ''

  // 该模型配置自己的 Key（存在 models 表的 api_key 列）
  if (!finalKey && userId && profileId) {
    finalKey = getModelKey(userId, profileId)
    if (finalKey) keySource = 'model'
  }

  // 供应商维度的 Key（历史数据，作为兼容回退）
  if (!finalKey && userId) {
    finalKey = getProviderKey(userId, provider)
    if (finalKey) keySource = 'provider'
  }

  // .env 兜底
  if (!finalKey && provider && PROVIDER_ENV[provider]) {
    finalKey = getEnvKey(provider)
    if (finalKey) keySource = 'env'
  }

  return { baseUrl: finalBaseUrl, apiKey: finalKey, keySource, preset }
}

/**
 * 统一的 Chat Completions 代理
 * @param {Object} params
 *   - provider, baseUrl, apiKey, model, messages, stream, temperature, maxTokens, tools, tool_choice
 *   - web_search_options: 供应商内置联网搜索开关（豆包），原样透传
 * @param {Object} res    Express Response（stream=true 时用）
 * @param {AbortSignal} signal
 */
export async function proxyChat(params, res, signal) {
  const {
    provider, baseUrl: reqBaseUrl, apiKey: reqKey, userId, profileId,
    appendPath, model, messages, stream = true, temperature = 0.7, maxTokens,
    tools, tool_choice, web_search_options,
  } = params

  const { baseUrl, apiKey } = resolveProvider(provider, reqBaseUrl, reqKey, userId, profileId)

  if (!apiKey) throw new Error('未配置 API Key（请在 设置 → 模型设置 中填写）')
  if (!baseUrl) throw new Error('未配置 Base URL')
  if (!model) throw new Error('未选择模型')

  const url = buildChatUrl(baseUrl, appendPath)
  const body = { model, messages, stream, temperature }
  if (maxTokens) body.max_tokens = maxTokens
  if (tools) body.tools = tools
  if (tool_choice) body.tool_choice = tool_choice
  if (web_search_options) body.web_search_options = web_search_options
  // 流式请求 token 用量（部分 OpenAI 兼容供应商支持，不支持时通常会被忽略）
  if (stream && STREAM_USAGE_PROVIDERS.has(provider)) {
    body.stream_options = { include_usage: true }
  }

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    let msg = `上游错误 (${upstream.status})`
    try {
      const j = JSON.parse(errText)
      msg = j.error?.message || j.message || msg
    } catch {
      msg += ': ' + errText.slice(0, 300)
    }
    // 透传上游状态码，前端可据此把 401/429/5xx 翻译成可操作的提示
    const err = new Error(msg)
    err.status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
    err.expose = true
    throw err
  }

  if (!stream) {
    // 非流式：直接返回 JSON
    const data = await upstream.json()
    return { json: data }
  }

  // 流式：把上游 ReadableStream pipe 给前端
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Nginx 防缓冲

  if (!upstream.body) {
    res.write('data: [DONE]\n\n')
    res.end()
    return { streamed: true }
  }

  // Node fetch 的 body 是 Web ReadableStream，需要 pipeTo
  try {
    const { Readable } = await import('node:stream')
    const nodeStream = Readable.fromWeb(upstream.body)
    nodeStream.pipe(res)
    await new Promise((resolve, reject) => {
      nodeStream.on('end', resolve)
      nodeStream.on('error', reject)
      res.on('close', () => { try { nodeStream.destroy() } catch {} resolve() })
    })
  } catch (e) {
    // 如果 pipeTo 方式失败，降级手动读取
    try {
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    } catch {}
  }

  return { streamed: true }
}

/**
 * 联网搜索代理 — 转发到供应商的 /tools/search（tools 模式，目前 DeepSeek 支持）
 * 豆包走内置搜索（native），不经过这里
 */
export async function proxySearch(params, signal) {
  const { provider, baseUrl: reqBaseUrl, apiKey: reqKey, userId, profileId, appendPath, query, count = 5 } = params

  // 只有 tools 模式才有该接口，提前给出明确原因，避免只看到上游 404 或 Key 报错
  const mode = searchMode(provider)
  if (PROVIDERS[provider] && mode !== 'tools') {
    throw new Error(mode === 'native'
      ? '该供应商使用内置联网搜索，不支持 /tools/search 接口'
      : '该供应商未适配联网搜索（当前支持 DeepSeek、豆包）')
  }

  const { baseUrl, apiKey } = resolveProvider(provider, reqBaseUrl, reqKey, userId, profileId)

  if (!apiKey) throw new Error('未配置 API Key')
  if (!baseUrl) throw new Error('未配置 Base URL')

  const url = buildSearchUrl(baseUrl, appendPath)
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, count, need_content: true }),
    signal,
  })

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    let msg = `搜索失败 (${upstream.status})`
    try { const j = JSON.parse(text); msg = j.error?.message || msg } catch {}
    if (upstream.status === 404) msg = '该供应商未提供 /tools/search 接口，无法联网搜索'
    throw new Error(msg)
  }

  return upstream.json()
}
