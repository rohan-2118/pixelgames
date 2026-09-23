/**
 * Quick smoke: session resume save/load for snake + trivia.
 */
import { saveMatchResume, loadMatchResume, clearMatchResume, resumeKey } from '../src/persist/matchResume.js'

// jsdom-less: fake sessionStorage
const store = new Map()
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

clearMatchResume()
const meta = { gameId: 'snake', roomId: null, mode: 'solo', host: false }
saveMatchResume(meta, { kind: 'solo', score: 42, snake: [1, 2, 3] })
const loaded = loadMatchResume(meta)
if (!loaded || loaded.score !== 42) throw new Error('resume load failed')
if (loadMatchResume({ ...meta, gameId: 'tetris' })) throw new Error('should not match other game')
clearMatchResume()
if (loadMatchResume(meta)) throw new Error('clear failed')
console.log('resume persist OK', resumeKey(meta.gameId, meta.roomId, meta.mode, meta.host))

globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.performance = { now: () => Date.now() }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}

function makeCanvas() {
  const noop = () => {}
  const s = {}
  const ctx = new Proxy({}, { get: (_, p) => (p === 'measureText' ? (t) => ({ width: String(t).length * 7 }) : s[p] ?? noop), set: (_, p, v) => ((s[p] = v), true) })
  return { width: 960, height: 540, getContext: () => ctx, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }) }
}

const { default: Snake } = await import('../src/games/solo/snake.js')
const snake = new Snake(makeCanvas(), null)
snake.start()
// mutate if possible
if (snake.score != null) snake.score = 99
else if (snake.state?.score != null) snake.state.score = 99
const snap = snake.getMatchSnapshot()
const snake2 = new Snake(makeCanvas(), null)
const ok = snake2.applyMatchSnapshot(snap)
if (!ok) throw new Error('snake apply failed')
console.log('snake snapshot OK', snap.kind || typeof snap)

const { default: Trivia } = await import('../src/games/multiplayer/trivia8.js')
const p2p = { isHost: true, broadcast() {}, sendTo() {}, getPeers: () => [] }
const t = new Trivia(makeCanvas(), p2p)
t._hostLobbyStart()
const ts = t.getMatchSnapshot()
const t2 = new Trivia(makeCanvas(), p2p)
if (!t2.applyMatchSnapshot(ts)) throw new Error('trivia apply failed')
if (t2.state.phase === 'lobby') throw new Error('trivia should resume mid-match, phase=' + t2.state.phase)
console.log('trivia snapshot OK phase=', t2.state.phase)

console.log('ALL RESUME SMOKE PASSED')
