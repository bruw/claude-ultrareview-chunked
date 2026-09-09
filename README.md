# curc

**C**laude **U**lt**r**areview **C**hunk — review an entire codebase with Claude Code's
ultrareview, one diff-sized chunk at a time.

> **Unofficial.** curc is a third-party tool. It is not made by, endorsed by, or
> affiliated with Anthropic. It drives the `claude` CLI you already have installed.

> **This costs money.** Every chunk is one billed cloud ultrareview: roughly **$5–$25 in
> usage credits** after the 3 free lifetime runs on Pro and Max. A 291,000-line
> repository chunks into ~51 pieces — **$255 to $1,275** for a full sweep. curc cannot
> see your balance or how many free runs you have left. Nothing is billed until you
> confirm.

## Why

`/code-review ultra` reviews a **diff**, capped at 500 changed files and 8,000 changed
lines. That makes it excellent before a merge and useless for the thing people keep
wanting it for: a bug review of a codebase that already exists.

curc makes a whole repository reviewable by cutting it into chunks that each fit inside
the cap.

## Install

```bash
npx -y curc@latest      # no install
npm i -g curc           # or put it on PATH
```

Needs Node ≥ 20, git, and a Claude Code that is logged in to a claude.ai account and has
`claude ultrareview`. curc checks all of that before it spends anything.

## Use it

```bash
curc
```

That's the whole interface. One guided terminal flow: it surveys the repo, shows you the
chunks and what they cost, lets you pick some, launches the reviews in the background,
and reads the findings back. Nothing has to be run in a particular order.

<details>
<summary>Non-interactive commands, for scripts and agents</summary>

```bash
curc plan  --scope src,tests --json   # survey and chunk (free)
curc run   --chunks 1-3 --yes         # launch reviews (billed)
curc run   --chunks 1-3 --dry-run     # build and prove the pairs, launch nothing
curc status --json                    # planned / running / done
curc findings --json                  # findings with chunk provenance
curc stop                             # stop the run in flight
curc clean --yes                      # remove curc worktrees and branches
```

`--yes` is the only way a billed run starts without a terminal. Every prompt in the
guided flow has a flag equivalent, and curc errors with the flag name rather than
hanging when it has no terminal to ask on.
</details>

## How it works

Reviewing "just these files" is not something a diff-based reviewer can express. So for
each chunk curc builds a **pair of commits**:

```
curc/base-0007    an orphan commit — the whole repo MINUS the chunk's files
curc/chunk-0007   the whole repo, parented on that base
```

The diff between them is exactly the chunk, as pure additions — while the sandbox still
receives the **entire repository**, so a reviewer can follow an import out of the chunk
instead of staring at orphan files. The review runs from a throwaway worktree:

```
claude ultrareview curc/base-0007 --json --no-post
```

Both commits are built through a scratch git index, so your index, working tree, HEAD
and branches are never touched. Every pair is proved before use — merge-base identity,
exact file list, additions only — and re-checked against the 500-file / 8,000-line caps
immediately before a review is allowed to start.

## Long sweeps, and code that moves

A sweep can take months, and `main` does not stand still. Chunk numbers are therefore
not the unit of progress — **git blob shas are.**

curc records the sha of every file it has reviewed. On the next `plan`:

- a file that **moved but did not change** keeps its sha and stays covered, for free
- a file that was **edited** gets a new sha and re-enters the plan on its own
- **chunk boundaries can shift** freely, because nothing ever referred to them

So "31 of 51 done" becomes something exact: 612 of 779 files covered, 167 remaining, 24
chunks to go. Chunk ids are never reused, so a re-plan cannot overwrite older findings.

Two byte-identical files share one sha and so share coverage — same content, same bugs.

## What it writes

| path | what |
|---|---|
| `.claude/curc/ledger.json` | the plan and the coverage record |
| `.claude/curc/findings/` | raw ultrareview output, one file per chunk |
| `.claude/curc/logs/` | per-chunk logs and the supervisor log |
| `.claude/curc/runs/` | one record per review |
| `.claude/worktrees/curc-*` | review worktrees, removed as each chunk finishes |

curc offers to add `.claude/curc/` to `.gitignore`; it never edits the file silently.
Peak footprint is three worktrees, not one per chunk.

## Safety

curc never writes your index, never moves HEAD, never checks anything out in your
working tree, never commits, pushes, or stages, and never creates or deletes a ref
outside `refs/heads/curc/`. It always passes `--no-post`, so nothing is ever commented
on a pull request.

These are not promises, they are tests — see `test/refs.test.js`, which asserts the
index bytes, `git status`, HEAD, the current branch, and an unstaged edit are all
identical before and after a chunk is built, on a deliberately dirty repository.

curc reviews **committed** content. Uncommitted changes are not in any review, and it
says so.

## The Claude Code plugin

```
/plugin marketplace add artdiev/curc
/plugin install curc@curc
```

The plugin adds a skill that surveys the repo, presents the cost, asks for approval, and
— once the reviews land — triages the findings: re-reading each cited file at current
HEAD, separating confirmed bugs from stale line numbers and false positives, and
grouping by theme rather than by chunk.

The skill deliberately **cannot** launch a billed run. `curc run` is left out of its
allowed tools, so spending always takes a deliberate act from you.

## Environment

| variable | effect |
|---|---|
| `CURC_CLAUDE_BIN` | path to the `claude` binary, if it is not on PATH |
| `CURC_COST_LOW` / `CURC_COST_HIGH` | correct the per-review cost band |
| `NO_COLOR` | plain output |

## License

MIT © artdiev
