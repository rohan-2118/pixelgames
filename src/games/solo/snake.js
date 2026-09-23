// src/games/solo/snake.js
//
// CYBER SNAKE OVERDRIVE — a neon serpent sim built on the shared arcade FX
// stack (ParticleField / Camera / PostFX / synth audio).
//
// What makes it more than "classic snake":
//   * The body is rendered as a smoothed spline of tapered hex capsules with a
//     travelling hue shimmer and a dashed energy seam, so movement reads as one
//     continuous creature instead of a chain of grid squares.
//   * OVERDRIVE (hold Shift) burns a boost meter for ~1.8x speed, a bloom trail
//     and motion streaks. The meter refills on its own after a short recovery
//     beat, and rare violet pellets top it straight back up.
//   * Pellets chained inside the combo window escalate a x1 -> x4 score
//     multiplier with an on-screen countdown ring; letting it lapse drops you
//     back to x1.
//
// All state is RAM-only. The only persistence is the arcade's own
// sessionStorage match-resume path via getMatchSnapshot/applyMatchSnapshot.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId) /
//   getMatchSnapshot() / applyMatchSnapshot(data) / getHudStats()
//
// This is a solo game, so `p2pContext` is always null and the peer hooks are
// no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'
import {
  THEME, FONT_MONO, FONT_UI, TAU,
  clamp, lerp, easeOutCubic,
  withAlpha, mixColor, roundRect,
  drawArenaBackdrop, drawGrid, drawGlassPanel, drawNeonText, drawTelemetry,
  drawBar, drawCanvasButton, hitRect, toCanvasPoint,
} from '../../fx/theme.js'
import { ParticleField } from '../../fx/particles.js'
import { Camera } from '../../fx/camera.js'
import { PostFX } from '../../fx/postfx.js'
import { sfx } from '../../fx/audio.js'

// -- Arena geometry ---------------------------------------------------------
// The top 44px of the canvas belongs to the arcade HUD; the telemetry strip
// starts at y=52 and the playfield only begins at y=108.
const CELL = 20
const COLS = 45
const ROWS = 19
const ARENA_W = COLS * CELL // 900
const ARENA_H = ROWS * CELL // 380
const ARENA_X = Math.round((960 - ARENA_W) / 2) // 30
const ARENA_Y = 108
const PANEL_Y = 52
const PANEL_H = 46

// -- Pace -------------------------------------------------------------------
const BASE_STEP_MS = 140
const MIN_STEP_MS = 62
const STEP_DECREMENT_MS = 12
const ITEMS_PER_SPEEDUP = 5
const BOOST_STEP_SCALE = 0.56 // step interval multiplier while boosting

// -- Scoring ----------------------------------------------------------------
const SCORE_PER_PELLET = 10
const OVERDRIVE_VALUE = 35
const MAX_MULTIPLIER = 4
const COMBO_WINDOW_MS = 3400
// Warning pips as the combo window drains (ms remaining).
const COMBO_TICK_MARKS = [1000, 620, 300]

// -- Boost ------------------------------------------------------------------
const BOOST_MAX = 100
const BOOST_DRAIN_PER_SEC = 32
const BOOST_REGEN_PER_SEC = 13
const BOOST_MIN_ENGAGE = 12 // can't re-engage below this after a full drain
const BOOST_RECOVER_DELAY_MS = 620
const OVERDRIVE_BOOST_GAIN = 46

// -- Pellets ----------------------------------------------------------------
const OVERDRIVE_TTL_MS = 9000
const OVERDRIVE_CHANCE = 0.22
const OVERDRIVE_MIN_ITEMS = 3

// -- Misc -------------------------------------------------------------------
const MAX_POPUPS = 22
const SFX_MIN_GAP_MS = 55
const PATH_SUBDIVISIONS = 3

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

const KEY_TO_DIR = {
  arrowup: DIRECTIONS.up, w: DIRECTIONS.up,
  arrowdown: DIRECTIONS.down, s: DIRECTIONS.down,
  arrowleft: DIRECTIONS.left, a: DIRECTIONS.left,
  arrowright: DIRECTIONS.right, d: DIRECTIONS.right,
}

/** Finite-number guard so a corrupt snapshot can never poison the sim. */
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

export default class SnakeGame {
  /**
   * @param {HTMLCanvasElement} canvas - Shared 960x540 arcade canvas.
   * @param {null} p2pContext - Always null for solo games.
   */
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2pContext = p2pContext
    this.p2p = p2pContext

    this.width = canvas.width || 960
    this.height = canvas.height || 540
    this.cols = COLS
    this.rows = ROWS

    this.running = false
    this.rafId = null
    this.lastTime = 0
    this.elapsed = 0

    // Shared FX stack.
    this.fx = new ParticleField({ max: 900 })
    this.camera = new Camera({ decay: 0.88, maxOffset: 22 })
    this.post = new PostFX(canvas, { accent: THEME.cyan })

    // Pre-baked colour ramps: mixColor() parses hex strings, which is far too
    // expensive to run per segment per frame on a 90-segment snake.
    this.palette = SnakeGame._buildRamp([THEME.cyan, THEME.ice, THEME.violet, THEME.magenta])
    this.boostPalette = SnakeGame._buildRamp([THEME.amber, THEME.lime, THEME.ice, THEME.amber])

    this.pointer = { x: -1, y: -1 }
    this.restartRect = null
    this.boostHeld = false
    this.boostGlow = 0
    this.scrollX = 0
    this.scrollY = 0
    this.trailClock = 0
    this._lastSfxAt = -1e9
    this._lastBoostSfxAt = -1e9

    // Bind handlers once so add/removeEventListener reference the same fn.
    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onBlur = this._onBlur.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._loop = this._loop.bind(this)

    this._resetState()
  }

  /** Sample a multi-stop hex ramp into 64 cached colours. */
  static _buildRamp(stops) {
    const ramp = new Array(64)
    const spans = stops.length - 1
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * spans
      const idx = Math.min(spans - 1, Math.floor(t))
      ramp[i] = mixColor(stops[idx], stops[idx + 1], t - idx)
    }
    return ramp
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true

    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('blur', this._onBlur)
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    this.canvas.addEventListener('pointermove', this._onPointerMove)

    this.fx.ambient(this.width, this.height, {
      count: 56,
      color: THEME.cyan,
      speed: 0.013,
      size: 1.7,
    })

    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('blur', this._onBlur)
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
    this.canvas.removeEventListener('pointermove', this._onPointerMove)

    this.boostHeld = false
    this.boosting = false
    this.restartRect = null

    this.fx.destroy()
    this.post.destroy()
    this.camera.reset()
  }

  /** Solo lane hook — this game has no lobby, so there is nothing to skip. */
  startSoloMatch() {
    this.paused = false
  }

  /** Arcade HUD telemetry. */
  getHudStats() {
    let status
    if (this.gameOver) status = 'GAME OVER'
    else if (this.paused) status = 'PAUSED'
    else if (!this.started) status = 'READY'
    else if (this.multiplier > 1) status = `x${this.multiplier} COMBO`
    else if (this.boosting) status = 'OVERDRIVE'
    else status = `LEN ${this.snake.length}`
    return { score: this.score, label: 'SCORE', status }
  }

  getMatchSnapshot() {
    return {
      kind: 'solo',
      version: 2,
      snake: cloneState(this.snake),
      prevSnake: cloneState(this.prevSnake),
      direction: cloneState(this.direction),
      pendingDirections: cloneState(this.pendingDirections),
      score: this.score,
      itemsEaten: this.itemsEaten,
      stepMs: this.stepMs,
      accumulator: this.accumulator,
      pendingGrowth: this.pendingGrowth,
      paused: this.paused,
      gameOver: this.gameOver,
      started: this.started,
      deathCause: this.deathCause,
      pellet: cloneState(this.pellet),
      overdrive: cloneState(this.overdrive),
      overdriveTtl: this.overdriveTtl,
      multiplier: this.multiplier,
      comboTimer: this.comboTimer,
      comboChain: this.comboChain,
      bestMultiplier: this.bestMultiplier,
      boost: this.boost,
      boostCooldown: this.boostCooldown,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false

    if (Array.isArray(snap.snake) && snap.snake.length) this.snake = cloneState(snap.snake)
    if (Array.isArray(snap.prevSnake) && snap.prevSnake.length) this.prevSnake = cloneState(snap.prevSnake)
    else this.prevSnake = this.snake.map((seg) => ({ ...seg }))

    if (snap.direction && typeof snap.direction === 'object') this.direction = cloneState(snap.direction)
    if (Array.isArray(snap.pendingDirections)) this.pendingDirections = cloneState(snap.pendingDirections)

    this.score = num(snap.score, this.score)
    this.itemsEaten = num(snap.itemsEaten, this.itemsEaten)
    this.stepMs = clamp(num(snap.stepMs, this.stepMs), MIN_STEP_MS, BASE_STEP_MS)
    this.accumulator = clamp(num(snap.accumulator, 0), 0, BASE_STEP_MS)
    this.pendingGrowth = Math.max(0, num(snap.pendingGrowth, 0))

    if (typeof snap.paused === 'boolean') this.paused = snap.paused
    if (typeof snap.gameOver === 'boolean') this.gameOver = snap.gameOver
    if (typeof snap.started === 'boolean') this.started = snap.started
    if (typeof snap.deathCause === 'string' || snap.deathCause === null) this.deathCause = snap.deathCause

    // `food` is the pre-Overdrive field name — accept it so an in-flight
    // session-resume snapshot from the old build still loads.
    const pellet = snap.pellet || snap.food
    if (pellet && typeof pellet === 'object') this.pellet = cloneState(pellet)
    this.overdrive = snap.overdrive && typeof snap.overdrive === 'object' ? cloneState(snap.overdrive) : null
    this.overdriveTtl = Math.max(0, num(snap.overdriveTtl, 0))

    this.multiplier = clamp(Math.round(num(snap.multiplier, 1)), 1, MAX_MULTIPLIER)
    this.comboTimer = clamp(num(snap.comboTimer, 0), 0, COMBO_WINDOW_MS)
    this.comboChain = Math.max(0, num(snap.comboChain, 0))
    this.bestMultiplier = clamp(Math.round(num(snap.bestMultiplier, this.multiplier)), 1, MAX_MULTIPLIER)
    this.boost = clamp(num(snap.boost, BOOST_MAX), 0, BOOST_MAX)
    this.boostCooldown = Math.max(0, num(snap.boostCooldown, 0))

    // Transient presentation state never round-trips through the snapshot.
    this.boosting = false
    this.boostHeld = false
    this.boostGlow = 0
    this.deathTimer = this.gameOver ? 1200 : 0
    this.popups = []
    this.comboTickIndex = COMBO_TICK_MARKS.findIndex((mark) => this.comboTimer > mark)
    if (this.comboTickIndex < 0) this.comboTickIndex = COMBO_TICK_MARKS.length
    return true
  }

  onPeerAction() {
    /* Solo game — no peer traffic. */
  }

  onPeerJoin() {
    /* Solo game — no peers. */
  }

  onPeerLeave() {
    /* Solo game — no peers. */
  }

  // --------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------

  _resetState() {
    const startX = Math.floor(COLS / 2) - 4
    const startY = Math.floor(ROWS / 2)

    this.snake = [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ]
    this.prevSnake = this.snake.map((seg) => ({ ...seg }))
    this.direction = { ...DIRECTIONS.right }
    this.pendingDirections = []
    this.pendingGrowth = 0

    this.score = 0
    this.itemsEaten = 0
    this.stepMs = BASE_STEP_MS
    this.accumulator = 0

    this.multiplier = 1
    this.bestMultiplier = 1
    this.comboTimer = 0
    this.comboChain = 0
    this.comboTickIndex = COMBO_TICK_MARKS.length

    this.boost = BOOST_MAX
    this.boosting = false
    this.boostCooldown = 0
    this.boostGlow = 0
    this.trailClock = 0

    this.paused = false
    this.gameOver = false
    this.deathCause = null
    this.deathTimer = 0
    // The serpent idles until the player steers — no surprise "auto-drove into
    // a wall" losses before anyone has touched a key.
    this.started = false

    this.popups = []
    this.overdrive = null
    this.overdriveTtl = 0
    this.pellet = this._spawnPellet()
    this.restartRect = null
  }

  /** Full local restart (death screen button / R with no arcade HUD bound). */
  _restart() {
    this.fx.clear()
    this.camera.reset()
    this._resetState()
  }

  _isFree(x, y) {
    if (this.snake.some((seg) => seg.x === x && seg.y === y)) return false
    if (this.pellet && this.pellet.x === x && this.pellet.y === y) return false
    if (this.overdrive && this.overdrive.x === x && this.overdrive.y === y) return false
    return true
  }

  _spawnPellet() {
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = Math.floor(Math.random() * COLS)
      const y = Math.floor(Math.random() * ROWS)
      if (this._isFree(x, y)) return { x, y, seed: Math.random() * TAU }
    }
    // Saturated board — fall back to the first free cell we can find.
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (this._isFree(x, y)) return { x, y, seed: Math.random() * TAU }
      }
    }
    return { x: 0, y: 0, seed: 0 }
  }

  _maybeSpawnOverdrive() {
    if (this.overdrive) return
    if (this.itemsEaten < OVERDRIVE_MIN_ITEMS) return
    if (Math.random() > OVERDRIVE_CHANCE) return
    this.overdrive = this._spawnPellet()
    this.overdriveTtl = OVERDRIVE_TTL_MS
    this.fx.ring(this._cx(this.overdrive.x), this._cy(this.overdrive.y), {
      radius: 42, color: THEME.violet, life: 620, width: 3,
    })
  }

  // --------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------

  _onKeyDown(event) {
    // The arcade HUD owns R / Esc at capture phase; if it already claimed the
    // key, the shell is remounting us and we must not also reset locally.
    if (event.defaultPrevented) return
    sfx.unlock()

    const raw = typeof event.key === 'string' ? event.key : ''
    const key = raw.toLowerCase()

    if (event.shiftKey || raw === 'Shift') this.boostHeld = true

    if (this.gameOver) {
      if (key === 'r') {
        event.preventDefault()
        this._restart()
      }
      return
    }

    if (key === 'p' && this.started) {
      event.preventDefault()
      this.paused = !this.paused
      sfx.ui()
      return
    }

    if (this.paused) return

    const dir = KEY_TO_DIR[key]
    if (!dir) return
    event.preventDefault()

    // Never allow a direct 180° reversal into the serpent's own neck.
    const last = this.pendingDirections[this.pendingDirections.length - 1] || this.direction
    if (dir.x === -last.x && dir.y === -last.y) return
    if (dir.x === last.x && dir.y === last.y) return

    // Cap the queue so rapid key mashing can't desync input from ticks.
    if (this.pendingDirections.length < 2) this.pendingDirections.push({ ...dir })

    // The very first steer kicks off motion.
    if (!this.started) {
      this.started = true
      this.accumulator = 0
      sfx.confirm()
    }
  }

  _onKeyUp(event) {
    const raw = typeof event.key === 'string' ? event.key : ''
    if (raw === 'Shift' || !event.shiftKey) this.boostHeld = false
  }

  _onBlur() {
    this.boostHeld = false
  }

  _onPointerMove(event) {
    this.pointer = toCanvasPoint(this.canvas, event, this.width, this.height)
  }

  _onPointerDown(event) {
    sfx.unlock()
    this.pointer = toCanvasPoint(this.canvas, event, this.width, this.height)
    if (this.gameOver && this.restartRect && hitRect(this.pointer, this.restartRect)) {
      sfx.confirm()
      this._restart()
    }
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = clamp(now - this.lastTime, 0, 64) // clamp to avoid catch-up jumps
    this.lastTime = now
    this.elapsed += dt

    this._update(dt)
    this._render(this._alpha())

    this.rafId = requestAnimationFrame(this._loop)
  }

  /** Effective ms between grid steps, accounting for boost. */
  _stepInterval() {
    const base = clamp(this.stepMs, MIN_STEP_MS, BASE_STEP_MS)
    return this.boosting ? base * BOOST_STEP_SCALE : base
  }

  /** 0..1 interpolation factor between the previous and current grid cells. */
  _alpha() {
    if (this.gameOver || this.paused || !this.started) return 1
    return clamp(this.accumulator / this._stepInterval(), 0, 1)
  }

  _update(dt) {
    this.fx.update(dt)
    this.camera.update(dt)
    this._updatePopups(dt)
    this._updateBoost(dt)
    this._updateParallax(dt)

    if (this.gameOver) {
      this.deathTimer += dt
      return
    }
    if (!this.started || this.paused) return

    this._updateCombo(dt)
    this._updateOverdrivePellet(dt)

    this.accumulator += dt
    let guard = 0
    while (this.accumulator >= this._stepInterval() && !this.gameOver && guard++ < 8) {
      this.accumulator -= this._stepInterval()
      this._step()
    }
    if (this.gameOver) this.accumulator = 0

    if (this.boosting) this._emitBoostTrail(dt)
  }

  _updateBoost(dt) {
    const canBoost =
      this.boostHeld &&
      this.started &&
      !this.paused &&
      !this.gameOver &&
      this.boost > 0 &&
      (this.boosting || (this.boost >= BOOST_MIN_ENGAGE && this.boostCooldown <= 0))

    if (canBoost) {
      if (!this.boosting && this.elapsed - this._lastBoostSfxAt > 420) {
        this._lastBoostSfxAt = this.elapsed
        sfx.swipe(true)
      }
      this.boosting = true
      this.boost = clamp(this.boost - (BOOST_DRAIN_PER_SEC * dt) / 1000, 0, BOOST_MAX)
      if (this.boost <= 0) {
        this.boost = 0
        this.boosting = false
        this.boostCooldown = BOOST_RECOVER_DELAY_MS
      }
    } else {
      this.boosting = false
      if (this.boostCooldown > 0) {
        this.boostCooldown = Math.max(0, this.boostCooldown - dt)
      } else if (!this.paused && !this.gameOver) {
        this.boost = clamp(this.boost + (BOOST_REGEN_PER_SEC * dt) / 1000, 0, BOOST_MAX)
      }
    }

    const target = this.boosting ? 1 : 0
    this.boostGlow = lerp(this.boostGlow, target, clamp(dt / 110, 0, 1))
  }

  _updateCombo(dt) {
    if (this.comboTimer <= 0) return
    this.comboTimer = Math.max(0, this.comboTimer - dt)

    // Discrete warning pips — one per threshold crossing, never per frame.
    while (
      this.comboTickIndex < COMBO_TICK_MARKS.length &&
      this.comboTimer <= COMBO_TICK_MARKS[this.comboTickIndex]
    ) {
      if (this.multiplier > 1 && this.comboTimer > 0) sfx.tick(this.comboTickIndex >= 2)
      this.comboTickIndex++
    }

    if (this.comboTimer === 0) {
      if (this.multiplier > 1) {
        const head = this._headPixel(1)
        this.fx.ring(head.x, head.y, { radius: 34, color: THEME.textFaint, life: 420, width: 1.6 })
      }
      this.multiplier = 1
      this.comboChain = 0
    }
  }

  _updateOverdrivePellet(dt) {
    if (!this.overdrive) return
    this.overdriveTtl -= dt
    if (this.overdriveTtl > 0) return
    const px = this._cx(this.overdrive.x)
    const py = this._cy(this.overdrive.y)
    this.fx.burst(px, py, { count: 10, color: THEME.violet, speed: 0.12, life: 380, size: 2, ring: false })
    this.overdrive = null
    this.overdriveTtl = 0
  }

  _updateParallax(dt) {
    const speed = this.started && !this.paused && !this.gameOver ? 1 : 0.25
    const gain = (this.boosting ? 2.8 : 1) * speed * dt * 0.022
    this.scrollX -= this.direction.x * gain
    this.scrollY -= this.direction.y * gain
    if (!Number.isFinite(this.scrollX)) this.scrollX = 0
    if (!Number.isFinite(this.scrollY)) this.scrollY = 0
  }

  _emitBoostTrail(dt) {
    this.trailClock += dt
    const head = this._headPixel(this._alpha())
    const ramp = this.boostPalette
    while (this.trailClock >= 20) {
      this.trailClock -= 20
      this.fx.trail(head.x, head.y, {
        color: ramp[Math.floor(this.elapsed * 0.05) & 63],
        size: 5.6,
        life: 340,
        drift: 0.04,
        alpha: 0.55,
      })
    }
  }

  // --------------------------------------------------------------------
  // Simulation
  // --------------------------------------------------------------------

  _step() {
    if (this.pendingDirections.length) {
      this.direction = this.pendingDirections.shift()
    }

    this.prevSnake = this.snake.map((seg) => ({ ...seg }))

    const head = this.snake[0]
    if (!head) return
    const next = { x: head.x + this.direction.x, y: head.y + this.direction.y }

    if (next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS) {
      this._die('wall', next)
      return
    }

    const eatPellet = !!this.pellet && next.x === this.pellet.x && next.y === this.pellet.y
    const eatOverdrive = !!this.overdrive && next.x === this.overdrive.x && next.y === this.overdrive.y

    // If the body isn't growing this step the tail vacates its cell, so
    // stepping onto the current tail is legal.
    const growsThisStep = this.pendingGrowth > 0 || eatPellet || eatOverdrive
    const body = growsThisStep ? this.snake : this.snake.slice(0, -1)
    if (body.some((seg) => seg.x === next.x && seg.y === next.y)) {
      this._die('self', next)
      return
    }

    this.snake.unshift(next)

    if (eatPellet) {
      this.pendingGrowth += 1
      this._collect(this.pellet, false)
      this.pellet = this._spawnPellet()
      this._maybeSpawnOverdrive()
    }
    if (eatOverdrive) {
      this.pendingGrowth += 2
      this._collect(this.overdrive, true)
      this.overdrive = null
      this.overdriveTtl = 0
    }

    if (this.pendingGrowth > 0) {
      this.pendingGrowth -= 1
      // Duplicate the old tail in prevSnake so the newly grown segment doesn't
      // visually teleport in from nowhere during interpolation.
      const tail = this.prevSnake[this.prevSnake.length - 1]
      if (tail) this.prevSnake.push({ ...tail })
    } else {
      this.snake.pop()
    }
  }

  /**
   * Award a pellet. Chaining inside the combo window steps the multiplier up
   * one notch (capped); letting the window lapse drops straight back to x1.
   */
  _collect(cell, isOverdrive) {
    const px = this._cx(cell.x)
    const py = this._cy(cell.y)
    const previousMultiplier = this.multiplier

    if (this.comboTimer > 0) {
      this.multiplier = Math.min(MAX_MULTIPLIER, this.multiplier + 1)
      this.comboChain += 1
    } else {
      this.multiplier = 1
      this.comboChain = 1
    }
    this.comboTimer = COMBO_WINDOW_MS
    this.comboTickIndex = 0
    this.bestMultiplier = Math.max(this.bestMultiplier, this.multiplier)

    const base = isOverdrive ? OVERDRIVE_VALUE : SCORE_PER_PELLET
    const gained = base * this.multiplier
    this.score += gained
    this.itemsEaten += 1

    if (isOverdrive) {
      this.boost = clamp(this.boost + OVERDRIVE_BOOST_GAIN, 0, BOOST_MAX)
      this.boostCooldown = 0
    }

    // Difficulty ramps with how much you've eaten (and so with length).
    this.stepMs = Math.max(
      MIN_STEP_MS,
      BASE_STEP_MS - Math.floor(this.itemsEaten / ITEMS_PER_SPEEDUP) * STEP_DECREMENT_MS
    )

    const color = isOverdrive ? THEME.violet : THEME.lime
    const secondary = isOverdrive ? THEME.magenta : THEME.cyan
    this.fx.burst(px, py, {
      count: isOverdrive ? 30 : 18,
      color,
      secondary,
      speed: isOverdrive ? 0.3 : 0.2,
      life: isOverdrive ? 620 : 460,
      size: isOverdrive ? 3.2 : 2.4,
      gravity: 0,
      ring: true,
      shards: isOverdrive ? 6 : 0,
    })
    this.fx.ring(px, py, { radius: isOverdrive ? 54 : 34, color: secondary, life: 420, width: 2.2 })

    this._popup(px, py - 6, `+${gained}`, color, isOverdrive ? 22 : 18)
    if (this.multiplier > previousMultiplier && this.multiplier > 1) {
      this._popup(px, py - 30, `x${this.multiplier}`, THEME.amber, 20)
    }

    this.camera.impact({
      strength: isOverdrive ? 10 : 4.5,
      punch: isOverdrive ? 1.032 : 1.012,
      color: isOverdrive ? THEME.violet : null,
    })

    if (this.elapsed - this._lastSfxAt > SFX_MIN_GAP_MS) {
      this._lastSfxAt = this.elapsed
      sfx.pickup(this.multiplier - 1 + (isOverdrive ? 3 : 0))
      if (this.multiplier > previousMultiplier && this.multiplier > 1) sfx.combo(this.multiplier)
    }
  }

  _die(cause, cell) {
    if (this.gameOver) return
    this.gameOver = true
    this.deathCause = cause
    this.deathTimer = 0
    this.boosting = false
    this.boostHeld = false
    this.multiplier = 1
    this.comboTimer = 0
    this.comboChain = 0
    this.accumulator = 0

    const px = this._cx(clamp(cell ? cell.x : this.snake[0].x, 0, COLS - 1))
    const py = this._cy(clamp(cell ? cell.y : this.snake[0].y, 0, ROWS - 1))

    this.fx.burst(px, py, {
      count: 42, color: THEME.magenta, secondary: THEME.amber,
      speed: 0.42, life: 780, size: 3.4, gravity: 0.00012, ring: true, shards: 10,
    })
    this.fx.smoke(px, py, { count: 9, color: '#2a1a2e', life: 1100, size: 13 })
    // Blow the body apart along its own length.
    for (let i = 0; i < this.snake.length; i += 3) {
      const seg = this.snake[i]
      this.fx.burst(this._cx(seg.x), this._cy(seg.y), {
        count: 4, color: i % 2 ? THEME.cyan : THEME.violet,
        speed: 0.16, life: 520, size: 2.2, ring: false,
      })
    }

    this.camera.impact({ strength: 24, color: THEME.magenta, punch: 1.055 })
    this.camera.flash(THEME.magenta, 0.3)
    sfx.death()
  }

  // --------------------------------------------------------------------
  // Popups
  // --------------------------------------------------------------------

  _popup(x, y, text, color, size = 18) {
    if (this.popups.length >= MAX_POPUPS) this.popups.shift()
    this.popups.push({ x, y, text, color, size, life: 880, maxLife: 880, vy: -0.042 })
  }

  _updatePopups(dt) {
    if (!this.popups.length) return
    for (const p of this.popups) {
      p.y += p.vy * dt
      p.life -= dt
    }
    this.popups = this.popups.filter((p) => p.life > 0)
  }

  // --------------------------------------------------------------------
  // Geometry helpers
  // --------------------------------------------------------------------

  _cx(gridX) {
    return ARENA_X + gridX * CELL + CELL / 2
  }

  _cy(gridY) {
    return ARENA_Y + gridY * CELL + CELL / 2
  }

  /** Interpolated head position in canvas pixels. */
  _headPixel(alpha) {
    const cur = this.snake[0]
    if (!cur) return { x: this._cx(0), y: this._cy(0) }
    const prev = this.prevSnake[0] || cur
    const a = clamp(num(alpha, 1), 0, 1)
    return {
      x: this._cx(lerp(prev.x, cur.x, a)),
      y: this._cy(lerp(prev.y, cur.y, a)),
    }
  }

  /** Interpolated centre of every segment, head first. */
  _bodyPoints(alpha) {
    const a = clamp(num(alpha, 1), 0, 1)
    const pts = []
    for (let i = 0; i < this.snake.length; i++) {
      const cur = this.snake[i]
      const prev = this.prevSnake[i] || cur
      pts.push({
        x: this._cx(lerp(prev.x, cur.x, a)),
        y: this._cy(lerp(prev.y, cur.y, a)),
      })
    }
    return pts
  }

  /**
   * Catmull-Rom subdivision. Collinear runs stay straight while 90° turns
   * round off, which is what turns a grid crawl into a creature.
   */
  _smoothPath(pts, sub = PATH_SUBDIVISIONS) {
    if (pts.length < 3) return pts.slice()
    const out = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] || p2
      for (let s = 1; s <= sub; s++) {
        const t = s / sub
        const t2 = t * t
        const t3 = t2 * t
        out.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        })
      }
    }
    return out
  }

  /** Thickness profile: full through the torso, tapering into the tail. */
  _taper(index, total) {
    const fromTail = total - 1 - index
    const span = clamp(Math.floor(total * 0.34), 2, 8)
    let t = 1
    if (fromTail < span) t = 0.3 + 0.7 * easeOutCubic((fromTail + 0.7) / span)
    if (index === 0) return Math.max(t, 1.1)
    if (index === 1) return Math.max(t, 1.02)
    return t
  }

  _segColor(index) {
    const ramp = this.boostGlow > 0.5 ? this.boostPalette : this.palette
    const i = Math.floor(index * 1.8 + this.elapsed * 0.03) % 64
    return ramp[i < 0 ? i + 64 : i]
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render(alpha) {
    const ctx = this.ctx

    drawArenaBackdrop(ctx, this.width, this.height, {
      base: THEME.bg,
      step: 48,
      glowColor: THEME.cyan,
      glowAlpha: 0.045,
    })
    this._drawParallax(ctx)
    this.fx.drawAmbient(ctx)

    this.camera.begin(ctx, this.width, this.height)
    this._drawArena(ctx)
    this._drawPellets(ctx)
    this._drawSnake(ctx, alpha)
    this.fx.draw(ctx)
    this._drawPopups(ctx)
    this.camera.end(ctx)
    this.camera.drawFlash(ctx, this.width, this.height)

    this._drawBoostPanel(ctx)
    this._drawComboPanel(ctx)
    this._drawTelemetryPanel(ctx)
    this._drawFooter(ctx)

    if (!this.started && !this.gameOver) this._drawIntro(ctx)
    if (this.paused && !this.gameOver) this._drawPaused(ctx)
    if (this.gameOver) this._drawGameOver(ctx)

    this.post.bloom(ctx)
    this.post.finish(ctx, this.elapsed)
  }

  _drawParallax(ctx) {
    const far = 96
    const near = 32
    const fx = ((this.scrollX * 0.28) % far + far) % far
    const fy = ((this.scrollY * 0.28) % far + far) % far

    ctx.save()
    ctx.globalAlpha = 0.65
    drawGrid(ctx, {
      x: fx - far, y: fy - far,
      w: this.width + far * 2, h: this.height + far * 2,
      step: far,
      color: withAlpha(THEME.cyan, 0.035),
      major: 0,
    })
    ctx.restore()

    // Mid layer runs the other way for depth separation.
    const mx = ((-this.scrollX * 0.55) % near + near) % near
    const my = ((-this.scrollY * 0.55) % near + near) % near
    ctx.save()
    ctx.globalAlpha = 0.5
    drawGrid(ctx, {
      x: mx - near, y: my - near,
      w: this.width + near * 2, h: this.height + near * 2,
      step: near,
      color: withAlpha(THEME.violet, 0.022),
      major: 0,
    })
    ctx.restore()
  }

  _drawArena(ctx) {
    const x = ARENA_X - 8
    const y = ARENA_Y - 8
    const w = ARENA_W + 16
    const h = ARENA_H + 16

    ctx.save()
    roundRect(ctx, x, y, w, h, 16)
    ctx.fillStyle = 'rgba(5, 7, 13, 0.62)'
    ctx.fill()
    ctx.clip()

    // Playfield grid, scrolling with the serpent for a sense of travel.
    const ox = ((this.scrollX * 0.9) % CELL + CELL) % CELL
    const oy = ((this.scrollY * 0.9) % CELL + CELL) % CELL
    drawGrid(ctx, {
      x: ARENA_X + ox - CELL, y: ARENA_Y + oy - CELL,
      w: ARENA_W + CELL * 2, h: ARENA_H + CELL * 2,
      step: CELL,
      color: withAlpha(THEME.cyan, 0.042),
      major: 5,
      majorColor: withAlpha(THEME.cyan, 0.085),
    })

    // Slow horizontal scan sweep.
    const sweepX = ARENA_X + ((this.elapsed * 0.075) % (ARENA_W + 320)) - 160
    const sweep = ctx.createLinearGradient(sweepX - 130, 0, sweepX + 130, 0)
    sweep.addColorStop(0, 'rgba(0,240,255,0)')
    sweep.addColorStop(0.5, withAlpha(THEME.cyan, 0.05))
    sweep.addColorStop(1, 'rgba(0,240,255,0)')
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = sweep
    ctx.fillRect(ARENA_X - 8, ARENA_Y - 8, ARENA_W + 16, ARENA_H + 16)
    ctx.restore()

    // Kill-wall warning wash: brighter the closer the head is to an edge.
    const head = this.snake[0]
    if (head) {
      const margin = Math.min(head.x, COLS - 1 - head.x, head.y, ROWS - 1 - head.y)
      const danger = clamp(1 - margin / 3, 0, 1) * 0.5
      if (danger > 0.01) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = withAlpha(THEME.magenta, danger * (0.55 + 0.45 * Math.sin(this.elapsed * 0.01)))
        ctx.lineWidth = 10
        roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 13)
        ctx.stroke()
        ctx.restore()
      }
    }

    // Neon frame + corner brackets.
    ctx.save()
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.38)
    ctx.lineWidth = 1.5
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 16)
    ctx.stroke()
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.85)
    ctx.lineWidth = 2.5
    ctx.shadowColor = withAlpha(THEME.cyan, 0.6)
    ctx.shadowBlur = 12
    const c = 26
    const corners = [
      [x, y, 1, 1], [x + w, y, -1, 1],
      [x, y + h, 1, -1], [x + w, y + h, -1, -1],
    ]
    for (const [px, py, sx, sy] of corners) {
      ctx.beginPath()
      ctx.moveTo(px + sx * c, py)
      ctx.lineTo(px + sx * 12, py)
      ctx.moveTo(px, py + sy * c)
      ctx.lineTo(px, py + sy * 12)
      ctx.stroke()
    }
    ctx.restore()
  }

  _drawPellets(ctx) {
    if (this.pellet) this._drawPellet(ctx, this.pellet, false)
    if (this.overdrive) this._drawPellet(ctx, this.overdrive, true)
  }

  _drawPellet(ctx, cell, isOverdrive) {
    const t = this.elapsed
    const seed = num(cell.seed, 0)
    const head = this.snake[0]

    // Subtle attract wobble: a little idle float plus a lean toward the head.
    let ax = 0
    let ay = 0
    if (head) {
      const dx = head.x - cell.x
      const dy = head.y - cell.y
      const d = Math.hypot(dx, dy) || 1
      const pull = clamp(1 - d / 9, 0, 1) * 2.4
      ax = (dx / d) * pull
      ay = (dy / d) * pull
    }
    const wob = 1.7
    const cx = this._cx(cell.x) + Math.sin(t * 0.0035 + seed) * wob + ax * (0.6 + 0.4 * Math.sin(t * 0.004))
    const cy = this._cy(cell.y) + Math.cos(t * 0.0029 + seed * 1.7) * wob + ay * (0.6 + 0.4 * Math.sin(t * 0.004))

    const color = isOverdrive ? THEME.violet : THEME.lime
    const accent = isOverdrive ? THEME.magenta : THEME.cyan
    const pulse = 0.82 + Math.sin(t * 0.0065 + seed) * 0.18
    const core = (isOverdrive ? 7.2 : 5.4) * pulse

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // Soft halo.
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 3.6)
    halo.addColorStop(0, withAlpha(color, 0.55))
    halo.addColorStop(0.45, withAlpha(color, 0.16))
    halo.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(cx, cy, core * 3.6, 0, TAU)
    ctx.fill()

    // Expanding glow ring.
    const ringT = ((t + seed * 400) % 1400) / 1400
    ctx.globalAlpha = (1 - ringT) * 0.55
    ctx.strokeStyle = accent
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.arc(cx, cy, core + ringT * (isOverdrive ? 26 : 18), 0, TAU)
    ctx.stroke()
    ctx.globalAlpha = 1

    if (isOverdrive) {
      // Counter-rotating hex cage + remaining-life arc.
      const spin = t * 0.0016
      for (let ring = 0; ring < 2; ring++) {
        const r = core + 5 + ring * 5
        const dir = ring ? -1 : 1
        ctx.strokeStyle = withAlpha(ring ? accent : color, 0.85)
        ctx.lineWidth = 1.6
        ctx.beginPath()
        for (let i = 0; i <= 6; i++) {
          const a = spin * dir + (i / 6) * TAU
          const px = cx + Math.cos(a) * r
          const py = cy + Math.sin(a) * r
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.stroke()
      }
      const ttl = clamp(this.overdriveTtl / OVERDRIVE_TTL_MS, 0, 1)
      ctx.strokeStyle = withAlpha(THEME.amber, 0.9)
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.arc(cx, cy, core + 14, -Math.PI / 2, -Math.PI / 2 + TAU * ttl)
      ctx.stroke()
    } else {
      // Three orbiting motes.
      for (let i = 0; i < 3; i++) {
        const a = t * 0.0042 + seed + (i / 3) * TAU
        const r = core + 7
        ctx.fillStyle = withAlpha(accent, 0.75)
        ctx.beginPath()
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.5, 0, TAU)
        ctx.fill()
      }
    }

    // Faceted core.
    ctx.shadowColor = withAlpha(color, 0.9)
    ctx.shadowBlur = 18
    ctx.fillStyle = color
    ctx.beginPath()
    const faces = isOverdrive ? 6 : 4
    const rot = isOverdrive ? -t * 0.0022 : t * 0.0018
    for (let i = 0; i <= faces; i++) {
      const a = rot + (i / faces) * TAU
      const px = cx + Math.cos(a) * core
      const py = cy + Math.sin(a) * core
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = withAlpha(THEME.text, 0.9)
    ctx.beginPath()
    ctx.arc(cx, cy, core * 0.34, 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  _drawSnake(ctx, alpha) {
    const n = this.snake.length
    if (!n) return

    const pts = this._bodyPoints(alpha)
    const path = this._smoothPath(pts)
    if (!path.length) return

    const dying = this.gameOver ? clamp(this.deathTimer / 700, 0, 1) : 0
    const bodyAlpha = 1 - dying * 0.72
    const glowColor = this.boostGlow > 0.5 ? THEME.amber : THEME.cyan

    // 1) Wide soft underglow along the whole spline — the bloom's food source.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.2 * bodyAlpha
    ctx.strokeStyle = withAlpha(glowColor, 0.6)
    ctx.lineWidth = CELL * (1.02 + this.boostGlow * 0.3)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(path[0].x, path[0].y)
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
    ctx.stroke()
    ctx.restore()

    // 2) Segment capsules, tail first so the head always sits on top.
    ctx.save()
    ctx.globalAlpha = bodyAlpha
    ctx.lineJoin = 'round'
    for (let i = n - 1; i >= 1; i--) {
      const j = Math.min(i * PATH_SUBDIVISIONS, path.length - 1)
      const p = path[j]
      const a = path[Math.max(0, j - 1)]
      const b = path[Math.min(path.length - 1, j + 1)]
      let tx = b.x - a.x
      let ty = b.y - a.y
      const len = Math.hypot(tx, ty)
      if (len < 0.0001) { tx = 1; ty = 0 } else { tx /= len; ty /= len }

      const taper = this._taper(i, n)
      const r = CELL * 0.4 * taper
      const half = CELL * 0.5 * (0.6 + taper * 0.4)
      const color = this._segColor(i)

      this._capsulePath(ctx, p.x, p.y, tx, ty, half, r)
      ctx.fillStyle = color
      ctx.shadowColor = withAlpha(color, 0.55)
      ctx.shadowBlur = 9 + this.boostGlow * 6
      ctx.fill()
      ctx.shadowBlur = 0

      // Hairline plating edge.
      ctx.strokeStyle = withAlpha('#05070d', 0.55)
      ctx.lineWidth = 1
      ctx.stroke()

      // Inner highlight running down the spine.
      ctx.fillStyle = withAlpha(THEME.text, 0.16 + 0.12 * this.boostGlow)
      ctx.beginPath()
      ctx.ellipse(
        p.x - ty * r * 0.34, p.y + tx * r * 0.34,
        half * 0.5, r * 0.22,
        Math.atan2(ty, tx), 0, TAU
      )
      ctx.fill()
    }
    ctx.restore()

    // 3) Dashed energy seam flowing head-to-tail.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = (0.5 + 0.3 * this.boostGlow) * bodyAlpha
    ctx.strokeStyle = withAlpha(this.boostGlow > 0.5 ? THEME.amber : THEME.ice, 0.9)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.setLineDash([7, 11])
    ctx.lineDashOffset = -this.elapsed * 0.06
    ctx.beginPath()
    ctx.moveTo(path[0].x, path[0].y)
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    // 4) Motion streaks behind the head while boosting.
    if (this.boostGlow > 0.02) this._drawMotionStreaks(ctx, path)

    // 5) Head.
    this._drawHead(ctx, path, bodyAlpha)
  }

  /** Elongated octagonal capsule oriented along (tx, ty). */
  _capsulePath(ctx, x, y, tx, ty, half, r) {
    const nx = -ty
    const ny = tx
    const pt = (u, v) => [x + tx * u + nx * v, y + ty * u + ny * v]
    const corners = [
      pt(half, r * 0.4), pt(half * 0.5, r), pt(-half * 0.5, r), pt(-half, r * 0.4),
      pt(-half, -r * 0.4), pt(-half * 0.5, -r), pt(half * 0.5, -r), pt(half, -r * 0.4),
    ]
    ctx.beginPath()
    ctx.moveTo(corners[0][0], corners[0][1])
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1])
    ctx.closePath()
  }

  _drawMotionStreaks(ctx, path) {
    const head = path[0]
    const nextPt = path[Math.min(path.length - 1, 2)]
    let tx = head.x - nextPt.x
    let ty = head.y - nextPt.y
    const len = Math.hypot(tx, ty)
    if (len < 0.0001) return
    tx /= len
    ty /= len
    const nx = -ty
    const ny = tx

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      const phase = ((this.elapsed * 0.45 + i * 21) % 96) / 96
      const dist = 14 + phase * 74
      const side = (i % 2 ? 1 : -1) * (4 + (i % 3) * 3.5)
      const fade = (1 - phase) * this.boostGlow * 0.75
      if (fade <= 0.01) continue
      ctx.globalAlpha = fade
      ctx.strokeStyle = i % 2 ? withAlpha(THEME.amber, 0.9) : withAlpha(THEME.cyan, 0.9)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(head.x - tx * dist + nx * side, head.y - ty * dist + ny * side)
      ctx.lineTo(head.x - tx * (dist + 20) + nx * side, head.y - ty * (dist + 20) + ny * side)
      ctx.stroke()
    }
    ctx.restore()
  }

  _drawHead(ctx, path, bodyAlpha) {
    const p = path[0]
    const ref = path[Math.min(path.length - 1, 1)]
    let tx = p.x - ref.x
    let ty = p.y - ref.y
    const len = Math.hypot(tx, ty)
    if (len < 0.0001) {
      tx = this.direction.x
      ty = this.direction.y
    } else {
      tx /= len
      ty /= len
    }
    const nx = -ty
    const ny = tx
    const r = CELL * 0.46
    const accent = this.boostGlow > 0.5 ? THEME.amber : THEME.cyan

    // Directional glow cone.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = (0.22 + 0.26 * this.boostGlow) * bodyAlpha
    const reach = 74 + this.boostGlow * 56
    const cone = ctx.createLinearGradient(p.x, p.y, p.x + tx * reach, p.y + ty * reach)
    cone.addColorStop(0, withAlpha(accent, 0.55))
    cone.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = cone
    ctx.beginPath()
    ctx.moveTo(p.x + nx * r * 0.85, p.y + ny * r * 0.85)
    ctx.lineTo(p.x + tx * reach + nx * (r * 2.1), p.y + ty * reach + ny * (r * 2.1))
    ctx.lineTo(p.x + tx * reach - nx * (r * 2.1), p.y + ty * reach - ny * (r * 2.1))
    ctx.lineTo(p.x - nx * r * 0.85, p.y - ny * r * 0.85)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // Combo countdown ring orbiting the head.
    if (this.comboTimer > 0 && this.multiplier > 1) {
      const frac = clamp(this.comboTimer / COMBO_WINDOW_MS, 0, 1)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = withAlpha(THEME.amber, 0.22)
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 8, 0, TAU)
      ctx.stroke()
      ctx.strokeStyle = withAlpha(THEME.amber, 0.95)
      ctx.shadowColor = withAlpha(THEME.amber, 0.8)
      ctx.shadowBlur = 12
      ctx.lineWidth = 2.8
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * frac)
      ctx.stroke()
      ctx.restore()
    }

    // Skull plate: pointed nose + swept flanks.
    const pt = (u, v) => [p.x + tx * u + nx * v, p.y + ty * u + ny * v]
    const shell = [
      pt(r * 1.5, 0), pt(r * 0.95, r * 0.8), pt(-r * 0.2, r * 1.02),
      pt(-r * 1.05, r * 0.66), pt(-r * 1.05, -r * 0.66), pt(-r * 0.2, -r * 1.02),
      pt(r * 0.95, -r * 0.8),
    ]

    ctx.save()
    ctx.globalAlpha = bodyAlpha
    ctx.beginPath()
    ctx.moveTo(shell[0][0], shell[0][1])
    for (let i = 1; i < shell.length; i++) ctx.lineTo(shell[i][0], shell[i][1])
    ctx.closePath()
    const plate = ctx.createLinearGradient(
      p.x - tx * r, p.y - ty * r,
      p.x + tx * r * 1.5, p.y + ty * r * 1.5
    )
    plate.addColorStop(0, this._segColor(0))
    plate.addColorStop(1, this.boostGlow > 0.5 ? THEME.amber : THEME.ice)
    ctx.fillStyle = plate
    ctx.shadowColor = withAlpha(accent, 0.9)
    ctx.shadowBlur = 20
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = withAlpha('#05070d', 0.7)
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Visor slit.
    ctx.fillStyle = 'rgba(4, 8, 16, 0.86)'
    ctx.beginPath()
    const visor = [pt(r * 0.72, r * 0.62), pt(r * 0.2, r * 0.74), pt(r * 0.2, -r * 0.74), pt(r * 0.72, -r * 0.62)]
    ctx.moveTo(visor[0][0], visor[0][1])
    for (let i = 1; i < visor.length; i++) ctx.lineTo(visor[i][0], visor[i][1])
    ctx.closePath()
    ctx.fill()

    // Eyes.
    const eyeColor = this.gameOver ? THEME.magenta : this.boostGlow > 0.5 ? THEME.amber : THEME.cyan
    ctx.shadowColor = withAlpha(eyeColor, 0.95)
    ctx.shadowBlur = 12
    ctx.fillStyle = eyeColor
    for (const s of [1, -1]) {
      const [ex, ey] = pt(r * 0.48, s * r * 0.46)
      ctx.beginPath()
      ctx.ellipse(ex, ey, r * 0.2, r * 0.13, Math.atan2(ty, tx), 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  _drawPopups(ctx) {
    for (const p of this.popups) {
      const t = clamp(p.life / p.maxLife, 0, 1)
      drawNeonText(ctx, p.text, p.x, p.y, {
        font: `800 ${p.size}px ${FONT_MONO}`,
        color: p.color,
        glow: 14,
        align: 'center',
        baseline: 'middle',
        alpha: easeOutCubic(t),
      })
    }
  }

  // --------------------------------------------------------------------
  // Telemetry panels (all below y=48, clear of the arcade HUD)
  // --------------------------------------------------------------------

  _drawBoostPanel(ctx) {
    const x = 24
    const w = 316
    const hot = this.boosting
    const accent = hot ? THEME.amber : this.boostCooldown > 0 ? THEME.magenta : THEME.cyan
    const inner = drawGlassPanel(ctx, {
      x, y: PANEL_Y, w, h: PANEL_H, radius: 12,
      accent, glow: hot ? 26 : 14, pad: 12,
    })

    const label = hot ? 'OVERDRIVE' : this.boostCooldown > 0 ? 'RECHARGING' : 'BOOST'
    drawNeonText(ctx, label, inner.x, PANEL_Y + PANEL_H / 2 - 7, {
      font: `700 10px ${FONT_MONO}`,
      color: hot ? THEME.amber : THEME.textDim,
      glow: hot ? 12 : 0,
      align: 'left',
      baseline: 'middle',
    })
    drawNeonText(ctx, 'SHIFT', inner.x + inner.w, PANEL_Y + PANEL_H / 2 - 7, {
      font: `700 10px ${FONT_MONO}`,
      color: withAlpha(THEME.textFaint, this.boost >= BOOST_MIN_ENGAGE ? 1 : 0.45),
      glow: 0,
      align: 'right',
      baseline: 'middle',
    })

    const value = clamp(this.boost / BOOST_MAX, 0, 1)
    drawBar(ctx, {
      x: inner.x, y: PANEL_Y + PANEL_H / 2 + 3, w: inner.w, h: 8,
      value,
      color: hot ? THEME.amber : value < 0.2 ? THEME.magenta : THEME.cyan,
      track: 'rgba(255,255,255,0.07)',
      radius: 4,
    })

    // Minimum-engage notch.
    const notchX = inner.x + inner.w * (BOOST_MIN_ENGAGE / BOOST_MAX)
    ctx.save()
    ctx.strokeStyle = withAlpha(THEME.text, 0.35)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(notchX, PANEL_Y + PANEL_H / 2 + 2)
    ctx.lineTo(notchX, PANEL_Y + PANEL_H / 2 + 12)
    ctx.stroke()
    ctx.restore()
  }

  _drawComboPanel(ctx) {
    const x = 356
    const w = 248
    const active = this.multiplier > 1 && this.comboTimer > 0
    const accent = active ? THEME.amber : THEME.cyan
    const inner = drawGlassPanel(ctx, {
      x, y: PANEL_Y, w, h: PANEL_H, radius: 12,
      accent, glow: active ? 26 : 12, pad: 12,
    })

    const cx = inner.x + 14
    const cy = PANEL_Y + PANEL_H / 2
    const frac = clamp(this.comboTimer / COMBO_WINDOW_MS, 0, 1)

    ctx.save()
    ctx.lineWidth = 3
    ctx.strokeStyle = withAlpha(THEME.text, 0.12)
    ctx.beginPath()
    ctx.arc(cx, cy, 13, 0, TAU)
    ctx.stroke()
    if (frac > 0) {
      ctx.strokeStyle = accent
      ctx.shadowColor = withAlpha(accent, 0.8)
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.arc(cx, cy, 13, -Math.PI / 2, -Math.PI / 2 + TAU * frac)
      ctx.stroke()
    }
    ctx.restore()

    const pop = active ? 1 + 0.06 * Math.sin(this.elapsed * 0.012) : 1
    drawNeonText(ctx, `x${this.multiplier}`, cx + 26, cy + 1, {
      font: `800 ${Math.round(23 * pop)}px ${FONT_MONO}`,
      color: active ? THEME.amber : THEME.textDim,
      glow: active ? 20 : 4,
      align: 'left',
      baseline: 'middle',
    })

    const barX = inner.x + 92
    const barW = Math.max(30, inner.x + inner.w - barX)
    drawNeonText(ctx, active ? `CHAIN ${this.comboChain}` : 'COMBO IDLE', barX, cy - 8, {
      font: `700 9px ${FONT_MONO}`,
      color: THEME.textFaint,
      glow: 0,
      align: 'left',
      baseline: 'middle',
    })
    drawBar(ctx, {
      x: barX, y: cy + 1, w: barW, h: 6,
      value: frac,
      color: active ? THEME.amber : withAlpha(THEME.cyan, 0.7),
      track: 'rgba(255,255,255,0.07)',
      radius: 3,
    })
  }

  _drawTelemetryPanel(ctx) {
    const x = 620
    const w = 316
    const inner = drawGlassPanel(ctx, {
      x, y: PANEL_Y, w, h: PANEL_H, radius: 12,
      accent: THEME.cyan, glow: 12, pad: 12,
    })
    const speed = (BASE_STEP_MS / this._stepInterval()).toFixed(2)
    const cols = [
      ['length', this.snake.length, THEME.cyan],
      ['pellets', this.itemsEaten, THEME.lime],
      ['speed', `x${speed}`, this.boosting ? THEME.amber : THEME.ice],
    ]
    const step = inner.w / cols.length
    cols.forEach(([label, value, color], i) => {
      drawTelemetry(ctx, label, value, inner.x + step * i, inner.y + 2, {
        color,
        labelColor: THEME.textFaint,
        align: 'left',
        size: 11,
      })
    })
  }

  _drawFooter(ctx) {
    drawNeonText(
      ctx,
      'ARROWS / WASD  STEER      SHIFT  OVERDRIVE      P  PAUSE',
      this.width / 2,
      ARENA_Y + ARENA_H + 26,
      {
        font: `600 11px ${FONT_MONO}`,
        color: withAlpha(THEME.textFaint, 0.85),
        glow: 0,
        align: 'center',
        baseline: 'middle',
      }
    )
  }

  // --------------------------------------------------------------------
  // Overlays
  // --------------------------------------------------------------------

  _veil(ctx, alpha = 0.72) {
    ctx.save()
    ctx.fillStyle = withAlpha(THEME.bgDeep, alpha)
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.restore()
  }

  _drawIntro(ctx) {
    this._veil(ctx, 0.6)
    const w = 520
    const h = 178
    const x = (this.width - w) / 2
    const y = 186
    drawGlassPanel(ctx, { x, y, w, h, radius: 18, accent: THEME.cyan, glow: 28 })

    drawNeonText(ctx, 'CYBER SNAKE', this.width / 2, y + 52, {
      font: `800 40px ${FONT_UI}`,
      color: THEME.cyan,
      glow: 26,
    })
    drawNeonText(ctx, 'OVERDRIVE', this.width / 2, y + 88, {
      font: `800 26px ${FONT_UI}`,
      color: THEME.magenta,
      glow: 22,
    })
    const blink = 0.55 + 0.45 * Math.sin(this.elapsed * 0.005)
    drawNeonText(ctx, 'PRESS ARROW / WASD TO ENGAGE', this.width / 2, y + 126, {
      font: `700 13px ${FONT_MONO}`,
      color: withAlpha(THEME.text, blink),
      glow: 8,
    })
    drawNeonText(ctx, 'HOLD SHIFT TO BURN BOOST · CHAIN PELLETS FOR x4', this.width / 2, y + 150, {
      font: `600 11px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
    })
  }

  _drawPaused(ctx) {
    this._veil(ctx, 0.66)
    drawNeonText(ctx, 'PAUSED', this.width / 2, this.height / 2 - 8, {
      font: `800 44px ${FONT_UI}`,
      color: THEME.cyan,
      glow: 26,
    })
    drawNeonText(ctx, 'PRESS P TO RESUME', this.width / 2, this.height / 2 + 30, {
      font: `700 13px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
    })
  }

  _drawGameOver(ctx) {
    const reveal = clamp(this.deathTimer / 420, 0, 1)
    this._veil(ctx, 0.78 * reveal)
    if (reveal < 0.25) {
      this.restartRect = null
      return
    }

    const w = 520
    const h = 244
    const x = (this.width - w) / 2
    const y = 150
    drawGlassPanel(ctx, { x, y, w, h, radius: 18, accent: THEME.magenta, glow: 30 })

    drawNeonText(ctx, 'SIGNAL LOST', this.width / 2, y + 54, {
      font: `800 40px ${FONT_UI}`,
      color: THEME.magenta,
      glow: 28,
    })
    drawNeonText(
      ctx,
      this.deathCause === 'wall' ? 'FIREWALL COLLISION' : 'TAIL FEEDBACK LOOP',
      this.width / 2,
      y + 80,
      { font: `600 11px ${FONT_MONO}`, color: THEME.textDim, glow: 0 }
    )

    const stats = [
      ['score', this.score, THEME.cyan],
      ['best combo', `x${this.bestMultiplier}`, THEME.amber],
      ['length', this.snake.length, THEME.lime],
      ['pellets', this.itemsEaten, THEME.violet],
    ]
    const colW = (w - 72) / stats.length
    stats.forEach(([label, value, color], i) => {
      drawTelemetry(ctx, label, value, x + 36 + colW * i, y + 116, {
        color,
        labelColor: THEME.textFaint,
        align: 'left',
        size: 12,
      })
    })

    const btn = { x: this.width / 2 - 96, y: y + 164, w: 192, h: 44 }
    this.restartRect = drawCanvasButton(ctx, {
      ...btn,
      label: 'RESTART',
      accent: THEME.cyan,
      filled: true,
      font: `800 16px ${FONT_UI}`,
      hover: hitRect(this.pointer, btn),
    })
    drawNeonText(ctx, 'OR PRESS  R', this.width / 2, y + 222, {
      font: `600 10px ${FONT_MONO}`,
      color: THEME.textFaint,
      glow: 0,
    })
  }
}
