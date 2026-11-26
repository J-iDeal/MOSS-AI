/**
 * 用户设置读写（后端 settings 表）
 * token 由 http.js 自动附带
 */
import { getJSON, putJSON } from './http.js'

/** 拉取当前用户已保存的 UI 设置 */
export async function fetchSettings() {
  const data = await getJSON('/settings')
  return data?.settings || {}
}

/** 批量保存设置（后端会按白名单过滤，apiKey/serverMode 不会落库） */
export async function saveSettings(kv) {
  return putJSON('/settings', kv || {})
}
