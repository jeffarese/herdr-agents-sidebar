# herdr-agents-sidebar

[![CI](https://github.com/jeffarese/herdr-agents-sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffarese/herdr-agents-sidebar/actions/workflows/ci.yml)

A sidebar for the [Herdr](https://herdr.dev) desktop app: every agent, shell and program you run,
on this computer and on your other machines, in one list grouped by machine and by what each one
needs from you. Agents that finished their turn but left work running stay under Working, and
Claude Code's sub-agents appear under the session that started them.

![Herdr's sidebar, titled Sessions, with a search field and four filters: All 10, Needs you 1, Working 4, Done 1. Under "This computer · LOCAL": Needs you, "Rotate the API signing keys"; Done, "Fix the flaky checkout test"; Working, "Upgrade the build to Node 22" with a prompt mark for its background shell, "Add retries to the webhook client" with a flag for its goal, and "Migrate the billing schema" with two sub-agents indented under it, "Check the migration on a copy" and "Find every query on invoices"; Pinned, "Tidy the logging setup"; Idle, "Write the release notes" and "zsh · api". Under "studio · REMOTE": Working, "Train the ranking model"; Idle, "Profile the image pipeline". Add machine is at the bottom.](preview.png)

This is an unofficial mod. It is not affiliated with Herdr.

## Install

Ask your agent, in a terminal inside Herdr:

> Add the Herdr mod at github.com/jeffarese/herdr-agents-sidebar

Or run the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/jeffarese/herdr-agents-sidebar/main/install.sh | sh
```

From a clone, `./install.sh` does the same. Run it again to update, and `./install.sh --remove`
to take it all out again.

It needs the Herdr app (tested with 0.1.15), herdr-core (tested with 0.1.21) and `python3` for the
installer. Background work and sub-agents are read from Claude Code (tested with 2.1.323).

### What the installer changes

- It copies `mods/agent-sidebar` into `~/.config/herdr-app/mods` (or `$HERDR_APP_HOME/mods`),
  after Herdr's own checker passes it. If the installed copy then fails the check, the previous
  version is put back.
- In the layout Herdr shows, the sidebar takes the place of Herdr's Spaces and Agents lists.
  Other blocks in the sidebar stay below it. The footer under the sidebar goes, because Settings
  and Add machine are in the sidebar itself. A separately docked Outside panel goes too: its
  agents are already in this list.
- Herdr's own layouts are read-only, so when one of them is showing, the sidebar goes into a
  copy of it called `<name>-agents` (a copy of `main` if the shown one has no sidebar). A layout of
  your own is changed in place, after a backup to `<name>.json.before-agents`.
- `--remove` deletes the copy it made and puts each layout of your own back from its backup. If
  you changed that layout since, your changes stay: the sidebar's block comes out, what it
  replaced comes back, and the backup is left in place. A layout you added the sidebar to by
  hand gets Herdr's lists back. Then the mod is deleted. Keyboard bindings are never changed.

## Using it

| To | Do |
| --- | --- |
| Open a session | Click it. Herdr focuses its pane, or peeks at it if it has none. |
| Find one | Type in the search field: a task, project, program, machine, path or status. Up, Down and Enter pick from the results; Escape clears the search, then returns to the current session. |
| See only what needs you, works or is done | Click a filter. Click it again for All. |
| Keep a session near the top | Hover its row and click the pin. A pinned session that has nothing to report sits under Pinned, above the idle ones, and comes first in its section otherwise. |
| Fold a machine or a section | Click its heading. A folded machine still shows how many sessions need you, work or are done. |
| See where each session works | Click the lines button beside Settings (or bind a key to `agent-sidebar.density`). Expanded gives each session a second line with its folder and git branch; compact is one line. Every copy of the sidebar follows the choice. |
| Start a shell or an agent on a machine | Click the machine's **+**, pick a folder, then the shell or agent (below). |
| Start another session where one works | Hover its row and click its **+**: the launcher opens with that folder picked. |
| Close a session | Hover its row and click **✕**: its pane closes, as ⌘W does in it. One that is working, needs you, has background work or runs a program asks first. |
| See everything about a session | Hover it: program, project, machine, status and for how long, its background work, its address and folder. |

### Starting a session in a folder

A machine's **+** opens a launcher: a folder at the top, what to start below.

- **Folders** come first from what is open on that machine: the folder of the terminal you are
  in, then every space's terminals and start folders. Then the folders you started sessions in
  recently, your home folder, and your projects: each folder one level inside `~/workspace`,
  `~/code`, `~/src`, `~/projects`, `~/dev`, `~/Developer`, `~/git`, `~/repos`, `~/work` or
  `~/github`, and each Git repository one level inside those. Type to search them.
- **A path** that starts with `/` or `~` lists the folders inside it, on that machine. Typing `/`
  after a search or after part of a name goes into the folder chosen: `herd/` becomes
  `~/workspace/herdr/`, listing what is inside. On this computer, the folder button (or ⌘O) opens
  the system's folder picker.
- **Where it opens:** a folder with a terminal of one of the machine's spaces in it gets a new
  tab in that space; any other gets a new space of its own. The switch beside "Start in" changes
  that, and stays as you set it while you move between folders.
- **What starts:** the highlighted program, marked ↵: at first the one you started last on that
  machine. Click any program to start it.

All of it works from the keyboard, without leaving the search field:

| Key | Does |
| --- | --- |
| Type | Search folders, or type a path |
| ↑ ↓ | Choose the folder |
| `/` | Go into the folder chosen |
| ⇥ / ⇧⇥ | Choose the program |
| ↵ | Start it (a double click on a folder does too) |
| ⌥1 … ⌥9 | Start the program in that place at once (⌥1 is Shell) |
| ⌘O | Choose a folder in the system's picker (this computer) |
| Esc | Close |

To open it from the keyboard, bind a key to `agent-sidebar.new` in `keys.json`, for example
`"cmd-t": "agent-sidebar.new"` under `global`: it opens for the machine you are working on. It
reaches the sidebar only while a layout shows it.

Herdr's commands for the next and previous agent follow the order of the list. Folds are kept
per copy of the sidebar. When the sidebar is narrower than 210 px it becomes a rail of icons,
and a button at its top widens it again.

### Sections and marks

With only this computer connected there are no machine headings, and its **+** sits beside
Settings in the title bar.

Each machine lists its sessions in the sections Herdr's Agents list uses, most urgent first:

| Section | Mark | What it means |
| --- | --- | --- |
| Needs you | Red **!** | Waiting on a permission or a question |
| Done | Check | Finished a turn you haven't looked at |
| Working | Turning ring | Working on a turn |
| Working | Pulsing prompt, robot or flag | Its turn is over, but something it started still runs (below) |
| Pinned | Small ring | A pinned session with nothing to report |
| Idle | Nothing | Waiting for you to say something, or a shell or program with no status |

Shells and programs follow the same rules as agents, and within a section everything is ordered
by what changed last.

Inside a section, sessions working in the same folder sit together under a heading with the
folder's name, where the first of them would be. A session alone in its folder names it beside
its title instead (or on its second line, expanded).

Rows show how long a session has been in its state: `<1m`, `4m`, `2h`, `3d`. A session started
by another one sits under it, and lifts it into its own most urgent section, except that a
finished sub-agent's news is its parent's to report.

### Work that goes on after a turn

Herdr marks an agent done or idle when its turn ends. With Claude Code, that can happen while
the agent still waits on something it started. The sidebar keeps such an agent under Working,
and its mark says what it waits on:

- **A prompt mark:** a background shell or monitor, such as a test run or a dev server. The
  tooltip lists each command and how long it has run.
- **A robot mark:** sub-agents or workflows still running, or a sub-agent or program running in a
  Herdr terminal it started.
- **A flag:** an open `/goal`. The tooltip shows the goal and its last check. Any other agent
  with an open goal gets a small flag beside its age.

Claude Code's sub-agents run inside its process, so Herdr has no terminal for them. The sidebar
lists each running one under its session, with its task and how long it has run. A click opens
the session. They count as part of their session in the filters and headings.

## How background work is found

Once every ten seconds, and within a second of an agent on that machine changing status, the
sidebar runs one short `sh` script on each machine through Herdr, the same way Herdr runs its
own commands there. The script looks at:

- **the processes under each agent's terminal**, with `ps`, to find the shells Claude Code
  started;
- **Claude Code's session file** for that process, `~/.claude/sessions/<pid>.json` (or under
  `$CLAUDE_CONFIG_DIR`), which says whether it is busy, waiting on a shell, or idle;
- **the session's transcript**, for its last goal record only. After the first look it reads
  only what was added since the last one;
- **the transcripts of the session's sub-agents** that were written in the last 15 minutes, and
  only while the session is busy or asking you something (always, where there is no session
  file): their description, when they started, and whether they have handed back their report.

The script changes nothing. What it prints, including the command lines of the processes under
your agents, goes only to the Herdr app, over Herdr's own connection to that machine, and stays
in memory there. The mod makes no network requests.

The launcher runs two more short `sh` scripts on the machine it starts on, the same way: one
lists your project folders (at most once every ten minutes), the other the folders inside a path
you type. Neither changes anything. The project folders it found, the folders you started
sessions in and the agents each machine has are kept in Herdr's shared state (`shared.json`), so
the next launcher shows them at once.

This relies on how Claude Code 2.1 lays out these files, which isn't a documented interface. If
a later version changes them, the sidebar falls back to Herdr's status and shows no sub-agents,
until it is updated. Other agents keep Herdr's status.

## Known limits

- **Claude Code only** for background work and sub-agents.
- **Machines where Claude Code writes no session file:** background shells are still found, but
  sub-agents and goals only when the agent was started as `claude` with `--session-id <id>`,
  `--resume <id>` or `-r <id>`.
- **A sub-agent quiet for 15 minutes**, for example one waiting on a very long command, drops off
  the list until it writes again. A stopped one can stay listed for up to 15 minutes while its
  session is busy with others.
- **Not covered:** scheduled tasks, wake-ups and pull request subscriptions. Herdr already
  shows when an agent waits on a question or a permission.
- **Windows:** the installer and the background check need a POSIX shell. The list itself works
  anywhere Herdr does, but is tested only on macOS.

## Performance

On a Mac with 1,240 processes and 12 agents, one look takes about 115 ms, most of it `ps`; on a
remote Mac it is about 90 ms with the round trip. The first look reads each transcript in full
for its goal, about half a second per 100 MB and at most 256 MB a look; the rest wait for the
next look. Later looks read only what was added. Building the list takes under 0.5 ms for 500
terminals. `node scripts/bench.mjs` measures it on your machine (`--live` adds your own agents).

## Development

```sh
npm test                           # node --test, including the probe script in each local shell
herdr-app check mods/agent-sidebar # Herdr's own checker, which renders the mod once
npm run bench                      # the benchmarks above
```

- **`mods/agent-sidebar/model.js`** turns Herdr's terminals into rows, sections and counts. It
  imports nothing from the app, so Node can test it.
- **`mods/agent-sidebar/background.js`** holds the probe script and reads what it prints. Also
  plain JavaScript.
- **`mods/agent-sidebar/main.js`** draws the sidebar with Herdr's `herdr` and `gpui-kit` modules,
  and `launcher.js` the launcher behind each machine's **+**.
- **`mods/agent-sidebar/folders.js`** picks the folders the launcher offers and where a session
  there opens, and holds its two `sh` scripts. Plain JavaScript too.
- **`scripts/install.py`** installs, updates and removes it; `install.sh` fetches the repository
  when run on its own.

## License

MIT. The icons follow [Lucide](https://lucide.dev), and some are Lucide's own: see
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
