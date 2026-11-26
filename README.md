<p align="center">
  <img src="assets/banner.webp" alt="Second Pair: a writer at her typewriter with one proofreader reading over each shoulder." width="100%">
</p>

# Second Pair

Cross-model review and Codex task delegation for Claude Code.

[![MIT license](https://img.shields.io/badge/license-MIT-475569)](LICENSE)

[What it does](#what-it-does) | [How it compares](#how-it-compares) | [Installation](#installation) | [Configuration](#configuration) | [Commands](#commands) | [License](#license)

A Claude Code plugin. When Claude finishes a turn that changed code, Codex reviews everything Claude changed in that repo during the session, in the background, and wakes Claude only when it finds real problems. Gemini can review alongside it. Claude can also hand Codex an implementation task that runs headless in its own git worktree and branch, so nothing lands on your main branch until you merge it.

## What it does

<img src="assets/review-gate.webp" alt="A proofreader hands a writer back a page with one line circled, while a desk bell waits beside her typewriter." width="360" align="right">

### Review every turn, bounded

A `PostToolUse` hook records which repos Claude edits and the commit each one had at the first edit. A `Stop` hook runs in the background (`asyncRewake`), so you are never held up. It sends the whole session diff, untracked files included, to Codex in a read-only sandbox, and to Gemini as well if you turn it on.

Findings rated P0 to P2 wake Claude with the file, line and suggested fix. Claude fixes the real ones and rebuts the wrong ones in one line. After two blocking rounds in a row on a repo the gate stops and leaves the rest to you, so a disagreement between models never turns into a loop that burns your quota. When a reviewer is down (missing CLI, quota, timeout) Claude says so once instead of failing silently.

<br clear="all">

<img src="assets/worktree.webp" alt="A foreman hands a work order to a carpenter stepping through the door of a separate side workshop, while the main shop floor stays roped off." width="360" align="left">

### Hand Codex the mechanical work

The bundled `orchestrate` skill teaches Claude when to delegate: a multi-file change with acceptance checks that fits a one-page spec goes to Codex, a large read-only analysis can go to Gemini, and anything that needs Claude's connectors or judgment stays with Claude.

`codex-task` creates a worktree on branch `agent/codex/<id>`, links `node_modules` from the main checkout, runs Codex in its `workspace-write` sandbox there and commits the result to the branch. Claude then reviews the diff, re-runs the checks and reports the branch. Merging stays your call.

<br clear="all">

## How it compares

OpenAI's official [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) also offers a Codex review gate on `Stop` and Codex delegation, and is the better choice if you want Codex review and rescue commands and nothing else. Second Pair differs in four ways:

- It reviews everything changed since the session's first edit in each repo, not only the current turn.
- Codex and Gemini can review the same diff in one pass.
- Blocking stops after two rounds in a row on the same repo.
- Delegated tasks always run in a separate worktree and branch.

For larger fleets of parallel workers, see [a-fable-of-codexes](https://github.com/jvogan/a-fable-of-codexes); for a multi-model MCP hub, see [pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server).

## Installation

You need Node.js 18 or later, git, and the [Codex CLI](https://github.com/openai/codex) signed in. Gemini review needs Google's Antigravity command-line tool, `agy`, on your PATH and signed in; without it, Gemini is skipped. The older Gemini CLI is not supported.

In Claude Code:

```text
/plugin marketplace add arcbaslow/second-pair
/plugin install second-pair@second-pair
```

Restart Claude Code so the hooks load, then ask Claude to run `orch doctor`, or run it yourself from the plugin folder: `node orch.mjs doctor`. It reports which CLIs it found and the active config.

Every turn that changes code in a git repo Claude has edited now gets a Codex review, which uses your Codex quota. Set `"review": { "enabled": false }` in the config to keep delegation and turn the gate off.

## Configuration

Defaults live in `config.default.json`. Override any key in `~/.claude/second-pair/config.json`; the two are merged. Runs, logs and session state are kept in `~/.claude/second-pair/` (or `$ORCH_HOME`), so they survive plugin updates.

| Key | Default | What it does |
|---|---|---|
| `denylist` | `[]` | Path fragments that never go to Codex or Gemini, for example a notes vault or a client repo under NDA |
| `review.enabled` | `true` | Turns the automatic review gate on or off |
| `review.agents` | `["codex"]` | Reviewers for the gate: `codex`, `gemini` or both |
| `review.wakeOn` | `["P0","P1","P2"]` | Severities that wake Claude |
| `review.maxRounds` | `2` | Blocking rounds in a row on a repo before the gate stops |
| `review.skipPaths` | `[]` | Path prefixes left out of the diff; reviewers are asked not to open them, which is not a sandbox boundary, so use `denylist` for anything confidential |
| `worktrees.root` | next to the repo, in `.worktrees/` | Where task worktrees are created |
| `worktrees.linkDirs` | `["node_modules"]` | Dependency folders linked from the main checkout into each worktree |
| `codex.model`, `codex.taskEffort`, `codex.reviewEffort` | Codex default, `high`, `medium` | Model and reasoning effort for tasks and reviews |
| `gemini.model`, `gemini.reviewModel` | `agy` default | Models for Gemini tasks and reviews |

`CODEX_BIN` and `AGY_BIN` override where the CLIs are found.

## Commands

| Command | What it does |
|---|---|
| `orch doctor` | Shows the CLIs found, the config file in use and the review settings |
| `orch codex-task --repo <path> --task <spec.md>` | Runs a Codex task in a new worktree and branch, commits the result and prints a JSON report |
| `orch review --repo <path> [--agent codex\|gemini\|both] [--base <ref>]` | One-off review of everything changed since a ref |
| `orch gemini-task --task <spec.md> [--repo <path>] [--edits]` | Gemini analysis, or edits in its own worktree with `--edits` |
| `orch finalize --id <id>` | Commits and records a task whose orchestrator process died after the worker finished |
| `orch runs`, `orch worktree-rm --id <id>` | Lists recent runs; removes a task worktree and keeps its branch |

Inside Claude Code, `orch` is `node "${CLAUDE_PLUGIN_ROOT}/orch.mjs"`, which the skill fills in for Claude.

## Limits

- A repo is tracked once Claude edits a file in it with Edit or Write; a repo with no commits yet is reviewed against an empty tree. Repos under `~/.claude` are never tracked. Changes made only through shell commands in a repo Claude never edited are not reviewed.
- Headless `agy` refuses shell commands, so Gemini cannot run tests; Claude runs the checks for Gemini's edits.
- Worktrees link dependency folders rather than install them, because Codex runs without network.

## License

[MIT](LICENSE)
