// Stop hook (asyncRewake): reviews everything changed since the session's first edit in each
// repo. Exit 2 wakes Claude with the findings on stderr; exit 0 stays silent.
import fs from 'node:fs';
import path from 'node:path';
import { STATE, config, isDenied, git, sha, readJson, writeJson, codexReview, geminiReview, agyCmd, formatFindings, reviewableUntracked, skipPathspecs } from '../lib.mjs';

const log = (msg) => fs.appendFileSync(path.join(STATE, 'review-gate.log'), `${new Date().toISOString()} ${msg}\n`);

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => main().catch((e) => { log(`error ${e.stack}`); process.exit(0); }));

function fingerprint(root, base, untracked) {
  const head = git(root, ['rev-parse', 'HEAD'], { allowFail: true });
  const diff = git(root, ['diff', base, '--', '.', ...skipPathspecs()], { allowFail: true, raw: true });
  const extra = untracked.map((f) => { try { const s = fs.statSync(path.join(root, f)); return `${f} ${s.size} ${s.mtimeMs}`; } catch { return f; } }).join('\n');
  return { empty: !diff.trim() && !untracked.length, fp: sha(`${head}\n${diff}\n${extra}`) };
}

const NOTICE_EVERY_MS = 6 * 3600000;

function newFailures(failed) {
  const file = path.join(STATE, 'reviewer-failures.json');
  const seen = readJson(file, {});
  const fresh = failed.filter((x) => {
    const key = x.error.slice(0, 200);
    const last = seen[x.agent];
    if (last && last.key === key && Date.now() - last.at < NOTICE_EVERY_MS) return false;
    seen[x.agent] = { key, at: Date.now() };
    return true;
  });
  if (fresh.length) writeJson(file, seen);
  return fresh.map((x) => `- ${x.agent}: ${x.error.slice(0, 300)}`);
}

function update(file, root, patch) {
  const s = readJson(file, { repos: {} });
  s.repos[root] = { ...(s.repos[root] || {}), ...patch };
  writeJson(file, s);
}

async function main() {
  const ev = JSON.parse(input || '{}');
  if (!config.review.enabled || !ev.session_id) return;
  const file = path.join(STATE, `session-${ev.session_id}.json`);
  const initial = readJson(file, null);
  if (!initial) return;

  const messages = [];
  const notices = [];
  for (const root of Object.keys(initial.repos)) {
    if (isDenied(root) || !fs.existsSync(root)) continue;
    const lock = path.join(STATE, `lock-${sha(ev.session_id + root).slice(0, 12)}`);
    try { if (Date.now() - fs.statSync(lock).mtimeMs >= 20 * 60000) fs.unlinkSync(lock); } catch {}
    try { fs.closeSync(fs.openSync(lock, 'wx')); } catch { log(`skip ${root}: review already running`); continue; }
    try {
      // Re-read after taking the lock: another Stop hook may have reviewed this repo while this
      // one was busy with an earlier repo, and its round count must not be overwritten.
      const r = readJson(file, initial).repos[root];
      if (!r?.base) continue;
      if (!git(root, ['rev-parse', '--verify', '--quiet', `${r.base}^{tree}`], { allowFail: true })) {
        const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }) || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        log(`rebase ${root}: base ${r.base.slice(0, 7)} no longer exists, reviewing from ${head.slice(0, 7)} on`);
        update(file, root, { base: head, lastReviewed: null });
        continue;
      }
      const untracked = reviewableUntracked(root);
      const { empty, fp } = fingerprint(root, r.base, untracked);
      if (empty || fp === r.lastReviewed) continue;
      if ((r.blockStreak || 0) >= config.review.maxRounds) {
        log(`skip ${root}: ${r.blockStreak} blocking rounds already, leaving the rest to the user`);
        continue;
      }

      const agents = (config.review.agents || ['codex']).filter((a) => a !== 'gemini' || agyCmd());
      log(`review ${root} since ${r.base.slice(0, 7)} by ${agents.join('+')}`);
      const runs = await Promise.all(agents.map((a) => (a === 'gemini' ? geminiReview : codexReview)({ repo: root, base: r.base, untracked }).then((res) => ({ agent: a, ...res }))));
      const patch = { lastReviewId: runs.map((x) => x.id).join(',') };
      const ok = runs.filter((x) => !x.error);
      const failed = runs.filter((x) => x.error);
      for (const x of failed) log(`review ${x.id} (${x.agent}) failed: ${x.error}`);
      notices.push(...newFailures(failed));
      if (ok.length) {
        patch.lastReviewed = fp;
        const sections = [];
        let total = 0;
        for (const x of ok) {
          const blocking = x.result.findings.filter((f) => config.review.wakeOn.includes(f.severity));
          total += blocking.length;
          if (blocking.length) sections.push(`${x.agent} (review ${x.id}):\n${formatFindings(blocking)}`);
          log(`review ${x.id} (${x.agent}): ${x.result.verdict}, ${x.result.findings.length} finding(s), ${blocking.length} blocking`);
        }
        patch.blockStreak = total ? (r.blockStreak || 0) + 1 : 0;
        if (total) messages.push(`Cross-review of ${root} (changes since ${r.base.slice(0, 7)}, round ${patch.blockStreak}/${config.review.maxRounds}) found ${total} issue(s):\n${sections.join('\n\n')}`);
      }
      update(file, root, patch);
    } finally {
      try { fs.unlinkSync(lock); } catch {}
    }
  }

  const parts = [];
  if (messages.length) parts.push(`${messages.join('\n\n')}\n\nFix the findings that are real. If one is wrong, say why in one line. Do not commit around them silently.`);
  if (notices.length) parts.push(`Cross-review did not fully run:\n${notices.join('\n')}\nNothing to fix in the code for this part. Tell the user once which reviewer is down and why.`);
  if (parts.length) {
    process.stderr.write(`${parts.join('\n\n')}\n`);
    process.exit(2);
  }
}
