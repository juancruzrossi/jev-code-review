# jev-code-review

Your coding agent reviews its own code with [Jev](https://typesafe.ai) before handing it to you.

Works with Claude Code, Codex, and OpenCode.

## How it works

1. The agent changes code.
2. Jev asks a small yes/no rule for each concern and, when a rule is true, which added line breaks it.
3. Findings land in two tiers: Fix (80% or more) must be fixed; Verify (55-79%) should be opened and changed only if the problem is real. The agent fixes Fix items and asks Jev again, up to 3 rounds; it stops early when the Fix count stops dropping.
4. The agent ends its answer with the table. `Final` is the last round:

```
┌─────────────────────┬─────────┬───────┐
│         Rule         │ Round 1 │ Final │
├─────────────────────┼─────────┼───────┤
│ defect               │ 62%     │ 12% ✓ │
│ missing_requirement  │ 5%      │ 5%  ✓ │
│ speculative_code     │ 30%     │ 30% ✓ │
│ new_dependency        │ 2%      │ 2%  ✓ │
│ reinvents_existing    │ 8%      │ 8%  ✓ │
│ unrelated_change      │ 4%      │ 4%  ✓ │
└─────────────────────┴─────────┴───────┘

Fix:
- a.js:12 — defect 62%: For some input the task or the callers can pass, an added line returns a wrong result...
```

You don't need to ask for it. The agent does it on every code change.

## Built-in rules

| Rule | Checks |
|---|---|
| defect | An added line misbehaves for some real input |
| missing_requirement | Something the task asked for is missing |
| speculative_code | An added line does more than the task needs |
| new_dependency | A new third-party dependency was added unasked |
| reinvents_existing | An added line reimplements something that already exists |
| unrelated_change | A changed line does not trace to the task |

### Project rules

Add project-specific rules in `.jev/rules.json` at the git root:

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
