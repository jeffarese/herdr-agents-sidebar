import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE, elapsed, shellCommand, goalOf, parseProbe, probeArgs, workOf, probeTargets, signature } from "../mods/agent-sidebar/background.js";

// As ps prints a background command Claude Code started (captured from Claude Code 2.1.323).
const snapshot = command => `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1794566139050-qx5w1i.sh 2>/dev/null || true && \\builtin setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-151a-cwd`;
const goal = fields => JSON.stringify({ parentUuid: "a", isSidechain: false, type: "attachment", attachment: { type: "goal_status", ...fields } });
// Records of a sub-agent's transcript, as Claude Code 2.1.323 writes them.
const prompt = (text, timestamp) => JSON.stringify({ parentUuid: null, isSidechain: true, agentId: "x", type: "user", message: { role: "user", content: text }, timestamp });
const call = (name, stop = "tool_use") => JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: stop, content: [{ type: "tool_use", id: "toolu_1", name, input: {} }] } });
const result = (text, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] }, ...extra });

test("ps elapsed times read as seconds", () => {
  assert.deepEqual(["00:07", "16:02", "22:19:53", "3-01:00:00", "", "junk"].map(elapsed), [7, 962, 80393, 262800, 0, 0]);
});

test("the command Claude Code runs is unquoted from its eval word", () => {
  assert.equal(shellCommand(snapshot("npm test")), "npm test");
  assert.equal(shellCommand(snapshot("sleep 120 && echo 'it'\"'\"'s done'")), "sleep 120 && echo 'it'\"'\"'s done'");
  assert.equal(shellCommand(snapshot("printf 'a\n  b'")), "printf 'a b'");
  // As macOS's ps prints a newline.
  assert.equal(shellCommand(snapshot("npm run build\\012npm test")), "npm run build npm test");
  assert.equal(shellCommand("node   server.js"), "node server.js");
});

test("the last goal record decides, as Claude Code restores it", () => {
  assert.deepEqual(goalOf(goal({ met: false, sentinel: true, condition: " Ship the API " })), { condition: "Ship the API", check: "" });
  assert.deepEqual(goalOf(goal({ met: false, condition: "Ship", reason: "Tests still fail" })), { condition: "Ship", check: "Tests still fail" });
  // Met, failed, and cleared ("/goal clear" writes a met sentinel).
  for (const fields of [{ met: true, condition: "Ship", iterations: 2 }, { met: false, failed: true, condition: "Ship" }, { met: true, sentinel: true, condition: "Ship" }]) {
    assert.equal(goalOf(goal(fields)), null);
  }
  // A line cut short or still being written says nothing either way.
  assert.equal(goalOf(""), undefined);
  assert.equal(goalOf("{\"attachment\":{\"type\":\"goal_st"), undefined);
  assert.equal(goalOf(`ype":"goal_status","met":false,"condition":"Ship"}}`), undefined);
});

test("transcripts are read once in full, then only from where the last read stopped", () => {
  const first = parseProbe(`L 10 s1\nL 11 s2\nZ s1 500\nZ s2 900\nG s1 *\nG s2 *\nG s1 * ${goal({ met: false, sentinel: true, condition: "Ship" })}\n`);
  assert.deepEqual(first.goals.get("s1"), { condition: "Ship", check: "" });
  assert.equal(first.goals.get("s2"), null);
  assert.deepEqual(probeArgs([{ pid: 10 }, { pid: "x;rm" }], first.read), ["10", "s1=500", "s2=900"]);
  // Unchanged, and grown with no new goal record: the earlier answer stands.
  const second = parseProbe("L 10 s1\nL 11 s2\nZ s1 500\nZ s2 950\n", Date.now(), first.read);
  assert.deepEqual(second.goals.get("s1"), { condition: "Ship", check: "" });
  assert.equal(second.goals.get("s2"), null);
  // A record that can't be read changes nothing; a newer one wins; a met one ends the goal.
  const third = parseProbe(`Z s1 800\nZ s2 990\nG s1 + {"attachment":{"type":"goal_st\nG s2 + ${goal({ met: false, sentinel: true, condition: "Port" })}`, Date.now(), second.read);
  assert.deepEqual(third.goals.get("s1"), { condition: "Ship", check: "" });
  assert.equal(third.goals.get("s2").condition, "Port");
  const fourth = parseProbe(`Z s1 900\nZ s2 990\nG s1 + ${goal({ met: true, condition: "Ship" })}`, Date.now(), third.read);
  assert.equal(fourth.goals.get("s1"), null);
  assert.equal(fourth.goals.get("s2").condition, "Port");
  // Each transcript's project folder is sent back, so it isn't searched for again; only
  // a plain folder name is.
  const placed = parseProbe("L 10 s1 -Users-me-app\nL 11 s2 ..\nZ s1 500\nZ s2 900\n", Date.now(), first.read);
  assert.deepEqual(probeArgs([], placed.read), ["s1=500@-Users-me-app", "s2=900"]);
  // Read in full again (it shrank) and no record left: no goal. Gone files are forgotten.
  const fifth = parseProbe("Z s2 100\nG s2 *\n", Date.now(), fourth.read);
  assert.equal(fifth.goals.get("s2"), null);
  assert.deepEqual([...fifth.read.keys()], ["s2"]);
});

test("running sub-agents are listed by session; finished ones and quiet ones are not", () => {
  const meta = JSON.stringify({ agentType: "general-high", description: "Review  the\nrepo", requestShape: "background" });
  const first = parseProbe([
    "T s1 a1 5000", "T s1 a2 900", "T s2 a3 100",
    `M a1 ${meta}`, "M a2 {broken",
    "A a1 run", "A a2 done", "A a3 run",
    "B a1 2026-11-13T11:14:14.969Z", "B a3 not-a-date",
  ].join("\n"), Date.parse("2026-11-13T11:20:00Z"));
  assert.deepEqual(first.subagents.get("s1"), [{ id: "a1", type: "general-high", description: "Review the repo", background: true, started: Date.parse("2026-11-13T11:14:14.969Z") }]);
  assert.deepEqual(first.subagents.get("s2"), [{ id: "a3", type: "", description: "", background: false, started: Date.parse("2026-11-13T11:20:00Z") }]);
  assert.deepEqual(probeArgs([], first.read), ["a1=5000", "a2=900", "a3=100"]);
  // Unchanged files keep what was read; a changed one gets a new state; unlisted ones go.
  const second = parseProbe("T s1 a1 5000\nT s1 a2 1200\nA a2 run\n", Date.parse("2026-11-13T11:21:00Z"), first.read);
  assert.deepEqual(second.subagents.get("s1").map(sub => [sub.id, sub.description]), [["a1", "Review the repo"], ["a2", ""]]);
  assert.equal(second.subagents.has("s2"), false);
  assert.equal(second.read.has("a3"), false);
});

test("a wrapper's Claude Code session is found, and only its background shells count", () => {
  const now = 1_000_000;
  const probe = parseProbe([
    "P   900     1   1:00:00 agp",                  // the terminal's foreground: a wrapper
    "P   901   900   1:00:00 claude --session-id 5", // Claude Code under it
    `P   902   901     04:00 ${snapshot("npm test")}`,
    "P   903   902     04:00 node test.js",          // that command's own child
    `P   904   903     01:00 ${snapshot("nested")}`, // a shell inside it is the same task
    "P   905   901   1:00:00 node mcp-server.js",    // an MCP server is not background work
    `P   906   901     00:30 ${snapshot("sleep 300")}`,
    "P   950     1     10:00 claude",                // another terminal's agent, no session file
    `S 901 ${JSON.stringify({ pid: 901, sessionId: "5", status: "busy" })}`,
    "S 999 {not json",
    "L 901 5", "Z 5 10", "G 5 *",
    "T 5 a1 10", "A a1 run",
    "",
  ].join("\n"), now);
  const work = workOf([{ address: "t1", pid: "900" }, { address: "t2", pid: 950 }, { address: "t3", pid: 4242 }], probe);
  assert.deepEqual(work.get("t1").session, { status: "busy" });
  assert.deepEqual(work.get("t1").shells, [{ text: "npm test", started: now - 240000 }, { text: "sleep 300", started: now - 30000 }]);
  assert.deepEqual(work.get("t1").subagents.map(sub => sub.id), ["a1"]);
  assert.deepEqual(work.get("t2"), { at: now, session: null, goal: null, shells: [], subagents: [] });
  assert.equal(work.has("t3"), false); // its process is gone
  // A reading's signature ignores times.
  assert.equal(signature(work), signature(workOf([{ address: "t1", pid: 900 }, { address: "t2", pid: 950 }], parseProbe("P 900 1 00:01 agp\nP 950 1 00:01 claude\nP 901 900 00:01 claude\n" +
    `P 902 901 00:09 ${snapshot("npm test")}\nP 906 901 00:01 ${snapshot("sleep 300")}\nS 901 {"status":"busy"}\nL 901 5\nZ 5 10\nT 5 a1 10\nA a1 run`))));
});

test("only available agents with a numeric process are probed, grouped by machine", () => {
  const rows = [
    { address: "t1", machine: null, kind: "agent", available: true, pid: 10 },
    { address: "work/t1", machine: "work", kind: "agent", available: true, pid: "20" },
    { address: "t2", machine: null, kind: "shell", available: true, pid: 30 },
    { address: "t3", machine: null, kind: "agent", available: false, pid: 40 },
    { address: "t4", machine: null, kind: "agent", available: true, pid: null },
  ];
  assert.deepEqual([...probeTargets(rows)], [[null, [{ address: "t1", pid: "10" }]], ["work", [{ address: "work/t1", pid: "20" }]]]);
});

// The probe script itself, in every POSIX shell this machine has.
// zsh only as sh, which is how it runs when it is a system's /bin/sh.
const shells = [["/bin/sh"], ["/bin/dash"], ["/bin/bash", "--posix"], ["/bin/zsh", "--emulate", "sh"]].filter(([path]) => existsSync(path));
for (const [shell, ...flags] of shells) {
  test(`the probe script reads sessions, shells, goals and sub-agents (${[shell, ...flags].join(" ")})`, async t => {
    const home = mkdtempSync(join(tmpdir(), "agent-sidebar-"));
    // A stand-in for Claude Code: a process whose child is a snapshot shell running a command.
    writeFileSync(join(home, "agent.sh"), `/bin/sh -c ": ${home}/shell-snapshots/snapshot-sh-1.sh && eval 'sleep 30' < /dev/null; :" & wait\n`);
    const agent = spawn("/bin/sh", [join(home, "agent.sh")], { stdio: "ignore", detached: true });
    t.after(() => { try { process.kill(-agent.pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
    const project = join(home, "projects", "-work-app");
    const subagents = join(project, "abc-123", "subagents");
    mkdirSync(join(home, "sessions"));
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(home, "sessions", `${agent.pid}.json`), JSON.stringify({ pid: agent.pid, sessionId: "abc-123", status: "busy" }));
    // The goal record sits where the next read's look-back will cut into it, 20 bytes in,
    // before its "attachment" key: the cut line still holds the text grep looks for.
    const log = join(project, "abc-123.jsonl");
    const record = goal({ met: false, sentinel: true, condition: "Ship it" });
    const pad = n => `${JSON.stringify({ type: "user", text: "x".repeat(n - 25) })}\n`; // n + 1 bytes
    writeFileSync(log, `${pad(9000)}${record}\n${pad(4096 + 20 - record.length - 2)}`);
    // One sub-agent still working, one that handed its report back.
    writeFileSync(join(subagents, "agent-a1.jsonl"), [prompt("Review the repo", "2026-11-13T11:14:14.969Z"), call("Read"), result("ok"), ""].join("\n"));
    writeFileSync(join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-high", description: "Review the repo", requestShape: "background" }));
    writeFileSync(join(subagents, "agent-a2.jsonl"), [prompt("Find it", "2026-11-13T11:00:00.000Z"), call("SubagentHandback"), result("{\"success\":true}"), ""].join("\n"));
    writeFileSync(join(subagents, "agent-a2.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find it" }));
    // A report longer than the 64 KB read: its answer, which ends the turn, says it is done.
    const report = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "SubagentHandback", input: { report: "y".repeat(70000) } }] } });
    writeFileSync(join(subagents, "agent-a3.jsonl"), [prompt("Write it up", "2026-11-13T11:01:00.000Z"), report, result("{\"success\":true}", { toolEndsTurn: true }), ""].join("\n"));
    // Stopped by the user.
    writeFileSync(join(subagents, "agent-a4.jsonl"), [prompt("Look around", "2026-11-13T11:02:00.000Z"), call("Read"), JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }), ""].join("\n"));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
    const run = (read = new Map()) => parseProbe(execFileSync(shell, [...flags, "-c", PROBE, "sh", ...probeArgs([{ pid: agent.pid }], read)], { encoding: "utf8", env }), Date.now(), read);
    let probe;
    for (let i = 0; i < 40; i++) {
      probe = run();
      if (workOf([{ address: "t1", pid: agent.pid }], probe).get("t1")?.shells.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const work = workOf([{ address: "t1", pid: agent.pid }], probe).get("t1");
    assert.deepEqual(work.session, { status: "busy" });
    assert.deepEqual(work.shells.map(shell => shell.text), ["sleep 30"]);
    assert.deepEqual(work.goal, { condition: "Ship it", check: "" });
    assert.deepEqual(work.subagents, [{ id: "a1", type: "general-high", description: "Review the repo", background: true, started: Date.parse("2026-11-13T11:14:14.969Z") }]);
    // The same session open in a second process (resumed twice): read once, listed once.
    const child = [...probe.procs.values()].find(proc => proc.parent === String(agent.pid));
    writeFileSync(join(home, "sessions", `${child.pid}.json`), JSON.stringify({ pid: Number(child.pid), sessionId: "abc-123", status: "busy" }));
    const twice = execFileSync(shell, [...flags, "-c", PROBE, "sh", ...probeArgs([{ pid: agent.pid }])], { encoding: "utf8", env });
    assert.equal(twice.split("\n").filter(line => line.startsWith("Z abc-123 ")).length, 1);
    assert.equal(twice.split("\n").filter(line => line.startsWith("T abc-123 a1 ")).length, 1);
    rmSync(join(home, "sessions", `${child.pid}.json`));
    // Grown a little: the look-back starts inside the goal record. The cut line is skipped,
    // and the goal stays.
    appendFileSync(log, pad(200));
    assert.ok(probeArgs([], probe.read).includes(`abc-123=${probe.read.get("abc-123").bytes}@-work-app`));
    const grown = run(probe.read);
    assert.deepEqual(grown.goals.get("abc-123"), { condition: "Ship it", check: "" });
    // "/goal clear" appends a met sentinel, found in the new bytes. The sub-agent finishes.
    appendFileSync(log, `${goal({ met: true, sentinel: true, condition: "Ship it" })}\n`);
    appendFileSync(join(subagents, "agent-a1.jsonl"), `${call("SubagentHandback")}\n`);
    const cleared = run(grown.read);
    assert.equal(cleared.goals.get("abc-123"), null);
    assert.ok(cleared.read.get("abc-123").bytes > grown.read.get("abc-123").bytes);
    assert.deepEqual(cleared.subagents.get("abc-123"), []);
    // Idle: sub-agents are not looked for at all.
    writeFileSync(join(home, "sessions", `${agent.pid}.json`), JSON.stringify({ pid: agent.pid, sessionId: "abc-123", status: "idle" }));
    assert.equal(run(cleared.read).subagents.size, 0);
  });
}

// What a transcript gains while it is read is left for the next look, never skipped. A
// stand-in tail appends to the transcript just before it runs.
test("a transcript that grows while it is read loses no goal record", { skip: !existsSync("/bin/sh") }, t => {
  const home = mkdtempSync(join(tmpdir(), "agent-sidebar-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "projects", "-work-app");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, "sessions"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "abc-123", status: "idle" }));
  const log = join(project, "abc-123.jsonl");
  writeFileSync(log, "");
  const tail = join(home, "bin", "tail");
  writeFileSync(tail, `#!/bin/sh\n[ -f "${home}/grow" ] && cat "${home}/grow" >> "${log}"\nexec ${execFileSync("/bin/sh", ["-c", "command -v tail"], { encoding: "utf8" }).trim()} "$@"\n`);
  chmodSync(tail, 0o755);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
  const run = read => parseProbe(execFileSync("/bin/sh", ["-c", PROBE, "sh", ...probeArgs([{ pid: process.pid }], read)], { encoding: "utf8", env }), Date.now(), read);
  // Empty at the first look; then a goal as its very first line, read from the start.
  let probe = run(new Map());
  assert.equal(probe.read.get("abc-123").bytes, 0);
  appendFileSync(log, `${goal({ met: false, condition: "Ship it", reason: "Not yet" })}\n`);
  probe = run(probe.read);
  assert.deepEqual(probe.goals.get("abc-123"), { condition: "Ship it", check: "Not yet" });
  // "/goal clear", then 10 KB more arrives between the size check and the read.
  appendFileSync(log, `${goal({ met: true, sentinel: true, condition: "Ship it" })}\n${JSON.stringify({ type: "user", text: "x".repeat(8000) })}\n`);
  writeFileSync(join(home, "grow"), `${JSON.stringify({ type: "user", text: "z".repeat(10000) })}\n`);
  probe = run(probe.read);
  assert.equal(probe.goals.get("abc-123"), null);
  rmSync(join(home, "grow"));
  assert.equal(run(probe.read).goals.get("abc-123"), null);
});
