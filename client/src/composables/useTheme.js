/**
 * 主题管理 composable
 * 外观模式：light / dark / system（跟随系统）
 * 配色方案：多套风格色调，可叠加在浅色/深色模式之上
 */
import { ref, computed, watch } from 'vue'

const MODE_KEY = 'ai-chat-theme'
const PALETTE_KEY = 'ai-chat-palette'

const media = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

/** 可选配色方案（id 与 globals.css 中 [data-palette] 对应） */
export const PALETTES = [
  { id: 'indigo', label: '靛蓝', colors: ['#6366f1', '#8b5cf6'] },
  { id: 'ocean', label: '海洋', colors: ['#0284c7', '#2563eb'] },
  { id: 'forest', label: '森林', colors: ['#059669', '#0d9488'] },
  { id: 'sakura', label: '樱花', colors: ['#db2777', '#c026d3'] },
  { id: 'sunset', label: '日落', colors: ['#ea580c', '#e11d48'] },
  { id: 'grape', label: '紫罗兰', colors: ['#7c3aed', '#d946ef'] },
  { id: 'mono', label: '石墨', colors: ['#64748b', '#334155'] },
]

const PALETTE_IDS = PALETTES.map((p) => p.id)

function loadTheme() {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved
  } catch {}
  return 'system'
}

function loadPalette() {
  try {
    const saved = localStorage.getItem(PALETTE_KEY)
    if (PALETTE_IDS.includes(saved)) return saved
  } catch {}
  return 'indigo'
}

const theme = ref(loadTheme())
const palette = ref(loadPalette())
// 系统是否深色（响应式，跟随系统模式变化时驱动 isDark）
const systemDark = ref(!!media?.matches)

// 当前实际生效的是否深色（手动模式 + 跟随系统）
const isDark = computed(() => theme.value === 'dark' || (theme.value === 'system' && systemDark.value))

function applyTheme() {
  const root = document.documentElement
  const dark = theme.value === 'dark' || (theme.value === 'system' && media?.matches)
  root.classList.toggle('dark', !!dark)
  root.dataset.palette = palette.value
}

applyTheme()

// 跟随系统时，监听系统主题变化
media?.addEventListener?.('change', (e) => {
  systemDark.value = e.matches
  if (theme.value === 'system') applyTheme()
})

watch(theme, (val) => {
  applyTheme()
  try { localStorage.setItem(MODE_KEY, val) } catch {}
})

watch(palette, (val) => {
  applyTheme()
  try { localStorage.setItem(PALETTE_KEY, val) } catch {}
})

export function useTheme() {
  function setTheme(val) {
    theme.value = val
  }
  function setPalette(val) {
    if (PALETTE_IDS.includes(val)) palette.value = val
  }
  return { theme, palette, isDark, setTheme, setPalette }
}
