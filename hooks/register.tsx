import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, TextProps, Timer } from 'claude-code'

import type { Board, Doc, Feature, FeedRow, Gallery, PetStyle, Focus, Skin, Todo, TurnState, Usage } from '../types'

const PANE = 'focus'

/** The second pane, a tab beside the first: the bound feature's mockups. */
const GALLERY = 'maquettes'

/** A thumbnail's height in pixels: two a terminal row. */
const THUMB_PIXELS = 34

/** Columns the header keeps free on the right, where a host draws its own controls. */
const HEADER_CLEARANCE = 9

/**
 * Names to try for the slash command, best first. A built-in's name is refused
 * — `/focus` already is one — so the engine's own list decides, never a guess.
 */
const CANDIDATES = ['mission', 'focus-pane', 'unlocker', 'pane'] as const

/** The ticket prefixes worth catching in a prompt; edit this line, not the regex. */
const PREFIXES = ['UNL']
const TICKET = new RegExp(`\\b(?:${PREFIXES.join('|')})-\\d{1,6}\\b`, 'i')

/** A Sacred Book document, by its checkout path or its GitHub URL: the feature's folder. */
const BOOK_PATH = /sacred-book\/(?:blob\/main\/|tree\/main\/)?(v[12]\/[\w-]+\/(?:bug\/)?[\w-]+)\//

/** Queries that found no feature: a module value, so each is searched once a load. */
const missed = new Set<string>()


const focus = atom({ plugin: 'focus-pane', key: 'focus' } as const, {
  ticket: null,
  mission: null,
  isMissionPhrased: false,
  summary: null,
  branch: null,
  ask: '',
  isPinned: false,
  isDismissed: false,
})
const todos = atom({ plugin: 'focus-pane', key: 'todos' } as const, [])
const feed = atom({ plugin: 'focus-pane', key: 'feed' } as const, [])
const usage = atom({ plugin: 'focus-pane', key: 'usage' } as const, {
  tokens: null,
  window: 0,
  percent: null,
  usd: null,
  startedAt: null,
})
const turn = atom({ plugin: 'focus-pane', key: 'turn' } as const, {
  count: 0,
  isRunning: false,
  startedAt: null,
  lastMs: null,
})
const board = atom({ plugin: 'focus-pane', key: 'board' } as const, { notes: [], chores: [], serial: 0 })
const feature = atom({ plugin: 'focus-pane', key: 'feature' } as const, null)
const gallery = atom({ plugin: 'focus-pane', key: 'gallery' } as const, { status: 'idle', path: null, shots: [] })
const petStyle = atom({ plugin: 'focus-pane', key: 'petStyle' } as const, 'sprite')
const skin = atom({ plugin: 'focus-pane', key: 'skin' } as const, 'dark')
const command = atom({ plugin: 'focus-pane', key: 'command' } as const, null)

/** How many tool calls the feed remembers, and how many a pane shows at most. */
const FEED_KEPT = 60
const FEED_LEAST = 3

/** How many headings a spec or plan card lists before it counts the rest. */
const OUTLINE_SHOWN = 6
const OUTLINE_LEAST = 2

/** The fewest todo rows kept when the pane is short, and the lines a brief may wrap to. */
const TODOS_LEAST = 4
const BRIEF_LINES = 2

const SACRED_BOOK = 'https://github.com/unlocker-io/sacred-book/blob/main'

/**
 * Finds a feature of the Sacred Book checkout by its folder name, else by a word
 * of its README (a ticket key), and prints its path, then its README.
 */
const FIND = `
cd "\${SACRED_BOOK_DIR:-$HOME/Sites/sacred-book}" || exit 2
d=$(find v1 v2 -maxdepth 4 -type d -name "$1" 2>/dev/null | head -n 1)
[ -z "$d" ] && d=$(grep -rliw --include=README.md -- "$1" v1 v2 2>/dev/null | head -n 1 | xargs -r dirname)
[ -z "$d" ] && exit 1
echo "$d"
cat "$d/README.md"
`

const CAT = 'cd "${SACRED_BOOK_DIR:-$HOME/Sites/sacred-book}" && cat -- "$1"'

/**
 * Opens a mockup in the browser: the signed URL the dev API hands for it, else
 * the checkout's own file. The token stays in the shell's environment.
 */
const OPEN = `
u=$(curl -fsS -m 10 -G -H "Authorization: Bearer $API_DEV_UNLKR" --data-urlencode "path=$1" \
  https://dev.unlkr.io/api/v1/designs/url 2>/dev/null \
  | sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p' | sed 's/\\\\\\//\\//g; s/\\\\u0026/\\&/g')
[ -z "$u" ] && u="\${SACRED_BOOK_DIR:-$HOME/Sites/sacred-book}/$1" && [ ! -f "$u" ] && exit 1
xdg-open "$u" >/dev/null 2>&1
`

/** The share of the pane's height the person's notes and todo take, together. */
const DESK_SHARE = 0.3

/** Numbers the feed rows: a module value, a reload only needs them unique from then on. */
let sequence = 0

/** The redraw ticker: a module value, so a reload drops it with its timer. */
let ticker: Timer | undefined

// ------------------------------------------------------------------- the pet

/**
 * The cat that walks the bottom of the pane: 14 by 6 pixels facing right, two a
 * terminal row. `b` fur, `d` stripe, `e` eye, `w` bib, `.` nothing.
 */
const SPRITE = {
  walk: [
    ['t.........b.b.', 't.........bbb.', '.t.bbbbbbbbeb.', '.tbbdbdbbbbbb.', '..bbbbbbbww...', '..b.b...b.b...'],
    ['..........b.b.', 'tt........bbb.', '..tbbbbbbbbeb.', '..bbdbdbbbbbb.', '..bbbbbbbww...', '...b.b.b.b....'],
  ],
  sleep: [
    '..............',
    '..............',
    '..............',
    '...bbbbbb.b.b.',
    '.tbbdbdbbbbbb.',
    'ttbbbbbbbbbbb.',
  ],
} as const
const CAT_COLUMNS = 14
const PET_ROWS = 3
const FUR: Record<string, string> = { b: '#e9a45b', t: '#e9a45b', d: '#b9722f', e: '#10141f', w: '#f7ecdc' }

/** Its pace: a step every tick, slow at rest, quick in a turn; then it sleeps. */
const PET_REST_MS = 1500
const PET_WORK_MS = 500
const PET_SLEEPS_AFTER = 200

/**
 * Where it is and how it feels: module values, since nothing but the drawing
 * reads them and a reload may well start it over from the left.
 */
const pet = { x: 0, heading: 1 as 1 | -1, step: 0, restTicks: 0, isAsleep: false, mood: '', moodTicks: 0 }

/** A passing feeling, shown beside its head for a few ticks: `!`, `♪`. */
const feel = (mood: string) => {
  actor.react = mood === '!' ? 'alert' : 'happy'
  if (mood === '!') {
    burst(7, 'x', SCENE.hurt, 0.5)
    say('Aïe.', 2500)
  } else {
    burst(8, '*', SCENE.spark, 0.6)
    say('Une de moins !', 3000)
  }
  pet.mood = mood
  pet.moodTicks = 4
  pet.isAsleep = false
}

/** One tick of the walk: `reach` is how far a step goes. The drawing bounds `x`. */
const walk = (reach: number) => {
  pet.step += 1
  pet.x += pet.heading * reach
  if (pet.moodTicks > 0) pet.moodTicks -= 1
}

/** Starts the ticker at a turn's pace or at rest's; at rest it ends in sleep. */
const pace = ($: EngineInterface, isWorking: boolean) => {
  ticker?.cancel()
  pet.restTicks = 0
  pet.isAsleep = false
  actor.isCalled = true
  actor.isAwaited = false
  animate($, isWorking)
  ticker = $.clock.every(isWorking ? PET_WORK_MS : PET_REST_MS, () => {
    if (!isWorking) {
      pet.restTicks += 1
      if (pet.restTicks > PET_SLEEPS_AFTER) {
        // Asleep it stands still: no more ticks, no more redraws.
        pet.isAsleep = true
        ticker?.cancel()
        ticker = undefined
      }
    }
    if (!pet.isAsleep) walk(isWorking ? 2 : 1)
    $.ui.invalidate('ui.render')
  })
}

/**
 * The sitting cat, in line art: every character one cell wide, so the drawing
 * holds in any monospace font. `eyes` and `tail` are swapped in as it lives.
 */
const LINE_CAT = [
  '      />     ﾌ',
  '      |  EYES |',
  '     /` ﾐ_x ﾉ',
  '    /       |',
  '   /   \\    ﾉ',
  '   |   | | |',
  ' /‾|   | | |',
  ' | (‾\\__\\_)__)',
  'TAIL',
] as const
const LINE_COLUMNS = 16
const LINE_ROWS = LINE_CAT.length

/** The sitting cat's nine lines, pushed `left` columns in, as it feels now. */
const lineCat = (columns: number, isWorking: boolean, mood: string) => {
  const span = Math.max(1, columns - LINE_COLUMNS - 2)
  const lap = ((pet.x % (span * 2)) + span * 2) % (span * 2)
  const left = ' '.repeat(lap < span ? lap : span * 2 - lap)
  // Dozing at rest, wide awake in a turn, a blink now and then.
  const eyes = pet.isAsleep ? '-  -' : pet.step % 7 === 0 ? '-  -' : isWorking ? 'o  o' : '_  _'
  const tail = pet.isAsleep || pet.step % 2 === 0 ? ' \\=⊃' : ' \\_⊃'

  return LINE_CAT.map((row, at) => {
    const drawn = row.replace('EYES', eyes).replace('TAIL', tail)

    return `${left}${drawn}${at === 0 && mood ? `  ${mood}` : ''}`
  })
}

/** `sprite`, `3d`, `line`, `pixel` or `off`, from a command or the store; `on` and old booleans too. */
const asPetStyle = (value: unknown): PetStyle | null =>
  value === 'png' || value === 'big' || value === 'sprite' || value === '3d' || value === 'line' || value === 'pixel' || value === 'off'
    ? value
    : value === 'on' || value === true
      ? 'sprite'
      : value === false
        ? 'off'
        : null

// --------------------------------------------------------------- the 3D cat

/** The 3D cat's sprite, in pixels: two pixel rows a terminal row. */
const CAT3_W = 30
const CAT3_H = 20
const CAT3_ROWS = CAT3_H / 2

/** How the 3D cat stands this frame. */
type Pose = {
  /** Turn about the vertical: 0 faces right, -π left, -π/2 the viewer. */
  yaw: number
  /** -1 to 1: where the walk cycle swings the legs. */
  swing: number
  /** -1 to 1: where the tail sways. */
  tail: number
  /** 0 standing, 1 lying with its legs tucked under. */
  tuck: number
  isBlinking: boolean
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/** A smooth union: two shapes melt into one where they meet. */
const blend = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k

  return Math.min(a, b) - h * h * k * 0.25
}

const blob = (
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
) => {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  const dz = (z - cz) / rz

  return (Math.sqrt(dx * dx + dy * dy + dz * dz) - 1) * Math.min(rx, ry, rz)
}

const limb = (
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
) => {
  const px = x - ax
  const py = y - ay
  const pz = z - az
  const ex = bx - ax
  const ey = by - ay
  const ez = bz - az
  const h = clamp01((px * ex + py * ey + pz * ez) / (ex * ex + ey * ey + ez * ez))

  return Math.hypot(px - ex * h, py - ey * h, pz - ez * h) - r
}

/** The cat as a distance field, in its own space: it faces +x, y is up. */
const catField = (x: number, y: number, z: number, pose: Pose) => {
  const drop = 0.26 * pose.tuck
  const hip = 0.5 - drop
  const reach = 0.16 * pose.swing * (1 - pose.tuck)
  const foot = 0.04

  let d = blob(x, y, z, 0, hip, 0, 0.5, 0.26, 0.25)
  d = blend(d, blob(x, y, z, 0.5, hip + 0.3 - 0.12 * pose.tuck, 0, 0.25, 0.24, 0.25), 0.08)
  d = blend(d, blob(x, y, z, 0.72, hip + 0.22 - 0.12 * pose.tuck, 0, 0.1, 0.08, 0.11), 0.05)
  const earY = hip + 0.55 - 0.12 * pose.tuck
  d = blend(d, blob(x, y, z, 0.47, earY, 0.14, 0.07, 0.13, 0.06), 0.03)
  d = blend(d, blob(x, y, z, 0.47, earY, -0.14, 0.07, 0.13, 0.06), 0.03)
  // Diagonal pairs swing together, as a cat walks.
  d = blend(d, limb(x, y, z, 0.3, hip - 0.1, 0.13, 0.3 + reach, foot, 0.13, 0.075), 0.05)
  d = blend(d, limb(x, y, z, 0.3, hip - 0.1, -0.13, 0.3 - reach, foot, -0.13, 0.075), 0.05)
  d = blend(d, limb(x, y, z, -0.3, hip - 0.1, 0.13, -0.3 - reach, foot, 0.13, 0.075), 0.05)
  d = blend(d, limb(x, y, z, -0.3, hip - 0.1, -0.13, -0.3 + reach, foot, -0.13, 0.075), 0.05)
  d = blend(
    d,
    limb(x, y, z, -0.45, hip + 0.08, 0, -0.74, hip + 0.5 - 0.3 * pose.tuck, 0.3 * pose.tail, 0.055),
    0.05,
  )

  return d
}

const FUR3 = [233, 164, 91]
const STRIPE3 = [178, 106, 44]
const BIB3 = [247, 232, 212]
const EYE3 = [16, 20, 31]
const NOSE3 = [232, 120, 130]

/** What the cat's coat is at a point of its surface. */
const catCoat = (x: number, y: number, z: number, pose: Pose) => {
  const hip = 0.5 - 0.26 * pose.tuck
  const headY = hip + 0.3 - 0.12 * pose.tuck
  if (!pose.isBlinking && Math.hypot(x - 0.7, y - (headY + 0.06), Math.abs(z) - 0.13) < 0.065) return EYE3
  if (Math.hypot(x - 0.82, y - (headY - 0.05), z) < 0.04) return NOSE3
  // White socks, and a white tip to the tail.
  if (y < 0.11 && pose.tuck < 0.5) return BIB3
  if (x < -0.66) return BIB3
  if (Math.abs(x) < 0.4 && y > hip + 0.05 && Math.sin(x * 24) > 0.45) return STRIPE3

  return FUR3
}

const CAM_TILT = 0.32
const CAM_COS = Math.cos(CAM_TILT)
const CAM_SIN = Math.sin(CAM_TILT)
const LIGHT = [0.45, 0.78, 0.44]

/**
 * Ray-marches the cat into CAT3_W by CAT3_H pixels, 0xRRGGBB each, or -1 where
 * the ray meets nothing. An orthographic camera, a little above, looking in.
 */
const renderCat = (pose: Pose) => {
  const out = new Int32Array(CAT3_W * CAT3_H)
  const cos = Math.cos(pose.yaw)
  const sin = Math.sin(pose.yaw)
  const scale = 2.3 / CAT3_W
  // The camera and the light, turned into the cat's own space.
  const turn = (x: number, y: number, z: number) => [x * cos - z * sin, y, x * sin + z * cos] as const
  const [fx, fy, fz] = turn(0, -CAM_SIN, -CAM_COS)
  const [lx, ly, lz] = turn(LIGHT[0] ?? 0, LIGHT[1] ?? 0, LIGHT[2] ?? 0)
  const field = (x: number, y: number, z: number) => catField(x, y, z, pose)

  for (let j = 0; j < CAT3_H; j += 1) {
    for (let i = 0; i < CAT3_W; i += 1) {
      const u = (i + 0.5 - CAT3_W / 2) * scale
      const v = (CAT3_H / 2 - j - 0.5) * scale + 0.52
      const [ox, oy, oz] = turn(u, v * CAM_COS + 3 * CAM_SIN, -v * CAM_SIN + 3 * CAM_COS)
      let t = 1.6
      let hit = false
      for (let step = 0; step < 28 && t < 4.6; step += 1) {
        const d = field(ox + fx * t, oy + fy * t, oz + fz * t)
        if (d < 0.012) {
          hit = true
          break
        }
        t += d
      }
      if (!hit) {
        out[j * CAT3_W + i] = -1
        continue
      }
      const x = ox + fx * t
      const y = oy + fy * t
      const z = oz + fz * t
      const e = 0.02
      const nx = field(x + e, y, z) - field(x - e, y, z)
      const ny = field(x, y + e, z) - field(x, y - e, z)
      const nz = field(x, y, z + e) - field(x, y, z - e)
      const n = Math.hypot(nx, ny, nz) || 1
      const lit = 0.42 + 0.7 * Math.max(0, (nx * lx + ny * ly + nz * lz) / n)
      const coat = catCoat(x, y, z, pose)
      const tone = (at: number) => Math.min(255, Math.round((coat[at] ?? 0) * lit))
      out[j * CAT3_W + i] = (tone(0) << 16) | (tone(1) << 8) | tone(2)
    }
  }

  return out
}

/** Where the 3D cat is in its walk: module values, as the other cats' are. */
const cat3 = { x: 4, heading: 1 as 1 | -1, yaw: 0, phase: 0, look: 0, frame: 0 }

/** Its own clock, quicker than the pane's: frames go out by `$.ui.blit`. */
const CAT3_FRAME_MS = 90
let animator: Timer | undefined

/** What the strip is drawn at, from the last render: a blit must match it. */
const stage = { columns: 0, ground: '', ink: '', mood: '', style: '' as PetStyle | '', left: 0, root: '' }

/**
 * The `png` cat: a real Image, one file a frame, where the terminal draws
 * pictures. 64 by 36 pixels over 32 columns by 9 rows keeps them square.
 */
const PNG_COLUMNS = 32
const PNG_ROWS = 9

/** Why the terminal would not draw the Image, once it said so: the sprite cat takes over. */
let imageRefusal = ''

const FACING_VIEWER = -Math.PI / 2

/** One frame of its life: it walks, turns round at an edge, stops to look at you. */
const stepCat3 = (isWorking: boolean) => {
  cat3.frame += 1
  const span = Math.max(1, stage.columns - CAT3_W)
  if (pet.isAsleep) return
  if (cat3.look > 0) cat3.look -= 1
  else if (!isWorking && Math.random() < 0.006) cat3.look = 28

  const goal = cat3.look > 0 ? FACING_VIEWER : cat3.heading > 0 ? 0 : -Math.PI
  const off = goal - cat3.yaw
  cat3.yaw += Math.max(-0.22, Math.min(0.22, off))
  // It walks only once it faces the way it goes.
  if (cat3.look > 0 || Math.abs(off) > 0.3) return

  const pace3 = isWorking ? 0.55 : 0.2
  cat3.x += cat3.heading * pace3
  cat3.phase += pace3 * 1.1
  if (cat3.x >= span) {
    cat3.x = span
    cat3.heading = -1
  } else if (cat3.x <= 0) {
    cat3.x = 0
    cat3.heading = 1
  }
}

/** The strip the 3D cat walks, as Raster cells: `columns` wide, CAT3_ROWS tall. */
const cat3Strip = (columns: number, ground: string, ink: string, mood: string) => {
  const isStill = pet.isAsleep || cat3.look > 0
  const sprite = renderCat({
    yaw: pet.isAsleep ? 0.5 : cat3.yaw,
    swing: isStill ? 0 : Math.sin(cat3.phase),
    tail: Math.sin(cat3.frame * 0.22),
    tuck: pet.isAsleep ? 1 : 0,
    isBlinking: pet.isAsleep || cat3.frame % 46 < 2,
  })
  const left = Math.round(Math.max(0, Math.min(cat3.x, columns - CAT3_W)))
  const base = rgb(ground)
  const words = new Uint32Array(columns * CAT3_ROWS * 3)
  const at = (row: number, x: number) => {
    const inSprite = x - left
    if (inSprite < 0 || inSprite >= CAT3_W) return base
    const seen = sprite[row * CAT3_W + inSprite] ?? -1

    return seen < 0 ? base : seen
  }
  for (let row = 0; row < CAT3_ROWS; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const cell = (row * columns + x) * 3
      words[cell] = LOWER_HALF
      words[cell + 1] = at(row * 2 + 1, x)
      words[cell + 2] = at(row * 2, x)
    }
  }
  if (mood) {
    const beside = cat3.heading > 0 ? left + CAT3_W - 4 : left + 3
    if (beside >= 0 && beside < columns) {
      words[beside * 3] = mood.codePointAt(0) ?? 0x20
      words[beside * 3 + 1] = rgb(ink)
      words[beside * 3 + 2] = base
    }
  }

  return toBase64(new Uint8Array(words.buffer))
}

/** The file of the frame the sprite cat is on, as scripts/build-frames.py names them. */
const frameFile = () =>
  `${stage.root}/assets/frames/${actor.beat.clip}-${actor.beat.frames[actor.at] ?? 0}${actor.beat.isFlipped ? '-flip' : ''}.png`

/** Where the `png` cat stands, in columns from the left of its strip. */
const pngLeft = (columns: number) => Math.round(Math.max(0, Math.min(actor.x, columns - PNG_COLUMNS)))

/** Starts the animated cat's frames, 3D or sprite; each goes out by `$.ui.blit`. */
const animate = ($: EngineInterface, isWorking: boolean) => {
  animator?.cancel()
  let waited = 0
  animator = $.clock.every(SPRITE_TICK_MS, () => {
    if (stage.columns === 0) return
    if (stage.style === 'png') {
      if (!stepSprite(SPRITE_TICK_MS, isWorking, stage.columns)) return
      // A step sideways moves the picture in the layout: that is a redraw. A
      // new frame in place is a swap of its file, with no redraw.
      if (pngLeft(stage.columns) !== stage.left) {
        $.ui.invalidate('ui.render')

        return
      }
      void $.ui
        .blit({ requestId: PANE, key: 'petimg', source: { file: frameFile(), format: 'png' } })
        .then(told => {
          if (told.deny === undefined || imageRefusal !== '') return
          imageRefusal = told.deny
          $.ui.toast(`focus-pane : pas d'image dans ce terminal (${told.deny}) — chat en sprites`)
          $.ui.invalidate('ui.render')
        })
        .catch(() => undefined)

      return
    }
    if (stage.style === 'sprite' || stage.style === 'big') {
      // Two clocks, one frame: the cat's and the scene's. Either moving redraws.
      const hasStepped = stepSprite(SPRITE_TICK_MS, isWorking, stage.columns)
      const hasStirred = stepScene(SPRITE_TICK_MS)
      if (!hasStepped && !hasStirred) return
      void $.ui
        .blit({
          requestId: PANE,
          key: 'pet',
          columns: stage.columns,
          rows: stripRows(),
          cells: spriteStrip(stage.columns, stage.ground, stage.ink, stage.mood === "'" ? "'" : ''),
        })
        .catch(() => undefined)

      return
    }
    if (stage.style !== '3d') return
    waited += SPRITE_TICK_MS
    if (waited < CAT3_FRAME_MS) return
    waited = 0
    stepCat3(isWorking)
    void $.ui
      .blit({
        requestId: PANE,
        key: 'pet',
        columns: stage.columns,
        rows: CAT3_ROWS,
        cells: cat3Strip(stage.columns, stage.ground, stage.ink, stage.mood),
      })
      .catch(() => undefined)
  })
}

// ------------------------------------------------------------ the sprite cat

// <sprites> generated by scripts/build-sprites.py from the sheets under assets/ — do not edit
const SPRITE_W = 32
const SPRITE_H = 24
const SPRITE_INK = 'abcdefghi'
const SPRITE_PALETTE = [0x7a4524, 0xe8873a, 0xfbf3e6, 0xb65a22, 0xf28fa0, 0x2b1b16, 0xf6b56b, 0xc96f2c, 0xd8c7b0]
const CLIPS = {
  walk: {
    ms: 110,
    frames: [
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha.................abbhaagaabbahha.................abbha.a.abbaiia.................aicca...accaiia.................aicca...accaaa...................aaa.....aa..............',
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha................abbhhaagaabbaahha................abbia.aabba.aiia................accia..acca.aiia................acca...acca..aa..................aa.....aa...............',
      '...................................................................................................................................................................................a...a..........................aba.aba.............aa..........aba.aba............acca........abdbabeba...........acca........abbdbdbbba.........accca.......abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbggggggbbgaahha...............abbaiiagabba.ahha...............accaiiaacca...aiia..............accaaa.acca...aiia...............aa.....aa.....aa.........',
      '...................................................................................................................................................a...a..........................aba.aba.............aa..........aba.aba............acca........abdbabeba...........acca........abbdbdbbba.........accca.......abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha................abbaahhgabbaahha...............abba.aiiaacca.ahha..............acca.aiiaacca.aiia..............acca..aa..aa..aiia...............aa............aa..........',
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha...............abbaaahhgaabbahha...............abba.ahha.accahha..............acca...aiiaaccaiia..............acca...aiia.aaaiia...............aa.....aa.....aa...........',
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha...............abbaahhagaaabbhha...............acca.ahha..accha................acca.aiia..accia.................aa..aiia...aiia......................aa.....aa............',
      '...................................................................................................................................................................................a...a..........................aba.aba...........aa............aba.aba..........acca..........abdbabeba.........acca..........abbdbdbbba........accca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbggggggggbbha.................accahhagaaabbha.................accaiiaa..aicca..................aaaiia...aicca.....................aa.....aaa............',
      '...................................................................................................................................................a...a..........................aba.aba...........aa............aba.aba..........acca..........abdbabeba.........acca..........abbdbdbbba........accca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha.................abbhhagaabbhha..................accha.a..abbia..................accia....accia...................aiia....acca.....................aa......aa.............',
    ],
  },
  run: {
    ms: 75,
    frames: [
      '...................................................................................................................................................................................a...a..........................aba.aba..........aa.............aba.aba.........acca...........abdbabeba........acca.......a...abbdbdbbba.......accca..aaaabaaabbbdbbbbbba.......accdaabbddbddbdbbbbbfcbba........addbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa..........abbaggggggggbbha.a..............abbaaahhgaaabbha...............abba...ahha.ahbba...............acca...ahha.aibba..............acca.....aiiaiiacca..............aa......aiiaaaacca.......................aa....aa...........',
      '...................................................................................................................................................a...a............aa............aba.aba..........acca...........aba.aba..........acca..........abdbabeba.........acca......a...abbdbdbbba........acca..aaaabaaabbbdbbbbbba.......addbaabbddbddbdbbbbbfcbba........abbbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa...........abbgggggggbbahhaa...............abbahhagaabbahha...............abbaahhaa.abbhha................acca.ahha..abbia................acca.ahha..abbia.................aa..aiia..acca......................aiia..acca.......................aa....aa.............',
      '...................................................................................................................................................................................a...a..........................aba.aba..........aa.............aba.aba.........acca...........abdbabeba........acca.......a...abbdbdbbba.......accca..aaaabaaabbbdbbbbbba.......accdaabbddbddbdbbbbbfcbba........addbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa...........abbgggggggbbahhaa...............abbahhagaabbahha.................abbha.aabba.ahha................accha..abba.aiia................accia..acca.aiia.................aiia..acca..aa...................aa....aa...............',
      '...................................................................................................................................................................................a...a............aa............aba.aba..........acca...........aba.aba..........acca..........abdbabeba.........acca......a...abbdbdbbba........acca..aaaabaaabbbdbbbbbba.......addbaabbddbddbdbbbbbfcbba........abbbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa............abbgggggbbgaahha................abbhaagabba.ahha................ahbba.abba...ahha...............aibba.acca...ahha..............aiiaccacca.....aiia..............aaaccaaa......aiia.................aa..........aa........',
      '...................................................................................................................................................a...a..........................aba.aba..........aa.............aba.aba.........acca...........abdbabeba........acca.......a...abbdbdbbba.......accca..aaaabaaabbbdbbbbbba.......accdaabbddbddbdbbbbbfcbba........addbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa...........abbgggggggbbahhaa...............abbahhagaabbahha................abbhha.aabbaahha.................abbia..acca.ahha................abbia..acca.ahha................acca....aa..aiia................acca........aiia.................aa..........aa..........',
      '...................................................................................................................................................................................a...a............aa............aba.aba..........acca...........aba.aba..........acca..........abdbabeba.........acca......a...abbdbdbbba........acca..aaaabaaabbbdbbbbbba.......addbaabbddbddbdbbbbbfcbba........abbbddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggga..........abbbbbbbbbbbbbhabaaaa...........abbgggggggbbahhaa...............abbahhagaabbahha...............abba.ahha..abbha................abba.aiia..accha................acca.aiia..accia................acca..aa....aiia.................aa..........aa............',
    ],
  },
  turn: {
    ms: 100,
    frames: [
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbbbbba........acca.....a...abbbbbfcbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha................abbahhagaabbahha................abbahhaa.abbahha................accaiia..accaiia................accaiia..accaiia.................aa.aa....aa.aa...........',
      '..................................................................................................................................................a.....a........................aba...aba............aa.........abaaaaaba...........acca.......abebbbbbeba..........acca.......abbbbdbdbba..........acca......abbbbbbbbbbba.........acca......abbbfcbbbfcba.........addbaaaaaaadbbffbbbffba..........abbabbddbdbbbbbgeegbba..........abbddbdbbdbbbbgggggga............abdbbdbbdbbbbbgggga............abbdbbbbbbbbbbbbbaa..............abbbbbbbbbbbbaaa................abbbbbbbbbbbba..................abbggggggbbhha..................abbhhaaaabbhha..................abbhha..abbhha..................acciia..acciia..................acciia..acciia...................aaaa....aaaa............',
      '................................................................................................................................................a.....a........................aba...aba................aa.....abaaaaaba...............acca...abebbbbbeba..............acca...abbbbdbdbba..............acca..abbbbbbbbbbba.............acca..abbbfcbbbfcba.............addbaaadbbffbbbffba..............abbddbbbbbbgeegbba..............abbdbbdbbbgggggga................abdbbdbbbbgggga................abbbbbbbbbbbbaa..................abbbbbbbbbba....................abbbbbbbbbba....................abbgggbbgga.....................abbhhabbhha.....................abbhhabbhha.....................acciiacciia.....................acciiacciia......................aaaa.aaaa.............',
      '..............................................................................................................................................a.....a........................aba...aba....................aa.abaaaaaba...................accabebbbbbeba..................accabbbbdbdbba..................accbbbbbbbbbbba.................accbbbfcbbbfcba.................adddbbffbbbffba..................abbbbbbgeegbba..................abbbbbgggggga...................abbdbbbgggga....................abbbbbbbbba.....................abbbbbbbbba.....................ahbbbbbbbhha....................ahhbbggbbhha....................ahhbbgabbhha....................ahhbbaabbhha....................aiiccaacciia....................aiiccaacciia.....................aaaa..aaaa...........',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba...................aaebabbbbabea..................accbedbddbdeba..................acbbbbbbbbbbbba................accbbfcbbbbfcbba................accdbffbbbbffbda................adddbbbgeegbbbda.................abbbbggggggbba..................abbdbbggggbba....................addbbbbbbbba.....................abbbbbbbbbba....................aabbbbbbbbaa...................ahhbbbbbbbbhha..................ahhabbbbbbahha..................ahhabbaabbahha..................aiiaccaaccaiia..................aiiaccaaccaiia...................aa.aa..aa.aa..........',
    ],
  },
  sit: {
    ms: 180,
    frames: [
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbfcbbbbfcbba..................adbffbbbbffbda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba.....................abbbbbbbbbba....aa.............adbbbggggbbbda..acca............adbbbbggbbbbda..acca............abbbbbggbbbbba..acca...........abbbbbbggbbbbbba.acca...........abbbbbbbbbbbbbbaabdda...........abbbbccbbccbbbbdbbba.............abbbccbbccbbbbdbba...............aaaaaaaaaaaaaaaa......',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbfcbbbbfcbba..................adbffbbbbffbda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba.....................abbbbbbbbbba...................adbbbggggbbbda..................adbbbbggbbbbda....aa............abbbbbggbbbbba...acca..........abbbbbbggbbbbbba.aacca..........abbbbbbbbbbbbbbaadccca..........abbbbccbbccbbbbbbdcca............abbbccbbccbbbdbbbaa..............aaaaaaaaaaaaaaaa......',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbfcbbbbfcbba..................adbffbbbbffbda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba.....................abbbbbbbbbba...................adbbbggggbbbda..................adbbbbggbbbbda..................abbbbbggbbbbba.................abbbbbbggbbbbbba................abbbbbbbbbbbbbbaaaaaa...........abbbbccbbccbbbbbdcccca...........abbbccbbccbbbbbdcccca............aaaaaaaaaaaaaaaaaaa...',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbbbbbbbbbbba..................adbaabbbbaabda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba.....................abbbbbbbbbba...................adbbbggggbbbda..................adbbbbggbbbbda....aa............abbbbbggbbbbba...acca..........abbbbbbggbbbbbba.aacca..........abbbbbbbbbbbbbbaadccca..........abbbbccbbccbbbbbbdcca............abbbccbbccbbbdbbbaa..............aaaaaaaaaaaaaaaa......',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbfcbbbbfcbba..................adbffbbbbffbda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba.....................abbbbbbbbbba....aa.............adbbbggggbbbda..acca............adbbbbggbbbbda..acca............abbbbbggbbbbba..acca...........abbbbbbggbbbbbba.acca...........abbbbbbbbbbbbbbaabdda...........abbbbccbbccbbbbdbbba.............abbbccbbccbbbbdbba...............aaaaaaaaaaaaaaaa......',
      '...........................................................................................................................................a........a.....................aba......aba....................aba.aaaa.aba....................aebabbbbabea....................abedbddbdeba...................abbbbbbbbbbbba..................abbfcbbbbfcbba..................adbffbbbbffbda..................adbbbgeegbbbda...................abbggggggbba.....................abbggggbba....aa...............abbbbbbbbbba..acca.............adbbbggggbbbda.acca.............adbbbbggbbbbda.accca............abbbbbggbbbbba..acca...........abbbbbbggbbbbbbaabdda...........abbbbbbbbbbbbbbaabba............abbbbccbbccbbbbbdbba.............abbbccbbccbbbbbdda...............aaaaaaaaaaaaaaaa......',
    ],
  },
  sleep: {
    ms: 500,
    frames: [
      '..............................................................................................................................................................................................................................................................................................................................................................................................................aa.........................aaaaaddaaaa....a..............aabbddbdbbdbbaa.aba............abddbdbbbbbdebbbaaea...........abbdbbbbbbbbbbbdbdbba...........abbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbaabaabba..........abbbbbbbbbbbbbbgegbbba...........abdbbdbbdcccbbgggbcca............adbbdbbdccccaabaacca.............aaaaaaaaaaa..a..aa......',
      '..............................................................................................................................................................................................................................................................................................................................................................................aa.........................aaaaaddaaaa...................aabbddbdbbddbaa..a.............abddbdbbbbbdbbbbaaba...........abbdbbbbbbbbbebbbbaea..........abbbbbbbbbbbbbbbdbdbba..........abbbbbbbbbbbbbbbbbbbbba.........abbbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbaabaabba..........abbbbbbbbbbbbbbgegbbba...........abdbbdbbdcccbbgggbcca............adbbdbbdccccaabaacca.............aaaaaaaaaaa..a..aa......',
      '..............................................................................................................................................................................................................................................................................................................................................................................aa.........................aaaaaddaaaa...................aabbddbdbbddbaa..a.............abddbdbbbbbdbbbbaaba...........abbdbbbbbbbbbebbbbaea..........abbbbbbbbbbbbbbbdbdbba..........abbbbbbbbbbbbbbbbbbbbba.........abbbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbaabaabba..........abbbbbbbbbbbbbbgegbbba...........abdbbdbbdcccbbgggbcca............adbbdbbdccccaabaacca.............aaaaaaaaaaa..a..aa......',
      '..............................................................................................................................................................................................................................................................................................................................................................................................................aa.........................aaaaaddaaaa....a..............aabbddbdbbdbbaa.aba............abddbdbbbbbdebbbaaea...........abbdbbbbbbbbbbbdbdbba...........abbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbbbbbbbba..........abbbbbbbbbbbbbaabaabba..........abbbbbbbbbbbbbbgegbbba...........abdbbdbbdcccbbgggbcca............adbbdbbdccccaabaacca.............aaaaaaaaaaa..a..aa......',
    ],
  },
  happy: {
    ms: 120,
    frames: [
      '...................................................................................................................................................................................a...a..............aa..........aba.aba............acca.........aba.aba............acca........abdbabeba..........accca........abbdbdbbba.........acca........abbbdbbbbbba........adda.....a...abbbbbbabba........abba.aaaabaaabdbbbbagagba.......abbdabbddbddbdbdbbbggggea........adbddbdbbdbbdbbbbbggggga........abbdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha...............abbahhaagaaabbahha..............accaiia.a..accaiia..............accaiia....accaiia...............aa.aa......aa.aa..........',
      '...................................................a...a..........................aba.aba.........................aba.aba...........aa...........abdbabeba.........acca..........abbdbdbbba........acca.........abbbdbbbbbba.......accca.....a...abbbbbbabba........acca.aaaabaaabdbbbbagagba.......addbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga........abbdbbdbbdbbdbbbbbbggea.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbggggggggbbahha..............abbahhaagaaabbahha..............abbahha.a...accaiia............accaiia......accaiia............accaiia.......aa.aa..............aa.aa......................................................................................................................',
      '...................a...a...............aaa........aba.aba.............accca.......aba.aba............acccca......abdbabeba...........accaa.......abbdbdbbba.........abdda.......abbbdbbbbbba........abba.....a...abbbbbbabba........abbdaaaaabaaabdbbbbagagba........addabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggea.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha.................abbgggggggbbaiia................abbahhgaaaccaaiia................accaiia..accaaa.................accaiia...aa.....................aa.aa..................................................................................................................................................................................',
      '...................................................................................................................................................a...a...............aaa........aba.aba.............accca.......aba.aba............acccca......abdbabeba...........accaa.......abbdbdbbba.........abdda.......abbbdbbbbbba........abba.....a...abbbbbbabba........abbdaaaaabaaabdbbbbagagba........addabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha................abbahhagaabbahha...............abbahha.a..abbahha..............accaiia....accaiia..............accaiia....accaiia...............aa.aa......aa.aa..........',
    ],
  },
  alert: {
    ms: 130,
    frames: [
      '...................................................................................................................................................a...a..........................aba.aba............aa...........aba.aba...........acca.........abdbabeba..........acca.........abbdbdbbba.........acca........abbbdbbfcbba........acca.....a...abbbbbffbba........addbaaaaabaaabdbbbbffggba........abbabbddbddbdbdbbbggggea........abbddbdbbdbbdbbbbbggggga.........abdbbdbbdbbdbbbbbbggga.........abbdbbbbbbbbbbbbabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbbha................abbgggggggbbahha................abbahhagaabbahha................abbahhaa.abbahha................accaiia..accaiia................accaiia..accaiia.................aa.aa....aa.aa...........',
      '...................................................................................a...a.............aaa..........aba.aba...........accca.........aba.aba...........accca........abdbabeba..........accca.a.aaa.aabbdbdbbba.........acccbababbbabbbbdbbfcbba........acccbbbddbddbdbbbbbffbba........adddddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggea..........abbbbbbbbbbbbbaabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbhha................abbgggggggbbahha................abbahhagaabbahha................abbahhaa.abbahha................accaiia..accaiia................accaiia..accaiia.................aa.aa....aa.aa...........................................................................',
      '...................................................................................................................................................a...a.............aaa..........aba.aba...........accca.........aba.aba...........accca........abdbabeba..........accca.a.aaa.aabbdbdbbba.........acccbababbbabbbbdbbfcbba........acccbbbddbddbdbbbbbffbba........adddddbdbbdbbbdbbbbffggba........abbdbbdbbdbbdbdbbbggggea........abbdbbbbbbbbbbbbbbggggga........abbbbbbbbbbbbbbbbbbggea..........abbbbbbbbbbbbbaabaaaa...........abbbbbbbbbbbbba.a...............abbbbbbbbbbbbhha................abbgggggggbbahha................abbahhagaabbahha................abbahhaa.abbahha................accaiia..accaiia................accaiia..accaiia.................aa.aa....aa.aa...........',
    ],
  },
} as const
const BIG_W = 64
const BIG_H = 36
const BIG_INK = 'abcdefghi'
const BIG_PALETTE = [0x7a4524, 0xe8873a, 0xfbf3e6, 0xf28fa0, 0xb65a22, 0x2b1b16, 0xf6b56b, 0xc96f2c, 0xd8c7b0]
const BIG_CLIPS = {
  walk: {
    ms: 110,
    frames: [
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa..........................aaa.......................abba....abba.........................aacca......................abbaaaaaabdaa........................aaccaa....................aaeeaaaaaabbaaa......................acccca....................abeeebbeebbeebbbaa...................aaccca.....................abbeebbeebbbbbbbbaa...................acbaa....................aabbeebbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbgahhhha..................................abbbbbbggggggggggggbbbbaahhhha...................................aabbbbhhaaaaaaaaaabbbbaahhhha....................................abbbbhha........abbbbaahhhha....................................abbbbhha........abbbbaaiiiia....................................accccaa.........accccaaiiiia....................................aiicccca........accccaaaaaaa....................................aiicccca........acccca.aaaa......................................aaaaaa..........aaaa............................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...........................aaa......................abba....abba..........................accaa.....................abbaaaaaabdaa.........................accaaa...................aaeeaaaaaabbaaa.......................bcccaa...................abeeebbeebbeebbbaa....................acccca....................abbeebbeebbbbbbbbaa...................abbbba...................aabbeebbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbaahhhha..................................abbbbhhggggggggggggbbbbaahhhha..................................abbbbhhhhaaaaaaaabbbbaa.ahhhha..................................abbbbiihha......abbbba..aaahha..................................abbbbiiiia......abbbba..aiiiiaa..................................aacccciia......acccca...aaiiaaa..................................accccaaa......acccca....aaaaaa..................................accccaa.......acccca.....aaaa....................................aaaa..........aaaa..............................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba............................aaa.....................abba....abba...........................aaaaa....................abbaaaaaabdaa..........................acccaa..................abeebaeebbeedba........................acccca..................abaeebbeebbeebbaaa.....................aaccca...................abbeebbeebbbbbbaaaa....................abbbaa..................abbbeebbbbbbbbffcfbba...................abbbaa..................abbbbbbbbbbbbbffffbbaa.................aabbba........aaaaaaaa...abbbeebbbbbbbbffffbbaa.................aaaeeaa..aaaaaebbeeebbaaaebeeeebbbbbbbbgggdddga..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbggggggddgga..................abbbbaaabbbeeebeebbbbeeebbbbbbbbbbbggggggggggaa..................aabbeeebbbeebbeebbbbeebggggggbbbbbgggggaggaaa....................abbeebbbbeebbeebbbbeebggggggbbbbbbgggagagaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaa..........................aabbbebbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbbbggggggggggbbbbbbbahhhha..................................abbbbaaggggggggggbbbbaaaahhhhaa.................................abbbbaahhhhaaaaaabbbba...aahhhha................................abbbbaaiiiia...aabbbba....ahhhha................................accccaaiiiia..accccaa.....aiiiia................................accccaaaaaaa..acccca......aaaiiaa...............................acccca.aaaa...acccca.......aaiiiia...............................aaaa..........aaaa..........aaaa..................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...........................aaa......................abba....abba..........................accaa.....................abbaaaaaabdaa.........................accaaa...................aaeeaaaaaabbaaa.......................bcccaa...................abeeebbeebbeebbbaa....................acccca....................abbeebbeebbbbbbbbaa...................abbbba...................aabbeebbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbaaggggggggggggbbaaaahhhha.................................aabbbbaaggggggggggbbbbaaaahhhha................................aaabbaa.ahhhhaaaaaabbbba..ahhhha................................abbbba..aaahha....abbbba..ahhhha................................abbbba..aiiiiaa...acccca..ahhhhaa...............................acccca...aaiiaaa..acccca...aaiiaaa..............................acccca....aaaaaa..aaaaaa....aiiiia..............................acccca.....aaaa....aaaa.....aiiiia...............................aaaa........................aaaa....................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa..........................aaa.......................abba....abba.........................aacca......................abbaaaaaabdaa........................aaccaa....................aaeeaaaaaabbaaa......................acccca....................abeeebbeebbeebbbaa...................aaccca.....................abbeebbeebbbbbbbbaa...................acbaa....................aabbeebbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha.................................aabbaaaaggggggggggggbbbbgahhhha................................abbbbaaaaggggggggggggbbbbaahhhha................................abbbba...aahhhhaaaaaabbbbaahhhha................................abbbba....ahhhha....abbbbaahhhha...............................aabbbba....ahhhha....accccaahhhha..............................aaaccaa.....aiiiiaa...accccaaiiiia..............................acccca.......aaiiiia..aaaaaaaiiiia..............................acccca........aiiiia...aaaa.aiiiia...............................aaaa..........aaaa..........aaaa......................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa.........................aaa........................abba....abba........................accaa.......................abbaaaaaabdaa.......................accaaa.....................aaeeaaaaaabbaaa.....................acccaa.....................abeeebbeebbeebbbaa..................acccca......................abbeebbeebbbbbbbbaa..................acbbaa....................aabbeebbbbbbbbbbbbaaa.................aabbea....................abbbbbbbbbbbbbffcfbbba.................abbeea........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha.................................aabbaaaaggggggggggggbbbbhahhhha................................abbbbaaaaggggggggggggbbbbaahhhha................................abbbba..ahhhhaaaaaaaabbbbhhhhaa.................................abbbba..ahhhha......aaabbhhhha..................................acccca..ahhhhaa.....acccchhhha..................................acccca...aaiiaaa.....aacccciia..................................aaaaaa....aiiiia......aaacciia...................................aaaa.....aiiiia.......aacciia.............................................aaaa..........aaaa........................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba........................aaa.........................abba....abba.......................aaaaa........................abbaaaaaabdaa......................acccaa......................abeebaeebbeedba....................acccca......................abaeebbeebbeebbaaa.................aaccca.......................abbeebbeebbbbbbaaaa.................acbbba.....................abbbeebbbbbbbbffcfbba.................bbbbaa....................abbbbbbbbbbbbbffffbbaa................bbbeaaa........aaaaaaaa...abbbeebbbbbbbbffffbbaa.................aaaeeaa..aaaaaebbeeebbaaaebeeeebbbbbbbbgggdddga..................aaebbbaabbbbeeebeeebbbeeebbbbbbbbbbbggggggddgga..................abbbbaaabbbeeebeebbbbeeebbbbbbbbbbbggggggggggaa..................aabbeeebbbeebbeebbbbeebggggggbbbbbgggggaggaaa....................abbeebbbbeebbeebbbbeebggggggbbbbbbgggagagaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaa..........................aabbbebbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhaaa..................................abbbbbbggggggggggggbbbbbhhhaa...................................abbbbaaggggggggggggbbbbhhhha....................................abbbbaahhhhaaaaaaaaaabbbbhha....................................accccaahhhha........abbbbhha....................................accccaaiiiia........accccaa.....................................aaaaaaaiiiia........accccaa......................................aaaa.aiiiia........acccccca...........................................aaaa..........aaaaaa........................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa.........................aaa........................abba....abba........................accaa.......................abbaaaaaabdaa.......................accaaa.....................aaeeaaaaaabbaaa.....................acccaa.....................abeeebbeebbeebbbaa..................acccca......................abbeebbeebbbbbbbbaa..................acbbaa....................aabbeebbbbbbbbbbbbaaa.................aabbea....................abbbbbbbbbbbbbffcfbbba.................abbeea........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbhahhaaa..................................abbbbaaggggggggggggbbbbhhhhaa...................................abbbbaahhaaaaaaaaaabbbbhhhha....................................aaabbhhhha........abbbbiihha....................................acccchhhha........abbbbiiiia.....................................aacccciia.........aacccciia......................................aaacciia..........accccaaa.......................................aacciia..........accccaa..........................................aaaa............aaaa..........................',
    ],
  },
  run: {
    ms: 75,
    frames: [
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaa.............................a.......a......................aacca...........................aaa.....aaa.....................aaccaa.........................aaaa....aaaaa....................acccca........................abeebaaaabedbba...................acccca........................abeebbeebbeebbaa..................acccaa.......................abaeebbeebbeebbaaa.................aabbbba.......aaaaaaaaaaaaaaabbbeebbeebbbbffcfba.................abbbbaa..aaaaeeabbbeeabbbeeaabbeebbbbbbbbffffbba.................abeeaaaaaaaaeeabbbeeabbbeeabbbbbbbbbbbbbffffbbaa.................aaaebbbeeebeebbbbeebbbbeebbbbeebbbbbbbbbggdddga..................aabbbbeebbeebbbbeebbbbeebbeeeebbbbbbbgggggddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbgggggggggga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbgggggaggggaa.................abbbbbebbbbbbbbbbbbbbbbbggggggbbbbbggggagaggga...................abbbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggggggaa....................aabbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaaaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbhaaaaaaaa...........................abbbbaaggggggggggggggbbbbhhhha.................................aabbaaa.aaaahgggggaaaaaabbbbhha................................abbbbaa.....ahhhhaaaaa..abbbbaa.................................abbbba......ahhhhaa.....abbbbaa................................aaccaaa.......aahhhha...aaiibbbba..............................accccaa.........ahhhha..aiiiibbbba..............................acccca..........aiiiia..aiiiicccca...............................aaaa...........aaaiiaa..aaaaaaccaa..............................................aaiiiia.....aacccca...............................................aaaa........aaaa......................',
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................eba.....bba.....................aacca..........................abba....abbaa....................aaccaa........................aaeeaaaaaabdaaa...................acccca........................abeebbeebbeebbba..................acccca.......................abaeebbeebbeebbbba.................accbaaa.......aaaaaaaaaaaaaaaabbeebbeebbbbbbbbaa.................aaabbea..aaaaeeebbbeeebbbeeeebbeebbbbbbbbffcfbba.................aabeeeaaeeabeeebbbeeebbbeeebbbbbbbbbbbbbffffbbaa.................aeeeeaaeeabeebbbbeebbbbeebbbbeebbbbbbbbffffgbaa..................aaebbbeebbeebbbbeebbbbeebbbbbbbbbbbbbggggdddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbggggggddgga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbggggggggggaa.................aaabbbebbbbbbbbbbbbbbbbbggggggbbbbbgggggaggaaa...................aabbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggagagaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbhhhaaaaaa............................aabbbbbbggggggggggggbbbbaahhhha................................aaabbaaaabbbggggggggbbbbbbbhhaa.................................abbbba..ahhhhaaaaaaaabbbbhhhha..................................abbbba..ahhhha......abbbbhhhha..................................acccca..ahhhha......abbbbiiiia..................................acccca..ahhhha......abbbbiiiia..................................acccca..ahhhhaa.....abbbbiiiia...................................aaaa....aaiiaaa.....aaccccaa.............................................aiiiia......acccca..............................................aiiiia......acccca...............................................aaaa........aaaa..........................',
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a........................aa............................eba.....bba......................acca..........................abba....abbaa....................aaccaa........................aaeeaaaaaabdaaa...................acccca........................abeebbeebbeebbba..................acccca.......................abaeebbeebbeebbbba.................acccaaa.......aaaaaaaaaaaaaaaabbeebbeebbbbbbbbaa................aaaabbea..aaaaeeebbbeeebbbeeeebbeebbbbbbbbffcfbba................aaabbeeaaeeabeeebbbeeebbbeeebbbbbbbbbbbbbffffbbaa.................abeeeaaeeabeebbbbeebbbbeebbbbeebbbbbbbbffffgbaa..................aaebbbeebbeebbbbeebbbbeebbbbbbbbbbbbbggggdddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbggggggddgga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbggggggggggaa.................aaabbbebbbbbbbbbbbbbbbbbggggggbbbbbgggggaggaaa...................aabbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggagagaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaa.......................abbbbbbbbbbbbbbbbbbbbbbaabhhhaaaaaa.............................abbbbggggggggggggggbbbbaahhhha..................................abbbbbbbbbgggggggbbbbaa.ahhhha..................................abbbbhhhhaaaaaaaabbbba..ahhhha..................................abbbbhhhha......abbbba..ahhhha..................................abbbbhhhha......abbbba..ahhhhaa..................................aacccchha......abbbba...aaiiiia..................................acccchha......abbbba....aiiiia..................................acccciia......acccca....aiiiia...................................aaiiiia......acccca.....aaaa.....................................aiiiia......acccca...............................................aaaa........aaaa..............................',
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................aaa.....aaa.....................aaaaa..........................aaaa....aaaaa....................acccca........................abeebaaaabedbba...................acccca........................abeebbeebbeebbaa..................acccca.......................abaeebbeebbeebbaaa.................aacbbba.......aaaaaaaaaaaaaaabbbeebbeebbbbffcfba.................abbbbaa..aaaaeeabbbeeabbbeeaabbeebbbbbbbbffffbba.................bbbeaaaaaaaaeeabbbeeabbbeeabbbbbbbbbbbbbffffbbaa.................aaaeebbeeebeebbbbeebbbbeebbbbeebbbbbbbbbggdddga..................aaebbbeebbeebbbbeebbbbeebbeeeebbbbbbbgggggddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbgggggggggga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbgggggaggggaa.................abbbbbebbbbbbbbbbbbbbbbbggggggbbbbbggggagaggga...................abbbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggggggaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbhhbbaaaaaaaaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbhhhaaaaaa.............................abbbbggggggggggggbbbbggaahhhhaa..................................aabbbbhhaaaaaaggbbaaaa..aahhhha..................................abbbbaa.aaaaabbbbaa.....ahhhha..................................abbbbaa.....abbbba......ahhhhaa................................aaiibbbba...aaccaaa.......aahhhha..............................aiiiibbbba..accccaa.........ahhhha..............................aiiiicccca..acccca..........aiiiia...............................aaaaaaccaa..aaaa...........aaaiiaa..................................aacccca.................aaiiiia...................................aaaa....................aaaa................',
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaa.............................a.......a......................accca...........................eba.....bba.....................acccaa.........................abba....abbaa....................acccaa........................aaeeaaaaaabdaaa...................accccb........................abeebbeebbeebbba..................acccbb.......................abaeebbeebbeebbbba.................acbbbba.......aaaaaaaaaaaaaaaabbeebbeebbbbbbbbaa.................aaabbea..aaaaeeebbbeeebbbeeeebbeebbbbbbbbffcfbba.................aaeeeeaaeeabeeebbbeeebbbeeebbbbbbbbbbbbbffffbbaa.................aeeeeaaeeabeebbbbeebbbbeebbbbeebbbbbbbbffffgbaa..................aabbbbeebbeebbbbeebbbbeebbbbbbbbbbbbbggggdddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbggggggddgga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbggggggggggaa.................aaabbbebbbbbbbbbbbbbbbbbggggggbbbbbgggggaggaaa...................aabbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggagagaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaa.......................abbbbbbbbbbbbbbbbbbbbbbaabhhhaaaaaa.............................abbbbggggggggggggggbbbbaahhhha..................................abbbbbbbbbgggggggbbbbaa.ahhhha..................................abbbbhhhhaaaaaaaabbbba..ahhhha..................................abbbbhhhha......abbbba..ahhhha..................................abbbbiiiia......acccca..ahhhha..................................abbbbiiiia......acccca..ahhhha..................................abbbbiiiia......acccca..ahhhhaa..................................aaccccaa........aaaa....aaiiaaa..................................acccca..................aiiiia..................................acccca..................aiiiia...................................aaaa....................aaaa....................',
      '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................a..............................................................aaaa............................a.......a......................acccca..........................eba.....bba.....................acccca.........................abba....abbaa....................acccca........................aaeeaaaaaabdaaa...................aacccb........................abeebbeebbeebbba..................aacbbb.......................abaeebbeebbeebbbba..................abbbba.......aaaaaaaaaaaaaaaabbeebbeebbbbbbbbaa.................aaabeee..aaaaeeebbbeeebbbeeeebbeebbbbbbbbffcfbba.................aaeeeeaaeeabeeebbbeeebbbeeebbbbbbbbbbbbbffffbbaa.................aeebbaaeeabeebbbbeebbbbeebbbbeebbbbbbbbffffgbaa..................aabbbbeebbeebbbbeebbbbeebbbbbbbbbbbbbggggdddgga..................abbbbeebbeebbbbeebbbbeebbbbbbbbbbbbggggggddgga..................abbbbeebbbebbbbbebbbbbebgggggbbbbbbggggggggggaa.................aaabbbebbbbbbbbbbbbbbbbbggggggbbbbbgggggaggaaa...................aabbbbbbbbbbbbbbbbbbbbbggggggbbbbbbbggagagaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbhhhaaaaaa............................aabbbbbbggggggggggggbbbbaahhhha................................aaabbaaaabbbggggggggbbbbbbbhhaa.................................abbbba..ahhhhaaaaaaaabbbbhhhha..................................abbbba..ahhhha......abbbbhhhha..................................abbbba..ahhhhaa.....abbbbhhhha..................................abbbba...aaiiiia.....aacccchha..................................abbbba....aiiiia......acccchha..................................acccca....aiiiia......acccciia..................................acccca.....aaaa........aaiiiia..................................acccca..................aiiiia...................................aaaa....................aaaa........................',
    ],
  },
  turn: {
    ms: 100,
    frames: [
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa..........................aaa.......................abba....abba.........................aacca......................abbaaaaaabdaa........................aaccaa....................aaeeaaaaaabbaaa......................acccca....................abeeebbeebbeebbbaa...................aaccca.....................abbeebbeebbbbbbbbaa...................acbaa....................aabbeebbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbgahhhha..................................abbbbaaggggggggggggbbbbaahhhha..................................abbbbaahhhhaaaaaaaabbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
      '....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa............................aaa..................abba.....aa.abba..........................accaa.................abbaaaaaaeeaabba.........................aaccaa................aaddaaaaaaeeaabdaa........................acccaa...............abdbbbbbeebeebeebdba......................acccca................abbbbbbbeebbbbeebbba......................acabba...............aabbbbbbbbbbbbbbbbbbaa.....................abbbba..............abbbbbbffcfbbbbbbffcfbba....................abbbba.......aaaaaaaabbbbbbffffbbbbbbffffbba....................aeeeeaa..aaaaaaaaaaaaeeebbbffffbbbbbbffffbba.....................aaeeebaabbbbeeebeeebbbbbbbbbbbgggddddgbbaaa......................aebbbeeebbbeebbeebbbbbbbbbbggggggddgggbaa........................ebbbeeebbbeebbeebbbbbbbbbbgggggggggggba..........................abbeebbbbeebbeebbbbebbbbbbbggggaaaaaa..........................aabbeebbbbbebbbebbbbeebbbbbbbbggggaaa...........................aabbeebbbbbbbbbbbbbbbebbbbbabbaaaaa.............................aabbbebbbbbbbbbbbbbbbbbbbbaaaa...................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbha......................................abbbbggggggggggggbbbbghhha......................................abbbbhhggggggggggbbbbhhhha......................................abbbbhhhhaaaaaaaabbbbhhhha......................................abbbbhhhha......abbbbhhhha......................................abbbbhhhha......abbbbhhhha......................................acccciiiia......acccciiiia......................................acccciiiia......acccciiiia......................................acccciiiia......acccciiiia.......................................aaaaaaaa........aaaaaaaa........................',
      '................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa....................................aaa..........abba.....aa.abba..................................accaa.........abbaaaaaaeeaabba.................................aaccaa........aaddaaaaaaeeaabdaa................................acccaa.......abdbbbbbeebeebeebdba..............................acccca........abbbbbbbeebbbbeebbba..............................acabba.......aabbbbbbbbbbbbbbbbbbaa.............................abbbba......abbbbbbffcfbbbbbbffcfbba............................abbbba......abbbbbbffffbbbbbbffffbba............................aeeeeaa.aaaaaeeebbbffffbbbbbbffffbba.............................aaeeebaebbbbbbbbbbbbbbgggddddgbbaaa..............................aebbbeeebbbebbbbbbbggggggddgggbaa................................ebbbeeebbbeebbbbbbgggggggggggba.................................abbbeebbbbeebbbbbbbgggggaaaaaa..................................abbbeebbbbbebbbbbbbbbbggggaaa...................................abbbeebbbbbbbbbbbbbbbbgaaaa.....................................aabbbebbbbbbbbbbbbbbbbaa.........................................abbbbbbbbbbbbbbbbbbbba..........................................abbbbbbbbbbbbbbbbbbba...........................................abbbbggggggbbbbgggga............................................abbbbhgggggbbbbghhha............................................abbbbhhhhaabbbbhhhha............................................abbbbhhhhaabbbbhhhha............................................abbbbhhhhaabbbbhhhha............................................acccciiiiaacccciiiia............................................acccciiiiaacccciiiia............................................acccciiiiaacccciiiia.............................................aaaaaaaa..aaaaaaaa..........................',
      '............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa...........................................aaa...abba.....aa.abba.........................................aacca..abbaaaaaaeeaabba........................................aaacca.aaddaaaaaaeeaabdaa.......................................accccaabdbbbbbeebeebeebdba.....................................aaccca.abbbbbbbeebbbbeebbba.....................................aabbaaaabbbbbbbbbbbbbbbbbbaa....................................abbbbabbbbbbffcfbbbbbbffcfbba...................................abbbbabbbbbbffffbbbbbbffffbba...................................aaeeaaeeebbbffffbbbbbbffffbba....................................aaaeebbbbbbbbbbgggddddgbbaaa.....................................aabbbbbbbbbbggggggddgggbaa.......................................abbbbbbbbbbgggggggggggba........................................abbbbebbbbbbgggggaaaaaa.........................................abbbbeebbbbbbbbggbbaaa..........................................abbbbbebbbbbbbbbbbba............................................abbbbbbbbbbbbbbbbbba...........................................aaabbbbbbbbbbbbbbbba...........................................aaabbbbbbbbbbbbbbbbbba..........................................ahhhhbbbbggggbbbbghhha..........................................ahhhhbbbbggggbbbbhhhha..........................................ahhhhbbbbaaaabbbbhhhha..........................................ahhhhbbbba..abbbbhhhha..........................................ahhhhbbbba..abbbbhhhha..........................................aiiiicccca..acccciiiia..........................................aiiiicccca..acccciiiia..........................................aiiiicccca..acccciiiia...........................................aaaaaaaa....aaaaaaaa........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba........................................a.abdaaaaaaaaaaaaaaaadba.......................................acbbddbbeebbebbebbeebbddba.....................................acccbbbbbeebbebbebbeebbbbba....................................aaccbbbbbbeebbbbbbbbeebbbbbba...................................acccbbbbffcfbbbbbbbbffcfbbbba...................................acccbbbbffffbbbbbbbbffffbbbba...................................acbbeeebffffbbbbbbbbffffbeeea...................................aabbbbbbbbbbbgddddgbbbbbbbbba...................................aabbbbggbbbggggddggggbbbggbba....................................aeegggggbggggggggggggbggggga....................................aaagggggbbgggbaabgggbbgbbaaa.....................................aabbbbbbbbbgabbagbbbbbbaaa.......................................abbbbbbbbgbbbbbbgbbbbba..........................................aaabbbbbggggggbbbbbbba............................................abbbbbggggggbbbbbbba........................................aaaaabbbbbggggggbbbbbbbaaa.....................................ahhhhaabbbbbbggggbbbbbbhhhha....................................ahhhhaabbbbbbbbbbbbbbbahhhha....................................ahhhhaabbbbbbbbbbbbbbaahhhha....................................ahhhhaabbbbaaaaaabbbbaahhhha....................................ahhhhaabbbbaaaaaabbbbaahhhha....................................aiiiiaacccca....accccaaiiiia....................................aiiiiaacccca....accccaaiiiia....................................aiiiiaacccca....accccaaiiiia.....................................aaaa..aaaa......aaaa..aaaa....................',
    ],
  },
  sit: {
    ms: 180,
    frames: [
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbffcfbbbbbbbbffcfbbbba......................................abbbbffffbbbbbbbbffffbbbba......................................aeeebffffbbbbbbbbffffbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga.......................................aabbbbbbbgabbagbbbbbbbaa......aaa...............................aabbbbbbgbbbbbbgbbbbbbaa.....aaaaa.............................aeebbbbbggggggggggbbbbbeea....aaacca............................aeebbbbbggggggggggbbbbbeea.....aaccaa............................aebbbbbbggggggbbbbbbbbea.......accaa...........................aeebbbbbbggggggbbbbbbbbeea......abbba..........................aaeebbbbbbggggggbbbbbbbbeeaa....aabbba.........................aaabbbbbbbbbgggggbbbbbbbbbbaaa..aaaebba.........................abbbbbbbbbbbbggggbbbbbbbbbbbbaaabeeeeaa.........................abbbbbbbbbbbbbbbbbbbbbbbbbbbbeebbbeeea..........................abbbbbbccccbbbbbbccccbbbbbbbbeebbbbaa............................aaaaaaccccaaaaaaacccaaaaaaaaaaaaaa...............................aaaaaccccaaaaaaacccaaaaaaaaaaaa......................................aaaa.a....aaaa..........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbffcfbbbbbbbbffcfbbbba......................................abbbbffffbbbbbbbbffffbbbba......................................aeeebffffbbbbbbbbffffbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga.......................................aabbbbbbbgabbagbbbbbbbaa........................................aabbbbbbgbbbbbbgbbbbbbaa.......................................aeebbbbbggggggggggbbbbbeea......................................aeebbbbbggggggggggbbbbbeea.......................................aebbbbbbggggggbbbbbbbbea...........aa..........................aeebbbbbbggggggbbbbbbbbeea.........acca........................aaeebbbbbbggggggbbbbbbbbeeaa.......acccca......................aaabbbbbbbbbgggggbbbbbbbbbbaaa....aaaccca.......................abbbbbbbbbbbbggggbbbbbbbbbbbbaaaaabbccca........................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbaeebbbccca........................abbbbbbccccbbbbbbccccbbbbbbbbbaeebbbbaa..........................aaaaaaccccaaaaaaacccaaaaaaaaaaaaaaaa.............................aaaaaccccaaaaaaacccaaaaaaaaaaaaa.....................................aaaa.a....aaaa..........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbffcfbbbbbbbbffcfbbbba......................................abbbbffffbbbbbbbbffffbbbba......................................aeeebffffbbbbbbbbffffbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga.......................................aabbbbbbbgabbagbbbbbbbaa........................................aabbbbbbgbbbbbbgbbbbbbaa.......................................aeebbbbbggggggggggbbbbbeea......................................aeebbbbbggggggggggbbbbbeea.......................................aebbbbbbggggggbbbbbbbbea.......................................aeebbbbbbggggggbbbbbbbbeea.....................................aaeebbbbbbggggggbbbbbbbbeeaa...................................aaabbbbbbbbbgggggbbbbbbbbbbaaa..................................abbbbbbbbbbbbggggbbbbbbbbbbbbaaa................................abbbbbbbbbbbbbbbbbbbbbbbbbbbbeeaaaaaaaaa........................abbbbbbccccbbbbbbccccbbbbbbbbeeaaaaaaaaaa........................aaaaaaccccaaaaaaacccaaaaaaaaaaaaaaaaaaaa.........................aaaaaccccaaaaaaacccaaaaaaaaaaaaaaaaaaa...............................aaaa.a....aaaa..........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbabbabbbbbbbbabbabbbba......................................aeeebbaabbbbbbbbbbaabbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga.......................................aabbbbbbbgabbagbbbbbbbaa........................................aabbbbbbgbbbbbbgbbbbbbaa.......................................aeebbbbbggggggggggbbbbbeea......................................aeebbbbbggggggggggbbbbbeea.......................................aebbbbbbggggggbbbbbbbbea...........aa..........................aeebbbbbbggggggbbbbbbbbeea.........acca........................aaeebbbbbbggggggbbbbbbbbeeaa.......acccca......................aaabbbbbbbbbgggggbbbbbbbbbbaaa....aaaccca.......................abbbbbbbbbbbbggggbbbbbbbbbbbbaaaaabbccca........................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbaeebbbccca........................abbbbbbccccbbbbbbccccbbbbbbbbbaeebbbbaa..........................aaaaaaccccaaaaaaacccaaaaaaaaaaaaaaaa.............................aaaaaccccaaaaaaacccaaaaaaaaaaaaa.....................................aaaa.a....aaaa..........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbffcfbbbbbbbbffcfbbbba......................................abbbbffffbbbbbbbbffffbbbba......................................aeeebffffbbbbbbbbffffbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga.......................................aabbbbbbbgabbagbbbbbbbaa......aaa...............................aabbbbbbgbbbbbbgbbbbbbaa.....aaaaa.............................aeebbbbbggggggggggbbbbbeea....aaacca............................aeebbbbbggggggggggbbbbbeea.....aaccaa............................aebbbbbbggggggbbbbbbbbea.......accaa...........................aeebbbbbbggggggbbbbbbbbeea......abbba..........................aaeebbbbbbggggggbbbbbbbbeeaa....aabbba.........................aaabbbbbbbbbgggggbbbbbbbbbbaaa..aaaebba.........................abbbbbbbbbbbbggggbbbbbbbbbbbbaaabeeeeaa.........................abbbbbbbbbbbbbbbbbbbbbbbbbbbbeebbbeeea..........................abbbbbbccccbbbbbbccccbbbbbbbbeebbbbaa............................aaaaaaccccaaaaaaacccaaaaaaaaaaaaaa...............................aaaaaccccaaaaaaacccaaaaaaaaaaaa......................................aaaa.a....aaaa..........................',
      '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abdaa.aaaaaaaaaa.aadba..........................................abdaaaaaaaaaaaaaaaadba.........................................abddbbeebbebbebbeebbddba........................................abbbbbeebbebbebbeebbbbba.......................................abbbbbbeebbbbbbbbeebbbbbba......................................abbbbffcfbbbbbbbbffcfbbbba......................................abbbbffffbbbbbbbbffffbbbba......................................aeeebffffbbbbbbbbffffbeeea......................................abbbbbbbbbgddddgbbbbbbbbba......................................abbggbbbggggddggggbbbggbba......................................agggggbggggggggggggbggggga......................................agggggbbgggbaabgggbbggggga....a..................................aabbbbbbbgabbagbbbbbbbaa....aaaaa...............................aabbbbbbgbbbbbbgbbbbbbaa...aaaaaaa.............................aeebbbbbggggggggggbbbbbeea..aaacccca............................aeebbbbbggggggggggbbbbbeea...aacccca.............................aebbbbbbggggggbbbbbbbbea......aabbaa...........................aeebbbbbbggggggbbbbbbbbeea.....aebbea..........................aaeebbbbbbggggggbbbbbbbbeeaa....aebeea.........................aaabbbbbbbbbgggggbbbbbbbbbbaaa.aaeeeeea.........................abbbbbbbbbbbbggggbbbbbbbbbbbbaabbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbbbbeeebbbaa...........................abbbbbbccccbbbbbbccccbbbbbbbbeeeebaa.............................aaaaaaccccaaaaaaacccaaaaaaaaaaaaa................................aaaaaccccaaaaaaacccaaaaaaaaaaaa......................................aaaa.a....aaaa..........................',
    ],
  },
  sleep: {
    ms: 500,
    frames: [
      '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaaaaa..........................................aaaaebbbbeeebeeebbbbbaaa.......bb.............................aaabbeeebbbeebbeebbbbbbbbaaaaaa.abba..........................aaaaaabeebbbbeebbeebbbbbdbbaaaaaaaadba.........................abbbeebbeebbbbeebbeebbbbdbbbebbebbbbbdba.......................abbbbeebbeebbbbbbbbbbbbbbbbbbebbebbbbbbba......................aabbbbeebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abeebbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aaeeebbbbbbbbbbbbbbbbbbbbbbaabbbggbaabbbbba.....................aaeeeebbbbbbbbbbbbbbbbbbbbbbbgddddgggbbbbba......................aeeebbbbbggggggggggbbbbbbbbbggddggggbcccca.......................aebbbeeebbbbbbbbbbcccccccbbggggggggbcccca........................aaaaaeeabbbeeabbbccaaaaaaaaaaaaaaaacccca..........................aaaeeabbbeeabbbccaaaaaa.aaaaaaaaacccca............................aaaaaaaaaaaaaaa................aaaa............',
      '.........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaa..................................................aaaaaaaeeabeeaaaaaaa.........................................aaaaaaaaaaeebbeeaaaaaaaaaa....................................aaeeebeebbbbeebbeebbbbbbbbbbaa....bb..........................aabbeebbeebbbbeebbeebbbbbbbbbbbbaa.abba........................aaabbeebbeebbbbbbbbbbbbbbbdbbebbaaaaadba.......................abbbbbeebbbbbbbbbbbbbbbbbbdbbbebbebbbbbdba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbebbebbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abeebbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aaeeebbbbbbbbbbbbbbbbbbbbbbaabbbggbaabbbbba.....................aaeeeebbbbbbbbbbbbbbbbbbbbbbbgddddgggbbbbba......................aeeebbbbbggggggggggbbbbbbbbbggddggggbcccca.......................aebbbeeebbbbbbbbbbcccccccbbggggggggbcccca........................aaaaaeeabbbeeabbbccaaaaaaaaaaaaaaaacccca..........................aaaeeabbbeeabbbccaaaaaa.aaaaaaaaacccca............................aaaaaaaaaaaaaaa................aaaa............',
      '.........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaa..................................................aaaaaaaeeabeeaaaaaaa.........................................aaaaaaaaaaeebbeeaaaaaaaaaa....................................aaeeebeebbbbeebbeebbbbbbbbbbaa....bb..........................aabbeebbeebbbbeebbeebbbbbbbbbbbbaa.abba........................aaabbeebbeebbbbbbbbbbbbbbbdbbebbaaaaadba.......................abbbbbeebbbbbbbbbbbbbbbbbbdbbbebbebbbbbdba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbebbebbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abeebbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aaeeebbbbbbbbbbbbbbbbbbbbbbaabbbggbaabbbbba.....................aaeeeebbbbbbbbbbbbbbbbbbbbbbbgddddgggbbbbba......................aeeebbbbbggggggggggbbbbbbbbbggddggggbcccca.......................aebbbeeebbbbbbbbbbcccccccbbggggggggbcccca........................aaaaaeeabbbeeabbbccaaaaaaaaaaaaaaaacccca..........................aaaeeabbbeeabbbccaaaaaa.aaaaaaaaacccca............................aaaaaaaaaaaaaaa................aaaa............',
      '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaaaaa..........................................aaaaebbbbeeebeeebbbbbaaa.......bb.............................aaabbeeebbbeebbeebbbbbbbbaaaaaa.abba..........................aaaaaabeebbbbeebbeebbbbbdbbaaaaaaaadba.........................abbbeebbeebbbbeebbeebbbbdbbbebbebbbbbdba.......................abbbbeebbeebbbbbbbbbbbbbbbbbbebbebbbbbbba......................aabbbbeebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abeebbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aaeeebbbbbbbbbbbbbbbbbbbbbbaabbbggbaabbbbba.....................aaeeeebbbbbbbbbbbbbbbbbbbbbbbgddddgggbbbbba......................aeeebbbbbggggggggggbbbbbbbbbggddggggbcccca.......................aebbbeeebbbbbbbbbbcccccccbbggggggggbcccca........................aaaaaeeabbbeeabbbccaaaaaaaaaaaaaaaacccca..........................aaaeeabbbeeabbbccaaaaaa.aaaaaaaaacccca............................aaaaaaaaaaaaaaa................aaaa............',
    ],
  },
  happy: {
    ms: 120,
    frames: [
      '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a............................aaa.......................aaa.....aaa..........................aaaaa.....................aaaa....aaaaa........................acccaa....................abeebaaaabedbba.......................acccaa....................abeebbeebbeebbaa.....................acccca....................abaeebbeebbeebbaaa....................abbbba...................aabbeebbeebbbbbbbbba...................abbbba....................abbeebbbbbbbbbaabbba..................abbbba...................aabbbbbbbbbbbbabbabbaa.................aeeeea.....aaaaaaaaaaaaaaebbbeebbbbbbbbbggdddga.................aeeebaaaaaabbeeabeeabbbeeebeeeebbbbbbbgggggddgga.................aebbaaaaaabbeeabeeabbbeeebbbbbbbbbbbgggggggggga..................abbbbeeebbbeebbeebbbbeebgggggbbbbbbgggggaggggaa..................abbbeebbbbeebbeebbbbeebggggggbbbbbggggagaggga...................abbbeebbbbeebbeebbbbeebggggggbbbbbbbggggggaa....................aabbeebbbbbebbbebbbbbebbbbbbbaaaaaaaaaaaaa......................aabbbebbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha.................................aabbbbbbbbbbbbbbbbbbbbbbbbhhhha................................aaabbaaggggggggggggggbbbbaahhhha................................abbbbaahhhhaaaaaaaaaabbbbaahhhha................................abbbbaahhhhaaaaaaaaaabbbbaahhhha................................accccaaiiiia........accccaaiiiiaa...............................accccaaiiiia.........aaccccaaiiiia..............................accccaaiiiia..........accccaaiiiia...............................aaaa..aaaa............aaaa..aaaa....................',
      '.......................................................................................................................................................................................................................................a.......a......................................................aaa.....aaa.........................aa.........................aaaa....aaaaa.......................acca.......................abeebaaaabedbba.....................aaccaa......................abeebbeebbeebbaa....................aacca......................abaeebbeebbeebbaaa..................acccca.....................aabbeebbeebbbbbbbbba.................acccca......................abbeebbbbbbbbbaabbba.................aabbaa....................aabbbbbbbbbbbbabbabbaa................aabbea......aaaaaaaaaaaaaaebbbeebbbbbbbbbggdddga.................abeeea..aaabbeeabeeabbbeeebeeeebbbbbbbgggggddgga................aeeeeaaaaaabbeeabeeabbbeeebbbbbbbbbbbgggggggggga.................aaabbbeeebbbeebbeebbbbeebgggggbbbbbbggggdaggggaa.................abbbbeeebbbeebbeebbbbeebggggggbbbbbgggaadaggga...................abbbeebbbbeebbeebbbbeebggggggbbbbbbbggddggaa....................aabbeebbbbbebbbebbbbbebbbbbbbaaaaaaaaaaaaa......................aabbeebbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbebbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha.................................aabbbbbbbbbbbbbbbbbbbbbbbbhhhha................................aaabbaaggggggggggggggbbbbaahhhhaa...............................abbbbaahhhhaaaaaaaaaaaabbbbaahhhha..............................abbbbaahhhhaaaaaaaaa..abbbbaahhhha.............................aabbbbaahhhha..........accccaaiiiia............................accccaaiiiiaa...........aaaccaaaaiiaa...........................accccaaiiiia.............aaccccaaiiiia..........................accccaaiiiia...............aaaa..aaaa............................aaaa..aaaa............................................................................................................................................................................................................................................................................................................................................................................',
      '...............................................................................................................a......................................................aa......aaa...............................aaa..................abba....abba.............................aaccaa.................abbaaaaaabdaa..........................aaaaccaa................aaeeaaaaaabbaaa........................accccaaa................abeeebbeebbeebbbaa.....................aabcccaa.................abbeebbeebbbbbbbbaa....................aabbaa..................aabbeebbbbbbbbbbbbaaa...................aebbaa..................abbbbbbbbbbbbbbbbbbbba.................aeeeea........aaaaaaaa...abbbeebbbbbbbbbaabbbba.................aeeeea...aaaaaaaaaaaaaaaaabeeeebbbbbbbbabbaggba.................aaabbbeaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga.................aabbbeeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa.................abeebeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga...................aabbeebbbbeebbeebbbbeebgggggbbbbbbbbggdaaaaa....................abbbeebbbbeebbbebbbbeebbggggbbbbbbbbgaaaaaa.....................abbbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaadda.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha........aa.........................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbbbggggggggggggbbbbbbaaiiaa.................................abbbbaaggggggggggggbbbbbbaaiiiiaa................................aabbbbaahhhhaaaaaaaacccca.aaiiaaa................................accccaaiiiia......aaaccaa..aaaa.................................accccaaiiiiaa......aacccca.......................................aaccccaaiiaaa.......aaaa..........................................aaaa..aaaa....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa..............................aaaa..................abba....abba............................aaaccaa.................abbaaaaaabdaa.........................aaaaaccaa................aaeeaaaaaabbaaa.......................acccccaaa................abeeebbeebbeebbbaa.....................aabbcaaa.................abbeebbeebbbbbbbbaa....................aabbaa..................aabbeebbbbbbbbbbbbaaa..................aeeeba...................abbbbbbbbbbbbbbbbbbbba.................aeeeea........aaaaaaaa...abbbeebbbbbbbbbaabbbba.................aeeebaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbabbaggba..................aabbbbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbeeeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................aaebeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbgahhhha.................................aabbbbaaggggggggggggbbbbaahhhha................................aaabbaaaahhaaaaaaaaaabbbbaahhhha................................abbbbaahhhha........abbbbaahhhha................................abbbbaahhhha........abbbbaahhhhaa...............................accccaaiiiia.........aaccccaaiiaaa..............................accccaaiiiia..........accccaaiiiia..............................accccaaiiiia..........accccaaiiiia...............................aaaa..aaaa............aaaa..aaaa....................',
    ],
  },
  alert: {
    ms: 130,
    frames: [
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa..........................aaa.......................abba....abba.........................aacca......................abbaaaaaabdaa........................aaccaa....................aaeeaaaaaabbaaa......................acccca....................abeeebbeebbeebbbfa...................aaccca.....................abbeebbeebbbbbbbbaa...................acbaa....................aabbeebbbbbbbbffbfaaa..................abbbba...................abbbbbbbbbbbbbffcfbbba.................abbbba........aaaaaaaa...abbbeebbbbbbbbffffbbba.................aeeeeaa..aaaaaaaaaaaaaaaaabeeeebbbbbbbbffffggba..................aaeebbaabbbbeeebeeebbbeeebbbbbbbbbbbgggggdddgga..................abbbbeeebbbeeebeebbbbeeebbggbbbbbbbggggggddggaa..................ebbbeeebbbeebbeebbbbeebbgggggbbbbbgggggggggga....................abbeebbbbeebbeebbbbeebgggggbbbbbbbbbbaaaaaa....................aabbeebbbbeebbbebbbbeebbggggbbbbbbbbbbaaaaa.....................aabbeebbbbbebbbbbbbbbebbbbbbbaaaaaaaaaa.a.......................aabbbebbbbbbbbbbbbbbbbbbbbbbha...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbhhha..................................abbbbggggggggggggggbbbbgahhhha..................................abbbbaaggggggggggggbbbbaahhhha..................................abbbbaahhhhaaaaaaaabbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
      '...............................................................................................................................................................................................................................................................................................................a................................a.....................aa......aaa............................aaabb...................abba....abba...........................aaccbba..................abbaaaaaabdaa.........................aaacccb.....a..a..a......aaeeaaaaaabbaaa.......................acccccca...aabaabeabaa..aabeeebbeebbeebbbfa.....................accccccaa.aaabbabbabbbaababbeebbeebbbbbbbbaa....................accccccaaaaabbbbeeabbbaabbbbeebbbbbbbbffbfaaa...................aacccccebbbbeeebeeebbbeeebbbbbbbbbbbbbffcfbbba..................aabbbbeeebbbeeebeebbbbeeebbbeebbbbbbbbffffbbba...................abbbbeeebbbeebbeebbbbeebbeeeebbbbbbbbffffggba...................abbbbeebbbbeebbeebbbbeebbbbbbbbbbbbgggggdddgga..................aeebbeebbbbeebbbebbbbeebbbggbbbbbbbggggggddggaa..................ebbbeebbbbbebbbbbbbbbebggggggbbbbbgggggggggga...................abbbbebbbbbbbbbbbbbbbbbgggggbbbbbbbbggdaaaaa....................abbbbbbbbbbbbbbbbbbbbbbbggggbbbbbbbbgaaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaadda........................abbbbbbbbbbbbbbbbbbbbbbbbbba.........aa..........................abbbbbbbbbbbbbbbbbbbbbbbbhaa...................................abbbbbbbbbbbbbbbbbbbbbbbbhhaaa..................................abbbbggggggggggggggbbbbaahhhha..................................abbbbaahgggggggggggbbbbaahhhha..................................abbbbaahhhhaaaaaaaabbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................................................................................................................................................................................................................',
      '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a................................a.....................aa......aaa............................aaabb...................abba....abba...........................aaccbba..................abbaaaaaabdaa.........................aaacccb.....a..a..a......aaeeaaaaaabbaaa.......................acccccca...aabaabeabaa..aabeeebbeebbeebbbfa.....................accccccaa.aaabbabbabbbaababbeebbeebbbbbbbbaa....................accccccaaaaabbbbeeabbbaabbbbeebbbbbbbbffbfaaa...................aacccccebbbbeeebeeebbbeeebbbbbbbbbbbbbffcfbbba..................aabbbbeeebbbeeebeebbbbeeebbbeebbbbbbbbffffbbba...................abbbbeeebbbeebbeebbbbeebbeeeebbbbbbbbffffggba...................abbbbeebbbbeebbeebbbbeebbbbbbbbbbbbgggggdddgga..................aeebbeebbbbeebbbebbbbeebbbggbbbbbbbggggggddggaa..................ebbbeebbbbbebbbbbbbbbebggggggbbbbbgggggggggga...................abbbbebbbbbbbbbbbbbbbbbgggggbbbbbbbbggdaaaaa....................abbbbbbbbbbbbbbbbbbbbbbbggggbbbbbbbbgaaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaadda........................abbbbbbbbbbbbbbbbbbbbbbbbbba.........aa..........................abbbbbbbbbbbbbbbbbbbbbbbbhaa...................................abbbbbbbbbbbbbbbbbbbbbbbbhhaaa..................................abbbbggggggggggggggbbbbaahhhha..................................abbbbaahgggggggggggbbbbaahhhha..................................abbbbaahhhhaaaaaaaabbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................abbbbaahhhha......abbbbaahhhha..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia..................................accccaaiiiia......accccaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
    ],
  },
} as const
// </sprites>

type ClipName = keyof typeof CLIPS

/** One stretch of the cat's life: frames of a clip, in order, maybe mirrored. */
type Beat = {
  clip: ClipName
  frames: readonly number[]
  /** Drawn mirrored: the sheet faces right. */
  isFlipped: boolean
  /** Columns it moves each frame, signed. */
  stride: number
}

/** The sprite cat, between two frames: what it plays, where, what comes next. */
const actor = {
  beat: { clip: 'sit', frames: [0, 1, 2, 3, 4, 5], isFlipped: false, stride: 0 } as Beat,
  at: 0,
  clock: 0,
  x: 8,
  heading: 1 as 1 | -1,
  /** Lying at rest, seated when you type or between two walks, standing to walk. */
  posture: 'lying' as 'standing' | 'seated' | 'lying',
  rested: 0,
  restFor: 1200,
  goal: 8,
  react: '' as '' | 'happy' | 'alert',
  /** Milliseconds left of "the person is typing": it sits up and watches. */
  typing: 0,
  /** True while the session waits on the person: a question asked, a permission pending. */
  isAwaited: false,
  /** Set when what it should do changed: the beat in hand ends at its next frame. */
  isCalled: false,
  queue: [] as Beat[],
}

/** How long after a keystroke it still counts the person as typing. */
const TYPING_MS = 4000

/** The odds that a walk cycle is a hop instead. */
const HOP_ODDS = 0.22

/** The tools that are the agent asking the person something. */
const ASKING: readonly string[] = ['AskUserQuestion', 'ExitPlanMode']

/** Puts the cat on guard, or stands it down, the moment the wait starts or ends. */
const await_ = (isAwaited: boolean) => {
  if (actor.isAwaited !== isAwaited) actor.isCalled = true
  if (isAwaited && !actor.isAwaited) say('Hé. On attend ta réponse.', 9000)
  actor.isAwaited = isAwaited
}

const SPRITE_TICK_MS = 60

/**
 * The cat's box in cells, by the sheet that draws it: both go two pixels a
 * cell in half blocks, the 32 by 24 sheet over 32 columns by 12 rows, the big
 * 64 by 36 one over 64 by 18. (Finer glyphs do not help: a Raster cell takes
 * none beyond the Basic Multilingual Plane, which rules sextants out, and a
 * quadrant's pixel is twice as tall as wide, which squeezes a square sheet.)
 */
const isBig = () => stage.style === 'big'
const catColumns = () => (isBig() ? BIG_W : SPRITE_W)
const catRows = () => (isBig() ? BIG_H : SPRITE_H) / 2
const stripRows = () => catRows() + 1
/** What the big cat is to the small one, for the distances drawn in cells. */
const catScale = () => (isBig() ? 2 : 1)

const count = (length: number) => Array.from({ length }, (_unused, at) => at)
const TURN_IN = count(CLIPS.turn.frames.length)
const TURN_OUT = [...TURN_IN].reverse()

/**
 * What it does next, once the beat in hand is played out. While the agent
 * works it walks about and sits between two walks; at rest it lies down; and
 * whenever the person types, it sits up and watches.
 */
const direct = (isWorking: boolean, span: number): Beat => {
  const queued = actor.queue.shift()
  if (queued !== undefined) return queued
  const isFlipped = actor.heading < 0
  const isWatching = actor.typing > 0
  const sit: Beat = { clip: 'sit', frames: count(CLIPS.sit.frames.length), isFlipped: false, stride: 0 }
  const lie: Beat = { clip: 'sleep', frames: count(CLIPS.sleep.frames.length), isFlipped, stride: 0 }

  // The session waits on the person: on its feet, back arched, until they answer.
  // Typing wins over it: they are answering, and it sits to watch.
  const isOnGuard = actor.isAwaited && !isWatching
  if (isOnGuard && actor.posture === 'standing') {
    actor.react = ''

    return { clip: 'alert', frames: [0, 1, 2, 2, 2, 2, 1, 2, 2, 2], isFlipped, stride: 0 }
  }

  if (actor.posture === 'lying') {
    if (!isWatching && !isWorking && !isOnGuard) return lie
    // Up on its haunches first; from there it watches, or sets off.
    actor.posture = 'seated'
    actor.rested = 0
    actor.restFor = 0

    return sit
  }

  if (actor.posture === 'seated') {
    if (isWatching) return sit
    if (isOnGuard) {
      actor.posture = 'standing'

      return { clip: 'turn', frames: TURN_OUT, isFlipped, stride: 0 }
    }
    if (!isWorking) {
      actor.posture = 'lying'

      return lie
    }
    if (actor.rested < actor.restFor) {
      actor.rested += CLIPS.sit.frames.length * CLIPS.sit.ms

      return sit
    }
    // Up again: somewhere to go, and the half turn from facing you to facing there.
    actor.goal = Math.round(Math.random() * span)
    if (Math.abs(actor.goal - actor.x) < 12) actor.goal = actor.x < span / 2 ? span : 0
    actor.heading = actor.goal >= actor.x ? 1 : -1
    actor.posture = 'standing'
    actor.react = ''

    return { clip: 'turn', frames: TURN_OUT, isFlipped: actor.heading < 0, stride: 0 }
  }

  if (actor.react !== '' && !isWatching) {
    const clip = actor.react
    actor.react = ''

    return clip === 'happy'
      ? { clip, frames: [0, 1, 2, 3, 0, 1, 2, 3], isFlipped, stride: 0 }
      : { clip, frames: [0, 1, 2, 2, 2, 1, 0], isFlipped, stride: 0 }
  }

  const isThere =
    actor.heading > 0 ? actor.x >= Math.min(span, actor.goal) : actor.x <= Math.max(0, actor.goal)
  if (isWatching || !isWorking || isThere) {
    actor.posture = 'seated'
    actor.rested = 0
    actor.restFor = 3000 + Math.random() * 5000

    return { clip: 'turn', frames: TURN_IN, isFlipped, stride: 0 }
  }

  // Now and then a hop on the way, for the joy of it.
  if (Math.random() < HOP_ODDS) {
    return { clip: 'happy', frames: count(CLIPS.happy.frames.length), isFlipped, stride: actor.heading }
  }

  return { clip: 'walk', frames: count(CLIPS.walk.frames.length), isFlipped, stride: actor.heading }
}

/** The clips that loop, and so may be cut short when it is called to something else. */
const LOOPS: readonly ClipName[] = ['walk', 'run', 'sit', 'sleep', 'alert']

/** Moves the sprite cat on by `ms`; true when what is drawn changed. */
const stepSprite = (ms: number, isWorking: boolean, columns: number) => {
  const span = Math.max(1, columns - catColumns())
  let hasMoved = false
  actor.clock += ms
  if (actor.typing > 0) {
    actor.typing -= ms
    // The typing stopped: it goes back to what the agent's state asks of it.
    if (actor.typing <= 0) actor.isCalled = true
  }
  // Called while it lies still on a slow frame: no waiting that frame out.
  if (actor.isCalled && LOOPS.includes(actor.beat.clip)) actor.clock = CLIPS[actor.beat.clip].ms
  while (actor.clock >= CLIPS[actor.beat.clip].ms) {
    actor.clock -= CLIPS[actor.beat.clip].ms
    actor.at += 1
    actor.x = Math.max(0, Math.min(span, actor.x + actor.beat.stride * catScale()))
    const isOut =
      actor.beat.stride !== 0 &&
      (actor.beat.stride > 0 ? actor.x >= Math.min(span, actor.goal) : actor.x <= Math.max(0, actor.goal))
    const isCut = actor.isCalled && LOOPS.includes(actor.beat.clip)
    if (actor.at >= actor.beat.frames.length || isOut || isCut) {
      actor.isCalled = false
      actor.beat = direct(isWorking, span)
      actor.at = 0
    }
    hasMoved = true
  }

  return hasMoved
}

// ------------------------------------------------------------------ the scene

/** The cat's rows, then one for the ground it stands on. */

/** What the scene is painted with, beside the cat's own palette. */
const SCENE = {
  ground: 0x8a7a1f,
  grass: [0x5f8a3a, 0x7fa64a, 0x4d7330],
  bloom: [0xe86a8a, 0xf2c14e, 0xe8e2f7],
  mote: 0x4a5573,
  bug: 0x9bd45a,
  ember: [0xf2a45b, 0xe2843a, 0xb9622a],
  spark: [0xf7e27a, 0xfff3c0],
  hurt: [0xff6b7a, 0xc8283a],
}

/** One thing adrift over the scene: a square of dust, a spark, a cross. */
type Speck = { x: number; y: number; dx: number; dy: number; age: number; life: number; glyph: number; colors: readonly number[] }

/** A glyph standing in the scene: a blade of grass, a bloom, a mote. */
type Prop = { x: number; row: number; glyph: number; color: number }

/** The scene around the cat: module values, as the cat's own are. */
const scene = {
  clock: 0,
  specks: [] as Speck[],
  /** What the cat says, wrapped, and until when on the scene's clock. */
  lines: [] as string[],
  saysUntil: 0,
  bugX: 0,
  /** The props laid for a strip this wide, and that width. */
  props: [] as Prop[],
  laidFor: 0,
  isDirty: false,
}

const glyphOf = (text: string) => text.codePointAt(0) ?? 0x20

/** A small repeatable generator: the same strip width grows the same meadow. */
const seeded = (seed: number) => {
  let state = (seed * 2654435761) >>> 0

  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0

    return state / 4294967296
  }
}

/** Grass in tufts, a bloom on its stem now and then, motes in the air. */
const layProps = (columns: number) => {
  const next = seeded(columns)
  const pick = <T,>(from: readonly T[]) => from[Math.floor(next() * from.length)] as T
  const props: Prop[] = []
  const floor = catRows() - 1
  for (let x = 1 + Math.floor(next() * 4); x < columns - 3; x += 6 + Math.floor(next() * 9)) {
    if (next() < 0.3) {
      // A bloom: a head, and a stem two rows tall.
      props.push({ x, row: floor - 2, glyph: glyphOf('*'), color: pick(SCENE.bloom) })
      props.push({ x, row: floor - 1, glyph: glyphOf('|'), color: SCENE.grass[2] ?? 0 })
      props.push({ x, row: floor, glyph: glyphOf('|'), color: SCENE.grass[2] ?? 0 })
      continue
    }
    const height = 1 + Math.floor(next() * 3)
    for (let up = 0; up < height; up += 1) {
      const blades = up === 0 ? '\\|/' : up === 1 ? '\\ /' : ' | '
      for (let k = 0; k < 3; k += 1) {
        const blade = blades[k] ?? ' '
        if (blade !== ' ') props.push({ x: x + k, row: floor - up, glyph: glyphOf(blade), color: pick(SCENE.grass) })
      }
    }
  }
  for (let k = 0; k < Math.floor(columns / 9); k += 1) {
    props.push({ x: Math.floor(next() * columns), row: Math.floor(next() * (floor - 1)), glyph: glyphOf('.'), color: SCENE.mote })
  }
  scene.props = props
  scene.laidFor = columns * 2 + catScale()
}

/** Where the cat's head is, in cells: what it says and raises starts there. */
const headAt = (columns: number) => {
  const left = Math.round(Math.max(0, Math.min(actor.x, columns - catColumns())))

  return {
    left,
    x: actor.beat.isFlipped ? left + 5 * catScale() : left + catColumns() - 6 * catScale(),
    row: 2 * catScale(),
  }
}

/** Throws `count` specks up from the cat's head. */
const burst = (count: number, glyph: string, colors: readonly number[], spread: number) => {
  const head = headAt(stage.columns || 80)
  for (let k = 0; k < count; k += 1) {
    scene.specks.push({
      x: head.x + (Math.random() - 0.5) * 4,
      y: head.row + Math.random() * 2,
      dx: (Math.random() - 0.5) * spread,
      dy: -(0.05 + Math.random() * 0.12),
      age: 0,
      life: 900 + Math.random() * 1100,
      glyph: glyphOf(glyph),
      colors,
    })
  }
  if (scene.specks.length > 60) scene.specks.splice(0, scene.specks.length - 60)
}

/** Only what a Raster cell takes for sure: Latin letters, digits, plain punctuation. */
const plain = (text: string) =>
  text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\u0020-\u007e\u00a0-\u017f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const BUBBLE_WIDTH = 28
const BUBBLE_LINES = 3

/** Puts words in the cat's mouth for a while: wrapped, cut, and plain. */
const say = (text: string, ms = 7000) => {
  const lines: string[] = []
  let line = ''
  for (const word of plain(text).split(' ')) {
    if (line && line.length + 1 + word.length > BUBBLE_WIDTH) {
      lines.push(line)
      line = ''
    }
    line = line ? `${line} ${word}` : word.slice(0, BUBBLE_WIDTH)
  }
  if (line) lines.push(line)
  if (lines.length === 0) return
  // Too long for the frame: it trails off rather than stop mid-sentence unmarked.
  if (lines.length > BUBBLE_LINES) {
    const last = (lines[BUBBLE_LINES - 1] ?? '').slice(0, BUBBLE_WIDTH - 3).replace(/[\s,;:.!?-]+$/, '')
    lines.splice(BUBBLE_LINES - 1, lines.length, `${last}...`)
  }
  scene.lines = lines
  scene.saysUntil = scene.clock + ms
  scene.isDirty = true
}

/** Moves the scene on by `ms`; true when what is drawn changed. */
const stepScene = (ms: number) => {
  const before = Math.floor(scene.clock / 420)
  scene.clock += ms
  let hasMoved = scene.isDirty
  scene.isDirty = false
  if (scene.specks.length > 0) {
    for (const one of scene.specks) {
      one.age += ms
      one.x += one.dx
      one.y += one.dy
    }
    scene.specks = scene.specks.filter(one => one.age < one.life && one.y > -1)
    hasMoved = true
  }
  if (scene.lines.length > 0 && scene.clock >= scene.saysUntil) {
    scene.lines = []
    hasMoved = true
  }
  // The bug ambles along the ground, a cell every beat of the slow clock.
  if (Math.floor(scene.clock / 420) !== before) {
    scene.bugX -= 1
    hasMoved = true
  }

  return hasMoved
}

/**
 * The strip as Raster cells, `columns` wide and stripRows() tall: the meadow, the
 * bug, the specks, the cat over them, what it says over the cat, the ground.
 */
const spriteStrip = (columns: number, ground: string, ink: string, mood: string) => {
  // The meadow is laid for a width and a floor: another cat, another floor.
  if (scene.laidFor !== columns * 2 + catScale()) layProps(columns)
  const base = rgb(ground)
  const pen = rgb(ink)
  const total = columns * stripRows()
  const glyphs = new Uint32Array(total).fill(0x20)
  const fore = new Uint32Array(total).fill(base)
  const back = new Uint32Array(total).fill(base)
  const put = (row: number, x: number, glyph: number, color: number, behind = base) => {
    if (row < 0 || row >= stripRows() || x < 0 || x >= columns) return
    const cell = row * columns + x
    glyphs[cell] = glyph
    fore[cell] = color
    back[cell] = behind
  }

  for (const one of scene.props) put(one.row, one.x, one.glyph, one.color)

  const bugAt = ((scene.bugX % (columns + 6)) + columns + 6) % (columns + 6) - 3
  '}o{'.split('').forEach((part, k) => put(catRows() - 1, bugAt + k, glyphOf(part), SCENE.bug))

  for (const one of scene.specks) {
    const shade = one.colors[Math.min(one.colors.length - 1, Math.floor((one.age / one.life) * one.colors.length))]
    put(Math.round(one.y), Math.round(one.x), one.glyph, shade ?? pen)
  }

  // The cat, over all that: only the cells it has a pixel in.
  const clip = (isBig() ? BIG_CLIPS : CLIPS)[actor.beat.clip]
  const frame = clip.frames[actor.beat.frames[actor.at] ?? 0] ?? clip.frames[0]
  const across = isBig() ? BIG_W : SPRITE_W
  const letters = isBig() ? BIG_INK : SPRITE_INK
  const palette = isBig() ? BIG_PALETTE : SPRITE_PALETTE
  const left = Math.round(Math.max(0, Math.min(actor.x, columns - catColumns())))
  /** The color of one pixel of the frame, or -1 where the frame is clear. */
  const at = (y: number, x: number) => {
    const seen = frame[y * across + (actor.beat.isFlipped ? across - 1 - x : x)] ?? '.'

    return seen === '.' ? -1 : (palette[letters.indexOf(seen)] ?? -1)
  }
  const wide = catColumns()
  const tall = catRows()
  for (let row = 0; row < tall; row += 1) {
    for (let col = 0; col < wide; col += 1) {
      const top = at(row * 2, col)
      const bottom = at(row * 2 + 1, col)
      if (top < 0 && bottom < 0) continue
      put(row, left + col, LOWER_HALF, bottom < 0 ? base : bottom, top < 0 ? base : top)
    }
  }

  // What it says, in a frame beside its head: on the side with room.
  if (scene.lines.length > 0) {
    const framed = Math.max(...scene.lines.map(one => one.length)) + 4
    // Close to the head: the frame's cells are clear well inside the sprite's box.
    const head = headAt(columns)
    const isRight = head.x + 6 + framed <= columns
    const from = isRight ? head.x + 6 : head.x - 6 - framed
    if (from >= 0) {
      const rim = rgb('#6b7699')
      const last = scene.lines.length + 1
      for (let row = 0; row <= last; row += 1) {
        for (let x = 0; x < framed; x += 1) {
          const isEdgeRow = row === 0 || row === last
          const isEdgeCol = x === 0 || x === framed - 1
          const corner = row === 0 ? (x === 0 ? '╭' : '╮') : x === 0 ? '╰' : '╯'
          const glyph = isEdgeRow && isEdgeCol ? corner : isEdgeRow ? '─' : isEdgeCol ? '│' : ' '
          put(row, from + x, glyphOf(glyph), rim)
        }
        if (row > 0 && row < last) {
          const text = scene.lines[row - 1] ?? ''
          for (let k = 0; k < text.length; k += 1) put(row, from + 2 + k, glyphOf(text[k] ?? ' '), pen)
        }
      }
    }
  }

  const sign = actor.beat.clip === 'sleep' ? 'z' : mood
  if (sign && scene.lines.length === 0) {
    put(0, actor.beat.isFlipped ? left + 1 : left + catColumns() - 2, glyphOf(sign), pen)
  }

  // The ground, last: a band the height of half a cell, under everything.
  for (let x = 0; x < columns; x += 1) put(catRows(), x, 0x2580, SCENE.ground)

  const words = new Uint32Array(total * 3)
  for (let cell = 0; cell < total; cell += 1) {
    words[cell * 3] = glyphs[cell] ?? 0x20
    words[cell * 3 + 1] = fore[cell] ?? base
    words[cell * 3 + 2] = back[cell] ?? base
  }

  return toBase64(new Uint8Array(words.buffer))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const sextet = (word: number, shift: number) => ALPHABET[(word >> shift) & 63] ?? ''

/** Standard padded base64; the environment has no Buffer and no atob. */
const toBase64 = (bytes: Uint8Array) => {
  let out = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const one = bytes[at] ?? 0
    const two = bytes[at + 1]
    const three = bytes[at + 2]
    const word = (one << 16) | ((two ?? 0) << 8) | (three ?? 0)
    out += sextet(word, 18)
    out += sextet(word, 12)
    out += two === undefined ? '=' : sextet(word, 6)
    out += three === undefined ? '=' : sextet(word, 0)
  }

  return out
}

/**
 * ▄: the foreground paints the bottom half, the background the rest of the cell.
 * Not ▀: xterm.js draws a half block a pixel short of the cell's top edge, and
 * that row shows the background — with ▀ it is the bottom color, a hairline
 * over every cell whose halves differ. With ▄ the row is already the top color.
 */
const LOWER_HALF = 0x2584
const rgb = (hex: string) => Number.parseInt(hex.slice(1), 16)

/**
 * The strip the cat walks, as Raster cells: `columns` wide, PET_ROWS tall. Its
 * place is folded into the strip here, so a resize never leaves it outside.
 */
const petStrip = (columns: number, ground: string, ink: string, mood: string) => {
  const span = Math.max(1, columns - CAT_COLUMNS - 2)
  // A triangle wave over the span: x walks out and back whatever it has counted to.
  const lap = ((pet.x % (span * 2)) + span * 2) % (span * 2)
  const left = lap < span ? lap : span * 2 - lap
  const isRightward = lap < span === pet.heading > 0
  const frame = pet.isAsleep ? SPRITE.sleep : (SPRITE.walk[pet.step % 2] ?? SPRITE.walk[0])
  const at = (row: number, x: number) => {
    const inFrame = x - left
    if (inFrame < 0 || inFrame >= CAT_COLUMNS) return undefined

    return FUR[frame[row]?.[isRightward ? inFrame : CAT_COLUMNS - 1 - inFrame] ?? '.']
  }

  const base = rgb(ground)
  const words = new Uint32Array(columns * PET_ROWS * 3)
  for (let row = 0; row < PET_ROWS; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const cell = (row * columns + x) * 3
      words[cell] = LOWER_HALF
      words[cell + 1] = rgb(at(row * 2 + 1, x) ?? ground)
      words[cell + 2] = rgb(at(row * 2, x) ?? ground)
    }
  }
  // What it feels, one character past its head, on the top row.
  if (mood) {
    const beside = isRightward ? left + CAT_COLUMNS : left - 1
    if (beside >= 0 && beside < columns) {
      words[beside * 3] = mood.codePointAt(0) ?? 0x20
      words[beside * 3 + 1] = rgb(ink)
      words[beside * 3 + 2] = base
    }
  }

  return toBase64(new Uint8Array(words.buffer))
}

const cut = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

const clock = (ms: number) => {
  const all = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(all / 60)
  return `${String(minutes).padStart(2, '0')}:${String(all % 60).padStart(2, '0')}`
}

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** A prompt long enough to be the session's mission, and not a bare slash command. */
const isMissionWorthy = (text: string) => text.length >= 16 && !text.startsWith('/')

/** What the running tool is working on, from whichever argument carries it. */
const detailOf = (e: object) => {
  const args = e as Record<string, unknown>
  const tool = asText(args.tool)
  // An MCP tool is named mcp__<server>__<tool>: the two are what it is doing.
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  const questions = Array.isArray(args.questions) ? (args.questions[0] as Record<string, unknown> | null) : null
  const first =
    (mcp ? `${mcp[1]} › ${mcp[2]}` : '') ||
    // A shell command says what it is for better than how it does it.
    (tool === 'Bash' ? asText(args.description) : '') ||
    asText(args.command) ||
    asText(args.file_path) ||
    asText(args.pattern) ||
    asText(args.description) ||
    asText(args.subject) ||
    asText(args.taskId) ||
    asText(args.skill) ||
    asText(args.url) ||
    asText(args.query) ||
    asText(questions?.question) ||
    asText(args.prompt) ||
    asText(args.path)

  return first.replace(/\s+/g, ' ')
}

/** The feed's badge for a tool: its name, or a short one where the name is long. */
const SHORT: Record<string, string> = {
  AskUserQuestion: 'Ask',
  ToolSearch: 'Tools',
  NotebookEdit: 'Notebook',
  TodoWrite: 'Todo',
  TaskCreate: 'Task',
  TaskUpdate: 'Task',
  TaskList: 'Task',
  TaskGet: 'Task',
  WebFetch: 'Fetch',
  WebSearch: 'Search',
  ExitPlanMode: 'Plan',
}
const labelOf = (tool: string) => (tool.startsWith('mcp__') ? 'MCP' : (SHORT[tool] ?? tool))

/** What a tool call was given, flattened: where a path or a ticket is looked for. */
const said = (e: object) => {
  try {
    return JSON.stringify(e).slice(0, 4000)
  } catch {
    return ''
  }
}

/** TodoWrite's list as this mod keeps it, whatever the payload turns out to be. */
const asTodos = (value: unknown): Todo[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap(one => {
    if (!one || typeof one !== 'object') return []
    const row = one as Record<string, unknown>
    const content = asText(row.content)
    if (!content) return []
    const status: Todo['status'] =
      row.status === 'in_progress' || row.status === 'completed' ? row.status : 'pending'

    return [{ content, status, activeForm: asText(row.activeForm) || content }]
  })
}

// ---------------------------------------------------------------- the palettes

type Family = 'shell' | 'edit' | 'read' | 'agent' | 'other'
type Badge = { background: string | undefined; text: string | undefined }

type Tone = {
  panel: string | undefined
  card: string | undefined
  frame: string | undefined
  mark: string | undefined
  text: string | undefined
  muted: string | undefined
  ok: string | undefined
  bad: string | undefined
  badBackground: string | undefined
  liveBackground: string | undefined
  liveText: string | undefined
  chipBackground: string | undefined
  chipText: string | undefined
  track: string | undefined
  badges: Record<Family, Badge>
}

const PLAIN: Badge = { background: undefined, text: undefined }

/** Unlocker's own blues, off the design tokens, over a navy or a paper ground. */
const TONES: Record<Skin, Tone> = {
  dark: {
    panel: '#0f131d',
    card: '#0f131d',
    frame: '#2a3350',
    mark: '#406aff',
    text: '#e6eaf5',
    muted: '#6b7699',
    ok: '#3ecf8e',
    bad: '#ff6b7a',
    badBackground: '#3a1620',
    liveBackground: '#173cc1',
    liveText: '#ffffff',
    chipBackground: '#222a42',
    chipText: '#aab6dd',
    track: '#2a3350',
    badges: {
      shell: { background: '#12306b', text: '#7fb0ff' },
      edit: { background: '#2e2466', text: '#b7a4ff' },
      read: { background: '#0f3a44', text: '#6fd6e6' },
      agent: { background: '#123d2c', text: '#6fe0a8' },
      other: { background: '#2a3044', text: '#aab6dd' },
    },
  },
  light: {
    panel: '#f4f6fc',
    card: '#f4f6fc',
    frame: '#c9d3ee',
    mark: '#173cc1',
    text: '#1a2240',
    muted: '#6a7594',
    ok: '#0a8f5a',
    bad: '#c8283a',
    badBackground: '#fde3e6',
    liveBackground: '#406aff',
    liveText: '#ffffff',
    chipBackground: '#e3e9fa',
    chipText: '#33407a',
    track: '#dbe1f2',
    badges: {
      shell: { background: '#dbe6ff', text: '#173cc1' },
      edit: { background: '#e8e1ff', text: '#5a3fc0' },
      read: { background: '#d9f3f7', text: '#0b6b7a' },
      agent: { background: '#d9f5e6', text: '#0a7a4c' },
      other: { background: '#e6e9f2', text: '#4a5578' },
    },
  },
  // A theme that asked for the terminal's 16 colors gets none of ours.
  ansi: {
    panel: undefined,
    card: undefined,
    frame: undefined,
    mark: undefined,
    text: undefined,
    muted: undefined,
    ok: undefined,
    bad: undefined,
    badBackground: undefined,
    liveBackground: undefined,
    liveText: undefined,
    chipBackground: undefined,
    chipText: undefined,
    track: undefined,
    badges: { shell: PLAIN, edit: PLAIN, read: PLAIN, agent: PLAIN, other: PLAIN },
  },
}

const FAMILIES: Record<string, Family> = {
  Bash: 'shell',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  WebFetch: 'read',
  WebSearch: 'read',
  Agent: 'agent',
  Task: 'agent',
  Skill: 'agent',
  TodoWrite: 'agent',
}

/** Which palette the `theme` row of /config asks for. */
const skinOf = (value: unknown): Skin => {
  const name = typeof value === 'string' ? value.toLowerCase() : ''
  if (name.includes('ansi')) return 'ansi'

  return name.includes('light') ? 'light' : 'dark'
}

/**
 * Takes the first candidate the engine does not already have, and remembers it.
 * Idempotent: registering a name again replaces it, so a later turn may retry.
 */
const COMMAND = {
  description: 'Rouvre et cadre le pane Unlocker',
  argumentHint: 'auto | mission <texte> | spec <feature|off> | pet <sprite|big|png|3d|line|pixel|off> | demo | UNL-1234 <texte>',
}

const claimCommand = async ($: EngineInterface, isFreshLoad = false) => {
  const already = await read($, command)
  if (already !== null && !isFreshLoad) return already

  // A reload drops the module's registrations while `$.state` keeps the name:
  // register it again, or the pane advertises a command the engine forgot.
  if (already !== null) {
    const isBack = await $.command
      .register({ name: already, ...COMMAND })
      .then(() => true)
      .catch(() => false)
    if (isBack) return already
  }

  const taken = new Set((await $.command.list()).map(one => one.name))
  const free = CANDIDATES.find(one => !taken.has(one))
  if (free === undefined) {
    $.ui.toast('focus-pane: aucun nom de commande libre')

    return null
  }

  await $.command.register({ name: free, ...COMMAND })
  await update($, command, () => free)

  return free
}

/** Reads the `theme` row of /config, then writes the palette it asks for. */
const wearTheme = async ($: EngineInterface) => {
  const rows = await $.config.list()
  const seen = skinOf(rows.find(one => one.key === 'theme')?.value)
  await update($, skin, () => seen)
}

// ------------------------------------------------------------------ figures

const MARK: Record<Todo['status'], string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
}

/** Keeps the end of a text: a branch or a path says most in its last segment. */
const tail = (text: string, room: number) =>
  text.length <= room ? text : `…${text.slice(text.length - Math.max(1, room - 1))}`

/** 84210 as 84.2k: a figure a card can print large. */
const compact = (count: number) =>
  count < 1000
    ? String(count)
    : count < 1_000_000
      ? `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}k`
      : `${(count / 1_000_000).toFixed(1)}M`

/** How long a call took, as a feed row ends: 4ms, 6.1s, 01:12. */
const took = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms)

/** How long the session has run, as a card prints it: 42s, 4m, 1h12. */
const span = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

const two = (value: number) => String(value).padStart(2, '0')

/** The wall-clock time of a feed row. */
const stamp = (at: number) => {
  const when = new Date(at)

  return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`
}

// ------------------------------------------------------------------ the parts

type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
}

/** Secondary text: the palette's own grey, or the terminal's dim under ANSI. */
const quiet = (tone: Tone, ground: string | undefined) => ({
  color: tone.muted,
  dimColor: tone.muted === undefined,
  backgroundColor: ground,
})

/** A small filled label, as the header and the feed carry them. */
const chip = (
  { Text }: Elements,
  label: string,
  background: string | undefined,
  text: string | undefined,
) => (
  <Text bold color={text} backgroundColor={background} inverse={background === undefined}>
    {` ${label} `}
  </Text>
)

/** The last row: each key in the accent, what it does beside it, in one line. */
const legend = (
  { Box, Text }: Elements,
  tone: Tone,
  keys: readonly (readonly [string, string])[],
) => (
  <Box key="legend" flexDirection="row" width="100%">
    <Text backgroundColor={tone.panel} wrap="truncate-end">
      {keys.map(([key, does], at) => (
        <Text backgroundColor={tone.panel}>
          <Text bold color={tone.mark} backgroundColor={tone.panel}>
            {`${at === 0 ? '' : '  '}${key}`}
          </Text>
          <Text {...quiet(tone, tone.panel)}>{` ${does}`}</Text>
        </Text>
      ))}
    </Text>
  </Box>
)

/** A thin progress line: the filled part in its color, the rest as a track. */
const meter = ({ Text }: Elements, tone: Tone, ratio: number, width: number, color: string | undefined) => {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))

  return (
    <Text backgroundColor={tone.card}>
      <Text color={color} backgroundColor={tone.card}>
        {'━'.repeat(filled)}
      </Text>
      <Text color={tone.track} dimColor={tone.track === undefined} backgroundColor={tone.card}>
        {'─'.repeat(width - filled)}
      </Text>
    </Text>
  )
}

/** A card's first line: its name in small capitals, what it counts on the right. */
const heading = ({ Box, Text }: Elements, tone: Tone, label: string, aside: string) => (
  <Box flexDirection="row" width="100%" justifyContent="space-between">
    <Text {...quiet(tone, tone.card)}>{`${label} ›`}</Text>
    <Text {...quiet(tone, tone.card)}>{aside}</Text>
  </Box>
)

type Figure = {
  label: string
  aside: string
  value: string
  /** 0 to 1, or null for a card with no meter. */
  ratio: number | null
  color: string | undefined
  caption: string
}

/** One figure, large, with its meter and what it counts: the row of four. */
const card = (parts: Elements, tone: Tone, one: Figure, width: number) => {
  const { Box, Text } = parts

  return (
    <Box
      key={`card:${one.label}`}
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="round"
      borderColor={tone.frame}
      backgroundColor={tone.card}
      paddingX={1}
    >
      {heading(parts, tone, one.label, one.aside)}
      <Text bold color={tone.text} backgroundColor={tone.card}>
        {one.value}
      </Text>
      {one.ratio === null ? (
        <Text backgroundColor={tone.card}> </Text>
      ) : (
        meter(parts, tone, one.ratio, Math.max(4, width - 4), one.color)
      )}
      <Text {...quiet(tone, tone.card)} wrap="truncate-end">
        {one.caption}
      </Text>
    </Box>
  )
}

// ------------------------------------------------------------- sacred book

const KINDS: Record<string, Doc['kind']> = { spécification: 'spec', plan: 'plan', maquette: 'design' }

/** `title: "…"` and `status: …` of a document's front matter, then its headings. */
const readDoc = (text: string) => {
  const title = text.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? null
  const status = text.match(/^status:\s*(\S+)/m)?.[1] ?? null
  const outline = text
    .split('\n')
    .flatMap(row => {
      const hit = row.match(/^(##|###) (.+)$/)
      if (!hit) return []
      const said = (hit[2] ?? '').replace(/[`*]/g, '').replace(/ → .*$/, '').trim()

      return [hit[1] === '###' ? `  ${said}` : said]
    })

  return { title, status, outline }
}

/** Binds the pane to one Sacred Book feature: its README, its spec, its plan. */
const bindFeature = async ($: EngineInterface, query: string): Promise<Feature | null> => {
  const found = await $.process.run(['sh', '-c', FIND, 'sh', query])
  if (found.exitCode !== 0) return null
  const [path = '', ...readme] = found.stdout.split('\n')
  if (!path) return null

  const docs: Doc[] = []
  for (const row of readme) {
    const hit = row.match(/^- (\S+) : \[`?([^`\]]+)`?\]\(([^)]+)\)(?: — \*(.+?)\*)?/)
    const kind = hit ? KINDS[(hit[1] ?? '').toLowerCase()] : undefined
    if (!hit || kind === undefined) continue
    const file = `${path}/${hit[3] ?? ''}`
    const doc: Doc = { kind, name: hit[2] ?? '', path: file, status: hit[4] ?? null, title: null, outline: [] }
    if (kind !== 'design') {
      const text = await $.process.run(['sh', '-c', CAT, 'sh', file])
      if (text.exitCode === 0) {
        const told = readDoc(text.stdout)
        doc.title = told.title
        doc.status = told.status ?? doc.status
        doc.outline = told.outline
      }
    }
    docs.push(doc)
  }

  const bound: Feature = {
    path,
    title: readme.find(row => row.startsWith('# '))?.slice(2).trim() ?? path,
    ticket: readme.join('\n').match(TICKET)?.[0]?.toUpperCase() ?? null,
    docs,
  }
  await update($, feature, () => bound)
  await update($, focus, was => ({ ...was, ticket: was.ticket ?? bound.ticket }))
  await $.store.set(`feature:${await $.session.cwd()}`, path).catch(() => undefined)

  return bound
}

/** What thumbs.py printed, as shots, whatever it turns out to hold. */
const asShots = (text: string): Gallery['shots'] => {
  const told: unknown = JSON.parse(text)
  if (!Array.isArray(told)) return []

  return told.flatMap(one => {
    const row = one as Record<string, unknown> | null
    const cells = asText(row?.cells)
    const columns = Number(row?.columns)
    const rows = Number(row?.rows)

    return row && cells && columns > 0 && rows > 0
      ? [{ id: asText(row.id), title: asText(row.title), columns, rows, cells }]
      : []
  })
}

/** Shoots the bound mockup's screens once; thumbs.py keeps them for the next time. */
const loadGallery = async ($: EngineInterface) => {
  const design = (await read($, feature))?.docs.find(one => one.kind === 'design')
  const now = await read($, gallery)
  if (!design) return update($, gallery, (): Gallery => ({ status: 'failed', path: null, shots: [] }))
  if (now.path === design.path && (now.status === 'ready' || now.status === 'loading')) return undefined

  await update($, gallery, (): Gallery => ({ status: 'loading', path: design.path, shots: [] }))
  const ran = await $.process
    .run([
      'sh',
      '-c',
      'exec python3 "$1" "${SACRED_BOOK_DIR:-$HOME/Sites/sacred-book}/$2" "$3"',
      'sh',
      `${$.plugin.root}/scripts/thumbs.py`,
      design.path,
      String(THUMB_PIXELS),
    ])
    .catch(() => null)
  const shots = ran !== null && ran.exitCode === 0 && !ran.isStdoutTruncated ? asShots(ran.stdout) : []

  return update($, gallery, (): Gallery => ({
    status: shots.length > 0 ? 'ready' : 'failed',
    path: design.path,
    shots,
  }))
}

/**
 * Binds the feature a text points at, when the pane has none: a Sacred Book path
 * or URL first, else a ticket key. `isWrite` rebinds, the agent being at work on
 * that feature's documents; a mere read of another feature leaves the binding.
 */
const noticeFeature = async ($: EngineInterface, text: string, isWrite = false) => {
  const now = await read($, feature)
  const path = text.match(BOOK_PATH)?.[1]
  if (path !== undefined) {
    if (now?.path === path || (now !== null && !isWrite) || missed.has(path)) return
    if ((await bindFeature($, path.split('/').pop() ?? path).catch(() => null)) === null) missed.add(path)

    return
  }
  const ticket = text.match(TICKET)?.[0]?.toUpperCase()
  if (ticket === undefined || now !== null || missed.has(ticket)) return
  if ((await bindFeature($, ticket).catch(() => null)) === null) missed.add(ticket)
}

/** A todo list off the bound plan's own steps, for showing the pane full. */
const demoTodos = (bound: Feature | null): Todo[] => {
  const steps = (bound?.docs.find(one => one.kind === 'plan')?.outline ?? [])
    .map(one => one.trim())
    .filter(one => /^R\d|^api-v2|^Front|^Pact|^Recette/.test(one))
  const all =
    steps.length >= 4
      ? steps.slice(0, 8)
      : ['Lire la spec', 'Écrire le contrat BFF', 'Régénérer le SDK', 'Conformer api-v2', 'Brancher le front', 'Recette staging']

  return all.map((content, at) => ({
    content,
    status: at < 2 ? 'completed' : at === 2 ? 'in_progress' : 'pending',
    activeForm: content,
  }))
}

/** A feature made up whole, for a session bound to none. */
const DEMO_FEATURE: Feature = {
  path: 'v2/banking/console-comptes',
  title: 'Console admin — comptes',
  ticket: 'UNL-4844',
  docs: [
    {
      kind: 'spec',
      name: 'spec.md',
      path: 'v2/banking/console-comptes/spec.md',
      status: 'approved',
      title: 'Console admin — comptes',
      outline: ['Ce qui est livré', 'Règles métier', '  Solde et encours', '  Relevé', 'Hors périmètre'],
    },
    {
      kind: 'plan',
      name: 'plan.md',
      path: 'v2/banking/console-comptes/plan.md',
      status: 'in progress',
      title: 'Plan — console comptes',
      outline: [
        'Contrat BFF',
        '  R1 — GET /accounts',
        '  R2 — GET /accounts/{id}',
        '  R3 — relevé',
        '  R4 — attestation',
        'api-v2 — en dernier, conforme',
        'Front — apps/admin',
        'Pact',
        'Recette (staging)',
      ],
    },
    {
      kind: 'design',
      name: 'maquettes.html',
      path: 'v2/banking/console-comptes/design/maquettes.html',
      status: null,
      title: null,
      outline: [],
    },
  ],
}

/** A feed of calls a real turn could have made, the newest still running. */
const demoFeed = (now: number): FeedRow[] =>
  (
    [
      ['Bash', 'make spec-guard', 4, null, false],
      ['Edit', 'apps/admin/src/accounts/StatementTable.tsx', 21, 180, false],
      ['Bash', 'bun run test accounts', 48, 12400, true],
      ['Edit', 'packages/sdk-backoffice/src/accounts.ts', 75, 210, false],
      ['Read', 'src/BackOffice/Accounts/StatementDto.php', 96, 40, false],
      ['Grep', 'AccountStatement', 110, 320, false],
      ['Bash', 'make sdk-gen', 152, 8700, false],
      ['Agent', 'Conformer api-v2 au contrat R3', 240, 96000, false],
      ['Read', 'v2/banking/console-comptes/plan.md', 305, 35, false],
    ] as const
  ).map(([tool, detail, ago, ms, isError], at) => ({ id: `demo-${at}`, tool, detail, at: now - ago * 1000, ms, isError }))

/** Notes and chores for a pane nobody wrote in yet. */
const demoBoard = (now: number): Board => ({
  notes: [
    { id: 1, text: 'Le relevé doit paginer côté serveur, pas dans le front', at: now - 40 * 60_000 },
    { id: 2, text: 'Attestation : attendre la réponse du métier sur le gabarit', at: now - 12 * 60_000 },
  ],
  chores: [
    { id: 3, text: 'Relire la PR BFF', isDone: true, href: null },
    { id: 4, text: 'Recette staging avec un compte centralisateur', isDone: false, href: null },
    { id: 5, text: 'Ticket UNL-4844', isDone: false, href: 'https://linear.app/unlocker/issue/UNL-4844' },
  ],
  serial: 5,
})

/** The person's notes are kept per working directory, across sessions. */
const shelf = async ($: EngineInterface) => `board:${await $.session.cwd()}`

/** What `$.store` gave back, as a Board, whatever it turns out to hold. */
const asBoard = (value: unknown): Board | null => {
  if (!value || typeof value !== 'object') return null
  const held = value as Record<string, unknown>
  const notes = Array.isArray(held.notes) ? held.notes : []
  const chores = Array.isArray(held.chores) ? held.chores : []

  return {
    notes: notes.flatMap(one => {
      const row = one as Record<string, unknown> | null
      const text = asText(row?.text)

      return row && text ? [{ id: Number(row.id) || 0, text, at: Number(row.at) || 0 }] : []
    }),
    chores: chores.flatMap(one => {
      const row = one as Record<string, unknown> | null
      const text = asText(row?.text)

      return row && text
        ? [{ id: Number(row.id) || 0, text, isDone: row.isDone === true, href: asText(row.href) || null }]
        : []
    }),
    serial: Number(held.serial) || 0,
  }
}

/** Changes the board, then writes it to the store: the two never part. */
const keep = async ($: EngineInterface, change: (was: Board) => Board) => {
  await update($, board, change)
  const now = await read($, board)
  await $.store.set(await shelf($), now).catch(() => undefined)
}

const QUIP =
  "Tu es un chat de bureau qui regarde un agent de code travailler et commente, pince-sans-rire, " +
  'comme un documentaire animalier ou une remarque de chat. Une seule phrase très courte, de ' +
  '8 mots et 50 caractères au maximum, en français, sans guillemets, sans emoji, sans préambule.'

/** Has haiku word what the cat thinks of it; detached, the turn never waits on it. */
const quip = ($: EngineInterface, about: string) => {
  if (stage.style !== 'sprite' && stage.style !== 'big') return
  void $.model
    .complete({ model: 'haiku', maxTokens: 40, system: QUIP, prompt: about })
    .then(told => {
      const line = told.isAnswered ? told.text.trim().split('\n')[0]?.trim() : ''
      if (line) say(line, 9000)
    })
    .catch(() => undefined)
}

/** Reads the session's own counters into the atom the cards draw from. */
const meterUsage = async ($: EngineInterface) => {
  const seen = await $.session.usage()
  await update($, usage, () => ({
    tokens: seen.context.tokens ?? null,
    window: seen.context.window,
    percent: seen.context.percent ?? null,
    usd: seen.cost?.usd ?? null,
    startedAt: seen.startedAt,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The pane first: nothing below may keep it off screen. A refused call here
    // throws, and a thrown hook is skipped whole — which is how /focus, already
    // a built-in, once took the pane down with it.
    // Unasked, the engine seats a pane only from 144 columns: below that it waits,
    // and the person's first prompt opens it (prompt.submit), at any width.
    void $.ui
      .open({ id: PANE, title: 'Focus' })
      .then(opened => {
        if (!opened.isPlaced) $.ui.toast('focus-pane : le pane s\'ouvrira à ton premier message')
      })
      .catch(() => undefined)

    await claimCommand($, true).catch(reason => {
      $.ui.toast(`focus-pane: commande non enregistrée (${String(reason)})`)
    })

    await wearTheme($).catch(() => undefined)
    await meterUsage($).catch(() => undefined)
    const style = asPetStyle(await $.store.get('pet').catch(() => null))
    if (style !== null) await update($, petStyle, () => style)
    // A reload lands in the middle of a turn as well as between two: the turn
    // atom outlives it and says which, where a fresh module would guess rest.
    pace($, (await read($, turn)).isRunning)

    const saved = await shelf($)
      .then(key => $.store.get(key))
      .then(asBoard)
      .catch(() => null)
    if (saved !== null) await update($, board, () => saved)


    const branch = await $.process
      .run(['git', 'branch', '--show-current'], { cwd: await $.session.cwd() })
      .then(ran => (ran.exitCode === 0 ? ran.stdout.trim() : ''))
      .catch(() => '')

    const hit = branch.match(TICKET)
    await update($, focus, was => ({
      ...was,
      branch: branch || null,
      ticket: was.ticket ?? (hit ? hit[0].toUpperCase() : null),
    }))
    // The feature this checkout was last bound to, read again: the files moved on.
    // Only in a checkout on a branch: a bare folder (a workspace root) is no one
    // feature's home, and a new session there starts unbound.
    const last = branch
      ? asText(await $.store.get(`feature:${await $.session.cwd()}`).catch(() => null))
      : ''
    if (last) await bindFeature($, last.split('/').pop() ?? last).catch(() => null)
    else if (hit && (await read($, feature)) === null) await bindFeature($, hit[0]).catch(() => null)

    return next(e)
  })

  // The person switched theme in /config: repaint, no reload needed.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    await update($, skin, () => skinOf(e.value))

    return set
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== (await read($, command))) return next(e)

    const args = e.args.trim()

    if (args === 'spec' || args.startsWith('spec ')) {
      const asked = args.slice('spec'.length).trim()
      if (!asked || asked === 'off') {
        await update($, feature, () => null)
        await $.store.delete(`feature:${await $.session.cwd()}`).catch(() => undefined)

        missed.clear()

        return { text: 'Focus pane: plus de feature Sacred Book liée.' }
      }
      const bound = await bindFeature($, asked.replace(/\/+$/, '').split('/').pop() ?? asked)

      return {
        text: bound
          ? `Focus pane lié à ${bound.path} (${bound.docs.map(one => one.kind).join(', ')}).`
          : `Aucune feature Sacred Book ne répond à « ${asked} ».`,
      }
    }

    if (args === 'pet' || args.startsWith('pet ')) {
      const style = asPetStyle(args.slice('pet'.length).trim() || 'sprite')
      imageRefusal = ''
      if (style === null) return { text: 'Focus pane: pet sprite | big | png | 3d | line | pixel | off.' }
      await update($, petStyle, () => style)
      await $.store.set('pet', style).catch(() => undefined)

      return {
        text:
          style === 'off'
            ? 'Focus pane: le chat est rentré.'
            : `Focus pane: le chat est là (${style === 'png' ? 'en image' : style === 'big' ? 'en grand' : style === 'sprite' ? 'en sprites' : style === '3d' ? 'en 3D' : style === 'line' ? 'au trait' : 'en pixels'}).`,
      }
    }

    if (args === 'demo') {
      // A session bound to nothing gets a feature to show; a bound one keeps its own.
      if ((await read($, feature)) === null) await update($, feature, () => DEMO_FEATURE)
      const fake = demoTodos(await read($, feature))
      await update($, todos, () => fake)
      const now = await $.clock.now()
      await update($, feed, () => demoFeed(now))
      await update($, focus, was => ({
        ...was,
        isDismissed: false,
        ticket: was.ticket ?? DEMO_FEATURE.ticket,
        mission: was.mission ?? 'Livrer la console admin des comptes : liste, détail, relevé et attestation',
        isMissionPhrased: true,
        summary: was.summary ?? 'Brancher le relevé de compte sur le SDK back-office',
        isPinned: true,
      }))
      // Shown, never stored: the person's own notes are left as they are on disk.
      await update($, board, was => (was.notes.length + was.chores.length > 0 ? was : demoBoard(now)))

      return { text: `Focus pane: données de démonstration (${fake.length} étapes).` }
    }

    const isMission = args.startsWith('mission ')
    const said = isMission ? args.slice('mission '.length).trim() : args
    const hit = said.match(TICKET)
    const rest = hit ? said.replace(hit[0], '').trim() : said

    await update($, focus, was => ({
      ...was,
      isDismissed: false,
      ticket: hit ? hit[0].toUpperCase() : was.ticket,
      mission: isMission && rest ? cut(rest, 200) : was.mission,
      isMissionPhrased: isMission && rest ? true : was.isMissionPhrased,
      summary: isMission || args === 'auto' ? was.summary : rest || was.summary,
      isPinned: isMission ? was.isPinned : args === 'auto' ? false : rest.length > 0 || was.isPinned,
    }))
    await wearTheme($).catch(() => undefined)

    const opened = await $.ui.open({ id: PANE, title: 'Focus' })

    return {
      text: opened.isPlaced
        ? `Focus pane up${hit ? ` on ${hit[0]}` : ''}${rest ? `: ${isMission ? 'mission ' : ''}${rest}` : ''}.`
        : 'Focus pane waiting: widen the terminal.',
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, focus, was => ({ ...was, isDismissed: true }))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const hit = e.text.match(TICKET)
    const asked = e.text.trim()
    await update($, focus, was => ({
      ...was,
      ask: e.text,
      ticket: hit ? hit[0].toUpperCase() : was.ticket,
      mission: was.mission ?? (isMissionWorthy(asked) ? cut(asked, 200) : null),
    }))

    // A ticket or a Sacred Book link in the prompt names the feature in hand.
    await noticeFeature($, e.text).catch(() => undefined)

    // A prompt is the person asking: the pane opened behind it seats at any width.
    const seated = await read($, focus)
    if (!seated.isDismissed) void $.ui.open({ id: PANE, title: 'Focus' }).catch(() => undefined)

    return next(e)
  })

  // A call the engine will ask the person to allow: the session waits on them
  // until the call ends, allowed or not.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if ((verdict as { decision?: unknown }).decision === 'ask') await_(true)

    return verdict
  })

  // The person is typing: the cat sits up. Nothing awaited, the keystroke must not wait.
  on('prompt.edit', ($, e, next) => {
    if (actor.typing <= 0) {
      actor.isCalled = true
      say("Je t'écoute.", 2500)
    }
    actor.typing = TYPING_MS

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await claimCommand($).catch(() => undefined)
    const now = await $.clock.now()
    await update($, turn, was => ({ ...was, isRunning: true, startedAt: now }))
    await meterUsage($).catch(() => undefined)

    const seated = await read($, focus)
    if (!(e as { agentId?: unknown }).agentId && seated.ask.trim()) {
      quip($, `L'humain vient de demander ceci à l'agent :\n${seated.ask.trim().slice(0, 400)}`)
    }
    if (!seated.isDismissed) {
      const up = await $.ui.panes()
      if (!up.some(one => one.id === PANE)) void $.ui.open({ id: PANE, title: 'Focus' })
    }

    pace($, true)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    sequence += 1
    const id = `${at}-${sequence}`
    const row: FeedRow = { id, tool: String(e.tool), detail: detailOf(e), at, ms: null, isError: false }
    await update($, feed, was => [row, ...was].slice(0, FEED_KEPT))

    // An agent reading or writing a Sacred Book document names the feature in hand.
    const given = said(e)
    if (given.includes('sacred-book')) {
      // The documents may just have been published: a ticket that found none is asked again.
      missed.clear()
      const isWrite = row.tool === 'Write' || row.tool === 'Edit'
      await noticeFeature($, given, isWrite).catch(() => undefined)
      const known = (await read($, focus)).ticket
      if (known) await noticeFeature($, known).catch(() => undefined)
    }

    if (ASKING.includes(String(e.tool))) await_(true)
    // Each call raises a little dust off the cat's back.
    if (!e.agentId) burst(3, '■', SCENE.ember, 0.3)

    const close = async (isError: boolean) => {
      await_(false)
      if (isError) feel('!')
      const ms = (await $.clock.now()) - at
      await update($, feed, was => was.map(one => (one.id === id ? { ...one, ms, isError } : one)))
      await meterUsage($).catch(() => undefined)
    }

    try {
      const ran = await next(e)
      const told = ran as { isError?: unknown; deny?: unknown }
      await close(told.isError === true || typeof told.deny === 'string')

      return ran
    } catch (reason) {
      await close(true)
      throw reason
    }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const wrote = asTodos((e as unknown as { todos?: unknown }).todos)
    if (wrote.length > 0 && !e.agentId) {
      const before = (await read($, todos)).filter(one => one.status === 'completed').length
      if (wrote.filter(one => one.status === 'completed').length > before) feel('♪')
      await update($, todos, () => wrote)
    }

    return ran
  })

  // The task tools are the todo list of newer builds: one call a task, by id.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    const made = (ran as { result?: { task?: { id?: unknown; subject?: unknown } } }).result?.task
    const id = asText(made?.id)
    const args = e as unknown as { subject?: unknown; activeForm?: unknown }
    const content = asText(made?.subject) || asText(args.subject)
    if (id && content) {
      await update($, todos, (was): Todo[] => [
        ...was.filter(one => one.id !== id),
        { id, content, status: 'pending', activeForm: asText(args.activeForm) || content },
      ])
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    const told = ran as { isError?: unknown; result?: { success?: unknown } }
    if (told.isError === true || told.result?.success === false) return ran
    const args = e as unknown as { taskId?: unknown; subject?: unknown; activeForm?: unknown; status?: unknown }
    const id = asText(args.taskId)
    if (!id) return ran
    if (args.status === 'completed') feel('♪')

    await update($, todos, was =>
      args.status === 'deleted'
        ? was.filter(one => one.id !== id)
        : was.map(one =>
            one.id !== id
              ? one
              : {
                  ...one,
                  content: asText(args.subject) || one.content,
                  activeForm: asText(args.activeForm) || asText(args.subject) || one.activeForm,
                  status:
                    args.status === 'pending' || args.status === 'in_progress' || args.status === 'completed'
                      ? args.status
                      : one.status,
                },
          ),
    )

    return ran
  })

  // The engine's own list is the truth: a TaskList answer replaces what the pane holds.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    const listed = (ran as { result?: { tasks?: unknown } }).result?.tasks
    if (!Array.isArray(listed)) return ran

    await update($, todos, was =>
      listed.flatMap(one => {
        const row = one as Record<string, unknown> | null
        const id = asText(row?.id)
        const content = asText(row?.subject)
        if (!row || !id || !content) return []
        const status: Todo['status'] =
          row.status === 'in_progress' || row.status === 'completed' ? row.status : 'pending'

        return [{ id, content, status, activeForm: was.find(old => old.id === id)?.activeForm ?? content }]
      }),
    )

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran

    pace($, false)
    await update($, turn, was => ({
      count: was.count + 1,
      isRunning: false,
      startedAt: null,
      lastMs: e.durationMs,
    }))
    // A call the turn left open was cut short with it.
    await update($, feed, was =>
      was.map(one => (one.ms === null ? { ...one, ms: 0, isError: e.isAborted } : one)),
    )
    await meterUsage($).catch(() => undefined)

    if (!e.isAborted && e.answer.trim()) {
      quip($, `L'agent vient de finir son tour. Sa conclusion :\n${e.answer.trim().slice(0, 400)}`)
    }

    // The answer often links the documents it published; else the ticket is asked again.
    missed.clear()
    await noticeFeature($, e.answer).catch(() => undefined)
    const known = (await read($, focus)).ticket
    if (known) await noticeFeature($, known).catch(() => undefined)

    const seated = await read($, focus)
    const ask = seated.ask.trim()
    if (seated.isPinned || e.isAborted || (!ask && !seated.summary)) return ran

    // Detached: the turn ends now, the lines land when haiku answers.
    void (async () => {
      if (seated.mission && !seated.isMissionPhrased) {
        const phrased = await $.model.complete({
          model: 'haiku',
          maxTokens: 80,
          system:
            "Tu dis la mission d'une session de dev : le but de fond, pas la première action. Une seule phrase nominale de " +
            '12 mots maximum, en français, sans guillemets, sans préambule, sans point final.',
          prompt:
            `Ticket : ${seated.ticket ?? 'aucun'}\n\n` +
            `Demande initiale :\n${seated.mission}\n\n` +
            `Ce que l'agent a compris et fait au premier tour :\n${e.answer.slice(0, 1500) || 'rien de visible'}`,
        })
        const line = phrased.isAnswered ? phrased.text.trim().split('\n')[0]?.trim() : ''
        if (line) {
          await update($, focus, was => ({
            ...was,
            mission: cut(line, 160),
            isMissionPhrased: true,
          }))
        }
      }

      const said = await $.model.complete({
        model: 'haiku',
        maxTokens: 120,
        system:
          "Tu dis l'action en cours dans une session de dev, en français. Une seule phrase " +
          'nominale de 14 mots maximum, sans guillemets, sans préambule, sans point final.',
        prompt:
          `Mission de la session : ${seated.mission ?? 'inconnue'}\n\n` +
          `Action précédente : ${seated.summary ?? 'aucune'}\n\n` +
          `Demande : ${ask.slice(0, 1200) || 'aucune'}\n\n` +
          `Ce qui vient d'être fait : ${e.answer.slice(0, 1200) || 'rien de visible'}`,
      })
      if (!said.isAnswered) return
      const line = said.text.trim().split('\n')[0]?.trim()
      if (line) {
        await update($, focus, was => (was.isPinned ? was : { ...was, summary: cut(line, 200) }))
      }
    })()

    return ran
  })

  // A note or a chore typed in the pane: Enter files it, the field starts over.
  on('ui.input', { requestId: PANE }, async ($, e, next) => {
    const text = e.value.trim()
    if (e.kind !== 'submit' || !text) return next(e)

    if (e.element.startsWith('note:new')) {
      const at = await $.clock.now()
      await keep($, was => ({
        ...was,
        serial: was.serial + 1,
        notes: [...was.notes, { id: was.serial + 1, text, at }],
      }))
    } else if (e.element.startsWith('chore:new')) {
      await keep($, was => ({
        ...was,
        serial: was.serial + 1,
        chores: [...was.chores, { id: was.serial + 1, text, isDone: false, href: null }],
      }))
    } else if (e.element.startsWith('chore:link')) {
      const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
      await keep($, was => ({
        ...was,
        serial: was.serial + 1,
        chores: [
          ...was.chores,
          { id: was.serial + 1, text: href.replace(/^https?:\/\//, ''), isDone: false, href },
        ],
      }))
    }

    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== GALLERY) return next(e)
    const [kind, verb, rest] = e.element.split(':')
    const id = Number(rest ?? verb)

    if (kind === 'focus') {
      // a, t, c: the hotkey puts the caret in its field, the person types.
      const { serial } = await read($, board)
      const field = verb === 'chore' ? 'chore:new' : verb === 'link' ? 'chore:link' : 'note:new'
      await $.ui.focus({ requestId: PANE, key: `${field}:${serial}` }).catch(() => undefined)
    } else if (kind === 'gallery' && verb === 'open') {
      await $.ui.open({ id: GALLERY, title: 'Maquettes', focus: true }).catch(() => undefined)
      void loadGallery($).catch(() => undefined)
    } else if (kind === 'gallery' && verb === 'back') {
      await $.ui.open({ id: PANE, title: 'Focus', focus: true }).catch(() => undefined)
    }

    if (kind === 'note' && verb === 'drop') {
      await keep($, was => ({ ...was, notes: was.notes.filter(one => one.id !== id) }))
    } else if (kind === 'chore' && verb === 'clear') {
      await keep($, was => ({ ...was, chores: was.chores.filter(one => !one.isDone) }))
    } else if (kind === 'design' && verb === 'open') {
      const design = (await read($, feature))?.docs.find(one => one.kind === 'design')
      if (design) {
        // Detached: the press returns now, the browser opens when curl answers.
        void $.process
          .run(['sh', '-c', OPEN, 'sh', design.path])
          .then(ran => {
            if (ran.exitCode !== 0) $.ui.toast('focus-pane: maquette introuvable')
          })
          .catch(() => $.ui.toast('focus-pane: maquette introuvable'))
      }
    } else if (kind === 'chore' && verb === 'toggle') {
      await keep($, was => ({
        ...was,
        chores: was.chores.map(one => (one.id === id ? { ...one, isDone: !one.isDone } : one)),
      }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // A phone has no text field: there the two lists are read, not written.
    const Input = 'Input' in table ? table.Input : undefined
    const Link = 'Link' in table ? table.Link : undefined
    const room = Math.max(24, e.props.bodyColumns) - 2
    const seated: Focus = await read($, focus)
    const plan: Todo[] = await read($, todos)
    const rows: FeedRow[] = await read($, feed)
    const state: TurnState = await read($, turn)
    const spent: Usage = await read($, usage)
    const kept: Board = await read($, board)
    const bound: Feature | null = await read($, feature)
    const tone = TONES[await read($, skin)]
    const mine = await read($, command)
    const now = await $.clock.now()
    const parts: Elements = { Box, Text }
    const inner = room - 4
    const briefWidth = Math.max(8, inner - 10)

    const done = plan.filter(one => one.status === 'completed').length
    const turnClock =
      state.isRunning && state.startedAt !== null
        ? clock(now - state.startedAt)
        : state.lastMs !== null
          ? clock(state.lastMs)
          : null

    // ------------------------------------------------------------ the header
    const header = (
      <Box
        flexDirection="row"
        flexWrap="wrap"
        width="100%"
        justifyContent="space-between"
        columnGap={2}
        paddingRight={HEADER_CLEARANCE}
      >
        <Box flexDirection="row">
          <Text bold color={tone.mark} backgroundColor={tone.panel}>
            ◢ U N L O C K E R
          </Text>
          <Text {...quiet(tone, tone.panel)}>{'  │  F O C U S'}</Text>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {state.isRunning
            ? chip(parts, `● EN COURS${turnClock ? ` ${turnClock}` : ''}`, tone.liveBackground, tone.liveText)
            : chip(parts, '○ AU REPOS', tone.chipBackground, tone.chipText)}
          {seated.branch !== null &&
            chip(parts, tail(seated.branch, 24).toUpperCase(), tone.chipBackground, tone.chipText)}
          {seated.ticket !== null && chip(parts, seated.ticket, tone.chipBackground, tone.text)}
        </Box>
      </Box>
    )

    // ------------------------------------------------- mission and action now
    const line = (label: string, said: string | null, fallback: string) => (
      <Box flexDirection="row" width="100%" columnGap={1}>
        <Box flexShrink={0}>{chip(parts, label, tone.chipBackground, tone.chipText)}</Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text
            color={said === null ? tone.muted : tone.text}
            dimColor={said === null && tone.muted === undefined}
            backgroundColor={tone.card}
            wrap="wrap"
          >
            {cut(said ?? fallback, briefWidth * BRIEF_LINES)}
          </Text>
        </Box>
      </Box>
    )
    const brief = (
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        {line('MISSION', seated.mission, 'pas encore de mission')}
        {line('ACTION ', seated.summary, 'action à venir')}
      </Box>
    )

    // -------------------------------------------------------------- the cards
    const figures: Figure[] = [
      {
        label: 'PLAN',
        aside: plan.length > 0 ? `${done}/${plan.length}` : '',
        value: plan.length > 0 ? `${Math.round((done / plan.length) * 100)}%` : '—',
        ratio: plan.length > 0 ? done / plan.length : 0,
        color: tone.ok,
        caption: plan.length > 0 ? 'todos terminées' : 'aucune todo list',
      },
      {
        label: 'CONTEXTE',
        aside: spent.usd === null ? '' : `$${spent.usd.toFixed(2)}`,
        value: spent.tokens === null ? '—' : compact(spent.tokens),
        ratio: spent.percent === null ? 0 : spent.percent / 100,
        color: spent.percent !== null && spent.percent >= 80 ? tone.bad : tone.mark,
        caption:
          spent.percent === null || spent.window === 0
            ? 'tokens en contexte'
            : `${Math.round(spent.percent)}% de ${compact(spent.window)}`,
      },
      {
        label: 'TOURS',
        aside: state.isRunning ? 'EN COURS' : '',
        value: String(state.count + (state.isRunning ? 1 : 0)),
        ratio: null,
        color: undefined,
        caption: turnClock === null ? 'aucun tour joué' : `${state.isRunning ? 'ce tour' : 'dernier'} ${turnClock}`,
      },
      {
        label: 'TEMPS',
        aside: 'SESSION',
        value: spent.startedAt === null ? '—' : span(now - spent.startedAt),
        ratio: null,
        color: undefined,
        caption: `${rows.length} appel${rows.length > 1 ? 's' : ''} d'outil`,
      },
    ]
    const isWide = room >= 84
    const perRow = isWide ? 4 : 2
    const cardWidth = Math.floor((room - (perRow - 1)) / perRow)
    const cards = (
      <Box flexDirection="column" width="100%">
        {[0, perRow]
          .filter(from => from < figures.length)
          .map(from => (
            <Box flexDirection="row" width="100%" columnGap={1}>
              {figures.slice(from, from + perRow).map(one => card(parts, tone, one, cardWidth))}
            </Box>
          ))}
      </Box>
    )

    // ---------------------------------------------------------------- the fit
    // The pane is exactly as tall as its window: every block is counted in rows,
    // and what does not fit gives way in this order — the feed down to a few rows,
    // the outlines, the bottom lists' reserved share, then the todo list.
    const tall = e.props.scroll.bodyRows
    const papers = (bound?.docs ?? []).filter(one => one.kind !== 'design')
    const design = bound?.docs.find(one => one.kind === 'design')
    const paperWidth = isWide && papers.length > 1 ? Math.floor((room - 1) / 2) : room
    const choresDone = kept.chores.filter(one => one.isDone).length
    const half = isWide ? Math.floor((room - 1) / 2) : room
    const noteLines = (text: string) => Math.max(1, Math.ceil(text.length / Math.max(8, half - 14)))
    const notesRows =
      4 + Math.max(1, kept.notes.reduce((sum, one) => sum + noteLines(one.text), 0))
    const choresRows = 5 + Math.max(1, kept.chores.length) + (choresDone > 0 ? 1 : 0)
    const briefLines = (said: string | null) =>
      Math.min(BRIEF_LINES, Math.max(1, Math.ceil((said ?? '').length / briefWidth)))

    // The pixel cat is a Raster on a painted ground; without either, the line cat
    // takes its place, being plain text.
    const Raster = 'Raster' in table ? table.Raster : undefined
    const asked: PetStyle = await read($, petStyle)
    const canPixel = Raster !== undefined && tone.panel !== undefined && tone.text !== undefined
    const Image = 'Image' in table ? table.Image : undefined
    const fitted: PetStyle = asked !== 'off' && asked !== 'line' && !canPixel ? 'line' : asked
    // No Image on this surface, or a terminal that refused it: the sprite cat.
    const style: PetStyle = fitted === 'png' && (Image === undefined || imageRefusal !== '') ? 'sprite' : fitted
    const petRows =
      style === 'png' ? PNG_ROWS : style === 'sprite' || style === 'big' ? stripRows() : style === '3d' ? CAT3_ROWS : style === 'pixel' ? PET_ROWS : style === 'line' ? LINE_ROWS : 0
    const mood = pet.isAsleep
      ? 'z'
      : pet.moodTicks > 0
        ? pet.mood
        : spent.percent !== null && spent.percent >= 80
          ? "'"
          : ''
    // What the animator blits at, between two renders.
    stage.columns = room
    stage.ground = tone.panel ?? ''
    stage.ink = tone.text ?? ''
    stage.mood = mood
    stage.style = style
    stage.left = pngLeft(room)
    stage.root = $.plugin.root

    const rowsOf = (outlines: number, todosKept: number, share: number) => {
      const paperRows = (one: Doc) =>
        Math.min(one.outline.length, outlines) + (one.outline.length > outlines ? 1 : 0) + 4
      const book =
        bound === null
          ? 0
          : (design ? 4 : 3) +
            (paperWidth === room
              ? papers.reduce((sum, one) => sum + paperRows(one), 0)
              : Math.max(0, ...papers.map(paperRows)))
      const block = isWide ? share : Math.floor(share / 2)
      const desk = isWide
        ? Math.max(notesRows, choresRows, block)
        : Math.max(notesRows, block) + Math.max(choresRows, block)
      const list = plan.length === 0 ? 0 : 3 + Math.min(plan.length, todosKept)

      return (
        1 + // header
        2 + briefLines(seated.mission) + briefLines(seated.summary) +
        (isWide ? 6 : 12) + // cards
        book +
        list +
        3 + // the feed's frame and heading
        desk +
        petRows +
        1 // legend
      )
    }

    let outlines = OUTLINE_SHOWN
    let todosKept = plan.length
    let share = Math.round(tall * DESK_SHARE)
    const isOver = () => rowsOf(outlines, todosKept, share) + FEED_LEAST > tall
    while (isOver() && outlines > OUTLINE_LEAST) outlines -= 1
    while (isOver() && share > 0) share -= 1
    while (isOver() && todosKept > TODOS_LEAST) todosKept -= 1
    const shown = Math.max(1, Math.min(FEED_KEPT, tall - rowsOf(outlines, todosKept, share)))
    const blockRows = isWide ? share : Math.floor(share / 2)

    // The todo list's window, when it had to give rows: it follows the step in hand.
    const doing = Math.max(0, plan.findIndex(one => one.status === 'in_progress'))
    const isCut = todosKept < plan.length
    const todosFrom = isCut ? Math.max(0, Math.min(doing - 1, plan.length - (todosKept - 1))) : 0
    const todosSeen = isCut ? plan.slice(todosFrom, todosFrom + todosKept - 1) : plan

    // --------------------------------------------------------------- the plan
    const todoList = plan.length > 0 && (
      <Box
        key="plan"
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        {heading(parts, tone, 'TODOS', `${done}/${plan.length}`)}
        {todosSeen.map(one =>
          one.status === 'in_progress' ? (
            <Box width="100%" backgroundColor={tone.liveBackground}>
              <Text
                bold
                color={tone.liveText}
                backgroundColor={tone.liveBackground}
                inverse={tone.liveBackground === undefined}
                wrap="truncate-end"
              >
                {` ${MARK.in_progress} ${cut(one.activeForm, inner - 4)}`}
              </Text>
            </Box>
          ) : one.status === 'completed' ? (
            <Text backgroundColor={tone.card} wrap="truncate-end">
              <Text color={tone.ok} backgroundColor={tone.card}>{` ${MARK.completed} `}</Text>
              <Text {...quiet(tone, tone.card)} strikethrough>
                {cut(one.content, inner - 4)}
              </Text>
            </Text>
          ) : (
            <Text color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
              {` ${MARK.pending} ${cut(one.content, inner - 4)}`}
            </Text>
          ),
        )}
        {isCut && (
          <Text {...quiet(tone, tone.card)}>{`   + ${plan.length - todosSeen.length} autres étapes`}</Text>
        )}
      </Box>
    )

    // --------------------------------------------------------------- the feed
    // ------------------------------------------------------------ sacred book
    const status = (said: string | null) =>
      said === null
        ? null
        : chip(
            parts,
            said.toUpperCase(),
            said === 'approved' ? tone.badges.agent.background : tone.chipBackground,
            said === 'approved' ? tone.badges.agent.text : tone.chipText,
          )
    const paper = (one: Doc) => (
      <Box
        key={`doc:${one.kind}`}
        flexDirection="column"
        width={paperWidth}
        flexShrink={0}
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        <Box flexDirection="row" width="100%" justifyContent="space-between">
          <Text {...quiet(tone, tone.card)}>{one.kind === 'spec' ? 'SPEC ›' : 'PLAN ›'}</Text>
          {status(one.status)}
        </Box>
        {one.outline.slice(0, outlines).map(row => (
          <Text
            color={row.startsWith('  ') ? tone.muted : tone.text}
            dimColor={row.startsWith('  ') && tone.muted === undefined}
            backgroundColor={tone.card}
            wrap="truncate-end"
          >
            {cut(row.startsWith('  ') ? `  · ${row.trim()}` : `▸ ${row}`, paperWidth - 4)}
          </Text>
        ))}
        {one.outline.length > outlines && (
          <Text {...quiet(tone, tone.card)}>{`  + ${one.outline.length - outlines} sections`}</Text>
        )}
        {Link !== undefined ? (
          <Link href={`${SACRED_BOOK}/${one.path}`} label="ouvrir sur GitHub ↗" />
        ) : (
          <Text {...quiet(tone, tone.card)} wrap="truncate-end">
            {one.name}
          </Text>
        )}
      </Box>
    )
    const book = bound !== null && (
      <Box key="book" flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          width="100%"
          borderStyle="round"
          borderColor={tone.frame}
          backgroundColor={tone.card}
          paddingX={1}
        >
          <Box flexDirection="row" width="100%" columnGap={1}>
            <Box flexShrink={0}>{chip(parts, 'FEATURE', tone.liveBackground, tone.liveText)}</Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
                {bound.title}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text {...quiet(tone, tone.card)}>{tail(bound.path, 34)}</Text>
            </Box>
          </Box>
          {design && (
            <Box flexDirection="row" width="100%" columnGap={1}>
              <Box flexShrink={0}>{chip(parts, 'MAQUETTE', tone.chipBackground, tone.chipText)}</Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
                  {design.name}
                </Text>
              </Box>
              {design.status !== null && (
                <Box flexShrink={0}>
                  <Text {...quiet(tone, tone.card)}>{design.status}</Text>
                </Box>
              )}
              <Box flexShrink={0} flexDirection="row" columnGap={2}>
                <Button key="gallery:open" plain hotkey="m" label="miniatures" onPress={() => undefined} />
                <Button key="design:open" plain hotkey="o" label="ouvrir ↗" onPress={() => undefined} />
              </Box>
            </Box>
          )}
        </Box>
        <Box flexDirection={paperWidth === room ? 'column' : 'row'} width="100%" columnGap={1}>
          {papers.map(paper)}
        </Box>
      </Box>
    )

    const badgeWidth = 8
    const event = (one: FeedRow) => {
      const isLive = one.ms === null
      const ground = one.isError ? tone.badBackground : tone.card
      const badge = tone.badges[FAMILIES[one.tool] ?? 'other']
      const ending = isLive
        ? `● ${clock(now - one.at)}`
        : one.isError
          ? '✗ ÉCHEC'
          : `✓ ${took(one.ms ?? 0)}`
      const free = inner - 8 - 2 - (badgeWidth + 2) - 2 - ending.length - 2

      return (
        <Box
          key={`event:${one.id}`}
          flexDirection="row"
          width="100%"
          justifyContent="space-between"
          backgroundColor={ground}
        >
          <Text backgroundColor={ground} wrap="truncate-end">
            <Text {...quiet(tone, ground)}>{`${stamp(one.at)}  `}</Text>
            {chip(parts, cut(labelOf(one.tool), badgeWidth).padEnd(badgeWidth), badge.background, badge.text)}
            <Text color={one.isError ? tone.bad : tone.text} bold={isLive} backgroundColor={ground}>
              {`  ${cut(one.detail || '—', Math.max(6, free))}`}
            </Text>
          </Text>
          <Text
            bold={one.isError}
            color={isLive ? tone.mark : one.isError ? tone.bad : tone.ok}
            backgroundColor={ground}
          >
            {ending}
          </Text>
        </Box>
      )
    }
    const activity = (
      <Box
        key="feed"
        flexDirection="column"
        width="100%"
        flexGrow={1}
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        {heading(
          parts,
          tone,
          'ACTIVITÉ',
          `${rows.length} ÉVÉNEMENT${rows.length > 1 ? 'S' : ''}`,
        )}
        {rows.length === 0 ? (
          <Text {...quiet(tone, tone.card)}>aucune activité pour le moment</Text>
        ) : (
          rows.slice(0, shown).map(event)
        )}
      </Box>
    )

    // ------------------------------------------- the person's notes and todo
    const field = (key: string, placeholder: string) =>
      Input !== undefined && (
        <Input key={key} placeholder={placeholder} submitLabel="ajouter" onSubmit={() => undefined} />
      )
    const comments = (
      <Box
        key="notes"
        flexDirection="column"
        width={half}
        minHeight={blockRows}
        flexShrink={0}
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        <Box flexDirection="row" width="100%" justifyContent="space-between">
          <Text {...quiet(tone, tone.card)}>{`COMMENTAIRES ›  ${kept.notes.length}`}</Text>
          {Input !== undefined && (
            <Button key="focus:note" plain hotkey="c" label="commenter" onPress={() => undefined} />
          )}
        </Box>
        {kept.notes.length === 0 && <Text {...quiet(tone, tone.card)}>aucun commentaire</Text>}
        {kept.notes.map(one => (
          <Box flexDirection="row" width="100%" columnGap={1}>
            <Box flexShrink={0}>
              <Text {...quiet(tone, tone.card)}>{stamp(one.at).slice(0, 5)}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={tone.text} backgroundColor={tone.card} wrap="wrap">
                {one.text}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Button key={`note:drop:${one.id}`} plain label="×" dimColor onPress={() => undefined} />
            </Box>
          </Box>
        ))}
        <Box flexGrow={1} />
        {field(`note:new:${kept.serial}`, 'ajouter un commentaire…')}
      </Box>
    )
    const chores = (
      <Box
        key="chores"
        flexDirection="column"
        width={half}
        minHeight={blockRows}
        flexShrink={0}
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        <Box flexDirection="row" width="100%" justifyContent="space-between">
          <Text {...quiet(tone, tone.card)}>
            {`MA TODO ›  ${kept.chores.length > 0 ? `${choresDone}/${kept.chores.length}` : '0'}`}
          </Text>
          {Input !== undefined && (
            <Box flexDirection="row" columnGap={2}>
              <Button key="focus:chore" plain hotkey="a" label="tâche" onPress={() => undefined} />
              <Button key="focus:link" plain hotkey="t" label="lien" onPress={() => undefined} />
            </Box>
          )}
        </Box>
        {kept.chores.length === 0 && <Text {...quiet(tone, tone.card)}>rien à faire de ton côté</Text>}
        {kept.chores.map(one =>
          one.href !== null && Link !== undefined ? (
            <Box flexDirection="row" width="100%" columnGap={1}>
              <Button
                key={`chore:toggle:${one.id}`}
                plain
                label={one.isDone ? MARK.completed : MARK.pending}
                dimColor={one.isDone}
                onPress={() => undefined}
              />
              <Link href={one.href} label={`${cut(one.text, Math.max(8, half - 10))} ↗`} />
            </Box>
          ) : (
            <Button
              key={`chore:toggle:${one.id}`}
              plain
              label={`${one.isDone ? MARK.completed : MARK.pending} ${cut(one.text, Math.max(8, half - 6))}`}
              dimColor={one.isDone}
              onPress={() => undefined}
            />
          ),
        )}
        {choresDone > 0 && (
          <Button key="chore:clear" plain label="retirer les terminées" dimColor onPress={() => undefined} />
        )}
        <Box flexGrow={1} />
        {field(`chore:new:${kept.serial}`, 'ajouter une tâche…')}
        {field(`chore:link:${kept.serial}`, 'coller un lien…')}
      </Box>
    )
    const desk = (
      <Box flexDirection={isWide ? 'row' : 'column'} width="100%" columnGap={1}>
        {comments}
        {chores}
      </Box>
    )

    const footer = legend(parts, tone, [
      ['a', 'Tâche'],
      ['t', 'Lien'],
      ['c', 'Commenter'],
      ...(design ? ([['m', 'Miniatures'], ['o', 'Maquette']] as const) : []),
      ['ctrl+x tab', 'Clavier'],
      ['esc', 'Rendre la main'],
      ...(mine === null ? [] : ([[`/${mine}`, 'Rouvrir']] as const)),
    ])

    return (
      <Box
        flexDirection="column"
        width="100%"
        minHeight={e.props.scroll.bodyRows}
        paddingX={1}
        backgroundColor={tone.panel}
      >
        {header}
        {brief}
        {cards}
        {book}
        {todoList}
        {activity}
        {desk}
        {style === 'pixel' && Raster !== undefined && tone.panel !== undefined && tone.text !== undefined && (
          <Raster
            key="pet"
            columns={room}
            rows={PET_ROWS}
            cells={petStrip(room, tone.panel, tone.text, mood)}
          />
        )}
        {style === 'png' && Image !== undefined && (
          <Box key="pet" flexDirection="row" width="100%" height={PNG_ROWS}>
            <Box width={stage.left} flexShrink={0} />
            <Image
              key="petimg"
              source={{ file: frameFile(), format: 'png' }}
              columns={PNG_COLUMNS}
              rows={PNG_ROWS}
              alt=" "
            />
          </Box>
        )}
        {(style === 'sprite' || style === 'big') && Raster !== undefined && tone.panel !== undefined && tone.text !== undefined && (
          <Raster
            key="pet"
            columns={room}
            rows={stripRows()}
            // The moods are clips here; only sleep and the context warning stay a character.
            cells={spriteStrip(room, tone.panel, tone.text, mood === "'" ? mood : '')}
          />
        )}
        {style === '3d' && Raster !== undefined && tone.panel !== undefined && tone.text !== undefined && (
          <Raster
            key="pet"
            columns={room}
            rows={CAT3_ROWS}
            cells={cat3Strip(room, tone.panel, tone.text, mood)}
          />
        )}
        {style === 'line' && (
          <Box key="pet" flexDirection="column" width="100%">
            {lineCat(room, state.isRunning, mood).map(row => (
              <Text color={tone.text} backgroundColor={tone.panel} wrap="truncate-end">
                {row}
              </Text>
            ))}
          </Box>
        )}
        {footer}
      </Box>
    )
  })

  // The mockups tab: every screen of the bound mockup as a thumbnail.
  on('ui.render', { component: 'Pane', requestId: GALLERY }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Raster is the terminal table's alone: ask the table, never the surface name.
    const Raster = 'Raster' in table ? table.Raster : undefined
    const room = Math.max(24, e.props.bodyColumns) - 2
    const tone = TONES[await read($, skin)]
    const bound: Feature | null = await read($, feature)
    const seen: Gallery = await read($, gallery)
    const parts: Elements = { Box, Text }
    const design = bound?.docs.find(one => one.kind === 'design')

    return (
      <Box
        flexDirection="column"
        width="100%"
        minHeight={e.props.scroll.bodyRows}
        paddingX={1}
        rowGap={1}
        backgroundColor={tone.panel}
      >
        <Box
          flexDirection="row"
          flexWrap="wrap"
          width="100%"
          justifyContent="space-between"
          columnGap={2}
          paddingRight={HEADER_CLEARANCE}
        >
          <Box flexDirection="row" columnGap={1}>
            {chip(parts, 'MAQUETTES', tone.liveBackground, tone.liveText)}
            <Text bold color={tone.text} backgroundColor={tone.panel} wrap="truncate-end">
              {cut(bound?.title ?? 'aucune feature liée', Math.max(10, room - 52))}
            </Text>
            {seen.status === 'ready' && (
              <Text {...quiet(tone, tone.panel)}>{`${seen.shots.length} écrans`}</Text>
            )}
          </Box>
          <Box flexDirection="row" columnGap={2}>
            {design && <Button key="design:open" plain hotkey="o" label="ouvrir ↗" onPress={() => undefined} />}
            <Button key="gallery:back" plain hotkey="b" label="retour" onPress={() => undefined} />
          </Box>
        </Box>

        {!design && (
          <Text {...quiet(tone, tone.panel)}>
            aucune maquette : lie une feature du Sacred Book avec spec &lt;feature&gt;
          </Text>
        )}
        {design && seen.status === 'loading' && (
          <Text {...quiet(tone, tone.panel)}>capture des écrans en cours…</Text>
        )}
        {design && seen.status === 'failed' && (
          <Text color={tone.bad} backgroundColor={tone.panel}>
            miniatures indisponibles (navigateur Chromium et ImageMagick requis) — « ouvrir ↗ » marche toujours
          </Text>
        )}

        <Box flexDirection="row" flexWrap="wrap" width="100%" columnGap={2} rowGap={1}>
          {seen.shots.map(one => (
            <Box key={`shot:${one.id}`} flexDirection="column" width={Math.max(one.columns, 19)} flexShrink={0}>
              {Raster !== undefined && (
                <Raster key={`thumb:${one.id}`} columns={one.columns} rows={one.rows} cells={one.cells} />
              )}
              <Text backgroundColor={tone.panel} wrap="truncate-end">
                <Text bold color={tone.mark} backgroundColor={tone.panel}>
                  {one.id}
                </Text>
                <Text {...quiet(tone, tone.panel)}>
                  {` ${cut(one.title, Math.max(8, Math.max(one.columns, 19) - one.id.length - 1))}`}
                </Text>
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexGrow={1} />
        {legend(parts, tone, [
          ...(design ? ([['o', 'Ouvrir la maquette']] as const) : []),
          ['b', 'Retour au focus'],
          ['ctrl+x tab', 'Clavier'],
          ['esc', 'Rendre la main'],
        ])}
      </Box>
    )
  })
}
