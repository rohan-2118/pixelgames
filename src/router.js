// src/router.js
//
// Match lifecycle + HTML5 History API routing. `main.js` owns the DOM shell
// (grid, guide, ads, header) and hands this module a small `shell` adapter.
//
// Route shapes
//   /                                          → arcade grid
//   /category/solo | /category/multiplayer     → filtered catalog
//   /games/snake                               → solo game boots immediately
//   /games/tank4                               → pre-match overlay (dual mode)
//   /games/tank4?mode=ai                       → local match, bots only
//   /games/tank4?room=NX-842&mode=multi&host=true|false  → WebRTC mesh
//   /privacy | /terms | /contact               → legal pages
//
// Legacy `#game=…` hashes are migrated once via replaceState.

import { getGameById } from './registry.js'
import { createRoom } from './network/room.js'
import { loadMatchResume, saveMatchResume, clearMatchResume } from './persist/matchResume.js'
import { mountPreMatch } from './ui/prematch.js'
import { GameHUD } from './ui/hud.js'
import { sfx } from './fx/audio.js'
import { THEME, FONT_MONO, FONT_UI, drawArenaBackdrop, drawNeonText, withAlpha } from './fx/theme.js'

export const MODE = { SOLO: 'solo', AI: 'ai', MULTI: 'multi' }

const ROOM_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Mint a 6-character room code in the canonical "NX-842" shape. */
export function generateRoomCode() {
  const a = ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]
  const b = ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]
  const digits = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `${a}${b}-${digits}`
}

/**
 * Build a clean path URL for History API navigation.
 * @param {{ game?: string, room?: string, mode?: string, host?: boolean, category?: string, page?: string }} opts
 */
export function buildPath({ game, room, mode, host, category, page } = {}) {
  if (page) return `/${page}`
  if (category) return `/category/${category}`
  if (!game) return '/'

  const params = new URLSearchParams()
  if (room) params.set('room', room)
  if (mode) params.set('mode', mode)
  if (typeof host === 'boolean') params.set('host', String(host))
  const query = params.toString()
  return `/games/${encodeURIComponent(game)}${query ? `?${query}` : ''}`
}

/** @deprecated Use buildPath — kept for any leftover call sites. */
export const buildHash = buildPath

/** Normalize pathname (strip trailing slash except root). */
export function normalizePathname(pathname = location.pathname) {
  if (!pathname || pathname === '/') return '/'
  return pathname.replace(/\/+$/, '') || '/'
}

/**
 * Parse the current History API location into a route object.
 * Also migrates legacy `#game=` hashes into clean paths.
 */
export function parseRoute() {
  // One-shot migration from hash routing → path routing.
  if (typeof location !== 'undefined' && location.hash && /(?:^|[&#])game=/.test(location.hash)) {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
    const hp = new URLSearchParams(raw)
    const migrated = buildPath({
      game: hp.get('game') || undefined,
      room: hp.get('room') || undefined,
      mode: hp.get('mode') || undefined,
      host: hp.get('host') === 'true' ? true : hp.get('host') === 'false' ? false : undefined,
    })
    history.replaceState(null, '', migrated)
  }

  const path = normalizePathname()
  const params = new URLSearchParams(location.search)

  if (path === '/privacy' || path === '/terms' || path === '/contact') {
    return {
      type: 'legal',
      page: path.slice(1),
      game: null,
      room: null,
      mode: null,
      host: false,
      category: null,
    }
  }

  if (path.startsWith('/category/')) {
    const category = path.slice('/category/'.length)
    return {
      type: 'category',
      category: category === 'solo' || category === 'multiplayer' ? category : null,
      game: null,
      room: null,
      mode: null,
      host: false,
      page: null,
    }
  }

  if (path.startsWith('/games/')) {
    const game = decodeURIComponent(path.slice('/games/'.length).split('/')[0] || '')
    const hostParam = params.get('host')
    return {
      type: 'game',
      game: game || null,
      room: params.get('room'),
      mode: params.get('mode'),
      host: hostParam === 'true',
      category: null,
      page: null,
    }
  }

  return {
    type: 'home',
    game: null,
    room: null,
    mode: null,
    host: false,
    category: null,
    page: null,
  }
}

/** @deprecated Use parseRoute. */
export const parseHash = parseRoute

export function inviteUrlFor(gameId, roomCode) {
  const path = buildPath({
    game: gameId,
    room: roomCode,
    mode: MODE.MULTI,
    host: false,
  })
  return `${location.origin}${path}`
}

/**
 * Push or replace a History entry and notify listeners.
 * @param {string} url
 * @param {{ replace?: boolean }} [opts]
 */
export function navigate(url, { replace = false } = {}) {
  const next = url || '/'
  const current = `${normalizePathname()}${location.search}`
  if (current === next) {
    window.dispatchEvent(new PopStateEvent('popstate'))
    return
  }
  if (replace) history.replaceState(null, '', next)
  else history.pushState(null, '', next)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function safeCall(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') return undefined
  try {
    return target[method](...args)
  } catch (err) {
    console.error(`[arcade] "${method}" threw:`, err)
    return undefined
  }
}

/**
 * @param {object} shell
 * @param {HTMLCanvasElement} shell.canvas
 * @param {HTMLElement} shell.canvasWrap
 * @param {(entry: object) => void} shell.showGameView
 * @param {() => void} shell.showGridView
 * @param {(category?: string|null) => void} [shell.showCategoryView]
 * @param {(page: string) => void} [shell.showLegalView]
 * @param {(text: string) => void} shell.showOverlay
 * @param {() => void} shell.hideOverlay
 * @param {(entry: object, roomId: string) => void} shell.setRoomShare
 * @param {() => void} shell.hideRoomShare
 */
export function createRouter(shell) {
  const { canvas, canvasWrap } = shell

  let engine = null
  let room = null
  let hud = null
  let prematch = null
  let matchMeta = null
  let p2pContext = null
  let entryRef = null
  let routeRef = null
  let bootToken = 0
  let resumeTimer = null
  let telemetryFrame = null
  let attractFrame = null
  let clearResumeOnTeardown = false

  function startAttract(gameEntry) {
    stopAttract()
    const ctx = canvas.getContext('2d')
    const started = performance.now()
    const step = (now) => {
      const t = now - started
      drawArenaBackdrop(ctx, canvas.width, canvas.height, { step: 48 })
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const sweepX = ((t * 0.09) % (canvas.width + 420)) - 210
      const sweep = ctx.createLinearGradient(sweepX - 180, 0, sweepX + 180, canvas.height)
      sweep.addColorStop(0, 'rgba(0,240,255,0)')
      sweep.addColorStop(0.5, withAlpha(THEME.cyan, 0.05))
      sweep.addColorStop(1, 'rgba(0,240,255,0)')
      ctx.fillStyle = sweep
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      drawNeonText(ctx, gameEntry.name.toUpperCase(), canvas.width / 2, canvas.height / 2 - 6, {
        font: `800 46px ${FONT_UI}`,
        color: withAlpha(THEME.cyan, 0.16),
        glow: 0,
      })
      drawNeonText(ctx, 'STANDBY // SELECT MATCH MODE', canvas.width / 2, canvas.height / 2 + 30, {
        font: `600 13px ${FONT_MONO}`,
        color: withAlpha(THEME.textFaint, 0.5 + 0.3 * Math.sin(t * 0.003)),
        glow: 0,
      })
      attractFrame = requestAnimationFrame(step)
    }
    attractFrame = requestAnimationFrame(step)
  }

  function stopAttract() {
    if (attractFrame != null) {
      cancelAnimationFrame(attractFrame)
      attractFrame = null
    }
  }

  function clearCanvas() {
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = THEME.bgDeep
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function startTelemetry() {
    stopTelemetry()
    let lastPoll = 0
    const step = (now) => {
      if (!hud) return
      hud.frame(now)
      if (now - lastPoll > 240) {
        lastPoll = now
        hud.setPing(room ? room.getPing() : null)
        const stats = safeCall(engine, 'getHudStats')
        if (stats && typeof stats === 'object') {
          if (stats.label != null) hud.setScoreLabel(String(stats.label))
          if (stats.score != null) hud.setScore(stats.score)
          if (stats.status != null) hud.setStatus(String(stats.status))
        } else if (engine && typeof engine.score === 'number') {
          hud.setScore(engine.score)
        }
      }
      telemetryFrame = requestAnimationFrame(step)
    }
    telemetryFrame = requestAnimationFrame(step)
  }

  function stopTelemetry() {
    if (telemetryFrame != null) {
      cancelAnimationFrame(telemetryFrame)
      telemetryFrame = null
    }
  }

  function persistActiveMatch() {
    if (!engine || !matchMeta) return
    const data = safeCall(engine, 'getMatchSnapshot')
    if (!data) return
    saveMatchResume(matchMeta, data)
  }

  function startResumeAutosave() {
    stopResumeAutosave()
    resumeTimer = setInterval(persistActiveMatch, 2000)
  }

  function stopResumeAutosave() {
    if (resumeTimer != null) {
      clearInterval(resumeTimer)
      resumeTimer = null
    }
  }

  function teardown({ preserveResume = false, keepRoom = false, keepHud = false } = {}) {
    stopResumeAutosave()
    stopAttract()

    if (preserveResume) {
      persistActiveMatch()
    } else if (clearResumeOnTeardown) {
      clearMatchResume()
    }

    if (engine) {
      safeCall(engine, 'stop')
      engine = null
    }

    if (!keepRoom && room) {
      try {
        const result = room.leave()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch (err) {
        console.error('[arcade] error leaving room:', err)
      }
      room = null
      p2pContext = null
    }

    if (!keepHud) {
      stopTelemetry()
      if (hud) {
        hud.destroy()
        hud = null
      }
    }

    if (prematch) {
      prematch.destroy()
      prematch = null
    }

    if (!keepRoom && !keepHud) {
      matchMeta = null
      entryRef = null
      routeRef = null
      clearResumeOnTeardown = false
      clearCanvas()
    }
  }

  function showPreMatch(gameEntry) {
    shell.hideOverlay()
    shell.hideRoomShare()
    const roomCode = generateRoomCode()
    startAttract(gameEntry)

    prematch = mountPreMatch({
      mount: canvasWrap,
      game: gameEntry,
      roomCode,
      inviteUrl: inviteUrlFor(gameEntry.id, roomCode),
      onSolo: () => {
        navigate(buildPath({ game: gameEntry.id, mode: MODE.AI }))
      },
      onHost: () => {
        navigate(
          buildPath({
            game: gameEntry.id,
            room: roomCode,
            mode: MODE.MULTI,
            host: true,
          }),
        )
      },
      onJoin: (code) => {
        navigate(
          buildPath({
            game: gameEntry.id,
            room: code,
            mode: MODE.MULTI,
            host: false,
          }),
        )
      },
      onBack: () => goHome(),
    })
  }

  function createOfflineContext(gameEntry) {
    const resolved = Promise.resolve()
    return {
      isHost: true,
      soloAi: true,
      offline: true,
      roomId: null,
      maxPlayers: gameEntry.capacity,
      broadcast: () => resolved,
      sendTo: () => resolved,
      broadcastSync: () => resolved,
      sendSyncTo: () => resolved,
      getPeers: () => [],
      getSelfId: () => 'local',
      getPing: () => null,
    }
  }

  function mountEngine(GameEngineClass, gameEntry, { isSoloAi, applyResume }) {
    let instance
    try {
      instance = new GameEngineClass(canvas, p2pContext)
    } catch (err) {
      console.error(`[arcade] failed to construct "${gameEntry.id}":`, err)
      shell.showOverlay(`"${gameEntry.name}" failed to start.`)
      return null
    }

    if (applyResume) {
      const resumeData = loadMatchResume(matchMeta)
      if (resumeData) {
        const applied = safeCall(instance, 'applyMatchSnapshot', resumeData)
        if (!applied) clearMatchResume()
      }
    }

    engine = instance
    shell.hideOverlay()
    safeCall(engine, 'start')

    if (isSoloAi) safeCall(engine, 'startSoloMatch')

    persistActiveMatch()
    startResumeAutosave()
    return engine
  }

  async function bootMatch(gameEntry, route) {
    const token = ++bootToken
    const isSoloAi = route.mode === MODE.AI && gameEntry.capacity > 1
    const isMultiplayer = gameEntry.capacity > 1 && route.mode === MODE.MULTI
    const roomId = route.room || null

    if (isMultiplayer && !roomId) {
      navigate(buildPath({ game: gameEntry.id }), { replace: true })
      return
    }

    shell.showOverlay(`Loading ${gameEntry.name}…`)

    let GameEngineClass
    try {
      const module = await import(`./games/${gameEntry.category}/${gameEntry.id}.js`)
      GameEngineClass = module.default
    } catch (err) {
      console.error(`[arcade] failed to load module "${gameEntry.id}":`, err)
      if (token === bootToken) {
        shell.showOverlay(`"${gameEntry.name}" could not be loaded. Please try another game.`)
      }
      return
    }
    if (token !== bootToken) return
    if (typeof GameEngineClass !== 'function') {
      shell.showOverlay(`"${gameEntry.name}" isn't available yet — check back soon.`)
      return
    }

    matchMeta = {
      gameId: gameEntry.id,
      roomId,
      mode: isMultiplayer ? MODE.MULTI : isSoloAi ? MODE.AI : MODE.SOLO,
      host: isMultiplayer ? !!route.host : true,
    }
    entryRef = gameEntry
    routeRef = { ...route }

    if (isMultiplayer) {
      shell.setRoomShare(gameEntry, roomId)
      p2pContext = {
        isHost: !!route.host,
        soloAi: false,
        offline: false,
        roomId,
        maxPlayers: gameEntry.capacity,
        broadcast: (data) => (room ? room.broadcast(data) : Promise.resolve()),
        sendTo: (peerId, data) => (room ? room.sendTo(peerId, data) : Promise.resolve()),
        broadcastSync: (data) => (room ? room.broadcastSync(data) : Promise.resolve()),
        sendSyncTo: (peerId, data) => (room ? room.sendSyncTo(peerId, data) : Promise.resolve()),
        getPeers: () => (room ? room.getPeers() : []),
        getSelfId: () => (room ? room.getSelfId() : 'local'),
        getPing: () => (room ? room.getPing() : null),
      }
      room = createRoom(gameEntry.id, roomId, !!route.host, gameEntry.capacity, {
        onPeerJoin: (peerId) => safeCall(engine, 'onPeerJoin', peerId),
        onPeerLeave: (peerId) => safeCall(engine, 'onPeerLeave', peerId),
        onGameAction: (data, peerId) => safeCall(engine, 'onPeerAction', data, peerId),
        onHostSync: (data, peerId) => safeCall(engine, 'onPeerAction', data, peerId),
        onRoomFull: () => {
          shell.showOverlay('This room is full. Returning to the arcade…')
          setTimeout(() => {
            if (token === bootToken) goHome()
          }, 1800)
        },
      })
    } else {
      shell.hideRoomShare()
      p2pContext = gameEntry.capacity > 1 ? createOfflineContext(gameEntry) : null
    }

    if (token !== bootToken) {
      if (room) room.leave().catch(() => {})
      room = null
      return
    }

    const modeLabel = isMultiplayer
      ? `${route.host ? 'HOSTING' : 'JOINED'} · ${roomId}`
      : isSoloAi
        ? 'SOLO VS AI'
        : 'SOLO'
    hud = new GameHUD({
      mount: canvasWrap,
      gameName: gameEntry.name,
      mode: modeLabel,
      showPing: isMultiplayer,
      onRestart: () => restartMatch(),
      onExit: () => goHome(),
    })
    startTelemetry()

    mountEngine(GameEngineClass, gameEntry, { isSoloAi, applyResume: true })
    if (isSoloAi) sfx.matchStart()
  }

  async function restartMatch() {
    if (!entryRef || !routeRef) return
    clearMatchResume()

    const gameEntry = entryRef
    const route = routeRef
    const isSoloAi = route.mode === MODE.AI && gameEntry.capacity > 1

    if (engine) {
      safeCall(engine, 'stop')
      engine = null
    }
    clearCanvas()

    let GameEngineClass
    try {
      const module = await import(`./games/${gameEntry.category}/${gameEntry.id}.js`)
      GameEngineClass = module.default
    } catch (err) {
      console.error('[arcade] restart failed to reload module:', err)
      shell.showOverlay('Restart failed. Returning to the arcade…')
      setTimeout(goHome, 1500)
      return
    }
    if (!entryRef) return

    if (hud) {
      hud.setScore(0)
      hud.setStatus('')
    }
    mountEngine(GameEngineClass, gameEntry, { isSoloAi, applyResume: false })
    sfx.matchStart()
  }

  function goHome() {
    clearResumeOnTeardown = true
    clearMatchResume()
    navigate('/')
  }

  async function handleRouteChange() {
    const route = parseRoute()

    if (route.type === 'legal') {
      clearResumeOnTeardown = true
      teardown()
      if (typeof shell.showLegalView === 'function') shell.showLegalView(route.page)
      else shell.showGridView()
      return
    }

    if (route.type === 'category') {
      clearResumeOnTeardown = true
      teardown()
      if (typeof shell.showCategoryView === 'function') shell.showCategoryView(route.category)
      else shell.showGridView()
      return
    }

    if (route.type === 'home' || !route.game) {
      clearResumeOnTeardown = true
      teardown()
      shell.showGridView()
      return
    }

    const gameEntry = getGameById(route.game)
    if (!gameEntry) {
      clearMatchResume()
      teardown()
      shell.showGridView()
      return
    }

    const sameMatch =
      matchMeta &&
      matchMeta.gameId === route.game &&
      (matchMeta.roomId || null) === (route.room || null) &&
      matchMeta.mode === (route.mode || MODE.SOLO)
    if (sameMatch && engine) return

    teardown()
    shell.showGameView(gameEntry)

    // Solo titles boot immediately; multiplayer without mode hits prematch.
    const needsPreMatch = gameEntry.capacity > 1 && !route.mode
    if (needsPreMatch) {
      entryRef = gameEntry
      showPreMatch(gameEntry)
      return
    }

    // Capacity-1 games treat missing mode as solo.
    const bootRoute = {
      ...route,
      mode: route.mode || (gameEntry.capacity === 1 ? MODE.SOLO : route.mode),
    }
    await bootMatch(gameEntry, bootRoute)
  }

  const onPageHide = () => {
    if (!engine) return
    persistActiveMatch()
    teardown({ preserveResume: true })
  }
  window.addEventListener('beforeunload', onPageHide)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('popstate', handleRouteChange)

  return {
    handleRouteChange,
    restartMatch,
    goHome,
    teardown,
    navigate,
    openGame(gameEntry) {
      const path =
        gameEntry.capacity === 1
          ? buildPath({ game: gameEntry.id, mode: MODE.SOLO })
          : buildPath({ game: gameEntry.id })
      navigate(path)
    },
    get activeEngine() {
      return engine
    },
    get activeRoomId() {
      return matchMeta ? matchMeta.roomId : null
    },
  }
}
