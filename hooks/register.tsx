import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ElementConstructor,
  EngineInterface,
  Register,
  SvgProps,
  TextProps,
  Timer,
  TurnUsage,
} from 'claude-code'

import type { AgentRow, AgentsView, Doc, Effort, Feature, FeedRow, Gallery, MainLoop, PetCoat, PetStyle, Focus, Skin, Todo, TurnState, Usage } from '../types'

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
const agents = atom({ plugin: 'focus-pane', key: 'agents' } as const, [])
const agentsView = atom({ plugin: 'focus-pane', key: 'agentsView' } as const, { isFolded: false, isDoneHidden: false })
const mainLoop = atom({ plugin: 'focus-pane', key: 'mainLoop' } as const, { model: null, effort: null })
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
const feature = atom({ plugin: 'focus-pane', key: 'feature' } as const, null)
const gallery = atom({ plugin: 'focus-pane', key: 'gallery' } as const, { status: 'idle', path: null, shots: [] })
const petStyle = atom({ plugin: 'focus-pane', key: 'petStyle' } as const, 'sprite')
const petCoat = atom({ plugin: 'focus-pane', key: 'petCoat' } as const, 'roux')
const skin = atom({ plugin: 'focus-pane', key: 'skin' } as const, 'dark')
const command = atom({ plugin: 'focus-pane', key: 'command' } as const, null)

/** How many tool calls the feed remembers. */
const FEED_KEPT = 60

/** How many headings a spec or plan card lists before it counts the rest. */
const OUTLINE_SHOWN = 6
const OUTLINE_LEAST = 2

/** The fewest todo rows kept when the pane is short, and the lines a brief may wrap to. */
const TODOS_LEAST = 4
/** The todo list at its leanest: the step in hand, and the row that counts the others. */
const TODOS_ONE = 2
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
    if (stage.isBao) baoBurst(bao.x + 7, BAO_GROUND - 9, 14, 0.7, SCENE.hurt)
    say('Aïe.', 2500)
  } else {
    play('sparkle', 3)
    // In the panda's world a finished todo is a sprout to go and eat.
    if (stage.isBao) baoPlant()
    else say('Une de moins !', 3000)
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

/** Which cat: its name under assets/cats/, in French or as people say it. */
const asPetCoat = (value: unknown): PetCoat | null =>
  value === 'roux' || value === 'orange' || value === 'tigre' || value === 'tigré'
    ? 'roux'
    : value === 'noir' || value === 'black'
      ? 'noir'
      : value === 'garfield'
        ? 'garfield'
        : value === 'panda'
          ? 'panda'
          : null

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
      // Light in six steps: a smooth shade would be a color a pixel.
      const lit = 0.42 + 0.7 * (Math.round(Math.max(0, (nx * lx + ny * ly + nz * lz) / n) * 6) / 6)
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
const stage = {
  columns: 0,
  ground: '',
  ink: '',
  mood: '',
  style: '' as PetStyle | '',
  coat: 'roux' as PetCoat,
  left: 0,
  root: '',
  /** True where the cat is one Svg, redrawn when what it does changes: the desktop. */
  isSvg: false,
  /** True while the panda is out on a terminal: it has a world of its own. */
  isBao: false,
}

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
    if (stage.isSvg) {
      // The picture animates itself: only a change of what the cat does, or of
      // what it says, is worth drawing again.
      stepSprite(SPRITE_TICK_MS, isWorking, stage.columns)
      stepScene(SPRITE_TICK_MS)
      const now = svgKey()
      if (now !== svgDrawn) {
        svgDrawn = now
        $.ui.invalidate('ui.render')
      }

      return
    }
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
    if (stage.isBao) {
      stepBao(SPRITE_TICK_MS, isWorking)
      stepScene(SPRITE_TICK_MS)
      void $.ui
        .blit({ requestId: PANE, key: 'pet', columns: stage.columns, rows: BAO_ROWS, cells: baoStrip(stage.columns) })
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

// <sprites> generated by scripts/build-sprites.py from the sheets under assets/cats/ — do not edit
const SHEETS = {
  roux: {
    small: {
      w: 32,
      h: 24,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x7a4524, 0xe8873a, 0xfbf3e6, 0xb65a22, 0xf28fa0, 0x2b1b16, 0xf6b56b, 0xc96f2c, 0xd8c7b0],
      clips: {
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
      },
    },
    big: {
      w: 64,
      h: 36,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x7a4524, 0xe8873a, 0xf28fa0, 0xb65a22, 0xfbf3e6, 0x2b1b16, 0xc96f2c, 0xf6b56b, 0xd8c7b0],
      clips: {
        walk: {
          ms: 110,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................aeeeea....................abdddbbddbbbbbbbaa....................aeeeea....................abbddbbbbbbbbbbbbaa..................aaeeea....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbdda..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbhagggga..................................abbbbbbghhhhhhhhhhhbbbbaagggga...................................aabbbbggaaaaaaaaaabbbbaagggga....................................abbbbgga........abbbbaagggga....................................abbbbgga........abbbbaaiiiia....................................aeeeeaa.........aeeeeaaiiiia....................................aiieeeea........aeeeeaaaaaaa....................................aiieeeea........aeeeea.aaaa......................................aaaaaa..........aaaa............................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba...........................aaaa.....................abbaaaaaabcaa.........................aaaaaa...................aaddaaaaaabbaaa.......................aeeeaa...................abdddbbddbbbbbbbaa.....................aeeeaa...................abbddbbbbbbbbbbbbaa...................aeeeea...................aabbddbbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbbba..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbaagggga..................................abbbbggghhhhhhhhhhhbbbbaagggga..................................abbbbggggaaaaaaaabbbbaa.agggga..................................abbbbiigga......abbbba..aaagga..................................abbbbiiiia......abbbba..aiiiiaa..................................aaeeeeiia......aeeeea...aaiiaaa..................................aeeeeaaa......aeeeea....aaaaaa..................................aeeeeaa.......aeeeea.....aaaa....................................aaaa..........aaaa..............................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba....................................................abba....abba............................aaaa....................abbaaaaaabcaa..........................aeeeaa..................abddbaddbbbbcba........................aeeeea..................abaddbbddbbbbbbaaa......................aeeeea..................abbddbbbbbbbbbbaaaa....................beeeaa..................abbbddbbbbbfffffbbbba...................bbbbaa..................abbbbbbbbbffffefbbbbaa.................abbbba...................abddbbbbbbffffefbbbbaa.................addbba..................addddbbbbbbffffffbbbbaaa................addddaa.....aaaaaaaaaaaaaadbbbbbbbbffffffbbbbaa..................addbaaaaaaaaaaaaaaaaaaaadabbbbbbbbbffffbbbbba....................aaabbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa......................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbba........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbbbhhhhhhhhhhbbbbbbbagggga..................................abbbbaabhhhhhhhhhbbbbaaaaggggaa.................................abbbbaaggggaaaaaabbbba...aagggga................................abbbbaaiiiia...aabbbba....agggga................................aeeeeaaiiiia..aeeeeaa.....aiiiia................................aeeeeaaaaaaa..aeeeea......aaaiiaa...............................aeeeea.aaaa...aeeeea.......aaiiiia...............................aaaa..........aaaa..........aaaa..................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba...........................aaaa.....................abbaaaaaabcaa.........................aaaaaa...................aaddaaaaaabbaaa.......................aeeeaa...................abdddbbddbbbbbbbaa.....................aeeeaa...................abbddbbbbbbbbbbbbaa...................aeeeea...................aabbddbbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbbba..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbaahhhhhhhhhhhhbbaaaagggga.................................aabbbbaaghhhhhhhhhbbbbaaaagggga................................aaabbaa.aggggaaaaaabbbba..agggga................................abbbba..aaagga....abbbba..agggga................................abbbba..aiiiiaa...aeeeea..aggggaa...............................aeeeea...aaiiaaa..aeeeea...aaiiaaa..............................aeeeea....aaaaaa..aaaaaa....aiiiia..............................aeeeea.....aaaa....aaaa.....aiiiia...............................aaaa........................aaaa....................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................aeeeea....................abdddbbddbbbbbbbaa....................aeeeea....................abbddbbbbbbbbbbbbaa..................aaeeea....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbdda..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga.................................aabbaaaahhhhhhhhhhhhbbbbhagggga................................abbbbaaaaahhhhhhhhhhhbbbbaagggga................................abbbba...aaggggaaaaaabbbbaagggga................................abbbba....agggga....abbbbaagggga...............................aabbbba....agggga....aeeeeaagggga..............................aaaeeaa.....aiiiiaa...aeeeeaaiiiia..............................aeeeea.......aaiiiia..aaaaaaaiiiia..............................aeeeea........aiiiia...aaaa.aiiiia...............................aaaa..........aaaa..........aaaa......................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.........................aaaa.......................abbaaaaaabcaa.......................aaaaaa.....................aaddaaaaaabbaaa.....................aeeeaa.....................abdddbbddbbbbbbbaa...................aeeeaa.....................abbddbbbbbbbbbbbbaa.................aeeeea.....................aabbddbbbbbbbbbbbbaaa.................aabbba....................abbbbbbbbbbfffffbbbbba................aabbba....................abddbbbbbbffffefbbbbba.................abdaaa..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aadbbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga.................................aabbaaaahhhhhhhhhhhhbbbbgagggga................................abbbbaaaaghhhhhhhhhhhbbbbaagggga................................abbbba..aggggaaaaaaaabbbbggggaa.................................abbbba..agggga......aaabbgggga..................................aeeeea..aggggaa.....aeeeegggga..................................aeeeea...aaiiaaa.....aaeeeeiia..................................aaaaaa....aiiiia......aaaeeiia...................................aaaa.....aiiiia.......aaeeiia.............................................aaaa..........aaaa........................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba....................................................abba....abba........................aaaa........................abbaaaaaabcaa......................aeeeaa......................abddbaddbbbbcba....................aeeeea......................abaddbbddbbbbbbaaa..................aeeeea......................abbddbbbbbbbbbbaaaa................aaeeeba.....................abbbddbbbbbfffffbbbba................aebbba.....................abbbbbbbbbffffefbbbbaa................bbbbaa....................abddbbbbbbffffefbbbbaa................aadddda..................addddbbbbbbffffffbbbbaaa................addddaa.....aaaaaaaaaaaaaadbbbbbbbbffffffbbbbaa..................addbaaaaaaaaaaaaaaaaaaaadabbbbbbbbbffffbbbbba....................aaabbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa......................aadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbba........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbgaaa..................................abbbbbbhhhhhhhhhhhhbbbbbgggaa...................................abbbbaabhhhhhhhhhhhbbbbgggga....................................abbbbaaggggaaaaaaaaaabbbbgga....................................aeeeeaagggga........abbbbgga....................................aeeeeaaiiiia........aeeeeaa.....................................aaaaaaaiiiia........aeeeeaa......................................aaaa.aiiiia........aeeeeeea...........................................aaaa..........aaaaaa........................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.........................aaaa.......................abbaaaaaabcaa.......................aaaaaa.....................aaddaaaaaabbaaa.....................aeeeaa.....................abdddbbddbbbbbbbaa...................aeeeaa.....................abbddbbbbbbbbbbbbaa.................aeeeea.....................aabbddbbbbbbbbbbbbaaa.................aabbba....................abbbbbbbbbbfffffbbbbba................aabbba....................abddbbbbbbffffefbbbbba.................abdaaa..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aadbbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbgaggaaa..................................abbbbaaghhhhhhhhhhhbbbbggggaa...................................abbbbaaggaaaaaaaaaabbbbgggga....................................aaabbgggga........abbbbiigga....................................aeeeegggga........abbbbiiiia.....................................aaeeeeiia.........aaeeeeiia......................................aaaeeiia..........aeeeeaaa.......................................aaeeiia..........aeeeeaa..........................................aaaa............aaaa..........................',
          ],
        },
        run: {
          ms: 75,
          frames: [
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................aaa.....aaa.....................aaaaa..........................aaaa....aaaaa....................aeeeea........................abddbaaaabbcbba...................aeeeea........................abddbbddbbbbbbaa..................aeeeea.......................abaddbbddbbbbbbaaa.................aaeeba......................aabbddbbbbbfffffbbba.................abbbba......................abbddbbbbffffefbbbba................abbbaaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................aaddddbaaadbbbdddbdddbbbdddbddbbbbbbffffffbbbbcca................adddbbbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbca..................adbbbbdddbbbddbbddbbbbddbbbbbbbbbbbffffbbbbbca...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbbbbbbbbaaa....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaaaa........................abbbbbbbbbbbbbbbbbbbbbbbbbbbgaaaaaaaa...........................abbbbaahhhhhhhhhhhhhhbbbbgggga.................................aabbaaa.aaaagghhhhaaaaaabbbbgga................................abbbbaa.....aggggaaaa...abbbbaa.................................abbbba......aggggaa.....abbbbaa................................aaeeaaa.......aagggga...aaiibbbba..............................aeeeeaa.........agggga..aiiiibbbba..............................aeeeea..........aiiiia..aiiiieeeea...............................aaaa...........aaaiiaa..aaaaaaeeaa..............................................aaiiiia.....aaeeeea...............................................aaaa........aaaa......................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a........................a.............................dba.....bba......................aaaa..........................abba....abbaa....................aaaaaa........................aaddaaaaaabcaaa...................aeeeea........................abddbbddbbbbbbba..................aeeeea.......................abaddbbddbbbbbbbba.................aeeeea......................aabbddbbbbbbbbbbbbaa................aaebbba......................abbddbbbbbfffffbbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................bbbdaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbffffefbbbbaa.................aaaddbbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbaaa.................aadbbbdddbbbddbbddbbbbddbbbbbbbbbbffffffbbbbaa...................adbbbddbbbbddbbddbbbbddbbbbbbbbbbbffffbbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbgbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbgggaaaaaa............................aabbbbbbhhhhhhhhhhbbbbbbaagggga................................aaabbaaaabbbbhhhhhhaabbbbbbggaa.................................abbbba..aggggaaaaaa.abbbbgggga..................................abbbba..agggga......abbbbgggga..................................aeeeea..agggga......abbbbiiiia..................................aeeeea..agggga......abbbbiiiia..................................aeeeea..aggggaa.....abbbbiiiia...................................aaaa....aaiiaaa.....aaeeeeaa.............................................aiiiia......aeeeea..............................................aiiiia......aeeeea...............................................aaaa........aaaa..........................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a......................................................dba.....bba......................aaa...........................abba....abbaa....................aaaaa.........................aaddaaaaaabcaaa...................aeeeea........................abddbbddbbbbbbba..................aeeeea.......................abaddbbddbbbbbbbba.................aeeeea......................aabbddbbbbbbbbbbbbaa................aaeebba......................abbddbbbbbfffffbbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................bbbbaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbffffefbbbbaa.................aaadddbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbaaa.................aadbbbdddbbbddbbddbbbbddbbbbbbbbbbffffffbbbbaa...................adbbbddbbbbddbbddbbbbddbbbbbbbbbbbffffbbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbgbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbaabgggaaaaaa.............................abbbbhhhhbbhhhhhhhhbbbbaagggga..................................abbbbbbbbaahhhhhhbbbbaa.agggga..................................abbbbgggga.aaaaaabbbba..agggga..................................abbbbgggga......abbbba..agggga..................................abbbbgggga......abbbba..aggggaa..................................aaeeeegga......abbbba...aaiiiia..................................aeeeegga......abbbba....aiiiia..................................aeeeeiia......aeeeea....aiiiia...................................aaiiiia......aeeeea.....aaaa.....................................aiiiia......aeeeea...............................................aaaa........aaaa..............................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a........................a.............................aaa.....aaa......................aaaa..........................aaaa....aaaaa....................aeeeea........................abddbaaaabbcbba...................aeeeea........................abddbbddbbbbbbaa..................aeeeea.......................abaddbbddbbbbbbaaa.................aaeeeb......................aabbddbbbbbfffffbbba................aaebbba......................abbddbbbbffffefbbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................aaddddaaaadbbbdddbdddbbbdddbddbbbbbbffffffbbbbcca................addddbbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbca..................addbbbdddbbbddbbddbbbbddbbbbbbbbbbbffffbbbbbca...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbbbbbbbbaaa....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa.......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbgbbaaaaaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbgggaaaaaa.............................abbbbhhhhhhhhhhhhbbbbhhaaggggaa..................................aabbbbggaaaaaahhbbaaaa..aagggga..................................abbbbaa..aaaabbbbaa.....agggga..................................abbbbaa.....abbbba......aggggaa................................aaiibbbba...aaeeaaa.......aagggga..............................aiiiibbbba..aeeeeaa.........agggga..............................aiiiieeeea..aeeeea..........aiiiia...............................aaaaaaeeaa..aaaa...........aaaiiaa..................................aaeeeea.................aaiiiia...................................aaaa....................aaaa................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................dba.....bba.....................aaeea..........................abba....abbaa....................aaeeaa........................aaddaaaaaabcaaa...................aeeeea........................abddbbddbbbbbbba..................aeeeea.......................abaddbbddbbbbbbbba.................aeeeaa......................aabbddbbbbbbbbbbbbaa.................abbbba......................abbddbbbbbfffffbbbba................abbbdaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................aaddaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbffffefbbbbaa.................aaaabbbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbaaa.................aabbbbdddbbbddbbddbbbbddbbbbbbbbbbffffffbbbbaa...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbffffbbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbgbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbaabgggaaaaaa.............................abbbbhhhhbbhhhhhhhhbbbbaagggga..................................abbbbbbbbaahhhhhhbbbbaa.agggga..................................abbbbgggga.aaaaaabbbba..agggga..................................abbbbgggga......abbbba..agggga..................................abbbbiiiia......aeeeea..agggga..................................abbbbiiiia......aeeeea..agggga..................................abbbbiiiia......aeeeea..aggggaa..................................aaeeeeaa........aaaa....aaiiaaa..................................aeeeea..................aiiiia..................................aeeeea..................aiiiia...................................aaaa....................aaaa....................',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa.............................a.......a.......................aeea...........................dba.....bba.....................aaeeaa.........................abba....abbaa....................aaeeaa........................aaddaaaaaabcaaa...................aeeeea........................abddbbddbbbbbbba..................aeeeea.......................abaddbbddbbbbbbbba.................aebbaaa.....................aabbddbbbbbbbbbbbbaa.................abbbba......................abbddbbbbbfffffbbbba.................abddaaa....aaaaaaaaaaaaaaaaabbbbbbbbffffefbbbbaa................aaddaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbffffefbbbbaa.................aaabbbbdddbbbdddbdddbbbddddddbbbbbbffffffbbbbaaa.................aabbbbdddbbbddbbddbbbbddbbbbbbbbbbffffffbbbbaa...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbffffbbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbgbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbgggaaaaaa............................aabbbbbbhhhhhhhhhhbbbbbbaagggga................................aaabbaaaabbbbhhhhhhaabbbbbbggaa.................................abbbba..aggggaaaaaa.abbbbgggga..................................abbbba..agggga......abbbbgggga..................................abbbba..aggggaa.....abbbbgggga..................................abbbba...aaiiiia.....aaeeeegga..................................abbbba....aiiiia......aeeeegga..................................aeeeea....aiiiia......aeeeeiia..................................aeeeea.....aaaa........aaiiiia..................................aeeeea..................aiiiia...................................aaaa....................aaaa........................',
          ],
        },
        turn: {
          ms: 100,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................aeeeea....................abdddbbddbbbbbbbaa....................aeeeea....................abbddbbbbbbbbbbbbaa..................aaeeea....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbdda..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbhagggga..................................abbbbaaghhhhhhhhhhhbbbbaagggga..................................abbbbaaggggaaaaaaaabbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
            '....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba...........................aaaa.................abbaaaaaaaaabbba..........................aaaaaa...............aaccaaaaaaaaabccaa.........................aeeaaa..............abcbbbbbddbbbbbbbcba.......................aaeeaa...............abbbbbbbbbbbbbbbbbba.......................aaeea...............aabbbbbbbbbbbbbbbbbbaa......................abbba..............abbbbbfffffbbbbbfffffbba.....................abbbaa.............abbbbffffefbbbbffffefbba.....................abbbaa.............abbbbffffefbbbbffffefbba.....................aaddddaaa..aaaaaaaaabbbbffffffbbbbffffffaaa......................addbbddaaaaddabbbdddbbbffffffbbbbffffffaa........................adbbddaaaaddabbbdddbbbbffffbbbbbbffffba..........................abbddbbbbddbbbbddbbdbbbbbbbccccbbaaaa...........................abbddbbbbddbbbbddbbddbbbbbbbcccbbaaa...........................aabbbbbbbbbbbbbbbbbbddbbbbbabbaaaaa.............................aabbbbbbbbbbbbbbbbbbbbbbbbaaaa...................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbga......................................abbbbhhhhhhhhhhhhbbbbhggga......................................abbbbggghhhhhhhhhbbbbgggga......................................abbbbggggaaaaaaaabbbbgggga......................................abbbbgggga......abbbbgggga......................................abbbbgggga......abbbbgggga......................................aeeeeiiiia......aeeeeiiiia......................................aeeeeiiiia......aeeeeiiiia......................................aeeeeiiiia......aeeeeiiiia.......................................aaaaaaaa........aaaaaaaa........................',
            '................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba...................................aaaa.........abbaaaaaaaaabbba..................................aaaaaa.......aaccaaaaaaaaabccaa.................................aeeaaa......abcbbbbbddbbbbbbbcba...............................aaeeaa.......abbbbbbbbbbbbbbbbbba...............................aaeea.......aabbbbbbbbbbbbbbbbbbaa..............................abbba......abbbbbfffffbbbbbfffffbba.............................abbbaa.....abbbbffffefbbbbffffefbba.............................abbbaa.....abbbbffffefbbbbffffefbba.............................aaddddaaa.aabbbbffffffbbbbffffffaaa..............................addbbddaabbdbbbffffffbbbbffffffaa................................adbbddaabbddbbbffffbbbbbbffffba..................................abbddbbbbddbbbbbbbbccccbbaaaa...................................abbddbbbbddbbbbbbbbbccbbbaaa...................................aabbbbbbbbbbbbbbddbbbbbbaaa.....................................aabbbbbbbbbbbbbbbbbbbbaa.........................................abbbbbbbbbbbbbbbbbbbba..........................................abbbbbbbbbbbbbbbbbbba...........................................abbbbhhhhhhbbbbhhhga............................................abbbbgghhhhbbbbgggga............................................abbbbggggaabbbbgggga............................................abbbbggggaabbbbgggga............................................abbbbggggaabbbbgggga............................................aeeeeiiiiaaeeeeiiiia............................................aeeeeiiiiaaeeeeiiiia............................................aeeeeiiiiaaeeeeiiiia.............................................aaaaaaaa..aaaaaaaa..........................',
            '............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba..........................................aaaa..abbaaaaaaaaabbba.........................................aaaaaaaaccaaaaaaaaabccaa........................................aeeeeabcbbbbbddbbbbbbbcba......................................aeeeeaabbbbbbbbbbbbbbbbbba......................................aeeeaaabbbbbbbbbbbbbbbbbbaa.....................................abbbabbbbbfffffbbbbbfffffbba....................................abbbbbbbbffffefbbbbffffefbba....................................abbbabbbbffffefbbbbffffefbba....................................aaaddbbbbffffffbbbbffffffaaa.....................................aadbbbbbffffffbbbbffffffaa.......................................abbbbbbbffffbbbbbbffffba.........................................abbbdbbbbbbbccccbbaaaa..........................................abbbddbbbbbbbccbbbaaa..........................................abbbbddbbbbbbbbbbbba............................................abbbbbbbbbbbbbbbbbba...........................................aagbbbbbbbbbbbbbbbbg...........................................aaaggbbbbbbbbbbbbbbgga..........................................aggggbbbbhhhhbbbbhggga..........................................aggggbbbbhhhhbbbbgggga..........................................aggggbbbbaaaabbbbgggga..........................................aggggbbbba..abbbbgggga..........................................aggggbbbba..abbbbgggga..........................................aiiiieeeea..aeeeeiiiia..........................................aiiiieeeea..aeeeeiiiia..........................................aiiiieeeea..aeeeeiiiia...........................................aaaaaaaa....aaaaaaaa........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba........................................abbccbbbbbbdbbdbbbbbbccba......................................aaebbbbbbbbbbbbbbbbbbbbbba......................................aabbbbbbbbbbbbbbbbbbbbbbbba....................................aeebbbbbfffffbbbbbfffffbbbba....................................aeebbbbffffefbbbbffffefbbbba....................................aeebbbbffffefbbbbffffefbbbba....................................abbddbbffffffbbbbffffffbbaaa....................................abbbbbbffffffbbbbffffffbbaa.....................................abbddbbbffffbbbbbbffffbbba.......................................aadddbbbbbbbccccbbbbbbaa........................................aaddbbbbbbbbbccbbbbbbaa..........................................abbbbbbbbhbbbbbbhbbbba...........................................aabbbbbbhhhhhhbbbbbba.............................................aabbbbhhhhhhbbbbbba...........................................aaaabbbbbhhhhhbbbbbbaaaa.......................................aggggbbbbbbhhhhbbbbbagggga......................................aggggbbbbbbbbbbbbbbaagggga......................................aggggbbbbbbbbbbbbbbaagggga......................................aggggbbbbaaaaaabbbbaagggga......................................aggggbbbba.aaaabbbbaagggga......................................aiiiieeeea....aeeeeaaiiiia......................................aiiiieeeea....aeeeeaaiiiia......................................aiiiieeeea....aeeeeaaiiiia.......................................aaaaaaaa......aaaa..aaaa....................',
          ],
        },
        sit: {
          ms: 180,
          frames: [
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbfffffbbbbbfffffbbbba......................................abbbbffffefbbbbffffefbbbba......................................abbbbffffefbbbbffffefbbbba......................................aaabbffffffbbbbffffffbbaaa.......................................aabbffffffbbbbffffffbbaa.........................................abbbffffbbbbbbffffbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa........aaa..................................aabbbbhbbbbbbhbbbbaa......aaaaa................................addbbbbhhhhhhhhbbbbdda.....aaeeea...............................addbbbhhhhhhhhhhbbbdda......aeeeea..............................abbbbbbhhhhhhbbbbbbbba.......aeeea..............................abbbbbbhhhhhhbbbbbbbba.......dbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....abbbba............................aaabbbbbbbhhhhhbbbbbbbbaaa...aaddbba...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdaabdddaaa...........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbddaa.............................abbbbeeeebbbbbbeeeebbbbbbddabbbdaa...............................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaaa..................................aaaeeeeaaaaaaeeeeaaaaaaaaaaa.......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbfffffbbbbbfffffbbbba......................................abbbbffffefbbbbffffefbbbba......................................abbbbffffefbbbbffffefbbbba......................................aaabbffffffbbbbffffffbbaaa.......................................aabbffffffbbbbffffffbbaa.........................................abbbffffbbbbbbffffbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba...........aa.............................abbbbbbhhhhhhbbbbbbbba..........aeea...........................aabbbbbbhhhhhhbbbbbbbbaa........aaeeaa.........................aaabbbbbbbhhhhhbbbbbbbbaaa.....aaaaeea.........................aabbbbbbbbbbbhhbbbbbbbbbbbbaaaaabbeeaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbddabbbeeaa...........................abbbbeeeebbbbbbeeeebbbbbbbbddabbbaaa.............................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaaaaa................................aaaeeeeaaaaaaeeeeaaaaaaaaaaaa......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbfffffbbbbbfffffbbbba......................................abbbbffffefbbbbffffefbbbba......................................abbbbffffefbbbbffffefbbbba......................................aaabbffffffbbbbffffffbbaaa.......................................aabbffffffbbbbffffffbbaa.........................................abbbffffbbbbbbffffbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba..........................................abbbbbbhhhhhhbbbbbbbba.........................................aabbbbbbhhhhhhbbbbbbbbaa.......................................aaabbbbbbbhhhhhbbbbbbbbaaa.....................................aabbbbbbbbbbbhhbbbbbbbbbbbbdaaaaaaaaaaa.........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbeeeeeeaa.........................abbbbeeeebbbbbbeeeebbbbbbddabbbeeeeeeaa..........................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaaaaaaaaaa...........................aaaeeeeaaaaaaeeeeaaaaaaaaaaaaaaaaaaa...............................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................aaabbabbbbabbbbabbbbabbaaa.......................................aabbbaaaabbbbbbaaaabbbaa.........................................abbbbbbbbbbbbbbbbbbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba...........aa.............................abbbbbbhhhhhhbbbbbbbba..........aeea...........................aabbbbbbhhhhhhbbbbbbbbaa........aaeeaa.........................aaabbbbbbbhhhhhbbbbbbbbaaa.....aaaaeea.........................aabbbbbbbbbbbhhbbbbbbbbbbbbaaaaabbeeaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbddabbbeeaa...........................abbbbeeeebbbbbbeeeebbbbbbbbddabbbaaa.............................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaaaaa................................aaaeeeeaaaaaaeeeeaaaaaaaaaaaa......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbfffffbbbbbfffffbbbba......................................abbbbffffefbbbbffffefbbbba......................................abbbbffffefbbbbffffefbbbba......................................aaabbffffffbbbbffffffbbaaa.......................................aabbffffffbbbbffffffbbaa.........................................abbbffffbbbbbbffffbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa........aaa..................................aabbbbhbbbbbbhbbbbaa......aaaaa................................addbbbbhhhhhhhhbbbbdda.....aaeeea...............................addbbbhhhhhhhhhhbbbdda......aeeeea..............................abbbbbbhhhhhhbbbbbbbba.......aeeea..............................abbbbbbhhhhhhbbbbbbbba.......dbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....abbbba............................aaabbbbbbbhhhhhbbbbbbbbaaa...aaddbba...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdaabdddaaa...........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbddaa.............................abbbbeeeebbbbbbeeeebbbbbbddabbbdaa...............................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaaa..................................aaaeeeeaaaaaaeeeeaaaaaaaaaaa.......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbfffffbbbbbfffffbbbba......................................abbbbffffefbbbbffffefbbbba......................................abbbbffffefbbbbffffefbbbba......................................aaabbffffffbbbbffffffbbaaa.......................................aabbffffffbbbbffffffbbaa.........................................abbbffffbbbbbbffffbbba...........................................aabbbbbbccccbbbbbbaa......a......................................aabbbbbbccbbbbbbaa......aaaaa..................................aabbbbhbbbbbbhbbbbaa....aaaaaaa................................addbbbbhhhhhhhhbbbbdda...aaaaeeea...............................addbbbhhhhhhhhhhbbbdda....aaaeeea...............................abbbbbbhhhhhhbbbbbbbba......abbaaa..............................abbbbbbhhhhhhbbbbbbbba......abbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....adbdda............................aaabbbbbbbhhhhhbbbbbbbbaaa..aaadddda...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdadbbbaaa............................aabbbbbbbbbbbbbbbbbbbbbbbbbdddbbbba..............................abbbbeeeebbbbbbeeeebbbbbbbddddbaa................................aaaaeeeeaaaaaaeeeeaaaaaaaaaaaa...................................aaaeeeeaaaaaaeeeeaaaaaaaaaaa.......................................aaaa......aaaa..........................',
          ],
        },
        sleep: {
          ms: 500,
          frames: [
            '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaabba.........bb...............................aaaaabbbbddabddabbbbbaaaaaaaa.abba............................aaaaaaaabbbddbbddbbbbbcaaaaaaaaaacba..........................aabdddbddbbbbddbbddbbbbcbbbdbbdbbbbbcba........................aabbddbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.......................aaabbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................addbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbeeeea.......................adbbbdddbbbbbbbbbbeeeeeeebbbbbbbbbbbeeeea........................aaaaaddabbbddabbbeeaaaaaaaaaaaaaaaaeeeea..........................aaaddabbbddabbbeeaaaaaa.aaaaaaaaaeeeea............................aaaaaaaaaaaaaaa................aaaa............',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa.................................................aaaaaaaaaaaaaaaaaaaa.........................................aaabdddbbbddbbddbbbbbbaaaa......bb............................aaddabddbbbbddbbddbbbbbbbbbbaaaa.abba..........................aaaddbbddbbbbbbbbbbbbbbbcbbabaaaaaacba.........................abbbddbbbbbbbbbbbbbbbbbbcbbbdbbdbbbbbcba.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abddbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbeeeea.......................adbbbdddbbbbbbbbbbeeeeeeebbbbbbbbbbbeeeea........................aaaaaddabbbddabbbeeaaaaaaaaaaaaaaaaeeeea..........................aaaddabbbddabbbeeaaaaa..aaaaaaaaaeeeea............................aaaaaaaaaaaaaaa................aaaa............',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa.................................................aaaaaaaaaaaaaaaaaaaa.........................................aaabdddbbbddbbddbbbbbbaaaa......bb............................aaddabddbbbbddbbddbbbbbbbbbbaaaa.abba..........................aaaddbbddbbbbbbbbbbbbbbbcbbabaaaaaacba.........................abbbddbbbbbbbbbbbbbbbbbbcbbbdbbdbbbbbcba.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abddbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbeeeea.......................adbbbdddbbbbbbbbbbeeeeeeebbbbbbbbbbbeeeea........................aaaaaddabbbddabbbeeaaaaaaaaaaaaaaaaeeeea..........................aaaddabbbddabbbeeaaaaa..aaaaaaaaaeeeea............................aaaaaaaaaaaaaaa................aaaa............',
            '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaabba.........bb...............................aaaaabbbbddabddabbbbbaaaaaaaa.abba............................aaaaaaaabbbddbbddbbbbbcaaaaaaaaaacba..........................aabdddbddbbbbddbbddbbbbcbbbdbbdbbbbbcba........................aabbddbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.......................aaabbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................addbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbeeeea.......................adbbbdddbbbbbbbbbbeeeeeeebbbbbbbbbbbeeeea........................aaaaaddabbbddabbbeeaaaaaaaaaaaaaaaaeeeea..........................aaaddabbbddabbbeeaaaaaa.aaaaaaaaaeeeea............................aaaaaaaaaaaaaaa................aaaa............',
          ],
        },
        happy: {
          ms: 120,
          frames: [
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.............................a........................aaa.....aaa...........................aaa......................aaaa....aaaaa.........................aeeaa....................abddbaaaabbcbba.......................aaeeaa....................abddbbddbbbbbbaa.....................aaaeea....................abaddbbddbbbbbbaaa....................aeeeea...................aabbddbbbbbbbbbbbbba...................abbbba....................abbddbbbbbbbbbbbbbba..................abbbba...................aabbbbbbbbbbaabbbbbbaa.................adddda...................abddbbbbbbbabbabbbbbcca................addddaa.................aaaddbbbbbbabbbbabbbbca..................addbaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbca...................aaabbdddbbbdddbbbdddbddddbbbbbbbbbbbbbbbbaaa.....................aabddddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa.......................adbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbbaa........................abbddbbbbddbbbbddbbddbbbbbbaaaaaaaaaaa.........................aabbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga.................................aabbbbbbbbbbbbbbbbbbbbbbbbgggga................................aaabbaabhhhhhhhhhhhhhbbbbaagggga................................abbbbaaggggaaaaaaaaaabbbbaagggga................................abbbbaagggga........abbbbaagggga................................aeeeeaaiiiia........aeeeeaaiiiiaa...............................aeeeeaaiiiia.........aaeeeeaaiiiia..............................aeeeeaaiiiia..........aeeeeaaiiiia...............................aaaa..aaaa............aaaa..aaaa....................',
            '.......................................................................................................................................................................................................................................a.......a......................................................aaa.....aaa....................................................aaaa....aaaaa.......................aaa........................abddbaaaabbcbba.....................aaeea.......................abddbbddbbbbbbaa....................aaeeaa.....................abaddbbddbbbbbbaaa...................aeeea.....................aabbddbbbbbbbbbbbbba.................aeeeea......................abbddbbbbbbbbbbbbbba................aeeeba.....................aabbbbbbbbbbaabbbbbbaa................aabbba....................abddbbbbbbbabbabbbbbcca...............aabbba...................aaaddbbbbbbabbbbabbbbca.................addaaa....aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbca.................aaaddbaaadbbbdddbbbdddbddddbbbbbbbbbbbbbbbbaaa...................aabbbbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa.....................abbbbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbaa.......................aabbddbbbbddbbbbddbbddbbbbbbaaaaaaaaaaa.........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga.................................aabbbbbbbbbbbbbbbbbbbbbbbbgggga................................aaabbaabhhhhhhhhhhhhhbbbbaaggggaa...............................abbbbaaggggaaaaaaaaaaaabbbbaagggga..............................abbbbaagggga..........abbbbaagggga.............................aabbbbaagggga..........aeeeeaaiiiia............................aeeeeaaiiiiaa...........aaaeeaaaaiiaa...........................aeeeeaaiiiia.............aaeeeeaaiiiia..........................aeeeeaaiiiia...............aaaa..aaaa............................aaaa..aaaa............................................................................................................................................................................................................................................................................................................................................................................',
            '...............................................................................................................a......................................................aa......aaa....................................................abba....abba..............................aaaa..................abbaaaaaabcaa...........................aaaaaaa................aaddaaaaaabbaaa.........................beeeeeaa...............abdddbbddbbbbbbbaa......................abeeeeea................abbddbbbbbbbbbbbbaa....................aabbeeaa................aabbddbbbbbbbbbbbbaaa...................adbbaa..................abbbbbbbbbbbbbbbbbbbba..................adbbaa..................abddbbbbbbbbbbbbbbbbba.................adddda..................aaaddbbbbbbbbaabbbbbbba.................adddba......aaaaaaaaaaaaaabbbbbbbbbbabbabbbbbaaa................adbbbaaaaaaaaddabbbddabddaabbbbbbbbabbbbabbbbaa..................dbbbaaaaaaaaddabbbddabddabbbbbbbbbbbbbbbbbbaa....................abadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaaaa.....................aabbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaaa......................abbbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbbbhhhhhhhhhhhhbbbbbbaaiiaa.................................abbbbaaahhhhhhhhhhhbabbbbaaiiiiaa................................aabbbbaaggggaaaaaaaaeeeea.aaiiaaa................................aeeeeaaiiiia......aaaeeaa..aaaa.................................aeeeeaaiiiiaa......aaeeeea.......................................aaeeeeaaiiaaa.......aaaa..........................................aaaa..aaaa....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.............................aaaaa..................abbaaaaaabcaa..........................aaaaaaaa................aaddaaaaaabbaaa........................aeeeeaaaa...............abdddbbddbbbbbbbaa.....................aaeeeeaaa................abbddbbbbbbbbbbbbaa....................aabbaaa.................aabbddbbbbbbbbbbbbaaa...................adbbaa..................abbbbbbbbbbbbbbbbbbbba.................adddda...................abddbbbbbbbbbbbbbbbbba.................adddda..................aaaddbbbbbbbbaabbbbbbba.................aaabbbd.....aaaaaaaaaaaaaabbbbbbbbbbabbabbbbbaaa.................aabbbbaaaaaaddabbbddabddaabbbbbbbbabbbbabbbbaa...................abbddaaaaaaddabbbddabddabbbbbbbbbbbbbbbbbbaa.....................aadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbhagggga.................................aabbbbaaghhhhhhhhhhhbbbbaagggga................................aaabbaaaaggaaaaaaaaaabbbbaagggga................................abbbbaagggga........abbbbaagggga................................abbbbaagggga........abbbbaaggggaa...............................aeeeeaaiiiia.........aaeeeeaaiiaaa..............................aeeeeaaiiiia..........aeeeeaaiiiia..............................aeeeeaaiiiia..........aeeeeaaiiiia...............................aaaa..aaaa............aaaa..aaaa....................',
          ],
        },
        alert: {
          ms: 130,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................aeeeea....................abdddbbddbbbbbbbaa....................aeeeea....................abbddbbbbbbbbbbbbaa..................aaeeea....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbfffffbbbbba.................abbbba...................abddbbbbbbffffefbbbbba.................abbdda..................aaaddbbbbbbffffefbbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbffffffbbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbffffffbbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbffffbbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbga...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbggga..................................abbbbhhhhhhhhhhhhhhbbbbhagggga..................................abbbbaaghhhhhhhhhhhbbbbaagggga..................................abbbbaaggggaaaaaaaabbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
            '...............................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...............................a....................abba....abba...........................aaaaaa...................abbaaaaaabcaa.........................aaaaaaaa.................aaddaaaaaabbaaa........................aeeeeea.................abdddbbddbbbbbbbaa.....................aaeeeeea.................abbddbbbbbbbbbbbbaa....................aaeeeeea...a..a.a..a..a.aabbddbbbbbbbbbbbbaaa...................aaeeeeedaaabaababaabaabdbbbbbbbbbbbfffffbbbbba..................aaeeebddababdabbbbabbabbbbddbbbbbbffffefbbbbba...................abbbbddabbbddabbbaaabddddddbbbbbbffffefbbbbba...................abbbbddbbbbdddbbbdddbdddbbbbbbbbbffffffbbbbaaa..................abdddddbbbbddbbbbddbbddbbbbbbbbbbffffffbbbbaa...................adddbbbbbbbddbbbbddbbddbbbbbbbbbbbffffbbbbaa.....................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbba.....................................abbbbbbbbbbbbbbbbbbbbbbbbgaa...................................abbbbbbbbbbbbbbbbbbbbbbbbggaaa..................................abbbbhhhhhhhhhhhhhhbbbbaagggga..................................abbbbaagghhhhhhhhhhbbbbaagggga..................................abbbbaaggggaaaaaaaabbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................................................................................................................................................................................................................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...............................a....................abba....abba...........................aaaaaa...................abbaaaaaabcaa.........................aaaaaaaa.................aaddaaaaaabbaaa........................aeeeeea.................abdddbbddbbbbbbbaa.....................aaeeeeea.................abbddbbbbbbbbbbbbaa....................aaeeeeea...a..a.a..a..a.aabbddbbbbbbbbbbbbaaa...................aaeeeeedaaabaababaabaabdbbbbbbbbbbbfffffbbbbba..................aaeeebddababdabbbbabbabbbbddbbbbbbffffefbbbbba...................abbbbddabbbddabbbaaabddddddbbbbbbffffefbbbbba...................abbbbddbbbbdddbbbdddbdddbbbbbbbbbffffffbbbbaaa..................abdddddbbbbddbbbbddbbddbbbbbbbbbbffffffbbbbaa...................adddbbbbbbbddbbbbddbbddbbbbbbbbbbbffffbbbbaa.....................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbba.....................................abbbbbbbbbbbbbbbbbbbbbbbbgaa...................................abbbbbbbbbbbbbbbbbbbbbbbbggaaa..................................abbbbhhhhhhhhhhhhhhbbbbaagggga..................................abbbbaagghhhhhhhhhhbbbbaagggga..................................abbbbaaggggaaaaaaaabbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................abbbbaagggga......abbbbaagggga..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia..................................aeeeeaaiiiia......aeeeeaaiiiia...................................aaaa..aaaa........aaaa..aaaa......................',
          ],
        },
      },
    },
  },
  noir: {
    small: {
      w: 32,
      h: 18,
      ink: 'abcdefgh',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x6d6a7c, 0x2c2b34, 0x1f1e25, 0x8fd14f, 0x121116, 0xfbf3e6, 0x3a3944, 0xe08a9c],
      clips: {
        walk: {
          ms: 110,
          frames: [
            '...................................................................................................................................................a...aa.............aa...........baaaba............bba..........bcbcbbbba.........abb..........abcbbbbbbaa.........bba.........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbbcgggggbbacca..................bbca....bbacca..................bba.....bbacca..................cbba....bbaaa...........',
            '...................................................................................................................................................a...aa.............aa...........baaaba............aba..........bcbcbbbba..........bba.........abcbbbbbbaa.........bba.........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbccgggggbbacca.................bbcca...bba.aca.................abbca...bba.acaa.................bba....bba..aa..........',
            '...................................................................................................................................................................................ba..ba.............aba.........acbcbbha............bba.........bcbbbbbaa..........bba.........abbbbdefbba.........cba.........ccbbbdedbbaa........acaaaaaaaaaacbbbbbddbba..........abccbcbbcbcbbbbbbbbba...........abcbbbbbbbbbbbbaaaa..............bbbbbbbbbbbbba..................bbbgggggbbbbcca.................bbaccaaabba.acca................bbacca.bba...cca................bbaaa..bba...acca........',
            '...................................................................................................................................................a...aa.............aa...........baaaba............aba..........bcbcbbbba..........bba.........abcbbbbbbaa.........bba.........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca................abbacggggbbaacca................bba.aca..bba.cca................bba.acaa.bba.acaa...............bba..aa..aa...cca.........',
            '...................................................................................................................................................a...aa.............aa...........baaaba............bba..........bcbcbbbba.........abb..........abcbbbbbbaa.........bba.........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca................bbaaagggggbbacca................bba..cca..bbacca...............aba...cca..bbacca...............bba....cca.aa.cca..........',
            '...................................................................................................................................................a...aa............aa............baaaba...........aba...........bcbcbbbba.........bba..........abcbbbbbbaa........abb..........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca................bbaacgggggbbacca................bba.cca...abcca.................bba.acaa..abbca.................aa...cca...abca...........',
            '...................................................................................................................................................................................ba..ba...........aba...........acbcbbha..........bba...........bcbbbbbaa.........bba..........abbbbdefbba........acca.........ccbbbdedbbaa........acaaaaaaaaaacbbbbbddbba..........acccbcbbcbcbbbbbbbbba...........abcbbbbbbbbbbbbaaaa..............bbbbbbbbbbbbba..................bbbggggggbbbca..................bbaccaaaaabbca..................bbacca....bba...................aa.cca....bbba...........',
            '...................................................................................................................................................a...aa............aa............baaaba...........aba...........bcbcbbbba.........bba..........abcbbbbbbaa........abb..........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbacgggggbbcca..................abcca....bbcca..................abbca....abbca...................abca.....bba............',
          ],
        },
        run: {
          ms: 75,
          frames: [
            '....................................................................................................................................................................a..............aa..aa..........abb............acbaabba.........abb............bcbcbbbaa.........bba...........bcbbdefbba........accbacbccccbcccbbbdedbbha........abbccbcbcbbcbbbbbbddbbh..........bbcbbbbbbbbbbbbbbbbba...........abbbbbbbbbbbbbaaaaaa............bbagggggggbbcca................bba...ccaa..bba................abaa...acca.acbba...............bba.....cca.ccbba.......................acca..abba..........',
            '....................................................................................................................................................................aa.............ba..ba..........abb............acbcbbbb.........abb...........abcbbbbbba.........bbaa..aaaaaaaabbbbdefbba.........acbccbccccbcccbbbdedbbaa.........cbcbbcbcbbcbbbbbbddbba..........abbbbbbbbbbbbbbbbbbaa............bbbbbbbbbbbbbcaaa..............abaabbgggabbbca.................bba.cca...bbcca.................bba.cca...bbcca.................aa..acaa..abba.......................cca...bba............',
            '....................................................................................................................................................................a..............ba..ba..........abb............acbcbbbb.........abb...........abcbbbbbba.........bbaa..aaaaaaaabbbbdefbba.........accccbccccbcccbbbdedbbaa.........cbcbbcbcbbcbbbbbbddbba..........abbbbbbbbbbbbbbbbbbaa............bbbbbbbbbbbabcaaa...............bbbbagggbba.cca.................bbcca...bba.cca.................abbca...bba.acca.................bbca...bba..cca..................cca...bba..............',
            '....................................................................................................................................................................a..............aa..aa..........abb............acbaabba.........abb............bcbcbbbaa........abba...........bcbbdefbba........accaacbccccbcccbbbdedbbha........acbccbcbcbbcbbbbbbddbbh..........bbcbbbbbbbbbbbbbbbbba...........abbbbbbbbbbbbbbbaaaa.............bbggggggbbgacca..................bba.aabba...cca................acbba.abaa...acca...............ccbba.bba.....cca.................abba........acca.......',
            '...................................................................................................................................................................aba.............ba..ba..........abb............acbcbbbb.........aba...........abcbbbbbba.........bbaa..aaaaaaaabbbbdefbba.........aabccbccccbcccbbbdedbbaa.........abcbbcbcbbcbbbbbbddbba..........abbbbbbbbbbbbbbbbbbaa............bbbbbbbbbbbabcaaa...............bbbbagggbba.cca.................bbcca...bba.cca.................bbcca...bba.cca.................abba....aa..acaa.................bba.........cca.........',
            '....................................................................................................................................a..............................aba.............ba..ba..........abb............acbcbbbb.........abaa..........abcbbbbbba.........acaa..aaaaaaaabbbbdefbba.........abbccbccccbcccbbbdedbbaa.........abcbbcbcbbcbbbbbbddbba..........abbbbbbbbbbbbbbbbbbaa............bbbbbbbbbbbbbcaaa..............abaabbgggabbbca.................bba.cca...bbcca.................bba.acca..abbca.................bba..cca...bbca.................bba.........cca...........',
          ],
        },
        turn: {
          ms: 100,
          frames: [
            '...................................................................................................................................................a...aa.............aa...........baaaba............bba..........bcbcbbbba.........abb..........abcbbbbbbaa.........bba.........acbbbdefbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbacgggggbbacca.................bbacca...bbacca.................bbacca...bbacca.................bbacca...bbacca..........',
            '..................................................................................................................................................a.....a..............aa.........baaaaaba.............baa.......bbbbcbbbha...........aba.......abbbbbbbbba...........aba.......bbdefbbdefba..........accaa.aaaabbdedbbdedaa...........abcaacabccbbddbbbdda.............bcbbcbbcbcbbbbhbaa.............abbbbbbbbbbbbaa..................bbbbbbbbbbbba...................bbccggggbbcca...................bbcca...bbcca...................bbcca...bbcca...................bbcca...bbcca...........',
            '................................................................................................................................................a.....a..................aa.....baaaaaba.................baa...bbbbcbbbha...............aba...abbbbbbbbba...............aba...bbdefbbdefba..............accaaabbdedbbdedaa...............abcabcbbddbbbdda.................bcbbcbbbbbhbaa.................abbbbbbbbbba.....................bbbbbbbbbb......................bbcggbbcca......................bbccabbcca......................bbccabbcca......................bbccabbcca............',
            '..............................................................................................................................................a.....a......................aa.baaaaaba....................abbbbbbcbbbha...................bbabbbbbbbbba...................bbbbdefbbdefba..................acbbdedbbdedaa...................bbbbddbbbdda....................abcbbbbhbaa.....................bbbbbbbbba.....................acbbbbbbbca.....................ccbbggbbcca.....................ccbba.bbcca.....................ccbba.bbcca.....................ccbba.bbcca...........',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................bhbbbcbbbbhb...................abbbbbbbbbbbba..................bbbdefbbdefbba..................bcbdedbbdedbaa..................bcbbddbbbddba...................acbbbbbhbbba.....................abbbgggbbba.....................aabbbggbbbaa....................ccbbbbbbbacca...................ccbbaaabbacca...................ccbba..bbacca...................ccbba..bbacca.........',
          ],
        },
        sit: {
          ms: 180,
          frames: [
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbdefbbdefbba...................abdedbbdedbaa....................bbddbbbddba......................abbbhbbba....a.................cbbggggbbca..abb................bbbgggbbbba...aba..............abbbgggbbbba...bba.............abbbbbbgbbbbbbabcaa..............bbbbbbbbbbbbcabca................abbaaabbaaaaaa.......',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbdefbbdefbba...................abdedbbdedbaa....................bbddbbbddba......................abbbhbbba......................cbbggggbbca.....................bbbgggbbbba.....a..............abbbgggbbbba....aba............abbbbbbgbbbbbbaabba..............bbbbbbbbbbbbbcabaa...............abbaaabbaaaaaa.......',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbdefbbdefbba...................abdedbbdedbaa....................bbddbbbddba......................abbbhbbba......................cbbggggbbca.....................bbbgggbbbba....................abbbgggbbbba...................abbbbbbgbbbbbbaaaaaa.............bbbbbbbbbbbbcabbbba..............abbaaabbaaaaaaaaaa...',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbbbbbbbbbbba...................ababbbbabbbaa....................bbbbbbbbbba......................abbbhbbba......................cbbggggbbca.....................bbbgggbbbba.....a..............abbbgggbbbba....aba............abbbbbbgbbbbbbaabba..............bbbbbbbbbbbbbcabaa...............abbaaabbaaaaaa.......',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbdefbbdefbba...................abdedbbdedbaa....................bbddbbbddba......................abbbhbbba....a.................cbbggggbbca..abb................bbbgggbbbba...aba..............abbbgggbbbba...bba.............abbbbbbgbbbbbbabcaa..............bbbbbbbbbbbbcabca................abbaaabbaaaaaa.......',
            '...........................................................................................................................................a........a......................ba.aaaaaaha....................ahbbbcbbbbhb....................bbbbbbbbbbbba...................bbdefbbdefbba...................abdedbbdedbaa....................bbddbbbddba......................abbbhbbba...aa.................cbbggggbbca.aabb................bbbgggbbbba...baa..............abbbgggbbbba...cca.............abbbbbbgbbbbbbabba...............bbbbbbbbbbbbbcca.................abbaaabbaaaaaa.......',
          ],
        },
        sleep: {
          ms: 500,
          frames: [
            '.........................................................................................................................................................................................................................................................................................................................................................................aabbcacabbaaaa.ba.............acccbbcbcbbhbcbbbbb............abcbbbbbbbbbbbbbbbbba...........cbbbbbbbbbbbabbbabbba..........accbbbbbbbbbbbbhhbbbba...........abbcbbbbbbbbbbbbbbbba.............acabcabbaaa.aaaabba.....',
            '..........................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa...................acacbbcbcbbbbbaa.ba............abcbbbbbbbbbhbcbbbbb...........abbbbbbbbbbbbbbbbbbbba..........acbbbbbbbbbbbabbbabbba..........accbbbbbbbbbbbbhhbbbba...........abbcbbbbbbbbbbbbbbbba.............acabcabbaaa.aaaabba.....',
            '..........................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa...................acacbbcbcbbbbbaa.ba............abcbbbbbbbbbhbcbbbbb...........abbbbbbbbbbbbbbbbbbbba..........acbbbbbbbbbbbabbbabbba..........accbbbbbbbbbbbbhhbbbba...........abbcbbbbbbbbbbbbbbbba.............acabcabbaaa.aaaabba.....',
            '.........................................................................................................................................................................................................................................................................................................................................................................aabbcacabbaaaa.ba.............acccbbcbcbbhbcbbbbb............abcbbbbbbbbbbbbbbbbba...........cbbbbbbbbbbbabbbabbba..........accbbbbbbbbbbbbhhbbbba...........abbcbbbbbbbbbbbbbbbba.............acabcabbaaa.aaaabba.....',
          ],
        },
        happy: {
          ms: 120,
          frames: [
            '...................................................................................................................................................................................aa..aa.............ba..........acbaabba...........aba..........bcbcbbbaa..........bba..........bcbbbbbbba.........cca.........acbbbbbabbha........acaaaaaaaaaaabbbbbbbbbh..........abccbccbccccbbbbbbbba............bcbbcbbcbcbbbaaaaaa.............bbbbbbbbbbbbba.................abbbbbbbbbbbbcca................bbaccaaaaabbacca................bbacca....bbacca................bbacca.....bbacca.........',
            '...................................................................................aa..aa............a............acbaabba..........aba...........bcbcbbbaa.........bba...........bcbbbbbbba........abb..........acbbbbbabbha........caa..aaaaaaaabbbbbbbbbh.........abbccbccbccccbbbbbbbba...........abcbbcbbcbcbbbaaaaaa.............bbbbbbbbbbbbba.................abbbbbbbbbbbbcca................bbaccaaaaaabbacca..............abbacca.....bbacca..............bbacca......abbacca.............aa.aa......................................................................................',
            '...................................................a...aa...............aa.........baaaba.............bbba........bcbcbbbba..........abba........abcbbbbbbaa.........aba.........acbbbbbbbbb.........cca...aaaaaaabbbbbbabbaa........cbaaaacabcacabbbbbbbbba..........abcbbcbbcbcbbbbbbbbaa...........abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbaagggggbbbacca.................bbacca...aba.aa.................abbacaa...aa............................................................................................................................................',
            '...................................................................................................................................................a...aa..............aaa.........baaaba.............bbaa........bcbcbbbba..........abaa........abcbbbbbbaa.........cca.........acbbbbbbbbb.........abb...aaaaaaabbbbbbabbaa.........bcaaacabcacabbbbbbbbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca................abbacgggggbbacca................bbacca....bbacca................bbacca....abbacaa...............bbacca.....bbacca.........',
          ],
        },
        alert: {
          ms: 130,
          frames: [
            '...................................................................................................................................................a...aa.............aa...........baaaba............bba..........bcbcbbbba.........abb..........abcbbbbbbaa.........bba.........acbbbddfbbb.........aca...aaaaaaabbbbdedbbaa.........bbaaacabcacabbbbbddbba...........bcbbcbbcbcbbbbbbbba............abbbbbbbbbbbbbc..................bbbbbbbbbbbbbca.................bbacgggggbbacca.................bbacca...bbacca.................bbacca...bbacca.................bbacca...bbacca..........',
            '........................................................................................................a..........ba..ba.............aaaa........acaaabaa...........abbb.........bcbbbbbba..........abbbaaabbaabbbbbbbddbbb..........bbcabcabaacccbbbdefbbb..........bccbbcbbcbcbbbbbdddbba..........abbbbbbbbbbbbbbbbbbaaa..........abbbbbbbbbbbbbbaaaa..............abbbbbbbbbbbba..................bbgggggggbbacca.................bbaccaaaabbacca.................bbacca...bbacca.................bbacca...bbacca.................aa.aa....aa.aa...........................................',
            '...................................................................................................................................................a...aa.............aaa..........baaaba.............bbb.........bcbcbbbba..........abbb...aa..aabcbbbbbbaa.........abbcaacbbabbbcbbbddfbbb..........bbcbbccbccccbbbbdedbbaa.........ccbbbcbbcbcbbbbbbddbba..........abbbbbbbbbbbbbbbbbbaa............bbbbbbbbbbbbba..................bbbbbbbbbbbbcaa.................bbacgggggbbacca.................bbacca...bbacca.................bbacca...bbacca.................bbacca...bbacca..........',
          ],
        },
      },
    },
    big: {
      w: 64,
      h: 36,
      ink: 'abcdefgh',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x6d6a7c, 0x2c2b34, 0xe08a9c, 0x1f1e25, 0x8fd14f, 0x121116, 0xfbf3e6, 0x3a3944],
      clips: {
        walk: {
          ms: 110,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................abbbba....................abdddbbddbbbbbbbaa....................abbbba....................abbddbbbbbbbbbbbbaa..................aabbba....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeffgebbbbba.................abbdda..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbhadddda..................................abbbbbbdhhhhhhhhhhhbbbbaadddda...................................aabbbbddaaaaaaaaaabbbbaadddda....................................abbbbdda........abbbbaadddda....................................abbbbdda........abbbbaadddda....................................abbbbaa.........abbbbaadddda....................................addbbbba........abbbbaaaaaaa....................................addbbbba........abbbba.aaaa......................................aaaaaa..........aaaa............................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba...........................aaaa.....................abbaaaaaabcaa.........................aaaaaa...................aaddaaaaaabbaaa.......................abbbaa...................abdddbbddbbbbbbbaa.....................abbbaa...................abbddbbbbbbbbbbbbaa...................abbbba...................aabbddbbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeffgebbbbba.................abbbba..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbaadddda..................................abbbbdddhhhhhhhhhhhbbbbaadddda..................................abbbbddddaaaaaaaabbbbaa.adddda..................................abbbbdddda......abbbba..aaadda..................................abbbbdddda......abbbba..addddaa..................................aabbbbdda......abbbba...aaddaaa..................................abbbbaaa......abbbba....aaaaaa..................................abbbbaa.......abbbba.....aaaa....................................aaaa..........aaaa..............................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba....................................................abba....abba............................aaaa....................abbaaaaaabcaa..........................abbbaa..................abddbaddbbbbcba........................abbbba..................abaddbbddbbbbbbaaa......................abbbba..................abbddbbbbbbbbbbaaaa....................bbbbaa..................abbbddbbbbbeeeeebbbba...................bbbbaa..................abbbbbbbbbeeffgebbbbaa.................abbbba...................abddbbbbbbeeffgebbbbaa.................addbba..................addddbbbbbbeeffeebbbbaaa................addddaa.....aaaaaaaaaaaaaadbbbbbbbbeeffeebbbbaa..................addbaaaaaaaaaaaaaaaaaaaadabbbbbbbbbeeeebbbbba....................aaabbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa......................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbba........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbbbhhhhhhhhhhbbbbbbbadddda..................................abbbbaabhhhhhhhhhbbbbaaaaddddaa.................................abbbbaaddddaaaaaabbbba...aadddda................................abbbbaadddda...aabbbba....adddda................................abbbbaadddda..abbbbaa.....adddda................................abbbbaaaaaaa..abbbba......aaaddaa...............................abbbba.aaaa...abbbba.......aadddda...............................aaaa..........aaaa..........aaaa..................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba...........................aaaa.....................abbaaaaaabcaa.........................aaaaaa...................aaddaaaaaabbaaa.......................abbbaa...................abdddbbddbbbbbbbaa.....................abbbaa...................abbddbbbbbbbbbbbbaa...................abbbba...................aabbddbbbbbbbbbbbbaaa..................abbbba...................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeffgebbbbba.................abbbba..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbaahhhhhhhhhhhhbbaaaadddda.................................aabbbbaadhhhhhhhhhbbbbaaaadddda................................aaabbaa.addddaaaaaabbbba..adddda................................abbbba..aaadda....abbbba..adddda................................abbbba..addddaa...abbbba..addddaa...............................abbbba...aaddaaa..abbbba...aaddaaa..............................abbbba....aaaaaa..aaaaaa....adddda..............................abbbba.....aaaa....aaaa.....adddda...............................aaaa........................aaaa....................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................abbbba....................abdddbbddbbbbbbbaa....................abbbba....................abbddbbbbbbbbbbbbaa..................aabbba....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeffgebbbbba.................abbdda..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda.................................aabbaaaahhhhhhhhhhhhbbbbhadddda................................abbbbaaaaahhhhhhhhhhhbbbbaadddda................................abbbba...aaddddaaaaaabbbbaadddda................................abbbba....adddda....abbbbaadddda...............................aabbbba....adddda....abbbbaadddda..............................aaabbaa.....addddaa...abbbbaadddda..............................abbbba.......aadddda..aaaaaaadddda..............................abbbba........adddda...aaaa.adddda...............................aaaa..........aaaa..........aaaa......................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.........................aaaa.......................abbaaaaaabcaa.......................aaaaaa.....................aaddaaaaaabbaaa.....................abbbaa.....................abdddbbddbbbbbbbaa...................abbbaa.....................abbddbbbbbbbbbbbbaa.................abbbba.....................aabbddbbbbbbbbbbbbaaa.................aabbba....................abbbbbbbbbbeeeeebbbbba................aabbba....................abddbbbbbbeeffgebbbbba.................abdaaa..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aadbbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda.................................aabbaaaahhhhhhhhhhhhbbbbdadddda................................abbbbaaaadhhhhhhhhhhhbbbbaadddda................................abbbba..addddaaaaaaaabbbbddddaa.................................abbbba..adddda......aaabbdddda..................................abbbba..addddaa.....abbbbdddda..................................abbbba...aaddaaa.....aabbbbdda..................................aaaaaa....adddda......aaabbdda...................................aaaa.....adddda.......aabbdda.............................................aaaa..........aaaa........................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......bba....................................................abba....abba........................aaaa........................abbaaaaaabcaa......................abbbaa......................abddbaddbbbbcba....................abbbba......................abaddbbddbbbbbbaaa..................abbbba......................abbddbbbbbbbbbbaaaa................aabbbba.....................abbbddbbbbbeeeeebbbba................abbbba.....................abbbbbbbbbeeffgebbbbaa................bbbbaa....................abddbbbbbbeeffgebbbbaa................aadddda..................addddbbbbbbeeffeebbbbaaa................addddaa.....aaaaaaaaaaaaaadbbbbbbbbeeffeebbbbaa..................addbaaaaaaaaaaaaaaaaaaaadabbbbbbbbbeeeebbbbba....................aaabbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa......................aadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbba........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbba...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbdaaa..................................abbbbbbhhhhhhhhhhhhbbbbbdddaa...................................abbbbaabhhhhhhhhhhhbbbbdddda....................................abbbbaaddddaaaaaaaaaabbbbdda....................................abbbbaadddda........abbbbdda....................................abbbbaadddda........abbbbaa.....................................aaaaaaadddda........abbbbaa......................................aaaa.adddda........abbbbbba...........................................aaaa..........aaaaaa........................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.........................aaaa.......................abbaaaaaabcaa.......................aaaaaa.....................aaddaaaaaabbaaa.....................abbbaa.....................abdddbbddbbbbbbbaa...................abbbaa.....................abbddbbbbbbbbbbbbaa.................abbbba.....................aabbddbbbbbbbbbbbbaaa.................aabbba....................abbbbbbbbbbeeeeebbbbba................aabbba....................abddbbbbbbeeffgebbbbba.................abdaaa..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aadbbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbdaddaaa..................................abbbbaadhhhhhhhhhhhbbbbddddaa...................................abbbbaaddaaaaaaaaaabbbbdddda....................................aaabbdddda........abbbbdddda....................................abbbbdddda........abbbbdddda.....................................aabbbbdda.........aabbbbdda......................................aaabbdda..........abbbbaaa.......................................aabbdda..........abbbbaa..........................................aaaa............aaaa..........................',
          ],
        },
        run: {
          ms: 75,
          frames: [
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................aaa.....aaa.....................aaaaa..........................aaaa....aaaaa....................abbbba........................abddbaaaabbcbba...................abbbba........................abddbbddbbbbbbaa..................abbbba.......................abaddbbddbbbbbbaaa.................aabbba......................aabbddbbbbbeeeeebbba.................abbbba......................abbddbbbbeeffgebbbba................abbbaaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................aaddddbaaadbbbdddbdddbbbdddbddbbbbbbeeffeebbbbcca................adddbbbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbca..................adbbbbdddbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbbca...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbbbbbbbbaaa....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaaaa........................abbbbbbbbbbbbbbbbbbbbbbbbbbbdaaaaaaaa...........................abbbbaahhhhhhhhhhhhhhbbbbdddda.................................aabbaaa.aaaaddhhhhaaaaaabbbbdda................................abbbbaa.....addddaaaa...abbbbaa.................................abbbba......addddaa.....abbbbaa................................aabbaaa.......aadddda...aaddbbbba..............................abbbbaa.........adddda..addddbbbba..............................abbbba..........adddda..addddbbbba...............................aaaa...........aaaddaa..aaaaaabbaa..............................................aadddda.....aabbbba...............................................aaaa........aaaa......................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a........................a.............................dba.....bba......................aaaa..........................abba....abbaa....................aaaaaa........................aaddaaaaaabcaaa...................abbbba........................abddbbddbbbbbbba..................abbbba.......................abaddbbddbbbbbbbba.................abbbba......................aabbddbbbbbbbbbbbbaa................aabbbba......................abbddbbbbbeeeeebbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................bbbdaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbeeffgebbbbaa.................aaaddbbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbaaa.................aadbbbdddbbbddbbddbbbbddbbbbbbbbbbeeffeebbbbaa...................adbbbddbbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbdbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbdddaaaaaa............................aabbbbbbhhhhhhhhhhbbbbbbaadddda................................aaabbaaaabbbbhhhhhhaabbbbbbddaa.................................abbbba..addddaaaaaa.abbbbdddda..................................abbbba..adddda......abbbbdddda..................................abbbba..adddda......abbbbdddda..................................abbbba..adddda......abbbbdddda..................................abbbba..addddaa.....abbbbdddda...................................aaaa....aaddaaa.....aabbbbaa.............................................adddda......abbbba..............................................adddda......abbbba...............................................aaaa........aaaa..........................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a......................................................dba.....bba......................aaa...........................abba....abbaa....................aaaaa.........................aaddaaaaaabcaaa...................abbbba........................abddbbddbbbbbbba..................abbbba.......................abaddbbddbbbbbbbba.................abbbba......................aabbddbbbbbbbbbbbbaa................aabbbba......................abbddbbbbbeeeeebbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................bbbbaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbeeffgebbbbaa.................aaadddbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbaaa.................aadbbbdddbbbddbbddbbbbddbbbbbbbbbbeeffeebbbbaa...................adbbbddbbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbdbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbaabdddaaaaaa.............................abbbbhhhhbbhhhhhhhhbbbbaadddda..................................abbbbbbbbaahhhhhhbbbbaa.adddda..................................abbbbdddda.aaaaaabbbba..adddda..................................abbbbdddda......abbbba..adddda..................................abbbbdddda......abbbba..addddaa..................................aabbbbdda......abbbba...aadddda..................................abbbbdda......abbbba....adddda..................................abbbbdda......abbbba....adddda...................................aadddda......abbbba.....aaaa.....................................adddda......abbbba...............................................aaaa........aaaa..............................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a........................a.............................aaa.....aaa......................aaaa..........................aaaa....aaaaa....................abbbba........................abddbaaaabbcbba...................abbbba........................abddbbddbbbbbbaa..................abbbba.......................abaddbbddbbbbbbaaa.................aabbbb......................aabbddbbbbbeeeeebbba................aabbbba......................abbddbbbbeeffgebbbba................abbbbaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................aaddddaaaadbbbdddbdddbbbdddbddbbbbbbeeffeebbbbcca................addddbbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbca..................addbbbdddbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbbca...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbbbbbbbbaaa....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaa.......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbdbbaaaaaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbdddaaaaaa.............................abbbbhhhhhhhhhhhhbbbbhhaaddddaa..................................aabbbbddaaaaaahhbbaaaa..aadddda..................................abbbbaa..aaaabbbbaa.....adddda..................................abbbbaa.....abbbba......addddaa................................aaddbbbba...aabbaaa.......aadddda..............................addddbbbba..abbbbaa.........adddda..............................addddbbbba..abbbba..........adddda...............................aaaaaabbaa..aaaa...........aaaddaa..................................aabbbba.................aadddda...................................aaaa....................aaaa................',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.......................aaa............................dba.....bba.....................aabba..........................abba....abbaa....................aabbaa........................aaddaaaaaabcaaa...................abbbba........................abddbbddbbbbbbba..................abbbba.......................abaddbbddbbbbbbbba.................abbbaa......................aabbddbbbbbbbbbbbbaa.................abbbba......................abbddbbbbbeeeeebbbba................abbbdaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................aaddaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbeeffgebbbbaa.................aaaabbbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbaaa.................aabbbbdddbbbddbbddbbbbddbbbbbbbbbbeeffeebbbbaa...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbdbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbaabdddaaaaaa.............................abbbbhhhhbbhhhhhhhhbbbbaadddda..................................abbbbbbbbaahhhhhhbbbbaa.adddda..................................abbbbdddda.aaaaaabbbba..adddda..................................abbbbdddda......abbbba..adddda..................................abbbbdddda......abbbba..adddda..................................abbbbdddda......abbbba..adddda..................................abbbbdddda......abbbba..addddaa..................................aabbbbaa........aaaa....aaddaaa..................................abbbba..................adddda..................................abbbba..................adddda...................................aaaa....................aaaa....................',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa.............................a.......a.......................abba...........................dba.....bba.....................aabbaa.........................abba....abbaa....................aabbaa........................aaddaaaaaabcaaa...................abbbba........................abddbbddbbbbbbba..................abbbba.......................abaddbbddbbbbbbbba.................abbbaaa.....................aabbddbbbbbbbbbbbbaa.................abbbba......................abbddbbbbbeeeeebbbba.................abddaaa....aaaaaaaaaaaaaaaaabbbbbbbbeeffgebbbbaa................aaddaaaaaaaaaaaaaaaaaaaaaaaaddbbbbbbeeffgebbbbaa.................aaabbbbdddbbbdddbdddbbbddddddbbbbbbeeffeebbbbaaa.................aabbbbdddbbbddbbddbbbbddbbbbbbbbbbeeffeebbbbaa...................aabbbddbbbbddbbddbbbbddbbbbbbbbbbbeeeebbbbba....................abbbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaa.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbdbbbbbbaaa..........................abbbbbbbbbbbbbbbbbbbbbbbbbdddaaaaaa............................aabbbbbbhhhhhhhhhhbbbbbbaadddda................................aaabbaaaabbbbhhhhhhaabbbbbbddaa.................................abbbba..addddaaaaaa.abbbbdddda..................................abbbba..adddda......abbbbdddda..................................abbbba..addddaa.....abbbbdddda..................................abbbba...aadddda.....aabbbbdda..................................abbbba....adddda......abbbbdda..................................abbbba....adddda......abbbbdda..................................abbbba.....aaaa........aadddda..................................abbbba..................adddda...................................aaaa....................aaaa........................',
          ],
        },
        turn: {
          ms: 100,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................abbbba....................abdddbbddbbbbbbbaa....................abbbba....................abbddbbbbbbbbbbbbaa..................aabbba....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeffgebbbbba.................abbdda..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeffeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbhadddda..................................abbbbaadhhhhhhhhhhhbbbbaadddda..................................abbbbaaddddaaaaaaaabbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda...................................aaaa..aaaa........aaaa..aaaa......................',
            '....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba...........................aaaa.................abbaaaaaaaaabbba..........................aaaaaa...............aaccaaaaaaaaabccaa.........................abbaaa..............abcbbbbbddbbbbbbbcba.......................aabbaa...............abbbbbbbbbbbbbbbbbba.......................aabba...............aabbbbbbbbbbbbbbbbbbaa......................abbba..............abbbbbeeeeebbbbbeeeeebba.....................abbbaa.............abbbbeeffgebbbbeeffgebba.....................abbbaa.............abbbbeeffgebbbbeeffgebba.....................aaddddaaa..aaaaaaaaabbbbeeffeebbbbeeffeeaaa......................addbbddaaaaddabbbdddbbbeeffeebbbbeeffeeaa........................adbbddaaaaddabbbdddbbbbeeeebbbbbbeeeeba..........................abbddbbbbddbbbbddbbdbbbbbbbccccbbaaaa...........................abbddbbbbddbbbbddbbddbbbbbbbcccbbaaa...........................aabbbbbbbbbbbbbbbbbbddbbbbbabbaaaaa.............................aabbbbbbbbbbbbbbbbbbbbbbbbaaaa...................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbda......................................abbbbhhhhhhhhhhhhbbbbhddda......................................abbbbdddhhhhhhhhhbbbbdddda......................................abbbbddddaaaaaaaabbbbdddda......................................abbbbdddda......abbbbdddda......................................abbbbdddda......abbbbdddda......................................abbbbdddda......abbbbdddda......................................abbbbdddda......abbbbdddda......................................abbbbdddda......abbbbdddda.......................................aaaaaaaa........aaaaaaaa........................',
            '................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba...................................aaaa.........abbaaaaaaaaabbba..................................aaaaaa.......aaccaaaaaaaaabccaa.................................abbaaa......abcbbbbbddbbbbbbbcba...............................aabbaa.......abbbbbbbbbbbbbbbbbba...............................aabba.......aabbbbbbbbbbbbbbbbbbaa..............................abbba......abbbbbeeeeebbbbbeeeeebba.............................abbbaa.....abbbbeeffgebbbbeeffgebba.............................abbbaa.....abbbbeeffgebbbbeeffgebba.............................aaddddaaa.aabbbbeeffeebbbbeeffeeaaa..............................addbbddaabbdbbbeeffeebbbbeeffeeaa................................adbbddaabbddbbbeeeebbbbbbeeeeba..................................abbddbbbbddbbbbbbbbccccbbaaaa...................................abbddbbbbddbbbbbbbbbccbbbaaa...................................aabbbbbbbbbbbbbbddbbbbbbaaa.....................................aabbbbbbbbbbbbbbbbbbbbaa.........................................abbbbbbbbbbbbbbbbbbbba..........................................abbbbbbbbbbbbbbbbbbba...........................................abbbbhhhhhhbbbbhhhda............................................abbbbddhhhhbbbbdddda............................................abbbbddddaabbbbdddda............................................abbbbddddaabbbbdddda............................................abbbbddddaabbbbdddda............................................abbbbddddaabbbbdddda............................................abbbbddddaabbbbdddda............................................abbbbddddaabbbbdddda.............................................aaaaaaaa..aaaaaaaa..........................',
            '............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa..........aa.................................................abba......aaabba..........................................aaaa..abbaaaaaaaaabbba.........................................aaaaaaaaccaaaaaaaaabccaa........................................abbbbabcbbbbbddbbbbbbbcba......................................abbbbaabbbbbbbbbbbbbbbbbba......................................abbbaaabbbbbbbbbbbbbbbbbbaa.....................................abbbabbbbbeeeeebbbbbeeeeebba....................................abbbbbbbbeeffgebbbbeeffgebba....................................abbbabbbbeeffgebbbbeeffgebba....................................aaaddbbbbeeffeebbbbeeffeeaaa.....................................aadbbbbbeeffeebbbbeeffeeaa.......................................abbbbbbbeeeebbbbbbeeeeba.........................................abbbdbbbbbbbccccbbaaaa..........................................abbbddbbbbbbbccbbbaaa..........................................abbbbddbbbbbbbbbbbba............................................abbbbbbbbbbbbbbbbbba...........................................aadbbbbbbbbbbbbbbbbd...........................................aaaddbbbbbbbbbbbbbbdda..........................................addddbbbbhhhhbbbbhddda..........................................addddbbbbhhhhbbbbdddda..........................................addddbbbbaaaabbbbdddda..........................................addddbbbba..abbbbdddda..........................................addddbbbba..abbbbdddda..........................................addddbbbba..abbbbdddda..........................................addddbbbba..abbbbdddda..........................................addddbbbba..abbbbdddda...........................................aaaaaaaa....aaaaaaaa........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba........................................abbccbbbbbbdbbdbbbbbbccba......................................aabbbbbbbbbbbbbbbbbbbbbbba......................................aabbbbbbbbbbbbbbbbbbbbbbbba....................................abbbbbbbeeeeebbbbbeeeeebbbba....................................abbbbbbeeffgebbbbeeffgebbbba....................................abbbbbbeeffgebbbbeeffgebbbba....................................abbddbbeeffeebbbbeeffeebbaaa....................................abbbbbbeeffeebbbbeeffeebbaa.....................................abbddbbbeeeebbbbbbeeeebbba.......................................aadddbbbbbbbccccbbbbbbaa........................................aaddbbbbbbbbbccbbbbbbaa..........................................abbbbbbbbhbbbbbbhbbbba...........................................aabbbbbbhhhhhhbbbbbba.............................................aabbbbhhhhhhbbbbbba...........................................aaaabbbbbhhhhhbbbbbbaaaa.......................................addddbbbbbbhhhhbbbbbadddda......................................addddbbbbbbbbbbbbbbaadddda......................................addddbbbbbbbbbbbbbbaadddda......................................addddbbbbaaaaaabbbbaadddda......................................addddbbbba.aaaabbbbaadddda......................................addddbbbba....abbbbaadddda......................................addddbbbba....abbbbaadddda......................................addddbbbba....abbbbaadddda.......................................aaaaaaaa......aaaa..aaaa....................',
          ],
        },
        sit: {
          ms: 180,
          frames: [
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbeeeeebbbbbeeeeebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................aaabbeeffeebbbbeeffeebbaaa.......................................aabbeeffeebbbbeeffeebbaa.........................................abbbeeeebbbbbbeeeebbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa........aaa..................................aabbbbhbbbbbbhbbbbaa......aaaaa................................addbbbbhhhhhhhhbbbbdda.....aabbba...............................addbbbhhhhhhhhhhbbbdda......abbbba..............................abbbbbbhhhhhhbbbbbbbba.......abbba..............................abbbbbbhhhhhhbbbbbbbba.......dbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....abbbba............................aaabbbbbbbhhhhhbbbbbbbbaaa...aaddbba...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdaabdddaaa...........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbddaa.............................abbbbbbbbbbbbbbbbbbbbbbbbddabbbdaa...............................aaaabbbbaaaaaabbbbaaaaaaaaaaaaa..................................aaabbbbaaaaaabbbbaaaaaaaaaaa.......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbeeeeebbbbbeeeeebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................aaabbeeffeebbbbeeffeebbaaa.......................................aabbeeffeebbbbeeffeebbaa.........................................abbbeeeebbbbbbeeeebbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba...........aa.............................abbbbbbhhhhhhbbbbbbbba..........abba...........................aabbbbbbhhhhhhbbbbbbbbaa........aabbaa.........................aaabbbbbbbhhhhhbbbbbbbbaaa.....aaaabba.........................aabbbbbbbbbbbhhbbbbbbbbbbbbaaaaabbbbaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbddabbbbbaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbbddabbbaaa.............................aaaabbbbaaaaaabbbbaaaaaaaaaaaaaaa................................aaabbbbaaaaaabbbbaaaaaaaaaaaa......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbeeeeebbbbbeeeeebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................aaabbeeffeebbbbeeffeebbaaa.......................................aabbeeffeebbbbeeffeebbaa.........................................abbbeeeebbbbbbeeeebbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba..........................................abbbbbbhhhhhhbbbbbbbba.........................................aabbbbbbhhhhhhbbbbbbbbaa.......................................aaabbbbbbbhhhhhbbbbbbbbaaa.....................................aabbbbbbbbbbbhhbbbbbbbbbbbbdaaaaaaaaaaa.........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbbbbbbbaa.........................abbbbbbbbbbbbbbbbbbbbbbbbddabbbbbbbbbaa..........................aaaabbbbaaaaaabbbbaaaaaaaaaaaaaaaaaaaa...........................aaabbbbaaaaaabbbbaaaaaaaaaaaaaaaaaaa...............................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................aaabbabbbbabbbbabbbbabbaaa.......................................aabbbaaaabbbbbbaaaabbbaa.........................................abbbbbbbbbbbbbbbbbbbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa.............................................aabbbbhbbbbbbhbbbbaa...........................................addbbbbhhhhhhhhbbbbdda..........................................addbbbhhhhhhhhhhbbbdda..........................................abbbbbbhhhhhhbbbbbbbba...........aa.............................abbbbbbhhhhhhbbbbbbbba..........abba...........................aabbbbbbhhhhhhbbbbbbbbaa........aabbaa.........................aaabbbbbbbhhhhhbbbbbbbbaaa.....aaaabba.........................aabbbbbbbbbbbhhbbbbbbbbbbbbaaaaabbbbaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbddabbbbbaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbbddabbbaaa.............................aaaabbbbaaaaaabbbbaaaaaaaaaaaaaaa................................aaabbbbaaaaaabbbbaaaaaaaaaaaa......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbeeeeebbbbbeeeeebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................aaabbeeffeebbbbeeffeebbaaa.......................................aabbeeffeebbbbeeffeebbaa.........................................abbbeeeebbbbbbeeeebbba...........................................aabbbbbbccccbbbbbbaa.............................................aabbbbbbccbbbbbbaa........aaa..................................aabbbbhbbbbbbhbbbbaa......aaaaa................................addbbbbhhhhhhhhbbbbdda.....aabbba...............................addbbbhhhhhhhhhhbbbdda......abbbba..............................abbbbbbhhhhhhbbbbbbbba.......abbba..............................abbbbbbhhhhhhbbbbbbbba.......dbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....abbbba............................aaabbbbbbbhhhhhbbbbbbbbaaa...aaddbba...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdaabdddaaa...........................aabbbbbbbbbbbbbbbbbbbbbbbbbdabbbddaa.............................abbbbbbbbbbbbbbbbbbbbbbbbddabbbdaa...............................aaaabbbbaaaaaabbbbaaaaaaaaaaaaa..................................aaabbbbaaaaaabbbbaaaaaaaaaaa.......................................aaaa......aaaa..........................',
            '......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aa................aa...........................................abba..............abba..........................................abcaa.aaaaaaaaaa.aacba..........................................abcaaaaaaaaaaaaaaaacba.........................................abccbbbbbbdbbdbbbbbbccba........................................abbbbbbbbbbbbbbbbbbbbbba.......................................abbbbbbbbbbbbbbbbbbbbbbbba......................................abbbbbeeeeebbbbbeeeeebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................abbbbeeffgebbbbeeffgebbbba......................................aaabbeeffeebbbbeeffeebbaaa.......................................aabbeeffeebbbbeeffeebbaa.........................................abbbeeeebbbbbbeeeebbba...........................................aabbbbbbccccbbbbbbaa......a......................................aabbbbbbccbbbbbbaa......aaaaa..................................aabbbbhbbbbbbhbbbbaa....aaaaaaa................................addbbbbhhhhhhhhbbbbdda...aaaabbba...............................addbbbhhhhhhhhhhbbbdda....aaabbba...............................abbbbbbhhhhhhbbbbbbbba......abbaaa..............................abbbbbbhhhhhhbbbbbbbba......abbbba.............................aabbbbbbhhhhhhbbbbbbbbaa.....adbdda............................aaabbbbbbbhhhhhbbbbbbbbaaa..aaadddda...........................aabbbbbbbbbbbhhbbbbbbbbbbbbdadbbbaaa............................aabbbbbbbbbbbbbbbbbbbbbbbbbdddbbbba..............................abbbbbbbbbbbbbbbbbbbbbbbbbddddbaa................................aaaabbbbaaaaaabbbbaaaaaaaaaaaa...................................aaabbbbaaaaaabbbbaaaaaaaaaaa.......................................aaaa......aaaa..........................',
          ],
        },
        sleep: {
          ms: 500,
          frames: [
            '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaabba.........bb...............................aaaaabbbbddabddabbbbbaaaaaaaa.abba............................aaaaaaaabbbddbbddbbbbbcaaaaaaaaaacba..........................aabdddbddbbbbddbbddbbbbcbbbdbbdbbbbbcba........................aabbddbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.......................aaabbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................addbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbbbbba.......................adbbbdddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba........................aaaaaddabbbddabbbbbaaaaaaaaaaaaaaaabbbba..........................aaaddabbbddabbbbbaaaaaa.aaaaaaaaabbbba............................aaaaaaaaaaaaaaa................aaaa............',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa.................................................aaaaaaaaaaaaaaaaaaaa.........................................aaabdddbbbddbbddbbbbbbaaaa......bb............................aaddabddbbbbddbbddbbbbbbbbbbaaaa.abba..........................aaaddbbddbbbbbbbbbbbbbbbcbbabaaaaaacba.........................abbbddbbbbbbbbbbbbbbbbbbcbbbdbbdbbbbbcba.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abddbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbbbbba.......................adbbbdddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba........................aaaaaddabbbddabbbbbaaaaaaaaaaaaaaaabbbba..........................aaaddabbbddabbbbbaaaaa..aaaaaaaaabbbba............................aaaaaaaaaaaaaaa................aaaa............',
            '........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaa.................................................aaaaaaaaaaaaaaaaaaaa.........................................aaabdddbbbddbbddbbbbbbaaaa......bb............................aaddabddbbbbddbbddbbbbbbbbbbaaaa.abba..........................aaaddbbddbbbbbbbbbbbbbbbcbbabaaaaaacba.........................abbbddbbbbbbbbbbbbbbbbbbcbbbdbbdbbbbbcba.......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.....................abddbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbbbbba.......................adbbbdddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba........................aaaaaddabbbddabbbbbaaaaaaaaaaaaaaaabbbba..........................aaaddabbbddabbbbbaaaaa..aaaaaaaaabbbba............................aaaaaaaaaaaaaaa................aaaa............',
            '.....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaaaaaaaaaaaabba.........bb...............................aaaaabbbbddabddabbbbbaaaaaaaa.abba............................aaaaaaaabbbddbbddbbbbbcaaaaaaaaaacba..........................aabdddbddbbbbddbbddbbbbcbbbdbbdbbbbbcba........................aabbddbbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbba.......................aaabbddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba......................addbbbbbbbbbbbbbbbbbbbbbbabbabbbbabbabbbba.....................aadddbbbbbbbbbbbbbbbbbbbbbbaabbbbbbaabbbbba.....................aaddddbbbbbbbbbbbbbbbbbbbbbbbbccccbbbbbbbba......................adddbbbbbbhhhhhhhhhbbbbbbbbbbbccbbbbbbbbba.......................adbbbdddbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba........................aaaaaddabbbddabbbbbaaaaaaaaaaaaaaaabbbba..........................aaaddabbbddabbbbbaaaaaa.aaaaaaaaabbbba............................aaaaaaaaaaaaaaa................aaaa............',
          ],
        },
        happy: {
          ms: 120,
          frames: [
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.......a.............................a........................aaa.....aaa...........................aaa......................aaaa....aaaaa.........................abbaa....................abddbaaaabbcbba.......................aabbaa....................abddbbddbbbbbbaa.....................aaabba....................abaddbbddbbbbbbaaa....................abbbba...................aabbddbbbbbbbbbbbbba...................abbbba....................abbddbbbbbbbbbbbbbba..................abbbba...................aabbbbbbbbbbaabbbbbbaa.................adddda...................abddbbbbbbbabbabbbbbcca................addddaa.................aaaddbbbbbbabbbbabbbbca..................addbaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbca...................aaabbdddbbbdddbbbdddbddddbbbbbbbbbbbbbbbbaaa.....................aabddddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa.......................adbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbbaa........................abbddbbbbddbbbbddbbddbbbbbbaaaaaaaaaaa.........................aabbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda.................................aabbbbbbbbbbbbbbbbbbbbbbbbdddda................................aaabbaabhhhhhhhhhhhhhbbbbaadddda................................abbbbaaddddaaaaaaaaaabbbbaadddda................................abbbbaadddda........abbbbaadddda................................abbbbaadddda........abbbbaaddddaa...............................abbbbaadddda.........aabbbbaadddda..............................abbbbaadddda..........abbbbaadddda...............................aaaa..aaaa............aaaa..aaaa....................',
            '.......................................................................................................................................................................................................................................a.......a......................................................aaa.....aaa....................................................aaaa....aaaaa.......................aaa........................abddbaaaabbcbba.....................aabba.......................abddbbddbbbbbbaa....................aabbaa.....................abaddbbddbbbbbbaaa...................abbba.....................aabbddbbbbbbbbbbbbba.................abbbba......................abbddbbbbbbbbbbbbbba................abbbba.....................aabbbbbbbbbbaabbbbbbaa................aabbba....................abddbbbbbbbabbabbbbbcca...............aabbba...................aaaddbbbbbbabbbbabbbbca.................addaaa....aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbca.................aaaddbaaadbbbdddbbbdddbddddbbbbbbbbbbbbbbbbaaa...................aabbbbdddbbbdddbbbdddbdddbbbbbbbbbbbbbbbbbaa.....................abbbbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbbaa.......................aabbddbbbbddbbbbddbbddbbbbbbaaaaaaaaaaa.........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaa.............................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda.................................aabbbbbbbbbbbbbbbbbbbbbbbbdddda................................aaabbaabhhhhhhhhhhhhhbbbbaaddddaa...............................abbbbaaddddaaaaaaaaaaaabbbbaadddda..............................abbbbaadddda..........abbbbaadddda.............................aabbbbaadddda..........abbbbaadddda............................abbbbaaddddaa...........aaabbaaaaddaa...........................abbbbaadddda.............aabbbbaadddda..........................abbbbaadddda...............aaaa..aaaa............................aaaa..aaaa............................................................................................................................................................................................................................................................................................................................................................................',
            '...............................................................................................................a......................................................aa......aaa....................................................abba....abba..............................aaaa..................abbaaaaaabcaa...........................aaaaaaa................aaddaaaaaabbaaa.........................bbbbbbaa...............abdddbbddbbbbbbbaa......................abbbbbba................abbddbbbbbbbbbbbbaa....................aabbbbaa................aabbddbbbbbbbbbbbbaaa...................adbbaa..................abbbbbbbbbbbbbbbbbbbba..................adbbaa..................abddbbbbbbbbbbbbbbbbba.................adddda..................aaaddbbbbbbbbaabbbbbbba.................adddba......aaaaaaaaaaaaaabbbbbbbbbbabbabbbbbaaa................adbbbaaaaaaaaddabbbddabddaabbbbbbbbabbbbabbbbaa..................dbbbaaaaaaaaddabbbddabddabbbbbbbbbbbbbbbbbbaa....................abadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaaaa.....................aabbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaaa......................abbbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbbbhhhhhhhhhhhhbbbbbbaaddaa.................................abbbbaaahhhhhhhhhhhbabbbbaaddddaa................................aabbbbaaddddaaaaaaaabbbba.aaddaaa................................abbbbaadddda......aaabbaa..aaaa.................................abbbbaaddddaa......aabbbba.......................................aabbbbaaddaaa.......aaaa..........................................aaaa..aaaa....................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba.............................aaaaa..................abbaaaaaabcaa..........................aaaaaaaa................aaddaaaaaabbaaa........................abbbbaaaa...............abdddbbddbbbbbbbaa.....................aabbbbaaa................abbddbbbbbbbbbbbbaa....................aabbaaa.................aabbddbbbbbbbbbbbbaaa...................adbbaa..................abbbbbbbbbbbbbbbbbbbba.................adddda...................abddbbbbbbbbbbbbbbbbba.................adddda..................aaaddbbbbbbbbaabbbbbbba.................aaabbbd.....aaaaaaaaaaaaaabbbbbbbbbbabbabbbbbaaa.................aabbbbaaaaaaddabbbddabddaabbbbbbbbabbbbabbbbaa...................abbddaaaaaaddabbbddabddabbbbbbbbbbbbbbbbbbaa.....................aadbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbhadddda.................................aabbbbaadhhhhhhhhhhhbbbbaadddda................................aaabbaaaaddaaaaaaaaaabbbbaadddda................................abbbbaadddda........abbbbaadddda................................abbbbaadddda........abbbbaaddddaa...............................abbbbaadddda.........aabbbbaaddaaa..............................abbbbaadddda..........abbbbaadddda..............................abbbbaadddda..........abbbbaadddda...............................aaaa..aaaa............aaaa..aaaa....................',
          ],
        },
        alert: {
          ms: 130,
          frames: [
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa....................................................abba....abba..........................aaaa......................abbaaaaaabcaa........................aaaaaa....................aaddaaaaaabbaaa......................abbbba....................abdddbbddbbbbbbbaa....................abbbba....................abbddbbbbbbbbbbbbaa..................aabbba....................aabbddbbbbbbbbbbbbaaa..................abbbd....................abbbbbbbbbbeeeeebbbbba.................abbbba...................abddbbbbbbeeeegebbbbba.................abbdda..................aaaddbbbbbbeeffgebbbbba.................aaaddaa.....aaaaaaaaaaaaaabbbbbbbbbeeffeebbbbaaa.................aaddbbaaaaaaddabbbddabddaabbbbbbbbeeeeeebbbbaa...................abbbbaaaaaaddabbbddabddabbbbbbbbbbeeeebbbbaa.....................aabbdddbbbddbbbbddbbddbbbbbbbbbbbbbbbbaaa........................abbddbbbbddbbbbddbbddbbbbbbbbbbbbbbbbaa........................aabbddbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa..........................aabbbbbbbbbbbbbbbbbbbbbbbbbbda...................................abbbbbbbbbbbbbbbbbbbbbbbbbbaa...................................abbbbbbbbbbbbbbbbbbbbbbbbbddda..................................abbbbhhhhhhhhhhhhhhbbbbhadddda..................................abbbbaadhhhhhhhhhhhbbbbaadddda..................................abbbbaaddddaaaaaaaabbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda...................................aaaa..aaaa........aaaa..aaaa......................',
            '...............................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...............................a....................abba....abba...........................aaaaaa...................abbaaaaaabcaa.........................aaaaaaaa.................aaddaaaaaabbaaa........................abbbbba.................abdddbbddbbbbbbbaa.....................aabbbbba.................abbddbbbbbbbbbbbbaa....................aabbbbba...a..a.a..a..a.aabbddbbbbbbbbbbbbaaa...................aabbbbbdaaabaababaabaabdbbbbbbbbbbbeeeeebbbbba..................aabbbbddababdabbbbabbabbbbddbbbbbbeeeegebbbbba...................abbbbddabbbddabbbaaabddddddbbbbbbeeffgebbbbba...................abbbbddbbbbdddbbbdddbdddbbbbbbbbbeeffeebbbbaaa..................abdddddbbbbddbbbbddbbddbbbbbbbbbbeeeeeebbbbaa...................adddbbbbbbbddbbbbddbbddbbbbbbbbbbbeeeebbbbaa.....................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbba.....................................abbbbbbbbbbbbbbbbbbbbbbbbdaa...................................abbbbbbbbbbbbbbbbbbbbbbbbddaaa..................................abbbbhhhhhhhhhhhhhhbbbbaadddda..................................abbbbaaddhhhhhhhhhhbbbbaadddda..................................abbbbaaddddaaaaaaaabbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda...................................aaaa..aaaa........aaaa..aaaa......................................................................................................................................................................................................................',
            '...............................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a......................................................aa......aaa...............................a....................abba....abba...........................aaaaaa...................abbaaaaaabcaa.........................aaaaaaaa.................aaddaaaaaabbaaa........................abbbbba.................abdddbbddbbbbbbbaa.....................aabbbbba.................abbddbbbbbbbbbbbbaa....................aabbbbba...a..a.a..a..a.aabbddbbbbbbbbbbbbaaa...................aabbbbbdaaabaababaabaabdbbbbbbbbbbbeeeeebbbbba..................aabbbbddababdabbbbabbabbbbddbbbbbbeeeegebbbbba...................abbbbddabbbddabbbaaabddddddbbbbbbeeffgebbbbba...................abbbbddbbbbdddbbbdddbdddbbbbbbbbbeeffeebbbbaaa..................abdddddbbbbddbbbbddbbddbbbbbbbbbbeeeeeebbbbaa...................adddbbbbbbbddbbbbddbbddbbbbbbbbbbbeeeebbbbaa.....................aabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaa.....................abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaa......................abbbbbbbbbbbbbbbbbbbbbbbbbbbbaaaaaaaaa...........................abbbbbbbbbbbbbbbbbbbbbbbbbba.....................................abbbbbbbbbbbbbbbbbbbbbbbbdaa...................................abbbbbbbbbbbbbbbbbbbbbbbbddaaa..................................abbbbhhhhhhhhhhhhhhbbbbaadddda..................................abbbbaaddhhhhhhhhhhbbbbaadddda..................................abbbbaaddddaaaaaaaabbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda..................................abbbbaadddda......abbbbaadddda...................................aaaa..aaaa........aaaa..aaaa......................',
          ],
        },
      },
    },
  },
  garfield: {
    small: {
      w: 32,
      h: 24,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x7a4524, 0xe8873a, 0xfbf3e6, 0xb65a22, 0xf28fa0, 0x2b1b16, 0xf6b56b, 0xc96f2c, 0xd8c7b0],
      clips: {
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
      },
    },
    big: {
      w: 64,
      h: 36,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x7a4524, 0xe8873a, 0xfbf3e6, 0xf28fa0, 0xb65a22, 0x2b1b16, 0xf6b56b, 0xc96f2c, 0xd8c7b0],
      clips: {
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
      },
    },
  },
  panda: {
    small: {
      w: 32,
      h: 18,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x6d6a7c, 0x3d3c48, 0x2b2a33, 0xf7f3ea, 0xd9d3c7, 0x1f1e25, 0x7cc24e, 0x4e9338, 0xf28fa0],
      clips: {
        walk: {
          ms: 120,
          frames: [
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef.................abcceeeeebbccca.................bccceeeeeebbcca................abccaffff.afbcca.................bcc.afff..fbcca.................aaa..aa...aaaa...........',
            '....................................................................................aa...aa........................cccaaaccc.......................ccdddddcc.................aaaa.bcddddddda.............addddddddbcddcddcca...........aaddddddddbbcdcccdcca..........addddddddddbccddccdcca...........edddddddddbcceeeecee............adccdddddbbccceeeee.............abcccddddbbccdf.a................bcceeeeebbccfa.................abcceeeeeebccca.................abcceefeeabccc..................bcccfffa..fbcc..................bccaaff...fbca...................aa........aa............',
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef..................bccceeeebbccff..................bccceeeeebccff..................bcccfa..abccff..................accfa....acffa...................aa........aa...........',
            '....................................................................................aa...aa........................cccaaaccc.......................ccdddddcc.................aaaa.bcddddddda.............addddddddbcddcddcca...........aaddddddddbbcdcccdcca..........addddddddddbccddccdcca...........edddddddddbcceeeecee............adccdddddbbccceeeee.............abcccddddbbccdf.a................ebcceeeebcccff..................abcceeeebccfffa..................bcceaeebccfffa..................bccc..abccffff..................accc...bcaafff...................aa........aa..........',
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bbcceeeebcccef..................abcceeeebcccffa.................abccceebbccffff.................afbcca.bcccafffa................afbcc..bcca.fff..................aaaa...aa..aaa.........',
            '....................................................................................aa...aa........................cccaaaccc.......................ccdddddcc.................aaaa.bcddddddda.............addddddddbcddcddcca...........aaddddddddbbcdcccdcca..........addddddddddbccddccdcca...........edddddddddbcceeeecee............adccdddddbbccceeeee.............abcccddddbbccdf.a................ebcceeeebcccff..................abcceeeebccfffa..................bcccaeebccffff..................bccc..abccffff..................fcca..abcc.ffa...................aa....aa..............',
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef..................bccceeeebbccff..................bccceeeeebccff..................bcccfa..abccff...................ccffa..abccf......................aa....aa.............',
            '....................................................................................aa...aa........................cccaaaccc.......................ccdddddcc.................aaaa.bcddddddda.............addddddddbcddcddcca...........aaddddddddbbcdcccdcca..........addddddddddbccddccdcca...........edddddddddbcceeeecee............adccdddddbbccceeeee.............abcccddddbbccdf.a................bcceeeeebbccfa.................abcceeeeeebccfa.................bbcceefeeabccc..................bcccfffa..fbcc..................acc.fffa..abcc.......................aa....aa............',
          ],
        },
        run: {
          ms: 80,
          frames: [
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa..............abccceeeebbccef.................bccceeeeebbccca................abcceeeeeeeebccc................bccc.affffffbbcca...............bcca..affffffbcca................aa....aa..aaaaa..........',
            '....................................................................................aa...aba.......................acccdaccc.......................acddddddc..............aaaaddaabcddddddda............adddddddddbcddccdccd...........dddddddddddbcddccdccd..........addddddddddbbcdddccdcd...........ddddddddddbccceeeeee............dbccddddddbcccdeeee.............abccdddddbbccdf.................abcceeeeeebcccf.................bccceeeeeebbcca.................bcccfffaaaabcca................abccafff...abcca.................bcc..a....afff..................aaa........aa............',
            '....................................................................................aa...aba.......................acccdaccc.......................acddddddc..............aaaaddaabcddddddda............adddddddddbcddccdccd...........dddddddddddbcddccdccd..........addddddddddbbcdddccdcd...........ddddddddddbccceeeeee............dbccddddddbcccdeeee.............abccdddddbbccdfa.................bccceeeebbccffa.................abcceeeebcccfff.................abccaaaabccffff.................abcca...bccafffa.................bcca....a..fff...................aa........aaa.........',
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bbcceeeebcccefa.................abccceebbcccfff.................ffbcceebcccafffa...............affbcccbccca.ffff...............afffbccbcca..afff................aaaaa..aa....aa.........',
            '...................................................................................aba...aa........................cccadccca......................acddddddca..............aaaaddaaccddddddd..............adddddddbcddccddcca...........adddddddddbcddccdccca...........ddddddddddbcdddccccd............addddddddbbcceeeeeea.............dbccddddbcccdeeeea..............dbccddddbcccfa..................abccceeebcceff...................bccceeebccfffa..................abccaabcccfffa..................fbcc..bcccfffa..................fffa..bcca.aa....................aa....aa..............',
            '...................................................................................aba...aa........................cccadccca......................acddddddca..............aaaaddaaccddddddd..............adddddddbcddccddcca...........adddddddddbcddccdccca...........ddddddddddbcdddccccd............addddddddbbcceeeeeea.............dbccddddbcccdeeeea..............dbccddddbcccfa..................bccceeeebbccf..................abcceeeeeebccf..................abccffffaabcca..................abccffff..bccc...................aa.afff..accc.......................aa....aa............',
          ],
        },
        turn: {
          ms: 100,
          frames: [
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcccdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef..................bccceeeebbccff..................bccceeeeebccff..................bcccfa..abccff..................accffa..abccfa...................aaaa....aaaa...........',
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcdcdddcda............addddddddbbddccdccdd...........ddddddddddbccdccdccda..........addddddddddbcceeeceee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef..................bccceeeebbccff..................bccceeeeebccff..................bcccfa..abccff..................accffa..abccfa...................aaaa....aaaa...........',
            '..............................................a.....a........................bbaaa.bba......................accdddddcc.......................cddddddda.......................dddddddda......................addccdddcd.....................ccddccdcccd....................bccddddcddda....................bccceeeeeee....................abccddeeeeeca...................abccddddbccca...................abccddddbccc....................abcceeeebccc....................abceeeeeeccc....................abccfaaafbcc....................abccf..afbcc.....................aaa....aaa............',
            '............aa.....a.......................abbaaaabbb......................acddddddcc.......................dddddddda......................addddddddd......................adcdddccdd......................adccddccdd.....................aaddddddddda...................acceeeeeeeebcc..................accceeeeeedbcc..................abccddddddbccc...................bcccdddddbcca...................dbccdddddbcca...................dbccdddddccda..................abbceeeeeebbbb..................cbbcceeeeecbbca.................accceeeeeecccc...................aaa..aa...aa..........',
            '............................................bb....aba......................accddddccc......................acdddddddc.......................dddddddda......................adccdddcdd......................ddccddccdda.....................adccddccdd.....................cceeecceeeaca..................accceeeeeeebcc..................abccdeeeedbccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaaeeaaacca.........',
          ],
        },
        sit: {
          ms: 260,
          frames: [
            '............................................bb....aba......................accddddccc......................acdddddddc.......................dddddddda......................adccdddcdd......................ddccddccdda.....................adccddccdd.....................cceeecceeeaca..................accceeeeeeebcc..................abccdeeeedbccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaaeeaaacca.........',
            '............................................bba...bba......................accddddccc......................acdddddddc......................addddddddd......................adccdddcdd......................adccddccdd......................addcddccdd.....................cceeecceeeaca..................accceeeeeeebcc..................abccddeeedbccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaeeeeaacca.........',
            '............................................aba....bb.......................cccddddcca......................cdddddddca......................adddddddd.......................ddccdddcda.....................addccddccdd......................ddccddccda....................ccaeeecceeeca..................accceeeeeeebcc..................abccddeeeebccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaaeeaaacca.........',
            '............................................bba...bba......................accddddccc......................acdddddddc......................addddddddd......................adccdddcdd......................adccddccdd......................addcddccdd.....................cceeecceeeaca..................accceeeeeeebcc..................abccddeeedbccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaeeeeaacca.........',
            '...........................................aba....bb.......................cccddddcca......................cdddddddca......................adddddddd.......................ddcdddcdda.....................adcccdcccdd......................ddccdccdda.....................cceeeceeeeaca..................acceeeeeeedbcc..................abccdeeeedbccc...................bcccdddddbcca...................dbccddddbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaaeeaaacca.........',
            '............................................bb....aba......................accddddccc......................acdddddddc.......................dddddddda......................adccdddcdd......................ddccddccdda.....................adccddccddgh...................cceeecceeehga..................accceeeieeegcc..................abccdeeeehgccc...................bcccddddgbcca...................dbccdddgbccca...................ddccddddbccda...................bbbddddddcbba..................ccbcceeeeeccbca.................ccbcceeeeecbbca..................cccaaeeaaacca.........',
          ],
        },
        sleep: {
          ms: 520,
          frames: [
            '...................................................................................................................................................................................................................................................................................abba.abba...............a.......cccdddccc.............ddddddddaccddddddda............dddddddddbccddcddcca..........addddddddddbccdcccacca..........addddddddddbccddccdcda...........adddddddddbcceeeecee.............bccccceebbcccceeec..............bccccceeebcccccccca.............accccaaaaaaaaaaccc......',
            '...................................................................................................................................................................................................................................................................................abba.abba..............aaa.aa..acccdddccc............addddddddbccddddddda............dddddddddbccddcddcca..........addddddddddbccdcccacca..........addddddddddbccddccdcca...........adddddddddbcceeeccee.............bccccceebbccceeeee..............bccccceeebcccccccca.............accccaaaaaaaaaaccc......',
            '...................................................................................................................................................................................................................................................................................abb...bba.............adddaaaaaacccdddccc............addddddddbcccdddddca...........adddddddddbccddcddcdaa.........addddddddddbccdcccdcca..........addddddddddbccddccdcca...........adddddddddbcceeeccee.............bccccceebbccceeeee..............bccccceeebcccccccca.............accccaaaaaaaaaaccc......',
            '...................................................................................................................................................................................................................................................................................abba.abba..............aaa.aa..acccdddccc............addddddddbccddddddda............dddddddddbccddcddcca..........addddddddddbccdcccacca..........addddddddddbccddccdcca...........adddddddddbcceeeccee.............bccccceebbccceeeee..............bccccceeebcccccccca.............accccaaaaaaaaaaccc......',
          ],
        },
        happy: {
          ms: 120,
          frames: [
            '....................................................................................bb...bb........................cccdddccc.......................ccdddddcc...............aaaaaaabcddddddda.............addddddddbcdcccdcca...........aaddddddddbbcddacdaca..........addddddddddbccddddcdda...........edddddddddbccceeeiea............adccdddddbbccdaeeea.............abcccddddbbccdf.................abcceeeeebbccfa.................bbcceeeeeebccc..................bcccffffaafbcca................abccaafff.afbcca.................bcc..ffa..ffcc...........................................',
            '....................bb...bb........................cccdddccc.......................ccdddddcc...............aaaaaaabcddddddda.............addddddddbcdcccdcca...........aaddddddddbbcddacdaca..........addddddddddbccddddcdda...........edddddddddbccceeeiea............adccdddddbbccdaeeea.............abcccddddbbccdf..................bccceeeebbccff..................bcceeeeeebccfa.................abcceffaaabccfa.................abccaa....afffa..................bcc.......fff...........................................................................................................',
            '...................cccdddccc.......................ccdddddcc...............aaaaaaabcddddddda.............addddddddbcdcccdcca...........aaddddddddbbcddacdaca..........addddddddddbccddddcdda...........edddddddddbccceeeiea............adccdddddbbccdaeeea.............abcccddddbcccdf..................ebcceeeebcccffa.................abccceebcccffff.................ffbccaabccaafffa................ffbcccabcc..ffff.................aacc..aa...aff.........................................................................................................................................',
            '....................................................bb...bb........................cccdddccc.......................ccdddddcc...............aaaaaaabcddddddda.............addddddddbcdcccdcca...........aaddddddddbbcddacdaca..........addddddddddbccddddcdda...........edddddddddbccceeeiea............adccdddddbbccdaeeea.............abcccddddbbccdf..................bbcceeeebbccff..................abcceeeebcccff..................abccfaaabcccffa..................bccf...bccfff....................ffa...acc.a...........................................................................',
          ],
        },
        alert: {
          ms: 130,
          frames: [
            '....................................................................................aa...aa........................abbaaabba.......................ccdddddcc......................acddddddda..............adddddddbcddcddcca............addddddddbbddcdcdccd...........ddddddddddbccddccdcca..........addddddddddbcceeeecee............adccddddddbccceeeee.............abcccddddbbccdfaaa...............bccceeeebbccef..................bccceeeebbccff..................bccceeeeebccff..................bcccfa..abccff..................accffa..abccfa...................aaaa....aaaa...........',
            '...................................................................................bba..abb.......................accddddcca......................acddddddc...............aaaddddbcdddddddd..............adddddddbcddcddddc............adddddddddbcddccddcc............dddddddddbbceeeeccee............addddddddbccceeeeee..............dbccddddbcccdaaaa...............dbccddddbcccfa..................abcceeeebccefa..................abcceeeebccffa..................abccffaabccffa..................abccff..bccffa...................acafa..acafa...........................................',
            '...................................................bb...aba.......................accdddccc.......................acddddddc................aaaaaabcddddddda...............dddddddbcddccdcdc.............adddddddbbcddccdccd............addddddddbccddddcdda............aedddddddbccceeeeee..............abccddddbcccfeeea...............abccdddbbccdf....................bcceeebbccef....................bcceeeebccff....................bccffaabccff....................bccff..bccff....................acc......ffa...........................................................................',
          ],
        },
      },
    },
    big: {
      w: 64,
      h: 36,
      ink: 'abcdefghi',
      across: 8,
      down: 7,
      png: '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',
      palette: [0x6d6a7c, 0x3d3c48, 0x2b2a33, 0xf7f3ea, 0xd9d3c7, 0x1f1e25, 0xf28fa0, 0x7cc24e, 0x4e9338],
      clips: {
        walk: {
          ms: 120,
          frames: [
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa..................................abbccccceeeeeeeeeebbbcccccffa...................................abbccccceeeeeeeeeebbbbcccccfa..................................abbbcccceeeeeeeeeeeebbbccccca...................................abbccccceeeeeeeeeeeeebbbccccca..................................abbcccccafffffffaaaaafbbccccca.................................abbcccccaafffffffa..affbbccccca.................................abbccccca.affffffa..afffbbcccca..................................abcccca..affffffa...affbbcccca..................................abcccca...affffa....afffbccca....................................aaaaa.....aaaa......aaaaaaa.......................................................................................',
            '.......................................................................................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba..............................................accccccaaaaacccccca.............................................acccccdddddddccccca.............................................acccdddddddddddccca............................................aaccdddddddddddddca...................................aaaaaaa..abcccdddddddddddddca............................aaaaaaadddddddaabbccddddddddddddddda...........................addddddddddddddddbbccddddcccddddcccca..........................addddddddddddddddbbbccdddccdccddccdcca.......................aaadddddddddddddddddbbbccdddcccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................adddddddddddddddddddddbbcccdddddcccdddcccda.....................addddddddddddddddddddbbbccceeeeeeeeccceeeea......................aeddddddddddddddddddbbbcccceeeeeeeeceeeea........................addddddddddddddddddbbcccccceeeeeeeeeeea.........................addbccccddddddddddbbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaaeeeaaa...........................adbbcccccdddddddddbbbcccccddfa.aaa..............................adbbcccccdddddddddbbbcccccdffa...................................abbcccceeeeeeeeeebbbcccccffa...................................abbbcccceeeeeeeeeebbbbccccffa...................................abbccccceeeeeeeeeeebbbcccccfa...................................abbccccceeeeeeeeeeeebbcccccfa...................................abbcccceeeeffeeeeeaabbccccca...................................abbbccccaffffffaaaa.afbbcccca...................................abbcccccaffffffa....afbbcccca...................................abbcccccaffffffa....afbbcccca...................................abbcccca.affffa.....affbccca.....................................abcccca..aaaa.......afffffa......................................aaaaa...............aaaaa........................................................................................',
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbccccefffa...................................abbccccceeeeeeeeebbbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbcccccfffaaaaaaabbccccffffa...................................abbcccccfffa.....abbccccffffa...................................abbcccccfffa.....abbccccffffa....................................abccccffaa.......aaccfffffa.....................................abccccaa...........aafffffa......................................aaaaa...............aaaaa......................................................................................',
            '.......................................................................................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba..............................................accccccaaaaacccccca.............................................acccccdddddddccccca.............................................acccdddddddddddccca............................................aaccdddddddddddddca...................................aaaaaaa..abcccdddddddddddddca............................aaaaaaadddddddaabbccddddddddddddddda...........................addddddddddddddddbbccddddcccddddcccca..........................addddddddddddddddbbbccdddccdccddccdcca.......................aaadddddddddddddddddbbbccdddcccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................adddddddddddddddddddddbbcccdddddcccdddcccda.....................addddddddddddddddddddbbbccceeeeeeeeccceeeea......................aeddddddddddddddddddbbbcccceeeeeeeeceeeea........................addddddddddddddddddbbcccccceeeeeeeeeeea.........................addbccccddddddddddbbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaaeeeaaa...........................adbbcccccdddddddddbbbcccccddfa.aaa..............................adbbcccccdddddddddbbbcccccdffa...................................aebbcccceeeeeeeeebbcccccefffa...................................aebbccccceeeeeeeebbcccccfffffa...................................abbccccceeeeeeebbbccccffffffa...................................abbccccceeeeeeebbcccccffffffa....................................abbcccceaaeeeebbcccccffffffa....................................abbccccca.aaaabbccccafffffffa...................................abbccccca....abbccccafffffffa...................................abbccccca....abbccccafffffffa....................................abccccca.....abccca.affffffa....................................abcccca.......aaaa..afffffa......................................aaaaa...............aaaaa....................................................................................',
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbbcccceeeeeeeeebbcccccceffa...................................aebbccccceeeeeeeebbccccceffffa...................................abbccccceeeeeeebbccccccfffffa....................................abbccccceeeeeebbcccccfffffffa..................................afbbccccceeeeebbbcccccfffffffa..................................afbbbccccaaaaabbcccccafffffffa..................................affbbccccca..abbcccccaafffffffa.................................affbbccccca..abbcccca.afffffffa.................................afffbcccca...abbcccca..afffffa...................................affbcccca....abccca...afffffa....................................aaaaaaa......aaaa.....aaaaa...................................................................................',
            '.......................................................................................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba..............................................accccccaaaaacccccca.............................................acccccdddddddccccca.............................................acccdddddddddddccca............................................aaccdddddddddddddca...................................aaaaaaa..abcccdddddddddddddca............................aaaaaaadddddddaabbccddddddddddddddda...........................addddddddddddddddbbccddddcccddddcccca..........................addddddddddddddddbbbccdddccdccddccdcca.......................aaadddddddddddddddddbbbccdddcccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................adddddddddddddddddddddbbcccdddddcccdddcccda.....................addddddddddddddddddddbbbccceeeeeeeeccceeeea......................aeddddddddddddddddddbbbcccceeeeeeeeceeeea........................addddddddddddddddddbbcccccceeeeeeeeeeea.........................addbccccddddddddddbbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaaeeeaaa...........................adbbcccccdddddddddbbbcccccddfa.aaa..............................adbbcccccdddddddddbbbcccccdffa...................................aebbcccceeeeeeeeebbcccccefffa...................................aebbccccceeeeeeeebbcccccfffffa...................................abbccccceeeeeeeebbccccffffffa...................................abbbcccceeeeeeebbbccccffffffa....................................abbcccccaaeeeebbcccccfffffffa...................................abbccccca.aaaabbcccccfffffffa...................................abbccccca....abbccccafffffffa...................................afbcccca.....abbccccaafffffa....................................affcccca.....abbcccca.affffa.....................................affffa.......abccca...aaaa.......................................aaaa.........aaaa............................................................................................',
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbccccefffa...................................abbccccceeeeeeeeebbbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbcccccfffaaaaaaabbccccffffa...................................abbcccccfffa.....abbccccffffa....................................abccccffffa.....abbccccfffa......................................acccfffffa.....abbccccffa........................................aaaffffa.......abcccaaa............................................aaaa.........aaaa..........................................................................................',
            '.......................................................................................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba..............................................accccccaaaaacccccca.............................................acccccdddddddccccca.............................................acccdddddddddddccca............................................aaccdddddddddddddca...................................aaaaaaa..abcccdddddddddddddca............................aaaaaaadddddddaabbccddddddddddddddda...........................addddddddddddddddbbccddddcccddddcccca..........................addddddddddddddddbbbccdddccdccddccdcca.......................aaadddddddddddddddddbbbccdddcccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................adddddddddddddddddddddbbcccdddddcccdddcccda.....................addddddddddddddddddddbbbccceeeeeeeeccceeeea......................aeddddddddddddddddddbbbcccceeeeeeeeceeeea........................addddddddddddddddddbbcccccceeeeeeeeeeea.........................addbccccddddddddddbbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaaeeeaaa...........................adbbcccccdddddddddbbbcccccddfa.aaa..............................adbbcccccdddddddddbbbcccccdffa...................................abbcccceeeeeeeeeebbbcccccffa...................................abbccccceeeeeeeeeebbbcccccffa...................................abbccccceeeeeeeeeeebbbccccffa...................................abbccccceeeeeeeeeeeebbcccccfa..................................abbbcccceeeeffeeeeeaabbccccca...................................abbcccccfffffffaaaa.abbccccca...................................abbcccccaffffffa....afbbcccca....................................abccccaaffffffa.....abbcccca....................................abccca.affffffa.....abbcccca.....................................aaaa...affffa.......abccca..............................................aaaa.........aaaa........................................................................................',
          ],
        },
        run: {
          ms: 80,
          frames: [
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa..................................abbcccccceeeeeeeeebbbccccceffa.................................abbbccccceeeeeeeeeebbbbcccccfa..................................abbcccccceeeeeeeeeebbbbcccccca.................................abbcccccceeeeeeeeeeeebcbbccccca.................................abbccccceeeeeeeeeeeeeeebbcccccca...............................abbccccccaaaffffffffaffffbbcccccca..............................abbccccca..affffffffaffffbbbccccca..............................abbcccca....afffffffafffffbbccccca..............................abbcccca.....affffffaffffffbccccca...............................abccca......afffffa.affffabcccca.................................aaaa........aaaaa...aaaa.aaaaa.....................................................................................',
            '.........................................................................................................................................................................................................................................a..........a...................................................abaa......aabaa................................................abbbba.aa.abbbbba..............................................accccccaddaaccccca..............................................accccddddddddccccca............................................aacccdddddddddddcca...................................aaaaa....abcccdddddddddddddca...........................aaaaaaaadddddaaaabbccdddddddddddddda..........................aaddddddddddddddddbbbccddddccddddddccda........................addddddddddddddddddbbbcddddccccdddccccda......................aadddddddddddddddddddbbccddddccdccddcdccca.....................adddddddddddddddddddddbbccddddcccccddccccda....................adddddddddddddddddddddbbbccdddddccccddccccda....................adddddddddddddddddddddbbbcccdddddccdccdccdda....................adddddddddddddddddddddbbcccceeeeeeeccceeeea......................adddddddddddddddddddbbbccccceeeeeeeeeeeea.......................adddbcccddddddddddddbbbcccccdeeeeeeggeea........................addbbccccdddddddddddbbbcccccddaeeeeeeea.........................addbbccccdddddddddddbbbcccccdfaaaaaaaa...........................abbcccccddddddddddbbbbccccddfa..................................abbccccceeeeeeeeeebbbbcccccffa..................................abbccccceeeeeeeeeeebbbcccccffa..................................abbcccceeeeeeeeeeeebbbbccccffa.................................abbccccceeeeeeeeeeeeebbbccccca..................................abbccccceeeeeeeeeeeeeabbccccca..................................abbcccccfffffffaaaaaaabbbcccca.................................abbbccccafffffffa.....afbbcccca.................................abbcccccaafffffa......afbbcccca.................................abbccccca.afffa.......affbccca...................................abcccca...aaa........affffffa...................................abcccca...............affffa.....................................aaaaa.................aaaa........................................................................................',
            '.........................................................................................................................................................................................................................................a..........a...................................................abaa......aabaa................................................abbbba.aa.abbbbba..............................................accccccaddaaccccca..............................................accccddddddddccccca............................................aacccdddddddddddcca...................................aaaaa....abcccdddddddddddddca...........................aaaaaaaadddddaaaabbccdddddddddddddda..........................aaddddddddddddddddbbbccddddccddddddccda........................addddddddddddddddddbbbcddddccccdddccccda......................aadddddddddddddddddddbbccddddccdccddcdccca.....................adddddddddddddddddddddbbccddddcccccddccccda....................adddddddddddddddddddddbbbccdddddccccddccccda....................adddddddddddddddddddddbbbcccdddddccdccdccdda....................adddddddddddddddddddddbbcccceeeeeeeccceeeea......................adddddddddddddddddddbbbccccceeeeeeeeeeeea.......................adddbcccddddddddddddbbbcccccdeeeeeeggeea........................addbbccccdddddddddddbbbcccccddaeeeeeeea.........................addbbccccdddddddddddbbbcccccdfaaaaaaaa...........................adbbccccddddddddddbbbcccccddffa.................................aebbccccceeeeeeeeebbbcccccefffa..................................abbccccceeeeeeeeebbbcccccffffa..................................abbccccceeeeeeeeebbcccccfffffa...................................abbcccceeeeeeeeebbcccccffffffa..................................abbccccceeeeeeebbbccccfffffffa..................................abbcccccaaaaaaabbcccccfffffffa..................................abbccccca.....abbcccccafffffffa.................................afbbcccca......abccccaafffffffa..................................abbcccca.......accca.afffffffa..................................abbcccca........aaa...afffffa....................................abccca...............afffffa.....................................aaaa.................aaaaa...................................................................................',
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbccccccdffa...................................abbbccccceeeeeeeebbccccccefffa..................................aebbcccccceeeeeebbccccccefffffa..................................abbbccccceeeeebbbccccccffffffa..................................afbbcccccceeeebbccccccffffffffa................................afffbbccccceeebbccccccaafffffffa...............................affffbbbcccccabbbccccca.affffffffa..............................afffffbbcccccabbcccccca..afffffffa..............................affffffbbccccabbccccca....affffffa..............................affffffbbccccabbcccca.....affffffa...............................afffffabccca.abcccca......affffa.................................aaaaa.aaaa...aaaaa........aaaa..................................................................................',
            '........................................................................................................................................................................................................................................a..........a..................................................aabaa......aaba................................................abbbbba.aa.abbbba...............................................acccccaaddacccccca.............................................acccccddddddddcccca............................................aaaccdddddddddddccca....................................aaaaa..abcccdddddddddddddcca.............................aaaaaaadddddaaabcccdddddddddddddda.............................addddddddddddddbbccdddddccdddddccda............................adddddddddddddddbbccddddccccdddccccda........................aaadddddddddddddddbbbccddddccdcddccdccda.......................addddddddddddddddddbbbccddddccccddcccccda......................adddddddddddddddddddbbbccddddccccddcccccda......................adddddddddddddddddddbbcccdddddccccccccdda.......................addddddddddddddddddbbbcccceeeeeeeccceeeea........................aeddddddddddddddddbbbccccceeeeeeeeeeeea..........................addbcccddddddddddbbccccccdeeeeeggeeea...........................adbbccccddddddddbbbccccccdfeeeeeeeaa............................adbbccccddddddddbbbcccccddfaaaaaaa..............................adbbcccccdddddddbbbcccccdffa....................................aebbccccceeeeeeebbbcccccefffa....................................aebbccccceeeeeebbccccceffffa.....................................abbccccceeeeeebbcccccfffffa.....................................abbccccceeeeeebbcccccffffffa.....................................abbccccceeeeebbccccfffffffa.....................................abbcccccaaaabbcccccaffffffa....................................afbbccccca..abbcccccaffffffa....................................affbcccca...abbcccccaffffffa....................................afffcccfa...abbcccca.affffa.....................................affffffa....abbcccca..aaaa.......................................afffffa.....abccca...............................................aaaaa.......aaaa.............................................................................................',
            '........................................................................................................................................................................................................................................a..........a..................................................aabaa......aaba................................................abbbbba.aa.abbbba...............................................acccccaaddacccccca.............................................acccccddddddddcccca............................................aaaccdddddddddddccca....................................aaaaa..abcccdddddddddddddcca.............................aaaaaaadddddaaabcccdddddddddddddda.............................addddddddddddddbbccdddddccdddddccda............................adddddddddddddddbbccddddccccdddccccda........................aaadddddddddddddddbbbccddddccdcddccdccda.......................addddddddddddddddddbbbccddddccccddcccccda......................adddddddddddddddddddbbbccddddccccddcccccda......................adddddddddddddddddddbbcccdddddccccccccdda.......................addddddddddddddddddbbbcccceeeeeeeccceeeea........................aeddddddddddddddddbbbccccceeeeeeeeeeeea..........................addbcccddddddddddbbccccccdeeeeeggeeea...........................adbbccccddddddddbbbccccccdfeeeeeeeaa............................adbbccccddddddddbbbcccccddfaaaaaaa..............................adbbccccddddddddbbbcccccdffa....................................abbccccceeeeeeeebbbccccceffa....................................abbccccceeeeeeeebbbbccccffa.....................................abbccccceeeeeeeeebbbcccccfa....................................abbccccceeeeeeeeeeebbcccccfa....................................abbccccceeeeeeeeeeebbccccca.....................................abbccccafffffffaaaafbbcccca.....................................abbccccafffffffa..afbbccccca....................................abbccccafffffffa...abbccccca.....................................abccca.affffffa...abbccccca......................................aaaa..affffffa....abccccca.............................................affffa.....abcccca...............................................aaaa.......aaaaa........................................................................................',
          ],
        },
        turn: {
          ms: 100,
          frames: [
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddcccccddcccccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbccccefffa...................................abbccccceeeeeeeeebbbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbcccccfffaaaaaaabbccccffffa...................................abbcccccfffa.....abbccccffffa...................................abbcccccfffa.....abbccccffffa....................................abccccffffa.....abbccccfffa.....................................abccccfffa.......abcccffffa......................................aaaaaaaa.........aaaaaaaa......................................................................................',
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddcccdddddcccdda..........................aaddddddddddddddddbbccddccdcdddcdccdda.........................adddddddddddddddddbbbcdddcccccdcccccddda......................aaadddddddddddddddddbbbccddcccccdcccccdda......................addddddddddddddddddddbbcccdddcccdddcccddda.....................addddddddddddddddddddbbbcccddddddcccdddddda.....................addddddddddddddddddddbbbcccceeeeeccceeeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbccccefffa...................................abbccccceeeeeeeeebbbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbcccccfffaaaaaaabbccccffffa...................................abbcccccfffa.....abbccccffffa...................................abbcccccfffa.....abbccccffffa....................................abccccffffa.....abbccccfffa.....................................abccccfffa.......abcccffffa......................................aaaaaaaa.........aaaaaaaa......................................................................................',
            '...........................................................................................................................................................aa..........aa.................................................abba........abba...............................................abbbba.aaaa.abbbba.............................................accccccaddddacccccca............................................accccddddddddddcccca............................................acccddddddddddddccca.............................................acddddddddddddddca..............................................adddddddddddddddda..............................................adddddddddddddddda.............................................addddcccdddddcccddda............................................addddccdcddddcdccdda..........................................aaaddddccccdddcccccdda.........................................acccddddccccdddcccccdda........................................abcccddddccccdddccccddda.......................................abbccccddddddddccdddddda........................................abbcccceeeeeeeccceeeeeea........................................abbccccceeeeeeeeeeeeeea........................................adbbcccccdeeeeeeeeeeeecda.......................................adbbccccdddeeeeeeeeeeccda.......................................adbbccccddddddeeeecccccda.......................................adbbccccddddddddbbcccccda.......................................adbbccccddddddddbbcccccda.......................................abbbccccdddddddbbbccccca........................................abbbcccceeeeeeebbbccccca........................................abbbcccceeeeeeeebbccccca........................................abbbccceeeeeeeeebbccccca........................................abbccceeeeeeeeeeebccccca........................................abbccccfeeeeeeeeebbcccca........................................abbccccffaaaaaaffbbcccca........................................abbccccffa....affbbcccca........................................abbccccffa....affbbcccca.........................................abcccffa......affbccca...........................................aaaaaa........aaaaaa........................................................................................',
            '........................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccdcddddcdccddda...........................................addddccccddddccccdddda...........................................adddccccddddccccddda............................................adddccccddddccccddda..........................................aaaddddddddddddddddddaaa.......................................acccaeeeeeecccceeeeeeaccca.....................................abcccceeeeeeeeeeeeeeeebcccca....................................abccccceeeeeeeeeeeeeebbcccca....................................abcccccdeeeeeeeeeeeedbbcccca....................................abbccccdddeeeeeeeedddbbcccca....................................abbcccccddddddddddddbbccccca.....................................abbccccddddddddddddbbcccca......................................abbcccccddddddddddbbccccca......................................abbcccccddddddddddbbccccca......................................adbbccccddddddddddbbccccda......................................adbbcccccddddddddbbcccccda......................................addbccccddddddddddbccccdda......................................abbbccccddddddddddbccccbba.....................................abbbbbcbeeeeeeeeeeeebcbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................................................................................',
            '........................................................................................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccdcddddcdccddda...........................................addddccccddddccccdddda...........................................adddccccddddccccddda............................................adddccccddddccccddda..........................................aaaddddddddddddddddddaaa.......................................acccaeeeeeecccceeeeeeaccca.....................................abcccceeeeeeeeeeeeeeeebcccca....................................abccccceeeeeeeeeeeeeebbcccca....................................abcccccdeeeeeeeeeeeedbbcccca....................................abbcccccddeeeeeeeeddbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................',
          ],
        },
        sit: {
          ms: 260,
          frames: [
            '........................................................................................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccdcddddcdccddda...........................................addddccccddddccccdddda...........................................adddccccddddccccddda............................................adddccccddddccccddda..........................................aaaddddddddddddddddddaaa.......................................acccaeeeeeecccceeeeeeaccca.....................................abcccceeeeeeeeeeeeeeeebcccca....................................abccccceeeeeeeeeeeeeebbcccca....................................abcccccdeeeeeeeeeeeedbbcccca....................................abbcccccddeeeeeeeeddbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................',
            '........................................................................................aaaa........aaaa...............................................abbbba......abbbba.............................................accccccaaaaaacccccca............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccdcddddcdccddda............................................adddccccddddccccddda............................................adddccccddddccccddda............................................addddcccddddcccdddda..........................................aaaddddddddccddddddddaaa.......................................acccaeeeeeecccceeeeeeaccca.....................................abcccceeeeeeeeeeeeeeeebcccca....................................abccccceeeeeeeeeeeeeebbcccca....................................abcccccddeeeeeeeeeeddbbcccca....................................abbcccccdddeeeeeedddbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaeeeeeeeeaaaccccca.......................................aaaaa...aaaaaaaa...aaaaa....................',
            '.........................................................................................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................addddcccddddddccddda............................................adddccdccddddcdccdda...........................................addddcccccdddcccccddda...........................................adddcccccdddcccccdda............................................addddccccdddccccddda.........................................aaaadddddddddcddddddddaa.......................................acccaaeeeeeeeccceeeeeeccca.....................................abccccaeeeeeeeeeeeeeeeecccca....................................abcccccdeeeeeeeeeeeeeebcccca....................................abcccccddeeeeeeeeeeeebbcccca....................................abbcccccdddeeeeeeeedbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................',
            '........................................................................................aaaa........aaaa...............................................abbbba......abbbba.............................................accccccaaaaaacccccca............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccccddddccccddda............................................adddcccadddaccccddda............................................adddcaacddddaaccddda............................................addddcccddddcccdddda..........................................aaaddddddddccddddddddaaa.......................................acccaeeeeeecccceeeeeeaccca.....................................abcccceeeeeeeeeeeeeeeebcccca....................................abccccceeeeeeeeeeeeeebbcccca....................................abcccccddeeeeeeeeeeddbbcccca....................................abbcccccdddeeeeeedddbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaeeeeeeeeaaaccccca.......................................aaaaa...aaaaaaaa...aaaaa....................',
            '.......................................................................................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddccddddddcccdddda............................................addccdcddddccdccddda...........................................adddcccccdddcccccdddda...........................................addcccccdddcccccddda............................................adddccccdddccccdddda...........................................aaddddddddcdddddddddaaaa.......................................accceeeeeeccceeeeeeeaaccca.....................................abccceeeeeeeeeeeeeeeeabcccca....................................abcccceeeeeeeeeeeeeedbbcccca....................................abccccceeeeeeeeeeeeddbbcccca....................................abbcccccdeeeeeeeedddbbccccca.....................................abbcccccddddddddddbbbcccca......................................abbcccccddddddddddbbccccca......................................adbbcccccddddddddbbcccccda......................................adbbcccccddddddddbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................',
            '........................................................................................aaa..........aaa...............................................abbba........abbba.............................................abbbbbaaaaaaaabbbbba............................................acccccddddddddccccca............................................acccddddddddddddccca............................................accddddddddddddddcca.............................................adddddddddddddddda..............................................adddddddddddddddda.............................................adddddddddddddddddda............................................adddcccddddddcccddda............................................adddccdcddddcdccddda...........................................addddccccddddccccdddda...........................................adddccccddddccccdddaa.a.........................................adddccccddddccccdddhhaia......................................aaaddddddddddddddddddhaha......................................acccaeeeeeecccceeeeeeihhca.....................................abcccceeeeeeeeeeeeeeeehhccca....................................abccccceeeeeeggeeeeeehhcccca....................................abcccccdeeeeeeeeeeeehhbcccca....................................abbcccccddeeeeeeeeihhbccccca.....................................abbcccccddddddddihhbbcccca......................................abbcccccddddddddhhbbccccca......................................adbbcccccddddddhhbbcccccda......................................adbbcccccdddddihdbbcccccda......................................addbbcccccddddddbbcccccdda......................................adddbccccddddddddbccccddda......................................adddbccccddddddddbccccddda......................................abbbbbcddddddddddddcbbbbba.....................................abbbbbbbeeeeeeeeeeeebbbbbbba...................................acccbbcccceeeeeeeeeeccccbbccca..................................accbbbbccceeeeeeeeeecccbbbbcca..................................acccbbbccceeeeeeeeeecccbbbccca...................................accccccceeeeeeeeeeeeccccccca.....................................acccccaaaaaeeeeaaaaaccccca.......................................aaaaa.....aaaa.....aaaaa....................',
          ],
        },
        sleep: {
          ms: 520,
          frames: [
            '.........................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................a.........a...................................................aabaa.....aabaa................................................abbbbba...abbbbba...............................................acccccaaaaaccccca..............................aa..............acccccdddddddccccca..........................aaaddaaaaaaaaaa..aaaaccdddddddddddcca..........................adddddddddddddddaabccccdddddddddddddca.........................adddddddddddddddddbbccccddddddddddddda.........................addddddddddddddddddbbcccddddcccddddcccda......................aaddddddddddddddddddbbbcccdddccccdddccccda.....................addddddddddddddddddddbbbcccdddcccacdaccccda.....................addddddddddddddddddddbbccccdddcaaccdcaaccda.....................addddddddddddddddddddbbccccddddccccddcccdda.....................aeeddddddddddddddddddbbccccceeeeeeccceeeea.......................aaddddddddddddddddddbbccccceeeeeeecceeeea........................adddcddddddddddddddbbcccccdeeeeeeeeeeea..........................abbccccccccceeeeebbbcccccccceeeeeeeca...........................abbccccccccceeeeeebbccccccccccccccccca..........................abbccccccccceeeeeebbccccccccccccccccca..........................abbccccccccceeeeeeabccccccccccccccccca...........................aaccccccccaaaaaaa.aaaaaaaaaaacccccca..............................aaaaaaaa...................aaaaaa.............',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaa.....aaaaa................................................abbbbba...abbbbba...............................................acccccaaaaaccccca............................aaaaaa...aaa.....aacccccdddddddccccca.........................aaddddddaaadddaaaaacccccdddddddddddccca........................adddddddddddddddddbbccccdddddddddddddca........................addddddddddddddddddbbccccddddddddddddda.........................adddddddddddddddddbbbcccddddccdddddcccda......................aaddddddddddddddddddbbbcccdddccccdddccccda.....................addddddddddddddddddddbbbcccdddcccacdaccccda.....................addddddddddddddddddddbbccccdddcaaccdcaaccda.....................addddddddddddddddddddbbccccddddccccddccccda.....................aeeddddddddddddddddddbbcccccddddcccccdcdda.......................aaddddddddddddddddddbbccccceeeeeeccceeeea........................adddcddddddddddddddbbcccccdeeeeeeeeeeea..........................abbccccccccceeeeebbbccccccceeeeeeeeea...........................abbccccccccceeeeeebbcccccccccceeecccca..........................abbccccccccceeeeeebbccccccccccccccccca..........................abbccccccccceeeeeeebccccccccccccccccca...........................aaccccccccaaaaaaaaaaaaaaaaaaacccccca..............................aaaaaaaa...................aaaaaa.............',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba............................aaaaaa.............acccccaaaaaccccca...........................addddddaaaaaaaaaaaaacccccdddddddccccca.........................adddddddddddddddddbccccccdddddddddcccca........................adddddddddddddddddbbcccccdddddddddddcca........................addddddddddddddddddbbccccddddddddddddda.a......................addddddddddddddddddbbbcccddddccdddddccddaea....................aaddddddddddddddddddbbbcccdddccccdddccccdaa....................addddddddddddddddddddbbccccdddcccccddccccda.....................addddddddddddddddddddbbccccdddcaaacdaaaccda.....................addddddddddddddddddddbbccccddddccccddccccda.....................aeeddddddddddddddddddbbccccdddddccccccccdda......................aaddddddddddddddddddbbccccceeeeeeccceeeea........................adddcdddddddddddddbbbcccccdeeeeeeeeeeea..........................abbccccccccceeeeebbbccccccceeeeeeeeea...........................abbccccccccceeeeeebbccccccccceeeeeccca..........................abbccccccccceeeeeebbccccccccccccccccca..........................abbccccccccceeeeeeebccccccccccccccccca...........................aaccccccccaaaaaaaaaaaaaaaaaaacccccca..............................aaaaaaaa...................aaaaaa.............',
            '.......................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................aaaaa.....aaaaa................................................abbbbba...abbbbba...............................................acccccaaaaaccccca............................aaaaaa...aaa.....aacccccdddddddccccca.........................aaddddddaaadddaaaaacccccdddddddddddccca........................adddddddddddddddddbbccccdddddddddddddca........................addddddddddddddddddbbccccddddddddddddda.........................adddddddddddddddddbbbcccddddccdddddcccda......................aaddddddddddddddddddbbbcccdddccccdddccccda.....................addddddddddddddddddddbbbcccdddcccacdaccccda.....................addddddddddddddddddddbbccccdddcaaccdcaaccda.....................addddddddddddddddddddbbccccddddccccddccccda.....................aeeddddddddddddddddddbbcccccddddcccccdcdda.......................aaddddddddddddddddddbbccccceeeeeeccceeeea........................adddcddddddddddddddbbcccccdeeeeeeeeeeea..........................abbccccccccceeeeebbbccccccceeeeeeeeea...........................abbccccccccceeeeeebbcccccccccceeecccca..........................abbccccccccceeeeeebbccccccccccccccccca..........................abbccccccccceeeeeeebccccccccccccccccca...........................aaccccccccaaaaaaaaaaaaaaaaaaacccccca..............................aaaaaaaa...................aaaaaa.............',
          ],
        },
        happy: {
          ms: 120,
          frames: [
            '........................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddcccccddccccca.........................adddddddddddddddddbbbcddddcccacddaccccda......................aaadddddddddddddddddbbbccddddaaccddcaacca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa..................................abbccccceeeeeeeeeebbbcccccffa...................................abbccccceeeeeeeeeebbbbcccccfa..................................abbbcccceeeeeeeeeeeebbbccccca...................................abbccccceeeeeeeeeeeeebbbccccca..................................abbcccccafffffffaaaaafbbccccca.................................abbcccccaafffffffa..affbbccccca.................................abbccccca.affffffa..afffbbcccca..................................abcccca..affffffa...affbbcccca..................................abcccca...affffa....afffbccca....................................aaaaa.....aaaa......aaaaaaa.......................................................................................................................................................',
            '.......................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddcccccddccccca.........................adddddddddddddddddbbbcddddcccacddaccccda......................aaadddddddddddddddddbbbccddddaaccddcaacca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbcccccfffa...................................abbcccceeeeeeeeeebbbcccccffa....................................abbcccceeeeeeeeeeebbbccccffa....................................abbcccceeeeeeeeeeeebbccccffa...................................abbbcccceffffaaaaaaabbccccffa...................................abbcccccffffa.......abcccfffa...................................abbcccccaaaa........afffffffa....................................abccccca............affffffa....................................abcccca.............afffffa......................................aaaaa...............aaaaa.......................................................................................................................................................................................................................................................................................................................................................................................................................',
            '.....................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddcccccddccccca.........................adddddddddddddddddbbbcddddcccacddaccccda......................aaadddddddddddddddddbbbccddddaaccddcaacca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbccccccdffa...................................abbbccccceeeeeeeebbccccccefffa..................................aebbccccceeeeeeebbcccccceffffa...................................abbbccccceeeeebbbccccccffffffa..................................afbbccccceeeeebbccccccfffffffa.................................affbbbccccceeebbbcccccaffffffffa................................afffbbcccccaaabbccccca.afffffffa................................afffbbbcccccaabbccccca.affffffffa...............................affffbbcccccaabbcccca...afffffffa................................afffbbcccca..abccca....affffffa..................................aaaabccca....aaaa......affffa.......................................aaaa................aaaa...................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................................',
            '........................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddcccccddccccca.........................adddddddddddddddddbbbcddddcccacddaccccda......................aaadddddddddddddddddbbbccddddaaccddcaacca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeggeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbbcccceeeeeeeeebbbccccefffa....................................abbcccceeeeeeeeebbcccccffffa....................................abbcccceeeeeeeeebbcccccffffa....................................abbccccceeeeeeeebbcccccfffffa...................................abbcccccffaaaaaabbcccccfffffa...................................abbcccccfa.....abbccccffffffa....................................abccccffa.....abbccccfffffa......................................acccfffa.....abbccccafffa........................................affffa.......abccca.aaa..........................................aaaa.........aaaa...........................................................................................................................................................................................................................................................................................',
          ],
        },
        alert: {
          ms: 130,
          frames: [
            '........................................................................................................................................................................................................................................................................................................aaa.......aaa..................................................abbba.....abbba................................................abbbbbaaaaabbbbba..............................................accccccdddddcccccca.............................................accccdddddddddcccca.............................................acccdddddddddddccca............................................acccdddddddddddddca..............................aaaaaaaaaaaaaaabccddddddddddddddda............................aaddddddddddddddbbccddddcccddddcccda..........................aaddddddddddddddddbbccdddccdccddccdcca.........................adddddddddddddddddbbbcddddccdccddccdccda......................aaadddddddddddddddddbbbccddddccccddccccca......................addddddddddddddddddddbbcccddddccccddccccda.....................addddddddddddddddddddbbbcccddddddddcccdddda.....................addddddddddddddddddddbbbcccceeeeeeecceeeea.......................aeddddddddddddddddddbbcccccceeeeeeeeeeea.........................adddcccddddddddddddbbccccccdeeeeeeeeea..........................addbccccddddddddddbbbcccccddaaeeeeeaa...........................adbbcccccdddddddddbbbcccccddfaaaaaa.............................adbbcccccdddddddddbbbcccccdffa...................................abbccccceeeeeeeeebbbccccceffa...................................abbccccceeeeeeeeebbbccccefffa...................................abbccccceeeeeeeeebbbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbccccceeeeeeeeeebbccccffffa...................................abbcccccfffaaaaaaabbccccffffa...................................abbcccccfffa.....abbccccffffa...................................abbcccccfffa.....abbccccffffa....................................abccccffffa.....abbccccfffa.....................................abccccfffa.......abcccffffa......................................aaaaaaaa.........aaaaaaaa......................................................................................',
            '......................................................................................................................................................................................................................................aaaa.......aaaa................................................abbbba.....abbbba..............................................accccccaaaaacccccca.............................................acccccdddddddccccca.............................................acccdddddddddddccca............................................aaacdddddddddddddca....................................aaaaaaa.abccddddddddddddddda..............................aaaaaadddddddabbccdddddcdddddddcda.............................addddddddddddddbbccddddccccdddcccca............................addddddddddddddbbbccddddccdcdddcdcca.........................aaadddddddddddddddbbbccddddccdccdccdcca........................addddddddddddddddddbbcccddddccccdddcccca........................addddddddddddddddddbbcccdddddcccdcdcccda.......................addddddddddddddddddbbbccceeeeeeeeccceeeea........................aeddddddddddddddddbbbcccceeeeeeeeeeeeea.........................aeddddddddddddddddbbcccccceeeeeeeeeeea...........................addbccccddddddddbbbccccccdaeeeeeeeaa............................addbccccddddddddbbbcccccddaaaaaaaa..............................adbbcccccdddddddbbbcccccddfa....................................adbbcccccdddddddbbbcccccdffa.....................................abbccccceeeeeeebbbccccefffa.....................................abbccccceeeeeeebbbccccefffa.....................................abbccccceeeeeeeebbccccffffa.....................................abbccccceeeeeeeebbccccffffa.....................................abbccccceeeeeeeebbccccffffa.....................................abbcccccfffaaaaabbccccffffa.....................................abbcccccfffa...abbccccffffa.....................................abbcccccfffa...abbccccffffa......................................abccccffffa...abbccccfffa........................................acccaffaa.....aaccafffa..........................................aaa.aa.........aa.aaa........................................................................................................................................................',
            '......................................................................................................aaa........aaa.................................................abbba......abbba...............................................abbbbbaaaaaabbbbba..............................................acccccdddddcccccca..............................................acccddddddddddccca.............................................aaccddddddddddddcca............................................abccdddddddddddddda.................................aaaaaaaaaaaabbccdddddddddddddda...............................aadddddddddddbbbcdddddcccddddcccda.............................adddddddddddddbbbcddddccdccddccdcca............................addddddddddddddbbccddddccdccddccdcca.........................aaaddddddddddddddbbbccddddcccccddccccda........................adddddddddddddddddbbbccdddddccccddccccda........................adddddddddddddddddbbccccdddddddcccdddda.........................adddddddddddddddddbbcccceeeeeeeecceeeea.........................aeeddddddddddddddbbbccccceeeeeeeeeeeea...........................aadddccdddddddddbbccccccdeeeeeeeeeea.............................adbbccccdddddddbbccccccdfaeeeeeaaa..............................adbbccccddddddbbbccccccdfaaaaaa.................................adbbccccddddddbbbcccccddfa......................................adbbcccceeeeeebbbccccceffa.......................................abbcccceeeeeebbbccccceffa.......................................abbcccceeeeeeebbcccccfffa.......................................abbcccceeeeeeebbcccccfffa.......................................abbcccceeeeeeebbcccccfffa.......................................abbccccffffaaabbcccccfffa.......................................abbccccffffa.abbccccffffa.......................................abbccccfffa...abccccffffa.......................................abbccccaaa.....aaaffffffa........................................abccca...........affffa..........................................aaaa.............aaaa........................................................................................................................................................................................................................................................................................',
          ],
        },
      },
    },
  },
} as const
// </sprites>

/** The clips every sheet has, with their frame counts and paces: the roux cat's stand for all. */
const CLIPS = SHEETS.roux.small.clips

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
/** The sheet in hand: the chosen cat's, at the chosen size. */
const sheet = () => SHEETS[stage.coat][isBig() ? 'big' : 'small']
const catColumns = () => sheet().w
const catRows = () => sheet().h / 2
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

  // Lasagne on the table: no sitting, no watching, it tears from end to end
  // and leaps as it goes, until the dish is done.
  if (isFeasting()) {
    actor.react = ''
    if (actor.posture !== 'standing') {
      actor.posture = 'standing'
      actor.goal = actor.heading > 0 ? span : 0

      return { clip: 'turn', frames: TURN_OUT, isFlipped: actor.heading < 0, stride: 0 }
    }
    if (actor.heading > 0 ? actor.x >= span : actor.x <= 0) actor.heading = actor.heading > 0 ? -1 : 1
    actor.goal = actor.heading > 0 ? span : 0
    const clip = Math.random() < 0.4 ? 'happy' : 'run'

    return {
      clip,
      frames: count(CLIPS[clip].frames.length),
      isFlipped: actor.heading < 0,
      stride: 2 * actor.heading,
    }
  }

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

// --------------------------------------------------------- the cat as an Svg

/** The row of the sheet each clip is on: the manifests all agree. */
const CLIP_ROW: Record<ClipName, number> = { walk: 0, run: 1, turn: 2, sit: 3, sleep: 4, happy: 5, alert: 6 }

/** The scene in sprite pixels, where a surface draws real pictures. */
const SVG_WIDTH = 320
const SVG_TOP = 14
const SVG_GROUND = 3

/** What the Svg drawn last showed, so the animator redraws on a change alone. */
let svgDrawn = ''

/** What the cat does and says, as far as the picture depends on it. */
const svgKey = () =>
  [
    actor.beat.clip,
    actor.beat.frames.join(''),
    actor.beat.isFlipped,
    actor.beat.stride === 0 ? Math.round(actor.x) : actor.goal,
    scene.lines.join('|'),
    stage.coat,
    scene.done,
    scene.fails,
    isFeasting(),
    scene.effects.length,
    scene.effects[scene.effects.length - 1]?.born ?? 0,
    new Date().getHours(),
  ].join('/')

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The scene as one self-playing picture, where a surface draws real pictures:
 * the two sheets themselves behind windows a frame wide, stepped and moved by
 * CSS. It is drawn again only when what it shows changes, so every animation
 * starts as far in as the scene's clock says, and none jumps on a redraw.
 */
const sceneSvg = (ground: string | undefined) => {
  tend(SVG_WIDTH)
  const drawn = SHEETS[stage.coat].big
  const clip = drawn.clips[actor.beat.clip]
  const span = SVG_WIDTH - drawn.w
  const from = Math.max(0, Math.min(span, actor.x))
  const to = actor.beat.stride === 0 ? from : Math.max(0, Math.min(span, actor.goal))
  const speed = Math.abs(actor.beat.stride) * catScale()
  const travel = speed === 0 ? 0 : (Math.abs(to - from) / speed) * clip.ms
  const reel = actor.beat.frames.length * clip.ms
  const steps = actor.beat.frames
    .map((frame, at) => {
      const shift = `translate(${-frame * drawn.w}px,${-CLIP_ROW[actor.beat.clip] * drawn.h}px)`

      return `${((at / actor.beat.frames.length) * 100).toFixed(2)}%{transform:${shift}}`
    })
    .join('')
  const floor = SVG_TOP + drawn.h
  const height = floor + 4
  const rules = new Map<string, string>()

  /** The keyframes that step a piece of the decor through its frames, made once a piece. */
  const reelOf = (name: DecorName) => {
    const item = DECOR.items[name]
    if (!rules.has(name)) {
      const at = (frame: number) => `translate(${-(item.at[0] + frame * item.w)}px,${-item.at[1]}px)`
      const frames = item.frames.map((_frame, k) => `${((k / item.frames.length) * 100).toFixed(2)}%{transform:${at(k)}}`)
      rules.set(name, `@keyframes k-${name}{${frames.join('')}100%{transform:${at(item.frames.length - 1)}}}`)
    }

    return item.frames.length * item.ms
  }
  /**
   * One piece of the decor in a window its size: `age` how far into its frames
   * it already is; `once` plays it through and holds (or, `fades`, vanishes).
   */
  const piece = (name: DecorName, x: number, y: number, age = scene.clock, mode: 'loop' | 'once' | 'fades' = 'loop') => {
    const item = DECOR.items[name]
    const window = `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${item.w}" height="${item.h}"`
    if (item.frames.length === 1) {
      return `${window} viewBox="${item.at[0]} ${item.at[1]} ${item.w} ${item.h}"><use href="#d"/></svg>`
    }
    const length = reelOf(name)
    const run =
      mode === 'loop'
        ? `k-${name} ${length}ms step-end ${-(age % length)}ms infinite`
        : `k-${name} ${length}ms step-end ${-Math.min(age, length)}ms 1 forwards`
    const fade = mode === 'fades' ? `,gone 1ms linear ${Math.max(0, length - age)}ms 1 forwards` : ''

    return `${window} viewBox="0 0 ${item.w} ${item.h}"><use href="#d" style="animation:${run}${fade}"/></svg>`
  }
  const stand = (name: DecorName, x: number, age?: number, mode?: 'loop' | 'once' | 'fades') =>
    piece(name, x, floor - 16, age, mode)

  const hour = new Date().getHours()
  const isDay = hour >= 7 && hour < 20
  const parts: string[] = []
  // The sky: the sun or the moon, and by day a cloud crossing it.
  parts.push(piece(isDay ? 'sun' : 'moon', SVG_WIDTH - 20, 0))
  if (isDay) {
    const crossing = 110_000
    parts.push(
      `<g style="animation:drift ${crossing}ms linear ${-((scene.clock + crossing * 0.3) % crossing)}ms infinite">` +
        `${piece('cloud_b', 0, 0)}</g>`,
    )
  } else {
    const sky = seeded(SVG_WIDTH + 7)
    for (let k = 0; k < 9; k += 1) parts.push(piece('star', sky() * (SVG_WIDTH - 16), sky() * (floor - 30), scene.clock + k * 300))
  }
  // The ground, tile by tile, the same tiles in the same order as on a terminal this wide.
  const tiles = seeded(SVG_WIDTH + 3)
  for (let x = 0; x < SVG_WIDTH; x += 16) {
    const tile = DECOR.items[(['ground_a', 'ground_b', 'ground_c'] as const)[Math.floor(tiles() * 3)] ?? 'ground_a']
    parts.push(
      `<svg x="${x}" y="${floor}" width="16" height="4" viewBox="${tile.at[0]} ${tile.at[1] + 12} 16 4"><use href="#d"/></svg>`,
    )
  }
  // What grew: a bloom a finished todo, a mushroom a failed call.
  for (const one of scene.blooms) {
    const [grow, sway] = BLOOMS[one.kind] ?? BLOOMS[0]!
    const age = scene.clock - one.born
    const grown = DECOR.items[grow].frames.length * DECOR.items[grow].ms
    parts.push(age < grown ? stand(grow, one.x, age, 'once') : stand(sway, one.x, age - grown))
  }
  for (const one of scene.mushrooms) {
    const rising = DECOR.items.mushroom_a_appear
    const age = scene.clock - one.born
    parts.push(
      age < rising.frames.length * rising.ms
        ? stand('mushroom_a_appear', one.x, age, 'once')
        : stand(MUSHROOMS[one.kind] ?? 'mushroom_a', one.x),
    )
  }
  if (isFeasting()) {
    // The wave of an RGB keyboard: two crests of squares, each column bobbing a
    // little after its neighbour, and the hue of the whole turning.
    const air = floor - 6
    for (let crest = 0; crest < 2; crest += 1) {
      const period = 1500 + crest * 500
      for (let x = 2; x < SVG_WIDTH; x += 7) {
        const lag = -(((x * (9 + crest * 4) + scene.clock) % (period * 2)) + crest * 400)
        parts.push(
          `<rect x="${x}" y="2" width="3" height="3" fill="hsl(${(x * 3 + crest * 150) % 360} 90% 60%)" ` +
            `style="animation:bob-${crest} ${period}ms ease-in-out ${lag}ms infinite alternate"/>`,
        )
      }
      rules.set(`bob-${crest}`, `@keyframes bob-${crest}{from{transform:translateY(0)}to{transform:translateY(${air - 8}px)}}`)
    }
    parts.push(stand('lasagne', SVG_WIDTH - 44))
  }

  // The cat, sliding to where it is headed while its frames step.
  parts.push(
    `<g class="at"><svg y="${SVG_TOP}" width="${drawn.w}" height="${drawn.h}" viewBox="0 0 ${drawn.w} ${drawn.h}">` +
      `<g${actor.beat.isFlipped ? ` transform="translate(${drawn.w},0) scale(-1,1)"` : ''}>` +
      `<image class="reel" width="${drawn.w * drawn.across}" height="${drawn.h * drawn.down}" ` +
      `href="data:image/png;base64,${drawn.png}"/></g></svg></g>`,
  )
  const headX = actor.beat.isFlipped ? to + 10 : to + drawn.w - 12
  if (actor.beat.clip === 'sleep') parts.push(piece('zzz', headX - 4, SVG_TOP - 8))

  // Before the cat: the grass, the ladybird on its way, the butterfly, what is playing.
  for (const one of scene.front) parts.push(stand(one.item, one.x, scene.clock + one.x * 97))
  const walk = (SVG_WIDTH + 32) * DECOR.items.beetle.ms
  parts.push(
    `<g style="animation:cross ${walk}ms linear ${-(scene.clock % walk)}ms infinite">${stand('beetle', -16)}</g>`,
  )
  parts.push(
    `<g style="animation:flutter-x 9100ms ease-in-out ${-(scene.clock % 18_200)}ms infinite alternate">` +
      `<g style="animation:flutter-y 2600ms ease-in-out ${-(scene.clock % 5200)}ms infinite alternate">` +
      `${piece('butterfly', 0, 0)}</g></g>`,
  )
  for (const one of scene.effects) {
    const age = scene.clock - one.born
    if (age >= 0) parts.push(piece(one.item, one.x, SVG_TOP + one.y, age, 'fades'))
  }

  // What the cat says, beside where it is headed.
  if (scene.lines.length > 0) {
    const wide = Math.max(...scene.lines.map(one => one.length)) * 4.3 + 12
    const isRight = to + drawn.w + wide <= SVG_WIDTH
    const left = isRight ? to + drawn.w - 6 : Math.max(0, to - wide + 6)
    const tall = scene.lines.length * 8 + 6
    const rows = scene.lines.map((one, at) => `<text x="${left + 6}" y="${9 + at * 8}">${escaped(one)}</text>`).join('')
    parts.push(
      `<rect x="${left}" y="1" width="${wide}" height="${tall}" rx="3" fill="${ground ?? '#10141f'}" ` +
        `stroke="#6b7699" stroke-width="0.6"/><g font-family="ui-monospace,monospace" font-size="6.5" ` +
        `fill="${stage.ink || '#e6eaf5'}">${rows}</g>`,
    )
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${height}" width="100%">` +
    `<style>` +
    `image{image-rendering:pixelated}` +
    `.at{animation:go ${Math.max(1, Math.round(travel))}ms linear forwards}` +
    `.reel{animation:play ${reel}ms step-end infinite}` +
    `@keyframes go{from{transform:translate(${from}px,0)}to{transform:translate(${to}px,0)}}` +
    `@keyframes play{${steps}}` +
    `@keyframes gone{to{opacity:0}}` +
    `@keyframes drift{from{transform:translate(-40px,0)}to{transform:translate(${SVG_WIDTH}px,0)}}` +
    `@keyframes cross{from{transform:translate(0,0)}to{transform:translate(${SVG_WIDTH + 32}px,0)}}` +
    `@keyframes flutter-x{from{transform:translate(30px,0)}to{transform:translate(${SVG_WIDTH - 50}px,0)}}` +
    `@keyframes flutter-y{from{transform:translate(0,4px)}to{transform:translate(0,${Math.max(8, floor - 34)}px)}}` +
    [...rules.values()].join('') +
    `</style>` +
    `<defs><image id="d" width="${DECOR.sheet[0]}" height="${DECOR.sheet[1]}" href="data:image/png;base64,${DECOR.png}"/></defs>` +
    (ground === undefined ? '' : `<rect width="${SVG_WIDTH}" height="${height}" fill="${ground}"/>`) +
    parts.join('') +
    `</svg>`
  )
}

// ------------------------------------------------------------------ the scene

// <decor> generated by scripts/build-sprites.py from assets/decor/ — do not edit
const DECOR = {
  ink: 'abcdefghijklmno',
  sheet: [256, 368],
  png: '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',
  palette: [0x8fd14f, 0x4f9a3a, 0xc08a3e, 0x7a4524, 0x2f6b34, 0xf2c230, 0x8a6fd8, 0xf28fa0, 0xd8463c, 0xf6b56b, 0xe8873a, 0x6d6a7c, 0xc9cfe0, 0x2c2b34, 0x3b4a5e],
  items: {
    ground_a: { at: [0, 0], w: 16, h: 16, ms: 1, box: [0, 12, 16, 4], frames: ['................................................................................................................................................................................................aaabaaaaabaaaaaabbbbbcbbbbbbbcbbccccccccdcccccccccdcccccccccdccc'] },
    ground_b: { at: [16, 0], w: 16, h: 16, ms: 1, box: [0, 12, 16, 4], frames: ['................................................................................................................................................................................................aaaaabaaaaaabaaabbcbbbbbbcbbbbbbccccdccccccccccccccccccccddccccc'] },
    ground_c: { at: [32, 0], w: 16, h: 16, ms: 1, box: [0, 12, 16, 4], frames: ['................................................................................................................................................................................................aabaaaaaaaabaaaabbbbbbccbbbbbbbbccccccccccccdccccdcccccccccccccc'] },
    grass_short: { at: [0, 16], w: 16, h: 16, ms: 450, box: [4, 12, 7, 4], frames: ['....................................................................................................................................................................................................b..b..b.........b.ba.ba.........abbabab.........eebeebe.....', '.....................................................................................................................................................................................................b..b.b.........b.ab.ab.........bababba.........eebeebe.....'] },
    grass_medium: { at: [0, 32], w: 16, h: 16, ms: 450, box: [4, 11, 8, 5], frames: ['......................................................................................................................................................................................b...b.........b.b.b.a.........bab.bab.........ababbabb........eebeebee....', '.......................................................................................................................................................................................b...b.........b.b.ba.........bab.bab.........ababbabb........eebeebee....'] },
    grass_tall: { at: [0, 48], w: 16, h: 16, ms: 450, box: [3, 10, 9, 6], frames: ['.....................................................................................................................................................................b....b..........b..b.b........b.ab.b.a........babb.abba.......abbababab.......eebeeebee....', '......................................................................................................................................................................b....b.........b..b.b........b.ba.b.a........babb.abba.......abbababab.......eebeeebee....'] },
    grass_sparse: { at: [0, 64], w: 16, h: 16, ms: 450, box: [2, 12, 11, 4], frames: ['...................................................................................................................................................................................................b....b.........ba...ba..b......ab...ab..ab.....ee...ee..ee...', '..................................................................................................................................................................................................b......b........ab...ba...b.....ab...ab..ab.....ee...ee..ee...'] },
    flower_yellow_grow: { at: [0, 80], w: 16, h: 16, ms: 260, box: [4, 6, 7, 10], frames: ['......................................................................................................................................................................................................a.a..............ba..............b..............ebe.......', '.......................................................................................................................................................f..............fff..............b...............b.a...........a.bab............ab..............ebe.......', '......................................................................................................f.f............fffff..........fffdfff..........fffff............f.f..............b...............b.a...........a.bab............ab..............ebe.......'] },
    flower_yellow_sway: { at: [48, 80], w: 16, h: 16, ms: 420, box: [3, 6, 9, 10], frames: ['.....................................................................................................f.f............fffff..........fffdfff..........fffff............f.f..............b................b.a...........a.bab............ab..............ebe.......', '.......................................................................................................f.f............fffff..........fffdfff..........fffff............f.f..............b..............b.a...........a.bab............ab..............ebe.......'] },
    flower_violet_grow: { at: [0, 96], w: 16, h: 16, ms: 260, box: [4, 6, 7, 10], frames: ['......................................................................................................................................................................................................a.a..............ba..............b..............ebe.......', '.......................................................................................................................................................g..............ggg..............b...............b.a...........a.bab............ab..............ebe.......', '......................................................................................................g.g............ggggg..........gggfggg..........ggggg............g.g..............b...............b.a...........a.bab............ab..............ebe.......'] },
    flower_violet_sway: { at: [48, 96], w: 16, h: 16, ms: 420, box: [3, 6, 9, 10], frames: ['.....................................................................................................g.g............ggggg..........gggfggg..........ggggg............g.g..............b................b.a...........a.bab............ab..............ebe.......', '.......................................................................................................g.g............ggggg..........gggfggg..........ggggg............g.g..............b..............b.a...........a.bab............ab..............ebe.......'] },
    flower_pink_grow: { at: [0, 112], w: 16, h: 16, ms: 260, box: [4, 6, 7, 10], frames: ['......................................................................................................................................................................................................a.a..............ba..............b..............ebe.......', '.......................................................................................................................................................h..............hhh..............b...............b.a...........a.bab............ab..............ebe.......', '......................................................................................................h.h............hhhhh..........hhhfhhh..........hhhhh............h.h..............b...............b.a...........a.bab............ab..............ebe.......'] },
    flower_pink_sway: { at: [48, 112], w: 16, h: 16, ms: 420, box: [3, 6, 9, 10], frames: ['.....................................................................................................h.h............hhhhh..........hhhfhhh..........hhhhh............h.h..............b................b.a...........a.bab............ab..............ebe.......', '.......................................................................................................h.h............hhhhh..........hhhfhhh..........hhhhh............h.h..............b..............b.a...........a.bab............ab..............ebe.......'] },
    mushroom_a: { at: [0, 128], w: 16, h: 16, ms: 1, box: [4, 9, 8, 7], frames: ['......................................................................................................................................................iiii...........ijiiii.........iiiiijii........diiiiiid..........djjd............jjjd...........djjjjd.....'] },
    mushroom_b: { at: [16, 128], w: 16, h: 16, ms: 1, box: [5, 8, 6, 8], frames: ['.......................................................................................................................................kk.............kkkk...........kkjkkk..........dddddd............jd..............jd..............jd.............jjdd......'] },
    mushroom_a_appear: { at: [32, 128], w: 16, h: 16, ms: 140, box: [4, 11, 8, 5], frames: ['.......................................................................................................................................................................................................................................ii............ciiiic.....', '......................................................................................................................................................................................................................iiii...........ijiiii.........ciiiiijc....', '......................................................................................................................................................................................iiii...........ijiiii.........iiiiijii........diiiiiid........c.djjd.c....'] },
    rock_a: { at: [0, 144], w: 16, h: 16, ms: 1, box: [4, 12, 7, 4], frames: ['......................................................................................................................................................................................................lll............lmlll..........lllllln.........nllllnn.....'] },
    rock_b: { at: [16, 144], w: 16, h: 16, ms: 1, box: [5, 13, 5, 3], frames: ['......................................................................................................................................................................................................................lml............lllln...........nllnn......'] },
    bush: { at: [0, 160], w: 32, h: 16, ms: 1, box: [4, 3, 25, 13], frames: ['...............................................................................................................e............................eeebeee........................ebaabbbbe..e..................e.eaaaabbbbeebeee............eeebebaaaabbbbaabbbbe..........ebaabbbaaaabbbaaaabbbe..........eaaaabbbaaaabbaaaabbbe..........eaaaabbbaaaabbbaabbbbbe........ebbaabbbbaaaabbbbbbbbbbbe.......ebbbbbbbbaaaabbbbbbbbbbbe.......eeeeeeeeeeeeeeeeeeeeeeeee.......eeeeeeeeeeeeeeeeeeeeeeeee........eeeeeeeeeeeeeeee.eeeeee....'] },
    signpost: { at: [0, 176], w: 32, h: 16, ms: 1, box: [2, 2, 28, 14], frames: ['......................................................................cc................cc............cc................cc........dddddddddddddddddddddddddddd....dddddddddddddddddddddddddddd....dddddddddddddddddddddddddddd....dddddddddddddddddddddddddddd....dddddddddddddddddddddddddddd....dddddddddddddddddddddddddddd........cc................cc............cc................cc............cc................cc............cc................cc............cc................cc............cc................cc......'] },
    butterfly: { at: [0, 192], w: 16, h: 16, ms: 90, box: [4, 5, 7, 6], frames: ['....................................................................................ggg.ggg.........ghgdghg.........gggdggg..........ggdgg...........gh.hg............g.g.......................................................................................', '.....................................................................................................ggdgg...........ghdhg............gdg.............hgh.......................................................................................................', '......................................................................................................gdg.............gdg.............gdg..............h........................................................................................................', '....................................................................................................g..d..g.........gggdggg.........ghgdghg..........gg.gg............g.g.......................................................................................'] },
    beetle: { at: [0, 208], w: 16, h: 16, ms: 120, box: [4, 11, 8, 5], frames: ['......................................................................................................................................................................................iii............iiniinn........iniiiinn........iiinii...........l.l.l......', '......................................................................................................................................................................................iii............iiniinn........iniiiinn........iiinii..........l..l..l.....', '......................................................................................................................................................................................iii............iiniinn........iniiiinn........iiinii............l.l.l.....', '......................................................................................................................................................................................iii............iiniinn........iniiiinn........iiinii...........l..l..l....'] },
    sun: { at: [0, 224], w: 16, h: 16, ms: 1, box: [1, 1, 13, 13], frames: ['.......................k...............k...........k.kkkkk.k........kkfffkk........kkfffffkk.......kfffffffk.....kkkfffffffkkk.....kfffffffk.......kkfffffkk........kkfffkk........k.kkkkk.k...........k...............k........................................'] },
    moon: { at: [16, 224], w: 16, h: 16, ms: 1, box: [3, 3, 8, 9], frames: ['.....................................................kk.............kjk............kjk.............kjk.............kjk.............kjjk............kjjjk............kjjjkkk..........kkkkk......................................................................'] },
    cloud_a: { at: [0, 240], w: 32, h: 16, ms: 1, box: [4, 2, 26, 11], frames: ['.............................................................................lll...........................llmmmll........................lmmmmmmmllllll................l.lmmmmmmmmmmmmml.............llmlmmmmmmmmmmmmmmml...........lmmmmmmmmmmmmmmmmmmmml..........lmmmmmmmmmmmmmmmmmmmmmll.......lmmmmmmmmmmmmmmmmmmmmmmml........lmmmmmmmmmmmmmmmmmmmmmmml.......lmmmmmllmmmlllmmmmmmmmml.........lllll..lll...llllllllll...................................................................................................'] },
    cloud_b: { at: [32, 240], w: 32, h: 16, ms: 1, box: [6, 4, 20, 8], frames: ['..............................................................................................................................................lll.........................l..lmmml..lll.................llmllmmmmmllmmml................lmmmmmmmmmmmmmmml..............lmmmmmmmmmmmmmmmml.............lmmmmmmlmmmllmmmmmml............lmmmmll.lll..lmmmmml............lllll.........llllll......................................................................................................................................'] },
    star: { at: [0, 256], w: 16, h: 16, ms: 600, box: [5, 5, 5, 5], frames: ['.......................................................................................k...............f.............kfffk.............f...............k........................................................................................................', '.......................................................................................................k..............kfk..............k........................................................................................................................'] },
    hills: { at: [0, 272], w: 32, h: 16, ms: 1, box: [0, 7, 32, 9], frames: ['..................................................................................................................................................................................................................................ooooo.........................ooooooooooo...ooo...............ooooooooooooooooooo............oooooooooooooooooooooo.........oooooooooooooooooooooooo.......oooooooooooooooooooooooooo.....oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo'] },
    tree: { at: [0, 288], w: 16, h: 16, ms: 1, box: [1, 1, 15, 15], frames: ['......................ooooo..........ooooooo........ooooooooo.......ooooooooo......ooooooooooo....ooooooooooooo...ooooooooooooo..ooooooooooooooo..ooooooooooooo...ooooooooooooo....oooooo.oooo.........oo..............oo..............oo.............oooo......'] },
    lasagne: { at: [0, 304], w: 16, h: 16, ms: 220, box: [0, 0, 16, 16], frames: ['..........l............l...l...........l...l..........l...l..........l...l...........l...l............l............................jjkjjjkjjk......iikiiiikii......jjjjjjjjjj.....liiiiiiiiiil...llllllllllllll.llmmllllllllllll..llllllllllll.....llllllllll...', '...........l..........l...l..........l...l...........l...l............l...l............l...l...........l...........................jjkjjjkjjk......iikiiiikii......jjjjjjjjjj.....liiiiiiiiiil...llllllllllllll.llmmllllllllllll..llllllllllll.....llllllllll...', '.........l...........l...l............l...l............l...l...........l...l..........l...l..........l.............................jjkjjjkjjk......iikiiiikii......jjjjjjjjjj.....liiiiiiiiiil...llllllllllllll.llmmllllllllllll..llllllllllll.....llllllllll...'] },
    sparkle: { at: [0, 320], w: 16, h: 16, ms: 90, box: [4, 4, 7, 7], frames: ['.......................................................................................................k..............kfk..............k........................................................................................................................', '.......................................................................................k...............f.............kfjfk.............f...............k........................................................................................................', '.......................................................................k.............k.f.k.............f............kffjffk............f.............k.f.k.............k........................................................................................', '.......................................................................k.............k...k..........................k.....k..........................k...k.............k........................................................................................'] },
    dust: { at: [0, 336], w: 16, h: 16, ms: 110, box: [3, 11, 10, 5], frames: ['......................................................................................................................................................................................................ll.............lmml...........lmmmmll..........llllll.....', '.......................................................................................................................................................................................ll............llmml..........lmmmmmll.......lmmlmmmml........ll.llll.....', '......................................................................................................................................................................................l..l..........l..ll..l.......l.lm..ml.........l..l...l.........l...l......', '....................................................................................................................................................................................l......l...........l...........l........l............l......................'] },
    zzz: { at: [0, 352], w: 16, h: 16, ms: 400, box: [0, 0, 15, 15], frames: ['................................................................................................................................................................................gggg..............g..............g..............gggg............................', '....................................................................................ggggg..............g..............g..............g..............ggggg.......................gggg..............g..............g..............gggg............................', '.........gggggg..............g..............g..............g..............g.........ggggggggggg........g..............g..............g..............ggggg.......................gggg..............g..............g..............gggg............................'] },
  },
} as const
// </decor>

type DecorName = keyof typeof DECOR.items

/** The ground under the cat, in cell rows: a tile of the sheet is four pixels tall. */
const GROUND_ROWS = 2

/** The cat's rows, then the ground it stands on. */
const stripRows = () => catRows() + GROUND_ROWS

/** What the scene is painted with, beside the sheets' own palettes. */
const SCENE = {
  hurt: [0xff6b7a, 0xc8283a],
}

/** One thing adrift over the scene, a character a cell: the crosses of a failed call. */
type Speck = { x: number; y: number; dx: number; dy: number; age: number; life: number; glyph: number; colors: readonly number[] }

/** A piece of the sheet standing in the scene, by its left edge in pixels. */
type Prop = { item: DecorName; x: number }

/** A piece of the sheet played once where something happened: dust, a sparkle. */
type Effect = { item: DecorName; x: number; y: number; born: number }

/** Something that grew in the meadow for what the session did, and when. */
type Growth = { x: number; kind: number; born: number }

/** The scene around the cat: module values, as the cat's own are. */
const scene = {
  clock: 0,
  specks: [] as Speck[],
  effects: [] as Effect[],
  /** What the cat says, wrapped, and until when on the scene's clock. */
  lines: [] as string[],
  saysUntil: 0,
  saidAt: 0,
  /** Until when, on the scene's clock, the lasagne is out and the cat beside itself. */
  feastUntil: 0,
  /** The grass laid for a strip this wide and a cat this size. */
  front: [] as Prop[],
  /** Where a bloom or a mushroom may come up, in the order they do. */
  plots: [] as number[],
  laidFor: 0,
  /** A bloom a finished todo, a mushroom a failed call: told by the last render. */
  done: 0,
  fails: 0,
  blooms: [] as Growth[],
  mushrooms: [] as Growth[],
  isDirty: false,
}

const glyphOf = (text: string) => text.codePointAt(0) ?? 0x20

const isFeasting = () => scene.clock < scene.feastUntil

/** A full-bright hue at `glow`, 0 to 1, over `ground`: a key of the keyboard, lit so far. */
const lit = (hue: number, glow: number, ground: number) => {
  const turn = (((hue % 360) + 360) % 360) / 60
  const rise = 1 - Math.abs((turn % 2) - 1)
  const [r, g, b] =
    turn < 1 ? [1, rise, 0] : turn < 2 ? [rise, 1, 0] : turn < 3 ? [0, 1, rise] : turn < 4 ? [0, rise, 1] : turn < 5 ? [rise, 0, 1] : [1, 0, rise]
  const mix = (channel: number, shift: number) => {
    const under = (ground >> shift) & 255

    return Math.round(under + (channel * 255 - under) * Math.min(1, glow))
  }

  return (mix(r, 16) << 16) | (mix(g, 8) << 8) | mix(b, 0)
}

/** How long a dish of lasagne lasts. */
const FEAST_MS = 60_000

/** Serves the lasagne, or clears the table. */
const feast = (isServed: boolean) => {
  scene.feastUntil = isServed ? scene.clock + FEAST_MS : 0
  actor.isCalled = true
  pet.isAsleep = false
  scene.isDirty = true
  if (isServed) say(stage.coat === 'garfield' ? 'LASAGNES !!!' : 'Des lasagnes ?!', 4000)
}

/** A small repeatable generator: the same strip width grows the same meadow. */
const seeded = (seed: number) => {
  let state = (seed * 2654435761) >>> 0

  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2246822507) + 0x9e3779b9) >>> 0

    return state / 4294967296
  }
}

const GRASS: readonly DecorName[] = ['grass_short', 'grass_medium', 'grass_tall', 'grass_sparse']
const BLOOMS: readonly [DecorName, DecorName][] = [
  ['flower_yellow_grow', 'flower_yellow_sway'],
  ['flower_violet_grow', 'flower_violet_sway'],
  ['flower_pink_grow', 'flower_pink_sway'],
]
const MUSHROOMS: readonly DecorName[] = ['mushroom_a', 'mushroom_b']

/** The meadow for a strip `columns` wide: tufts of grass before the cat, and the plots between them. */
const layMeadow = (columns: number) => {
  const next = seeded(columns)
  const pick = <T,>(from: readonly T[]) => from[Math.floor(next() * from.length)] as T
  const cell = 16
  const front: Prop[] = []
  const plots: number[] = []
  // Grass in front, in tufts of every kind, and between the tufts the plots.
  for (let x = 2 + Math.floor(next() * 8); x < columns - 10; x += 9 + Math.floor(next() * 10)) {
    if (next() < 0.38) plots.push(x)
    else front.push({ item: pick(GRASS), x })
  }
  // The plots come up in a shuffled order, so the meadow fills evenly.
  for (let at = plots.length - 1; at > 0; at -= 1) {
    const other = Math.floor(next() * (at + 1))
    const held = plots[at] ?? 0
    plots[at] = plots[other] ?? 0
    plots[other] = held
  }
  scene.front = front
  scene.plots = plots
  scene.laidFor = columns * 64 + catRows()
  scene.blooms = []
  scene.mushrooms = []
}

/** Lays the meadow for this width if it is not, and lets grow what the session earned. */
const tend = (columns: number) => {
  if (scene.laidFor !== columns * 64 + catRows()) layMeadow(columns)
  // A bloom a finished todo, a mushroom a failed call, each in its plot.
  while (scene.blooms.length < Math.min(scene.done, scene.plots.length)) {
    scene.blooms.push({ x: scene.plots[scene.blooms.length] ?? 0, kind: scene.blooms.length % BLOOMS.length, born: scene.clock })
  }
  scene.blooms.length = Math.min(scene.blooms.length, scene.done)
  const spare = scene.plots.slice(Math.min(scene.done, scene.plots.length)).reverse()
  while (scene.mushrooms.length < Math.min(scene.fails, spare.length, 6)) {
    scene.mushrooms.push({ x: spare[scene.mushrooms.length] ?? 0, kind: scene.mushrooms.length % MUSHROOMS.length, born: scene.clock })
  }
  scene.mushrooms.length = Math.min(scene.mushrooms.length, scene.fails)
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
  if (scene.specks.length > 90) scene.specks.splice(0, scene.specks.length - 90)
}

/** Plays a piece of the sheet once, where the cat is: dust at its feet, sparkles round its head. */
const play = (item: 'dust' | 'sparkle', count = 1) => {
  const columns = stage.columns || 80
  const head = headAt(columns)
  const cell = 16
  for (let k = 0; k < count; k += 1) {
    scene.effects.push(
      item === 'dust'
        ? { item, x: head.left + catColumns() / 2 - cell / 2 - actor.heading * 8 * catScale(), y: catRows() * 2 - cell, born: scene.clock }
        : {
            item,
            x: head.x - cell / 2 + (Math.random() - 0.5) * 14 * catScale(),
            y: Math.max(0, head.row * 2 - cell / 2 + (Math.random() - 0.5) * 8 * catScale()),
            born: scene.clock + k * 90,
          },
    )
  }
  if (scene.effects.length > 24) scene.effects.splice(0, scene.effects.length - 24)
  scene.isDirty = true
}

/** Only what a Raster cell takes for sure: Latin letters, digits, plain punctuation. */
const plain = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/[^ -~ -ſ]/g, '')
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
  scene.saidAt = scene.clock
  scene.saysUntil = scene.clock + ms
  scene.isDirty = true
}

/** The meadow breathes at this pace: grass sways, the beetle walks, the clouds drift. */
const AMBIENT_MS = 120

/** Moves the scene on by `ms`; true when what is drawn changed. */
const stepScene = (ms: number) => {
  const before = Math.floor(scene.clock / AMBIENT_MS)
  const wasFeasting = isFeasting()
  scene.clock += ms
  let hasMoved = scene.isDirty
  scene.isDirty = false
  if (wasFeasting && !isFeasting()) {
    // The dish is done: back to what the agent's state asks of it.
    actor.isCalled = true
    say('Burp.', 3000)
    hasMoved = true
  }
  // The wave rolls on every frame of a feast.
  if (isFeasting()) hasMoved = true
  if (scene.specks.length > 0) {
    for (const one of scene.specks) {
      one.age += ms
      one.x += one.dx
      one.y += one.dy
    }
    scene.specks = scene.specks.filter(one => one.age < one.life && one.y > -1)
    hasMoved = true
  }
  if (scene.effects.length > 0) {
    scene.effects = scene.effects.filter(
      one => scene.clock - one.born < DECOR.items[one.item].frames.length * DECOR.items[one.item].ms,
    )
    hasMoved = true
  }
  if (scene.lines.length > 0 && scene.clock >= scene.saysUntil) {
    scene.lines = []
    hasMoved = true
  }
  if (Math.floor(scene.clock / AMBIENT_MS) !== before) hasMoved = true

  return hasMoved
}

/**
 * The strip as Raster cells, `columns` wide and stripRows() tall. The scene is
 * composed in pixels, two a cell — the sky, the meadow behind, the cat, the grass
 * before it — then turned into half blocks, and what is written in characters
 * (the wave, what the cat says) goes over the cells last.
 */
const spriteStrip = (columns: number, ground: string, ink: string, mood: string) => {
  tend(columns)
  const base = rgb(ground)
  const pen = rgb(ink)
  const rows = stripRows()
  const tall = rows * 2
  const floor = catRows() * 2
  // The decor keeps its own size whatever the cat's: beside the big cat it is a small meadow.
  const scale = 1
  const cell = 16
  const pixels = new Int32Array(columns * tall).fill(-1)
  const dot = (x: number, y: number, color: number) => {
    if (x >= 0 && x < columns && y >= 0 && y < tall) pixels[y * columns + x] = color
  }
  /** Lays one frame of a piece of the decor sheet, its top left at (left, top), each pixel `by` wide. */
  const stamp = (name: DecorName, frame: number, left: number, top: number, by = scale) => {
    const item = DECOR.items[name]
    const drawn = item.frames[frame % item.frames.length] ?? item.frames[0]
    for (let y = 0; y < item.h; y += 1) {
      for (let x = 0; x < item.w; x += 1) {
        const seen = drawn[y * item.w + x] ?? '.'
        if (seen === '.') continue
        const color = DECOR.palette[DECOR.ink.indexOf(seen)] ?? base
        for (let dy = 0; dy < by; dy += 1) {
          for (let dx = 0; dx < by; dx += 1) dot(Math.round(left) + x * by + dx, Math.round(top) + y * by + dy, color)
        }
      }
    }
  }
  /** Stands a piece on the ground, the foot of its case on the floor line. */
  const stand = (name: DecorName, frame: number, left: number) => stamp(name, frame, left, floor - cell)
  const beat = (name: DecorName) => Math.floor(scene.clock / DECOR.items[name].ms)

  // The sky: by day the sun and clouds adrift, by night the moon and stars.
  const hour = new Date().getHours()
  const isDay = hour >= 7 && hour < 20
  stamp(isDay ? 'sun' : 'moon', 0, columns - cell - 2, 0)
  if (isDay) {
    const lane = columns + 2 * cell
    stamp('cloud_b', 0, ((scene.clock * 0.003 + columns * 0.3) % lane) - 2 * cell, 0)
  } else {
    const sky = seeded(columns + 7)
    for (let k = 0; k < Math.floor(columns / 14); k += 1) {
      stamp('star', beat('star') + k, sky() * (columns - cell), sky() * Math.max(1, floor - cell - 6))
    }
  }

  // The ground: three tiles, the same three in the same order for a given width.
  const tiles = seeded(columns + 3)
  for (let x = 0; x < columns; x += 16) {
    const tile = DECOR.items[(['ground_a', 'ground_b', 'ground_c'] as const)[Math.floor(tiles() * 3)] ?? 'ground_a']
    for (let y = 0; y < GROUND_ROWS * 2; y += 1) {
      for (let dx = 0; dx < 16; dx += 1) {
        const seen = tile.frames[0][(12 + y) * 16 + dx] ?? '.'
        if (seen !== '.') dot(x + dx, floor + y, DECOR.palette[DECOR.ink.indexOf(seen)] ?? base)
      }
    }
  }

  // Behind the cat: what grew, and the dish.
  for (const one of scene.blooms) {
    const [grow, sway] = BLOOMS[one.kind] ?? BLOOMS[0]!
    const age = scene.clock - one.born
    const grown = DECOR.items[grow].frames.length * DECOR.items[grow].ms
    if (age < grown) stand(grow, Math.floor(age / DECOR.items[grow].ms), one.x)
    else stand(sway, Math.floor((age - grown) / DECOR.items[sway].ms), one.x)
  }
  for (const one of scene.mushrooms) {
    const rising = DECOR.items.mushroom_a_appear
    const age = scene.clock - one.born
    if (age < rising.frames.length * rising.ms) stand('mushroom_a_appear', Math.floor(age / rising.ms), one.x)
    else stand(MUSHROOMS[one.kind] ?? 'mushroom_a', 0, one.x)
  }
  if (isFeasting()) stand('lasagne', beat('lasagne'), Math.max(1, columns - cell - 10 * scale))

  // The cat, in its own sheet's colors.
  const drawn = sheet()
  const clip = drawn.clips[actor.beat.clip]
  const frame = clip.frames[actor.beat.frames[actor.at] ?? 0] ?? clip.frames[0]
  const letters: string = drawn.ink
  const palette: readonly number[] = drawn.palette
  const left = Math.round(Math.max(0, Math.min(actor.x, columns - catColumns())))
  for (let y = 0; y < drawn.h; y += 1) {
    for (let x = 0; x < drawn.w; x += 1) {
      const seen = frame[y * drawn.w + (actor.beat.isFlipped ? drawn.w - 1 - x : x)] ?? '.'
      if (seen !== '.') dot(left + x, y, palette[letters.indexOf(seen)] ?? base)
    }
  }
  const head = headAt(columns)
  if (actor.beat.clip === 'sleep') stamp('zzz', beat('zzz'), head.x, Math.max(0, floor - drawn.h))

  // Before the cat: the grass, the beetle on its way, the butterfly, what is playing.
  for (const one of scene.front) stand(one.item, beat(one.item) + one.x, one.x)
  const walked = (Math.floor(scene.clock / DECOR.items.beetle.ms) * scale) % (columns + 2 * cell)
  stand('beetle', beat('beetle'), walked - cell)
  stamp(
    'butterfly',
    beat('butterfly'),
    columns * 0.5 + Math.sin(scene.clock / 2900) * columns * 0.38 - cell / 2,
    Math.max(0, (floor - cell) * (0.35 + 0.3 * Math.sin(scene.clock / 830))),
  )
  for (const one of scene.effects) {
    const age = scene.clock - one.born
    if (age >= 0) stamp(one.item, Math.floor(age / DECOR.items[one.item].ms), one.x, one.y)
  }

  // Pixels to cells: the lower half block, its ink the bottom pixel, its ground the top.
  const total = columns * rows
  const glyphs = new Uint32Array(total).fill(0x20)
  const fore = new Uint32Array(total).fill(base)
  const back = new Uint32Array(total).fill(base)
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = pixels[row * 2 * columns + x] ?? -1
      const bottom = pixels[(row * 2 + 1) * columns + x] ?? -1
      if (top < 0 && bottom < 0) continue
      const at = row * columns + x
      glyphs[at] = LOWER_HALF
      fore[at] = bottom < 0 ? base : bottom
      back[at] = top < 0 ? base : top
    }
  }
  /** Writes a character in a cell; `isOver` false leaves a cell the picture already fills. */
  const put = (row: number, x: number, glyph: number, color: number, behind = base, isOver = true) => {
    if (row < 0 || row >= rows || x < 0 || x >= columns) return
    const at = row * columns + x
    if (!isOver && glyphs[at] !== 0x20) return
    glyphs[at] = glyph
    fore[at] = color
    back[at] = behind
  }

  // The air of a feast: a wave of lit squares rolling across, as over the keys of
  // an RGB keyboard — two crests out of step, the hue sweeping with them.
  if (isFeasting()) {
    const air = catRows() - 1
    const middle = (air - 1) / 2
    for (let x = 0; x < columns; x += 2) {
      const hue = (x * 5 + scene.clock * 0.14) % 360
      for (let crest = 0; crest < 2; crest += 1) {
        const swing = Math.sin(x * (0.16 + crest * 0.05) - scene.clock * (0.005 + crest * 0.002) + crest * 2.1)
        const peak = middle + swing * middle * 0.9
        for (let row = 0; row < air; row += 1) {
          const glow = 1 - Math.abs(row - peak) / 1.7
          // Twelve hues, three glows: the Raster has only so many colors to give.
          if (glow > 0.12) put(row, x, glyphOf('■'), lit(Math.round((hue + crest * 150) / 30) * 30, Math.ceil(glow * 3) / 3, base), base, false)
        }
      }
    }
  }

  for (const one of scene.specks) {
    const shade = one.colors[Math.min(one.colors.length - 1, Math.floor((one.age / one.life) * one.colors.length))]
    put(Math.round(one.y), Math.round(one.x), one.glyph, shade ?? pen, base, false)
  }

  // What it says, in a frame beside its head: on the side with room.
  if (scene.lines.length > 0) {
    const framed = Math.max(...scene.lines.map(one => one.length)) + 4
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

  if (mood && scene.lines.length === 0) {
    put(0, actor.beat.isFlipped ? left + 1 : left + catColumns() - 2, glyphOf(mood), pen)
  }

  const words = new Uint32Array(total * 3)
  for (let at = 0; at < total; at += 1) {
    words[at * 3] = glyphs[at] ?? 0x20
    words[at * 3 + 1] = fore[at] ?? base
    words[at * 3 + 2] = back[at] ?? base
  }

  return toBase64(new Uint8Array(words.buffer))
}

// ------------------------------------------------------------ bao's universe

/**
 * The panda's own world, after the design "Univers · Bao le panda": a bamboo
 * grove by the water, at night. One cell of the design is one pixel here, two
 * to a terminal row. Bao wanders, rolls to a sprout as a ball, eats it and is
 * rewarded; a sprout comes up for each todo finished, or on request.
 */
const BAO_TALL = 30
const BAO_ROWS = BAO_TALL / 2
const BAO_GROUND = 23

const BAO_HEAD = [
  '.KK........KK.',
  'KKKKWWWWWWKKKK',
  '.KKWWWWWWWWKK.',
  '.WWWWWWWWWWWW.',
  'WWKKKWWWWKKKWW',
  'EYES',
  'WKKKWWWWWWKKKW',
  'WPWWWWKKWWWWPW',
  'MOUTH',
  '..GWWWWWWWWG..',
] as const
const BAO_BODY = ['.KKKWWWWWWKKK.', 'KKKKWWWWWWKKKK', 'KKKWWWWWWWWKKK', '.KKWWWWWWWWKK.'] as const
const BAO_LEGS = {
  a: ['..KKKK..KKKK..', '..KKK....KKK..'],
  b: ['..KKKK..KKKK..', '...KK....KKK..'],
  c: ['..KKKK..KKKK..', '..KKK....KK...'],
  sit: ['.KKKKWWWWKKKK.', 'KKKK......KKKK'],
} as const
const BAO_EYES = { c: 'WKKEKWWWWKEKKW', r: 'WKKKEWWWWKKKEW', l: 'WEKKKWWWWEKKKW', x: 'WKKKKWWWWKKKKW' } as const
const BAO_INK: Record<string, number> = { K: 0x0b0b0c, W: 0xf2efe8, G: 0xc9c5bc, P: 0xfcd1ff, E: 0xf2efe8 }
const BAO_NIGHT = {
  sky: 0x272b34,
  hillBack: 0x2e3540,
  hillFront: 0x333b47,
  rim: 0x3d4452,
  stalkBack: 0x2f4a40,
  nodeBack: 0x28403a,
}
const BAO_SAYS = {
  roll: ['mode boule activé.', 'roulade !', 'trop lent à pied.'],
  land: ['réception parfaite.', '10/10 du jury.', 'encore une ?'],
  walk: ['sprint en cours.', 'direction : le bambou le plus proche.', 'pas de course, pas de bruit.'],
  idle: ['vent faible. feuilles calmes.', 'je compte les lucioles : {n}.', 'rien à signaler.'],
  eat: ['bambou frais. humeur : excellente.', 'crunch. crunch.', 'pousse livrée, pousse mangée.'],
  sleep: ['sieste planifiée.', 'ne pas déranger.'],
} as const
const BAO_CONFETTI = [0xfcd1ff, 0x7996ff, 0x3fcc8c, 0xffbf49, 0xf2efe8]
/** Seconds between two of Bao's idle hearts, on average. */
const BAO_HEART_EVERY = 7

/** A heart five pixels across: for a reward, and now and then for nothing. */
const BAO_HEART = ['.X.X.', 'XXXXX', '.XXX.', '..X..'] as const

/** Something adrift in Bao's world, in cells: a square, a word, a heart, a ring, a leaf. */
type BaoPart = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: number
  falls?: true
  text?: string
  isHeart?: true
  isRing?: true
  leaf?: number
}
type BaoStalk = { x: number; h: number; phase: number; isBack: boolean }
type BaoSprout = { x: number; grown: number }

/** Bao and its world, between two frames: module values, as the cats' are. */
const bao = {
  t: 0,
  columns: 0,
  x: 10,
  goal: 20,
  state: 'walk' as 'walk' | 'roll' | 'idle' | 'eat' | 'sleep',
  timer: 0,
  leg: 0,
  blink: 0,
  chew: 0,
  hop: 0,
  heading: 1,
  angle: 0,
  target: null as BaoSprout | null,
  parts: [] as BaoPart[],
  sprouts: [] as BaoSprout[],
  stars: [] as { x: number; y: number; glyph: string; phase: number }[],
  hillBack: [] as number[],
  hillFront: [] as number[],
  stalksBack: [] as BaoStalk[],
  stalks: [] as BaoStalk[],
  soil: [] as number[],
  flies: [] as { x: number; y: number; phase: number; speed: number }[],
  score: 0,
  combo: 0,
  ateAt: -99,
  flash: 0,
  level: null as { n: number; at: number } | null,
  /** What is due a little later on Bao's clock: the fireworks of a new level. */
  later: [] as { at: number; run: () => void }[],
}

const baoPick = <T,>(from: readonly T[]) => from[Math.floor(Math.random() * from.length)] as T
const baoBetween = (low: number, high: number) => low + Math.random() * (high - low)

/** Lays the grove for a strip this wide: stars, hills, stalks, soil, fireflies. */
const baoLay = (columns: number) => {
  bao.columns = columns
  bao.stars = Array.from({ length: Math.floor(columns / 5) }, () => ({
    x: Math.floor(baoBetween(0, columns)),
    y: Math.floor(baoBetween(2, 10)),
    glyph: baoPick(['*', '.', '.', '+', ':']),
    phase: baoBetween(0, 6),
  }))
  bao.hillBack = Array.from({ length: columns }, (_unused, at) =>
    Math.max(0, Math.round(3 + 2.5 * Math.sin(at / 9) + 2 * Math.sin(at / 4.3 + 1))),
  )
  bao.hillFront = Array.from({ length: columns }, (_unused, at) => Math.max(0, Math.round(1.5 + 1.5 * Math.sin(at / 6 + 2))))
  const grove = (count: number, isBack: boolean): BaoStalk[] =>
    Array.from({ length: count }, () => ({
      x: Math.floor(baoBetween(1, columns - 1)),
      h: Math.floor(isBack ? baoBetween(7, 14) : baoBetween(10, 20)),
      phase: baoBetween(0, 6),
      isBack,
    }))
  const count = Math.max(4, Math.round(columns / 11))
  bao.stalksBack = grove(Math.round(count * 1.6), true)
  bao.stalks = grove(count, false)
  bao.soil = Array.from({ length: columns * 5 }, () => Math.random())
  bao.flies = Array.from({ length: Math.max(4, Math.floor(columns / 14)) }, () => ({
    x: baoBetween(0, columns),
    y: baoBetween(BAO_GROUND - 12, BAO_GROUND - 2),
    phase: baoBetween(0, 6),
    speed: baoBetween(0.4, 1),
  }))
  bao.x = Math.min(bao.x, Math.max(0, columns - 16))
  bao.goal = Math.min(bao.goal, Math.max(0, columns - 14))
}

const baoSay = (kind: keyof typeof BAO_SAYS) =>
  say(baoPick(BAO_SAYS[kind]).replace('{n}', String(bao.flies.length)), 5000)

const baoBurst = (x: number, y: number, count: number, spread = 1, colors: readonly number[] = BAO_CONFETTI) => {
  for (let k = 0; k < count; k += 1) {
    const angle = baoBetween(0, Math.PI * 2)
    const speed = (baoBetween(40, 160) * spread) / 8
    bao.parts.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 7.5,
      life: baoBetween(0.9, 1.6),
      color: baoPick(colors),
      falls: true,
    })
  }
  if (bao.parts.length > 260) bao.parts.splice(0, bao.parts.length - 260)
}

/** A sprout eaten: the count, the combo, confetti and hearts, fireworks every fifth. */
const baoReward = () => {
  const cx = bao.x + 7
  const cy = BAO_GROUND - 9
  bao.score += 1
  bao.combo = bao.t - bao.ateAt < 20 ? bao.combo + 1 : 1
  bao.ateAt = bao.t
  bao.hop = 0.55
  bao.flash = 0.18
  baoBurst(cx, cy, 26 + bao.combo * 6)
  for (let k = 0; k < 3; k += 1) {
    bao.parts.push({ x: cx + baoBetween(-5, 5), y: cy - baoBetween(0, 2.5), vx: baoBetween(-1, 1), vy: baoBetween(-5, -3), life: 2, color: 0xfcd1ff, isHeart: true })
  }
  bao.parts.push({ x: cx - 1, y: BAO_GROUND - 15, vx: 0, vy: -2.7, life: 1.6, color: 0xffbf49, text: bao.combo > 1 ? `combo x${bao.combo}` : '+1' })
  if (bao.score % 5 === 0) {
    bao.flash = 0.35
    bao.level = { n: bao.score / 5, at: bao.t }
    for (let k = 0; k < 4; k += 1) {
      const fx = baoBetween(0.15, 0.85) * bao.columns
      const fy = baoBetween(3, 12)
      bao.later.push({ at: bao.t + k * 0.22, run: () => baoBurst(fx, fy, 40, 1.3) })
    }
  }
}

/** Plants a sprout, at `x` or anywhere, and sends Bao for it unless it is eating. */
const baoPlant = (at?: number) => {
  const columns = bao.columns || 80
  const x = Math.max(1, Math.min(columns - 2, Math.floor(at ?? baoBetween(2, columns - 2))))
  const sprout: BaoSprout = { x, grown: 0 }
  bao.sprouts.push(sprout)
  for (let k = 0; k < 10; k += 1) {
    bao.parts.push({ x: x + 0.5, y: BAO_GROUND, vx: baoBetween(-6, 6), vy: baoBetween(-14, -5), life: 0.8, color: baoPick([0x3fcc8c, 0xffbf49]), falls: true })
  }
  bao.parts.push({ x: x + 0.5, y: BAO_GROUND - 0.5, vx: 0, vy: 0, life: 0.5, color: 0x3fcc8c, isRing: true })
  if (bao.state !== 'eat') {
    bao.goal = Math.max(0, Math.min(columns - 14, x - 13))
    bao.state = Math.abs(bao.goal - bao.x) > 14 ? 'roll' : 'walk'
    bao.target = sprout
    baoSay(bao.state)
  }
}

/** Moves Bao's world on by `ms`. At rest it sleeps; while you type it stands and looks. */
const stepBao = (ms: number, isWorking: boolean) => {
  const dt = Math.min(0.1, ms / 1000)
  const columns = bao.columns
  bao.t += dt
  if (actor.typing > 0) actor.typing -= ms
  bao.hop = Math.max(0, bao.hop - dt)
  bao.flash = Math.max(0, bao.flash - dt)
  if (bao.combo > 0 && bao.t - bao.ateAt > 20) bao.combo = 0
  bao.blink -= dt
  if (bao.blink < -3.5 - Math.random() * 3) bao.blink = 0.15
  for (const one of bao.sprouts) one.grown = Math.min(1, one.grown + dt * 0.5)
  const due = bao.later.filter(one => one.at <= bao.t)
  bao.later = bao.later.filter(one => one.at > bao.t)
  for (const one of due) one.run()

  const isHeld = actor.typing > 0 || actor.isAwaited
  const isResting = !isWorking && !isHeld
  // The session's say over Bao's own: asleep at rest, still while you type, hopping while it waits on you.
  if (isResting && bao.state !== 'sleep' && bao.state !== 'eat' && bao.state !== 'roll') {
    bao.state = 'sleep'
    bao.timer = 1e9
    baoSay('sleep')
  }
  if (!isResting && bao.state === 'sleep' && bao.timer > 1e6) bao.timer = 0
  if (isHeld && (bao.state === 'walk' || bao.state === 'idle')) {
    bao.state = 'idle'
    bao.timer = 0.4
  }
  if (isWorking && Math.random() < dt / 18 && bao.sprouts.length < 3) bao.sprouts.push({ x: Math.floor(baoBetween(2, columns - 2)), grown: 0 })
  if (bao.state === 'idle' && Math.random() < dt * (actor.isAwaited ? 3 : 1.4) && bao.hop === 0) bao.hop = 0.55

  if (bao.state === 'walk' || bao.state === 'roll') {
    const isRolling = bao.state === 'roll'
    bao.leg += dt * 2.2
    const gap = bao.goal - bao.x
    const step = dt * (isRolling ? 16 : 7)
    if (isRolling) {
      bao.angle += (Math.sign(gap) * step) / 6.5
      if (Math.random() < dt * 14) {
        bao.parts.push({ x: bao.x + 7 - Math.sign(gap) * 6, y: BAO_GROUND - 0.5, vx: -Math.sign(gap) * baoBetween(2.5, 7.5), vy: baoBetween(-5, -1.2), life: 0.6, color: baoPick([0x7c808c, 0x5b5b61]), falls: true })
      }
    }
    if (isRolling && Math.abs(gap) <= step) {
      bao.hop = 0.55
      baoSay('land')
      for (let k = 0; k < 12; k += 1) {
        bao.parts.push({ x: bao.x + 7, y: BAO_GROUND - 0.5, vx: baoBetween(-11, 11), vy: baoBetween(-11, -4), life: 0.7, color: baoPick([0x7c808c, 0xffbf49]), falls: true })
      }
    }
    if (Math.abs(gap) <= step) {
      bao.x = bao.goal
      if (bao.target !== null && bao.sprouts.includes(bao.target)) {
        bao.sprouts.splice(bao.sprouts.indexOf(bao.target), 1)
        bao.target = null
        bao.state = 'eat'
        bao.timer = 6
        bao.chew = 0
        baoSay('eat')
      } else {
        bao.state = 'idle'
        bao.timer = baoBetween(1, 2.2)
        if (Math.random() < 0.3) baoSay('idle')
      }
    } else {
      bao.x += Math.sign(gap) * step
      bao.heading = Math.sign(gap)
    }
    if (Math.random() < dt * 3) {
      bao.parts.push({ x: bao.x + 7 + baoBetween(-4, 4), y: BAO_GROUND - 0.5, vx: 0, vy: -1, life: 1, color: 0x7c808c, text: baoPick([':', '.', '.']) })
    }
  } else {
    bao.timer -= dt
    if (bao.state === 'eat') {
      bao.chew += dt
      if (Math.random() < dt * 4) {
        bao.parts.push({ x: bao.x + 7, y: BAO_GROUND - 4, vx: baoBetween(-5, 5), vy: baoBetween(-6, -1.2), life: 0.8, color: baoPick([0x3fcc8c, 0x2e9a68]), falls: true })
      }
      if (bao.timer <= 0) baoReward()
    }
    if (bao.state === 'sleep' && Math.random() < dt * 1.2) {
      bao.parts.push({ x: bao.x + 12, y: BAO_GROUND - 12, vx: 1.2, vy: -2.2, life: 2.2, color: 0x9a9aa0, text: baoPick(['z', 'Z']) })
    }
    if (bao.timer <= 0) {
      const ripe = bao.sprouts.find(one => one.grown >= 1)
      const dice = Math.random()
      if (ripe !== undefined && dice < 0.6 && !isHeld) {
        bao.target = ripe
        bao.goal = Math.max(0, Math.min(columns - 14, ripe.x - 13))
        bao.state = Math.abs(bao.goal - bao.x) > 18 ? 'roll' : 'walk'
        baoSay(bao.state)
      } else if (isHeld) {
        bao.state = 'idle'
        bao.timer = 0.4
      } else {
        bao.target = null
        bao.goal = Math.floor(baoBetween(0, Math.max(1, columns - 14)))
        bao.state = dice > 0.5 && Math.abs(bao.goal - bao.x) > 12 ? 'roll' : 'walk'
        if (Math.random() < 0.5) baoSay(bao.state)
      }
    }
  }
  // Now and then, for no reason at all, a little pink heart or two float up from its head.
  if (bao.state !== 'sleep' && bao.state !== 'roll' && Math.random() < dt / BAO_HEART_EVERY) {
    const count = Math.random() < 0.4 ? 2 : 1
    for (let k = 0; k < count; k += 1) {
      bao.parts.push({
        x: bao.x + 7 + baoBetween(-5, 5),
        y: BAO_GROUND - 18 - baoBetween(0, 2),
        vx: baoBetween(-0.8, 0.8),
        vy: baoBetween(-4.5, -2.8),
        life: baoBetween(1.6, 2.4),
        color: 0xfcd1ff,
        isHeart: true,
      })
    }
  }
  // A leaf lets go of a stalk now and then, and drifts down.
  if (Math.random() < dt * 1.5 && bao.stalks.length > 0) {
    const from = baoPick(bao.stalks)
    bao.parts.push({ x: from.x, y: BAO_GROUND - from.h, vx: baoBetween(0.6, 2.5), vy: 1.5, life: 6, color: 0x3fcc8c, leaf: baoBetween(0, 6) })
  }
  for (const one of bao.parts) {
    one.life -= dt
    one.x += one.vx * dt + (one.leaf === undefined ? 0 : Math.sin(bao.t * 2 + one.leaf) * 1.5 * dt)
    one.y += one.vy * dt
    if (one.falls) one.vy += 17.5 * dt
    if (one.leaf !== undefined && one.y > BAO_GROUND) one.life = 0
  }
  bao.parts = bao.parts.filter(one => one.life > 0)
}

/**
 * Two colors mixed: `share` of the first over the second, in eighths. A Raster
 * paints 1024 distinct color pairs and rounds the rest to a coarse palette, sky
 * and all: a fade that made a new color every frame used them up in seconds.
 */
const baoMix = (over: number, under: number, level: number) => {
  const share = Math.round(level * 8) / 8
  if (share >= 1) return over
  if (share <= 0) return under
  const blend = (shift: number) => Math.round(((under >> shift) & 255) + (((over >> shift) & 255) - ((under >> shift) & 255)) * Math.max(0, share))

  return (blend(16) << 16) | (blend(8) << 8) | blend(0)
}

/** Bao's world as Raster cells, `columns` wide and BAO_ROWS tall. */
const baoStrip = (columns: number) => {
  if (bao.columns !== columns) baoLay(columns)
  const night = BAO_NIGHT
  const floor = BAO_GROUND
  const pixels = new Int32Array(columns * BAO_TALL).fill(night.sky)
  const cell = (x: number, y: number, color: number, wide = 1, tall = 1, share = 1) => {
    for (let dy = 0; dy < tall; dy += 1) {
      for (let dx = 0; dx < wide; dx += 1) {
        const px = Math.floor(x) + dx
        const py = Math.floor(y) + dy
        if (px < 0 || px >= columns || py < 0 || py >= BAO_TALL) continue
        const at = py * columns + px
        pixels[at] = baoMix(color, pixels[at] ?? night.sky, share)
      }
    }
  }
  /** What is written in characters, a cell each: laid over the picture last. */
  const written: { x: number; row: number; glyph: number; color: number; share: number; behind?: number }[] = []
  const write = (x: number, row: number, text: string, color: number, share = 1, behind?: number) => {
    for (let k = 0; k < text.length; k += 1) {
      if (text[k] !== ' ' || behind !== undefined) written.push({ x: Math.floor(x) + k, row, glyph: glyphOf(text[k] ?? ' '), color, share, behind })
    }
  }

  for (const one of bao.stars) {
    write(one.x, Math.floor(one.y / 2), one.glyph, one.glyph === '*' ? 0xffbf49 : 0x7c808c, 0.35 + 0.65 * Math.max(0, Math.sin(bao.t * 1.3 + one.phase)))
  }
  const stalk = (one: BaoStalk) => {
    const top = floor - one.h
    const sway = Math.round(Math.sin(bao.t * 1.2 + one.phase) * 0.9)
    const leaf = one.isBack ? night.stalkBack : 0x3fcc8c
    for (let y = top; y < floor; y += 1) {
      const isNode = (y - top) % 5 === 4
      cell(one.x, y, one.isBack ? (isNode ? night.nodeBack : night.stalkBack) : isNode ? 0x1e6b47 : 0x2e9a68)
      if (isNode && y < floor - 3) {
        const side = y % 2 === 1 ? 1 : -1
        cell(one.x + side, y, leaf)
        cell(one.x + side * 2 + (side > 0 ? sway : 0), y - 1, leaf)
        cell(one.x + side * 3 + sway, y - 1, leaf)
      }
    }
    cell(one.x - 1 + sway, top - 1, leaf)
    cell(one.x + sway, top - 2, leaf)
    cell(one.x + 1 + sway, top - 1, leaf)
    cell(one.x + 2 + sway, top - 2, leaf)
  }
  for (let x = 0; x < columns; x += 1) {
    const high = bao.hillBack[x] ?? 0
    if (high > 0) cell(x, floor - high - 3, night.hillBack, 1, high + 3)
  }
  for (const one of bao.stalksBack) stalk(one)
  for (let x = 0; x < columns; x += 1) {
    const high = bao.hillFront[x] ?? 0
    if (high > 0) cell(x, floor - high, night.hillFront, 1, high)
  }
  for (const one of bao.stalks) stalk(one)
  for (const one of bao.sprouts) {
    const high = 1 + Math.floor(one.grown * 3)
    for (let up = 1; up <= high; up += 1) cell(one.x, floor - up, 0x2e9a68)
    if (one.grown >= 1) {
      cell(one.x + 1, floor - 3, 0x3fcc8c)
      cell(one.x - 1, floor - 4, 0x3fcc8c)
    }
  }

  // Bao: a ball when it rolls, else its head, body and legs row by row, ringed.
  const left = Math.round(bao.x)
  if (bao.state === 'roll') {
    const cx = bao.x + 7
    const cy = floor - 7
    const cos = Math.cos(bao.angle)
    const sin = Math.sin(bao.angle)
    for (let y = -8; y <= 8; y += 1) {
      for (let x = -8; x <= 8; x += 1) {
        const dx = x + 0.5 - (cx - Math.floor(cx))
        const dy = y + 0.5
        const reach = Math.hypot(dx, dy)
        if (reach > 7.2) continue
        const u = dx * cos + dy * sin
        const v = -dx * sin + dy * cos
        const color =
          reach > 6.2 || Math.abs(v) < 1.4 || Math.hypot(u - 2.8, v + 3.6) < 1.5 || Math.hypot(u + 2.8, v + 3.6) < 1.5
            ? BAO_INK.K
            : v > 3.4
              ? BAO_INK.G
              : BAO_INK.W
        cell(Math.floor(cx) + x, cy + y, color ?? 0)
      }
    }
  } else {
    const top = floor - 16 - Math.round(Math.sin(Math.min(1, bao.hop / 0.55) * Math.PI) * 5)
    const eyes =
      bao.state === 'sleep' || bao.blink > 0 ? BAO_EYES.x : bao.state === 'walk' ? (bao.heading > 0 ? BAO_EYES.r : BAO_EYES.l) : BAO_EYES.c
    const mouth = bao.state === 'eat' && Math.floor(bao.chew * 5) % 2 === 1 ? '.WWWWGKKGWWWW.' : '.WWWWGWWGWWWW.'
    const legs =
      bao.state === 'walk'
        ? ([BAO_LEGS.a, BAO_LEGS.b, BAO_LEGS.a, BAO_LEGS.c][((Math.floor(bao.leg * 6) % 4) + 4) % 4] ?? BAO_LEGS.a)
        : bao.state === 'idle'
          ? BAO_LEGS.a
          : BAO_LEGS.sit
    const rows: string[] = [...BAO_HEAD.map(row => (row === 'EYES' ? eyes : row === 'MOUTH' ? mouth : row)), ...BAO_BODY, ...legs]
    const isOn = (x: number, y: number) => {
      const seen = rows[y]?.[x]

      return seen !== undefined && seen !== '.'
    }
    for (let y = -1; y < rows.length; y += 1) {
      for (let x = -1; x <= 14; x += 1) {
        if (!isOn(x, y) && (isOn(x - 1, y) || isOn(x + 1, y) || isOn(x, y - 1) || isOn(x, y + 1))) cell(left + x, top + y, night.rim)
      }
    }
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const seen = row[x] ?? '.'
        if (seen !== '.') cell(left + x, top + y, BAO_INK[seen] ?? 0)
      }
    })
    if (bao.state === 'eat') {
      for (let y = 3; y <= 14; y += 1) cell(left + 12, top + y, y % 4 === 0 ? 0x1e6b47 : 0x2e9a68)
      const sway = Math.round(Math.sin(bao.t * 3))
      cell(left + 13 + sway, top + 2, 0x3fcc8c)
      cell(left + 14 + sway, top + 1, 0x3fcc8c)
      cell(left + 11, top + 2, 0x3fcc8c)
      cell(left + 11, top + 10, BAO_INK.K ?? 0, 1, 2)
      cell(left + 13, top + 10, BAO_INK.K ?? 0, 1, 2)
    }
    write(left + 5, Math.max(0, Math.floor((top - 2) / 2)), 'bao', 0xffbf49)
  }

  // The ground with its bright blades, the soil under it, and the water at the foot.
  for (let x = 0; x < columns; x += 1) {
    cell(x, floor, x % 7 === 3 || x % 11 === 5 ? 0x3fcc8c : 0x2e7a55)
    if ((bao.soil[x] ?? 0) > 0.82) cell(x, floor - 1, 0x2e7a55)
    for (let down = 1; down <= 4; down += 1) {
      cell(x, floor + down, (bao.soil[x * 5 + down] ?? 0) > 0.85 ? 0x4a3a31 : down > 2 ? 0x2f2420 : 0x3a2c26)
    }
  }
  cell(0, floor + 5, 0x14284a, columns, 2)
  const drift = Math.floor(bao.t * 8) % 4
  for (let x = 0; x < columns; x += 1) {
    if ((x + drift) % 4 !== 0) write(x, (floor + 5) / 2, '~', 0x7996ff, (x + drift) % 4 === 2 ? 1 : 0.55)
  }

  for (const one of bao.flies) {
    if (Math.sin(bao.t * 2 * one.speed + one.phase) > 0.2) {
      cell(one.x + Math.sin(bao.t * 0.5 * one.speed + one.phase) * 5, one.y + Math.sin(bao.t * 0.9 + one.phase) * 1.25, 0xffbf49)
    }
  }
  for (const one of bao.parts) {
    // No fade: a part is there, then gone. Each shade of a fade would be a color more.
    const share = 1
    if (one.isHeart) {
      BAO_HEART.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) if (row[x] === 'X') cell(one.x + x - 2, one.y + y, one.color, 1, 1, share)
      })
    } else if (one.isRing) {
      const reach = Math.round((0.5 - one.life) * 10) + 1
      for (let x = -reach; x <= reach; x += 1) {
        cell(one.x + x, one.y - reach / 2, one.color, 1, 1, share)
        cell(one.x + x, one.y + reach / 2, one.color, 1, 1, share)
      }
    } else if (one.text !== undefined) {
      write(one.x, Math.floor(one.y / 2), one.text, one.color, share)
    } else {
      cell(one.x, one.y, one.color, 1, 1, share)
    }
  }

  if (bao.level !== null && bao.t - bao.level.at < 2.4) {
    const age = bao.t - bao.level.at
    const title = `niveau ${bao.level.n}`
    write(Math.round((columns - title.length) / 2), 5 - Math.round(age * 0.4), title, Math.floor(age * 8) % 2 === 1 ? 0xfcd1ff : 0xffbf49)
  }

  // What Bao says, typed out a letter at a time, in a black frame beside it.
  if (scene.lines.length > 0) {
    let typed = Math.max(0, Math.floor(((scene.clock - scene.saidAt) / 1000) * 32))
    const framed = Math.max(...scene.lines.map(one => one.length)) + 4
    let from = left + 15
    if (from + framed > columns - 1) from = left - framed - 1
    from = Math.max(1, from)
    const last = scene.lines.length + 1
    for (let row = 0; row <= last; row += 1) {
      cell(from, (row + 1) * 2, 0x0b0b0c, framed, 2)
      for (let x = 0; x < framed; x += 1) {
        const isEdgeRow = row === 0 || row === last
        const isEdgeCol = x === 0 || x === framed - 1
        const corner = row === 0 ? (x === 0 ? '╭' : '╮') : x === 0 ? '╰' : '╯'
        if (isEdgeRow || isEdgeCol) write(from + x, row + 1, isEdgeRow && isEdgeCol ? corner : isEdgeRow ? '─' : '│', 0xc9c9cf, 1, 0x0b0b0c)
      }
      if (row > 0 && row < last) {
        const text = scene.lines[row - 1] ?? ''
        write(from + 2, row + 1, text.slice(0, typed), 0xf2f2f2, 1, 0x0b0b0c)
        typed = Math.max(0, typed - text.length)
      }
    }
  }

  // A reward flashes the whole scene white for an instant.
  const glare = bao.flash > 0.2 ? 0.25 : bao.flash > 0 ? 0.125 : 0
  const total = columns * BAO_ROWS
  const words = new Uint32Array(total * 3)
  for (let row = 0; row < BAO_ROWS; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = baoMix(0xffffff, pixels[row * 2 * columns + x] ?? night.sky, glare)
      const bottom = baoMix(0xffffff, pixels[(row * 2 + 1) * columns + x] ?? night.sky, glare)
      const at = (row * columns + x) * 3
      words[at] = top === bottom ? 0x20 : LOWER_HALF
      words[at + 1] = bottom
      words[at + 2] = top
    }
  }
  for (const one of written) {
    if (one.row < 0 || one.row >= BAO_ROWS || one.x < 0 || one.x >= columns) continue
    const at = (Math.floor(one.row) * columns + one.x) * 3
    const under = one.behind ?? words[at + 2] ?? night.sky
    words[at] = one.glyph
    words[at + 1] = baoMix(one.color, under, one.share)
    words[at + 2] = under
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
  /** The color of an agent's tier word and of its meter. */
  tiers: Record<'heavy' | 'careful' | 'medium' | 'light', string | undefined>
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
    tiers: { heavy: '#ff5a3c', careful: '#f0a020', medium: '#4a9cff', light: '#3ecf8e' },
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
    tiers: { heavy: '#d8401f', careful: '#c47a00', medium: '#1f6fd6', light: '#0a8f5a' },
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
    tiers: { heavy: undefined, careful: undefined, medium: undefined, light: undefined },
    badges: { shell: PLAIN, edit: PLAIN, read: PLAIN, agent: PLAIN, other: PLAIN },
  },
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
  argumentHint: 'auto | mission <texte> | spec <feature|off> | cat <roux|noir|garfield|panda> | lasagne [off] | bambou | pet <sprite|big|png|3d|line|pixel|off> | demo | UNL-1234 <texte>',
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

/** How long the session has run, as a card prints it: 42s, 4m, 1h12. */
const span = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

// ----------------------------------------------------------------- the agents

type Tier = 'heavy' | 'careful' | 'medium' | 'light'

/** How many subagent rows the pane remembers. */
const AGENTS_KEPT = 30

const TIERS: Record<string, Tier> = { max: 'heavy', xhigh: 'heavy', high: 'careful', medium: 'medium', low: 'light' }

/** How hard an agent thinks, as a word: a number or no effort at all has none. */
const tierOf = (effort: Effort | null): Tier | null => (typeof effort === 'string' ? (TIERS[effort] ?? null) : null)

/** Dollars per million tokens. */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

// Estimates: a cache write is priced at the 1 h rate, 2 × input, as Claude Code sessions pay it.
const OPUS_5_5: Price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }
const PRICES: readonly (readonly [string, Price])[] = [
  ['fable', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 }],
  ['opus-5-5', OPUS_5_5],
  ['opus', { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 }],
  ['haiku', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 }],
]

const tokensOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** What one request cost, by the table; a model it does not know is priced as Opus 5.5. */
const stepCost = (usage: TurnUsage, model: string) => {
  const price = PRICES.find(([name]) => model.includes(name))?.[1] ?? OPUS_5_5

  return (
    (tokensOf(usage.input_tokens) * price.input +
      tokensOf(usage.output_tokens) * price.output +
      tokensOf(usage.cache_read_input_tokens) * price.cacheRead +
      tokensOf(usage.cache_creation_input_tokens) * price.cacheWrite) /
    1e6
  )
}

/** The size of a request: every token it carried or wrote. */
const stepSize = (usage: TurnUsage) =>
  tokensOf(usage.input_tokens) +
  tokensOf(usage.output_tokens) +
  tokensOf(usage.cache_read_input_tokens) +
  tokensOf(usage.cache_creation_input_tokens)

/** The context window an estimate divides by. */
const windowOf = (model: string) => (model.includes('haiku') ? 200_000 : 1_000_000)

const capital = (word: string) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`

/** `claude-opus-5-5` as Opus 5.5, `opus` as Opus; any other id as it is. */
const modelName = (id: string) => {
  const bare = id.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  const hit = bare.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/)
  if (hit) return `${capital(hit[1] ?? '')} ${hit[2]}${hit[3] === undefined ? '' : `.${hit[3]}`}`

  return /^[a-z]+$/.test(bare) ? capital(bare) : id
}

/** An estimated cost: two decimals under ten dollars, one above. */
const dollars = (usd: number) => `≈$${usd.toFixed(usd < 10 ? 2 : 1)}`

const blankAgent = (id: string, title: string, type: string, model: string | null, now: number): AgentRow => ({
  id,
  title,
  type,
  model,
  effort: null,
  status: 'running',
  startedAt: now,
  endedAt: null,
  context: 0,
  tokens: 0,
  usd: 0,
})

/** Keeps the newest rows: the oldest finished one goes first, else the oldest. */
const trimAgents = (rows: AgentRow[]) => {
  const kept = [...rows]
  while (kept.length > AGENTS_KEPT) {
    const at = kept.findIndex(one => one.status !== 'running')
    kept.splice(Math.max(0, at), 1)
  }

  return kept
}

/** A row with one more request taken in: its size is its context, its tokens and cost add up. */
const charge = (row: AgentRow, usage: TurnUsage | null | undefined): AgentRow => {
  if (!usage) return row
  const size = stepSize(usage)

  return { ...row, context: size, tokens: row.tokens + size, usd: row.usd + stepCost(usage, usage.model || row.model || '') }
}

/** Ids the engine does not list (a workflow's agents, a fork's): never looked up twice. */
const strangers = new Set<string>()

/** Redraws each second while an agent runs: a module value, so a reload drops it with its timer. */
let agentTicker: Timer | undefined

/** Starts or stops the ticker after each write of the rows. */
const tick = async ($: EngineInterface) => {
  try {
    agentTicker?.cancel()
  } catch {
    // A timer of an engine long gone.
  }
  agentTicker = undefined
  if ((await read($, agents)).some(one => one.status === 'running')) {
    agentTicker = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
    })
  }
}

/** A request of a subagent's loop went by: its row is made if the engine lists it, else it is left alone. */
const noteStep = async (
  $: EngineInterface,
  id: string,
  step: { model: string; effort?: Effort },
  usage: TurnUsage | null,
) => {
  const now = await $.clock.now()
  if (!(await read($, agents)).some(one => one.id === id)) {
    if (strangers.has(id)) return
    const listed = (await $.agent.list()).find(one => one.id === id)
    if (listed === undefined) {
      strangers.add(id)

      return
    }
    await update($, agents, was =>
      was.some(one => one.id === id)
        ? was
        : trimAgents([...was, blankAgent(id, listed.description || listed.type, listed.type, null, now)]),
    )
  }
  await update($, agents, was =>
    was.map(one =>
      one.id !== id
        ? one
        : charge(
            { ...one, status: 'running', endedAt: null, effort: step.effort ?? one.effort, model: usage?.model ?? step.model },
            usage,
          ),
    ),
  )
  await tick($)
}

/** A subagent's turn ended: its row closes, and takes the turn's usage if no step ever gave it one. */
const endAgent = async ($: EngineInterface, id: string, reason: string, usage: TurnUsage | undefined) => {
  const now = await $.clock.now()
  await update($, agents, was =>
    was.map(one =>
      one.id !== id
        ? one
        : {
            ...(one.tokens === 0 ? charge(one, usage) : one),
            status: reason === 'answer' ? 'completed' : 'failed',
            endedAt: now,
          },
    ),
  )
  await tick($)
}

/** The engine's own list is the truth: a row still running whose agent is over is closed. */
const reconcileAgents = async ($: EngineInterface) => {
  if (!(await read($, agents)).some(one => one.status === 'running')) return
  const listed = await $.agent.list()
  const now = await $.clock.now()
  await update($, agents, was =>
    was.map(one => {
      const seen = listed.find(other => other.id === one.id)
      if (one.status !== 'running' || seen === undefined || seen.status === 'running' || seen.status === 'pending') return one

      return { ...one, status: seen.status === 'completed' ? 'completed' : 'failed', endedAt: now }
    }),
  )
  await tick($)
}

/** Task ids as a tool call spells them. */
const asIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(one => (typeof one === 'string' || typeof one === 'number' ? [String(one).trim()] : [])).filter(Boolean)
    : []

const joined = (was: string[] | undefined, more: string[]) => [...new Set([...(was ?? []), ...more])]

/**
 * Clawd as the mock-up draws him, in a box of 9 cells by 3: each cell split in two columns
 * and two rows of quarter cells (the quadrant blocks), a grid of 18 by 6. One quarter cell
 * across is one pixel of the mock-up, one down is two: the body 8 wide, the arms 2, the legs
 * `L.L..L.L`. Letters name a color of the sprite's palette, `.` is the ground; a cell holds
 * two colors at most, foreground and background, and the grids keep to it.
 *
 * A few cells (`fine`, keyed `row,column` in cells) may take a finer glyph than a quadrant: ▃,
 * a lower three eighths, for a thin brim or band; `+`; `·`. Their colors are a letter for the
 * foreground and one for the background, the ground when absent. No variant needs one today.
 */
const AVATAR_COLUMNS = 9
const AVATAR_ROWS = 3
const BODY = { O: '#ec7a58', K: '#1a1512' }
type Sprite = {
  grid: readonly string[]
  palette: Record<string, string>
  fine?: Record<string, readonly [glyph: string, fore: string, back?: string]>
}

/** The accessories' colors, the mock-up's: grey, dark, blue, yellow, white, pink, red, green. */
const GEAR = { g: '#B8B8BC', n: '#3A3A42', b: '#3B5BDB', y: '#F2C14E', w: '#FFFFFF', p: '#FCD1FF', r: '#E5484D', v: '#3FCC8C' }
const dressed = (grid: readonly string[]): Sprite => ({ grid, palette: { ...BODY, ...GEAR } })

/** Bare: a head where a hat would be. A planned task wears it. */
const BARE: Sprite = {
  grid: [
    '..................',
    '...OOOOOOOO.......',
    '...OKOOOOKO.......',
    '.OOOOOOOOOOOO.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ],
  palette: BODY,
}

/**
 * Ten variants of the crab, from the mock-up's "ten versions" (the logo left out): the hat or the
 * accessory on the top two quarter rows, the eyes on the third. An agent wears one of them,
 * picked by its id (`variantOf`); the tier is written in its row, not worn.
 */
const VARIANTS: readonly Sprite[] = [
  // Original: a grey hat on a blue band, a pencil in the right hand.
  dressed([
    '....gggggg..y.....',
    '...bbbbbbbb.y.....',
    '...OKOOOOKO.y.....',
    '.OOOOOOOOOOOy.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Cap: a dark cap and its visor, a glint on it; the right claw up, waving.
  dressed([
    '....nwnnnn........',
    '..nnnnnnnnnnO.....',
    '...OKOOOOKOOO.....',
    '.OOOOOOOOOO.......',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Key: a bare head, the right claw up, holding a golden key.
  dressed([
    '.............yy...',
    '...OOOOOOOO...y...',
    '...OKOOOOKOOOOyy..',
    '.OOOOOOOOOO.......',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Top hat: a dark crown, a pink ribbon, a wide brim.
  dressed([
    '....nnnnnn........',
    '...nppppppnn......',
    '...OKOOOOKO.......',
    '.OOOOOOOOOOOO.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Site: a yellow helmet, a grey wrench in the right hand.
  dressed([
    '....yyyyyy..g.g...',
    '..yyyyyyyyyy.g....',
    '...OKOOOOKOOOg....',
    '.OOOOOOOOOOOOg....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Crown: two golden prongs, a blue stone and a red one.
  dressed([
    '....yy..yy........',
    '...ybyyyyry.......',
    '...OKOOOOKO.......',
    '.OOOOOOOOOOOO.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Glasses: no hat, two dark lenses, a white glint on each.
  dressed([
    '..................',
    '...OOOOOOOO.......',
    '..KKwKKKKwKK......',
    '.OOOKKOOKKOOO.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Beanie: a pink bonnet, a white pompom.
  dressed([
    '......ww..........',
    '...pppppppp.......',
    '...OKOOOOKO.......',
    '.OOOOOOOOOOOO.....',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
  // Asleep: eyes shut, arms down, a z above the head.
  dressed([
    '............www...',
    '...OOOOOOOO..w....',
    '...OOOOOOOO.www...',
    '...OKKOOKKO.......',
    '.OOOOOOOOOOOO.....',
    '...O.O..O.O.......',
  ]),
  // Bravo: both claws up, confetti over the head.
  dressed([
    '....pp..yy....v.b.',
    '.O.OOOOOOOO.O.....',
    '.OOOKOOOOKOOOO....',
    '...OOOOOOOO.......',
    '...OOOOOOOO.......',
    '...O.O..O.O.......',
  ]),
]

/** A string's FNV-1a hash, 32 bits: stable from one render to the next, spread over close ids. */
const hashOf = (text: string) => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193)

  return hash >>> 0
}

/** The variant an agent wears, by its id: always the same one. */
const variantOf = (seed: string | null): Sprite => (seed === null ? BARE : (VARIANTS[hashOf(seed) % VARIANTS.length] ?? BARE))

/** `hex` and `toward` blended, `share` of the way. */
const mixHex = (hex: string, toward: string, share: number) => {
  const mixed = [16, 8, 0].map(shift => {
    const one = (rgb(hex) >> shift) & 255
    const other = (rgb(toward) >> shift) & 255

    return Math.round(one + (other - one) * share)
  })

  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/** One cell of the crab: its glyph and two colors, undefined for the ground. */
type AvatarCell = { glyph: number; fore: string | undefined; back: string | undefined }

/** The quadrant block for the quarter cells in the foreground: upper left, upper right, lower left, lower right. */
const QUADRANTS: Record<string, number> = {
  '0000': 0x20,
  '1000': 0x2598,
  '0100': 0x259d,
  '0010': 0x2596,
  '0001': 0x2597,
  '1100': 0x2580,
  '0011': 0x2584,
  '1010': 0x258c,
  '0101': 0x2590,
  '1001': 0x259a,
  '0110': 0x259e,
  '1110': 0x259b,
  '1101': 0x259c,
  '1011': 0x2599,
  '0111': 0x259f,
  '1111': 0x2588,
}

/**
 * The crab's cells, row-major. An agent wears the variant its `seed` (its id) picks; a planned
 * task has no agent yet: the bare crab, faded toward the ground (not under an ansi theme,
 * whose ground is the terminal's own).
 */
const avatarGlyphs = (seed: string | null, isPlanned: boolean, ground: string | undefined): AvatarCell[] => {
  const sprite = isPlanned ? BARE : variantOf(seed)
  const paint = (letter: string | undefined) => {
    const hex = letter === undefined ? undefined : sprite.palette[letter]

    return hex !== undefined && isPlanned && ground !== undefined ? mixHex(hex, ground, 0.4) : hex
  }

  return Array.from({ length: AVATAR_ROWS * AVATAR_COLUMNS }, (_, at): AvatarCell => {
    const row = Math.floor(at / AVATAR_COLUMNS)
    const column = at % AVATAR_COLUMNS
    const fine = sprite.fine?.[`${row},${column}`]
    if (fine !== undefined) return { glyph: fine[0].codePointAt(0) ?? 0x20, fore: paint(fine[1]), back: paint(fine[2]) }

    const quarters = [0, 1].flatMap(down => [0, 1].map(across => paint(sprite.grid[row * 2 + down]?.[column * 2 + across])))
    const [upLeft, upRight, downLeft, downRight] = quarters
    const colors = [...new Set(quarters)]
    if (colors.length === 1) return { glyph: 0x20, fore: upLeft, back: upLeft }

    // The background takes the top when it is one color: the half or quarter blocks then stand
    // on the cell's lower edge (no ▀, which xterm.js draws a pixel short of the top).
    const back = upLeft === upRight ? upLeft : colors.includes(undefined) ? undefined : downLeft === downRight ? downLeft : upLeft
    const fore = colors.find(one => one !== back)

    return { glyph: QUADRANTS[quarters.map(one => (one === back ? '0' : '1')).join('')] ?? 0x20, fore, back }
  })
}

/** The crab as Raster cells. */
const avatarCells = (cells: AvatarCell[], ground: string | undefined) => {
  const base = ground === undefined ? 0x01000000 : rgb(ground)
  const words = new Uint32Array(cells.length * 3)
  cells.forEach((one, at) => {
    words[at * 3] = one.glyph
    words[at * 3 + 1] = one.fore === undefined ? base : rgb(one.fore)
    words[at * 3 + 2] = one.back === undefined ? base : rgb(one.back)
  })

  return toBase64(new Uint8Array(words.buffer))
}

/** A cell as the terminal draws it, 10 by 21; a quadrant's quarters, and what a finer glyph paints, as x, y, w, h. */
const CELL_W = 10
const CELL_H = 21
const MASKS: Record<number, string> = Object.fromEntries(Object.entries(QUADRANTS).map(([mask, glyph]) => [glyph, mask]))
const FINE_SHAPES: Record<number, readonly (readonly [number, number, number, number])[]> = {
  0x2583: [[0, (CELL_H * 5) / 8, CELL_W, (CELL_H * 3) / 8]],
  0x2b: [
    [1, 10, 8, 1],
    [4.5, 6, 1, 9],
  ],
  0xb7: [[4, 9.5, 2, 2]],
}

/** The crab as a vector picture, for a surface that draws one: the same cells, the same shapes. */
const avatarSvg = (cells: AvatarCell[]) => {
  const rect = (x: number, y: number, w: number, h: number, hex: string | undefined) =>
    hex === undefined ? [] : [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${hex}"/>`]
  const shapes = cells.flatMap((one, at) => {
    const x = (at % AVATAR_COLUMNS) * CELL_W
    const y = Math.floor(at / AVATAR_COLUMNS) * CELL_H
    const mask = MASKS[one.glyph]
    // A quadrant block: each quarter in its own color, the ground left bare.
    if (mask !== undefined) {
      return [...mask].flatMap((bit, quarter) =>
        rect(x + (quarter % 2) * (CELL_W / 2), y + Math.floor(quarter / 2) * (CELL_H / 2), CELL_W / 2, CELL_H / 2, bit === '1' ? one.fore : one.back),
      )
    }

    return [
      ...rect(x, y, CELL_W, CELL_H, one.back),
      ...(FINE_SHAPES[one.glyph] ?? []).flatMap(([left, top, w, h]) => rect(x + left, y + top, w, h, one.fore)),
    ]
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${AVATAR_COLUMNS * CELL_W} ${AVATAR_ROWS * CELL_H}" width="36" height="25" shape-rendering="crispEdges">` +
    shapes.join('') +
    '</svg>'
  )
}

/** A session's worth of agents made up whole, for showing the pane full. */
const demoAgents = (now: number): AgentRow[] => [
  {
    id: 'demo-1',
    title: 'Conformer api-v2 au contrat R3',
    type: 'general-purpose',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    status: 'running',
    startedAt: now - 201_000,
    endedAt: null,
    context: 177_000,
    tokens: 1_240_000,
    usd: 1.65,
  },
  {
    id: 'demo-2',
    title: 'Contrat BFF et SDK du relevé',
    type: 'general-purpose',
    model: 'claude-opus-5-5',
    effort: 'high',
    status: 'completed',
    startedAt: now - 1_500_000,
    endedAt: now - 435_000,
    context: 270_000,
    tokens: 9_700_000,
    usd: 6.26,
  },
  {
    id: 'demo-3',
    title: 'Pact du relevé de compte',
    type: 'general-purpose',
    model: 'claude-opus-5-5',
    effort: 'high',
    status: 'completed',
    startedAt: now - 700_000,
    endedAt: now - 280_000,
    context: 120_000,
    tokens: 3_100_000,
    usd: 2.4,
  },
]

// ------------------------------------------------------------------ the parts

type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  /** Where the surface draws real pictures and no grid of cells: the desktop. */
  Svg?: ElementConstructor<SvgProps>
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
const meter = (
  { Text, Svg }: Elements,
  tone: Tone,
  ratio: number,
  width: number,
  color: string | undefined,
  trackGlyph = '─',
) => {
  // Off the terminal a row of characters has no known width: a drawn bar fits its card.
  if (Svg !== undefined) {
    const share = Math.max(0, Math.min(100, ratio * 100))

    return (
      <Svg
        height={3}
        alt={`${Math.round(share)} %`}
        source={
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 3" width="100%" height="3" preserveAspectRatio="none">` +
          `<rect width="100" height="3" rx="1" fill="${tone.track ?? '#2a3350'}"/>` +
          `<rect width="${share.toFixed(1)}" height="3" rx="1" fill="${color ?? '#406aff'}"/></svg>`
        }
      />
    )
  }
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))

  return (
    <Text backgroundColor={tone.card} wrap="truncate-end">
      <Text color={color} backgroundColor={tone.card}>
        {'━'.repeat(filled)}
      </Text>
      <Text color={tone.track} dimColor={tone.track === undefined} backgroundColor={tone.card}>
        {trackGlyph.repeat(width - filled)}
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

type Stat = {
  key: string
  label: string
  /** Quiet, on the right of the label: a percentage, a live dot. */
  aside?: string
  value: string
  /** A meter filling the rest of the value's line: a ratio from 0 to 1 and its color. */
  gauge?: { ratio: number; color: string | undefined }
}

/**
 * The compact figure, four rows with its frame: the label (and an aside) in grey, the value
 * in bold under it, and when asked a meter on the value's own line. In cells the widths add
 * up exactly; as a share of the row (`width` a string) the card may give.
 */
const stat = (parts: Elements, tone: Tone, one: Stat, width: number | string) => {
  const { Box, Text } = parts
  const isCells = typeof width === 'number'
  // The frame and the padding take 4 cells, the value and a space the rest of the line.
  const bar = isCells ? Math.max(1, width - 4 - one.value.length - 1) : 14

  return (
    <Box
      key={one.key}
      flexDirection="column"
      width={width}
      flexGrow={isCells ? 0 : 1}
      flexShrink={isCells ? 0 : 1}
      borderStyle="round"
      borderColor={tone.frame}
      backgroundColor={tone.card}
      paddingX={1}
    >
      <Box flexDirection="row" width="100%" justifyContent="space-between">
        <Text {...quiet(tone, tone.card)} wrap="truncate-end">
          {one.label}
        </Text>
        {one.aside !== undefined && one.aside !== '' && <Text {...quiet(tone, tone.card)}>{one.aside}</Text>}
      </Box>
      {one.gauge === undefined ? (
        <Text bold color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
          {one.value}
        </Text>
      ) : (
        <Box flexDirection="row" width="100%" columnGap={1}>
          <Text bold color={tone.text} backgroundColor={tone.card}>
            {one.value}
          </Text>
          <Box flexGrow={1} flexShrink={1}>
            {meter(parts, tone, one.gauge.ratio, bar, one.gauge.color)}
          </Box>
        </Box>
      )}
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

  // Two of the waiting tasks hang on others, so the planned rows say what they wait for.
  return all.map((content, at) => ({
    id: String(at + 1),
    content,
    status: at < 2 ? 'completed' : at === 2 ? 'in_progress' : 'pending',
    activeForm: content,
    ...(at === 4 ? { blockedBy: ['3'] } : at === 5 ? { blockedBy: ['3', '5'] } : {}),
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
    const coat = asPetCoat(await $.store.get('cat').catch(() => null))
    if (coat !== null) await update($, petCoat, () => coat)
    // A reload lands in the middle of a turn as well as between two: the turn
    // atom outlives it and says which, where a fresh module would guess rest.
    pace($, (await read($, turn)).isRunning)
    // The rows outlive a reload, the timer does not.
    await tick($).catch(() => undefined)

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

    if (/^bamb(ou|oo)s?$/i.test(args)) {
      if (!stage.isBao) return { text: 'Focus pane: le bambou est pour le panda (cat panda, dans un terminal).' }
      baoPlant()

      return { text: 'Focus pane: une pousse de bambou est plantée.' }
    }

    if (/^lasagn[ea]s?(\s|$)/i.test(args)) {
      if (stage.isBao) {
        // A panda's feast is bamboo: a row of sprouts to roll between.
        for (let k = 0; k < 5; k += 1) baoPlant()

        return { text: 'Focus pane: festin de bambou, cinq pousses plantées.' }
      }
      if (stage.style !== 'sprite' && stage.style !== 'big') {
        return { text: 'Focus pane: les lasagnes sont pour le chat en sprites (pet sprite ou pet big).' }
      }
      const isServed = !/\soff$/i.test(args)
      feast(isServed)

      return { text: isServed ? 'Focus pane: lasagnes servies, une minute de folie.' : 'Focus pane: table débarrassée.' }
    }

    if (args === 'cat' || args.startsWith('cat ')) {
      const coat = asPetCoat(args.slice('cat'.length).trim().toLowerCase())
      if (coat === null) return { text: 'Focus pane: cat roux | noir | garfield | panda.' }
      await update($, petCoat, () => coat)
      await $.store.set('cat', coat).catch(() => undefined)

      return { text: coat === 'panda' ? 'Focus pane: le panda entre en scène.' : `Focus pane: le chat ${coat} entre en scène.` }
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
      await update($, agents, () => demoAgents(now))
      await tick($).catch(() => undefined)
      await update($, focus, was => ({
        ...was,
        isDismissed: false,
        ticket: was.ticket ?? DEMO_FEATURE.ticket,
        mission: was.mission ?? 'Livrer la console admin des comptes : liste, détail, relevé et attestation',
        isMissionPhrased: true,
        summary: was.summary ?? 'Brancher le relevé de compte sur le SDK back-office',
        isPinned: true,
      }))

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
    if (!(e as { agentId?: unknown }).agentId) await reconcileAgents($).catch(() => undefined)

    return next(e)
  })

  // A subagent started: its row is made as soon as the engine gives it an id.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    try {
      const started = ran.deny === undefined ? ran : null
      if (started?.agentId) {
        const id = started.agentId
        const now = await $.clock.now()
        const title = e.description || e.subagentType
        await update($, agents, was =>
          was.some(one => one.id === id)
            ? was.map(one => (one.id === id ? { ...one, title, type: e.subagentType, model: one.model ?? started.model } : one))
            : trimAgents([...was, blankAgent(id, title, e.subagentType, started.model, now)]),
        )
        await tick($)
      }
    } catch {
      // Tracking an agent never gets in the spawn's way.
    }

    return ran
  })

  // Each request of a subagent's loop: its context, tokens and cost grow.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const main = yield* next(e)
      try {
        const was = await read($, mainLoop)
        const made = { model: main.usage?.model || e.model || was.model, effort: e.effort ?? was.effort }
        // `update` writes whatever it is handed, and every write redraws: an unchanged loop is left alone.
        if (made.model !== was.model || made.effort !== was.effort) await update($, mainLoop, () => made)
      } catch {
        // Noting the main loop never gets in a step's way.
      }

      return main
    }
    const ran = yield* next(e)
    try {
      await noteStep($, e.agentId, e, ran.usage)
    } catch {
      // Tracking an agent never gets in a step's way.
    }

    return ran
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
    if (!e.agentId) play('dust')

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
    const args = e as unknown as {
      taskId?: unknown
      subject?: unknown
      activeForm?: unknown
      status?: unknown
      addBlockedBy?: unknown
      addBlocks?: unknown
    }
    const id = asText(args.taskId)
    if (!id) return ran
    if (args.status === 'completed') feel('♪')
    const blockers = asIds(args.addBlockedBy)
    const blocked = asIds(args.addBlocks)

    await update($, todos, was =>
      args.status === 'deleted'
        ? was.filter(one => one.id !== id)
        : was.map(one => {
            // This task gains the blockers it was given, and is a blocker of the ones it blocks.
            const gains = [...(one.id === id ? blockers : []), ...(one.id !== undefined && one.id !== id && blocked.includes(one.id) ? [id] : [])]
            const waits = gains.length > 0 ? { blockedBy: joined(one.blockedBy, gains) } : {}
            if (one.id !== id) return gains.length > 0 ? { ...one, ...waits } : one

            return {
              ...one,
              ...waits,
              content: asText(args.subject) || one.content,
              activeForm: asText(args.activeForm) || asText(args.subject) || one.activeForm,
              status:
                args.status === 'pending' || args.status === 'in_progress' || args.status === 'completed'
                  ? args.status
                  : one.status,
            }
          }),
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

        const blockedBy = Array.isArray(row.blockedBy) ? { blockedBy: asIds(row.blockedBy) } : {}

        return [{ id, content, status, activeForm: was.find(old => old.id === id)?.activeForm ?? content, ...blockedBy }]
      }),
    )

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) {
      await endAgent($, e.agentId, e.reason, e.usage).catch(() => undefined)

      return ran
    }

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
    await reconcileAgents($).catch(() => undefined)

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

  on('ui.press', async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== GALLERY) return next(e)
    const [kind, verb] = e.element.split(':')

    if (kind === 'bao' && verb === 'plant') {
      baoPlant()
    } else if (kind === 'gallery' && verb === 'open') {
      await $.ui.open({ id: GALLERY, title: 'Maquettes', focus: true }).catch(() => undefined)
      void loadGallery($).catch(() => undefined)
    } else if (kind === 'gallery' && verb === 'back') {
      await $.ui.open({ id: PANE, title: 'Focus', focus: true }).catch(() => undefined)
    } else if (kind === 'agents' && verb === 'fold') {
      await update($, agentsView, was => ({ ...was, isFolded: !was.isFolded }))
    } else if (kind === 'agents' && verb === 'done') {
      await update($, agentsView, was => ({ ...was, isDoneHidden: !was.isDoneHidden }))
    }

    if (kind === 'design' && verb === 'open') {
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
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Link = 'Link' in table ? table.Link : undefined
    const room = Math.max(24, e.props.bodyColumns) - 2
    const seated: Focus = await read($, focus)
    const plan: Todo[] = await read($, todos)
    const rows: FeedRow[] = await read($, feed)
    const crew: AgentRow[] = await read($, agents)
    const main: MainLoop = await read($, mainLoop)
    const view: AgentsView = await read($, agentsView)
    const state: TurnState = await read($, turn)
    const spent: Usage = await read($, usage)
    const bound: Feature | null = await read($, feature)
    const tone = TONES[await read($, skin)]
    const mine = await read($, command)
    const now = await $.clock.now()
    const parts: Elements = { Box, Text, Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined }
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
    const stats: Stat[] = [
      { key: 'card:COÛT', label: 'COÛT', value: spent.usd === null ? '—' : dollars(spent.usd) },
      {
        key: 'card:CONTEXTE',
        label: 'CONTEXTE',
        aside: spent.percent === null ? '' : `${Math.round(spent.percent)}%`,
        value: spent.tokens === null ? '—' : compact(spent.tokens),
        gauge: {
          ratio: spent.percent === null ? 0 : spent.percent / 100,
          color: spent.percent !== null && spent.percent >= 80 ? tone.bad : tone.mark,
        },
      },
      { key: 'card:TOURS', label: 'TOURS', aside: state.isRunning ? '●' : '', value: String(state.count + (state.isRunning ? 1 : 0)) },
      { key: 'card:TEMPS', label: 'TEMPS', value: spent.startedAt === null ? '—' : span(now - spent.startedAt) },
    ]
    const isWide = room >= 84
    // Four to a row from 56 cells, else two: 4 rows or 8.
    const isFour = room >= 56
    const perRow = isFour ? 4 : 2
    const cardWidth = Math.floor((room - (perRow - 1)) / perRow)
    // Off the terminal a width is no count of cells, and the font is not a grid:
    // the blocks there take a share of their row and flex, instead of a number.
    const isCells = e.surface === 'terminal'
    const cardShare = `${Math.floor(100 / perRow) - 2}%`
    const cards = (
      <Box flexDirection="column" width="100%">
        {[0, perRow]
          .filter(from => from < stats.length)
          .map(from => (
            <Box flexDirection="row" width="100%" columnGap={1}>
              {stats.slice(from, from + perRow).map(one => stat(parts, tone, one, isCells ? cardWidth : cardShare))}
            </Box>
          ))}
      </Box>
    )

    // ---------------------------------------------------------------- the fit
    // The pane is exactly as tall as its window: every block is counted in rows,
    // and what does not fit gives way in this order: the outlines, then the todo list.
    const tall = e.props.scroll.bodyRows
    const papers = (bound?.docs ?? []).filter(one => one.kind !== 'design')
    const design = bound?.docs.find(one => one.kind === 'design')
    const paperWidth = isWide && papers.length > 1 ? Math.floor((room - 1) / 2) : room
    const briefLines = (said: string | null) =>
      Math.min(BRIEF_LINES, Math.max(1, Math.ceil((said ?? '').length / briefWidth)))

    // The pixel cat is a Raster on a painted ground; without either, the line cat
    // takes its place, being plain text.
    // Every surface's table names every element; only the terminal draws cells.
    const Raster = e.surface === 'terminal' && 'Raster' in table ? table.Raster : undefined
    const asked: PetStyle = await read($, petStyle)
    const coat: PetCoat = await read($, petCoat)
    const canPixel = Raster !== undefined && tone.panel !== undefined && tone.text !== undefined
    const Image = e.surface === 'terminal' && 'Image' in table ? table.Image : undefined
    // Where there is no grid of cells to paint but real pictures: the desktop.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const isSvg = Svg !== undefined && Raster === undefined && asked !== 'off'
    const fitted: PetStyle = isSvg ? 'off' : asked !== 'off' && asked !== 'line' && !canPixel ? 'line' : asked
    // No Image on this surface, or a terminal that refused it: the sprite cat.
    const style: PetStyle = fitted === 'png' && (Image === undefined || imageRefusal !== '') ? 'sprite' : fitted
    // The panda, on a terminal, has a world of its own in place of the meadow, and a key to plant in it.
    const isBao = coat === 'panda' && (style === 'sprite' || style === 'big') && canPixel
    const petRows =
      isBao ? BAO_ROWS + 1 : style === 'png' ? PNG_ROWS : style === 'sprite' || style === 'big' ? stripRows() : style === '3d' ? CAT3_ROWS : style === 'pixel' ? PET_ROWS : style === 'line' ? LINE_ROWS : 0
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
    stage.coat = coat
    stage.isBao = isBao
    // What the meadow shows of the session: a bloom a finished todo, a mushroom a failed call.
    scene.done = done
    scene.fails = rows.filter(one => one.isError).length
    stage.left = pngLeft(room)
    stage.root = $.plugin.root
    stage.isSvg = isSvg
    if (isSvg) {
      // The big sheet, on a stage counted in its own pixels.
      stage.style = 'big'
      stage.columns = SVG_WIDTH
      svgDrawn = svgKey()
    }

    const rowsOf = (outlines: number, todosKept: number, isCompact = false) => {
      const paperRows = (one: Doc) =>
        Math.min(one.outline.length, outlines) + (one.outline.length > outlines ? 1 : 0) + 4
      const book =
        bound === null
          ? 0
          : (design ? 4 : 3) +
            // Compact: the papers shrink to one row of their statuses, and their links go.
            (isCompact
              ? papers.length > 0 ? 1 : 0
              : paperWidth === room
                ? papers.reduce((sum, one) => sum + paperRows(one), 0)
                : Math.max(0, ...papers.map(paperRows)))
      const list = plan.length === 0 ? 0 : 3 + Math.min(plan.length, todosKept)

      return (
        1 + // header
        2 + briefLines(seated.mission) + briefLines(seated.summary) +
        (isFour ? 4 : 8) + // cards
        book +
        list +
        petRows +
        1 // legend
      )
    }

    type Line = { kind: 'agent'; row: AgentRow } | { kind: 'todo'; todo: Todo; rank: string }
    // Newest first; the same moment, the one spawned last.
    const newest = (a: { at: number; time: number }, b: { at: number; time: number }) => b.time - a.time || b.at - a.at
    const runningL: Line[] = crew
      .map((row, at) => ({ row, at, time: row.startedAt }))
      .filter(one => one.row.status === 'running')
      .sort(newest)
      .map(one => ({ kind: 'agent', row: one.row }))
    const doneL: Line[] = crew
      .map((row, at) => ({ row, at, time: row.endedAt ?? row.startedAt }))
      .filter(one => one.row.status !== 'running')
      .sort(newest)
      .map(one => ({ kind: 'agent', row: one.row }))
    const plannedL: Line[] = plan.flatMap((todo, at): Line[] =>
      todo.status === 'pending' ? [{ kind: 'todo', todo, rank: todo.id ?? String(at + 1) }] : [],
    )
    const lines: Line[] = [...runningL, ...(view.isDoneHidden ? [] : doneL), ...plannedL]
    const isEmpty = crew.length === 0 && plannedL.length === 0
    const hasCards = crew.length > 0

    const isAvatar = e.surface !== 'mobile' && (Raster !== undefined || Svg !== undefined)
    // What the section takes in rows, for `kept` of its lines, the first `open` of them unfolded
    // and the others one row each; the totals ride in the title row, they take none. An unfolded
    // line takes a rule under it, unless it is the last one shown, and the first unfolded line of
    // a group an empty row above it, under the group's title: an agent's four rows (its avatar
    // beside the title, meta and stats, the bar beneath them), a planned task its avatar's.
    const agentsRows = (open: number, kept: number) => {
      const shown = lines.slice(0, kept)
      const titles =
        (shown.some(one => one.kind === 'agent' && one.row.status === 'running') ? 1 : 0) +
        (doneL.length > 0 ? 1 : 0) +
        (shown.some(one => one.kind === 'todo') ? 1 : 0)
      const groupOf = (one: Line) => (one.kind === 'todo' ? 'planned' : one.row.status === 'running' ? 'running' : 'done')
      let body = 0
      let margins = 0
      shown.forEach((one, at) => {
        if (at >= open) {
          body += 1

          return
        }
        body += (one.kind === 'agent' ? 4 : isAvatar ? AVATAR_ROWS : 2) + (at < shown.length - 1 ? 1 : 0)
        // The first unfolded line of each group drawn has an empty row above it, under its title.
        if (at === 0 || groupOf(shown[at - 1]!) !== groupOf(one)) margins += 1
      })

      return 3 + 1 + titles + margins + body + (kept < lines.length ? 1 : 0)
    }
    // ---- Who gives way first. The Sacred Book and the todos fold before the agents do:
    // 0. start at the floors (outlines and todos), every line folded;
    // 1. with agents, the first lines (the running ones, else the latest finished) must unfold:
    //    the outlines go down to none, the todos to the step in hand, the book to compact, one
    //    notch at a time, until they fit; past the last notch the count of unfolded lines goes down;
    // 2. then greedily, one unit at a time, and the first unit that does not fit ends it: the other
    //    agents unfold, the outlines and the todos come back (only if step 1 cost nothing), then
    //    the planned tasks unfold.
    type Fit = { outlines: number; todos: number; isCompact: boolean }
    const floor: Fit = { outlines: OUTLINE_LEAST, todos: TODOS_LEAST, isCompact: false }
    const notches: Fit[] = [floor]
    const notch = (next: Fit) => {
      const was = notches[notches.length - 1]!
      // A notch that frees no row is no notch at all.
      if (rowsOf(next.outlines, next.todos, next.isCompact) < rowsOf(was.outlines, was.todos, was.isCompact)) notches.push(next)
    }
    for (let at = OUTLINE_LEAST - 1; at >= 0; at -= 1) notch({ ...notches[notches.length - 1]!, outlines: at })
    for (let at = TODOS_LEAST - 1; at >= TODOS_ONE; at -= 1) notch({ ...notches[notches.length - 1]!, todos: at })
    notch({ ...notches[notches.length - 1]!, isCompact: true })

    const agentCount = lines.filter(one => one.kind === 'agent').length
    const unfoldable = view.isFolded ? 0 : lines.length
    const fits = (at: Fit, unfolded: number) =>
      rowsOf(at.outlines, at.todos, at.isCompact) + agentsRows(unfolded, lines.length) <= tall
    let fit = floor
    let open = 0
    let isDegraded = false
    if (agentCount > 0) {
      let want = view.isFolded ? 0 : runningL.length > 0 ? runningL.length : 1
      const first = notches.findIndex(at => fits(at, want))
      if (first >= 0) {
        fit = notches[first]!
        isDegraded = first > 0
      } else {
        fit = notches[notches.length - 1]!
        isDegraded = notches.length > 1
        while (want > 0 && !fits(fit, want)) want -= 1
      }
      open = want
    }
    let isStopped = false
    // 2a: the other agents.
    while (!isStopped && open < Math.min(agentCount, unfoldable)) {
      if (fits(fit, open + 1)) open += 1
      else isStopped = true
    }
    // 2b: the outlines, then the todos, back up.
    while (!isStopped && !isDegraded && fit.outlines < OUTLINE_SHOWN) {
      if (fits({ ...fit, outlines: fit.outlines + 1 }, open)) fit = { ...fit, outlines: fit.outlines + 1 }
      else isStopped = true
    }
    while (!isStopped && !isDegraded && fit.todos < plan.length) {
      if (fits({ ...fit, todos: fit.todos + 1 }, open)) fit = { ...fit, todos: fit.todos + 1 }
      else isStopped = true
    }
    // 2c: the planned tasks.
    while (!isStopped && open < unfoldable) {
      if (fits(fit, open + 1)) open += 1
      else isStopped = true
    }
    const { outlines, isCompact } = fit
    const todosKept = Math.max(fit.todos, 0)

    // The todo list's window, when it had to give rows: it follows the step in hand.
    const doing = Math.max(0, plan.findIndex(one => one.status === 'in_progress'))
    const isCut = todosKept < plan.length
    // One step shown: the one in hand; more, the step before it too.
    const todosFrom = isCut ? Math.max(0, Math.min(doing - (todosKept > TODOS_ONE ? 1 : 0), plan.length - (todosKept - 1))) : 0
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


    // ------------------------------------------------------------- the agents
    // With the rows left, as many lines unfolded as fit, from the first in display order (the
    // running ones, the latest finished, the planned) and the others one row each. When even all
    // folded do not fit, the first lines alone are kept, the running ones longest. The person's
    // fold takes none unfolded.
    const budget = tall - rowsOf(outlines, todosKept, isCompact)
    let kept = lines.length
    // Past the floor the pane overflows and scrolls: a running agent is never cut for room.
    if (open === 0) {
      while (kept > runningL.length && agentsRows(0, kept) > budget) kept -= 1
    }
    const shown = lines.slice(0, kept)

    const avatar = (key: string, seed: string | null, isPlanned: boolean) => {
      const cells = avatarGlyphs(seed, isPlanned, tone.card)

      return (
        <Box flexShrink={0} width={isCells ? AVATAR_COLUMNS : undefined}>
          {Raster !== undefined ? (
            <Raster key={key} columns={AVATAR_COLUMNS} rows={AVATAR_ROWS} cells={avatarCells(cells, tone.card)} />
          ) : (
            Svg !== undefined && <Svg source={avatarSvg(cells)} alt="agent" width={36} height={25} />
          )}
        </Box>
      )
    }
    const colWidth = Math.max(8, isAvatar ? inner - AVATAR_COLUMNS - 1 : inner)
    const rule = (
      <Text color={tone.frame} dimColor={tone.frame === undefined} backgroundColor={tone.card} wrap="truncate-end">
        {'─'.repeat(Math.max(1, inner))}
      </Text>
    )
    const iconOf = (row: AgentRow) =>
      row.status === 'running'
        ? { mark: '●', color: tone.bad }
        : row.status === 'completed'
          ? { mark: '✓', color: tone.ok }
          : { mark: '✗', color: tone.bad }
    const waitsOn = (todo: Todo) => {
      const open = (todo.blockedBy ?? []).filter(id => plan.find(one => one.id === id)?.status !== 'completed')

      return open.length > 0 ? `après ${open.join(', ')}` : 'prête'
    }

    const agentLine = (row: AgentRow, isFirst: boolean, isFolded: boolean) => {
      const tier = tierOf(row.effort)
      const room = windowOf(row.model ?? '')
      const used = Math.min(1, row.context / room)
      const pct = Math.round((row.context / room) * 100)
      const ms = (row.endedAt ?? now) - row.startedAt
      const icon = iconOf(row)
      const name = row.model === null ? row.type : modelName(row.model)

      if (isFolded) {
        const right = `${tier === null ? '' : ' · '}${pct}% · ${clock(ms)}`

        return (
          <Box key={`agents:row:${row.id}`} flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
            <Text backgroundColor={tone.card} wrap="truncate-end">
              <Text color={icon.color} backgroundColor={tone.card}>{icon.mark}</Text>
              <Text bold color={tone.text} backgroundColor={tone.card}>
                {` ${cut(row.title, Math.max(8, inner - right.length - (tier?.length ?? 0) - 4))}`}
              </Text>
            </Text>
            <Text backgroundColor={tone.card} wrap="truncate-end">
              {tier !== null && <Text bold color={tone.tiers[tier]} backgroundColor={tone.card}>{tier}</Text>}
              <Text {...quiet(tone, tone.card)}>{right}</Text>
            </Text>
          </Box>
        )
      }

      return (
        <Box key={`agents:row:${row.id}`} flexDirection="row" width="100%" columnGap={1} marginTop={isFirst ? 1 : undefined}>
          {isAvatar && avatar(`agent:ava:${row.id}`, row.id, false)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" width="100%" justifyContent="space-between">
              <Text bold color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
                {cut(row.title, colWidth - 2)}
              </Text>
              <Text color={icon.color} backgroundColor={tone.card}>{icon.mark}</Text>
            </Box>
            <Text backgroundColor={tone.card} wrap="truncate-end">
              {tier !== null && <Text bold color={tone.tiers[tier]} backgroundColor={tone.card}>{tier}</Text>}
              <Text color={tone.chipText} backgroundColor={tone.card}>
                {`${tier === null ? '' : ' '}${name}${row.effort === null ? '' : ` · ${row.effort}`}`}
              </Text>
            </Text>
            <Text color={tone.chipText} backgroundColor={tone.card} wrap="truncate-end">
              {`ctx ${pct}% · ${compact(row.context)} ${dollars(row.usd)} ${clock(ms)}`}
            </Text>
            {meter(parts, tone, used, colWidth, tier === null ? tone.mark : tone.tiers[tier], '━')}
          </Box>
        </Box>
      )
    }

    const plannedLine = (todo: Todo, rank: string, isFirst: boolean, isFolded: boolean) => {
      const waits = waitsOn(todo)

      if (isFolded) {
        return (
          <Box key={`agents:todo:${rank}`} flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
            <Text {...quiet(tone, tone.card)} wrap="truncate-end">
              {`◷ ${cut(`${rank}. ${todo.content}`, Math.max(8, inner - waits.length - 4))}`}
            </Text>
            <Text {...quiet(tone, tone.card)}>{waits}</Text>
          </Box>
        )
      }

      return (
        <Box key={`agents:todo:${rank}`} flexDirection="row" width="100%" columnGap={1} marginTop={isFirst ? 1 : undefined}>
          {isAvatar && avatar(`agent:ava:todo-${rank}`, null, true)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="center">
            <Box flexDirection="row" width="100%" justifyContent="space-between">
              <Text bold color={tone.text} backgroundColor={tone.card} wrap="truncate-end">
                {cut(`${rank}. ${todo.content}`, colWidth - 2)}
              </Text>
              <Text {...quiet(tone, tone.card)}>◷</Text>
            </Box>
            <Text {...quiet(tone, tone.card)} wrap="truncate-end">
              {waits}
            </Text>
          </Box>
        </Box>
      )
    }

    // Group titles go in front of their group's lines; the finished one is always a button.
    const groupTitle = (label: string) => <Text {...quiet(tone, tone.card)}>{label}</Text>
    const shownRunning = shown.filter(one => one.kind === 'agent' && one.row.status === 'running')
    const shownDone = shown.filter(one => one.kind === 'agent' && one.row.status !== 'running')
    const shownPlanned = shown.filter(one => one.kind === 'todo')
    // A line, and the rule under it when it is unfolded, unless it is the last one shown. A line
    // is unfolded when its place in the display order is among the first `open`.
    const lineNodes = (group: Line[], from: number) =>
      group.flatMap((one, at) => {
        const isFolded = from + at >= open

        return [
          one.kind === 'agent' ? agentLine(one.row, at === 0, isFolded) : plannedLine(one.todo, one.rank, at === 0, isFolded),
          ...(!isFolded && from + at < shown.length - 1 ? [rule] : []),
        ]
      })
    const doneTitle = doneL.length > 0 && (
      <Box flexDirection="row" width="100%">
        <Button
          key="agents:done"
          plain
          label={`${view.isDoneHidden ? '▸' : '▾'} Terminés · ${doneL.length}`}
          dimColor
          onPress={() => undefined}
        />
      </Box>
    )

    const inHand = plan.find(one => one.status === 'in_progress')
    const sum = (pick: (one: AgentRow) => number) => crew.reduce((total, one) => total + pick(one), 0)
    const isAllOver = crew.every(one => one.endedAt !== null)
    const wall =
      crew.length === 0
        ? 0
        : (isAllOver ? Math.max(...crew.map(one => one.endedAt ?? 0)) : now) - Math.min(...crew.map(one => one.startedAt))
    // The totals ride in the title row, right before the fold button: the title of the todo
    // in hand gives way to them, never the other way round.
    const totals = hasCards ? `${dollars(sum(one => one.usd))} · ${compact(sum(one => one.tokens))} · ${clock(wall)}` : ''
    const foldLabel = view.isFolded ? 'déplier' : 'replier'
    const titleRoom = Math.max(8, inner - 'AGENTS ›'.length - 1 - (totals === '' ? 0 : totals.length + 1) - (isEmpty ? 0 : foldLabel.length + 1) - 2)
    const mainTier = tierOf(main.effort)
    const mainRight = [main.model === null ? '' : modelName(main.model), spent.percent === null ? '' : `${Math.round(spent.percent)}%`, turnClock ?? '']
      .filter(one => one !== '')
      .join(' · ')
    const mainRow = (
      <Box key="agents:main" flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
        <Text backgroundColor={tone.card} wrap="truncate-end">
          {state.isRunning ? (
            <Text color={tone.bad} backgroundColor={tone.card}>●</Text>
          ) : (
            <Text {...quiet(tone, tone.card)}>○</Text>
          )}
          <Text bold color={tone.text} backgroundColor={tone.card}>{' Principal'}</Text>
          {!state.isRunning && <Text {...quiet(tone, tone.card)}>{' · au repos'}</Text>}
        </Text>
        <Text backgroundColor={tone.card} wrap="truncate-end">
          {mainTier !== null && <Text bold color={tone.tiers[mainTier]} backgroundColor={tone.card}>{mainTier}</Text>}
          <Text {...quiet(tone, tone.card)}>{`${mainTier === null || mainRight === '' ? '' : ' · '}${mainRight}`}</Text>
        </Text>
      </Box>
    )
    const agentsBlock = (
      <Box
        key="agents"
        flexDirection="column"
        width="100%"
        flexGrow={1}
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        <Box key="agents:title" flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text backgroundColor={tone.card} wrap="truncate-end">
              <Text {...quiet(tone, tone.card)}>AGENTS ›</Text>
              {inHand !== undefined && (
                <Text bold color={tone.text} backgroundColor={tone.card}>
                  {` ${cut(inHand.content, titleRoom)}`}
                </Text>
              )}
            </Text>
          </Box>
          <Box flexShrink={0} flexDirection="row" columnGap={1}>
            {totals !== '' && <Text {...quiet(tone, tone.card)}>{totals}</Text>}
            {!isEmpty && (
              <Button key="agents:fold" plain hotkey="r" label={foldLabel} dimColor onPress={() => undefined} />
            )}
          </Box>
        </Box>
        {mainRow}
        {shownRunning.length > 0 && groupTitle(`En cours · ${runningL.length}`)}
        {lineNodes(shownRunning, 0)}
        {doneTitle}
        {lineNodes(shownDone, shownRunning.length)}
        {shownPlanned.length > 0 && groupTitle(`Planifiés · ${plannedL.length}`)}
        {lineNodes(shownPlanned, shownRunning.length + shownDone.length)}
        {kept < lines.length && <Text {...quiet(tone, tone.card)}>{`+ ${lines.length - kept} autres`}</Text>}
      </Box>
    )

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
        width={isCells ? paperWidth : paperWidth === room ? '100%' : '49%'}
        flexGrow={isCells ? 0 : 1}
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
          {isCompact && papers.length > 0 && (
            <Box key="book:statuses" flexDirection="row" width="100%" columnGap={3}>
              {papers.map(one => (
                <Box key={`book:status:${one.kind}`} flexDirection="row" columnGap={1}>
                  <Text {...quiet(tone, tone.card)}>{one.kind === 'spec' ? 'SPEC ›' : 'PLAN ›'}</Text>
                  {status(one.status)}
                </Box>
              ))}
            </Box>
          )}
        </Box>
        {!isCompact && (
          <Box flexDirection={paperWidth === room ? 'column' : 'row'} width="100%" columnGap={1}>
            {papers.map(paper)}
          </Box>
        )}
      </Box>
    )

    const footer = legend(parts, tone, [
      // Seated above the prompt, not docked: only the fullscreen renderer docks a pane, and the person alone switches to it.
      ...(e.props.placement === 'inline' && e.surface === 'terminal' ? ([['/tui fullscreen', 'Pane à droite']] as const) : []),
      ...(design ? ([['m', 'Miniatures'], ['o', 'Maquette']] as const) : []),
      ...(isBao ? ([['b', 'Bambou']] as const) : []),
      ...(isEmpty ? [] : ([['r', 'Replier']] as const)),
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
        {agentsBlock}
        {style === 'pixel' && Raster !== undefined && tone.panel !== undefined && tone.text !== undefined && (
          <Raster
            key="pet"
            columns={room}
            rows={PET_ROWS}
            cells={petStrip(room, tone.panel, tone.text, mood)}
          />
        )}
        {isSvg && Svg !== undefined && <Svg source={sceneSvg(tone.panel)} alt="Le chat du pane dans sa prairie" />}
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
        {isBao && (
          <Box flexDirection="row" width="100%" justifyContent="flex-end">
            <Button key="bao:plant" plain hotkey="b" label="planter un bambou" dimColor onPress={() => undefined} />
          </Box>
        )}
        {isBao && Raster !== undefined && <Raster key="pet" columns={room} rows={BAO_ROWS} cells={baoStrip(room)} />}
        {!isBao && (style === 'sprite' || style === 'big') && Raster !== undefined && tone.panel !== undefined && tone.text !== undefined && (
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
    // Every surface's table names every element; only the terminal draws cells.
    const Raster = e.surface === 'terminal' && 'Raster' in table ? table.Raster : undefined
    const room = Math.max(24, e.props.bodyColumns) - 2
    const tone = TONES[await read($, skin)]
    const bound: Feature | null = await read($, feature)
    const seen: Gallery = await read($, gallery)
    const parts: Elements = { Box, Text, Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined }
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
