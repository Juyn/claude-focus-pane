export type Focus = {
  /** The ticket key the work hangs on, from a prompt, the branch, or /focus. */
  ticket: string | null
  /** The session's standing mission: the first real ask, phrased once by haiku. */
  mission: string | null
  /** True once haiku condensed the mission: the raw first prompt is shown until then. */
  isMissionPhrased: boolean
  /** One line on the action now: rewritten by haiku each turn, or pinned by /focus. */
  summary: string | null
  /** The branch of the session's cwd, read once at session.start. */
  branch: string | null
  /** The prompt of the turn now running, kept so the lines can be rewritten. */
  ask: string
  /** True while /focus pinned the action by hand: no model rewrites it. */
  isPinned: boolean
  /** True once the person closed the pane: it stops coming back on its own. */
  isDismissed: boolean
}

export type Todo = {
  /** The task's id when a task tool made it; a TodoWrite row has none. */
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
  /** Ids of the tasks that must finish first, as the task tools reported them. */
  blockedBy?: string[]
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** One subagent of the session, as its spawn and its steps reported it. */
export type AgentRow = {
  /** The agentId its loop's events carry. */
  id: string
  /** The spawn's description, or the listed agent's. */
  title: string
  /** The subagent type it runs as. */
  type: string
  /** The resolved model id: the spawn's, then each step's. */
  model: string | null
  /** The `effort` of its last step. */
  effort: Effort | null
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt: number | null
  /** The size of its last step: input, cache read, cache write and output. */
  context: number
  /** The four counters, summed over every step. */
  tokens: number
  /** What those steps cost, estimated from the price table. */
  usd: number
}

/** How the AGENTS section is shown: rows folded to a line, the finished hidden. */
export type AgentsView = {
  isFolded: boolean
  isDoneHidden: boolean
}

/** One tool call of the live feed, newest first; `ms` stays null while it runs. */
export type FeedRow = {
  id: string
  tool: string
  detail: string
  at: number
  ms: number | null
  isError: boolean
}

/** One active document of a Sacred Book feature, as its README lists them. */
export type Doc = {
  kind: 'spec' | 'plan' | 'design'
  /** The file's own name, as the README shows it. */
  name: string
  /** Its path in the Sacred Book repository: what a GitHub URL or the dev API takes. */
  path: string
  status: string | null
  title: string | null
  /** Its `##` headings, and its `###` ones indented by two spaces. */
  outline: string[]
}

/** The Sacred Book feature the pane is bound to, read off the local checkout. */
export type Feature = {
  /** `v2/banking/console-comptes`: the feature's folder in the repository. */
  path: string
  title: string
  ticket: string | null
  docs: Doc[]
}

/** How the cat at the bottom of the pane is drawn: the sprite sheet, ray-marched in 3D, line art, flat pixels, or not at all. */
/** Which cat walks the pane: a folder of sheets under assets/cats/. */
export type PetCoat = 'roux' | 'noir' | 'garfield' | 'panda'

export type PetStyle = 'png' | 'big' | 'sprite' | '3d' | 'line' | 'pixel' | 'off'

/** The mockups tab: the screens of the bound mockup, shot once by thumbs.py. */
export type Gallery = {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** The mockup the shots are of, so another feature's are shot anew. */
  path: string | null
  /** `cells`: base64 Raster cells, `columns` by `rows`. */
  shots: { id: string; title: string; columns: number; rows: number; cells: string }[]
}

/** The session's own counters, as `$.session.usage()` last reported them. */
export type Usage = {
  tokens: number | null
  window: number
  percent: number | null
  usd: number | null
  startedAt: number | null
}

export type TurnState = {
  count: number
  isRunning: boolean
  startedAt: number | null
  lastMs: number | null
}

/**
 * Which palette the pane paints with, from the `theme` row of /config: the two
 * brand palettes, or `ansi` for a theme that asks for the terminal's own colors
 * — there the pane sets no color at all.
 */
export type Skin = 'dark' | 'light' | 'ansi'

declare module 'claude-code' {
  interface PluginState {
    'focus-pane': {
      focus: Focus
      todos: Todo[]
      feed: FeedRow[]
      agents: AgentRow[]
      agentsView: AgentsView
      usage: Usage
      feature: Feature | null
      gallery: Gallery
      petStyle: PetStyle
      petCoat: PetCoat
      turn: TurnState
      skin: Skin
      /** The slash command the engine actually granted, or null while it has none. */
      command: string | null
    }
  }
}
