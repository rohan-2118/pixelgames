// src/games/multiplayer/snake6.js
//
// Snake Royale 6 — host-authoritative, serverless 6-player light-cycle
// arena (Tron-style). All state lives strictly in RAM for the lifetime of
// the room; nothing is ever written to localStorage, cookies, or
// IndexedDB.
//
// Networking model:
//   - Host (p2p.isHost === true) owns the entire simulation. It runs a
//     fixed 30Hz tick (`TICK_MS`) exactly as the spec requires; every
//     player auto-advances one grid cell every `STEP_MS` (a few ticks),
//     so "no input" still means "still moving" — steering only changes
//     heading, it never starts/stops motion.
//   - Every tick the host broadcasts a full state snapshot via
//     `p2p.broadcast({ type: 'sync', ... })`, matching the pattern used
//     by every other 30Hz arcade game (Tank Arena 4, Quad Pong, Bomber
//     Blitz 4).
//   - Clients only ever capture directional key presses and forward the
//     desired heading to the host via
//     `p2p.broadcast({ type: 'input', dir }) `; they never simulate
//     anything locally, they just render the latest synced grid.
//   - Collision rule: stepping onto ANY occupied cell (your own trail,
//     any rival's trail, or outside the arena bounds) instantly
//     eliminates that player. Two riders turning into the exact same
//     empty cell on the same tick both crash (mutual elimination).
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)

import { drawLobby, fillBots, canvasPoint, hit, botNoise, findReclaimSeat, findLobbySeat } from '../shared/lobby.js'
import { cloneState, snapshotFromState, applyStateSnapshot } from '../shared/snapshot.js'
import {
  THEME,
  FONT_MONO,
  FONT_UI,
  drawArenaBackdrop,
  drawGlassPanel,
  drawNeonText,
  withAlpha,
} from '../../fx/theme.js'

const TICK_HZ = 30
const TICK_MS = 1000 / TICK_HZ
const STEP_MS = 130 // one grid cell advance every ~130ms
const SEAT_COUNT = 6

const CELL = 20
const GRID_COLS = 48 // 48 * 20 = 960
const GRID_ROWS = 27 // 27 * 20 = 540

const ROUND_OVER_MS = 4200

const SEAT_COLORS = ['#00e5ff', '#ff007f', '#39ff14', '#ffd23f', '#b980ff', '#5ad8ff']
const SEAT_NAMES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']

const DIR_VECTORS = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
}
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' }

// Deterministic hexagon-ring spawn layout, headings pointed inward so no
// rider immediately crashes into their own freshly-placed trail cell.
const SPAWNS = [
  { row: 13, col: 6, dir: 'right' },
  { row: 4, col: 16, dir: 'down' },
  { row: 4, col: 32, dir: 'down' },
  { row: 13, col: 42, dir: 'left' },
  { row: 22, col: 32, dir: 'up' },
  { row: 22, col: 16, dir: 'up' },
]

const KEY_TO_DIR = {
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
}

export default class Snake6Game {
  /**
   * @param {HTMLCanvasElement} canvas - Shared 960x540 arcade canvas.
   * @param {object} p2pContext - Host-authoritative networking context.
   */
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2p = p2pContext
    this.isHost = !!(p2pContext && p2pContext.isHost)
    this.width = canvas.width || 960
    this.height = canvas.height || 540

    this.running = false
    this.raf = null
    this.lastTime = 0
    this.tickAccumulator = 0
    this.stepAccumulator = 0

    this.mySeat = this.isHost ? 0 : null
    this.peerSeats = new Map()

    // Host-authoritative simulation internals.
    this.occ = new Int8Array(GRID_COLS * GRID_ROWS).fill(-1)
    this.heads = Array.from({ length: SEAT_COUNT }, () => ({ row: 0, col: 0, dir: 'right' }))
    this.alive = new Array(SEAT_COUNT).fill(false)
    this.pendingDir = new Array(SEAT_COUNT).fill(null)

    this.state = this._emptyState()
    this.startRect = null
    this.simTime = 0

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._loop = this._loop.bind(this)

    if (this.isHost) {
      this.state.players[0].active = true
      this.state.players[0].isBot = false
    }
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    window.addEventListener('keydown', this._onKeyDown)
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    window.removeEventListener('keydown', this._onKeyDown)
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
  }

  getMatchSnapshot() {
    return snapshotFromState(this, {
      peerSeats: Array.from(this.peerSeats.entries()),
      occ: Array.from(this.occ),
      heads: cloneState(this.heads),
      alive: cloneState(this.alive),
      pendingDir: cloneState(this.pendingDir),
      simTime: this.simTime,
    })
  }

  applyMatchSnapshot(snap) {
    if (!applyStateSnapshot(this, snap)) return false
    if (this.isHost) this.peerSeats = new Map()
    if (Array.isArray(snap.occ)) this.occ = new Int8Array(snap.occ)
    if (Array.isArray(snap.heads)) this.heads = cloneState(snap.heads)
    if (Array.isArray(snap.alive)) this.alive = cloneState(snap.alive)
    if (Array.isArray(snap.pendingDir)) this.pendingDir = cloneState(snap.pendingDir)
    if (typeof snap.simTime === 'number') this.simTime = snap.simTime
    return true
  }

  onPeerJoin(peerId) {
    if (!this.isHost) return
    const inLobby = this.state.phase === 'lobby'
    let seat = inLobby
      ? findLobbySeat(this.state.players)
      : findReclaimSeat(this.state.players, this.peerSeats)
    if (seat < 0) return
    if (inLobby) this.state.players[seat] = { active: true, isBot: false, wins: 0 }
    this.peerSeats.set(peerId, seat)
    this.p2p?.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })
    this._broadcast()
  }

  onPeerLeave(peerId) {
    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    this.state.players[seat].active = false
    this.alive[seat] = false
    this.peerSeats.delete(peerId)

    if (this._activeSeats().length < 2 && this.state.phase !== 'lobby') {
      this.state.phase = 'lobby'
      this.state.message = 'Share the room link, then press START when ready.'
      this._broadcast()
      return
    }
    this._checkRoundOver()
    this._broadcast()
  }

  onPeerAction(data, peerId) {
    if (!data || typeof data !== 'object') return

    if (data.type === 'welcome' && !this.isHost) {
      this.mySeat = data.seat
      return
    }
    if (data.type === 'sync' && !this.isHost) {
      this.state = data.state
      return
    }

    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null || data.type !== 'input') return
    if (typeof data.dir === 'string' && DIR_VECTORS[data.dir]) {
      this.pendingDir[seat] = data.dir
    }
  }

  // --------------------------------------------------------------------
  // Host-authoritative state machine
  // --------------------------------------------------------------------

  _emptyState() {
    return {
      players: Array.from({ length: SEAT_COUNT }, () => ({ active: false, isBot: false, wins: 0 })),
      phase: 'lobby', // 'lobby' | 'playing' | 'roundover'
      alive: new Array(SEAT_COUNT).fill(false),
      occ: Array.from(this.occ),
      heads: Array.from({ length: SEAT_COUNT }, () => null),
      message: 'Share the room link, then press START when ready.',
      winner: null,
      roundOverMs: 0,
    }
  }

  _lobbySeats() {
    return this.state.players.map((p) => ({ active: p.active, isBot: !!p.isBot }))
  }

  _activateBotSeat(seat) {
    this.state.players[seat].active = true
    this.state.players[seat].isBot = true
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
    if (!this.isHost || this.state.phase !== 'lobby') return
    fillBots(this._lobbySeats(), SEAT_COUNT, (seat) => this._activateBotSeat(seat))
    this._startRound()
  }

  _onPointerDown(event) {
    if (!this.isHost || this.state.phase !== 'lobby') return
    const pt = canvasPoint(this.canvas, event, this.width, this.height)
    if (this.startRect && hit(pt, this.startRect)) this._hostPressStart()
  }

  /**
   * Look-ahead light-cycle AI: score each legal turn by open runway length,
   * wall clearance, and optional aggression toward the nearest rival head.
   */
  _botSnakeDir(seat) {
    const head = this.heads[seat]
    if (!head || !this.alive[seat]) return null
    const cur = head.dir
    const options = ['up', 'down', 'left', 'right'].filter((d) => d !== OPPOSITE[cur])

    // Soft attractor: nearest living rival.
    let target = null
    let bestD = Infinity
    for (let s = 0; s < SEAT_COUNT; s++) {
      if (s === seat || !this.alive[s] || !this.state.players[s]?.active) continue
      const h = this.heads[s]
      const d = Math.abs(h.row - head.row) + Math.abs(h.col - head.col)
      if (d < bestD) {
        bestD = d
        target = h
      }
    }

    let bestDir = null
    let bestScore = -Infinity
    for (const dir of options) {
      const score = this._scoreSnakeDir(seat, head.row, head.col, dir, target)
      const noise = (botNoise(seat, this.simTime, dir.charCodeAt(0)) - 0.5) * 2
      if (score + noise > bestScore) {
        bestScore = score + noise
        bestDir = dir
      }
    }

    // Keep going straight if it's clearly safe and turning isn't much better.
    const straightScore = this._scoreSnakeDir(seat, head.row, head.col, cur, target)
    if (straightScore >= bestScore - 3 && straightScore > 4) return null
    return bestDir
  }

  _scoreSnakeDir(seat, row, col, dir, target) {
    const [dr, dc] = DIR_VECTORS[dir]
    let r = row
    let c = col
    let open = 0
    const maxLook = 14
    for (let i = 0; i < maxLook; i++) {
      r += dr
      c += dc
      if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) break
      const occ = this.occ[r * GRID_COLS + c]
      if (occ != null && occ >= 0) break
      // Don't steer into a cell another alive head is about to claim on this step.
      let contested = false
      for (let s = 0; s < SEAT_COUNT; s++) {
        if (s === seat || !this.alive[s]) continue
        const h = this.heads[s]
        const [odr, odc] = DIR_VECTORS[h.dir]
        if (h.row + odr === r && h.col + odc === c) contested = true
      }
      if (contested) break
      open++
    }

    if (open === 0) return -100

    let score = open * 10
    // Prefer staying off walls when space is equal.
    const nr = row + dr
    const nc = col + dc
    if (nr <= 1 || nc <= 1 || nr >= GRID_ROWS - 2 || nc >= GRID_COLS - 2) score -= 4

    if (target) {
      const before = Math.abs(target.row - row) + Math.abs(target.col - col)
      const after = Math.abs(target.row - nr) + Math.abs(target.col - nc)
      // Mild aggression only when we have runway left.
      if (open >= 5) score += (before - after) * 3
    }
    return score
  }

  _activeSeats() {
    return this.state.players.map((player, seat) => (player.active ? seat : -1)).filter((seat) => seat >= 0)
  }

  _startRound() {
    if (!this.isHost) return
    const active = this._activeSeats()
    if (active.length < 2) {
      this.state.phase = 'lobby'
      this.state.message = 'Share the room link, then press START when ready.'
      this._broadcast()
      return
    }

    this.occ.fill(-1)
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const isActive = this.state.players[seat].active
      this.alive[seat] = isActive
      this.pendingDir[seat] = null
      const spawn = SPAWNS[seat]
      this.heads[seat] = { row: spawn.row, col: spawn.col, dir: spawn.dir }
      if (isActive) this.occ[spawn.row * GRID_COLS + spawn.col] = seat
    }

    this.state.phase = 'playing'
    this.state.winner = null
    this.state.message = 'Steer with arrows / WASD. Avoid every trail!'
    this._syncFromSim()
    this._broadcast()
  }

  _stepGrid() {
    const alive = this.state.players
      .map((player, seat) => (player.active && this.alive[seat] ? seat : -1))
      .filter((seat) => seat >= 0)
    if (!alive.length) return

    for (const seat of alive) {
      const want = this.pendingDir[seat]
      if (want && want !== OPPOSITE[this.heads[seat].dir]) {
        this.heads[seat].dir = want
      }
      this.pendingDir[seat] = null
    }

    const intents = {}
    for (const seat of alive) {
      const { row, col, dir } = this.heads[seat]
      const [dr, dc] = DIR_VECTORS[dir]
      intents[seat] = { row: row + dr, col: col + dc }
    }

    const toEliminate = new Set()
    for (const seat of alive) {
      const { row, col } = intents[seat]
      if (row < 0 || col < 0 || row >= GRID_ROWS || col >= GRID_COLS) {
        toEliminate.add(seat)
        continue
      }
      if (this.occ[row * GRID_COLS + col] !== -1) toEliminate.add(seat)
    }

    const cellClaims = new Map()
    for (const seat of alive) {
      if (toEliminate.has(seat)) continue
      const { row, col } = intents[seat]
      const key = row * GRID_COLS + col
      if (!cellClaims.has(key)) cellClaims.set(key, [])
      cellClaims.get(key).push(seat)
    }
    for (const seats of cellClaims.values()) {
      if (seats.length > 1) seats.forEach((seat) => toEliminate.add(seat))
    }

    for (const seat of alive) {
      if (toEliminate.has(seat)) {
        this.alive[seat] = false
        continue
      }
      const { row, col } = intents[seat]
      this.occ[row * GRID_COLS + col] = seat
      this.heads[seat] = { row, col, dir: this.heads[seat].dir }
    }

    this._checkRoundOver()
  }

  _checkRoundOver() {
    const activeCount = this._activeSeats().length
    const aliveSeats = this.state.players
      .map((player, seat) => (player.active && this.alive[seat] ? seat : -1))
      .filter((seat) => seat >= 0)

    if (activeCount > 1 && aliveSeats.length <= 1 && this.state.phase === 'playing') {
      this.state.phase = 'roundover'
      this.state.winner = aliveSeats[0] ?? null
      if (aliveSeats.length) this.state.players[aliveSeats[0]].wins++
      this.state.message = aliveSeats.length ? `${SEAT_NAMES[aliveSeats[0]]} survives the grid!` : 'Double knockout!'
      this.state.roundOverMs = ROUND_OVER_MS
    }
  }

  _syncFromSim() {
    this.state.alive = Array.from({ length: SEAT_COUNT }, (_, seat) => this.alive[seat])
    this.state.occ = Array.from(this.occ)
    this.state.heads = this.heads.map((head, seat) =>
      this.state.players[seat].active && this.alive[seat] ? { row: head.row, col: head.col } : null
    )
  }

  _broadcast() {
    this._syncFromSim()
    this.p2p?.broadcast({ type: 'sync', state: this.state })
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(50, now - this.lastTime)
    this.lastTime = now

    if (this.isHost) {
      this.tickAccumulator += dt
      while (this.tickAccumulator >= TICK_MS) {
        this.tickAccumulator -= TICK_MS
        this._hostTick(TICK_MS)
      }
    }

    this._render()
    this.raf = requestAnimationFrame(this._loop)
  }

  _hostTick(dtMs) {
    this.simTime += dtMs
    if (this.state.phase === 'lobby') {
      this._broadcast()
      return
    }
    if (this.state.phase === 'playing') {
      for (let seat = 0; seat < SEAT_COUNT; seat++) {
        const player = this.state.players[seat]
        if (!player.active || !player.isBot || !this.alive[seat]) continue
        const dir = this._botSnakeDir(seat)
        if (dir) this.pendingDir[seat] = dir
      }
      this.stepAccumulator += dtMs
      let stepped = false
      while (this.stepAccumulator >= STEP_MS) {
        this.stepAccumulator -= STEP_MS
        this._stepGrid()
        stepped = true
      }
      if (stepped) this._broadcast()
    } else if (this.state.phase === 'roundover') {
      this.state.roundOverMs -= dtMs
      if (this.state.roundOverMs <= 0) {
        this._startRound()
      } else {
        this._broadcast()
      }
    }
  }

  // --------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------

  _onKeyDown(event) {
    if (event.repeat || this.mySeat == null) return
    const dir = KEY_TO_DIR[event.key]
    if (!dir) return
    event.preventDefault()
    if (this.isHost) {
      this.pendingDir[this.mySeat] = dir
    } else {
      this.p2p?.broadcast({ type: 'input', dir })
    }
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    const state = this.state

    drawArenaBackdrop(ctx, this.width, this.height, { step: 20 })

    if (state.phase === 'lobby') {
      this.startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'Snake Royale 6',
        seats: state.players.map((p) => ({ active: p.active, isBot: !!p.isBot })),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
      })
      return
    }

    // Soft neon grid
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.06)
    ctx.lineWidth = 1
    for (let c = 0; c <= GRID_COLS; c++) {
      ctx.beginPath()
      ctx.moveTo(c * CELL, 0)
      ctx.lineTo(c * CELL, this.height)
      ctx.stroke()
    }
    for (let r = 0; r <= GRID_ROWS; r++) {
      ctx.beginPath()
      ctx.moveTo(0, r * CELL)
      ctx.lineTo(this.width, r * CELL)
      ctx.stroke()
    }

    // Trails with glow bloom
    const occ = state.occ || []
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const seat = occ[row * GRID_COLS + col]
        if (seat == null || seat < 0) continue
        const color = SEAT_COLORS[seat]
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur = 10
        ctx.fillStyle = withAlpha(color, 0.72)
        ctx.fillRect(col * CELL + 2, row * CELL + 2, CELL - 4, CELL - 4)
        ctx.restore()
        ctx.fillStyle = withAlpha('#ffffff', 0.18)
        ctx.fillRect(col * CELL + 4, row * CELL + 4, CELL - 8, 3)
      }
    }

    if (Array.isArray(state.heads)) {
      state.heads.forEach((head, seat) => {
        if (!head || !state.players[seat]?.active || !state.alive?.[seat]) return
        const color = SEAT_COLORS[seat]
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur = 18
        ctx.fillStyle = color
        ctx.fillRect(head.col * CELL + 1, head.row * CELL + 1, CELL - 2, CELL - 2)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(head.col * CELL + 5, head.row * CELL + 5, CELL - 10, CELL - 10)
        ctx.restore()
      })
    }

    this._drawHud(ctx)
    if (state.phase === 'roundover') this._drawBanner(ctx)
  }

  _drawHud(ctx) {
    const state = this.state
    const activeCount = state.players.filter((p) => p.active).length
    drawGlassPanel(ctx, {
      x: 10,
      y: 8,
      w: 240,
      h: 28 + activeCount * 22,
      accent: THEME.cyan,
      title: 'LIGHT CYCLE',
      glow: 14,
    })

    let row = 0
    ctx.font = `600 11px ${FONT_MONO}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    state.players.forEach((player, seat) => {
      if (!player.active) return
      const y = 36 + row++ * 22
      const isAlive = state.alive?.[seat]
      ctx.fillStyle = SEAT_COLORS[seat]
      ctx.beginPath()
      ctx.arc(26, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = isAlive ? THEME.text : THEME.textDim
      const you = seat === this.mySeat ? ' YOU' : player.isBot ? ' BOT' : ''
      ctx.fillText(
        `${SEAT_NAMES[seat]}${you}  ${isAlive || state.phase === 'lobby' ? 'IN' : 'OUT'}  W${player.wins}`,
        38,
        y,
      )
    })

    drawNeonText(ctx, state.message, this.width / 2, 22, {
      font: `600 13px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
    })
  }

  _drawBanner(ctx) {
    const state = this.state
    drawGlassPanel(ctx, {
      x: this.width / 2 - 230,
      y: this.height / 2 - 44,
      w: 460,
      h: 88,
      accent: state.winner == null ? THEME.amber : SEAT_COLORS[state.winner],
      glow: 26,
    })
    drawNeonText(ctx, state.message, this.width / 2, this.height / 2 + 4, {
      font: `800 22px ${FONT_UI}`,
      color: state.winner == null ? THEME.text : SEAT_COLORS[state.winner],
      glow: 16,
    })
  }
}
