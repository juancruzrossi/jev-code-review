# How jev-code-review works

jev-code-review gives your coding agent a second reviewer. [Jev](https://typesafe.ai), a code-review model, checks every change the agent makes and tells it exactly which line has a problem, so the agent fixes that line before handing the work to you.

## The problem it solves

A coding agent that reviews its own code tends to approve it. When it gets vague feedback such as "an edge case may be unhandled", it guesses: it adds validation nobody asked for, pulls in a new library, or rewrites code that was fine. You find the real bug later, in review or in production.

jev-code-review replaces that with short, specific findings:

- **Where:** the file and line.
- **What:** which rule the line breaks.
- **How sure:** a probability, so the agent knows whether to fix the line or only check it.

## When it runs

It runs on its own. You don't need to ask for it, and your agent instructions (`AGENTS.md`, `CLAUDE.md`) don't need to mention it.

1. **After each edit.** When the agent changes a file, Jev checks the new lines in about a second. It speaks only when it is confident something is wrong, so the agent can fix it while it is still in that file.
2. **Before the agent answers.** When the agent finishes a change, it asks Jev to review the whole diff against your request. If Jev finds problems, the agent fixes them and asks again, up to three rounds. It stops early when another round would not help.

## What a finding looks like

```
┌─────────────────────┬───────┐
│        Rule         │ Final │
├─────────────────────┼───────┤
│ defect              │ 92% ✗ │
│ missing_requirement │ 15% ✓ │
│ speculative_code    │ 16% ✓ │
│ new_dependency      │ 5% ✓  │
│ reinvents_existing  │ 15% ✓ │
│ unrelated_change    │ 16% ✓ │
└─────────────────────┴───────┘

Fix:
- math.js:7 — defect 92%: for some input it can receive, an added line returns a wrong value, skips or double-counts an item, leaves wrong state, swallows an error into a misleading result, forgets to await, or has a condition or bound the wrong way round.
```

Findings come in two tiers:

| Tier | Probability | What the agent does |
|---|---|---|
| Fix | 75% or more | Fixes the line. |
| Verify | 55% to 74% | Opens the line and changes it only if the problem is real. |

When Jev is unsure about the exact line, the finding says `(line uncertain)`. The agent ends its answer with the table, so you see the result too.

## What it checks

| Rule | Catches |
|---|---|
| `defect` | A new line that misbehaves for some real input: a wrong value, a skipped item, a swallowed error, a missing `await`, a condition the wrong way round. |
| `missing_requirement` | Something your request explicitly asked for that is not in the change. |
| `speculative_code` | Options, settings, caches, retries, or checks that nobody asked for. |
| `new_dependency` | A new third-party package that your request did not ask for. |
| `reinvents_existing` | New code that duplicates a helper or constant the project already has. |
| `unrelated_change` | Renames, reformatting, or rewrites of code your request did not need changed. |

You can add rules for your own project, such as "money amounts are integers in cents, never floats". See [Project rules](../README.md#project-rules).

## What it doesn't do

- It doesn't judge design or architecture. Whether a change is the right approach is still your call.
- It doesn't replace tests. It catches likely problems in the new lines; tests prove behavior.
- It doesn't see your whole repository. It sees the change, your request, and any files the agent passes along.

## What leaves your machine

To review a change, the plugin sends the Jev API (TypeSafe) your request, the diff, and any files the agent passes along for context. It needs a Jev API key in `JEV_API_KEY` or in `~/.env`.
