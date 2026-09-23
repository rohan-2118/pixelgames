// src/games/multiplayer/skribbl.js
//
// Draw & Guess — host-authoritative Skribbl-style party game for 2–12
// players over WebRTC data channels.
//
// Ephemeral by design: every byte of match state lives in client RAM (plus
// the shell's short-lived sessionStorage resume snapshot). No database, no
// accounts, no cookies, no IndexedDB.
//
// Networking model
//   - Host (p2p.isHost === true) owns the turn queue, the 60s round clock,
//     word selection, hint reveals, guess validation, and scoring. It
//     broadcasts a full snapshot via `p2p.broadcast({ type:'sync', state })`
//     at ~10Hz, with immediate pushes whenever something changes.
//   - Clients send stroke segments, tool settings, board clears, word picks
//     and chat guesses to the host; they never score anything locally.
//   - The secret word NEVER appears in the public sync. It is delivered only
//     to the active drawer via `p2p.sendTo(peerId, { type:'secretWord' })`,
//     the same private-channel pattern used by Liar's Dice and Codenames.
//
// DOM overlay
//   start() wraps the shared 960x540 canvas in a flex stage, injecting a
//   drawing toolbar (drawer only) and a right-hand chat/guess panel.
//   stop() restores the original DOM exactly and removes every listener,
//   timer and injected node.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//   plus optional getMatchSnapshot() / applyMatchSnapshot(data)

import {
  drawLobby,
  fillBots,
  canvasPoint,
  hit,
  botNoise,
  findLobbySeat,
  findReclaimSeat,
  LOBBY_COLORS,
  BOT_NAMES,
} from '../shared/lobby.js'
import { snapshotFromState, applyStateSnapshot, cloneState } from '../shared/snapshot.js'
import { THEME, FONT_MONO, FONT_UI, drawArenaBackdrop, drawGlassPanel, drawNeonText, withAlpha } from '../../fx/theme.js'
import { createSketchPen, tickSketchPen } from '../shared/botSketch.js'
import { sfx } from '../../fx/audio.js'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TICK_MS = 1000 / 30
const SYNC_EVERY_TICKS = 3 // ~10Hz full snapshots
const SEAT_COUNT = 12

const ROUND_MS = 60000
const WORD_SELECT_MS = 15000
const SUMMARY_MS = 4000
const WORD_CHOICES = 3

const HINT_1_AT = 0.4 // 40% elapsed
const HINT_2_AT = 0.7 // 70% elapsed

const MAX_STROKES = 4000
const MAX_CHAT = 60

const MIN_POINTS = 50
const POINTS_PER_SECOND = 10
const WRONG_GUESS_PENALTY = 25
const DRAWER_BONUS = 50

// Visual theme — neo-arcade digital studio
const C_BG = THEME.bgDeep
const C_CYAN = THEME.cyan
const C_GREEN = THEME.lime
const C_PANEL = THEME.surface
const C_PINK = THEME.magenta
const C_GOLD = THEME.amber
const C_TEXT = THEME.text
const C_DIM = THEME.textDim
const C_FAINT = THEME.textFaint

/** Drawable region: the HUD strip owns the top 64px of the canvas. */
const BOARD = { x: 0, y: 64, w: 960, h: 476 }

const SEAT_NAMES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12']

const BRUSH_SIZES = [
  { id: 'fine', label: 'Fine', size: 3 },
  { id: 'medium', label: 'Medium', size: 8 },
  { id: 'heavy', label: 'Heavy', size: 18 },
]

const PALETTE = [
  THEME.text, THEME.cyan, THEME.lime, THEME.amber, '#ff9f43',
  THEME.magenta, THEME.violet, THEME.ice, '#ff5e5e', '#7d8aa8',
]

/** 70 recognizable, drawable items — single and multi-word. */
const WORD_BANK = [
  'TREE', 'GLUE STICK', 'AIRPLANE', 'GUITAR', 'CASTLE', 'VOLCANO', 'SUNFLOWER',
  'LIGHTHOUSE', 'OCTOPUS', 'RAINBOW', 'SANDWICH', 'TELESCOPE', 'WATERFALL',
  'ASTRONAUT', 'BUTTERFLY', 'PENGUIN', 'PIRATE SHIP', 'WIZARD HAT', 'MERMAID',
  'CAMPFIRE', 'SKATEBOARD', 'BALLOON', 'CACTUS', 'JELLYFISH', 'IGLOO',
  'TORNADO', 'UNICORN', 'TRUMPET', 'ANCHOR', 'COMPASS', 'LANTERN', 'WINDMILL',
  'HAMMOCK', 'SPIDER WEB', 'KANGAROO', 'SUBMARINE', 'MOUNTAIN', 'TREASURE MAP',
  'SCARECROW', 'FIREWORKS', 'HELICOPTER', 'MUSHROOM', 'PYRAMID', 'SHARK',
  'TOASTER', 'ROBOT', 'DRAGON', 'ROCKET', 'BICYCLE', 'UMBRELLA', 'PIZZA',
  'SNOWMAN', 'DINOSAUR', 'CUPCAKE', 'TRAFFIC LIGHT', 'HEADPHONES', 'BACKPACK',
  'LADDER', 'SUNGLASSES', 'WATERMELON', 'PAINT BRUSH', 'ICE CREAM',
  'SOCCER BALL', 'LIGHT BULB', 'LAPTOP', 'CAMERA', 'LOLLIPOP', 'LADYBUG',
  'FLASHLIGHT', 'DOUGHNUT', 'POPCORN', 'ELEPHANT', 'GIRAFFE', 'TURTLE',
  'HOT AIR BALLOON', 'FERRIS WHEEL', 'PARACHUTE', 'CROWN', 'KEYBOARD', 'WHALE',
]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function shuffled(list) {
  const copy = list.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function normalizeGuess(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Indices of guessable (non-space) characters in a word. */
function letterIndices(word) {
  const out = []
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ' ') out.push(i)
  }
  return out
}

/**
 * Public hint string: spaces always shown, revealed letters shown, everything
 * else masked as underscores. e.g. "GLUE STICK" -> "_ _ _ _     _ _ _ _ _"
 */
function buildMasked(word, revealedSet) {
  const tokens = []
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (ch === ' ') tokens.push('  ')
    else tokens.push(revealedSet.has(i) ? ch : '_')
  }
  return tokens.join(' ')
}

function wordShape(word) {
  const words = word.split(' ').filter(Boolean)
  const letters = letterIndices(word).length
  return words.length > 1
    ? `${words.length} words · ${letters} letters`
    : `${letters} letters`
}

// ---------------------------------------------------------------------------
// Injected stylesheet for the DOM overlay
// ---------------------------------------------------------------------------

const STYLE_ID = 'skribbl-overlay-style'
const STYLE_TEXT = `
.skribbl-stage{display:flex;gap:12px;align-items:stretch;flex-wrap:wrap;width:100%}
.skribbl-main{flex:1 1 600px;min-width:0;display:flex;flex-direction:column;gap:10px}
.skribbl-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;
  background:${C_PANEL};border:1px solid rgba(0,229,255,.28);border-radius:12px}
.skribbl-bar__status{display:flex;flex-direction:column;gap:2px;min-width:150px}
.skribbl-bar__hint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;
  letter-spacing:1px;color:${C_CYAN};font-weight:700}
.skribbl-bar__meta{font-size:11px;color:${C_DIM}}
.skribbl-bar__group{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.skribbl-bar__label{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:${C_FAINT}}
.skribbl-swatch{width:24px;height:24px;border-radius:6px;border:2px solid transparent;cursor:pointer;padding:0}
.skribbl-swatch[aria-pressed="true"]{border-color:${C_TEXT};box-shadow:0 0 8px rgba(255,255,255,.45)}
.skribbl-btn{font:inherit;font-size:12px;font-weight:600;color:${C_TEXT};background:rgba(0,229,255,.1);
  border:1px solid rgba(0,229,255,.4);border-radius:8px;padding:6px 10px;cursor:pointer}
.skribbl-btn:hover{background:rgba(0,229,255,.2)}
.skribbl-btn[aria-pressed="true"]{background:rgba(57,255,20,.2);border-color:${C_GREEN}}
.skribbl-btn--danger{background:rgba(255,0,127,.14);border-color:rgba(255,0,127,.5)}
.skribbl-btn--danger:hover{background:rgba(255,0,127,.26)}
.skribbl-bar.is-locked .skribbl-tool{opacity:.35;pointer-events:none}
.skribbl-chat{flex:0 0 272px;max-width:100%;display:flex;flex-direction:column;
  background:${C_PANEL};border:1px solid rgba(0,229,255,.28);border-radius:12px;overflow:hidden;
  min-height:340px;max-height:620px}
.skribbl-chat__head{padding:10px 12px;border-bottom:1px solid rgba(0,229,255,.2);
  font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${C_CYAN};font-weight:700}
.skribbl-chat__scores{padding:8px 12px;border-bottom:1px solid rgba(0,229,255,.14);
  display:flex;flex-direction:column;gap:4px;max-height:168px;overflow-y:auto}
.skribbl-score{display:flex;align-items:center;gap:7px;font-size:12px;color:${C_TEXT}}
.skribbl-score__dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.skribbl-score__name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skribbl-score__pts{color:${C_DIM};font-variant-numeric:tabular-nums}
.skribbl-score.is-drawer .skribbl-score__name{color:${C_GOLD};font-weight:700}
.skribbl-score.is-guessed .skribbl-score__pts{color:${C_GREEN};font-weight:700}
.skribbl-feed{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;
  flex-direction:column;gap:6px;font-size:12px;line-height:1.4}
.skribbl-msg{color:#c6d3ea;word-break:break-word}
.skribbl-msg b{color:${C_TEXT}}
.skribbl-msg--system{color:${C_CYAN}}
.skribbl-msg--correct{color:${C_GREEN};font-weight:700}
.skribbl-msg--hint{color:${C_GOLD};font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.skribbl-form{display:flex;gap:6px;padding:10px;border-top:1px solid rgba(0,229,255,.2)}
.skribbl-input{flex:1;min-width:0;font:inherit;font-size:13px;color:${C_TEXT};
  background:#0b1120;border:1px solid rgba(0,229,255,.32);border-radius:8px;padding:8px 10px}
.skribbl-input:disabled{opacity:.5}
.skribbl-input:focus{outline:none;border-color:${C_CYAN};box-shadow:0 0 0 2px rgba(0,229,255,.18)}
.skribbl-pick{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:14px;background:rgba(5,7,13,.93);z-index:6;padding:20px;text-align:center}
.skribbl-pick__title{margin:0;font-size:18px;color:${C_TEXT}}
.skribbl-pick__sub{margin:0;font-size:12px;color:${C_DIM}}
.skribbl-pick__row{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
.skribbl-pick__btn{font:inherit;font-size:16px;font-weight:700;letter-spacing:.04em;color:${C_TEXT};
  background:rgba(0,229,255,.12);border:2px solid ${C_CYAN};border-radius:12px;padding:14px 20px;cursor:pointer}
.skribbl-pick__btn:hover{background:rgba(0,229,255,.26);transform:translateY(-1px)}
@media (max-width:900px){.skribbl-chat{flex:1 1 100%;max-height:none}}
`

export default class SkribblGame {
  /**
   * @param {HTMLCanvasElement} canvas - Shared 960x540 arcade canvas.
   * @param {object|null} p2pContext - Host-authoritative networking context.
   */
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2p = p2pContext || null
    // A missing p2p context (solo route) degrades to a local host + bots game.
    this.isHost = !p2pContext || !!p2pContext.isHost
    this.width = canvas.width || 960
    this.height = canvas.height || 540

    this.running = false
    this.raf = null
    this.lastTime = 0
    this.accumulator = 0
    this.tickCount = 0

    this.mySeat = this.isHost ? 0 : null
    this.myPeerId = null
    this.peerSeats = new Map() // peerId -> seat

    // Local-only view data
    this.myWord = null // real word, drawer only
    this.myChoices = null // 3 offered words, drawer only
    this.tool = { color: PALETTE[0], size: BRUSH_SIZES[1].size, sizeId: 'medium', eraser: false, fill: false }
    this.drawing = false
    this.lastPoint = null
    this.strokePts = [] // quadratic Bézier control points for the active stroke
    this.startRect = null
    this.againRect = null

    // Host-only authoritative extras (never synced wholesale)
    this.currentWord = null
    this.revealed = new Set()
    this.hostChoices = []
    this.usedWords = []
    this.chatSeq = 1
    this.botPlan = new Map() // seat -> { guessAt, wrongAt, wrongWord }
    this.botPen = null

    this.state = this._emptyState()

    // DOM references
    this.dom = null
    this.domAnchor = null
    this.domListeners = null
    this.ownsStyle = false
    this.chatRenderedId = 0
    this._scoreSig = ''
    this._statusSig = ''
    this._inputSig = ''
    this._pickSig = ''

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._loop = this._loop.bind(this)

    if (this.isHost) {
      this.state.players[0].active = true
      this.state.players[0].isBot = false
    }
  }

  // ------------------------------------------------------------------
  // GameEngine interface
  // ------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    this._buildDom()
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup', this._onPointerUp)
    window.addEventListener('pointercancel', this._onPointerUp)
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
    window.removeEventListener('pointermove', this._onPointerMove)
    window.removeEventListener('pointerup', this._onPointerUp)
    window.removeEventListener('pointercancel', this._onPointerUp)
    this.drawing = false
    this.lastPoint = null
    this._destroyDom()
  }

  // ------------------------------------------------------------------
  // Match resume
  // ------------------------------------------------------------------

  getMatchSnapshot() {
    return snapshotFromState(this, {
      peerSeats: Array.from(this.peerSeats.entries()),
      myPeerId: this.myPeerId,
      myWord: this.myWord,
      myChoices: this.myChoices ? this.myChoices.slice() : null,
      tool: cloneState(this.tool),
      currentWord: this.currentWord,
      revealed: Array.from(this.revealed),
      hostChoices: this.hostChoices.slice(),
      usedWords: this.usedWords.slice(),
      chatSeq: this.chatSeq,
      botPlan: Array.from(this.botPlan.entries()),
    })
  }

  applyMatchSnapshot(snap) {
    if (!applyStateSnapshot(this, snap)) return false
    // Peer ids are regenerated after a refresh, so old mappings are useless —
    // onPeerJoin() re-seats everyone as they reconnect.
    this.peerSeats = new Map()
    if (snap.myPeerId !== undefined) this.myPeerId = snap.myPeerId
    if (snap.myWord !== undefined) this.myWord = snap.myWord
    if (Array.isArray(snap.myChoices) || snap.myChoices === null) this.myChoices = snap.myChoices
    if (snap.tool && typeof snap.tool === 'object') this.tool = cloneState(snap.tool)
    if (snap.currentWord !== undefined) this.currentWord = snap.currentWord
    if (Array.isArray(snap.revealed)) this.revealed = new Set(snap.revealed)
    if (Array.isArray(snap.hostChoices)) this.hostChoices = snap.hostChoices.slice()
    if (Array.isArray(snap.usedWords)) this.usedWords = snap.usedWords.slice()
    if (Number.isFinite(snap.chatSeq)) this.chatSeq = snap.chatSeq
    if (Array.isArray(snap.botPlan)) this.botPlan = new Map(snap.botPlan)
    this.chatRenderedId = 0
    return true
  }

  // ------------------------------------------------------------------
  // Peer lifecycle
  // ------------------------------------------------------------------

  onPeerJoin(peerId) {
    if (!this.isHost) return
    const inLobby = this.state.phase === 'LOBBY'
    const seat = inLobby
      ? findLobbySeat(this.state.players)
      : findReclaimSeat(this.state.players, this.peerSeats)
    if (seat < 0) return

    if (inLobby) {
      this.state.players[seat] = this._freshPlayer({ active: true, isBot: false })
    }
    this.peerSeats.set(peerId, seat)
    this.p2p?.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })

    // A reconnecting drawer needs their private word/choices back.
    if (!inLobby && seat === this.state.drawerSeat) {
      if (this.state.phase === 'WORD_SELECT' && this.hostChoices.length) {
        this.p2p?.sendTo(peerId, { type: 'wordChoices', words: this.hostChoices.slice() })
      } else if (this.currentWord) {
        this.p2p?.sendTo(peerId, { type: 'secretWord', word: this.currentWord })
      }
    }
    this._pushSystem(`${this._label(seat)} joined the room.`)
    this._broadcast()
  }

  onPeerLeave(peerId) {
    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    this.peerSeats.delete(peerId)

    const wasDrawer = seat === this.state.drawerSeat
    this.state.players[seat] = this._freshPlayer({ active: false, isBot: false })
    this.state.queue = this.state.queue.filter((s) => s !== seat)
    this._pushSystem(`${this._label(seat)} left the room.`)

    if (this.state.phase === 'LOBBY') {
      this._broadcast()
      return
    }
    if (this._activeSeats().length < 2) {
      this._returnToLobby('Not enough players — back to the lobby.')
      return
    }
    if (wasDrawer) {
      this._endRound(`${this._label(seat)} disconnected.`, false)
      return
    }
    this._checkEveryoneGuessed()
    this._broadcast()
  }

  onPeerAction(data, peerId) {
    if (!data || typeof data !== 'object') return

    // ---- client-side inbound ----
    if (!this.isHost) {
      if (data.type === 'welcome') {
        this.mySeat = data.seat
        this.myPeerId = data.yourPeerId
        return
      }
      if (data.type === 'wordChoices') {
        this.myChoices = Array.isArray(data.words) ? data.words.slice() : null
        this.myWord = null
        return
      }
      if (data.type === 'secretWord') {
        this.myWord = typeof data.word === 'string' ? data.word : null
        this.myChoices = null
        return
      }
      if (data.type === 'strokeAdd') {
        if (data.seg) this.state.strokes.push(data.seg)
        return
      }
      if (data.type === 'boardClear') {
        this.state.strokes = []
        return
      }
      if (data.type === 'sync') {
        const incoming = data.state
        if (!incoming) return
        if (incoming.strokes == null) {
          // Light snapshot: keep the ink we already relayed.
          incoming.strokes = this.state.strokes
        } else if (
          incoming.round === this.state.round &&
          this.state.strokes.length > incoming.strokes.length
        ) {
          // strokeAdd relays and periodic snapshots can race; within a round the
          // longer stroke log is always the more complete one.
          incoming.strokes = this.state.strokes
        }
        this.state = incoming
        if (this.mySeat !== this.state.drawerSeat) {
          this.myWord = null
          this.myChoices = null
        }
        return
      }
      return
    }

    // ---- host-side inbound ----
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    if (data.type === 'stroke') this._hostStroke(seat, data.seg)
    else if (data.type === 'clearBoard') this._hostClearBoard(seat)
    else if (data.type === 'pickWord') this._hostPickWord(seat, data.word)
    else if (data.type === 'guess') this._hostGuess(seat, data.text)
    else if (data.type === 'startMatch') this._hostStartMatch()
    else if (data.type === 'playAgain') this._returnToLobby('Ready for another round?')
  }

  // ------------------------------------------------------------------
  // State helpers
  // ------------------------------------------------------------------

  _emptyState() {
    return {
      players: Array.from({ length: SEAT_COUNT }, () => this._freshPlayer()),
      phase: 'LOBBY', // LOBBY | WORD_SELECT | DRAWING | ROUND_SUMMARY | GAME_OVER
      drawerSeat: -1,
      queue: [],
      turn: 0,
      totalTurns: 0,
      round: 0,
      timeLeftMs: 0,
      selectMs: 0,
      summaryMs: 0,
      maskedWord: '',
      wordShape: '',
      wordLength: 0,
      hintsShown: 0,
      revealWord: '',
      strokes: [],
      chat: [],
      rankings: [],
      message: 'Share the room link, then press START when ready.',
    }
  }

  _freshPlayer(overrides = {}) {
    return {
      active: false,
      isBot: false,
      score: 0,
      wrongGuesses: 0,
      hasGuessed: false,
      lastPoints: 0,
      ...overrides,
    }
  }

  _label(seat) {
    const player = this.state.players[seat]
    if (player?.isBot) return BOT_NAMES[seat % BOT_NAMES.length]
    return SEAT_NAMES[seat] || `P${seat + 1}`
  }

  _activeSeats() {
    const out = []
    this.state.players.forEach((player, seat) => {
      if (player.active) out.push(seat)
    })
    return out
  }

  _humanSeats() {
    const out = []
    this.state.players.forEach((player, seat) => {
      if (player.active && !player.isBot) out.push(seat)
    })
    return out
  }

  _guesserSeats() {
    return this._activeSeats().filter((seat) => seat !== this.state.drawerSeat)
  }

  _seatPeerId(seat) {
    for (const [peerId, mapped] of this.peerSeats.entries()) {
      if (mapped === seat) return peerId
    }
    return null
  }

  _pushChat(kind, text, seat = -1, points = 0) {
    this.state.chat.push({ id: this.chatSeq++, kind, text, seat, points })
    if (this.state.chat.length > MAX_CHAT) {
      this.state.chat.splice(0, this.state.chat.length - MAX_CHAT)
    }
  }

  _pushSystem(text) {
    this._pushChat('system', text)
  }

  /**
   * Host -> everyone. `light` snapshots omit the stroke log (the expensive
   * part) because ink is already relayed segment-by-segment; full snapshots
   * go out on every phase/board change and once a second as a repair pass.
   */
  _broadcast(light = false) {
    if (!this.isHost) return
    if (!light) {
      this.p2p?.broadcast({ type: 'sync', state: this.state })
      return
    }
    this.p2p?.broadcast({ type: 'sync', state: { ...this.state, strokes: null } })
  }

  /** Client -> host, or direct local handling when we *are* the host. */
  _sendToHost(message) {
    if (this.isHost) return
    this.p2p?.broadcast(message)
  }

  // ------------------------------------------------------------------
  // Host-authoritative state machine
  // ------------------------------------------------------------------

  /**
   * Solo-vs-AI entry point called by the arcade shell right after start().
   * Skips the lobby wait entirely: every empty seat becomes a local bot and
   * the match begins immediately with zero network involvement.
   */
  startSoloMatch() {
    this._hostStartMatch()
  }

  getHudStats() {
    const me = this.mySeat != null ? this.state.players[this.mySeat] : null
    let status = 'LOBBY'
    if (this.state.phase === 'WORD_SELECT') status = this._amDrawer() ? 'PICK WORD' : 'STANDBY'
    else if (this.state.phase === 'DRAWING') status = this._amDrawer() ? 'DRAWING' : (me?.hasGuessed ? 'SOLVED' : 'GUESS')
    else if (this.state.phase === 'ROUND_SUMMARY') status = 'REVEAL'
    else if (this.state.phase === 'GAME_OVER') status = 'PODIUM'
    return {
      label: 'SCORE',
      score: me?.score ?? 0,
      status,
    }
  }

  _hostStartMatch() {
    if (!this.isHost || this.state.phase !== 'LOBBY') return
    const capacity = this.p2p?.maxPlayers ? clamp(this.p2p.maxPlayers, 2, SEAT_COUNT) : SEAT_COUNT
    fillBots(this.state.players, capacity, (seat) => {
      this.state.players[seat] = this._freshPlayer({ active: true, isBot: true })
    })

    const seats = this._activeSeats()
    seats.forEach((seat) => {
      this.state.players[seat].score = 0
      this.state.players[seat].wrongGuesses = 0
      this.state.players[seat].hasGuessed = false
      this.state.players[seat].lastPoints = 0
    })

    this.usedWords = []
    this.state.chat = []
    this.state.rankings = []
    this.state.queue = seats.slice()
    this.state.totalTurns = seats.length
    this.state.turn = 0
    this.state.round = 0
    this._pushSystem(`Match started — ${seats.length} artists, one turn each.`)
    this._beginTurn()
  }

  _beginTurn() {
    if (!this.isHost) return
    const next = this.state.queue.shift()
    if (next == null || !this.state.players[next]?.active) {
      if (this.state.queue.length > 0) {
        this._beginTurn()
        return
      }
      this._gameOver()
      return
    }

    this.state.turn += 1
    this.state.drawerSeat = next
    this.state.phase = 'WORD_SELECT'
    this.state.round += 1
    this.state.strokes = []
    this.state.timeLeftMs = ROUND_MS
    this.state.selectMs = WORD_SELECT_MS
    this.state.summaryMs = 0
    this.state.revealWord = ''
    this.state.maskedWord = ''
    this.state.wordShape = ''
    this.state.wordLength = 0
    this.state.hintsShown = 0
    this.currentWord = null
    this.revealed = new Set()
    this.botPlan.clear()
    this.botPen = null

    this._activeSeats().forEach((seat) => {
      this.state.players[seat].hasGuessed = false
      this.state.players[seat].wrongGuesses = 0
      this.state.players[seat].lastPoints = 0
    })

    this.hostChoices = this._drawWordChoices()
    this.state.message = `${this._label(next)} is picking a word…`
    this._pushSystem(`Turn ${this.state.turn}/${this.state.totalTurns} — ${this._label(next)} draws next.`)

    if (next === this.mySeat) {
      this.myChoices = this.hostChoices.slice()
      this.myWord = null
    } else {
      const peerId = this._seatPeerId(next)
      if (peerId) this.p2p?.sendTo(peerId, { type: 'wordChoices', words: this.hostChoices.slice() })
    }
    this._broadcast()
  }

  _drawWordChoices() {
    let pool = WORD_BANK.filter((word) => !this.usedWords.includes(word))
    if (pool.length < WORD_CHOICES) {
      this.usedWords = []
      pool = WORD_BANK.slice()
    }
    return shuffled(pool).slice(0, WORD_CHOICES)
  }

  _hostPickWord(seat, word) {
    if (!this.isHost) return
    if (this.state.phase !== 'WORD_SELECT' || seat !== this.state.drawerSeat) return
    const picked = this.hostChoices.includes(word) ? word : this.hostChoices[0]
    if (!picked) return
    this._startDrawing(picked)
  }

  _startDrawing(word) {
    this.currentWord = word
    this.usedWords.push(word)
    this.revealed = new Set()
    this.hostChoices = []
    this.state.phase = 'DRAWING'
    this.state.timeLeftMs = ROUND_MS
    this.state.selectMs = 0
    this.state.strokes = []
    this.state.wordLength = letterIndices(word).length
    this.state.wordShape = wordShape(word)
    this.state.maskedWord = buildMasked(word, this.revealed)
    this.state.hintsShown = 0
    this.state.message = `${this._label(this.state.drawerSeat)} is drawing!`
    this._pushSystem(`${this._label(this.state.drawerSeat)} is drawing — ${this.state.wordShape}.`)

    const drawer = this.state.drawerSeat
    if (drawer === this.mySeat) {
      this.myWord = word
      this.myChoices = null
    } else {
      const peerId = this._seatPeerId(drawer)
      if (peerId) this.p2p?.sendTo(peerId, { type: 'secretWord', word })
    }

    this._planBots()
    this._broadcast()
  }

  /** Pre-roll each bot guesser's wrong / correct moments with realistic pacing. */
  _planBots() {
    this.botPlan.clear()
    const now = performance.now()
    const word = this.currentWord || ''
    this._guesserSeats().forEach((seat) => {
      if (!this.state.players[seat].isBot) return
      const skill = 0.35 + botNoise(seat, now, 3) * 0.55
      const r1 = botNoise(seat, now, 1)
      const r2 = botNoise(seat, now, 2)
      const solves = skill > 0.28
      // Typo draft of the real word for near-miss guesses.
      const typo = this._typoWord(word, seat, now)
      this.botPlan.set(seat, {
        wrongAt: 3500 + r1 * 16000,
        wrongDone: false,
        wrongText: typo || WORD_BANK[Math.floor(botNoise(seat, now, 9) * WORD_BANK.length)],
        // Better bots solve earlier after hints; weaker bots wait longer.
        guessAt: solves ? 10000 + (1 - skill) * 38000 + r2 * 8000 : Infinity,
        guessDone: false,
        typingMs: 0,
        typingBuf: '',
        targetGuess: word.toLowerCase(),
      })
    })

    if (this.state.players[this.state.drawerSeat]?.isBot) {
      this.botPen = createSketchPen(word, BOARD, {
        color: PALETTE[1 + Math.floor(Math.random() * (PALETTE.length - 2))],
        size: BRUSH_SIZES[1].size,
      })
    }
  }

  /** Introduce 0–2 character typos so solo AI feels human. */
  _typoWord(word, seat, t) {
    if (!word) return ''
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    let out = word.toLowerCase().replace(/[^a-z ]/g, '')
    const n = 1 + Math.floor(botNoise(seat, t, 20) * 2)
    for (let i = 0; i < n && out.length > 2; i++) {
      const idx = 1 + Math.floor(botNoise(seat, t, 21 + i) * (out.length - 2))
      if (out[idx] === ' ') continue
      const ch = letters[Math.floor(botNoise(seat, t, 30 + i) * letters.length)]
      out = out.slice(0, idx) + ch + out.slice(idx + 1)
    }
    return out
  }

  _hostStroke(seat, seg) {
    if (!this.isHost) return
    if (this.state.phase !== 'DRAWING' || seat !== this.state.drawerSeat) return
    const clean = this._sanitizeSeg(seg)
    if (!clean) return
    this.state.strokes.push(clean)
    if (this.state.strokes.length > MAX_STROKES) this.state.strokes.shift()
    this.p2p?.broadcast({ type: 'strokeAdd', seg: clean })
  }

  _sanitizeSeg(seg) {
    if (!seg || typeof seg !== 'object') return null
    if (seg.op === 'fill') {
      const x = Number(seg.x)
      const y = Number(seg.y)
      if (![x, y].every(Number.isFinite)) return null
      const color = typeof seg.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(seg.color)
        ? seg.color
        : PALETTE[0]
      return {
        op: 'fill',
        x: clamp(x, BOARD.x, BOARD.x + BOARD.w),
        y: clamp(y, BOARD.y, BOARD.y + BOARD.h),
        color,
      }
    }
    const x0 = Number(seg.x0)
    const y0 = Number(seg.y0)
    const x1 = Number(seg.x1)
    const y1 = Number(seg.y1)
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null
    const size = clamp(Number(seg.size) || BRUSH_SIZES[1].size, 1, 64)
    const color = typeof seg.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(seg.color)
      ? seg.color
      : PALETTE[0]
    const cx = Number.isFinite(Number(seg.cx)) ? clamp(Number(seg.cx), 0, this.width) : null
    const cy = Number.isFinite(Number(seg.cy)) ? clamp(Number(seg.cy), 0, this.height) : null
    return {
      x0: clamp(x0, 0, this.width),
      y0: clamp(y0, 0, this.height),
      x1: clamp(x1, 0, this.width),
      y1: clamp(y1, 0, this.height),
      cx, cy,
      size,
      color,
      erase: !!seg.erase,
    }
  }

  _hostClearBoard(seat) {
    if (!this.isHost) return
    if (this.state.phase !== 'DRAWING' || seat !== this.state.drawerSeat) return
    this.state.strokes = []
    this.p2p?.broadcast({ type: 'boardClear' })
    this._broadcast()
  }

  _hostGuess(seat, rawText) {
    if (!this.isHost) return
    const player = this.state.players[seat]
    if (!player?.active) return
    const text = String(rawText || '').slice(0, 64).trim()
    if (!text) return

    if (this.state.phase !== 'DRAWING') {
      this._pushChat('guess', text, seat)
      this._broadcast(true)
      return
    }
    if (seat === this.state.drawerSeat) {
      // The artist may chat but must not spell anything out.
      if (normalizeGuess(text) === normalizeGuess(this.currentWord || '')) {
        this._pushSystem(`${this._label(seat)}, no spoilers!`)
      } else {
        this._pushChat('guess', text, seat)
      }
      this._broadcast(true)
      return
    }
    if (player.hasGuessed) return // muted for the rest of the round

    if (normalizeGuess(text) === normalizeGuess(this.currentWord || '')) {
      this._awardCorrect(seat)
      return
    }

    player.wrongGuesses += 1
    this._pushChat('guess', text, seat)
    this._broadcast(true)
  }

  _awardCorrect(seat) {
    const player = this.state.players[seat]
    const remainingSeconds = Math.max(0, Math.ceil(this.state.timeLeftMs / 1000))
    const points = Math.max(
      MIN_POINTS,
      remainingSeconds * POINTS_PER_SECOND - player.wrongGuesses * WRONG_GUESS_PENALTY
    )
    player.score += points
    player.lastPoints = points
    player.hasGuessed = true

    const drawer = this.state.players[this.state.drawerSeat]
    if (drawer?.active) drawer.score += DRAWER_BONUS

    this._pushChat('correct', `🎉 ${this._label(seat)} guessed the word! (+${points} pts)`, seat, points)
    try { sfx.correct() } catch { /* audio optional */ }
    this._checkEveryoneGuessed()
    if (this.state.phase === 'DRAWING') this._broadcast(true)
  }

  _checkEveryoneGuessed() {
    if (this.state.phase !== 'DRAWING') return
    const guessers = this._guesserSeats()
    if (guessers.length === 0) {
      this._endRound('No guessers left.', false)
      return
    }
    if (guessers.every((seat) => this.state.players[seat].hasGuessed)) {
      this._endRound('Everyone guessed it!', true)
    }
  }

  _revealHint(count) {
    if (!this.currentWord) return
    const candidates = letterIndices(this.currentWord).filter((i) => !this.revealed.has(i))
    if (candidates.length <= 1) {
      // Never expose the final letter — mark the hint spent so we stop retrying.
      this.state.hintsShown = count
      return
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    this.revealed.add(pick)
    this.state.hintsShown = count
    this.state.maskedWord = buildMasked(this.currentWord, this.revealed)
    this._pushChat('hint', `Hint ${count}: ${this.state.maskedWord}`)
  }

  _endRound(reason, everyone) {
    if (!this.isHost) return
    this.state.phase = 'ROUND_SUMMARY'
    this.state.summaryMs = SUMMARY_MS
    this.state.revealWord = this.currentWord || '—'
    this.state.message = reason
    const solved = this._guesserSeats().filter((seat) => this.state.players[seat].hasGuessed).length
    this._pushSystem(
      `The word was "${this.state.revealWord}" — ${solved} ${solved === 1 ? 'player' : 'players'} got it.${
        everyone ? ' Perfect round!' : ''
      }`
    )
    this.botPlan.clear()
    this.botPen = null
    this._broadcast()
  }

  _gameOver() {
    this.state.phase = 'GAME_OVER'
    this.state.drawerSeat = -1
    this.state.timeLeftMs = 0
    this.state.selectMs = 0
    this.state.summaryMs = 0
    this.state.strokes = []
    this.state.maskedWord = ''
    this.state.rankings = this._activeSeats()
      .map((seat) => ({
        seat,
        score: this.state.players[seat].score,
        isBot: this.state.players[seat].isBot,
        name: this._label(seat),
      }))
      .sort((a, b) => b.score - a.score || a.seat - b.seat)
    const champ = this.state.rankings[0]
    this.state.message = champ ? `${champ.name} wins with ${champ.score} pts!` : 'Match complete.'
    this._pushSystem(this.state.message)
    this.currentWord = null
    this.myWord = null
    this.myChoices = null
    this._broadcast()
  }

  _returnToLobby(message) {
    if (!this.isHost) return
    const humans = new Set(this._humanSeats())
    this.state = this._emptyState()
    this.state.message = message || 'Share the room link, then press START when ready.'
    humans.add(0)
    humans.forEach((seat) => {
      this.state.players[seat] = this._freshPlayer({ active: true, isBot: false })
    })
    this.currentWord = null
    this.revealed = new Set()
    this.hostChoices = []
    this.botPlan.clear()
    this.botPen = null
    this.myWord = null
    this.myChoices = null
    this.chatRenderedId = 0
    this._broadcast()
  }

  // ------------------------------------------------------------------
  // Host tick
  // ------------------------------------------------------------------

  _hostTick(dtMs) {
    const phase = this.state.phase
    if (phase === 'WORD_SELECT') {
      this.state.selectMs -= dtMs
      const drawer = this.state.drawerSeat
      const isBot = !!this.state.players[drawer]?.isBot
      if (isBot && this.state.selectMs <= WORD_SELECT_MS - 1200) {
        this._hostPickWord(drawer, this.hostChoices[Math.floor(Math.random() * this.hostChoices.length)])
        return
      }
      if (this.state.selectMs <= 0) {
        this._pushSystem(`${this._label(drawer)} ran out of time — word auto-picked.`)
        this._hostPickWord(drawer, this.hostChoices[0])
      }
      return
    }

    if (phase === 'DRAWING') {
      this.state.timeLeftMs = Math.max(0, this.state.timeLeftMs - dtMs)
      const elapsedRatio = 1 - this.state.timeLeftMs / ROUND_MS
      if (this.state.hintsShown < 1 && elapsedRatio >= HINT_1_AT) this._revealHint(1)
      if (this.state.hintsShown < 2 && elapsedRatio >= HINT_2_AT) this._revealHint(2)

      this._driveBotArtist(dtMs)
      this._driveBotGuessers(ROUND_MS - this.state.timeLeftMs)

      if (this.state.timeLeftMs <= 0) {
        this._endRound("Time's up!", false)
      }
      return
    }

    if (phase === 'ROUND_SUMMARY') {
      this.state.summaryMs -= dtMs
      if (this.state.summaryMs <= 0) {
        if (this.state.queue.length === 0) this._gameOver()
        else this._beginTurn()
      }
    }
  }

  /** Bot artists drip a recognizable word silhouette instead of random scribbles. */
  _driveBotArtist(dtMs) {
    const pen = this.botPen
    if (!pen || pen.done) return
    if (!this.state.players[this.state.drawerSeat]?.isBot) return

    const segs = tickSketchPen(pen, dtMs, 36)
    for (const seg of segs) {
      this._hostStroke(this.state.drawerSeat, {
        x0: seg.x0,
        y0: seg.y0,
        x1: seg.x1,
        y1: seg.y1,
        size: seg.size,
        color: seg.color,
        erase: false,
      })
    }
  }

  _driveBotGuessers(elapsedMs) {
    if (this.botPlan.size === 0) return
    for (const [seat, plan] of this.botPlan.entries()) {
      const player = this.state.players[seat]
      if (!player?.active || !player.isBot || player.hasGuessed) continue

      if (!plan.wrongDone && elapsedMs >= plan.wrongAt) {
        plan.wrongDone = true
        const decoy = plan.wrongText
          || WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)].toLowerCase()
        if (normalizeGuess(decoy) !== normalizeGuess(this.currentWord || '')) {
          this._hostGuess(seat, decoy)
        }
      }
      if (!plan.guessDone && elapsedMs >= plan.guessAt) {
        // After hint 1 (40%), bump solve chance by advancing early solvers.
        const hintBoost = this.state.hintsShown >= 1 && !plan.hintNudge
        if (hintBoost) {
          plan.hintNudge = true
          plan.guessAt = Math.min(plan.guessAt, elapsedMs + 2500 + botNoise(seat, elapsedMs, 40) * 6000)
          if (elapsedMs < plan.guessAt) continue
        }
        plan.guessDone = true
        this._hostGuess(seat, this.currentWord || '')
      }
    }
  }

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(120, now - this.lastTime)
    this.lastTime = now

    if (this.isHost) {
      this.accumulator += dt
      while (this.accumulator >= TICK_MS) {
        this.accumulator -= TICK_MS
        this._hostTick(TICK_MS)
        this.tickCount += 1
        if (this.state.phase !== 'LOBBY' && this.tickCount % SYNC_EVERY_TICKS === 0) {
          this._broadcast(this.tickCount % 30 !== 0)
        }
      }
    }

    this._syncDom()
    this._render()
    this.raf = requestAnimationFrame(this._loop)
  }

  // ------------------------------------------------------------------
  // DOM overlay: toolbar + chat panel + word-pick modal
  // ------------------------------------------------------------------

  _buildDom() {
    const wrap = this.canvas.parentElement
    if (!wrap || !wrap.parentElement) return // canvas-only fallback

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
      this.ownsStyle = true
    }

    // Remember exactly where the canvas wrapper lived so stop() can restore it.
    this.domAnchor = { parent: wrap.parentElement, next: wrap.nextSibling, wrap }

    const stage = document.createElement('div')
    stage.className = 'skribbl-stage'

    const main = document.createElement('div')
    main.className = 'skribbl-main'

    // ---- toolbar ----
    const bar = document.createElement('div')
    bar.className = 'skribbl-bar'

    const status = document.createElement('div')
    status.className = 'skribbl-bar__status'
    const hintEl = document.createElement('div')
    hintEl.className = 'skribbl-bar__hint'
    hintEl.textContent = '— — —'
    const metaEl = document.createElement('div')
    metaEl.className = 'skribbl-bar__meta'
    metaEl.textContent = 'Waiting for the match to start.'
    status.append(hintEl, metaEl)

    const colorGroup = document.createElement('div')
    colorGroup.className = 'skribbl-bar__group skribbl-tool'
    const colorLabel = document.createElement('span')
    colorLabel.className = 'skribbl-bar__label'
    colorLabel.textContent = 'Color'
    colorGroup.appendChild(colorLabel)
    const swatches = PALETTE.map((color) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'skribbl-swatch'
      btn.style.background = color
      btn.dataset.color = color
      btn.title = `Use ${color}`
      btn.setAttribute('aria-label', `Color ${color}`)
      btn.setAttribute('aria-pressed', String(color === this.tool.color))
      this._listen(btn, 'click', () => {
        this.tool.color = color
        this.tool.eraser = false
        this.tool.fill = false
        this._refreshToolButtons()
      })
      colorGroup.appendChild(btn)
      return btn
    })

    const sizeGroup = document.createElement('div')
    sizeGroup.className = 'skribbl-bar__group skribbl-tool'
    const sizeLabel = document.createElement('span')
    sizeLabel.className = 'skribbl-bar__label'
    sizeLabel.textContent = 'Brush'
    sizeGroup.appendChild(sizeLabel)
    const sizeButtons = BRUSH_SIZES.map((brush) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'skribbl-btn'
      btn.textContent = brush.label
      btn.dataset.sizeId = brush.id
      btn.setAttribute('aria-pressed', String(brush.id === this.tool.sizeId))
      this._listen(btn, 'click', () => {
        this.tool.size = brush.size
        this.tool.sizeId = brush.id
        this._refreshToolButtons()
      })
      sizeGroup.appendChild(btn)
      return btn
    })

    const eraserBtn = document.createElement('button')
    eraserBtn.type = 'button'
    eraserBtn.className = 'skribbl-btn skribbl-tool'
    eraserBtn.textContent = 'Eraser'
    eraserBtn.setAttribute('aria-pressed', String(this.tool.eraser))
    this._listen(eraserBtn, 'click', () => {
      this.tool.eraser = !this.tool.eraser
      if (this.tool.eraser) this.tool.fill = false
      this._refreshToolButtons()
    })

    const fillBtn = document.createElement('button')
    fillBtn.type = 'button'
    fillBtn.className = 'skribbl-btn skribbl-tool'
    fillBtn.textContent = 'Fill'
    fillBtn.title = 'Flood fill bucket'
    fillBtn.setAttribute('aria-pressed', String(this.tool.fill))
    this._listen(fillBtn, 'click', () => {
      this.tool.fill = !this.tool.fill
      if (this.tool.fill) this.tool.eraser = false
      this._refreshToolButtons()
    })

    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'skribbl-btn skribbl-btn--danger skribbl-tool'
    clearBtn.textContent = 'Clear'
    this._listen(clearBtn, 'click', () => this._requestClear())

    bar.append(status, colorGroup, sizeGroup, eraserBtn, fillBtn, clearBtn)

    // ---- chat / guess panel ----
    const chat = document.createElement('aside')
    chat.className = 'skribbl-chat'
    const chatHead = document.createElement('div')
    chatHead.className = 'skribbl-chat__head'
    chatHead.textContent = 'Chat & Guesses'
    const scores = document.createElement('div')
    scores.className = 'skribbl-chat__scores'
    const feed = document.createElement('div')
    feed.className = 'skribbl-feed'
    feed.setAttribute('role', 'log')
    feed.setAttribute('aria-live', 'polite')

    const form = document.createElement('form')
    form.className = 'skribbl-form'
    const input = document.createElement('input')
    input.className = 'skribbl-input'
    input.type = 'text'
    input.maxLength = 64
    input.autocomplete = 'off'
    input.placeholder = 'Waiting for the match to start…'
    input.disabled = true
    input.setAttribute('aria-label', 'Your guess')
    const sendBtn = document.createElement('button')
    sendBtn.type = 'submit'
    sendBtn.className = 'skribbl-btn'
    sendBtn.textContent = 'Send'
    form.append(input, sendBtn)
    this._listen(form, 'submit', (event) => {
      event.preventDefault()
      this._submitGuess()
    })
    chat.append(chatHead, scores, feed, form)

    // ---- word-pick modal (lives inside the canvas frame) ----
    const pick = document.createElement('div')
    pick.className = 'skribbl-pick'
    pick.hidden = true
    const pickTitle = document.createElement('h3')
    pickTitle.className = 'skribbl-pick__title'
    pickTitle.textContent = 'Your turn to draw — pick a word'
    const pickSub = document.createElement('p')
    pickSub.className = 'skribbl-pick__sub'
    pickSub.textContent = 'You get 60 seconds once you choose.'
    const pickRow = document.createElement('div')
    pickRow.className = 'skribbl-pick__row'
    pick.append(pickTitle, pickSub, pickRow)

    // Mount: stage takes the canvas wrapper's slot, wrapper moves inside it.
    this.domAnchor.parent.insertBefore(stage, this.domAnchor.next)
    main.append(bar, wrap)
    stage.append(main, chat)
    wrap.appendChild(pick)

    this.dom = {
      stage, main, bar, hintEl, metaEl, swatches, sizeButtons, eraserBtn, fillBtn, clearBtn,
      chat, scores, feed, form, input, pick, pickRow, pickSub,
    }
    this.chatRenderedId = 0
    this._scoreSig = ''
    this._pickSig = ''
    this._statusSig = ''
    this._inputSig = ''
    this._refreshToolButtons()
  }

  _listen(node, type, handler) {
    if (!this.domListeners) this.domListeners = []
    node.addEventListener(type, handler)
    this.domListeners.push([node, type, handler])
  }

  _destroyDom() {
    if (this.domListeners) {
      this.domListeners.forEach(([node, type, handler]) => node.removeEventListener(type, handler))
      this.domListeners = null
    }
    if (this.dom) {
      this.dom.pick?.remove()
      this.dom.chat?.remove()
      this.dom.bar?.remove()
      if (this.domAnchor?.parent && this.domAnchor.wrap) {
        // Put the shared canvas wrapper back exactly where we found it.
        this.domAnchor.parent.insertBefore(this.domAnchor.wrap, this.domAnchor.next)
      }
      this.dom.stage?.remove()
      this.dom = null
    }
    this.domAnchor = null
    if (this.ownsStyle) {
      document.getElementById(STYLE_ID)?.remove()
      this.ownsStyle = false
    }
  }

  _refreshToolButtons() {
    if (!this.dom) return
    this.dom.swatches.forEach((btn) => {
      btn.setAttribute(
        'aria-pressed',
        String(!this.tool.eraser && !this.tool.fill && btn.dataset.color === this.tool.color)
      )
    })
    this.dom.sizeButtons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.sizeId === this.tool.sizeId))
    })
    this.dom.eraserBtn.setAttribute('aria-pressed', String(this.tool.eraser))
    if (this.dom.fillBtn) this.dom.fillBtn.setAttribute('aria-pressed', String(this.tool.fill))
  }

  _amDrawer() {
    return this.mySeat != null && this.mySeat === this.state.drawerSeat
  }

  _myPlayer() {
    return this.mySeat != null ? this.state.players[this.mySeat] : null
  }

  /** Per-frame DOM reconciliation — every update is signature-gated. */
  _syncDom() {
    if (!this.dom) return
    const state = this.state
    const drawing = state.phase === 'DRAWING'
    const canDraw = drawing && this._amDrawer()

    // Toolbar lock + status line
    this.dom.bar.classList.toggle('is-locked', !canDraw)
    const hintText = this._hintText()
    const metaText = this._metaText()
    const statusSig = `${hintText}|${metaText}`
    if (statusSig !== this._statusSig) {
      this._statusSig = statusSig
      this.dom.hintEl.textContent = hintText
      this.dom.metaEl.textContent = metaText
    }

    // Scoreboard
    const scoreSig = state.players
      .map((p, seat) => (p.active ? `${seat}:${p.score}:${p.hasGuessed ? 1 : 0}` : ''))
      .join(',') + `|${state.drawerSeat}|${state.phase}`
    if (scoreSig !== this._scoreSig) {
      this._scoreSig = scoreSig
      this._renderScores()
    }

    // Chat feed
    this._renderFeed()

    // Guess input availability
    const me = this._myPlayer()
    let disabled = true
    let placeholder = 'Spectating this match…'
    if (state.phase === 'LOBBY') placeholder = 'Waiting for the match to start…'
    else if (state.phase === 'GAME_OVER') placeholder = 'Match complete — check the podium!'
    else if (!me?.active) placeholder = 'Spectating this match…'
    else if (this._amDrawer()) placeholder = "You're the artist — draw it!"
    else if (me.hasGuessed) placeholder = '✓ You already guessed it!'
    else if (state.phase === 'WORD_SELECT') {
      placeholder = 'Artist is picking a word…'
      disabled = false
    } else {
      placeholder = 'Type your guess, press Enter'
      disabled = false
    }
    const inputSig = `${disabled}|${placeholder}`
    if (inputSig !== this._inputSig) {
      this._inputSig = inputSig
      this.dom.input.disabled = disabled
      this.dom.input.placeholder = placeholder
      if (disabled) this.dom.input.value = ''
    }

    // Word-pick modal
    const showPick = state.phase === 'WORD_SELECT' && this._amDrawer() && Array.isArray(this.myChoices)
    const pickSig = showPick ? this.myChoices.join('|') : ''
    if (pickSig !== this._pickSig) {
      this._pickSig = pickSig
      this.dom.pickRow.replaceChildren()
      if (showPick) {
        this.myChoices.forEach((word) => {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'skribbl-pick__btn'
          btn.textContent = word
          btn.addEventListener('click', () => this._choose(word))
          this.dom.pickRow.appendChild(btn)
        })
      }
    }
    if (showPick) {
      this.dom.pickSub.textContent = `Choose within ${Math.max(0, Math.ceil(state.selectMs / 1000))}s — the round is 60 seconds.`
    }
    this.dom.pick.hidden = !showPick
  }

  _hintText() {
    const state = this.state
    if (state.phase === 'DRAWING') {
      if (this._amDrawer() && this.myWord) return this.myWord
      return state.maskedWord || '—'
    }
    if (state.phase === 'ROUND_SUMMARY') return state.revealWord || '—'
    if (state.phase === 'WORD_SELECT') return 'PICKING…'
    return '— — —'
  }

  _metaText() {
    const state = this.state
    if (state.phase === 'LOBBY') return 'Lobby — host presses START.'
    if (state.phase === 'GAME_OVER') return state.message
    const turn = `Turn ${state.turn}/${state.totalTurns}`
    if (state.phase === 'WORD_SELECT') return `${turn} · ${this._label(state.drawerSeat)} choosing`
    if (state.phase === 'ROUND_SUMMARY') return `${turn} · round over`
    const seconds = Math.max(0, Math.ceil(state.timeLeftMs / 1000))
    const shape = state.wordShape ? ` · ${state.wordShape}` : ''
    return `${turn} · ${seconds}s left · ${this._label(state.drawerSeat)} drawing${shape}`
  }

  _renderScores() {
    const rows = []
    const ordered = this._activeSeats().sort(
      (a, b) => this.state.players[b].score - this.state.players[a].score || a - b
    )
    ordered.forEach((seat) => {
      const player = this.state.players[seat]
      const row = document.createElement('div')
      row.className = 'skribbl-score'
      if (seat === this.state.drawerSeat) row.classList.add('is-drawer')
      if (player.hasGuessed) row.classList.add('is-guessed')

      const dot = document.createElement('span')
      dot.className = 'skribbl-score__dot'
      dot.style.background = LOBBY_COLORS[seat % LOBBY_COLORS.length]

      const name = document.createElement('span')
      name.className = 'skribbl-score__name'
      const you = seat === this.mySeat ? ' (You)' : ''
      const pencil = seat === this.state.drawerSeat ? '▸ ' : ''
      const check = player.hasGuessed ? ' ✓' : ''
      name.textContent = `${pencil}${this._label(seat)}${you}${check}`

      const pts = document.createElement('span')
      pts.className = 'skribbl-score__pts'
      pts.textContent = `${player.score}`

      row.append(dot, name, pts)
      rows.push(row)
    })
    this.dom.scores.replaceChildren(...rows)
  }

  _renderFeed() {
    const chat = this.state.chat || []
    const lastId = chat.length ? chat[chat.length - 1].id : 0
    if (chat.length === 0 || lastId < this.chatRenderedId) {
      this.dom.feed.replaceChildren()
      this.chatRenderedId = 0
      if (chat.length === 0) return
    }
    const fresh = chat.filter((entry) => entry.id > this.chatRenderedId)
    if (fresh.length === 0) return

    fresh.forEach((entry) => {
      const line = document.createElement('div')
      line.className = `skribbl-msg skribbl-msg--${entry.kind}`
      if (entry.kind === 'guess' && entry.seat >= 0) {
        const who = document.createElement('b')
        who.textContent = `${this._label(entry.seat)}${entry.seat === this.mySeat ? ' (You)' : ''}: `
        line.append(who, document.createTextNode(entry.text))
      } else {
        line.textContent = entry.text
      }
      this.dom.feed.appendChild(line)
      this.chatRenderedId = Math.max(this.chatRenderedId, entry.id)
    })

    while (this.dom.feed.childElementCount > MAX_CHAT) {
      this.dom.feed.removeChild(this.dom.feed.firstElementChild)
    }
    this.dom.feed.scrollTop = this.dom.feed.scrollHeight
  }

  // ------------------------------------------------------------------
  // Local intent -> host
  // ------------------------------------------------------------------

  _submitGuess() {
    if (!this.dom) return
    const text = this.dom.input.value.trim()
    this.dom.input.value = ''
    if (!text) return
    if (this.isHost) this._hostGuess(this.mySeat ?? 0, text)
    else this._sendToHost({ type: 'guess', text })
  }

  _choose(word) {
    if (!this._amDrawer() || this.state.phase !== 'WORD_SELECT') return
    this.myChoices = null
    this._pickSig = ''
    if (this.dom) this.dom.pick.hidden = true
    if (this.isHost) this._hostPickWord(this.mySeat ?? 0, word)
    else this._sendToHost({ type: 'pickWord', word })
  }

  _requestClear() {
    if (this.state.phase !== 'DRAWING' || !this._amDrawer()) return
    if (this.isHost) this._hostClearBoard(this.mySeat ?? 0)
    else {
      this.state.strokes = []
      this._sendToHost({ type: 'clearBoard' })
    }
  }

  _emitSeg(seg) {
    if (this.isHost) {
      this._hostStroke(this.mySeat ?? 0, seg)
    } else {
      this.state.strokes.push(seg) // optimistic: the ink appears instantly
      this._sendToHost({ type: 'stroke', seg })
    }
  }

  // ------------------------------------------------------------------
  // Pointer input
  // ------------------------------------------------------------------

  _onPointerDown(event) {
    const point = canvasPoint(this.canvas, event, this.width, this.height)

    if (this.state.phase === 'LOBBY') {
      if (this.isHost && this.startRect && hit(point, this.startRect)) {
        this._hostStartMatch()
      }
      return
    }
    if (this.state.phase === 'GAME_OVER') {
      if (this.isHost && this.againRect && hit(point, this.againRect)) {
        this._returnToLobby('Ready for another round?')
      } else if (!this.isHost) {
        this._sendToHost({ type: 'playAgain' })
      }
      return
    }
    if (this.state.phase !== 'DRAWING' || !this._amDrawer()) return
    if (point.y < BOARD.y) return

    const start = this._clampToBoard(point)

    // Flood-fill bucket: one click paints a contiguous region of the board.
    if (this.tool.fill && !this.tool.eraser) {
      this._emitSeg({ op: 'fill', x: start.x, y: start.y, color: this.tool.color })
      sfx.ui()
      return
    }

    this.drawing = true
    this.lastPoint = start
    this.strokePts = [start]
    this._emitSeg(this._segFrom(start, start, start))
  }

  _onPointerMove(event) {
    if (!this.drawing) return
    if (this.state.phase !== 'DRAWING' || !this._amDrawer()) {
      this.drawing = false
      this.strokePts = []
      return
    }
    const point = this._clampToBoard(canvasPoint(this.canvas, event, this.width, this.height))
    const from = this.lastPoint || point
    const dx = point.x - from.x
    const dy = point.y - from.y
    if (dx * dx + dy * dy < 2.25) return

    // Quadratic Bézier: previous point → midpoint as control → current point.
    this.strokePts.push(point)
    const pts = this.strokePts
    if (pts.length >= 3) {
      const p0 = pts[pts.length - 3]
      const p1 = pts[pts.length - 2]
      const p2 = pts[pts.length - 1]
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      const prevMid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
      this._emitSeg(this._segFrom(prevMid, mid, p1))
    } else {
      this._emitSeg(this._segFrom(from, point, point))
    }
    this.lastPoint = point
    if (Math.random() < 0.08) sfx.stroke()
  }

  _onPointerUp() {
    this.drawing = false
    this.lastPoint = null
    this.strokePts = []
  }

  _clampToBoard(point) {
    return {
      x: clamp(point.x, BOARD.x, BOARD.x + BOARD.w),
      y: clamp(point.y, BOARD.y, BOARD.y + BOARD.h),
    }
  }

  _segFrom(from, to, control = null) {
    return {
      x0: from.x,
      y0: from.y,
      x1: to.x,
      y1: to.y,
      cx: control ? control.x : null,
      cy: control ? control.y : null,
      size: this.tool.eraser ? this.tool.size * 2.4 : this.tool.size,
      color: this.tool.eraser ? C_BG : this.tool.color,
      erase: this.tool.eraser,
    }
  }

  // ------------------------------------------------------------------
  // Canvas rendering
  // ------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    const state = this.state

    if (state.phase === 'LOBBY') {
      this.againRect = null
      this.startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'DRAW & GUESS',
        seats: state.players,
        capacity: this.p2p?.maxPlayers ? clamp(this.p2p.maxPlayers, 2, SEAT_COUNT) : SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
        message: state.message,
      })
      return
    }

    this.startRect = null

    if (state.phase === 'GAME_OVER') {
      this._drawPodium()
      return
    }

    this.againRect = null
    this._drawBoard()
    this._drawStrokes()
    this._drawHud()

    if (state.phase === 'WORD_SELECT') this._drawSelectOverlay()
    else if (state.phase === 'ROUND_SUMMARY') this._drawSummaryOverlay()
    else this._drawDrawingFooter()
  }

  _drawBoard() {
    const ctx = this.ctx
    drawArenaBackdrop(ctx, this.width, this.height, { step: 48 })

    ctx.fillStyle = withAlpha(THEME.bgDeep, 0.88)
    ctx.fillRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h)

    ctx.strokeStyle = withAlpha(THEME.cyan, 0.06)
    ctx.lineWidth = 1
    for (let x = BOARD.x + 40; x < BOARD.x + BOARD.w; x += 40) {
      ctx.beginPath()
      ctx.moveTo(x, BOARD.y)
      ctx.lineTo(x, BOARD.y + BOARD.h)
      ctx.stroke()
    }
    for (let y = BOARD.y + 40; y < BOARD.y + BOARD.h; y += 40) {
      ctx.beginPath()
      ctx.moveTo(BOARD.x, y)
      ctx.lineTo(BOARD.x + BOARD.w, y)
      ctx.stroke()
    }

    ctx.strokeStyle = withAlpha(THEME.cyan, 0.35)
    ctx.lineWidth = 1.5
    ctx.strokeRect(BOARD.x + 0.5, BOARD.y + 0.5, BOARD.w - 1, BOARD.h - 1)
  }

  _drawStrokes() {
    const ctx = this.ctx
    const strokes = this.state.strokes || []
    if (strokes.length === 0) return

    // Offscreen buffer so flood-fill can sample contiguous color regions.
    if (!this._ink || this._ink.width !== this.width) {
      this._ink = document.createElement('canvas')
      this._ink.width = this.width
      this._ink.height = this.height
      this._inkCtx = this._ink.getContext('2d', { willReadFrequently: true })
    }
    const ink = this._inkCtx
    ink.clearRect(0, 0, this.width, this.height)
    ink.fillStyle = '#0a0f1c'
    ink.fillRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h)
    ink.lineCap = 'round'
    ink.lineJoin = 'round'

    for (let i = 0; i < strokes.length; i++) {
      const seg = strokes[i]
      if (!seg) continue
      if (seg.op === 'fill') {
        this._floodFill(ink, Math.round(seg.x), Math.round(seg.y), seg.color || C_TEXT)
        continue
      }
      ink.strokeStyle = seg.erase ? '#0a0f1c' : seg.color || C_TEXT
      ink.lineWidth = seg.size || 8
      ink.beginPath()
      if (seg.x0 === seg.x1 && seg.y0 === seg.y1 && seg.cx == null) {
        ink.arc(seg.x0, seg.y0, Math.max(0.6, ink.lineWidth / 2), 0, Math.PI * 2)
        ink.fillStyle = ink.strokeStyle
        ink.fill()
      } else if (seg.cx != null && seg.cy != null) {
        ink.moveTo(seg.x0, seg.y0)
        ink.quadraticCurveTo(seg.cx, seg.cy, seg.x1, seg.y1)
        ink.stroke()
      } else {
        ink.moveTo(seg.x0, seg.y0)
        ink.lineTo(seg.x1, seg.y1)
        ink.stroke()
      }
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(BOARD.x, BOARD.y, BOARD.w, BOARD.h)
    ctx.clip()
    ctx.drawImage(this._ink, 0, 0)
    ctx.restore()
    ctx.lineWidth = 1
  }

  /**
   * Scanline flood fill on the ink buffer. Caps work so a full-board fill
   * cannot stall the frame for more than a few ms on large regions.
   */
  _floodFill(ctx, sx, sy, fillHex) {
    if (sx < BOARD.x || sy < BOARD.y || sx >= BOARD.x + BOARD.w || sy >= BOARD.y + BOARD.h) return
    const { width, height } = ctx.canvas
    const img = ctx.getImageData(0, 0, width, height)
    const data = img.data
    const idx = (x, y) => (y * width + x) * 4
    const start = idx(sx, sy)
    const tr = data[start]
    const tg = data[start + 1]
    const tb = data[start + 2]
    const ta = data[start + 3]

    const parse = (hex) => {
      let h = hex.replace('#', '')
      if (h.length === 3) h = h.split('').map((c) => c + c).join('')
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    }
    const [fr, fg, fb] = parse(fillHex)
    if (tr === fr && tg === fg && tb === fb && ta === 255) return

    const match = (i) =>
      Math.abs(data[i] - tr) < 18 &&
      Math.abs(data[i + 1] - tg) < 18 &&
      Math.abs(data[i + 2] - tb) < 18

    const stack = [[sx, sy]]
    let painted = 0
    const MAX = 180000
    while (stack.length && painted < MAX) {
      const [x, y] = stack.pop()
      let lx = x
      while (lx >= BOARD.x && match(idx(lx, y))) lx--
      lx++
      let spanUp = false
      let spanDown = false
      while (lx < BOARD.x + BOARD.w && match(idx(lx, y))) {
        const i = idx(lx, y)
        data[i] = fr
        data[i + 1] = fg
        data[i + 2] = fb
        data[i + 3] = 255
        painted++
        if (y > BOARD.y) {
          if (match(idx(lx, y - 1))) {
            if (!spanUp) { stack.push([lx, y - 1]); spanUp = true }
          } else spanUp = false
        }
        if (y < BOARD.y + BOARD.h - 1) {
          if (match(idx(lx, y + 1))) {
            if (!spanDown) { stack.push([lx, y + 1]); spanDown = true }
          } else spanDown = false
        }
        lx++
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  _drawHud() {
    const ctx = this.ctx
    const state = this.state

    ctx.fillStyle = C_PANEL
    ctx.fillRect(0, 0, this.width, BOARD.y)
    ctx.strokeStyle = 'rgba(0,229,255,.3)'
    ctx.beginPath()
    ctx.moveTo(0, BOARD.y - 0.5)
    ctx.lineTo(this.width, BOARD.y - 0.5)
    ctx.stroke()

    // Left: turn + artist
    ctx.textAlign = 'left'
    ctx.fillStyle = C_DIM
    ctx.font = `11px ${FONT_UI}`
    ctx.fillText(`TURN ${state.turn} / ${state.totalTurns}`, 16, 22)
    ctx.fillStyle = C_GOLD
    ctx.font = `bold 15px ${FONT_UI}`
    const artist = state.drawerSeat >= 0 ? this._label(state.drawerSeat) : '—'
    ctx.fillText(`ART  ${artist}${state.drawerSeat === this.mySeat ? ' YOU' : ''}`, 16, 44)

    // Center: word / hint
    ctx.textAlign = 'center'
    const showReal = this._amDrawer() && this.myWord
    const wordText = showReal
      ? this.myWord
      : state.phase === 'ROUND_SUMMARY'
        ? state.revealWord
        : state.maskedWord || '— — —'
    ctx.fillStyle = C_CYAN
    ctx.font = 'bold 24px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(wordText, this.width / 2, 34)
    ctx.fillStyle = C_DIM
    ctx.font = `11px ${FONT_UI}`
    const shapeLine = showReal
      ? `Your word · ${state.wordShape}`
      : state.wordShape || 'waiting for the artist'
    ctx.fillText(shapeLine, this.width / 2, 52)

    // Right: countdown
    const seconds = Math.max(0, Math.ceil(state.timeLeftMs / 1000))
    ctx.textAlign = 'right'
    ctx.fillStyle = seconds <= 10 && state.phase === 'DRAWING' ? C_PINK : C_CYAN
    ctx.font = `bold 30px ${FONT_UI}`
    ctx.fillText(`${seconds}s`, this.width - 16, 42)

    // Time bar
    const ratio = clamp(state.timeLeftMs / ROUND_MS, 0, 1)
    ctx.fillStyle = 'rgba(0,229,255,.14)'
    ctx.fillRect(0, BOARD.y - 4, this.width, 3)
    ctx.fillStyle = seconds <= 10 && state.phase === 'DRAWING' ? C_PINK : C_CYAN
    ctx.fillRect(0, BOARD.y - 4, this.width * ratio, 3)
    ctx.textAlign = 'left'
  }

  _drawDrawingFooter() {
    const ctx = this.ctx
    const me = this._myPlayer()
    let text
    if (this._amDrawer()) text = 'Drag on the board to draw. Use the toolbar for colors, brush size, eraser and clear.'
    else if (me?.hasGuessed) text = `✓ Solved for +${me.lastPoints} pts — watch the rest of the round.`
    else text = 'Type your guess in the chat panel. Wrong guesses cost 25 potential points.'

    ctx.textAlign = 'center'
    ctx.fillStyle = me?.hasGuessed && !this._amDrawer() ? C_GREEN : 'rgba(147,162,194,.9)'
    ctx.font = `12px ${FONT_UI}`
    ctx.fillText(text, this.width / 2, this.height - 12)
    ctx.textAlign = 'left'
  }

  _drawSelectOverlay() {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(5,7,13,.86)'
    ctx.fillRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h)

    const seconds = Math.max(0, Math.ceil(this.state.selectMs / 1000))
    ctx.textAlign = 'center'
    ctx.fillStyle = C_TEXT
    ctx.font = `bold 28px ${FONT_UI}`
    ctx.fillText('CHOOSING A WORD', this.width / 2, 250)
    ctx.fillStyle = C_DIM
    ctx.font = `15px ${FONT_UI}`
    ctx.fillText(
      `${this._label(this.state.drawerSeat)} is picking from 3 words — ${seconds}s`,
      this.width / 2,
      284
    )
    ctx.fillStyle = C_CYAN
    ctx.font = `13px ${FONT_UI}`
    ctx.fillText('Get your guessing fingers ready.', this.width / 2, 314)
    ctx.textAlign = 'left'
  }

  _drawSummaryOverlay() {
    const ctx = this.ctx
    const state = this.state
    ctx.fillStyle = 'rgba(5,7,13,.9)'
    ctx.fillRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h)

    ctx.textAlign = 'center'
    ctx.fillStyle = C_DIM
    ctx.font = `13px ${FONT_UI}`
    ctx.fillText('THE WORD WAS', this.width / 2, 150)
    ctx.fillStyle = C_CYAN
    ctx.font = `bold 44px ${FONT_UI}`
    ctx.fillText(state.revealWord || '—', this.width / 2, 196)

    ctx.fillStyle = C_GREEN
    ctx.font = `14px ${FONT_UI}`
    ctx.fillText(state.message || '', this.width / 2, 226)

    const solvers = this._guesserSeats()
      .filter((seat) => state.players[seat].hasGuessed)
      .sort((a, b) => state.players[b].lastPoints - state.players[a].lastPoints)

    if (solvers.length === 0) {
      ctx.fillStyle = C_PINK
      ctx.font = `15px ${FONT_UI}`
      ctx.fillText('Nobody guessed it — no points awarded.', this.width / 2, 268)
    } else {
      ctx.font = `14px ${FONT_UI}`
      solvers.slice(0, 6).forEach((seat, index) => {
        const player = state.players[seat]
        ctx.fillStyle = C_TEXT
        ctx.fillText(
          `${this._label(seat)}  +${player.lastPoints} pts${player.wrongGuesses ? `  (${player.wrongGuesses} wrong)` : ''}`,
          this.width / 2,
          262 + index * 22
        )
      })
      const drawerSeat = state.drawerSeat
      if (drawerSeat >= 0) {
        ctx.fillStyle = C_GOLD
        ctx.font = `13px ${FONT_UI}`
        ctx.fillText(
          `${this._label(drawerSeat)} earned +${solvers.length * DRAWER_BONUS} artist bonus`,
          this.width / 2,
          268 + Math.min(solvers.length, 6) * 22
        )
      }
    }

    const next = Math.max(0, Math.ceil(state.summaryMs / 1000))
    ctx.fillStyle = C_DIM
    ctx.font = `13px ${FONT_UI}`
    ctx.fillText(
      state.queue.length > 0 ? `Next artist in ${next}s…` : `Final results in ${next}s…`,
      this.width / 2,
      this.height - 40
    )
    ctx.textAlign = 'left'
  }

  _drawPodium() {
    const ctx = this.ctx
    const state = this.state

    ctx.fillStyle = C_BG
    ctx.fillRect(0, 0, this.width, this.height)

    // Neon floor grid
    ctx.strokeStyle = 'rgba(0,229,255,.08)'
    ctx.lineWidth = 1
    for (let x = 0; x <= this.width; x += 48) {
      ctx.beginPath()
      ctx.moveTo(x, 360)
      ctx.lineTo(this.width / 2 + (x - this.width / 2) * 1.9, this.height)
      ctx.stroke()
    }
    for (let y = 360; y <= this.height; y += 22) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(this.width, y)
      ctx.stroke()
    }

    ctx.textAlign = 'center'
    ctx.fillStyle = C_TEXT
    ctx.font = `bold 32px ${FONT_UI}`
    ctx.fillText('FINAL SCORES', this.width / 2, 52)
    ctx.fillStyle = C_CYAN
    ctx.font = `14px ${FONT_UI}`
    ctx.fillText(state.message || 'Match complete.', this.width / 2, 78)

    // Heights stay above 150px so the name, role tag and score never collide;
    // the ranking hierarchy is carried by the remaining height difference.
    const medals = [
      { color: C_GOLD, label: '#1', h: 200, w: 156 },
      { color: '#c9d4e4', label: '#2', h: 176, w: 146 },
      { color: '#cd7f32', label: '#3', h: 156, w: 146 },
    ]
    const order = [1, 0, 2] // silver, gold, bronze across the stage
    const centerX = this.width / 2
    const slotX = [centerX - 190, centerX, centerX + 190]
    const baseY = 440

    order.forEach((rankIndex, slot) => {
      const entry = state.rankings[rankIndex]
      const medal = medals[rankIndex]
      const x = slotX[slot]
      const w = medal.w
      const h = entry ? medal.h : 70
      const y = baseY - h

      ctx.fillStyle = entry ? 'rgba(21,29,48,.95)' : 'rgba(21,29,48,.55)'
      ctx.fillRect(x - w / 2, y, w, h)
      ctx.strokeStyle = entry ? medal.color : 'rgba(83,96,120,.6)'
      ctx.lineWidth = 2
      ctx.strokeRect(x - w / 2, y, w, h)
      ctx.lineWidth = 1

      ctx.fillStyle = entry ? medal.color : C_FAINT
      ctx.font = `bold 26px ${FONT_UI}`
      ctx.fillText(medal.label, x, y + 34)

      if (!entry) {
        ctx.fillStyle = C_FAINT
        ctx.font = `12px ${FONT_UI}`
        ctx.fillText('—', x, y + 56)
        return
      }

      ctx.fillStyle = LOBBY_COLORS[entry.seat % LOBBY_COLORS.length]
      ctx.beginPath()
      ctx.arc(x, y + 64, 10, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = C_TEXT
      ctx.font = `bold 16px ${FONT_UI}`
      const you = entry.seat === this.mySeat ? ' (You)' : ''
      ctx.fillText(`${entry.name}${you}`, x, y + 98)

      ctx.fillStyle = entry.isBot ? '#ff9f43' : C_GREEN
      ctx.font = `11px ${FONT_UI}`
      ctx.fillText(entry.isBot ? 'BOT' : 'HUMAN', x, y + 116)

      ctx.fillStyle = medal.color
      ctx.font = `bold 22px ${FONT_UI}`
      ctx.fillText(`${entry.score}`, x, y + h - 14)
    })

    // 4th place and beyond
    const rest = state.rankings.slice(3)
    if (rest.length > 0) {
      ctx.textAlign = 'left'
      ctx.fillStyle = C_DIM
      ctx.font = `11px ${FONT_UI}`
      ctx.fillText('RUNNERS-UP', 24, 132)
      rest.slice(0, 9).forEach((entry, index) => {
        const y = 154 + index * 20
        ctx.fillStyle = LOBBY_COLORS[entry.seat % LOBBY_COLORS.length]
        ctx.beginPath()
        ctx.arc(30, y - 4, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = entry.seat === this.mySeat ? C_TEXT : '#a9b7d1'
        ctx.font = `13px ${FONT_UI}`
        ctx.fillText(`#${index + 4}  ${entry.name}${entry.seat === this.mySeat ? ' (You)' : ''}`, 44, y)
        ctx.fillStyle = C_DIM
        ctx.fillText(`${entry.score}`, 186, y)
      })
      ctx.textAlign = 'center'
    }

    // Play again
    if (this.isHost) {
      const w = 240
      const h = 48
      const x = (this.width - w) / 2
      const y = this.height - 66
      this.againRect = { x, y, w, h }
      ctx.fillStyle = 'rgba(57,255,20,.16)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = C_GREEN
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, w, h)
      ctx.lineWidth = 1
      ctx.fillStyle = C_TEXT
      ctx.font = `bold 18px ${FONT_UI}`
      ctx.fillText('↻  PLAY AGAIN', this.width / 2, y + 31)
    } else {
      this.againRect = null
      ctx.fillStyle = C_DIM
      ctx.font = `13px ${FONT_UI}`
      ctx.fillText('Waiting for the host to start a new match…', this.width / 2, this.height - 34)
    }
    ctx.textAlign = 'left'
  }
}




