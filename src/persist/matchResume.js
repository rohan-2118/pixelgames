// src/persist/matchResume.js
//
// In-tab match resume. The arcade stays serverless and does not use
// localStorage/cookies/IndexedDB. We only keep a short-lived snapshot in
// sessionStorage so a refresh can restore the active match. Leaving the
// game (Back to Arcade) or an explicit restart clears it.

const KEY = 'browser-arcade:match-resume:v1'
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

export function resumeKey(gameId, roomId, mode, host) {
  return `${gameId}|${roomId || ''}|${mode || 'solo'}|${host ? '1' : '0'}`
}

export function saveMatchResume(meta, data) {
  if (!data || typeof data !== 'object') return false
  try {
    const payload = {
      key: resumeKey(meta.gameId, meta.roomId, meta.mode, meta.host),
      gameId: meta.gameId,
      roomId: meta.roomId || null,
      mode: meta.mode || 'solo',
      host: !!meta.host,
      savedAt: Date.now(),
      data,
    }
    sessionStorage.setItem(KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function loadMatchResume(meta) {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const payload = JSON.parse(raw)
    if (!payload || payload.key !== resumeKey(meta.gameId, meta.roomId, meta.mode, meta.host)) {
      return null
    }
    if (Date.now() - (payload.savedAt || 0) > MAX_AGE_MS) {
      clearMatchResume()
      return null
    }
    return payload.data
  } catch {
    return null
  }
}

export function clearMatchResume() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

export function hasMatchResume(meta) {
  return !!loadMatchResume(meta)
}
