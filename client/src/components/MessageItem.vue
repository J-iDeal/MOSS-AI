<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { parseMarkdown, escapeHtml } from '../utils/markdown'
import { copyText } from '../utils/clipboard'
import ConfirmDialog from './ConfirmDialog.vue'
import ImagePreview from './ImagePreview.vue'
import { useTheme } from '../composables/useTheme'
import avatarLight from '../assets/openai-light.png'
import avatarDark from '../assets/openai-dark.png'

const { isDark } = useTheme()
// 根据当前主题切换助手头像（浅色/深色两套图）
const assistantAvatar = computed(() => (isDark.value ? avatarDark : avatarLight))

const props = defineProps({
  message: { type: Object, required: true },
  isStreaming: Boolean,
  modelName: String,
})
const emit = defineEmits(['regenerate', 'delete', 'retry', 'edit'])

const copied = ref(false)
const showConfirm = ref(false)
const sourcesExpanded = ref(false)
function toggleSources() { sourcesExpanded.value = !sourcesExpanded.value }

// ==================== 附件预览 ====================
const previewSrc = ref('')
const previewAlt = ref('')
function isPdfAttachment(a) {
  return a?.kind === 'pdf' || a?.mime === 'application/pdf'
}
function openImagePreview(a) {
  if (!a?.url) return
  previewSrc.value = a.url
  previewAlt.value = a.name || '图片'
}
// PDF 没有内联预览，直接新窗口打开原文
function openAttachment(a) {
  if (!a?.url) return
  if (isPdfAttachment(a)) {
    window.open(a.url, '_blank', 'noopener')
    return
  }
  openImagePreview(a)
}
function closeImagePreview() {
  previewSrc.value = ''
  previewAlt.value = ''
}

// ==================== 编辑用户消息 ====================
const editing = ref(false)
const editText = ref('')
function startEdit() {
  editText.value = props.message.content || ''
  editing.value = true
}
function cancelEdit() { editing.value = false }
function submitEdit() {
  const text = editText.value.trim()
  if (!text) return
  editing.value = false
  emit('edit', text)
}

// token 用量展示（仅助手消息且后端返回了 usage 时）
const usageText = computed(() => {
  const u = props.message.usage
  if (!u || !u.total) return ''
  return `${Number(u.total).toLocaleString()} tokens`
})

// 搜索中状态：仅在流式生成中且消息标记了 searching 时展示（刷新后 isStreaming 为 false，不会残留）
const showSearching = computed(
  () => props.isStreaming && props.message.role === 'assistant' && !!props.message.searching
)

// 从 url 提取显示用域名
function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || ''
  }
}

// ==================== 打字机效果 ====================
// 流式内容不直接整块渲染，而是按节奏逐字吐字，模拟豆包的平滑打字感
const displayed = ref(props.message.content || '')
let typeTimer = null

const CARET = '<span class="stream-caret"></span>'

function stopTypeTimer() {
  if (typeTimer) {
    clearTimeout(typeTimer)
    typeTimer = null
  }
}

function typeStep() {
  typeTimer = null
  const target = props.message.content || ''
  // 内容被替换（如重新生成）时直接对齐，避免回到旧文本
  if (displayed.value.length > target.length) displayed.value = target

  const backlog = target.length - displayed.value.length
  if (backlog > 0) {
    // 自适应速度：积压越多单帧吐字越多，保证既不卡顿也不落后
    const perTick = props.isStreaming
      ? Math.max(1, Math.ceil(backlog / 8))
      : Math.max(4, Math.ceil(backlog / 2))
    displayed.value = target.slice(0, displayed.value.length + perTick)
    typeTimer = setTimeout(typeStep, props.isStreaming ? 16 : 8)
    return
  }
  // 已追平：仍在流式则低速轮询等待新内容
  if (props.isStreaming) typeTimer = setTimeout(typeStep, 40)
}

function isStreamingNow() {
  return props.isStreaming && props.message.role === 'assistant' && !displayed.value
}

async function handleCopy() {
  const text = isBranch.value
    ? props.message.variants
        .map((v, i) => `【回答 ${i + 1}】\n${v.content || ''}`)
        .join('\n\n')
    : props.message.content
  const ok = await copyText(text)
  if (!ok) return
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// ==================== 多版本回答 ====================
const isBranch = computed(
  () => Array.isArray(props.message.variants) && props.message.variants.length > 0
)
function renderVariant(text) {
  return parseMarkdown(text || '', { autoHighlight: !props.isStreaming })
}
function variantUsage(v) {
  return v?.usage?.total ? `${Number(v.usage.total).toLocaleString()} tokens` : ''
}

// 代码块复制：通过事件委托处理 v-html 注入的按钮（CSP 友好，无内联 onclick）
async function onContentClick(e) {
  const btn = e.target.closest('.code-block-copy')
  if (!btn) return
  const pre = btn.closest('.code-block')?.querySelector('pre')
  if (!pre) return
  const original = btn.dataset.label || btn.textContent
  btn.dataset.label = original
  const ok = await copyText(pre.textContent)
  btn.textContent = ok ? '已复制' : '复制失败'
  setTimeout(() => { btn.textContent = original }, 1500)
}

function handleDeleteClick() { showConfirm.value = true }
function handleConfirmDelete() {
  showConfirm.value = false
  emit('delete')
}

// 渲染结果用 rAF 合并：打字机/流式一帧内可能多次变更，合并为每帧最多一次解析 + 写 DOM，
// 避免长消息时每帧重复解析整篇文本造成的额外开销
const rendered = ref(computeRendered())
let rafId = null

function computeRendered() {
  const raw = displayed.value
  if (props.message.role !== 'assistant') return renderPlainText(raw)
  // 流式中关闭自动语言检测，避免逐字重渲染时高亮开销过大
  const html = parseMarkdown(raw, { autoHighlight: !props.isStreaming })
  return props.isStreaming ? attachCaret(html) : html
}

function scheduleRender() {
  if (rafId != null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    rendered.value = computeRendered()
  })
}

watch(displayed, scheduleRender)
watch(() => props.isStreaming, scheduleRender)
watch(() => props.message.content, scheduleRender)

// 把光标插到最后一个块级元素内部，让其紧跟文字末尾
function attachCaret(html) {
  const m = html.match(/<\/(p|li|h[1-6]|td|th)>$/)
  if (m) return html.slice(0, -m[0].length) + CARET + m[0]
  return html ? html + CARET : CARET
}

// 用户消息/流式纯文本：统一走 markdown 工具的转义，再把换行转 <br>
function renderPlainText(text) {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

// 流式开始：启动打字机；流式结束：快速补齐剩余内容
watch(
  () => props.isStreaming,
  (streaming) => {
    if (streaming) {
      if (!typeTimer) typeTimer = setTimeout(typeStep, 16)
    } else {
      stopTypeTimer()
      if (displayed.value !== (props.message.content || '')) {
        typeTimer = setTimeout(typeStep, 0)
      }
    }
  },
  { immediate: true }
)

// 非流式内容变化（历史消息/重新生成）直接同步展示
watch(
  () => props.message.content,
  (val) => {
    if (!props.isStreaming && displayed.value !== (val || '')) {
      displayed.value = val || ''
    }
  }
)

// Esc：关闭消息删除确认弹窗
function onKeydown(e) {
  if (e.key === 'Escape' && showConfirm.value) {
    e.preventDefault()
    showConfirm.value = false
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  stopTypeTimer()
  if (rafId != null) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div :class="['message', message.role, { error: message.error }]">
    <div :class="['message-avatar', message.role]">
      <img v-if="message.role === 'assistant'" :src="assistantAvatar" class="avatar-img" alt="AI" />
      <Icon v-else name="user" :size="16" />
    </div>

    <div class="message-content">
      <div class="message-role">
        {{ message.role === 'user' ? '你' : (modelName || 'AI 助手') }}
        <span v-if="usageText" class="message-usage">{{ usageText }}</span>
      </div>

      <!-- 用户上传的附件：图片显示缩略图，PDF 显示文件卡片 -->
      <div v-if="message.attachments && message.attachments.length" class="message-attachments">
        <template v-for="a in message.attachments" :key="a.id">
          <button
            v-if="isPdfAttachment(a)"
            type="button"
            class="message-doc"
            :title="`打开 ${a.name || 'PDF'}`"
            @click="openAttachment(a)"
          >
            <Icon name="file" :size="16" />
            <span>{{ a.name || 'PDF' }}</span>
          </button>
          <button
            v-else
            type="button"
            class="message-image"
            :title="a.name || '查看大图'"
            @click="openAttachment(a)"
          >
            <img :src="a.url" :alt="a.name || '图片'" loading="lazy" />
          </button>
        </template>
      </div>

      <!-- 编辑用户消息：就地修改后保存并重发 -->
      <div v-if="editing" class="message-edit">
        <textarea v-model="editText" class="message-edit-input" rows="3"></textarea>
        <div class="message-edit-actions">
          <button class="btn btn-sm btn-primary" @click="submitEdit">保存并重发</button>
          <button class="btn btn-sm btn-secondary" @click="cancelEdit">取消</button>
        </div>
      </div>

      <div v-else-if="isBranch" class="message-variants">
        <div
          v-for="(v, i) in message.variants"
          :key="i"
          :class="['variant-column', { 'has-error': v.error }]"
        >
          <div class="variant-head">
            <span class="variant-label">回答 {{ i + 1 }}</span>
            <span v-if="variantUsage(v)" class="variant-usage">{{ variantUsage(v) }}</span>
          </div>
          <div v-if="!v.content && !v.error" class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </div>
          <div v-else class="variant-body" v-html="renderVariant(v.content)" @click="onContentClick"></div>
        </div>
      </div>

      <div v-else-if="showSearching" class="searching-indicator">
        <Icon name="search" :size="14" class="searching-icon" />
        <span class="searching-text">正在搜索：{{ message.searchQuery || '…' }}</span>
      </div>

      <div v-else-if="isStreamingNow()" class="typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>

      <div v-else-if="displayed || message.role !== 'user'" class="message-text" v-html="rendered" @click="onContentClick"></div>

      <div
        v-if="message.role === 'assistant' && message.sources && message.sources.length"
        class="message-sources"
      >
        <button class="sources-toggle" @click="toggleSources">
          <Icon name="search" :size="12" />
          <span>参考来源 {{ message.sources.length }}</span>
          <Icon name="chevron" :size="12" class="sources-chevron" :class="{ open: sourcesExpanded }" />
        </button>
        <div v-show="sourcesExpanded" class="sources-list">
          <a
            v-for="(s, i) in message.sources"
            :key="s.url || i"
            :href="s.url"
            target="_blank"
            rel="noopener noreferrer"
            class="source-row"
            :title="s.title || s.url"
          >
            <span class="source-index">{{ i + 1 }}</span>
            <span class="source-title">{{ s.title || s.url }}</span>
            <span class="source-site">{{ s.site_name || hostname(s.url) }}</span>
          </a>
        </div>
      </div>

      <div class="message-actions">
        <button class="message-action-btn" @click="handleCopy">
          <Icon :name="copied ? 'check' : 'copy'" :size="13" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <button
          v-if="message.role === 'assistant' && message.error"
          class="message-action-btn retry"
          @click="emit('retry')"
        >
          <Icon name="refresh" :size="13" />
          <span>重试</span>
        </button>
        <button
          v-else-if="message.role === 'assistant'"
          class="message-action-btn"
          @click="emit('regenerate')"
        >
          <Icon name="refresh" :size="13" />
          <span>重新生成</span>
        </button>
        <button
          v-if="message.role === 'user'"
          class="message-action-btn"
          @click="startEdit"
        >
          <Icon name="edit" :size="13" />
          <span>编辑</span>
        </button>
        <button class="message-action-btn" @click="handleDeleteClick">
          <Icon name="trash" :size="13" />
          <span>删除</span>
        </button>
      </div>
    </div>

    <ConfirmDialog
      :visible="showConfirm"
      title="删除这条消息？"
      message="此操作不可撤销。"
      confirm-text="删除"
      danger
      @confirm="handleConfirmDelete"
      @cancel="showConfirm = false"
    />

    <ImagePreview
      :visible="!!previewSrc"
      :src="previewSrc"
      :alt="previewAlt"
      @close="closeImagePreview"
    />
  </div>
</template>
