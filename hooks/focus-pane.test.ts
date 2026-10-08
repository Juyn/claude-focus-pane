import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, FsEntry, On, TurnUsage } from 'claude-code'
import type { Heartbeat } from '../types'

const PANE = 'focus'

const PROPS = {
  title: 'Focus',
  isFocused: false,
  bodyColumns: 48,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** What the engine beneath reports a subagent's next step cost, by agent id. */
const stepped = new Map<string, TurnUsage>()
let spawned = 0

/** What the plugin wrote with $.fs.write, in order. */
const written: { path: string; text: string }[] = []
/** What $.fs.read answers, by path, and what $.fs.list answers, by directory. */
const files = new Map<string, string>()
const folders = new Map<string, FsEntry[]>()
/** What $.env.get answers for HOME: a test unsets it to play a session with no home. */
let home: string | undefined

/** The engine beneath the plugin: the test answers for it. */
const engine = (on: On, theme = 'dark') => {
  stepped.clear()
  spawned = 0
  written.length = 0
  files.clear()
  folders.clear()
  home = '/home/test'
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? home : undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: 'session-test' }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', (_$, e) => ({ value: folders.get(e.path) ?? [] }))
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'claude-opus-5-5', agentId: `a${spawned}` }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: stepped.get(e.agentId ?? '') ?? null,
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ isError: true as const, result: null, text: 'no tool beneath the test' }))
  on('ui.render', () => ({ type: 'Text' as const, children: [] }))
  const rows: ConfigRow[] = [
    {
      key: 'theme',
      label: 'Theme',
      kind: 'choice',
      value: theme,
      provider: { plugin: 'core', tier: 'core' },
      isLocked: false,
    },
  ]
  on('config.list', () => ({ value: rows }))
  on('config.set', ($, e) => ({ value: e.value }))

  return clock
}

/** The theme row drives the palette; /config switching it repaints with no reload. */
const wear = ($: Engine, theme: string) =>
  $.config.set({
    key: 'theme',
    value: theme,
    previous: 'dark',
    provider: { plugin: 'core', tier: 'core' },
    origin: { kind: 'composer' },
  })

const wide = ($: Engine) =>
  $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 70 },
  })

test('the pane draws the ticket and the mission a first prompt names', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'on attaque UNL-4818, le signup auto-login', wait: false, origin: { kind: 'composer' } })

  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PROPS,
  })

  expect(await pane.find({ text: /UNL-4818/ })).toBeDefined()
  expect(await pane.find({ text: ' MISSION ' })).toBeDefined()
  expect(await pane.find({ text: /le signup auto-login/ })).toBeDefined()
})

test('the mission holds while the prompts move on', async ($, on) => {
  engine(on)
  const first = 'couvrir le signup auto-login en e2e Playwright'
  await $.prompt.submit({ text: first, wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'maintenant rejoue la mutation', wait: false, origin: { kind: 'composer' } })

  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PROPS,
  })

  expect(await pane.find({ text: new RegExp(first) })).toBeDefined()
  expect(await pane.find({ text: first })).toBeDefined()
})

test('the pane draws the plan TodoWrite wrote, with its progress', async ($, on) => {
  engine(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Monter la stack docker', status: 'completed', activeForm: 'Montage de la stack docker' },
      { content: 'Écrire le test e2e', status: 'in_progress', activeForm: 'Écriture du test e2e' },
      { content: 'Pousser la branche', status: 'pending', activeForm: 'Push de la branche' },
    ],
  })

  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PROPS,
  })

  expect(await pane.find({ text: /Écriture du test e2e/ })).toBeDefined()
  expect(await pane.find({ text: /Monter la stack docker/ })).toBeDefined()
  expect(await pane.find({ text: /1\/3/ })).toBeDefined()
})

test('an empty plan draws no PLAN card and no TODOS section', async ($, on) => {
  engine(on)

  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PROPS,
  })

  // `aucune todo list` was the caption of the PLAN card, which is gone.
  expect(await pane.find({ text: /aucune todo list/ })).toBeUndefined()
  expect(await pane.find({ key: 'card:PLAN' })).toBeUndefined()
  expect(await pane.find({ text: /TODOS/ })).toBeUndefined()
})


const mounted = ($: Engine, bodyColumns: number) =>
  $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns },
  })

const CARDS = ['card:COÛT', 'card:CONTEXTE', 'card:TOURS', 'card:TEMPS']

test('one view draws the brief and the four cards, at every width', async ($, on) => {
  engine(on)

  for (const columns of [120, 48]) {
    const pane = await mounted($, columns)
    for (const key of CARDS) expect(await pane.find({ key })).toBeDefined()
    expect(await pane.find({ text: ' MISSION ' })).toBeDefined()
    await pane.unmount()
  }
})

test('the context card prints what the session reports', async ($, on) => {
  engine(on)
  on('session.usage', () => ({
    value: { startedAt: 1_700_000_000_000 - 240_000, context: { tokens: 84_210, window: 200_000, percent: 42 }, rateLimits: [], cost: { usd: 1.92 } },
  }))
  await $.tool.call({ tool: 'Bash', command: 'cargo test ipc' })
  const pane = await wide($)

  expect(await pane.find({ text: '84.2k' })).toBeDefined()
  expect(await pane.find({ text: '≈$1.92' })).toBeDefined()
  // The caption `42% de 200k` is gone with the captions: the percentage sits beside the label.
  expect(await pane.find({ text: '42%' })).toBeDefined()
  expect(await pane.find({ text: '42% de 200k' })).toBeUndefined()
  expect(await pane.find({ text: '4m' })).toBeDefined()
})

test('switching to a light theme repaints the brand mark', async ($, on) => {
  engine(on)
  const before = await wide($)
  const dark = (await before.find({ type: 'Text', text: '◢ U N L O C K E R' }))?.props.color
  await before.unmount()

  await wear($, 'light')
  const light = (await (await wide($)).find({ type: 'Text', text: '◢ U N L O C K E R' }))?.props.color

  expect(typeof dark).toBe('string')
  expect(light).not.toBe(dark)
})

test('an ansi theme sets no color at all', async ($, on) => {
  engine(on)
  await wear($, 'dark-ansi')
  const pane = await wide($)

  expect((await pane.find({ type: 'Text', text: '◢ U N L O C K E R' }))?.props.color).toBeUndefined()
})

/** The element children of a drawn node, keyed or not. */
const kids = (node: unknown) => ((node as Drawn)?.children ?? []) as NonNullable<Drawn>[]

test('the four compact cards: no PLAN, two rows each, the context gauge on the value line', async ($, on) => {
  engine(on)
  on('session.usage', () => ({
    value: { startedAt: 1_700_000_000_000 - 240_000, context: { tokens: 84_210, window: 200_000, percent: 42 }, rateLimits: [], cost: { usd: 1.92 } },
  }))
  await $.tool.call({ tool: 'Bash', command: 'cargo test ipc' })
  const pane = await wide($)

  expect(await pane.find({ key: 'card:PLAN' })).toBeUndefined()
  expect(await pane.find({ text: /PLAN/ })).toBeUndefined()
  for (const key of CARDS) {
    const card = await pane.find({ key })
    expect(card?.props.borderStyle).toBe('round')
    // Label row + value row inside the frame: 2 + 2 border rows = 4.
    expect(kids(card)).toHaveLength(2)
  }
  const cost = await pane.find({ key: 'card:COÛT' })
  expect(kids(kids(cost)[0])[0]?.children?.join('')).toBe('COÛT')
  expect(kids(cost)[1]?.children?.join('')).toBe('≈$1.92')
  // Context: the value, then its bar, on the one line; no third row.
  const context = await pane.find({ key: 'card:CONTEXTE' })
  const valueLine = kids(context)[1]
  expect(kids(valueLine)).toHaveLength(2)
  expect(kids(valueLine)[0]?.children?.join('')).toBe('84.2k')
  expect(seek(kids(valueLine)[1], node => node.type === 'Text' && /^━+$/.test(String((node.children ?? []).join('')))))
    .toBeDefined()
  expect(kids(kids(context)[0])[1]?.children?.join('')).toBe('42%')
  // Tours: a dot beside the label only during a turn.
  expect(kids(kids(await pane.find({ key: 'card:TOURS' }))[0])).toHaveLength(1)
})

test('four cards a row from 56 columns, two a row below', async ($, on) => {
  engine(on)
  const rowsAt = async (columns: number) => {
    const pane = await mounted($, columns)
    const row = seek(await pane.drawn(), node => kids(node).some(one => one.props?.key === 'card:COÛT'))
    const count = kids(row).filter(one => String(one.props?.key ?? '').startsWith('card:')).length
    await pane.unmount()

    return count
  }

  expect(await rowsAt(70)).toBe(4)
  expect(await rowsAt(60)).toBe(4)
  expect(await rowsAt(52)).toBe(2)
  expect(await rowsAt(48)).toBe(2)
})

test('the pane is always as tall as its window', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 57 } },
  })

  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 57 } })
})

test('the pane no longer draws a feed, comments or a todo of its own', async ($, on) => {
  engine(on)
  const pane = await wide($)

  for (const key of ['feed', 'notes', 'chores', 'focus:note', 'focus:chore', 'focus:link']) {
    expect(await pane.find({ key })).toBeUndefined()
  }
  const legend = (await pane.find({ key: 'legend' }))?.text ?? ''
  for (const word of ['Commenter', 'Tâche', 'Lien']) expect(legend).not.toContain(word)
})

const README = [
  'v2/banking/console-comptes',
  '# Console admin — comptes',
  '',
  '- Spécification : [`spec.md`](specs/spec.md) — *draft*',
  '- Plan : [`plan.md`](plans/plan.md) — *draft*',
  '- Maquette : [`maquettes.html`](design/maquettes.html) — *à valider*',
  '',
  'Linear : [UNL-4844](https://linear.app/unlocker/issue/UNL-4844)',
].join('\n')

const SPEC = '---\ntitle: "Console comptes"\nstatus: draft\n---\n## Problème\n## Ce qui est livré\n### 1. Liste des comptes\n'
const PLAN =
  '---\nstatus: approved\n---\n## Contrat BFF\n### R1 — `GET /accounts` → `GET /v2/accounts`\n### R2 — `GET /accounts/{id}`\n' +
  '### R3 — relevé\n### R4 — attestation\n## api-v2 — en dernier, conforme\n## Front — `apps/admin`\n## Recette (staging)\n'

test('spec binds a Sacred Book feature and demo fills the plan from it', async ($, on) => {
  engine(on)
  const ran: string[][] = []
  on('command.list', () => ({ value: [] }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('process.run', ($$, e) => {
    ran.push([...e.argv])
    const asked = e.argv[e.argv.length - 1] ?? ''
    const stdout = asked === 'console-comptes' ? README : asked.endsWith('spec.md') ? SPEC : asked.endsWith('plan.md') ? PLAN : ''

    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'mission', args: 'spec console-comptes', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const pane = await mounted($, 120)

  expect(await pane.find({ text: 'Console admin — comptes' })).toBeDefined()
  expect(await pane.find({ text: ' UNL-4844 ' })).toBeDefined()
  expect(await pane.find({ key: 'doc:spec' })).toBeDefined()
  expect(await pane.find({ text: '▸ Ce qui est livré' })).toBeDefined()
  expect(await pane.find({ text: ' APPROVED ' })).toBeDefined()
  expect(await pane.find({ text: '  · R1 — GET /accounts' })).toBeDefined()

  await pane.press({ key: 'design:open' })
  expect(ran.some(argv => argv[argv.length - 1] === 'v2/banking/console-comptes/design/maquettes.html')).toBe(true)

  await $.command.run({ command: 'mission', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(await pane.find({ text: /● R3/ })).toBeDefined()
  expect(await pane.find({ text: /^\d+\/\d+$/ })).toBeDefined()
})

test('no bound feature draws no Sacred Book card', async ($, on) => {
  engine(on)

  expect(await (await wide($)).find({ key: 'book' })).toBeUndefined()
})

test('a refused command.register never keeps the pane off screen', async ($, on) => {
  engine(on)
  const opened: string[] = []
  on('command.register', () => {
    throw new Error('"/focus" refused: it is the built-in /focus')
  })
  on('ui.open', ($$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  expect(opened).toContain('focus')
})

test('the command takes the first name the engine does not already have', async ($, on) => {
  engine(on)
  const asked: string[] = []
  on('command.list', () => ({
    value: [
      { name: 'mission', description: 'built-in', source: 'builtin' as const },
      { name: 'focus', description: 'built-in', source: 'builtin' as const },
    ],
  }))
  on('command.register', ($$, e) => {
    asked.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  expect(asked).toEqual(['focus-pane'])
})

test('the pane names the command it was actually granted', async ($, on) => {
  engine(on)
  on('command.list', () => ({ value: [] }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  const pane = await wide($)
  expect(await pane.find({ text: '  /mission' })).toBeDefined()
  expect((await pane.find({ key: 'legend' }))?.text).toMatch(/^\/tui fullscreen Pane à droite  ctrl\+x tab Clavier  esc Rendre la main  \/mission Rouvrir$/)
})

test('a reload registers the remembered command again', async ($, on) => {
  engine(on)
  const asked: string[] = []
  on('command.list', () => ({ value: [] }))
  on('command.register', ($$, e) => {
    asked.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  expect(asked).toEqual(['mission', 'mission'])
})

test('m opens the mockups tab, which draws a thumbnail a screen and keeps the open button', async ($, on) => {
  engine(on)
  const opened: string[] = []
  on('command.list', () => ({ value: [] }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('ui.open', ($$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('process.run', ($$, e) => {
    const asked = e.argv[e.argv.length - 1] ?? ''
    const stdout = e.argv.some(one => one.endsWith('thumbs.py'))
      ? JSON.stringify([
          { id: '1.a', title: 'Liste par défaut', columns: 54, rows: 17, cells: 'gCUAAAAAAAAAAAAA'.repeat(54 * 17) },
          { id: '5.a', title: 'Liste en cartes', columns: 19, rows: 17, cells: 'gCUAAAAAAAAAAAAA'.repeat(19 * 17) },
        ])
      : asked === 'console-comptes'
        ? README
        : asked.endsWith('spec.md')
          ? SPEC
          : asked.endsWith('plan.md')
            ? PLAN
            : ''

    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'mission', args: 'spec console-comptes', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  const pane = await mounted($, 120)
  expect((await pane.find({ key: 'gallery:open' }))?.props.hotkey).toBe('m')
  await pane.press({ key: 'gallery:open' })
  expect(opened).toContain('maquettes')

  const tab = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'maquettes',
    props: { ...PROPS, title: 'Maquettes', bodyColumns: 120 },
  })
  expect((await tab.find({ key: 'thumb:1.a' }))?.props.columns).toBe(54)
  expect(await tab.find({ key: 'thumb:5.a' })).toBeDefined()
  expect(await tab.find({ text: /Liste par défaut/ })).toBeDefined()
  expect(await tab.find({ key: 'design:open' })).toBeDefined()
})

test('a short pane cuts the todo list to a window rather than scroll', async ($, on) => {
  engine(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: Array.from({ length: 12 }, (_unused, at) => ({
      content: `étape ${at + 1}`,
      status: at < 6 ? 'completed' : at === 6 ? 'in_progress' : 'pending',
      activeForm: `étape ${at + 1} en cours`,
    })),
  })
  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 24 } },
  })

  expect(await pane.find({ text: /étape 7 en cours/ })).toBeDefined()
  expect(await pane.find({ text: /\+ 9 autres étapes/ })).toBeDefined()
  expect(await pane.find({ text: /étape 1$/ })).toBeUndefined()
})

test('a prompt opens the pane a narrow terminal kept waiting', async ($, on) => {
  engine(on)
  const opened: string[] = []
  on('ui.open', ($$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })

  await $.prompt.submit({ text: 'bonjour', wait: false, origin: { kind: 'composer' } })

  expect(opened).toEqual(['focus'])
})

test('the task tools fill the plan as TodoWrite does', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.render', () => ({ type: 'Text' as const, children: [] }))
  let made = 0
  on('tool.call', ($$, e) => {
    if (e.tool === 'TaskCreate') {
      made += 1

      return { result: { task: { id: String(made), subject: e.subject } }, text: 'ok' }
    }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] }, text: 'ok' }

    return { isError: true as const, result: null, text: 'no tool beneath the test' }
  })

  await $.tool.call({ tool: 'TaskCreate', subject: 'Écrire le contrat BFF', description: 'x', activeForm: 'Écriture du contrat BFF' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Conformer api-v2', description: 'x' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'À jeter', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' })
  const pane = await wide($)

  expect(await pane.find({ text: /● Écriture du contrat BFF/ })).toBeDefined()
  expect(await pane.find({ text: /○ Conformer api-v2/ })).toBeDefined()
  expect(await pane.find({ text: /À jeter$/ })).toBeUndefined()
  expect(await pane.find({ text: '0/2' })).toBeDefined()
})

test('an agent reading a Sacred Book document binds its feature, as a ticket in a prompt does', async ($, on) => {
  engine(on)
  const asked: string[] = []
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('store.set', () => ({ value: undefined }))
  on('process.run', ($$, e) => {
    const last = e.argv[e.argv.length - 1] ?? ''
    asked.push(last)
    const stdout =
      last === 'console-comptes' || last === 'UNL-4844' ? README : last.endsWith('spec.md') ? SPEC : last.endsWith('plan.md') ? PLAN : ''

    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.tool.call({ tool: 'Read', file_path: '/home/xavier/Sites/sacred-book/v2/banking/console-comptes/README.md' })
  const pane = await mounted($, 120)
  expect(await pane.find({ text: 'Console admin — comptes' })).toBeDefined()
  expect(asked[0]).toBe('console-comptes')
})

test('a ticket in a prompt binds its feature, whatever its case', async ($, on) => {
  engine(on)
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('process.run', ($$, e) => {
    const last = e.argv[e.argv.length - 1] ?? ''
    const stdout = last === 'UNL-4844' ? README : last.endsWith('spec.md') ? SPEC : last.endsWith('plan.md') ? PLAN : ''

    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.prompt.submit({ text: 'on attaque unl-4844', wait: false, origin: { kind: 'composer' } })
  const pane = await mounted($, 120)

  expect(await pane.find({ key: 'doc:plan' })).toBeDefined()
  expect(await pane.find({ text: ' UNL-4844 ' })).toBeDefined()
})

const start = async ($: Engine, on: On) => {
  const clock = engine(on)
  on('command.list', () => ({ value: [] }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/home/xavier/Sites', surface: 'terminal', isInteractive: true })

  return clock
}

const petCommand = ($: Engine, style: string) =>
  $.command.run({ command: 'mission', args: `pet ${style}`, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

test('the sprite cat lives on a strip as wide as the pane; an ansi theme gets the line cat', async ($, on) => {
  engine(on)
  const pane = await mounted($, 100)
  const strip = await pane.find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.columns).toBe(98)
  expect(strip?.props.rows).toBe(14)
  await pane.unmount()

  await wear($, 'dark-ansi')
  expect((await (await mounted($, 100)).find({ key: 'pet' }))?.text).toMatch(/ﾐ_x ﾉ/)
})

test('pet line sits the line cat at the bottom of the pane', async ($, on) => {
  await start($, on)
  await petCommand($, 'line')
  const pane = await mounted($, 100)

  expect((await pane.find({ key: 'pet' }))?.text).toMatch(/ﾐ_x ﾉ/)
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
})

test('pet pixel walks the pixel cat on a strip as wide as the pane', async ($, on) => {
  await start($, on)
  await petCommand($, 'pixel')
  const strip = await (await mounted($, 100)).find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.columns).toBe(98)
  expect(strip?.props.rows).toBe(3)
})

test('pet off sends the cat in', async ($, on) => {
  await start($, on)
  await petCommand($, 'off')

  expect(await (await mounted($, 100)).find({ key: 'pet' })).toBeUndefined()
})

test('pet 3d walks the ray-marched cat', async ($, on) => {
  await start($, on)
  await petCommand($, '3d')
  const strip = await (await mounted($, 100)).find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.rows).toBe(10)
})

test('the scene around the cat draws its specks and what it says without a refused cell', async ($, on) => {
  engine(on)
  // A failed call raises red crosses and an "Aïe."; a finished todo, sparks.
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Écrire le test', status: 'completed', activeForm: 'Écriture du test' }],
  })
  const pane = await mounted($, 100)
  const strip = await pane.find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.rows).toBe(14)
})

test('pet big draws the 64 by 36 sheet over 18 rows and its ground', async ($, on) => {
  await start($, on)
  await petCommand($, 'big')
  const strip = await (await mounted($, 100)).find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.rows).toBe(20)
})

test('cat picks which cat walks the pane, at either size', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'mission', args: 'cat noir', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const small = await mounted($, 100)

  // The black cat has no small sheet of its own: the big one by half, 9 rows and the ground's 2.
  expect((await small.find({ key: 'pet' }))?.props.rows).toBe(11)
  await small.unmount()

  await petCommand($, 'big')
  expect((await (await mounted($, 100)).find({ key: 'pet' }))?.props.rows).toBe(20)
})

test('lasagne serves the dish in the scene, in cells the engine takes', async ($, on) => {
  await start($, on)
  const pane = await mounted($, 100)
  const served = await $.command.run({ command: 'mission', args: 'lasagne', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await pane.unmount()
  const strip = await (await mounted($, 100)).find({ key: 'pet' })

  expect(served.text).toMatch(/lasagnes servies/)
  expect(strip?.type).toBe('Raster')
})

test('on the desktop the cat and its meadow are one self-playing Svg', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'desktop',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100 },
  })
  // The meters are small Svg bars there too: the cat is the one that plays.
  const sources: string[] = []
  const walk = (node: unknown) => {
    const one = node as { type?: string; props?: { source?: unknown }; children?: unknown[] } | null
    if (!one || typeof one !== 'object') return
    if (one.type === 'Svg') sources.push(String(one.props?.source))
    for (const child of one.children ?? []) walk(child)
  }
  walk(await pane.drawn())

  expect(sources.filter(one => /@keyframes play/.test(one))).toHaveLength(1)
  // The meadow is in the same picture: the decor sheet, its ground and its grass.
  expect(sources.find(one => /@keyframes play/.test(one))).toMatch(/@keyframes k-grass_/)
  expect(sources.find(one => /@keyframes play/.test(one))).toMatch(/@keyframes k-beetle/)
  // One small Svg bar there too: the context gauge, now that PLAN has no meter.
  expect(sources.filter(one => /viewBox="0 0 100 3"/.test(one))).toHaveLength(1)
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
})

test('cat panda opens the panda its own world, and plants bamboo in it', async ($, on) => {
  await start($, on)
  const told = await $.command.run({ command: 'mission', args: 'cat panda', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const pane = await mounted($, 100)
  const strip = await pane.find({ key: 'pet' })

  expect(told.text).toMatch(/le panda entre en scène/)
  // On a terminal the panda has a world of its own, 15 rows tall, and a key to plant bamboo in it.
  expect(strip?.type).toBe('Raster')
  expect(strip?.props.rows).toBe(15)
  expect((await pane.find({ key: 'bao:plant' }))?.props.hotkey).toBe('b')

  await pane.press({ key: 'bao:plant' })
  const planted = await $.command.run({ command: 'mission', args: 'bambou', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(planted.text).toMatch(/pousse de bambou/)
  await pane.unmount()
  expect((await (await mounted($, 100)).find({ key: 'pet' }))?.type).toBe('Raster')
})

test('docked, the legend has no hint about the fullscreen renderer', async ($, on) => {
  engine(on)
  const docked = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 70, placement: 'dock' as const },
  })

  expect((await docked.find({ key: 'legend' }))?.text).not.toMatch(/tui fullscreen/)
  await docked.unmount()
  // Seated above the prompt, it says how to get the pane to the right.
  expect((await (await wide($)).find({ key: 'legend' }))?.text).toMatch(/^\/tui fullscreen Pane à droite/)
})

// ------------------------------------------------------------------- agents

const tallPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyRows = 140) =>
  $.ui.mount({
    plugin: 'focus-pane',
    surface,
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows } },
  })

const OPUS = 'claude-opus-5-5'

/**
 * The lowest docked height where exactly the demo's three agents unfold and the planned tasks
 * fold: settled by the probe of the fit (the demo: the running agent unfolded from 53 rows, the
 * second from 66, the third from 70, all eight lines from 93). Above 52 the Sacred Book and the
 * todos have given way for them: that is the order, they fold before the agents do.
 */
const VARIANT_B_ROWS = 71

/**
 * The lowest docked height where the demo's five planned tasks unfold too, three rows and a rule
 * each: every line unfolded.
 */
const VARIANT_A_ROWS = 94

/** A subagent spawned by the model, then one model request of its loop. */
const launch = async ($: Engine, description: string) => {
  const started = await $.agent.spawn({
    tool_use_id: `toolu_${description}`,
    prompt: 'x',
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'core', tier: 'core' },
    parentModel: OPUS,
    background: true,
    fork: false,
  })

  return started.deny === undefined ? (started.agentId ?? '') : ''
}

const step = async ($: Engine, agentId: string, usage: TurnUsage, effort: 'xhigh' | 'high' | 'medium' | 'low' = 'xhigh') => {
  stepped.set(agentId, usage)
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: usage.model, effort, messageCount: 3, agentId })
  for await (const _chunk of stream) {
    // Drained: the result settles once the stream is read to its end.
  }

  return stream.result
}

const finish = ($: Engine, agentId: string, reason: 'answer' | 'error') =>
  $.turn.complete({ turnId: `t-${agentId}`, answer: '', durationMs: 1000, isAborted: false, agentId, reason })

const BIG: TurnUsage = {
  input_tokens: 2_000,
  cache_read_input_tokens: 170_000,
  cache_creation_input_tokens: 4_000,
  output_tokens: 1_000,
  model: OPUS,
}
const SMALL: TurnUsage = {
  input_tokens: 500,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 0,
  output_tokens: 500,
  model: OPUS,
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | null

/** The keys of every Raster in a drawing. */
const rasterKeys = (tree: unknown) => {
  const keys: string[] = []
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    if (one.type === 'Raster') keys.push(String(one.props?.key))
    for (const child of one.children ?? []) walk(child)
  }
  walk(tree)

  return keys
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A Raster's cells decoded: the u32 words, three to a cell. */
const cellWords = (cells: unknown) => {
  const bytes: number[] = []
  let bits = 0
  let held = 0
  for (const ch of String(cells).replace(/=+$/, '')) {
    held = (held << 6) | BASE64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((held >> bits) & 255)
    }
  }
  const words: number[] = []
  for (let at = 0; at + 3 < bytes.length; at += 4) {
    words.push((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24))
  }

  return words
}

/** The colors a Raster paints, as #rrggbb, the terminal default left out. */
const paintOf = (cells: unknown) =>
  new Set(
    cellWords(cells)
      .filter((word, at) => at % 3 !== 0 && word !== 0x01000000)
      .map(word => `#${(word & 0xffffff).toString(16).padStart(6, '0')}`),
  )

test('a spawned subagent and its steps draw a running row: tier, model, context, cost, avatar', async ($, on) => {
  engine(on)
  const id = await launch($, 'Cache clock handover')
  await step($, id, BIG)
  const pane = await tallPane($)

  expect(await pane.find({ text: 'En cours · 1' })).toBeDefined()
  expect(await pane.find({ text: 'Cache clock handover' })).toBeDefined()
  expect(await pane.find({ text: 'heavy' })).toBeDefined()
  expect(await pane.find({ text: / Opus 5\.5 · xhigh/ })).toBeDefined()
  expect(await pane.find({ text: /ctx 18% · 177k ≈\$0\.09/ })).toBeDefined()
  expect(await pane.find({ text: '●' })).toBeDefined()
  const avatar = await pane.find({ key: 'agent:ava:a1' })
  expect(avatar?.type).toBe('Raster')
  expect(avatar?.props.columns).toBe(9)
  expect(avatar?.props.rows).toBe(3)
})

test('a finished subagent moves to Terminés with a check, a failed one with a cross', async ($, on) => {
  engine(on)
  const one = await launch($, 'Stable session prefix')
  const two = await launch($, 'Flaky migration')
  await step($, one, BIG, 'high')
  await step($, two, SMALL, 'high')
  await finish($, one, 'answer')
  await finish($, two, 'error')
  const pane = await tallPane($)

  expect(await pane.find({ text: 'En cours · 1' })).toBeUndefined()
  expect((await pane.find({ key: 'agents:done' }))?.props.label).toBe('▾ Terminés · 2')
  expect(await pane.find({ text: '✓' })).toBeDefined()
  expect(await pane.find({ text: '✗' })).toBeDefined()
  expect(await pane.find({ text: 'careful' })).toBeDefined()
})

/** The agents' totals as the section's title carries them: cost, tokens, wall clock. */
const TOTALS = /^≈\$\d+(\.\d+)? · \d+(\.\d+)?[kM]? · \d\d:\d\d$/

test('the title of the agents sums their cost and their tokens, and times them on the wall clock', async ($, on) => {
  const clock = engine(on)
  const one = await launch($, 'Premier')
  await step($, one, BIG)
  await clock.advance(60_000)
  const two = await launch($, 'Second')
  await step($, two, SMALL)
  await clock.advance(60_000)
  const pane = await tallPane($)

  expect((await pane.find({ text: TOTALS }))?.text).toBe('≈$0.12 · 228k · 02:00')
})

test('no card of its own under AGENTS: the totals sit in the title, right of the todo, before r', async ($, on) => {
  const clock = engine(on)
  await step($, await launch($, 'Premier'), BIG)
  await clock.advance(60_000)
  await step($, await launch($, 'Second'), SMALL)
  const pane = await tallPane($)

  for (const key of ['agents:cost', 'agents:tokens', 'agents:time', 'agents:totals']) {
    expect(await pane.find({ key })).toBeUndefined()
  }
  // The cards above stay; the section holds none of the labels the cards carried.
  const section = JSON.stringify(seek(await pane.drawn(), node => node.props?.key === 'agents'))
  for (const label of ['COÛT', 'TOKENS', 'DURÉE']) expect(section).not.toContain(`"${label}"`)
  const title = seek(await pane.drawn(), node => node.props?.key === 'agents:title')
  const kids = (title?.children ?? []) as Drawn[]
  expect(kids).toHaveLength(2)
  // Left: AGENTS ›. Right: the totals, then the fold button.
  expect(JSON.stringify(kids[0])).toContain('AGENTS ›')
  const right = (kids[1]?.children ?? []) as Drawn[]
  expect(right).toHaveLength(2)
  expect(String(right[0]?.children?.join(''))).toMatch(TOTALS)
  expect(right[1]?.props?.key).toBe('agents:fold')
})

test('a very long todo title gives way, the totals and the fold button stay whole', async ($, on) => {
  engine(on)
  const long = `Un titre de todo interminable ${'très long '.repeat(30)}fin`
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: long, status: 'in_progress', activeForm: long }] })
  await step($, await launch($, 'Premier'), BIG)
  const pane = await tallPane($)

  const title = seek(await pane.drawn(), node => node.props?.key === 'agents:title')
  const flat = JSON.stringify(title)
  expect(flat).toContain('…')
  expect(flat).not.toContain('fin')
  expect(flat).toContain('Un titre de todo')
  expect((await pane.find({ text: TOTALS }))?.text).toMatch(/^≈\$0\.\d\d · 177k · \d\d:\d\d$/)
  expect((await pane.find({ key: 'agents:fold' }))?.props.label).toBe('replier')
  // The title is one row: the long text never wraps the totals under it.
  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 140 } })
})

test('a task blocked by another is planned after it, and ready once it is done', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.render', () => ({ type: 'Text' as const, children: [] }))
  let made = 0
  on('tool.call', ($$, e) => {
    if (e.tool === 'TaskCreate') {
      made += 1

      return { result: { task: { id: String(made), subject: e.subject } }, text: 'ok' }
    }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] }, text: 'ok' }

    return { isError: true as const, result: null, text: 'no tool beneath the test' }
  })
  for (const subject of ['Contrat BFF', 'SDK', 'Front']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: 'x' })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', addBlockedBy: ['1'] })
  const before = await tallPane($)

  expect(await before.find({ text: 'Planifiés · 3' })).toBeDefined()
  expect(await before.find({ text: '3. Front' })).toBeDefined()
  expect(await before.find({ text: 'après 1' })).toBeDefined()
  await before.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const after = await tallPane($)
  expect(await after.find({ text: 'Planifiés · 2' })).toBeDefined()
  expect(await after.find({ text: 'après 1' })).toBeUndefined()
  expect(await after.find({ text: 'prête' })).toBeDefined()
})

test('addBlocks puts the task among the blockers of the ones it blocks', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.render', () => ({ type: 'Text' as const, children: [] }))
  let made = 0
  on('tool.call', ($$, e) => {
    if (e.tool === 'TaskCreate') {
      made += 1

      return { result: { task: { id: String(made), subject: e.subject } }, text: 'ok' }
    }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] }, text: 'ok' }

    return { isError: true as const, result: null, text: 'no tool beneath the test' }
  })
  for (const subject of ['Contrat BFF', 'SDK', 'Front']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: 'x' })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', addBlocks: ['2', '3'] })
  const pane = await tallPane($)

  expect((await pane.find({ text: 'après 1' }))).toBeDefined()
  expect(await pane.find({ text: 'prête' })).toBeDefined()
})

test('r folds the rows to one line each, t hides the finished', async ($, on) => {
  engine(on)
  const one = await launch($, 'En vol')
  const two = await launch($, 'Déjà rendu')
  await step($, one, BIG)
  await step($, two, SMALL, 'high')
  await finish($, two, 'answer')
  const pane = await tallPane($)

  expect(rasterKeys(await pane.drawn())).toEqual(expect.arrayContaining(['agent:ava:a1', 'agent:ava:a2']))
  expect((await pane.find({ key: 'agents:fold' }))?.props.hotkey).toBe('r')
  expect((await pane.find({ key: 'agents:fold' }))?.props.label).toBe('replier')

  await pane.press({ key: 'agents:fold' })
  expect(rasterKeys(await pane.drawn()).filter(key => key.startsWith('agent:ava:'))).toEqual([])
  expect(await pane.find({ text: /En vol/ })).toBeDefined()
  expect((await pane.find({ key: 'agents:fold' }))?.props.label).toBe('déplier')

  await pane.press({ key: 'agents:fold' })
  expect(rasterKeys(await pane.drawn())).toContain('agent:ava:a1')

  expect((await pane.find({ key: 'agents:done' }))?.props.hotkey).toBeUndefined()
  await pane.press({ key: 'agents:done' })
  expect((await pane.find({ key: 'agents:done' }))?.props.label).toBe('▸ Terminés · 1')
  expect(rasterKeys(await pane.drawn())).not.toContain('agent:ava:a2')
  expect(await pane.find({ text: /Déjà rendu/ })).toBeUndefined()
})

test('a short pane folds the agents, then keeps the running ones and counts the finished', async ($, on) => {
  await start($, on)
  for (let at = 1; at <= 8; at += 1) {
    const id = await launch($, `Agent ${at}`)
    await step($, id, SMALL)
    // The first five are over: a running agent is never cut for room, a finished one is.
    if (at <= 5) await finish($, id, 'answer')
  }

  // With the cat in, there is no room for the finished ones, and the running three stay.
  const crowded = await tallPane($, 'terminal', 22)
  expect(await crowded.find({ text: /^\+ \d+ autres$/ })).toBeDefined()
  expect(await crowded.find({ text: /Agent 8/ })).toBeDefined()
  expect(await crowded.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 22 } })
  await crowded.unmount()

  await petCommand($, 'off')
  const pane = await tallPane($, 'terminal', 22)
  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 22 } })
  expect(rasterKeys(await pane.drawn()).filter(key => key.startsWith('agent:ava:'))).toEqual([])
  expect(await pane.find({ text: /Agent 8/ })).toBeDefined()
  expect(await pane.find({ text: /^\+ \d+ autres$/ })).toBeDefined()
  expect(await pane.find({ text: /Agent 1$/ })).toBeUndefined()
})

test('a step from an agent the engine does not list draws no row', async ($, on) => {
  engine(on)
  on('agent.list', () => ({ value: [] }))
  await step($, 'ghost', SMALL)
  await step($, 'ghost', SMALL)
  const pane = await tallPane($)

  expect(await pane.find({ text: TOTALS })).toBeUndefined()
  expect(await pane.find({ key: 'agents:main' })).toBeDefined()
  expect(await pane.find({ text: 'aucun agent lancé' })).toBeUndefined()
  expect(await pane.find({ key: 'agent:ava:ghost' })).toBeUndefined()
})

test('a step from a listed agent nobody saw spawn makes its row', async ($, on) => {
  engine(on)
  on('agent.list', () => ({
    value: [{ id: 'm1', description: 'Mémoire', type: 'Explore', status: 'running' }],
  }))
  await step($, 'm1', SMALL)
  const pane = await tallPane($)

  expect(await pane.find({ text: 'Mémoire' })).toBeDefined()
  expect(await pane.find({ key: 'agent:ava:m1' })).toBeDefined()
})

test('under an ansi theme the avatar is still drawn, on the terminal default colors', async ($, on) => {
  engine(on)
  await wear($, 'dark-ansi')
  const id = await launch($, 'Sans couleur')
  await step($, id, SMALL)
  const pane = await tallPane($)
  const avatar = await pane.find({ key: 'agent:ava:a1' })

  expect(avatar?.type).toBe('Raster')
  expect(avatar?.props.columns).toBe(9)
  expect(avatar?.props.rows).toBe(3)

  // base64 of u32 triplets: 0x01000000 little-endian is the bytes 00 00 00 01.
  const words = cellWords(avatar?.props.cells)
  expect(words.length).toBe(81)
  expect(words.filter(word => word === 0x01000000).length).toBeGreaterThan(0)
})

test('no agent and no planned task says so, with no totals', async ($, on) => {
  engine(on)
  const pane = await tallPane($)

  expect(await pane.find({ key: 'agents:main' })).toBeDefined()
  expect(await pane.find({ text: 'aucun agent lancé' })).toBeUndefined()
  expect(await pane.find({ text: TOTALS })).toBeUndefined()
  expect(await pane.find({ key: 'agents:fold' })).toBeUndefined()
  expect(await pane.find({ key: 'agents' })).toBeDefined()
})

test('a main-loop turn settles a running row its agent list says is over', async ($, on) => {
  engine(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Parti', type: 'general-purpose', status: 'killed' }],
  }))
  const id = await launch($, 'Parti')
  await step($, id, SMALL)
  await $.turn.complete({ turnId: 'main', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  const pane = await tallPane($)

  expect(await pane.find({ text: 'En cours · 1' })).toBeUndefined()
  expect((await pane.find({ key: 'agents:done' }))?.props.label).toBe('▾ Terminés · 1')
  expect(await pane.find({ text: '✗' })).toBeDefined()
})

test('a turn that saw no step is charged its own usage when it completes', async ($, on) => {
  engine(on)
  const id = await launch($, 'Sans étape')
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1000, isAborted: false, agentId: id, reason: 'answer', usage: BIG })
  const pane = await tallPane($)

  expect(await pane.find({ text: /ctx 18% · 177k ≈\$0\.09/ })).toBeDefined()
})

test('on the desktop the avatar is a crisp Svg, and the mobile gets none', async ($, on) => {
  engine(on)
  const id = await launch($, 'Bureau')
  await step($, id, SMALL)
  const sources: string[] = []
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    if (one.type === 'Svg') sources.push(String(one.props?.source))
    for (const child of one.children ?? []) walk(child)
  }
  walk(await (await tallPane($, 'desktop')).drawn())

  expect(sources.filter(one => /viewBox="0 0 90 63"/.test(one) && /crispEdges/.test(one))).toHaveLength(1)
})

test('the demo fills the agents: one running, two finished, planned tasks that wait on others', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'mission', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const pane = await tallPane($)

  expect(await pane.find({ text: 'En cours · 1' })).toBeDefined()
  expect((await pane.find({ key: 'agents:done' }))?.props.label).toBe('▾ Terminés · 2')
  expect(await pane.find({ text: /^après / })).toBeDefined()
  expect(await pane.find({ text: / Opus 5\.5 · xhigh/ })).toBeDefined()
  expect(await pane.find({ text: /ctx 18% · 177k ≈\$1\.65 03:21/ })).toBeDefined()
})

test('the legend names r alone, and the Terminés button has no hotkey even with finished agents', async ($, on) => {
  engine(on)
  const id = await launch($, 'Légende')
  await step($, id, SMALL)
  const before = await tallPane($)
  expect((await before.find({ key: 'legend' }))?.text).toMatch(/r Replier/)
  await before.unmount()
  await finish($, id, 'answer')
  const after = await tallPane($)

  expect((await after.find({ key: 'legend' }))?.text).toMatch(/r Replier/)
  expect((await after.find({ key: 'legend' }))?.text).not.toMatch(/Terminés/)
  const button = await after.find({ key: 'agents:done' })
  expect(button?.props.hotkey).toBeUndefined()
  expect(button?.props.label).toBe('▾ Terminés · 1')
})

test('the pane redraws each second while an agent runs, and stops once none does', async ($, on) => {
  const clock = engine(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1

    return { value: undefined }
  })
  const id = await launch($, 'Qui tourne')
  await clock.advance(3000)
  expect(redraws).toBeGreaterThanOrEqual(3)

  await finish($, id, 'answer')
  const settled = redraws
  await clock.advance(3000)
  expect(redraws).toBe(settled)
})

test('a request of the main loop is none of the agents: nothing is listed, no row made', async ($, on) => {
  engine(on)
  let listed = 0
  on('agent.list', () => {
    listed += 1

    return { value: [{ id: 'undefined', description: 'Fantôme', type: 'x', status: 'running' }] }
  })
  const stream = $.turn.step({ turnId: 'main', index: 0, model: OPUS, effort: 'high', messageCount: 2 })
  for await (const _chunk of stream) {
    // Drained.
  }
  await stream.result

  expect(listed).toBe(0)
  expect(await (await tallPane($)).find({ text: TOTALS })).toBeUndefined()
})

/** One request of the main loop (no agentId), drained. */
const mainStep = async ($: Engine, model: string, effort: 'xhigh' | 'high' | 'medium' | 'low' = 'high') => {
  const stream = $.turn.step({ turnId: 'main', index: 0, model, effort, messageCount: 2 })
  for await (const _chunk of stream) {
    // Drained.
  }

  return stream.result
}

test('the main agent is always the first row of AGENTS, at rest with no subagent', async ($, on) => {
  engine(on)
  const pane = await tallPane($)
  const main = await pane.find({ key: 'agents:main' })

  expect(main).toBeDefined()
  expect(main?.text).toContain('Principal')
  expect(main?.text).toContain('au repos')
  expect(await pane.find({ text: 'aucun agent lancé' })).toBeUndefined()
  expect(await pane.find({ text: TOTALS })).toBeUndefined()
  expect(await pane.find({ key: 'agents:fold' })).toBeUndefined()
})

test('the main row shows a turn running and the model and effort of the main loop', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await mainStep($, OPUS, 'high')
  const main = await (await tallPane($)).find({ key: 'agents:main' })

  expect(main?.text).toContain('●')
  expect(main?.text).toContain('Principal')
  expect(main?.text).toContain('careful')
  expect(main?.text).toContain('Opus 5.5')
  expect(main?.text).not.toContain('au repos')
})

test('a subagent step leaves the model of the main row alone', async ($, on) => {
  engine(on)
  await mainStep($, OPUS, 'high')
  const id = await launch($, 'Petit')
  await step($, id, { ...SMALL, model: 'claude-haiku-4-5' }, 'low')
  const main = await (await tallPane($)).find({ key: 'agents:main' })

  expect(main?.text).toContain('Opus 5.5')
  expect(main?.text).not.toContain('Haiku')
})

test('the main row is drawn on the desktop surface too, with no avatar', async ($, on) => {
  engine(on)
  const pane = await tallPane($, 'desktop')
  const main = await pane.find({ key: 'agents:main' })

  expect(main?.text).toContain('Principal')
  expect(main?.text).toContain('au repos')
  expect(rasterKeys(await pane.drawn()).filter(key => key.startsWith('agent:ava:main'))).toHaveLength(0)
})

const BEAT = '/home/test/.cache/focus-pane/live/session-test.json'
const beats = () => written.filter(one => one.path === BEAT).map(one => JSON.parse(one.text) as Heartbeat)

test('the session publishes its heartbeat at start, then at each real change only', async ($, on) => {
  await start($, on)
  expect(beats()).toHaveLength(1)
  expect(beats()[0]).toMatchObject({ v: 1, sessionId: 'session-test', agents: [], main: { isRunning: false } })

  const id = await launch($, 'Chercheur')
  expect(beats()).toHaveLength(2)
  expect(beats()[1]?.agents).toMatchObject([{ id, title: 'Chercheur' }])

  // The first step tells the agent's effort and model; a second, alike, only makes its context grow.
  await step($, id, SMALL)
  const told = beats().length
  await step($, id, SMALL)
  expect(beats()).toHaveLength(told)

  await finish($, id, 'answer')
  expect(beats()).toHaveLength(told + 1)
  expect(beats().at(-1)?.agents).toEqual([])
})

test('the heartbeat is written again every 15 s, changed or not', async ($, on) => {
  const clock = await start($, on)
  await clock.advance(15_000)

  expect(beats()).toHaveLength(2)
})

test('the main loop and its turn reach the heartbeat', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await mainStep($, OPUS, 'high')

  expect(beats().at(-1)?.main).toEqual({ model: OPUS, effort: 'high', isRunning: true })
})

test('with no HOME nothing is written, and a subagent still starts', async ($, on) => {
  await start($, on)
  home = undefined
  written.length = 0
  const id = await launch($, 'Sans maison')

  expect(id).not.toBe('')
  expect(beats()).toHaveLength(0)
})

/** The demo in a docked pane of `columns` by `rows`: the bound feature, 8 todos, the default cat. */
const demoDock = async ($: Engine, on: On, columns: number, rows: number) => {
  await start($, on)
  await $.command.run({ command: 'mission', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  return $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: rows } },
  })
}

test('a docked pane of a normal height still draws the running agent and the totals', async ($, on) => {
  const pane = await demoDock($, on, 100, 50)

  expect(await pane.find({ text: /Conformer api-v2 au contrat R3/ })).toBeDefined()
  expect(await pane.find({ text: TOTALS })).toBeDefined()
  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 50 } })
})

test('a tall docked pane keeps the agents unfolded, with their avatars and the totals in the title', async ($, on) => {
  const pane = await demoDock($, on, 100, 110)

  expect(rasterKeys(await pane.drawn())).toContain('agent:ava:demo-1')
  expect(await pane.find({ text: TOTALS })).toBeDefined()
})

for (const [variant, rows] of [['c', 50], ['b', VARIANT_B_ROWS], ['a', 110]] as const) {
  test(`variant ${variant}: the totals are the title's, no row is spent on them`, async ($, on) => {
    const pane = await demoDock($, on, 100, rows)

    expect((await pane.find({ text: TOTALS }))?.text).toMatch(/^≈\$10\.3 · 14\.0M · \d\d:\d\d$/)
    expect(await pane.find({ key: 'agents:totals' })).toBeUndefined()
    expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: rows } })
    // What each variant unfolds: a everything, b the agents alone, c nothing.
    const avatars = rasterKeys(await pane.drawn()).filter(key => key.startsWith('agent:ava:'))
    expect(avatars.some(key => key.startsWith('agent:ava:demo-'))).toBe(variant !== 'c')
    expect(avatars.some(key => key.startsWith('agent:ava:todo-'))).toBe(variant === 'a')
  })
}

test('the outlines and the todos give way so that every agent keeps a line', async ($, on) => {
  const pane = await demoDock($, on, 100, 60)
  const keys: string[] = []
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    keys.push(String(one.props?.key ?? ''))
    for (const child of one.children ?? []) walk(child)
  }
  walk(await pane.drawn())

  expect(keys.filter(key => key.startsWith('agents:row:'))).toHaveLength(3)
  expect(await pane.find({ text: TOTALS })).toBeDefined()
})

/** The first node of a drawing that answers. */
const seek = (tree: unknown, wanted: (node: NonNullable<Drawn>) => boolean): NonNullable<Drawn> | undefined => {
  const one = tree as Drawn
  if (!one || typeof one !== 'object') return undefined
  if (wanted(one)) return one
  for (const child of one.children ?? []) {
    const hit = seek(child, wanted)
    if (hit !== undefined) return hit
  }

  return undefined
}

/** The avatar of each of `count` launched agents, by id, the pane drawn once. */
const crabsOf = async ($: Engine, count: number) => {
  for (let at = 0; at < count; at += 1) await step($, await launch($, `Agent ${at}`), SMALL)
  const pane = await tallPane($)
  const crabs = new Map<string, unknown>()
  for (let at = 1; at <= count; at += 1) {
    const cells = (await pane.find({ key: `agent:ava:a${at}` }))?.props.cells
    if (cells !== undefined) crabs.set(`a${at}`, cells)
  }

  return crabs
}

test('an agent keeps its crab from one drawing to the next', async ($, on) => {
  engine(on)
  await step($, await launch($, 'Lourd'), SMALL, 'xhigh')
  const pane = await tallPane($)
  const first = (await pane.find({ key: 'agent:ava:a1' }))?.props.cells
  await step($, 'a1', SMALL, 'xhigh')
  await step($, 'a1', BIG, 'xhigh')
  const again = (await pane.find({ key: 'agent:ava:a1' }))?.props.cells

  expect(first).toBeDefined()
  expect(again).toEqual(first)
})

test('the crabs of many agents spread over ten variants, each one wearing the body color', async ($, on) => {
  engine(on)
  const crabs = await crabsOf($, 24)
  const distinct = new Set([...crabs.values()].map(cells => String(cells)))

  expect(crabs.size).toBeGreaterThanOrEqual(20)
  expect(distinct.size).toBe(10)
  for (const cells of crabs.values()) expect(paintOf(cells)).toContain('#ec7a58')
})

/** Block elements (quadrants, halves, eighths), the space, the spark's plus and the bonnet's speck. */
const AVATAR_GLYPHS = (code: number) => code === 0x20 || code === 0x2b || code === 0xb7 || (code >= 0x2580 && code <= 0x259f)
const QUADRANTS = [0x2596, 0x2597, 0x2598, 0x2599, 0x259a, 0x259b, 0x259c, 0x259d, 0x259e, 0x259f]

/** The glyph of each cell of a Raster. */
const glyphsOf = (cells: unknown) => cellWords(cells).filter((_word, at) => at % 3 === 0)

test('every variant of the crab is made of blocks, spaces, pluses and dots, quadrants drawing its legs', async ($, on) => {
  engine(on)
  const crabs = await crabsOf($, 24)
  expect(new Set([...crabs.values()].map(cells => String(cells))).size).toBe(10)

  for (const cells of crabs.values()) {
    const glyphs = glyphsOf(cells)
    expect(glyphs).toHaveLength(27)
    expect(glyphs.filter(code => !AVATAR_GLYPHS(code))).toEqual([])
    // Half a column wide, the legs and the eyes need quarter cells: half blocks alone cannot draw them.
    expect(glyphs.some(code => QUADRANTS.includes(code))).toBe(true)
  }
})

test('every avatar cell is a block, a space, a plus or a dot, quadrants drawing its legs', async ($, on) => {
  engine(on)
  for (const [title, effort] of [['Lourd', 'xhigh'], ['Soigné', 'high'], ['Moyen', 'medium'], ['Léger', 'low']] as const) {
    await step($, await launch($, title), SMALL, effort)
  }
  const pane = await tallPane($)

  for (const id of ['a1', 'a2', 'a3', 'a4']) {
    const glyphs = glyphsOf((await pane.find({ key: `agent:ava:${id}` }))?.props.cells)
    expect(glyphs).toHaveLength(27)
    expect(glyphs.filter(code => !AVATAR_GLYPHS(code))).toEqual([])
    expect(glyphs.some(code => QUADRANTS.includes(code))).toBe(true)
  }
})

test('an unfolded agent wears a three-row avatar beside its title, meta and stats, its bar beneath them', async ($, on) => {
  engine(on)
  await step($, await launch($, 'Trois rangées'), BIG)
  const pane = await tallPane($)

  const line = seek(await pane.drawn(), node => node.props?.key === 'agents:row:a1')
  const [left, column] = (line?.children ?? []) as Drawn[]
  expect(seek(left, node => node.type === 'Raster')?.props?.rows).toBe(3)
  // Title, meta, stats, then the bar: four rows, the avatar's column empty on the fourth.
  expect(column?.children).toHaveLength(4)
  expect(seek(column, node => node.type === 'Raster')).toBeUndefined()
})

test('a planned task wears the bare crab, faded, and its two lines are centered', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'mission', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const demo = await tallPane($)
  const planned = rasterKeys(await demo.drawn()).filter(key => key.startsWith('agent:ava:todo-'))
  expect(planned.length).toBeGreaterThan(0)
  const hats = ['#b8b8bc', '#3a3a42', '#3b5bdb', '#f2c14e', '#ffffff', '#fcd1ff', '#e5484d', '#3fcc8c']
  const row = seek(await demo.drawn(), node => String(node.props?.key).startsWith('agents:todo:'))
  expect(row?.children?.some(child => (child as Drawn)?.props?.justifyContent === 'center')).toBe(true)
  for (const key of planned) {
    const avatar = await demo.find({ key })
    expect(avatar?.props.rows).toBe(3)
    const colors = paintOf(avatar?.props.cells)
    expect(colors.size).toBeGreaterThan(0)
    for (const hat of hats) expect(colors).not.toContain(hat)
    expect(colors).not.toContain('#ec7a58')
  }
})

test('an unfolded agent, its meta and stats in the chip grey, its bar full', async ($, on) => {
  engine(on)
  await step($, await launch($, 'Centré'), BIG)
  const pane = await tallPane($)

  const line = seek(await pane.drawn(), node => node.props?.key === 'agents:row:a1')
  expect((await pane.find({ text: /^ Opus 5\.5 · xhigh$/ }))?.props.color).toBe('#aab6dd')
  expect((await pane.find({ text: /^ctx 18% · 177k/ }))?.props.color).toBe('#aab6dd')
  const bar = await pane.find({ text: /^━+$/ })
  expect(bar).toBeDefined()
  expect(bar?.text.length).toBeGreaterThan(8)
  expect(seek(line, node => node.type === 'Text' && node.props?.color === '#2a3350' && /^━+$/.test(String((node.children ?? []).join('')))))
    .toBeDefined()
})

test('the shared meter keeps its thin track on the cards above', async ($, on) => {
  engine(on)
  const pane = await tallPane($)

  expect(await pane.find({ text: /^━*─+$/ })).toBeDefined()
})

test('an unfolded planned task takes its three-row avatar and a rule, no more', async ($, on) => {
  // At four rows and a rule each, as the agents take, the five planned tasks would need five more.
  const pane = await demoDock($, on, 100, VARIANT_A_ROWS)
  const planned = rasterKeys(await pane.drawn()).filter(key => key.startsWith('agent:ava:todo-'))

  expect(planned).toHaveLength(5)
  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: VARIANT_A_ROWS } })
})

test('where the unfolded planned rows do not fit, the agents keep their avatars and the planned fold', async ($, on) => {
  const pane = await demoDock($, on, 100, VARIANT_B_ROWS)
  const keys = rasterKeys(await pane.drawn())

  expect(keys).toContain('agent:ava:demo-1')
  expect(keys.filter(key => key.startsWith('agent:ava:todo-'))).toEqual([])
  expect(await pane.find({ text: /^◷ / })).toBeDefined()
  expect(await pane.find({ text: TOTALS })).toBeDefined()
})

/** The margin above each line of the agents section, in the order drawn (`agents:row:*`, `agents:todo:*`). */
const marginsOf = (tree: unknown) => {
  const margins: [string, number][] = []
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    const key = String(one.props?.key ?? '')
    if (key.startsWith('agents:row:') || key.startsWith('agents:todo:')) margins.push([key, Number(one.props?.marginTop ?? 0)])
    for (const child of one.children ?? []) walk(child)
  }
  walk(tree)

  return margins
}

test('the first unfolded line of each group has an empty row above it, the next ones the rule alone', async ($, on) => {
  // Variant a: the demo's running agent, two finished and five planned, all unfolded.
  const open = marginsOf(await (await demoDock($, on, 100, 120)).drawn())

  expect(open).toHaveLength(8)
  expect(open.map(([, margin]) => margin)).toEqual([1, 1, 0, 1, 0, 0, 0, 0])
})

test('variant b: only the groups whose first line is unfolded take the margin', async ($, on) => {
  const margins = marginsOf(await (await demoDock($, on, 100, VARIANT_B_ROWS)).drawn())

  expect(margins.filter(([key]) => key.startsWith('agents:row:')).map(([, margin]) => margin)).toEqual([1, 1, 0])
  expect(margins.filter(([key]) => key.startsWith('agents:todo:'))).toHaveLength(5)
  expect(margins.filter(([key]) => key.startsWith('agents:todo:')).every(([, margin]) => margin === 0)).toBe(true)
})

test('folded, a line takes one row and no margin', async ($, on) => {
  const pane = await demoDock($, on, 100, 120)
  await pane.press({ key: 'agents:fold' })
  const margins = marginsOf(await pane.drawn())

  expect(margins).toHaveLength(8)
  expect(margins.every(([, margin]) => margin === 0)).toBe(true)
})

// The fit unfolds line by line from the first in display order, and counts the margin: each
// line count unfolded starts at the row where its rows, its rules and the margins fit. The running
// agent comes first, at the price of the outlines, the todos and the Sacred Book (from 53 rows);
// the other agents come next, then the planned tasks, once the outlines and the todos are back.
for (const [rows, unfolded] of [
  [51, 0],
  [53, 0],
  [54, 1],
  [66, 1],
  [67, 2],
  [70, 2],
  [VARIANT_B_ROWS, 3],
  [82, 3],
  [83, 4],
  [85, 4],
  [86, 5],
  [VARIANT_A_ROWS - 1, 7],
  [VARIANT_A_ROWS, 8],
] as const) {
  test(`at ${rows} rows the demo unfolds ${unfolded} of its eight lines, agents first`, async ($, on) => {
    const drawn = await (await demoDock($, on, 100, rows)).drawn()
    const keys = rasterKeys(drawn).filter(key => key.startsWith('agent:ava:'))
    const agents = keys.filter(key => key.startsWith('agent:ava:demo-')).length

    expect(keys).toHaveLength(unfolded)
    expect(agents).toBe(Math.min(unfolded, 3))
    expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: rows } })
  })
}

// ---------------------------------------------------- the greedy unfolding

/** A docked pane of `rows` rows, with no feature bound: only the session's own agents. */
const bareDock = ($: Engine, rows: number) =>
  $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: rows } },
  })

/** `done` finished agents, oldest first, then `running` agents still going: ids in spawn order. */
const crowd = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, done: number, running: number) => {
  const ids: string[] = []
  for (let at = 0; at < done + running; at += 1) {
    const id = await launch($, `Agent ${at + 1}`)
    await step($, id, SMALL)
    await clock.advance(1000)
    if (at < done) await finish($, id, 'answer')
    ids.push(id)
  }

  return ids
}

/** Which of the ids have their avatar drawn, which are one folded row. */
const unfoldedOf = (tree: unknown, ids: string[]) => {
  const keys = rasterKeys(tree)

  return ids.filter(id => keys.includes(`agent:ava:${id}`))
}

test('one running agent and six finished ones, a pane too short for all: the unfolding stops where the room does', async ($, on) => {
  const clock = engine(on)
  const ids = await crowd($, clock, 6, 1)
  const running = ids[6]!
  const pane = await bareDock($, 60)
  const drawn = await pane.drawn()
  const open = unfoldedOf(drawn, ids)

  // The running agent first, then the finished ones from the most recent: a prefix of the display order.
  const order = [running, ...ids.slice(0, 6).reverse()]
  expect(open.length).toBeGreaterThan(0)
  expect(open.length).toBeLessThan(order.length)
  expect(order.slice(0, open.length).every(id => open.includes(id))).toBe(true)
  expect(open).toContain(running)
  expect(open).not.toContain(ids[0])
  // The oldest are one folded row each, still listed.
  expect(await pane.find({ key: `agents:row:${ids[0]}` })).toBeDefined()
  expect(await pane.find({ text: /\+ \d+ autres/ })).toBeUndefined()
  expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: 60 } })
})

test('seven finished agents, none running, in a docked pane of 57 rows: an avatar is still drawn', async ($, on) => {
  const clock = engine(on)
  const ids = await crowd($, clock, 7, 0)
  const pane = await bareDock($, 57)
  const drawn = await pane.drawn()
  const open = unfoldedOf(drawn, ids)

  expect(await pane.find({ text: /Terminés · 7/ })).toBeDefined()
  expect(await pane.find({ text: /En cours/ })).toBeUndefined()
  // The most recently finished first.
  expect(open.length).toBeGreaterThan(0)
  expect(open).toContain(ids[6])
  expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: 57 } })
})

test('r folds every line, whatever room there is, and r again unfolds the greedy prefix', async ($, on) => {
  const clock = engine(on)
  const ids = await crowd($, clock, 3, 1)
  const pane = await bareDock($, 140)

  expect(unfoldedOf(await pane.drawn(), ids)).toHaveLength(4)
  await pane.press({ key: 'agents:fold' })
  expect(unfoldedOf(await pane.drawn(), ids)).toEqual([])
  expect(await pane.find({ key: `agents:row:${ids[0]}` })).toBeDefined()
  await pane.press({ key: 'agents:fold' })
  expect(unfoldedOf(await pane.drawn(), ids)).toHaveLength(4)
})

// ------------------------------------------- the Sacred Book and the todos fold first

/** Every Text of a drawing, its children flattened. */
const textsOf = (tree: unknown) => {
  const texts: string[] = []
  const flat = (node: unknown): string => {
    const one = node as Drawn
    if (typeof node === 'string') return node
    if (!one || typeof one !== 'object') return ''

    return (one.children ?? []).map(flat).join('')
  }
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    if (one.type === 'Text') texts.push(flat(one))
    for (const child of one.children ?? []) walk(child)
  }
  walk(tree)

  return texts
}
/** The outline rows of the papers (`▸ heading`, `  · sub-heading`), the Terminés button apart. */
const outlineRows = (tree: unknown) => textsOf(tree).filter(text => /^(▸ (?!Terminés)|  · )/.test(text))
/** The todo steps drawn in the TODOS block. */
const todoRows = (tree: unknown) => textsOf(seek(tree, node => node.props?.key === 'plan')).filter(text => /^ [✓●○] ./.test(text))

test('at 58 rows the demo unfolds the running agent: the outlines and the todos give way, the book stays whole', async ($, on) => {
  const drawn = await (await demoDock($, on, 100, 58)).drawn()
  const avatars = rasterKeys(drawn).filter(key => key.startsWith('agent:ava:'))

  // The running agent, alone: its line is unfolded, its avatar drawn.
  expect(avatars).toEqual(['agent:ava:demo-1'])
  // The outlines went down to none ("+ n sections" alone), the todos to the step in hand.
  expect(outlineRows(drawn)).toEqual([])
  expect(textsOf(drawn).filter(text => /\+ \d+ sections/.test(text))).toHaveLength(2)
  expect(todoRows(drawn)).toHaveLength(1)
  expect(todoRows(drawn)[0]).toMatch(/^ ● /)
  expect(textsOf(drawn)).toContain('   + 7 autres étapes')
  // The Sacred Book is still the whole one: its papers, no compact row.
  expect(seek(drawn, node => node.props?.key === 'book:statuses')).toBeUndefined()
  expect(seek(drawn, node => node.props?.key === 'doc:spec')).toBeDefined()
  expect(seek(drawn, node => node.props?.key === 'doc:plan')).toBeDefined()
  expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: 58 } })
})

test('where the running agent does not fit with the whole book, the Sacred Book turns compact', async ($, on) => {
  const pane = await demoDock($, on, 100, 54)
  const drawn = await pane.drawn()
  const book = seek(drawn, node => node.props?.key === 'book')
  const [frame, ...rest] = (book?.children ?? []) as Drawn[]

  expect(rasterKeys(drawn).filter(key => key.startsWith('agent:ava:'))).toEqual(['agent:ava:demo-1'])
  // One rounded box and nothing under it: no paper, no GitHub link, no outline.
  expect(rest).toEqual([])
  expect(frame?.props?.borderStyle).toBe('round')
  expect(seek(drawn, node => node.props?.key === 'doc:spec')).toBeUndefined()
  expect(seek(drawn, node => node.props?.key === 'doc:plan')).toBeUndefined()
  expect(textsOf(drawn).some(text => /ouvrir sur GitHub/.test(text))).toBe(false)
  expect(outlineRows(drawn)).toEqual([])
  // Counted 2 (frame) + FEATURE + MAQUETTE + statuses = 5 rows, drawn as three rows in the frame.
  expect(frame?.children).toHaveLength(3)
  const statuses = seek(frame, node => node.props?.key === 'book:statuses')
  expect(textsOf(statuses)).toEqual(['SPEC ›', ' APPROVED ', 'PLAN ›', ' IN PROGRESS '])
  expect(textsOf(frame)).toContain(' FEATURE ')
  expect(textsOf(frame)).toContain(' MAQUETTE ')
  // The mockup keeps its two buttons.
  expect(await pane.find({ key: 'gallery:open' })).toBeDefined()
  expect(await pane.find({ key: 'design:open' })).toBeDefined()
  expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: 54 } })
})

test('a bare pane with finished agents only unfolds the latest finished first, the todos giving way', async ($, on) => {
  const clock = engine(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: Array.from({ length: 10 }, (_unused, at) => ({
      content: `étape ${at + 1}`,
      status: at < 3 ? 'completed' : at === 3 ? 'in_progress' : 'pending',
      activeForm: `étape ${at + 1} en cours`,
    })),
  })
  const ids = await crowd($, clock, 3, 0)
  const drawn = await (await bareDock($, 49)).drawn()

  expect(unfoldedOf(drawn, ids)).toEqual([ids[2]])
  // The todo list is cut to the step in hand to make that room.
  expect(todoRows(drawn)).toHaveLength(1)
  expect(textsOf(drawn)).toContain('   + 9 autres étapes')
  expect(drawn).toMatchObject({ type: 'Box', props: { minHeight: 49 } })
})

test('where the other agents stop unfolding midway, the outlines stay at their floor', async ($, on) => {
  // 70 rows: the running agent and one finished one unfold, the third does not fit; the outlines
  // do not come back up with the rows that are left, they are the agents'.
  const drawn = await (await demoDock($, on, 100, 70)).drawn()

  expect(rasterKeys(drawn).filter(key => key.startsWith('agent:ava:'))).toHaveLength(2)
  // OUTLINE_LEAST = 2 headings a paper, two papers side by side.
  expect(outlineRows(drawn)).toHaveLength(4)
  expect(textsOf(drawn)).toContain('   + 5 autres étapes')
})

test('with the agents unfolded, the outlines and the todos come back before the planned tasks unfold', async ($, on) => {
  // 76 rows: all three agents, more outlines than the floor, more todos than the floor, no planned avatar.
  const drawn = await (await demoDock($, on, 100, 76)).drawn()

  expect(rasterKeys(drawn).filter(key => key.startsWith('agent:ava:demo-'))).toHaveLength(3)
  expect(rasterKeys(drawn).filter(key => key.startsWith('agent:ava:todo-'))).toEqual([])
  expect(outlineRows(drawn).length).toBeGreaterThan(4)
  expect(todoRows(drawn)).toHaveLength(4)
})

test('every running agent unfolds before the todos stop giving way; short of room, the latest started keep their avatar', async ($, on) => {
  const clock = engine(on)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: Array.from({ length: 10 }, (_unused, at) => ({
      content: `étape ${at + 1}`,
      status: at < 3 ? 'completed' : at === 3 ? 'in_progress' : 'pending',
      activeForm: `étape ${at + 1} en cours`,
    })),
  })
  const ids = await crowd($, clock, 0, 3)

  // 57 rows: the three running agents, at the price of the todos cut to the step in hand.
  const wide57 = await bareDock($, 57)
  const all = await wide57.drawn()
  expect(unfoldedOf(all, ids)).toEqual(ids)
  expect(todoRows(all)).toHaveLength(1)
  await wide57.unmount()
  // 53 rows: the most degraded state holds two of them only, the latest started.
  const two = await (await bareDock($, 53)).drawn()
  expect(unfoldedOf(two, ids)).toEqual([ids[1], ids[2]])
  expect(todoRows(two)).toHaveLength(1)
  expect(two).toMatchObject({ type: 'Box', props: { minHeight: 53 } })
})
