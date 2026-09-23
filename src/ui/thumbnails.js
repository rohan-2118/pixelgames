// src/ui/thumbnails.js
//
// Card key art for every catalog entry, generated as inline SVG data URIs.
//
// Zero network requests and zero binary assets: each cover is composed at
// runtime from a shared cyberpunk template (graded backdrop + procedural
// motif + vector emblem + scanline veil), so the arcade stays a single
// self-contained client bundle.
//
// Deliberately emoji-free. Emblems are geometric line art in the arcade
// palette so the grid reads like a hardware catalog rather than a sticker
// sheet.

const W = 320
const H = 180

/* ---------------------------------------------------------------------------
 * Background motifs — drawn under the emblem, tinted by the game's accents.
 * ------------------------------------------------------------------------ */

const MOTIFS = {
  grid(a, b) {
    let out = ''
    for (let x = 16; x < W; x += 16) {
      out += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${a}" stroke-opacity=".13"/>`
    }
    for (let y = 16; y < H; y += 16) {
      out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${b}" stroke-opacity=".11"/>`
    }
    // Horizon accent so the grid has a direction.
    out += `<line x1="0" y1="${H * 0.62}" x2="${W}" y2="${H * 0.62}" stroke="${a}" stroke-opacity=".4" stroke-width="1.5"/>`
    return out
  },

  perspective(a, b) {
    let out = `<line x1="0" y1="${H * 0.52}" x2="${W}" y2="${H * 0.52}" stroke="${a}" stroke-opacity=".35"/>`
    for (let i = -6; i <= 6; i++) {
      out += `<line x1="${W / 2 + i * 12}" y1="${H * 0.52}" x2="${W / 2 + i * 82}" y2="${H}" stroke="${b}" stroke-opacity=".16"/>`
    }
    for (let i = 1; i <= 5; i++) {
      const y = H * 0.52 + Math.pow(i, 1.9) * 3.4
      out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${a}" stroke-opacity=".14"/>`
    }
    return out
  },

  bars(a, b) {
    const heights = [34, 62, 48, 84, 40, 70, 28, 56, 92, 44, 66, 32]
    return heights
      .map((h, i) => {
        const x = 10 + i * 25
        const color = i % 2 ? b : a
        return (
          `<rect x="${x}" y="${H - h}" width="15" height="${h}" fill="${color}" fill-opacity=".2"/>` +
          `<rect x="${x}" y="${H - h}" width="15" height="2.5" fill="${color}" fill-opacity=".75"/>`
        )
      })
      .join('')
  },

  bricks(a, b) {
    let out = ''
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 9; col++) {
        const offset = row % 2 ? 21 : 0
        const x = -14 + offset + col * 42
        const y = 10 + row * 20
        const color = row % 2 ? b : a
        out += `<rect x="${x}" y="${y}" width="36" height="12" fill="${color}" fill-opacity=".16"/>`
        out += `<rect x="${x}" y="${y}" width="36" height="1.6" fill="${color}" fill-opacity=".5"/>`
      }
    }
    return out
  },

  rings(a, b) {
    let out = ''
    for (let r = 22; r < 200; r += 22) {
      const color = (r / 22) % 2 ? a : b
      out += `<circle cx="${W / 2}" cy="${H / 2}" r="${r}" fill="none" stroke="${color}" stroke-opacity=".17"/>`
    }
    return out
  },

  waves(a, b) {
    let out = ''
    for (let i = 0; i < 6; i++) {
      const y = 26 + i * 27
      const color = i % 2 ? a : b
      out +=
        `<path d="M0 ${y} Q 40 ${y - 20} 80 ${y} T 160 ${y} T 240 ${y} T 320 ${y}" ` +
        `fill="none" stroke="${color}" stroke-opacity=".22" stroke-width="1.8"/>`
    }
    return out
  },

  hexes(a, b) {
    const hex = (cx, cy, r, color, op) => {
      const pts = []
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i - Math.PI / 6
        pts.push(`${(cx + Math.cos(ang) * r).toFixed(1)},${(cy + Math.sin(ang) * r).toFixed(1)}`)
      }
      return `<polygon points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-opacity="${op}"/>`
    }
    let out = ''
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 10; col++) {
        const cx = col * 36 + (row % 2 ? 18 : 0)
        const cy = row * 31
        out += hex(cx, cy, 18, (row + col) % 2 ? a : b, 0.16)
      }
    }
    return out
  },

  lanes(a, b) {
    let out = ''
    for (let i = 0; i < 6; i++) {
      const y = 12 + i * 28
      out += `<rect x="0" y="${y}" width="${W}" height="20" fill="${i % 2 ? a : b}" fill-opacity=".09"/>`
      for (let x = 8; x < W; x += 34) {
        out += `<rect x="${x}" y="${y + 9}" width="20" height="2" fill="${a}" fill-opacity=".3"/>`
      }
    }
    return out
  },

  scatter(a, b) {
    let out = ''
    // Deterministic pseudo-random field (no Math.random: art must be stable).
    for (let i = 0; i < 46; i++) {
      const x = ((i * 97) % 311) + 6
      const y = ((i * 53) % 169) + 6
      const r = 1.4 + ((i * 17) % 5) * 0.55
      out += `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${i % 3 ? a : b}" fill-opacity=".3"/>`
    }
    return out
  },
}

/* ---------------------------------------------------------------------------
 * Vector emblems — the subject of each cover. All line art, centred on
 * (160, 86), sized to roughly a 150x110 box so the composition stays even.
 * ------------------------------------------------------------------------ */

const EMBLEMS = {
  serpent(a, b) {
    let out = ''
    const pts = [
      [96, 118], [116, 112], [134, 98], [152, 82], [172, 70], [194, 66], [214, 74],
    ]
    out += `<path d="M${pts.map((p) => p.join(' ')).join(' L')}" fill="none" stroke="${a}" stroke-opacity=".28" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`
    out += `<path d="M${pts.map((p) => p.join(' ')).join(' L')}" fill="none" stroke="${a}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    pts.forEach(([x, y], i) => {
      out += `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="3" fill="${i === pts.length - 1 ? b : a}" fill-opacity="${0.35 + i * 0.09}"/>`
    })
    out += `<circle cx="218" cy="70" r="9" fill="${b}" fill-opacity=".9"/>`
    out += `<rect x="86" y="126" width="12" height="12" rx="3" fill="${b}" fill-opacity=".85"/>`
    return out
  },

  tetromino(a, b) {
    const cell = (x, y, color, op = 0.85) =>
      `<rect x="${x}" y="${y}" width="26" height="26" rx="3" fill="${color}" fill-opacity="${op * 0.3}" stroke="${color}" stroke-opacity="${op}" stroke-width="2"/>`
    return (
      cell(108, 40, a) + cell(134, 40, a) + cell(134, 66, a) + cell(160, 66, a) +
      cell(186, 66, b) + cell(186, 92, b) + cell(160, 92, b) + cell(134, 118, a, 0.5) +
      cell(160, 118, a, 0.5)
    )
  },

  mine(a, b) {
    let out = `<circle cx="160" cy="86" r="26" fill="${a}" fill-opacity=".22" stroke="${a}" stroke-width="2.4"/>`
    for (let i = 0; i < 12; i++) {
      const ang = (Math.PI / 6) * i
      const x1 = 160 + Math.cos(ang) * 30
      const y1 = 86 + Math.sin(ang) * 30
      const x2 = 160 + Math.cos(ang) * (i % 2 ? 48 : 40)
      const y2 = 86 + Math.sin(ang) * (i % 2 ? 48 : 40)
      out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${i % 2 ? b : a}" stroke-width="2" stroke-opacity=".8"/>`
    }
    out += `<circle cx="152" cy="78" r="5" fill="${b}" fill-opacity=".9"/>`
    return out
  },

  paddleBall(a, b) {
    return (
      `<rect x="70" y="60" width="9" height="56" rx="4" fill="${a}" fill-opacity=".9"/>` +
      `<rect x="241" y="70" width="9" height="56" rx="4" fill="${b}" fill-opacity=".9"/>` +
      `<circle cx="166" cy="88" r="11" fill="${a}" fill-opacity=".9"/>` +
      `<path d="M96 122 L140 96 L186 108 L232 82" fill="none" stroke="${b}" stroke-opacity=".55" stroke-width="2" stroke-dasharray="6 5"/>`
    )
  },

  quadPaddles(a, b) {
    return (
      `<rect x="64" y="52" width="192" height="72" fill="none" stroke="${a}" stroke-opacity=".38" stroke-width="1.6"/>` +
      `<rect x="70" y="72" width="7" height="34" rx="3" fill="${a}" fill-opacity=".9"/>` +
      `<rect x="243" y="72" width="7" height="34" rx="3" fill="${a}" fill-opacity=".9"/>` +
      `<rect x="142" y="56" width="36" height="7" rx="3" fill="${b}" fill-opacity=".9"/>` +
      `<rect x="142" y="113" width="36" height="7" rx="3" fill="${b}" fill-opacity=".9"/>` +
      `<circle cx="160" cy="88" r="9" fill="${b}" fill-opacity=".95"/>` +
      `<path d="M120 70 L160 88 L206 104" fill="none" stroke="${a}" stroke-opacity=".5" stroke-width="1.8" stroke-dasharray="5 4"/>`
    )
  },

  tank(a, b) {
    return (
      // treads
      `<rect x="98" y="104" width="124" height="18" rx="9" fill="${a}" fill-opacity=".2" stroke="${a}" stroke-opacity=".7" stroke-width="2"/>` +
      Array.from({ length: 7 }, (_, i) => `<line x1="${108 + i * 17}" y1="104" x2="${108 + i * 17}" y2="122" stroke="${a}" stroke-opacity=".55" stroke-width="2"/>`).join('') +
      // hull
      `<path d="M104 104 L112 80 L208 80 L216 104 Z" fill="${a}" fill-opacity=".24" stroke="${a}" stroke-width="2.2"/>` +
      // turret + barrel tracking up-right
      `<circle cx="160" cy="80" r="16" fill="${b}" fill-opacity=".26" stroke="${b}" stroke-width="2.2"/>` +
      `<rect x="158" y="34" width="9" height="46" rx="3" transform="rotate(28 162 80)" fill="${b}" fill-opacity=".85"/>` +
      `<circle cx="160" cy="80" r="4.5" fill="${b}"/>`
    )
  },

  blast(a, b) {
    let out = `<rect x="122" y="48" width="76" height="76" fill="none" stroke="${a}" stroke-opacity=".4" stroke-width="1.6"/>`
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI / 4) * i
      out += `<line x1="${(160 + Math.cos(ang) * 16).toFixed(1)}" y1="${(86 + Math.sin(ang) * 16).toFixed(1)}" x2="${(160 + Math.cos(ang) * 58).toFixed(1)}" y2="${(86 + Math.sin(ang) * 58).toFixed(1)}" stroke="${i % 2 ? b : a}" stroke-width="${i % 2 ? 2 : 3}" stroke-opacity=".8" stroke-linecap="round"/>`
    }
    out += `<circle cx="160" cy="86" r="17" fill="${b}" fill-opacity=".3" stroke="${b}" stroke-width="2.4"/>`
    out += `<circle cx="160" cy="86" r="7" fill="${b}" fill-opacity=".95"/>`
    return out
  },

  dice(a, b) {
    const face = (x, y, size, color) => {
      const top = `<path d="M${x} ${y} L${x + size / 2} ${y - size / 3} L${x + size} ${y} L${x + size / 2} ${y + size / 3} Z" fill="${color}" fill-opacity=".34" stroke="${color}" stroke-width="2"/>`
      const left = `<path d="M${x} ${y} L${x + size / 2} ${y + size / 3} L${x + size / 2} ${y + size} L${x} ${y + size * 0.67} Z" fill="${color}" fill-opacity=".2" stroke="${color}" stroke-width="2"/>`
      const right = `<path d="M${x + size} ${y} L${x + size / 2} ${y + size / 3} L${x + size / 2} ${y + size} L${x + size} ${y + size * 0.67} Z" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="2"/>`
      const pips =
        `<circle cx="${x + size * 0.28}" cy="${y + size * 0.58}" r="3.2" fill="${color}"/>` +
        `<circle cx="${x + size * 0.28}" cy="${y + size * 0.8}" r="3.2" fill="${color}"/>` +
        `<circle cx="${x + size * 0.72}" cy="${y + size * 0.62}" r="3.2" fill="${color}"/>`
      return top + left + right + pips
    }
    return face(96, 62, 56, a) + face(176, 78, 46, b)
  },

  cards(a, b) {
    const card = (x, y, rot, color) =>
      `<g transform="rotate(${rot} ${x + 24} ${y + 32})"><rect x="${x}" y="${y}" width="48" height="66" rx="5" fill="#0a1018" fill-opacity=".9" stroke="${color}" stroke-width="2"/>` +
      `<path d="M${x + 24} ${y + 20} L${x + 36} ${y + 34} L${x + 24} ${y + 48} L${x + 12} ${y + 34} Z" fill="${color}" fill-opacity=".75"/></g>`
    return card(100, 54, -14, a) + card(136, 48, -4, b) + card(174, 54, 11, a)
  },

  brush(a, b) {
    return (
      `<path d="M74 132 Q 118 66 156 100 T 244 52" fill="none" stroke="${a}" stroke-opacity=".3" stroke-width="16" stroke-linecap="round"/>` +
      `<path d="M74 132 Q 118 66 156 100 T 244 52" fill="none" stroke="${a}" stroke-width="3.4" stroke-linecap="round"/>` +
      `<g transform="rotate(38 232 52)"><rect x="224" y="20" width="17" height="42" rx="4" fill="${b}" fill-opacity=".9"/>` +
      `<path d="M224 62 L241 62 L236 80 L229 80 Z" fill="${b}" fill-opacity=".55" stroke="${b}" stroke-width="1.6"/></g>` +
      `<circle cx="74" cy="132" r="6" fill="${b}"/>`
    )
  },

  cycles(a, b) {
    let out = ''
    const paths = [
      ['M70 130 L70 86 L124 86 L124 50 L188 50', a],
      ['M250 46 L250 96 L196 96 L196 126 L136 126', b],
    ]
    for (const [d, color] of paths) {
      out += `<path d="${d}" fill="none" stroke="${color}" stroke-opacity=".3" stroke-width="12" stroke-linejoin="round"/>`
      out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round"/>`
    }
    out += `<circle cx="188" cy="50" r="7" fill="${a}"/>`
    out += `<circle cx="136" cy="126" r="7" fill="${b}"/>`
    return out
  },

  lens(a, b) {
    return (
      `<circle cx="146" cy="76" r="38" fill="${a}" fill-opacity=".12" stroke="${a}" stroke-width="2.6"/>` +
      `<circle cx="146" cy="76" r="26" fill="none" stroke="${a}" stroke-opacity=".4"/>` +
      `<rect x="168" y="100" width="54" height="11" rx="5" transform="rotate(38 168 100)" fill="${b}" fill-opacity=".9"/>` +
      `<path d="M128 70 L140 82 L166 56" fill="none" stroke="${b}" stroke-width="3" stroke-linecap="round"/>`
    )
  },

  mask(a, b) {
    return (
      `<path d="M120 46 Q160 32 200 46 L206 92 Q160 134 114 92 Z" fill="${a}" fill-opacity=".16" stroke="${a}" stroke-width="2.4"/>` +
      `<path d="M126 74 Q142 62 158 74 Q142 86 126 74 Z" fill="${b}" fill-opacity=".85"/>` +
      `<path d="M162 74 Q178 62 194 74 Q178 86 162 74 Z" fill="${b}" fill-opacity=".85"/>` +
      `<path d="M138 108 Q160 118 182 108" fill="none" stroke="${b}" stroke-opacity=".6" stroke-width="2.4"/>` +
      `<line x1="108" y1="40" x2="212" y2="40" stroke="${a}" stroke-opacity=".5" stroke-width="2"/>`
    )
  },

  keys(a, b) {
    let out = ''
    const rows = [
      [96, 56, 6], [88, 84, 7], [104, 112, 5],
    ]
    rows.forEach(([x0, y, n], r) => {
      for (let i = 0; i < n; i++) {
        const color = r === 1 && i === 3 ? b : a
        out += `<rect x="${x0 + i * 22}" y="${y}" width="19" height="19" rx="4" fill="${color}" fill-opacity="${r === 1 && i === 3 ? 0.4 : 0.16}" stroke="${color}" stroke-opacity=".8" stroke-width="1.8"/>`
      }
    })
    out += `<rect x="118" y="138" width="84" height="12" rx="5" fill="${a}" fill-opacity=".18" stroke="${a}" stroke-opacity=".7" stroke-width="1.8"/>`
    return out
  },

  gavel(a, b) {
    return (
      `<g transform="rotate(-32 160 80)"><rect x="118" y="62" width="84" height="34" rx="7" fill="${a}" fill-opacity=".26" stroke="${a}" stroke-width="2.4"/>` +
      `<rect x="112" y="56" width="12" height="46" rx="4" fill="${a}" fill-opacity=".8"/>` +
      `<rect x="196" y="56" width="12" height="46" rx="4" fill="${a}" fill-opacity=".8"/>` +
      `<rect x="154" y="94" width="13" height="56" rx="5" fill="${b}" fill-opacity=".85"/></g>` +
      `<rect x="106" y="140" width="108" height="9" rx="4" fill="${b}" fill-opacity=".45" stroke="${b}" stroke-opacity=".8"/>`
    )
  },

  quiz(a, b) {
    return (
      `<path d="M134 62 Q134 40 160 40 Q188 40 188 62 Q188 78 164 86 L164 100" fill="none" stroke="${a}" stroke-width="10" stroke-linecap="round"/>` +
      `<circle cx="164" cy="120" r="7.5" fill="${a}"/>` +
      `<circle cx="160" cy="84" r="58" fill="none" stroke="${b}" stroke-opacity=".35" stroke-width="2" stroke-dasharray="10 8"/>` +
      `<circle cx="160" cy="84" r="70" fill="none" stroke="${b}" stroke-opacity=".18"/>`
    )
  },

  poll(a, b) {
    return (
      `<rect x="96" y="96" width="26" height="42" fill="${a}" fill-opacity=".3" stroke="${a}" stroke-width="2"/>` +
      `<rect x="134" y="62" width="26" height="76" fill="${b}" fill-opacity=".3" stroke="${b}" stroke-width="2"/>` +
      `<rect x="172" y="80" width="26" height="58" fill="${a}" fill-opacity=".3" stroke="${a}" stroke-width="2"/>` +
      `<rect x="210" y="46" width="26" height="92" fill="${b}" fill-opacity=".38" stroke="${b}" stroke-width="2"/>` +
      `<path d="M109 92 L147 58 L185 76 L223 42" fill="none" stroke="${b}" stroke-width="2.4" stroke-dasharray="6 5"/>` +
      `<circle cx="223" cy="42" r="6" fill="${b}"/>`
    )
  },

  hood(a, b) {
    return (
      `<path d="M160 34 Q206 44 206 96 Q206 132 160 140 Q114 132 114 96 Q114 44 160 34 Z" fill="${a}" fill-opacity=".14" stroke="${a}" stroke-width="2.4"/>` +
      `<path d="M136 80 Q160 66 184 80 Q160 96 136 80 Z" fill="${b}" fill-opacity=".9"/>` +
      `<path d="M122 112 Q160 128 198 112" fill="none" stroke="${a}" stroke-opacity=".55" stroke-width="2.4"/>` +
      `<line x1="74" y1="58" x2="102" y2="58" stroke="${b}" stroke-opacity=".6" stroke-width="2"/>` +
      `<line x1="218" y1="58" x2="246" y2="58" stroke="${b}" stroke-opacity=".6" stroke-width="2"/>`
    )
  },

  runner(a, b) {
    return (
      `<circle cx="150" cy="46" r="13" fill="${a}" fill-opacity=".9"/>` +
      `<path d="M150 60 L146 96 L128 126" fill="none" stroke="${a}" stroke-width="7" stroke-linecap="round"/>` +
      `<path d="M146 96 L176 118" fill="none" stroke="${a}" stroke-width="7" stroke-linecap="round"/>` +
      `<path d="M150 70 L120 84" fill="none" stroke="${b}" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M150 70 L186 62" fill="none" stroke="${b}" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M206 48 L246 48 M198 72 L246 72 M210 96 L246 96" stroke="${b}" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>`
    )
  },

  bomb(a, b) {
    return (
      `<circle cx="154" cy="98" r="34" fill="${a}" fill-opacity=".2" stroke="${a}" stroke-width="2.6"/>` +
      `<rect x="146" y="56" width="17" height="14" rx="3" fill="${a}" fill-opacity=".8"/>` +
      `<path d="M158 56 Q182 34 204 50" fill="none" stroke="${b}" stroke-width="3" stroke-linecap="round"/>` +
      `<circle cx="206" cy="50" r="8" fill="${b}" fill-opacity=".9"/>` +
      `<circle cx="206" cy="50" r="15" fill="none" stroke="${b}" stroke-opacity=".4"/>` +
      `<path d="M138 90 Q150 82 160 92" fill="none" stroke="${a}" stroke-opacity=".7" stroke-width="2"/>`
    )
  },

  invader(a, b) {
    const px = (x, y, w, h, color, op = 0.9) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity="${op}"/>`
    return (
      px(136, 50, 48, 10, a) +
      px(124, 60, 72, 10, a) +
      px(112, 70, 96, 12, a) +
      px(124, 82, 16, 12, b) + px(180, 82, 16, 12, b) +
      px(112, 94, 96, 10, a, 0.7) +
      px(124, 104, 20, 10, a) + px(176, 104, 20, 10, a) +
      px(100, 62, 10, 22, b, 0.6) + px(210, 62, 10, 22, b, 0.6) +
      `<path d="M160 120 L160 146" stroke="${b}" stroke-width="4" stroke-linecap="round"/>`
    )
  },

  dodge(a, b) {
    return (
      `<circle cx="116" cy="70" r="17" fill="${a}" fill-opacity=".3" stroke="${a}" stroke-width="2.4"/>` +
      `<circle cx="204" cy="104" r="14" fill="${b}" fill-opacity=".3" stroke="${b}" stroke-width="2.4"/>` +
      `<circle cx="160" cy="46" r="10" fill="${b}" fill-opacity=".8"/>` +
      `<path d="M96 122 Q140 96 168 118" fill="none" stroke="${a}" stroke-opacity=".6" stroke-width="2.2" stroke-dasharray="7 6"/>` +
      `<path d="M224 58 Q186 78 206 104" fill="none" stroke="${b}" stroke-opacity=".6" stroke-width="2.2" stroke-dasharray="7 6"/>` +
      `<path d="M150 128 L160 108 L170 128" fill="none" stroke="${a}" stroke-width="3" stroke-linecap="round"/>`
    )
  },
}

/* ---------------------------------------------------------------------------
 * Art direction per game. Keys mirror `CATALOG` ids in src/registry.js.
 * ------------------------------------------------------------------------ */

const ART = {
  // --- solo ---
  snake: { a: '#39ff14', b: '#00f0ff', motif: 'grid', emblem: 'serpent' },
  tetris: { a: '#00f0ff', b: '#a855ff', motif: 'bricks', emblem: 'tetromino' },
  minesweeper: { a: '#ff0055', b: '#7fe7ff', motif: 'hexes', emblem: 'mine' },
  breakout: { a: '#ffb300', b: '#ff0055', motif: 'bricks', emblem: 'paddleBall' },
  invaders: { a: '#39ff14', b: '#a855ff', motif: 'scatter', emblem: 'invader' },
  solitaire: { a: '#7fe7ff', b: '#39ff14', motif: 'waves', emblem: 'cards' },

  // --- 4 players ---
  tank4: { a: '#ffb300', b: '#00f0ff', motif: 'perspective', emblem: 'tank' },
  pong4: { a: '#00f0ff', b: '#ff0055', motif: 'rings', emblem: 'quadPaddles' },
  bomber4: { a: '#ff0055', b: '#ffb300', motif: 'grid', emblem: 'blast' },

  // --- 5 players ---
  dice5: { a: '#ffb300', b: '#00f0ff', motif: 'hexes', emblem: 'dice' },
  wordbomb5: { a: '#a855ff', b: '#39ff14', motif: 'scatter', emblem: 'bomb' },

  // --- 6 players ---
  snake6: { a: '#39ff14', b: '#7fe7ff', motif: 'grid', emblem: 'cycles' },

  // --- 8+ players ---
  skribbl: { a: '#00f0ff', b: '#ff0055', motif: 'waves', emblem: 'brush' },
}

const FALLBACK = { a: '#00f0ff', b: '#ff0055', motif: 'grid', emblem: 'quiz' }

const cache = new Map()

function buildSvg(art, seedId) {
  const motif = (MOTIFS[art.motif] || MOTIFS.grid)(art.a, art.b)
  const emblem = (EMBLEMS[art.emblem] || EMBLEMS.quiz)(art.a, art.b)
  const gid = `g-${seedId}`
  const rid = `r-${seedId}`
  const sid = `s-${seedId}`
  const vid = `v-${seedId}`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
    '<defs>' +
    // Diagonal accent grade
    `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${art.a}" stop-opacity=".3"/>` +
    `<stop offset=".55" stop-color="${art.b}" stop-opacity=".12"/>` +
    `<stop offset="1" stop-color="#05070d" stop-opacity=".2"/>` +
    '</linearGradient>' +
    // Emblem halo
    `<radialGradient id="${rid}" cx="50%" cy="48%" r="46%">` +
    `<stop offset="0" stop-color="${art.a}" stop-opacity=".42"/>` +
    `<stop offset="1" stop-color="${art.a}" stop-opacity="0"/>` +
    '</radialGradient>' +
    // Light sweep
    `<linearGradient id="${sid}" x1="0" y1="1" x2="1" y2="0">` +
    '<stop offset=".3" stop-color="#ffffff" stop-opacity="0"/>' +
    '<stop offset=".52" stop-color="#ffffff" stop-opacity=".09"/>' +
    '<stop offset=".7" stop-color="#ffffff" stop-opacity="0"/>' +
    '</linearGradient>' +
    // Corner vignette
    `<radialGradient id="${vid}" cx="50%" cy="46%" r="72%">` +
    '<stop offset=".5" stop-color="#000000" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="#000000" stop-opacity=".62"/>' +
    '</radialGradient>' +
    // 2px scanline veil
    `<pattern id="scan-${seedId}" width="3" height="3" patternUnits="userSpaceOnUse">` +
    '<rect width="3" height="1.4" fill="#000000" fill-opacity=".26"/>' +
    '</pattern>' +
    '</defs>' +

    `<rect width="${W}" height="${H}" fill="#070b12"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${gid})"/>` +
    motif +
    `<circle cx="${W / 2}" cy="${H / 2 - 4}" r="74" fill="url(#${rid})"/>` +
    `<g stroke-linejoin="round">${emblem}</g>` +
    `<rect width="${W}" height="${H}" fill="url(#${sid})"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${vid})"/>` +
    `<rect width="${W}" height="${H}" fill="url(#scan-${seedId})"/>` +

    // Hardware framing: corner brackets + bottom accent rail.
    `<path d="M10 26 L10 10 L34 10" fill="none" stroke="${art.a}" stroke-opacity=".7" stroke-width="2"/>` +
    `<path d="M${W - 34} ${H - 10} L${W - 10} ${H - 10} L${W - 10} ${H - 26}" fill="none" stroke="${art.b}" stroke-opacity=".7" stroke-width="2"/>` +
    `<rect x="0" y="${H - 3}" width="${W}" height="3" fill="${art.a}" fill-opacity=".85"/>` +
    `<rect x="0" y="${H - 3}" width="${W * 0.32}" height="3" fill="${art.b}" fill-opacity=".95"/>` +
    '</svg>'
  )
}

/**
 * Inline SVG data URI for a game card thumbnail.
 * @param {string} gameId - Catalog id (falls back to a generic arcade tile).
 * @returns {string} `data:image/svg+xml` source usable in an <img src>.
 */
export function gameThumbnail(gameId) {
  if (cache.has(gameId)) return cache.get(gameId)
  const art = ART[gameId] || FALLBACK
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildSvg(art, gameId || 'default'))}`
  cache.set(gameId, uri)
  return uri
}

/** Primary accent for a game, reused by the card's hover glow and HUD tint. */
export function gameAccent(gameId) {
  return (ART[gameId] || FALLBACK).a
}

/** Secondary accent, available for gradients that need a second stop. */
export function gameAccentAlt(gameId) {
  return (ART[gameId] || FALLBACK).b
}
