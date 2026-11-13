#!/usr/bin/env node
// Benchmarks for the sidebar's two costs: building the list on every render, and the
// background probe that runs on each machine every few seconds.
//
//   node scripts/bench.mjs           synthetic data only
//   node scripts/bench.mjs --live    also probe this computer's real agents (needs hc)
//
// Synthetic agents are short-lived local processes with fake Claude Code files in a
// temporary folder. Nothing is written outside it, and every process is stopped at the end.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { build, groups } from "../mods/agent-sidebar/model.js";
import { PROBE, parseProbe, probeArgs, workOf } from "../mods/agent-sidebar/background.js";

const live = process.argv.includes("--live");
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn, runs) => {
  const xs = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); fn(); xs.push(performance.now() - start); }
  return median(xs);
};
const ms = value => `${value.toFixed(value < 1 ? 3 : 1).padStart(8)} ms`;

// --- The list: what render() computes before drawing ---------------------------------------
function terminals(n) {
  const machines = [null, "studio", "build"];
  const statuses = ["working", "idle", "done", "blocked", "idle", "idle"];
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    const machine = machines[i % machines.length];
    const address = machine ? `${machine}/t${i}` : `t${i}`;
    const agent = i % 5 !== 4;
    out.push({
      address, state: "live", status: agent ? statuses[i % statuses.length] : null,
      title: agent ? `Task number ${i}` : "", status_ms: now - i * 60000, created_ms: now - i * 90000,
      program: agent ? { name: "Claude", agent: true } : { name: "zsh", shell: true },
      foreground: { pid: 1000 + i, cwd: `/work/project-${i % 7}` },
      // Every seventh agent was started by the one before it.
      parent: agent && i % 7 === 6 ? (machine ? `${machine}/t${i - 3}` : `t${i - 3}`) : null,
      labels: {},
    });
  }
  return out;
}
console.log("List, per render (median)");
for (const n of [20, 100, 500]) {
  const list = terminals(n);
  const now = Date.now();
  const work = new Map(list.filter((_, i) => i % 3 === 0).map(t => [t.address, {
    at: now, session: { status: "shell" }, goal: { condition: "Ship it", check: "" },
    shells: [{ text: "npm test", started: now - 5000 }],
  }]));
  const machines = [{ name: null, layout: "ready" }, { name: "studio", layout: "ready" }, { name: "build", layout: "ready" }];
  const input = { terminals: list, machines, work, now };
  const once = () => groups(build(input), machines, "", "all");
  const search = () => groups(build(input), machines, "task 4", "all");
  console.log(`  ${String(n).padStart(3)} terminals   build+group ${ms(time(once, 200))}   with a search ${ms(time(search, 200))}`);
}

// --- Parsing a probe's output ------------------------------------------------------------
{
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`P ${2000 + i} ${i < 20 ? 1 : 2000 + (i % 20)} 01:00 /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1-x.sh && eval 'sleep ${i}' < /dev/null`);
  for (let i = 0; i < 20; i++) lines.push(`S ${2000 + i} {"pid":${2000 + i},"sessionId":"s${i}","status":"shell"}`, `L ${2000 + i} s${i}`, `Z s${i} 1000`);
  const text = lines.join("\n");
  const targets = Array.from({ length: 20 }, (_, i) => ({ address: `t${i}`, pid: String(2000 + i) }));
  console.log(`\nProbe output, 2000 processes: parse+attribute ${ms(time(() => workOf(targets, parseProbe(text)), 50))}`);
}

// --- The probe script with a real sh ---------------------------------------------------------
const children = [];
const home = mkdtempSync(join(tmpdir(), "agent-sidebar-bench-"));
const stop = () => {
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

function sh(args, env) {
  const start = performance.now();
  const out = execFileSync("sh", ["-c", PROBE, "sh", ...args], { encoding: "utf8", env, maxBuffer: 64 << 20 });
  return { out, ms: performance.now() - start };
}

async function synthetic(agents, megabytes) {
  const dir = join(home, `${agents}x${megabytes}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "projects", "-work"), { recursive: true });
  writeFileSync(join(dir, "agent.sh"), `/bin/sh -c ": ${dir}/shell-snapshots/snapshot-sh-1.sh && eval 'sleep 120' < /dev/null; :" & wait\n`);
  const line = `${JSON.stringify({ type: "assistant", message: { content: "x".repeat(900) } })}\n`;
  const body = line.repeat(Math.max(1, Math.round(megabytes * 1024 * 1024 / line.length)));
  const goal = `${JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "Ship it" } })}\n`;
  const targets = [];
  for (let i = 0; i < agents; i++) {
    const child = spawn("/bin/sh", [join(dir, "agent.sh")], { stdio: "ignore", detached: true });
    children.push(child);
    const id = `bench-${agents}-${i}`;
    // Busy, with sub-agents: one still working, two that handed back, as Claude Code writes them.
    writeFileSync(join(dir, "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id, cwd: "/work", status: "busy" }));
    writeFileSync(join(dir, "projects", "-work", `${id}.jsonl`), goal + body);
    const subs = join(dir, "projects", "-work", id, "subagents");
    mkdirSync(subs, { recursive: true });
    for (const [n, last] of [["1", "Read"], ["2", "SubagentHandback"], ["3", "SubagentHandback"]]) {
      const step = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: last }] } })}\n`;
      writeFileSync(join(subs, `agent-${i}x${n}.jsonl`), `${JSON.stringify({ type: "user", timestamp: new Date().toISOString() })}\n${line.repeat(200)}${step}`);
      writeFileSync(join(subs, `agent-${i}x${n}.meta.json`), JSON.stringify({ agentType: "Explore", description: `Task ${n}` }));
    }
    targets.push({ address: `t${i}`, pid: String(child.pid), log: join(dir, "projects", "-work", `${id}.jsonl`) });
  }
  await new Promise(resolve => setTimeout(resolve, 300)); // let each start its shell
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  // The first looks read transcripts in full, up to a budget a look.
  let read = new Map();
  let first, probe, looks = 0;
  do {
    const run = sh(probeArgs(targets, read), env);
    first ??= run;
    probe = parseProbe(run.out, Date.now(), read);
    read = probe.read;
    looks++;
  } while (targets.some(target => !read.has(basename(target.log, ".jsonl"))) && looks < 20);
  const work = workOf(targets, probe);
  const found = [...work.values()].filter(info => info.shells.length && info.goal && info.subagents.length === 1).length;
  const steady = [];
  for (let i = 0; i < 7; i++) {
    const run = sh(probeArgs(targets, read), env);
    read = parseProbe(run.out, Date.now(), read).read;
    steady.push(run.ms);
  }
  const grown = [];
  for (let i = 0; i < 7; i++) {
    for (const target of targets) appendFileSync(target.log, line);
    const run = sh(probeArgs(targets, read), env);
    read = parseProbe(run.out, Date.now(), read).read;
    grown.push(run.ms);
  }
  console.log(`  ${String(agents).padStart(2)} agents × ${String(megabytes).padStart(3)} MB   first ${ms(first.ms)}${looks > 1 ? ` (${looks} looks)` : ""}   unchanged ${ms(median(steady))}   all grew ${ms(median(grown))}   found ${found}/${agents}`);
  for (const target of targets) {
    const child = children.find(c => String(c.pid) === target.pid);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

console.log("\nProbe script, real sh (median of 7)");
console.log(`  this computer has ${execFileSync("sh", ["-c", "ps -A -o pid= | wc -l"], { encoding: "utf8" }).trim()} processes`);
for (const [agents, megabytes] of [[1, 1], [10, 1], [10, 50], [30, 5]]) await synthetic(agents, megabytes);

if (live) {
  // This computer's real agents, as Herdr knows them: their foreground processes.
  const list = JSON.parse(execFileSync("hc", ["ls", "--json"], { encoding: "utf8" })).terminals
    .filter(t => !t.address.includes("/") && t.status);
  const targets = list.map(t => {
    const info = JSON.parse(execFileSync("hc", ["get", t.address, "--json"], { encoding: "utf8" }));
    return { address: t.address, pid: String(info.foreground?.pid ?? "") };
  }).filter(t => /^\d+$/.test(t.pid));
  const first = sh(probeArgs(targets), process.env);
  let read = parseProbe(first.out).read;
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const run = sh(probeArgs(targets, read), process.env);
    read = parseProbe(run.out, Date.now(), read).read;
    runs.push(run.ms);
  }
  const work = workOf(targets, parseProbe(first.out));
  console.log(`\nLive, this computer: ${targets.length} agents, ${[...read.values()].length} transcripts`);
  console.log(`  first ${ms(first.ms)}   then ${ms(median(runs))}   background work on ${[...work.values()].filter(w => w.shells.length || w.goal || w.session?.status !== "idle").length}`);
}
