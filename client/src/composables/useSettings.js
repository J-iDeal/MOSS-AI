/**
 * 设置管理 composable
 * 使用 localStorage 持久化
 *
 * serverMode: 默认 true（走后端代理，API Key 在后端 .env）
 *              false = 直连模式（调试用，需前端提供 apiKey）
 */
import { reactive, computed, watch, nextTick } from 'vue'
import { PROVIDERS } from '../api/providers'
import { fetchSettings, saveSettings } from '../api/settings'

const STORAGE_KEY = 'ai-chat-settings'

// 是否默认走后端代理（VITE_DIRECT_MODE 会强制开启直连）
const DIRECT_MODE = import.meta.env.VITE_DIRECT_MODE === 'true'

// 同步到后端 settings 表的字段白名单
// 模型相关字段（provider/model/baseUrl/temperature/maxTokens/systemPrompt/activeProfileId）
// 现已归入 models 表，由 activeProfile → settings 镜像填充，不再写入 settings 表
// 排除：apiKey（敏感）、serverMode（构建环境决定）
const SYNC_KEYS = ['stream', 'webSearch', 'branchMode', 'branchCount']

const defaultSettings = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: '',
  model: '',
  // 请求地址是否自动拼接 /chat/completions（false=使用完整地址）
  appendPath: true,
  temperature: 0.7,
  maxTokens: 0,
  stream: true,
  systemPrompt: '你是一个友好、专业的AI助手，请用中文回答用户的问题。',
  activeProfileId: null,
  webSearch: false,
  // 多版本回答：开启后每次提问并发生成多个回答，并列展示方便对比
  branchMode: false,
  branchCount: 2,
  serverMode: !DIRECT_MODE, // true=后端代理, false=直连
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultSettings }
    const parsed = JSON.parse(raw)
    // serverMode 只由构建环境决定，避免历史 localStorage 里的旧值把应用卡在直连模式
    return { ...defaultSettings, ...parsed, serverMode: !DIRECT_MODE }
  } catch { return { ...defaultSettings } }
}

const settings = reactive(loadFromStorage())

function applyProviderDefaults() {
  const provider = PROVIDERS[settings.provider]
  if (!provider) return
  if (!settings.baseUrl) settings.baseUrl = provider.baseUrl
  if (!settings.model || (provider.models.length && !provider.models.includes(settings.model))) {
    settings.model = provider.defaultModel
  }
}
applyProviderDefaults()

// 后端同步：变更后防抖回写；applyingRemote 期间跳过，避免拉取时回环
let applyingRemote = false
let saveTimer = null

function pushToBackend() {
  if (applyingRemote) return
  const kv = {}
  for (const k of SYNC_KEYS) kv[k] = settings[k]
  saveSettings(kv).catch((e) => console.warn('[settings] 同步到后端失败:', e))
}

watch(
  settings,
  (val) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(val)) } catch {}
    if (applyingRemote) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(pushToBackend, 400)
  },
  { deep: true }
)

// 启动时从后端拉取并合并（后端优先）；后端为空则把本地默认值首次落库
async function pullFromBackend() {
  try {
    const remote = await fetchSettings() || {}
    applyingRemote = true
    let hasRemote = false
    for (const k of SYNC_KEYS) {
      if (remote[k] !== undefined && remote[k] !== null) {
        hasRemote = true
        if (settings[k] !== remote[k]) settings[k] = remote[k]
      }
    }
    await nextTick() // 等 watch 刷新完毕（期间 applyingRemote=true，跳过回写）
    applyingRemote = false
    if (!hasRemote) pushToBackend()
  } catch (e) {
    applyingRemote = false
    console.warn('[settings] 从后端拉取失败，使用本地设置:', e)
  }
}
pullFromBackend()

export function useSettings() {
  // serverMode 下只需要 provider + model；直连模式需要 apiKey
  const isConfigured = computed(() => {
    if (settings.serverMode) {
      return !!(settings.provider && settings.model)
    }
    // 直连模式
    return !!(settings.apiKey && settings.baseUrl && settings.model)
  })

  function getProviderConfig() {
    return {
      provider: settings.provider,
      // 后端据此找到该「模型配置」专属的 Key
      profileId: settings.activeProfileId || undefined,
      baseUrl: settings.baseUrl,
      appendPath: settings.appendPath !== false,
      // 后端代理模式下 Key 由服务端按模型配置解析，前端不再传
      apiKey: settings.serverMode ? '' : settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens || undefined,
      stream: settings.stream,
    }
  }

  function validate() {
    const errors = {}
    if (!settings.provider) errors.provider = '请选择供应商'
    if (!settings.model) errors.model = '请选择模型'
    if (!settings.serverMode) {
      // 直连模式才要求 apiKey / baseUrl
      if (!settings.baseUrl) errors.baseUrl = '请输入 API Base URL'
      if (!settings.apiKey) errors.apiKey = '请输入 API Key'
    }
    return errors
  }

  return {
    settings,
    isConfigured,
    getProviderConfig,
    validate,
  }
}
