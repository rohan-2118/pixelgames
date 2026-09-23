// src/games/solo/invaders.js
//
// Classic Space Invaders clone: a 5x11 grid of pixel-art aliens that
// step/drop/accelerate as their ranks thin out, a player cannon with
// cooldown-limited fire, and 3 destructible pixel barricades that erode
// from both alien and player fire. All state lives in RAM — no
// localStorage, no cookies, nothing survives a refresh.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//
// This is a solo game, so `p2pContext` is always null and the peer hooks
// are no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'
import { THEME, FONT_MONO, drawArenaBackdrop, drawNeonText, withAlpha } from '../../fx/theme.js'

const ALIEN_ROWS = 5
const ALIEN_COLS = 11
const ALIEN_PIXEL = 3 // size of one sprite "pixel" in canvas px
const ALIEN_GRID_W = 8 // sprite bitmap is 8x8 "pixels"
const ALIEN_W = ALIEN_GRID_W * ALIEN_PIXEL
const ALIEN_H = ALIEN_GRID_W * ALIEN_PIXEL
const ALIEN_COL_SPACING = 48
const ALIEN_ROW_SPACING = 38
const FORMATION_TOP = 60
const FORMATION_STEP_PX = 10
const FORMATION_DROP_PX = 16
const PLAY_MARGIN = 24

const BASE_STEP_MS = 750
const MIN_STEP_MS = 70
const WAVE_SPEEDUP_MS = 70

const PLAYER_SPEED = 340
const PLAYER_W = 34
const PLAYER_H = 16
const PLAYER_Y_OFFSET = 34
const PLAYER_LIVES = 3
const PLAYER_RESPAWN_INVULN_MS = 1500

const PLAYER_BULLET_SPEED = -520
const PLAYER_FIRE_COOLDOWN_MS = 420
const ALIEN_BULLET_SPEED = 260
const ALIEN_FIRE_BASE_MS = 1100
const ALIEN_FIRE_WAVE_REDUCTION_MS = 60
const ALIEN_FIRE_MIN_MS = 350

const BARRICADE_COUNT = 3
const BARRICADE_COLS = 11
const BARRICADE_ROWS = 8
const BARRICADE_PIXEL = 4
const BARRICADE_W = BARRICADE_COLS * BARRICADE_PIXEL
const BARRICADE_Y_OFFSET = 110

const COLORS = {
  background: '#0b0f19',
  ground: 'rgba(0, 229, 255, 0.2)',
  player: '#00e5ff',
  playerGlow: 'rgba(0, 229, 255, 0.6)',
  playerBullet: '#39ff14',
  alienBullet: '#ff007f',
  barricade: '#39ff14',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  accent: '#00e5ff',
  danger: '#ff007f',
}

const ROW_TYPE = (row) => (row === 0 ? 'squid' : row <= 2 ? 'crab' : 'octopus')
const ROW_COLOR = { squid: THEME.magenta, crab: THEME.cyan, octopus: THEME.lime }
const ROW_SCORE = { squid: 30, crab: 20, octopus: 10 }

// 8x8 pixel-art bitmaps, two animation frames per alien type.
const SPRITES = {
  squid: [
    ['..XXX..', '.XXXXX.', 'XX.X.XX', 'XXXXXXX', 'X.XXX.X', 'X.X.X.X', '...X...', '..X.X..'],
    ['..XXX..', '.XXXXX.', 'XX.X.XX', 'XXXXXXX', 'X.XXX.X', '..X.X..', '.X...X.', 'X.....X'],
  ],
  crab: [
    ['...XX...', '..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
    ['...XX...', '..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '.XX..XX.', 'X..XX..X', '..X..X..'],
  ],
  octopus: [
    ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXX..XXX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
    ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXX..XXX', 'XXXXXXXX', '.X.XX.X.', 'X.X..X.X', '.X....X.'],
  ],
}

/** Classic bunker silhouette used for all 3 barricades. */
function buildBarricadeShape() {
  const shape = []
  for (let r = 0; r < BARRICADE_ROWS; r++) {
    const row = []
    for (let c = 0; c < BARRICADE_COLS; c++) {
      let alive = true
      // Carve the arch/doorway out of the bottom-center.
      if (r >= BARRICADE_ROWS - 3 && c >= 4 && c <= 6) alive = false
      if (r === 0 && (c === 0 || c === BARRICADE_COLS - 1)) alive = false
      row.push(alive)
    }
    shape.push(row)
  }
  return shape
}

export default class InvadersGame {
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
    this.playerY = this.height - PLAYER_Y_OFFSET

    this.running = false
    this.rafId = null
    this.lastTime = 0
    this.keysDown = new Set()

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._loop = this._loop.bind(this)

    this._resetGame()
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
      score: this.score,
      lives: this.lives,
      wave: this.wave,
      gameOver: this.gameOver,
      player: cloneState(this.player),
      playerBullets: cloneState(this.playerBullets),
      alienBullets: cloneState(this.alienBullets),
      particles: cloneState(this.particles),
      fireCooldown: this.fireCooldown,
      aliens: cloneState(this.aliens),
      formationX: this.formationX,
      formationY: this.formationY,
      direction: this.direction,
      stepParity: this.stepParity,
      stepTimer: this.stepTimer,
      alienFireTimer: this.alienFireTimer,
      barricades: cloneState(this.barricades),
      waveMessageMs: this.waveMessageMs,
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false
    if (typeof snap.score === 'number') this.score = snap.score
    if (typeof snap.lives === 'number') this.lives = snap.lives
    if (typeof snap.wave === 'number') this.wave = snap.wave
    if (typeof snap.gameOver === 'boolean') this.gameOver = snap.gameOver
    if (snap.player && typeof snap.player === 'object') this.player = cloneState(snap.player)
    if (Array.isArray(snap.playerBullets)) this.playerBullets = cloneState(snap.playerBullets)
    if (Array.isArray(snap.alienBullets)) this.alienBullets = cloneState(snap.alienBullets)
    if (Array.isArray(snap.particles)) this.particles = cloneState(snap.particles)
    if (typeof snap.fireCooldown === 'number') this.fireCooldown = snap.fireCooldown
    if (Array.isArray(snap.aliens)) this.aliens = cloneState(snap.aliens)
    if (typeof snap.formationX === 'number') this.formationX = snap.formationX
    if (typeof snap.formationY === 'number') this.formationY = snap.formationY
    if (typeof snap.direction === 'number') this.direction = snap.direction
    if (typeof snap.stepParity === 'number') this.stepParity = snap.stepParity
    if (typeof snap.stepTimer === 'number') this.stepTimer = snap.stepTimer
    if (typeof snap.alienFireTimer === 'number') this.alienFireTimer = snap.alienFireTimer
    if (Array.isArray(snap.barricades)) this.barricades = cloneState(snap.barricades)
    if (typeof snap.waveMessageMs === 'number') this.waveMessageMs = snap.waveMessageMs
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

  _resetGame() {
    this.score = 0
    this.lives = PLAYER_LIVES
    this.wave = 1
    this.gameOver = false
    this.player = { x: (this.width - PLAYER_W) / 2, invulnMs: 0 }
    this.playerBullets = []
    this.alienBullets = []
    this.particles = []
    this.fireCooldown = 0
    this._startWave(1)
  }

  _startWave(wave) {
    this.wave = wave
    this.aliens = this._buildAliens()
    this.formationX = 0
    this.formationY = FORMATION_TOP
    this.direction = 1
    this.stepParity = 0
    this.stepTimer = 0
    this.alienFireTimer = this._randomFireInterval()
    this.barricades = this._buildBarricades()
    this.waveMessageMs = 1200
  }

  _buildAliens() {
    const totalWidth = (ALIEN_COLS - 1) * ALIEN_COL_SPACING + ALIEN_W
    const startX = (this.width - totalWidth) / 2
    const aliens = []
    for (let row = 0; row < ALIEN_ROWS; row++) {
      for (let col = 0; col < ALIEN_COLS; col++) {
        aliens.push({
          row,
          col,
          type: ROW_TYPE(row),
          localX: startX + col * ALIEN_COL_SPACING,
          localY: row * ALIEN_ROW_SPACING,
          alive: true,
        })
      }
    }
    return aliens
  }

  _buildBarricades() {
    const barricades = []
    const gap = (this.width - BARRICADE_COUNT * BARRICADE_W) / (BARRICADE_COUNT + 1)
    for (let i = 0; i < BARRICADE_COUNT; i++) {
      barricades.push({
        x: gap * (i + 1) + BARRICADE_W * i,
        y: this.height - BARRICADE_Y_OFFSET,
        cells: buildBarricadeShape(),
      })
    }
    return barricades
  }

  _randomFireInterval() {
    const base = Math.max(ALIEN_FIRE_MIN_MS, ALIEN_FIRE_BASE_MS - (this.wave - 1) * ALIEN_FIRE_WAVE_REDUCTION_MS)
    return base * (0.6 + Math.random() * 0.8)
  }

  // --------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------

  _onKeyDown(event) {
    const key = event.key

    if (this.gameOver) {
      if (key === 'r' || key === 'R') this._resetGame()
      return
    }

    if (['ArrowLeft', 'ArrowRight', ' '].includes(key)) event.preventDefault()
    this.keysDown.add(key)

    if (key === ' ' && this.fireCooldown <= 0) {
      this._firePlayerBullet()
    }
  }

  _onKeyUp(event) {
    this.keysDown.delete(event.key)
  }

  _firePlayerBullet() {
    // Classic Invaders: one player shot in flight at a time.
    if (this.playerBullets.length > 0) return
    this.fireCooldown = PLAYER_FIRE_COOLDOWN_MS
    this.playerBullets.push({
      x: this.player.x + PLAYER_W / 2,
      y: this.playerY - 4,
    })
  }

  // --------------------------------------------------------------------
  // Main loop
  // --------------------------------------------------------------------

  _loop(now) {
    if (!this.running) return
    const dt = Math.min(now - this.lastTime, 33)
    this.lastTime = now

    if (!this.gameOver) {
      this._update(dt)
    }
    this._render()

    this.rafId = requestAnimationFrame(this._loop)
  }

  _update(dt) {
    this._updatePlayer(dt)
    this._updateAlienFormation(dt)
    this._updateBullets(dt)
    this._updateAlienFiring(dt)
    this._updateParticles(dt)

    if (this.fireCooldown > 0) this.fireCooldown -= dt
    if (this.player.invulnMs > 0) this.player.invulnMs -= dt
    if (this.waveMessageMs > 0) this.waveMessageMs -= dt

    if (this.aliens.every((a) => !a.alive)) {
      this._startWave(this.wave + 1)
    }
  }

  _updatePlayer(dt) {
    const dtSec = dt / 1000
    let dx = 0
    if (this.keysDown.has('ArrowLeft') || this.keysDown.has('a') || this.keysDown.has('A')) dx -= PLAYER_SPEED * dtSec
    if (this.keysDown.has('ArrowRight') || this.keysDown.has('d') || this.keysDown.has('D')) dx += PLAYER_SPEED * dtSec
    this.player.x = Math.max(PLAY_MARGIN, Math.min(this.width - PLAY_MARGIN - PLAYER_W, this.player.x + dx))
  }

  _updateAlienFormation(dt) {
    const aliveAliens = this.aliens.filter((a) => a.alive)
    if (!aliveAliens.length) return

    const stepMs = Math.max(
      MIN_STEP_MS,
      BASE_STEP_MS - (this.wave - 1) * WAVE_SPEEDUP_MS - (55 - aliveAliens.length) * 12
    )

    this.stepTimer += dt
    if (this.stepTimer < stepMs) return
    this.stepTimer = 0
    this.stepParity = this.stepParity ? 0 : 1

    const minLocalX = Math.min(...aliveAliens.map((a) => a.localX))
    const maxLocalX = Math.max(...aliveAliens.map((a) => a.localX)) + ALIEN_W

    const tentativeX = this.formationX + this.direction * FORMATION_STEP_PX
    const leftEdge = tentativeX + minLocalX
    const rightEdge = tentativeX + maxLocalX

    if (leftEdge < PLAY_MARGIN || rightEdge > this.width - PLAY_MARGIN) {
      this.direction *= -1
      this.formationY += FORMATION_DROP_PX
    } else {
      this.formationX = tentativeX
    }

    // Invasion check: aliens reached the barricade line.
    const maxLocalY = Math.max(...aliveAliens.map((a) => a.localY)) + ALIEN_H
    if (this.formationY + maxLocalY >= this.height - BARRICADE_Y_OFFSET) {
      this.gameOver = true
    }
  }

  _updateBullets(dt) {
    const dtSec = dt / 1000

    for (const bullet of this.playerBullets) bullet.y += PLAYER_BULLET_SPEED * dtSec
    for (const bullet of this.alienBullets) bullet.y += ALIEN_BULLET_SPEED * dtSec

    this.playerBullets = this.playerBullets.filter((b) => b.y > -10)
    this.alienBullets = this.alienBullets.filter((b) => b.y < this.height + 10)

    this._resolvePlayerBulletHits()
    this._resolveAlienBulletHits()
  }

  _resolvePlayerBulletHits() {
    this.playerBullets = this.playerBullets.filter((bullet) => {
      if (this._hitBarricade(bullet.x, bullet.y)) return false

      for (const alien of this.aliens) {
        if (!alien.alive) continue
        const ax = this.formationX + alien.localX
        const ay = this.formationY + alien.localY
        if (bullet.x >= ax && bullet.x <= ax + ALIEN_W && bullet.y >= ay && bullet.y <= ay + ALIEN_H) {
          alien.alive = false
          this.score += ROW_SCORE[alien.type]
          this._spawnExplosion(ax + ALIEN_W / 2, ay + ALIEN_H / 2, ROW_COLOR[alien.type])
          return false
        }
      }
      return true
    })
  }

  _resolveAlienBulletHits() {
    this.alienBullets = this.alienBullets.filter((bullet) => {
      if (this._hitBarricade(bullet.x, bullet.y)) return false

      if (this.player.invulnMs <= 0) {
        const withinX = bullet.x >= this.player.x && bullet.x <= this.player.x + PLAYER_W
        const withinY = bullet.y >= this.playerY && bullet.y <= this.playerY + PLAYER_H
        if (withinX && withinY) {
          this._hitPlayer()
          return false
        }
      }
      return true
    })
  }

  /** Returns true and erodes the barricade if the point hit a live cell. */
  _hitBarricade(x, y) {
    for (const barricade of this.barricades) {
      const localCol = Math.floor((x - barricade.x) / BARRICADE_PIXEL)
      const localRow = Math.floor((y - barricade.y) / BARRICADE_PIXEL)
      if (localCol < 0 || localCol >= BARRICADE_COLS || localRow < 0 || localRow >= BARRICADE_ROWS) continue
      if (!barricade.cells[localRow][localCol]) continue

      // Erode a small neighborhood for a gradual, chunky deterioration look.
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = localRow + dr
          const c = localCol + dc
          if (r >= 0 && r < BARRICADE_ROWS && c >= 0 && c < BARRICADE_COLS && Math.random() < 0.7) {
            barricade.cells[r][c] = false
          }
        }
      }
      return true
    }
    return false
  }

  _updateAlienFiring(dt) {
    const aliveAliens = this.aliens.filter((a) => a.alive)
    if (!aliveAliens.length) return

    this.alienFireTimer -= dt
    if (this.alienFireTimer > 0) return
    this.alienFireTimer = this._randomFireInterval()

    // Pick a random column with at least one alive alien, fire from its
    // bottom-most survivor for an authentic "front line" shooting pattern.
    const columns = new Map()
    for (const alien of aliveAliens) {
      const existing = columns.get(alien.col)
      if (!existing || alien.row > existing.row) columns.set(alien.col, alien)
    }
    const shooters = Array.from(columns.values())
    const shooter = shooters[Math.floor(Math.random() * shooters.length)]
    if (!shooter) return

    const ax = this.formationX + shooter.localX + ALIEN_W / 2
    const ay = this.formationY + shooter.localY + ALIEN_H
    this.alienBullets.push({ x: ax, y: ay })
  }

  _hitPlayer() {
    this.lives -= 1
    this._spawnExplosion(this.player.x + PLAYER_W / 2, this.playerY + PLAYER_H / 2, COLORS.player)
    if (this.lives <= 0) {
      this.gameOver = true
    } else {
      this.player.x = (this.width - PLAYER_W) / 2
      this.player.invulnMs = PLAYER_RESPAWN_INVULN_MS
    }
  }

  _spawnExplosion(x, y, color) {
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 60 + Math.random() * 120
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 400,
        maxLife: 400,
        color,
        size: 2 + Math.random() * 2,
      })
    }
  }

  _updateParticles(dt) {
    if (!this.particles.length) return
    const dtSec = dt / 1000
    for (const p of this.particles) {
      p.x += p.vx * dtSec
      p.y += p.vy * dtSec
      p.vx *= 0.92
      p.vy *= 0.92
      p.life -= dt
    }
    this.particles = this.particles.filter((p) => p.life > 0)
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    drawArenaBackdrop(ctx, this.width, this.height, { step: 36 })

    this._drawGroundLine(ctx)
    this._drawBarricades(ctx)
    this._drawAliens(ctx)
    this._drawBullets(ctx)
    this._drawParticles(ctx)
    this._drawPlayer(ctx)
    this._drawHud(ctx)

    if (this.waveMessageMs > 0 && !this.gameOver) {
      drawNeonText(ctx, `WAVE ${this.wave}`, this.width / 2, this.height / 2, {
        font: `800 28px ${FONT_MONO}`,
        color: THEME.cyan,
        glow: 18,
      })
    }

    if (this.gameOver) {
      this._drawCenterOverlay(ctx, 'GAME OVER', `Score: ${this.score}   —   Press R to Restart`)
    }
  }

  _drawGroundLine(ctx) {
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.3)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PLAY_MARGIN, this.playerY + PLAYER_H + 8)
    ctx.lineTo(this.width - PLAY_MARGIN, this.playerY + PLAYER_H + 8)
    ctx.stroke()
  }

  _drawAliens(ctx) {
    for (const alien of this.aliens) {
      if (!alien.alive) continue
      const ax = this.formationX + alien.localX
      const ay = this.formationY + alien.localY
      const bitmap = SPRITES[alien.type][this.stepParity]
      const color = ROW_COLOR[alien.type]

      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur = 10
      ctx.fillStyle = color
      for (let r = 0; r < bitmap.length; r++) {
        const rowStr = bitmap[r]
        for (let c = 0; c < rowStr.length; c++) {
          if (rowStr[c] !== 'X') continue
          ctx.fillRect(ax + c * ALIEN_PIXEL, ay + r * ALIEN_PIXEL, ALIEN_PIXEL, ALIEN_PIXEL)
        }
      }
      ctx.restore()
    }
  }

  _drawBarricades(ctx) {
    ctx.save()
    ctx.shadowColor = THEME.lime
    ctx.shadowBlur = 8
    ctx.fillStyle = COLORS.barricade
    for (const barricade of this.barricades) {
      for (let r = 0; r < BARRICADE_ROWS; r++) {
        for (let c = 0; c < BARRICADE_COLS; c++) {
          if (!barricade.cells[r][c]) continue
          ctx.fillRect(
            barricade.x + c * BARRICADE_PIXEL,
            barricade.y + r * BARRICADE_PIXEL,
            BARRICADE_PIXEL,
            BARRICADE_PIXEL
          )
        }
      }
    }
    ctx.restore()
  }

  _drawPlayer(ctx) {
    const blinking = this.player.invulnMs > 0 && Math.floor(this.player.invulnMs / 120) % 2 === 0
    if (blinking) return

    const x = this.player.x
    const y = this.playerY
    ctx.save()
    ctx.shadowColor = THEME.cyan
    ctx.shadowBlur = 16
    ctx.fillStyle = THEME.cyan
    // Sleeker cannon: wide base, angled wings, centered muzzle.
    ctx.beginPath()
    ctx.moveTo(x + 2, y + PLAYER_H)
    ctx.lineTo(x + PLAYER_W - 2, y + PLAYER_H)
    ctx.lineTo(x + PLAYER_W - 6, y + 10)
    ctx.lineTo(x + PLAYER_W / 2 + 5, y + 10)
    ctx.lineTo(x + PLAYER_W / 2 + 3, y + 2)
    ctx.lineTo(x + PLAYER_W / 2 - 3, y + 2)
    ctx.lineTo(x + PLAYER_W / 2 - 5, y + 10)
    ctx.lineTo(x + 6, y + 10)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = THEME.ice
    ctx.fillRect(x + PLAYER_W / 2 - 2, y, 4, 8)
    ctx.restore()
  }

  _drawBullets(ctx) {
    ctx.save()
    ctx.shadowColor = THEME.cyan
    ctx.shadowBlur = 10
    ctx.fillStyle = THEME.cyan
    for (const bullet of this.playerBullets) {
      ctx.fillRect(bullet.x - 1.5, bullet.y - 8, 3, 12)
    }
    ctx.shadowColor = THEME.magenta
    ctx.fillStyle = THEME.magenta
    for (const bullet of this.alienBullets) {
      ctx.fillRect(bullet.x - 1.5, bullet.y - 6, 3, 10)
    }
    ctx.restore()
  }

  _drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(p.life / p.maxLife, 0)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  _drawHud(ctx) {
    drawNeonText(ctx, `SCORE ${this.score}`, PLAY_MARGIN, 18, {
      font: `700 16px ${FONT_MONO}`,
      color: THEME.cyan,
      glow: 10,
      align: 'left',
    })
    drawNeonText(ctx, `WAVE ${this.wave}`, PLAY_MARGIN, 38, {
      font: `600 12px ${FONT_MONO}`,
      color: THEME.textDim,
      glow: 0,
      align: 'left',
    })
    drawNeonText(ctx, '▲ '.repeat(this.lives).trim(), this.width - PLAY_MARGIN, 18, {
      font: `700 16px ${FONT_MONO}`,
      color: THEME.magenta,
      glow: 10,
      align: 'right',
    })
  }

  _drawCenterOverlay(ctx, title, subtitle) {
    ctx.save()
    ctx.fillStyle = withAlpha(THEME.bgDeep, 0.82)
    ctx.fillRect(0, 0, this.width, this.height)
    drawNeonText(ctx, title, this.width / 2, this.height / 2 - 12, {
      font: `800 40px ${FONT_MONO}`,
      color: THEME.magenta,
      glow: 20,
    })
    drawNeonText(ctx, subtitle, this.width / 2, this.height / 2 + 28, {
      font: `600 14px ${FONT_MONO}`,
      color: THEME.text,
      glow: 0,
    })
    ctx.restore()
  }
}
