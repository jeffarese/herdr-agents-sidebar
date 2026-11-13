// The installer against a temporary app home and a stand-in herdr-app that records what it is
// asked. Skipped where there is no python3.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const python = spawnSync("python3", ["--version"]).status === 0;
const installer = new URL("../scripts/install.py", import.meta.url).pathname;
const MOD = "agent-sidebar";

// What `herdr-app` does here: check, status, layout.clone and layout.switch.
const FAKE = `#!/bin/sh
state="$HERDR_APP_HOME/fake"
case "$1" in
  check)
    if [ -f "$state/fail-check" ] && [ "$2" = "$HERDR_APP_HOME/mods/${MOD}" ]; then echo "bad mod" >&2; exit 1; fi
    echo "check passed: $2" ;;
  status) printf '{"layout":"%s","errors":[]}\\n' "$(cat "$state/shown")" ;;
  do)
    echo "$2 $4 $6" >> "$state/commands"
    case "$2" in
      layout.clone) python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); d["cloned_from"] = {"name": sys.argv[3], "version": "0.1.15"}; json.dump(d, open(sys.argv[2], "w"))' \\
        "$HERDR_APP_HOME/layouts/$4.json" "$HERDR_APP_HOME/layouts/$6.json" "$4" ;;
      layout.switch) echo "$4" > "$state/shown" ;;
    esac ;;
esac
`;

const block = (id, mod, extra = {}) => ({ id, type: "block", content: { mod }, ...extra });
const main = () => ({
  id: "root", type: "row", children: [
    { id: "sidebar", type: "column", children: [
      block("brand", "workspace-chrome"),
      { id: "sidebar-lists", type: "column", children: [block("spaces", "spaces"), block("agents", "agents"), block("team", "team-board")] },
      block("sidebar-footer", "workspace-chrome", { content: { mod: "workspace-chrome", props: { footer: true } } }),
    ] },
    { id: "work", type: "column", children: [block("tabs", "tabs")] },
    block("outside", "outside"),
  ],
});

function setup(t, shown = "main") {
  const home = mkdtempSync(join(tmpdir(), "agent-sidebar-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  for (const dir of ["bin", "fake", "layouts", "mods"]) mkdirSync(join(home, dir));
  writeFileSync(join(bin, "herdr-app"), FAKE);
  chmodSync(join(bin, "herdr-app"), 0o755);
  writeFileSync(join(home, "installed.json"), JSON.stringify({ "layout:main": {}, "layout:terminals": {}, spaces: {} }));
  writeFileSync(join(home, "layouts", "main.json"), JSON.stringify(main()));
  writeFileSync(join(home, "layouts", "terminals.json"), JSON.stringify({ id: "root", type: "column", children: [block("tabs", "terminals-bar")] }));
  writeFileSync(join(home, "fake", "shown"), shown);
  const env = { ...process.env, HERDR_APP_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = (...args) => spawnSync("python3", [installer, ...args], { env, encoding: "utf8" });
  const read = name => JSON.parse(readFileSync(join(home, "layouts", `${name}.json`), "utf8"));
  const shownNow = () => readFileSync(join(home, "fake", "shown"), "utf8").trim();
  const mods = (...path) => join(home, "mods", MOD, ...path);
  const ids = layout => { const out = []; const walk = n => { out.push(n.id); (n.children ?? []).forEach(walk); }; walk(layout); return out; };
  return { home, run, read, shown: shownNow, mods, ids };
}

test("from Herdr's main layout: a copy gets the sidebar in place of Spaces and Agents, and is shown", { skip: !python }, t => {
  const h = setup(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Herdr shows main-agents with the Sessions sidebar/);
  const layout = h.read("main-agents");
  assert.deepEqual(h.ids(layout), ["root", "sidebar", "brand", "sidebar-lists", "sessions", "team", "work", "tabs"]);
  assert.equal(layout.preview, "layouts/main-agents.svg");
  assert.ok(existsSync(join(h.home, "layouts", "main-agents.svg")));
  assert.deepEqual(h.read("main"), main()); // Herdr's own is untouched
  assert.equal(h.shown(), "main-agents");
  assert.ok(existsSync(h.mods("main.js")) && existsSync(h.mods("background.js")));
  // Again, as an update: nothing new in the layout, no backup of a copy it made.
  assert.equal(h.run().status, 0);
  assert.deepEqual(h.read("main-agents"), layout);
  assert.equal(readdirSync(join(h.home, "layouts")).some(f => f.endsWith(".before-agents")), false);
});

test("an update replaces the mod's files, drops ones it no longer has, and keeps Herdr's", { skip: !python }, t => {
  const h = setup(t);
  assert.equal(h.run().status, 0);
  writeFileSync(h.mods("old-module.js"), "export {};\n");
  writeFileSync(h.mods("gpui-kit.d.ts"), "// Herdr's\n");
  writeFileSync(h.mods("main.js"), "// stale\n");
  assert.equal(h.run().status, 0);
  assert.equal(existsSync(h.mods("old-module.js")), false);
  assert.ok(existsSync(h.mods("gpui-kit.d.ts")));
  assert.notEqual(readFileSync(h.mods("main.js"), "utf8"), "// stale\n");
});

test("an installed copy that fails Herdr's check is put back as it was", { skip: !python }, t => {
  const h = setup(t);
  assert.equal(h.run().status, 0);
  writeFileSync(h.mods("main.js"), "// the working version\n");
  writeFileSync(join(h.home, "fake", "fail-check"), "");
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stopped: herdr-app check .* failed: bad mod/);
  assert.equal(readFileSync(h.mods("main.js"), "utf8"), "// the working version\n");
  // A first install that fails leaves nothing behind.
  rmSync(h.mods(), { recursive: true });
  assert.notEqual(h.run().status, 0);
  assert.equal(existsSync(h.mods()), false);
});

test("a personal layout is backed up once and changed in place; one without sidebar lists is left alone", { skip: !python }, t => {
  const h = setup(t, "mine");
  const mine = main();
  mine.children[0].children[1].children = [block("agents", "agents")];
  writeFileSync(join(h.home, "layouts", "mine.json"), JSON.stringify(mine));
  assert.equal(h.run().status, 0);
  assert.deepEqual(h.ids(h.read("mine")), ["root", "sidebar", "brand", "sidebar-lists", "sessions", "work", "tabs"]);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, "layouts", "mine.json.before-agents"), "utf8")), mine);
  assert.equal(h.read("mine").preview, undefined);
  // A sidebar with no children, and no lists: a clear message, nothing changed.
  writeFileSync(join(h.home, "layouts", "bare.json"), JSON.stringify({ id: "root", children: [{ id: "sidebar" }] }));
  writeFileSync(join(h.home, "fake", "shown"), "bare");
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stopped: this layout has no sidebar lists to replace/);
  assert.deepEqual(h.read("bare"), { id: "root", children: [{ id: "sidebar" }] });
});

test("from a layout of Herdr's with no sidebar, it says it uses a copy of main", { skip: !python }, t => {
  const h = setup(t, "terminals");
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^terminals has no sidebar, so this uses a copy of main\. Herdr shows main-agents/);
  assert.equal(existsSync(join(h.home, "layouts", "terminals-agents.json")), false);
});

test("--remove puts back what it changed and deletes the mod", { skip: !python }, t => {
  const h = setup(t);
  assert.equal(h.run().status, 0);
  const mine = main();
  writeFileSync(join(h.home, "layouts", "mine.json"), JSON.stringify(mine));
  writeFileSync(join(h.home, "fake", "shown"), "mine");
  assert.equal(h.run().status, 0);
  // Changed outside the installer, with no backup: only the block comes out.
  const other = main();
  other.children[0].children[1].children.unshift(block("sessions", MOD));
  writeFileSync(join(h.home, "layouts", "other.json"), JSON.stringify(other));
  writeFileSync(join(h.home, "fake", "shown"), "main-agents");
  const result = h.run("--remove");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deleted main-agents, the copy of main it made; put back mine as it was before; took the sidebar out of other; deleted the mod/);
  assert.equal(h.shown(), "main"); // switched away before the copy went
  assert.deepEqual(h.read("mine"), mine);
  assert.equal(existsSync(join(h.home, "layouts", "mine.json.before-agents")), false);
  assert.equal(existsSync(join(h.home, "layouts", "main-agents.json")), false);
  assert.equal(existsSync(join(h.home, "layouts", "main-agents.svg")), false);
  assert.deepEqual(h.ids(h.read("other")), h.ids(main()));
  assert.equal(existsSync(h.mods()), false);
  assert.match(h.run("--remove").stdout, /isn't installed/);
});

test("an update while the copy is shown never backs the copy up, so --remove still deletes it", { skip: !python }, t => {
  const h = setup(t);
  assert.equal(h.run().status, 0);
  // Shown now, and changed where the installer changes things: the footer is back.
  const copy = h.read("main-agents");
  copy.children[0].children.push(block("sidebar-footer", "workspace-chrome"));
  writeFileSync(join(h.home, "layouts", "main-agents.json"), JSON.stringify(copy));
  assert.equal(h.run().status, 0);
  assert.equal(existsSync(join(h.home, "layouts", "main-agents.json.before-agents")), false);
  const result = h.run("--remove");
  assert.match(result.stdout, /deleted main-agents, the copy of main it made/);
  assert.equal(existsSync(join(h.home, "layouts", "main-agents.json")), false);
  assert.equal(h.shown(), "main");
});

test("--remove keeps what changed in a layout since the install, and puts back what the sidebar replaced", { skip: !python }, t => {
  const h = setup(t, "mine");
  writeFileSync(join(h.home, "layouts", "mine.json"), JSON.stringify(main()));
  assert.equal(h.run().status, 0);
  const mine = h.read("mine");
  mine.children[1].children.push(block("notes", "notes")); // added since
  writeFileSync(join(h.home, "layouts", "mine.json"), JSON.stringify(mine));
  // And one where the sidebar went in by hand, in place of Herdr's lists, with no backup.
  const other = main();
  other.children[0].children[1].children = [block("sessions", MOD), block("team", "team-board")];
  writeFileSync(join(h.home, "layouts", "other.json"), JSON.stringify(other));
  const result = h.run("--remove");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /took the sidebar out of mine, kept what changed there since, and left the backup as mine\.json\.before-agents; took the sidebar out of other;/);
  assert.deepEqual(h.ids(h.read("mine")), ["root", "sidebar", "brand", "sidebar-lists", "spaces", "agents", "team", "sidebar-footer", "work", "tabs", "notes", "outside"]);
  assert.ok(existsSync(join(h.home, "layouts", "mine.json.before-agents")));
  assert.deepEqual(h.ids(h.read("other")), ["root", "sidebar", "brand", "sidebar-lists", "spaces", "agents", "team", "sidebar-footer", "work", "tabs", "outside"]);
});

test("a mod folder of the same name that isn't this one is never touched", { skip: !python }, t => {
  const h = setup(t);
  mkdirSync(h.mods(), { recursive: true });
  writeFileSync(h.mods("mod.json"), JSON.stringify({ title: "Something else" }));
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isn't this mod. Nothing was changed/);
  assert.equal(execFileSync("ls", [h.mods()], { encoding: "utf8" }).trim(), "mod.json");
  assert.match(h.run("--remove").stderr, /isn't this mod, so it stays/);
});
