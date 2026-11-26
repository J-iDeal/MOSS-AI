/**
 * 多模型配置管理 composable（后端 models 表为单一事实来源）
 *
 * - 启动时从后端拉取模型列表；localStorage 仅作离线缓存
 * - 变更方法（add/update/delete/setActive）均为 async：先更新本地保证 UI 响应，
 *   再 await 后端，避免「建配置→存 Key」之间的竞态
 * - 直连模式（VITE_DIRECT_MODE）退化为纯 localStorage，与旧行为一致
 */
import { ref, computed, watch } from 'vue'
import { PROVIDERS } from '../api/providers'
import { API_BASE, getToken } from '../api/http.js'
import {
  fetchModels, createModel, updateModel, removeModel, activateModel,
} from '../api/models.js'

const STORAGE_KEY = 'ai-chat-model-profiles'
const ACTIVE_KEY = 'ai-chat-active-profile'
const DIRECT_MODE = import.meta.env.VITE_DIRECT_MODE === 'true'

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveCache(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch {}
}
function loadActiveId(fallback) {
  try { return localStorage.getItem(ACTIVE_KEY) || fallback || null }
  catch { return fallback || null }
}

const profiles = ref(loadCache())
const activeId = ref(loadActiveId(profiles.value[0]?.id))

watch(profiles, (val) => saveCache(val), { deep: true })
watch(activeId, (val) => { try { localStorage.setItem(ACTIVE_KEY, val) } catch {} })

/** 启动时从后端拉取；后端为空则清理旧缓存并建默认模型 */
async function seedDefault() {
  const def = await createModel({
    name: '默认 - DeepSeek',
    provider: 'deepseek',
    model: PROVIDERS.deepseek.defaultModel,
    baseUrl: PROVIDERS.deepseek.baseUrl,
    temperature: 0.7,
    maxTokens: 0,
    systemPrompt: '',
  })
  if (!def) return
  const activated = await activateModel(def.id)
  profiles.value = [activated || def]
  activeId.value = def.id
}

async function init() {
  if (DIRECT_MODE) return
  try {
    const list = await fetchModels()
    if (list && list.length) {
      profiles.value = list
      const active = list.find((m) => m.isActive) || list[0]
      activeId.value = active?.id || null
    } else {
      // 后端为空 → 清掉旧 localStorage 残留（用户选择重建），建默认模型
      try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(ACTIVE_KEY) } catch {}
      await seedDefault()
    }
  } catch (e) {
    console.warn('[models] 从后端加载失败，使用本地缓存:', e)
  }
}
init()

export function useModels() {
  const activeProfile = computed(() =>
    profiles.value.find((p) => p.id === activeId.value) || profiles.value[0] || null
  )

  async function addProfile(profile) {
    const p = {
      id: genId(),
      name: profile.name || '新模型',
      provider: profile.provider || 'custom',
      apiKey: profile.apiKey || '',
      baseUrl: profile.baseUrl || '',
      // 请求地址是否自动拼接 /chat/completions（false=输入的是完整地址）
      appendPath: profile.appendPath !== false,
      model: profile.model || '',
      temperature: profile.temperature ?? 0.7,
      maxTokens: profile.maxTokens ?? 0,
      systemPrompt: profile.systemPrompt ?? '你是一个友好、专业的AI助手，请用中文回答用户的问题。',
    }
    const provider = PROVIDERS[p.provider]
    // 只补全请求地址，模型 ID 由用户手动填写
    if (provider?.baseUrl && !p.baseUrl) p.baseUrl = provider.baseUrl

    profiles.value.push(p) // 先更新本地，UI 立即响应
    if (DIRECT_MODE) return p
    try {
      const created = await createModel({
        id: p.id, name: p.name, provider: p.provider, model: p.model,
        baseUrl: p.baseUrl, appendPath: p.appendPath, apiKey: p.apiKey || undefined,
        temperature: p.temperature, maxTokens: p.maxTokens, systemPrompt: p.systemPrompt,
      })
      if (created) Object.assign(p, created)
    } catch (e) {
      console.warn('[models] 创建失败:', e)
    }
    return p
  }

  async function updateProfile(id, updates) {
    const idx = profiles.value.findIndex((p) => p.id === id)
    if (idx === -1) return
    profiles.value[idx] = { ...profiles.value[idx], ...updates }
    if (DIRECT_MODE) return
    // 不通过配置更新接口改 Key（Key 走 /key 接口，避免覆盖刚保存的 Key）
    const { apiKey, ...rest } = updates
    try { await updateModel(id, rest) } catch (e) { console.warn('[models] 更新失败:', e) }
  }

  async function deleteProfile(id) {
    const wasActive = activeId.value === id
    profiles.value = profiles.value.filter((p) => p.id !== id)
    if (wasActive) {
      const next = profiles.value[0]
      activeId.value = next?.id || null
      if (next) next.isActive = true
    }
    if (DIRECT_MODE) return
    try { await removeModel(id) } catch (e) { console.warn('[models] 删除失败:', e) }
  }

  async function setActive(id) {
    activeId.value = id
    profiles.value.forEach((p) => { p.isActive = (p.id === id) })
    if (DIRECT_MODE) return
    try { await activateModel(id) } catch (e) { console.warn('[models] 激活失败:', e) }
  }

  /**
   * 测试供应商连通性
   * - 后端代理模式：调 /api/v1/test-connection（Key 由后端按模型 id 解析）
   * - 直连模式：直接 POST {baseUrl}/chat/completions
   */
  async function testProfile(profile) {
    if (!profile.model) return { ok: false, msg: '请先选择模型' }

    if (!DIRECT_MODE) {
      try {
        const token = getToken()
        const headers = { 'Content-Type': 'application/json' }
        if (token) headers['Authorization'] = `Bearer ${token}`
        const body = { provider: profile.provider, model: profile.model }
        if (profile.id) body.profileId = profile.id
        if (profile.baseUrl) body.baseUrl = profile.baseUrl
        if (profile.apiKey) body.apiKey = profile.apiKey
        body.appendPath = profile.appendPath !== false
        const res = await fetch(`${API_BASE}/test-connection`, {
          method: 'POST', headers, body: JSON.stringify(body),
        })
        // 后端未启动时 Vite 代理会返回空响应，直接 res.json() 会抛 "Unexpected end of JSON input"
        const data = await res.json().catch(() => null)
        if (!data) {
          return {
            ok: false,
            msg: res.ok
              ? '后端返回内容为空，请确认服务已启动'
              : `后端服务未就绪（HTTP ${res.status}），请先运行 start.bat`,
          }
        }
        return data
      } catch (e) { return { ok: false, msg: e.message || '网络错误' } }
    }

    if (!profile.apiKey || !profile.baseUrl) return { ok: false, msg: '请先填入 API Key 和 Base URL' }
    try {
      const base = profile.baseUrl.replace(/\/+$/, '')
      const url = profile.appendPath === false ? base : `${base}/chat/completions`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, stream: false }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let msg = `HTTP ${res.status}`
        try { const j = JSON.parse(text); msg = j.error?.message || msg } catch {}
        return { ok: false, msg }
      }
      return { ok: true, msg: '连接成功' }
    } catch (e) { return { ok: false, msg: e.message || '网络错误' } }
  }

  return {
    profiles, activeId, activeProfile,
    addProfile, updateProfile, deleteProfile, setActive, testProfile,
  }
}
