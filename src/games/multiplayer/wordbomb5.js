// Word Bomb 5. A compact in-memory word list deliberately keeps this
// zero-storage game fully client-side while still providing deterministic
// host validation. The host alone owns timer, turn, lives, and phrase state.

import { drawLobby, fillBots, canvasPoint, hit, botNoise, findReclaimSeat, findLobbySeat } from '../shared/lobby.js'
import { snapshotFromState, applyStateSnapshot } from '../shared/snapshot.js'
import {
  THEME,
  FONT_MONO,
  FONT_UI,
  drawArenaBackdrop,
  drawGlassPanel,
  drawNeonText,
  withAlpha,
} from '../../fx/theme.js'

const TICK_MS = 1000 / 30
const SEAT_COUNT = 5
const TURN_MS = 10000
const ROUND_PAUSE_MS = 1600
const COLORS = ['#00e5ff', '#ff007f', '#39ff14', '#ffd23f', '#b980ff']
const NAMES = ['P1', 'P2', 'P3', 'P4', 'P5']

// Common words paired with the 2–3 letter roots they cover. The syllable
// pool below is generated from this same set, so every presented challenge
// always has at least one valid in-memory answer.
const WORDS = [
  'action', 'active', 'actor', 'actual', 'adapt', 'adventure', 'after', 'again', 'agent', 'album',
  'alert', 'alone', 'almost', 'alpha', 'answer', 'apple', 'april', 'artist', 'atom', 'attack',
  'basic', 'battle', 'beach', 'beauty', 'before', 'begin', 'believe', 'better', 'bicycle', 'bird',
  'black', 'block', 'blue', 'border', 'brain', 'brave', 'bread', 'bridge', 'bright', 'brother',
  'button', 'camera', 'candle', 'capital', 'captain', 'careful', 'castle', 'catch', 'center', 'chance',
  'change', 'chapter', 'charge', 'chicken', 'choice', 'circle', 'citizen', 'classic', 'clean', 'clear',
  'climate', 'clock', 'cloud', 'coffee', 'color', 'common', 'complete', 'computer', 'control', 'corner',
  'country', 'course', 'create', 'credit', 'crystal', 'culture', 'danger', 'dance', 'decide', 'degree',
  'design', 'detail', 'develop', 'diamond', 'different', 'direct', 'discover', 'doctor', 'double', 'dragon',
  'dream', 'drive', 'eager', 'early', 'earth', 'effect', 'energy', 'engine', 'enough', 'escape',
  'event', 'every', 'exact', 'example', 'excited', 'expert', 'factor', 'family', 'famous', 'fantasy',
  'farmer', 'fast', 'father', 'feature', 'final', 'finger', 'fire', 'flower', 'focus', 'forest',
  'forget', 'friend', 'future', 'garden', 'gentle', 'giant', 'globe', 'golden', 'ground', 'group',
  'handle', 'happy', 'harbor', 'health', 'heart', 'heavy', 'hidden', 'history', 'holiday', 'honest',
  'human', 'hunter', 'image', 'impact', 'important', 'inside', 'island', 'jacket', 'jungle', 'keyboard',
  'kingdom', 'ladder', 'language', 'laugh', 'leader', 'learn', 'legend', 'letter', 'library', 'light',
  'little', 'magic', 'market', 'master', 'matter', 'member', 'memory', 'message', 'middle', 'minute',
  'modern', 'moment', 'monkey', 'mother', 'motion', 'mountain', 'music', 'nature', 'nearby', 'neon',
  'night', 'normal', 'notice', 'number', 'object', 'ocean', 'office', 'orange', 'order', 'origin',
  'paper', 'parent', 'party', 'patient', 'peace', 'people', 'perfect', 'person', 'picture', 'planet',
  'player', 'pocket', 'poetry', 'police', 'power', 'present', 'pretty', 'price', 'prince', 'private',
  'project', 'proper', 'purple', 'puzzle', 'quick', 'quiet', 'radio', 'random', 'reason', 'record',
  'return', 'river', 'rocket', 'round', 'route', 'royal', 'safety', 'school', 'science', 'season',
  'secret', 'shadow', 'simple', 'silver', 'sister', 'skill', 'smart', 'smooth', 'social', 'soldier',
  'sound', 'space', 'special', 'spirit', 'spring', 'square', 'stable', 'story', 'street', 'strong',
  'summer', 'sunset', 'system', 'table', 'talent', 'target', 'teacher', 'temple', 'thank', 'theme',
  'thunder', 'ticket', 'time', 'together', 'tomorrow', 'travel', 'triangle', 'tunnel', 'uncle', 'under',
  'unique', 'united', 'useful', 'vacation', 'valley', 'value', 'velvet', 'victory', 'video', 'village',
  'violet', 'vision', 'voice', 'wander', 'water', 'welcome', 'window', 'winter', 'wisdom', 'wonder',
  'world', 'yellow', 'zebra',
]

const DICTIONARY = new Set(WORDS)
const SHORT_ROOTS = new Set(['ac', 'an', 'be', 'br', 'ch', 'cl', 'cr', 'dr', 'fl', 'fr', 'gr', 'pl', 'pr', 'sh', 'sp', 'st', 'th', 'tr', 'un', 've'])
const ROOTS = [...new Set(WORDS.flatMap((word) => {
  const roots = []
  for (let length = 2; length <= 3; length++) {
    for (let index = 0; index <= word.length - length; index++) roots.push(word.slice(index, index + length))
  }
  return roots
}).filter((root) => root.length === 3 || SHORT_ROOTS.has(root)))]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export default class WordBomb5Game {
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2p = p2pContext
    this.isHost = !!p2pContext?.isHost
    this.width = canvas.width || 960
    this.height = canvas.height || 540
    this.running = false
    this.raf = null
    this.lastTime = 0
    this.accumulator = 0
    this.mySeat = this.isHost ? 0 : null
    this.peerSeats = new Map()
    this.typed = ''
    this.state = this._emptyState()
    this._startRect = null
    this._botTurnSeat = null
    this._botTurnAt = 0
    this._onKeyDown = this._onKeyDown.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._loop = this._loop.bind(this)
    if (this.isHost) {
      this.state.players[0].active = true
      this.state.players[0].isBot = false
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    window.addEventListener('keydown', this._onKeyDown)
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = null
    this.canvas.removeEventListener('pointerdown', this._onPointerDown)
    window.removeEventListener('keydown', this._onKeyDown)
  }

  getMatchSnapshot() {
    return snapshotFromState(this, {
      peerSeats: Array.from(this.peerSeats.entries()),
      typed: this.typed,
      _botTurnSeat: this._botTurnSeat,
      _botTurnAt: this._botTurnAt,
    })
  }

  applyMatchSnapshot(snap) {
    if (!applyStateSnapshot(this, snap)) return false
    if (this.isHost) this.peerSeats = new Map()
    if (typeof snap.typed === 'string') this.typed = snap.typed
    if (snap._botTurnSeat !== undefined) this._botTurnSeat = snap._botTurnSeat
    if (typeof snap._botTurnAt === 'number') this._botTurnAt = snap._botTurnAt
    return true
  }

  onPeerJoin(peerId) {
    if (!this.isHost) return
    const inLobby = this.state.phase === 'lobby'
    let seat = inLobby
      ? findLobbySeat(this.state.players)
      : findReclaimSeat(this.state.players, this.peerSeats)
    if (seat < 0) return
    if (inLobby) this.state.players[seat] = { active: true, isBot: false, lives: 3 }
    this.peerSeats.set(peerId, seat)
    this.p2p?.sendTo(peerId, { type: 'welcome', seat, yourPeerId: peerId })
    this._broadcast()
  }

  onPeerLeave(peerId) {
    if (!this.isHost) return
    const seat = this.peerSeats.get(peerId)
    if (seat == null) return
    this.state.players[seat] = { active: false, isBot: false, lives: 0 }
    this.peerSeats.delete(peerId)
    if (this.state.phase === 'lobby') {
      this._broadcast()
      return
    }
    if (this._humanSeats().length < 1) {
      this._returnToLobby('Waiting for players…')
      return
    }
    if (this.state.turn === seat) this._startTurn(this._nextAliveSeat(seat))
    this._checkWinner()
  }

  onPeerAction(data, peerId) {
    if (!data || typeof data !== 'object') return
    if (data.type === 'welcome' && !this.isHost) {
      this.mySeat = data.seat
      return
    }
    if (data.type === 'sync' && !this.isHost) {
      this.state = data.state
      if (this.state.turn !== this.mySeat) this.typed = ''
      return
    }
    if (!this.isHost || data.type !== 'submit') return
    const seat = this.peerSeats.get(peerId)
    if (seat != null) this._submit(seat, data.word)
  }

  _emptyState() {
    return {
      players: Array.from({ length: SEAT_COUNT }, () => ({ active: false, isBot: false, lives: 3 })),
      turn: 0,
      syllable: 'TIC',
      timer: TURN_MS,
      phase: 'lobby',
      message: 'Share the room link, then press START when ready.',
      pause: 0,
      winner: null,
      lastWord: '',
      lobbyReturnMs: 0,
    }
  }

  _humanSeats() {
    return this.state.players
      .map((player, seat) => (player.active && !player.isBot ? seat : -1))
      .filter((seat) => seat >= 0)
  }

  _lobbySeats() {
    return this.state.players.map((p) => ({ active: p.active, isBot: !!p.isBot }))
  }

  _returnToLobby(message = 'Share the room link, then press START when ready.') {
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      const p = this.state.players[seat]
      if (p.isBot) this.state.players[seat] = { active: false, isBot: false, lives: 3 }
      else if (p.active) p.lives = 3
    }
    this.state.phase = 'lobby'
    this.state.winner = null
    this.state.message = message
    this.state.lobbyReturnMs = 0
    this._broadcast()
  }

  /**
   * Solo-vs-AI entry point called by the arcade shell right after start().
   * Skips the lobby wait entirely: every empty seat becomes a local bot and
   * the match begins immediately with zero network involvement.
   */
  startSoloMatch() {
    this._hostLobbyStart()
  }

  _hostLobbyStart() {
    if (!this.isHost || this.state.phase !== 'lobby') return
    fillBots(this.state.players, SEAT_COUNT, (seat) => {
      this.state.players[seat] = { active: true, isBot: true, lives: 3 }
    })
    this._startTurn(0)
  }

  _pickBotWord(syllable) {
    const syl = syllable.toLowerCase()
    const matches = WORDS.filter((w) => w.includes(syl))
    if (!matches.length) return 'action'
    return matches[Math.floor(botNoise(0, performance.now(), 81) * matches.length)]
  }

  _tickBotTurn() {
    const now = performance.now()
    if (this.state.phase !== 'playing') {
      this._botTurnSeat = null
      return
    }
    const seat = this.state.turn
    const player = this.state.players[seat]
    if (!player?.isBot || !player.active || player.lives <= 0) return
    if (this._botTurnSeat !== seat) {
      this._botTurnSeat = seat
      this._botTurnAt = now + 700 + botNoise(seat, now, 82) * 2500
    }
    if (now < this._botTurnAt) return
    this._submit(seat, this._pickBotWord(this.state.syllable))
    this._botTurnSeat = null
  }

  _onPointerDown(event) {
    const point = canvasPoint(this.canvas, event, this.width, this.height)
    if (this.isHost && this.state.phase === 'lobby' && this._startRect && hit(point, this._startRect)) {
      this._hostLobbyStart()
    }
  }

  _aliveSeats() {
    return this.state.players
      .map((player, seat) => player.active && player.lives > 0 ? seat : -1)
      .filter((seat) => seat >= 0)
  }

  _nextAliveSeat(from) {
    for (let step = 1; step <= 5; step++) {
      const seat = (from + step) % 5
      if (this.state.players[seat]?.active && this.state.players[seat].lives > 0) return seat
    }
    return from
  }

  _pickSyllable() {
    return ROOTS[Math.floor(Math.random() * ROOTS.length)].toUpperCase()
  }

  _startTurn(seat) {
    const alive = this._aliveSeats()
    if (alive.length <= 1) {
      this.state.phase = 'gameover'
      this.state.winner = alive[0] ?? null
      this.state.message = alive.length ? `${NAMES[alive[0]]} survives the bomb!` : 'Nobody survives.'
      this._broadcast()
      return
    }
    this.state.phase = 'playing'
    this.state.turn = this.state.players[seat]?.lives > 0 ? seat : alive[0]
    this.state.syllable = this._pickSyllable()
    this.state.timer = TURN_MS
    this.state.pause = 0
    this.state.message = `${NAMES[this.state.turn]}: type a word containing ${this.state.syllable}.`
    this._broadcast()
  }

  _submit(seat, rawWord) {
    if (this.state.phase !== 'playing' || seat !== this.state.turn) return
    const word = String(rawWord || '').toLowerCase().trim()
    const syllable = this.state.syllable.toLowerCase()
    if (!DICTIONARY.has(word)) {
      this.state.message = `"${word || '…'}" is not in the table dictionary.`
      this._broadcast()
      return
    }
    if (!word.includes(syllable)) {
      this.state.message = `"${word}" does not contain ${this.state.syllable}.`
      this._broadcast()
      return
    }
    this.state.lastWord = word.toUpperCase()
    const next = this._nextAliveSeat(seat)
    this.state.message = `${NAMES[seat]} passed with ${word.toUpperCase()}!`
    this.state.phase = 'pause'
    this.state.pause = ROUND_PAUSE_MS
    this.state.turn = next
    this._broadcast()
  }

  _explode() {
    const player = this.state.players[this.state.turn]
    player.lives = Math.max(0, player.lives - 1)
    this.state.lastWord = ''
    this.state.message = `BOOM! ${NAMES[this.state.turn]} loses a life.`
    this.state.phase = 'pause'
    this.state.pause = ROUND_PAUSE_MS
    this.state.turn = this._nextAliveSeat(this.state.turn)
  }

  _onKeyDown(event) {
    if (this.mySeat == null || this.state.turn !== this.mySeat || this.state.phase !== 'playing') return
    if (event.key === 'Enter') {
      event.preventDefault()
      const word = this.typed
      this.typed = ''
      if (this.isHost) this._submit(0, word)
      else this.p2p?.broadcast({ type: 'submit', word })
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      this.typed = this.typed.slice(0, -1)
      return
    }
    if (/^[a-zA-Z]$/.test(event.key) && this.typed.length < 18) {
      event.preventDefault()
      this.typed += event.key.toUpperCase()
    }
  }

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(50, now - this.lastTime)
    this.lastTime = now
    if (this.isHost) {
      this._tickBotTurn()
      this.accumulator += dt
      while (this.accumulator >= TICK_MS) {
        this.accumulator -= TICK_MS
        if (this.state.phase === 'playing') {
          this.state.timer -= TICK_MS
          if (this.state.timer <= 0) this._explode()
        } else if (this.state.phase === 'pause') {
          this.state.pause -= TICK_MS
          if (this.state.pause <= 0) {
            this._checkWinner()
            if (this.state.phase !== 'gameover') this._startTurn(this.state.turn)
          }
        } else if (this.state.phase === 'gameover') {
          this.state.lobbyReturnMs -= TICK_MS
          if (this.state.lobbyReturnMs <= 0) this._returnToLobby()
        }
        this._broadcast()
      }
    }
    this._render()
    this.raf = requestAnimationFrame(this._loop)
  }

  _checkWinner() {
    const alive = this._aliveSeats()
    if (this.state.players.filter((player) => player.active).length > 1 && alive.length <= 1) {
      this.state.phase = 'gameover'
      this.state.winner = alive[0] ?? null
      this.state.message = alive.length ? `${NAMES[alive[0]]} survives the bomb!` : 'Nobody survives.'
      this.state.lobbyReturnMs = 5000
    }
  }

  _broadcast() {
    this.p2p?.broadcast({ type: 'sync', state: this.state })
  }

  _render() {
    const ctx = this.ctx
    const state = this.state
    if (state.phase === 'lobby') {
      this._startRect = drawLobby(ctx, {
        width: this.width,
        height: this.height,
        title: 'Word Bomb',
        seats: this._lobbySeats(),
        capacity: SEAT_COUNT,
        isHost: this.isHost,
        mySeat: this.mySeat,
        message: state.message,
      })
      return
    }
    drawArenaBackdrop(ctx, this.width, this.height, { step: 48 })
    drawNeonText(ctx, 'WORD BOMB', this.width / 2, 42, {
      font: `800 26px ${FONT_UI}`,
      color: THEME.text,
      glow: 16,
    })
    drawNeonText(ctx, state.message, this.width / 2, 68, {
      font: `500 12px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
    })
    this._drawBomb(ctx)
    this._drawPlayers(ctx)
    this._drawInput(ctx)
  }

  _drawBomb(ctx) {
    const state = this.state
    const cx = this.width / 2
    const cy = 245
    const ratio = clamp(state.timer / TURN_MS, 0, 1)
    const hot = ratio < 0.3
    const pulse = 1 + (1 - ratio) * 0.12 * Math.sin(performance.now() / 90)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(pulse, pulse)
    ctx.fillStyle = withAlpha(THEME.bgRaised, 0.95)
    ctx.strokeStyle = hot ? THEME.magenta : THEME.lime
    ctx.lineWidth = 4
    ctx.shadowColor = ctx.strokeStyle
    ctx.shadowBlur = 22
    ctx.beginPath()
    ctx.arc(0, 0, 88, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.shadowBlur = 0
    // fuse ring
    ctx.strokeStyle = withAlpha(hot ? THEME.magenta : THEME.cyan, 0.7)
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.arc(0, 0, 98, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2)
    ctx.stroke()
    drawNeonText(ctx, state.syllable || '—', 0, 8, {
      font: `800 44px ${FONT_MONO}`,
      color: THEME.text,
      glow: 14,
    })
    drawNeonText(ctx, `${Math.ceil(Math.max(0, state.timer) / 1000)}s`, 0, 48, {
      font: `700 16px ${FONT_MONO}`,
      color: hot ? THEME.magenta : THEME.textDim,
      glow: hot ? 10 : 0,
    })
    ctx.restore()
  }

  _drawPlayers(ctx) {
    const positions = [[150, 150], [810, 150], [825, 400], [480, 460], [135, 400]]
    this.state.players.forEach((player, seat) => {
      if (!player.active) return
      const [x, y] = positions[seat]
      const current = this.state.turn === seat && this.state.phase === 'playing'
      drawGlassPanel(ctx, {
        x: x - 78,
        y: y - 34,
        w: 156,
        h: 68,
        accent: current ? '#ffffff' : COLORS[seat],
        glow: current ? 18 : 8,
      })
      ctx.globalAlpha = player.lives ? 1 : 0.35
      drawNeonText(ctx, `${NAMES[seat]}${seat === this.mySeat ? ' YOU' : ''}`, x, y - 8, {
        font: `700 13px ${FONT_MONO}`,
        color: COLORS[seat],
        glow: 6,
      })
      drawNeonText(ctx, player.lives ? `HP ${'●'.repeat(player.lives)}${'○'.repeat(3 - player.lives)}` : 'OUT', x, y + 16, {
        font: `600 12px ${FONT_MONO}`,
        color: player.lives ? THEME.text : THEME.textDim,
        glow: 0,
      })
      ctx.globalAlpha = 1
    })
  }

  _drawInput(ctx) {
    const mine = this.mySeat != null && this.state.turn === this.mySeat && this.state.phase === 'playing'
    drawGlassPanel(ctx, {
      x: 270,
      y: 338,
      w: 420,
      h: 52,
      accent: mine ? THEME.cyan : THEME.textFaint,
      glow: mine ? 16 : 6,
    })
    const text = mine
      ? (this.typed || 'TYPE WORD · ENTER')
      : (this.state.lastWord ? `LAST  ${this.state.lastWord}` : 'WAIT YOUR TURN')
    drawNeonText(ctx, text, this.width / 2, 366, {
      font: `600 15px ${FONT_MONO}`,
      color: mine ? THEME.text : THEME.textDim,
      glow: 0,
    })
  }
}
