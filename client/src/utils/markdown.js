/**
 * 消息渲染工具 - 轻量 Markdown 解析
 * 支持：代码块（highlight.js 语法高亮 + 自动语言检测）、行内代码、标题、表格、列表、分割线、粗体、斜体、链接
 */
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import diff from 'highlight.js/lib/languages/diff'
import plaintext from 'highlight.js/lib/languages/plaintext'

// 注册聊天场景常用语言（含常见别名），替代 highlight.js 全量引入以显著减小产物体积
const LANG_DEFS = {
  javascript, js: javascript,
  typescript, ts: typescript,
  python, py: python,
  json, bash, sh: bash, shell: bash,
  sql, xml, html: xml,
  css, markdown, md: markdown,
  yaml, yml: yaml,
  java, c, cpp, 'c++': cpp, go, rust, php, ruby, swift, kotlin,
  dockerfile, diff, plaintext, text: plaintext,
}
for (const [name, def] of Object.entries(LANG_DEFS)) {
  hljs.registerLanguage(name, def)
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 链接/图片地址白名单：仅放行 http(s)、mailto、tel 及站内相对/锚点地址，
// 阻断 javascript:、data:、vbscript: 等可执行协议造成的 XSS
function sanitizeUrl(url, { allowDataImage = false } = {}) {
  const u = String(url).trim()
  if (!u) return ''
  if (/^(\/|#|\?|mailto:|tel:)/i.test(u)) return u
  if (/^https?:\/\//i.test(u)) return u
  if (allowDataImage && /^data:image\//i.test(u)) return u
  return ''
}

// 用不可能出现在正文里的控制字符做行内代码占位，避免与用户文本中的 "数字" 碰撞
const CODE_TOKEN = '\u0000'

// 行内格式：行内代码、粗体、斜体、链接、图片
function inline(text) {
  let t = String(text)
  // 行内代码先提取为占位，避免内部字符被其他规则处理
  const codes = []
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c)
    return `${CODE_TOKEN}${codes.length - 1}${CODE_TOKEN}`
  })
  t = escapeHtml(t)
  // 图片 ![alt](src "title") 必须在链接之前处理，否则前缀会被链接规则吃掉
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, alt, src) => {
      const safe = sanitizeUrl(src, { allowDataImage: true })
      return safe
        ? `<img src="${safe}" alt="${escapeHtml(alt)}" loading="lazy">`
        : escapeHtml(alt)
    }
  )
  // 链接 [text](url "title")：href 走协议白名单，非法协议降级为纯文本
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, label, url) => {
      const safe = sanitizeUrl(url)
      return safe
        ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label
    }
  )
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  t = t.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, 'g'), (m, i) => {
    const c = codes[+i]
    return c === undefined ? m : `<code class="inline-code">${escapeHtml(c)}</code>`
  })
  return t
}

export function parseMarkdown(text, options = {}) {
  const { autoHighlight = true } = options
  if (!text) return ''
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let i = 0
  let paragraph = []

  const flush = () => {
    if (paragraph.length) {
      html += `<p>${paragraph.map(inline).join('<br>')}</p>`
      paragraph = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 代码块 ```lang ... ```
    if (/^```/.test(trimmed)) {
      flush()
      const lang = trimmed.slice(3).trim()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结尾 ```
      const rawCode = buf.join('\n')
      // 语法高亮：优先使用标注语言，否则自动检测
      let highlighted
      let detectedLang = lang
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(rawCode, { language: lang }).value
        } else if (autoHighlight) {
          const auto = hljs.highlightAuto(rawCode)
          highlighted = auto.value
          detectedLang = lang || auto.language || ''
        } else {
          highlighted = escapeHtml(rawCode)
        }
      } catch {
        highlighted = escapeHtml(rawCode)
      }
      html +=
        `<div class="code-block"><div class="code-block-header">` +
        `<span class="code-block-lang">${escapeHtml(detectedLang)}</span>` +
        `<button class="code-block-copy" type="button" aria-label="复制代码">复制</button>` +
        `</div><pre><code class="hljs">${highlighted}</code></pre></div>`
      continue
    }

    // 空行：仅作为段落分隔，不输出额外内容
    if (!trimmed) {
      flush()
      i++
      continue
    }

    // 标题 # ~ ####
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/)
    if (h) {
      flush()
      const lvl = h[1].length
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`
      i++
      continue
    }

    // 分割线 --- / ***
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush()
      html += '<hr>'
      i++
      continue
    }

    // 引用块 > text（支持连续多行）
    if (/^\s*>\s?/.test(line)) {
      flush()
      const items = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html += '<blockquote>' + items.map((t) => `<p>${inline(t)}</p>`).join('') + '</blockquote>'
      continue
    }

    // 表格：| 开头且下一行是分隔行 |---|
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      flush()
      const parseRow = (l) =>
        l.trim().replace(/^\|/, '').replace(/\|$/, '')
          .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
      const headers = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]))
        i++
      }
      html += '<table><thead><tr>' + headers.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      rows.forEach((r) => {
        html += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'
      })
      html += '</tbody></table>'
      continue
    }

    // 无序列表 - item / * item（含任务列表 - [ ] / - [x]）
    if (/^\s*[-*]\s+/.test(line)) {
      flush()
      const items = []
      let hasTask = false
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let content = lines[i].replace(/^\s*[-*]\s+/, '')
        const task = content.match(/^\[([ xX])\]\s+(.*)$/)
        if (task) {
          hasTask = true
          const checked = task[1].toLowerCase() === 'x'
          content = `<input type="checkbox" disabled${checked ? ' checked' : ''}> ${inline(task[2])}`
        } else {
          content = inline(content)
        }
        items.push(content)
        i++
      }
      const cls = hasTask ? ' class="task-list"' : ''
      html += `<ul${cls}>` + items.map((t) => `<li>${t}</li>`).join('') + '</ul>'
      continue
    }

    // 有序列表 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      flush()
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      html += '<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>'
      continue
    }

    // 普通文本行：进入当前段落
    paragraph.push(line)
    i++
  }
  flush()
  return html
}
