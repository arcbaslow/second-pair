import path from 'node:path';
import os from 'node:os';
import { STATE, norm, isDenied, git, gitRoot, readJson, writeJson } from '../lib.mjs';

const ABS = /^(?:[A-Za-z]:[\\/]|\/)/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function collectPaths(v, key = '', depth = 0, acc = new Set()) {
  if (depth > 4 || v == null) return acc;
  if (typeof v === 'string') {
    if (/file|path/i.test(key) && ABS.test(v) && v.length < 400) acc.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectPaths(x, key, depth + 1, acc);
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collectPaths(x, k, depth + 1, acc);
  }
  return acc;
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(input || '{}');
    if (!ev.session_id) return;
    const paths = collectPaths({ tool_input: ev.tool_input, tool_response: ev.tool_response });
    if (!paths.size) return;
    const claudeHome = norm(path.join(os.homedir(), '.claude')).toLowerCase();
    const file = path.join(STATE, `session-${ev.session_id}.json`);
    const state = readJson(file, { session: ev.session_id, repos: {} });
    let changed = false;
    for (const p of paths) {
      const n = norm(p);
      if (n.toLowerCase().startsWith(claudeHome) || isDenied(n)) continue;
      const root = gitRoot(n);
      if (!root || state.repos[root]) continue;
      // A repo with no commits yet is reviewed against the empty tree.
      state.repos[root] = { base: git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }) || EMPTY_TREE, firstTouch: new Date().toISOString() };
      changed = true;
    }
    if (changed) writeJson(file, state);
  } catch {
    // Bookkeeping must never break Claude's tool flow.
  }
});
