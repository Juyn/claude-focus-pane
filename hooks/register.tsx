import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, TextProps, Timer } from 'claude-code'

import type { Board, Doc, Feature, FeedRow, Gallery, Focus, Skin, Todo, TurnState, Usage } from '../types'

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
const TICKET = new RegExp(`\\b(?:${PREFIXES.join('|')})-\\d{1,6}\\b`)

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
[ -z "$d" ] && d=$(grep -rlw --include=README.md -- "$1" v1 v2 2>/dev/null | head -n 1 | xargs -r dirname)
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

/** The elapsed-time ticker: a module value, so a reload drops it with its timer. */
let ticker: Timer | undefined

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
  const first =
    asText(args.command) ||
    asText(args.file_path) ||
    asText(args.pattern) ||
    asText(args.description) ||
    asText(args.skill) ||
    asText(args.url) ||
    asText(args.query) ||
    asText(args.path)

  return first.replace(/\s+/g, ' ')
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
  argumentHint: 'auto | mission <texte> | spec <feature|off> | demo | UNL-1234 <texte>',
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
    ticket: readme.join('\n').match(TICKET)?.[0] ?? null,
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
    void $.ui.open({ id: PANE, title: 'Focus' }).catch(() => undefined)

    await claimCommand($, true).catch(reason => {
      $.ui.toast(`focus-pane: commande non enregistrée (${String(reason)})`)
    })

    await wearTheme($).catch(() => undefined)
    await meterUsage($).catch(() => undefined)

    const saved = await shelf($)
      .then(key => $.store.get(key))
      .then(asBoard)
      .catch(() => null)
    if (saved !== null) await update($, board, () => saved)

    // The feature this directory was last bound to, read again: the files moved on.
    const bound = asText(await $.store.get(`feature:${await $.session.cwd()}`).catch(() => null))
    if (bound) await bindFeature($, bound.split('/').pop() ?? bound).catch(() => null)

    const branch = await $.process
      .run(['git', 'branch', '--show-current'], { cwd: await $.session.cwd() })
      .then(ran => (ran.exitCode === 0 ? ran.stdout.trim() : ''))
      .catch(() => '')

    const hit = branch.match(TICKET)
    await update($, focus, was => ({
      ...was,
      branch: branch || null,
      ticket: was.ticket ?? (hit ? hit[0] : null),
    }))
    if (hit && (await read($, feature)) === null) await bindFeature($, hit[0]).catch(() => null)

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

        return { text: 'Focus pane: plus de feature Sacred Book liée.' }
      }
      const bound = await bindFeature($, asked.replace(/\/+$/, '').split('/').pop() ?? asked)

      return {
        text: bound
          ? `Focus pane lié à ${bound.path} (${bound.docs.map(one => one.kind).join(', ')}).`
          : `Aucune feature Sacred Book ne répond à « ${asked} ».`,
      }
    }

    if (args === 'demo') {
      const fake = demoTodos(await read($, feature))
      await update($, todos, () => fake)

      return { text: `Focus pane: todo list de démonstration (${fake.length} étapes).` }
    }

    const isMission = args.startsWith('mission ')
    const said = isMission ? args.slice('mission '.length).trim() : args
    const hit = said.match(TICKET)
    const rest = hit ? said.replace(hit[0], '').trim() : said

    await update($, focus, was => ({
      ...was,
      isDismissed: false,
      ticket: hit ? hit[0] : was.ticket,
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
      ticket: hit ? hit[0] : was.ticket,
      mission: was.mission ?? (isMissionWorthy(asked) ? cut(asked, 200) : null),
    }))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await claimCommand($).catch(() => undefined)
    const now = await $.clock.now()
    await update($, turn, was => ({ ...was, isRunning: true, startedAt: now }))
    await meterUsage($).catch(() => undefined)

    const seated = await read($, focus)
    if (!seated.isDismissed) {
      const up = await $.ui.panes()
      if (!up.some(one => one.id === PANE)) void $.ui.open({ id: PANE, title: 'Focus' })
    }

    ticker?.cancel()
    ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    sequence += 1
    const id = `${at}-${sequence}`
    const row: FeedRow = { id, tool: String(e.tool), detail: detailOf(e), at, ms: null, isError: false }
    await update($, feed, was => [row, ...was].slice(0, FEED_KEPT))

    const close = async (isError: boolean) => {
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
    if (wrote.length > 0) await update($, todos, () => wrote)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran

    ticker?.cancel()
    ticker = undefined
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
            'Tu reformules la demande initiale en une mission. Une seule phrase nominale de ' +
            '12 mots maximum, en français, sans guillemets, sans préambule, sans point final.',
          prompt: `Demande initiale :\n${seated.mission}`,
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

    const badgeWidth = 7
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
            {chip(parts, cut(one.tool, badgeWidth).padEnd(badgeWidth), badge.background, badge.text)}
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
