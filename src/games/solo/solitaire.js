// src/games/solo/solitaire.js
//
// Classic Klondike Solitaire rendered entirely on canvas: a fresh 52-card
// deck is generated and Fisher-Yates shuffled in RAM every game, dealt into
// 7 tableau columns, 4 foundations, and a draw-1 stock/waste pair. Cards
// are moved via mouse drag-and-drop (with alternating-suit-color /
// descending-rank validation) or double-click-to-foundation. All state
// lives in RAM — no localStorage, no cookies, nothing survives a refresh.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//
// This is a solo game, so `p2pContext` is always null and the peer hooks
// are no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'

const CARD_W = 80
const CARD_H = 112
const COL_GAP = 14
const COL_STEP = CARD_W + COL_GAP
const TABLEAU_TOP = 150
const TABLEAU_START_X_FALLBACK = 158
const FAN_OFFSET = 26
const TOP_ROW_Y = 20

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs']
const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const RED_SUITS = new Set(['hearts', 'diamonds'])
const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }

// --------------------------------------------------------------------------
// Solvability guarantee + Hint engine
//
// Vanilla random Klondike deals are not always winnable, and even when they
// are, a stuck-feeling player has no way to tell a genuinely bad deal from
// a missed move. To fix both problems we:
//   1. Shuffle repeatedly at deal time and use a lightweight full-knowledge
//      Klondike solver to *find an actual winning line* before committing
//      to a deal, retrying until one is found (bounded by attempts/time).
//   2. Reuse that same solver live, from the player's current board, to
//      power a rate-limited (3-per-game) Hint button that highlights the
//      exact next card + destination to play.
//
// Cards are encoded as integers 0-51 for the solver (suitIndex*13 + rank-1)
// so states can be cloned/hashed cheaply — this is purely an internal
// search representation and never bypasses face-down/face-up visibility
// rules in the actual playable game.
// --------------------------------------------------------------------------

const DEAL_NODE_BUDGET = 16000
const MAX_DEAL_ATTEMPTS = 25
const DEAL_TIME_BUDGET_MS = 1400
const HINT_NODE_BUDGET = 30000
const MAX_HINTS = 3
const HINT_DISPLAY_MS = 6000
const MESSAGE_DISPLAY_MS = 2600

function cardIdOf(suit, rank) {
  return SUITS.indexOf(suit) * 13 + (rank - 1)
}

function idToCard(id) {
  return { suit: SUITS[(id / 13) | 0], rank: (id % 13) + 1 }
}

function isRedId(id) {
  const suitIndex = (id / 13) | 0
  return suitIndex === 1 || suitIndex === 2 // hearts, diamonds
}

/** Deals 52 ids (in `array.pop()`-first-dealt order) into a solver state. */
function dealFromIds(ids) {
  const pool = ids.slice()
  const tableau = Array.from({ length: 7 }, () => [])
  const faceDown = new Array(7).fill(0)
  for (let col = 0; col < 7; col++) {
    for (let i = 0; i <= col; i++) {
      const id = pool.pop()
      tableau[col].push(id)
      if (i !== col) faceDown[col] += 1
    }
  }
  return { tableau, faceDown, foundation: [0, 0, 0, 0], waste: [], stock: pool }
}

function solverStateIsWon(state) {
  return state.foundation.every((rank) => rank === 13)
}

function solverStateHash(state) {
  return (
    state.tableau.map((col) => col.join('.')).join('|') +
    '~' + state.faceDown.join('.') +
    '~' + state.foundation.join('.') +
    '~' + state.waste.join('.') +
    '~' + state.stock.join('.')
  )
}

function solverCanFoundation(state, id) {
  const suitIndex = (id / 13) | 0
  const rank = (id % 13) + 1
  return state.foundation[suitIndex] === rank - 1
}

function solverCanTableau(state, id, destCol) {
  const rank = (id % 13) + 1
  const col = state.tableau[destCol]
  if (!col.length) return rank === 13 // only a King may start an empty column
  const topId = col[col.length - 1]
  const topRank = (topId % 13) + 1
  return isRedId(id) !== isRedId(topId) && rank === topRank - 1
}

function cloneSolverState(state) {
  return {
    tableau: state.tableau.map((col) => col.slice()),
    faceDown: state.faceDown.slice(),
    foundation: state.foundation.slice(),
    waste: state.waste.slice(),
    stock: state.stock.slice(),
  }
}

/** Flips the new top of `col` face-up if removing cards exposed a hidden one. */
function solverReveal(state, col) {
  const column = state.tableau[col]
  if (column.length > 0 && column.length === state.faceDown[col]) {
    state.faceDown[col] -= 1
  }
}

function solverApplyMove(state, move) {
  const next = cloneSolverState(state)
  if (move.type === 'draw') {
    next.waste.push(next.stock.pop())
  } else if (move.type === 'recycle') {
    while (next.waste.length) next.stock.push(next.waste.pop())
  } else if (move.type === 'waste-foundation') {
    const id = next.waste.pop()
    next.foundation[(id / 13) | 0] = (id % 13) + 1
  } else if (move.type === 'tableau-foundation') {
    const col = next.tableau[move.col]
    const id = col.pop()
    next.foundation[(id / 13) | 0] = (id % 13) + 1
    solverReveal(next, move.col)
  } else if (move.type === 'waste-tableau') {
    const id = next.waste.pop()
    next.tableau[move.destCol].push(id)
  } else if (move.type === 'tableau-tableau') {
    const src = next.tableau[move.fromCol]
    const moved = src.splice(src.length - move.count, move.count)
    next.tableau[move.destCol].push(...moved)
    solverReveal(next, move.fromCol)
  }
  return next
}

/**
 * Generates legal moves, roughly ordered best-first: foundation plays and
 * tableau moves that reveal a hidden card first, then other repositioning,
 * then drawing/recycling the stock last. (Foundation <- tableau moves are
 * intentionally not modeled — vanishingly rarely needed and keeping them
 * out keeps the search space, and thus this file, much smaller.)
 */
function solverGenerateMoves(state) {
  const tier0 = []
  const tier1 = []
  const tier2 = []

  if (state.waste.length) {
    const id = state.waste[state.waste.length - 1]
    if (solverCanFoundation(state, id)) tier0.push({ type: 'waste-foundation' })
  }

  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c]
    if (col.length) {
      const id = col[col.length - 1]
      if (solverCanFoundation(state, id)) tier0.push({ type: 'tableau-foundation', col: c })
    }
  }

  if (state.waste.length) {
    const id = state.waste[state.waste.length - 1]
    for (let d = 0; d < 7; d++) {
      if (solverCanTableau(state, id, d)) tier1.push({ type: 'waste-tableau', destCol: d })
    }
  }

  for (let c = 0; c < 7; c++) {
    const col = state.tableau[c]
    const faceUpLen = col.length - state.faceDown[c]
    for (let k = 1; k <= faceUpLen; k++) {
      const baseId = col[col.length - k]
      for (let d = 0; d < 7; d++) {
        if (d === c) continue
        if (solverCanTableau(state, baseId, d)) {
          const revealsCard = col.length - k === state.faceDown[c] && state.faceDown[c] > 0
          const move = { type: 'tableau-tableau', fromCol: c, count: k, destCol: d }
          if (revealsCard) tier0.push(move)
          else tier1.push(move)
        }
      }
    }
  }

  if (state.stock.length) tier2.push({ type: 'draw' })
  else if (state.waste.length) tier2.push({ type: 'recycle' })

  return tier0.concat(tier1, tier2)
}

/**
 * Bounded, full-information feasibility search: returns an array of moves
 * that leads to a win, or null if none was found within `nodeBudget`
 * (which may simply mean the search ran out of budget, not that the deal
 * is truly unsolvable). Iterative (explicit stack) on purpose — a naive
 * recursive DFS blows the JS call stack on long draw/recycle chains.
 */
function solveKlondike(startState, nodeBudget) {
  const visited = new Set()
  const parentOf = new Map() // key -> { move, parentKey } | null for the start
  const startKey = solverStateHash(startState)
  visited.add(startKey)
  parentOf.set(startKey, null)

  const stack = [{ state: startState, key: startKey }]
  let nodes = 0
  let winKey = null

  while (stack.length) {
    const { state, key } = stack.pop()
    nodes++
    if (nodes > nodeBudget) break
    if (solverStateIsWon(state)) {
      winKey = key
      break
    }
    const moves = solverGenerateMoves(state)
    // Push in reverse so higher-priority (tier0) moves get popped first.
    for (let i = moves.length - 1; i >= 0; i--) {
      const move = moves[i]
      const next = solverApplyMove(state, move)
      const nextKey = solverStateHash(next)
      if (visited.has(nextKey)) continue
      visited.add(nextKey)
      parentOf.set(nextKey, { move, parentKey: key })
      stack.push({ state: next, key: nextKey })
    }
  }

  if (!winKey) return null

  const moves = []
  let cur = winKey
  while (true) {
    const info = parentOf.get(cur)
    if (!info) break
    moves.push(info.move)
    cur = info.parentKey
  }
  moves.reverse()
  return moves
}

/**
 * Shuffles repeatedly until the resulting deal is confirmed winnable by
 * `solveKlondike` (or attempts/time run out, in which case the last shuffle
 * is used anyway so the game always deals promptly).
 */
function generateSolvableDeckIds() {
  const startTime = performance.now()
  let lastIds = null
  for (let attempt = 0; attempt < MAX_DEAL_ATTEMPTS; attempt++) {
    const ids = shuffle(Array.from({ length: 52 }, (_, i) => i))
    lastIds = ids
    const state = dealFromIds(ids)
    if (solveKlondike(state, DEAL_NODE_BUDGET)) return ids
    if (performance.now() - startTime > DEAL_TIME_BUDGET_MS) break
  }
  return lastIds
}

const COLORS = {
  background: '#0b0f19',
  felt: 'rgba(0, 229, 255, 0.04)',
  slotOutline: 'rgba(0, 229, 255, 0.35)',
  cardFace: '#eef1f8',
  cardEdge: 'rgba(11, 15, 25, 0.55)',
  cardBackFill: '#101a33',
  cardBackPattern: 'rgba(0, 229, 255, 0.35)',
  cardBackBorder: '#00e5ff',
  black: '#14171f',
  red: '#ff2f7e',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  accent: '#00e5ff',
  win: '#39ff14',
  dragHighlight: 'rgba(57, 255, 20, 0.55)',
}

function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank)
}

function isRed(suit) {
  return RED_SUITS.has(suit)
}

/** Fisher-Yates shuffle, in place. */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

export default class SolitaireGame {
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

    const tableauWidth = 7 * CARD_W + 6 * COL_GAP
    this.tableauStartX = Math.round((this.width - tableauWidth) / 2) || TABLEAU_START_X_FALLBACK

    this.running = false
    this.rafId = null
    this.lastTime = 0

    this.drag = null // { group, source, offsetX, offsetY, pointerX, pointerY }
    this.hoverColumn = null
    this.message = null // { text, color, expiresAt }

    this._onMouseDown = this._onMouseDown.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
    this._onMouseUp = this._onMouseUp.bind(this)
    this._onDoubleClick = this._onDoubleClick.bind(this)
    this._onKeyDown = this._onKeyDown.bind(this)
    this._onContextMenu = this._onContextMenu.bind(this)
    this._loop = this._loop.bind(this)

    this._resetGame()
  }

  // --------------------------------------------------------------------
  // GameEngine interface
  // --------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    this.canvas.addEventListener('mousedown', this._onMouseDown)
    this.canvas.addEventListener('mousemove', this._onMouseMove)
    window.addEventListener('mouseup', this._onMouseUp)
    this.canvas.addEventListener('dblclick', this._onDoubleClick)
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
    window.removeEventListener('mouseup', this._onMouseUp)
    this.canvas.removeEventListener('dblclick', this._onDoubleClick)
    this.canvas.removeEventListener('contextmenu', this._onContextMenu)
    window.removeEventListener('keydown', this._onKeyDown)
  }

  getMatchSnapshot() {
    return {
      kind: 'solo',
      tableau: cloneState(this.tableau),
      stock: cloneState(this.stock),
      waste: cloneState(this.waste),
      foundations: cloneState(this.foundations),
      won: this.won,
      moves: this.moves,
      hintsRemaining: this.hintsRemaining,
      activeHint: this.activeHint ? cloneState(this.activeHint) : null,
      hintMessage: this.hintMessage,
      message: this.message ? cloneState(this.message) : null,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false
    if (Array.isArray(snap.tableau)) this.tableau = cloneState(snap.tableau)
    if (Array.isArray(snap.stock)) this.stock = cloneState(snap.stock)
    if (Array.isArray(snap.waste)) this.waste = cloneState(snap.waste)
    if (snap.foundations && typeof snap.foundations === 'object') {
      this.foundations = cloneState(snap.foundations)
    }
    if (typeof snap.won === 'boolean') this.won = snap.won
    if (typeof snap.moves === 'number') this.moves = snap.moves
    if (typeof snap.hintsRemaining === 'number') this.hintsRemaining = snap.hintsRemaining
    if (snap.activeHint && typeof snap.activeHint === 'object') {
      this.activeHint = cloneState(snap.activeHint)
    } else if (snap.activeHint === null) {
      this.activeHint = null
    }
    if (snap.hintMessage !== undefined) this.hintMessage = snap.hintMessage
    if (snap.message && typeof snap.message === 'object') this.message = cloneState(snap.message)
    else if (snap.message === null) this.message = null
    this.drag = null
    this.hoverColumn = null
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
  // Dealing / state management
  // --------------------------------------------------------------------

  _resetGame() {
    // Shuffle-and-verify: retry shuffles until our solver confirms an
    // actual winning line exists (best-effort — see generateSolvableDeckIds).
    const ids = generateSolvableDeckIds()
    const dealt = dealFromIds(ids)

    this.tableau = dealt.tableau.map((col) =>
      col.map((id, i) => {
        const { suit, rank } = idToCard(id)
        return { suit, rank, faceUp: i === col.length - 1 }
      })
    )
    this.stock = dealt.stock.map((id) => {
      const { suit, rank } = idToCard(id)
      return { suit, rank, faceUp: false }
    })
    this.waste = []
    this.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] }

    this.drag = null
    this.hoverColumn = null
    this.won = false
    this.moves = 0
    this.message = null

    this.hintsRemaining = MAX_HINTS
    this.activeHint = null
    this.hintMessage = null
  }

  // --------------------------------------------------------------------
  // Layout helpers
  // --------------------------------------------------------------------

  _colX(index) {
    return this.tableauStartX + index * COL_STEP
  }

  _stockRect() {
    return { x: this._colX(0), y: TOP_ROW_Y, w: CARD_W, h: CARD_H }
  }

  _wasteRect() {
    return { x: this._colX(1), y: TOP_ROW_Y, w: CARD_W, h: CARD_H }
  }

  _foundationRect(suitIndex) {
    return { x: this._colX(3 + suitIndex), y: TOP_ROW_Y, w: CARD_W, h: CARD_H }
  }

  _foundationRowRect() {
    const first = this._foundationRect(0)
    const last = this._foundationRect(3)
    return { x: first.x - 8, y: first.y - 8, w: last.x + CARD_W - first.x + 16, h: CARD_H + 16 }
  }

  _foundationIndexForSuit(suit) {
    return SUITS.indexOf(suit)
  }

  // The gap between the waste (column 1) and the foundations (columns 3-6)
  // is otherwise empty, so the Hint button lives there in column 2.
  _hintButtonRect() {
    return { x: this._colX(2), y: TOP_ROW_Y, w: CARD_W, h: CARD_H }
  }

  // --------------------------------------------------------------------
  // Coordinate conversion / hit testing
  // --------------------------------------------------------------------

  _toCanvasPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const scaleY = this.canvas.height / rect.height
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }

  _pointInRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
  }

  /** Finds the top-most draggable target under a point, or null. */
  _hitTest(x, y) {
    // Foundations (top card only).
    for (let i = 0; i < 4; i++) {
      const suit = SUITS[i]
      const pile = this.foundations[suit]
      if (pile.length && this._pointInRect(x, y, this._foundationRect(i))) {
        return { zone: 'foundation', suitIndex: i, cardIndex: pile.length - 1 }
      }
    }

    // Waste (top card only).
    if (this.waste.length && this._pointInRect(x, y, this._wasteRect())) {
      return { zone: 'waste', cardIndex: this.waste.length - 1 }
    }

    // Stock (click target, not draggable).
    if (this._pointInRect(x, y, this._stockRect())) {
      return { zone: 'stock' }
    }

    // Tableau columns, topmost card first.
    for (let col = 0; col < 7; col++) {
      const column = this.tableau[col]
      const colX = this._colX(col)
      if (x < colX || x > colX + CARD_W) continue

      for (let i = column.length - 1; i >= 0; i--) {
        const cardY = TABLEAU_TOP + i * FAN_OFFSET
        const cardH = i === column.length - 1 ? CARD_H : FAN_OFFSET
        if (y >= cardY && y <= cardY + cardH) {
          return { zone: 'tableau', col, cardIndex: i }
        }
      }
    }

    return null
  }

  /** Which tableau column (if any) a point roughly falls under. */
  _columnAtX(x) {
    const relative = x - this.tableauStartX
    const col = Math.round(relative / COL_STEP)
    if (col < 0 || col > 6) return null
    const colX = this._colX(col)
    if (x < colX - COL_GAP / 2 || x > colX + CARD_W + COL_GAP / 2) return null
    return col
  }

  // --------------------------------------------------------------------
  // Move validation
  // --------------------------------------------------------------------

  _canPlaceOnTableau(card, destCol) {
    const column = this.tableau[destCol]
    if (!column.length) return card.rank === 13 // only a King may start an empty column
    const top = column[column.length - 1]
    if (!top.faceUp) return false
    return isRed(card.suit) !== isRed(top.suit) && card.rank === top.rank - 1
  }

  _canPlaceOnFoundation(card, suitIndex) {
    if (card.suit !== SUITS[suitIndex]) return false
    const pile = this.foundations[card.suit]
    if (!pile.length) return card.rank === 1
    return card.rank === pile[pile.length - 1].rank + 1
  }

  // --------------------------------------------------------------------
  // Input — dragging
  // --------------------------------------------------------------------

  _onMouseDown(event) {
    // Treat anything but a clear right/middle click as the primary action.
    // (Some automated/synthetic input sources don't normalize `button` the
    // same way real mouse hardware does, so we deliberately don't require
    // a strict `=== 0` match here.)
    if (event.button === 1 || event.button === 2) return
    const { x, y } = this._toCanvasPoint(event.clientX, event.clientY)

    if (this.won) return

    if (this._pointInRect(x, y, this._hintButtonRect())) {
      this._useHint()
      return
    }

    const hit = this._hitTest(x, y)
    if (!hit) return

    if (hit.zone === 'stock') {
      this._clickStock()
      return
    }

    if (hit.zone === 'tableau') {
      const column = this.tableau[hit.col]
      const card = column[hit.cardIndex]
      if (!card.faceUp) return // can't lift a face-down card

      const group = column.slice(hit.cardIndex)
      const cardScreenX = this._colX(hit.col)
      const cardScreenY = TABLEAU_TOP + hit.cardIndex * FAN_OFFSET
      this.drag = {
        group,
        source: { zone: 'tableau', col: hit.col, cardIndex: hit.cardIndex },
        offsetX: x - cardScreenX,
        offsetY: y - cardScreenY,
        pointerX: x,
        pointerY: y,
      }
    } else if (hit.zone === 'waste') {
      const card = this.waste[this.waste.length - 1]
      const rect = this._wasteRect()
      this.drag = {
        group: [card],
        source: { zone: 'waste' },
        offsetX: x - rect.x,
        offsetY: y - rect.y,
        pointerX: x,
        pointerY: y,
      }
    } else if (hit.zone === 'foundation') {
      const suit = SUITS[hit.suitIndex]
      const pile = this.foundations[suit]
      const card = pile[pile.length - 1]
      const rect = this._foundationRect(hit.suitIndex)
      this.drag = {
        group: [card],
        source: { zone: 'foundation', suitIndex: hit.suitIndex },
        offsetX: x - rect.x,
        offsetY: y - rect.y,
        pointerX: x,
        pointerY: y,
      }
    }
  }

  _onMouseMove(event) {
    const { x, y } = this._toCanvasPoint(event.clientX, event.clientY)
    if (this.drag) {
      this.drag.pointerX = x
      this.drag.pointerY = y
      this.hoverColumn = this._columnAtX(x)
    }
  }

  _onMouseUp(event) {
    if (!this.drag) return
    const { x, y } = this._toCanvasPoint(event.clientX, event.clientY)
    this._resolveDrop(x, y)
    this.drag = null
    this.hoverColumn = null
  }

  _resolveDrop(x, y) {
    const { group, source } = this.drag
    const leadCard = group[0]

    // Prefer foundation drops when the pointer is over the foundation row.
    if (group.length === 1 && this._pointInRect(x, y, this._foundationRowRect())) {
      const suitIndex = this._foundationIndexForSuit(leadCard.suit)
      if (this._canPlaceOnFoundation(leadCard, suitIndex)) {
        this._moveGroup(source, { zone: 'foundation', suitIndex })
        return
      }
    }

    const destCol = this._columnAtX(x)
    if (destCol !== null && y >= TABLEAU_TOP - FAN_OFFSET) {
      const isSameColumn = source.zone === 'tableau' && source.col === destCol
      if (!isSameColumn && this._canPlaceOnTableau(leadCard, destCol)) {
        this._moveGroup(source, { zone: 'tableau', col: destCol })
        return
      }
    }
    // Otherwise: snap back — no state change needed since we never removed
    // the cards from their source pile during the drag.
  }

  _moveGroup(source, dest) {
    const cards = this._removeFromSource(source)
    if (dest.zone === 'tableau') {
      this.tableau[dest.col].push(...cards)
    } else if (dest.zone === 'foundation') {
      this.foundations[SUITS[dest.suitIndex]].push(...cards)
    }
    this._flipExposedTableauCard(source)
    this.moves += 1
    this.activeHint = null // the board changed — any prior hint is stale
    this._checkVictory()
  }

  _removeFromSource(source) {
    if (source.zone === 'tableau') {
      return this.tableau[source.col].splice(source.cardIndex)
    }
    if (source.zone === 'waste') {
      return this.waste.splice(this.waste.length - 1, 1)
    }
    if (source.zone === 'foundation') {
      const suit = SUITS[source.suitIndex]
      return this.foundations[suit].splice(this.foundations[suit].length - 1, 1)
    }
    return []
  }

  _flipExposedTableauCard(source) {
    if (source.zone !== 'tableau') return
    const column = this.tableau[source.col]
    if (column.length) {
      const top = column[column.length - 1]
      if (!top.faceUp) top.faceUp = true
    }
  }

  _clickStock() {
    if (this.stock.length) {
      const card = this.stock.pop()
      card.faceUp = true
      this.waste.push(card)
    } else if (this.waste.length) {
      // Recycle waste back into the stock, face-down, preserving redeal order.
      while (this.waste.length) {
        const card = this.waste.pop()
        card.faceUp = false
        this.stock.push(card)
      }
    }
    this.activeHint = null // the board changed — any prior hint is stale
  }

  // --------------------------------------------------------------------
  // Input — double-click auto-move to foundation
  // --------------------------------------------------------------------

  _onDoubleClick(event) {
    const { x, y } = this._toCanvasPoint(event.clientX, event.clientY)
    if (this.won) return

    const hit = this._hitTest(x, y)
    if (!hit) return

    let source = null
    let card = null

    if (hit.zone === 'tableau') {
      const column = this.tableau[hit.col]
      if (hit.cardIndex !== column.length - 1) return // only the exposed top card
      card = column[hit.cardIndex]
      if (!card.faceUp) return
      source = { zone: 'tableau', col: hit.col, cardIndex: hit.cardIndex }
    } else if (hit.zone === 'waste') {
      card = this.waste[this.waste.length - 1]
      source = { zone: 'waste' }
    } else {
      return
    }

    const suitIndex = this._foundationIndexForSuit(card.suit)
    if (this._canPlaceOnFoundation(card, suitIndex)) {
      this.drag = null
      this._moveGroup(source, { zone: 'foundation', suitIndex })
    }
  }

  _onContextMenu(event) {
    event.preventDefault()
  }

  _onKeyDown(event) {
    if (event.key === 'r' || event.key === 'R') {
      this._resetGame()
    } else if (event.key === 'h' || event.key === 'H') {
      this._useHint()
    }
  }

  // --------------------------------------------------------------------
  // Hints
  // --------------------------------------------------------------------

  /** Mirrors the live board (this.tableau/foundations/waste/stock) into the
   * compact id-based representation the solver operates on. */
  _buildLiveSolverState() {
    const tableau = this.tableau.map((col) => col.map((card) => cardIdOf(card.suit, card.rank)))
    const faceDown = this.tableau.map((col) => col.reduce((n, card) => n + (card.faceUp ? 0 : 1), 0))
    const foundation = SUITS.map((suit) => {
      const pile = this.foundations[suit]
      return pile.length ? pile[pile.length - 1].rank : 0
    })
    const waste = this.waste.map((card) => cardIdOf(card.suit, card.rank))
    const stock = this.stock.map((card) => cardIdOf(card.suit, card.rank))
    return { tableau, faceDown, foundation, waste, stock }
  }

  _useHint() {
    if (this.won) return

    if (this.hintsRemaining <= 0) {
      this._flashMessage('No hints remaining', COLORS.danger)
      return
    }

    const state = this._buildLiveSolverState()
    const solution = solveKlondike(state, HINT_NODE_BUDGET)

    if (!solution || !solution.length) {
      this._flashMessage("No forced win found — try your best guess!", COLORS.danger)
      return
    }

    const move = solution[0]
    this.hintsRemaining -= 1
    this.hintMessage = null
    this.activeHint = {
      label: this._describeMove(move),
      rects: this._moveRects(move),
      shownAt: performance.now(),
    }
  }

  _flashMessage(text, color) {
    this.activeHint = null // never show two overlapping banners at once
    this.hintMessage = { text, color, shownAt: performance.now() }
  }

  _describeMove(move) {
    const label = (card) => `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`

    switch (move.type) {
      case 'draw':
        return 'Draw a card from the Stock'
      case 'recycle':
        return 'Recycle the Waste back into the Stock'
      case 'waste-foundation': {
        const card = this.waste[this.waste.length - 1]
        return `Move ${label(card)} from the Waste to its Foundation`
      }
      case 'tableau-foundation': {
        const col = this.tableau[move.col]
        const card = col[col.length - 1]
        return `Move ${label(card)} from Column ${move.col + 1} to its Foundation`
      }
      case 'waste-tableau': {
        const card = this.waste[this.waste.length - 1]
        return `Move ${label(card)} from the Waste to Column ${move.destCol + 1}`
      }
      case 'tableau-tableau': {
        const col = this.tableau[move.fromCol]
        const card = col[col.length - move.count]
        const extra = move.count > 1 ? ` (+${move.count - 1} more)` : ''
        return `Move ${label(card)}${extra} from Column ${move.fromCol + 1} to Column ${move.destCol + 1}`
      }
      default:
        return 'Make your next move'
    }
  }

  /** On-screen source/destination rects for the active hint's glow outlines. */
  _moveRects(move) {
    const topCardRect = (col) => {
      const column = this.tableau[col]
      const y = TABLEAU_TOP + Math.max(column.length - 1, 0) * FAN_OFFSET
      return { x: this._colX(col), y, w: CARD_W, h: CARD_H }
    }
    const liftedRect = (col, count) => {
      const column = this.tableau[col]
      const startIndex = Math.max(column.length - count, 0)
      const y = TABLEAU_TOP + startIndex * FAN_OFFSET
      const h = (count - 1) * FAN_OFFSET + CARD_H
      return { x: this._colX(col), y, w: CARD_W, h }
    }
    const landingRect = (col) => {
      const column = this.tableau[col]
      const y = TABLEAU_TOP + column.length * FAN_OFFSET
      return { x: this._colX(col), y, w: CARD_W, h: CARD_H }
    }

    switch (move.type) {
      case 'draw':
      case 'recycle':
        return { source: this._stockRect(), dest: this._stockRect() }
      case 'waste-foundation': {
        const card = this.waste[this.waste.length - 1]
        return { source: this._wasteRect(), dest: this._foundationRect(this._foundationIndexForSuit(card.suit)) }
      }
      case 'tableau-foundation': {
        const col = this.tableau[move.col]
        const card = col[col.length - 1]
        return { source: topCardRect(move.col), dest: this._foundationRect(this._foundationIndexForSuit(card.suit)) }
      }
      case 'waste-tableau':
        return { source: this._wasteRect(), dest: landingRect(move.destCol) }
      case 'tableau-tableau':
        return { source: liftedRect(move.fromCol, move.count), dest: landingRect(move.destCol) }
      default:
        return null
    }
  }

  // --------------------------------------------------------------------
  // Victory
  // --------------------------------------------------------------------

  _checkVictory() {
    const total = SUITS.reduce((sum, suit) => sum + this.foundations[suit].length, 0)
    if (total === 52) {
      this.won = true
    }
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    this.lastTime = now
    this._render(now)
    this.rafId = requestAnimationFrame(this._loop)
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render(now = performance.now()) {
    const ctx = this.ctx
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, this.width, this.height)

    this._drawFeltAndSlots(ctx)
    this._drawStock(ctx)
    this._drawWaste(ctx)
    this._drawFoundations(ctx)
    this._drawHintButton(ctx)
    this._drawTableau(ctx)
    this._drawDragGroup(ctx)
    this._drawHud(ctx)
    this._drawHintOverlay(ctx, now)

    if (this.won) {
      this._drawWinOverlay(ctx)
    }
  }

  _drawFeltAndSlots(ctx) {
    ctx.fillStyle = COLORS.felt
    ctx.fillRect(0, 0, this.width, this.height)
  }

  _drawSlotOutline(ctx, rect, label) {
    ctx.save()
    ctx.setLineDash([5, 5])
    ctx.strokeStyle = COLORS.slotOutline
    ctx.lineWidth = 2
    this._roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8)
    ctx.stroke()
    ctx.restore()

    if (label) {
      ctx.fillStyle = COLORS.slotOutline
      ctx.font = '28px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    }
  }

  _drawStock(ctx) {
    const rect = this._stockRect()
    if (this.stock.length) {
      this._drawCardBack(ctx, rect.x, rect.y)
      ctx.fillStyle = COLORS.textDim
      ctx.font = 'bold 11px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(String(this.stock.length), rect.x + CARD_W / 2, rect.y + CARD_H + 14)
      ctx.textAlign = 'left'
    } else {
      this._drawSlotOutline(ctx, rect, '\u21bb') // recycle glyph
    }
  }

  _drawWaste(ctx) {
    const rect = this._wasteRect()
    if (!this.waste.length) {
      this._drawSlotOutline(ctx, rect, null)
      return
    }
    const isDragging = this.drag && this.drag.source.zone === 'waste'
    if (isDragging) {
      this._drawSlotOutline(ctx, rect, null)
      return
    }
    const card = this.waste[this.waste.length - 1]
    this._drawCard(ctx, card, rect.x, rect.y)
  }

  _drawFoundations(ctx) {
    for (let i = 0; i < 4; i++) {
      const suit = SUITS[i]
      const rect = this._foundationRect(i)
      const pile = this.foundations[suit]
      const isDragging =
        this.drag && this.drag.source.zone === 'foundation' && this.drag.source.suitIndex === i

      if (!pile.length || isDragging) {
        this._drawSlotOutline(ctx, rect, SUIT_SYMBOL[suit])
        continue
      }
      const card = pile[pile.length - 1]
      this._drawCard(ctx, card, rect.x, rect.y)
    }
  }

  _drawHintButton(ctx) {
    const rect = this._hintButtonRect()
    const disabled = this.hintsRemaining <= 0
    const color = disabled ? COLORS.textDim : COLORS.win

    ctx.save()
    ctx.setLineDash(disabled ? [4, 4] : [])
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    if (!disabled) {
      ctx.shadowColor = color
      ctx.shadowBlur = 8
    }
    this._roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8)
    ctx.stroke()
    ctx.restore()

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.font = '26px sans-serif'
    ctx.fillText('\u{1F4A1}', rect.x + rect.w / 2, rect.y + rect.h / 2 - 16)
    ctx.font = 'bold 13px monospace'
    ctx.fillText('HINT', rect.x + rect.w / 2, rect.y + rect.h / 2 + 16)
    ctx.font = '11px monospace'
    ctx.fillText(disabled ? 'none left' : `${this.hintsRemaining} left`, rect.x + rect.w / 2, rect.y + rect.h / 2 + 32)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  _drawHintOverlay(ctx, now) {
    if (this.activeHint) {
      if (now - this.activeHint.shownAt < HINT_DISPLAY_MS) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 220)
        const rects = this.activeHint.rects
        if (rects) {
          if (rects.source) this._drawGlowBox(ctx, rects.source, COLORS.win, pulse)
          if (rects.dest && rects.dest !== rects.source) this._drawGlowBox(ctx, rects.dest, COLORS.accent, pulse)
        }
        this._drawBanner(ctx, this.activeHint.label, COLORS.win)
      } else {
        this.activeHint = null
      }
    }

    if (this.hintMessage) {
      if (now - this.hintMessage.shownAt < MESSAGE_DISPLAY_MS) {
        this._drawBanner(ctx, this.hintMessage.text, this.hintMessage.color)
      } else {
        this.hintMessage = null
      }
    }
  }

  _drawGlowBox(ctx, rect, color, pulse) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.shadowColor = color
    ctx.shadowBlur = 8 + pulse * 10
    this._roundRect(ctx, rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8, 10)
    ctx.stroke()
    ctx.restore()
  }

  _drawBanner(ctx, text, color) {
    const centerY = 11
    const boxH = 18

    ctx.save()
    ctx.font = 'bold 11px monospace'
    const paddingX = 14
    const textWidth = ctx.measureText(text).width
    const boxW = Math.min(textWidth + paddingX * 2, this.width - 16)
    const x = this.width / 2 - boxW / 2

    ctx.fillStyle = 'rgba(11, 15, 25, 0.88)'
    this._roundRect(ctx, x, centerY - boxH / 2, boxW, boxH, 8)
    ctx.fill()

    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    this._roundRect(ctx, x, centerY - boxH / 2, boxW, boxH, 8)
    ctx.stroke()

    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, this.width / 2, centerY + 1)
    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  _drawTableau(ctx) {
    for (let col = 0; col < 7; col++) {
      const column = this.tableau[col]
      const x = this._colX(col)

      if (!column.length) {
        this._drawSlotOutline(ctx, { x, y: TABLEAU_TOP, w: CARD_W, h: CARD_H }, null)
        if (this.hoverColumn === col && this.drag) {
          this._drawColumnHighlight(ctx, x, TABLEAU_TOP)
        }
        continue
      }

      const draggingFromHere = this.drag && this.drag.source.zone === 'tableau' && this.drag.source.col === col
      const visibleCount = draggingFromHere ? this.drag.source.cardIndex : column.length

      for (let i = 0; i < visibleCount; i++) {
        const card = column[i]
        const y = TABLEAU_TOP + i * FAN_OFFSET
        if (card.faceUp) {
          this._drawCard(ctx, card, x, y)
        } else {
          this._drawCardBack(ctx, x, y)
        }
      }

      if (this.hoverColumn === col && this.drag && !draggingFromHere) {
        const highlightY = TABLEAU_TOP + visibleCount * (visibleCount ? FAN_OFFSET : 0)
        this._drawColumnHighlight(ctx, x, visibleCount ? TABLEAU_TOP + (visibleCount - 1) * FAN_OFFSET + FAN_OFFSET : TABLEAU_TOP)
      }
    }
  }

  _drawColumnHighlight(ctx, x, y) {
    ctx.save()
    ctx.strokeStyle = COLORS.dragHighlight
    ctx.lineWidth = 3
    ctx.shadowColor = COLORS.dragHighlight
    ctx.shadowBlur = 10
    this._roundRect(ctx, x - 2, y - 2, CARD_W + 4, 8, 4)
    ctx.stroke()
    ctx.restore()
  }

  _drawDragGroup(ctx) {
    if (!this.drag) return
    const { group, pointerX, pointerY, offsetX, offsetY } = this.drag
    const originX = pointerX - offsetX
    const originY = pointerY - offsetY

    ctx.save()
    ctx.globalAlpha = 0.96
    group.forEach((card, i) => {
      this._drawCard(ctx, card, originX, originY + i * FAN_OFFSET, true)
    })
    ctx.restore()
  }

  _drawCard(ctx, card, x, y, elevated = false) {
    ctx.save()
    if (elevated) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
      ctx.shadowBlur = 16
      ctx.shadowOffsetY = 6
    }

    ctx.fillStyle = COLORS.cardFace
    this._roundRect(ctx, x, y, CARD_W, CARD_H, 8)
    ctx.fill()
    ctx.restore()

    ctx.strokeStyle = COLORS.cardEdge
    ctx.lineWidth = 1
    this._roundRect(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 8)
    ctx.stroke()

    const color = isRed(card.suit) ? COLORS.red : COLORS.black
    const label = rankLabel(card.rank)
    const symbol = SUIT_SYMBOL[card.suit]

    ctx.fillStyle = color
    ctx.textBaseline = 'top'
    ctx.font = 'bold 16px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(label, x + 6, y + 4)
    ctx.font = '14px sans-serif'
    ctx.fillText(symbol, x + 6, y + 22)

    ctx.save()
    ctx.translate(x + CARD_W - 6, y + CARD_H - 4)
    ctx.rotate(Math.PI)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = 'bold 16px sans-serif'
    ctx.fillText(label, 0, 0)
    ctx.font = '14px sans-serif'
    ctx.fillText(symbol, 0, 18)
    ctx.restore()

    ctx.font = '30px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(symbol, x + CARD_W / 2, y + CARD_H / 2 + 6)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  _drawCardBack(ctx, x, y) {
    ctx.save()
    ctx.fillStyle = COLORS.cardBackFill
    this._roundRect(ctx, x, y, CARD_W, CARD_H, 8)
    ctx.fill()

    ctx.strokeStyle = COLORS.cardBackBorder
    ctx.lineWidth = 1.5
    this._roundRect(ctx, x + 4, y + 4, CARD_W - 8, CARD_H - 8, 6)
    ctx.stroke()

    ctx.strokeStyle = COLORS.cardBackPattern
    ctx.lineWidth = 1
    for (let i = -CARD_H; i < CARD_W; i += 10) {
      ctx.beginPath()
      ctx.moveTo(x + i, y)
      ctx.lineTo(x + i + CARD_H, y + CARD_H)
      ctx.stroke()
    }
    ctx.restore()

    ctx.strokeStyle = COLORS.cardEdge
    ctx.lineWidth = 1
    this._roundRect(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 8)
    ctx.stroke()
  }

  _drawHud(ctx) {
    ctx.fillStyle = COLORS.textDim
    ctx.font = '13px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(`MOVES ${this.moves}`, this.tableauStartX, TABLEAU_TOP - 26)

    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.accent
    const doneCount = SUITS.reduce((sum, suit) => sum + this.foundations[suit].length, 0)
    ctx.fillText(`FOUNDATIONS ${doneCount}/52`, this._foundationRect(3).x + CARD_W, TABLEAU_TOP - 26)
    ctx.textAlign = 'left'
  }

  _drawWinOverlay(ctx) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.82)'
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.font = 'bold 44px monospace'
    ctx.fillStyle = COLORS.win
    ctx.shadowColor = COLORS.win
    ctx.shadowBlur = 22
    ctx.fillText('YOU WIN!', this.width / 2, this.height / 2 - 16)

    ctx.shadowBlur = 0
    ctx.font = '16px monospace'
    ctx.fillStyle = COLORS.text
    ctx.fillText(`Solved in ${this.moves} moves — Press R for a new deal`, this.width / 2, this.height / 2 + 26)

    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  _roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.arcTo(x + w, y, x + w, y + h, radius)
    ctx.arcTo(x + w, y + h, x, y + h, radius)
    ctx.arcTo(x, y + h, x, y, radius)
    ctx.arcTo(x, y, x + w, y, radius)
    ctx.closePath()
  }
}
