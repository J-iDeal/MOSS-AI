/**
 * AI 对话代理路由
 *
 * 前端原逻辑：直接 fetch {baseUrl}/chat/completions
 * 现在改为：fetch /api/v1/chat/completions
 * 后端负责：
 *   1. 根据 provider 取 apiKey：请求显式传入 > 数据库（界面配置） > .env 兜底
 *   2. 代理转发到对应供应商
 *   3. 流式时 SSE 透传，非流式时 JSON 透传
 */
import { Router } from 'express'
import { proxyChat, proxySearch, PROVIDERS, resolveProvider, buildChatUrl, supportsSearch, searchMode } from '../services/aiProxy.js'
import { getProviderKey, setProviderKey, deleteProviderKey } from '../services/providerKeys.js'
import { createError } from '../middleware/error.js'

const router = Router()

/**
 * POST /api/v1/chat/completions
 * 统一对话入口，参数基本对齐 OpenAI 协议
 *
 * Body:
 *   {
 *     provider: 'deepseek',        // 新增！后端据此选 Key
 *     baseUrl?: 'https://...',     // 可选覆盖（自定义供应商时用）
 *     apiKey?: 'sk-xxx',           // 可选覆盖（一般不传，后端从 .env 取）
 *     model: 'deepseek-chat',
 *     messages: [...],
 *     stream: true,
 *     temperature?: 0.7,
 *     max_tokens?: 0,
 *     tools?: [...],
 *     tool_choice?: 'auto'
 *   }
 */
router.post('/chat/completions', async (req, res, next) => {
  const {
    provider, baseUrl, apiKey, model, messages, stream, profileId,
    appendPath, temperature, max_tokens, tools, tool_choice, web_search_options,
  } = req.body || {}

  if (!messages || !Array.isArray(messages)) {
    return next(createError(400, 'messages 必须是数组'))
  }

  // 支持前端传 signal 取消
  // 注意：Node 16+ 中 req 的 'close' 在请求体读完时就会触发，不能用来判断客户端断开
  // 必须监听 res 的 'close'，并排除正常结束（writableEnded）的情况
  const abortController = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort()
  })

  try {
    const result = await proxyChat({
      provider, baseUrl, apiKey, profileId,
      model, messages, stream: stream !== false,
      appendPath,
      temperature, maxTokens: max_tokens,
      tools, tool_choice,
      web_search_options,
      userId: req.user.id,
    }, res, abortController.signal)

    if (result.json !== undefined) {
      // 非流式，还没写入响应
      res.json(result.json)
    }
    // 流式已在 proxyChat 中 pipe 完毕
  } catch (e) {
    next(createError(502, e.message || 'AI 服务调用失败'))
  }
})

/**
 * POST /api/v1/tools/search
 * 搜索代理（主要给 DeepSeek Function Calling 用）
 */
router.post('/tools/search', async (req, res, next) => {
  const { provider, baseUrl, apiKey, profileId, appendPath, query, count } = req.body || {}

  if (!query) return next(createError(400, 'query 必填'))

  try {
    const data = await proxySearch(
      { provider, baseUrl, apiKey, profileId, appendPath, query, count, userId: req.user.id },
      new AbortController().signal
    )
    res.json(data)
  } catch (e) {
    next(createError(502, e.message || '搜索服务调用失败'))
  }
})

/**
 * GET /api/v1/providers
 * 返回可用供应商列表（不含 apiKey），并标记 Key 来源
 */
router.get('/providers', (req, res) => {
  const list = Object.entries(PROVIDERS).map(([key, v]) => ({
    key,
    label: v.label,
    baseUrl: v.baseUrl,
    defaultModel: v.defaultModel,
    // 联网搜索模式：tools=服务端 /tools/search 代理；native=供应商内置搜索；null=未适配
    supportsSearch: supportsSearch(key),
    searchMode: searchMode(key),
  }))

  // 标记哪些供应商已配置 Key：数据库（界面配置）优先，其次 .env 兜底
  const { DEEPSEEK_API_KEY, OPENAI_API_KEY, DOUBAO_API_KEY, QWEN_API_KEY,
          SILICONFLOW_API_KEY, ZHIPU_API_KEY, MINIMAX_API_KEY } = process.env
  const envMap = {
    deepseek: DEEPSEEK_API_KEY, openai: OPENAI_API_KEY, doubao: DOUBAO_API_KEY,
    qwen: QWEN_API_KEY, siliconflow: SILICONFLOW_API_KEY,
    zhipu: ZHIPU_API_KEY, minimax: MINIMAX_API_KEY,
  }
  list.forEach((p) => {
    const dbKey = getProviderKey(req.user.id, p.key)
    const envKey = (envMap[p.key] || '').trim()
    p.source = dbKey ? 'db' : (envKey ? 'env' : null)
    p.configured = !!(dbKey || envKey)
  })

  res.json({ providers: list })
})

/**
 * PUT /api/v1/providers/:provider/key
 * 保存供应商 API Key 到数据库（前端「模型设置」使用）
 */
router.put('/providers/:provider/key', (req, res, next) => {
  const { provider } = req.params
  const { apiKey } = req.body || {}
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) return next(createError(400, 'provider 不合法'))
  if (!apiKey || !apiKey.trim()) return next(createError(400, 'apiKey 不能为空'))

  setProviderKey(req.user.id, provider, apiKey.trim())
  res.json({ ok: true, provider, source: 'db', configured: true })
})

/**
 * DELETE /api/v1/providers/:provider/key
 * 删除数据库中的供应商 Key（之后会回退到 .env）
 */
router.delete('/providers/:provider/key', (req, res, next) => {
  const { provider } = req.params
  if (!/^[a-zA-Z0-9_-]+$/.test(provider)) return next(createError(400, 'provider 不合法'))

  deleteProviderKey(req.user.id, provider)
  res.json({ ok: true, provider })
})

/**
 * POST /api/v1/test-connection
 * 测试供应商连通性（与前端 testProfile 对应，但 Key 在后端）
 */
router.post('/test-connection', async (req, res, next) => {
  const { provider, baseUrl, apiKey, model, appendPath, profileId } = req.body || {}

  const { baseUrl: finalUrl, apiKey: finalKey, keySource } = resolveProvider(
    provider, baseUrl, apiKey, req.user.id, profileId
  )
  if (!finalKey) return res.json({ ok: false, msg: '未配置 API Key，请先在 设置 → 模型设置 中填写' })
  if (!finalUrl) return res.json({ ok: false, msg: '未配置 Base URL' })
  if (!model) return res.json({ ok: false, msg: '未选择模型' })

  try {
    const upstream = await fetch(buildChatUrl(finalUrl, appendPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${finalKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
        stream: false,
      }),
    })
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      let msg = `HTTP ${upstream.status}`
      try { const j = JSON.parse(text); msg = j.error?.message || msg } catch {}
      return res.json({ ok: false, msg })
    }
    res.json({ ok: true, msg: '连接成功', keySource })
  } catch (e) {
    res.json({ ok: false, msg: e.message || '网络错误' })
  }
})

export default router
