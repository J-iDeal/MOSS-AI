<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import ImagePreview from './ImagePreview.vue'
import { useSettings } from '../composables/useSettings'
import { chatCompletion, providerSupportsSearch, providerSearchMode, providerSupportsVision } from '../api/providers'
import { uploadFiles } from '../api/uploads'

const props = defineProps({
  disabled: Boolean,
  isLoading: Boolean,
  isStreaming: Boolean,
})
const emit = defineEmits(['send', 'stop'])

const { settings, getProviderConfig } = useSettings()

const text = ref('')
const textareaRef = ref(null)

// ==================== 附件（图片 / PDF） ====================
// 只保存服务端返回的元数据，文件本体走 /uploads 静态访问，不塞进聊天 JSON
const attachments = ref([])
const fileInputRef = ref(null)
const uploading = ref(false)
const attachError = ref('')
const dragging = ref(false)
const MAX_ATTACHMENTS = 4
const MAX_FILE_SIZE = 10 * 1024 * 1024

function isPdfAttachment(a) {
  return a?.kind === 'pdf' || a?.mime === 'application/pdf'
}

function isPdfFile(file) {
  return file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '')
}

// 图片附件（PDF 不需要视觉能力，只做文本提取）
const imageAttachments = computed(() => attachments.value.filter((a) => !isPdfAttachment(a)))

// 输入框内图片预览
const previewSrc = ref('')
const previewAlt = ref('')

// 输入框自适应高度的上限（与 globals.css 中 .input-textarea 的 max-height 保持一致）
const MAX_INPUT_HEIGHT = 200

// ==================== 提示词优化 ====================
// 用当前模型把输入框里的提示词改写得更清晰、可执行；优化后支持一键撤回
const OPTIMIZE_SYSTEM_PROMPT = `你是一名专业的提示词工程师。请把用户给出的提示词改写为更清晰、具体、可执行的版本：
1. 保留原始意图、语言和关键约束，不得虚构事实或改变需求；
2. 补充必要的背景、目标、输出格式与限制条件；
3. 结构清晰，可直接发给 AI 使用；
4. 只输出优化后的提示词本身，不要添加解释、前缀后缀、引号或 Markdown 代码块。`

const optimizing = ref(false)
const optimizeError = ref('')
// { before, after }：撤回时恢复 before；用户手动改动后 after 不再匹配，撤回入口自动隐藏
const undoState = ref(null)

const canUndo = computed(() => !!undoState.value && text.value === undoState.value.after)

const optimizeTitle = computed(() => {
  if (optimizing.value) return '正在优化提示词…'
  if (canUndo.value) return '已优化，可点击左侧「撤回优化」恢复原文'
  return '用当前模型优化输入框中的提示词'
})

// 去掉模型可能附带的代码块围栏与包裹引号，只保留提示词正文
function cleanOptimized(raw) {
  let out = String(raw || '').trim()
  out = out.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  out = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim()
  return out
}

async function optimizePrompt() {
  const source = text.value.trim()
  if (!source || props.disabled || props.isLoading || optimizing.value) return

  optimizing.value = true
  optimizeError.value = ''
  try {
    const result = await chatCompletion({
      ...getProviderConfig(),
      stream: false,
      temperature: 0.4,
      messages: [
        { role: 'system', content: OPTIMIZE_SYSTEM_PROMPT },
        { role: 'user', content: source },
      ],
    })
    const optimized = cleanOptimized(result)
    if (!optimized) throw new Error('优化结果为空，请重试')
    if (optimized === source) {
      optimizeError.value = '这段提示词已经足够清晰'
      return
    }
    undoState.value = { before: source, after: optimized }
    text.value = optimized
    nextTick(() => {
      autoResize()
      textareaRef.value?.focus()
    })
  } catch (e) {
    optimizeError.value = e?.message || '优化失败，请稍后重试'
  } finally {
    optimizing.value = false
  }
}

function undoOptimize() {
  if (!canUndo.value) return
  text.value = undoState.value.before
  undoState.value = null
  nextTick(() => {
    autoResize()
    textareaRef.value?.focus()
  })
}

// 当前供应商是否支持联网搜索：不支持时开关置灰，避免开启后静默无搜索
const searchSupported = computed(() => providerSupportsSearch(settings.provider))

// 当前模型能否直接看图；不能时附件会走 OCR 文本兜底
const visionSupported = computed(() => providerSupportsVision(settings.provider, settings.model))

const attachTitle = computed(() => {
  if (uploading.value) return '正在上传文件…'
  if (!visionSupported.value) return '添加图片或 PDF（当前模型不支持识图，图片将用 OCR 提取文字，准确率有限；PDF 直接提取文本）'
  return `添加图片或 PDF：最多 ${MAX_ATTACHMENTS} 个，单个不超过 10MB`
})

const webSearchTitle = computed(() => {
  if (!searchSupported.value) {
    return '当前供应商未适配联网搜索（支持 DeepSeek、豆包），可在 模型设置 中测试搜索接口'
  }
  if (providerSearchMode(settings.provider) === 'native') {
    return settings.webSearch
      ? '关闭联网搜索'
      : '开启联网搜索：由豆包内置搜索完成（需在火山方舟控制台开通「豆包搜索」）'
  }
  return settings.webSearch
    ? '关闭联网搜索'
    : '开启联网搜索：模型将自主检索实时信息并标注来源'
})

// 切换到不支持的供应商时自动关闭，避免带着无效开关发送
watch(searchSupported, (ok) => {
  if (!ok && settings.webSearch) settings.webSearch = false
}, { immediate: true })

// 联网搜索开关（持久化在 settings 中，影响下一次及后续发送）
function toggleWebSearch() {
  if (!searchSupported.value) return
  settings.webSearch = !settings.webSearch
  // 与多版本回答互斥，避免一次提问并发过多请求
  if (settings.webSearch) settings.branchMode = false
}

// 多版本回答：开启后每次提问并发生成多个回答，并列展示对比
const branchTitle = computed(() => {
  if (settings.webSearch) return '联网搜索开启时不支持多版本回答，请先关闭联网搜索'
  return settings.branchMode
    ? `多版本回答已开启（每次生成 ${settings.branchCount} 个），点击调整`
    : '多版本回答：每次提问同时生成多个回答，并列对比（与联网搜索互斥）'
})

// 单一控件：主按钮显示当前状态，点击展开数量菜单（关闭 / 2 / 3 / 4 个回答）
const branchMenuOpen = ref(false)

function toggleBranchMenu() {
  if (settings.webSearch) return
  branchMenuOpen.value = !branchMenuOpen.value
}

function selectBranch(count) {
  if (count === 0) {
    settings.branchMode = false
  } else {
    settings.branchMode = true
    settings.branchCount = count
  }
  branchMenuOpen.value = false
}

function closeBranchMenu() { branchMenuOpen.value = false }

// ==================== 图片附件 ====================
// 上传前压缩：长边限制 1568、JPEG 0.85，控制视觉 token 与带宽
async function compressImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file
  if (file.size <= 400 * 1024) return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    // JPEG 不支持透明，先铺白底，避免 PNG 透明区域变黑
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    const name = (file.name || 'image').replace(/\.\w+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    // 压缩失败不阻断上传，直接用原图
    return file
  }
}

async function addFiles(files) {
  if (props.disabled || props.isLoading || optimizing.value || uploading.value) return
  if (!files.length) return

  const room = MAX_ATTACHMENTS - attachments.value.length
  if (room <= 0) {
    attachError.value = `一次最多添加 ${MAX_ATTACHMENTS} 个文件`
    return
  }

  const accepted = []
  for (const file of files) {
    if (!isPdfFile(file) && !file.type.startsWith('image/')) {
      attachError.value = '仅支持图片或 PDF 文件'
      continue
    }
    if (file.size > MAX_FILE_SIZE) {
      attachError.value = '单个文件不能超过 10MB'
      continue
    }
    accepted.push(file)
  }
  const batch = accepted.slice(0, room)
  if (accepted.length > room) attachError.value = `一次最多添加 ${MAX_ATTACHMENTS} 个文件`
  if (!batch.length) return

  attachError.value = ''
  uploading.value = true
  try {
    const compressed = await Promise.all(batch.map((file) => compressImage(file)))
    const uploaded = await uploadFiles(compressed)
    attachments.value.push(...uploaded)
  } catch (e) {
    attachError.value = e.message || '文件上传失败，请重试'
  } finally {
    uploading.value = false
  }
}

function pickFiles() {
  if (props.disabled || props.isLoading || uploading.value) return
  fileInputRef.value?.click()
}

function handleFileChange(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  addFiles(files)
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter((a) => a.id !== id)
  attachError.value = ''
}

function openAttachment(a) {
  if (!a?.url) return
  // PDF 没有内联预览，直接新窗口打开原文
  if (isPdfAttachment(a)) {
    window.open(a.url, '_blank', 'noopener')
    return
  }
  previewSrc.value = a.url
  previewAlt.value = a.name || '图片'
}

function closeImagePreview() {
  previewSrc.value = ''
  previewAlt.value = ''
}

function handlePaste(e) {
  const files = Array.from(e.clipboardData?.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  if (!files.length) return
  e.preventDefault()
  addFiles(files)
}

function onDragOver(e) {
  if (props.disabled || props.isLoading) return
  e.preventDefault()
  dragging.value = true
}

function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dragging.value = false
}

function onDrop(e) {
  dragging.value = false
  // 必须阻止默认行为，否则浏览器会直接打开拖入的 PDF 等文件
  e.preventDefault()
  if (props.disabled || props.isLoading) return
  addFiles(Array.from(e.dataTransfer?.files || []))
}

function onDocClick(e) {
  if (!branchMenuOpen.value) return
  if (!e.target.closest?.('.branch-control')) closeBranchMenu()
}

function onKeydown(e) {
  if (e.key === 'Escape' && branchMenuOpen.value) {
    e.preventDefault()
    closeBranchMenu()
  }
}

// 页面加载后自动对焦输入框
onMounted(() => {
  textareaRef.value?.focus()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})

// 暴露给父组件：新建/切换对话后主动对焦
function focus() {
  nextTick(() => textareaRef.value?.focus())
}
defineExpose({ focus })

// 生成期间输入框被禁用会自动失焦，生成结束后恢复焦点，避免用户每次都需重新点击
function isFocusInEditable() {
  const el = document.activeElement
  if (!el || el === document.body) return false
  if (el === textareaRef.value) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

watch(
  () => props.isLoading,
  (loading) => {
    if (loading) return
    nextTick(() => {
      // 用户已切到其他输入控件（如侧栏重命名、设置项）时不抢占焦点
      if (!isFocusInEditable()) textareaRef.value?.focus()
    })
  }
)

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  // 先按内容算出真实高度，再钳制到上限；超过上限时由 CSS 的 overflow-y 显示滚动条
  el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px'
}

watch(text, () => {
  autoResize()
  // 用户重新编辑后隐藏上一次的优化错误提示
  if (optimizeError.value) optimizeError.value = ''
})

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const value = text.value.trim()
  if ((!value && !attachments.value.length) || props.disabled || props.isLoading || optimizing.value || uploading.value) return
  emit('send', { text: value, attachments: attachments.value.slice() })
  text.value = ''
  attachments.value = []
  attachError.value = ''
  undoState.value = null
  nextTick(autoResize)
}

function handleStop() { emit('stop') }
</script>

<template>
  <div class="input-area">
    <div class="input-wrapper">
      <div
        class="input-box"
        :class="{ dragging }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <input
          ref="fileInputRef"
          class="attachment-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf"
          multiple
          @change="handleFileChange"
        />
        <textarea
          ref="textareaRef"
          v-model="text"
          class="input-textarea"
          :placeholder="
            optimizing
              ? '正在优化提示词...'
              : isLoading
                ? 'AI 正在生成...'
                : '发送消息，Enter 发送，Shift+Enter 换行；可粘贴或拖入图片、PDF'"
          :disabled="isLoading || optimizing"
          rows="1"
          @keydown="handleKeydown"
          @paste="handlePaste"
        ></textarea>
        <div v-if="attachments.length || attachError" class="input-attachments">
          <div v-for="a in attachments" :key="a.id" class="attachment-chip">
            <button
              v-if="!isPdfAttachment(a)"
              class="attachment-thumb"
              type="button"
              :title="`预览 ${a.name || '图片'}`"
              @click="openAttachment(a)"
            >
              <img :src="a.url" :alt="a.name || '图片'" />
            </button>
            <button
              v-else
              class="attachment-thumb attachment-doc"
              type="button"
              :title="`打开 ${a.name || 'PDF'}`"
              @click="openAttachment(a)"
            >
              <Icon name="file" :size="18" />
            </button>
            <span class="attachment-name" :title="a.name">{{ a.name || (isPdfAttachment(a) ? 'PDF' : '图片') }}</span>
            <button
              class="attachment-remove"
              type="button"
              title="移除该附件"
              @click="removeAttachment(a.id)"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>
          <div v-if="attachError" class="attachment-error" :title="attachError">{{ attachError }}</div>
        </div>
        <div v-if="imageAttachments.length && !visionSupported" class="vision-warning">
          当前模型不支持识图，图片只能 OCR 提取文字（准确率有限）；PDF 仍会正常提取文本。切换到支持视觉的模型（如 deepseek-flash）可直接理解图片。
        </div>
        <button
          class="prompt-optimize-btn"
          :class="{ active: canUndo }"
          :disabled="!text.trim() || disabled || isLoading || optimizing"
          :title="optimizeTitle"
          aria-label="优化提示词"
          @click="optimizePrompt"
        >
          <Icon name="sparkles" :size="16" :class="{ 'spin-icon': optimizing }" />
        </button>
        <div class="input-footer">
          <div class="input-footer-left">
            <button
              class="web-search-toggle attach-toggle"
              :class="{ active: attachments.length > 0 }"
              :disabled="disabled || isLoading || optimizing || uploading"
              :title="attachTitle"
              @click="pickFiles"
            >
              <Icon name="image" :size="16" />
              <span>{{ uploading ? '上传中…' : (attachments.length ? `附件 ×${attachments.length}` : '图片 / PDF') }}</span>
            </button>
            <button
              v-if="canUndo"
              class="undo-optimize-btn"
              title="恢复优化前的提示词"
              @click="undoOptimize"
            >
              <Icon name="undo" :size="13" />
              <span>撤回优化</span>
            </button>
            <button
              class="web-search-toggle"
              :class="{ active: settings.webSearch }"
              :disabled="!searchSupported"
              @click="toggleWebSearch"
              :title="webSearchTitle"
            >
              <Icon name="globe" :size="16" />
              <span>联网搜索</span>
            </button>
            <div class="branch-control">
              <button
                class="web-search-toggle branch-toggle"
                :class="{ active: settings.branchMode }"
                :disabled="settings.webSearch"
                @click="toggleBranchMenu"
                :title="branchTitle"
              >
                <Icon name="columns" :size="16" />
                <span>多版本<template v-if="settings.branchMode"> ×{{ settings.branchCount }}</template></span>
                <Icon name="chevron" :size="12" class="branch-caret" />
              </button>
              <div v-if="branchMenuOpen" class="branch-menu">
                <button
                  class="branch-menu-item"
                  :class="{ selected: !settings.branchMode }"
                  @click="selectBranch(0)"
                >关闭</button>
                <button
                  v-for="n in [2, 3, 4]"
                  :key="n"
                  class="branch-menu-item"
                  :class="{ selected: settings.branchMode && Number(settings.branchCount) === n }"
                  @click="selectBranch(n)"
                >
                  <span>{{ n }} 个回答</span>
                  <Icon
                    v-if="settings.branchMode && Number(settings.branchCount) === n"
                    name="check"
                    :size="13"
                  />
                </button>
              </div>
            </div>
            <div v-if="optimizeError" class="optimize-error" :title="optimizeError">
              {{ optimizeError }}
            </div>
            <div v-else class="input-hint">
              <span v-if="attachments.length">已选 {{ attachments.length }} 个附件 · </span>{{ text.length }} 字符 · {{ isStreaming ? '流式输出中' : '就绪' }}
            </div>
          </div>
          <button
            v-if="isLoading"
            class="stop-btn"
            @click="handleStop"
            title="停止生成"
          >
            <Icon name="stop" :size="12" />
          </button>
          <button
            v-else
            class="send-btn"
            :disabled="(!text.trim() && !attachments.length) || disabled || optimizing || uploading"
            @click="handleSend"
            title="发送"
          >
            <Icon name="send" :size="16" />
          </button>
        </div>
      </div>
    </div>
    <ImagePreview
      :visible="!!previewSrc"
      :src="previewSrc"
      :alt="previewAlt"
      @close="closeImagePreview"
    />
  </div>
</template>
