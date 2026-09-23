// src/games/solo/minesweeper.js
//
// Classic Minesweeper: procedural 16x16 grid, 40 mines, recursive flood-fill
// reveal, flag placement, mine counter, timer, and a victory/defeat banner.
// Mines are placed lazily on the first click (excluding that cell and its
// neighbors) so the opening move is always safe. All state lives in RAM —
// no localStorage, no cookies, nothing survives a refresh.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//
// This is a solo game, so `p2pContext` is always null and the peer hooks
// are no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'

const GRID_SIZE = 16
const MINE_COUNT = 40
const CELL_SIZE = 28
const BOARD_PX = GRID_SIZE * CELL_SIZE

const COLORS = {
  background: '#0b0f19',
  boardBorder: '#00e5ff',
  hidden: '#182140',
  hiddenHover: '#202b4d',
  revealed: '#0f1526',
  cellBorder: 'rgba(255, 255, 255, 0.06)',
  flag: '#ff007f',
  mine: '#ff3131',
  mineExploded: '#ff007f',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  accent: '#00e5ff',
  win: '#39ff14',
}

const NUMBER_COLORS = [
  null,
  '#00e5ff', // 1
  '#39ff14', // 2
  '#ff007f', // 3
  '#b98bff', // 4
  '#ff9100', // 5
  '#2dd4bf', // 6
  '#ffffff', // 7
  '#9ca3af', // 8
]

const NEIGHBOR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]

export default class MinesweeperGame {
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

    this.boardX = Math.round((this.width - BOARD_PX) / 2)
    this.boardY = Math.round((this.height - BOARD_PX) / 2)

    this.running = false
    this.rafId = null
    this.lastTime = 0

    this.hoverCell = null

    this._onMouseDown = this._onMouseDown.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
    this._onMouseLeave = this._onMouseLeave.bind(this)
    this._onContextMenu = this._onContextMenu.bind(this)
    this._onKeyDown = this._onKeyDown.bind(this)
    this._loop = this._loop.bind(this)

    this._resetState()
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    this.canvas.addEventListener('mousedown', this._onMouseDown)
    this.canvas.addEventListener('mousemove', this._onMouseMove)
    this.canvas.addEventListener('mouseleave', this._onMouseLeave)
    this.canvas.addEventListener('contextmenu', this._onContextMenu)
    window.addEventListener('keydown', this._onKeyDown)
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this._loop)
  }

  stop() {
    this.running = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.canvas.removeEventListener('mousedown', this._onMouseDown)
    this.canvas.removeEventListener('mousemove', this._onMouseMove)
    this.canvas.removeEventListener('mouseleave', this._onMouseLeave)
    this.canvas.removeEventListener('contextmenu', this._onContextMenu)
    window.removeEventListener('keydown', this._onKeyDown)
  }

  getMatchSnapshot() {
    return {
      kind: 'solo',
      cells: cloneState(this.cells),
      minesPlaced: this.minesPlaced,
      revealedCount: this.revealedCount,
      flagCount: this.flagCount,
      gameOver: this.gameOver,
      won: this.won,
      explodedCell: this.explodedCell ? cloneState(this.explodedCell) : null,
      startTime: this.startTime,
      elapsedMs: this.elapsedMs,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false
    if (Array.isArray(snap.cells)) this.cells = cloneState(snap.cells)
    if (typeof snap.minesPlaced === 'boolean') this.minesPlaced = snap.minesPlaced
    if (typeof snap.revealedCount === 'number') this.revealedCount = snap.revealedCount
    if (typeof snap.flagCount === 'number') this.flagCount = snap.flagCount
    if (typeof snap.gameOver === 'boolean') this.gameOver = snap.gameOver
    if (typeof snap.won === 'boolean') this.won = snap.won
    if (snap.explodedCell && typeof snap.explodedCell === 'object') {
      this.explodedCell = cloneState(snap.explodedCell)
    } else if (snap.explodedCell === null) {
      this.explodedCell = null
    }
    if (snap.startTime !== undefined) this.startTime = snap.startTime
    if (typeof snap.elapsedMs === 'number') this.elapsedMs = snap.elapsedMs
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
    this.cells = Array.from({ length: GRID_SIZE }, () =>
      Array.from({ length: GRID_SIZE }, () => ({
        isMine: false,
        isRevealed: false,
        isFlagged: false,
        adjacent: 0,
      }))
    )

    this.minesPlaced = false
    this.revealedCount = 0
    this.flagCount = 0
    this.gameOver = false
    this.won = false
    this.explodedCell = null

    this.startTime = null
    this.elapsedMs = 0
  }

  _placeMines(safeCol, safeRow) {
    const forbidden = new Set([`${safeCol},${safeRow}`])
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      forbidden.add(`${safeCol + dx},${safeRow + dy}`)
    }

    let placed = 0
    while (placed < MINE_COUNT) {
      const col = Math.floor(Math.random() * GRID_SIZE)
      const row = Math.floor(Math.random() * GRID_SIZE)
      const key = `${col},${row}`
      if (forbidden.has(key) || this.cells[row][col].isMine) continue
      this.cells[row][col].isMine = true
      placed += 1
    }

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        if (this.cells[row][col].isMine) continue
        let count = 0
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          const nCol = col + dx
          const nRow = row + dy
          if (this._inBounds(nCol, nRow) && this.cells[nRow][nCol].isMine) count += 1
        }
        this.cells[row][col].adjacent = count
      }
    }

    this.minesPlaced = true
    this.startTime = performance.now()
  }

  _inBounds(col, row) {
    return col >= 0 && col < GRID_SIZE && row >= 0 && row < GRID_SIZE
  }

  // --------------------------------------------------------------------
  // Game actions
  // --------------------------------------------------------------------

  _revealCell(col, row) {
    if (this.gameOver || this.won) return
    if (!this._inBounds(col, row)) return

    const cell = this.cells[row][col]
    if (cell.isRevealed || cell.isFlagged) return // left-click flag safety

    if (!this.minesPlaced) {
      this._placeMines(col, row)
    }

    if (cell.isMine) {
      this._triggerLoss(col, row)
      return
    }

    this._floodReveal(col, row)
    this._checkVictory()
  }

  _floodReveal(col, row) {
    if (!this._inBounds(col, row)) return
    const cell = this.cells[row][col]
    if (cell.isRevealed || cell.isFlagged || cell.isMine) return

    cell.isRevealed = true
    this.revealedCount += 1

    if (cell.adjacent === 0) {
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        this._floodReveal(col + dx, row + dy)
      }
    }
  }

  _toggleFlag(col, row) {
    if (this.gameOver || this.won) return
    if (!this._inBounds(col, row)) return

    const cell = this.cells[row][col]
    if (cell.isRevealed) return

    cell.isFlagged = !cell.isFlagged
    this.flagCount += cell.isFlagged ? 1 : -1
  }

  _triggerLoss(col, row) {
    this.gameOver = true
    this.explodedCell = { col, row }
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (this.cells[r][c].isMine) this.cells[r][c].isRevealed = true
      }
    }
  }

  _checkVictory() {
    const totalSafeCells = GRID_SIZE * GRID_SIZE - MINE_COUNT
    if (this.revealedCount >= totalSafeCells) {
      this.won = true
      this.gameOver = true
      // Auto-flag every remaining mine for a satisfying finish.
      for (let r = 0; r < GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
          if (this.cells[r][c].isMine) this.cells[r][c].isFlagged = true
        }
      }
      this.flagCount = MINE_COUNT
    }
  }

  // --------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------

  _canvasToCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const scaleY = this.canvas.height / rect.height
    const x = (clientX - rect.left) * scaleX
    const y = (clientY - rect.top) * scaleY

    const col = Math.floor((x - this.boardX) / CELL_SIZE)
    const row = Math.floor((y - this.boardY) / CELL_SIZE)
    return { col, row, x, y }
  }

  _onMouseDown(event) {
    const { col, row } = this._canvasToCell(event.clientX, event.clientY)

    if ((this.gameOver || this.won) && this._isRestartHit(event.clientX, event.clientY)) {
      this._resetState()
      return
    }

    if (!this._inBounds(col, row)) return

    if (event.button === 2) {
      event.preventDefault()
      this._toggleFlag(col, row)
    } else if (event.button === 0) {
      this._revealCell(col, row)
    }
  }

  _onMouseMove(event) {
    const { col, row } = this._canvasToCell(event.clientX, event.clientY)
    this.hoverCell = this._inBounds(col, row) ? { col, row } : null
  }

  _onMouseLeave() {
    this.hoverCell = null
  }

  _onContextMenu(event) {
    event.preventDefault()
  }

  _onKeyDown(event) {
    if ((event.key === 'r' || event.key === 'R') && (this.gameOver || this.won)) {
      this._resetState()
    }
  }

  _isRestartHit(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const scaleY = this.canvas.height / rect.height
    const x = (clientX - rect.left) * scaleX
    const y = (clientY - rect.top) * scaleY
    const btn = this._restartButtonRect()
    return x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h
  }

  _restartButtonRect() {
    return { x: this.width / 2 - 90, y: this.height / 2 + 40, w: 180, h: 42 }
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    this.lastTime = now

    if (this.minesPlaced && !this.gameOver && this.startTime !== null) {
      this.elapsedMs = now - this.startTime
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

    this._drawBoard(ctx)
    this._drawHud(ctx)

    if (this.gameOver) {
      this._drawBanner(ctx, this.won)
    }
  }

  _drawBoard(ctx) {
    ctx.save()
    ctx.shadowColor = 'rgba(0, 229, 255, 0.45)'
    ctx.shadowBlur = 14
    ctx.strokeStyle = COLORS.boardBorder
    ctx.lineWidth = 2
    ctx.strokeRect(this.boardX - 1, this.boardY - 1, BOARD_PX + 2, BOARD_PX + 2)
    ctx.restore()

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        this._drawCell(ctx, col, row)
      }
    }
  }

  _drawCell(ctx, col, row) {
    const cell = this.cells[row][col]
    const x = this.boardX + col * CELL_SIZE
    const y = this.boardY + row * CELL_SIZE
    const isHover =
      this.hoverCell && this.hoverCell.col === col && this.hoverCell.row === row
    const isExploded =
      this.explodedCell && this.explodedCell.col === col && this.explodedCell.row === row

    if (!cell.isRevealed) {
      ctx.fillStyle = isExploded
        ? COLORS.mineExploded
        : isHover && !this.gameOver
          ? COLORS.hiddenHover
          : COLORS.hidden
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2)

      if (cell.isFlagged) {
        this._drawFlag(ctx, x, y)
      } else if (this.gameOver && cell.isMine) {
        this._drawMine(ctx, x, y, isExploded)
      }
    } else {
      ctx.fillStyle = COLORS.revealed
      ctx.fillRect(x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2)

      if (cell.isMine) {
        this._drawMine(ctx, x, y, isExploded)
      } else if (cell.adjacent > 0) {
        ctx.fillStyle = NUMBER_COLORS[cell.adjacent]
        ctx.font = 'bold 15px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(cell.adjacent), x + CELL_SIZE / 2, y + CELL_SIZE / 2 + 1)
      }
    }

    ctx.strokeStyle = COLORS.cellBorder
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1)
  }

  _drawFlag(ctx, x, y) {
    const cx = x + CELL_SIZE / 2
    const cy = y + CELL_SIZE / 2
    ctx.save()
    ctx.shadowColor = COLORS.flag
    ctx.shadowBlur = 6
    ctx.strokeStyle = COLORS.flag
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx - 1, cy + 7)
    ctx.lineTo(cx - 1, cy - 8)
    ctx.stroke()

    ctx.fillStyle = COLORS.flag
    ctx.beginPath()
    ctx.moveTo(cx - 1, cy - 8)
    ctx.lineTo(cx + 8, cy - 4)
    ctx.lineTo(cx - 1, cy)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  _drawMine(ctx, x, y, exploded) {
    const cx = x + CELL_SIZE / 2
    const cy = y + CELL_SIZE / 2
    const r = CELL_SIZE * 0.26

    ctx.save()
    if (exploded) {
      ctx.shadowColor = COLORS.mineExploded
      ctx.shadowBlur = 14
    }
    ctx.strokeStyle = exploded ? COLORS.mineExploded : COLORS.mine
    ctx.lineWidth = 1.5
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(angle) * (r + 4), cy + Math.sin(angle) * (r + 4))
      ctx.stroke()
    }
    ctx.fillStyle = exploded ? COLORS.mineExploded : COLORS.mine
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  _drawHud(ctx) {
    const remainingMines = MINE_COUNT - this.flagCount
    const seconds = Math.floor(this.elapsedMs / 1000)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = 'bold 18px monospace'
    ctx.fillStyle = COLORS.accent
    ctx.fillText(`MINES ${remainingMines}`, this.boardX, this.boardY - 34)

    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.text
    ctx.fillText(
      `TIME ${String(seconds).padStart(3, '0')}s`,
      this.boardX + BOARD_PX,
      this.boardY - 34
    )

    ctx.textAlign = 'left'
  }

  _drawBanner(ctx, won) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.8)'
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const title = won ? 'FIELD CLEARED!' : 'BOOM! GAME OVER'
    const color = won ? COLORS.win : COLORS.mineExploded

    ctx.font = 'bold 42px monospace'
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 22
    ctx.fillText(title, this.width / 2, this.height / 2 - 40)

    ctx.shadowBlur = 0
    ctx.font = '16px monospace'
    ctx.fillStyle = COLORS.text
    const seconds = Math.floor(this.elapsedMs / 1000)
    const subtitle = won
      ? `Cleared in ${seconds}s — Press R to play again`
      : 'Press R to try again'
    ctx.fillText(subtitle, this.width / 2, this.height / 2)

    const btn = this._restartButtonRect()
    ctx.fillStyle = 'rgba(0, 229, 255, 0.12)'
    ctx.strokeStyle = COLORS.accent
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect
      ? ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 8)
      : ctx.rect(btn.x, btn.y, btn.w, btn.h)
    ctx.fill()
    ctx.stroke()

    ctx.font = 'bold 16px monospace'
    ctx.fillStyle = COLORS.accent
    ctx.fillText('RESTART', this.width / 2, btn.y + btn.h / 2 + 1)

    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
}
