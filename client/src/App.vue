<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Sidebar from './components/Sidebar.vue'
import MessageList from './components/MessageList.vue'
import ChatInput from './components/ChatInput.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useChat } from './composables/useChat'
import { useSettings } from './composables/useSettings'
import { useModels } from './composables/useModels'

const {
  groupedConversations, pinnedConversations, currentId, currentConversation, messages,
  isLoading, replyNotifications, newChat, selectChat, deleteChat, deleteChats, removeMessage,
  sendMessage, stopGenerating, regenerate, retryMessage, editAndResend,
  addGroup, renameGroup, deleteGroup, toggleGroupCollapsed,
  updateTitle, togglePin, reorderPinned, moveConvsToGroup, exportChat,
} = useChat()

const { settings, isConfigured } = useSettings()
const { activeProfile } = useModels()

const showSettings = ref(false)
const confirmDeleteChat = ref(null)
const sidebarRef = ref(null)

// 禁用右键 / F12 / Ctrl+U / Ctrl+S；并提供常用快捷键
function handleContextMenu(e) { e.preventDefault() }
function handleKeydown(e) {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()

  // Ctrl/Cmd+K：聚焦侧栏搜索
  if (mod && key === 'k') {
    e.preventDefault()
    sidebarRef.value?.focusSearch()
    return
  }
  // Alt+N：新建对话（浏览器已占用 Ctrl/Cmd+N，无法被网页拦截）
  if (e.altKey && key === 'n') {
    e.preventDefault()
    newChat()
    nextTick(() => chatInputRef.value?.focus())
    return
  }
  // Esc：关闭当前弹窗（按优先级从内到外），无弹窗时不生效
  if (e.key === 'Escape') {
    if (confirmDeleteChat.value) { e.preventDefault(); confirmDeleteChat.value = null; return }
    if (confirmBatchIds.value) { e.preventDefault(); confirmBatchIds.value = null; return }
    if (confirmDeleteGroupId.value) { e.preventDefault(); confirmDeleteGroupId.value = null; return }
  }
  if ((e.ctrlKey && key === 'u') || (e.ctrlKey && key === 's') || e.key === 'F12') {
    e.preventDefault()
  }
}
// 新建/切换对话后自动对焦输入框
const chatInputRef = ref(null)
watch(currentId, () => nextTick(() => chatInputRef.value?.focus()))

onMounted(() => {
  document.addEventListener('contextmenu', handleContextMenu)
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('keydown', handleKeydown)
})

function handleSend({ text, attachments }) { sendMessage(text, attachments) }
function handleStop() { stopGenerating() }
function handleRegenerate() { regenerate() }
function handleDeleteChat(id) { confirmDeleteChat.value = id }
function confirmDeleteChatAction() {
  if (confirmDeleteChat.value) {
    deleteChat(confirmDeleteChat.value)
    confirmDeleteChat.value = null
  }
}

// 批量删除（多选）
const confirmBatchIds = ref(null)
function handleDeleteChats(ids) { confirmBatchIds.value = ids }
function confirmBatchDeleteAction() {
  if (confirmBatchIds.value) {
    deleteChats(confirmBatchIds.value)
    confirmBatchIds.value = null
  }
}

// 删除分组（二次确认）
const confirmDeleteGroupId = ref(null)
function handleDeleteGroup(id) { confirmDeleteGroupId.value = id }
function confirmDeleteGroupAction() {
  if (confirmDeleteGroupId.value) {
    deleteGroup(confirmDeleteGroupId.value)
    confirmDeleteGroupId.value = null
  }
}
</script>

<template>
  <div class="app-layout">
    <Sidebar
      ref="sidebarRef"
      :grouped-conversations="groupedConversations"
      :pinned-conversations="pinnedConversations"
      :current-id="currentId"
      :reply-notifications="replyNotifications"
      @new-chat="newChat"
      @select-chat="selectChat"
      @delete-chat="handleDeleteChat"
      @open-settings="showSettings = true"
      @add-group="addGroup"
      @rename-group="renameGroup"
      @delete-group="handleDeleteGroup"
      @toggle-group="toggleGroupCollapsed"
      @rename-chat="updateTitle"
      @toggle-pin="togglePin"
      @reorder-pinned="reorderPinned"
      @move-convs="moveConvsToGroup"
      @delete-chats="handleDeleteChats"
      @export-chat="exportChat"
    />

    <main class="main-content">
      <MessageList
        :messages="messages"
        :is-loading="isLoading"
        :current-model="activeProfile?.model || settings.model"
        :conversation-title="currentConversation?.title"
        @regenerate="handleRegenerate"
        @retry="(msg) => retryMessage(msg.id)"
        @edit="(msg, text) => editAndResend(msg.id, text)"
        @delete="(msg) => removeMessage(msg.id)"
      />

      <ChatInput
        ref="chatInputRef"
        :disabled="!isConfigured"
        :is-loading="isLoading"
        :is-streaming="settings.stream && isLoading"
        @send="handleSend"
        @stop="handleStop"
      />
    </main>

    <SettingsPanel :visible="showSettings" @close="showSettings = false" />

    <ConfirmDialog
      :visible="!!confirmDeleteChat"
      title="删除这个对话？"
      message="对话中的所有消息将被永久删除，此操作不可撤销。"
      confirm-text="删除对话"
      danger
      @confirm="confirmDeleteChatAction"
      @cancel="confirmDeleteChat = null"
    />

    <ConfirmDialog
      :visible="!!confirmBatchIds"
      title="批量删除对话"
      :message="`确定删除选中的 ${confirmBatchIds?.length || 0} 个对话吗？所有消息将被永久删除。`"
      confirm-text="删除"
      danger
      @confirm="confirmBatchDeleteAction"
      @cancel="confirmBatchIds = null"
    />

    <ConfirmDialog
      :visible="!!confirmDeleteGroupId"
      title="删除这个分组？"
      message="分组将被删除，组内对话会自动移到「对话列表」，不会丢失消息。"
      confirm-text="删除分组"
      danger
      @confirm="confirmDeleteGroupAction"
      @cancel="confirmDeleteGroupId = null"
    />
  </div>
</template>
