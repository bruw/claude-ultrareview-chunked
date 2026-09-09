---
name: curc
description: Run or continue a chunked ultrareview sweep of an entire codebase, and triage what it finds. Use when the user wants to review, audit, or bug-hunt a whole existing repository rather than a diff — "review the whole repo", "ultrareview everything", "sweep the codebase for bugs", "audit this project" — when they mention curc, or when they want to read findings from an earlier sweep.
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(curc plan:*), Bash(curc status:*), Bash(curc findings:*), Bash(npx -y curc@latest plan:*), Bash(npx -y curc@latest status:*), Bash(npx -y curc@latest findings:*), Bash(command -v curc), Bash(git rev-parse:*), Bash(git status:*), Bash(git log:*)
---

# curc — chunked ultrareview

`/code-review ultra` reviews a **diff**, capped at 500 changed files and 8,000 changed
lines. curc makes a whole codebase reviewable by slicing it into diff-sized chunks and
driving one cloud ultrareview per chunk.

**Each chunk is one billed cloud review.** That fact governs everything below.

## Getting the CLI

`command -v curc`; if it is missing, use `npx -y curc@latest` in place of `curc`
everywhere. Do not `npm install -g` without asking.

curc validates that Claude Code is installed, supports `ultrareview`, and is logged in
before it will spend anything — you do not need to check those yourself.

## The one rule

**Never run `curc run`.** It is deliberately absent from this skill's `allowed-tools`,
because `Bash(...)` matching is prefix-based and allowing it would pre-authorize
`curc run --chunks all --yes` — a four-figure spend. Every command you may run is free
and read-only.

When the user is ready to spend, hand them the exact line and let them run it:

```
curc run --chunks 1-3 --yes
```

Or tell them to run `curc` with no arguments for the guided terminal flow, which does
the same thing interactively.

## What to do

**1 — Survey (free).** `curc plan --json`. Report: chunk count, files and lines in
scope, how many files are already covered from earlier sweeps, and what was dropped
(binaries, lockfiles, files too large for any diff).

**2 — Drift.** If `drift.state` is `"drifted"`, HEAD has moved past the plan. Say so
and let the user decide whether to re-plan; do not silently pick. Re-planning is free
and only re-chunks content that has not been reviewed — coverage is tracked by git blob
sha, so a file that moved but did not change stays covered.

**3 — The cost, before anything else.** Present in one message, with the arithmetic
shown:

- how many chunks they are about to review
- `chunks × $5` to `chunks × $25` in usage credits
- the first 3 ultrareviews are free on Pro and Max; **curc cannot see how many remain**
- a review that starts and then fails still consumes one

Then ask for approval with `AskUserQuestion`. **Approval means the user said yes to a
stated chunk count and a stated dollar range.** A vague "go ahead" that did not follow
those numbers is not approval — state the numbers and ask again.

**4 — Hand off.** Give them the `curc run` line. **`--chunks` takes chunk ids** — the
numbers in the `#` column, which are monotonic across re-plans and so stop matching list
positions after the first one. An id that is not in the plan is refused rather than
substituted. Reviews take 5–10 minutes each, run in the background, and survive closing
the terminal.

**5 — Follow along.** `curc status --json`, on a slow cadence — minutes, never seconds.
A full sweep takes hours to days. Do not busy-loop.

**6 — Triage.** This is the real work. `curc findings --json` returns every finding with
`_curc` provenance (chunk, snapshot, session URL, when it was reviewed). For each one:

- **Read the cited file at current HEAD.** The finding was produced against a snapshot;
  if the code has moved since, the line number is probably wrong.
- Classify: **confirmed** (the code still says what the finding claims), **stale** (the
  file changed since review — re-check before reporting), or **false positive**
  (ultrareview is a probabilistic reviewer and produces them).
- A chunk whose `findingsParsed` is `false` exited cleanly but returned a payload curc
  could not read. It still counts as covered, so it will not re-bill on the next plan —
  report it as unreviewed content rather than as a chunk with no findings.
- Group confirmed findings **by theme, not by chunk** — one real defect often surfaces
  in several chunks — and rank by blast radius.

Produce a prioritized report. **Do not fix anything unless the user asks.** If they do,
treat each fix as ordinary work: confirm the defect in the code first.

## Guardrails

- A chunk reported as `orphaned` had its supervisor die while a review was in flight.
  Report it; never re-run it, because that may double-bill. `curc run` refuses these
  without `--force`, and the per-chunk claim file refuses the spend regardless — but
  `--force` is the user's call to make, not yours.
- `curc clean` removes only curc's branches and worktrees; findings and the ledger are
  kept. There is no `--all`.
- If a repo says a run is in flight but nothing is running, the supervisor died holding
  its lock. curc never reclaims one by itself — two supervisors both deciding a lock is
  stale is a double-billed sweep — so tell the user to run `curc unlock`. It is not in
  this skill's allowed-tools, for the same reason `curc run` is not: it stands directly
  in front of a billed retry.
- curc reviews **committed** content. If the working tree is dirty, say that those
  changes are not in any review.
