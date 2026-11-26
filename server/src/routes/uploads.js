/**
 * 图片 / PDF 上传 + OCR / PDF 文本提取路由
 *
 * 上传：multipart → magic byte 校验 → 随机文件名写入 DATA_DIR/uploads
 * OCR ：对已上传的图片做文字识别，供不支持视觉的模型兜底
 * PDF ：提取文本层内容，供模型阅读文档
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DATA_DIR } from '../db.js'
import { createError } from '../middleware/error.js'

const router = Router()

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 4
const OCR_TIMEOUT = 90_000

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
})

// 按文件头判定真实类型，不信任客户端的文件名 / MIME
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && String(b.slice(0, 6)).indexOf('GIF8') === 0 },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.length > 5 && b.slice(0, 5).toString('ascii') === '%PDF-' },
]

function detectKind(buffer) {
  return SIGNATURES.find((s) => s.test(buffer)) || null
}

// busboy 默认按 latin1 解析文件名，非 ASCII 会乱码；能按 UTF-8 还原就还原
function decodeFileName(name) {
  const raw = String(name || 'image')
  try {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8')
    return utf8.includes('\uFFFD') ? raw : utf8
  } catch {
    return raw
  }
}

function runUpload(req, res, next) {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(createError(413, `单个文件不能超过 ${MAX_FILE_SIZE / 1024 / 1024}MB`))
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(createError(400, `一次最多上传 ${MAX_FILES} 个文件`))
    }
    next(createError(400, err.message || '上传失败'))
  })
}

/**
 * POST /api/v1/uploads
 * 表单字段：files（可多个）
 * 返回：{ files: [{ id, name, mime, size, url }] }
 */
router.post('/uploads', runUpload, async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : []
  if (!files.length) return next(createError(400, '请选择要上传的文件'))

  const kinds = files.map((f) => detectKind(f.buffer))
  if (kinds.some((k) => !k)) {
    return next(createError(400, '仅支持 PNG / JPG / WEBP / GIF 图片与 PDF 文件'))
  }

  try {
    const saved = []
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      const kind = kinds[i]
      const id = crypto.randomUUID()
      const filename = `${id}.${kind.ext}`
      await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), file.buffer)
      saved.push({
        id,
        name: decodeFileName(file.originalname),
        mime: kind.mime,
        size: file.size,
        kind: kind.ext === 'pdf' ? 'pdf' : 'image',
        url: `/uploads/${filename}`,
      })
    }
    res.json({ files: saved })
  } catch (e) {
    next(createError(500, `保存图片失败：${e.message}`))
  }
})

// ==================== OCR ====================
// tesseract.js 首次识别会下载中英文语言包，之后走本地缓存
let workerPromise = null
let ocrQueue = Promise.resolve()

async function getWorker(cachePath) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      return createWorker('chi_sim+eng', undefined, {
        cachePath,
        // 不传 errorHandler 时，tesseract 会在 worker 消息回调里直接 throw，导致整个进程崩溃
        errorHandler: (err) => console.warn('[ocr] tesseract error:', err),
      })
    })().catch((e) => {
      workerPromise = null
      throw e
    })
  }
  return workerPromise
}

/** 只允许访问 uploads 目录下、由本服务生成的文件 */
function resolveUploadedFile(url) {
  const filename = path.basename(String(url || ''))
  if (!/^[0-9a-f-]{36}\.(png|jpe?g|gif|webp)$/i.test(filename)) return ''
  const full = path.join(UPLOAD_DIR, filename)
  if (!full.startsWith(UPLOAD_DIR)) return ''
  return fs.existsSync(full) ? full : ''
}

/**
 * POST /api/v1/ocr
 * Body: { url: '/uploads/xxx.png' }
 * 返回：{ text }
 */
router.post('/ocr', async (req, res, next) => {
  const file = resolveUploadedFile(req.body?.url)
  if (!file) return next(createError(400, '图片不存在或地址不合法'))

  const cachePath = path.join(DATA_DIR, 'tessdata')
  fs.mkdirSync(cachePath, { recursive: true })

  const task = async () => {
    const worker = await getWorker(cachePath)
    let timer
    try {
      const result = await Promise.race([
        worker.recognize(file),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR 超时')), OCR_TIMEOUT)
        }),
      ])
      return String(result?.data?.text || '').replace(/\r\n/g, '\n').trim()
    } finally {
      clearTimeout(timer)
    }
  }

  // 同一个 worker 不支持并发识别，这里串行排队
  const run = ocrQueue.then(task)
  ocrQueue = run.catch(() => {})

  try {
    res.json({ text: await run })
  } catch (e) {
    next(createError(502, `图片文字识别失败：${e.message || '未知错误'}`))
  }
})

// ==================== PDF 文本提取 ====================
// 优先取文本层；文本层为空（扫描件/文字转曲）时渲染页面走 OCR 兜底
const PDF_MAX_CHARS = 60_000
const PDF_TIMEOUT = 60_000
const PDF_MIN_TEXT = 20          // 文本层少于该长度视为无有效文本
const PDF_OCR_MAX_PAGES = 5      // OCR 兜底最多识别前 5 页，避免耗时过长

let pdfParsePromise = null
function loadPdfParse() {
  if (!pdfParsePromise) {
    // 直接引 lib 入口，避免 pdf-parse 主入口在 ESM 下读取测试文件导致的崩溃
    pdfParsePromise = import('pdf-parse/lib/pdf-parse.js')
      .then((m) => m.default)
      .catch((e) => {
        pdfParsePromise = null
        throw e
      })
  }
  return pdfParsePromise
}

let pdfRenderPromise = null
function loadPdfRender() {
  if (!pdfRenderPromise) {
    pdfRenderPromise = import('pdf-to-img')
      .then((m) => m.pdf)
      .catch((e) => {
        pdfRenderPromise = null
        throw e
      })
  }
  return pdfRenderPromise
}

/** 把 PDF 页面渲染成图片后逐页 OCR（复用上面的 tesseract worker 与串行队列） */
async function ocrPdfPages(buffer) {
  const renderPdf = await loadPdfRender()
  const cachePath = path.join(DATA_DIR, 'tessdata')
  fs.mkdirSync(cachePath, { recursive: true })

  const doc = await renderPdf(buffer, { scale: 2 })
  const pages = []
  let pageNo = 0
  for await (const page of doc) {
    pageNo += 1
    const task = async () => {
      const worker = await getWorker(cachePath)
      let timer
      try {
        const result = await Promise.race([
          worker.recognize(page),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('OCR 超时')), OCR_TIMEOUT)
          }),
        ])
        return String(result?.data?.text || '').replace(/\r\n/g, '\n').trim()
      } finally {
        clearTimeout(timer)
      }
    }
    const run = ocrQueue.then(task)
    ocrQueue = run.catch(() => {})
    pages.push(`[第 ${pageNo} 页]\n${await run}`)
    if (pageNo >= PDF_OCR_MAX_PAGES) break
  }
  return pages.join('\n\n')
}

/** 只允许访问 uploads 目录下、由本服务生成的 PDF */
function resolveUploadedPdf(url) {
  const filename = path.basename(String(url || ''))
  if (!/^[0-9a-f-]{36}\.pdf$/i.test(filename)) return ''
  const full = path.join(UPLOAD_DIR, filename)
  if (!full.startsWith(UPLOAD_DIR)) return ''
  return fs.existsSync(full) ? full : ''
}

/**
 * POST /api/v1/pdf/extract
 * Body: { url: '/uploads/xxx.pdf' }
 * 返回：{ text, pages, truncated, ocr, ocrPages }
 */
router.post('/pdf/extract', async (req, res, next) => {
  const file = resolveUploadedPdf(req.body?.url)
  if (!file) return next(createError(400, 'PDF 不存在或地址不合法'))

  let timer
  try {
    const pdfParse = await loadPdfParse()
    const buffer = await fs.promises.readFile(file)
    const data = await Promise.race([
      pdfParse(buffer),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('PDF 解析超时')), PDF_TIMEOUT)
      }),
    ])
    const plain = String(data?.text || '').replace(/\r\n/g, '\n').trim()
    const pages = Number(data?.numpages) || 0

    let text = plain
    let ocr = false
    let ocrPages = 0
    // 无有效文本层 → 渲染页面 OCR 兜底
    if (plain.length < PDF_MIN_TEXT && pages > 0) {
      ocr = true
      ocrPages = Math.min(pages, PDF_OCR_MAX_PAGES)
      text = (await ocrPdfPages(buffer)).trim()
    }

    res.json({
      text: text.slice(0, PDF_MAX_CHARS),
      pages,
      truncated: text.length > PDF_MAX_CHARS,
      ocr,
      ocrPages,
    })
  } catch (e) {
    next(createError(422, `PDF 解析失败：${e.message || '未知错误'}`))
  } finally {
    clearTimeout(timer)
  }
})

export default router
