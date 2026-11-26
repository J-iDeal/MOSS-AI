/**
 * 对话管理 composable v2
 * 多会话、消息历史、流式响应、分组管理
 * 后端 SQLite 为持久化数据源，localStorage 仅作离线缓存
 */
import { ref, computed } from 'vue'
import { chatCompletion, chatCompletionWithTools, webSearch, SEARCH_TOOL, providerSearchMode, providerSupportsVision } from '../api/providers'
import { ocrImage, extractPdfText } from '../api/uploads'
import * as conversationApi from '../api/conversations'
import { useSettings } from './useSettings'

const CONV_STORAGE_KEY = 'ai-chat-conversations'
const GROUP_STORAGE_KEY = 'ai-chat-groups'
const DIRECT_MODE = import.meta.env.VITE_DIRECT_MODE === 'true'

/** 附件是否为 PDF（PDF 不做视觉处理，只提取文本层） */
function isPdfAttachment(a) {
  return a?.kind === 'pdf' || a?.mime === 'application/pdf'
}

// ==================== 本地缓存 ====================
function loadConversations() {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch { return [] }
}
function saveConversations(convs) {
  try { localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(convs)) } catch {}
}
function loadGroups() {
  try {
    const raw = localStorage.getItem(GROUP_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return [
    { id: 'default', name: '全部对话', builtin: true, collapsed: false },
  ]
}
function saveGroups(groups) {
  try { localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups)) } catch {}
}

const conversations = ref(loadConversations())
const groups = ref(loadGroups())
const currentId = ref(null)

// 先提供本地会话保证 UI 可用；后端初始化成功后会以后端数据替换
if (conversations.value.length === 0) {
  const first = createConversation()
  conversations.value.push(first)
  currentId.value = first.id
  saveConversations(conversations.value)
} else {
  currentId.value = conversations.value[0].id
}

function createConversation(groupId = 'default') {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: '新对话',
    groupId,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }
}

function genGroupId() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function normalizeMessage(message) {
  const normalized = {
    id: message.id,
    role: message.role,
    content: message.content || '',
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
  }
  if (Array.isArray(message.attachments) && message.attachments.length) {
    normalized.attachments = message.attachments
  }
  if (message.role === 'assistant') {
    normalized.sources = Array.isArray(message.sources) ? message.sources : []
    normalized.searching = !!message.searching
    normalized.searchQuery = message.searchQuery || ''
    normalized.error = !!message.error
    if (message.usage) normalized.usage = message.usage
    if (Array.isArray(message.variants) && message.variants.length) {
      normalized.variants = message.variants
    }
  }
  return normalized
}

function normalizeConversation(raw, messages = []) {
  const normalized = {
    id: raw.id,
    title: raw.title || '新对话',
    groupId: raw.groupId || raw.group_id || 'default',
    pinned: !!raw.pinned,
    createdAt: raw.createdAt ?? raw.created_at ?? Date.now(),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? Date.now(),
    messages: messages.map(normalizeMessage),
  }
  const pinOrder = raw.pinOrder ?? raw.pin_order
  if (Number.isFinite(pinOrder)) normalized.pinOrder = pinOrder
  return normalized
}

function normalizeGroups(rows) {
  const normalized = rows.map((g) => ({
    id: g.id,
    name: g.name,
    builtin: !!g.builtin,
    collapsed: !!g.collapsed,
  }))
  if (!normalized.some((g) => g.builtin)) {
    normalized.unshift({ id: 'default', name: '全部对话', builtin: true, collapsed: false })
  }
  return normalized
}

// 会话详情懒加载：仅在列表中预载标题/时间戳，点开会话时才拉完整消息
const _loadedDetailIds = new Set()   // 已成功拉取详情的会话 id
const _failedDetailIds = new Set()   // 拉取详情失败的会话 id，避免无限重试

async function loadServerData() {
  const [groupRows, conversationRows] = await Promise.all([
    conversationApi.fetchGroups(),
    conversationApi.fetchConversations(),
  ])
  // 只拿列表，messages 留空——避免 N+1 请求把所有会话的完整消息一次拉回
  const nextConversations = conversationRows.map((row) => normalizeConversation(row, []))

  groups.value = normalizeGroups(groupRows)
  conversations.value = nextConversations
  _loadedDetailIds.clear()

  if (!nextConversations.some((c) => c.id === currentId.value)) {
    currentId.value = nextConversations[0]?.id || null
  }
  saveGroups(groups.value)
  saveConversations(conversations.value)

  // 自动给当前选中的会话补拉完整详情
  if (currentId.value) {
    await ensureConversationLoaded(currentId.value)
  }
}

/**
 * 按需拉取某会话的完整消息历史；已加载或刚迁移进来的（messages 不为空）跳过
 * 成功后更新内存态 + localStorage，失败只记一次避免无限重试
 */
async function ensureConversationLoaded(id) {
  if (!id) return
  if (_loadedDetailIds.has(id)) return
  if (_failedDetailIds.has(id)) return

  const conv = conversations.value.find((c) => c.id === id)
  if (!conv) return
  // 如果 messages 已经非空（migrateLocalData 写进来的 / 离线缓存恢复的），视为已加载
  if (conv.messages && conv.messages.length > 0) {
    _loadedDetailIds.add(id)
    return
  }

  try {
    const detail = await conversationApi.fetchConversation(id)
    Object.assign(conv, {
      title: detail.conversation.title || conv.title,
      groupId: detail.conversation.group_id || conv.groupId,
      pinned: !!detail.conversation.pinned,
      pinOrder: detail.conversation.pin_order ?? conv.pinOrder,
      createdAt: detail.conversation.created_at ?? conv.createdAt,
      updatedAt: detail.conversation.updated_at ?? conv.updatedAt,
      messages: (detail.messages || []).map(normalizeMessage),
    })
    _loadedDetailIds.add(id)
    saveConversations(conversations.value)
  } catch (e) {
    console.warn(`[chat] 懒加载会话 ${id} 失败:`, e)
    _failedDetailIds.add(id)
  }
}

/** 仅在服务端没有任何会话时导入既有浏览器数据，保留原 ID、时间与分组 */
async function migrateLocalData() {
  const localGroups = groups.value.filter((g) => !g.builtin)
  const localConversations = conversations.value

  for (const group of localGroups) {
    await conversationApi.createGroup({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
    })
  }
  for (const conv of localConversations) {
    await conversationApi.createConversation({
      id: conv.id,
      title: conv.title,
      groupId: conv.groupId || 'default',
      pinned: conv.pinned,
      pinOrder: conv.pinOrder,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    })
    for (const message of conv.messages || []) {
      await conversationApi.createMessage(conv.id, {
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        sources: message.sources,
        searching: message.searching,
        searchQuery: message.searchQuery,
        attachments: message.attachments || [],
      })
    }
  }
}

async function init() {
  if (DIRECT_MODE) return
  try {
    const serverConversations = await conversationApi.fetchConversations()
    if (serverConversations.length === 0) await migrateLocalData()
    await loadServerData()
  } catch (e) {
    console.warn('[chat] 从后端加载失败，使用本地缓存:', e)
  }
}
const initPromise = init()

export function useChat() {
  const { settings, getProviderConfig, validate } = useSettings()

  const generatingIds = ref(new Set())
  const replyNotifications = ref(new Set())
  const abortControllers = new Map()
  const isLoading = computed(() => generatingIds.value.has(currentId.value))

  const currentConversation = computed(() =>
    conversations.value.find((c) => c.id === currentId.value)
  )

  const messages = computed(() => currentConversation.value?.messages || [])

  // 置顶对话单独抽离为独立区块（全局，含分组内的置顶），支持手动拖拽排序
  const pinnedConversations = computed(() =>
    conversations.value
      .filter((c) => c.pinned)
      .sort((a, b) => {
        const ao = a.pinOrder ?? Infinity
        const bo = b.pinOrder ?? Infinity
        if (ao !== bo) return ao - bo
        return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
      })
  )

  // 排序：自定义分组（含空分组）在上，未分组对话在下；置顶对话已抽离，不再重复出现
  const groupedConversations = computed(() => {
    const sortItems = (items) =>
      [...items].sort(
        (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
      )
    const custom = groups.value
      .filter((g) => !g.builtin)
      .map((g) => ({
        ...g,
        items: sortItems(
          conversations.value.filter((c) => c.groupId === g.id && !c.pinned)
        ),
      }))
    const def = groups.value.find((g) => g.builtin) || {
      id: 'default', name: '未分组', builtin: true, collapsed: false,
    }
    const ungrouped = {
      ...def,
      name: '未分组',
      items: sortItems(
        conversations.value.filter((c) => (c.groupId || 'default') === 'default' && !c.pinned)
      ),
    }
    return [...custom, ungrouped]
  })

  // ==================== 分组操作 ====================
  async function addGroup(name) {
    if (!name?.trim()) return
    await initPromise
    // 新建分组默认折叠收起
    const g = { id: genGroupId(), name: name.trim(), builtin: false, collapsed: true }
    groups.value.push(g)
    saveGroups(groups.value)
    if (DIRECT_MODE) return g
    try {
      await conversationApi.createGroup({ id: g.id, name: g.name, collapsed: g.collapsed })
    } catch (e) {
      console.warn('[chat] 创建分组失败:', e)
    }
    return g
  }

  async function renameGroup(id, name) {
    await initPromise
    const g = groups.value.find((x) => x.id === id)
    if (!g || g.builtin || !name?.trim()) return
    g.name = name.trim()
    saveGroups(groups.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.updateGroup(id, { name: g.name })
    } catch (e) {
      console.warn('[chat] 重命名分组失败:', e)
    }
  }

  async function deleteGroup(id) {
    await initPromise
    const g = groups.value.find((x) => x.id === id)
    if (!g || g.builtin) return
    // 把该分组下的对话移到默认分组
    conversations.value.forEach((c) => {
      if ((c.groupId || 'default') === id) c.groupId = 'default'
    })
    groups.value = groups.value.filter((x) => x.id !== id)
    saveConversations(conversations.value)
    saveGroups(groups.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.removeGroup(id)
    } catch (e) {
      console.warn('[chat] 删除分组失败:', e)
    }
  }

  async function toggleGroupCollapsed(id) {
    await initPromise
    const g = groups.value.find((x) => x.id === id)
    if (!g) return
    g.collapsed = !g.collapsed
    saveGroups(groups.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.updateGroup(id, { collapsed: g.collapsed })
    } catch (e) {
      console.warn('[chat] 更新分组折叠状态失败:', e)
    }
  }

  // ==================== 会话管理 ====================
  async function newChat(groupId = 'default') {
    await initPromise
    // 功能6: 如果当前已经是空的"新对话"，就不再新建
    const current = currentConversation.value
    if (current && current.messages.length === 0) {
      // 把当前对话移到指定分组
      if (groupId && current.groupId !== groupId) {
        current.groupId = groupId
        saveConversations(conversations.value)
        if (!DIRECT_MODE) {
          try {
            await conversationApi.updateConversation(current.id, { groupId })
          } catch (e) {
            console.warn('[chat] 移动对话失败:', e)
          }
        }
      }
      return current
    }
    const conv = createConversation(groupId)
    conversations.value.unshift(conv)
    currentId.value = conv.id
    saveConversations(conversations.value)
    if (!DIRECT_MODE) {
      try {
        await conversationApi.createConversation({
          id: conv.id,
          title: conv.title,
          groupId: conv.groupId,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        })
      } catch (e) {
        console.warn('[chat] 创建对话失败:', e)
      }
    }
    return conv
  }

  function clearReplyNotification(id) {
    if (!replyNotifications.value.has(id)) return
    const next = new Set(replyNotifications.value)
    next.delete(id)
    replyNotifications.value = next
  }

  function selectChat(id) {
    currentId.value = id
    clearReplyNotification(id)
    // 点开会话时按需拉取完整消息（懒加载，避免启动全量请求）
    ensureConversationLoaded(id)
  }

  async function deleteChat(id) {
    await initPromise
    conversations.value = conversations.value.filter((c) => c.id !== id)
    saveConversations(conversations.value)
    if (currentId.value === id) {
      if (conversations.value.length === 0) {
        await newChat()
      } else {
        currentId.value = conversations.value[0].id
      }
    }
    if (DIRECT_MODE) return
    try {
      await conversationApi.removeConversation(id)
    } catch (e) {
      console.warn('[chat] 删除对话失败:', e)
    }
  }

  async function updateTitle(id, title) {
    await initPromise
    const conv = conversations.value.find((c) => c.id === id)
    if (!conv || !title?.trim()) return
    conv.title = title.trim()
    saveConversations(conversations.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.updateConversation(id, { title: conv.title })
    } catch (e) {
      console.warn('[chat] 更新标题失败:', e)
    }
  }

  async function togglePin(id) {
    await initPromise
    const conv = conversations.value.find((c) => c.id === id)
    if (!conv) return
    conv.pinned = !conv.pinned
    if (conv.pinned) {
      // 新置顶的排到最前面
      const orders = conversations.value
        .filter((c) => c.pinned && c.id !== id)
        .map((c) => c.pinOrder ?? Infinity)
      const min = Math.min(...orders)
      conv.pinOrder = Number.isFinite(min) ? min - 1 : 0
    } else {
      delete conv.pinOrder
    }
    saveConversations(conversations.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.updateConversation(id, {
        pinned: conv.pinned,
        pinOrder: conv.pinOrder ?? null,
      })
    } catch (e) {
      console.warn('[chat] 更新置顶状态失败:', e)
    }
  }

  // 拖拽排序：按传入 id 顺序重写 pinOrder
  async function reorderPinned(orderedIds) {
    await initPromise
    orderedIds.forEach((id, index) => {
      const conv = conversations.value.find((c) => c.id === id)
      if (conv) conv.pinOrder = index
    })
    saveConversations(conversations.value)
    if (DIRECT_MODE) return
    try {
      await Promise.all(orderedIds.map((id, pinOrder) =>
        conversationApi.updateConversation(id, { pinOrder })
      ))
    } catch (e) {
      console.warn('[chat] 保存置顶顺序失败:', e)
    }
  }

  async function deleteChats(ids) {
    await initPromise
    const idSet = new Set(ids)
    conversations.value = conversations.value.filter((c) => !idSet.has(c.id))
    saveConversations(conversations.value)
    if (idSet.has(currentId.value)) {
      if (conversations.value.length === 0) {
        await newChat()
      } else {
        currentId.value = conversations.value[0].id
      }
    }
    if (DIRECT_MODE) return
    try {
      await conversationApi.removeConversations(ids)
    } catch (e) {
      console.warn('[chat] 批量删除对话失败:', e)
    }
  }

  function exportChat(id, format = 'markdown') {
    const conv = conversations.value.find((c) => c.id === id)
    if (!conv) return

    const filename = (conv.title || '未命名对话')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 80) || '未命名对话'
    let content
    let type
    let extension

    if (format === 'json') {
      content = JSON.stringify(conv, null, 2)
      type = 'application/json;charset=utf-8'
      extension = 'json'
    } else {
      const roleNames = { user: '用户', assistant: '助手', system: '系统' }
      const formatTime = (timestamp) => timestamp
        ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
        : '未知'
      const lines = [
        `# ${conv.title || '未命名对话'}`,
        '',
        `- 创建时间：${formatTime(conv.createdAt)}`,
        `- 导出时间：${formatTime(Date.now())}`,
      ]

      conv.messages.forEach((message) => {
        lines.push(
          '',
          '---',
          '',
          `## ${roleNames[message.role] || message.role}`,
          '',
          `时间：${formatTime(message.timestamp)}`,
          '',
          message.content || ''
        )
        if (Array.isArray(message.attachments) && message.attachments.length) {
          lines.push('', ...message.attachments.map((a) => (isPdfAttachment(a)
            ? `[${a.name || 'PDF'}](${a.url})`
            : `![${a.name || '图片'}](${a.url})`)))
        }
      })
      content = '\ufeff' + lines.join('\n')
      type = 'text/markdown;charset=utf-8'
      extension = 'md'
    }

    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${filename}.${extension}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async function importChat(data) {
    await initPromise
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.messages)) {
      throw new Error('JSON 内容不是有效的对话源数据')
    }

    const roles = ['user', 'assistant', 'system']
    const now = Date.now()
    const groupId = groups.value.some((g) => g.id === data.groupId) ? data.groupId : 'default'
    const imported = createConversation(groupId)
    imported.title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '导入的对话'
    imported.createdAt = Number.isFinite(data.createdAt) ? data.createdAt : now
    imported.updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : now
    imported.pinned = data.pinned === true
    if (imported.pinned && Number.isFinite(data.pinOrder)) imported.pinOrder = data.pinOrder
    imported.messages = data.messages.map((message, index) => {
      if (
        !message || typeof message !== 'object' ||
        !roles.includes(message.role) || typeof message.content !== 'string'
      ) {
        throw new Error(`第 ${index + 1} 条消息格式不正确`)
      }
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        role: message.role,
        content: message.content,
        timestamp: Number.isFinite(message.timestamp) ? message.timestamp : now,
        ...(Array.isArray(message.variants) && message.variants.length
          ? { variants: message.variants }
          : {}),
        ...(Array.isArray(message.attachments) && message.attachments.length
          ? { attachments: message.attachments }
          : {}),
      }
    })

    conversations.value.unshift(imported)
    currentId.value = imported.id
    saveConversations(conversations.value)
    if (!DIRECT_MODE) {
      try {
        await conversationApi.createConversation({
          id: imported.id,
          title: imported.title,
          groupId: imported.groupId,
          pinned: imported.pinned,
          pinOrder: imported.pinOrder,
          createdAt: imported.createdAt,
          updatedAt: imported.updatedAt,
        })
        for (const message of imported.messages) {
          await conversationApi.createMessage(imported.id, message)
        }
      } catch (e) {
        console.warn('[chat] 导入对话到后端失败:', e)
      }
    }
    return imported
  }

  async function moveConvsToGroup(ids, groupId) {
    await initPromise
    const idSet = new Set(ids)
    conversations.value.forEach((c) => {
      if (idSet.has(c.id)) c.groupId = groupId
    })
    saveConversations(conversations.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.moveConversations(ids, groupId)
    } catch (e) {
      console.warn('[chat] 批量移动对话失败:', e)
    }
  }

  // ==================== 消息管理 ====================

  async function addMessage(role, content, conversationId = currentId.value, attachments = []) {
    await initPromise
    const conv = conversations.value.find((c) => c.id === conversationId)
    if (!conv) return null
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role, content, timestamp: Date.now(),
    }
    if (Array.isArray(attachments) && attachments.length) {
      msg.attachments = attachments
    }
    // 助手消息预留联网搜索相关字段（历史导入消息可能没有，渲染时用可选链兜底）
    if (role === 'assistant') {
      msg.sources = []
      msg.searching = false
      msg.searchQuery = ''
    }
    conv.messages.push(msg)
    conv.updatedAt = Date.now()
    saveConversations(conversations.value)
    if (!DIRECT_MODE) {
      try {
        await conversationApi.createMessage(conv.id, msg)
      } catch (e) {
        console.warn('[chat] 保存消息失败:', e)
      }
    }
    // 返回数组中的响应式代理，而不是原始对象：
    // 否则调用方直接改 aiMsg.xxx（如多版本 variants、usage、error）不会触发视图更新
    return conv.messages[conv.messages.length - 1]
  }

  // 流式期间只更新内存，结束/停止/异常时统一在 finally 里 saveConversations 一次
  // 避免每个 delta 触发全量 JSON.stringify 写 localStorage 造成主线程卡顿
  function updateMessage(id, content, conversationId = currentId.value) {
    const conv = conversations.value.find((c) => c.id === conversationId)
    if (!conv) return
    const msg = conv.messages.find((m) => m.id === id)
    if (msg) msg.content = content
  }

  async function persistMessage(conversationId, id) {
    if (DIRECT_MODE) return
    const conv = conversations.value.find((c) => c.id === conversationId)
    const msg = conv?.messages.find((m) => m.id === id)
    if (!msg) return
    try {
      await conversationApi.updateMessage(id, {
        content: msg.content,
        sources: msg.sources || [],
        searching: !!msg.searching,
        searchQuery: msg.searchQuery || '',
        usage: msg.usage || null,
        variants: msg.variants || null,
        attachments: msg.attachments || [],
      })
    } catch (e) {
      console.warn('[chat] 更新消息失败:', e)
    }
  }

  async function removeMessage(id, conversationId = currentId.value) {
    await initPromise
    const conv = conversations.value.find((c) => c.id === conversationId)
    if (!conv) return
    conv.messages = conv.messages.filter((m) => m.id !== id)
    saveConversations(conversations.value)
    if (DIRECT_MODE) return
    try {
      await conversationApi.removeMessage(id)
    } catch (e) {
      console.warn('[chat] 删除消息失败:', e)
    }
  }

  // ==================== 发送消息 ====================

  // 联网搜索的系统指令：引导模型自主判断、改写查询、多轮搜索、标注引用
  const SEARCH_SYSTEM_PROMPT =
    '你具备联网搜索能力，可以调用 web_search 工具获取互联网实时信息。\n' +
    '规则：\n' +
    '1. 仅当问题需要最新、实时或你知识无法覆盖的信息时才搜索；通用知识直接回答。\n' +
    '2. 搜索前把用户的口语化问题改写为精准的关键词；复杂问题可拆解为多个关键词，分多次调用。\n' +
    '3. 拿到搜索结果后，综合多源信息给出准确、全面的回答，并在对应的句子后用上标序号标注引用来源，如 [1][2]。序号必须与搜索结果列表中的编号一致。\n' +
    '4. 若某轮搜索结果不足以回答，可以再次发起搜索补充。\n' +
    '5. 若搜索失败或无结果，如实告知用户，并基于已有知识尽力回答。'

  /**
   * 把搜索结果按 url 去重并分配全局递增编号，保证模型引用的 [N] 与最终来源列表一一对应
   */
  function ingestResults(results, sources) {
    return results.map((r) => {
      let idx = sources.findIndex((s) => s.url === r.url)
      if (idx === -1) {
        sources.push({
          title: r.title,
          url: r.url,
          site_name: r.site_name,
          snippet: r.snippet,
        })
        idx = sources.length - 1
      }
      return { ...r, _index: idx + 1 }
    })
  }

  /** 格式化为喂给模型的文本（使用全局编号） */
  function formatNumbered(items) {
    if (!items.length) return '未搜索到相关结果。'
    return items
      .map((r) => {
        const body = (r.content || r.snippet || '').slice(0, 1500)
        return `[${r._index}] ${r.title}\n来源：${r.site_name || '未知站点'} ${r.url}\n${body}`
      })
      .join('\n\n')
  }

  /**
   * 联网搜索 Agent 循环：模型自主决定何时搜、搜什么，最多 MAX_ROUNDS 轮
   * 每轮：流式请求 → 若返回 tool_calls 则执行搜索并回填 → 继续；否则为最终答案
   */
  async function runSearchAgent(conv, aiMsg, signal) {
    const MAX_ROUNDS = 6
    const providerCfg = getProviderConfig()
    const sources = aiMsg.sources

    // 初始上下文：系统指令 + 历史可见消息（排除本条空的 aiMsg）
    const vision = providerSupportsVision(providerCfg.provider, providerCfg.model)
    const msgs = [
      {
        role: 'system',
        content: settings.systemPrompt
          ? `${SEARCH_SYSTEM_PROMPT}\n\n${settings.systemPrompt}`
          : SEARCH_SYSTEM_PROMPT,
      },
      ...(await buildHistoryMessages(conv, aiMsg.id, vision)),
    ]

    const onStream = (delta) => {
      updateMessage(aiMsg.id, (aiMsg.content || '') + delta, conv.id)
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const cfg = {
        ...providerCfg,
        messages: msgs,
        tools: [SEARCH_TOOL],
        stream: settings.stream,
        signal,
        // 多轮搜索会反复产生用量，这里累加到最后一条助手消息上
        onUsage: (usage) => {
          if (!aiMsg || !usage) return
          const prev = aiMsg.usage || { prompt: 0, completion: 0, total: 0 }
          aiMsg.usage = {
            prompt: prev.prompt + usage.prompt,
            completion: prev.completion + usage.completion,
            total: prev.total + usage.total,
          }
        },
      }

      const result = await chatCompletionWithTools(
        cfg,
        settings.stream ? onStream : null
      )
      const { content, toolCalls } = result

      // 没有工具调用 → 最终答案（流式时已通过 onStream 实时写入）
      if (!toolCalls || toolCalls.length === 0) {
        if (!settings.stream) updateMessage(aiMsg.id, content || '', conv.id)
        aiMsg.searching = false
        aiMsg.searchQuery = ''
        saveConversations(conversations.value)
        return
      }

      // 把本轮 assistant 消息（含 tool_calls）压入上下文，供下一轮模型知晓
      msgs.push({ role: 'assistant', content: content || '', tool_calls: toolCalls })

      // 执行模型发起的每一次搜索
      aiMsg.searching = true
      for (const tc of toolCalls) {
        let query = ''
        try {
          query = JSON.parse(tc.function.arguments || '{}').query || ''
        } catch {
          query = ''
        }
        aiMsg.searchQuery = query || '正在检索…'
        saveConversations(conversations.value)
        await persistMessage(conv.id, aiMsg.id)

        let toolContent
        try {
          const results = await webSearch(
            {
              // provider / profileId 必须一起传，后端据此解析模型 Key（代理模式下前端不持有 Key）
              ...providerCfg,
              signal,
            },
            query,
            5
          )
          const numbered = ingestResults(results, sources)
          toolContent = formatNumbered(numbered)
          saveConversations(conversations.value)
          await persistMessage(conv.id, aiMsg.id) // 持久化 sources
        } catch (e) {
          if (e.name === 'AbortError') throw e
          toolContent = `搜索失败：${e.message || '未知错误'}。请基于已有知识回答，或如实告知用户无法获取实时信息。`
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: toolContent })
      }

      aiMsg.searching = false
      aiMsg.searchQuery = ''
      // 进入下一轮，让模型基于搜索结果生成答案（流式）
    }

    // 达到最大轮次的兜底
    if (!aiMsg.content) {
      updateMessage(aiMsg.id, '（已达到最大搜索轮次，未能生成完整回答）', conv.id)
    }
    aiMsg.searching = false
    aiMsg.searchQuery = ''
    saveConversations(conversations.value)
  }

  /**
   * 供应商内置联网搜索（豆包）：请求里开启 web_search_options，
   * 由供应商自行检索，引用标注通过 annotations 返回
   */
  async function runNativeSearch(conv, aiMsg, signal) {
    const providerCfg = getProviderConfig()
    let firstDelta = true

    const vision = providerSupportsVision(providerCfg.provider, providerCfg.model)
    const msgs = [
      ...(settings.systemPrompt ? [{ role: 'system', content: settings.systemPrompt }] : []),
      ...(await buildHistoryMessages(conv, aiMsg.id, vision)),
    ]

    aiMsg.searching = true
    aiMsg.searchQuery = ''
    saveConversations(conversations.value)

    const onStream = (delta) => {
      if (firstDelta) {
        firstDelta = false
        aiMsg.searching = false
      }
      updateMessage(aiMsg.id, (aiMsg.content || '') + delta, conv.id)
    }

    const onAnnotations = (citations) => {
      for (const c of citations) {
        if (!aiMsg.sources.some((s) => s.url === c.url)) aiMsg.sources.push(c)
      }
      saveConversations(conversations.value)
    }

    try {
      const content = await chatCompletion(
        { ...providerCfg, messages: msgs, signal, nativeSearch: true, onAnnotations,
          onUsage: (usage) => { if (aiMsg && usage) aiMsg.usage = usage } },
        settings.stream ? onStream : null
      )
      if (!settings.stream) updateMessage(aiMsg.id, content || '', conv.id)
    } finally {
      aiMsg.searching = false
      aiMsg.searchQuery = ''
      saveConversations(conversations.value)
    }
  }

  async function sendMessage(text, attachments = []) {
    await initPromise
    const conv = currentConversation.value
    const trimmed = String(text || '').trim()
    if ((!trimmed && !attachments.length) || !conv || generatingIds.value.has(conv.id)) return

    clearReplyNotification(conv.id)
    await addMessage('user', trimmed, conv.id, attachments)

    const errors = validate()
    if (Object.keys(errors).length > 0) {
      await addMessage(
        'assistant',
        settings.serverMode
          ? '⚠️ 请先在系统设置中选择供应商和模型（API Key 可在 模型设置 中填写）'
          : '⚠️ 请先在系统设置中完成模型配置（API Key、Base URL、模型）',
        conv.id
      )
      return
    }

    if (conv.title === '新对话') {
      const base = trimmed || '附件对话'
      conv.title = base.slice(0, 20) + (base.length > 20 ? '...' : '')
      saveConversations(conversations.value)
      if (!DIRECT_MODE) {
        try {
          await conversationApi.updateConversation(conv.id, { title: conv.title })
        } catch (e) {
          console.warn('[chat] 自动更新标题失败:', e)
        }
      }
    }

    await runAssistant(conv)
  }

  // ==================== 图片附件 → 请求内容 ====================
  // 上传后的图片在 /uploads 下，上游模型访问不到本地地址，必须转成 data URL 发送
  const _dataUrlCache = new Map()

  async function toDataUrl(attachment) {
    const url = attachment?.url
    if (!url) return ''
    if (_dataUrlCache.has(url)) return _dataUrlCache.get(url)
    try {
      const res = await fetch(url)
      if (!res.ok) return ''
      const blob = await res.blob()
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      _dataUrlCache.set(url, dataUrl)
      return dataUrl
    } catch {
      return ''
    }
  }

  /**
   * 附件文字预处理，结果缓存在附件上避免每轮重复请求：
   * - PDF：始终提取文本层
   * - 图片：仅非视觉模型做 OCR
   * 只处理最近两轮，历史附件过多时不全量处理
   */
  async function ensureAttachmentText(conv, aiMsg, vision) {
    const needsWork = (a) => (isPdfAttachment(a)
      ? !a.pdfText && !a.pdfError
      : !vision && !a.ocrText && !a.ocrError)

    const targets = conv.messages
      .filter((m) => m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length)
      .slice(-2)
      .filter((m) => m.attachments.some(needsWork))
    if (!targets.length) return

    if (aiMsg) {
      aiMsg.searching = true
      aiMsg.searchQuery = '正在提取附件文字…'
    }
    saveConversations(conversations.value)
    try {
      for (const m of targets) {
        for (const a of m.attachments) {
          if (!needsWork(a)) continue
          if (isPdfAttachment(a)) {
            try {
              const text = (await extractPdfText(a.url)).trim()
              if (text) a.pdfText = text
              else a.pdfError = '未能识别到文本（可能是空白页或扫描清晰度不足）'
            } catch (e) {
              a.pdfError = e.message || 'PDF 文本提取失败'
            }
          } else {
            try {
              a.ocrText = (await ocrImage(a.url)).trim()
            } catch (e) {
              a.ocrError = e.message || '识别失败'
            }
          }
        }
        await persistMessage(conv.id, m.id)
      }
    } finally {
      if (aiMsg) { aiMsg.searching = false; aiMsg.searchQuery = '' }
      saveConversations(conversations.value)
    }
  }

  /**
   * 组装发给模型的 messages：
   * - PDF：始终拼接提取出的文本
   * - 图片（支持视觉）：转成 image_url content parts，仅最近两轮
   * - 图片（不支持视觉）：用 OCR 文字替代
   */
  async function buildHistoryMessages(conv, excludeId, vision) {
    const MAX_ATTACHMENT_TURNS = 2
    const recentIds = new Set(
      conv.messages
        .filter((m) => m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length)
        .slice(-MAX_ATTACHMENT_TURNS)
        .map((m) => m.id)
    )

    const out = []
    for (const m of conv.messages) {
      if (m.id === excludeId) continue
      const atts = Array.isArray(m.attachments) ? m.attachments : []
      if (m.role !== 'user' || !atts.length) {
        out.push({ role: m.role, content: m.content })
        continue
      }

      if (!recentIds.has(m.id)) {
        const images = atts.filter((a) => !isPdfAttachment(a)).length
        const pdfs = atts.length - images
        const labels = []
        if (images) labels.push(`${images} 张图片`)
        if (pdfs) labels.push(`${pdfs} 个 PDF`)
        const placeholder = `[用户上传了 ${labels.join('、')}，内容已省略]`
        out.push({ role: m.role, content: m.content ? `${m.content}\n\n${placeholder}` : placeholder })
        continue
      }

      // PDF 文本块（供两种模式复用）
      let pdfIndex = 0
      const docBlocks = atts
        .filter(isPdfAttachment)
        .map((a) => {
          pdfIndex += 1
          if (a.pdfText) return `[PDF ${pdfIndex}：${a.name || '文档'}]\n${a.pdfText}`
          return `[PDF ${pdfIndex}：${a.pdfError || '未能提取文本'}]`
        })
        .join('\n\n')

      if (vision) {
        const parts = []
        const textParts = [m.content, docBlocks].filter(Boolean).join('\n\n')
        if (textParts) parts.push({ type: 'text', text: textParts })
        for (const a of atts.filter((a) => !isPdfAttachment(a))) {
          const dataUrl = await toDataUrl(a)
          if (dataUrl) parts.push({ type: 'image_url', image_url: { url: dataUrl } })
        }
        out.push({ role: m.role, content: parts.length ? parts : (m.content || '[附件]') })
      } else {
        const blocks = []
        let imgIndex = 0
        for (const a of atts) {
          if (isPdfAttachment(a)) continue
          imgIndex += 1
          if (a.ocrText) blocks.push(`[图片 ${imgIndex} 文字]\n${a.ocrText}`)
          else blocks.push(`[图片 ${imgIndex}：${a.ocrError ? '文字识别失败' : '未能提取文字'}]`)
        }
        if (docBlocks) blocks.push(docBlocks)
        const body = blocks.join('\n\n')
        out.push({ role: m.role, content: m.content ? `${m.content}\n\n${body}` : body })
      }
    }
    return out
  }

  /**
   * 为当前会话生成一条助手回复：插入占位消息 → 流式/搜索 → 异常处理 → 持久化
   * 供发送、重新生成、编辑重发、失败重试复用，统一避免重复插入 user 消息
   */
  async function runAssistant(conv) {
    const aiMsg = await addMessage('assistant', '', conv.id)
    const nextGenerating = new Set(generatingIds.value)
    nextGenerating.add(conv.id)
    generatingIds.value = nextGenerating

    const providerCfg = getProviderConfig()
    const vision = providerSupportsVision(providerCfg.provider, providerCfg.model)
    // 预处理附件文字：PDF 总是提取，图片仅在非视觉模型下 OCR
    await ensureAttachmentText(conv, aiMsg, vision)

    const history = [
      ...(settings.systemPrompt ? [{ role: 'system', content: settings.systemPrompt }] : []),
      ...(await buildHistoryMessages(conv, aiMsg?.id, vision)),
    ]

    const controller = new AbortController()
    abortControllers.set(conv.id, controller)
    const config = {
      ...providerCfg,
      messages: history,
      signal: controller.signal,
      onUsage: (usage) => { if (aiMsg && usage) aiMsg.usage = usage },
    }
    let didComplete = false

    try {
      const searchMode = settings.webSearch ? providerSearchMode(settings.provider) : null
      // 多版本回答与联网搜索、图片附件互斥，避免一次并发多个带图请求
      const hasAttachments = conv.messages.some(
        (m) => m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length
      )
      const useBranch = !!settings.branchMode && !searchMode && !hasAttachments
      if (useBranch) {
        didComplete = await runBranch(config, aiMsg)
      } else {
        if (searchMode === 'tools') {
          await runSearchAgent(conv, aiMsg, controller.signal)
        } else if (searchMode === 'native') {
          await runNativeSearch(conv, aiMsg, controller.signal)
        } else if (settings.stream) {
          await chatCompletion(config, (delta) => {
            if (aiMsg) updateMessage(aiMsg.id, (aiMsg.content || '') + delta, conv.id)
          })
        } else {
          const content = await chatCompletion(config, null)
          if (aiMsg) updateMessage(aiMsg.id, content, conv.id)
        }
        didComplete = true
      }
    } catch (e) {
      // 搜索/请求异常时清理搜索中状态，避免 UI 卡在“正在搜索”
      if (aiMsg) { aiMsg.searching = false; aiMsg.searchQuery = '' }
      if (e.name === 'AbortError') {
        if (aiMsg && !aiMsg.content) {
          await removeMessage(aiMsg.id, conv.id)
        } else if (aiMsg) {
          updateMessage(aiMsg.id, (aiMsg.content || '') + '\n\n[已停止]', conv.id)
        }
      } else {
        // 失败时标记 error，供消息气泡展示「重试」按钮
        if (aiMsg) {
          aiMsg.error = true
          const tip = e.message || '请求失败，请重试'
          updateMessage(
            aiMsg.id,
            aiMsg.content ? `${aiMsg.content}\n\n⚠️ ${tip}` : `⚠️ ${tip}`,
            conv.id
          )
        }
      }
    } finally {
      // 流式 delta 不写库；结束、失败或停止时：后端持久化一次 + 本地缓存一次
      if (aiMsg) {
        await persistMessage(conv.id, aiMsg.id)
        saveConversations(conversations.value)
      }

      const next = new Set(generatingIds.value)
      next.delete(conv.id)
      generatingIds.value = next
      if (abortControllers.get(conv.id) === controller) abortControllers.delete(conv.id)

      if (
        didComplete &&
        currentId.value !== conv.id &&
        conversations.value.some((item) => item.id === conv.id)
      ) {
        const nextNotifications = new Set(replyNotifications.value)
        nextNotifications.add(conv.id)
        replyNotifications.value = nextNotifications
      }
    }
  }

  /**
   * 多版本回答：同一问题并发请求多个回答，分别流式写入 aiMsg.variants，供并列对比
   * 返回是否至少有一个回答成功（用于决定是否发完成通知）
   */
  async function runBranch(baseConfig, aiMsg) {
    const count = Math.min(Math.max(parseInt(settings.branchCount, 10) || 2, 2), 4)
    aiMsg.variants = Array.from({ length: count }, () => ({
      content: '',
      usage: null,
      error: false,
    }))
    const stream = !!baseConfig.stream
    let anyOk = false

    await Promise.all(
      aiMsg.variants.map(async (variant) => {
        const cfg = {
          ...baseConfig,
          onUsage: (usage) => { if (usage) variant.usage = usage },
        }
        try {
          if (stream) {
            await chatCompletion(cfg, (delta) => { variant.content += delta })
          } else {
            variant.content = await chatCompletion(cfg, null)
          }
          anyOk = true
        } catch (e) {
          variant.error = true
          const tip = e.message || '请求失败'
          if (e.name === 'AbortError') {
            variant.content = `${variant.content || ''}\n\n[已停止]`
          } else {
            variant.content = variant.content ? `${variant.content}\n\n⚠️ ${tip}` : `⚠️ ${tip}`
          }
        }
      })
    )

    // 汇总各版本用量，供消息级统计展示
    const total = aiMsg.variants.reduce((acc, v) => {
      const u = v.usage
      if (!u) return acc
      return {
        prompt: acc.prompt + (u.prompt || 0),
        completion: acc.completion + (u.completion || 0),
        total: acc.total + (u.total || 0),
      }
    }, { prompt: 0, completion: 0, total: 0 })
    if (total.total) aiMsg.usage = total

    return anyOk
  }

  function stopGenerating() {
    abortControllers.get(currentId.value)?.abort()
  }

  async function regenerate() {
    await initPromise
    const conv = currentConversation.value
    if (!conv || conv.messages.length === 0 || generatingIds.value.has(conv.id)) return

    let lastUserIdx = -1
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return

    // 只删除最后一条 user 之后的回复，再重新生成
    for (let i = conv.messages.length - 1; i > lastUserIdx; i--) {
      await removeMessage(conv.messages[i].id, conv.id)
    }
    await runAssistant(conv)
  }

  /**
   * 失败消息重试：保留原提问，删除该消息及其后的内容后重新生成
   */
  async function retryMessage(messageId) {
    await initPromise
    const conv = currentConversation.value
    if (!conv || generatingIds.value.has(conv.id)) return

    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return

    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx < 0) return

    for (let i = conv.messages.length - 1; i > userIdx; i--) {
      await removeMessage(conv.messages[i].id, conv.id)
    }
    await runAssistant(conv)
  }

  /**
   * 编辑用户消息并重发：更新内容 → 截断其后所有消息 → 重新生成
   */
  async function editAndResend(messageId, content) {
    await initPromise
    const conv = currentConversation.value
    if (!conv || generatingIds.value.has(conv.id)) return

    const idx = conv.messages.findIndex((m) => m.id === messageId)
    if (idx < 0 || conv.messages[idx].role !== 'user') return

    const text = String(content || '').trim()
    if (!text) return

    conv.messages[idx].content = text
    conv.messages[idx].error = false
    if (!DIRECT_MODE) {
      try {
        await conversationApi.updateMessage(messageId, { content: text })
      } catch (e) {
        console.warn('[chat] 更新消息失败:', e)
      }
    }

    for (let i = conv.messages.length - 1; i > idx; i--) {
      await removeMessage(conv.messages[i].id, conv.id)
    }
    saveConversations(conversations.value)
    await runAssistant(conv)
  }

  return {
    // 状态
    groupedConversations,
    pinnedConversations,
    currentId,
    currentConversation,
    messages,
    isLoading,
    replyNotifications,

    // 分组操作
    addGroup,
    renameGroup,
    deleteGroup,
    toggleGroupCollapsed,

    // 会话操作
    newChat,
    selectChat,
    deleteChat,
    deleteChats,
    updateTitle,
    togglePin,
    reorderPinned,
    moveConvsToGroup,
    exportChat,
    importChat,

    // 消息操作
    removeMessage,

    // 发送
    sendMessage,
    stopGenerating,
    regenerate,
    retryMessage,
    editAndResend,
  }
}
