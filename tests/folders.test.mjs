import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCAN, LIST, parseScan, parseList, pathQuery, knownFolders, searchFolders, insideFolders, remember, placement, tilde, basename,
} from "../mods/agent-sidebar/folders.js";
import { newSessionAction } from "../mods/agent-sidebar/model.js";

const spaces = [
  { id: "s1", name: "api", machine: null, folder: "/Users/me/work/api", active: false, tabs: [{ id: "a1" }] },
  { id: "s2", name: "web", machine: null, folder: "", active: true, tabs: [{ id: "b1" }, { id: "b2" }] },
  { id: "w/s3", name: "train", machine: "w", folder: "/home/me/train", active: false, tabs: [{ id: "w/c1" }] },
];
const panes = [
  { pane: "p1", tab: "a1", cwd: "/Users/me/work/api/server" },
  { pane: "p2", tab: "b1", cwd: "/Users/me/work/web" },
  { pane: "p3", tab: "w/c1", cwd: "/home/me/train" },
];

test("a typed path names a folder to look in; anything else is a search", () => {
  assert.deepEqual(pathQuery("~"), { dir: "~", leaf: "" });
  assert.deepEqual(pathQuery("~/"), { dir: "~", leaf: "" });
  assert.deepEqual(pathQuery("~/work/a"), { dir: "~/work", leaf: "a" });
  assert.deepEqual(pathQuery("/"), { dir: "/", leaf: "" });
  assert.deepEqual(pathQuery("/us"), { dir: "/", leaf: "us" });
  assert.deepEqual(pathQuery("/Users/me/"), { dir: "/Users/me", leaf: "" });
  assert.equal(pathQuery("api"), null);
  assert.equal(pathQuery("~api"), null);
});

test("known folders: picked first, then the focused terminal's, the spaces', recent, home and projects, each once", () => {
  const out = knownFolders({
    machine: null, chosen: { path: "/tmp/picked", tag: "Picked" }, focused: { space: "s1", cwd: "/Users/me/work/api/server" },
    spaces, panes, recent: ["/Users/me/old", "/Users/me/work/web"], scanned: ["/Users/me/work/api", "/Users/me/work/new"], home: "/Users/me",
  });
  assert.deepEqual(out.map(f => [f.path, f.tag, f.group]), [
    ["/tmp/picked", "Picked", "open"],
    ["/Users/me/work/api/server", "Current", "open"],
    ["/Users/me/work/api", "api", "open"],
    ["/Users/me/work/web", "web", "open"],
    ["/Users/me", "web", "open"], // web's start folder is empty: its machine's home
    ["/Users/me/old", "Recent", "recent"],
    ["/Users/me/work/new", "", "projects"],
  ]);
  // Another machine's spaces and terminals stay out; an unknown home is "~".
  const remote = knownFolders({ machine: "w", focused: { space: "s1", cwd: "/x" }, spaces, panes });
  assert.deepEqual(remote.map(f => f.path), ["/home/me/train", "~"]);
});

test("search keeps every word, best names first; Inside lists a folder's folders", () => {
  const all = ["/Users/me/work/api", "/Users/me/work/web-api", "/Users/me/apis/x", "/Users/me/work/web"].map(path => ({ path, tag: "", group: "projects" }));
  assert.deepEqual(searchFolders(all, "api", "/Users/me").map(f => f.path), ["/Users/me/work/api", "/Users/me/work/web-api", "/Users/me/apis/x"]);
  assert.deepEqual(searchFolders(all, "work web", "/Users/me").map(f => f.path), ["/Users/me/work/web-api", "/Users/me/work/web"]);
  assert.equal(searchFolders(all, "  ", "/Users/me").length, 4);
  const listing = { dir: "/Users/me", names: ["Code", "code-old", "Desktop", ".config"] };
  assert.deepEqual(insideFolders(listing, "").map(f => [f.path, f.tag]),
    [["/Users/me", "This folder"], ["/Users/me/Code", ""], ["/Users/me/code-old", ""], ["/Users/me/Desktop", ""]]);
  assert.deepEqual(insideFolders(listing, "co").map(f => f.path), ["/Users/me/Code", "/Users/me/code-old"]);
  assert.deepEqual(insideFolders(listing, ".c").map(f => f.path), ["/Users/me/.config"]);
  assert.deepEqual(insideFolders({ dir: "/", names: ["usr"] }, "u").map(f => f.path), ["/usr"]);
  assert.deepEqual(insideFolders(null, ""), []);
});

test("paths show from the home folder; recent folders move to the front and stay few", () => {
  assert.equal(tilde("/Users/me", "/Users/me"), "~");
  assert.equal(tilde("/Users/me/work", "/Users/me"), "~/work");
  assert.equal(tilde("/Users/meow", "/Users/me"), "/Users/meow");
  assert.equal(tilde("/x", null), "/x");
  assert.equal(basename("/Users/me/work/"), "work");
  assert.equal(basename("/"), "/");
  assert.deepEqual(remember(["/a", "/b", "/c"], "/b"), ["/b", "/a", "/c"]);
  assert.equal(remember(Array.from({ length: 20 }, (_, i) => `/${i}`), "/new").length, 12);
});

test("a folder with a terminal in a space joins it as a tab, the focused space first; others get a new space", () => {
  const focused = { space: "s2" };
  assert.equal(placement("/Users/me/work/web", null, spaces, panes, focused).match.id, "s2");
  assert.equal(placement("/Users/me/work/api", null, spaces, panes, focused).match.id, "s1"); // its start folder
  const none = placement("/Users/me/elsewhere", null, spaces, panes, focused);
  assert.equal(none.match, null);
  assert.equal(none.fallback.id, "s2");
  assert.deepEqual(placement("/x", "nowhere", spaces, panes, focused), { match: null, fallback: null });
  assert.equal(placement("/home/me/train", "w", spaces, panes, focused).match.id, "w/s3");
});

test("new sessions start in the folder asked for, as a tab in the space asked for or in a new space", () => {
  const machines = [{ name: null, layout: "ready" }, { name: "w", layout: "ready" }];
  const claude = { name: "Claude Code", run: ["claude"] };
  assert.deepEqual(newSessionAction(null, machines, spaces, { space: "s2" }, claude, { folder: "/Users/me/work/api", space: "s1" }),
    { name: "tab.new", args: { name: "Claude Code", argv: ["claude"], folder: "/Users/me/work/api", space: "s1" } });
  assert.deepEqual(newSessionAction("w", machines, spaces, null, null, { folder: "/home/me/x", space: null }),
    { name: "space.new", args: { folder: "/home/me/x", machine: "w" } });
  // A space on another machine is never joined.
  assert.deepEqual(newSessionAction("w", machines, spaces, null, null, { folder: "/srv", space: "s1" }),
    { name: "space.new", args: { folder: "/srv", machine: "w" } });
  // Without a choice: the focused space there, as before.
  assert.deepEqual(newSessionAction(null, machines, spaces, { space: "s1" }), { name: "tab.new", args: { space: "s1" } });
});

const shells = [["/bin/sh"], ["/bin/dash"], ["/bin/bash", "--posix"], ["/bin/zsh", "--emulate", "sh"]].filter(([path]) => existsSync(path));
for (const [shell, ...flags] of shells) {
  test(`the scan and list scripts find projects and folders (${[shell, ...flags].join(" ")})`, t => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-sidebar-folders-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    for (const dir of ["workspace/api/.git", "workspace/group/web/.git", "workspace/group/notes", "src/tool", "Documents/x", ".hidden", "with space"]) {
      mkdirSync(join(home, dir), { recursive: true });
    }
    const env = { PATH: process.env.PATH, HOME: home };
    const sh = (script, ...args) => execFileSync(shell, [...flags, "-c", script, "sh", ...args], { encoding: "utf8", env });
    const scan = parseScan(sh(SCAN));
    assert.equal(scan.home, home);
    assert.deepEqual(scan.folders.sort(), [`${home}/src/tool`, `${home}/workspace/api`, `${home}/workspace/group`, `${home}/workspace/group/web`]);
    const list = parseList(sh(LIST, "~"));
    assert.equal(list.home, home);
    assert.equal(list.dir, home);
    assert.deepEqual(list.names, ["Documents", "src", "with space", "workspace", ".hidden"]);
    assert.deepEqual(parseList(sh(LIST, "~/workspace/group")).names, ["notes", "web"]);
    assert.deepEqual(parseList(sh(LIST, `${home}/with space`)).names, []);
    assert.throws(() => sh(LIST, "~/missing"), error => error.status === 3);
  });
}

test("scan answers are cleaned of repeats that differ only in case", () => {
  assert.deepEqual(parseScan("/h\n/h/Code/a\n/h/code/a\n\n/h/x/\n"), { home: "/h", folders: ["/h/Code/a", "/h/x"] });
  assert.deepEqual(parseScan(""), { home: null, folders: [] });
});
