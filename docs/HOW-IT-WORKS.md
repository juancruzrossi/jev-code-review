# How jev-code-review works

jev-code-review gives your coding agent a second reviewer. [Jev](https://typesafe.ai), a code-review model, checks every change the agent makes and tells it exactly which line has a problem, so the agent fixes that line before handing the work to you.

## The problem it solves

A coding agent that reviews its own code tends to approve it. When it gets vague feedback such as "an edge case may be unhandled", it guesses: it adds validation nobody asked for, pulls in a new library, or rewrites code that was fine. You find the real bug later, in review or in production.

jev-code-review replaces that with short, specific findings:

- **Where:** the file and line.
- **What:** which rule the line breaks.
- **How sure:** a probability, so the agent knows whether to fix the line or only check it.

## When it runs

It runs on its own. You don't need to ask for it, and your agent instructions (`AGENTS.md`) don't need to mention it.

1. **After each edit.** When the agent changes a file, Jev checks the new lines in about a second. It speaks only when it is confident something is wrong, so the agent can fix it while it is still in that file.
2. **Before the agent answers.** When the agent finishes a change, it asks Jev to review the whole diff against your request. If Jev finds problems, the agent fixes them and asks again, up to three rounds. It stops early when another round would not help.

## What a finding looks like

```
┌────────────────────────────────────────────┐
│              Jev Code Review               │
├──────────────────────┬─────────────────────┤
│ Is there a problem?  │       Chance        │
├──────────────────────┼─────────────────────┤
│ Task not done        │ 8% ✓                │
│ Unrelated changes    │ 16% ✓               │
│ Missing requirements │ 15% ✓               │
│ Bug                  │ 92% ✗               │
├──────────────────────┴─────────────────────┤
│ 0% = surely fine · 100% = surely a problem │
└────────────────────────────────────────────┘

Must resolve:
- math.js:7 — Bug 92%: for some input it can receive, an added line returns a wrong value, skips or double-counts an item, leaves wrong state, swallows an error into a misleading result, forgets to await, or has a condition or bound the wrong way round.
```

Findings come in two tiers:

| Tier | Probability | What the agent does |
|---|---|---|
| Must resolve | 90% or more | Fixes the line, or explains in its answer why it is not a real problem. |
| Check | 55% to 89% | Opens the line and changes it only if the problem is real. |

When Jev is unsure about the exact line, the finding says `(line uncertain)`. The agent ends its answer with the table, so you see the result too.

Each percentage is the chance that the problem is real: 0% means surely fine, 100% means surely a problem. The table marks `✓` below 55%, `!` from 55% to below 90%, and `✗` at 90% or more. `No findings — good to go.` means no rule reached the check tier. `No blockers — <n> to check.` means check findings remain: open each line and change it only if the problem is real. Neither verdict guarantees correctness.

## What it checks

| Problem | Catches |
|---|---|
| Task not done | The change does not do what your request asks, does it only partly, or breaks a constraint the request states. |
| Unrelated changes | Renames, reformatting, or rewrites of code your request did not need changed. |
| Missing requirements | Something your request explicitly asked for that is not in the change. |
| Bug | A new line that misbehaves for some real input: a wrong value, a skipped item, a swallowed error, a missing `await`, a condition the wrong way round. |

You can add rules for your own project, such as "money amounts are integers in cents, never floats". See [Project rules](../README.md#project-rules).

## What it doesn't do

- It doesn't judge design or architecture. Whether a change is the right approach is still your call.
- It doesn't replace tests. It catches likely problems in the new lines; tests prove behavior.
- It doesn't see your whole repository. It sees the change, your request, and any files the agent passes along.

## What leaves your machine

To review a change, the plugin sends the Jev API (TypeSafe) your request, the diff, any files the agent passes along for context, and the rule lines found in the `AGENTS*.md` files that apply to the changed files' directories and their parents — never a sibling module's `AGENTS.md`, never `CLAUDE.md`, and never the whole file. It needs a Jev API key in `JEV_API_KEY` or in `~/.envs`.
