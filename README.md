# jev-code-review

Your coding agent reviews its own code with [Jev](https://typesafe.ai) before handing it to you.

Works with Claude Code, Codex, and OpenCode.

## How it works

1. The agent changes code. After each edit, Jev checks the new lines and speaks only when it is confident a line is wrong.
2. Before answering, the agent asks Jev to review the whole change against your request.
3. Jev answers with findings: the file and line, the rule it breaks, and how sure it is. Findings at 90% or more must be resolved or explained; findings at 55-89% get checked and changed only if the problem is real.
4. The agent fixes, asks again (up to 3 rounds), and ends its answer with the table:

```
┌───────────────────────────────────┐
│          Jev Code Review          │
├──────────────────────┬────────────┤
│         Risk         │   Chance   │
├──────────────────────┼────────────┤
│ Task not done        │ 8% ✓ low   │
│ Unrelated changes    │ 16% ✓ low  │
│ Missing requirements │ 15% ✓ low  │
│ Defects              │ 92% ✗ high │
├──────────────────────┴────────────┤
│          Lower is better          │
└───────────────────────────────────┘

Must resolve:
- math.js:7 — Defects 92%: for some input it can receive, an added line returns a wrong value, ...
```

You don't need to ask for it, and your `AGENTS.md` doesn't need to mention it. The agent does it on every code change.

Read [How it works](docs/HOW-IT-WORKS.md) for what it solves, what each rule catches, and what it sends to the Jev API.

Each percentage is the chance that the risk is real, so lower is better. The table marks `✓ low` below 55%, `! check` from 55% to below 90%, and `✗ high` at 90% or more. `No findings — good to go.` means no rule reached the check tier. `No blockers — <n> to check.` means check findings remain: open each line and change it only if the problem is real. Neither verdict guarantees correctness.

## Built-in rules

| Risk | Checks |
|---|---|
| Task not done | The change fails to do what the task asks, or breaks a stated constraint |
| Unrelated changes | A changed line does not trace to the task |
| Missing requirements | Something the task asked for is missing |
| Defects | An added line misbehaves for some real input |

### Project rules

Jev also checks a change against your project's own conventions:

- For each changed file, Jev reads the `AGENTS*.md` files (for example `AGENTS.md` and `AGENTS.local.md`) in that file's own directory and every ancestor directory up to the git root — never a sibling module's `AGENTS.md`, and never `CLAUDE.md`. Nothing needs to be added there for this — it reads what already exists.
- Each code rule found in those files is checked and located on its own, and findings name the rule and the file it came from: `- path:line — "the rule text" (path/to/AGENTS.md) NN%`. A repository with no `AGENTS*.md` files runs exactly as before.
- For rules that don't belong in `AGENTS.md`, add `.jev/rules.json` at the git root:

```json
[{ "name": "no_console_log", "rule": "never call console.log in production code" }]
```

Each entry becomes a rule Jev checks and locates the same way as the built-in ones.

## Local decision log

Each successful review appends a JSON line to `$XDG_STATE_HOME/jev-code-review/decisions.jsonl` (default: `~/.local/state/jev-code-review/decisions.jsonl`). It records the timestamp, repository folder name, round, verdict, and each rule's name, probability, tier, file and line. It contains no code, diff, task or rule text, and never leaves your machine. A log write failure does not fail the review.

## Requirements

- Node.js
- A Jev API key from [TypeSafe](https://console.typesafe.ai), as `JEV_API_KEY` in your environment or in `~/.env`

## Install

### Claude Code

```
/plugin marketplace add juancruzrossi/jev-code-review
/plugin install jev-code-review@jev-code-review
```

### Codex

```
codex plugin marketplace add juancruzrossi/jev-code-review
codex plugin add jev-code-review@jev-code-review
```

If Codex asks, trust the hooks once in `/hooks`.

### OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{ "plugin": ["github:juancruzrossi/jev-code-review"] }
```

## Uninstall

### Claude Code

```
/plugin uninstall jev-code-review@jev-code-review
```

### Codex

```
codex plugin remove jev-code-review@jev-code-review
```

### OpenCode

Remove from `~/.config/opencode/opencode.jsonc`:

```jsonc
{ "plugin": ["github:juancruzrossi/jev-code-review"] }
```
