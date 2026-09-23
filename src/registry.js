// src/registry.js
//
// Single source of truth for every game in the arcade.

/**
 * @typedef {Object} GameInstructions
 * @property {string} objective
 * @property {string[]} controls
 * @property {string[]} howToPlay
 */

/**
 * @typedef {Object} GameEntry
 * @property {string} id
 * @property {string} name
 * @property {'solo'|'multiplayer'} category
 * @property {number} capacity
 * @property {string} description
 * @property {GameInstructions} instructions
 */

/** @type {GameEntry[]} */
export const CATALOG = [
  // ----------------------------- Solo (1) -----------------------------
  {
    id: 'snake',
    name: 'Snake',
    category: 'solo',
    capacity: 1,
    description:
      'Guide a growing serpent around a neon grid, gobble pellets, and avoid crashing into walls or your own tail.',
    instructions: {
      objective: 'Eat pellets, grow longer, and survive as long as you can.',
      controls: ['Arrow Keys / WASD — Steer', 'P — Pause'],
      howToPlay: [
        'Steer with arrows or WASD.',
        'Eat pellets to grow and score.',
        'Avoid walls and your own tail.',
        'Speed rises as you grow.',
      ],
    },
  },
  {
    id: 'tetris',
    name: 'Tetris',
    category: 'solo',
    capacity: 1,
    description: 'Stack falling tetrominoes, clear lines, and survive the rising tempo.',
    instructions: {
      objective: 'Clear lines without topping out.',
      controls: ['← / → — Move', '↓ Soft drop', 'Space Hard drop', '↑ / Z Rotate', 'C Hold'],
      howToPlay: [
        'Fit pieces to complete horizontal rows.',
        'Cleared rows score points.',
        'Hold a piece for later with C.',
        'Game ends when the stack reaches the top.',
      ],
    },
  },
  {
    id: 'minesweeper',
    name: 'Minesweeper',
    category: 'solo',
    capacity: 1,
    description: 'Clear a hidden minefield using number clues — one wrong click ends it.',
    instructions: {
      objective: 'Reveal every safe tile without detonating a mine.',
      controls: ['Left Click — Reveal', 'Right Click — Flag'],
      howToPlay: [
        'Numbers show adjacent mine counts.',
        'Flag suspected mines.',
        'Deduce safe tiles from the clues.',
        'Clear the board to win.',
      ],
    },
  },
  {
    id: 'breakout',
    name: 'Breakout',
    category: 'solo',
    capacity: 1,
    description:
      'Cinema-grade neon brick storm — paddle physics, multi-ball chaos, and laser clears.',
    instructions: {
      objective: 'Destroy every brick before your lives run out.',
      controls: ['Mouse / ← → — Paddle', 'Space — Launch / Laser'],
      howToPlay: [
        'Keep the ball alive with the paddle.',
        'Angle shots off the paddle edges.',
        'Catch power-ups for widen, multi-ball, or lasers.',
        'Clear the wall to advance.',
      ],
    },
  },
  {
    id: 'invaders',
    name: 'Space Invaders',
    category: 'solo',
    capacity: 1,
    description:
      'Modern orbital defense — pixel fleets, eroding bunkers, and escalating wave pressure.',
    instructions: {
      objective: 'Wipe each alien wave before they reach the surface.',
      controls: ['← / → — Move', 'Space — Fire'],
      howToPlay: [
        'Strafe and shoot the descending formation.',
        'Use bunkers as cover — they erode under fire.',
        'Waves accelerate as ranks thin.',
        'Survive as long as your lives allow.',
      ],
    },
  },
  {
    id: 'solitaire',
    name: 'Solitaire',
    category: 'solo',
    capacity: 1,
    description: 'Klondike solitaire with guaranteed solvable deals and smart hints.',
    instructions: {
      objective: 'Build four suit foundations from Ace to King.',
      controls: ['Drag cards', 'Double-click auto-foundation', 'Click deck to draw', 'H Hint'],
      howToPlay: [
        'Build tableau descending, alternating colors.',
        'Move Aces to foundations first.',
        'Every deal has a winning line.',
        'Use hints sparingly when stuck.',
      ],
    },
  },

  // --------------------------- 4 Players ---------------------------
  {
    id: 'tank4',
    name: 'Tank Arena 4',
    category: 'multiplayer',
    capacity: 4,
    description: 'Four tanks, neon cover, ricochet shells — last tank standing.',
    instructions: {
      objective: 'Eliminate every rival tank.',
      controls: ['WASD / Arrows — Drive', 'Mouse — Aim', 'Click / Space — Fire'],
      howToPlay: [
        'START fills empty seats with bots.',
        'Use cover pillars and ricochets.',
        'Reload forces tactical retreats.',
        'First to the win target takes the match.',
      ],
    },
  },
  {
    id: 'pong4',
    name: 'Quad Pong',
    category: 'multiplayer',
    capacity: 4,
    description: 'Four-edge arena Pong — defend your wall or lose a life.',
    instructions: {
      objective: 'Be the last paddle with lives remaining.',
      controls: ['Arrows / A D — Slide along your edge'],
      howToPlay: [
        'Each player owns one side of the square.',
        'Misses cost a life.',
        'Ball speeds up on paddle hits.',
        'Last survivor wins.',
      ],
    },
  },
  {
    id: 'bomber4',
    name: 'Bomber Blitz 4',
    category: 'multiplayer',
    capacity: 4,
    description: 'Grid bomber duel — blast crates, snatch power-ups, outplay three rivals.',
    instructions: {
      objective: 'Be the last bomber standing.',
      controls: ['WASD / Arrows — Move', 'Space — Drop bomb'],
      howToPlay: [
        'Carve paths through soft crates.',
        'Bombs explode in a cross after a short fuse.',
        'Grab blast, bomb, and speed upgrades.',
        'Corner rivals without trapping yourself.',
      ],
    },
  },

  // --------------------------- 5 Players ---------------------------
  {
    id: 'dice5',
    name: 'Dice Duel 5',
    category: 'multiplayer',
    capacity: 5,
    description: "High-stakes Liar's Dice — bluff the table or call the lie.",
    instructions: {
      objective: 'Be the last player with dice remaining.',
      controls: ['+/− adjust bid', 'Raise Bid', 'Liar!'],
      howToPlay: [
        'Secret rolls each round.',
        'Bids must escalate quantity or face.',
        'Wrong Liar! call costs a die.',
        'Bots fill empty seats on START.',
      ],
    },
  },
  {
    id: 'wordbomb5',
    name: 'Word Bomb 5',
    category: 'multiplayer',
    capacity: 5,
    description: 'Pass the live bomb by typing a word that contains the glowing syllable.',
    instructions: {
      objective: 'Never hold the bomb when the fuse hits zero.',
      controls: ['Type a word', 'Enter — Submit'],
      howToPlay: [
        'A syllable fragment appears each turn.',
        'Valid words pass the bomb onward.',
        'Explosion costs a life.',
        'Last survivor wins the match.',
      ],
    },
  },

  // --------------------------- 6 Players ---------------------------
  {
    id: 'snake6',
    name: 'Snake Royale 6',
    category: 'multiplayer',
    capacity: 6,
    description: 'Six light-cycles, one grid — cut rivals off or get erased.',
    instructions: {
      objective: 'Be the last cycle alive.',
      controls: ['WASD / Arrows — Steer'],
      howToPlay: [
        'You never stop moving.',
        'Hit any trail or wall and you are out.',
        'Herd rivals into dead ends.',
        'Last rider standing wins.',
      ],
    },
  },

  // --------------------------- 8+ Players ---------------------------
  {
    id: 'skribbl',
    name: 'Draw & Guess',
    category: 'multiplayer',
    capacity: 12,
    description: 'Studio drawing party for up to 12 — paint the word, race the chat.',
    instructions: {
      objective: 'Guess fast and draw clear when it is your turn.',
      controls: ['Mouse — Draw', 'Toolbar — Tools', 'Type + Enter — Guess'],
      howToPlay: [
        'START fills empty seats with bots.',
        'Each player draws once per match.',
        'Hints unlock as the clock drains.',
        'Highest score takes the podium.',
      ],
    },
  },
]

export function getGameById(id) {
  return CATALOG.find((game) => game.id === id)
}

export const CAPACITY_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'solo', label: 'Solo', test: (game) => game.capacity === 1 },
  { id: '4', label: '4 Players', test: (game) => game.capacity === 4 },
  { id: '5', label: '5 Players', test: (game) => game.capacity === 5 },
  { id: '6', label: '6 Players', test: (game) => game.capacity === 6 },
  { id: '8plus', label: '8+ Players', test: (game) => game.capacity >= 8 },
]
