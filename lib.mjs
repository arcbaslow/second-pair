import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.ORCH_HOME || path.join(os.homedir(), '.claude', 'second-pair');
export const STATE = path.join(HOME, 'state');
export const RUNS = path.join(HOME, 'runs');
export const SCHEMAS = path.join(ROOT, 'schemas');
export const USER_CONFIG = path.join(HOME, 'config.json');
for (const d of [STATE, RUNS]) fs.mkdirSync(d, { recursive: true });

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

function userConfig() {
  if (!fs.existsSync(USER_CONFIG)) return {};
  // A typo must not silently drop the user's denylist and send everything to the workers.
  try { return JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8')); } catch (e) { throw new Error(`${USER_CONFIG} is not valid JSON: ${e.message}`); }
}

export const config = merge(readJson(path.join(ROOT, 'config.default.json'), {}), userConfig());

export const norm = (p) => path.resolve(p).replace(/\\/g, '/');

export function isDenied(p) {
  const s = norm(p).toLowerCase();
  return config.denylist.some((d) => s.includes(d.toLowerCase()));
}

export function worktreeRoot(repo) {
  return norm(config.worktrees.root || path.join(path.dirname(repo), '.worktrees'));
}

function onPath(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

// A command to spawn without a shell: { cmd, pre } where pre are leading args.
// npm installs codex on Windows as shims (an extensionless sh script and codex.cmd) that cannot be
// spawned without a shell, so a shim is resolved to the package's JS entry and run with this Node.
function resolveCmd(file) {
  if (process.platform !== 'win32' || /\.exe$/i.test(file)) return { cmd: file, pre: [] };
  const js = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(js) ? { cmd: process.execPath, pre: [js] } : null;
}

export function codexCmd() {
  const tried = [process.env.CODEX_BIN, config.codex.bin].filter(Boolean);
  for (const c of tried) if (fs.existsSync(c)) { const r = resolveCmd(c); if (r) return r; }
  for (const c of onPath('codex')) { const r = resolveCmd(c); if (r) return r; }
  // The Codex desktop app on Windows keeps its CLI in a hash-named folder that changes on update.
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (process.env.LOCALAPPDATA && fs.existsSync(base)) {
    const found = fs.readdirSync(base).map((d) => path.join(base, d, 'codex.exe')).filter((e) => fs.existsSync(e))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return { cmd: found[0], pre: [] };
  }
  throw new Error('codex not found: install the Codex CLI or set CODEX_BIN');
}

export function agyCmd() {
  for (const c of [process.env.AGY_BIN, config.gemini.agyBin]) if (c && fs.existsSync(c)) return c;
  const hit = onPath('agy').find((c) => process.platform !== 'win32' || /\.exe$/i.test(c));
  if (hit) return hit;
  const win = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  return process.env.LOCALAPPDATA && fs.existsSync(win) ? win : null;
}

export function git(cwd, args, { allowFail = false, raw = false } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  const out = r.stdout || '';
  return raw ? out : out.trim();
}

export function gitRoot(p) {
  let dir = p;
  try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { dir = path.dirname(p); }
  while (dir && !fs.existsSync(dir)) dir = path.dirname(dir);
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? norm(r.stdout.trim()) : null;
}

const skipped = (f) => (config.review.skipPaths || []).some((p) => f.startsWith(p));

// Untracked files worth reviewing: everything git does not ignore, minus lockfiles, linked
// dependency dirs and skipPaths. Files written by shell commands are never seen by the edit
// hook, so the review cannot rely on the hook's file list.
export function reviewableUntracked(repo) {
  const linked = config.worktrees.linkDirs || [];
  return git(repo, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], { allowFail: true })
    .split('\n').filter(Boolean)
    .filter((f) => !config.review.ignore.includes(path.basename(f)) && !skipped(f) && !linked.some((d) => f === d || f.startsWith(`${d}/`)));
}

// The prompt names at most maxUntracked files and says how many it left out.
function untrackedLine(untracked, findMore) {
  const max = config.review.maxUntracked || 200;
  if (!untracked.length) return 'none';
  const more = untracked.length - max;
  return untracked.slice(0, max).join(', ') + (more > 0 ? ` and ${more} more (${findMore})` : '');
}

export const skipPathspecs = () => (config.review.skipPaths || []).map((p) => `:(exclude)${p}`);

export function newId(prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Workers spawn their own children (tests, dev servers), so a timeout kills the whole tree:
// taskkill /T on Windows, the process group elsewhere.
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

// detached puts workers outside the terminal's process group, so Ctrl-C is passed on to all live ones.
const live = new Set();
if (process.platform !== 'win32') {
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { for (const c of live) killTree(c); process.exit(130); });
}

export function runProcess(cmd, args, { cwd, input, timeoutMs, stdoutFile, stderrFile, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const out = stdoutFile ? fs.createWriteStream(stdoutFile) : null;
    const err = stderrFile ? fs.createWriteStream(stderrFile) : null;
    let tail = '';
    child.stdout.on('data', (b) => { out?.write(b); });
    child.stderr.on('data', (b) => { err?.write(b); tail = (tail + b.toString()).slice(-4000); });
    let timedOut = false;
    let settled = false;
    const done = (s) => (s ? new Promise((r) => { s.on('error', r); s.end(r); }) : null);
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await Promise.all([done(out), done(err)]);
      resolve({ code, timedOut, stderrTail: tail });
    };
    // A surviving grandchild can hold the pipes open, so 'close' may never come after a kill.
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); setTimeout(() => finish(null), 10000); }, timeoutMs) : null;
    live.add(child);
    child.on('error', (e) => { tail += `\nspawn error: ${e.message}`; });
    child.on('close', (code) => { live.delete(child); finish(code); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const SEVERITY = 'Severity: P0 breaks the build, loses data or leaks secrets; P1 wrong behavior a user will hit; P2 edge case, rule violation or fragile code; P3 minor.';

const REVIEW_PROMPT = (base, untracked) => `You are the second reviewer in a two-model setup. Another model wrote these changes.
Review ONLY what changed in this git repository relative to commit ${base}:
- committed and uncommitted changes: run \`git diff --stat ${base}\` for an overview, then \`git diff ${base}\`
- new untracked files to include: ${untrackedLine(untracked, 'list them with `git ls-files --others --exclude-standard`')}${(config.review.skipPaths || []).length ? `
- never open, read or diff these paths, and leave them out of every git command with pathspecs: ${config.review.skipPaths.map((p) => `':(exclude)${p}'`).join(' ')}` : ''}
Read surrounding code and the repo's AGENTS.md or CLAUDE.md when they exist, and check the changes against their rules.
Report only real problems introduced by these changes: bugs, regressions, broken contracts between files, security or privacy issues, violations of the repo's documented rules, copy that claims something the code does not do. No style preferences, no praise.
${SEVERITY}
Do not modify any file. Do not open .env*, *.pem, *.key or other credential files.
Return JSON matching the output schema. verdict is "clean" when there are no P0-P2 findings. Use line 0 when a finding has no single line. Paths are relative to the repository root.`;

export async function codexReview({ repo, base, untracked = [], effort, id, timeoutMin }) {
  id = id || newId('rv');
  const runDir = path.join(RUNS, id);
  fs.mkdirSync(runDir, { recursive: true });
  const out = path.join(runDir, 'result.json');
  const meta = { id, kind: 'review', agent: 'codex', repo, base, untracked, started: new Date().toISOString(), status: 'running' };
  writeJson(path.join(runDir, 'run.json'), meta);
  let bin;
  try { bin = codexCmd(); } catch (e) { Object.assign(meta, { status: 'failed' }); writeJson(path.join(runDir, 'run.json'), meta); return { id, runDir, result: null, error: e.message }; }
  const args = [...bin.pre, 'exec', '-C', repo, '-s', 'read-only', '--ephemeral',
    '--output-schema', path.join(SCHEMAS, 'review.schema.json'), '-o', out,
    '-c', `model_reasoning_effort="${effort || config.codex.reviewEffort}"`];
  if (config.codex.model) args.push('-m', config.codex.model);
  args.push('-');
  const r = await runProcess(bin.cmd, args, {
    cwd: repo, input: REVIEW_PROMPT(base, untracked),
    timeoutMs: (timeoutMin || config.codex.reviewTimeoutMin) * 60000,
    stdoutFile: path.join(runDir, 'stdout.log'), stderrFile: path.join(runDir, 'stderr.log'),
  });
  const result = readJson(out, null);
  Object.assign(meta, { finished: new Date().toISOString(), status: r.timedOut ? 'timeout' : result ? 'done' : 'failed', exitCode: r.code });
  writeJson(path.join(runDir, 'run.json'), meta);
  const errLine = r.stderrTail.split('\n').reverse().find((l) => /^ERROR/i.test(l.trim()));
  return { id, runDir, result, error: result ? null : `codex review ${meta.status} (exit ${r.code}): ${(errLine || r.stderrTail.slice(-600)).trim()}` };
}

// Headless agy cannot run shell commands (they are auto-denied), so Gemini reviewers get the
// diff as a file and only read files. The result is a JSON envelope on the last JSON line of
// stdout; with --json-schema the parsed result is in `structured_output`.
export async function agyRun({ prompt, cwd, model, schemaFile, timeoutMin, addDirs = [], runDir, mode, sandbox = true }) {
  const bin = agyCmd();
  if (!bin) return { error: 'agy (Antigravity CLI) not installed' };
  const args = ['-p', prompt, '--output-format', 'json', '--print-timeout', `${timeoutMin || 20}m`];
  if (model || config.gemini.model) args.push('--model', model || config.gemini.model);
  if (schemaFile) args.push('--json-schema', schemaFile);
  if (sandbox) args.push('--sandbox');
  if (mode) args.push('--mode', mode);
  for (const d of addDirs) args.push('--add-dir', d);
  const stdoutFile = path.join(runDir, 'stdout.json');
  const r = await runProcess(bin, args, {
    cwd, timeoutMs: ((timeoutMin || 20) + 2) * 60000, stdoutFile, stderrFile: path.join(runDir, 'stderr.log'),
  });
  const lines = (fs.existsSync(stdoutFile) ? fs.readFileSync(stdoutFile, 'utf8') : '').split('\n').filter((l) => l.trim().startsWith('{'));
  let envelope = null;
  try { envelope = JSON.parse(lines.at(-1)); } catch {}
  if (!envelope) return { error: `agy produced no result (exit ${r.code}): ${r.stderrTail.slice(-600)}` };
  if (envelope.status === 'ERROR' || envelope.error) {
    return { envelope, error: `agy error: ${String(envelope.error || envelope.finished_reason).split('\n')[0]}` };
  }
  if (envelope.denied_actions?.length && !envelope.response) {
    return { envelope, error: `agy denied tools it needed: ${envelope.denied_actions.map((a) => a.action).join(', ')}` };
  }
  return { envelope, result: envelope.structured_output ?? null, text: envelope.response || '' };
}

const GEMINI_REVIEW_PROMPT = (patch, base, untracked) => `You are a second-model reviewer. Another model wrote these changes. The full diff relative to commit ${base} is in the file ${patch}.
${untracked.length ? `New untracked files to include: ${untrackedLine(untracked, 'find them with your file listing tools, never a shell command')}.\n` : ''}${(config.review.skipPaths || []).length ? `Never open or read anything under these paths: ${config.review.skipPaths.join(', ')}.\n` : ''}Read the diff, read the changed files in the workspace for context, and read the repo's AGENTS.md or CLAUDE.md when they exist to check the changes against their rules.
Report only real problems introduced by these changes: bugs, regressions, broken contracts between files, security, privacy or accessibility defects, violations of the documented rules, copy that claims something the code does not do. No style preferences, no praise.
${SEVERITY}
You cannot run shell commands; use file reading only. Do not modify any file. Do not open .env*, *.pem, *.key or other credential files.
Return JSON matching the schema. verdict is "clean" when there are no P0-P2 findings. Use line 0 when a finding has no single line. Paths are relative to the repository root.`;

export async function geminiReview({ repo, base, untracked = [], model, id, timeoutMin }) {
  id = id || newId('gr');
  const runDir = path.join(RUNS, id);
  fs.mkdirSync(runDir, { recursive: true });
  const patch = path.join(runDir, 'diff.patch');
  const excludes = [...config.worktrees.linkDirs, ...(config.review.skipPaths || [])].map((d) => `:(exclude)${d}`);
  fs.writeFileSync(patch, git(repo, ['diff', base, '--', '.', ...excludes], { raw: true, allowFail: true }));
  const meta = { id, kind: 'review', agent: 'gemini', repo, base, untracked, started: new Date().toISOString(), status: 'running' };
  writeJson(path.join(runDir, 'run.json'), meta);
  const res = await agyRun({
    prompt: GEMINI_REVIEW_PROMPT(norm(patch), base, untracked), cwd: repo, runDir,
    model: model || config.gemini.reviewModel, schemaFile: path.join(SCHEMAS, 'review.schema.json'),
    timeoutMin: timeoutMin || config.gemini.reviewTimeoutMin, addDirs: [runDir],
  });
  if (res.result) writeJson(path.join(runDir, 'result.json'), res.result);
  Object.assign(meta, { finished: new Date().toISOString(), status: res.result ? 'done' : 'failed', conversationId: res.envelope?.conversation_id, usage: res.envelope?.usage });
  writeJson(path.join(runDir, 'run.json'), meta);
  return { id, runDir, result: res.result, error: res.result ? null : res.error || 'no structured result' };
}

export function formatFindings(findings) {
  return findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.title}\n  ${f.detail}\n  Fix: ${f.fix}`).join('\n');
}
