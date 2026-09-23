// src/games/solo/tetris.js
//
// Standard-rules Tetris: 10x20 matrix, 7-bag randomizer, SRS-style rotation
// with wall kicks, hold piece, ghost piece, hard/soft drop, neon line-clear
// flashes, and drop-speed scaling every 10 lines. All state lives in RAM —
// no localStorage, no cookies, nothing survives a refresh.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//
// This is a solo game, so `p2pContext` is always null and the peer hooks
// are no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'

const COLS = 10
const ROWS = 20
const BLOCK = 24
const BOARD_W = COLS * BLOCK
const BOARD_H = ROWS * BLOCK

const BASE_DROP_MS = 800
const MIN_DROP_MS = 100
const DROP_STEP_PER_LEVEL = 60
const LINES_PER_LEVEL = 10
const SOFT_DROP_MS = 40
const LOCK_DELAY_MS = 500
const MAX_LOCK_RESETS = 15
const DAS_DELAY_MS = 170
const DAS_REPEAT_MS = 50
const LINE_FLASH_MS = 320

const COLORS = {
  background: '#0b0f19',
  boardBg: 'rgba(255, 255, 255, 0.02)',
  boardBorder: '#00e5ff',
  grid: 'rgba(255, 255, 255, 0.04)',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  accent: '#00e5ff',
  danger: '#ff007f',
  ghost: 'rgba(255, 255, 255, 0.18)',
}

// Standard 7 tetrominoes, one neon color each.
const PIECE_COLORS = {
  I: '#00e5ff',
  O: '#fffb00',
  T: '#ff007f',
  S: '#39ff14',
  Z: '#ff3131',
  J: '#3b82f6',
  L: '#ff9100',
}

// Cell offsets per rotation state (0, R, 2, L) for every piece, defined in
// a local bounding-box grid (4x4 for I/O, 3x3 for J/L/S/T/Z).
const SHAPES = {
  I: {
    size: 4,
    0: [[0, 1], [1, 1], [2, 1], [3, 1]],
    R: [[2, 0], [2, 1], [2, 2], [2, 3]],
    2: [[0, 2], [1, 2], [2, 2], [3, 2]],
    L: [[1, 0], [1, 1], [1, 2], [1, 3]],
  },
  O: {
    size: 4,
    0: [[1, 0], [2, 0], [1, 1], [2, 1]],
    R: [[1, 0], [2, 0], [1, 1], [2, 1]],
    2: [[1, 0], [2, 0], [1, 1], [2, 1]],
    L: [[1, 0], [2, 0], [1, 1], [2, 1]],
  },
  T: {
    size: 3,
    0: [[1, 0], [0, 1], [1, 1], [2, 1]],
    R: [[1, 0], [1, 1], [2, 1], [1, 2]],
    2: [[0, 1], [1, 1], [2, 1], [1, 2]],
    L: [[1, 0], [0, 1], [1, 1], [1, 2]],
  },
  S: {
    size: 3,
    0: [[1, 0], [2, 0], [0, 1], [1, 1]],
    R: [[1, 0], [1, 1], [2, 1], [2, 2]],
    2: [[1, 1], [2, 1], [0, 2], [1, 2]],
    L: [[0, 0], [0, 1], [1, 1], [1, 2]],
  },
  Z: {
    size: 3,
    0: [[0, 0], [1, 0], [1, 1], [2, 1]],
    R: [[2, 0], [1, 1], [2, 1], [1, 2]],
    2: [[0, 1], [1, 1], [1, 2], [2, 2]],
    L: [[1, 0], [0, 1], [1, 1], [0, 2]],
  },
  J: {
    size: 3,
    0: [[0, 0], [0, 1], [1, 1], [2, 1]],
    R: [[1, 0], [2, 0], [1, 1], [1, 2]],
    2: [[0, 1], [1, 1], [2, 1], [2, 2]],
    L: [[1, 0], [1, 1], [0, 2], [1, 2]],
  },
  L: {
    size: 3,
    0: [[2, 0], [0, 1], [1, 1], [2, 1]],
    R: [[1, 0], [1, 1], [1, 2], [2, 2]],
    2: [[0, 1], [1, 1], [2, 1], [0, 2]],
    L: [[0, 0], [1, 0], [1, 1], [1, 2]],
  },
}

const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']
const ROTATION_ORDER = ['0', 'R', '2', 'L']

// Standard SRS wall-kick offsets for JLSTZ pieces, keyed by
// "<fromState>>><toState>". Values are [dx, dy] in board space
// (positive y = down, i.e. already converted from the guideline's
// upward-positive convention).
const JLSTZ_KICKS = {
  '0>R': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  'R>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  'R>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>R': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>L': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  'L>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  'L>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>L': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
}

const I_KICKS = {
  '0>R': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  'R>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  'R>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>R': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>L': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  'L>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  'L>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>L': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
}

function createEmptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null))
}

/** Fisher-Yates shuffle, returns a new array. */
function shuffled(array) {
  const copy = array.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export default class TetrisGame {
  /**
   * @param {HTMLCanvasElement} canvas - Shared 960x540 arcade canvas.
   * @param {null} p2pContext - Always null for solo games.
   */
  constructor(canvas, p2pContext) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p2pContext = p2pContext

    this.width = canvas.width || 960
    this.height = canvas.height || 540

    this.boardX = Math.round((this.width - BOARD_W) / 2)
    this.boardY = Math.round((this.height - BOARD_H) / 2)

    this.running = false
    this.rafId = null
    this.lastTime = 0

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._loop = this._loop.bind(this)

    this._resetState()
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
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
  }

  getMatchSnapshot() {
    return {
      kind: 'solo',
      board: cloneState(this.board),
      bag: cloneState(this.bag),
      nextQueue: cloneState(this.nextQueue),
      score: this.score,
      lines: this.lines,
      level: this.level,
      dropIntervalMs: this.dropIntervalMs,
      holdType: this.holdType,
      holdUsed: this.holdUsed,
      dropTimer: this.dropTimer,
      lockTimer: this.lockTimer,
      lockResets: this.lockResets,
      isGrounded: this.isGrounded,
      softDropHeld: this.softDropHeld,
      das: this.das ? cloneState(this.das) : null,
      clearingRows: cloneState(this.clearingRows),
      clearTimer: this.clearTimer,
      gameOver: this.gameOver,
      active: this.active ? cloneState(this.active) : null,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false
    if (Array.isArray(snap.board)) this.board = cloneState(snap.board)
    if (Array.isArray(snap.bag)) this.bag = cloneState(snap.bag)
    if (Array.isArray(snap.nextQueue)) this.nextQueue = cloneState(snap.nextQueue)
    if (typeof snap.score === 'number') this.score = snap.score
    if (typeof snap.lines === 'number') this.lines = snap.lines
    if (typeof snap.level === 'number') this.level = snap.level
    if (typeof snap.dropIntervalMs === 'number') this.dropIntervalMs = snap.dropIntervalMs
    if (snap.holdType !== undefined) this.holdType = snap.holdType
    if (typeof snap.holdUsed === 'boolean') this.holdUsed = snap.holdUsed
    if (typeof snap.dropTimer === 'number') this.dropTimer = snap.dropTimer
    if (typeof snap.lockTimer === 'number') this.lockTimer = snap.lockTimer
    if (typeof snap.lockResets === 'number') this.lockResets = snap.lockResets
    if (typeof snap.isGrounded === 'boolean') this.isGrounded = snap.isGrounded
    if (typeof snap.softDropHeld === 'boolean') this.softDropHeld = snap.softDropHeld
    if (snap.das && typeof snap.das === 'object') this.das = cloneState(snap.das)
    else if (snap.das === null) this.das = null
    if (Array.isArray(snap.clearingRows)) this.clearingRows = cloneState(snap.clearingRows)
    if (typeof snap.clearTimer === 'number') this.clearTimer = snap.clearTimer
    if (typeof snap.gameOver === 'boolean') this.gameOver = snap.gameOver
    if (snap.active && typeof snap.active === 'object') this.active = cloneState(snap.active)
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
    this.board = createEmptyBoard()
    this.bag = []
    this.nextQueue = []
    this._refillQueue()

    this.score = 0
    this.lines = 0
    this.level = 0
    this.dropIntervalMs = BASE_DROP_MS

    this.holdType = null
    this.holdUsed = false

    this.dropTimer = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.isGrounded = false

    this.softDropHeld = false
    this.das = null // { dir: -1|1, timer, stage }

    this.clearingRows = []
    this.clearTimer = 0

    this.gameOver = false

    this._spawnPiece()
  }

  _refillQueue() {
    while (this.nextQueue.length < 5) {
      if (!this.bag.length) this.bag = shuffled(PIECE_TYPES)
      this.nextQueue.push(this.bag.pop())
    }
  }

  _spawnPiece() {
    this._refillQueue()
    const type = this.nextQueue.shift()
    this._refillQueue()

    const size = SHAPES[type].size
    const startX = Math.floor((COLS - size) / 2)
    const startY = type === 'I' ? -1 : -2

    this.active = { type, rotation: '0', x: startX, y: startY }
    this.holdUsed = false
    this.dropTimer = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.isGrounded = false

    if (this._collides(this.active, 0, 0)) {
      this.gameOver = true
    }
  }

  // --------------------------------------------------------------------
  // Geometry / collision helpers
  // --------------------------------------------------------------------

  _cellsFor(piece) {
    return SHAPES[piece.type][piece.rotation].map(([cx, cy]) => ({
      x: piece.x + cx,
      y: piece.y + cy,
    }))
  }

  _collides(piece, dx, dy, rotation = piece.rotation) {
    const test = { ...piece, x: piece.x + dx, y: piece.y + dy, rotation }
    return this._cellsFor(test).some(({ x, y }) => {
      if (x < 0 || x >= COLS || y >= ROWS) return true
      if (y < 0) return false // above the visible board is allowed
      return this.board[y][x] !== null
    })
  }

  _tryMove(dx, dy) {
    if (this._collides(this.active, dx, dy)) return false
    this.active.x += dx
    this.active.y += dy
    if (this.isGrounded) this._registerLockReset()
    return true
  }

  _registerLockReset() {
    if (this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0
      this.lockResets += 1
    }
  }

  _rotate(direction) {
    const piece = this.active
    if (piece.type === 'O') return // O never changes orientation

    const currentIndex = ROTATION_ORDER.indexOf(piece.rotation)
    const nextIndex = (currentIndex + (direction > 0 ? 1 : 3)) % 4
    const nextRotation = ROTATION_ORDER[nextIndex]
    const kickTable = piece.type === 'I' ? I_KICKS : JLSTZ_KICKS
    const key = `${piece.rotation}>${nextRotation}`
    const kicks = kickTable[key] || [[0, 0]]

    for (const [dx, dy] of kicks) {
      if (!this._collides(piece, dx, dy, nextRotation)) {
        piece.rotation = nextRotation
        piece.x += dx
        piece.y += dy
        if (this.isGrounded) this._registerLockReset()
        return true
      }
    }
    return false
  }

  _hardDrop() {
    let distance = 0
    while (!this._collides(this.active, 0, 1)) {
      this.active.y += 1
      distance += 1
    }
    this.score += distance * 2
    this._lockPiece()
  }

  _holdPiece() {
    if (this.holdUsed) return
    this.holdUsed = true

    const currentType = this.active.type
    if (this.holdType === null) {
      this.holdType = currentType
      this._spawnPiece()
      this.holdUsed = true
    } else {
      const swapType = this.holdType
      this.holdType = currentType
      const size = SHAPES[swapType].size
      this.active = {
        type: swapType,
        rotation: '0',
        x: Math.floor((COLS - size) / 2),
        y: swapType === 'I' ? -1 : -2,
      }
      this.dropTimer = 0
      this.lockTimer = 0
      this.lockResets = 0
      this.isGrounded = false
      if (this._collides(this.active, 0, 0)) this.gameOver = true
    }
  }

  _ghostY() {
    let ghostY = this.active.y
    while (!this._collides({ ...this.active, y: ghostY }, 0, 1)) {
      ghostY += 1
    }
    return ghostY
  }

  _lockPiece() {
    const color = PIECE_COLORS[this.active.type]
    for (const { x, y } of this._cellsFor(this.active)) {
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
        this.board[y][x] = color
      }
    }

    const fullRows = []
    for (let row = 0; row < ROWS; row++) {
      if (this.board[row].every((cell) => cell !== null)) fullRows.push(row)
    }

    if (fullRows.length) {
      this.clearingRows = fullRows
      this.clearTimer = LINE_FLASH_MS
    } else {
      this._spawnPiece()
    }
  }

  _finishLineClear() {
    const rowsToClear = new Set(this.clearingRows)
    this.board = this.board.filter((_, row) => !rowsToClear.has(row))
    while (this.board.length < ROWS) {
      this.board.unshift(Array(COLS).fill(null))
    }

    const count = this.clearingRows.length
    const points = [0, 100, 300, 500, 800][count] || 800
    this.score += points * (this.level + 1)
    this.lines += count
    this.level = Math.floor(this.lines / LINES_PER_LEVEL)
    this.dropIntervalMs = Math.max(
      MIN_DROP_MS,
      BASE_DROP_MS - this.level * DROP_STEP_PER_LEVEL
    )

    this.clearingRows = []
    this.clearTimer = 0
    this._spawnPiece()
  }

  // --------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------

  _onKeyDown(event) {
    const key = event.key

    if (this.gameOver) {
      if (key === 'r' || key === 'R') this._resetState()
      return
    }

    const handledKeys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowDown',
      'ArrowUp',
      ' ',
      'z',
      'Z',
      'c',
      'C',
    ]
    if (handledKeys.includes(key)) event.preventDefault()

    if (this.clearingRows.length) return // frozen during line-clear flash

    if (event.repeat) return // we implement our own DAS/repeat below

    if (key === 'ArrowLeft') {
      this._tryMove(-1, 0)
      this.das = { dir: -1, timer: 0, stage: 0 }
    } else if (key === 'ArrowRight') {
      this._tryMove(1, 0)
      this.das = { dir: 1, timer: 0, stage: 0 }
    } else if (key === 'ArrowDown') {
      this.softDropHeld = true
    } else if (key === 'ArrowUp') {
      this._rotate(1)
    } else if (key === 'z' || key === 'Z') {
      this._rotate(-1)
    } else if (key === ' ') {
      this._hardDrop()
    } else if (key === 'c' || key === 'C') {
      this._holdPiece()
    }
  }

  _onKeyUp(event) {
    const key = event.key
    if (key === 'ArrowLeft' && this.das && this.das.dir === -1) this.das = null
    if (key === 'ArrowRight' && this.das && this.das.dir === 1) this.das = null
    if (key === 'ArrowDown') this.softDropHeld = false
  }

  _updateDas(dt) {
    if (!this.das || this.gameOver || this.clearingRows.length) return
    this.das.timer += dt
    if (this.das.stage === 0) {
      if (this.das.timer >= DAS_DELAY_MS) {
        this._tryMove(this.das.dir, 0)
        this.das.timer = 0
        this.das.stage = 1
      }
    } else if (this.das.timer >= DAS_REPEAT_MS) {
      this._tryMove(this.das.dir, 0)
      this.das.timer = 0
    }
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(now - this.lastTime, 100)
    this.lastTime = now

    if (this.gameOver) {
      this._render()
      this.rafId = requestAnimationFrame(this._loop)
      return
    }

    if (this.clearingRows.length) {
      this.clearTimer -= dt
      if (this.clearTimer <= 0) this._finishLineClear()
      this._render()
      this.rafId = requestAnimationFrame(this._loop)
      return
    }

    this._updateDas(dt)

    const effectiveInterval = this.softDropHeld
      ? Math.min(this.dropIntervalMs, SOFT_DROP_MS)
      : this.dropIntervalMs

    this.dropTimer += dt
    if (this.dropTimer >= effectiveInterval) {
      this.dropTimer = 0
      if (this._tryMove(0, 1)) {
        if (this.softDropHeld) this.score += 1
        this.isGrounded = false
        this.lockTimer = 0
      } else {
        this.isGrounded = true
      }
    }

    if (this.isGrounded && !this.gameOver) {
      this.lockTimer += dt
      if (this.lockTimer >= LOCK_DELAY_MS) {
        this._lockPiece()
      }
    }

    this._render()
    this.rafId = requestAnimationFrame(this._loop)
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, this.width, this.height)

    this._drawBoardFrame(ctx)
    this._drawLockedBlocks(ctx)

    if (this.clearingRows.length) {
      this._drawClearFlash(ctx)
    } else if (!this.gameOver) {
      this._drawGhost(ctx)
      this._drawActivePiece(ctx)
    }

    this._drawSidePanels(ctx)

    if (this.gameOver) {
      this._drawCenterOverlay(ctx, 'GAME OVER', `Score: ${this.score}   —   Press R to Restart`)
    }
  }

  _drawBoardFrame(ctx) {
    ctx.fillStyle = COLORS.boardBg
    ctx.fillRect(this.boardX, this.boardY, BOARD_W, BOARD_H)

    ctx.strokeStyle = COLORS.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let c = 0; c <= COLS; c++) {
      ctx.moveTo(this.boardX + c * BLOCK + 0.5, this.boardY)
      ctx.lineTo(this.boardX + c * BLOCK + 0.5, this.boardY + BOARD_H)
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.moveTo(this.boardX, this.boardY + r * BLOCK + 0.5)
      ctx.lineTo(this.boardX + BOARD_W, this.boardY + r * BLOCK + 0.5)
    }
    ctx.stroke()

    ctx.save()
    ctx.shadowColor = 'rgba(0, 229, 255, 0.5)'
    ctx.shadowBlur = 14
    ctx.strokeStyle = COLORS.boardBorder
    ctx.lineWidth = 2
    ctx.strokeRect(this.boardX - 1, this.boardY - 1, BOARD_W + 2, BOARD_H + 2)
    ctx.restore()
  }

  _drawCell(ctx, col, row, color, alpha = 1) {
    const x = this.boardX + col * BLOCK
    const y = this.boardY + row * BLOCK
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(x + 1, y + 1, BLOCK - 2, BLOCK - 2)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 1.5, y + 1.5, BLOCK - 3, BLOCK - 3)
    ctx.globalAlpha = 1
  }

  _drawLockedBlocks(ctx) {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const color = this.board[row][col]
        if (color) this._drawCell(ctx, col, row, color)
      }
    }
  }

  _drawGhost(ctx) {
    const ghostY = this._ghostY()
    if (ghostY === this.active.y) return
    for (const [cx, cy] of SHAPES[this.active.type][this.active.rotation]) {
      const row = ghostY + cy
      const col = this.active.x + cx
      if (row < 0) continue
      const x = this.boardX + col * BLOCK
      const y = this.boardY + row * BLOCK
      ctx.strokeStyle = COLORS.ghost
      ctx.lineWidth = 2
      ctx.strokeRect(x + 2, y + 2, BLOCK - 4, BLOCK - 4)
    }
  }

  _drawActivePiece(ctx) {
    const color = PIECE_COLORS[this.active.type]
    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = 8
    for (const { x, y } of this._cellsFor(this.active)) {
      if (y < 0) continue
      this._drawCell(ctx, x, y, color)
    }
    ctx.restore()
  }

  _drawClearFlash(ctx) {
    const progress = 1 - Math.max(this.clearTimer, 0) / LINE_FLASH_MS
    const flashAlpha = 0.5 + 0.5 * Math.sin(progress * Math.PI * 6)
    for (const row of this.clearingRows) {
      for (let col = 0; col < COLS; col++) {
        this._drawCell(ctx, col, row, this.board[row][col] || '#ffffff')
      }
      ctx.globalAlpha = Math.max(flashAlpha, 0.15)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(this.boardX, this.boardY + row * BLOCK, BOARD_W, BLOCK)
      ctx.globalAlpha = 1
    }
  }

  _drawSidePanels(ctx) {
    const leftCenter = this.boardX / 2
    const rightCenter = this.boardX + BOARD_W + (this.width - (this.boardX + BOARD_W)) / 2

    ctx.textAlign = 'center'

    // Left panel: score + lines.
    ctx.fillStyle = COLORS.textDim
    ctx.font = 'bold 13px monospace'
    ctx.fillText('SCORE', leftCenter, this.boardY + 20)
    ctx.fillStyle = COLORS.accent
    ctx.font = 'bold 22px monospace'
    ctx.fillText(String(this.score), leftCenter, this.boardY + 44)

    ctx.fillStyle = COLORS.textDim
    ctx.font = 'bold 13px monospace'
    ctx.fillText('LINES', leftCenter, this.boardY + 96)
    ctx.fillStyle = COLORS.text
    ctx.font = 'bold 20px monospace'
    ctx.fillText(String(this.lines), leftCenter, this.boardY + 118)

    ctx.fillStyle = COLORS.textDim
    ctx.font = 'bold 13px monospace'
    ctx.fillText('LEVEL', leftCenter, this.boardY + 168)
    ctx.fillStyle = COLORS.text
    ctx.font = 'bold 20px monospace'
    ctx.fillText(String(this.level), leftCenter, this.boardY + 190)

    // Left panel: hold piece.
    ctx.fillStyle = COLORS.textDim
    ctx.font = 'bold 13px monospace'
    ctx.fillText('HOLD', leftCenter, this.boardY + 250)
    this._drawMiniPiece(ctx, this.holdType, leftCenter, this.boardY + 300, this.holdUsed)

    // Right panel: next piece queue.
    ctx.fillStyle = COLORS.textDim
    ctx.font = 'bold 13px monospace'
    ctx.fillText('NEXT', rightCenter, this.boardY + 20)

    this.nextQueue.slice(0, 3).forEach((type, i) => {
      this._drawMiniPiece(ctx, type, rightCenter, this.boardY + 70 + i * 90, false)
    })

    ctx.textAlign = 'left'
  }

  _drawMiniPiece(ctx, type, centerX, centerY, dimmed) {
    const boxSize = 70
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.strokeRect(centerX - boxSize / 2, centerY - boxSize / 2, boxSize, boxSize)

    if (!type) {
      ctx.restore()
      return
    }

    const cells = SHAPES[type]['0']
    const size = SHAPES[type].size
    const miniBlock = 14
    const offsetX = centerX - (size * miniBlock) / 2
    const offsetY = centerY - (size * miniBlock) / 2

    ctx.globalAlpha = dimmed ? 0.35 : 1
    ctx.fillStyle = PIECE_COLORS[type]
    for (const [cx, cy] of cells) {
      ctx.fillRect(
        offsetX + cx * miniBlock + 1,
        offsetY + cy * miniBlock + 1,
        miniBlock - 2,
        miniBlock - 2
      )
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }

  _drawCenterOverlay(ctx, title, subtitle) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.8)'
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.font = 'bold 42px monospace'
    ctx.fillStyle = COLORS.danger
    ctx.shadowColor = COLORS.danger
    ctx.shadowBlur = 20
    ctx.fillText(title, this.width / 2, this.height / 2 - 16)

    ctx.shadowBlur = 0
    ctx.font = '16px monospace'
    ctx.fillStyle = COLORS.text
    ctx.fillText(subtitle, this.width / 2, this.height / 2 + 26)

    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
}
