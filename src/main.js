// src/main.js
//
// Application shell for the ephemeral cyberpunk arcade. This file owns the DOM
// chrome only — catalog grid, filters, ad slots, guide panels, the game view
// frame — and delegates every match concern (pre-match modal, engine mount,
// WebRTC room, HUD, teardown) to src/router.js.
//
// Serverless by design: no backend, no cookies, no IndexedDB. The only storage
// touched anywhere is a single short-lived sessionStorage snapshot that lets a
// refresh resume the match in progress; quitting to the hub clears it.
import './style.css'
import { CATALOG, CAPACITY_FILTERS } from './registry.js'
import { gameThumbnail, gameAccent } from './ui/thumbnails.js'
import { createRouter, inviteUrlFor, navigate, buildPath } from './router.js'
import { sfx } from './fx/audio.js'

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

function requireEl(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`[arcade] missing #${id}`)
  return node
}

function bindShell() {
  const filterBarEl = requireEl('filterBar')
  const gameGridEl = requireEl('gameGrid')
  const gameViewEl = requireEl('gameView')
  const legalViewEl = document.getElementById('legalView')
  const legalContentEl = document.getElementById('legalContent')
  const legalBackBtn = document.getElementById('legalBackBtn')
  const activeGameTitleEl = requireEl('activeGameTitle')
  const backToArcadeBtn = requireEl('backToArcadeBtn')
  const brandHomeEl = requireEl('brandHome')

  const canvasEl = requireEl('gameCanvas')
  const canvasWrapEl = document.querySelector('.canvas-wrap')
  if (!canvasWrapEl) throw new Error('[arcade] missing .canvas-wrap')
  const gameOverlayEl = requireEl('gameOverlay')
  const gameOverlayTextEl = requireEl('gameOverlayText')

  const roomShareBarEl = requireEl('roomShareBar')
  const roomShareInputEl = requireEl('roomShareInput')
  const copyRoomBtn = requireEl('copyRoomBtn')
  const copyFeedbackEl = requireEl('copyFeedback')

  const gameGuideEl = requireEl('gameGuide')
  const guideObjectiveEl = requireEl('guideObjective')
  const guideControlsEl = requireEl('guideControls')
  const guideHowToEl = requireEl('guideHowTo')

  return {
    filterBarEl,
    gameGridEl,
    gameViewEl,
    legalViewEl,
    legalContentEl,
    legalBackBtn,
    activeGameTitleEl,
    backToArcadeBtn,
    brandHomeEl,
    canvasEl,
    canvasWrapEl,
    gameOverlayEl,
    gameOverlayTextEl,
    roomShareBarEl,
    roomShareInputEl,
    copyRoomBtn,
    copyFeedbackEl,
    gameGuideEl,
    guideObjectiveEl,
    guideControlsEl,
    guideHowToEl,
  }
}

let shell
try {
  shell = bindShell()
} catch (err) {
  console.warn(err)
}

const {
  filterBarEl,
  gameGridEl,
  gameViewEl,
  legalViewEl,
  legalContentEl,
  legalBackBtn,
  activeGameTitleEl,
  backToArcadeBtn,
  brandHomeEl,
  canvasEl,
  canvasWrapEl,
  gameOverlayEl,
  gameOverlayTextEl,
  roomShareBarEl,
  roomShareInputEl,
  copyRoomBtn,
  copyFeedbackEl,
  gameGuideEl,
  guideObjectiveEl,
  guideControlsEl,
  guideHowToEl,
} = shell || bindShell()

let currentFilter = 'all'

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function activateAdSlot(insEl) {
  if (!insEl || insEl.dataset.adActivated === '1') return
  if (insEl.offsetWidth < 1) return
  insEl.dataset.adActivated = '1'
  insEl.classList.remove('ad-deferred')
  insEl.classList.add('adsbygoogle')
  try {
    window.adsbygoogle = window.adsbygoogle || []
    window.adsbygoogle.push({})
  } catch {
    /* ad blocker or offline */
  }
}

function createGridAdCard(slotId) {
  const card = document.createElement('div')
  card.className = 'ad-slot ad-slot--card'
  card.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = 'ad-slot__label'
  label.textContent = 'Advertisement'

  const ins = document.createElement('ins')
  ins.className = 'ad-deferred'
  ins.style.display = 'block'
  ins.style.width = '100%'
  ins.style.minHeight = '250px'
  ins.dataset.adClient = 'ca-pub-XXXXXXXXXXXXXXXX'
  ins.dataset.adSlot = slotId
  ins.dataset.adFormat = 'rectangle'
  ins.dataset.fullWidthResponsive = 'true'

  card.append(label, ins)
  return card
}

function matchesFilter(game, filterId) {
  const filter = CAPACITY_FILTERS.find((f) => f.id === filterId)
  return filter ? filter.test(game) : true
}

function createGameCard(game) {
  const card = document.createElement('article')
  card.className = 'game-card'
  card.tabIndex = 0
  card.setAttribute('role', 'link')
  card.setAttribute('aria-label', `Play ${game.name}`)
  card.dataset.href = `/games/${game.id}`
  card.style.setProperty('--card-accent', gameAccent(game.id))

  const media = document.createElement('div')
  media.className = 'game-card__media'
  const art = document.createElement('img')
  art.className = 'game-card__img'
  art.src = gameThumbnail(game.id)
  art.width = 320
  art.height = 180
  art.loading = 'lazy'
  art.decoding = 'async'
  art.alt = `${game.name} cover art`
  media.appendChild(art)

  const badge = document.createElement('span')
  badge.className = `game-card__badge${game.capacity === 1 ? ' game-card__badge--solo' : ''}`
  badge.textContent = game.capacity === 1 ? 'Solo' : `${game.capacity}P`
  media.appendChild(badge)

  const scan = document.createElement('span')
  scan.className = 'game-card__scan'
  media.appendChild(scan)
  card.appendChild(media)

  const body = document.createElement('div')
  body.className = 'game-card__body'

  const title = document.createElement('h3')
  title.className = 'game-card__title'
  title.textContent = game.name
  body.appendChild(title)

  const desc = document.createElement('p')
  desc.className = 'game-card__desc'
  desc.textContent = game.description
  body.appendChild(desc)

  const cta = document.createElement('a')
  cta.className = 'game-card__cta'
  cta.href = `/games/${game.id}`
  cta.textContent = game.capacity === 1 ? 'PLAY NOW' : 'SOLO / FRIENDS'
  cta.addEventListener('click', (event) => {
    event.preventDefault()
    activate()
  })
  body.appendChild(cta)
  card.appendChild(body)

  const activate = () => {
    sfx.unlock()
    sfx.confirm()
    router.openGame(game)
  }

  card.addEventListener('click', (event) => {
    if (event.target.closest('a')) return
    activate()
  })
  card.addEventListener('pointerenter', () => sfx.hover())
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate()
    }
  })

  return card
}

function renderGrid(filterId = currentFilter) {
  currentFilter = filterId
  gameGridEl.innerHTML = ''

  const filtered = CATALOG.filter((game) => matchesFilter(game, filterId))

  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'game-grid__empty'
    empty.textContent = 'No games match this filter yet.'
    gameGridEl.appendChild(empty)
    return
  }

  const GRID_AD_SLOTS = ['5555555555', '6666666666']
  const fragment = document.createDocumentFragment()
  let adIndex = 0
  filtered.forEach((game, index) => {
    if (index > 0 && index % 8 === 0 && adIndex < GRID_AD_SLOTS.length) {
      fragment.appendChild(createGridAdCard(GRID_AD_SLOTS[adIndex]))
      adIndex += 1
    }
    fragment.appendChild(createGameCard(game))
  })
  gameGridEl.appendChild(fragment)

  requestAnimationFrame(() => {
    gameGridEl.querySelectorAll('.ad-slot--card .ad-deferred').forEach(activateAdSlot)
  })
}

function setActiveFilterButton(filterId) {
  filterBarEl.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.filter === filterId)
  })
}

filterBarEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.filter-btn')
  if (!btn) return
  sfx.ui()
  const filterId = btn.dataset.filter
  setActiveFilterButton(filterId)
  if (btn.dataset.path) {
    navigate(btn.dataset.path)
    return
  }
  if (filterId === 'all') navigate('/')
  else {
    renderGrid(filterId)
    // Capacity filters stay on home path so shareable URLs stay clean.
    if (location.pathname !== '/') navigate('/', { replace: true })
  }
})

const LEGAL_COPY = {
  privacy: {
    title: 'Privacy Policy',
    html: `<p>PixelGame is an ephemeral browser arcade. We do not create user accounts, and we do not operate a gameplay database. A short-lived <code>sessionStorage</code> snapshot may restore an active match after refresh and is cleared when you return to the arcade grid. Advertising partners such as Google AdSense may set their own cookies subject to your browser settings.</p>`,
  },
  terms: {
    title: 'Terms of Use',
    html: `<p>PixelGame games are provided free of charge for personal entertainment. Do not attempt to reverse-engineer peer networking for abuse. Content is offered as-is without warranties. By playing you agree to use the service lawfully and respectfully.</p>`,
  },
  contact: {
    title: 'Contact',
    html: `<p>Reach PixelGame at <a href="mailto:hello@pixelgame.games">hello@pixelgame.games</a> for partnership, DMCA, or AdSense inquiries. We do not provide account support because PixelGame has no accounts.</p>`,
  },
}

function hideLegalView() {
  if (legalViewEl) legalViewEl.hidden = true
}

function showGridView() {
  hideLegalView()
  gameViewEl.hidden = true
  gameGridEl.hidden = false
  activeGameTitleEl.textContent = ''
  hideRoomShare()
  hideOverlay()
  gameGuideEl.hidden = true
  document.body.classList.remove('is-playing')

  const capacityOnly = ['4', '5', '6', '8plus'].includes(currentFilter)
  if (!capacityOnly) {
    currentFilter = 'all'
    setActiveFilterButton('all')
  }
  renderGrid(currentFilter)
}

function showCategoryView(category) {
  hideLegalView()
  gameViewEl.hidden = true
  gameGridEl.hidden = false
  document.body.classList.remove('is-playing')
  hideRoomShare()
  hideOverlay()
  gameGuideEl.hidden = true

  if (category === 'solo') {
    currentFilter = 'solo'
    setActiveFilterButton('solo')
    renderGrid('solo')
    return
  }
  if (category === 'multiplayer') {
    currentFilter = 'all'
    setActiveFilterButton('all')
    gameGridEl.innerHTML = ''
    const multi = CATALOG.filter((g) => g.capacity > 1)
    const fragment = document.createDocumentFragment()
    multi.forEach((game) => fragment.appendChild(createGameCard(game)))
    gameGridEl.appendChild(fragment)
    return
  }
  showGridView()
}

function showLegalView(page) {
  gameViewEl.hidden = true
  gameGridEl.hidden = true
  document.body.classList.remove('is-playing')
  hideRoomShare()
  hideOverlay()
  if (!legalViewEl || !legalContentEl) {
    showGridView()
    return
  }
  const copy = LEGAL_COPY[page]
  legalViewEl.hidden = false
  legalContentEl.innerHTML = copy
    ? `<h1>${escapeHtml(copy.title)}</h1>${copy.html}`
    : `<h1>Not found</h1><p><a href="/">Return home</a></p>`
}

function showGameView(entry) {
  hideLegalView()
  gameGridEl.hidden = true
  gameViewEl.hidden = false
  activeGameTitleEl.textContent = entry.name
  renderGuide(entry)
  document.body.classList.add('is-playing')
  requestAnimationFrame(() => activateAdSlot(document.getElementById('adGameIns')))
}

function showOverlay(message) {
  gameOverlayTextEl.textContent = message
  gameOverlayEl.hidden = false
}

function hideOverlay() {
  gameOverlayEl.hidden = true
  gameOverlayTextEl.textContent = ''
}

function renderGuide(entry) {
  guideObjectiveEl.textContent = entry.instructions.objective
  guideControlsEl.innerHTML = entry.instructions.controls
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')
  guideHowToEl.innerHTML = entry.instructions.howToPlay
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')
  gameGuideEl.hidden = false
}

function setRoomShare(entry, roomId) {
  roomShareInputEl.value = inviteUrlFor(entry.id, roomId)
  roomShareBarEl.hidden = false
  copyFeedbackEl.textContent = ''
}

function hideRoomShare() {
  roomShareBarEl.hidden = true
  roomShareInputEl.value = ''
  copyFeedbackEl.textContent = ''
}

copyRoomBtn.addEventListener('click', async () => {
  const value = roomShareInputEl.value
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    roomShareInputEl.select()
    try {
      document.execCommand('copy')
    } catch {
      /* clipboard unavailable */
    }
  }
  sfx.ui()
  copyFeedbackEl.textContent = 'Copied!'
  setTimeout(() => {
    copyFeedbackEl.textContent = ''
  }, 2000)
})

const router = createRouter({
  canvas: canvasEl,
  canvasWrap: canvasWrapEl,
  showGridView,
  showGameView,
  showCategoryView,
  showLegalView,
  showOverlay,
  hideOverlay,
  setRoomShare,
  hideRoomShare,
})

backToArcadeBtn.addEventListener('click', () => router.goHome())
if (legalBackBtn) legalBackBtn.addEventListener('click', () => router.goHome())

brandHomeEl.addEventListener('click', (event) => {
  event.preventDefault()
  router.goHome()
})

// Intercept same-origin path links for pushState navigation (no full reload).
document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]')
  if (!anchor) return
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (anchor.target && anchor.target !== '_self') return

  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return

  let url
  try {
    url = new URL(href, location.origin)
  } catch {
    return
  }
  if (url.origin !== location.origin) return

  event.preventDefault()
  navigate(`${url.pathname}${url.search}`)
})

const unlockAudio = () => sfx.unlock()
window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true })
window.addEventListener('keydown', unlockAudio, { once: true })

renderGrid(currentFilter)
router.handleRouteChange()

// Silence unused import warnings in some tooling — buildPath used by SEO pages.
void buildPath
