/**
 * 模型配置 API（后端 models 表，单一事实来源）
 * token 由 http.js 自动附带
 */
import { getJSON, postJSON, putJSON, delJSON } from './http.js'

/** 拉取模型列表（不含 api_key） */
export async function fetchModels() {
  const data = await getJSON('/models')
  return data?.models || []
}

/** 新建模型，返回创建后的对象（含 id） */
export async function createModel(payload) {
  return postJSON('/models', payload)
}

/** 更新模型配置 */
export async function updateModel(id, payload) {
  return putJSON(`/models/${id}`, payload)
}

/** 删除模型 */
export async function removeModel(id) {
  return delJSON(`/models/${id}`)
}

/** 设为当前激活模型 */
export async function activateModel(id) {
  return postJSON(`/models/${id}/activate`)
}
