#!/bin/sh
# The Sessions sidebar's scene for its README pictures, on a stage of the showcase kit
# (~/workspace/herdr/herdr-showcase). The kit's scene.sh runs it last, with the stage's folder:
#
#   w=$(SHOWCASE_VPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh ~/workspace/herdr/herdr-showcase/stage.sh)
#
# From the default scene (shop's Claude Code focused, two toasts) it adds what the sidebar can
# show and the cast doesn't:
#   - two Claude Code sub-agents under the focused session, "Speed up the checkout page", as
#     Claude Code writes them (a transcript and a .meta.json under the session's subagents/);
#   - an open /goal on "Add retries to the webhook client" (a goal_status record), its flag;
#   - one session under Recently closed: a Claude Code session started in web and ended;
#   - "Write the release notes" shown as hovered, with its row's buttons. shoot.sh moves the
#     pointer out of the window, so the stage's copy of the mod (never the repository's) is
#     changed to draw that row as if the pointer were on it.
# Everything it writes is under the stage's own HOME and app home.
set -eu
w=$(cd "${1:?usage: showcase.sh <stage folder>}" && pwd -P)
# shellcheck disable=SC1091
. "$w/env.sh"
say() { printf '%s\n' "agent-sidebar: $*" >&2; }
mod="$HERDR_APP_HOME/mods/agent-sidebar"
claude="$HOME/.claude"

# The terminal of a tab, from `hc ls` ("shop / 1").
terminal_at() {
  hc ls 2>/dev/null | /usr/bin/python3 -c 'import json, sys
where = sys.argv[1]
for t in json.load(sys.stdin).get("terminals", []):
    if t.get("where") == where:
        print(t["address"]); break' "$1"
}
# A Claude Code session's transcript, by the folder its session file names.
transcript_in() {
  /usr/bin/python3 - "$claude" "$1" <<'PY'
import glob, json, os, sys
claude, cwd = sys.argv[1:3]
for f in glob.glob(f"{claude}/sessions/*.json"):
    s = json.load(open(f))
    if s.get("cwd") == cwd:
        for t in glob.glob(f"{claude}/projects/*/{s['sessionId']}.jsonl"):
            print(t)
            sys.exit(0)
PY
}

# ---------------------------------------------------------------- sub-agents under shop's session

say "sub-agents"
shop=$(transcript_in "$HOME/code/shop")
[ -n "$shop" ] || { echo "agent-sidebar: no transcript for shop's session" >&2; exit 1; }
/usr/bin/python3 - "$shop" <<'PY'
import json, os, sys, time, uuid
transcript = sys.argv[1]
session = os.path.basename(transcript)[:-len(".jsonl")]
subs = os.path.join(transcript[:-len(".jsonl")], "subagents")
os.makedirs(subs, exist_ok=True)
now = time.time()
stamp = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
for n, (kind, task, minutes, tool, args) in enumerate([
    ("general-purpose", "Profile the checkout", 1, "Bash", {"command": "npx lighthouse http://localhost:5173/checkout --preset=perf", "description": "Profile the checkout"}),
    ("Explore", "Find useCartTotals callers", 0.5, "Grep", {"pattern": "useCartTotals", "path": "src"}),
]):
    agent = uuid.uuid5(uuid.NAMESPACE_URL, f"{transcript}/{n}").hex[:17]
    base = os.path.join(subs, f"agent-{agent}")
    json.dump({"agentType": kind, "description": task}, open(base + ".meta.json", "w"), separators=(",", ":"))
    t = now - minutes * 60
    lines = [
        {"parentUuid": None, "isSidechain": True, "agentId": agent, "type": "user",
         "message": {"role": "user", "content": task}, "uuid": str(uuid.uuid4()), "timestamp": stamp(t), "sessionId": session},
        {"parentUuid": None, "isSidechain": True, "agentId": agent, "type": "assistant",
         "message": {"model": "claude-opus-5-5", "role": "assistant", "type": "message",
                     "content": [{"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:24], "name": tool, "input": args}],
                     "stop_reason": "tool_use"},
         "uuid": str(uuid.uuid4()), "timestamp": stamp(now - 10), "sessionId": session},
    ]
    with open(base + ".jsonl", "w") as f:
        for line in lines:
            f.write(json.dumps(line, separators=(",", ":")) + "\n")
PY
# A sub-agent whose transcript is quiet for 15 minutes drops off the list: these stay fresh for as
# long as the stage's app runs. The loop ends within ten seconds of the app, or of the folder.
app=$(cat "$w/app.pid")
(
  n=0
  while kill -0 "$app" 2>/dev/null && [ -d "${shop%.jsonl}/subagents" ]; do
    [ $((n % 24)) = 0 ] && find "${shop%.jsonl}/subagents" -name 'agent-*.jsonl' -exec touch {} + 2>/dev/null
    n=$((n + 1))
    sleep 10
  done
) </dev/null >/dev/null 2>&1 &

# ---------------------------------------------------------------- an open goal on api's session

say "goal"
api=$(transcript_in "$HOME/code/api")
[ -n "$api" ] || { echo "agent-sidebar: no transcript for api's session" >&2; exit 1; }
/usr/bin/python3 - "$api" <<'PY'
import json, sys, time, uuid
stamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
# "type" first in the attachment: the probe looks for "attachment":{"type":"goal_status".
record = {"type": "attachment", "attachment": {"type": "goal_status", "condition": "Every webhook test passes",
          "met": False, "reason": "3 of 41 webhook tests still fail"}, "uuid": str(uuid.uuid4()), "timestamp": stamp}
open(sys.argv[1], "a").write(json.dumps(record, separators=(",", ":")) + "\n")
PY

# ---------------------------------------------------------------- one recently closed session

say "a session to close"
before=$(ls "$w/run/agents" 2>/dev/null || :)
# tab.new opens in the shown space: web (the third) for a moment, then shop again.
herdr-app do space.select --index 3 >/dev/null
herdr-app do tab.new --folder "$HOME/code/web" --focus false \
  --argv '["claude","--state","idle","Compare two caching layers"]' >/dev/null
herdr-app do space.select --index 1 >/dev/null
herdr-app do tab.select --index 1 >/dev/null
sleep 1
pid=$(ls "$w/run/agents" | grep -vxF "$before" | sed -n 's/\.txt$//p' | tail -n 1)
[ -n "$pid" ] || { echo "agent-sidebar: the session to close didn't start" >&2; exit 1; }
/usr/bin/python3 - "$claude" "$pid" "$HOME/code/web" <<'PY'
import json, os, sys, time, uuid
claude, pid, cwd = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{claude}/closed"))
now = time.time()
stamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 1500))
json.dump({"pid": pid, "sessionId": sid, "cwd": cwd, "startedAt": int((now - 1500) * 1000), "status": "idle"},
          open(f"{claude}/sessions/{pid}.json", "w"), separators=(",", ":"))
slug = "".join(c if c.isalnum() else "-" for c in cwd)
os.makedirs(f"{claude}/projects/{slug}", exist_ok=True)
with open(f"{claude}/projects/{slug}/{sid}.jsonl", "w") as f:
    f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "Compare two caching layers"},
                        "uuid": str(uuid.uuid4()), "timestamp": stamp, "sessionId": sid, "cwd": cwd}, separators=(",", ":")) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5-5", "role": "assistant", "type": "message",
                        "content": [{"type": "text", "text": "Redis keeps up; the in-process cache doesn't."}], "stop_reason": "end_turn",
                        "usage": {"input_tokens": 8, "cache_read_input_tokens": 52000, "output_tokens": 410}},
                        "perTurnEffort": "medium", "uuid": str(uuid.uuid4()), "timestamp": stamp, "sessionId": sid, "cwd": cwd},
                       separators=(",", ":")) + "\n")
PY
# The sidebar learns its session at its next look (every ten seconds), then sees it end. It
# notices both only when it draws, and a window behind others draws only when asked to: each
# `herdr-app shot` here (to a file thrown away) is that ask, not a picture.
nudge() { herdr-app shot "$w/run/nudge.png" >/dev/null 2>&1 || :; rm -f "$w/run/nudge.png"; }
term=$(terminal_at "web / 2")
[ -n "$term" ] || { echo "agent-sidebar: no terminal at web / 2" >&2; exit 1; }
i=0
while [ $i -lt 8 ]; do sleep 2; nudge; i=$((i + 1)); done
herdr-app do terminal.kill --terminal "$term" >/dev/null
sleep 1; nudge; sleep 1; nudge
grep -q '"agent-sidebar.closed"' "$HERDR_APP_HOME/shared.json" 2>/dev/null || say "Recently closed may be empty: the sidebar didn't see that session end"

# ---------------------------------------------------------------- a hovered row

say "hover"
hover=$(terminal_at "web / 1")
[ -n "$hover" ] || { echo "agent-sidebar: no terminal at web / 1" >&2; exit 1; }
/usr/bin/python3 - "$mod/main.js" "$hover" <<'PY'
import sys
path, address = sys.argv[1:3]
s = open(path).read()
a = "    const hovered = this.hovered === row.address && row.available;\n"
b = "      .when(!on && !picked, el => el.hover(s => s.bg(t.hover)))\n"
if s.count(a) != 1 or s.count(b) != 1:
    sys.exit("agent-sidebar: main.js changed; the hovered row is left out")
s = s.replace(a, a.replace("this.hovered === row.address", f"(this.hovered === row.address || row.address === {address!r})"))
s = s.replace(b, b + "      .when(!on && !picked && hovered, el => el.bg(t.hover))\n")
open(path, "w").write(s)
PY
# Herdr reloads a mod whose files change; the next probe fills the reloaded copy in again.
sleep 12
say "done"
