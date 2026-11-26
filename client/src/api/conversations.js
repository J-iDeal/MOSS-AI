/**
 * 对话 / 分组 / 消息 API
 * 服务端 SQLite 为持久化数据源，token 由 http.js 自动附带
 */
import { getJSON, postJSON, patchJSON, delJSON } from './http.js'

// ==================== 分组 ====================
export async function fetchGroups() {
  const data = await getJSON('/groups')
  return data?.groups || []
}

export function createGroup(payload) {
  return postJSON('/groups', payload)
}

export function updateGroup(id, payload) {
  return patchJSON(`/groups/${id}`, payload)
}

export function removeGroup(id) {
  return delJSON(`/groups/${id}`)
}

// ==================== 会话 ====================
export async function fetchConversations() {
  const data = await getJSON('/conversations')
  return data?.conversations || []
}

export async function fetchConversation(id) {
  return getJSON(`/conversations/${id}`)
}

export async function createConversation(payload) {
  const data = await postJSON('/conversations', payload)
  return data?.conversation
}

export function updateConversation(id, payload) {
  return patchJSON(`/conversations/${id}`, payload)
}

export function removeConversation(id) {
  return delJSON(`/conversations/${id}`)
}

export function removeConversations(ids) {
  return postJSON('/conversations/batch-delete', { ids })
}

export function moveConversations(ids, groupId) {
  return postJSON('/conversations/batch-move', { ids, groupId })
}

// ==================== 消息 ====================
export async function createMessage(conversationId, payload) {
  const data = await postJSON(`/conversations/${conversationId}/messages`, payload)
  return data?.message
}

export function updateMessage(id, payload) {
  return patchJSON(`/messages/${id}`, payload)
}

export function removeMessage(id) {
  return delJSON(`/messages/${id}`)
}
