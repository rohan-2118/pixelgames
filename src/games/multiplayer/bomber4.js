// src/games/multiplayer/bomber4.js
//
// Bomber Blitz 4 — host-authoritative, serverless 4-player grid bomber
// battle. All state lives strictly in RAM for the lifetime of the room;
// nothing is ever written to localStorage/cookies/IndexedDB.
//
// Networking model:
//   - Host (p2p.isHost === true) owns the entire simulation: the 15x11
//     grid, bomb fuses, cross-shaped explosions, power-ups, and player
//     movement/collision. It runs a fixed 30Hz tick and broadcasts a full
//     state snapshot every tick via `p2p.broadcast({ type: 'sync', ... })`.
//     The grid is authored once by the host and streamed to clients inside
//     every sync frame (it mutates as blocks are destroyed, so it can't be
//     treated as static/deterministic the way simple obstacle layouts can).
//   - Clients (p2p.isHost === false) only capture local movement input and
//     bomb-placement key presses, forwarding them via
//     `p2p.broadcast({ type: 'input', ... })` (continuous movement) and
//     `p2p.broadcast({ type: 'bomb' })` (one-shot per key press), then
//     render whatever the latest `sync` snapshot contains.
//   - Since Trystero rooms are a full mesh, a client never automatically
//     learns its own peer id. The host sends a one-off, individually
//     targeted `{ type: 'welcome' }` via `p2p.sendTo(peerId, ...)` the
//     moment a peer connects, echoing back their own peer id
//     (`yourPeerId`) alongside their assigned seat/spawn corner.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)

import { drawLobby, fillBots, canvasPoint, hit, botNoise, findReclaimSeat } from '../shared/lobby.js'
import { cloneState } from '../shared/snapshot.js'
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
const SEAT_COUNT = 4

const GRID_COLS = 15
const GRID_ROWS = 11
const CELL = 40
const GRID_W = GRID_COLS * CELL
const GRID_H = GRID_ROWS * CELL

const SEAT_COLORS = ['#00e5ff', '#ff007f', '#39ff14', '#ffd23f']
const SEAT_GLOW = ['rgba(0,229,255,0.6)', 'rgba(255,0,127,0.6)', 'rgba(57,255,20,0.6)', 'rgba(255,210,63,0.6)']
const SEAT_NAMES = ['P1', 'P2', 'P3', 'P4']
const SPAWN_CELLS = [
  [1, 1],
  [1, GRID_COLS - 2],
  [GRID_ROWS - 2, GRID_COLS - 2],
  [GRID_ROWS - 2, 1],
]

const BLOCK_DENSITY = 0.48

const PLAYER_RADIUS = 13
const PLAYER_BASE_SPEED = 138 // px / second
const PLAYER_SPEED_STEP = 28 // added per speed level
const MAX_SPEED_LEVEL = 4

const BOMB_FUSE_MS = 2500
const BOMB_BASE_RADIUS = 1
const MAX_BLAST_RADIUS = 6
const BOMB_BASE_CAPACITY = 1
const MAX_BOMB_CAPACITY = 5

const EXPLOSION_VISUAL_MS = 420
const RESPAWN_INVULN_MS = 1500
const POWERUP_DROP_CHANCE = 0.38
const POWERUP_KINDS = ['blast', 'speed', 'bomb']

const ROUND_OVER_DISPLAY_MS = 4200

const MOVE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ',
  'a', 'A', 'd', 'D', 'w', 'W', 's', 'S',
])

const COLORS = {
  background: '#0b0f19',
  cellEmpty: '#0d1220',
  cellEmptyEdge: 'rgba(0, 229, 255, 0.05)',
  solid: '#232b45',
  solidEdge: '#00e5ff',
  block: '#1c3a2e',
  blockEdge: '#39ff14',
  bomb: '#141a2c',
  bombFuseCold: '#39ff14',
  bombFuseHot: '#ff007f',
  explosion: '#ffd23f',
  explosionCore: '#ff007f',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  panel: 'rgba(11, 15, 25, 0.72)',
}

function buildGrid() {
  const grid = []
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = []
    for (let c = 0; c < GRID_COLS; c++) {
      if (r === 0 || c === 0 || r === GRID_ROWS - 1 || c === GRID_COLS - 1) row.push('solid')
      else if (r % 2 === 0 && c % 2 === 0) row.push('solid')
      else row.push('empty')
    }
    grid.push(row)
  }

  // Soft start: clear a 2-cell cross around every spawn so the opening
  // never feels boxed-in before the first bomb.
  const clear = new Set()
  for (const [sr, sc] of SPAWN_CELLS) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (Math.abs(dr) + Math.abs(dc) > 2) continue
        clear.add(`${sr + dr},${sc + dc}`)
      }
    }
  }

  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (grid[r][c] !== 'empty') continue
      if (clear.has(`${r},${c}`)) continue
      if (Math.random() < BLOCK_DENSITY) grid[r][c] = 'block'
    }
  }

  return grid
}

function cellCenter(row, col, offsetX, offsetY) {
  return { x: offsetX + col * CELL + CELL / 2, y: offsetY + row * CELL + CELL / 2 }
}

export default class Bomber4Game {
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
    this.offsetX = (this.width - GRID_W) / 2
    this.offsetY = 56 + (this.height - 56 - GRID_H) / 2

    this.running = false
    this.rafId = null
    this.lastTime = 0
    this.tickAccumulator = 0

    this.mySeat = this.isHost ? 0 : null
    this.myPeerId = null
    this.hostPeerId = null

    this.keysDown = new Set()
    this.lastSentInput = null
    this.spaceHeldLocally = false

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._loop = this._loop.bind(this)
    this.startRect = null
    this.simTime = 0

    // ---- Host-authoritative state ----
    this.peerSeatMap = new Map()
    this.inputs = [null, null, null, null] // { up, down, left, right } per remote seat
    this.pendingBombs = new Set() // seats that requested a bomb this tick
    this.grid = null
    this.players = this._createPlayers()
    this.bombs = [] // { row, col, fuseMs, ownerSeat, blastRadius, detonated }
    this.explosions = [] // { row, col, ttlMs }
    this.powerups = new Map() // "row,col" -> kind
    this.roundState = 'lobby'
    this.roundOverMs = 0
    this.winnerSeat = null

    // ---- Client render state ----
    this.netState = null

    if (this.isHost) {
      this.players[0].active = true
      this.players[0].isBot = false
    }
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    this.lastTime = performance.now()
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
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
  }

  getMatchSnapshot() {
    return {
      kind: 'realtime',
      mySeat: this.mySeat,
      myPeerId: this.myPeerId,
      hostPeerId: this.hostPeerId,
      roundState: this.roundState,
      roundOverMs: this.roundOverMs,
      winnerSeat: this.winnerSeat,
      simTime: this.simTime,
      peerSeatMap: Array.from(this.peerSeatMap.entries()),
      inputs: cloneState(this.inputs),
      pendingBombs: Array.from(this.pendingBombs),
      grid: this.grid ? cloneState(this.grid) : null,
      players: cloneState(this.players),
      bombs: cloneState(this.bombs),
      explosions: cloneState(this.explosions),
      powerups: Array.from(this.powerups.entries()),
      netState: this.netState ? cloneState(this.netState) : null,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'realtime') return false
    if (snap.mySeat !== undefined) this.mySeat = snap.mySeat
    if (snap.myPeerId !== undefined) this.myPeerId = snap.myPeerId
    if (snap.hostPeerId !== undefined) this.hostPeerId = snap.hostPeerId
    if (typeof snap.roundState === 'string') this.roundState = snap.roundState
    if (typeof snap.roundOverMs === 'number') this.roundOverMs = snap.roundOverMs
    if (snap.winnerSeat !== undefined) this.winnerSeat = snap.winnerSeat
    if (typeof snap.simTime === 'number') this.simTime = snap.simTime
    if (Array.isArray(snap.peerSeatMap)) this.peerSeatMap = new Map(snap.peerSeatMap)
    if (Array.isArray(snap.inputs)) this.inputs = cloneState(snap.inputs)
    if (Array.isArray(snap.pendingBombs)) this.pendingBombs = new Set(snap.pendingBombs)
    if (Array.isArray(snap.grid)) this.grid = cloneState(snap.grid)
    if (Array.isArray(snap.players)) this.players = cloneState(snap.players)
    if (Array.isArray(snap.bombs)) this.bombs = cloneState(snap.bombs)
    if (Array.isArray(snap.explosions)) this.explosions = cloneState(snap.explosions)
    if (Array.isArray(snap.powerups)) this.powerups = new Map(snap.powerups)
    if (snap.netState && typeof snap.netState === 'object') this.netState = cloneState(snap.netState)
    else if (snap.netState === null) this.netState = null
    return true
  }

  onPeerJoin(peerId) {
    if (!this.isHost) return
    let seat = -1
    if (this.roundState === 'lobby') {
      seat = this._assignSeat(peerId)
    } else {
      seat = findReclaimSeat(this.players, this.peerSeatMap)
      if (seat >= 0) {
        this.peerSeatMap.set(peerId, seat)
        if (!this.inputs[seat]) {
          this.inputs[seat] = { up: false, down: false, left: false, right: false }
        }
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
            up: !!data.up,
            down: !!data.down,
            left: !!data.left,
            right: !!data.right,
          }
        }
      }
      return
    }

    if (data.type === 'bomb') {
      if (this.isHost) {
        const seat = this.peerSeatMap.get(peerId)
        if (seat != null) this.pendingBombs.add(seat)
      }
      return
    }

    if (data.type === 'sync') {
      if (!this.isHost) {
        this.hostPeerId = peerId
        this.netState = data
      }
      return
    }
  }

  // --------------------------------------------------------------------
  // Seat management (host only)
  // --------------------------------------------------------------------

  _createPlayers() {
    const players = []
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      players.push({
        active: false,
        alive: false,
        x: 0,
        y: 0,
        blastRadius: BOMB_BASE_RADIUS,
        speedLevel: 1,
        bombCapacity: BOMB_BASE_CAPACITY,
        bombsActive: 0,
        invulnMs: 0,
        wins: 0,
        facing: 'down',
        isBot: false,
      })
    }
    return players
  }

  _spawnSeat(seat) {
    const [sr, sc] = SPAWN_CELLS[seat]
    const p = this.players[seat]
    const center = cellCenter(sr, sc, this.offsetX, this.offsetY)
    p.x = center.x
    p.y = center.y
    p.alive = true
    p.blastRadius = BOMB_BASE_RADIUS
    p.speedLevel = 1
    p.bombCapacity = BOMB_BASE_CAPACITY
    p.bombsActive = 0
    p.invulnMs = RESPAWN_INVULN_MS
    p.facing = 'down'
  }

  _assignSeat(peerId) {
    for (let seat = 1; seat < SEAT_COUNT; seat++) {
      if (!this.players[seat].active) {
        this.players[seat].active = true
        this.players[seat].isBot = false
        this.peerSeatMap.set(peerId, seat)
        this.inputs[seat] = { up: false, down: false, left: false, right: false }
        return seat
      }
    }
    return -1
  }

  _lobbySeats() {
    return this.players.map((p) => ({ active: p.active, isBot: !!p.isBot }))
  }

  _activateBotSeat(seat) {
    const p = this.players[seat]
    p.active = true
    p.isBot = true
    this.inputs[seat] = { up: false, down: false, left: false, right: false }
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
    if (!this.isHost) return
    // Solo vs AI and rematch both land here; always refill bots from a lobby snapshot.
    this.roundState = 'lobby'
    fillBots(this._lobbySeats(), SEAT_COUNT, (seat) => this._activateBotSeat(seat))
    this._startRound()
  }

  _onPointerDown(event) {
    if (!this.isHost || this.roundState !== 'lobby') return
    const pt = canvasPoint(this.canvas, event, this.width, this.height)
    if (this.startRect && hit(pt, this.startRect)) this._hostPressStart()
  }

  /** Soft danger map: cells that will be hit by live bomb blasts. */
  _dangerCells() {
    const danger = new Set()
    for (const bomb of this.bombs) {
      if (bomb.detonated) continue
      for (const cell of this._computeBlastCells(bomb.row, bomb.col, bomb.blastRadius)) {
        danger.add(`${cell.row},${cell.col}`)
      }
    }
    return danger
  }

  _botCanStep(row, col) {
    if (this._cellBlocking(row, col)) return false
    if (this._bombAt(row, col)) return false
    return true
  }

  /**
   * Heuristic bomber AI: flee blast radii, break adjacent crates, chase the
   * nearest rival, and only plant when an escape tile exists.
   */
  _botMoveInput(seat) {
    const p = this.players[seat]
    if (!p?.alive) return { up: false, down: false, left: false, right: false }

    const { row, col } = this._cellOf(p.x, p.y)
    const danger = this._dangerCells()
    const hereKey = `${row},${col}`
    const inDanger = danger.has(hereKey)

    const dirs = [
      { key: 'up', dr: -1, dc: 0, input: { up: true, down: false, left: false, right: false } },
      { key: 'down', dr: 1, dc: 0, input: { up: false, down: true, left: false, right: false } },
      { key: 'left', dr: 0, dc: -1, input: { up: false, down: false, left: true, right: false } },
      { key: 'right', dr: 0, dc: 1, input: { up: false, down: false, left: false, right: true } },
    ]

    // Nearest living rival (or power-up) as a soft attractor.
    let targetR = row
    let targetC = col
    let bestDist = Infinity
    for (let s = 0; s < SEAT_COUNT; s++) {
      const o = this.players[s]
      if (s === seat || !o.active || !o.alive) continue
      const oc = this._cellOf(o.x, o.y)
      const d = Math.abs(oc.row - row) + Math.abs(oc.col - col)
      if (d < bestDist) {
        bestDist = d
        targetR = oc.row
        targetC = oc.col
      }
    }
    for (const key of this.powerups.keys()) {
      const [pr, pc] = key.split(',').map(Number)
      const d = Math.abs(pr - row) + Math.abs(pc - col)
      if (d < bestDist) {
        bestDist = d
        targetR = pr
        targetC = pc
      }
    }

    let best = null
    let bestScore = -Infinity
    for (const dir of dirs) {
      const nr = row + dir.dr
      const nc = col + dir.dc
      if (!this._botCanStep(nr, nc)) continue
      const key = `${nr},${nc}`
      let score = 0
      if (inDanger) score += danger.has(key) ? -80 : 120
      else if (danger.has(key)) score -= 90
      // Prefer clear corridors toward the target.
      score -= (Math.abs(nr - targetR) + Math.abs(nc - targetC)) * 4
      // Nudge toward soft blocks we can eventually bomb.
      if (this._cellAt(nr + dir.dr, nc + dir.dc) === 'block') score += 8
      // Personality noise so bots don't lockstep.
      score += (botNoise(seat, this.simTime, dir.key.charCodeAt(0)) - 0.5) * 6
      if (score > bestScore) {
        bestScore = score
        best = dir.input
      }
    }

    // Bomb decision: plant only when not already in blast danger, an adjacent
    // soft block or rival is in blast range, and at least one escape exit exists.
    const wantBomb = this._botShouldBomb(seat, row, col, danger, inDanger)
    if (wantBomb) this.pendingBombs.add(seat)

    return best || { up: false, down: false, left: false, right: false }
  }

  _botShouldBomb(seat, row, col, danger, inDanger) {
    const p = this.players[seat]
    if (!p || inDanger) return false
    if (p.bombsActive >= p.bombCapacity) return false
    if (this._bombAt(row, col)) return false
    if (botNoise(seat, this.simTime, 17) < 0.55) return false

    const radius = p.blastRadius || BOMB_BASE_RADIUS
    const blast = this._computeBlastCells(row, col, radius)
    let useful = false
    for (const cell of blast) {
      if (cell.row === row && cell.col === col) continue
      if (this._cellAt(cell.row, cell.col) === 'block') useful = true
      for (let s = 0; s < SEAT_COUNT; s++) {
        if (s === seat) continue
        const o = this.players[s]
        if (!o.active || !o.alive) continue
        const oc = this._cellOf(o.x, o.y)
        if (oc.row === cell.row && oc.col === cell.col) useful = true
      }
    }
    if (!useful) return false

    // Require an escape tile that would sit outside this hypothetical blast.
    const blastSet = new Set(blast.map((c) => `${c.row},${c.col}`))
    const exits = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1],
    ]
    const canEscape = exits.some(([r, c]) => this._botCanStep(r, c) && !blastSet.has(`${r},${c}`) && !danger.has(`${r},${c}`))
    return canEscape
  }

  _freeSeatForPeer(peerId) {
    const seat = this.peerSeatMap.get(peerId)
    if (seat == null) return
    this.players[seat].active = false
    this.players[seat].alive = false
    this.inputs[seat] = null
    this.peerSeatMap.delete(peerId)
  }

  // --------------------------------------------------------------------
  // Input capture
  // --------------------------------------------------------------------

  _currentLocalMoveInput() {
    const k = this.keysDown
    return {
      up: k.has('ArrowUp') || k.has('w') || k.has('W'),
      down: k.has('ArrowDown') || k.has('s') || k.has('S'),
      left: k.has('ArrowLeft') || k.has('a') || k.has('A'),
      right: k.has('ArrowRight') || k.has('d') || k.has('D'),
    }
  }

  _onKeyDown(event) {
    if (MOVE_KEYS.has(event.key)) event.preventDefault()

    if (event.key === ' ') {
      if (!event.repeat) this._requestBomb()
      this.keysDown.add(event.key)
      return
    }

    this.keysDown.add(event.key)
    this._maybeSendMoveInput()
  }

  _onKeyUp(event) {
    this.keysDown.delete(event.key)
    if (event.key === ' ') return
    this._maybeSendMoveInput()
  }

  _maybeSendMoveInput() {
    if (this.isHost || !this.p2p) return
    const current = this._currentLocalMoveInput()
    const key = `${current.up}|${current.down}|${current.left}|${current.right}`
    if (key === this.lastSentInput) return
    this.lastSentInput = key
    this.p2p.broadcast({ type: 'input', ...current })
  }

  _requestBomb() {
    if (this.roundState !== 'playing') return
    if (this.isHost) {
      this.pendingBombs.add(this.mySeat ?? 0)
    } else if (this.p2p) {
      this.p2p.broadcast({ type: 'bomb' })
    }
  }

  // --------------------------------------------------------------------
  // Grid / occupancy helpers
  // --------------------------------------------------------------------

  _cellAt(row, col) {
    if (row < 0 || col < 0 || row >= GRID_ROWS || col >= GRID_COLS) return 'solid'
    return this.grid[row][col]
  }

  _cellBlocking(row, col) {
    const cell = this._cellAt(row, col)
    return cell === 'solid' || cell === 'block'
  }

  _bombAt(row, col) {
    return this.bombs.find((b) => b.row === row && b.col === col && !b.detonated)
  }

  _canPlayerOccupy(x, y, ignoreBombKey) {
    // Walls/crates use corner samples; bombs use center only so a player can
    // leave a bomb they just planted without soft-locking halfway out.
    const r = PLAYER_RADIUS - 2
    const corners = [
      [x - r, y - r],
      [x + r, y - r],
      [x - r, y + r],
      [x + r, y + r],
    ]
    for (const [px, py] of corners) {
      const col = Math.floor((px - this.offsetX) / CELL)
      const row = Math.floor((py - this.offsetY) / CELL)
      if (this._cellBlocking(row, col)) return false
    }
    const { row, col } = this._cellOf(x, y)
    const key = `${row},${col}`
    if (key !== ignoreBombKey && this._bombAt(row, col)) return false
    return true
  }

  _cellOf(x, y) {
    return {
      row: Math.floor((y - this.offsetY) / CELL),
      col: Math.floor((x - this.offsetX) / CELL),
    }
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(now - this.lastTime, 50)
    this.lastTime = now

    if (this.isHost) {
      this.tickAccumulator += dt
      while (this.tickAccumulator >= TICK_MS) {
        this._hostTick(TICK_MS)
        this.tickAccumulator -= TICK_MS
      }
    }

    this._render()
    this.rafId = requestAnimationFrame(this._loop)
  }

  _hostTick(dtMs) {
    this.simTime += dtMs

    if (this.roundState === 'lobby') {
      this.pendingBombs.clear()
      this._broadcastSync()
      return
    }

    const dt = dtMs / 1000

    if (this.roundState === 'roundover') {
      this.roundOverMs -= dtMs
      if (this.roundOverMs <= 0) this._startRound()
      this._broadcastSync()
      return
    }

    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = this.players[seat]
      if (!p.active || !p.alive) continue
      let input
      if (seat === 0 && this.isHost) input = this._currentLocalMoveInput()
      else if (p.isBot) input = this._botMoveInput(seat)
      else input = this.inputs[seat] || {}
      this._movePlayer(seat, input, dt)
      // Bomb intent is decided inside _botMoveInput (escape-aware).
    }

    for (const seat of this.pendingBombs) this._tryPlaceBomb(seat)
    this.pendingBombs.clear()

    this._collectPowerups()
    this._updateBombs(dtMs)
    this._updateExplosionVisuals(dtMs)
    this._decayInvulnerability(dtMs)
    this._checkRoundState()
    this._broadcastSync()
  }

  _movePlayer(seat, input, dt) {
    const p = this.players[seat]
    if (!p.active || !p.alive) return

    const speed = PLAYER_BASE_SPEED + (p.speedLevel - 1) * PLAYER_SPEED_STEP
    let dx = 0
    let dy = 0
    if (input.left) dx -= 1
    if (input.right) dx += 1
    if (input.up) dy -= 1
    if (input.down) dy += 1

    if (dx !== 0 && dy !== 0) {
      const inv = Math.SQRT1_2
      dx *= inv
      dy *= inv
    }

    if (dy < 0) p.facing = 'up'
    else if (dy > 0) p.facing = 'down'
    else if (dx < 0) p.facing = 'left'
    else if (dx > 0) p.facing = 'right'

    const bombKey = this._standingBombKey(p)

    // Axis-separated move + soft center snap so players don't feel "stuck"
    // on cell edges (the classic Bomberman control feel).
    if (dx !== 0) {
      const nx = p.x + dx * speed * dt
      if (this._canPlayerOccupy(nx, p.y, bombKey)) {
        p.x = nx
      } else {
        // Slide toward cell center on the free axis so a slightly off bumper still turns a corner.
        const { col } = this._cellOf(p.x, p.y)
        const idealX = this.offsetX + col * CELL + CELL / 2
        const slide = Math.sign(idealX - p.x) * Math.min(Math.abs(idealX - p.x), speed * dt)
        if (slide && this._canPlayerOccupy(p.x + slide, p.y, bombKey)) p.x += slide
      }
    }
    if (dy !== 0) {
      const ny = p.y + dy * speed * dt
      if (this._canPlayerOccupy(p.x, ny, bombKey)) {
        p.y = ny
      } else {
        const { row } = this._cellOf(p.x, p.y)
        const idealY = this.offsetY + row * CELL + CELL / 2
        const slide = Math.sign(idealY - p.y) * Math.min(Math.abs(idealY - p.y), speed * dt)
        if (slide && this._canPlayerOccupy(p.x, p.y + slide, bombKey)) p.y += slide
      }
    }
  }

  /** If the player is currently standing on a live bomb (e.g. one they just
   * placed), that bomb's cell must not block their own movement away from
   * it, but should still block everyone else / their return trip. */
  _standingBombKey(player) {
    const { row, col } = this._cellOf(player.x, player.y)
    return this._bombAt(row, col) ? `${row},${col}` : null
  }

  _tryPlaceBomb(seat) {
    const p = this.players[seat]
    if (!p.active || !p.alive) return
    if (p.bombsActive >= p.bombCapacity) return

    const { row, col } = this._cellOf(p.x, p.y)
    if (this._cellAt(row, col) !== 'empty') return
    if (this._bombAt(row, col)) return

    this.bombs.push({
      row,
      col,
      fuseMs: BOMB_FUSE_MS,
      ownerSeat: seat,
      blastRadius: p.blastRadius,
      detonated: false,
    })
    p.bombsActive++
  }

  _updateBombs(dtMs) {
    for (const bomb of this.bombs) {
      if (!bomb.detonated) bomb.fuseMs -= dtMs
    }

    let exploded = true
    while (exploded) {
      exploded = false
      for (const bomb of this.bombs) {
        if (!bomb.detonated && bomb.fuseMs <= 0) {
          this._detonateBomb(bomb)
          bomb.detonated = true
          exploded = true
        }
      }
    }

    if (this.bombs.some((b) => b.detonated)) {
      for (const bomb of this.bombs) {
        if (bomb.detonated) {
          const owner = this.players[bomb.ownerSeat]
          if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1)
        }
      }
      this.bombs = this.bombs.filter((b) => !b.detonated)
    }
  }

  _computeBlastCells(row, col, radius) {
    const cells = [{ row, col }]
    const dirs = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]
    for (const [dr, dc] of dirs) {
      for (let i = 1; i <= radius; i++) {
        const r = row + dr * i
        const c = col + dc * i
        if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) break
        const cellType = this.grid[r][c]
        if (cellType === 'solid') break
        cells.push({ row: r, col: c })
        if (cellType === 'block') break
      }
    }
    return cells
  }

  _detonateBomb(bomb) {
    const cells = this._computeBlastCells(bomb.row, bomb.col, bomb.blastRadius)

    // Burn any powerups already lying exposed in the blast before new ones
    // are created from destroyed blocks this same explosion.
    for (const { row, col } of cells) {
      this.powerups.delete(`${row},${col}`)
    }

    for (const { row, col } of cells) {
      this.explosions.push({ row, col, ttlMs: EXPLOSION_VISUAL_MS })

      if (this.grid[row][col] === 'block') {
        this.grid[row][col] = 'empty'
        if (Math.random() < POWERUP_DROP_CHANCE) {
          const kind = POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)]
          this.powerups.set(`${row},${col}`, kind)
        }
      }

      // Chain-react any other live bomb caught in the blast.
      const otherBomb = this._bombAt(row, col)
      if (otherBomb && otherBomb !== bomb) otherBomb.fuseMs = 0

      // Eliminate any player standing in the blast.
      for (const player of this.players) {
        if (!player.active || !player.alive) continue
        if (player.invulnMs > 0) continue
        const cell = this._cellOf(player.x, player.y)
        if (cell.row === row && cell.col === col) player.alive = false
      }
    }
  }

  _collectPowerups() {
    for (const player of this.players) {
      if (!player.active || !player.alive) continue
      const { row, col } = this._cellOf(player.x, player.y)
      const key = `${row},${col}`
      const kind = this.powerups.get(key)
      if (!kind) continue
      this.powerups.delete(key)
      if (kind === 'blast') player.blastRadius = Math.min(MAX_BLAST_RADIUS, player.blastRadius + 1)
      else if (kind === 'speed') player.speedLevel = Math.min(MAX_SPEED_LEVEL, player.speedLevel + 1)
      else if (kind === 'bomb') player.bombCapacity = Math.min(MAX_BOMB_CAPACITY, player.bombCapacity + 1)
    }
  }

  _updateExplosionVisuals(dtMs) {
    this.explosions = this.explosions
      .map((e) => ({ ...e, ttlMs: e.ttlMs - dtMs }))
      .filter((e) => e.ttlMs > 0)
  }

  _decayInvulnerability(dtMs) {
    for (const p of this.players) {
      if (p.invulnMs > 0) p.invulnMs = Math.max(0, p.invulnMs - dtMs)
    }
  }

  _checkRoundState() {
    const activeSeats = []
    for (let s = 0; s < SEAT_COUNT; s++) if (this.players[s].active) activeSeats.push(s)
    if (activeSeats.length < 2) return

    const aliveSeats = activeSeats.filter((s) => this.players[s].alive)
    if (aliveSeats.length <= 1) {
      this.roundState = 'roundover'
      this.roundOverMs = ROUND_OVER_DISPLAY_MS
      this.winnerSeat = aliveSeats.length === 1 ? aliveSeats[0] : null
      if (this.winnerSeat != null) this.players[this.winnerSeat].wins++
    }
  }

  _startRound() {
    this.grid = buildGrid()
    this.bombs = []
    this.explosions = []
    this.powerups = new Map()
    this.roundState = 'playing'
    this.winnerSeat = null
    this.roundOverMs = 0
    for (let s = 0; s < SEAT_COUNT; s++) {
      if (this.players[s].active) this._spawnSeat(s)
    }
  }

  _broadcastSync() {
    if (!this.p2p) return
    this.p2p.broadcast({
      type: 'sync',
      grid: this.grid,
      players: this.players.map((p) => ({
        active: p.active,
        isBot: !!p.isBot,
        alive: p.alive,
        x: p.x,
        y: p.y,
        blastRadius: p.blastRadius,
        speedLevel: p.speedLevel,
        bombCapacity: p.bombCapacity,
        invulnMs: p.invulnMs,
        wins: p.wins,
        facing: p.facing,
      })),
      bombs: this.bombs.map((b) => ({ row: b.row, col: b.col, fuseMs: b.fuseMs, ownerSeat: b.ownerSeat })),
      explosions: this.explosions.map((e) => ({ row: e.row, col: e.col, ttlMs: e.ttlMs })),
      powerups: Array.from(this.powerups.entries()).map(([key, kind]) => {
        const [row, col] = key.split(',').map(Number)
        return { row, col, kind }
      }),
      roundState: this.roundState,
      roundOverMs: this.roundOverMs,
      winnerSeat: this.winnerSeat,
    })
  }

  _localSnapshot() {
    return {
      grid: this.grid,
      players: this.players.map((p) => ({
        active: p.active,
        isBot: !!p.isBot,
        alive: p.alive,
        x: p.x,
        y: p.y,
        blastRadius: p.blastRadius,
        speedLevel: p.speedLevel,
        bombCapacity: p.bombCapacity,
        invulnMs: p.invulnMs,
        wins: p.wins,
        facing: p.facing,
      })),
      bombs: this.bombs.map((b) => ({ row: b.row, col: b.col, fuseMs: b.fuseMs, ownerSeat: b.ownerSeat })),
      explosions: this.explosions.map((e) => ({ row: e.row, col: e.col, ttlMs: e.ttlMs })),
      powerups: Array.from(this.powerups.entries()).map(([key, kind]) => {
        const [row, col] = key.split(',').map(Number)
        return { row, col, kind }
      }),
      roundState: this.roundState,
      roundOverMs: this.roundOverMs,
      winnerSeat: this.winnerSeat,
    }
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)
    drawArenaBackdrop(ctx, this.width, this.height, { step: 40 })

    const snapshot = this.isHost ? this._localSnapshot() : this.netState
    if (!snapshot) {
      this._drawWaitingOverlay(ctx)
      return
    }

    if (snapshot.roundState === 'lobby') {
      this.startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'Bomber Blitz 4',
        seats: snapshot.players.map((p) => ({ active: p.active, isBot: !!p.isBot })),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
      })
      return
    }

    if (!snapshot.grid) {
      this._drawWaitingOverlay(ctx)
      return
    }

    this._drawGrid(ctx, snapshot.grid)
    this._drawPowerups(ctx, snapshot.powerups)
    this._drawBombs(ctx, snapshot.bombs)
    this._drawExplosions(ctx, snapshot.explosions)
    this._drawPlayers(ctx, snapshot.players)
    this._drawHud(ctx, snapshot.players)

    if (snapshot.roundState === 'roundover') this._drawRoundBanner(ctx, snapshot.winnerSeat)
  }

  _drawGrid(ctx, grid) {
    // Arena plate behind the grid
    ctx.fillStyle = withAlpha(THEME.bgRaised, 0.92)
    ctx.fillRect(this.offsetX - 4, this.offsetY - 4, GRID_W + 8, GRID_H + 8)
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.35)
    ctx.lineWidth = 1.5
    ctx.strokeRect(this.offsetX - 4, this.offsetY - 4, GRID_W + 8, GRID_H + 8)

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const x = this.offsetX + c * CELL
        const y = this.offsetY + r * CELL
        const cell = grid[r][c]

        if (cell === 'solid') {
          ctx.fillStyle = '#161e32'
          ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2)
          ctx.strokeStyle = withAlpha(THEME.cyan, 0.45)
          ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3)
          // Hatch
          ctx.strokeStyle = withAlpha(THEME.cyan, 0.12)
          ctx.beginPath()
          ctx.moveTo(x + 4, y + CELL - 4)
          ctx.lineTo(x + CELL - 4, y + 4)
          ctx.stroke()
        } else if (cell === 'block') {
          ctx.fillStyle = withAlpha(THEME.magenta, 0.18)
          ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6)
          ctx.strokeStyle = THEME.magenta
          ctx.lineWidth = 1.5
          ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6)
          ctx.strokeStyle = withAlpha(THEME.lime, 0.35)
          ctx.strokeRect(x + 7, y + 7, CELL - 14, CELL - 14)
        } else {
          ctx.fillStyle = withAlpha('#0a101c', 0.85)
          ctx.fillRect(x, y, CELL, CELL)
          ctx.strokeStyle = withAlpha(THEME.cyan, 0.06)
          ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1)
        }
      }
    }
  }

  _drawPowerups(ctx, powerups) {
    for (const pu of powerups) {
      const { x, y } = cellCenter(pu.row, pu.col, this.offsetX, this.offsetY)
      ctx.save()
      ctx.translate(x, y)
      const pulse = 1 + 0.08 * Math.sin(performance.now() / 180)
      ctx.scale(pulse, pulse)

      let color = '#00e5ff'
      let glyph = '◎'
      if (pu.kind === 'speed') {
        color = '#39ff14'
        glyph = '»'
      } else if (pu.kind === 'bomb') {
        color = '#ff007f'
        glyph = '●'
      }

      ctx.shadowColor = color
      ctx.shadowBlur = 10
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(0, 0, 12, 0, Math.PI * 2)
      ctx.globalAlpha = 0.18
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.shadowBlur = 0
      ctx.font = 'bold 14px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(glyph, 0, 1)
      ctx.restore()
    }
  }

  _drawBombs(ctx, bombs) {
    for (const bomb of bombs) {
      const { x, y } = cellCenter(bomb.row, bomb.col, this.offsetX, this.offsetY)
      const fusePct = Math.max(0, bomb.fuseMs) / BOMB_FUSE_MS
      const pulseSpeed = 120 + fusePct * 260
      const pulse = 1 + 0.12 * Math.sin(performance.now() / pulseSpeed)

      ctx.save()
      ctx.translate(x, y)
      ctx.scale(pulse, pulse)
      const hot = fusePct < 0.3
      ctx.shadowColor = hot ? COLORS.bombFuseHot : COLORS.bombFuseCold
      ctx.shadowBlur = 12
      ctx.fillStyle = COLORS.bomb
      ctx.beginPath()
      ctx.arc(0, 0, 13, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = hot ? COLORS.bombFuseHot : COLORS.bombFuseCold
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.restore()
    }
  }

  _drawExplosions(ctx, explosions) {
    for (const e of explosions) {
      const { x, y } = cellCenter(e.row, e.col, this.offsetX, this.offsetY)
      const progress = 1 - e.ttlMs / EXPLOSION_VISUAL_MS
      const alpha = Math.max(0, 1 - progress)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.fillStyle = COLORS.explosion
      ctx.beginPath()
      ctx.arc(x, y, CELL * 0.42, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = COLORS.explosionCore
      ctx.beginPath()
      ctx.arc(x, y, CELL * 0.22, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  _drawPlayers(ctx, players) {
    for (let seat = 0; seat < players.length; seat++) {
      const p = players[seat]
      if (!p.active || !p.alive) continue

      const blinking = p.invulnMs > 0 && Math.floor(p.invulnMs / 110) % 2 === 0
      const color = SEAT_COLORS[seat]
      ctx.save()
      ctx.globalAlpha = blinking ? 0.35 : 1
      ctx.translate(p.x, p.y)
      const rot = { up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0 }[p.facing] || 0
      ctx.rotate(rot)

      // Neon mech body — chassis + cockpit + side thrusters (not a flat circle).
      ctx.shadowColor = SEAT_GLOW[seat]
      ctx.shadowBlur = blinking ? 6 : 14
      ctx.fillStyle = withAlpha(color, 0.22)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(14, 0)
      ctx.lineTo(6, -10)
      ctx.lineTo(-10, -9)
      ctx.lineTo(-14, -4)
      ctx.lineTo(-14, 4)
      ctx.lineTo(-10, 9)
      ctx.lineTo(6, 10)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()

      ctx.shadowBlur = 0
      ctx.fillStyle = withAlpha('#080c14', 0.85)
      ctx.beginPath()
      ctx.arc(2, 0, 4.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = color
      ctx.fillRect(-12, -7, 4, 3)
      ctx.fillRect(-12, 4, 4, 3)
      ctx.fillStyle = THEME.amber
      ctx.fillRect(8, -2, 5, 4)
      ctx.restore()

      if (seat === this.mySeat) {
        ctx.strokeStyle = withAlpha('#ffffff', 0.45)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(p.x, p.y, PLAYER_RADIUS + 8, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  _drawHud(ctx, players) {
    const activeCount = players.filter((p) => p.active).length
    drawGlassPanel(ctx, {
      x: 12,
      y: 8,
      w: 320,
      h: 42 + activeCount * 22,
      accent: THEME.cyan,
      glow: 14,
    })

    drawNeonText(ctx, 'BOMBER BLITZ', 28, 26, {
      font: `700 11px ${FONT_MONO}`,
      color: THEME.cyan,
      glow: 8,
      align: 'left',
    })

    let row = 0
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (let seat = 0; seat < players.length; seat++) {
      const p = players[seat]
      if (!p.active) continue
      const y = 48 + row * 22
      ctx.fillStyle = SEAT_COLORS[seat]
      ctx.beginPath()
      ctx.arc(28, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = `600 11px ${FONT_MONO}`
      ctx.fillStyle = p.alive ? THEME.text : THEME.textDim
      const you = seat === this.mySeat ? ' YOU' : p.isBot ? ' BOT' : ''
      ctx.fillText(
        `${SEAT_NAMES[seat]}${you}  B${p.bombCapacity} R${p.blastRadius} S${p.speedLevel}  W${p.wins}${p.alive ? '' : ' OUT'}`,
        40,
        y,
      )
      row++
    }
  }

  _drawRoundBanner(ctx, winnerSeat) {
    drawGlassPanel(ctx, {
      x: this.width / 2 - 240,
      y: this.height / 2 - 50,
      w: 480,
      h: 100,
      accent: winnerSeat == null ? THEME.amber : SEAT_COLORS[winnerSeat],
      glow: 28,
    })
    const label =
      winnerSeat == null ? 'DRAW — MUTUAL DESTRUCTION' : `${SEAT_NAMES[winnerSeat]} CLEARS THE GRID`
    drawNeonText(ctx, label, this.width / 2, this.height / 2 - 6, {
      font: `800 22px ${FONT_UI}`,
      color: winnerSeat == null ? THEME.text : SEAT_COLORS[winnerSeat],
      glow: 18,
    })
    drawNeonText(ctx, 'Re-arming next round…', this.width / 2, this.height / 2 + 28, {
      font: `500 12px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
    })
  }

  _drawWaitingOverlay(ctx) {
    drawNeonText(ctx, 'SYNCING ARENA…', this.width / 2, this.height / 2, {
      font: `700 18px ${FONT_MONO}`,
      color: THEME.cyan,
      glow: 16,
    })
  }
}
