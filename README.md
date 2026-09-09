# claude-ultrareview-chunked

Review a whole existing codebase with Claude Code's ultrareview, one chunk at a time.

```bash
cd your-repo
npx -y claude-ultrareview-chunked@latest
```

> **Unofficial.** claude-ultrareview-chunked is a third-party tool, not made by or affiliated with Anthropic.
> It just drives the `claude` CLI you already have.

> **It spends money.** Every chunk is one cloud ultrareview, roughly $5–$25 in usage
> credits after your **3 free runs**. A 300k-line repo is ~50 chunks. claude-ultrareview-chunked estimates
> the bill before every launch and never starts one without a yes.

## The use case

You inherited a repo. Or you wrote one over three years and would like a second pair of
eyes on *all* of it, not just the last pull request. `/code-review ultra` is very good
at that, but it reviews a **diff**, capped at 500 files and 8,000 changed lines. Point
it at an existing codebase and there is no diff to review.

claude-ultrareview-chunked fakes the diff. It slices the repo into chunks that fit under the cap, builds a
throwaway commit pair for each one where the "change" is exactly that chunk, and runs
one ultrareview per pair. The reviewer still gets the whole repository to read, so it
can follow an import out of the chunk instead of guessing.

It keeps score by content, so you can sweep a live codebase
over weeks without paying to re-review files that moved.


## How the chunk trick works

For each chunk claude-ultrareview-chunked builds two commits:

```
claude-ultrareview-chunked/base-0007    orphan commit: the whole repo MINUS the chunk's files
claude-ultrareview-chunked/chunk-0007   the whole repo, parented on that base
```

The diff between them is exactly the chunk, as pure additions. The review runs from a
throwaway worktree with:

```
claude ultrareview claude-ultrareview-chunked/base-0007 --json --no-post
```

Both commits are built through a scratch git index. Your index, working tree, HEAD and
branches are never touched. Every pair is checked before use (merge-base, exact file
list, additions only) and re-measured against the 500-file / 8,000-line caps right
before a review is allowed to start.

## Install

```bash
npx -y claude-ultrareview-chunked@latest   # nothing to install
npm i -g claude-ultrareview-chunked        # or keep it on PATH
```

The package installs one command, `claude-ultrareview-chunked`.

You need Node 20+, git, and a Claude Code that is logged in to a claude.ai account
(ultrareview does not work on API keys). claude-ultrareview-chunked checks all of that before it spends
anything.

## Use it

```bash
claude-ultrareview-chunked
```

That is the whole interface. It surveys the repo, shows you the chunks and what they
cost, lets you pick a few, launches the reviews in the background, and reads the
findings back when they land. Quit whenever; the reviews keep going.

A first sweep usually looks like:

1. `claude-ultrareview-chunked` → pick the directories you care about → it plans, say, 12 chunks.
2. Review 3 of them. Wait ten minutes. Read the findings. Decide whether it is worth it.
3. Come back later and review a few more. Repeat until pending hits zero.

<details>
<summary>Subcommands, for scripts and agents</summary>

```bash
claude-ultrareview-chunked plan  --scope src,tests --json   # survey and chunk (free)
claude-ultrareview-chunked run   --chunks 3-5 --yes         # launch reviews (billed)
claude-ultrareview-chunked run   --chunks 3-5 --dry-run     # build and prove the pairs, launch nothing
claude-ultrareview-chunked status --json                    # planned / running / done
claude-ultrareview-chunked findings --json                  # findings with chunk provenance
claude-ultrareview-chunked stop                             # stop the run in flight
claude-ultrareview-chunked clean --yes                      # remove claude-ultrareview-chunked worktrees and branches
claude-ultrareview-chunked unlock                           # clear a lock a dead supervisor left behind
```

`--chunks` takes **chunk ids**, the numbers in the `#` column. They never get reused
across re-plans, so after the first re-plan they stop matching list positions. An id
that is not in the plan is refused rather than substituted.

`claude-ultrareview-chunked run` never prompts. `--yes` is the consent, terminal or not; without it claude-ultrareview-chunked
prints the cost and exits. Every question the guided flow asks has a flag like that, so
nothing ever hangs waiting on a terminal that is not there.

`--force` re-runs a chunk that may already have been billed (a review that failed,
timed out, or lost its supervisor still consumed a run). claude-ultrareview-chunked refuses those without it.
</details>


## Long sweeps

`main` does not stand still for a month. claude-ultrareview-chunked records the **git blob sha** of every
file it has reviewed, so on the next plan:

- a file that moved but did not change is still covered, for free
- an edited file gets a new sha and comes back into the plan by itself
- chunk boundaries can shift freely, because nothing ever referred to them

"31 of 51 chunks" becomes something exact: 612 of 779 files covered, 24 chunks to go.

## What it writes

| path | what |
|---|---|
| `.claude/claude-ultrareview-chunked/ledger.json` | the plan and the coverage record |
| `.claude/claude-ultrareview-chunked/findings/` | raw ultrareview output, one file per chunk |
| `.claude/claude-ultrareview-chunked/logs/` | per-chunk logs and the supervisor log |
| `.claude/claude-ultrareview-chunked/runs/` | one record per review, plus the claim that says it was launched |
| `.claude/worktrees/claude-ultrareview-chunked-*` | review worktrees, removed as each chunk finishes |

claude-ultrareview-chunked offers to add `.claude/claude-ultrareview-chunked/` and `.claude/worktrees/` to `.gitignore`. It never
edits the file silently. Peak footprint is three worktrees, not one per chunk.

## Safety

claude-ultrareview-chunked never writes your index, never moves HEAD, never checks anything out in your
working tree, never commits, pushes or stages, and never creates or deletes a ref
outside `refs/heads/claude-ultrareview-chunked/`. It always passes `--no-post`, so nothing is ever commented
on a pull request.

Those are tests, not promises: `test/refs.test.js` asserts the index bytes, `git
status`, HEAD, the current branch and an unstaged edit are byte-identical before and
after a chunk is built, on a deliberately dirty repo.

**Nothing is billed twice by accident.** A run takes a lock before it writes anything,
and each chunk takes an atomic claim immediately before the one call that spends money.
Two `claude-ultrareview-chunked run` at once cannot both launch, and a chunk cannot be reviewed twice however
that goes wrong. claude-ultrareview-chunked never reclaims a stale lock on its own; `claude-ultrareview-chunked unlock` is a
deliberate act. A review that hangs is killed rather than holding a slot forever.

claude-ultrareview-chunked reviews **committed** content. Uncommitted changes are not in any review, and it
says so.

## The Claude Code plugin

```
/plugin marketplace add bruw/claude-ultrareview-chunked
/plugin install claude-ultrareview-chunked@claude-ultrareview-chunked
```

The plugin adds a skill that surveys the repo, presents the cost, asks for approval,
and, once the reviews land, triages the findings: re-reading each cited file at current
HEAD, separating confirmed bugs from stale line numbers and false positives, and
grouping by theme rather than by chunk.

The skill deliberately **cannot** launch a billed run. `claude-ultrareview-chunked run` is left out of its
allowed tools, so spending always takes a keystroke from you.

## Environment

| variable | effect |
|---|---|
| `CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN` | path to the `claude` binary, if it is not on PATH |
| `CLAUDE_ULTRAREVIEW_CHUNKED_COST_LOW` / `CLAUDE_ULTRAREVIEW_CHUNKED_COST_HIGH` | correct the per-review cost band |
| `CLAUDE_ULTRAREVIEW_CHUNKED_WATCHDOG_MS` | shorten claude-ultrareview-chunked's own bound on a single review |
| `NO_COLOR` | plain output |

## Contributing

Bug reports and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © bruw
