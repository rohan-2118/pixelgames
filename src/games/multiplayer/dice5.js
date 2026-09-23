// src/games/multiplayer/dice5.js
//
// CYBER DICE TABLE — host-authoritative Liar's Dice (Perudo) for 2–5 players.
// Glassmorphic seats, vector 3D tumbling dice, Web Audio table knocks, and a
// tactical bot AI. All state is RAM-only for the life of the room.
//
// Networking
//   Host owns dice, bids, turns, losses, and round transitions.
//   Clients receive only their own dice via sendTo({ type:'privateDice' }).
//   Solo-vs-AI: p2p.soloAi === true; startSoloMatch() fills bots and begins.
//
// Implements GameEngine:
//   constructor / start / stop / onPeerAction / onPeerJoin / onPeerLeave /
//   getMatchSnapshot / applyMatchSnapshot / startSoloMatch / getHudStats

import {
  drawLobby, fillBots, canvasPoint, hit, botNoise,
  findReclaimSeat, findLobbySeat, BOT_NAMES,
} from '../shared/lobby.js'
import { cloneState, snapshotFromState, applyStateSnapshot } from '../shared/snapshot.js'
import {
  THEME, FONT_MONO, FONT_UI, PLAYER_COLORS, TAU,
  clamp, withAlpha, roundRect,
  drawArenaBackdrop, drawGlassPanel, drawNeonText, drawCanvasButton, hitRect,
} from '../../fx/theme.js'
import { ParticleField } from '../../fx/particles.js'
import { sfx } from '../../fx/audio.js'

const TICK_MS = 1000 / 30
const SEAT_COUNT = 5
const NAMES = ['P1', 'P2', 'P3', 'P4', 'P5']

const rollDie = () => 1 + Math.floor(Math.random() * 6)

/** Pip maps for die faces 1–6 (unit square 0..1). */
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.22], [0.72, 0.22], [0.28, 0.5], [0.72, 0.5], [0.28, 0.78], [0.72, 0.78]],
}

const SEAT_POS = [
  { x: 130, y: 168 },
  { x: 350, y: 138 },
  { x: 610, y: 138 },
  { x: 830, y: 168 },
  { x: 480, y: 390 },
]

export default class Dice5Game {
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2p = p2pContext
    this.isHost = !!p2pContext?.isHost
    this.width = canvas.width || 960
    this.height = canvas.height || 540
    this.running = false
    this.raf = null
    this.lastTick = 0
    this.accumulator = 0
    this.mySeat = this.isHost ? 0 : null
    this.peerSeats = new Map()
    this.privateDice = []
    this.hostDice = null
    this.draft = { quantity: 1, face: 1 }
    this.controls = []
    this.state = this._emptyState()
    this._startRect = null
    this._botTurnAt = 0
    this._botTurnSeat = null
    this.fx = new ParticleField({ max: 500 })
    this.diceAnims = [] // { x,y,face,spin,bounce,settled }
    this.rollFlash = 0
    this.time = 0

    this._onPointer = this._onPointer.bind(this)
    this._loop = this._loop.bind(this)

    if (this.isHost) {
      this.state.players[0].active = true
      this.state.players[0].isBot = false
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.canvas.addEventListener('pointerdown', this._onPointer)
    this.lastTick = performance.now()
    this.raf = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.canvas.removeEventListener('pointerdown', this._onPointer)
    this.fx.clear()
  }

  getHudStats() {
    const me = this.mySeat != null ? this.state.players[this.mySeat] : null
    const diceLeft = me?.active ? me.diceCount : 0
    let status = 'LOBBY'
    if (this.state.phase === 'bidding') status = this.state.turn === this.mySeat ? 'YOUR BID' : 'WAITING'
    else if (this.state.phase === 'reveal') status = 'REVEAL'
    else if (this.state.phase === 'rolling') status = 'ROLLING'
    else if (this.state.phase === 'gameover') status = 'MATCH OVER'
    return { label: 'DICE', score: diceLeft, status }
  }

  getMatchSnapshot() {
    return snapshotFromState(this, {
      peerSeats: Array.from(this.peerSeats.entries()),
      privateDice: cloneState(this.privateDice),
      draft: cloneState(this.draft),
      hostDice: this.hostDice ? cloneState(this.hostDice) : null,
      _botTurnAt: this._botTurnAt,
      _botTurnSeat: this._botTurnSeat,
    })
  }

  applyMatchSnapshot(snap) {
    if (!applyStateSnapshot(this, snap)) return false
    if (this.isHost) this.peerSeats = new Map()
    if (Array.isArray(snap.privateDice)) this.privateDice = cloneState(snap.privateDice)
    if (snap.draft && typeof snap.draft === 'object') this.draft = cloneState(snap.draft)
    if (Array.isArray(snap.hostDice)) this.hostDice = cloneState(snap.hostDice)
    if (typeof snap._botTurnAt === 'number') this._botTurnAt = snap._botTurnAt
    if (snap._botTurnSeat !== undefined) this._botTurnSeat = snap._botTurnSeat
    return true
  }

  onPeerJoin(peerId) {
    if (!this.isHost) return
    const inLobby = this.state.phase === 'lobby'
    const seat = inLobby
      ? findLobbySeat(this.state.players)
      : findReclaimSeat(this.state.players, this.peerSeats)
    if (seat < 0) return
    if (inLobby) this.state.players[seat] = { active: true, isBot: false, diceCount: 5 }
    this.peerSeats.set(peerId, seat)
    this.p2p?.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })
    if (!inLobby && this.hostDice?.[seat]?.length) {
      this.p2p?.sendTo(peerId, { type: 'privateDice', dice: this.hostDice[seat] })
    }
    this._broadcast()
  }

  onPeerLeave(peerId) {
    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    this.state.players[seat] = { active: false, isBot: false, diceCount: 0 }
    this.peerSeats.delete(peerId)
    if (this.state.phase === 'lobby') {
      this._broadcast()
      return
    }
    if (this._humanSeats().length < 1) {
      this._returnToLobby('Waiting for rivals…')
      return
    }
    this._beginRoll(this._nextActiveSeat(seat))
  }

  onPeerAction(data, peerId) {
    if (!data || typeof data !== 'object') return
    if (data.type === 'welcome' && !this.isHost) {
      this.mySeat = data.seat
      return
    }
    if (data.type === 'privateDice' && !this.isHost) {
      this.privateDice = Array.isArray(data.dice) ? data.dice : []
      this._spawnMyDiceAnims(this.privateDice)
      return
    }
    if (data.type === 'sync' && !this.isHost) {
      const wasReveal = this.state.phase
      this.state = data.state
      if (this.state.phase === 'reveal' && wasReveal !== 'reveal') {
        this._burstReveal()
        sfx.crunch()
      }
      if (this.state.phase === 'rolling' && wasReveal !== 'rolling') {
        sfx.diceRoll()
      }
      return
    }
    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    if (data.type === 'bid') this._tryBid(seat, data.quantity, data.face)
    if (data.type === 'liar') this._callLiar(seat)
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------

  _emptyState() {
    return {
      players: Array.from({ length: SEAT_COUNT }, () => ({
        active: false, isBot: false, diceCount: 5,
      })),
      turn: 0,
      bid: null,
      phase: 'lobby', // lobby | rolling | bidding | reveal | gameover
      reveal: null,
      message: 'Share the room link, then press START when ready.',
      nextRoundMs: 0,
      rollMs: 0,
    }
  }

  _label(seat) {
    const p = this.state.players[seat]
    if (p?.isBot) return BOT_NAMES[seat % BOT_NAMES.length]
    return NAMES[seat]
  }

  _humanSeats() {
    return this.state.players
      .map((p, seat) => (p.active && !p.isBot ? seat : -1))
      .filter((s) => s >= 0)
  }

  _lobbySeats() {
    return this.state.players.map((p) => ({ active: p.active, isBot: !!p.isBot }))
  }

  _activeSeats() {
    return this.state.players
      .map((p, seat) => (p.active && p.diceCount > 0 ? seat : -1))
      .filter((s) => s >= 0)
  }

  _nextActiveSeat(from) {
    for (let step = 1; step <= SEAT_COUNT; step++) {
      const seat = (from + step) % SEAT_COUNT
      const p = this.state.players[seat]
      if (p.active && p.diceCount > 0) return seat
    }
    return 0
  }

  _returnToLobby(message = 'Share the room link, then press START when ready.') {
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = this.state.players[seat]
      if (p.isBot) this.state.players[seat] = { active: false, isBot: false, diceCount: 5 }
      else if (p.active) p.diceCount = 5
    }
    this.state.phase = 'lobby'
    this.state.bid = null
    this.state.reveal = null
    this.state.message = message
    this.diceAnims = []
    this._broadcast()
  }

  startSoloMatch() {
    this._hostLobbyStart()
  }

  _hostLobbyStart() {
    if (!this.isHost || this.state.phase !== 'lobby') return
    fillBots(this.state.players, SEAT_COUNT, (seat) => {
      this.state.players[seat] = { active: true, isBot: true, diceCount: 5 }
    })
    sfx.matchStart()
    this._beginRoll(0)
  }

  _beginRoll(startSeat) {
    if (!this.isHost) return
    const active = this._activeSeats()
    if (active.length <= 1) {
      this.state.phase = 'gameover'
      this.state.turn = active[0] ?? 0
      this.state.message = active.length
        ? `${this._label(active[0])} wins the table!`
        : 'Table closed.'
      this.state.bid = null
      this.state.nextRoundMs = 4500
      this.fx.burst(SEAT_POS[this.state.turn].x, SEAT_POS[this.state.turn].y, {
        count: 40, color: PLAYER_COLORS[this.state.turn], speed: 0.42, secondary: THEME.cyan,
      })
      sfx.combo(4)
      this._broadcast()
      return
    }

    this.hostDice = Array.from({ length: SEAT_COUNT }, (_, seat) => {
      const count = this.state.players[seat].diceCount
      return this.state.players[seat].active && count > 0
        ? Array.from({ length: count }, rollDie)
        : []
    })
    this.state.turn = this.state.players[startSeat]?.active && this.state.players[startSeat].diceCount > 0
      ? startSeat
      : active[0]
    this.state.bid = null
    this.state.phase = 'rolling'
    this.state.reveal = null
    this.state.rollMs = 900
    this.state.message = 'Dice tumbling…'
    this.privateDice = this.hostDice[0]
    this._spawnMyDiceAnims(this.privateDice)
    sfx.diceRoll()
    for (const [peerId, seat] of this.peerSeats) {
      this.p2p?.sendTo(peerId, { type: 'privateDice', dice: this.hostDice[seat] })
    }
    this._broadcast()
  }

  _finishRoll() {
    this.state.phase = 'bidding'
    this.state.rollMs = 0
    this.state.message = `${this._label(this.state.turn)}'s turn — raise the bid.`
    this.diceAnims.forEach((d) => { d.settled = true; d.bounce = 0 })
    sfx.diceLand()
    this._broadcast()
  }

  _spawnMyDiceAnims(faces) {
    const baseX = 700
    const baseY = 300
    this.diceAnims = (faces || []).map((face, i) => ({
      x: baseX + (i % 3) * 52,
      y: baseY + Math.floor(i / 3) * 52,
      face,
      spin: Math.random() * TAU,
      bounce: 1,
      settled: false,
      seed: Math.random() * 1000,
    }))
  }

  _tryBid(seat, quantity, face) {
    if (this.state.phase !== 'bidding' || seat !== this.state.turn) return
    quantity = clamp(Math.floor(quantity), 1, 25)
    face = clamp(Math.floor(face), 1, 6)
    const old = this.state.bid
    if (old && (quantity < old.quantity || (quantity === old.quantity && face <= old.face))) return
    this.state.bid = { quantity, face, bidder: seat }
    this.state.turn = this._nextActiveSeat(seat)
    this.state.message = `${this._label(seat)} bids ${quantity} × ${face}. ${this._label(this.state.turn)}'s turn.`
    sfx.ui()
    this.fx.ring(SEAT_POS[seat].x, SEAT_POS[seat].y, { color: PLAYER_COLORS[seat], life: 400 })
    this._broadcast()
  }

  _callLiar(seat) {
    if (this.state.phase !== 'bidding' || seat !== this.state.turn || !this.state.bid) return
    const bid = this.state.bid
    const total = this.hostDice.flat().filter((die) => die === bid.face).length
    const bidTrue = total >= bid.quantity
    const loser = bidTrue ? seat : bid.bidder
    this.state.players[loser].diceCount = Math.max(0, this.state.players[loser].diceCount - 1)
    this.state.phase = 'reveal'
    this.state.reveal = {
      dice: cloneState(this.hostDice),
      total,
      loser,
      caller: seat,
      bidTrue,
      face: bid.face,
      quantity: bid.quantity,
    }
    this.state.message = bidTrue
      ? `Bid held (${total}). ${this._label(seat)} loses a die.`
      : `Bluff called (${total}). ${this._label(bid.bidder)} loses a die.`
    this.state.nextRoundMs = 3600
    this._burstReveal()
    sfx.crunch()
    this._broadcast()
  }

  _burstReveal() {
    const pos = SEAT_POS[this.state.reveal?.loser ?? 0]
    this.fx.burst(pos.x, pos.y, {
      count: 28, color: THEME.magenta, secondary: THEME.amber, speed: 0.38, shards: 4,
    })
  }

  _tickBotTurn(now) {
    if (this.state.phase !== 'bidding') {
      this._botTurnSeat = null
      return
    }
    const seat = this.state.turn
    const player = this.state.players[seat]
    if (!player?.isBot || !player.active) return
    if (this._botTurnSeat !== seat) {
      this._botTurnSeat = seat
      this._botTurnAt = now + 500 + botNoise(seat, now, 70) * 1400
    }
    if (now < this._botTurnAt) return

    // Estimate own matching dice + wildish aggression.
    const mine = this.hostDice?.[seat] || []
    const old = this.state.bid
    const myMatch = old ? mine.filter((d) => d === old.face).length : 0
    const callChance = old
      ? clamp(0.15 + (old.quantity - myMatch - 1) * 0.18, 0.08, 0.85)
      : 0
    if (old && botNoise(seat, now, 71) < callChance) {
      this._callLiar(seat)
      return
    }

    let quantity = old ? old.quantity : 1
    let face = old ? old.face : 1 + Math.floor(botNoise(seat, now, 72) * 6)
    if (old) {
      if (botNoise(seat, now, 73) > 0.45) quantity += 1
      else {
        face = clamp(face + 1, 1, 6)
        if (face <= old.face) quantity = old.quantity + 1
      }
    } else {
      quantity = Math.max(1, myMatch || 1)
    }
    this._tryBid(seat, quantity, face)
  }

  _broadcast() {
    this.p2p?.broadcast({ type: 'sync', state: this.state })
  }

  _send(data) {
    if (this.isHost) {
      if (data.type === 'bid') this._tryBid(0, data.quantity, data.face)
      if (data.type === 'liar') this._callLiar(0)
    } else this.p2p?.broadcast(data)
  }

  // ------------------------------------------------------------------
  // Loop / input
  // ------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(50, now - this.lastTick)
    this.lastTick = now
    this.time = now
    this.fx.update(dt)
    this._updateDiceAnims(dt)

    if (this.isHost) {
      this._tickBotTurn(now)
      this.accumulator += dt
      while (this.accumulator >= TICK_MS) {
        this.accumulator -= TICK_MS
        if (this.state.phase === 'rolling') {
          this.state.rollMs -= TICK_MS
          if (this.state.rollMs <= 0) this._finishRoll()
          else this._broadcast()
        } else if (this.state.phase === 'reveal') {
          this.state.nextRoundMs -= TICK_MS
          if (this.state.nextRoundMs <= 0) {
            const loser = this.state.reveal.loser
            this._beginRoll(this._nextActiveSeat(loser - 1))
          } else this._broadcast()
        } else if (this.state.phase === 'gameover') {
          this.state.nextRoundMs -= TICK_MS
          if (this.state.nextRoundMs <= 0) this._returnToLobby('Press START for a new table.')
          else this._broadcast()
        }
      }
    }

    this._render()
    this.raf = requestAnimationFrame(this._loop)
  }

  _updateDiceAnims(dt) {
    const t = dt / 1000
    for (const d of this.diceAnims) {
      if (d.settled) continue
      d.spin += t * (8 + (d.seed % 5))
      d.bounce = Math.max(0, d.bounce - t * 1.6)
      if (this.state.phase !== 'rolling' && d.bounce <= 0.05) {
        d.settled = true
        d.bounce = 0
      }
    }
  }

  _onPointer(event) {
    const point = canvasPoint(this.canvas, event, this.width, this.height)
    if (this.isHost && this.state.phase === 'lobby' && this._startRect && hit(point, this._startRect)) {
      this._hostLobbyStart()
      return
    }
    const button = this.controls.find((c) => hitRect(point, c))
    if (!button || this.mySeat == null || this.state.turn !== this.mySeat || this.state.phase !== 'bidding') return
    sfx.ui()
    if (button.action === 'quantity') this.draft.quantity = clamp(this.draft.quantity + button.delta, 1, 25)
    if (button.action === 'face') this.draft.face = clamp(this.draft.face + button.delta, 1, 6)
    if (button.action === 'bid') this._send({ type: 'bid', quantity: this.draft.quantity, face: this.draft.face })
    if (button.action === 'liar') this._send({ type: 'liar' })
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    this.controls = []

    if (this.state.phase === 'lobby') {
      this._startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'LIAR\'S DICE',
        seats: this._lobbySeats(),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
        message: this.state.message,
      })
      return
    }

    drawArenaBackdrop(ctx, this.width, this.height, { step: 40, glowAlpha: 0.04 })

    // Title strip under HUD
    drawNeonText(ctx, 'LIAR\'S DICE', this.width / 2, 68, {
      font: `800 22px ${FONT_UI}`, color: THEME.cyan, glow: 14,
    })
    drawNeonText(ctx, this.state.message, this.width / 2, 90, {
      font: `600 12px ${FONT_MONO}`, color: THEME.textDim, glow: 0,
    })

    // Seat cards
    this.state.players.forEach((player, seat) => {
      const pos = SEAT_POS[seat]
      const accent = PLAYER_COLORS[seat]
      const live = player.active && player.diceCount > 0
      drawGlassPanel(ctx, {
        x: pos.x - 86, y: pos.y - 48, w: 172, h: 96,
        radius: 12, accent: live ? accent : THEME.textFaint,
        glow: this.state.turn === seat && this.state.phase === 'bidding' ? 22 : 10,
        title: null, pad: 10,
      })
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(pos.x - 62, pos.y - 22, 6, 0, TAU)
      ctx.fill()
      ctx.font = `700 13px ${FONT_UI}`
      ctx.fillStyle = THEME.text
      ctx.textAlign = 'left'
      ctx.fillText(
        `${this._label(seat)}${seat === this.mySeat ? ' · YOU' : ''}`,
        pos.x - 50, pos.y - 18
      )
      ctx.font = `600 11px ${FONT_MONO}`
      ctx.fillStyle = live ? THEME.textDim : THEME.textFaint
      ctx.fillText(
        player.active
          ? (player.diceCount ? `${player.diceCount} DICE` : 'OUT')
          : 'EMPTY',
        pos.x - 50, pos.y + 4
      )
      // Mini face-up dice count dots
      if (live) {
        for (let i = 0; i < player.diceCount; i++) {
          ctx.fillStyle = withAlpha(accent, 0.85)
          roundRect(ctx, pos.x - 62 + i * 18, pos.y + 18, 14, 14, 3)
          ctx.fill()
        }
      }
      if (this.state.turn === seat && this.state.phase === 'bidding') {
        ctx.strokeStyle = THEME.text
        ctx.lineWidth = 2
        roundRect(ctx, pos.x - 90, pos.y - 52, 180, 104, 14)
        ctx.stroke()
        ctx.lineWidth = 1
      }
    })

    // Current bid panel
    drawGlassPanel(ctx, {
      x: 330, y: 210, w: 300, h: 108,
      radius: 14, accent: THEME.magenta, glow: 16, pad: 14,
    })
    drawNeonText(ctx, 'CURRENT BID', 480, 240, {
      font: `700 11px ${FONT_MONO}`, color: THEME.magenta, glow: 8,
    })
    if (this.state.bid) {
      this._drawDie3D(ctx, 430, 278, 36, this.state.bid.face, 0, 0, true)
      drawNeonText(ctx, `× ${this.state.bid.quantity}`, 520, 284, {
        font: `800 28px ${FONT_UI}`, color: THEME.text, glow: 10,
      })
    } else {
      drawNeonText(ctx, 'NO BID YET', 480, 282, {
        font: `700 16px ${FONT_MONO}`, color: THEME.textFaint, glow: 0,
      })
    }

    // Your private dice / reveal overlay
    if (this.state.reveal) this._drawReveal(ctx)
    else if (this.mySeat != null && this.state.players[this.mySeat]?.active) {
      drawGlassPanel(ctx, {
        x: 678, y: 230, w: 250, h: 140,
        radius: 14, accent: PLAYER_COLORS[this.mySeat], glow: 12, pad: 12,
      })
      drawNeonText(ctx, 'YOUR HIDDEN DICE', 803, 256, {
        font: `700 10px ${FONT_MONO}`, color: PLAYER_COLORS[this.mySeat], glow: 6,
      })
      this.diceAnims.forEach((d) => {
        this._drawDie3D(ctx, d.x, d.y, 38, d.face, d.spin, d.bounce, d.settled)
      })
      if (!this.diceAnims.length && this.privateDice.length) {
        this.privateDice.forEach((face, i) => {
          this._drawDie3D(ctx, 720 + (i % 3) * 52, 300 + Math.floor(i / 3) * 52, 38, face, 0, 0, true)
        })
      }
    }

    // Bid controls
    const myTurn = this.state.turn === this.mySeat && this.state.phase === 'bidding'
    if (myTurn) {
      drawGlassPanel(ctx, {
        x: 200, y: 448, w: 560, h: 78,
        radius: 12, accent: THEME.lime, glow: 14, pad: 10,
      })
      this._pushBtn(ctx, 220, 462, 40, 48, '−', 'quantity', -1)
      this._pushBtn(ctx, 266, 462, 40, 48, '+', 'quantity', 1)
      this._pushBtn(ctx, 320, 462, 40, 48, '−', 'face', -1)
      this._pushBtn(ctx, 366, 462, 40, 48, '+', 'face', 1)
      this._drawDie3D(ctx, 440, 486, 32, this.draft.face, 0, 0, true)
      drawNeonText(ctx, String(this.draft.quantity), 480, 490, {
        font: `800 20px ${FONT_MONO}`, color: THEME.text, glow: 0,
      })
      this._pushBtn(ctx, 520, 462, 110, 48, 'RAISE', 'bid', 0, THEME.lime)
      this._pushBtn(ctx, 640, 462, 100, 48, 'LIAR!', 'liar', 0, THEME.magenta)
    }

    this.fx.draw(ctx)
  }

  _pushBtn(ctx, x, y, w, h, label, action, delta = 0, accent = THEME.cyan) {
    const enabled = action !== 'liar' || !!this.state.bid
    this.controls.push({ x, y, w, h, action, delta })
    drawCanvasButton(ctx, {
      x, y, w, h, label,
      accent: enabled ? accent : THEME.textFaint,
      filled: action === 'bid' || action === 'liar',
      font: `700 13px ${FONT_MONO}`,
    })
  }

  _drawReveal(ctx) {
    const r = this.state.reveal
    ctx.fillStyle = 'rgba(5,7,13,.88)'
    ctx.fillRect(160, 110, 640, 320)
    drawGlassPanel(ctx, {
      x: 170, y: 118, w: 620, h: 304,
      radius: 16, accent: THEME.amber, glow: 20, pad: 16,
    })
    drawNeonText(ctx, 'TABLE REVEAL', 480, 150, {
      font: `800 20px ${FONT_UI}`, color: THEME.amber, glow: 16,
    })
    r.dice.forEach((dice, seat) => {
      if (!dice.length && !this.state.players[seat].active) return
      const y = 178 + seat * 42
      ctx.fillStyle = PLAYER_COLORS[seat]
      ctx.font = `700 12px ${FONT_MONO}`
      ctx.textAlign = 'left'
      ctx.fillText(this._label(seat), 200, y)
      dice.forEach((face, i) => {
        this._drawDie3D(ctx, 310 + i * 36, y - 4, 26, face, 0, 0, true)
      })
    })
    drawNeonText(ctx, `MATCHING ${r.face}s: ${r.total}  ·  Bid was ${r.quantity}`, 480, 400, {
      font: `700 13px ${FONT_MONO}`, color: THEME.text, glow: 0,
    })
  }

  /**
   * Perspective cube die with soft contact shadow and pip face.
   * bounce 0..1 lifts the die; spin rotates the face while tumbling.
   */
  _drawDie3D(ctx, cx, cy, size, face, spin, bounce, settled) {
    const s = size
    const lift = bounce * 14
    const y = cy - lift
    const depth = s * 0.22
    const skew = settled ? 0.18 : 0.18 + Math.sin(spin) * 0.08

    // Soft contact shadow
    ctx.save()
    ctx.fillStyle = withAlpha('#000', 0.35 * (1 - bounce * 0.6))
    ctx.beginPath()
    ctx.ellipse(cx, cy + s * 0.42, s * 0.42, s * 0.14, 0, 0, TAU)
    ctx.fill()

    // Top face (lighter)
    const top = [
      [cx - s * 0.42, y - s * 0.22],
      [cx + s * 0.1, y - s * 0.42],
      [cx + s * 0.48, y - s * 0.18],
      [cx - s * 0.04, y + 0.02],
    ]
    ctx.beginPath()
    top.forEach(([x, yy], i) => (i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy)))
    ctx.closePath()
    ctx.fillStyle = '#d8e6f8'
    ctx.fill()

    // Side face
    ctx.beginPath()
    ctx.moveTo(cx + s * 0.1, y - s * 0.42)
    ctx.lineTo(cx + s * 0.48, y - s * 0.18)
    ctx.lineTo(cx + s * 0.48, y + s * 0.28)
    ctx.lineTo(cx + s * 0.1, y + s * 0.08)
    ctx.closePath()
    ctx.fillStyle = '#7a8aa8'
    ctx.fill()

    // Front face (pip face)
    const fx = cx - s * 0.42
    const fy = y - s * 0.22
    const fw = s * 0.76
    const fh = s * 0.76
    roundRect(ctx, fx, fy + depth * 0.3, fw, fh, 4)
    const grad = ctx.createLinearGradient(fx, fy, fx, fy + fh)
    grad.addColorStop(0, '#f4f7ff')
    grad.addColorStop(1, '#c8d4ea')
    ctx.fillStyle = grad
    ctx.fill()
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.35)
    ctx.lineWidth = 1
    ctx.stroke()

    // Pips — if tumbling hard, scramble face until settled
    const show = settled || bounce < 0.35
      ? face
      : 1 + Math.floor((Math.abs(Math.sin(spin * 3 + face)) * 6)) % 6 + 0
    const pipFace = clamp(show, 1, 6)
    const pips = PIPS[pipFace] || PIPS[1]
    ctx.fillStyle = '#1a2236'
    for (const [px, py] of pips) {
      ctx.beginPath()
      ctx.arc(fx + px * fw, fy + depth * 0.3 + py * fh, s * 0.07, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }
}
