// src/fx/camera.js
//
// Dynamic camera with impact screenshake, directional kick, zoom punch and an
// optional hit-flash. Usage inside a render pass:
//
//   this.camera.update(dt)
//   this.camera.begin(ctx)
//   ...draw the world...
//   this.camera.end(ctx)
//   this.camera.drawFlash(ctx, width, height)   // optional, screen-space
//
// All state is RAM-only and resets with the match.

import { clamp, withAlpha, THEME } from './theme.js'

export class Camera {
  /**
   * @param {object} [opts]
   * @param {number} [opts.decay] Shake energy retained per 16.7ms (0..1).
   * @param {number} [opts.maxOffset] Clamp for the shake offset in px.
   */
  constructor({ decay = 0.9, maxOffset = 26 } = {}) {
    this.decay = decay
    this.maxOffset = maxOffset

    this.shakeEnergy = 0
    this.offsetX = 0
    this.offsetY = 0
    this.kickX = 0
    this.kickY = 0
    this.rotation = 0
    this.zoom = 1
    this.zoomTarget = 1
    this.flashAlpha = 0
    this.flashColor = THEME.cyan
    this.time = 0
    this.enabled = true
  }

  get offset() {
    return { x: this.offsetX, y: this.offsetY }
  }

  /**
   * Add shake energy. Strength is roughly "pixels of peak displacement".
   * @param {number} strength
   * @param {object} [opts]
   * @param {number} [opts.rotate] Peak rotation in radians.
   */
  shake(strength = 8, { rotate = 0 } = {}) {
    if (!this.enabled) return
    this.shakeEnergy = Math.min(this.maxOffset, this.shakeEnergy + strength)
    if (rotate) this.rotationEnergy = Math.max(this.rotationEnergy || 0, rotate)
  }

  /** Directional recoil, e.g. push the view opposite a fired shell. */
  kick(dirX, dirY, strength = 6) {
    if (!this.enabled) return
    const len = Math.hypot(dirX, dirY) || 1
    this.kickX += (dirX / len) * strength
    this.kickY += (dirY / len) * strength
  }

  /** Brief zoom punch (1.04 = 4% in). Eases back to 1. */
  punch(scale = 1.03) {
    this.zoom = scale
  }

  /** Full-screen color flash that fades out. */
  flash(color = THEME.magenta, alpha = 0.3) {
    this.flashColor = color
    this.flashAlpha = Math.max(this.flashAlpha, alpha)
  }

  /** Convenience: the standard "something exploded near me" response. */
  impact({ strength = 10, color = null, punch = 1.02, dirX = 0, dirY = 0 } = {}) {
    this.shake(strength)
    if (dirX || dirY) this.kick(dirX, dirY, strength * 0.4)
    if (punch) this.punch(punch)
    if (color) this.flash(color, 0.16)
  }

  /** @param {number} dt milliseconds */
  update(dt) {
    const step = clamp(dt, 0, 64)
    this.time += step
    const decayFactor = Math.pow(this.decay, step / 16.67)

    this.shakeEnergy *= decayFactor
    if (this.shakeEnergy < 0.05) this.shakeEnergy = 0

    // Two out-of-phase sine sources read as handheld jitter rather than noise.
    const e = this.shakeEnergy
    if (e > 0) {
      this.offsetX = Math.sin(this.time * 0.061) * e * 0.7 + (Math.random() - 0.5) * e * 0.6
      this.offsetY = Math.cos(this.time * 0.083) * e * 0.7 + (Math.random() - 0.5) * e * 0.6
    } else {
      this.offsetX = 0
      this.offsetY = 0
    }

    this.kickX *= Math.pow(0.86, step / 16.67)
    this.kickY *= Math.pow(0.86, step / 16.67)
    this.offsetX += this.kickX
    this.offsetY += this.kickY

    if (this.rotationEnergy) {
      this.rotationEnergy *= decayFactor
      if (this.rotationEnergy < 0.0005) this.rotationEnergy = 0
      this.rotation = Math.sin(this.time * 0.05) * this.rotationEnergy
    } else {
      this.rotation = 0
    }

    this.zoom += (this.zoomTarget - this.zoom) * clamp(step / 90, 0, 1)
    if (Math.abs(this.zoom - this.zoomTarget) < 0.0008) this.zoom = this.zoomTarget

    this.flashAlpha *= Math.pow(0.88, step / 16.67)
    if (this.flashAlpha < 0.004) this.flashAlpha = 0
  }

  /**
   * Apply the camera transform. Must be paired with end().
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [width] Canvas width, required for zoom to stay centered.
   * @param {number} [height]
   */
  begin(ctx, width = 960, height = 540) {
    ctx.save()
    if (this.zoom !== 1 || this.rotation !== 0) {
      ctx.translate(width / 2, height / 2)
      ctx.scale(this.zoom, this.zoom)
      if (this.rotation) ctx.rotate(this.rotation)
      ctx.translate(-width / 2, -height / 2)
    }
    ctx.translate(this.offsetX, this.offsetY)
  }

  end(ctx) {
    ctx.restore()
  }

  /** Screen-space hit flash. Call after end(). */
  drawFlash(ctx, width, height) {
    if (this.flashAlpha <= 0) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = withAlpha(this.flashColor, this.flashAlpha)
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }

  reset() {
    this.shakeEnergy = 0
    this.offsetX = 0
    this.offsetY = 0
    this.kickX = 0
    this.kickY = 0
    this.rotation = 0
    this.rotationEnergy = 0
    this.zoom = 1
    this.flashAlpha = 0
  }
}
