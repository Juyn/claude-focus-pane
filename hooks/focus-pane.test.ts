import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, On } from 'claude-code'

const PANE = 'focus'

const PROPS = {
  title: 'Focus',
  isFocused: false,
  bodyColumns: 48,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** The engine beneath the plugin: the test answers for it. */
const engine = (on: On, theme = 'dark') => {
  mock.clock(on, { now: 1_700_000_000_000 })
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

test('one view draws the brief, the four cards and the feed, at every width', async ($, on) => {
  engine(on)

  for (const columns of [120, 48]) {
    const pane = await mounted($, columns)
    for (const key of CARDS) expect(await pane.find({ key })).toBeDefined()
    expect(await pane.find({ key: 'feed' })).toBeDefined()
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

test('a tool call lands in the feed with its badge and how it ended', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  const pane = await wide($)

  expect(await pane.find({ text: /git push --force origin main/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' Bash     ' })).toBeDefined()
  expect(await pane.find({ text: '✗ ÉCHEC' })).toBeDefined()
  expect(await pane.find({ text: /aucune activité/ })).toBeUndefined()
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
  expect((await pane.find({ key: 'feed' }))?.props.flexGrow).toBe(1)
  expect((await pane.find({ key: 'notes' }))?.props.minHeight).toBe(17)
  expect((await pane.find({ key: 'chores' }))?.props.minHeight).toBe(17)
})

test('a comment and a chore typed in the pane are filed, kept and worked', async ($, on) => {
  engine(on)
  const stored: Record<string, unknown> = {}
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('store.set', ($$, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  const pane = await wide($)
  expect(await pane.find({ text: 'aucun commentaire' })).toBeDefined()

  await pane.input({ key: 'note:new:0', text: 'vérifier le contraste en thème clair' })
  await pane.input({ key: 'chore:new:1', text: 'relire la PR' })

  expect(await pane.find({ text: 'vérifier le contraste en thème clair' })).toBeDefined()
  expect(await pane.find({ key: 'chore:toggle:2' })).toBeDefined()
  expect(await pane.find({ key: 'chore:clear' })).toBeUndefined()
  expect(stored['board:/home/xavier/Sites']).toMatchObject({ notes: [{ id: 1 }], chores: [{ id: 2, isDone: false }] })

  await pane.press({ key: 'chore:toggle:2' })
  expect(await pane.find({ key: 'chore:clear' })).toBeDefined()
  await pane.press({ key: 'chore:clear' })
  expect(await pane.find({ key: 'chore:toggle:2' })).toBeUndefined()

  await pane.press({ key: 'note:drop:1' })
  expect(await pane.find({ text: 'aucun commentaire' })).toBeDefined()
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
  expect((await pane.find({ key: 'legend' }))?.text).toMatch(/^a Tâche  t Lien  c Commenter  ctrl\+x tab Clavier  esc Rendre la main  \/mission Rouvrir$/)
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

test('t files a link in the todo, a t c are the hotkeys of their fields', async ($, on) => {
  engine(on)
  on('session.cwd', () => ({ value: '/home/xavier/Sites' }))
  on('store.set', () => ({ value: undefined }))
  const pane = await wide($)

  expect((await pane.find({ key: 'focus:chore' }))?.props.hotkey).toBe('a')
  expect((await pane.find({ key: 'focus:link' }))?.props.hotkey).toBe('t')
  expect((await pane.find({ key: 'focus:note' }))?.props.hotkey).toBe('c')

  await pane.input({ key: 'chore:link:0', text: 'linear.app/unlocker/issue/UNL-4844' })
  const link = await pane.find({ type: 'Link' })
  expect(link?.props.href).toBe('https://linear.app/unlocker/issue/UNL-4844')
  expect(await pane.find({ key: 'chore:toggle:1' })).toBeDefined()
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

test('the feed names an MCP call by its server and tool, a shell call by its purpose', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'mcp__linear-unlocker__save_issue' as never, id: 'UNL-4854' } as never)
  await $.tool.call({ tool: 'Bash', command: 'D=/tmp/x; psql "$D" -f s.sql', description: 'Simuler le script SQL' })
  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100, scroll: { offset: 0, bodyRows: 60 } },
  })

  expect(await pane.find({ type: 'Text', text: ' MCP      ' })).toBeDefined()
  expect(await pane.find({ text: /linear-unlocker › save_issue/ })).toBeDefined()
  expect(await pane.find({ text: /Simuler le script SQL/ })).toBeDefined()
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
  expect(strip?.props.rows).toBe(13)
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
  expect(strip?.props.rows).toBe(13)
})

test('pet big draws the 64 by 36 sheet over 18 rows and its ground', async ($, on) => {
  await start($, on)
  await petCommand($, 'big')
  const strip = await (await mounted($, 100)).find({ key: 'pet' })

  expect(strip?.type).toBe('Raster')
  expect(strip?.props.rows).toBe(19)
})

test('cat picks which cat walks the pane, at either size', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'mission', args: 'cat noir', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  const small = await mounted($, 100)

  // The black cat has no small sheet of its own: the big one by half, 9 rows and the ground.
  expect((await small.find({ key: 'pet' }))?.props.rows).toBe(10)
  await small.unmount()

  await petCommand($, 'big')
  expect((await (await mounted($, 100)).find({ key: 'pet' }))?.props.rows).toBe(19)
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

test('on the desktop the cat is one self-playing Svg', async ($, on) => {
  engine(on)
  const pane = await $.ui.mount({
    plugin: 'focus-pane',
    surface: 'desktop',
    component: 'Pane',
    requestId: PANE,
    props: { ...PROPS, bodyColumns: 100 },
  })
  const cat = await pane.find({ type: 'Svg' })

  expect(cat?.type).toBe('Svg')
  expect(String(cat?.props.source)).toMatch(/@keyframes play/)
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
})
