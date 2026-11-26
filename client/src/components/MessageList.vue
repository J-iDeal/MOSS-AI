<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUpdate, onBeforeUnmount } from 'vue'
import MessageItem from './MessageItem.vue'
import Icon from './Icon.vue'
import { useSettings } from '../composables/useSettings'
import { useModels } from '../composables/useModels'
import brandLogo from '../assets/openai.svg'

const props = defineProps({
  messages: { type: Array, default: () => [] },
  isLoading: Boolean,
  currentModel: String,
  conversationTitle: String,
})
const emit = defineEmits(['regenerate', 'delete', 'retry', 'edit'])

const { isConfigured } = useSettings()
const { activeProfile } = useModels()
const containerRef = ref(null)

// 会话累计 token 用量（仅统计后端返回了 usage 的消息）
const totalTokens = computed(() =>
  props.messages.reduce((sum, m) => sum + (Number(m.usage?.total) || 0), 0)
)

// ==================== 消息导航点 ====================
const msgEls = ref([])
const activeMsgIndex = ref(0)

onBeforeUpdate(() => { msgEls.value = [] })
function setMsgRef(el, i) {
  // 组件 ref 拿到的是组件实例，需取 $el 得到真实 DOM 才能滚动定位
  const dom = el?.$el || el
  if (dom) msgEls.value[i] = dom
}

// ==================== 底部跟随滚动 ====================
const BOTTOM_THRESHOLD = 56
const stickToBottom = ref(true)
const wrapperRef = ref(null)
let resizeObserver = null
let lastScrollTop = 0

function onScroll() {
  const container = containerRef.value
  if (!container) return
  const containerTop = container.getBoundingClientRect().top
  let idx = 0
  msgEls.value.forEach((el, i) => {
    if (el && el.getBoundingClientRect().top - containerTop <= 100) idx = i
  })
  activeMsgIndex.value = idx

  // 注意：流式输出会让内容变高，此时 scroll 事件先于 ResizeObserver 触发，
  // 若按“离底距离”判断会把代码块这类大幅增高误判成用户上滑。
  // 因此只做两件事：贴底则恢复跟随；只有用户主动向上滚（scrollTop 变小）才停止跟随。
  const top = container.scrollTop
  const atBottom = container.scrollHeight - top - container.clientHeight <= BOTTOM_THRESHOLD
  if (atBottom) stickToBottom.value = true
  else if (top < lastScrollTop - 2) stickToBottom.value = false
  lastScrollTop = top
}

// 滚轮向上即视为用户想查看历史，立即停止跟随
function onWheel(e) {
  if (e.deltaY < 0) stickToBottom.value = false
}

function scrollToMsg(i) {
  const el = msgEls.value[i]
  if (!el) return
  stickToBottom.value = false
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeMsgIndex.value = i
}

// 只为用户消息生成导航项（保留原始消息索引用于定位/高亮）
const userNav = computed(() =>
  props.messages
    .map((m, i) => ({
      m,
      i,
      text: (m.content || '').replace(/\s+/g, ' ').trim() || '（空消息）',
    }))
    .filter((x) => x.m.role === 'user')
)

watch(
  () => props.messages.length,
  (len, oldLen) => {
    // 新消息（发送/开始生成）时强制回到底部跟随；删除消息则保持当前阅读位置
    if (len > oldLen) stickToBottom.value = true
    nextTick(scrollToBottom)
  }
)

// 内容高度变化（流式打字机逐字输出）时，只要用户仍在底部就持续贴底
watch(
  wrapperRef,
  (el) => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!el) return
    resizeObserver = new ResizeObserver(() => {
      if (stickToBottom.value) scrollToBottom()
    })
    resizeObserver.observe(el)
  },
  { flush: 'post' }
)

onMounted(() => nextTick(scrollToBottom))
onBeforeUnmount(() => resizeObserver?.disconnect())

// 切换对话时回到底部
watch(
  () => props.messages,
  () => {
    stickToBottom.value = true
    lastScrollTop = 0
    nextTick(scrollToBottom)
  }
)

function scrollToBottom() {
  const el = containerRef.value
  if (!el || !stickToBottom.value) return
  el.scrollTop = el.scrollHeight
  lastScrollTop = el.scrollTop
}

// 用户上滑后显示的「回到底部」按钮
function backToBottom() {
  const el = containerRef.value
  if (!el) return
  stickToBottom.value = true
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}
</script>

<template>
  <!-- 空对话：欢迎页 -->
  <template v-if="messages.length === 0">
    <div class="chat-header">
      <div class="header-left">
        <span class="chat-header-title">MOSS-AI</span>
      </div>
      <div class="header-right">
        <div class="status-indicator inline">
          <span :class="['status-dot', isConfigured ? '' : 'mock']"></span>
          <span v-if="isConfigured">已连接 · {{ activeProfile?.name || activeProfile?.provider }}</span>
          <span v-else>未配置</span>
        </div>
      </div>
    </div>

    <div class="messages-container" ref="containerRef">
      <div class="welcome-screen">
        <div class="welcome-logo">
          <img :src="brandLogo" alt="MOSS-AI" />
        </div>
        <div class="welcome-title">你好，有什么可以帮你？</div>
      </div>
    </div>
  </template>

  <!-- 有消息：对话列表 -->
  <template v-else>
  <div class="message-list">
    <div class="chat-header">
      <div class="header-left">
        <span class="chat-header-title">{{ conversationTitle || 'MOSS-AI' }}</span>
        <span v-if="totalTokens" class="chat-header-usage" title="本对话累计消耗 tokens">
          {{ totalTokens.toLocaleString() }} tokens
        </span>
      </div>
      <div class="header-right">
        <div class="status-indicator inline">
          <span :class="['status-dot', isConfigured ? '' : 'mock']"></span>
          <span v-if="isConfigured">已连接 · {{ activeProfile?.name || activeProfile?.provider }}</span>
          <span v-else>未配置</span>
        </div>
      </div>
    </div>

    <div class="messages-container" ref="containerRef" @scroll="onScroll" @wheel.passive="onWheel">
      <div class="messages-wrapper" ref="wrapperRef">
        <MessageItem
          v-for="(msg, i) in messages"
          :key="msg.id"
          :ref="(el) => setMsgRef(el, i)"
          :message="msg"
          :model-name="currentModel"
          :is-streaming="isLoading && messages[messages.length - 1]?.id === msg.id && msg.role === 'assistant'"
          @regenerate="emit('regenerate')"
          @retry="emit('retry', msg)"
          @edit="(text) => emit('edit', msg, text)"
          @delete="emit('delete', msg)"
        />
      </div>
    </div>

    <!-- 回到底部：用户上滑浏览历史时出现 -->
    <button
      v-if="!stickToBottom"
      class="scroll-bottom-btn"
      type="button"
      title="回到底部"
      aria-label="回到底部"
      @click="backToBottom"
    >
      <Icon name="chevron" :size="18" />
    </button>

    <!-- 右侧消息导航：仅用户消息；默认短横线，悬停展开摘要面板 -->
    <nav v-if="messages.length >= 2 && userNav.length > 0" class="msg-nav">
      <div class="msg-nav-lines">
        <span
          v-for="item in userNav"
          :key="item.m.id"
          :class="['msg-nav-line', { active: item.i === activeMsgIndex }]"
          @click="scrollToMsg(item.i)"
        ></span>
      </div>
      <div class="msg-nav-panel">
        <div
          v-for="item in userNav"
          :key="item.m.id"
          :class="['msg-nav-item', { active: item.i === activeMsgIndex }]"
          @click="scrollToMsg(item.i)"
        >
          <span class="msg-nav-item-text">{{ item.text }}</span>
          <span :class="['msg-nav-line', { active: item.i === activeMsgIndex }]"></span>
        </div>
      </div>
    </nav>
  </div>
  </template>
</template>
