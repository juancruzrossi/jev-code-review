# jev-code-review

Your coding agent reviews its own code with [Jev](https://typesafe.ai) before handing it to you.

Works with Claude Code, Codex, and OpenCode.

## How it works

1. The agent changes code. After each edit, Jev checks the new lines and speaks only when it is confident a line is wrong.
2. Before answering, the agent asks Jev to review the whole change against your request.
3. Jev answers with findings: the file and line, the rule it breaks, and how sure it is. Findings at 90% or more must be resolved or explained; findings at 55-89% get checked and changed only if the problem is real.
4. The agent fixes, asks again (up to 3 rounds), and ends its answer with the table:

```
┌──────────────────────┬───────┐
│         Rule         │ Final │
├──────────────────────┼───────┤
│ addresses_task       │ 8% ✓  │
│ unrelated_change     │ 16% ✓ │
│ needs_clarification  │ 5% ✓  │
│ missing_requirement  │ 15% ✓ │
│ defect               │ 92% ✗ │
└──────────────────────┴───────┘

Must resolve:
- math.js:7 — defect 92%: for some input it can receive, an added line returns a wrong value, ...
```

You don't need to ask for it, and your `AGENTS.md` or `CLAUDE.md` doesn't need to mention it. The agent does it on every code change.

Read [How it works](docs/HOW-IT-WORKS.md) for what it solves, what each rule catches, and what it sends to the Jev API.

## Built-in rules

| Rule | Checks |
|---|---|
| addresses_task | The change fails to do what the task asks, or breaks a stated constraint |
| unrelated_change | A changed line does not trace to the task |
| needs_clarification | The task left out information this change needed |
| missing_requirement | Something the task asked for is missing |
| defect | An added line misbehaves for some real input |

### Project rules

Jev also checks a change against your project's own conventions:

- If the git root has an `AGENTS.md` or `CLAUDE.md`, its text (capped at 6,000 characters) is checked as a `project_rules` rule. Nothing needs to be added there for this — it reads what already exists.
- For rules that don't belong in `AGENTS.md`/`CLAUDE.md`, add `.jev/rules.json` at the git root:

```json
[{ "name": "no_console_log", "rule": "never call console.log in production code" }]
```

Each entry becomes a rule Jev checks and locates the same way as the built-in ones.

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
