// src/games/shared/lobby.js
//
// Shared lobby + bot-fill helpers for every multiplayer GameEngine.
// Host waits on a Start button; empty seats become bots so a solo host
// (or a partial party) can always fill the room to capacity.

import {
  THEME,
  FONT_MONO,
  FONT_UI,
  PLAYER_COLORS,
  drawArenaBackdrop,
  drawGlassPanel,
  drawNeonText,
  drawCanvasButton,
  withAlpha,
} from '../../fx/theme.js'

export const LOBBY_COLORS = PLAYER_COLORS

export const LOBBY_NAMES = [
  'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12',
]

export const BOT_NAMES = [
  'NeonBot', 'PixelBot', 'CyberBot', 'GlitchBot', 'ArcBot', 'FluxBot',
  'SparkBot', 'NovaBot', 'BitBot', 'HexBot', 'VoltBot', 'PulseBot',
]

/** Canvas-space hit test. */
export function hit(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
}

export function canvasPoint(canvas, event, width, height) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) * width) / rect.width,
    y: ((event.clientY - rect.top) * height) / rect.height,
  }
}

/**
 * Draw the pre-game lobby: roster, bot preview, and host-only START button.
 * Returns the start-button rect (or null) for hit-testing.
 */
export function drawLobby(ctx, {
  width,
  height,
  title,
  seats, // [{ active, isBot, label? }]
  capacity,
  isHost,
  mySeat,
  message = 'Share the room link, then press START when ready.',
}) {
  const active = seats.filter((s) => s.active).length
  const botsIfStart = Math.max(0, capacity - active)
  const t = performance.now()

  drawArenaBackdrop(ctx, width, height, { step: 48 })

  // Title block sits below the arcade HUD strip (top ~44px is reserved).
  drawNeonText(ctx, title.toUpperCase(), width / 2, 74, {
    font: `800 30px ${FONT_UI}`,
    color: THEME.text,
    glow: 22,
  })
  drawNeonText(ctx, message, width / 2, 98, {
    font: `500 12.5px ${FONT_MONO}`,
    color: THEME.textDim,
    glow: 0,
  })

  // Roster panel. Rooms larger than 8 seats split into two columns with
  // tighter rows so a 12-player roster still fits above the START button.
  const cols = capacity > 8 ? 2 : 1
  const rows = Math.ceil(capacity / cols)
  const rowH = rows > 8 ? 29 : 33
  const panelW = cols === 2 ? 660 : 540
  const colW = panelW / cols
  const panelX = (width - panelW) / 2
  const panelY = 118
  const panelH = 52 + rows * rowH

  drawGlassPanel(ctx, {
    x: panelX,
    y: panelY,
    w: panelW,
    h: panelH,
    accent: THEME.cyan,
    title: `roster  ${String(active).padStart(2, '0')} / ${capacity}`,
    glow: 26,
  })

  ctx.save()
  for (let seat = 0; seat < capacity; seat++) {
    const s = seats[seat] || { active: false }
    const col = Math.floor(seat / rows)
    const colX = panelX + col * colW
    const y = panelY + 50 + (seat % rows) * rowH + rowH / 2
    const color = LOBBY_COLORS[seat % LOBBY_COLORS.length]

    // Row backing: lit for live seats, hollow for open ones.
    ctx.fillStyle = s.active ? withAlpha(color, 0.07) : 'rgba(255,255,255,0.015)'
    ctx.fillRect(colX + 16, y - rowH / 2 + 2, colW - 32, rowH - 4)
    ctx.fillStyle = s.active ? color : 'rgba(120,140,170,0.25)'
    ctx.fillRect(colX + 16, y - rowH / 2 + 2, 2.5, rowH - 4)

    // Seat index chip
    ctx.font = `700 10px ${FONT_MONO}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = s.active ? withAlpha(color, 0.9) : 'rgba(120,140,170,0.45)'
    ctx.fillText(String(seat + 1).padStart(2, '0'), colX + 26, y)

    if (s.active) {
      ctx.save()
      ctx.shadowColor = withAlpha(color, 0.9)
      ctx.shadowBlur = 10
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(colX + 52, y, 5.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    } else {
      ctx.strokeStyle = 'rgba(120,140,170,0.32)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(colX + 52, y, 5.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    let label
    if (s.active && s.isBot) label = s.label || BOT_NAMES[seat % BOT_NAMES.length]
    else if (s.active && seat === mySeat) label = `${s.label || LOBBY_NAMES[seat]} · YOU`
    else if (s.active) label = s.label || LOBBY_NAMES[seat]
    else label = 'AWAITING LINK'

    ctx.font = s.active ? `700 13px ${FONT_UI}` : `500 12px ${FONT_MONO}`
    ctx.fillStyle = s.active ? THEME.text : 'rgba(120,140,170,0.5)'
    ctx.fillText(label, colX + 68, y)

    const tagText = s.active ? (s.isBot ? 'AI' : 'HUMAN') : 'OPEN'
    const tagColor = s.active ? (s.isBot ? THEME.amber : THEME.lime) : 'rgba(120,140,170,0.4)'
    ctx.font = `700 9.5px ${FONT_MONO}`
    ctx.textAlign = 'right'
    ctx.fillStyle = tagColor
    ctx.fillText(tagText, colX + colW - 26, y)
  }
  ctx.restore()

  if (cols === 2) {
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.14)
    ctx.beginPath()
    ctx.moveTo(panelX + colW, panelY + 44)
    ctx.lineTo(panelX + colW, panelY + panelH - 10)
    ctx.stroke()
  }

  // Bot fill preview
  const previewY = panelY + panelH + 26
  if (botsIfStart > 0) {
    drawNeonText(
      ctx,
      `START NOW → ${botsIfStart} AI OPPONENT${botsIfStart === 1 ? '' : 'S'} FILL THE EMPTY SEATS`,
      width / 2,
      previewY,
      { font: `700 12px ${FONT_MONO}`, color: THEME.amber, glow: 10 }
    )
  } else {
    drawNeonText(ctx, 'ROOM AT CAPACITY — ALL SEATS LIVE', width / 2, previewY, {
      font: `700 12px ${FONT_MONO}`,
      color: THEME.lime,
      glow: 10,
    })
  }

  // START button (host only)
  let startRect = null
  if (isHost) {
    const bw = 240
    const bh = 50
    const bx = (width - bw) / 2
    const by = Math.min(height - 64, previewY + 22)
    startRect = drawCanvasButton(ctx, {
      x: bx,
      y: by,
      w: bw,
      h: bh,
      label: '▶  START MATCH',
      accent: THEME.lime,
      filled: true,
      font: `800 18px ${FONT_UI}`,
      hover: Math.sin(t * 0.004) > 0, // slow breathing pulse draws the eye
    })
  } else {
    drawNeonText(ctx, 'STANDBY // WAITING FOR HOST', width / 2, height - 42, {
      font: `600 13px ${FONT_MONO}`,
      color: withAlpha(THEME.cyan, 0.55 + 0.35 * Math.sin(t * 0.004)),
      glow: 0,
    })
  }

  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
  return startRect
}

/**
 * Activate every empty seat as a bot. Mutates `seats` array in place.
 * `activate(seat)` is called for each newly filled bot seat.
 * Returns number of bots added.
 */
export function fillBots(seats, capacity, activate) {
  let added = 0
  for (let seat = 0; seat < capacity; seat++) {
    if (seats[seat]?.active) continue
    if (typeof activate === 'function') activate(seat)
    else {
      seats[seat].active = true
      seats[seat].isBot = true
    }
    added++
  }
  return added
}

/** Simple deterministic pseudo-random 0–1 from a seed that changes over time. */
export function botNoise(seat, t, salt = 0) {
  const x = Math.sin(seat * 12.9898 + t * 0.0017 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Seat indices currently bound to a live peer connection. */
export function mappedSeats(peerMap) {
  return new Set(peerMap.values())
}

/**
 * Mid-match reconnect: active human seat with no current peer mapping (host is seat 0).
 */
export function findReclaimSeat(seats, peerMap, { minSeat = 1 } = {}) {
  const mapped = mappedSeats(peerMap)
  for (let seat = minSeat; seat < seats.length; seat++) {
    const s = seats[seat]
    if (s?.active && !s.isBot && !mapped.has(seat)) return seat
  }
  return -1
}

/** Lobby join: first inactive seat (seat 0 is the host). */
export function findLobbySeat(seats, { minSeat = 1 } = {}) {
  for (let seat = minSeat; seat < seats.length; seat++) {
    if (!seats[seat]?.active) return seat
  }
  return -1
}
