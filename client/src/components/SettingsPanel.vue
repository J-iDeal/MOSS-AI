<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import { useSettings } from '../composables/useSettings'
import { useModels } from '../composables/useModels'
import { useChat } from '../composables/useChat'
import { useTheme, PALETTES } from '../composables/useTheme'
import { PROVIDERS, saveProfileKey, clearProfileKey, fetchProfileKey, webSearch, chatCompletion, providerSupportsSearch, providerSearchMode } from '../api/providers'

const props = defineProps({ visible: Boolean })
const emit = defineEmits(['close'])

const { settings, validate } = useSettings()
const { theme, palette, setTheme, setPalette } = useTheme()
const {
  profiles, activeId, activeProfile,
  addProfile, updateProfile, deleteProfile, setActive, testProfile,
} = useModels()
const { importChat } = useChat()

// ==================== 系统设置：模块切换 ====================
const activeSection = ref('general')

// ==================== 对话导入 ====================
const importInput = ref(null)
const importStatus = ref(null)

async function handleImport(event) {
  const file = event.target.files?.[0]
  if (!file) return
  importStatus.value = null
  try {
    const data = JSON.parse(await file.text())
    const imported = await importChat(data)
    importStatus.value = { ok: true, msg: `已导入“${imported.title}”` }
  } catch (error) {
    importStatus.value = {
      ok: false,
      msg: error instanceof SyntaxError ? '文件不是有效的 JSON，请选择导出的 JSON 源数据' : error.message,
    }
  } finally {
    event.target.value = ''
  }
}

// ==================== 一级：模型列表 ====================
const confirmDeleteId = ref(null)

// ==================== 二级：模型编辑 ====================
const showEditor = ref(false)
const editingProfile = ref(null) // 编辑副本，保存时才写入
const editingError = ref('')
const testing = ref(false)
const testResult = ref(null)
const testingSearch = ref(false)
const searchTestResult = ref(null)
const showAdvanced = ref(false) // 二级弹窗内的高级配置折叠

// 当前模型配置的 Key 状态
// source: model=配置专属 Key, provider=沿用供应商历史 Key, env=.env 兜底
const editingKeySource = ref(null)
const keyLoadError = ref('')
const editingApiKey = ref('') // 打开编辑时回填当前生效值
const editingKeyOriginal = ref('') // 打开编辑时的 Key，用于判断是否修改
const keyBusy = ref(false)

async function loadKeyForProfile(profile) {
  editingApiKey.value = ''
  editingKeyOriginal.value = ''
  editingKeySource.value = null
  keyLoadError.value = ''
  if (!settings.serverMode || !profile?.id) return
  try {
    const data = await fetchProfileKey(profile.id, profile.provider)
    editingApiKey.value = data.apiKey || ''
    editingKeyOriginal.value = data.apiKey || ''
    editingKeySource.value = data.source || null
  } catch (e) {
    keyLoadError.value = e.message || '读取失败'
  }
}

const keyPlaceholder = computed(() =>
  editingKeySource.value
    ? '留空表示不修改'
    : 'sk-...（保存后绑定到当前模型配置）'
)

const keyHint = computed(() => {
  if (!settings.serverMode) return ''
  if (keyLoadError.value) {
    return `读取服务器 Key 失败：${keyLoadError.value}`
  }
  if (editingKeySource.value === 'model') {
    return 'Key 已绑定到当前模型配置，明文显示，可直接修改。'
  }
  if (editingKeySource.value === 'provider') {
    return '当前沿用该供应商的历史 Key，保存后归到当前模型配置。'
  }
  if (editingKeySource.value === 'env') {
    return '当前使用 .env 中的 Key，保存后归到当前模型配置。'
  }
  return '尚未配置 Key，输入后保存会绑定到当前模型配置。'
})

const providerList = computed(() =>
  Object.entries(PROVIDERS).map(([key, val]) => ({ key, ...val }))
)

// 预填请求地址：不拼接模式下补成完整地址，避免预填内容与开关语义不一致
function providerBaseUrl(provider, appendPath) {
  const base = PROVIDERS[provider]?.baseUrl || ''
  return appendPath === false && base ? `${base}/chat/completions` : base
}

// 激活配置变化时同步到 settings（发送消息使用），高级参数跟随模型
watch(
  activeProfile,
  (p) => {
    if (p) {
      settings.provider = p.provider
      settings.apiKey = p.apiKey
      settings.baseUrl = p.baseUrl
      settings.appendPath = p.appendPath !== false
      settings.model = p.model
      settings.activeProfileId = p.id
      settings.temperature = p.temperature ?? 0.7
      settings.maxTokens = p.maxTokens ?? 0
      settings.systemPrompt = p.systemPrompt ?? ''
    }
  },
  { immediate: true, deep: true }
)

// 每次打开设置时回到一级列表
watch(
  () => props.visible,
  (val) => {
    if (val) {
      showEditor.value = false
      editingProfile.value = null
      confirmDeleteId.value = null
      importStatus.value = null
    }
  }
)

// ==================== 二级弹窗操作 ====================
async function openEditor(id) {
  const p = profiles.value.find((x) => x.id === id)
  if (!p) return
  editingProfile.value = {
    temperature: 0.7,
    maxTokens: 0,
    systemPrompt: '',
    appendPath: true,
    ...p,
  }
  if (editingProfile.value.appendPath === undefined) {
    editingProfile.value.appendPath = true
  }
  if (!editingProfile.value.baseUrl) {
    editingProfile.value.baseUrl = providerBaseUrl(
      editingProfile.value.provider,
      editingProfile.value.appendPath
    )
  }
  editingError.value = ''
  testResult.value = null
  searchTestResult.value = null
  showAdvanced.value = false
  showEditor.value = true
  await loadKeyForProfile(editingProfile.value)
}

async function openNewEditor() {
  const cur = activeProfile.value
  const provider = cur?.provider || 'deepseek'
  editingProfile.value = {
    id: null,
    name: '',
    provider,
    apiKey: '',
    baseUrl: providerBaseUrl(provider, true),
    appendPath: true,
    model: '',
    temperature: 0.7,
    maxTokens: 0,
    systemPrompt: '你是一个友好、专业的AI助手，请用中文回答用户的问题。',
  }
  editingError.value = ''
  testResult.value = null
  searchTestResult.value = null
  showAdvanced.value = false
  showEditor.value = true
  await loadKeyForProfile(editingProfile.value)
}

function closeEditor() {
  showEditor.value = false
  editingProfile.value = null
}

function onProviderChange() {
  const p = PROVIDERS[editingProfile.value.provider]
  if (p) {
    // 仅自动填充请求地址，模型 ID 保留用户输入/为空，由用户自行填写
    editingProfile.value.baseUrl = providerBaseUrl(
      editingProfile.value.provider,
      editingProfile.value.appendPath
    )
  }
  // 换了供应商，重新读取该配置在新供应商下的 Key
  loadKeyForProfile(editingProfile.value)
  testResult.value = null
  searchTestResult.value = null
}

// ==================== Provider 自定义下拉 ====================
const providerOpen = ref(false)
const providerLabel = computed(() => {
  const p = PROVIDERS[editingProfile.value?.provider]
  return p?.label || editingProfile.value?.provider || '请选择'
})
function selectProvider(key) {
  editingProfile.value.provider = key
  onProviderChange()
  providerOpen.value = false
}
function onGlobalClick(e) {
  if (!e.target.closest('.app-select')) providerOpen.value = false
}
// Esc：优先关闭二级编辑弹窗 / 删除确认，最后关闭整个设置面板
function onKeydown(e) {
  if (!props.visible || e.key !== 'Escape') return
  e.preventDefault()
  if (showEditor.value) { closeEditor(); return }
  if (confirmDeleteId.value) { confirmDeleteId.value = null; return }
  emit('close')
}

onMounted(() => {
  document.addEventListener('click', onGlobalClick)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onGlobalClick)
  document.removeEventListener('keydown', onKeydown)
})

async function saveEditor() {
  const ep = editingProfile.value
  if (!ep) return
  const name = ep.name?.trim() || ''
  if (!name) {
    editingError.value = '请输入配置名称'
    return
  }
  // 配置名称强制唯一
  if (profiles.value.some((x) => x.id !== ep.id && (x.name || '').trim() === name)) {
    editingError.value = '配置名称已存在，请换一个'
    return
  }
  ep.name = name
  const provider = PROVIDERS[ep.provider]
  if (provider && !ep.baseUrl) ep.baseUrl = providerBaseUrl(ep.provider, ep.appendPath)

  if (settings.serverMode) {
    const key = editingApiKey.value.trim()
    const keyChanged = !!key && key !== editingKeyOriginal.value
    ep.apiKey = '' // Key 只存服务端，不留在浏览器

    // 先落库配置（新配置需要先有 id），再按 id 保存专属 Key
    let targetId = ep.id
    if (ep.id) {
      await updateProfile(ep.id, ep)
    } else {
      const added = await addProfile(ep)
      targetId = added.id
      await setActive(added.id)
    }

    if (keyChanged) {
      keyBusy.value = true
      try {
        await saveProfileKey(targetId, key)
        editingKeyOriginal.value = key
        editingKeySource.value = 'model'
      } catch (e) {
        editingError.value = `保存 API Key 失败：${e.message}`
        keyBusy.value = false
        return
      }
      keyBusy.value = false
    }
  } else if (ep.id) {
    await updateProfile(ep.id, ep)
  } else {
    const added = await addProfile(ep)
    await setActive(added.id)
  }
  closeEditor()
}

async function handleClearKey() {
  const ep = editingProfile.value
  if (!ep?.id) return
  keyBusy.value = true
  editingError.value = ''
  try {
    await clearProfileKey(ep.id)
    testResult.value = null
    await loadKeyForProfile(ep)
  } catch (e) {
    editingError.value = `清除 API Key 失败：${e.message}`
  } finally {
    keyBusy.value = false
  }
}

async function handleTest() {
  if (!editingProfile.value) return
  testing.value = true
  testResult.value = null
  // 代理模式下若刚输入了未保存的 Key，先用它测试
  const keyOverride = settings.serverMode ? editingApiKey.value.trim() : editingProfile.value.apiKey
  testResult.value = await testProfile({ ...editingProfile.value, apiKey: keyOverride })
  testing.value = false
}

/**
 * 测试联网搜索：真实发起一次搜索
 * - native（豆包）：对话请求开启 web_search_options，看是否返回引用标注
 * - tools（DeepSeek/自定义）：直接请求 /tools/search
 */
async function handleTestSearch() {
  const ep = editingProfile.value
  if (!ep || testingSearch.value) return
  if (!ep.model) {
    searchTestResult.value = { ok: false, msg: '请先填写模型 ID' }
    return
  }
  testingSearch.value = true
  searchTestResult.value = null
  const keyOverride = settings.serverMode ? editingApiKey.value.trim() : ep.apiKey
  try {
    if (providerSearchMode(ep.provider) === 'native') {
      let citations = []
      await chatCompletion({
        provider: ep.provider,
        profileId: ep.id || undefined,
        baseUrl: ep.baseUrl,
        appendPath: ep.appendPath !== false,
        apiKey: keyOverride,
        model: ep.model,
        messages: [{ role: 'user', content: '请搜索今天的新闻，并用一句话概括' }],
        stream: false,
        temperature: 0.3,
        nativeSearch: true,
        onAnnotations: (list) => { citations = list },
      })
      searchTestResult.value = citations.length
        ? { ok: true, msg: `内置联网搜索可用，返回 ${citations.length} 个引用` }
        : {
            ok: false,
            msg: '未返回引用：Chat API 会静默忽略未生效的搜索。请确认 方舟控制台→应用组件库→豆包搜索→「豆包搜索 Custom 版」显示「已开通」，且控制台账号/地域与该 API Key 一致',
          }
    } else {
      const results = await webSearch(
        {
          provider: ep.provider,
          profileId: ep.id || undefined,
          baseUrl: ep.baseUrl,
          appendPath: ep.appendPath !== false,
          apiKey: keyOverride,
        },
        '联网搜索测试',
        3
      )
      searchTestResult.value = results.length
        ? { ok: true, msg: `搜索接口可用，返回 ${results.length} 条结果` }
        : { ok: false, msg: '接口可访问，但未返回结果' }
    }
  } catch (e) {
    searchTestResult.value = { ok: false, msg: e.message || '搜索测试失败' }
  } finally {
    testingSearch.value = false
  }
}

// ==================== 一级操作 ====================
async function handleDeleteProfile() {
  if (confirmDeleteId.value) {
    const id = confirmDeleteId.value
    confirmDeleteId.value = null
    await deleteProfile(id) // 删模型行即连带删除其专属 Key
  }
}

function handleClose() {
  validate()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <!-- 一级弹窗：模型列表 -->
    <div v-if="visible" class="settings-overlay">
      <div class="settings-panel">
        <div class="settings-header">
          <div class="settings-title">
            <Icon name="settings" :size="18" />
            <span>系统设置</span>
          </div>
          <button class="settings-close" @click="handleClose">
            <Icon name="x" :size="18" />
          </button>
        </div>

        <div class="settings-body settings-layout">
          <!-- 左侧：设置模块 -->
          <nav class="settings-nav">
            <button
              :class="['settings-nav-item', { active: activeSection === 'general' }]"
              @click="activeSection = 'general'"
            >
              <Icon name="settings" :size="15" />
              通用设置
            </button>
            <button
              :class="['settings-nav-item', { active: activeSection === 'conversation' }]"
              @click="activeSection = 'conversation'"
            >
              <Icon name="chat" :size="15" />
              对话设置
            </button>
            <button
              :class="['settings-nav-item', { active: activeSection === 'models' }]"
              @click="activeSection = 'models'"
            >
              <Icon name="bot" :size="15" />
              模型设置
            </button>
          </nav>

          <!-- 右侧：设置详情 -->
          <div class="settings-content">
            <!-- 通用设置 -->
            <template v-if="activeSection === 'general'">
              <div class="settings-group">
                <div class="settings-group-title">外观</div>
                <div class="form-label">主题模式</div>
                <div class="theme-options">
                  <button
                    :class="['theme-option', { active: theme === 'light' }]"
                    @click="setTheme('light')"
                  >
                    <Icon name="sun" :size="20" />
                    <span>浅色</span>
                  </button>
                  <button
                    :class="['theme-option', { active: theme === 'dark' }]"
                    @click="setTheme('dark')"
                  >
                    <Icon name="moon" :size="20" />
                    <span>深色</span>
                  </button>
                  <button
                    :class="['theme-option', { active: theme === 'system' }]"
                    @click="setTheme('system')"
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="4" width="18" height="12" rx="2" />
                      <path d="M8 20h8M12 16v4" />
                    </svg>
                    <span>跟随系统</span>
                  </button>
                </div>

                <div class="form-label" style="margin-top:18px;">主题配色</div>
                <div class="palette-options">
                  <button
                    v-for="p in PALETTES"
                    :key="p.id"
                    :class="['palette-option', { active: palette === p.id }]"
                    @click="setPalette(p.id)"
                  >
                    <span class="palette-dots">
                      <span class="palette-dot" :style="{ background: p.colors[0] }"></span>
                      <span class="palette-dot" :style="{ background: p.colors[1] }"></span>
                    </span>
                    <span class="palette-name">{{ p.label }}</span>
                    <Icon v-if="palette === p.id" name="check" :size="13" class="palette-check" />
                  </button>
                </div>
              </div>
            </template>

            <!-- 对话设置 -->
            <template v-else-if="activeSection === 'conversation'">
              <div class="settings-group">
                <div class="settings-group-title">回答方式</div>
                <div class="toggle-row">
                  <div>
                    <div class="form-label" style="margin-bottom:0;">流式回答</div>
                    <div class="form-hint">边生成边显示，对所有模型配置全局生效</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="流式回答"
                    :aria-checked="settings.stream"
                    :class="['toggle-switch', settings.stream ? 'on' : '']"
                    @click="settings.stream = !settings.stream"
                  ></button>
                </div>
              </div>

              <div class="settings-group">
                <div class="settings-group-title">数据管理</div>
                <div class="form-label">导入对话</div>
                <div class="form-hint">选择 MOSS-AI 导出的 JSON 源数据，导入后将创建一个新对话。</div>
                <input
                  ref="importInput"
                  type="file"
                  accept=".json,application/json"
                  style="display:none;"
                  @change="handleImport"
                />
                <button class="btn btn-secondary" style="margin-top:12px;" @click="importInput?.click()">
                  <Icon name="upload" :size="14" />
                  选择 JSON 文件
                </button>
                <div
                  v-if="importStatus"
                  class="form-hint"
                  :style="{ color: importStatus.ok ? 'var(--success)' : 'var(--danger)' }"
                >{{ importStatus.msg }}</div>
              </div>
            </template>

            <!-- 模型设置 -->
            <template v-else>
          <div class="settings-group">
            <div class="settings-group-title">
              <Icon name="bot" :size="12" style="vertical-align:-2px; margin-right:4px; opacity:0.7;" />
              模型列表
            </div>

            <div
              v-for="p in profiles"
              :key="p.id"
              :class="['model-card', { active: activeId === p.id }]"
            >
              <div class="model-card-header">
                <div style="min-width:0;">
                  <div class="model-card-name">
                    {{ p.name }}
                    <span style="font-size:11px; color:var(--text-muted); font-weight:400; margin-left:4px;">
                      {{ PROVIDERS[p.provider]?.label || p.provider }}
                    </span>
                  </div>
                  <div class="model-card-meta">{{ p.model || '未设置模型' }}</div>
                </div>
                <div class="model-card-actions">
                  <button
                    v-if="activeId !== p.id"
                    class="btn btn-sm btn-secondary"
                    @click="setActive(p.id)"
                  >使用</button>
                  <span v-else style="font-size:12px; color:var(--primary); padding:6px 4px; display:flex; align-items:center; gap:4px;">
                    <Icon name="check" :size="13" />当前
                  </span>
                  <button class="btn btn-sm btn-secondary" @click="openEditor(p.id)">
                    <Icon name="edit" :size="13" />
                  </button>
                  <button
                    v-if="profiles.length > 1"
                    class="btn btn-sm btn-secondary"
                    @click="confirmDeleteId = p.id"
                  >
                    <Icon name="trash" :size="13" />
                  </button>
                </div>
              </div>
            </div>

            <button class="btn btn-secondary" style="width:100%; margin-top:10px;" @click="openNewEditor">
              <Icon name="plus" :size="14" />
              新建模型配置
            </button>
          </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 二级弹窗：编辑模型 -->
    <div v-if="visible && showEditor && editingProfile" class="settings-overlay" style="z-index:110;">
      <div class="settings-panel" style="width:600px; max-width:calc(100vw - 48px); height:auto;">
        <div class="settings-header">
          <div class="settings-title">
            <Icon name="edit" :size="17" />
            <span>{{ editingProfile.id ? '编辑模型' : '新建模型' }}</span>
          </div>
          <button class="settings-close" @click="closeEditor">
            <Icon name="x" :size="18" />
          </button>
        </div>

        <div class="settings-body">

          <div class="form-field">
            <label class="form-label">配置名称</label>
            <input v-model="editingProfile.name" class="form-input" type="text" placeholder="如：我的 DeepSeek" />
            <div v-if="editingError" class="form-error">{{ editingError }}</div>
          </div>
          
          <div class="form-field">
            <label class="form-label">Provider</label>
            <!-- 自定义下拉：替代原生 select，统一展开列表样式 -->
            <div class="app-select">
              <button type="button" class="app-select-trigger" @click="providerOpen = !providerOpen">
                <span>{{ providerLabel }}</span>
                <Icon name="chevron" :size="14" :class="['app-select-arrow', { open: providerOpen }]" />
              </button>
              <div v-if="providerOpen" class="app-select-dropdown">
                <button
                  v-for="p in providerList"
                  :key="p.key"
                  type="button"
                  :class="['app-select-option', { selected: editingProfile.provider === p.key }]"
                  @click="selectProvider(p.key)"
                >
                  <span>{{ p.label }}</span>
                  <Icon v-if="editingProfile.provider === p.key" name="check" :size="14" />
                </button>
              </div>
            </div>
            <div v-if="!providerSupportsSearch(editingProfile.provider)" class="form-hint">
              该供应商未适配联网搜索（当前支持 DeepSeek、豆包）；若用的是中转网关，可用下方「测试联网搜索」确认。
            </div>
            <div v-else-if="providerSearchMode(editingProfile.provider) === 'native'" class="form-hint">
              豆包使用方舟内置联网搜索，需在火山方舟控制台开通「豆包搜索」后才会返回引用。
            </div>
          </div>

          <div class="form-field">
            <div class="form-label-row">
              <label class="form-label">请求地址</label>
              <!-- 完整 URL：开启后输入的地址原样请求；关闭时自动追加 /chat/completions -->
              <button
                type="button"
                class="url-full-switch"
                role="switch"
                :aria-checked="editingProfile.appendPath === false"
                @click="editingProfile.appendPath = editingProfile.appendPath === false"
              >
                <span>完整 URL</span>
                <span :class="['toggle-switch', editingProfile.appendPath === false ? 'on' : '']"></span>
              </button>
            </div>
            <div class="url-input-box">
              <input
                v-model="editingProfile.baseUrl"
                class="url-input"
                type="text"
                :placeholder="
                  editingProfile.appendPath === false
                    ? 'https://api.example.com/v1/chat/completions'
                    : (settings.serverMode ? '留空则使用后端预设' : 'https://api.example.com/v1')
                "
              />
              <span
                v-if="editingProfile.appendPath === false"
                class="url-suffix"
                title="完整 URL 模式下请确保地址已包含该路径"
              >/chat/completions</span>
            </div>
            <div class="form-hint">
              {{ editingProfile.appendPath === false
                ? '直接请求填写的完整地址，请自行包含 /chat/completions'
                : '将自动在地址后拼接 /chat/completions' }}
            </div>
          </div>

          <div class="form-field">
            <label class="form-label">模型 ID</label>
            <input
              v-model="editingProfile.model"
              class="form-input"
              type="text"
              placeholder="输入模型名称（如 deepseek-flash）"
            />
          </div>

          <!-- API Key：代理模式存服务端数据库；直连模式存浏览器 -->
          <template v-if="settings.serverMode">
            <div class="form-field">
              <label class="form-label">API Key</label>
              <input
                v-model="editingApiKey"
                class="form-input"
                type="text"
                :placeholder="keyPlaceholder"
                autocomplete="off"
              />
              <div class="form-hint">{{ keyHint }}</div>
              <button
                v-if="editingKeySource === 'model'"
                type="button"
                class="btn btn-sm btn-secondary"
                style="margin-top:8px;"
                :disabled="keyBusy"
                @click="handleClearKey"
              >
                <Icon name="trash" :size="13" />
                清除该配置的 Key
              </button>
            </div>
          </template>

          <template v-if="!settings.serverMode">
            <div class="form-field">
              <label class="form-label">API Key</label>
              <input
                v-model="editingProfile.apiKey"
                class="form-input"
                type="password"
                placeholder="sk-..."
                autocomplete="off"
              />
              <div class="form-hint">仅保存在本地浏览器，不会上传</div>
            </div>
          </template>

          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-secondary" :disabled="testing" @click="handleTest">
              <Icon name="plug" :size="14" />
              {{ testing ? '测试中...' : '测试连接' }}
            </button>
            <button class="btn btn-secondary" :disabled="testingSearch" @click="handleTestSearch">
              <Icon name="globe" :size="14" />
              {{ testingSearch ? '搜索测试中...' : '测试联网搜索' }}
            </button>
            <span
              v-if="testResult"
              :style="{
                fontSize: '12px',
                color: testResult.ok ? '#10b981' : '#ef4444',
                display: 'flex', alignItems: 'center', gap: '4px'
              }"
            >
              <Icon :name="testResult.ok ? 'check' : 'x'" :size="12" />
              {{ testResult.msg }}
            </span>
            <span
              v-if="searchTestResult"
              :style="{
                fontSize: '12px',
                color: searchTestResult.ok ? '#10b981' : '#ef4444',
                display: 'flex', alignItems: 'center', gap: '4px'
              }"
            >
              <Icon :name="searchTestResult.ok ? 'check' : 'x'" :size="12" />
              {{ searchTestResult.msg }}
            </span>
          </div>

          <!-- 高级配置（模型级，默认折叠） -->
          <div class="settings-group" style="margin-top:20px; margin-bottom:0;">
            <div
              class="settings-group-title"
              style="cursor:pointer; user-select:none;"
              @click="showAdvanced = !showAdvanced"
            >
              <Icon
                name="chevron"
                :size="12"
                :style="{
                  verticalAlign: '-2px', marginRight: '4px', opacity: 0.7,
                  transform: showAdvanced ? 'none' : 'rotate(-90deg)',
                  transition: 'transform 0.2s'
                }"
              />
              高级配置
            </div>

            <template v-if="showAdvanced">
              <div class="form-row">
                <div class="form-field">
                  <label class="form-label">Temperature</label>
                  <input v-model.number="editingProfile.temperature" class="form-input" type="number" min="0" max="2" step="0.1" />
                  <div class="form-hint">0 更确定，2 更随机</div>
                </div>
                <div class="form-field">
                  <label class="form-label">Max Tokens</label>
                  <input v-model.number="editingProfile.maxTokens" class="form-input" type="number" min="0" placeholder="0 = 不限" />
                  <div class="form-hint">最大输出 token 数</div>
                </div>
              </div>

              <div class="form-field" style="margin-top:10px;">
                <label class="form-label">System Prompt</label>
                <textarea
                  v-model="editingProfile.systemPrompt"
                  class="form-input"
                  rows="3"
                  placeholder="设定 AI 的角色和行为..."
                  style="resize:vertical;"
                ></textarea>
              </div>
            </template>
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn btn-secondary" @click="closeEditor">取消</button>
          <button class="btn btn-primary" :disabled="keyBusy" @click="saveEditor">
            <Icon name="check" :size="14" />
            保存
          </button>
        </div>
      </div>
    </div>

    <!-- 删除配置确认 -->
    <div v-if="confirmDeleteId" class="confirm-overlay">
      <div class="confirm-panel">
        <div class="confirm-title">删除这个模型配置？</div>
        <div class="confirm-message">删除后无法恢复。如它是当前激活的，将自动切换到第一个可用配置。</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" @click="confirmDeleteId = null">取消</button>
          <button class="btn btn-danger" @click="handleDeleteProfile">删除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
