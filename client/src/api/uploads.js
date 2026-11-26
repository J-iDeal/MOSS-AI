/**
 * 图片 / PDF 上传 / OCR / PDF 文本提取 API
 * 上传走 multipart（不能塞进聊天 JSON，避免 2MB 体积限制）
 */
import { API_BASE, getToken, fetchWithTimeout } from './http.js'

async function readError(res) {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text)
    return j.error || j.message || `请求失败（HTTP ${res.status}）`
  } catch {
    return text || `请求失败（HTTP ${res.status}）`
  }
}

/**
 * 上传图片或 PDF
 * @param {File[]} files
 * @returns {Promise<Array<{id,name,mime,size,kind,url}>>}
 */
export async function uploadFiles(files) {
  if (!files || !files.length) return []
  const form = new FormData()
  for (const file of files) form.append('files', file, file.name || 'file')

  const token = getToken()
  const res = await fetchWithTimeout(`${API_BASE}/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  }, 120_000)

  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return data.files || []
}

/**
 * 对已上传的图片做文字识别（不支持视觉的模型兜底）
 * 首次识别需要下载语言包，超时给到 180s
 */
export async function ocrImage(url) {
  const token = getToken()
  const res = await fetchWithTimeout(`${API_BASE}/ocr`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  }, 180_000)

  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return String(data.text || '')
}

/**
 * 提取 PDF 文本（无文本层时服务端会自动渲染页面并 OCR，耗时较长）
 * 超时给到 300s，覆盖多页 OCR
 */
export async function extractPdfText(url) {
  const token = getToken()
  const res = await fetchWithTimeout(`${API_BASE}/pdf/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  }, 300_000)

  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return String(data.text || '')
}
