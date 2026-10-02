# focus-pane

A Claude Code mod: a permanent side pane that keeps the session's context on screen.

- **Header** — session state, branch, ticket (`UNL-1234`, caught from the branch or a prompt).
- **Mission / action** — the first real ask, condensed once; the action in hand, rewritten each turn.
- **Cards** — plan progress, context tokens and cost, turns, session time.
- **Sacred Book** — the bound feature's spec and plan (status, outline, GitHub link) and its mockup.
- **Todos** — the list the agent's `TodoWrite` wrote.
- **Activity** — live feed of tool calls: time, tool, detail, outcome.
- **Comments / My todo** — typed in the pane, kept per working directory across sessions.
- **Mockups tab** — one thumbnail per screen of the bound mockup, with an open-in-browser button.

It opens by itself at session start. Opened unasked, the engine seats a pane only from 144 terminal
columns; in a narrower terminal, run the slash command once (`/mission`).

## Install — instructions for an agent

Run these on the machine that runs Claude Code. Do not improvise other paths: the settings below are
the only mechanism that loads a mod in every session.

1. **Clone** to the conventional place (any absolute path works, this one is assumed below):

   ```sh
   git clone git@github.com:Juyn/claude-focus-pane.git ~/.claude/mods/focus-pane
   ```

2. **Register** it for every session:

   ```sh
   ~/.claude/mods/focus-pane/install.sh
   ```

   It adds the folder to `CLAUDE_CODE_PLUGIN_DIRS` and sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` in the
   `env` block of `~/.claude/settings.json` (backup written beside it; other plugin folders are
   kept; running it twice changes nothing). To do it by hand instead:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/<user>/.claude/mods/focus-pane", "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1" } }
   ```

   Several folders are separated by `:` (`;` on Windows).

3. **Verify**:

   ```sh
   claude plugin validate ~/.claude/mods/focus-pane   # must end with "Validation passed"
   claude plugin test ~/.claude/mods/focus-pane       # the mod's own tests
   ```

   If `claude plugin test` answers `hooks modules are turned off in this process`, mods are not
   enabled for this account or build: nothing will load, and that is not fixable from this repo.
   Report it instead of retrying.

4. **Start a new session.** Plugin folders are read when the Claude Code process starts; a running
   session never picks them up. The pane footer names the slash command actually granted
   (`/mission`, else `/focus-pane`, `/unlocker`, `/pane`).

### Claude Code in a terminal (TUI), any host

Steps 1–4 as written, on that host, as the user who runs `claude`. Requires Claude Code ≥ 2.1.287.

### Claude Desktop (Code tab)

The desktop app starts its local Code sessions with the same `~/.claude/settings.json`, so steps 1–4
on the desktop machine are the whole install: the `env` block is how a folder is named where no
`--plugin-dir` flag can be given. Quit and reopen the app (or start a new Code session) afterwards.
For a session the desktop app runs on a **remote** host, install on that host, not on the desktop.
On the desktop surface the mockup thumbnails are not drawn (they are terminal cells); captions and
the open button are.

### One-off, without touching settings

```sh
claude --plugin-dir ~/.claude/mods/focus-pane
```

## Requirements

| Needed for | What |
|---|---|
| The pane | Claude Code ≥ 2.1.287 with mods enabled |
| Sacred Book cards | a checkout of `unlocker-io/sacred-book` at `~/Sites/sacred-book`, or `SACRED_BOOK_DIR` |
| Open a mockup | `xdg-open`; `API_DEV_UNLKR` (a dev.unlkr.io token with `dev.designs.read`) in the environment for the signed URL — without it the checkout's local file is opened |
| Mockup thumbnails | `python3`, ImageMagick (`magick`), a Chromium browser (`brave`, `chromium`, `google-chrome`) |

Everything but the first row is optional: the pane draws without it. Never write the token into a
file of this repo or into `settings.json`; export it from the shell profile.

## Use

| Command | Does |
|---|---|
| `/mission` | reopens the pane |
| `/mission spec <feature>` | binds a Sacred Book feature by folder name or ticket (`console-comptes`, `UNL-4844`); `spec off` unbinds |
| `/mission mission <text>` | sets the mission by hand |
| `/mission <text>` / `auto` | pins the action line / hands it back to the model |
| `/mission demo` | fills the todo list from the bound plan, to see the pane full |

With the keyboard in the pane (click it, or `ctrl+x tab`): `a` task, `t` link, `c` comment,
`m` mockup thumbnails, `o` open the mockup, `esc` back to the prompt.

A branch that carries a ticket known to a Sacred Book README binds its feature at session start.

## Develop

```sh
claude plugin validate .
bunx --package typescript tsc -p .
claude plugin test .
```

`hooks/register.tsx` is the module, `types/index.d.ts` its state contract, `scripts/thumbs.py` the
thumbnail shooter (cached in `~/.cache/focus-pane`). With `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` an edit
reloads the mod when the turn that made it ends. `.claude-plugin/types/` is written by the engine
and ignored by git.
