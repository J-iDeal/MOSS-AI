/**
 * 统一错误处理中间件
 */
export function errorHandler(err, req, res, _next) {
  console.error('[ERROR]', err.stack || err.message)

  // SSE 流式中途出错
  if (res.headersSent) {
    try { res.end() } catch {}
    return
  }

  const status = err.status || 500
  res.status(status).json({
    error: err.expose ? err.message : '服务器内部错误',
    ...(process.env.NODE_ENV === 'development' ? { detail: err.message } : {}),
  })
}

/**
 * 404 处理
 */
export function notFound(req, res) {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` })
}

/**
 * 构建带 status 的 Error
 */
export function createError(status, message) {
  const e = new Error(message)
  e.status = status
  e.expose = true
  return e
}
