// src/ui/prematch.js
//
// Universal pre-match overlay. Every multiplayer game routes through this
// before an engine is constructed, so the player always picks a lane first:
//
//   OPTION A — SOLO VS AI BOT ....... local heuristic bots, no WebRTC at all
//   OPTION B — PLAY WITH FRIENDS .... mint a room code + copy invite, or paste
//                                     a friend's code and connect over WebRTC
//
// Pure DOM (glassmorphism from style.css) mounted over the canvas frame. The
// returned handle's destroy() removes every node and listener it created.

import { sfx } from '../fx/audio.js'

/** Normalise anything a user might paste into a canonical room code. */
export function normalizeRoomCode(raw) {
  if (!raw) return ''
  let value = String(raw).trim()

  // Full invite link pasted: pull room from query string or legacy hash.
  try {
    if (/^https?:\/\//i.test(value) || value.includes('/games/') || value.includes('?')) {
      const url = new URL(value, typeof location !== 'undefined' ? location.origin : 'https://pixelgame.games')
      const fromQuery = url.searchParams.get('room')
      if (fromQuery) value = fromQuery
    }
  } catch {
    /* not a URL — fall through */
  }

  const hashIndex = value.indexOf('#')
  if (hashIndex !== -1) {
    const params = new URLSearchParams(value.slice(hashIndex + 1))
    const fromHash = params.get('room')
    if (fromHash) value = fromHash
  }

  value = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (value.length < 3) return value
  if (/^[A-Z]{2}\d{3}$/.test(value)) return `${value.slice(0, 2)}-${value.slice(2)}`
  return value
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.mount Container (the canvas wrapper).
 * @param {object} opts.game Registry entry ({ id, name, capacity, description }).
 * @param {string} opts.roomCode Pre-minted code for the "friends" lane.
 * @param {string} opts.inviteUrl Full shareable URL for that code.
 * @param {() => void} opts.onSolo
 * @param {() => void} opts.onHost
 * @param {(code: string) => void} opts.onJoin
 * @param {() => void} opts.onBack
 * @returns {{ destroy: () => void, setBusy: (msg: string|null) => void }}
 */
export function mountPreMatch({
  mount,
  game,
  roomCode,
  inviteUrl,
  onSolo,
  onHost,
  onJoin,
  onBack,
}) {
  const root = el('div', 'prematch')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', `${game.name} — select match mode`)

  const shell = el('div', 'prematch__shell')

  // ---- Header -------------------------------------------------------------
  const head = el('header', 'prematch__head')
  const eyebrow = el('span', 'prematch__eyebrow', 'Match Configuration')
  const title = el('h2', 'prematch__title', game.name)
  const meta = el('div', 'prematch__meta')
  meta.appendChild(el('span', 'prematch__chip', `${game.capacity} PLAYER MAX`))
  meta.appendChild(el('span', 'prematch__chip prematch__chip--dim', 'P2P WEBRTC · NO ACCOUNTS'))
  head.append(eyebrow, title, meta)
  if (game.description) head.appendChild(el('p', 'prematch__blurb', game.description))
  shell.appendChild(head)

  // ---- Option grid --------------------------------------------------------
  const grid = el('div', 'prematch__grid')

  // OPTION A — Solo vs AI
  const solo = el('section', 'pm-card pm-card--solo')
  solo.appendChild(el('span', 'pm-card__tag', 'Option A'))
  solo.appendChild(el('h3', 'pm-card__title', 'Solo vs AI Bot'))
  solo.appendChild(el('p', 'pm-card__sub', 'Instant boot · 0 ms latency · fully offline'))
  const soloList = el('ul', 'pm-card__list')
  for (const line of [
    'Heuristic bot AI with steering + predictive aim',
    'Every empty seat filled locally in RAM',
    'No room code, no peers, no waiting',
  ]) {
    soloList.appendChild(el('li', null, line))
  }
  solo.appendChild(soloList)
  const soloBtn = el('button', 'pm-btn pm-btn--primary', 'BOOT SOLO MATCH')
  soloBtn.type = 'button'
  solo.appendChild(soloBtn)
  grid.appendChild(solo)

  // OPTION B — Play with friends
  const friends = el('section', 'pm-card pm-card--friends')
  friends.appendChild(el('span', 'pm-card__tag pm-card__tag--alt', 'Option B'))
  friends.appendChild(el('h3', 'pm-card__title', 'Play With Friends'))
  friends.appendChild(el('p', 'pm-card__sub', 'Share the code — bots fill any seat left open'))

  const codeRow = el('div', 'pm-code')
  codeRow.appendChild(el('span', 'pm-code__label', 'Your Room Code'))
  const codeValue = el('strong', 'pm-code__value', roomCode)
  codeRow.appendChild(codeValue)
  friends.appendChild(codeRow)

  const copyBtn = el('button', 'pm-btn pm-btn--accent', 'COPY INVITE LINK')
  copyBtn.type = 'button'
  friends.appendChild(copyBtn)

  const hostBtn = el('button', 'pm-btn pm-btn--outline', 'OPEN ROOM & WAIT')
  hostBtn.type = 'button'
  friends.appendChild(hostBtn)

  const divider = el('div', 'pm-divider')
  divider.appendChild(el('span', null, "or join a friend's room"))
  friends.appendChild(divider)

  const joinRow = el('form', 'pm-join')
  const joinInput = el('input', 'pm-join__input')
  joinInput.type = 'text'
  joinInput.placeholder = 'NX-842'
  joinInput.maxLength = 64
  joinInput.autocomplete = 'off'
  joinInput.spellcheck = false
  joinInput.setAttribute('aria-label', 'Room code to join')
  const joinBtn = el('button', 'pm-btn pm-btn--connect', 'CONNECT')
  joinBtn.type = 'submit'
  joinRow.append(joinInput, joinBtn)
  friends.appendChild(joinRow)

  const status = el('p', 'pm-status')
  status.setAttribute('role', 'status')
  friends.appendChild(status)

  grid.appendChild(friends)
  shell.appendChild(grid)

  // ---- Footer -------------------------------------------------------------
  const foot = el('footer', 'prematch__foot')
  const backBtn = el('button', 'pm-link', '← Back to hub')
  backBtn.type = 'button'
  foot.appendChild(backBtn)
  foot.appendChild(el('span', 'prematch__foot-note', 'Nothing is stored — closing the tab erases the match.'))
  shell.appendChild(foot)

  const busy = el('div', 'prematch__busy')
  busy.hidden = true
  const busySpinner = el('div', 'prematch__spinner')
  const busyText = el('p', 'prematch__busy-text', 'Connecting…')
  busy.append(busySpinner, busyText)
  shell.appendChild(busy)

  root.appendChild(shell)
  mount.appendChild(root)

  // ---- Behaviour ----------------------------------------------------------
  let destroyed = false
  let statusTimer = null

  function setStatus(message, tone = 'info') {
    status.textContent = message || ''
    status.dataset.tone = tone
    if (statusTimer) clearTimeout(statusTimer)
    if (message) {
      statusTimer = setTimeout(() => {
        if (!destroyed) status.textContent = ''
      }, 3200)
    }
  }

  function setBusy(message) {
    busy.hidden = !message
    if (message) busyText.textContent = message
    shell.classList.toggle('is-busy', !!message)
  }

  const onSoloClick = () => {
    sfx.unlock()
    sfx.confirm()
    setBusy('Spinning up bots…')
    onSolo()
  }

  const onCopyClick = async () => {
    sfx.unlock()
    sfx.ui()
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setStatus('Invite link copied to clipboard', 'ok')
    } catch {
      // Clipboard API blocked (insecure context / permissions): fall back to a
      // throwaway textarea so the button still works everywhere.
      const scratch = document.createElement('textarea')
      scratch.value = inviteUrl
      scratch.setAttribute('readonly', '')
      scratch.style.position = 'fixed'
      scratch.style.opacity = '0'
      document.body.appendChild(scratch)
      scratch.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(scratch)
      setStatus(ok ? 'Invite link copied to clipboard' : inviteUrl, ok ? 'ok' : 'info')
    }
    copyBtn.textContent = 'LINK COPIED ✓'
    setTimeout(() => {
      if (!destroyed) copyBtn.textContent = 'COPY INVITE LINK'
    }, 1800)
  }

  const onHostClick = () => {
    sfx.unlock()
    sfx.confirm()
    setBusy('Opening room ' + roomCode + '…')
    onHost()
  }

  const onJoinSubmit = (event) => {
    event.preventDefault()
    sfx.unlock()
    const code = normalizeRoomCode(joinInput.value)
    if (code.length < 4) {
      sfx.deny()
      setStatus('Enter a valid room code (e.g. NX-842)', 'error')
      joinInput.focus()
      return
    }
    if (code === roomCode) {
      sfx.deny()
      setStatus('That is your own room — press "Open room" instead', 'error')
      return
    }
    sfx.confirm()
    setBusy(`Connecting to ${code}…`)
    onJoin(code)
  }

  const onBackClick = () => {
    sfx.ui()
    onBack()
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onBackClick()
    }
  }

  const onPointerOver = (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('.pm-btn')) sfx.hover()
  }

  soloBtn.addEventListener('click', onSoloClick)
  copyBtn.addEventListener('click', onCopyClick)
  hostBtn.addEventListener('click', onHostClick)
  joinRow.addEventListener('submit', onJoinSubmit)
  backBtn.addEventListener('click', onBackClick)
  root.addEventListener('pointerover', onPointerOver)
  window.addEventListener('keydown', onKeyDown)

  // Normalise as the user types so the field always reads like a room code.
  const onJoinInput = () => {
    const caretAtEnd = joinInput.selectionStart === joinInput.value.length
    const next = normalizeRoomCode(joinInput.value)
    if (next !== joinInput.value) {
      joinInput.value = next
      if (caretAtEnd) joinInput.setSelectionRange(next.length, next.length)
    }
  }
  joinInput.addEventListener('input', onJoinInput)

  requestAnimationFrame(() => {
    if (!destroyed) soloBtn.focus({ preventScroll: true })
  })

  return {
    setStatus,
    setBusy,
    destroy() {
      if (destroyed) return
      destroyed = true
      if (statusTimer) clearTimeout(statusTimer)
      soloBtn.removeEventListener('click', onSoloClick)
      copyBtn.removeEventListener('click', onCopyClick)
      hostBtn.removeEventListener('click', onHostClick)
      joinRow.removeEventListener('submit', onJoinSubmit)
      backBtn.removeEventListener('click', onBackClick)
      joinInput.removeEventListener('input', onJoinInput)
      root.removeEventListener('pointerover', onPointerOver)
      window.removeEventListener('keydown', onKeyDown)
      root.remove()
    },
  }
}
