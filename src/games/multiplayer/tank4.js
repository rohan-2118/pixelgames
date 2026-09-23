// src/games/multiplayer/tank4.js
//
// CYBER-TANKS ADVANCED ARENA — host-authoritative, serverless 2-4 player
// top-down tank duel with destructible neon cover, ricocheting tracer shells
// and a tactical bot AI. All state lives strictly in RAM for the lifetime of
// the room; nothing is ever written to localStorage/cookies/IndexedDB.
//
// Networking model (unchanged from the original engine):
//   - Host (p2p.isHost === true) owns the ENTIRE simulation: hull/turret
//     physics, shell ballistics, pillar damage, round + match logic. It runs a
//     fixed 30Hz tick and broadcasts a full state snapshot every tick via
//     `p2p.broadcast({ type: 'sync', ... })`.
//   - Clients (p2p.isHost === false) never simulate anything. They capture
//     local keyboard + pointer aim and forward it via
//     `p2p.broadcast({ type: 'input', ... })`, then render whatever the most
//     recent `sync` snapshot says.
//   - Trystero rooms are a full mesh, so a client is never handed its own peer
//     id. The host sends a one-off targeted `{ type: 'welcome' }` via
//     `p2p.sendTo(peerId, ...)` the moment a peer connects, echoing back
//     `yourPeerId` plus the assigned seat.
//   - One-shot presentation events (muzzle flashes, ricochets, wrecks, kills)
//     ride along in the sync payload so every client plays the same particle
//     burst and sound without simulating anything.
//
// In solo-vs-AI mode the router hands us a synthetic offline p2p context
// (`p2p.soloAi === true`, broadcast/sendTo are no-ops), so the exact same
// host code path runs with zero network traffic.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId) /
//   getMatchSnapshot() / applyMatchSnapshot(data) / startSoloMatch() /
//   getHudStats()

import {
  THEME, FONT_MONO, FONT_UI, PLAYER_COLORS, TAU,
  clamp, lerp, rand, withAlpha, mixColor, roundRect,
  drawArenaBackdrop, drawGlassPanel, drawNeonText, drawBar,
} from '../../fx/theme.js'
import { ParticleField } from '../../fx/particles.js'
import { Camera } from '../../fx/camera.js'
import { PostFX } from '../../fx/postfx.js'
import { sfx } from '../../fx/audio.js'
import { drawLobby, fillBots, canvasPoint, hit, findReclaimSeat, BOT_NAMES } from '../shared/lobby.js'
import { cloneState } from '../shared/snapshot.js'

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const TICK_HZ = 30
const TICK_MS = 1000 / TICK_HZ
const SEAT_COUNT = 4

const VIEW_W = 960
const VIEW_H = 540

// The top 44px belong to the arcade HUD; the scoreboard strip and the arena
// both start below it.
const BOARD = { x: 22, y: 50, w: 916, h: 44 }
const ARENA = { x: 22, y: 102, w: 916, h: 414 }

const SEAT_NAMES = ['P1', 'P2', 'P3', 'P4']

const TANK_RADIUS = 15
const HULL_LEN = 34
const TRACK_HALF = 11.5
const TREAD_LEN = 32
const TREAD_W = 7
const CLEAT_SPACING = 6
const BARREL_LEN = 22
const TURRET_R = 9.5

const TANK_TURN_RATE = 2.75 // rad / second
const TANK_FORWARD_SPEED = 152 // px / second
const TANK_REVERSE_SPEED = 98 // px / second
const TURRET_SLEW = 4.8 // rad / second — the barrel always lags the aim a little

const SHELL_SPEED = 420
const SHELL_RADIUS = 3.6
const SHELL_MAX_LIFE_MS = 5200
const SHELL_MAX_BOUNCES = 2
const SHELL_OWNER_GRACE_MS = 130
const SHELL_SUBSTEPS = 2
const FIRE_COOLDOWN_MS = 620

const PILLAR_DAMAGE = 1

const ROUND_COUNTDOWN_MS = 1800
const ROUND_OVER_MS = 3200
const MATCH_OVER_MS = 5400
const SPAWN_INVULN_MS = 1100
const MATCH_WINS = 5

const MOVE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ',
  'a', 'A', 'd', 'D', 'w', 'W', 's', 'S',
])

// ---------------------------------------------------------------------------
// Pure geometry helpers
// ---------------------------------------------------------------------------

/** Shortest signed angular difference a - b, wrapped to [-PI, PI]. */
function angleDelta(a, b) {
  let d = a - b
  while (d > Math.PI) d -= TAU
  while (d < -Math.PI) d += TAU
  return d
}

/** Deterministic 0..1 hash — used for crack/rubble geometry so host and
 * clients fracture pillars identically without transmitting anything. */
function hash01(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7 + 0.5) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Deterministic destructible cover. Identical on host and every client, so
 * only the mutable `hp`/`alive` fields ever travel over the wire.
 */
function buildPillars() {
  const cx = ARENA.x + ARENA.w / 2
  const cy = ARENA.y + ARENA.h / 2
  const defs = [
    [cx, cy, 78, 78, 5],
    [cx - 176, cy - 104, 58, 58, 3],
    [cx + 176, cy - 104, 58, 58, 3],
    [cx - 176, cy + 104, 58, 58, 3],
    [cx + 176, cy + 104, 58, 58, 3],
    [cx - 330, cy, 30, 132, 3],
    [cx + 330, cy, 30, 132, 3],
    [cx, cy - 138, 150, 28, 3],
    [cx, cy + 138, 150, 28, 3],
  ]
  return defs.map(([px, py, w, h, hp], i) => ({
    id: i,
    x: px - w / 2,
    y: py - h / 2,
    w,
    h,
    hp,
    maxHp: hp,
    alive: true,
  }))
}

function circleRectHit(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w))
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h))
  const dx = cx - nx
  const dy = cy - ny
  return dx * dx + dy * dy < r * r
}

/**
 * Distance along a normalised ray to the near face of an (optionally padded)
 * rect, or Infinity when the ray misses. Slab method.
 */
function rayRectDist(ox, oy, dx, dy, rect, pad, maxT) {
  const minX = rect.x - pad
  const maxX = rect.x + rect.w + pad
  const minY = rect.y - pad
  const maxY = rect.y + rect.h + pad
  let t0 = 0
  let t1 = maxT

  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return Infinity
  } else {
    let ta = (minX - ox) / dx
    let tb = (maxX - ox) / dx
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return Infinity
  }

  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return Infinity
  } else {
    let ta = (minY - oy) / dy
    let tb = (maxY - oy) / dy
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return Infinity
  }

  return t0
}

/**
 * Solve the lead angle for a constant-speed shell against a target moving at
 * constant velocity. Falls back to a direct shot when no positive intercept
 * time exists.
 */
function interceptAngle(sx, sy, tx, ty, tvx, tvy, speed) {
  const dx = tx - sx
  const dy = ty - sy
  const a = tvx * tvx + tvy * tvy - speed * speed
  const b = 2 * (dx * tvx + dy * tvy)
  const c = dx * dx + dy * dy

  let t = -1
  if (Math.abs(a) < 1e-4) {
    if (Math.abs(b) > 1e-6) t = -c / b
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      const t1 = (-b + sq) / (2 * a)
      const t2 = (-b - sq) / (2 * a)
      const pos = [t1, t2].filter((v) => v > 0 && Number.isFinite(v))
      if (pos.length) t = Math.min(...pos)
    }
  }

  if (!(t > 0) || !Number.isFinite(t)) return Math.atan2(dy, dx)
  return Math.atan2(dy + tvy * t, dx + tvx * t)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export default class Tank4Game {
  /**
   * @param {HTMLCanvasElement} canvas Shared 960x540 arcade canvas.
   * @param {object} p2pContext Host-authoritative networking context.
   */
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2p = p2pContext
    this.isHost = !!(p2pContext && p2pContext.isHost)

    this.width = canvas.width || VIEW_W
    this.height = canvas.height || VIEW_H

    this.fx = new ParticleField({ max: 1100 })
    this.camera = new Camera({ decay: 0.9, maxOffset: 22 })
    this.post = new PostFX(canvas, { accent: THEME.cyan })

    this.running = false
    this.rafId = null
    this.lastTime = 0
    this.tickAccumulator = 0
    this.elapsed = 0
    this.simTime = 0

    this.mySeat = this.isHost ? 0 : null
    this.myPeerId = null
    this.hostPeerId = null

    this.keysDown = new Set()
    this.lastSentInput = null
    this.pointer = null // canvas-space aim point, null until the mouse moves
    this.pointerInside = false
    this.pointerFiring = false
    this.startRect = null
    this.prevCursor = ''

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerLeave = this._onPointerLeave.bind(this)
    this._onBlur = this._onBlur.bind(this)
    this._loop = this._loop.bind(this)

    // ---- Host-authoritative simulation state (ignored on clients) ----
    this.peerSeatMap = new Map() // networkPeerId -> seat index
    this.inputs = [null, null, null, null]
    this.tanks = this._createTanks()
    this.brains = [null, null, null, null]
    this.pillars = buildPillars()
    this.shells = []
    this.events = [] // presentation events accumulated during the current tick
    this.roundState = 'lobby' // lobby | countdown | playing | roundover | matchover
    this.round = 0
    this.countdownMs = 0
    this.roundOverMs = 0
    this.winnerSeat = null
    this.matchWinner = null
    this.nextShellId = 1

    // ---- Client render state ----
    this.netState = null

    // ---- Presentation bookkeeping ----
    this._sfxAt = Object.create(null)
    this._lastPhase = null
    this._lastPip = null

    if (this.isHost) {
      this.tanks[0].active = true
      this.tanks[0].isBot = false
    }
  }

  // ------------------------------------------------------------------
  // GameEngine interface
  // ------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true

    // stop() nulls these out; a restart on the same instance rebuilds them.
    if (!this.fx) this.fx = new ParticleField({ max: 1100 })
    if (!this.post) this.post = new PostFX(this.canvas, { accent: THEME.cyan })

    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('blur', this._onBlur)
    window.addEventListener('pointerup', this._onPointerUp)
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    this.canvas.addEventListener('pointermove', this._onPointerMove)
    this.canvas.addEventListener('pointerleave', this._onPointerLeave)

    if (this.canvas.style) {
      this.prevCursor = this.canvas.style.cursor || ''
      this.canvas.style.cursor = 'crosshair'
    }

    this.fx?.ambient(this.width, this.height, {
      count: 46,
      color: THEME.cyan,
      speed: 0.012,
      size: 1.7,
    })

    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.tickAccumulator = 0
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
    window.removeEventListener('pointerup', this._onPointerUp)
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
    this.canvas.removeEventListener('pointermove', this._onPointerMove)
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave)

    if (this.canvas.style) this.canvas.style.cursor = this.prevCursor

    this.fx?.destroy()
    this.post?.destroy()
    this.camera?.reset()

    this.fx = null
    this.post = null
    this.keysDown.clear()
    this.pointer = null
    this.pointerInside = false
    this.startRect = null
    this._sfxAt = Object.create(null)
    this.events = []
  }

  getMatchSnapshot() {
    return {
      kind: 'realtime',
      mySeat: this.mySeat,
      myPeerId: this.myPeerId,
      hostPeerId: this.hostPeerId,
      roundState: this.roundState,
      round: this.round,
      countdownMs: this.countdownMs,
      roundOverMs: this.roundOverMs,
      winnerSeat: this.winnerSeat,
      matchWinner: this.matchWinner,
      simTime: this.simTime,
      nextShellId: this.nextShellId,
      peerSeatMap: Array.from(this.peerSeatMap.entries()),
      inputs: cloneState(this.inputs),
      tanks: cloneState(this.tanks),
      brains: cloneState(this.brains),
      pillars: cloneState(this.pillars),
      shells: cloneState(this.shells),
      netState: this.netState ? cloneState(this.netState) : null,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'realtime') return false
    if (snap.mySeat !== undefined) this.mySeat = snap.mySeat
    if (snap.myPeerId !== undefined) this.myPeerId = snap.myPeerId
    if (snap.hostPeerId !== undefined) this.hostPeerId = snap.hostPeerId
    if (typeof snap.roundState === 'string') this.roundState = snap.roundState
    if (typeof snap.round === 'number') this.round = snap.round
    if (typeof snap.countdownMs === 'number') this.countdownMs = snap.countdownMs
    if (typeof snap.roundOverMs === 'number') this.roundOverMs = snap.roundOverMs
    if (snap.winnerSeat !== undefined) this.winnerSeat = snap.winnerSeat
    if (snap.matchWinner !== undefined) this.matchWinner = snap.matchWinner
    if (typeof snap.simTime === 'number') this.simTime = snap.simTime
    if (typeof snap.nextShellId === 'number') this.nextShellId = snap.nextShellId
    // Peer ids do not survive a reload; the host rebuilds the map on rejoin.
    if (this.isHost) this.peerSeatMap = new Map()
    if (Array.isArray(snap.inputs)) this.inputs = cloneState(snap.inputs)
    if (Array.isArray(snap.tanks)) this.tanks = cloneState(snap.tanks)
    if (Array.isArray(snap.brains)) this.brains = cloneState(snap.brains)
    if (Array.isArray(snap.pillars) && snap.pillars.length === this.pillars.length) {
      this.pillars = cloneState(snap.pillars)
    }
    if (Array.isArray(snap.shells)) this.shells = cloneState(snap.shells)
    if (snap.netState && typeof snap.netState === 'object') this.netState = cloneState(snap.netState)
    else if (snap.netState === null) this.netState = null
    this.events = []
    return true
  }

  getHudStats() {
    const view = this._viewState()
    const seat = this.mySeat
    let score = 0
    if (view && Array.isArray(view.tanks) && seat != null && view.tanks[seat]) {
      score = view.tanks[seat].wins || 0
    }
    const phase = (view && view.roundState) || this.roundState
    let status = ''
    if (phase === 'lobby') status = 'LOBBY'
    else if (phase === 'countdown') status = 'DEPLOYING'
    else if (phase === 'playing') status = `ROUND ${(view && view.round) || this.round}`
    else if (phase === 'roundover') status = 'ROUND OVER'
    else if (phase === 'matchover') status = 'MATCH OVER'
    return { score, label: 'WINS', status }
  }

  onPeerJoin(peerId) {
    if (!this.isHost) return
    let seat = -1
    if (this.roundState === 'lobby') {
      seat = this._assignSeat(peerId)
    } else {
      seat = findReclaimSeat(this.tanks, this.peerSeatMap)
      if (seat >= 0) {
        this.peerSeatMap.set(peerId, seat)
        if (!this.inputs[seat]) this.inputs[seat] = this._blankInput()
      }
    }
    if (seat === -1) return
    if (this.p2p) this.p2p.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })
    if (this.roundState !== 'lobby') this._broadcastSync()
  }

  onPeerLeave(peerId) {
    if (!this.isHost) return
    this._freeSeatForPeer(peerId)
  }

  onPeerAction(data, peerId) {
    if (!data || typeof data !== 'object') return

    if (data.type === 'welcome') {
      if (!this.isHost) {
        this.mySeat = data.seat
        this.myPeerId = data.yourPeerId
      }
      return
    }

    if (data.type === 'input') {
      if (this.isHost) {
        const seat = this.peerSeatMap.get(peerId)
        if (seat != null) {
          this.inputs[seat] = {
            left: !!data.left,
            right: !!data.right,
            up: !!data.up,
            down: !!data.down,
            fire: !!data.fire,
            aim: typeof data.aim === 'number' && Number.isFinite(data.aim) ? data.aim : null,
          }
        }
      }
      return
    }

    if (data.type === 'sync') {
      if (!this.isHost) {
        this.hostPeerId = peerId
        this._applyRemotePillars(data.pillars)
        this.netState = { ...data, pillars: this.pillars }
        if (Array.isArray(data.events) && data.events.length) this._consumeEvents(data.events)
      }
      return
    }
  }

  // ------------------------------------------------------------------
  // Seat management (host only)
  // ------------------------------------------------------------------

  _blankInput() {
    return { left: false, right: false, up: false, down: false, fire: false, aim: null }
  }

  _createTanks() {
    const tanks = []
    for (let i = 0; i < SEAT_COUNT; i++) {
      tanks.push({
        active: false,
        alive: false,
        isBot: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        hull: 0,
        turret: 0,
        treadL: 0,
        treadR: 0,
        fireCooldown: 0,
        invulnMs: 0,
        muzzleMs: 0,
        recoil: 0,
        wins: 0,
        kills: 0,
      })
    }
    return tanks
  }

  _spawnPointFor(seat) {
    const m = 46
    const points = [
      { x: ARENA.x + m, y: ARENA.y + m },
      { x: ARENA.x + ARENA.w - m, y: ARENA.y + m },
      { x: ARENA.x + ARENA.w - m, y: ARENA.y + ARENA.h - m },
      { x: ARENA.x + m, y: ARENA.y + ARENA.h - m },
    ]
    const p = points[seat] || points[0]
    const cx = ARENA.x + ARENA.w / 2
    const cy = ARENA.y + ARENA.h / 2
    return { x: p.x, y: p.y, angle: Math.atan2(cy - p.y, cx - p.x) }
  }

  _spawnSeat(seat) {
    const point = this._spawnPointFor(seat)
    const tank = this.tanks[seat]
    tank.x = point.x
    tank.y = point.y
    tank.vx = 0
    tank.vy = 0
    tank.hull = point.angle
    tank.turret = point.angle
    tank.alive = true
    tank.fireCooldown = 0
    tank.invulnMs = SPAWN_INVULN_MS
    tank.muzzleMs = 0
    tank.recoil = 0
  }

  _assignSeat(peerId) {
    for (let seat = 1; seat < SEAT_COUNT; seat++) {
      if (!this.tanks[seat].active) {
        this.tanks[seat].active = true
        this.tanks[seat].isBot = false
        this.brains[seat] = null
        this.peerSeatMap.set(peerId, seat)
        this.inputs[seat] = this._blankInput()
        return seat
      }
    }
    return -1
  }

  _freeSeatForPeer(peerId) {
    const seat = this.peerSeatMap.get(peerId)
    if (seat == null) return
    this.tanks[seat].active = false
    this.tanks[seat].alive = false
    this.inputs[seat] = null
    this.brains[seat] = null
    this.peerSeatMap.delete(peerId)
  }

  _lobbySeats() {
    return this.tanks.map((t) => ({ active: t.active, isBot: !!t.isBot }))
  }

  _activateBotSeat(seat) {
    const tank = this.tanks[seat]
    tank.active = true
    tank.isBot = true
    this.inputs[seat] = this._blankInput()
    this.brains[seat] = this._createBrain(seat)
  }

  /**
   * Solo-vs-AI entry point called by the arcade shell right after start().
   * Skips the lobby wait entirely: every empty seat becomes a local bot and
   * the match begins immediately with zero network involvement.
   */
  startSoloMatch() {
    this._hostPressStart()
  }

  _hostPressStart() {
    if (!this.isHost || this.roundState !== 'lobby') return
    fillBots(this._lobbySeats(), SEAT_COUNT, (seat) => this._activateBotSeat(seat))
    this.round = 0
    this.matchWinner = null
    for (const t of this.tanks) { t.wins = 0; t.kills = 0 }
    this._startRound()
  }

  // ------------------------------------------------------------------
  // Bot AI — HUNT / STRAFE / RETREAT / REPOSITION
  // ------------------------------------------------------------------

  /** Per-bot personality. Reaction time, aim sloppiness and aggression are
   * rolled once per seat so the three opponents read as distinct drivers. */
  _createBrain(seat) {
    const aggression = rand(0.3, 0.98)
    return {
      seat,
      state: 'REPOSITION',
      stateMs: 0,
      thinkMs: 0,
      reactionMs: rand(120, 420),
      aimError: rand(0.018, 0.105),
      aggression,
      orbitDir: Math.random() < 0.5 ? -1 : 1,
      preferredRange: lerp(300, 150, aggression) + rand(-24, 24),
      targetSeat: null,
      hasLos: false,
      goalX: ARENA.x + ARENA.w / 2,
      goalY: ARENA.y + ARENA.h / 2,
      aimNoise: 0,
      fireHold: 0,
      bankAngle: null,
    }
  }

  /** Any alive pillar between two points? `pad` widens the pillars so bots
   * respect the shell radius rather than threading impossible gaps. */
  _hasLineOfSight(x0, y0, x1, y1, pad = 0) {
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return true
    const nx = dx / len
    const ny = dy / len
    for (const p of this.pillars) {
      if (!p.alive) continue
      if (rayRectDist(x0, y0, nx, ny, p, pad, len) < len) return false
    }
    return true
  }

  /** Distance along a ray until it meets a pillar or the arena wall. */
  _rayDistance(x, y, dx, dy, maxLen, pad) {
    let best = maxLen
    if (dx > 1e-9) best = Math.min(best, (ARENA.x + ARENA.w - pad - x) / dx)
    else if (dx < -1e-9) best = Math.min(best, (ARENA.x + pad - x) / dx)
    if (dy > 1e-9) best = Math.min(best, (ARENA.y + ARENA.h - pad - y) / dy)
    else if (dy < -1e-9) best = Math.min(best, (ARENA.y + pad - y) / dy)
    for (const p of this.pillars) {
      if (!p.alive) continue
      const t = rayRectDist(x, y, dx, dy, p, pad, maxLen)
      if (t < best) best = t
    }
    return clamp(best, 0, maxLen)
  }

  /** Three whiskers (left / centre / right) so bots slide around cover
   * instead of grinding along it. Returns a world-space steering nudge. */
  _whiskerAvoid(tank) {
    const pad = TANK_RADIUS * 0.75
    const h = tank.hull
    const rx = -Math.sin(h)
    const ry = Math.cos(h)
    const centreLen = 82
    const sideLen = 58

    const dC = this._rayDistance(tank.x, tank.y, Math.cos(h), Math.sin(h), centreLen, pad)
    const dL = this._rayDistance(tank.x, tank.y, Math.cos(h - 0.52), Math.sin(h - 0.52), sideLen, pad)
    const dR = this._rayDistance(tank.x, tank.y, Math.cos(h + 0.52), Math.sin(h + 0.52), sideLen, pad)

    let ax = 0
    let ay = 0
    if (dL < sideLen) {
      const w = 1 - dL / sideLen
      ax += rx * w
      ay += ry * w
    }
    if (dR < sideLen) {
      const w = 1 - dR / sideLen
      ax -= rx * w
      ay -= ry * w
    }
    if (dC < centreLen) {
      const w = 1 - dC / centreLen
      const dir = dR >= dL ? 1 : -1
      ax += rx * dir * w * 1.6
      ay += ry * dir * w * 1.6
      ax -= Math.cos(h) * w * 0.9
      ay -= Math.sin(h) * w * 0.9
    }
    return { x: ax, y: ay }
  }

  /** Keep a tactical goal inside the arena and out of solid cover. */
  _sanitiseGoal(x, y) {
    const m = TANK_RADIUS + 8
    let gx = clamp(x, ARENA.x + m, ARENA.x + ARENA.w - m)
    let gy = clamp(y, ARENA.y + m, ARENA.y + ARENA.h - m)
    for (const p of this.pillars) {
      if (!p.alive) continue
      if (!circleRectHit(gx, gy, TANK_RADIUS + 6, p)) continue
      const cx = p.x + p.w / 2
      const cy = p.y + p.h / 2
      let dx = gx - cx
      let dy = gy - cy
      const len = Math.hypot(dx, dy) || 1
      dx /= len
      dy /= len
      const reach = Math.max(p.w, p.h) / 2 + TANK_RADIUS + 10
      gx = clamp(cx + dx * reach, ARENA.x + m, ARENA.x + ARENA.w - m)
      gy = clamp(cy + dy * reach, ARENA.y + m, ARENA.y + ARENA.h - m)
    }
    return { x: gx, y: gy }
  }

  /** Nearest intact pillar, measured from `from` and biased away from a threat. */
  _nearestCover(from, threat) {
    let best = null
    let bestScore = Infinity
    for (const p of this.pillars) {
      if (!p.alive) continue
      const cx = p.x + p.w / 2
      const cy = p.y + p.h / 2
      const d = Math.hypot(cx - from.x, cy - from.y)
      const away = threat ? Math.hypot(cx - threat.x, cy - threat.y) : 0
      const score = d - away * 0.35
      if (score < bestScore) {
        bestScore = score
        best = { x: cx, y: cy, rect: p }
      }
    }
    return best
  }

  /** Deliberate re-decision, throttled to the bot's personal reaction time. */
  _botThink(seat, dtMs) {
    const tank = this.tanks[seat]
    const b = this.brains[seat]
    if (!b) return

    b.stateMs += dtMs
    b.thinkMs -= dtMs
    b.fireHold = Math.max(0, b.fireHold - dtMs)
    if (b.thinkMs > 0) return
    b.thinkMs = b.reactionMs * rand(0.8, 1.35)

    // --- Target selection: nearest enemy, heavily favouring a clear line ---
    let target = null
    let targetSeat = null
    let targetLos = false
    let bestScore = Infinity
    for (let s = 0; s < SEAT_COUNT; s++) {
      if (s === seat) continue
      const other = this.tanks[s]
      if (!other.active || !other.alive) continue
      const d = Math.hypot(other.x - tank.x, other.y - tank.y)
      const los = this._hasLineOfSight(tank.x, tank.y, other.x, other.y, SHELL_RADIUS)
      const score = d * (los ? 1 : 2.2)
      if (score < bestScore) {
        bestScore = score
        target = other
        targetSeat = s
        targetLos = los
      }
    }

    if (targetSeat !== b.targetSeat) b.fireHold = b.reactionMs
    b.targetSeat = targetSeat
    b.hasLos = targetLos

    if (!target) {
      b.state = 'REPOSITION'
      const g = this._sanitiseGoal(
        ARENA.x + ARENA.w / 2 + rand(-200, 200),
        ARENA.y + ARENA.h / 2 + rand(-140, 140)
      )
      b.goalX = g.x
      b.goalY = g.y
      return
    }

    const dist = Math.hypot(target.x - tank.x, target.y - tank.y)
    const reloading = tank.fireCooldown > FIRE_COOLDOWN_MS * 0.42
    const prev = b.state

    if (reloading && dist < 240 + b.aggression * 60) b.state = 'RETREAT'
    else if (!targetLos) b.state = 'REPOSITION'
    else if (dist < b.preferredRange * 0.62 || dist > b.preferredRange * 1.55) b.state = 'HUNT'
    else b.state = 'STRAFE'

    if (b.state !== prev) {
      b.stateMs = 0
      if (Math.random() < 0.35) b.orbitDir *= -1
    }

    // --- Goal point for the chosen state ---
    let gx = target.x
    let gy = target.y
    const toBot = Math.atan2(tank.y - target.y, tank.x - target.x)

    if (b.state === 'HUNT') {
      gx = target.x + Math.cos(toBot) * b.preferredRange
      gy = target.y + Math.sin(toBot) * b.preferredRange
    } else if (b.state === 'STRAFE') {
      const a = toBot + b.orbitDir * 0.75
      gx = target.x + Math.cos(a) * b.preferredRange
      gy = target.y + Math.sin(a) * b.preferredRange
    } else if (b.state === 'RETREAT') {
      // Break contact: put an intact pillar between us and the shooter.
      const cover = this._nearestCover(tank, target)
      if (cover) {
        const ang = Math.atan2(cover.y - target.y, cover.x - target.x)
        const reach = Math.max(cover.rect.w, cover.rect.h) / 2 + TANK_RADIUS + 14
        gx = cover.x + Math.cos(ang) * reach
        gy = cover.y + Math.sin(ang) * reach
      } else {
        gx = tank.x + Math.cos(toBot) * 200
        gy = tank.y + Math.sin(toBot) * 200
      }
    } else {
      // REPOSITION: sample a ring of candidate spots and take the first that
      // opens a firing line, so bots flank instead of bumping into cover.
      let found = null
      for (let i = 0; i < 10; i++) {
        const a = rand(0, TAU)
        const r = rand(110, 230)
        const cand = this._sanitiseGoal(tank.x + Math.cos(a) * r, tank.y + Math.sin(a) * r)
        if (this._hasLineOfSight(cand.x, cand.y, target.x, target.y, SHELL_RADIUS)) {
          found = cand
          break
        }
        if (!found) found = cand
      }
      gx = found ? found.x : target.x
      gy = found ? found.y : target.y
    }

    const g = this._sanitiseGoal(gx, gy)
    b.goalX = g.x
    b.goalY = g.y
  }

  /** Single-wall bank shot: mirror the target across a wall and check that
   * both legs of the path are clear. Returns an aim angle or null. */
  _bankShot(tank, target) {
    const walls = [
      { axis: 'x', v: ARENA.x + SHELL_RADIUS },
      { axis: 'x', v: ARENA.x + ARENA.w - SHELL_RADIUS },
      { axis: 'y', v: ARENA.y + SHELL_RADIUS },
      { axis: 'y', v: ARENA.y + ARENA.h - SHELL_RADIUS },
    ]
    for (const w of walls) {
      const mx = w.axis === 'x' ? 2 * w.v - target.x : target.x
      const my = w.axis === 'y' ? 2 * w.v - target.y : target.y
      const denom = w.axis === 'x' ? mx - tank.x : my - tank.y
      if (Math.abs(denom) < 1e-6) continue
      const t = w.axis === 'x' ? (w.v - tank.x) / denom : (w.v - tank.y) / denom
      if (!(t > 0.06 && t < 0.94)) continue
      const ix = tank.x + (mx - tank.x) * t
      const iy = tank.y + (my - tank.y) * t
      if (ix < ARENA.x || ix > ARENA.x + ARENA.w) continue
      if (iy < ARENA.y || iy > ARENA.y + ARENA.h) continue
      if (!this._hasLineOfSight(tank.x, tank.y, ix, iy, SHELL_RADIUS)) continue
      if (!this._hasLineOfSight(ix, iy, target.x, target.y, SHELL_RADIUS)) continue
      return Math.atan2(my - tank.y, mx - tank.x)
    }
    return null
  }

  /** Turn the brain's tactical goal into concrete tank controls. */
  _botInput(seat, dtMs) {
    const tank = this.tanks[seat]
    const b = this.brains[seat]
    if (!b) return this._blankInput()

    // --- Steering: arrive + separation + whisker avoidance ---
    let sx = b.goalX - tank.x
    let sy = b.goalY - tank.y
    const dist = Math.hypot(sx, sy) || 1
    sx /= dist
    sy /= dist

    for (let s = 0; s < SEAT_COUNT; s++) {
      if (s === seat) continue
      const o = this.tanks[s]
      if (!o.active || !o.alive) continue
      const dx = tank.x - o.x
      const dy = tank.y - o.y
      const d = Math.hypot(dx, dy)
      if (d > 74 || d < 1e-4) continue
      const w = (1 - d / 74) * 1.35
      sx += (dx / d) * w
      sy += (dy / d) * w
    }

    const avoid = this._whiskerAvoid(tank)
    sx += avoid.x * 1.7
    sy += avoid.y * 1.7

    const mag = Math.hypot(sx, sy)
    const heading = mag > 1e-5 ? Math.atan2(sy, sx) : tank.hull

    let up = false
    let down = false
    let diff = angleDelta(heading, tank.hull)
    if (Math.abs(diff) > 2.25) {
      // Goal is behind us — reverse rather than pirouette in the open.
      down = true
      diff = angleDelta(heading + Math.PI, tank.hull)
    } else {
      up = dist > 26 && Math.abs(diff) < 1.3
    }

    // --- Gunnery: predictive lead, personal aim error, LOS gate ---
    let aim = tank.turret
    let wantFire = false
    const target = b.targetSeat != null ? this.tanks[b.targetSeat] : null

    if (target && target.active && target.alive) {
      b.aimNoise = clamp(b.aimNoise + rand(-0.012, 0.012), -b.aimError, b.aimError)
      const direct = interceptAngle(
        tank.x, tank.y, target.x, target.y, target.vx, target.vy, SHELL_SPEED
      )
      const los = this._hasLineOfSight(tank.x, tank.y, target.x, target.y, SHELL_RADIUS)
      let solution = direct
      let canShoot = los

      if (!los) {
        const bank = b.aggression > 0.45 ? this._bankShot(tank, target) : null
        if (bank != null) {
          solution = bank
          canShoot = true
        }
      }

      aim = solution + b.aimNoise
      const aligned = Math.abs(angleDelta(aim, tank.turret)) < 0.075
      wantFire = canShoot && aligned && tank.fireCooldown <= 0 && b.fireHold <= 0 && target.invulnMs <= 0
      if (wantFire) b.fireHold = b.reactionMs * 0.6
    }

    return {
      left: diff < -0.055,
      right: diff > 0.055,
      up,
      down,
      fire: wantFire,
      aim,
    }
  }

  // ------------------------------------------------------------------
  // Local input capture
  // ------------------------------------------------------------------

  _localTank() {
    const seat = this.mySeat
    if (seat == null) return null
    if (this.isHost) return this.tanks[seat] || null
    const nt = this.netState && this.netState.tanks && this.netState.tanks[seat]
    return nt || null
  }

  /** Mouse aim when the pointer has been used, hull heading otherwise. */
  _localAim() {
    const t = this._localTank()
    if (!t) return null
    if (!this.pointer) return typeof t.hull === 'number' ? t.hull : null
    const dx = this.pointer.x - t.x
    const dy = this.pointer.y - t.y
    if (Math.hypot(dx, dy) < 6) return typeof t.turret === 'number' ? t.turret : null
    return Math.atan2(dy, dx)
  }

  _currentLocalInput() {
    const k = this.keysDown
    return {
      left: k.has('ArrowLeft') || k.has('a') || k.has('A'),
      right: k.has('ArrowRight') || k.has('d') || k.has('D'),
      up: k.has('ArrowUp') || k.has('w') || k.has('W'),
      down: k.has('ArrowDown') || k.has('s') || k.has('S'),
      fire: k.has(' ') || this.pointerFiring,
      aim: this._localAim(),
    }
  }

  _onKeyDown(event) {
    if (MOVE_KEYS.has(event.key)) event.preventDefault()
    if (!this.keysDown.has(event.key)) sfx.unlock()
    this.keysDown.add(event.key)
    this._maybeSendInput()
  }

  _onKeyUp(event) {
    this.keysDown.delete(event.key)
    this._maybeSendInput()
  }

  _onBlur() {
    this.keysDown.clear()
    this.pointerFiring = false
    this._maybeSendInput()
  }

  _onPointerMove(event) {
    this.pointer = canvasPoint(this.canvas, event, this.width, this.height)
    this.pointerInside = true
  }

  _onPointerLeave() {
    this.pointerInside = false
    this.pointerFiring = false
  }

  _onPointerDown(event) {
    sfx.unlock()
    const pt = canvasPoint(this.canvas, event, this.width, this.height)
    this.pointer = pt
    this.pointerInside = true

    if (this.roundState === 'lobby' && this.isHost) {
      if (this.startRect && hit(pt, this.startRect)) {
        sfx.confirm()
        this._hostPressStart()
      }
      return
    }
    // Hold-to-fire; the per-tank cooldown throttles the actual rate.
    this.pointerFiring = true
    this._maybeSendInput()
  }

  _onPointerUp() {
    if (!this.pointerFiring) return
    this.pointerFiring = false
    this._maybeSendInput()
  }

  /** Clients only: forward input when the button mask or quantised aim moves. */
  _maybeSendInput() {
    if (this.isHost || !this.p2p) return
    const cur = this._currentLocalInput()
    const aimQ = cur.aim == null ? 'n' : Math.round(cur.aim * 50)
    const key = `${cur.left}|${cur.right}|${cur.up}|${cur.down}|${cur.fire}|${aimQ}`
    if (key === this.lastSentInput) return
    this.lastSentInput = key
    this.p2p.broadcast({ type: 'input', ...cur })
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(now - this.lastTime, 50)
    this.lastTime = now
    this.elapsed += dt

    if (this.isHost) {
      this.tickAccumulator += dt
      let guard = 0
      while (this.tickAccumulator >= TICK_MS && guard++ < 6) {
        this._hostTick(TICK_MS)
        this.tickAccumulator -= TICK_MS
      }
      if (this.tickAccumulator > TICK_MS * 6) this.tickAccumulator = 0
    } else {
      // Aim rides the pointer, so re-evaluate every frame (deduped inside).
      this._maybeSendInput()
    }

    this.fx?.update(dt)
    this.camera?.update(dt)
    this._render()

    this.rafId = requestAnimationFrame(this._loop)
  }

  _hostTick(dtMs) {
    this.simTime += dtMs

    if (this.roundState === 'lobby') {
      this._broadcastSync()
      return
    }

    if (this.roundState === 'countdown') {
      this.countdownMs -= dtMs
      if (this.countdownMs <= 0) {
        this.countdownMs = 0
        this.roundState = 'playing'
      }
      this._decayCosmetics(dtMs)
      this._broadcastSync()
      this._flushEvents()
      return
    }

    if (this.roundState === 'roundover' || this.roundState === 'matchover') {
      this.roundOverMs -= dtMs
      this._decayCosmetics(dtMs)
      if (this.roundOverMs <= 0) {
        if (this.roundState === 'matchover') this._startMatch()
        else this._startRound()
      }
      this._broadcastSync()
      this._flushEvents()
      return
    }

    const dt = dtMs / 1000

    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const tank = this.tanks[seat]
      if (!tank.active) continue
      if (tank.isBot && tank.alive) {
        this._botThink(seat, dtMs)
        this.inputs[seat] = this._botInput(seat, dtMs)
      }
    }

    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const tank = this.tanks[seat]
      if (!tank.active) continue
      const input =
        seat === 0 && this.isHost && !tank.isBot
          ? this._currentLocalInput()
          : this.inputs[seat] || this._blankInput()
      this._applyInput(seat, input, dt)
    }

    this._separateTanks()
    this._updateShells(dtMs)
    this._updateRoundState(dtMs)
    this._broadcastSync()
    this._flushEvents()
  }

  _decayCosmetics(dtMs) {
    for (const t of this.tanks) {
      if (t.muzzleMs > 0) t.muzzleMs = Math.max(0, t.muzzleMs - dtMs)
      if (t.recoil > 0) t.recoil = Math.max(0, t.recoil - dtMs / 190)
      if (t.fireCooldown > 0) t.fireCooldown = Math.max(0, t.fireCooldown - dtMs)
      if (t.invulnMs > 0) t.invulnMs = Math.max(0, t.invulnMs - dtMs)
    }
  }

  _applyInput(seat, input, dt) {
    const tank = this.tanks[seat]
    const dtMs = dt * 1000

    if (tank.invulnMs > 0) tank.invulnMs = Math.max(0, tank.invulnMs - dtMs)
    if (tank.fireCooldown > 0) tank.fireCooldown = Math.max(0, tank.fireCooldown - dtMs)
    if (tank.muzzleMs > 0) tank.muzzleMs = Math.max(0, tank.muzzleMs - dtMs)
    if (tank.recoil > 0) tank.recoil = Math.max(0, tank.recoil - dtMs / 190)

    if (!tank.alive) {
      tank.vx = 0
      tank.vy = 0
      return
    }

    // --- Hull ---
    let turn = 0
    if (input.left) turn -= TANK_TURN_RATE
    if (input.right) turn += TANK_TURN_RATE
    tank.hull += turn * dt

    let speed = 0
    if (input.up) speed = TANK_FORWARD_SPEED
    else if (input.down) speed = -TANK_REVERSE_SPEED

    const px = tank.x
    const py = tank.y
    if (speed !== 0) {
      const nx = tank.x + Math.cos(tank.hull) * speed * dt
      const ny = tank.y + Math.sin(tank.hull) * speed * dt
      if (this._canOccupy(nx, tank.y)) tank.x = nx
      if (this._canOccupy(tank.x, ny)) tank.y = ny
    }
    tank.vx = dt > 0 ? (tank.x - px) / dt : 0
    tank.vy = dt > 0 ? (tank.y - py) / dt : 0

    // --- Treads: per-side wheel speed, so turning counter-rotates the belts ---
    const wheelL = speed - turn * TRACK_HALF
    const wheelR = speed + turn * TRACK_HALF
    tank.treadL = (tank.treadL + wheelL * dt) % 4096
    tank.treadR = (tank.treadR + wheelR * dt) % 4096

    // --- Turret: eases toward the aim angle at a limited slew rate ---
    const aim = typeof input.aim === 'number' && Number.isFinite(input.aim) ? input.aim : tank.hull
    const slew = TURRET_SLEW * dt
    const d = angleDelta(aim, tank.turret)
    tank.turret += clamp(d, -slew, slew)
    if (tank.turret > Math.PI) tank.turret -= TAU
    else if (tank.turret < -Math.PI) tank.turret += TAU

    if (input.fire && tank.fireCooldown <= 0) this._fireShell(seat, tank)
  }

  /** Soft push-apart so tanks never fuse; cheaper and less sticky than
   * treating other tanks as hard collision geometry. */
  _separateTanks() {
    for (let a = 0; a < SEAT_COUNT; a++) {
      const ta = this.tanks[a]
      if (!ta.active || !ta.alive) continue
      for (let b = a + 1; b < SEAT_COUNT; b++) {
        const tb = this.tanks[b]
        if (!tb.active || !tb.alive) continue
        let dx = tb.x - ta.x
        let dy = tb.y - ta.y
        let d = Math.hypot(dx, dy)
        const min = TANK_RADIUS * 2
        if (d >= min) continue
        if (d < 1e-4) { dx = 1; dy = 0; d = 1 }
        const push = (min - d) / 2
        const ux = (dx / d) * push
        const uy = (dy / d) * push
        if (this._canOccupy(ta.x - ux, ta.y - uy)) { ta.x -= ux; ta.y -= uy }
        if (this._canOccupy(tb.x + ux, tb.y + uy)) { tb.x += ux; tb.y += uy }
      }
    }
  }

  _canOccupy(x, y) {
    const r = TANK_RADIUS
    if (x - r < ARENA.x || x + r > ARENA.x + ARENA.w) return false
    if (y - r < ARENA.y || y + r > ARENA.y + ARENA.h) return false
    for (const p of this.pillars) {
      if (!p.alive) continue
      if (circleRectHit(x, y, r, p)) return false
    }
    return true
  }

  // ------------------------------------------------------------------
  // Ballistics
  // ------------------------------------------------------------------

  _fireShell(seat, tank) {
    const a = tank.turret
    const nose = TURRET_R + BARREL_LEN + SHELL_RADIUS
    const x = tank.x + Math.cos(a) * nose
    const y = tank.y + Math.sin(a) * nose

    this.shells.push({
      id: this.nextShellId++,
      seat,
      x,
      y,
      vx: Math.cos(a) * SHELL_SPEED,
      vy: Math.sin(a) * SHELL_SPEED,
      bounces: 0,
      age: 0,
    })

    tank.fireCooldown = FIRE_COOLDOWN_MS
    tank.muzzleMs = 90
    tank.recoil = 1
    this._pushEvent({ t: 'fire', x, y, a, s: seat })
  }

  /** Reflect a shell off a rect, pushing it clear first. Returns the surface
   * normal, or null when the shell was not overlapping. */
  _reflectOffRect(s, rect) {
    const r = SHELL_RADIUS
    const nx = Math.max(rect.x, Math.min(s.x, rect.x + rect.w))
    const ny = Math.max(rect.y, Math.min(s.y, rect.y + rect.h))
    let dx = s.x - nx
    let dy = s.y - ny
    const dist = Math.hypot(dx, dy)
    if (dist > r) return null

    if (dist > 1e-6) {
      dx /= dist
      dy /= dist
      const push = r - dist + 0.05
      s.x += dx * push
      s.y += dy * push
    } else {
      // Centre landed inside the rect — eject along the shallowest face.
      const left = s.x - rect.x
      const right = rect.x + rect.w - s.x
      const top = s.y - rect.y
      const bottom = rect.y + rect.h - s.y
      const m = Math.min(left, right, top, bottom)
      if (m === left) { dx = -1; dy = 0; s.x = rect.x - r - 0.05 }
      else if (m === right) { dx = 1; dy = 0; s.x = rect.x + rect.w + r + 0.05 }
      else if (m === top) { dx = 0; dy = -1; s.y = rect.y - r - 0.05 }
      else { dx = 0; dy = 1; s.y = rect.y + rect.h + r + 0.05 }
    }

    const dot = s.vx * dx + s.vy * dy
    s.vx -= 2 * dot * dx
    s.vy -= 2 * dot * dy
    return { x: dx, y: dy }
  }

  _updateShells(dtMs) {
    const remaining = []
    const subDt = dtMs / 1000 / SHELL_SUBSTEPS

    const minX = ARENA.x + SHELL_RADIUS
    const maxX = ARENA.x + ARENA.w - SHELL_RADIUS
    const minY = ARENA.y + SHELL_RADIUS
    const maxY = ARENA.y + ARENA.h - SHELL_RADIUS

    for (const s of this.shells) {
      s.age += dtMs
      let dead = false

      for (let step = 0; step < SHELL_SUBSTEPS && !dead; step++) {
        s.x += s.vx * subDt
        s.y += s.vy * subDt

        // --- Arena walls ---
        let bouncedNormal = null
        if (s.x < minX) { s.x = minX; s.vx = -s.vx; bouncedNormal = { x: 1, y: 0 } }
        else if (s.x > maxX) { s.x = maxX; s.vx = -s.vx; bouncedNormal = { x: -1, y: 0 } }
        if (s.y < minY) { s.y = minY; s.vy = -s.vy; bouncedNormal = { x: 0, y: 1 } }
        else if (s.y > maxY) { s.y = maxY; s.vy = -s.vy; bouncedNormal = { x: 0, y: -1 } }

        if (bouncedNormal) {
          s.bounces++
          this._pushEvent({
            t: 'ric', x: s.x, y: s.y, a: Math.atan2(bouncedNormal.y, bouncedNormal.x), s: s.seat,
          })
          if (s.bounces > SHELL_MAX_BOUNCES) {
            this._pushEvent({ t: 'fizzle', x: s.x, y: s.y, s: s.seat })
            dead = true
            break
          }
        }

        // --- Destructible pillars ---
        for (const p of this.pillars) {
          if (!p.alive) continue
          const n = this._reflectOffRect(s, p)
          if (!n) continue
          s.bounces++
          this._damagePillar(p, s.x, s.y, Math.atan2(n.y, n.x), s.seat)
          if (s.bounces > SHELL_MAX_BOUNCES) {
            this._pushEvent({ t: 'fizzle', x: s.x, y: s.y, s: s.seat })
            dead = true
          }
          break
        }
        if (dead) break

        // --- Tanks ---
        for (let seat = 0; seat < SEAT_COUNT; seat++) {
          const tank = this.tanks[seat]
          if (!tank.active || !tank.alive) continue
          if (seat === s.seat && s.age < SHELL_OWNER_GRACE_MS) continue
          if (tank.invulnMs > 0) continue
          const dx = tank.x - s.x
          const dy = tank.y - s.y
          const hitDist = TANK_RADIUS + SHELL_RADIUS
          if (dx * dx + dy * dy < hitDist * hitDist) {
            this._killTank(seat, s.seat)
            dead = true
            break
          }
        }
      }

      if (dead) continue
      if (s.age > SHELL_MAX_LIFE_MS) {
        this._pushEvent({ t: 'fizzle', x: s.x, y: s.y, s: s.seat })
        continue
      }
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue
      remaining.push(s)
    }

    this.shells = remaining
  }

  _damagePillar(p, x, y, angle, seat) {
    p.hp -= PILLAR_DAMAGE
    if (p.hp > 0) {
      this._pushEvent({ t: 'crack', x, y, a: angle, s: seat, p: p.id })
      return
    }
    p.hp = 0
    p.alive = false
    this._pushEvent({ t: 'wreck', x: p.x + p.w / 2, y: p.y + p.h / 2, s: seat, p: p.id })
  }

  _killTank(seat, bySeat) {
    const tank = this.tanks[seat]
    tank.alive = false
    tank.vx = 0
    tank.vy = 0
    if (bySeat != null && bySeat !== seat && this.tanks[bySeat]) this.tanks[bySeat].kills++
    this._pushEvent({ t: 'kill', x: tank.x, y: tank.y, s: seat })
  }

  // ------------------------------------------------------------------
  // Round / match flow
  // ------------------------------------------------------------------

  _updateRoundState() {
    const activeSeats = []
    for (let s = 0; s < SEAT_COUNT; s++) if (this.tanks[s].active) activeSeats.push(s)
    if (activeSeats.length < 2) return

    const aliveSeats = activeSeats.filter((s) => this.tanks[s].alive)
    if (aliveSeats.length > 1) return

    this.winnerSeat = aliveSeats.length === 1 ? aliveSeats[0] : null
    if (this.winnerSeat != null) this.tanks[this.winnerSeat].wins++

    if (this.winnerSeat != null && this.tanks[this.winnerSeat].wins >= MATCH_WINS) {
      this.matchWinner = this.winnerSeat
      this.roundState = 'matchover'
      this.roundOverMs = MATCH_OVER_MS
    } else {
      this.roundState = 'roundover'
      this.roundOverMs = ROUND_OVER_MS
    }
  }

  _startRound() {
    this.round += 1
    this.roundState = 'countdown'
    this.countdownMs = ROUND_COUNTDOWN_MS
    this.roundOverMs = 0
    this.winnerSeat = null
    this.shells = []
    for (const p of this.pillars) {
      p.hp = p.maxHp
      p.alive = true
    }
    for (let s = 0; s < SEAT_COUNT; s++) {
      if (this.tanks[s].active) this._spawnSeat(s)
      if (this.brains[s]) {
        this.brains[s].state = 'REPOSITION'
        this.brains[s].thinkMs = 0
        this.brains[s].targetSeat = null
        this.brains[s].fireHold = this.brains[s].reactionMs
      }
    }
  }

  _startMatch() {
    this.matchWinner = null
    this.round = 0
    for (const t of this.tanks) {
      t.wins = 0
      t.kills = 0
    }
    this._startRound()
  }

  // ------------------------------------------------------------------
  // Networking payloads
  // ------------------------------------------------------------------

  _pushEvent(e) {
    if (this.events.length < 48) this.events.push(e)
  }

  /** Host: play this tick's events locally, then drop them. */
  _flushEvents() {
    if (!this.events.length) return
    const batch = this.events
    this.events = []
    this._consumeEvents(batch)
  }

  _syncPayload() {
    return {
      type: 'sync',
      tanks: this.tanks.map((t) => ({
        active: t.active,
        alive: t.alive,
        isBot: !!t.isBot,
        x: Math.round(t.x * 10) / 10,
        y: Math.round(t.y * 10) / 10,
        hull: Math.round(t.hull * 1000) / 1000,
        turret: Math.round(t.turret * 1000) / 1000,
        treadL: Math.round(t.treadL * 10) / 10,
        treadR: Math.round(t.treadR * 10) / 10,
        fireCooldown: Math.round(t.fireCooldown),
        invulnMs: Math.round(t.invulnMs),
        muzzleMs: Math.round(t.muzzleMs),
        recoil: Math.round(t.recoil * 100) / 100,
        wins: t.wins,
        kills: t.kills,
      })),
      shells: this.shells.map((s) => ({
        id: s.id,
        seat: s.seat,
        x: Math.round(s.x * 10) / 10,
        y: Math.round(s.y * 10) / 10,
        vx: Math.round(s.vx),
        vy: Math.round(s.vy),
      })),
      pillars: this.pillars.map((p) => ({ hp: p.hp, alive: p.alive })),
      events: this.events,
      roundState: this.roundState,
      round: this.round,
      countdownMs: Math.round(this.countdownMs),
      roundOverMs: Math.round(this.roundOverMs),
      winnerSeat: this.winnerSeat,
      matchWinner: this.matchWinner,
    }
  }

  _broadcastSync() {
    if (!this.p2p) return
    this.p2p.broadcast(this._syncPayload())
  }

  _applyRemotePillars(list) {
    if (!Array.isArray(list)) return
    for (let i = 0; i < this.pillars.length && i < list.length; i++) {
      const src = list[i]
      if (!src) continue
      this.pillars[i].hp = src.hp
      this.pillars[i].alive = !!src.alive
    }
  }

  /** The state the renderer reads: live sim on the host, last sync on clients. */
  _viewState() {
    if (this.isHost) {
      return {
        tanks: this.tanks,
        shells: this.shells,
        pillars: this.pillars,
        roundState: this.roundState,
        round: this.round,
        countdownMs: this.countdownMs,
        roundOverMs: this.roundOverMs,
        winnerSeat: this.winnerSeat,
        matchWinner: this.matchWinner,
      }
    }
    return this.netState
  }

  // ------------------------------------------------------------------
  // Presentation events (particles / sound / camera)
  // ------------------------------------------------------------------

  /** Throttled one-shot sound so a burst of events never machine-guns audio. */
  _sound(fn, key, gapMs) {
    const last = this._sfxAt[key]
    if (last !== undefined && this.elapsed - last < gapMs) return
    this._sfxAt[key] = this.elapsed
    try { fn() } catch { /* audio must never break the frame */ }
  }

  /** Screenshake scaled by how close the blast was to the local player. */
  _impactAt(x, y, { strength = 8, color = null, punch = 1, dirX = 0, dirY = 0 } = {}) {
    if (!this.camera) return
    const me = this._localTank()
    let scale = 0.45
    if (me && Number.isFinite(me.x)) {
      const d = Math.hypot(me.x - x, me.y - y)
      scale = clamp(1 - d / 560, 0.1, 1)
    }
    this.camera.impact({
      strength: strength * scale,
      color: scale > 0.5 ? color : null,
      punch: 1 + (punch - 1) * scale,
      dirX,
      dirY,
    })
  }

  _consumeEvents(list) {
    const fx = this.fx
    for (const e of list) {
      if (!e || typeof e !== 'object') continue
      const color = PLAYER_COLORS[(e.s || 0) % PLAYER_COLORS.length]

      if (e.t === 'fire') {
        fx?.spark(e.x, e.y, e.a, { count: 11, color, speed: 0.42, spread: 0.9, life: 210, size: 2.2 })
        fx?.ring(e.x, e.y, { radius: 16, color: withAlpha(color, 0.9), life: 170, width: 1.8 })
        this._sound(() => sfx.shot(), 'shot', 45)
        this._impactAt(e.x, e.y, {
          strength: 4, punch: 1.004, dirX: -Math.cos(e.a), dirY: -Math.sin(e.a),
        })
      } else if (e.t === 'ric') {
        fx?.spark(e.x, e.y, e.a, { count: 8, color: THEME.ice, speed: 0.34, spread: 1.6, life: 260, size: 1.9 })
        fx?.spark(e.x, e.y, e.a, { count: 4, color, speed: 0.22, spread: 2.4, life: 200, size: 1.5 })
        this._sound(() => sfx.ricochet(), 'ric', 40)
        this._impactAt(e.x, e.y, { strength: 3, punch: 1 })
      } else if (e.t === 'crack') {
        fx?.spark(e.x, e.y, e.a, { count: 12, color: THEME.violet, speed: 0.36, spread: 1.9, life: 320, size: 2.1 })
        fx?.smoke(e.x, e.y, { count: 3, color: '#2a2036', life: 620, size: 7 })
        this._sound(() => sfx.ricochet(), 'crack', 50)
        this._impactAt(e.x, e.y, { strength: 5, punch: 1.006 })
      } else if (e.t === 'wreck') {
        fx?.burst(e.x, e.y, {
          count: 30, color: THEME.magenta, secondary: THEME.violet,
          speed: 0.36, life: 620, size: 3.2, shards: 12, ring: true,
        })
        fx?.smoke(e.x, e.y, { count: 10, color: '#2b2438', life: 1100, size: 13 })
        this._sound(() => sfx.crunch(), 'crunch', 70)
        this._impactAt(e.x, e.y, { strength: 12, color: THEME.magenta, punch: 1.015 })
      } else if (e.t === 'kill') {
        fx?.burst(e.x, e.y, {
          count: 44, color, secondary: THEME.amber,
          speed: 0.52, life: 780, size: 3.6, shards: 16, ring: true,
        })
        fx?.ring(e.x, e.y, { radius: 88, color: withAlpha(color, 0.85), life: 520, width: 3 })
        fx?.smoke(e.x, e.y, { count: 8, color: '#20283a', life: 1200, size: 14 })
        this._sound(() => sfx.boom(), 'boom', 90)
        this._impactAt(e.x, e.y, { strength: 20, color, punch: 1.03 })
        if (e.s === this.mySeat) this.camera?.flash(color, 0.3)
      } else if (e.t === 'fizzle') {
        fx?.ring(e.x, e.y, { radius: 14, color: withAlpha(THEME.amber, 0.8), life: 240, width: 1.4 })
      }
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    if (!ctx) return

    ctx.clearRect(0, 0, this.width, this.height)

    const view = this._viewState()

    if (!view) {
      drawArenaBackdrop(ctx, this.width, this.height, { step: 48, glowAlpha: 0.05 })
      this._drawWaitingOverlay(ctx)
      this.post?.bloom(ctx)
      this.post?.finish(ctx, this.elapsed)
      return
    }

    if (view.roundState === 'lobby') {
      this.startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'Cyber-Tanks Arena',
        seats: view.tanks.map((t) => ({ active: t.active, isBot: !!t.isBot })),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
        message: 'MOUSE AIMS · WASD DRIVES · SPACE / CLICK FIRES',
      })
      this._lastPhase = 'lobby'
      this.post?.bloom(ctx)
      this.post?.finish(ctx, this.elapsed)
      return
    }

    this._trackPhaseAudio(view)

    drawArenaBackdrop(ctx, this.width, this.height, { step: 48, glowAlpha: 0.05 })

    this.camera?.begin(ctx, this.width, this.height)
    this._drawArenaFloor(ctx)
    this.fx?.drawAmbient(ctx)
    this._drawPillars(ctx, view.pillars)
    this._drawShells(ctx, view.shells)
    this._drawTanks(ctx, view.tanks)
    this.fx?.draw(ctx)
    this.camera?.end(ctx)
    this.camera?.drawFlash(ctx, this.width, this.height)

    this._drawScoreboard(ctx, view)
    if (view.roundState === 'countdown') this._drawCountdown(ctx, view)
    if (view.roundState === 'roundover') this._drawBanner(ctx, view.winnerSeat, 'ROUND')
    if (view.roundState === 'matchover') this._drawBanner(ctx, view.matchWinner, 'MATCH')
    if (view.roundState === 'playing') this._drawReticle(ctx, view)

    this.post?.bloom(ctx)
    this.post?.finish(ctx, this.elapsed)
  }

  /** Countdown pips + a match-start sting, driven off the synced phase so the
   * host and every client hear the same cues. */
  _trackPhaseAudio(view) {
    const phase = view.roundState
    if (phase === 'countdown') {
      const sec = Math.ceil(view.countdownMs / 1000)
      if (sec !== this._lastPip) {
        this._lastPip = sec
        if (sec > 0) this._sound(() => sfx.tick(false), 'pip', 200)
      }
    } else {
      this._lastPip = null
    }

    if (phase !== this._lastPhase) {
      if (phase === 'playing' && this._lastPhase === 'countdown') {
        this._sound(() => sfx.matchStart(), 'go', 400)
      } else if (phase === 'matchover') {
        const won = view.matchWinner != null && view.matchWinner === this.mySeat
        this._sound(() => (won ? sfx.win() : sfx.lose()), 'matchend', 800)
      }
      this._lastPhase = phase
    }
  }

  _drawArenaFloor(ctx) {
    ctx.save()

    const g = ctx.createLinearGradient(ARENA.x, ARENA.y, ARENA.x, ARENA.y + ARENA.h)
    g.addColorStop(0, '#080d16')
    g.addColorStop(0.5, '#0a1220')
    g.addColorStop(1, '#070b13')
    roundRect(ctx, ARENA.x, ARENA.y, ARENA.w, ARENA.h, 10)
    ctx.fillStyle = g
    ctx.fill()

    // Inner deck grid, clipped to the arena so it reads as a floor plate.
    ctx.save()
    roundRect(ctx, ARENA.x, ARENA.y, ARENA.w, ARENA.h, 10)
    ctx.clip()
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.045)
    ctx.lineWidth = 1
    for (let x = ARENA.x; x <= ARENA.x + ARENA.w; x += 38) {
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, ARENA.y)
      ctx.lineTo(Math.round(x) + 0.5, ARENA.y + ARENA.h)
      ctx.stroke()
    }
    for (let y = ARENA.y; y <= ARENA.y + ARENA.h; y += 38) {
      ctx.beginPath()
      ctx.moveTo(ARENA.x, Math.round(y) + 0.5)
      ctx.lineTo(ARENA.x + ARENA.w, Math.round(y) + 0.5)
      ctx.stroke()
    }

    // Centre marker
    const cx = ARENA.x + ARENA.w / 2
    const cy = ARENA.y + ARENA.h / 2
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.09)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 128, 0, TAU)
    ctx.stroke()
    ctx.restore()

    // Neon containment edge
    ctx.shadowColor = withAlpha(THEME.cyan, 0.5)
    ctx.shadowBlur = 16
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.55)
    ctx.lineWidth = 2
    roundRect(ctx, ARENA.x + 1, ARENA.y + 1, ARENA.w - 2, ARENA.h - 2, 10)
    ctx.stroke()
    ctx.shadowBlur = 0

    // Corner brackets
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.8)
    ctx.lineWidth = 2.5
    const t = 22
    const corners = [
      [ARENA.x + 4, ARENA.y + 4, 1, 1],
      [ARENA.x + ARENA.w - 4, ARENA.y + 4, -1, 1],
      [ARENA.x + ARENA.w - 4, ARENA.y + ARENA.h - 4, -1, -1],
      [ARENA.x + 4, ARENA.y + ARENA.h - 4, 1, -1],
    ]
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath()
      ctx.moveTo(x + sx * t, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + sy * t)
      ctx.stroke()
    }

    ctx.restore()
  }

  _drawPillars(ctx, pillars) {
    if (!Array.isArray(pillars)) return
    for (let i = 0; i < pillars.length; i++) {
      const state = pillars[i]
      const geo = this.pillars[i]
      if (!geo) continue
      if (!state.alive) {
        this._drawRubble(ctx, geo, i)
        continue
      }
      this._drawPillar(ctx, geo, state, i)
    }
  }

  _drawPillar(ctx, p, state, index) {
    const hpRatio = clamp(state.hp / (p.maxHp || 1), 0, 1)
    const damage = 1 - hpRatio
    const edge = mixColor(THEME.magenta, THEME.violet, 0.35)

    ctx.save()

    // Cast shadow
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    roundRect(ctx, p.x + 4, p.y + 6, p.w, p.h, 6)
    ctx.fill()

    // Body
    const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.h)
    g.addColorStop(0, '#171f33')
    g.addColorStop(1, '#0c111d')
    roundRect(ctx, p.x, p.y, p.w, p.h, 6)
    ctx.fillStyle = g
    ctx.fill()

    // Inner hatch, dimming as the pillar loses integrity
    ctx.save()
    roundRect(ctx, p.x, p.y, p.w, p.h, 6)
    ctx.clip()
    ctx.strokeStyle = withAlpha(edge, 0.1 + 0.12 * hpRatio)
    ctx.lineWidth = 1
    for (let d = -p.h; d < p.w; d += 11) {
      ctx.beginPath()
      ctx.moveTo(p.x + d, p.y)
      ctx.lineTo(p.x + d + p.h, p.y + p.h)
      ctx.stroke()
    }
    ctx.restore()

    // Neon frame — glow fades with damage
    ctx.shadowColor = withAlpha(edge, 0.25 + 0.6 * hpRatio)
    ctx.shadowBlur = 6 + 14 * hpRatio
    ctx.strokeStyle = withAlpha(edge, 0.3 + 0.6 * hpRatio)
    ctx.lineWidth = 1.8
    roundRect(ctx, p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, 6)
    ctx.stroke()
    ctx.shadowBlur = 0

    // Integrity pips along the top edge
    const pips = p.maxHp
    const pipW = Math.min(9, (p.w - 10) / pips - 2)
    if (pipW > 2) {
      const totalW = pips * (pipW + 2) - 2
      let px = p.x + (p.w - totalW) / 2
      for (let i = 0; i < pips; i++) {
        ctx.fillStyle = i < state.hp ? withAlpha(THEME.lime, 0.85) : 'rgba(255,255,255,0.08)'
        ctx.fillRect(px, p.y + 4, pipW, 2)
        px += pipW + 2
      }
    }

    // Progressive fracture lines — deterministic from (pillar, damage step)
    const breaks = p.maxHp - state.hp
    if (breaks > 0) {
      ctx.save()
      roundRect(ctx, p.x, p.y, p.w, p.h, 6)
      ctx.clip()
      for (let d = 0; d < breaks; d++) {
        this._drawCrack(ctx, p, index, d, damage)
      }
      ctx.restore()
    }

    ctx.restore()
  }

  _drawCrack(ctx, p, index, step, damage) {
    const seed = index * 13 + step * 7
    const startEdge = Math.floor(hash01(seed, 1) * 4)
    let sx
    let sy
    const u = hash01(seed, 2)
    if (startEdge === 0) { sx = p.x + u * p.w; sy = p.y }
    else if (startEdge === 1) { sx = p.x + p.w; sy = p.y + u * p.h }
    else if (startEdge === 2) { sx = p.x + u * p.w; sy = p.y + p.h }
    else { sx = p.x; sy = p.y + u * p.h }

    const cx = p.x + p.w / 2
    const cy = p.y + p.h / 2
    let ang = Math.atan2(cy - sy, cx - sx)

    ctx.strokeStyle = withAlpha(THEME.ice, 0.35 + 0.45 * damage)
    ctx.shadowColor = withAlpha(THEME.magenta, 0.5)
    ctx.shadowBlur = 5
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    let x = sx
    let y = sy
    const segs = 5
    const span = Math.max(p.w, p.h) * 0.8
    for (let i = 0; i < segs; i++) {
      ang += (hash01(seed, 10 + i) - 0.5) * 1.15
      const len = (span / segs) * (0.6 + hash01(seed, 20 + i) * 0.8)
      x += Math.cos(ang) * len
      y += Math.sin(ang) * len
      ctx.lineTo(x, y)
    }
    ctx.stroke()

    // A short branch keeps the fracture from reading as a single scratch.
    if (hash01(seed, 33) > 0.45) {
      const bx = lerp(sx, x, 0.5)
      const by = lerp(sy, y, 0.5)
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.moveTo(bx, by)
      ctx.lineTo(
        bx + Math.cos(ang + 1.3) * span * 0.26,
        by + Math.sin(ang + 1.3) * span * 0.26
      )
      ctx.stroke()
    }
    ctx.shadowBlur = 0
  }

  _drawRubble(ctx, p, index) {
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.fillStyle = 'rgba(12,16,26,0.75)'
    roundRect(ctx, p.x + 3, p.y + 3, p.w - 6, p.h - 6, 5)
    ctx.fill()
    ctx.strokeStyle = withAlpha(THEME.magenta, 0.16)
    ctx.lineWidth = 1
    ctx.stroke()
    for (let i = 0; i < 7; i++) {
      const rx = p.x + 6 + hash01(index * 31 + i, 3) * (p.w - 12)
      const ry = p.y + 6 + hash01(index * 31 + i, 9) * (p.h - 12)
      const s = 1.2 + hash01(index * 31 + i, 17) * 2.4
      ctx.fillStyle = withAlpha(THEME.violet, 0.28)
      ctx.beginPath()
      ctx.arc(rx, ry, s, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  _drawShells(ctx, shells) {
    if (!Array.isArray(shells)) return
    for (const s of shells) {
      const color = PLAYER_COLORS[(s.seat || 0) % PLAYER_COLORS.length]
      const ang = Math.atan2(s.vy || 0, s.vx || 1)

      this.fx?.trail(s.x, s.y, { color, size: 3.4, life: 250, drift: 0.012, alpha: 0.7 })

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'

      // Tracer streak
      ctx.strokeStyle = withAlpha(color, 0.55)
      ctx.lineCap = 'round'
      ctx.lineWidth = 2.6
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x - Math.cos(ang) * 16, s.y - Math.sin(ang) * 16)
      ctx.stroke()

      // Hot core
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 9)
      g.addColorStop(0, 'rgba(255,255,255,0.95)')
      g.addColorStop(0.35, withAlpha(color, 0.75))
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(s.x, s.y, 9, 0, TAU)
      ctx.fill()

      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(s.x, s.y, SHELL_RADIUS * 0.72, 0, TAU)
      ctx.fill()
      ctx.restore()
    }
  }

  _drawTanks(ctx, tanks) {
    if (!Array.isArray(tanks)) return
    for (let seat = 0; seat < tanks.length; seat++) {
      const t = tanks[seat]
      if (!t || !t.active || !t.alive) continue
      this._drawTank(ctx, t, seat)
    }
  }

  _drawTank(ctx, t, seat) {
    const color = PLAYER_COLORS[seat % PLAYER_COLORS.length]
    const spawning = t.invulnMs > 0
    const alpha = spawning ? 0.45 + 0.45 * Math.abs(Math.sin(this.elapsed * 0.012)) : 1

    // Ground shadow
    ctx.save()
    ctx.globalAlpha = 0.45
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.beginPath()
    ctx.ellipse(t.x + 3, t.y + 6, 22, 17, 0, 0, TAU)
    ctx.fill()
    ctx.restore()

    // Faint directional glow ahead of the hull
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = alpha * 0.55
    const gx = t.x + Math.cos(t.hull) * 26
    const gy = t.y + Math.sin(t.hull) * 26
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 36)
    glow.addColorStop(0, withAlpha(color, 0.26))
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(gx, gy, 36, 0, TAU)
    ctx.fill()
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(t.x, t.y)
    ctx.rotate(t.hull)

    this._drawTread(ctx, -TRACK_HALF, t.treadL || 0, color)
    this._drawTread(ctx, TRACK_HALF, t.treadR || 0, color)

    // --- Chassis ---
    const body = [
      [HULL_LEN * 0.47, 0],
      [HULL_LEN * 0.33, -10.5],
      [-HULL_LEN * 0.35, -10.5],
      [-HULL_LEN * 0.44, -5.5],
      [-HULL_LEN * 0.44, 5.5],
      [-HULL_LEN * 0.35, 10.5],
      [HULL_LEN * 0.33, 10.5],
    ]
    ctx.beginPath()
    ctx.moveTo(body[0][0], body[0][1])
    for (let i = 1; i < body.length; i++) ctx.lineTo(body[i][0], body[i][1])
    ctx.closePath()
    const hullGrad = ctx.createLinearGradient(0, -11, 0, 11)
    hullGrad.addColorStop(0, mixColor('#131c2e', color, 0.1))
    hullGrad.addColorStop(0.55, '#0d1424')
    hullGrad.addColorStop(1, '#080d17')
    ctx.fillStyle = hullGrad
    ctx.fill()

    ctx.shadowColor = withAlpha(color, 0.85)
    ctx.shadowBlur = 11
    ctx.strokeStyle = withAlpha(color, 0.92)
    ctx.lineWidth = 1.7
    ctx.stroke()
    ctx.shadowBlur = 0

    // Deck detail
    ctx.strokeStyle = withAlpha(color, 0.3)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-HULL_LEN * 0.3, -6.5)
    ctx.lineTo(HULL_LEN * 0.28, -6.5)
    ctx.moveTo(-HULL_LEN * 0.3, 6.5)
    ctx.lineTo(HULL_LEN * 0.28, 6.5)
    ctx.stroke()

    // --- Turret (tracks the aim angle independently of the hull) ---
    ctx.rotate(angleDelta(t.turret, t.hull))

    const recoil = clamp(t.recoil || 0, 0, 1) * 5

    // Barrel
    ctx.beginPath()
    roundRect(ctx, TURRET_R * 0.45 - recoil, -2.7, BARREL_LEN, 5.4, 2)
    ctx.fillStyle = '#0b1120'
    ctx.fill()
    ctx.strokeStyle = withAlpha(color, 0.8)
    ctx.lineWidth = 1.3
    ctx.stroke()

    // Muzzle brake
    roundRect(ctx, TURRET_R * 0.45 - recoil + BARREL_LEN - 6, -4.2, 6, 8.4, 1.6)
    ctx.fillStyle = mixColor('#0b1120', color, 0.25)
    ctx.fill()
    ctx.strokeStyle = withAlpha(color, 0.9)
    ctx.lineWidth = 1.1
    ctx.stroke()

    // Drum
    const drum = ctx.createRadialGradient(-2, -2, 1, 0, 0, TURRET_R)
    drum.addColorStop(0, mixColor('#1a2439', color, 0.18))
    drum.addColorStop(1, '#0a1020')
    ctx.beginPath()
    ctx.arc(0, 0, TURRET_R, 0, TAU)
    ctx.fillStyle = drum
    ctx.fill()
    ctx.shadowColor = withAlpha(color, 0.7)
    ctx.shadowBlur = 9
    ctx.strokeStyle = withAlpha(color, 0.95)
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.shadowBlur = 0

    ctx.beginPath()
    ctx.arc(0, 0, TURRET_R * 0.52, 0, TAU)
    ctx.strokeStyle = withAlpha(color, 0.45)
    ctx.lineWidth = 1
    ctx.stroke()

    // Muzzle flash
    if (t.muzzleMs > 0) {
      const f = clamp(t.muzzleMs / 90, 0, 1)
      const mx = TURRET_R * 0.45 - recoil + BARREL_LEN + 3
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = f
      const fg = ctx.createRadialGradient(mx, 0, 0, mx, 0, 17 * f + 5)
      fg.addColorStop(0, 'rgba(255,255,255,0.95)')
      fg.addColorStop(0.4, withAlpha(THEME.amber, 0.7))
      fg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = fg
      ctx.beginPath()
      ctx.arc(mx, 0, 17 * f + 5, 0, TAU)
      ctx.fill()
      ctx.restore()
    }

    ctx.restore()

    // Local-player marker (screen-aligned so it never spins with the hull)
    if (seat === this.mySeat) {
      ctx.save()
      ctx.strokeStyle = withAlpha(color, 0.55)
      ctx.lineWidth = 1.3
      ctx.setLineDash([5, 7])
      ctx.lineDashOffset = -this.elapsed * 0.02
      ctx.beginPath()
      ctx.arc(t.x, t.y, TANK_RADIUS + 9, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }
  }

  /** One tread belt. Cleats scroll at the wheel speed of that side, so a
   * pivot turn visibly counter-rotates the two belts. */
  _drawTread(ctx, yOff, offset, color) {
    const L = TREAD_LEN
    const W = TREAD_W
    ctx.save()
    ctx.translate(0, yOff)

    roundRect(ctx, -L / 2, -W / 2, L, W, 3)
    ctx.fillStyle = '#080c15'
    ctx.fill()
    ctx.strokeStyle = withAlpha(color, 0.42)
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.save()
    roundRect(ctx, -L / 2, -W / 2, L, W, 3)
    ctx.clip()
    ctx.strokeStyle = withAlpha(color, 0.62)
    ctx.lineWidth = 1.5
    let o = (-offset) % CLEAT_SPACING
    if (o < 0) o += CLEAT_SPACING
    for (let x = -L / 2 - CLEAT_SPACING + o; x < L / 2 + CLEAT_SPACING; x += CLEAT_SPACING) {
      ctx.beginPath()
      ctx.moveTo(x, -W / 2)
      ctx.lineTo(x, W / 2)
      ctx.stroke()
    }
    ctx.restore()

    // Drive sprockets bookend the belt so it reads as machinery.
    ctx.fillStyle = withAlpha(color, 0.5)
    ctx.beginPath()
    ctx.arc(-L / 2 + 2, 0, 1.7, 0, TAU)
    ctx.arc(L / 2 - 2, 0, 1.7, 0, TAU)
    ctx.fill()

    ctx.restore()
  }

  _drawReticle(ctx, view) {
    if (!this.pointerInside || !this.pointer) return
    const me = view.tanks && this.mySeat != null ? view.tanks[this.mySeat] : null
    if (!me || !me.alive) return
    const color = PLAYER_COLORS[this.mySeat % PLAYER_COLORS.length]
    const { x, y } = this.pointer
    const ready = (me.fireCooldown || 0) <= 0

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = withAlpha(ready ? color : THEME.textFaint, ready ? 0.85 : 0.4)
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.arc(x, y, 11, 0, TAU)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - 17, y)
    ctx.lineTo(x - 5, y)
    ctx.moveTo(x + 5, y)
    ctx.lineTo(x + 17, y)
    ctx.moveTo(x, y - 17)
    ctx.lineTo(x, y - 5)
    ctx.moveTo(x, y + 5)
    ctx.lineTo(x, y + 17)
    ctx.stroke()
    ctx.restore()
  }

  _drawScoreboard(ctx, view) {
    drawGlassPanel(ctx, {
      x: BOARD.x,
      y: BOARD.y,
      w: BOARD.w,
      h: BOARD.h,
      radius: 10,
      accent: THEME.cyan,
      glow: 14,
      pad: 10,
    })

    const tanks = view.tanks || []
    const slotW = (BOARD.w - 150) / SEAT_COUNT
    const baseY = BOARD.y + BOARD.h / 2

    ctx.save()
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const t = tanks[seat]
      const x = BOARD.x + 14 + seat * slotW
      const color = PLAYER_COLORS[seat % PLAYER_COLORS.length]
      const active = t && t.active

      // Seat lamp
      ctx.beginPath()
      ctx.arc(x + 7, baseY, 5, 0, TAU)
      if (active && t.alive) {
        ctx.shadowColor = withAlpha(color, 0.9)
        ctx.shadowBlur = 10
        ctx.fillStyle = color
        ctx.fill()
        ctx.shadowBlur = 0
      } else if (active) {
        ctx.strokeStyle = withAlpha(color, 0.45)
        ctx.lineWidth = 1.3
        ctx.stroke()
      } else {
        ctx.strokeStyle = 'rgba(120,140,170,0.25)'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      if (!active) {
        ctx.font = `600 10px ${FONT_MONO}`
        ctx.fillStyle = 'rgba(120,140,170,0.4)'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText('OPEN', x + 20, baseY)
        continue
      }

      const isMe = seat === this.mySeat
      const label = t.isBot ? BOT_NAMES[seat % BOT_NAMES.length] : (isMe ? `${SEAT_NAMES[seat]} · YOU` : SEAT_NAMES[seat])

      ctx.font = `700 11.5px ${FONT_UI}`
      ctx.fillStyle = t.alive ? THEME.text : THEME.textFaint
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(label, x + 20, baseY - 4)

      ctx.font = `700 10px ${FONT_MONO}`
      ctx.fillStyle = withAlpha(color, 0.85)
      ctx.fillText(`${String(t.wins || 0).padStart(2, '0')} WINS`, x + 20, baseY + 9)

      if (!t.alive) {
        ctx.font = `700 9px ${FONT_MONO}`
        ctx.fillStyle = withAlpha(THEME.magenta, 0.8)
        ctx.fillText('WRECKED', x + 78, baseY + 9)
      } else {
        // Reload gauge
        const ratio = 1 - clamp((t.fireCooldown || 0) / FIRE_COOLDOWN_MS, 0, 1)
        drawBar(ctx, {
          x: x + 78,
          y: baseY + 4,
          w: Math.max(26, slotW - 108),
          h: 4,
          value: ratio,
          color: ratio >= 1 ? THEME.lime : withAlpha(color, 0.8),
          radius: 2,
        })
      }
    }

    // Round / phase telemetry on the right.
    const rx = BOARD.x + BOARD.w - 18
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.font = `600 9px ${FONT_MONO}`
    ctx.fillStyle = THEME.textFaint
    ctx.fillText('ROUND', rx, baseY - 4)
    ctx.font = `700 14px ${FONT_MONO}`
    ctx.fillStyle = THEME.cyan
    ctx.fillText(String(view.round || 1).padStart(2, '0'), rx, baseY + 11)

    ctx.font = `600 9px ${FONT_MONO}`
    ctx.fillStyle = THEME.textFaint
    ctx.fillText(`FIRST TO ${MATCH_WINS}`, rx - 34, baseY + 11)

    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
    ctx.restore()
  }

  _drawCountdown(ctx, view) {
    const secs = Math.max(1, Math.ceil(view.countdownMs / 1000))
    const cx = this.width / 2
    const cy = this.height / 2
    drawNeonText(ctx, String(secs), cx, cy + 14, {
      font: `800 74px ${FONT_UI}`,
      color: THEME.cyan,
      glow: 32,
      align: 'center',
      alpha: 0.9,
    })
    drawNeonText(ctx, 'SYSTEMS ONLINE', cx, cy + 50, {
      font: `700 12px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
      align: 'center',
    })
  }

  _drawBanner(ctx, winnerSeat, scope) {
    const w = 460
    const h = 122
    const x = (this.width - w) / 2
    const y = this.height / 2 - h / 2
    const accent = winnerSeat != null
      ? PLAYER_COLORS[winnerSeat % PLAYER_COLORS.length]
      : THEME.textDim

    drawGlassPanel(ctx, { x, y, w, h, radius: 14, accent, glow: 28, pad: 16 })

    const title = winnerSeat != null
      ? `${SEAT_NAMES[winnerSeat]} TAKES THE ${scope}`
      : 'MUTUAL DESTRUCTION'

    drawNeonText(ctx, title, this.width / 2, y + 56, {
      font: `800 ${scope === 'MATCH' ? 26 : 23}px ${FONT_UI}`,
      color: accent,
      glow: 22,
      align: 'center',
    })

    const sub = scope === 'MATCH' ? 'NEW MATCH SPINNING UP…' : 'REARMING FOR NEXT ROUND…'
    drawNeonText(ctx, sub, this.width / 2, y + 86, {
      font: `600 11.5px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
      align: 'center',
    })
  }

  _drawWaitingOverlay(ctx) {
    drawNeonText(ctx, 'LINKING TO HOST', this.width / 2, this.height / 2, {
      font: `800 24px ${FONT_UI}`,
      color: THEME.cyan,
      glow: 20,
      align: 'center',
    })
    drawNeonText(ctx, 'AWAITING FIRST STATE PACKET', this.width / 2, this.height / 2 + 26, {
      font: `600 11px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
      align: 'center',
    })
  }
}
