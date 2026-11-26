#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HOME, RUNS, SCHEMAS, USER_CONFIG, config, norm, isDenied, codexCmd, agyCmd, git, gitRoot, worktreeRoot,
  newId, readJson, writeJson, runProcess, codexReview, geminiReview, agyRun, formatFindings, reviewableUntracked,
} from './lib.mjs';

const USAGE = `Commands:
  doctor
  codex-task  --repo <path> --task <task.md> [--base <ref>] [--effort high] [--timeout <min>] [--no-commit]
  gemini-task --task <task.md> [--repo <path>] [--edits] [--schema task|review|none] [--model <id>] [--attach a,b]
  review      --repo <path> [--agent codex|gemini|both] [--base <ref>] [--effort medium]
  finalize    --id <run id>
  runs        [--n 10]
  worktree-rm --id <run id>`;

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true; else { o[k] = next; i++; }
  }
  return o;
}

const die = (msg, code = 1) => { console.error(`orch: ${msg}`); process.exit(code); };
const print = (obj) => console.log(JSON.stringify(obj, null, 2));

const TASK_FOOTER = (wt, base) => `
---
Rules for this run, from the orchestrator (Claude):
- You work in an isolated git worktree at ${wt}, branched from ${base}. Edit only what the task needs.
- Do not commit, push, rebase or change git config. The orchestrator commits your changes after you finish.
- Do not open .env*, *.pem, *.key, credential or secret files.
- Run the checks the task names and report each one in checks_run, including failures.
- If something blocks you, stop and return status "blocked" with the reason instead of guessing.
- Your final message must be JSON matching the provided output schema.`;

function addWorktree(repo, branch, wt, base) {
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '-b', branch, wt, base]);
  const warnings = [];
  for (const d of config.worktrees.linkDirs) {
    const src = path.join(repo, d);
    if (fs.existsSync(src)) { if (!fs.existsSync(path.join(wt, d))) fs.symlinkSync(src, path.join(wt, d), 'junction'); }
    else if (d === 'node_modules' && fs.existsSync(path.join(repo, 'package.json'))) {
      warnings.push(`${repo} has no node_modules, so scripts that import packages will fail inside the worktree (Codex has no network). Install dependencies in the main checkout first.`);
    }
  }
  for (const w of warnings) console.error(`orch: warning: ${w}`);
  return warnings;
}

async function codexTask(o) {
  if (!o.repo || !o.task) die('codex-task needs --repo and --task');
  const repo = gitRoot(o.repo);
  if (!repo) die(`${o.repo} is not inside a git repository`);
  if (isDenied(repo)) die(`${repo} is on the denylist, refusing to send it to Codex`);
  const bin = codexCmd();
  const id = o.id || newId('cx');
  const baseSha = git(repo, ['rev-parse', o.base || 'HEAD']);
  const branch = `agent/codex/${id}`;
  const wt = norm(path.join(worktreeRoot(repo), `${path.basename(repo)}-${id}`));
  const warnings = addWorktree(repo, branch, wt, baseSha);

  const runDir = path.join(RUNS, id);
  fs.mkdirSync(runDir, { recursive: true });
  const task = fs.readFileSync(o.task, 'utf8');
  fs.writeFileSync(path.join(runDir, 'task.md'), task);
  const effort = o.effort || config.codex.taskEffort;
  const meta = { id, kind: 'codex-task', agent: 'codex', repo, worktree: wt, branch, base: baseSha, effort, warnings, started: new Date().toISOString(), status: 'running' };
  writeJson(path.join(runDir, 'run.json'), meta);
  console.error(`orch: ${id} started in ${wt} (branch ${branch})`);

  const resultFile = path.join(runDir, 'result.json');
  const args = [...bin.pre, 'exec', '-C', wt, '-s', 'workspace-write', '--output-schema', path.join(SCHEMAS, 'task-result.schema.json'),
    '-o', resultFile, '--json', '-c', `model_reasoning_effort="${effort}"`];
  if (config.codex.model) args.push('-m', config.codex.model);
  args.push('-');
  const r = await runProcess(bin.cmd, args, {
    cwd: wt, input: task + TASK_FOOTER(wt, baseSha),
    timeoutMs: Number(o.timeout || config.codex.taskTimeoutMin) * 60000,
    stdoutFile: path.join(runDir, 'events.jsonl'), stderrFile: path.join(runDir, 'stderr.log'),
  });
  meta.exitCode = r.code;
  meta.timedOut = r.timedOut;
  finalizeTask(meta, { noCommit: !!o['no-commit'], stderrTail: r.stderrTail });
}

// Also run on its own (`orch finalize --id`) to recover a run whose orchestrator died after the worker finished.
function finalizeTask(meta, { noCommit = false, stderrTail = '' } = {}) {
  const runDir = path.join(RUNS, meta.id);
  const wt = meta.worktree;
  const result = readJson(path.join(runDir, 'result.json'), null);

  let commit = null;
  if (git(wt, ['status', '--porcelain']) && !noCommit) {
    git(wt, ['add', '-A']);
    // A linked dependency dir that is not gitignored would otherwise be committed as a junction.
    for (const d of config.worktrees.linkDirs) {
      if (git(wt, ['diff', '--cached', '--name-only', '--', d], { allowFail: true })) git(wt, ['reset', '-q', '--', d]);
    }
    if (git(wt, ['diff', '--cached', '--name-only'], { allowFail: true })) {
      const summary = (result?.summary || `changes from the ${meta.agent} run`).trim();
      git(wt, ['commit', '-q', '-m', summary.split('\n')[0].slice(0, 72), ...(summary.includes('\n') || summary.length > 72 ? ['-m', summary] : [])]);
      commit = git(wt, ['rev-parse', 'HEAD']);
    }
  }
  const diffstat = git(wt, ['diff', '--stat', meta.base, ...(noCommit ? [] : ['HEAD'])], { allowFail: true });

  Object.assign(meta, {
    finished: meta.finished || new Date().toISOString(),
    status: meta.timedOut ? 'timeout' : meta.exitCode !== 0 && !result ? 'failed' : result?.status || 'done',
    commit: commit || meta.commit || null, diffstat,
  });
  writeJson(path.join(runDir, 'run.json'), meta);
  print({ ...meta, result, error: result ? null : stderrTail.slice(-800), runDir });
}

function finalize(o) {
  const meta = readJson(path.join(RUNS, String(o.id), 'run.json'));
  if (!meta?.worktree) die(`no task run ${o.id} with a worktree`);
  if (meta.exitCode === undefined) meta.exitCode = fs.existsSync(path.join(RUNS, meta.id, 'result.json')) ? 0 : 1;
  finalizeTask(meta);
}

async function review(o) {
  if (!o.repo) die('review needs --repo');
  const repo = gitRoot(o.repo);
  if (!repo) die(`${o.repo} is not inside a git repository`);
  if (isDenied(repo)) die(`${repo} is on the denylist`);
  const base = o.base ? git(repo, ['rev-parse', o.base]) : git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }) || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const untracked = reviewableUntracked(repo);
  const agent = o.agent || 'codex';
  const jobs = [];
  if (agent === 'codex' || agent === 'both') jobs.push(codexReview({ repo, base, untracked, effort: o.effort }).then((r) => ({ agent: 'codex', ...r })));
  if (agent === 'gemini' || agent === 'both') jobs.push(geminiReview({ repo, base, untracked, model: o.model }).then((r) => ({ agent: 'gemini', ...r })));
  if (!jobs.length) die(`unknown --agent ${agent} (codex|gemini|both)`);
  const results = await Promise.all(jobs);
  print(results.map(({ agent: a, id, runDir, result, error }) => ({ agent: a, id, runDir, error, ...result })));
  for (const r of results) if (r.result?.findings.length) console.error(`\n${r.agent}:\n${formatFindings(r.result.findings)}`);
  if (results.every((r) => r.error)) process.exit(1);
}

// Read-only by default; with --edits Gemini works in its own worktree and the result is committed
// like a codex-task. agy refuses every shell command in headless mode, so Claude runs the checks.
async function geminiTask(o) {
  if (!o.task) die('gemini-task needs --task');
  if (!agyCmd()) die('agy (Antigravity CLI) is not installed');
  const id = o.id || newId('gm');
  const runDir = path.join(RUNS, id);
  fs.mkdirSync(runDir, { recursive: true });
  const task = fs.readFileSync(o.task, 'utf8');
  fs.writeFileSync(path.join(runDir, 'task.md'), task);
  for (const f of typeof o.attach === 'string' ? o.attach.split(',').filter(Boolean) : []) fs.copyFileSync(f, path.join(runDir, path.basename(f)));
  let cwd = runDir;
  const meta = { id, kind: 'gemini-task', agent: 'gemini', started: new Date().toISOString(), status: 'running' };
  if (o.repo) {
    const repo = gitRoot(o.repo);
    if (!repo) die(`${o.repo} is not inside a git repository`);
    if (isDenied(repo)) die(`${repo} is on the denylist, refusing to send it to Gemini`);
    meta.repo = repo;
    cwd = repo;
    if (o.edits) {
      meta.base = git(repo, ['rev-parse', o.base || 'HEAD']);
      meta.branch = `agent/gemini/${id}`;
      meta.worktree = norm(path.join(worktreeRoot(repo), `${path.basename(repo)}-${id}`));
      meta.warnings = addWorktree(repo, meta.branch, meta.worktree, meta.base);
      cwd = meta.worktree;
    }
  }
  writeJson(path.join(runDir, 'run.json'), meta);
  const schema = o.schema === 'review' ? path.join(SCHEMAS, 'review.schema.json') : o.schema === 'none' ? null : path.join(SCHEMAS, 'task-result.schema.json');
  const footer = `\n---\nRules from the orchestrator (Claude): shell commands are refused in this mode and any attempt stops your run, so never run one, not even git or ls. Use your file tools only: read and list files${o.edits ? ', and edit files inside your worktree' : ''}. ${o.edits ? 'Edit only what the task needs; the orchestrator commits your changes and runs the checks.' : 'Do not modify any file.'} Do not open .env*, *.pem, *.key or credential files. List every check the task asks for in checks_run with passed=false and note "not run: no shell", Claude runs them.`;
  // Windows caps a command line near 32k characters, so long specs travel as a file.
  const prompt = task.length > 6000
    ? `Your task is in the file ${norm(path.join(runDir, 'task.md'))}. Read it in full first, plus any file it names in the same folder, then do it.${footer}`
    : task + footer;
  const res = await agyRun({
    prompt, cwd, runDir, model: o.model, schemaFile: schema, addDirs: [runDir],
    timeoutMin: Number(o.timeout || config.gemini.taskTimeoutMin), mode: o.edits ? 'accept-edits' : undefined,
  });
  if (res.result) writeJson(path.join(runDir, 'result.json'), res.result);
  else if (res.text) fs.writeFileSync(path.join(runDir, 'report.md'), res.text);
  Object.assign(meta, { conversationId: res.envelope?.conversation_id, usage: res.envelope?.usage, exitCode: res.error ? 1 : 0 });
  if (meta.worktree) return finalizeTask(meta, { stderrTail: res.error || '' });
  Object.assign(meta, { finished: new Date().toISOString(), status: res.error ? 'failed' : 'done' });
  writeJson(path.join(runDir, 'run.json'), meta);
  print({ ...meta, result: res.result, text: res.result ? undefined : res.text, error: res.error || null, runDir });
}

function runs(o) {
  const n = Number(o.n || 10);
  const list = fs.readdirSync(RUNS).map((d) => readJson(path.join(RUNS, d, 'run.json'))).filter(Boolean)
    .sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, n);
  print(list.map(({ id, kind, status, repo, branch, commit, started }) => ({ id, kind, status, repo, branch, commit, started })));
}

function worktreeRm(o) {
  const meta = readJson(path.join(RUNS, String(o.id), 'run.json'));
  if (!meta?.worktree) die(`no worktree recorded for ${o.id}`);
  for (const d of config.worktrees.linkDirs) {
    const p = path.join(meta.worktree, d);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
  }
  git(meta.repo, ['worktree', 'remove', meta.worktree]);
  console.log(`removed ${meta.worktree}; branch ${meta.branch} kept`);
}

function version(cmd, pre = []) {
  const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || r.stderr || '').trim();
}

function doctor() {
  const out = { home: HOME, userConfig: fs.existsSync(USER_CONFIG) ? USER_CONFIG : null };
  try { const c = codexCmd(); out.codex = { cmd: [c.cmd, ...c.pre].join(' '), version: version(c.cmd, c.pre) }; } catch (e) { out.codex = { error: e.message }; }
  out.git = version('git');
  out.node = process.version;
  const agy = agyCmd();
  out.gemini = agy ? { bin: agy, version: version(agy) } : { error: 'agy (Antigravity CLI) not installed; gemini review and tasks are off' };
  out.review = { enabled: config.review.enabled, agents: config.review.agents, maxRounds: config.review.maxRounds };
  out.denylist = config.denylist;
  print(out);
}

const o = parseArgs(process.argv.slice(2));
const table = { doctor, 'codex-task': codexTask, 'gemini-task': geminiTask, review, finalize, runs, 'worktree-rm': worktreeRm };
const cmd = o._[0];
if (!table[cmd]) die(`unknown command "${cmd || ''}"\n${USAGE}`);
await table[cmd](o);
