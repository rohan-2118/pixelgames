// src/fx/particles.js
//
// Pooled, additive-blended particle system shared by every game.
//
// Everything is plain RAM: a fixed-size pool of structs, no allocations during
// steady-state play, and no dependencies. Draw with `ctx.globalCompositeOperation
// = 'lighter'` so overlapping particles bloom instead of muddying.

import { TAU, clamp, rand, withAlpha, THEME } from './theme.js'

const KIND_DOT = 0
const KIND_SPARK = 1 // stretched along velocity
const KIND_RING = 2 // expanding hollow circle
const KIND_SHARD = 3 // rotating triangle chunk
const KIND_SMOKE = 4 // soft dark puff, drawn normally (not additive)

export class ParticleField {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max] Pool size. Oldest particles are recycled.
   */
  constructor({ max = 1200 } = {}) {
    this.max = max
    this.pool = new Array(max)
    for (let i = 0; i < max; i++) {
      this.pool[i] = {
        active: false,
        kind: KIND_DOT,
        x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1,
        size: 2, endSize: 0,
        color: THEME.cyan,
        alpha: 1,
        gravity: 0,
        drag: 1,
        spin: 0,
        rot: 0,
        wobble: 0,
        seed: 0,
      }
    }
    this.cursor = 0
    this.liveCount = 0
    this.ambientSeeds = []
  }

  get count() {
    return this.liveCount
  }

  /** Claim a slot from the pool (recycles the oldest if saturated). */
  _claim() {
    for (let probes = 0; probes < this.max; probes++) {
      const p = this.pool[this.cursor]
      this.cursor = (this.cursor + 1) % this.max
      if (!p.active) {
        p.active = true
        this.liveCount++
        return p
      }
    }
    const p = this.pool[this.cursor]
    this.cursor = (this.cursor + 1) % this.max
    return p
  }

  /** Low-level spawn. Prefer the semantic helpers below. */
  spawn({
    x, y, vx = 0, vy = 0,
    life = 500,
    size = 3,
    endSize = 0,
    color = THEME.cyan,
    kind = KIND_DOT,
    gravity = 0,
    drag = 0.98,
    spin = 0,
    alpha = 1,
    wobble = 0,
  }) {
    const p = this._claim()
    p.kind = kind
    p.x = x; p.y = y; p.vx = vx; p.vy = vy
    p.life = life; p.maxLife = life
    p.size = size; p.endSize = endSize
    p.color = color
    p.gravity = gravity
    p.drag = drag
    p.spin = spin
    p.rot = rand(0, TAU)
    p.alpha = alpha
    p.wobble = wobble
    p.seed = Math.random() * 1000
    return p
  }

  /**
   * Omnidirectional explosion: fast sparks + slower embers + a shock ring.
   */
  burst(x, y, {
    count = 26,
    color = THEME.amber,
    secondary = null,
    speed = 0.34,
    spread = TAU,
    baseAngle = 0,
    life = 520,
    size = 3,
    gravity = 0.00018,
    ring = true,
    shards = 0,
  } = {}) {
    for (let i = 0; i < count; i++) {
      const a = baseAngle + rand(-spread / 2, spread / 2)
      const v = speed * rand(0.35, 1.35)
      this.spawn({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: life * rand(0.6, 1.3),
        size: size * rand(0.6, 1.5),
        color: secondary && i % 3 === 0 ? secondary : color,
        kind: KIND_SPARK,
        gravity,
        drag: 0.976,
      })
    }
    for (let i = 0; i < shards; i++) {
      const a = rand(0, TAU)
      this.spawn({
        x, y,
        vx: Math.cos(a) * speed * rand(0.2, 0.7),
        vy: Math.sin(a) * speed * rand(0.2, 0.7),
        life: life * rand(1.1, 1.8),
        size: size * rand(1.4, 2.6),
        color,
        kind: KIND_SHARD,
        gravity: gravity * 2,
        drag: 0.984,
        spin: rand(-0.012, 0.012),
      })
    }
    if (ring) this.ring(x, y, { color, life: life * 0.7, radius: size * 14 })
  }

  /** Directional spark fan — impacts, ricochets, muzzle flashes. */
  spark(x, y, angle, {
    count = 9,
    color = THEME.cyan,
    speed = 0.3,
    spread = 1.1,
    life = 320,
    size = 2.4,
    gravity = 0.00012,
  } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread / 2, spread / 2)
      const v = speed * rand(0.4, 1.25)
      this.spawn({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: life * rand(0.6, 1.25),
        size: size * rand(0.7, 1.3),
        color,
        kind: KIND_SPARK,
        gravity,
        drag: 0.97,
      })
    }
  }

  /** Expanding shockwave ring. */
  ring(x, y, { radius = 36, color = THEME.cyan, life = 360, width = 2.5 } = {}) {
    this.spawn({
      x, y,
      life,
      size: width,
      endSize: radius,
      color,
      kind: KIND_RING,
      drag: 1,
    })
  }

  /** A single soft glow dot — call per frame behind a moving object. */
  trail(x, y, {
    color = THEME.cyan,
    size = 4,
    life = 260,
    drift = 0.02,
    alpha = 0.85,
  } = {}) {
    this.spawn({
      x: x + rand(-1, 1),
      y: y + rand(-1, 1),
      vx: rand(-drift, drift),
      vy: rand(-drift, drift),
      life,
      size,
      color,
      alpha,
      kind: KIND_DOT,
      drag: 0.94,
    })
  }

  /** Dark puff for destruction debris (drawn without additive blending). */
  smoke(x, y, { count = 6, color = '#2a3446', life = 900, size = 10 } = {}) {
    for (let i = 0; i < count; i++) {
      this.spawn({
        x: x + rand(-6, 6), y: y + rand(-6, 6),
        vx: rand(-0.04, 0.04), vy: rand(-0.07, -0.01),
        life: life * rand(0.7, 1.4),
        size: size * rand(0.6, 1.4),
        endSize: size * 2.2,
        color,
        kind: KIND_SMOKE,
        drag: 0.99,
      })
    }
  }

  /**
   * Seed slow ambient motes that drift forever inside a region. Call once on
   * start; they respawn on their own as they age out.
   */
  ambient(width, height, { count = 40, color = THEME.cyan, speed = 0.014, size = 1.8 } = {}) {
    this.ambientSeeds = []
    for (let i = 0; i < count; i++) {
      this.ambientSeeds.push({
        x: rand(0, width), y: rand(0, height),
        vx: rand(-speed, speed), vy: rand(-speed, speed),
        size: size * rand(0.5, 1.6),
        phase: rand(0, TAU),
        color,
      })
    }
    this.ambientBounds = { width, height }
  }

  /** @param {number} dt milliseconds since last update */
  update(dt) {
    const step = clamp(dt, 0, 64)
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i]
      if (!p.active) continue
      p.life -= step
      if (p.life <= 0) {
        p.active = false
        this.liveCount = Math.max(0, this.liveCount - 1)
        continue
      }
      p.vy += p.gravity * step
      const dragFactor = Math.pow(p.drag, step / 16.67)
      p.vx *= dragFactor
      p.vy *= dragFactor
      p.x += p.vx * step
      p.y += p.vy * step
      if (p.spin) p.rot += p.spin * step
    }

    if (this.ambientSeeds.length && this.ambientBounds) {
      const { width, height } = this.ambientBounds
      for (const m of this.ambientSeeds) {
        m.x += m.vx * step
        m.y += m.vy * step
        m.phase += 0.0012 * step
        if (m.x < -10) m.x = width + 10
        if (m.x > width + 10) m.x = -10
        if (m.y < -10) m.y = height + 10
        if (m.y > height + 10) m.y = -10
      }
    }
  }

  /** Ambient motes only — draw these before gameplay geometry. */
  drawAmbient(ctx) {
    if (!this.ambientSeeds.length) return
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const m of this.ambientSeeds) {
      const twinkle = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin(m.phase))
      ctx.fillStyle = withAlpha(m.color, twinkle)
      ctx.beginPath()
      ctx.arc(m.x, m.y, m.size, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  /** Foreground particles — draw these after gameplay geometry. */
  draw(ctx) {
    if (this.liveCount === 0) return
    ctx.save()

    // Pass 1: smoke, normal blending so it reads as mass, not light.
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i]
      if (!p.active || p.kind !== KIND_SMOKE) continue
      const t = p.life / p.maxLife
      const radius = p.size + (p.endSize - p.size) * (1 - t)
      ctx.globalAlpha = 0.34 * t * p.alpha
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(0.5, radius), 0, TAU)
      ctx.fill()
    }

    // Pass 2: everything luminous.
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i]
      if (!p.active || p.kind === KIND_SMOKE) continue
      const t = clamp(p.life / p.maxLife, 0, 1)
      const fade = t * t
      ctx.globalAlpha = fade * p.alpha

      if (p.kind === KIND_RING) {
        const radius = p.size + (p.endSize - p.size) * (1 - t)
        ctx.strokeStyle = p.color
        ctx.lineWidth = Math.max(0.6, p.size * t * 1.6)
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(1, radius), 0, TAU)
        ctx.stroke()
        continue
      }

      if (p.kind === KIND_SPARK) {
        const speed = Math.hypot(p.vx, p.vy)
        const len = clamp(speed * 90, p.size, 22)
        const ang = Math.atan2(p.vy, p.vx)
        ctx.strokeStyle = p.color
        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(0.8, p.size * fade)
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - Math.cos(ang) * len, p.y - Math.sin(ang) * len)
        ctx.stroke()
        continue
      }

      if (p.kind === KIND_SHARD) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        const s = p.size * (0.5 + fade * 0.8)
        ctx.beginPath()
        ctx.moveTo(-s, -s * 0.6)
        ctx.lineTo(s, 0)
        ctx.lineTo(-s * 0.7, s * 0.8)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
        continue
      }

      // KIND_DOT — soft radial glow.
      const r = Math.max(0.6, p.size * (0.4 + fade * 0.9))
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4)
      grad.addColorStop(0, withAlpha(p.color, 0.95))
      grad.addColorStop(0.45, withAlpha(p.color, 0.35))
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 2.4, 0, TAU)
      ctx.fill()
    }

    ctx.restore()
  }

  /** Drop every live particle (round reset / teardown). */
  clear() {
    for (let i = 0; i < this.max; i++) this.pool[i].active = false
    this.liveCount = 0
  }

  /** Full reset including ambient motes. */
  destroy() {
    this.clear()
    this.ambientSeeds = []
    this.ambientBounds = null
  }
}

export const PARTICLE_KIND = {
  DOT: KIND_DOT,
  SPARK: KIND_SPARK,
  RING: KIND_RING,
  SHARD: KIND_SHARD,
  SMOKE: KIND_SMOKE,
}
