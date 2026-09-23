// src/fx/theme.js
//
// Single source of truth for the neo-arcade look, plus the canvas drawing
// primitives every game shares (glass panels, neon type, grids, bars).
//
// Keep these values in sync with the CSS custom properties in src/style.css —
// the DOM shell and the canvas renderers must read as one continuous surface.

export const THEME = {
  // Surfaces
  bgDeep: '#05070d',
  bg: '#080c14',
  bgRaised: '#0d1320',
  surface: '#111a28',
  glass: 'rgba(16, 24, 38, 0.72)',
  glassEdge: 'rgba(0, 240, 255, 0.22)',

  // Accents
  cyan: '#00f0ff',
  magenta: '#ff0055',
  lime: '#39ff14',
  amber: '#ffb300',
  violet: '#a855ff',
  ice: '#7fe7ff',

  // Type
  text: '#e8f4ff',
  textDim: '#8fa3c0',
  textFaint: '#4f5f78',

  // Structure
  grid: 'rgba(0, 240, 255, 0.055)',
  gridStrong: 'rgba(0, 240, 255, 0.11)',
  shadow: 'rgba(0, 0, 0, 0.55)',
}

/** Telemetry / HUD face. Monospace keeps numeric columns from jittering. */
export const FONT_MONO = 'ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace'
/** Display face for titles and large callouts. */
export const FONT_UI = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif'

/** Twelve distinguishable neon player colors (seat order). */
export const PLAYER_COLORS = [
  '#00f0ff', '#ff0055', '#39ff14', '#ffb300', '#a855ff', '#7fe7ff',
  '#ff7a1a', '#ff5ea8', '#00ffc8', '#c6ff2e', '#ff4d4d', '#8b7dff',
]

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
export const lerp = (a, b, t) => a + (b - a) * t
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
export const TAU = Math.PI * 2

/** Random float in [min, max). */
export const rand = (min, max) => min + Math.random() * (max - min)
/** Random int in [min, max]. */
export const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1))
/** Random element. */
export const pick = (list) => list[Math.floor(Math.random() * list.length)]

/**
 * Add an alpha channel to a #rgb / #rrggbb color.
 * @param {string} hex
 * @param {number} alpha 0..1
 */
export function withAlpha(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(255,255,255,${alpha})`
  if (hex.startsWith('rgb')) return hex
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`
}

/** Mix two hex colors. */
export function mixColor(a, b, t) {
  const parse = (hex) => {
    let h = hex.replace('#', '')
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const to = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
  return `#${to(lerp(r1, r2, t))}${to(lerp(g1, g2, t))}${to(lerp(b1, b2, t))}`
}

/** Rounded-rectangle path (does not fill or stroke). */
export function roundRect(ctx, x, y, w, h, r = 10) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

/**
 * Deep-slate arena backdrop with a perspective-free tech grid.
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawArenaBackdrop(ctx, width, height, {
  base = THEME.bg,
  step = 40,
  glowColor = THEME.cyan,
  glowAlpha = 0.05,
} = {}) {
  ctx.fillStyle = base
  ctx.fillRect(0, 0, width, height)

  // Corner glow wash so the frame never looks flat.
  const g = ctx.createRadialGradient(width / 2, height * 0.42, 40, width / 2, height * 0.5, width * 0.72)
  g.addColorStop(0, withAlpha(glowColor, glowAlpha * 2.2))
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, width, height)

  drawGrid(ctx, { x: 0, y: 0, w: width, h: height, step })
}

/** Uniform tech grid. */
export function drawGrid(ctx, {
  x = 0, y = 0, w, h, step = 40, color = THEME.grid, major = 5, majorColor = THEME.gridStrong,
}) {
  ctx.save()
  ctx.lineWidth = 1
  let i = 0
  for (let gx = x; gx <= x + w; gx += step, i++) {
    ctx.strokeStyle = major && i % major === 0 ? majorColor : color
    ctx.beginPath()
    ctx.moveTo(Math.round(gx) + 0.5, y)
    ctx.lineTo(Math.round(gx) + 0.5, y + h)
    ctx.stroke()
  }
  i = 0
  for (let gy = y; gy <= y + h; gy += step, i++) {
    ctx.strokeStyle = major && i % major === 0 ? majorColor : color
    ctx.beginPath()
    ctx.moveTo(x, Math.round(gy) + 0.5)
    ctx.lineTo(x + w, Math.round(gy) + 0.5)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Frosted glass panel with a neon edge and optional header strip.
 * Returns the inner content rect so callers can lay out inside it.
 */
export function drawGlassPanel(ctx, {
  x, y, w, h,
  radius = 14,
  accent = THEME.cyan,
  fill = THEME.glass,
  glow = 18,
  title = null,
  titleAlign = 'left',
  pad = 18,
}) {
  ctx.save()

  // Drop shadow / outer glow
  ctx.shadowColor = withAlpha(accent, 0.3)
  ctx.shadowBlur = glow
  ctx.fillStyle = fill
  roundRect(ctx, x, y, w, h, radius)
  ctx.fill()
  ctx.shadowBlur = 0

  // Inner sheen (top-down gradient) for the glass read
  const sheen = ctx.createLinearGradient(x, y, x, y + h)
  sheen.addColorStop(0, 'rgba(255,255,255,0.055)')
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.012)')
  sheen.addColorStop(1, 'rgba(255,255,255,0.03)')
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = sheen
  ctx.fill()

  // Neon border
  ctx.strokeStyle = withAlpha(accent, 0.45)
  ctx.lineWidth = 1.25
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius)
  ctx.stroke()

  // Accent corner ticks
  ctx.strokeStyle = withAlpha(accent, 0.85)
  ctx.lineWidth = 2
  const t = 14
  ctx.beginPath()
  ctx.moveTo(x + radius * 0.6, y + 1); ctx.lineTo(x + radius * 0.6 + t, y + 1)
  ctx.moveTo(x + w - radius * 0.6, y + h - 1); ctx.lineTo(x + w - radius * 0.6 - t, y + h - 1)
  ctx.stroke()

  let contentY = y + pad
  if (title) {
    ctx.fillStyle = withAlpha(accent, 0.1)
    roundRect(ctx, x + 1, y + 1, w - 2, 34, radius)
    ctx.fill()
    ctx.font = `700 12px ${FONT_MONO}`
    ctx.fillStyle = accent
    ctx.textAlign = titleAlign
    ctx.textBaseline = 'middle'
    const tx = titleAlign === 'center' ? x + w / 2 : x + pad
    ctx.fillText(title.toUpperCase(), tx, y + 18)
    contentY = y + 34 + pad * 0.6
  }

  ctx.restore()
  return { x: x + pad, y: contentY, w: w - pad * 2, h: h - (contentY - y) - pad }
}

/** Glowing text. Restores all context state it touches. */
export function drawNeonText(ctx, text, x, y, {
  font = `700 24px ${FONT_UI}`,
  color = THEME.cyan,
  glow = 16,
  align = 'center',
  baseline = 'alphabetic',
  alpha = 1,
} = {}) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = baseline
  if (glow > 0) {
    ctx.shadowColor = withAlpha(color, 0.9)
    ctx.shadowBlur = glow
  }
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** Thin telemetry label + value pair, monospace. */
export function drawTelemetry(ctx, label, value, x, y, {
  color = THEME.cyan,
  labelColor = THEME.textFaint,
  align = 'left',
  size = 12,
} = {}) {
  ctx.save()
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.font = `600 ${size - 2}px ${FONT_MONO}`
  ctx.fillStyle = labelColor
  ctx.fillText(label.toUpperCase(), x, y)
  ctx.font = `700 ${size + 2}px ${FONT_MONO}`
  ctx.fillStyle = color
  ctx.fillText(String(value), x, y + size + 3)
  ctx.restore()
}

/** Horizontal progress / timer bar with neon fill. */
export function drawBar(ctx, { x, y, w, h = 6, value, color = THEME.cyan, track = 'rgba(255,255,255,.08)', radius = 3 }) {
  roundRect(ctx, x, y, w, h, radius)
  ctx.fillStyle = track
  ctx.fill()
  const filled = clamp(value, 0, 1) * w
  if (filled > 0.5) {
    ctx.save()
    ctx.shadowColor = withAlpha(color, 0.8)
    ctx.shadowBlur = 10
    roundRect(ctx, x, y, filled, h, radius)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }
}

/** Neon capsule button drawn on canvas. Returns its hit rect. */
export function drawCanvasButton(ctx, {
  x, y, w, h, label,
  accent = THEME.cyan,
  filled = false,
  font = `700 17px ${FONT_UI}`,
  hover = false,
}) {
  ctx.save()
  roundRect(ctx, x, y, w, h, 10)
  ctx.fillStyle = filled ? withAlpha(accent, hover ? 0.34 : 0.22) : withAlpha(accent, hover ? 0.16 : 0.08)
  ctx.fill()
  ctx.shadowColor = withAlpha(accent, 0.7)
  ctx.shadowBlur = hover ? 22 : 12
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 10)
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.font = font
  ctx.fillStyle = THEME.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + w / 2, y + h / 2 + 1)
  ctx.restore()
  return { x, y, w, h }
}

/** Point-in-rect test for canvas-space hit detection. */
export function hitRect(point, rect) {
  return (
    !!rect &&
    point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h
  )
}

/** Convert a DOM pointer event into fixed-resolution canvas coordinates. */
export function toCanvasPoint(canvas, event, width, height) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) * width) / (rect.width || width),
    y: ((event.clientY - rect.top) * height) / (rect.height || height),
  }
}
