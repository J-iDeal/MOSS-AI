<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import brandLogo from '../assets/openai.svg'

const props = defineProps({
  groupedConversations: { type: Array, required: true },
  pinnedConversations: { type: Array, default: () => [] },
  currentId: String,
  replyNotifications: { type: Set, default: () => new Set() },
})
const emit = defineEmits([
  'newChat', 'selectChat', 'deleteChat', 'openSettings',
  'addGroup', 'renameGroup', 'deleteGroup', 'toggleGroup',
  'renameChat', 'togglePin', 'moveConvs', 'deleteChats', 'reorderPinned', 'exportChat',
])

// ==================== 区块数据 ====================
const customGroups = computed(() => props.groupedConversations.filter((g) => !g.builtin))
const ungroupedGroup = computed(() => props.groupedConversations.find((g) => g.builtin))

// ==================== 会话搜索 ====================
const searchQuery = ref('')
const searchInputRef = ref(null)
const searchKeyword = computed(() => searchQuery.value.trim().toLowerCase())
const isSearching = computed(() => !!searchKeyword.value)

// 暴露给父组件：Ctrl/Cmd+K 聚焦搜索框
function focusSearch() {
  nextTick(() => {
    searchInputRef.value?.focus()
    searchInputRef.value?.select()
  })
}
defineExpose({ focusSearch })

function matchConv(conv) {
  if (!isSearching.value) return true
  return (conv.title || '').toLowerCase().includes(searchKeyword.value)
}

// 搜索时只保留命中的会话，并隐藏命中数为 0 的分组
const visiblePinned = computed(() => props.pinnedConversations.filter(matchConv))

const visibleCustomGroups = computed(() => {
  if (!isSearching.value) return customGroups.value
  return customGroups.value
    .map((g) => ({ ...g, items: g.items.filter(matchConv) }))
    .filter((g) => g.items.length > 0)
})

const visibleUngrouped = computed(() => {
  if (!ungroupedGroup.value) return null
  if (!isSearching.value) return ungroupedGroup.value
  return { ...ungroupedGroup.value, items: ungroupedGroup.value.items.filter(matchConv) }
})

const searchResultCount = computed(
  () =>
    visiblePinned.value.length +
    visibleCustomGroups.value.reduce((n, g) => n + g.items.length, 0) +
    (visibleUngrouped.value?.items.length || 0)
)

// ==================== 分组管理 ====================
const renamingGroupId = ref(null)
const renameValue = ref('')
const newGroupName = ref('')
const showNewGroupInput = ref(false)

function startRenameGroup(group, e) {
  e?.stopPropagation?.()
  renamingGroupId.value = group.id
  renameValue.value = group.name
}
function commitRenameGroup() {
  emit('renameGroup', renamingGroupId.value, renameValue.value)
  renamingGroupId.value = null
}
function addGroup() {
  if (!newGroupName.value.trim()) return
  emit('addGroup', newGroupName.value.trim())
  newGroupName.value = ''
  showNewGroupInput.value = false
}

// ==================== 对话菜单 ====================
const menuForId = ref(null)
const menuPos = ref({ top: 0, left: 0 })
const menuMoveOpen = ref(false)
const menuExportOpen = ref(false)
// 二级菜单（fixed 定位，带视口边界校验）
const moveMenuPos = ref({ top: 0, left: 0 })
const exportMenuPos = ref({ top: 0, left: 0 })
// 多选批量移动浮层位置
const batchMenuPos = ref({ top: 0, left: 0 })
const batchMoveOpen = ref(false)

function openMenu(conv, e) {
  e.stopPropagation()
  if (menuForId.value === conv.id) {
    closeMenu()
    return
  }
  const rect = e.currentTarget.getBoundingClientRect()
  // 菜单垂直边界校验：底部空间不足则向上弹出，并保留 8px 视口边距
  const MENU_H = conv.messages.length > 0 ? 246 : 210
  let top = rect.bottom + 4
  if (top + MENU_H > window.innerHeight - 8) top = Math.max(8, rect.top - MENU_H - 4)
  menuPos.value = { top, left: rect.left - 140 }
  menuForId.value = conv.id
  menuMoveOpen.value = false
  menuExportOpen.value = false
}
function closeMenu() {
  menuForId.value = null
  menuMoveOpen.value = false
  menuExportOpen.value = false
}

// 点击展开二级分组菜单：计算 fixed 坐标，水平/垂直都做视口边界校验
function toggleMoveMenu(e) {
  if (menuMoveOpen.value) { menuMoveOpen.value = false; return }
  const rect = e.currentTarget.getBoundingClientRect()
  const MENU_W = 180
  const GAP = 8
  const height = Math.min(240, props.groupedConversations.length * 36 + 12)
  let top = rect.top - 6
  if (top + height > window.innerHeight - GAP) top = Math.max(GAP, window.innerHeight - height - GAP)
  let left = rect.right + 6
  if (left + MENU_W > window.innerWidth - GAP) {
    left = Math.max(GAP, rect.left - MENU_W - 6)
  }
  moveMenuPos.value = { top, left }
  menuExportOpen.value = false
  menuMoveOpen.value = true
}

function toggleExportMenu(e) {
  if (menuExportOpen.value) { menuExportOpen.value = false; return }
  const rect = e.currentTarget.getBoundingClientRect()
  const MENU_W = 180
  const GAP = 8
  const height = 84
  let top = rect.top - 6
  if (top + height > window.innerHeight - GAP) top = Math.max(GAP, window.innerHeight - height - GAP)
  let left = rect.right + 6
  if (left + MENU_W > window.innerWidth - GAP) {
    left = Math.max(GAP, rect.left - MENU_W - 6)
  }
  exportMenuPos.value = { top, left }
  menuMoveOpen.value = false
  menuExportOpen.value = true
}

// 多选移动浮层：默认向下展开，底部不足则向上，水平贴齐并限制在视口内
function openBatchMove(e) {
  if (batchMoveOpen.value) { batchMoveOpen.value = false; return }
  const rect = e.currentTarget.getBoundingClientRect()
  const MENU_W = 180
  const GAP = 8
  const height = Math.min(240, props.groupedConversations.length * 36 + 12)
  let top = rect.bottom + 6
  if (top + height > window.innerHeight - GAP) top = Math.max(GAP, rect.top - height - 6)
  const left = Math.min(Math.max(GAP, rect.left), window.innerWidth - MENU_W - GAP)
  batchMenuPos.value = { top, left }
  batchMoveOpen.value = true
}
function onDocClick() { closeMenu(); batchMoveOpen.value = false }
// Esc：按层级关闭菜单 / 重命名 / 多选模式
function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (menuForId.value) {
    menuForId.value = null
    menuMoveOpen.value = false
    menuExportOpen.value = false
    return
  }
  if (renamingGroupId.value) { renamingGroupId.value = null; return }
  if (renamingChatId.value) { renamingChatId.value = null; return }
  if (selectionMode.value) {
    selectionMode.value = false
    selectedIds.value = new Set()
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})

const menuConv = () => {
  const pinned = props.pinnedConversations.find((x) => x.id === menuForId.value)
  if (pinned) return pinned
  for (const g of props.groupedConversations) {
    const c = g.items.find((x) => x.id === menuForId.value)
    if (c) return c
  }
  return null
}

function menuAction(action) {
  const conv = menuConv()
  if (!conv) return
  if (action === 'rename') {
    renamingChatId.value = conv.id
    renameChatValue.value = conv.title
  } else if (action === 'pin') {
    emit('togglePin', conv.id)
  } else if (action === 'multi') {
    enterSelection(conv.id)
  } else if (action === 'exportJson') {
    emit('exportChat', conv.id, 'json')
  } else if (action === 'exportMarkdown') {
    emit('exportChat', conv.id, 'markdown')
  } else if (action === 'delete') {
    emit('deleteChat', conv.id)
  }
  closeMenu()
}

function moveTo(groupId) {
  const conv = menuConv()
  if (conv) emit('moveConvs', [conv.id], groupId)
  closeMenu()
}

// ==================== 置顶拖拽排序 ====================
const dragPinId = ref(null)
const dropBeforeId = ref(null)

function onPinDragStart(conv, e) {
  dragPinId.value = conv.id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', conv.id)
}
function onPinDragOver(conv, e) {
  if (!dragPinId.value || dragPinId.value === conv.id) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dropBeforeId.value = conv.id
}
function onPinDrop(conv, e) {
  e.preventDefault()
  const fromId = dragPinId.value
  if (!fromId || fromId === conv.id) return
  const ids = props.pinnedConversations.map((c) => c.id)
  const next = ids.filter((id) => id !== fromId)
  next.splice(next.indexOf(conv.id), 0, fromId)
  emit('reorderPinned', next)
  dragPinId.value = null
  dropBeforeId.value = null
}
function onPinDragEnd() {
  dragPinId.value = null
  dropBeforeId.value = null
}

// ==================== 对话重命名 ====================
const renamingChatId = ref(null)
const renameChatValue = ref('')
function commitRenameChat() {
  if (renamingChatId.value) {
    emit('renameChat', renamingChatId.value, renameChatValue.value)
    renamingChatId.value = null
  }
}

// ==================== 多选模式 ====================
const selectionMode = ref(false)
const selectedIds = ref(new Set())

function enterSelection(firstId) {
  selectionMode.value = true
  selectedIds.value = new Set(firstId ? [firstId] : [])
}
function exitSelection() {
  selectionMode.value = false
  selectedIds.value = new Set()
  batchMoveOpen.value = false
}
function toggleSelected(id) {
  const s = new Set(selectedIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedIds.value = s
}
function onConvClick(id) {
  if (selectionMode.value) toggleSelected(id)
  else emit('selectChat', id)
}
function batchDelete() {
  if (selectedIds.value.size === 0) return
  emit('deleteChats', [...selectedIds.value])
  exitSelection()
}
function batchMoveTo(groupId) {
  if (!groupId || selectedIds.value.size === 0) return
  emit('moveConvs', [...selectedIds.value], groupId)
  exitSelection()
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <div class="brand-logo">
          <img :src="brandLogo" class="brand-logo-img" alt="MOSS-AI" />
        </div>
        <div>
          <div class="brand-text">MOSS-AI</div>
        </div>
      </div>
    </div>

    <!-- 会话搜索：本地按标题实时过滤，输入即生效 -->
    <div class="sidebar-search">
      <Icon name="search" :size="14" class="sidebar-search-icon" />
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        class="sidebar-search-input"
        type="text"
        placeholder="搜索对话"
        @keyup.esc="searchQuery = ''"
      />
      <button
        v-if="searchQuery"
        class="sidebar-search-clear"
        title="清空搜索"
        @click="searchQuery = ''"
      >
        <Icon name="x" :size="12" />
      </button>
    </div>

    <button class="new-chat-btn" @click="emit('newChat')">
      <Icon name="plus" :size="16" />
      <span>新建对话</span>
    </button>

    <!-- 多选工具条：已选计数 + 操作按钮组 -->
    <div v-if="selectionMode" class="selection-bar">
      <span class="selection-count">已选 {{ selectedIds.size }} 项</span>
      <div class="selection-actions">
        <div class="selection-move-wrap">
          <button class="selection-action-btn" @click.stop="openBatchMove">
            <Icon name="folder" :size="13" />移动
          </button>
          <div
            v-if="batchMoveOpen"
            class="selection-move-menu"
            :style="{ top: batchMenuPos.top + 'px', left: batchMenuPos.left + 'px' }"
            @click.stop
          >
            <button
              v-for="g in groupedConversations"
              :key="g.id"
              class="conv-menu-item"
              @click="batchMoveTo(g.id)"
            >{{ g.name }}</button>
          </div>
        </div>
        <button class="selection-action-btn danger" @click="batchDelete">
          <Icon name="trash" :size="13" />删除
        </button>
        <button class="selection-action-btn" @click="exitSelection">
          <Icon name="x" :size="13" />取消
        </button>
      </div>
    </div>

    <div class="conversation-list">
      <!-- ============ 区块：分组（标题右侧 + 添加分组） ============ -->
      <div class="section-title section-title-row">
        <span>分组</span>
        <button
          class="section-add-btn"
          title="添加分组"
          @click="showNewGroupInput = !showNewGroupInput"
        >
          <Icon name="plus" :size="13" />
        </button>
      </div>

      <!-- 新建分组输入框 -->
      <template v-if="showNewGroupInput">
        <div class="group-create">
          <input
            v-model="newGroupName"
            class="form-input group-create-input"
            placeholder="分组名称"
            @keyup.enter="addGroup()"
            @keyup.esc="showNewGroupInput = false"
            v-focus
          />
          <div class="group-create-actions">
            <button class="btn btn-sm btn-primary" @click="addGroup()">创建</button>
            <button class="btn btn-sm btn-secondary" @click="showNewGroupInput = false">取消</button>
          </div>
        </div>
      </template>

      <template v-if="visibleCustomGroups.length > 0">
      <div>
        <template v-for="group in visibleCustomGroups" :key="group.id">
          <!-- 分组标题（二级，可折叠） -->
          <div
            :class="['group-title', { collapsed: group.collapsed }]"
            @click="emit('toggleGroup', group.id)"
          >
            <span class="group-label">
              <Icon name="chevron" :size="12" class="chevron" />
              <template v-if="renamingGroupId === group.id">
                <input
                  v-model="renameValue"
                  class="form-input rename-group-input"
                  @click.stop
                  @blur="commitRenameGroup"
                  @keyup.enter="commitRenameGroup"
                  @keyup.esc="renamingGroupId = null"
                />
              </template>
              <template v-else>{{ group.name }}</template>
            </span>
            <span
              class="group-actions"
              v-if="renamingGroupId !== group.id"
              @click.stop
            >
              <button @click="startRenameGroup(group)"><Icon name="edit" :size="13" /></button>
              <button @click="emit('deleteGroup', group.id)"><Icon name="trash" :size="13" /></button>
            </span>
          </div>

          <!-- 分组下的对话（树状缩进） -->
          <div v-if="!group.collapsed || isSearching" class="group-items">
            <div
              v-for="conv in group.items"
              :key="conv.id"
              :class="['conversation-item', {
                active: conv.id === currentId && !selectionMode,
                selected: selectionMode && selectedIds.has(conv.id),
              }]"
              @click="onConvClick(conv.id)"
            >
              <Icon
                v-if="selectionMode"
                name="checkbox"
                :size="15"
                class="icon"
                :style="{ opacity: selectedIds.has(conv.id) ? 1 : 0.35, color: selectedIds.has(conv.id) ? 'var(--primary)' : 'inherit' }"
              />
              <Icon v-else name="chat" :size="15" class="icon" />

              <template v-if="renamingChatId === conv.id">
                <input
                  v-model="renameChatValue"
                  class="form-input rename-chat-input"
                  @click.stop
                  @blur="commitRenameChat"
                  @keyup.enter="commitRenameChat"
                  @keyup.esc="renamingChatId = null"
                  v-focus
                />
              </template>
              <span v-else class="title">{{ conv.title }}</span>
              <span
                v-if="replyNotifications.has(conv.id)"
                class="conversation-reply-badge"
                title="回答已完成"
              >新回复</span>

              <button
                v-if="!selectionMode && renamingChatId !== conv.id"
                class="more-btn"
                title="更多"
                @click="openMenu(conv, $event)"
              >
                <Icon name="more" :size="15" />
              </button>
            </div>
            <div v-if="group.items.length === 0" class="group-empty">
              空分组 · 通过对话菜单移入
            </div>
          </div>
        </template>
      </div>
      </template>

      <!-- ============ 区块：置顶（无置顶对话时隐藏） ============ -->
      <template v-if="visiblePinned.length > 0">
        <div :class="['section-title', { 'with-divider': visibleCustomGroups.length > 0 }]">置顶</div>
        <div class="group-items builtin">
          <div
            v-for="conv in visiblePinned"
            :key="conv.id"
            :class="['conversation-item', {
              active: conv.id === currentId && !selectionMode,
              selected: selectionMode && selectedIds.has(conv.id),
              dragging: dragPinId === conv.id,
              'drop-before': dropBeforeId === conv.id,
            }]"
            :draggable="!selectionMode && renamingChatId !== conv.id"
            @click="onConvClick(conv.id)"
            @dragstart="onPinDragStart(conv, $event)"
            @dragover="onPinDragOver(conv, $event)"
            @drop="onPinDrop(conv, $event)"
            @dragend="onPinDragEnd"
          >
            <Icon
              v-if="selectionMode"
              name="checkbox"
              :size="15"
              class="icon"
              :style="{ opacity: selectedIds.has(conv.id) ? 1 : 0.35, color: selectedIds.has(conv.id) ? 'var(--primary)' : 'inherit' }"
            />

            <template v-if="renamingChatId === conv.id">
              <input
                v-model="renameChatValue"
                class="form-input rename-chat-input"
                @click.stop
                @blur="commitRenameChat"
                @keyup.enter="commitRenameChat"
                @keyup.esc="renamingChatId = null"
                v-focus
              />
            </template>
            <span v-else class="title">{{ conv.title }}</span>
              <span
                v-if="replyNotifications.has(conv.id)"
                class="conversation-reply-badge"
                title="回答已完成"
              >新回复</span>

            <button
              v-if="!selectionMode && renamingChatId !== conv.id"
              class="more-btn"
              title="更多"
              @click="openMenu(conv, $event)"
            >
              <Icon name="more" :size="15" />
            </button>
          </div>
        </div>
      </template>

      <!-- ============ 区块：对话列表 ============ -->
      <div :class="['section-title', { 'with-divider': visibleCustomGroups.length > 0 || visiblePinned.length > 0 }]">对话列表</div>

      <template v-if="visibleUngrouped">
        <div class="group-items builtin">
          <div
            v-for="conv in visibleUngrouped.items"
            :key="conv.id"
            :class="['conversation-item', {
              active: conv.id === currentId && !selectionMode,
              selected: selectionMode && selectedIds.has(conv.id),
            }]"
            @click="onConvClick(conv.id)"
          >
            <Icon
              v-if="selectionMode"
              name="checkbox"
              :size="15"
              class="icon"
              :style="{ opacity: selectedIds.has(conv.id) ? 1 : 0.35, color: selectedIds.has(conv.id) ? 'var(--primary)' : 'inherit' }"
            />
            <Icon v-else name="chat" :size="15" class="icon" />

            <template v-if="renamingChatId === conv.id">
              <input
                v-model="renameChatValue"
                class="form-input rename-chat-input"
                @click.stop
                @blur="commitRenameChat"
                @keyup.enter="commitRenameChat"
                @keyup.esc="renamingChatId = null"
                v-focus
              />
            </template>
            <span v-else class="title">{{ conv.title }}</span>
              <span
                v-if="replyNotifications.has(conv.id)"
                class="conversation-reply-badge"
                title="回答已完成"
              >新回复</span>

            <button
              v-if="!selectionMode && renamingChatId !== conv.id"
              class="more-btn"
              title="更多"
              @click="openMenu(conv, $event)"
            >
              <Icon name="more" :size="15" />
            </button>
          </div>
          <div v-if="isSearching && searchResultCount === 0" class="group-empty plain">
            没有匹配的对话
          </div>
          <div v-else-if="!isSearching && visibleUngrouped.items.length === 0" class="group-empty plain">
            暂无对话
          </div>
        </div>
      </template>
    </div>

    <div class="sidebar-footer">
      <button class="settings-btn" @click="emit('openSettings')">
        <span class="icon-wrap">
          <Icon name="settings" :size="17" />
          <span>系统设置</span>
        </span>
      </button>
    </div>

    <!-- 对话右键菜单（fixed 定位，避免被列表裁剪） -->
    <Teleport to="body">
      <div
        v-if="menuForId && menuConv()"
        class="conv-menu"
        :style="{ top: menuPos.top + 'px', left: Math.max(8, menuPos.left) + 'px' }"
        @click.stop
      >
        <button class="conv-menu-item" @click="menuAction('rename')">
          <Icon name="edit" :size="14" />重命名
        </button>
        <button class="conv-menu-item" @click="menuAction('pin')">
          <Icon name="pin" :size="14" />{{ menuConv().pinned ? '取消置顶' : '置顶' }}
        </button>
        <div class="conv-menu-parent">
          <button class="conv-menu-item" @click="toggleMoveMenu">
            <Icon name="folder" :size="14" />移动到分组
            <Icon name="chevron" :size="12" class="conv-submenu-chevron" />
          </button>
          <div
            v-if="menuMoveOpen"
            class="conv-submenu"
            :style="{ top: moveMenuPos.top + 'px', left: moveMenuPos.left + 'px' }"
          >
            <button
              v-for="g in groupedConversations"
              :key="g.id"
              class="conv-menu-item"
              @click="moveTo(g.id)"
            >
              <span class="conv-check-slot">
                <Icon v-if="(menuConv().groupId || 'default') === g.id" name="check" :size="13" />
              </span>
              {{ g.name }}
            </button>
          </div>
        </div>
        <button class="conv-menu-item" @click="menuAction('multi')">
          <Icon name="checkbox" :size="14" />多选
        </button>
        <div v-if="menuConv().messages.length > 0" class="conv-menu-parent">
          <button class="conv-menu-item" @click="toggleExportMenu">
            <Icon name="download" :size="14" />导出对话
            <Icon name="chevron" :size="12" class="conv-submenu-chevron" />
          </button>
          <div
            v-if="menuExportOpen"
            class="conv-submenu"
            :style="{ top: exportMenuPos.top + 'px', left: exportMenuPos.left + 'px' }"
          >
            <button class="conv-menu-item" @click="menuAction('exportJson')">
              <Icon name="download" :size="14" />导出 JSON
            </button>
            <button class="conv-menu-item" @click="menuAction('exportMarkdown')">
              <Icon name="download" :size="14" />导出 Markdown
            </button>
          </div>
        </div>
        <div class="conv-menu-divider"></div>
        <button class="conv-menu-item danger" @click="menuAction('delete')">
          <Icon name="trash" :size="14" />删除
        </button>
      </div>
    </Teleport>
  </aside>
</template>

<script>
export default {
  directives: {
    focus: {
      mounted(el) { el.focus(); el.select() },
    },
  },
}
</script>
