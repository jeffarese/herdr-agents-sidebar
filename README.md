# herdr-agents-sidebar

[![CI](https://github.com/jeffarese/herdr-agents-sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffarese/herdr-agents-sidebar/actions/workflows/ci.yml)

A sidebar for the [Herdr](https://herdr.dev) desktop app: every agent, shell and program you run,
on this computer and on your other machines, in one list grouped by machine and by what each one
needs from you. Agents that finished their turn but left work running stay under Cooking, and
Claude Code's sub-agents appear under the session that started them.

![The Sessions sidebar on the left of a Herdr window; the rest of the window is dimmed. The sidebar, titled Sessions 12 with a star, a gear and a button to fold it, lists under "Local", a laptop followed by its CPU, memory and disk: Needs you, "Rotate the API signing keys", wanting Bash to rotate the staging keys; Done, "Fix the flaky checkout test" in a worktree of shop, +42 −7 and pull request #128; Cooking, "Add retries to the webhook client" editing a migration, with the flag of an open goal and its Codex sub-agent "Review the retry change" under it, +85 −6 #1203, then "Speed up the checkout page", selected, reading useCartTotals.ts, with two Claude Code sub-agents under it, "Find useCartTotals callers" (Explore) and "Profile the checkout" (general-purpose); Idle, the shell dev-server, "Update the docs for the new API" with +52 −9, "Write the release notes" with the pointer on it, showing Haiku · low and its buttons to send it a message, move it, start a session in its folder, pin it and close it, then the api server and shop's dev server with their branches and changes. Under "studio", a desktop marked remote by a small globe, followed by its CPU and memory: Cooking, "Train the ranking model" at epoch 12 of 20; Idle, "Benchmark the search index". Then "attic · Unavailable", Add machine, and Recently closed 1. Behind the dim: Claude Code speeding up the checkout page in the middle under a header with its model and limits, pull requests, system stats and running servers on the right, and two notifications in the bottom right corner. The sessions are made up.](preview.png)

*Around it: Claude Code under a pane header with the model and limits, [pull requests](https://github.com/jeffarese/herdr-prs) and [stats](https://github.com/jeffarese/herdr-stats-mod) on the right with what's running, and two notifications in the corner. Every session in it is made up.*

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
installer. Background work, sub-agents, and each session's model and effort are read from Claude Code
(tested with 2.1.326).

### What the installer changes

- It copies `mods/agent-sidebar` into `~/.config/herdr-app/mods` (or `$HERDR_APP_HOME/mods`),
  after Herdr's own checker passes it. If the installed copy then fails the check, the previous
  version is put back.
- In the layout Herdr shows, the sidebar takes the place of Herdr's Spaces and Agents lists.
  Other blocks in the sidebar stay below it. The footer under the sidebar goes, because Add machine is in
  the sidebar itself and Herdr's settings are one click inside the sidebar's own. A separately docked Outside panel goes too: its
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
| Change what the sidebar shows | Click the gear in the title bar (or bind a key to `agent-sidebar.settings`). The sidebar's own settings open in a window with four tabs. **Layout:** rows, grouping, folder headings and motion. **List:** sub-agents, shells, machines that are away, each machine's CPU, memory and disk, and the lines under the list (Add machine, Recently closed, Clean up and how old is old). **Sessions:** what each row says (model, effort and its colors, what it is doing, context size, lines changed, pull request, time in its state). **Organize:** the star's button, whether it asks Claude Code or Codex, and its model and effort. Each choice is kept in Herdr's shared state, so every copy of the sidebar follows. Turning off lines changed or pull requests also stops asking git or GitHub for them, and turning off CPU, memory and disk stops asking the machines how busy they are. **Herdr settings…** at the bottom opens Herdr's own, and **Reset to defaults** brings the defaults back. |
| Pick one from the keyboard | With the sidebar focused (`pane.go`), Up and Down move through the sessions and Enter opens the one picked; Escape returns to the current session. |
| Keep a session near the top | Hover its row and click the pin. A pinned session that has nothing to report sits under Pinned, above the idle ones, and comes first in its section otherwise. |
| Fold a machine or a section | Click its heading. A folded machine still shows how many sessions need you, work or are done. |
| See how busy each machine is | With more than one machine, each heading follows the name with its CPU, the share of its memory in use and how full its disk is, as in `20% 75% 47%`, in gray. One turns amber, then red, when it runs high: CPU at 70% and 90%; memory, on a Mac, when its memory pressure passes 50% and 75% (a Mac keeps most of its memory in use, and only the pressure says it is short), elsewhere at 80% and 92% used; the disk at 85% and 95% full. They update every ten seconds and give way, disk first, then memory, when the sidebar is too narrow; the heading's tooltip always has them, with the sizes. A remote machine's name is followed by a small globe. |
| Group sessions by space, or by project | Choose **Group by** in the settings (or bind a key to `agent-sidebar.group`, which goes from status to spaces to projects and round again). By space, each of Herdr's spaces is a heading, in Herdr's order and with its color, holding its sessions by urgency; one with no session keeps its heading. By project, spaces of one name on every machine are one heading, under no machine, and a session elsewhere says where. Whatever the grouping, what needs you comes first. Every copy of the sidebar follows the choice. |
| See which model and effort a session runs with | Expanded, each Claude Code session's second line ends with them when there is room, as in `Opus 5.5 · xhigh · 159k`: the model, its effort (bolder from `xhigh` up) and the context its last turn was sent. They give way first: to what the session asks or does, said in full, and to its folder, branch and changes. Compact, `Opus · xhigh` follows the title when it fits. The tooltip always has them. The settings can color the effort by its level, from gray through blue, green and yellow to red; it is off at first, so that every color in the list is a status. |
| See what a session is doing, or wants | While a Claude Code session works, its second line (expanded) or the space after its title (compact, when it fits) says its last step, as in `Bash · Run the tests`. One that needs you says what for: `Asks · Which database?`, `Wants Bash · Delete the build folder`. |
| See what a session changed, and its pull request | Expanded, a session's folder is followed by the lines added and removed since the last commit there, and by its branch's pull request number in its state's color (needs the GitHub CLI, `gh`). The tooltip has the link. |
| Manage a space | Grouped by space, hover a space's heading: **+** starts a shell or agent in it, the arrows move all its sessions to another space, **⋯** (or a right-click) opens Herdr's own menu to rename or close it. Double-click the heading to rename, click its dot to change its color, drag it onto another to reorder. A machine's heading (or the title bar, with one machine) has a button for a new space. |
| Move a session to another space | Hover its row and click the arrow, then click the space; or drag the row onto the space. Its pane closes and it reappears as a tab of that space, still running. Spaces of other machines are no destination. Escape cancels. |
| Let Claude or Codex organize the spaces | Click the star in the title bar. Claude (through Claude Code on this computer) or a GPT model (through Codex) is shown each session's title, folder, branch and space, and suggests spaces by project. The settings choose which, the family of model (Haiku, Sonnet or Opus; Luna, Terra, Sol or Astra) and the effort; the latest model of the family is used. By default it is Claude Sonnet at low effort. While it is asked a banner says so. Its suggestion is then shown as a preview: the list becomes the spaces as they would be, with new and renamed spaces marked and each session that would move highlighted, saying where from. Click a highlighted session to leave it where it is. Nothing changes until **Apply**; **Dismiss** or Escape puts it away. A key can be bound to `agent-sidebar.organize`. |
| Send a session a message | Hover an agent's row and click the paper plane, type, Enter. It is pasted and submitted as `hc send` does. Not offered for a shell, or for an agent waiting on a dialog. |
| Close what is old | When sessions have been idle for over a day, a line under the list closes them all, on a second click. Pinned ones, the one you are in and any with work running stay. |
| Reopen a closed session | Claude Code sessions that ended are kept under **Recently closed** (the last eight). Click one to resume it in its folder. |
| See the sessions of a machine that is away | A machine Herdr can't reach is one dim line after the others. Click it to show the sessions it had when last seen; they can't be opened until it is back. |
| See where each session works | Choose **Expanded** rows in the settings (or bind a key to `agent-sidebar.density`). Each session gets a second line with its folder and git branch (a folder too long for the line loses its start, not its end); compact is one line. Every copy of the sidebar follows the choice. |
| Start a shell or an agent on a machine | Click the machine's **+**, pick a folder, then the shell or agent (below). |
| Start another session where one works | Hover its row and click its **+**: the launcher opens with that folder picked. |
| Close a session | Hover its row and click **✕**: its pane closes, as ⌘W does in it. One that is working, needs you, has background work or runs a program asks first. |
| See every agent as a card, with its sub-agents | With the [Agent grid](https://github.com/jeffarese/herdr-agent-grid-mod) installed, the title bar gets a grid button (its tooltip names the key, ⌘G as it ships): every agent on every machine as a card, with what it is doing, what it last said and its sub-agents. The button shows only while that mod is installed. |
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
- **Which machine:** with more than one connected, the header shows each as a tab. Click one,
  or press ⇥, to start there instead; what you typed stays and searches that machine's folders.
- **What starts:** the highlighted program, marked ↵: at first the one you started last on that
  machine. Click any program to start it.

All of it works from the keyboard, without leaving the search field:

| Key | Does |
| --- | --- |
| Type | Search folders, or type a path |
| ⇥ / ⇧⇥ | Move to the next or previous machine (what you typed searches there) |
| ↑ ↓ | Choose the folder |
| `/` | Go into the folder chosen |
| ⌥↑ / ⌥↓ | Choose the program |
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

<img src="docs/media/sidebar.png" width="298" alt="The Sessions sidebar alone. Under Local, a laptop followed by its CPU, memory and disk: Needs you, one session asking for Bash; Done, one session with +42 −7 and pull request #128; Cooking, two sessions with their spinners, one with a Codex sub-agent in a terminal of its own and the selected one with two Claude Code sub-agents, Explore and general-purpose, under it; Idle, a program running in no space, two agents and the two tabs running servers, the row of one agent with the pointer on it showing its buttons. Under studio, a desktop marked remote by a globe, followed by its CPU and memory: one session cooking, one idle. Then attic, Unavailable, Add machine, and Recently closed 1. The sessions are made up.">

With only this computer connected there are no machine headings, and its **+** sits beside
Settings in the title bar.

Each machine lists its sessions in the sections Herdr's Agents list uses, most urgent first. A
section's heading is a gray label with its rows' mark in its status's color (a pin for Pinned, a
ring for Idle), and its chevron shows while it is folded or pointed at:

| Section | Mark | What it means |
| --- | --- | --- |
| Needs you | Red **!** | Waiting on a permission or a question |
| Done | Check | Finished a turn you haven't looked at |
| Cooking | Turning ring | Working on a turn |
| Cooking | Pulsing prompt, robot or flag | Its turn is over, but something it started still runs (below) |
| Pinned | Small ring | A pinned session with nothing to report |
| Idle | Nothing | Waiting for you to say something, or a shell or program with no status |

Shells and programs follow the same rules as agents, and within a section everything is ordered
by what changed last.

Inside a section, sessions working in the same folder sit together under a heading with the
folder's name, where the first of them would be. A session alone in its folder names it beside
its title instead. Expanded, every session names its folder on its second line, so they sit
together under no heading.

Rows show how long a session has been in its state: `<1m`, `4m`, `2h`, `3d`. A session started
by another one sits under it, and lifts it into its own most urgent section, except that a
finished sub-agent's news is its parent's to report.

### Work that goes on after a turn

Herdr marks an agent done or idle when its turn ends. With Claude Code, that can happen while
the agent still waits on something it started. The sidebar keeps such an agent under Cooking,
and its mark says what it waits on:

- **A prompt mark:** a background shell or monitor, such as a test run or a dev server. The
  tooltip lists each command and how long it has run.
- **A robot mark:** sub-agents or workflows still running, or a sub-agent or program running in a
  Herdr terminal it started.
- **A flag:** an open `/goal`. The tooltip shows the goal and its last check. Any other agent
  with an open goal gets a small flag beside its age.

Claude Code's sub-agents run inside its process, so Herdr has no terminal for them. The sidebar
lists each running one under its session, with its task and how long it has run. A Codex run
the session started through a shell (`codex exec` or `codex review`, an adversarial review, say)
is listed the same way, with Codex's icon, its model and effort, and the name of the file it
writes its answer to. A line joins a session's sub-agents. A click opens
the session. They count as part of their session in the title's count and the headings.

## How background work is found

Once every ten seconds, and within a second of an agent on that machine changing status, the
sidebar runs one short `sh` script on each machine through Herdr, the same way Herdr runs its
own commands there. The script looks at:

- **the processes under each agent's terminal**, with `ps`, to find the shells Claude Code
  started;
- **Claude Code's session file** for that process, `~/.claude/sessions/<pid>.json` (or under
  `$CLAUDE_CONFIG_DIR`), which says whether it is busy, waiting on a shell, or idle;
- **the session's transcript**, for its last goal record and for the model and effort of its
  last turn, its context size, and the start of that turn's last tool call (its name and at most
  480 bytes of its input, such as a command or a file name): only those are printed. After the first look it reads only what
  was added since the last one;
- **the transcripts of the session's sub-agents** that were written in the last 15 minutes, and
  only while the session is busy or asking you something (always, where there is no session
  file): their description, when they started, and whether they have handed back their report.

The script changes nothing. What it prints, including the command lines of the processes under
your agents, goes only to the Herdr app, over Herdr's own connection to that machine, and stays
in memory there. The mod itself makes no network requests. Two things it runs do, both yours and already signed
in: the GitHub CLI, asked every five minutes for the pull request of each session's branch (not
for `main` or `master`, and not at all without `gh`), and Claude Code or Codex (whichever the settings choose), once each time you click the star to
organize the spaces, which sends Anthropic or OpenAI the sessions' titles, folders, branches
and space names. Every half minute `git diff --shortstat` is run in each session's folder, without
taking git's optional locks.

Once at each start, another script of a few lines asks each machine what it is (`uname`, and
on a Mac `sysctl hw.model` and `pmset -g batt`; elsewhere the chassis type under `/sys`), so
its heading can show a laptop, a desktop or a server. The answer, one word, is kept in Herdr's
shared state. It changes nothing either.

While machine headings show (more than one machine, the sidebar wider than a rail, CPU, memory
and disk on in the settings), a third short script asks each machine that is connected how busy it
is, every ten seconds. On a Mac it runs `iostat` for one second of CPU, `sysctl` for the memory
size and pressure, and `vm_stat`, counting memory in use as Activity Monitor does (app, wired
and compressed); on Linux it reads `/proc/stat` twice a second apart and `/proc/meminfo`. On
both, `df -kP /` says how full the disk is: everything not available, as Finder counts it. That
is about 10 ms of work and a second of waiting. On this computer, when
[herdr-stats](https://github.com/jeffarese/herdr-stats-mod) is running its sampler, the figures
are read from its snapshot (`herdr-stats/snapshot.json` in the cache folder) instead, and no
script runs. The figures stay in memory. This changes nothing either.

The launcher runs two more short `sh` scripts on the machine it starts on, the same way: one
lists your project folders (at most once every ten minutes), the other the folders inside a path
you type. Neither changes anything. The project folders it found, the folders you started
sessions in and the agents each machine has are kept in Herdr's shared state (`shared.json`), so
the next launcher shows them at once.

This relies on how Claude Code 2.1 lays out these files, which isn't a documented interface. If
a later version changes them, the sidebar falls back to Herdr's status and shows no sub-agents,
until it is updated. Other agents keep Herdr's status.

## Known limits

- **Moving a session** closes its pane and gives its terminal the other space's labels; Herdr
  has no command for it. If the second step fails, the session keeps running without a pane and
  is listed under No space, where a click peeks at it.
- **Claude Code only** for background work, sub-agents, what a session is doing, and model and effort. The model is
  looked for in the last 1 MB of a transcript on the first look, and in everything added after
  that. A session whose transcript can't be found (no session file, see below) shows the model
  it was started with (`claude --model …`), with no effort, or nothing if it was given none.
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
- **`mods/agent-sidebar/settings.js`** is the window behind the gear, and **`demo.js`** a set of
  example sessions: `agent-sidebar.demo` opens a copy that shows them and asks no machine
  anything.
- **`scripts/install.py`** installs, updates and removes it; `install.sh` fetches the repository
  when run on its own.
- **`docs/demo/`** sets up the scene of the pictures in this README, on a made-up Herdr window
  with every mod running; its `README.md` says how to take them again.

## Works well with

The pictures above are one Herdr window with these mods running together:

- [Pull requests](https://github.com/jeffarese/herdr-prs): your pull requests and the state of their checks, in a sidebar.
- [Stats](https://github.com/jeffarese/herdr-stats-mod): CPU, memory, GPU, network and temperatures beside your terminals, and which agent is using them.
- [Quick switcher](https://github.com/jeffarese/herdr-bar-mod): ⌘K to any agent, tab, pane or space on every machine.
- [Mod hub](https://github.com/jeffarese/herdr-mod-hub): browse the gallery, read a mod's code before installing it, and manage your mods.
- [Outside](https://github.com/jeffarese/herdr-outside): the agents and terminals herdr-core runs outside your spaces.

## License

MIT. The icons follow [Lucide](https://lucide.dev), and some are Lucide's own: see
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
