// src/fx/postfx.js
//
// Screen-space finishing pass: additive bloom, CRT scanlines, vignette and a
// faint chromatic edge. Runs entirely on the 2D context with one cached
// offscreen buffer, so it costs a downscaled blit per frame and nothing else.
//
// Typical game render:
//   ...draw world + particles...
//   this.post.bloom(ctx)              // luminous smear over the frame
//   this.post.finish(ctx, this.time)  // scanlines + vignette + frame glow
//
// Preferences live in module RAM only — nothing is persisted (a refresh
// restores defaults), which keeps the zero-storage guarantee intact.

import { THEME, withAlpha, clamp } from './theme.js'

const prefs = {
  scanlines: true,
  bloom: true,
  vignette: true,
}

const listeners = new Set()

function notify() {
  for (const fn of listeners) {
    try {
      fn({ ...prefs })
    } catch {
      /* a broken listener must never break rendering */
    }
  }
}

export function getDisplayPrefs() {
  return { ...prefs }
}

export function setScanlines(on) {
  prefs.scanlines = !!on
  notify()
}

export function setBloom(on) {
  prefs.bloom = !!on
  notify()
}

export function setVignette(on) {
  prefs.vignette = !!on
  notify()
}

/** Cycle the CRT look on/off (scanlines + vignette move together). */
export function toggleCrt() {
  const next = !prefs.scanlines
  prefs.scanlines = next
  prefs.vignette = next
  notify()
  return next
}

export function isCrtEnabled() {
  return prefs.scanlines
}

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function onDisplayPrefsChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let filterSupport = null
function supportsFilter() {
  if (filterSupport !== null) return filterSupport
  try {
    const c = document.createElement('canvas')
    c.width = 4
    c.height = 4
    const ctx = c.getContext('2d')
    ctx.filter = 'blur(2px)'
    filterSupport = ctx.filter === 'blur(2px)'
  } catch {
    filterSupport = false
  }
  return filterSupport
}

export class PostFX {
  /**
   * @param {HTMLCanvasElement} canvas The game canvas (fixed internal size).
   * @param {object} [opts]
   * @param {number} [opts.bloomScale] Downscale factor for the blur buffer.
   * @param {number} [opts.bloomStrength] 0..1 additive mix.
   */
  constructor(canvas, { bloomScale = 0.34, bloomStrength = 0.42, accent = THEME.cyan } = {}) {
    this.canvas = canvas
    this.width = canvas.width || 960
    this.height = canvas.height || 540
    this.bloomScale = bloomScale
    this.bloomStrength = bloomStrength
    this.accent = accent

    this.buffer = document.createElement('canvas')
    this.buffer.width = Math.max(1, Math.round(this.width * bloomScale))
    this.buffer.height = Math.max(1, Math.round(this.height * bloomScale))
    this.bufferCtx = this.buffer.getContext('2d')

    this.scanPattern = null
    this.vignetteGradient = null
  }

  /** Rebuild cached surfaces when the internal resolution changes. */
  resize(width, height) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.buffer.width = Math.max(1, Math.round(width * this.bloomScale))
    this.buffer.height = Math.max(1, Math.round(height * this.bloomScale))
    this.vignetteGradient = null
  }

  _ensureScanPattern(ctx) {
    if (this.scanPattern) return this.scanPattern
    const tile = document.createElement('canvas')
    tile.width = 1
    tile.height = 3
    const tctx = tile.getContext('2d')
    tctx.fillStyle = 'rgba(0,0,0,0.30)'
    tctx.fillRect(0, 0, 1, 1)
    tctx.fillStyle = 'rgba(0,0,0,0.10)'
    tctx.fillRect(0, 1, 1, 1)
    tctx.fillStyle = 'rgba(255,255,255,0.016)'
    tctx.fillRect(0, 2, 1, 1)
    this.scanPattern = ctx.createPattern(tile, 'repeat')
    return this.scanPattern
  }

  _ensureVignette(ctx) {
    if (this.vignetteGradient) return this.vignetteGradient
    const g = ctx.createRadialGradient(
      this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.34,
      this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.78
    )
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.72, 'rgba(0,0,0,0.26)')
    g.addColorStop(1, 'rgba(0,0,0,0.62)')
    this.vignetteGradient = g
    return g
  }

  /**
   * Additive bloom: downscale the frame, blur it, add it back. Call once the
   * world and particles are drawn but before scanlines.
   */
  bloom(ctx, strength = this.bloomStrength) {
    if (!prefs.bloom || strength <= 0) return
    const bw = this.buffer.width
    const bh = this.buffer.height
    const bctx = this.bufferCtx

    bctx.clearRect(0, 0, bw, bh)
    bctx.globalCompositeOperation = 'source-over'
    bctx.filter = 'none'
    bctx.drawImage(this.canvas, 0, 0, this.width, this.height, 0, 0, bw, bh)

    // Crush the darks so only lit pixels bleed.
    bctx.globalCompositeOperation = 'multiply'
    bctx.fillStyle = 'rgba(255,255,255,0.72)'
    bctx.fillRect(0, 0, bw, bh)
    bctx.globalCompositeOperation = 'source-over'

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = clamp(strength, 0, 1)
    if (supportsFilter()) ctx.filter = `blur(${Math.round(6 / this.bloomScale * 0.34)}px)`
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.buffer, 0, 0, bw, bh, 0, 0, this.width, this.height)
    ctx.filter = 'none'
    ctx.restore()
  }

  /**
   * CRT scanlines, vignette, edge glow and a slow rolling refresh band.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} time Milliseconds since the match started (for the roll).
   */
  finish(ctx, time = 0) {
    const { width, height } = this

    if (prefs.scanlines) {
      ctx.save()
      ctx.fillStyle = this._ensureScanPattern(ctx)
      ctx.globalAlpha = 0.55
      ctx.fillRect(0, 0, width, height)

      // Rolling refresh band — very subtle, sells the CRT without distracting.
      const bandY = ((time * 0.055) % (height + 160)) - 80
      const band = ctx.createLinearGradient(0, bandY, 0, bandY + 80)
      band.addColorStop(0, 'rgba(255,255,255,0)')
      band.addColorStop(0.5, 'rgba(255,255,255,0.028)')
      band.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.globalAlpha = 1
      ctx.fillStyle = band
      ctx.fillRect(0, bandY, width, 80)
      ctx.restore()
    }

    if (prefs.vignette) {
      ctx.save()
      ctx.fillStyle = this._ensureVignette(ctx)
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }

    // Neon frame edge ties the canvas to the DOM chrome around it.
    ctx.save()
    ctx.strokeStyle = withAlpha(this.accent, 0.3)
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, width - 2, height - 2)
    ctx.strokeStyle = withAlpha(this.accent, 0.08)
    ctx.lineWidth = 8
    ctx.strokeRect(4, 4, width - 8, height - 8)
    ctx.restore()
  }

  destroy() {
    this.scanPattern = null
    this.vignetteGradient = null
    this.buffer.width = 1
    this.buffer.height = 1
    this.bufferCtx = null
  }
}
