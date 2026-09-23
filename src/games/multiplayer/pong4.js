// src/games/multiplayer/pong4.js
//
// Quad Pong — host-authoritative, serverless 4-player Pong on a square
// perimeter arena. All state lives strictly in RAM; nothing is persisted
// across a refresh.
//
// Networking model:
//   - Host (p2p.isHost === true) simulates the ball, all four paddles, and
//     lives/elimination at a fixed 30Hz tick, broadcasting a full snapshot
//     every tick via `p2p.broadcast({ type: 'sync', ... })`.
//   - Clients (p2p.isHost === false) only capture their local paddle input
//     and forward it via `p2p.broadcast({ type: 'input', ... })`, then
//     render whatever the latest `sync` snapshot contains.
//   - Since Trystero rooms are a full mesh, a client never automatically
//     learns its own peer id. The host sends a one-off, individually
//     targeted `{ type: 'welcome' }` via `p2p.sendTo(peerId, ...)` the
//     moment a peer connects, echoing back their own peer id (`yourPeerId`)
//     alongside their assigned seat (which also determines which of the
//     four edges — N/E/S/W — they defend).
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)

import { drawLobby, fillBots, canvasPoint, hit, findReclaimSeat } from '../shared/lobby.js'
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
const STARTING_LIVES = 3

// seat index -> edge it defends (clockwise, host is always North)
const EDGE_OF_SEAT = ['N', 'E', 'S', 'W']
const SEAT_COLORS = ['#00e5ff', '#ff007f', '#39ff14', '#ffd23f']
const SEAT_GLOW = ['rgba(0,229,255,0.6)', 'rgba(255,0,127,0.6)', 'rgba(57,255,20,0.6)', 'rgba(255,210,63,0.6)']
const SEAT_NAMES = ['North', 'East', 'South', 'West']

const ARENA_SIZE = 420
const PADDLE_LEN = 92
const PADDLE_HALF = PADDLE_LEN / 2
const PADDLE_THICKNESS = 12
const PADDLE_SPEED = 300 // px / second along the edge

const BALL_RADIUS = 8
const BALL_BASE_SPEED = 260
const BALL_MAX_SPEED = 560
const BALL_SPEED_GAIN = 14 // added to speed on every paddle hit
const PADDLE_SPIN = 220 // extra tangential velocity added based on hit offset

const ROUND_OVER_DISPLAY_MS = 4200
const RESET_PAUSE_MS = 900 // brief pause before ball launches after a life is lost

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'A', 'd', 'D', 'w', 'W', 's', 'S'])

const COLORS = {
  background: '#080c14',
  grid: 'rgba(0, 229, 255, 0.06)',
  arena: 'rgba(0, 229, 255, 0.18)',
  wallDead: 'rgba(147, 162, 194, 0.35)',
  ball: '#eaf2ff',
  ballGlow: 'rgba(234, 242, 255, 0.8)',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  panel: 'rgba(11, 15, 25, 0.72)',
}

export default class Pong4Game {
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
    this.arenaX = (this.width - ARENA_SIZE) / 2
    this.arenaY = (this.height - ARENA_SIZE) / 2
    this.arenaSize = ARENA_SIZE

    this.running = false
    this.rafId = null
    this.lastTime = 0
    this.tickAccumulator = 0

    this.mySeat = this.isHost ? 0 : null
    this.myPeerId = null
    this.hostPeerId = null

    this.keysDown = new Set()
    this.lastSentInput = null

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._loop = this._loop.bind(this)
    this.startRect = null

    // ---- Host-authoritative state ----
    this.peerSeatMap = new Map()
    this.inputs = [null, null, null, null] // { neg, pos } per remote seat
    this.players = this._createPlayers()
    this.ball = this._createBall()
    this.ballLaunchMs = 0 // countdown before ball starts moving after (re)spawn
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
      ballLaunchMs: this.ballLaunchMs,
      peerSeatMap: Array.from(this.peerSeatMap.entries()),
      inputs: cloneState(this.inputs),
      players: cloneState(this.players),
      ball: cloneState(this.ball),
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
    if (typeof snap.ballLaunchMs === 'number') this.ballLaunchMs = snap.ballLaunchMs
    if (this.isHost) this.peerSeatMap = new Map()
    if (Array.isArray(snap.inputs)) this.inputs = cloneState(snap.inputs)
    if (Array.isArray(snap.players)) this.players = cloneState(snap.players)
    if (snap.ball && typeof snap.ball === 'object') this.ball = cloneState(snap.ball)
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
        if (!this.inputs[seat]) this.inputs[seat] = { neg: false, pos: false }
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
          this.inputs[seat] = { neg: !!data.neg, pos: !!data.pos }
        }
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
        lives: STARTING_LIVES,
        eliminated: false,
        paddlePos: this.arenaX + this.arenaSize / 2, // will be re-centered per edge in _resetPlayerPaddle
        isBot: false,
      })
    }
    return players
  }

  _resetPlayerPaddle(seat) {
    const edge = EDGE_OF_SEAT[seat]
    const center =
      edge === 'N' || edge === 'S'
        ? this.arenaX + this.arenaSize / 2
        : this.arenaY + this.arenaSize / 2
    this.players[seat].paddlePos = center
  }

  _assignSeat(peerId) {
    for (let seat = 1; seat < SEAT_COUNT; seat++) {
      if (!this.players[seat].active) {
        const p = this.players[seat]
        p.active = true
        p.isBot = false
        this.peerSeatMap.set(peerId, seat)
        this.inputs[seat] = { neg: false, pos: false }
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
    this.inputs[seat] = { neg: false, pos: false }
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
    this._startRound()
  }

  _onPointerDown(event) {
    if (!this.isHost || this.roundState !== 'lobby') return
    const pt = canvasPoint(this.canvas, event, this.width, this.height)
    if (this.startRect && hit(pt, this.startRect)) this._hostPressStart()
  }

  _botPaddleInput(seat) {
    const edge = EDGE_OF_SEAT[seat]
    const ball = this.ball
    const isHorizontal = edge === 'N' || edge === 'S'
    const target = isHorizontal ? ball.x : ball.y
    const delta = target - this.players[seat].paddlePos
    const dead = 16
    return { neg: delta < -dead, pos: delta > dead }
  }

  _freeSeatForPeer(peerId) {
    const seat = this.peerSeatMap.get(peerId)
    if (seat == null) return
    this.players[seat].active = false
    this.players[seat].eliminated = false
    this.inputs[seat] = null
    this.peerSeatMap.delete(peerId)
  }

  // --------------------------------------------------------------------
  // Input capture
  // --------------------------------------------------------------------

  _currentLocalInput() {
    const k = this.keysDown
    return {
      neg: k.has('ArrowLeft') || k.has('ArrowUp') || k.has('a') || k.has('A') || k.has('w') || k.has('W'),
      pos: k.has('ArrowRight') || k.has('ArrowDown') || k.has('d') || k.has('D') || k.has('s') || k.has('S'),
    }
  }

  _onKeyDown(event) {
    if (MOVE_KEYS.has(event.key)) event.preventDefault()
    this.keysDown.add(event.key)
    this._maybeSendInput()
  }

  _onKeyUp(event) {
    this.keysDown.delete(event.key)
    this._maybeSendInput()
  }

  _maybeSendInput() {
    if (this.isHost || !this.p2p) return
    const current = this._currentLocalInput()
    const key = `${current.neg}|${current.pos}`
    if (key === this.lastSentInput) return
    this.lastSentInput = key
    this.p2p.broadcast({ type: 'input', ...current })
  }

  // --------------------------------------------------------------------
  // Ball helpers
  // --------------------------------------------------------------------

  _createBall() {
    return { x: this.width / 2, y: this.height / 2, vx: 0, vy: 0 }
  }

  _resetBall(immediate = false) {
    const cx = this.arenaX + this.arenaSize / 2
    const cy = this.arenaY + this.arenaSize / 2
    const angle = Math.random() * Math.PI * 2
    this.ball.x = cx
    this.ball.y = cy
    this.ball.vx = Math.cos(angle) * BALL_BASE_SPEED
    this.ball.vy = Math.sin(angle) * BALL_BASE_SPEED
    this.ballLaunchMs = immediate ? 0 : RESET_PAUSE_MS
  }

  _clampBallSpeed() {
    const speed = Math.hypot(this.ball.vx, this.ball.vy)
    if (speed < 1) return
    const clamped = Math.max(BALL_BASE_SPEED, Math.min(BALL_MAX_SPEED, speed + BALL_SPEED_GAIN))
    const scale = clamped / speed
    this.ball.vx *= scale
    this.ball.vy *= scale
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
    if (this.roundState === 'lobby') {
      this._broadcastSync()
      return
    }

    const dt = dtMs / 1000

    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = this.players[seat]
      if (!p.active || p.eliminated) continue
      let input
      if (seat === 0 && this.isHost) input = this._currentLocalInput()
      else if (p.isBot) input = this._botPaddleInput(seat)
      else input = this.inputs[seat] || {}
      this._movePaddle(seat, input, dt)
    }

    if (this.roundState === 'roundover') {
      this.roundOverMs -= dtMs
      if (this.roundOverMs <= 0) this._startRound()
      this._broadcastSync()
      return
    }

    if (this.ballLaunchMs > 0) {
      this.ballLaunchMs -= dtMs
      this._broadcastSync()
      return
    }

    this._updateBall(dt)
    this._checkRoundState()
    this._broadcastSync()
  }

  _movePaddle(seat, input, dt) {
    const player = this.players[seat]
    if (!player.active || player.eliminated) return
    const edge = EDGE_OF_SEAT[seat]
    const isHorizontal = edge === 'N' || edge === 'S'
    const min = (isHorizontal ? this.arenaX : this.arenaY) + PADDLE_HALF
    const max = (isHorizontal ? this.arenaX : this.arenaY) + this.arenaSize - PADDLE_HALF

    let delta = 0
    if (input.neg) delta -= PADDLE_SPEED * dt
    if (input.pos) delta += PADDLE_SPEED * dt
    player.paddlePos = Math.max(min, Math.min(max, player.paddlePos + delta))
  }

  _updateBall(dt) {
    const ball = this.ball
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt

    if (ball.y - BALL_RADIUS <= this.arenaY) this._resolveEdgeHit('N')
    else if (ball.y + BALL_RADIUS >= this.arenaY + this.arenaSize) this._resolveEdgeHit('S')

    if (ball.x - BALL_RADIUS <= this.arenaX) this._resolveEdgeHit('W')
    else if (ball.x + BALL_RADIUS >= this.arenaX + this.arenaSize) this._resolveEdgeHit('E')
  }

  _resolveEdgeHit(edge) {
    const seat = EDGE_OF_SEAT.indexOf(edge)
    const player = this.players[seat]
    const ball = this.ball
    const r = BALL_RADIUS
    const isWall = !player.active || player.eliminated

    if (edge === 'N' || edge === 'S') {
      const wallY = edge === 'N' ? this.arenaY : this.arenaY + this.arenaSize
      const withinPaddle = !isWall && Math.abs(ball.x - player.paddlePos) <= PADDLE_HALF
      if (isWall || withinPaddle) {
        ball.y = edge === 'N' ? wallY + r : wallY - r
        ball.vy = -ball.vy
        if (withinPaddle) {
          const offset = (ball.x - player.paddlePos) / PADDLE_HALF
          ball.vx += offset * PADDLE_SPIN
          this._clampBallSpeed()
        }
      } else {
        this._loseLife(seat)
      }
    } else {
      const wallX = edge === 'W' ? this.arenaX : this.arenaX + this.arenaSize
      const withinPaddle = !isWall && Math.abs(ball.y - player.paddlePos) <= PADDLE_HALF
      if (isWall || withinPaddle) {
        ball.x = edge === 'W' ? wallX + r : wallX - r
        ball.vx = -ball.vx
        if (withinPaddle) {
          const offset = (ball.y - player.paddlePos) / PADDLE_HALF
          ball.vy += offset * PADDLE_SPIN
          this._clampBallSpeed()
        }
      } else {
        this._loseLife(seat)
      }
    }
  }

  _loseLife(seat) {
    const player = this.players[seat]
    player.lives = Math.max(0, player.lives - 1)
    if (player.lives <= 0) player.eliminated = true
    this._resetBall(false)
  }

  _checkRoundState() {
    const activeSeats = []
    for (let s = 0; s < SEAT_COUNT; s++) if (this.players[s].active) activeSeats.push(s)
    if (activeSeats.length < 2) return

    const survivors = activeSeats.filter((s) => !this.players[s].eliminated)
    if (survivors.length <= 1) {
      this.roundState = 'roundover'
      this.roundOverMs = ROUND_OVER_DISPLAY_MS
      this.winnerSeat = survivors.length === 1 ? survivors[0] : null
    }
  }

  _startRound() {
    this.roundState = 'playing'
    this.winnerSeat = null
    this.roundOverMs = 0
    for (let s = 0; s < SEAT_COUNT; s++) {
      if (this.players[s].active) {
        this.players[s].lives = STARTING_LIVES
        this.players[s].eliminated = false
        this._resetPlayerPaddle(s)
      }
    }
    this._resetBall(false)
  }

  _broadcastSync() {
    if (!this.p2p) return
    this.p2p.broadcast({
      type: 'sync',
      players: this.players.map((p) => ({
        active: p.active,
        isBot: !!p.isBot,
        lives: p.lives,
        eliminated: p.eliminated,
        paddlePos: p.paddlePos,
      })),
      ball: { x: this.ball.x, y: this.ball.y },
      ballLaunchMs: this.ballLaunchMs,
      roundState: this.roundState,
      roundOverMs: this.roundOverMs,
      winnerSeat: this.winnerSeat,
    })
  }

  _localSnapshot() {
    return {
      players: this.players.map((p) => ({
        active: p.active,
        isBot: !!p.isBot,
        lives: p.lives,
        eliminated: p.eliminated,
        paddlePos: p.paddlePos,
      })),
      ball: { x: this.ball.x, y: this.ball.y },
      ballLaunchMs: this.ballLaunchMs,
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
    this._drawGrid(ctx)

    const snapshot = this.isHost ? this._localSnapshot() : this.netState
    if (!snapshot) {
      this._drawArenaOutline(ctx)
      this._drawWaitingOverlay(ctx)
      return
    }

    if (snapshot.roundState === 'lobby') {
      this.startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'Quad Pong',
        seats: snapshot.players.map((p) => ({ active: p.active, isBot: !!p.isBot })),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
      })
      return
    }

    this._drawArenaOutline(ctx)
    this._drawEdges(ctx, snapshot.players)
    if (snapshot.roundState !== 'roundover') this._drawBall(ctx, snapshot.ball)
    this._drawHud(ctx, snapshot.players)

    if (snapshot.roundState === 'roundover') this._drawRoundBanner(ctx, snapshot.winnerSeat)
  }

  _drawGrid(ctx) {
    ctx.strokeStyle = COLORS.grid
    ctx.lineWidth = 1
    for (let x = 0; x <= this.width; x += 40) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, this.height)
      ctx.stroke()
    }
    for (let y = 0; y <= this.height; y += 40) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(this.width, y)
      ctx.stroke()
    }
  }

  _drawArenaOutline(ctx) {
    ctx.strokeStyle = COLORS.arena
    ctx.lineWidth = 2
    ctx.strokeRect(this.arenaX, this.arenaY, this.arenaSize, this.arenaSize)
  }

  _drawEdges(ctx, players) {
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = players[seat]
      const edge = EDGE_OF_SEAT[seat]
      const isWall = !p.active || p.eliminated

      ctx.save()
      if (isWall) {
        ctx.fillStyle = COLORS.wallDead
        this._drawEdgeBar(ctx, edge, this.arenaX + this.arenaSize / 2, this.arenaSize)
      } else {
        ctx.shadowColor = SEAT_GLOW[seat]
        ctx.shadowBlur = 14
        ctx.fillStyle = SEAT_COLORS[seat]
        this._drawEdgeBar(ctx, edge, p.paddlePos, PADDLE_LEN)
      }
      ctx.restore()
    }
  }

  _drawEdgeBar(ctx, edge, center, length) {
    const t = PADDLE_THICKNESS
    if (edge === 'N') {
      ctx.fillRect(center - length / 2, this.arenaY - (length === this.arenaSize ? t : 0), length, t)
    } else if (edge === 'S') {
      const y = this.arenaY + this.arenaSize - (length === this.arenaSize ? 0 : t)
      ctx.fillRect(center - length / 2, y, length, t)
    } else if (edge === 'W') {
      ctx.fillRect(this.arenaX - (length === this.arenaSize ? t : 0), center - length / 2, t, length)
    } else if (edge === 'E') {
      const x = this.arenaX + this.arenaSize - (length === this.arenaSize ? 0 : t)
      ctx.fillRect(x, center - length / 2, t, length)
    }
  }

  _drawBall(ctx, ball) {
    ctx.save()
    ctx.shadowColor = COLORS.ballGlow
    ctx.shadowBlur = 16
    ctx.fillStyle = COLORS.ball
    ctx.beginPath()
    ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  _drawHud(ctx, players) {
    const panelW = 210
    const activeCount = players.filter((p) => p.active).length
    const panelH = 24 + activeCount * 22
    ctx.save()
    ctx.fillStyle = COLORS.panel
    ctx.fillRect(14, 14, panelW, panelH)
    ctx.strokeStyle = 'rgba(0,229,255,0.25)'
    ctx.strokeRect(14, 14, panelW, panelH)

    ctx.font = '13px "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    let row = 0
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = players[seat]
      if (!p.active) continue
      const y = 30 + row * 22
      ctx.fillStyle = SEAT_COLORS[seat]
      ctx.beginPath()
      ctx.arc(30, y, 5, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = p.eliminated ? COLORS.textDim : COLORS.text
      const you = seat === this.mySeat ? ' (You)' : ''
      const hearts = '♥'.repeat(p.lives) + '·'.repeat(STARTING_LIVES - p.lives)
      const status = p.eliminated ? '  OUT' : ''
      ctx.fillText(`${SEAT_NAMES[seat]}${you}  ${hearts}${status}`, 44, y)
      row++
    }
    ctx.restore()
  }

  _drawRoundBanner(ctx, winnerSeat) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.72)'
    ctx.fillRect(0, this.height / 2 - 55, this.width, 110)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (winnerSeat != null) {
      ctx.fillStyle = SEAT_COLORS[winnerSeat]
      ctx.font = 'bold 32px "Segoe UI", sans-serif'
      ctx.shadowColor = SEAT_GLOW[winnerSeat]
      ctx.shadowBlur = 18
      ctx.fillText(`${SEAT_NAMES[winnerSeat]} WINS THE ROUND!`, this.width / 2, this.height / 2 - 10)
    } else {
      ctx.fillStyle = COLORS.text
      ctx.font = 'bold 28px "Segoe UI", sans-serif'
      ctx.fillText('ALL PLAYERS ELIMINATED', this.width / 2, this.height / 2 - 10)
    }

    ctx.shadowBlur = 0
    ctx.fillStyle = COLORS.textDim
    ctx.font = '15px "Segoe UI", sans-serif'
    ctx.fillText('Next round starting…', this.width / 2, this.height / 2 + 26)
    ctx.restore()
  }

  _drawWaitingOverlay(ctx) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.6)'
    ctx.fillRect(0, 0, this.width, this.height)
    ctx.fillStyle = COLORS.text
    ctx.font = '20px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Connecting to host…', this.width / 2, this.height / 2)
    ctx.restore()
  }
}
