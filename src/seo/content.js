// src/seo/content.js
// Editorial + schema metadata for every catalog game. Shared by the SPA
// (legal/category chrome) and the Node prerender/sitemap pipeline.

export const SITE = {
  name: 'PixelGame',
  domain: 'https://pixelgame.games',
  tagline: 'Instant cyberpunk browser arcade — zero signup, zero downloads.',
  defaultOgImage: 'https://pixelgame.games/og-default.svg',
}

/** @type {Record<string, { genre: string[], summary: string, minPlayers: number, maxPlayers: number }>} */
export const GAME_SEO = {
  snake: {
    genre: ['Snake', 'Arcade', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Snake on PixelGame is the classic neon grid chase rebuilt for modern browsers. Guide your growing serpent around a fixed 960×540 arena, collect glowing pellets, and avoid walls or your own trail as speed escalates. Originally popularized in early mobile phones, Snake remains one of the most recognizable skill arcade loops: perfect for short sessions on Chromebooks, school networks, and phones. PixelGame runs entirely in your tab — no install, no account, no saved progress — so every run starts fresh the moment you open /games/snake.',
  },
  tetris: {
    genre: ['Puzzle', 'Arcade', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Tetris on PixelGame delivers the legendary falling-block puzzle with hold, soft and hard drops, and rising tempo. Clear complete horizontal lines before the stack tops out. Since its 1980s debut, Tetris has defined spatial puzzle design; this browser edition keeps the muscle-memory controls players expect while wrapping them in PixelGame’s cyberpunk HUD. Play free online with zero downloads — ideal for Chromebook, desktop, and mobile browsers when you want a focused, high-skill solo session.',
  },
  minesweeper: {
    genre: ['Puzzle', 'Logic', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Minesweeper on PixelGame is the classic logic minefield: reveal safe tiles using adjacent-mine numbers, flag threats, and clear the board without a single detonation. The Windows-era staple returns as a pure client-side puzzle — no plugins, no tracking, no account. Deduction and probability make every board a fresh challenge. Open /games/minesweeper for an instant unblocked browser round that works on Chromebook, PC, and mobile.',
  },
  breakout: {
    genre: ['Action', 'Arcade', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Breakout on PixelGame is a neon brick-storm arcade: paddle physics, multi-ball chaos, and laser clears inside a cinema-grade 16:9 canvas. Descend from Atari’s Breakout and Arkanoid lineage, this edition emphasizes angle control off paddle edges and power-up timing. Destroy every brick before lives run out. Instant load, no download, and Chromebook-friendly — a pure skill arcade loop for short competitive solo runs.',
  },
  invaders: {
    genre: ['Shooter', 'Arcade', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Space Invaders on PixelGame modernizes the 1978 Taito classic: pixel fleets step and drop, bunkers erode under fire, and waves accelerate as ranks thin. Strafe your cannon, time shots, and survive escalating pressure across a neon orbital battlefield. This free browser edition needs no account or install — perfect for unblocked Chromebook play and nostalgic arcade sessions rebuilt with cyberpunk polish.',
  },
  solitaire: {
    genre: ['Card', 'Puzzle', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 1,
    summary:
      'Solitaire on PixelGame is Klondike with guaranteed solvable deals and smart hints. Build four suit foundations from Ace to King while alternating colors on the tableau. The world’s most played digital card game returns as an ephemeral browser experience — close the tab and it vanishes, with no accounts or cloud saves. Ideal for focused, calm puzzle sessions on any modern browser including Chromebook.',
  },
  tank4: {
    genre: ['Shooter', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 4,
    summary:
      'Tank Arena 4 is PixelGame’s host-authoritative neon tank duel for up to four players. Drive with WASD, aim with the mouse, and ricochet shells off cover pillars. Empty seats fill with heuristic bots for Solo vs AI, or share a room code for friends over WebRTC — no login required. Last tank standing wins. Built for instant browser multiplayer that rivals casual web arcade portals without downloads or accounts.',
  },
  pong4: {
    genre: ['Sports', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 4,
    summary:
      'Quad Pong puts four paddles on one square arena — each player owns an edge and must defend it as the ball accelerates. Misses cost lives; last paddle standing wins. Play Solo vs AI bots or invite friends with a room link. PixelGame’s P2P mesh keeps matches ephemeral and account-free. A fresh twist on the oldest video game genre, tuned for Chromebook and desktop browsers.',
  },
  bomber4: {
    genre: ['Action', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 4,
    summary:
      'Bomber Blitz 4 is a classic grid bomber duel: blast soft crates, snatch blast/speed/bomb power-ups, and corner rivals without trapping yourself. Drop bombs with Space, weave with WASD, and survive cross-shaped explosions. Supports Solo vs AI or up to four friends via room codes — all client-side, no server database. Instant unblocked multiplayer for school Chromebooks and living-room browsers alike.',
  },
  dice5: {
    genre: ['Bluffing', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 5,
    summary:
      "Dice Duel 5 brings Liar's Dice bluffing to the browser. Secret rolls each round, escalating bids on quantity or face, and dangerous Liar! calls that cost a die when wrong. Be the last player with dice remaining. Fill empty seats with bots or host a five-player room — zero accounts, zero downloads. A social deduction table classic adapted for PixelGame’s ephemeral cyberpunk arcade.",
  },
  wordbomb5: {
    genre: ['Word', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 5,
    summary:
      'Word Bomb 5 passes a live fuse between players: type a valid word containing the glowing syllable before the timer hits zero. Explosions cost lives; last survivor wins. Host-validated word lists keep play fair in room sessions, while Solo vs AI fills empty seats instantly. No login, no install — a party word game that loads in one click on Chromebook, PC, and mobile.',
  },
  snake6: {
    genre: ['Snake', 'Multiplayer', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 6,
    summary:
      'Snake Royale 6 turns the classic snake loop into a six-player light-cycle royale. You never stop moving — hit any trail or wall and you are out. Herd rivals into dead ends and be the last cycle alive. Boot Solo vs AI or share a room code for friends. Pure client-side WebRTC multiplayer with PixelGame’s neon aesthetic and zero data storage.',
  },
  skribbl: {
    genre: ['Drawing', 'Party', 'Browser Game', 'Unblocked Game'],
    minPlayers: 1,
    maxPlayers: 12,
    summary:
      'Draw & Guess is PixelGame’s studio drawing party for up to twelve players. Paint the secret word when it is your turn, race the chat to guess, and climb the scoreboard as hints unlock. Bots fill empty seats on START so you can practice Solo vs AI anytime. No accounts, no downloads — share a room link and play instantly across Chromebook, desktop, and mobile browsers.',
  },
}

export function metaDescription(name) {
  const base = `Play ${name} free online on PixelGame. Instant browser game with zero downloads, no account required, unblocked on Chromebook, PC, and Mobile.`
  return base.length <= 160 ? base : `${base.slice(0, 157)}...`
}

export function pageTitle(game) {
  if (game.capacity === 1) {
    return `${game.name} - Play Free Online (Unblocked, No Download) | PixelGame`
  }
  return `${game.name} - Free Online ${game.capacity}-Player Browser Game (No Login) | PixelGame`
}

export function faqFor(game) {
  const name = game.name
  const isMulti = game.capacity > 1
  return [
    {
      q: `Can I play ${name} on school or work Chromebooks?`,
      a: `Yes. ${name} runs entirely in a modern web browser at pixelgame.games — no install, extension, or admin rights required. If your network allows HTTPS game sites, open the game page and play instantly on Chromebook, PC, or mobile.`,
    },
    {
      q: 'Does PixelGame require an account, download, or plugin?',
      a: 'No. PixelGame is a pure HTML5 canvas arcade. There are no user accounts, no app downloads, and no Flash or Java plugins. Close the tab and the session vanishes.',
    },
    {
      q: 'How do I play with friends using a room code?',
      a: isMulti
        ? `Open ${name}, choose Play With Friends, copy the invite link or share the room code, and have friends join the same room. Matches use peer-to-peer WebRTC — PixelGame does not host a game server database.`
        : `${name} is a solo game. For multiplayer titles on PixelGame, open a multiplayer game page, choose Play With Friends, and share the room invite link or code.`,
    },
    {
      q: 'Does this game store my personal data or gameplay history?',
      a: 'No accounts and no tracking databases. The only optional storage is a short-lived sessionStorage snapshot so a refresh can resume an active match; returning to the arcade grid clears it. PixelGame does not keep personal profiles or long-term gameplay history.',
    },
  ]
}
