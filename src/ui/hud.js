// src/ui/hud.js
//
// Floating control HUD mounted over every game canvas.
//
//   [ GAME NAME | MODE ]   FPS · PING · SCORE   [ CRT ] [ SFX ] [ R ] [ ESC ]
//
// The HUD owns the two global match hotkeys (R = restart, Esc = exit to hub)
// and refuses to fire them while the player is typing in a game input — chat
// driven games like Draw & Guess depend on that guard.
//
// destroy() unbinds every listener and removes every node it created, so an
// engine swap can never leak HUD state.

import { sfx } from '../fx/audio.js'
import { isCrtEnabled, toggleCrt } from '../fx/postfx.js'

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

export class GameHUD {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount Canvas wrapper.
   * @param {string} opts.gameName
   * @param {string} [opts.mode] Short mode label, e.g. "SOLO VS AI".
   * @param {() => void} opts.onRestart
   * @param {() => void} opts.onExit
   * @param {boolean} [opts.showPing] Hide the ping readout for offline matches.
   */
  constructor({ mount, gameName, mode = 'SOLO', onRestart, onExit, showPing = false }) {
    this.mount = mount
    this.onRestart = onRestart
    this.onExit = onExit
    this.destroyed = false

    // FPS sampling state (rolling one-second window).
    this._frames = 0
    this._fpsClock = 0
    this._lastFrameAt = 0
    this._fps = 0

    const root = el('div', 'hud')
    this.root = root

    // -- Identity ----------------------------------------------------------
    const identity = el('div', 'hud__identity')
    const dot = el('span', 'hud__live')
    this.nameEl = el('span', 'hud__name', gameName)
    this.modeEl = el('span', 'hud__mode', mode)
    identity.append(dot, this.nameEl, this.modeEl)

    // -- Telemetry ---------------------------------------------------------
    const telemetry = el('div', 'hud__telemetry')
    this.fpsEl = this._stat(telemetry, 'FPS', '—')
    this.pingEl = this._stat(telemetry, 'PING', '—')
    this.pingEl.parentElement.hidden = !showPing
    this.scoreEl = this._stat(telemetry, 'SCORE', '0')
    this.statusEl = el('span', 'hud__status')
    telemetry.appendChild(this.statusEl)

    // -- Controls ----------------------------------------------------------
    const controls = el('div', 'hud__controls')

    this.crtBtn = el('button', 'hud__btn hud__btn--icon', 'CRT')
    this.crtBtn.type = 'button'
    this.crtBtn.title = 'Toggle CRT scanlines'
    this.crtBtn.setAttribute('aria-pressed', String(isCrtEnabled()))
    this.crtBtn.classList.toggle('is-on', isCrtEnabled())

    this.sfxBtn = el('button', 'hud__btn hud__btn--icon', sfx.muted ? 'SFX OFF' : 'SFX ON')
    this.sfxBtn.type = 'button'
    this.sfxBtn.title = 'Toggle sound effects'
    this.sfxBtn.classList.toggle('is-on', !sfx.muted)

    this.restartBtn = el('button', 'hud__btn hud__btn--warn', 'RESTART')
    this.restartBtn.type = 'button'
    this.restartBtn.title = 'Restart match (R)'
    this.restartBtn.appendChild(el('kbd', 'hud__kbd', 'R'))

    this.exitBtn = el('button', 'hud__btn hud__btn--exit', 'EXIT')
    this.exitBtn.type = 'button'
    this.exitBtn.title = 'Exit to hub (Esc)'
    this.exitBtn.appendChild(el('kbd', 'hud__kbd', 'ESC'))

    controls.append(this.crtBtn, this.sfxBtn, this.restartBtn, this.exitBtn)

    root.append(identity, telemetry, controls)
    mount.appendChild(root)

    // -- Listeners ---------------------------------------------------------
    this._onRestartClick = (event) => {
      event.preventDefault()
      event.currentTarget.blur()
      sfx.unlock()
      sfx.ui()
      this.onRestart?.()
    }
    this._onExitClick = (event) => {
      event.preventDefault()
      event.currentTarget.blur()
      sfx.unlock()
      sfx.swipe(false)
      this.onExit?.()
    }
    this._onCrtClick = () => {
      const on = toggleCrt()
      this.crtBtn.classList.toggle('is-on', on)
      this.crtBtn.setAttribute('aria-pressed', String(on))
      sfx.unlock()
      sfx.ui()
    }
    this._onSfxClick = () => {
      sfx.unlock()
      const muted = sfx.toggleMute()
      this.sfxBtn.textContent = muted ? 'SFX OFF' : 'SFX ON'
      this.sfxBtn.classList.toggle('is-on', !muted)
      if (!muted) sfx.ui()
    }
    this._onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        this.onExit?.()
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        // Let the engine handle its own R if it marked the event handled; the
        // arcade-level restart is the fallback and is always authoritative.
        event.preventDefault()
        this.onRestart?.()
      }
    }

    this.restartBtn.addEventListener('click', this._onRestartClick)
    this.exitBtn.addEventListener('click', this._onExitClick)
    this.crtBtn.addEventListener('click', this._onCrtClick)
    this.sfxBtn.addEventListener('click', this._onSfxClick)
    // Capture phase: games bind their own window key handlers, and the HUD must
    // see R/Esc first so a game cannot swallow the exit hotkey.
    window.addEventListener('keydown', this._onKeyDown, true)
  }

  _stat(parent, label, value) {
    const wrap = el('div', 'hud__stat')
    wrap.appendChild(el('span', 'hud__stat-label', label))
    const valueEl = el('span', 'hud__stat-value', value)
    wrap.appendChild(valueEl)
    parent.appendChild(wrap)
    return valueEl
  }

  /** Call once per rendered frame to drive the FPS readout. */
  frame(now = performance.now()) {
    if (this.destroyed) return
    if (this._lastFrameAt) {
      this._fpsClock += now - this._lastFrameAt
      this._frames++
      if (this._fpsClock >= 500) {
        this._fps = Math.round((this._frames * 1000) / this._fpsClock)
        this._frames = 0
        this._fpsClock = 0
        this.fpsEl.textContent = String(this._fps)
        this.fpsEl.dataset.tone = this._fps >= 55 ? 'ok' : this._fps >= 30 ? 'warn' : 'bad'
      }
    }
    this._lastFrameAt = now
  }

  setMode(text) {
    if (this.destroyed) return
    this.modeEl.textContent = text
  }

  setScore(value) {
    if (this.destroyed) return
    this.scoreEl.textContent = String(value)
  }

  setScoreLabel(label) {
    if (this.destroyed) return
    const labelEl = this.scoreEl.parentElement?.querySelector('.hud__stat-label')
    if (labelEl) labelEl.textContent = label
  }

  /** @param {number|null} ms Round-trip time, or null when unknown/offline. */
  setPing(ms) {
    if (this.destroyed) return
    const row = this.pingEl.parentElement
    if (ms == null) {
      this.pingEl.textContent = '—'
      this.pingEl.dataset.tone = 'idle'
      return
    }
    row.hidden = false
    this.pingEl.textContent = `${Math.round(ms)}ms`
    this.pingEl.dataset.tone = ms < 90 ? 'ok' : ms < 200 ? 'warn' : 'bad'
  }

  showPing(show) {
    if (this.destroyed) return
    this.pingEl.parentElement.hidden = !show
  }

  /** Short right-of-telemetry note, e.g. "WAITING FOR PEERS". */
  setStatus(text) {
    if (this.destroyed) return
    this.statusEl.textContent = text || ''
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.restartBtn.removeEventListener('click', this._onRestartClick)
    this.exitBtn.removeEventListener('click', this._onExitClick)
    this.crtBtn.removeEventListener('click', this._onCrtClick)
    this.sfxBtn.removeEventListener('click', this._onSfxClick)
    window.removeEventListener('keydown', this._onKeyDown, true)
    this.root.remove()
    this.onRestart = null
    this.onExit = null
  }
}
