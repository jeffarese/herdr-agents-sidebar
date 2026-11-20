# How the README's pictures are made

`preview.png` (the README's main picture and the card in Herdr's gallery) and
`docs/media/sidebar.png` (the sidebar alone, larger) are pictures of a real Herdr window: the
showcase stage in `~/workspace/herdr/herdr-showcase`, a second Herdr app on this Mac with its own
home, its own herdr-cores and every mod installed from its repository. Its sessions, machines,
pull requests and servers are made up (Sam, at Acme); nothing of anyone's own is in them. The
kit's `README.md` says how the stage works and `BRIEF.md` what it shows.

The stage is shot without the VPN switch (`SHOWCASE_VPN=0`), as every public mod's pictures are.

## The sidebar's scene: `showcase.sh`

The kit's `scene.sh` plays the cast and ends on the default scene: space shop, its Claude Code
session "Speed up the checkout page" focused, and two notifications in the corner. Then it runs
`showcase.sh`, which adds what the sidebar can show and the cast doesn't:

- **Two sub-agents** under "Speed up the checkout page": a transcript and a `.meta.json` for each
  under the session's `subagents/` folder, as Claude Code writes them. The sidebar drops a
  sub-agent whose transcript has been quiet for 15 minutes, so a loop touches them every four
  minutes; it ends by itself once the stage's app has stopped.
- **An open goal** on "Add retries to the webhook client": a `goal_status` record at the end of
  its transcript, so the row has its flag.
- **One session under Recently closed**: a Claude Code session started in web, given a session
  file, and ended once the sidebar has seen it. A window behind others draws only when asked to,
  and the sidebar notices sessions only when it draws, so the hook asks it to with `herdr-app
  shot` (to a file it throws away) while that happens.
- **A hovered row**, "Write the release notes", with its buttons (message, move, new session
  here, pin, close). `shoot.sh` moves the pointer out of the window before each picture, so the
  hook changes the stage's copy of `main.js` (never this repository's) to draw that row as if the
  pointer were on it: its buttons and the hover background. Herdr reloads the mod when the file
  changes.

The local machine's and the studio's CPU, memory and disk figures are this Mac's own at the
moment of the picture (the studio is a second herdr-core on the same Mac), so they differ from
one picture to the next.

## The pictures

- **`preview.png`**: the whole window, everything outside the sidebar's column dimmed (`shoot.sh
  --dim`, the rest at 0.45 brightness). Every mod's README shows this same window; the dim says
  which part this one is about, and the rest stays readable behind it.
- **`docs/media/sidebar.png`**: the sidebar alone at 2x, from the top down to Recently closed
  (`shoot.sh --crop`), for the README's sections and marks.

The sidebar's width comes from a setting (`sidebar.width`) and its length from the mod's row
heights, so `showcase-shots.sh` measures both before it shoots, on the last frame the stage drew
(`herdr-app shot` to a file it deletes): the sidebar's border and its last line.

## Taking them again

```sh
sh docs/demo/showcase-shots.sh
```

It builds a stage with this scene (`SHOWCASE_VPN=0`, `SHOWCASE_HOOK=docs/demo/showcase.sh`),
takes both pictures with the kit's `shoot.sh`, writes them over `preview.png` and
`docs/media/sidebar.png`, and takes the stage down, also when a step fails. A picture over
2.5 MB is reduced to 256 colors. `SHOWCASE_KIT` points at another copy of the kit;
`SIDEBAR_DIM` and `SIDEBAR_CROP` (`x,y,w,h` in pixels of the 2x picture) replace the measured
rectangles.

Building the stage and playing the scene take about a minute. `shoot.sh` waits until the
keyboard and mouse have been still for a minute and takes turns with any other stage, so a run
takes a few minutes.

Look at both pictures before committing them.

To work on the scene by hand, build a stage and leave it up:

```sh
kit=~/workspace/herdr/herdr-showcase
w=$(SHOWCASE_VPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh $kit/stage.sh)
(. "$w/env.sh" && herdr-app do space.select --index 2)   # every command with the stage's env
sh $kit/shoot.sh "$w" /tmp/try.png
sh $kit/stage.sh --down "$w"
```
