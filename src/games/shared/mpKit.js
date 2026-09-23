// src/games/shared/mpKit.js
//
// Shared scaffolding for host-authoritative multiplayer GameEngines.
// Cuts lobby / peer / tick / broadcast boilerplate so each title can focus
// on rules and rendering.

import {
  drawLobby,
  fillBots,
  canvasPoint,
  hit,
  botNoise,
  findReclaimSeat,
  findLobbySeat,
  BOT_NAMES,
} from './lobby.js'
import { cloneState } from './snapshot.js'
import {
  THEME,
  FONT_MONO,
  FONT_UI,
  PLAYER_COLORS,
  drawArenaBackdrop,
  drawGlassPanel,
  drawNeonText,
  withAlpha,
  clamp,
  rand,
  pick,
} from '../../fx/theme.js'

export {
  drawLobby,
  fillBots,
  canvasPoint,
  hit,
  botNoise,
  findReclaimSeat,
  findLobbySeat,
  BOT_NAMES,
  cloneState,
  THEME,
  FONT_MONO,
  FONT_UI,
  PLAYER_COLORS,
  drawArenaBackdrop,
  drawGlassPanel,
  drawNeonText,
  withAlpha,
  clamp,
  rand,
  pick,
}

/**
 * Wire the common GameEngine lifecycle for a realtime host-authoritative title.
 * Caller supplies hooks for sim + render.
 */
export function bindRealtimeEngine(game, {
  tickHz = 30,
  seatCount,
  title,
  createPlayer,
  onStartRound,
  onHostTick,
  onRenderPlay,
  botInput = null,
  keyFilter = null,
}) {
  const TICK_MS = 1000 / tickHz

  game.width = game.canvas.width || 960
  game.height = game.canvas.height || 540
  game.running = false
  game.raf = null
  game.lastTime = 0
  game.acc = 0
  game.simTime = 0
  game.isHost = !!(game.p2p && game.p2p.isHost)
  game.mySeat = game.isHost ? 0 : null
  game.peerSeats = new Map()
  game.phase = 'lobby'
  game.message = 'Share the room link, then press START when ready.'
  game.startRect = null
  game.roundOverMs = 0
  game.winnerSeat = null
  game.keys = new Set()
  game.inputs = Array.from({ length: seatCount }, () => null)
  game.players = Array.from({ length: seatCount }, (_, seat) => createPlayer(seat))
  if (game.isHost) {
    game.players[0].active = true
    game.players[0].isBot = false
  }

  game._onKeyDown = (e) => {
    if (keyFilter && keyFilter(e)) e.preventDefault()
    game.keys.add(e.key)
    if (!game.isHost && game.p2p) {
      const input = game._localInput?.()
      if (input) game.p2p.broadcast({ type: 'input', ...input })
    }
  }
  game._onKeyUp = (e) => {
    game.keys.delete(e.key)
    if (!game.isHost && game.p2p) {
      const input = game._localInput?.()
      if (input) game.p2p.broadcast({ type: 'input', ...input })
    }
  }
  game._onPointerDown = (e) => {
    if (!game.isHost || game.phase !== 'lobby') return
    const pt = canvasPoint(game.canvas, e, game.width, game.height)
    if (game.startRect && hit(pt, game.startRect)) game._hostStart()
  }
  game._loop = (now) => {
    if (!game.running) return
    const dt = Math.min(50, now - game.lastTime)
    game.lastTime = now
    if (game.isHost) {
      game.acc += dt
      while (game.acc >= TICK_MS) {
        game.acc -= TICK_MS
        game.simTime += TICK_MS
        game._hostTick(TICK_MS)
      }
    }
    game._render()
    game.raf = requestAnimationFrame(game._loop)
  }

  game.start = function start() {
    if (game.running) return
    game.running = true
    window.addEventListener('keydown', game._onKeyDown)
    window.addEventListener('keyup', game._onKeyUp)
    game.canvas.addEventListener('pointerdown', game._onPointerDown)
    game.lastTime = performance.now()
    game.raf = requestAnimationFrame(game._loop)
  }

  game.stop = function stop() {
    game.running = false
    if (game.raf) cancelAnimationFrame(game.raf)
    game.raf = null
    window.removeEventListener('keydown', game._onKeyDown)
    window.removeEventListener('keyup', game._onKeyUp)
    game.canvas.removeEventListener('pointerdown', game._onPointerDown)
  }

  game.startSoloMatch = function startSoloMatch() {
    game._hostStart()
  }

  game._hostStart = function _hostStart() {
    if (!game.isHost || game.phase !== 'lobby') return
    fillBots(
      game.players.map((p) => ({ active: p.active, isBot: !!p.isBot })),
      seatCount,
      (seat) => {
        const p = createPlayer(seat)
        p.active = true
        p.isBot = true
        game.players[seat] = p
      },
    )
    onStartRound(game)
    game.phase = 'playing'
    game.message = ''
    game._broadcast()
  }

  game._hostTick = function _hostTick(dtMs) {
    if (game.phase === 'lobby') {
      game._broadcast()
      return
    }
    if (game.phase === 'roundover') {
      game.roundOverMs -= dtMs
      if (game.roundOverMs <= 0) {
        onStartRound(game)
        game.phase = 'playing'
        game.winnerSeat = null
      }
      game._broadcast()
      return
    }

    for (let seat = 0; seat < seatCount; seat++) {
      const p = game.players[seat]
      if (!p.active) continue
      let input = null
      if (seat === 0 && game.isHost) input = game._localInput?.() || {}
      else if (p.isBot && botInput) input = botInput(game, seat) || {}
      else input = game.inputs[seat] || {}
      game.inputs[seat] = input
    }
    onHostTick(game, dtMs)
    game._broadcast()
  }

  game._broadcast = function _broadcast() {
    game.p2p?.broadcast({ type: 'sync', state: game._publicState() })
  }

  game._publicState = function _publicState() {
    return {
      phase: game.phase,
      message: game.message,
      players: cloneState(game.players),
      winnerSeat: game.winnerSeat,
      roundOverMs: game.roundOverMs,
      simTime: game.simTime,
      ...(game._extraState?.() || {}),
    }
  }

  game._applySync = function _applySync(state) {
    if (!state) return
    game.phase = state.phase
    game.message = state.message || ''
    game.players = state.players
    game.winnerSeat = state.winnerSeat
    game.roundOverMs = state.roundOverMs
    game.simTime = state.simTime || 0
    game._applyExtra?.(state)
  }

  game.onPeerAction = function onPeerAction(data, peerId) {
    if (!data) return
    if (data.type === 'welcome' && !game.isHost) {
      game.mySeat = data.seat
      return
    }
    if (data.type === 'sync' && !game.isHost) {
      game._applySync(data.state)
      return
    }
    if (!game.isHost) return
    if (data.type === 'input') {
      const seat = game.peerSeats.get(peerId)
      if (seat == null) return
      game.inputs[seat] = data
    }
  }

  game.onPeerJoin = function onPeerJoin(peerId) {
    if (!game.isHost) return
    const inLobby = game.phase === 'lobby'
    let seat = inLobby
      ? findLobbySeat(game.players)
      : findReclaimSeat(game.players, game.peerSeats)
    if (seat < 0) return
    if (inLobby) {
      const p = createPlayer(seat)
      p.active = true
      p.isBot = false
      game.players[seat] = p
    }
    game.peerSeats.set(peerId, seat)
    game.p2p?.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })
    game._broadcast()
  }

  game.onPeerLeave = function onPeerLeave(peerId) {
    if (!game.isHost) return
    const seat = game.peerSeats.get(peerId)
    if (seat == null) return
    game.players[seat].active = false
    game.peerSeats.delete(peerId)
    game._broadcast()
  }

  game.getMatchSnapshot = function getMatchSnapshot() {
    return {
      kind: 'realtime',
      mySeat: game.mySeat,
      phase: game.phase,
      players: cloneState(game.players),
      winnerSeat: game.winnerSeat,
      roundOverMs: game.roundOverMs,
      simTime: game.simTime,
      peerSeats: Array.from(game.peerSeats.entries()),
      ...(game._extraState?.() || {}),
    }
  }

  game.applyMatchSnapshot = function applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'realtime') return false
    if (snap.mySeat !== undefined) game.mySeat = snap.mySeat
    if (typeof snap.phase === 'string') game.phase = snap.phase
    if (Array.isArray(snap.players)) game.players = cloneState(snap.players)
    if (snap.winnerSeat !== undefined) game.winnerSeat = snap.winnerSeat
    if (typeof snap.roundOverMs === 'number') game.roundOverMs = snap.roundOverMs
    if (typeof snap.simTime === 'number') game.simTime = snap.simTime
    if (game.isHost) game.peerSeats = new Map()
    game._applyExtra?.(snap)
    return true
  }

  game._render = function _render() {
    const ctx = game.ctx
    if (game.phase === 'lobby') {
      game.startRect = drawLobby(ctx, {
        width: game.width,
        height: game.height,
        title,
        seats: game.players.map((p) => ({ active: p.active, isBot: !!p.isBot })),
        capacity: seatCount,
        isHost: game.isHost,
        mySeat: game.mySeat,
        message: game.message,
      })
      return
    }
    onRenderPlay(game, ctx)
  }

  game._endRound = function _endRound(winnerSeat, message, pauseMs = 3200) {
    game.phase = 'roundover'
    game.winnerSeat = winnerSeat
    game.message = message
    game.roundOverMs = pauseMs
    if (winnerSeat != null && game.players[winnerSeat]) {
      game.players[winnerSeat].wins = (game.players[winnerSeat].wins || 0) + 1
    }
  }

  game.getHudStats = function getHudStats() {
    const me = game.mySeat != null ? game.players[game.mySeat] : null
    return {
      score: me?.score ?? me?.wins ?? 0,
      label: me?.wins != null ? 'WINS' : 'SCORE',
    }
  }
}

export function drawRoundBanner(ctx, game, label) {
  drawGlassPanel(ctx, {
    x: game.width / 2 - 240,
    y: game.height / 2 - 48,
    w: 480,
    h: 96,
    accent: game.winnerSeat == null ? THEME.amber : PLAYER_COLORS[game.winnerSeat % PLAYER_COLORS.length],
    glow: 24,
  })
  drawNeonText(ctx, label || game.message || 'ROUND OVER', game.width / 2, game.height / 2 + 2, {
    font: `800 22px ${FONT_UI}`,
    color: game.winnerSeat == null ? THEME.text : PLAYER_COLORS[game.winnerSeat % PLAYER_COLORS.length],
    glow: 16,
  })
}

export function drawScoreStrip(ctx, game, { y = 18 } = {}) {
  const active = game.players
    .map((p, seat) => ({ ...p, seat }))
    .filter((p) => p.active)
  drawGlassPanel(ctx, {
    x: 10,
    y: 8,
    w: Math.min(920, 40 + active.length * 150),
    h: 36,
    accent: THEME.cyan,
    glow: 10,
  })
  ctx.font = `600 11px ${FONT_MONO}`
  ctx.textBaseline = 'middle'
  active.forEach((p, i) => {
    const x = 24 + i * 150
    ctx.fillStyle = PLAYER_COLORS[p.seat % PLAYER_COLORS.length]
    ctx.beginPath()
    ctx.arc(x, y + 8, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = THEME.text
    const tag = p.seat === game.mySeat ? 'YOU' : p.isBot ? 'BOT' : `P${p.seat + 1}`
    const val = p.score != null ? p.score : p.wins || 0
    ctx.fillText(`${tag}  ${val}`, x + 12, y + 8)
  })
}
