import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, On, TurnUsage } from 'claude-code'

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

/** The engine beneath the plugin: the test answers for it. */
const engine = (on: On, theme = 'dark') => {
  stepped.clear()
  spawned = 0
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

test('an empty plan says so rather than drawing nothing', async ($, on) => {
  engine(on)

  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PROPS,
  })

  expect(await pane.find({ text: /aucune todo list/ })).toBeDefined()
})


const mounted = ($: Engine, bodyColumns: number) =>
  $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns },
  })

const CARDS = ['card:PLAN', 'card:CONTEXTE', 'card:TOURS', 'card:TEMPS']

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
  expect(await pane.find({ text: '$1.92' })).toBeDefined()
  expect(await pane.find({ text: '42% de 200k' })).toBeDefined()
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
  expect(await pane.find({ text: '29%' })).toBeDefined()
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
  engine(on)
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
  expect(sources.filter(one => /viewBox="0 0 100 3"/.test(one))).toHaveLength(2)
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

const step = async ($: Engine, agentId: string, usage: TurnUsage, effort: 'xhigh' | 'high' = 'xhigh') => {
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
  expect(avatar?.props.columns).toBe(10)
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

test('three cards sum the cost and the tokens of the agents, and time them on the wall clock', async ($, on) => {
  const clock = engine(on)
  const one = await launch($, 'Premier')
  await step($, one, BIG)
  await clock.advance(60_000)
  const two = await launch($, 'Second')
  await step($, two, SMALL)
  await clock.advance(60_000)
  const pane = await tallPane($)

  expect((await pane.find({ key: 'agents:cost' }))?.text).toMatch(/COÛT.*≈\$0\.12/)
  expect((await pane.find({ key: 'agents:tokens' }))?.text).toMatch(/TOKENS.*228k/)
  expect((await pane.find({ key: 'agents:time' }))?.text).toMatch(/DURÉE.*02:00/)
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

  expect((await pane.find({ key: 'agents:done' }))?.props.hotkey).toBe('t')
  await pane.press({ key: 'agents:done' })
  expect((await pane.find({ key: 'agents:done' }))?.props.label).toBe('▸ Terminés · 1')
  expect(rasterKeys(await pane.drawn())).not.toContain('agent:ava:a2')
  expect(await pane.find({ text: /Déjà rendu/ })).toBeUndefined()
})

test('a short pane folds the agents, then keeps the first ones and counts the rest', async ($, on) => {
  await start($, on)
  for (let at = 1; at <= 8; at += 1) {
    const id = await launch($, `Agent ${at}`)
    await step($, id, SMALL)
  }

  // With the cat in, there is no room for even one row.
  const crowded = await tallPane($, 'terminal', 24)
  expect(await crowded.find({ text: /^\+ \d+ autres$/ })).toBeDefined()
  expect(await crowded.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 24 } })
  await crowded.unmount()

  await petCommand($, 'off')
  const pane = await tallPane($, 'terminal', 24)
  expect(await pane.drawn()).toMatchObject({ type: 'Box', props: { minHeight: 24 } })
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

  expect(await pane.find({ key: 'agents:cost' })).toBeUndefined()
  expect(await pane.find({ text: 'aucun agent lancé' })).toBeDefined()
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
  expect(avatar?.props.columns).toBe(10)
  expect(avatar?.props.rows).toBe(3)

  // base64 of u32 triplets: 0x01000000 little-endian is the bytes 00 00 00 01.
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  let bits = 0
  let held = 0
  for (const ch of String(avatar?.props.cells).replace(/=+$/, '')) {
    held = (held << 6) | letters.indexOf(ch)
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
  expect(words.length).toBe(90)
  expect(words.filter(word => word === 0x01000000).length).toBeGreaterThan(0)
})

test('no agent and no planned task says so, with no cards', async ($, on) => {
  engine(on)
  const pane = await tallPane($)

  expect(await pane.find({ text: 'aucun agent lancé' })).toBeDefined()
  expect(await pane.find({ key: 'agents:cost' })).toBeUndefined()
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

  expect(sources.filter(one => /viewBox="0 0 10 6"/.test(one) && /crispEdges/.test(one))).toHaveLength(1)
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

test('the legend names r, and t when there are finished agents', async ($, on) => {
  engine(on)
  const id = await launch($, 'Légende')
  await step($, id, SMALL)
  const before = await tallPane($)
  expect((await before.find({ key: 'legend' }))?.text).toMatch(/r Replier/)
  expect((await before.find({ key: 'legend' }))?.text).not.toMatch(/t Terminés/)
  await before.unmount()
  await finish($, id, 'answer')
  const after = await tallPane($)

  expect((await after.find({ key: 'legend' }))?.text).toMatch(/r Replier  t Terminés/)
})

test('the pane redraws each second while an agent runs, and stops once none does', async ($, on) => {
  const clock = engine(on)
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
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
  expect(await (await tallPane($)).find({ key: 'agents:cost' })).toBeUndefined()
})
