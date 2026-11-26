/**
 * 复制文本到剪贴板
 * 优先使用异步 Clipboard API；在非安全上下文（例如通过局域网 IP 以 http 访问）
 * 或权限被拒绝时回退到 execCommand('copy')，保证复制功能始终可用
 */
export async function copyText(text) {
  const value = String(text ?? '')
  if (!value) return false

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // 权限被拒或浏览器限制时继续走兼容方案
    }
  }
  return legacyCopy(value)
}

// 兼容方案：借助临时 textarea + execCommand 复制，兼容非安全上下文
function legacyCopy(value) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)

  const selection = document.getSelection()
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  textarea.select()
  textarea.setSelectionRange(0, value.length)

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  textarea.remove()
  if (previousRange && selection) {
    selection.removeAllRanges()
    selection.addRange(previousRange)
  }
  return ok
}
