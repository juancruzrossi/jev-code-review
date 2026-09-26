# jev-code-review

Your coding agent reviews its own code with [Jev](https://typesafe.ai) before handing it to you.

Works with Claude Code, Codex, and OpenCode.

## How it works

1. The agent changes code.
2. Jev scores the change on six dimensions.
3. If a dimension fails, the agent fixes it and asks Jev again, up to 3 rounds.
4. The agent ends its answer with the score table. `Final` is the last round:

```
┌─────────────────┬─────────┬───────┐
│    Dimension    │ Round 1 │ Final │
├─────────────────┼─────────┼───────┤
│ Correctness     │ 7.4     │ 9.1 ✓ │
│ Simplicity      │ 6.2     │ 8.8 ✓ │
│ Surgical scope  │ 9.0     │ 9.2 ✓ │
│ Conventions     │ 8.1     │ 8.4 ✓ │
│ Readability     │ 8.7     │ 9.0 ✓ │
│ Maintainability │ 8.3     │ 6.6 ✗ │
└─────────────────┴─────────┴───────┘
```

You don't need to ask for it. The agent does it on every code change.

## Dimensions

Every dimension must score 8 or more.

| Dimension | Checks that the code |
|---|---|
| Correctness | Does what was asked and breaks nothing |
| Simplicity | Is the minimum that solves the problem |
| Surgical scope | Only touches what the task needs |
| Conventions | Follows the repo's existing style and reuses what exists |
| Readability | Is clear at first read |
| Maintainability | Keeps the next similar change in one place |

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

- Claude Code: `/plugin uninstall jev-code-review@jev-code-review`
- Codex: `codex plugin remove jev-code-review@jev-code-review`
- OpenCode: remove the entry from `opencode.jsonc`
