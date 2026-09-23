// src/games/shared/botSketch.js
//
// Deterministic stroke recipes for bot artists. Drawing games call
// `buildWordSketch(word, bounds)` once per turn and drip the returned
// segments onto the board so Solo vs AI produces recognizable silhouettes
// instead of random scribbles.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/** Hash a string into a stable [0,1) float. */
function hash01(str, salt = 0) {
  let h = 2166136261 ^ salt
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

function poly(points, color, size) {
  const segs = []
  for (let i = 1; i < points.length; i++) {
    segs.push({
      x0: points[i - 1][0],
      y0: points[i - 1][1],
      x1: points[i][0],
      y1: points[i][1],
      color,
      size,
    })
  }
  return segs
}

function oval(cx, cy, rx, ry, color, size, steps = 18) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  }
  return poly(pts, color, size)
}

function rect(x, y, w, h, color, size) {
  return poly(
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ],
    color,
    size,
  )
}

function line(x0, y0, x1, y1, color, size) {
  return [{ x0, y0, x1, y1, color, size }]
}

/**
 * Build a list of stroke segments that loosely depict `word` inside `bounds`.
 * Always returns something drawable — unknown words get a letter-shaped glyph.
 *
 * @param {string} word
 * @param {{x:number,y:number,w:number,h:number}} bounds
 * @param {{color?:string, size?:number}} [opts]
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number,color:string,size:number}>}
 */
export function buildWordSketch(word, bounds, opts = {}) {
  const raw = String(word || 'thing').toLowerCase().trim()
  const color = opts.color || '#00f0ff'
  const size = opts.size || 5
  const cx = bounds.x + bounds.w * 0.5
  const cy = bounds.y + bounds.h * 0.52
  const s = Math.min(bounds.w, bounds.h) * 0.28
  const jitter = (n) => (hash01(raw, n) - 0.5) * s * 0.08

  const recipes = {
    apple: () => [
      ...oval(cx + jitter(1), cy + s * 0.1, s * 0.7, s * 0.75, color, size),
      ...line(cx, cy - s * 0.7, cx + s * 0.15, cy - s * 1.05, color, size - 1),
      ...oval(cx + s * 0.35, cy - s * 0.55, s * 0.28, s * 0.14, '#39ff14', size - 1, 10),
    ],
    robot: () => [
      ...rect(cx - s * 0.7, cy - s * 0.5, s * 1.4, s * 1.2, color, size),
      ...oval(cx - s * 0.3, cy - s * 0.1, s * 0.14, s * 0.14, color, size, 8),
      ...oval(cx + s * 0.3, cy - s * 0.1, s * 0.14, s * 0.14, color, size, 8),
      ...line(cx - s * 0.35, cy + s * 0.35, cx + s * 0.35, cy + s * 0.35, color, size),
      ...line(cx, cy - s * 0.5, cx, cy - s * 0.95, color, size - 1),
      ...oval(cx, cy - s * 1.05, s * 0.12, s * 0.12, color, size - 1, 8),
    ],
    rocket: () => [
      ...poly(
        [
          [cx, cy - s * 1.1],
          [cx + s * 0.45, cy + s * 0.2],
          [cx + s * 0.2, cy + s * 0.55],
          [cx - s * 0.2, cy + s * 0.55],
          [cx - s * 0.45, cy + s * 0.2],
          [cx, cy - s * 1.1],
        ],
        color,
        size,
      ),
      ...line(cx - s * 0.15, cy + s * 0.55, cx - s * 0.35, cy + s * 1.0, '#ff0055', size),
      ...line(cx + s * 0.15, cy + s * 0.55, cx + s * 0.35, cy + s * 1.0, '#ff0055', size),
      ...line(cx, cy + s * 0.55, cx, cy + s * 1.05, '#ffb300', size),
    ],
    house: () => [
      ...rect(cx - s * 0.7, cy - s * 0.1, s * 1.4, s * 0.95, color, size),
      ...poly(
        [
          [cx - s * 0.9, cy - s * 0.1],
          [cx, cy - s * 1.0],
          [cx + s * 0.9, cy - s * 0.1],
        ],
        color,
        size,
      ),
      ...rect(cx - s * 0.15, cy + s * 0.25, s * 0.3, s * 0.6, color, size - 1),
    ],
    tree: () => [
      ...line(cx, cy + s * 0.9, cx, cy - s * 0.1, '#ffb300', size + 1),
      ...oval(cx, cy - s * 0.45, s * 0.7, s * 0.65, '#39ff14', size),
      ...oval(cx - s * 0.25, cy - s * 0.15, s * 0.35, s * 0.3, '#39ff14', size - 1, 10),
    ],
    car: () => [
      ...rect(cx - s * 0.95, cy - s * 0.1, s * 1.9, s * 0.55, color, size),
      ...poly(
        [
          [cx - s * 0.45, cy - s * 0.1],
          [cx - s * 0.2, cy - s * 0.55],
          [cx + s * 0.45, cy - s * 0.55],
          [cx + s * 0.7, cy - s * 0.1],
        ],
        color,
        size,
      ),
      ...oval(cx - s * 0.5, cy + s * 0.5, s * 0.22, s * 0.22, color, size, 10),
      ...oval(cx + s * 0.55, cy + s * 0.5, s * 0.22, s * 0.22, color, size, 10),
    ],
    cat: () => [
      ...oval(cx, cy + s * 0.15, s * 0.75, s * 0.55, color, size),
      ...oval(cx, cy - s * 0.45, s * 0.45, s * 0.4, color, size),
      ...poly([[cx - s * 0.35, cy - s * 0.55], [cx - s * 0.55, cy - s * 1.0], [cx - s * 0.1, cy - s * 0.65]], color, size),
      ...poly([[cx + s * 0.35, cy - s * 0.55], [cx + s * 0.55, cy - s * 1.0], [cx + s * 0.1, cy - s * 0.65]], color, size),
      ...oval(cx - s * 0.15, cy - s * 0.45, s * 0.06, s * 0.06, color, size, 6),
      ...oval(cx + s * 0.15, cy - s * 0.45, s * 0.06, s * 0.06, color, size, 6),
    ],
    dog: () => [
      ...oval(cx, cy + s * 0.1, s * 0.8, s * 0.5, color, size),
      ...oval(cx + s * 0.7, cy - s * 0.15, s * 0.35, s * 0.3, color, size),
      ...oval(cx + s * 0.95, cy - s * 0.35, s * 0.12, s * 0.2, color, size - 1, 8),
      ...line(cx - s * 0.7, cy + s * 0.35, cx - s * 1.15, cy - s * 0.2, color, size),
    ],
    fish: () => [
      ...oval(cx - s * 0.1, cy, s * 0.85, s * 0.45, color, size),
      ...poly([[cx + s * 0.65, cy], [cx + s * 1.2, cy - s * 0.4], [cx + s * 1.2, cy + s * 0.4], [cx + s * 0.65, cy]], color, size),
      ...oval(cx - s * 0.45, cy - s * 0.08, s * 0.08, s * 0.08, color, size, 6),
    ],
    moon: () => [
      ...oval(cx, cy, s * 0.85, s * 0.85, color, size),
      ...oval(cx + s * 0.28, cy - s * 0.08, s * 0.7, s * 0.7, '#080c14', size + 2),
    ],
    sun: () => [
      ...oval(cx, cy, s * 0.55, s * 0.55, '#ffb300', size),
      ...line(cx, cy - s * 1.05, cx, cy - s * 0.7, '#ffb300', size - 1),
      ...line(cx, cy + s * 0.7, cx, cy + s * 1.05, '#ffb300', size - 1),
      ...line(cx - s * 1.05, cy, cx - s * 0.7, cy, '#ffb300', size - 1),
      ...line(cx + s * 0.7, cy, cx + s * 1.05, cy, '#ffb300', size - 1),
    ],
    star: () => {
      const pts = []
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const r = i % 2 === 0 ? s : s * 0.42
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
      }
      pts.push(pts[0])
      return poly(pts, '#ffb300', size)
    },
    pizza: () => [
      ...poly([[cx, cy - s], [cx + s * 0.9, cy + s * 0.7], [cx - s * 0.9, cy + s * 0.7], [cx, cy - s]], color, size),
      ...oval(cx - s * 0.15, cy - s * 0.1, s * 0.1, s * 0.1, '#ff0055', size - 1, 6),
      ...oval(cx + s * 0.25, cy + s * 0.15, s * 0.1, s * 0.1, '#ff0055', size - 1, 6),
      ...oval(cx - s * 0.25, cy + s * 0.3, s * 0.1, s * 0.1, '#ff0055', size - 1, 6),
    ],
    guitar: () => [
      ...oval(cx, cy + s * 0.35, s * 0.55, s * 0.7, color, size),
      ...rect(cx - s * 0.12, cy - s * 1.05, s * 0.24, s * 1.0, color, size),
      ...line(cx - s * 0.08, cy - s * 1.05, cx - s * 0.08, cy + s * 0.2, color, size - 2),
      ...line(cx + s * 0.08, cy - s * 1.05, cx + s * 0.08, cy + s * 0.2, color, size - 2),
    ],
    umbrella: () => [
      ...poly(
        [
          [cx - s, cy],
          [cx, cy - s * 0.85],
          [cx + s, cy],
          [cx - s, cy],
        ],
        color,
        size,
      ),
      ...line(cx, cy, cx, cy + s * 0.85, color, size),
      ...oval(cx + s * 0.2, cy + s * 0.85, s * 0.22, s * 0.18, color, size - 1, 8),
    ],
    castle: () => [
      ...rect(cx - s * 0.9, cy - s * 0.2, s * 1.8, s * 1.0, color, size),
      ...rect(cx - s * 0.9, cy - s * 0.7, s * 0.35, s * 0.5, color, size),
      ...rect(cx - s * 0.18, cy - s * 0.7, s * 0.35, s * 0.5, color, size),
      ...rect(cx + s * 0.55, cy - s * 0.7, s * 0.35, s * 0.5, color, size),
      ...rect(cx - s * 0.2, cy + s * 0.2, s * 0.4, s * 0.6, color, size - 1),
    ],
    dragon: () => [
      ...oval(cx - s * 0.2, cy, s * 1.0, s * 0.45, color, size),
      ...oval(cx + s * 0.7, cy - s * 0.25, s * 0.35, s * 0.28, color, size),
      ...poly([[cx - s * 0.3, cy - s * 0.2], [cx - s * 0.1, cy - s * 0.95], [cx + s * 0.3, cy - s * 0.25]], '#39ff14', size),
      ...line(cx - s * 1.1, cy + s * 0.1, cx - s * 1.5, cy - s * 0.35, color, size),
    ],
    heart: () => [
      ...poly(
        [
          [cx, cy + s * 0.85],
          [cx - s * 0.95, cy - s * 0.05],
          [cx - s * 0.45, cy - s * 0.75],
          [cx, cy - s * 0.35],
          [cx + s * 0.45, cy - s * 0.75],
          [cx + s * 0.95, cy - s * 0.05],
          [cx, cy + s * 0.85],
        ],
        '#ff0055',
        size,
      ),
    ],
  }

  // Alias common synonyms / bank words onto recipes.
  const aliases = {
    bicycle: 'car',
    snowman: 'moon',
    dinosaur: 'dragon',
    octopus: 'fish',
    sandwich: 'house',
    volcano: 'mountain',
    waterfall: 'tree',
    butterfly: 'star',
    penguin: 'bird',
    pirate: 'ship',
    wizard: 'star',
    mermaid: 'fish',
    skateboard: 'car',
    balloon: 'oval',
    cactus: 'tree',
    jellyfish: 'fish',
    igloo: 'house',
    tornado: 'spiral',
    unicorn: 'horse',
    trumpet: 'guitar',
    anchor: 'star',
    compass: 'star',
    lantern: 'oval',
    windmill: 'star',
    hammock: 'line',
    spider: 'star',
    kangaroo: 'dog',
    submarine: 'fish',
    mountain: 'triangle',
    treasure: 'chest',
    scarecrow: 'robot',
    firework: 'star',
    helicopter: 'car',
    mushroom: 'umbrella',
    pyramid: 'triangle',
    shark: 'fish',
    toaster: 'house',
    rainbow: 'arc',
    lighthouse: 'tower',
    telescope: 'line',
    astronaut: 'robot',
    campfire: 'star',
  }

  let key = raw.replace(/[^a-z]/g, '')
  if (!recipes[key] && aliases[key]) key = aliases[key]
  if (recipes[key]) {
    return recipes[key]().map((seg) => ({
      ...seg,
      x0: clamp(seg.x0 + jitter(2), bounds.x + 8, bounds.x + bounds.w - 8),
      y0: clamp(seg.y0 + jitter(3), bounds.y + 8, bounds.y + bounds.h - 8),
      x1: clamp(seg.x1 + jitter(4), bounds.x + 8, bounds.x + bounds.w - 8),
      y1: clamp(seg.y1 + jitter(5), bounds.y + 8, bounds.y + bounds.h - 8),
    }))
  }

  // Fallback: draw the first letter as a block glyph so every word still "means" something.
  const letter = (raw[0] || '?').toUpperCase()
  const glyph = {
    A: [[cx, cy - s], [cx - s * 0.7, cy + s], [cx + s * 0.7, cy + s], [cx, cy - s], [cx - s * 0.35, cy + s * 0.15], [cx + s * 0.35, cy + s * 0.15]],
    B: null,
  }
  if (glyph[letter]) return poly(glyph[letter], color, size)

  // Generic abstract emblem: concentric diamond + crossbar keyed by word hash.
  const angle = hash01(raw, 11) * Math.PI
  const pts = []
  for (let i = 0; i < 4; i++) {
    const a = angle + (i * Math.PI) / 2
    pts.push([cx + Math.cos(a) * s, cy + Math.sin(a) * s])
  }
  pts.push(pts[0])
  return [
    ...poly(pts, color, size),
    ...oval(cx, cy, s * 0.35, s * 0.35, color, size - 1, 12),
    ...line(cx - s * 0.9, cy + s * 0.9, cx + s * 0.9, cy + s * 0.9, color, size - 1),
  ]
}

/**
 * Create a drip-feed pen that emits `buildWordSketch` segments over time.
 */
export function createSketchPen(word, bounds, opts = {}) {
  const segments = buildWordSketch(word, bounds, opts)
  return {
    segments,
    index: 0,
    cooldown: 0,
    done: segments.length === 0,
  }
}

/** Advance a sketch pen by `dtMs`; returns 0–N new stroke segments. */
export function tickSketchPen(pen, dtMs, rateMs = 42) {
  if (!pen || pen.done) return []
  pen.cooldown -= dtMs
  const out = []
  while (pen.cooldown <= 0 && pen.index < pen.segments.length) {
    out.push(pen.segments[pen.index++])
    pen.cooldown += rateMs
  }
  if (pen.index >= pen.segments.length) pen.done = true
  return out
}
