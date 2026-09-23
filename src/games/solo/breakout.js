// src/games/solo/breakout.js
//
// Neon brick breaker: mouse + arrow-key paddle tracking, angle-of-incidence
// ball deflection based on paddle strike point, a multi-layered brick wall
// with 1-3 hit points per brick, and falling power-ups (widen paddle,
// multi-ball split, laser shot). All state lives in RAM — no localStorage,
// no cookies, nothing survives a refresh.
//
// Implements the standard arcade GameEngine interface:
//   constructor(canvas, p2pContext) / start() / stop() /
//   onPeerAction(data, peerId) / onPeerJoin(peerId) / onPeerLeave(peerId)
//
// This is a solo game, so `p2pContext` is always null and the peer hooks
// are no-ops — they exist purely to satisfy the shared interface contract.

import { cloneState } from '../shared/snapshot.js'
import { THEME, FONT_MONO, FONT_UI, drawArenaBackdrop, drawNeonText, withAlpha } from '../../fx/theme.js'

const PLAY_MARGIN = 20
const PADDLE_Y_OFFSET = 36
const PADDLE_BASE_WIDTH = 110
const PADDLE_WIDE_WIDTH = 160
const PADDLE_HEIGHT = 14
const PADDLE_SPEED = 620 // px/sec via keyboard

const BALL_RADIUS = 8
const BALL_BASE_SPEED = 360
const BALL_MAX_SPEED = 620
const MAX_BOUNCE_ANGLE = (72 * Math.PI) / 180

const BRICK_ROWS = 6
const BRICK_COLS = 12
const BRICK_TOP = 70
const BRICK_HEIGHT = 20
const BRICK_GAP = 4
const BRICK_SIDE_MARGIN = 24

const POWERUP_DROP_CHANCE = 0.16
const POWERUP_FALL_SPEED = 140
const POWERUP_DURATION_MS = 9000
const LASER_COOLDOWN_MS = 260
const LASER_SPEED = 640

const STARTING_LIVES = 3

const COLORS = {
  background: '#0b0f19',
  wall: 'rgba(0, 229, 255, 0.25)',
  paddle: '#00e5ff',
  paddleGlow: 'rgba(0, 229, 255, 0.6)',
  ball: '#eaf2ff',
  ballGlow: 'rgba(255, 255, 255, 0.6)',
  text: '#eaf2ff',
  textDim: '#93a2c2',
  accent: '#00e5ff',
  danger: '#ff007f',
  laser: '#39ff14',
}

// Brick hit-point tiers -> color + score value. hp3 bricks are toughest and
// step down through the tiers (changing color) as they take damage.
const HP_COLORS = {
  3: '#ff007f',
  2: '#00e5ff',
  1: '#39ff14',
}
const HP_SCORE = { 3: 30, 2: 20, 1: 10 }

const POWERUP_TYPES = {
  WIDEN: { key: 'WIDEN', label: 'W', color: '#00e5ff' },
  MULTI: { key: 'MULTI', label: 'M', color: '#ff007f' },
  LASER: { key: 'LASER', label: 'L', color: '#39ff14' },
}
const POWERUP_KEYS = Object.keys(POWERUP_TYPES)

export default class BreakoutGame {
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

    this.playLeft = PLAY_MARGIN
    this.playRight = this.width - PLAY_MARGIN
    this.playTop = PLAY_MARGIN
    this.paddleY = this.height - PADDLE_Y_OFFSET

    this.running = false
    this.rafId = null
    this.lastTime = 0

    this.keysDown = new Set()

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onKeyUp = this._onKeyUp.bind(this)
    this._onMouseMove = this._onMouseMove.bind(this)
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
    this.canvas.addEventListener('mousemove', this._onMouseMove)
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
    this.canvas.removeEventListener('mousemove', this._onMouseMove)
  }

  getMatchSnapshot() {
    return {
      kind: 'solo',
      score: this.score,
      lives: this.lives,
      level: this.level,
      gameOver: this.gameOver,
      won: this.won,
      paddle: cloneState(this.paddle),
      widenTimer: this.widenTimer,
      laserTimer: this.laserTimer,
      laserCooldown: this.laserCooldown,
      lasers: cloneState(this.lasers),
      particles: cloneState(this.particles),
      powerups: cloneState(this.powerups),
      launched: this.launched,
      bricks: cloneState(this.bricks),
      balls: cloneState(this.balls),
    }
  }

  applyMatchSnapshot(snap) {
    if (!snap || snap.kind !== 'solo') return false
    if (typeof snap.score === 'number') this.score = snap.score
    if (typeof snap.lives === 'number') this.lives = snap.lives
    if (typeof snap.level === 'number') this.level = snap.level
    if (typeof snap.gameOver === 'boolean') this.gameOver = snap.gameOver
    if (typeof snap.won === 'boolean') this.won = snap.won
    if (snap.paddle && typeof snap.paddle === 'object') this.paddle = cloneState(snap.paddle)
    if (typeof snap.widenTimer === 'number') this.widenTimer = snap.widenTimer
    if (typeof snap.laserTimer === 'number') this.laserTimer = snap.laserTimer
    if (typeof snap.laserCooldown === 'number') this.laserCooldown = snap.laserCooldown
    if (Array.isArray(snap.lasers)) this.lasers = cloneState(snap.lasers)
    if (Array.isArray(snap.particles)) this.particles = cloneState(snap.particles)
    if (Array.isArray(snap.powerups)) this.powerups = cloneState(snap.powerups)
    if (typeof snap.launched === 'boolean') this.launched = snap.launched
    if (Array.isArray(snap.bricks)) this.bricks = cloneState(snap.bricks)
    if (Array.isArray(snap.balls)) this.balls = cloneState(snap.balls)
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
    this.lives = STARTING_LIVES
    this.level = 1
    this.gameOver = false
    this.won = false
    this._resetLevel(true)
  }

  _resetLevel(newBricks) {
    this.paddle = {
      x: (this.width - PADDLE_BASE_WIDTH) / 2,
      width: PADDLE_BASE_WIDTH,
    }
    this.widenTimer = 0
    this.laserTimer = 0
    this.laserCooldown = 0
    this.lasers = []
    this.particles = []
    this.powerups = []
    this.launched = false

    if (newBricks) {
      this.bricks = this._buildBricks()
    }

    this.balls = [this._spawnBallOnPaddle()]
  }

  _buildBricks() {
    const bricks = []
    const totalGapWidth = BRICK_GAP * (BRICK_COLS - 1)
    const brickWidth =
      (this.width - BRICK_SIDE_MARGIN * 2 - totalGapWidth) / BRICK_COLS

    for (let row = 0; row < BRICK_ROWS; row++) {
      // Difficulty ramps toward the top: back rows are tougher.
      const hp = row < 2 ? 3 : row < 4 ? 2 : 1
      for (let col = 0; col < BRICK_COLS; col++) {
        bricks.push({
          x: BRICK_SIDE_MARGIN + col * (brickWidth + BRICK_GAP),
          y: BRICK_TOP + row * (BRICK_HEIGHT + BRICK_GAP),
          w: brickWidth,
          h: BRICK_HEIGHT,
          hp,
          maxHp: hp,
          alive: true,
        })
      }
    }
    return bricks
  }

  _spawnBallOnPaddle() {
    return {
      x: this.paddle.x + this.paddle.width / 2,
      y: this.paddleY - BALL_RADIUS - 1,
      vx: 0,
      vy: 0,
      speed: BALL_BASE_SPEED,
      stuck: true,
    }
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

    if (key === ' ') {
      if (!this.launched) {
        this._launchBalls()
      } else if (this.laserTimer > 0 && this.laserCooldown <= 0) {
        this._fireLaser()
      }
    }
  }

  _onKeyUp(event) {
    this.keysDown.delete(event.key)
  }

  _onMouseMove(event) {
    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.canvas.width / rect.width
    const mouseX = (event.clientX - rect.left) * scaleX
    this._movePaddleTo(mouseX - this.paddle.width / 2)
  }

  _movePaddleTo(x) {
    const clamped = Math.max(this.playLeft, Math.min(this.playRight - this.paddle.width, x))
    const delta = clamped - this.paddle.x
    this.paddle.x = clamped
    // Any stuck ball rides along with the paddle before launch.
    if (!this.launched) {
      for (const ball of this.balls) {
        if (ball.stuck) ball.x += delta
      }
    }
  }

  _launchBalls() {
    this.launched = true
    for (const ball of this.balls) {
      if (!ball.stuck) continue
      ball.stuck = false
      const angle = -Math.PI / 2 + (Math.random() * 0.5 - 0.25)
      ball.vx = Math.sin(angle) * ball.speed
      ball.vy = Math.cos(angle) * ball.speed // negative-ish (upward bias below)
      ball.vy = -Math.abs(Math.cos(angle)) * ball.speed
    }
  }

  _fireLaser() {
    this.laserCooldown = LASER_COOLDOWN_MS
    this.lasers.push({ x: this.paddle.x + 12, y: this.paddleY })
    this.lasers.push({ x: this.paddle.x + this.paddle.width - 12, y: this.paddleY })
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
    const dtSec = dt / 1000

    this._updatePaddleFromKeys(dt)
    this._updateTimers(dt)
    this._updateBalls(dtSec)
    this._updateLasers(dtSec)
    this._updatePowerups(dtSec)
    this._updateParticles(dt)

    if (!this.won && this.bricks.every((b) => !b.alive)) {
      this._advanceLevel()
    }
  }

  _updatePaddleFromKeys(dt) {
    const dtSec = dt / 1000
    let dx = 0
    if (this.keysDown.has('ArrowLeft') || this.keysDown.has('a') || this.keysDown.has('A')) {
      dx -= PADDLE_SPEED * dtSec
    }
    if (this.keysDown.has('ArrowRight') || this.keysDown.has('d') || this.keysDown.has('D')) {
      dx += PADDLE_SPEED * dtSec
    }
    if (dx !== 0) this._movePaddleTo(this.paddle.x + dx)
  }

  _updateTimers(dt) {
    if (this.widenTimer > 0) {
      this.widenTimer -= dt
      if (this.widenTimer <= 0) {
        this.widenTimer = 0
        this.paddle.width = PADDLE_BASE_WIDTH
        this.paddle.x = Math.min(this.paddle.x, this.playRight - this.paddle.width)
      }
    }
    if (this.laserTimer > 0) {
      this.laserTimer -= dt
      if (this.laserTimer < 0) this.laserTimer = 0
    }
    if (this.laserCooldown > 0) this.laserCooldown -= dt
  }

  _updateBalls(dtSec) {
    for (const ball of this.balls) {
      if (ball.stuck) {
        ball.x = this.paddle.x + this.paddle.width / 2
        ball.y = this.paddleY - BALL_RADIUS - 1
        continue
      }

      ball.x += ball.vx * dtSec
      ball.y += ball.vy * dtSec

      // Walls.
      if (ball.x - BALL_RADIUS <= this.playLeft) {
        ball.x = this.playLeft + BALL_RADIUS
        ball.vx = Math.abs(ball.vx)
      } else if (ball.x + BALL_RADIUS >= this.playRight) {
        ball.x = this.playRight - BALL_RADIUS
        ball.vx = -Math.abs(ball.vx)
      }
      if (ball.y - BALL_RADIUS <= this.playTop) {
        ball.y = this.playTop + BALL_RADIUS
        ball.vy = Math.abs(ball.vy)
      }

      this._resolvePaddleCollision(ball)
      this._resolveBrickCollisions(ball)
    }

    // Remove balls that fell below the paddle.
    const before = this.balls.length
    this.balls = this.balls.filter((ball) => ball.stuck || ball.y - BALL_RADIUS < this.height)

    if (this.balls.length === 0) {
      this._loseLife()
    } else if (this.balls.length < before) {
      // A ball was lost but others remain in play — no life penalty.
    }
  }

  _resolvePaddleCollision(ball) {
    if (ball.vy <= 0) return // only care about downward-moving balls
    const paddleTop = this.paddleY
    const paddleBottom = this.paddleY + PADDLE_HEIGHT
    const withinX = ball.x + BALL_RADIUS >= this.paddle.x && ball.x - BALL_RADIUS <= this.paddle.x + this.paddle.width
    const withinY = ball.y + BALL_RADIUS >= paddleTop && ball.y - BALL_RADIUS <= paddleBottom

    if (withinX && withinY) {
      // Deflection angle based on where the ball struck the paddle.
      const paddleCenter = this.paddle.x + this.paddle.width / 2
      const relative = (ball.x - paddleCenter) / (this.paddle.width / 2)
      const clampedRelative = Math.max(-1, Math.min(1, relative))
      const angle = clampedRelative * MAX_BOUNCE_ANGLE

      ball.vx = Math.sin(angle) * ball.speed
      ball.vy = -Math.cos(angle) * ball.speed
      ball.y = paddleTop - BALL_RADIUS - 0.5
    }
  }

  _resolveBrickCollisions(ball) {
    for (const brick of this.bricks) {
      if (!brick.alive) continue
      if (
        ball.x + BALL_RADIUS < brick.x ||
        ball.x - BALL_RADIUS > brick.x + brick.w ||
        ball.y + BALL_RADIUS < brick.y ||
        ball.y - BALL_RADIUS > brick.y + brick.h
      ) {
        continue
      }

      // Determine which axis to reflect based on penetration depth.
      const overlapLeft = ball.x + BALL_RADIUS - brick.x
      const overlapRight = brick.x + brick.w - (ball.x - BALL_RADIUS)
      const overlapTop = ball.y + BALL_RADIUS - brick.y
      const overlapBottom = brick.y + brick.h - (ball.y - BALL_RADIUS)
      const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom)

      if (minOverlap === overlapTop || minOverlap === overlapBottom) {
        ball.vy = -ball.vy
      } else {
        ball.vx = -ball.vx
      }

      this._damageBrick(brick)
      break // one brick per frame per ball keeps physics stable
    }
  }

  _damageBrick(brick) {
    brick.hp -= 1
    this._spawnHitParticles(brick)

    if (brick.hp <= 0) {
      brick.alive = false
      this.score += HP_SCORE[brick.maxHp] || 10
      if (Math.random() < POWERUP_DROP_CHANCE) {
        this._spawnPowerup(brick)
      }
    }
  }

  _spawnPowerup(brick) {
    const type = POWERUP_TYPES[POWERUP_KEYS[Math.floor(Math.random() * POWERUP_KEYS.length)]]
    this.powerups.push({
      x: brick.x + brick.w / 2,
      y: brick.y + brick.h / 2,
      type,
    })
  }

  _updateLasers(dtSec) {
    for (const laser of this.lasers) {
      laser.y -= LASER_SPEED * dtSec
    }
    this.lasers = this.lasers.filter((laser) => laser.y > this.playTop)

    for (const laser of this.lasers) {
      for (const brick of this.bricks) {
        if (!brick.alive) continue
        if (
          laser.x >= brick.x &&
          laser.x <= brick.x + brick.w &&
          laser.y >= brick.y &&
          laser.y <= brick.y + brick.h
        ) {
          this._damageBrick(brick)
          laser.y = -999 // mark for removal
          break
        }
      }
    }
    this.lasers = this.lasers.filter((laser) => laser.y > this.playTop)
  }

  _updatePowerups(dtSec) {
    for (const powerup of this.powerups) {
      powerup.y += POWERUP_FALL_SPEED * dtSec
    }

    const remaining = []
    for (const powerup of this.powerups) {
      if (powerup.y > this.height) continue

      const withinX = powerup.x >= this.paddle.x && powerup.x <= this.paddle.x + this.paddle.width
      const withinY = powerup.y >= this.paddleY && powerup.y <= this.paddleY + PADDLE_HEIGHT
      if (withinX && withinY) {
        this._applyPowerup(powerup.type)
      } else {
        remaining.push(powerup)
      }
    }
    this.powerups = remaining
  }

  _applyPowerup(type) {
    if (type.key === 'WIDEN') {
      this.paddle.width = PADDLE_WIDE_WIDTH
      this.paddle.x = Math.max(
        this.playLeft,
        Math.min(this.paddle.x, this.playRight - this.paddle.width)
      )
      this.widenTimer = POWERUP_DURATION_MS
    } else if (type.key === 'MULTI') {
      const extras = []
      for (const ball of this.balls) {
        if (ball.stuck) continue
        for (let i = 0; i < 2; i++) {
          const spreadAngle = (i === 0 ? -1 : 1) * (Math.PI / 8)
          const baseAngle = Math.atan2(ball.vy, ball.vx) + spreadAngle
          extras.push({
            x: ball.x,
            y: ball.y,
            vx: Math.cos(baseAngle) * ball.speed,
            vy: Math.sin(baseAngle) * ball.speed,
            speed: ball.speed,
            stuck: false,
          })
        }
      }
      this.balls.push(...extras)
    } else if (type.key === 'LASER') {
      this.laserTimer = POWERUP_DURATION_MS
    }
  }

  _spawnHitParticles(brick) {
    const cx = brick.x + brick.w / 2
    const cy = brick.y + brick.h / 2
    const color = HP_COLORS[brick.hp] || HP_COLORS[1]
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 60 + Math.random() * 100
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 350,
        maxLife: 350,
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
      p.vx *= 0.94
      p.vy *= 0.94
      p.life -= dt
    }
    this.particles = this.particles.filter((p) => p.life > 0)
  }

  _loseLife() {
    this.lives -= 1
    if (this.lives <= 0) {
      this.gameOver = true
      this.won = false
    } else {
      this._resetLevel(false)
    }
  }

  _advanceLevel() {
    this.level += 1
    this.score += 100 // level clear bonus
    this._resetLevel(true)
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------

  _render() {
    const ctx = this.ctx
    drawArenaBackdrop(ctx, this.width, this.height, { step: 40 })

    this._drawWalls(ctx)
    this._drawBricks(ctx)
    this._drawPowerups(ctx)
    this._drawLasers(ctx)
    this._drawParticles(ctx)
    this._drawPaddle(ctx)
    this._drawBalls(ctx)
    this._drawHud(ctx)

    if (!this.launched && !this.gameOver) {
      drawNeonText(ctx, 'PRESS SPACE TO LAUNCH', this.width / 2, this.height / 2, {
        font: `700 18px ${FONT_MONO}`,
        color: THEME.cyan,
        glow: 14,
      })
    }

    if (this.gameOver) {
      this._drawCenterOverlay(ctx, 'GAME OVER', `Score: ${this.score}   —   Press R to Restart`)
    }
  }

  _drawWalls(ctx) {
    ctx.strokeStyle = withAlpha(THEME.cyan, 0.35)
    ctx.lineWidth = 2
    ctx.strokeRect(this.playLeft, this.playTop, this.playRight - this.playLeft, this.height - this.playTop - 8)
  }

  _drawBricks(ctx) {
    for (const brick of this.bricks) {
      if (!brick.alive) continue
      ctx.fillStyle = HP_COLORS[brick.hp] || HP_COLORS[1]
      ctx.save()
      ctx.shadowColor = ctx.fillStyle
      ctx.shadowBlur = 6
      ctx.fillRect(brick.x, brick.y, brick.w, brick.h)
      ctx.restore()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.w - 1, brick.h - 1)
    }
  }

  _drawPaddle(ctx) {
    ctx.save()
    ctx.shadowColor = COLORS.paddleGlow
    ctx.shadowBlur = this.laserTimer > 0 ? 14 : 10
    ctx.fillStyle = this.laserTimer > 0 ? COLORS.laser : COLORS.paddle
    this._roundRect(ctx, this.paddle.x, this.paddleY, this.paddle.width, PADDLE_HEIGHT, 6)
    ctx.fill()
    ctx.restore()
  }

  _drawBalls(ctx) {
    for (const ball of this.balls) {
      ctx.save()
      ctx.shadowColor = COLORS.ballGlow
      ctx.shadowBlur = 10
      ctx.fillStyle = COLORS.ball
      ctx.beginPath()
      ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  _drawLasers(ctx) {
    ctx.strokeStyle = COLORS.laser
    ctx.lineWidth = 3
    ctx.save()
    ctx.shadowColor = COLORS.laser
    ctx.shadowBlur = 8
    for (const laser of this.lasers) {
      ctx.beginPath()
      ctx.moveTo(laser.x, laser.y)
      ctx.lineTo(laser.x, laser.y + 12)
      ctx.stroke()
    }
    ctx.restore()
  }

  _drawPowerups(ctx) {
    for (const powerup of this.powerups) {
      ctx.save()
      ctx.shadowColor = powerup.type.color
      ctx.shadowBlur = 10
      ctx.fillStyle = powerup.type.color
      this._roundRect(ctx, powerup.x - 14, powerup.y - 10, 28, 20, 5)
      ctx.fill()
      ctx.restore()

      ctx.fillStyle = '#0b0f19'
      ctx.font = 'bold 12px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(powerup.type.label, powerup.x, powerup.y + 1)
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
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
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = 'bold 18px monospace'
    ctx.fillStyle = COLORS.accent
    ctx.fillText(`SCORE ${this.score}`, this.playLeft, 4)

    ctx.font = '13px monospace'
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(`LEVEL ${this.level}`, this.playLeft, 26)

    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.danger
    ctx.font = 'bold 16px monospace'
    ctx.fillText('♥ '.repeat(this.lives).trim(), this.playRight, 4)

    if (this.widenTimer > 0 || this.laserTimer > 0) {
      ctx.font = '12px monospace'
      ctx.fillStyle = COLORS.textDim
      const labels = []
      if (this.widenTimer > 0) labels.push('WIDE PADDLE')
      if (this.laserTimer > 0) labels.push('LASER ARMED')
      ctx.fillText(labels.join('  •  '), this.playRight, 26)
    }
    ctx.textAlign = 'left'
  }

  _drawCenterMessage(ctx, text, color) {
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 20px monospace'
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.fillText(text, this.width / 2, this.paddleY - 60)
    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  _drawCenterOverlay(ctx, title, subtitle) {
    ctx.save()
    ctx.fillStyle = 'rgba(11, 15, 25, 0.8)'
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.font = 'bold 44px monospace'
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
