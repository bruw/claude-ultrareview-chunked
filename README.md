# Claude Utrareview Chunks - CURC

Review a whole existing codebase with Claude Code's ultrareview, one chunk at a time.

```bash
cd your-repo
npx -y curc@latest
```

> **Unofficial.** curc is a third-party tool, not made by or affiliated with Anthropic.
> It just drives the `claude` CLI you already have.

> **It spends money.** Every chunk is one cloud ultrareview, roughly $5–$25 in usage
> credits after your **3 free runs**. A 300k-line repo is ~50 chunks. curc estimates
> the bill before every launch and never starts one without a yes.

## The use case

You inherited a repo. Or you wrote one over three years and would like a second pair of
eyes on *all* of it, not just the last pull request. `/code-review ultra` is very good
at that, but it reviews a **diff**, capped at 500 files and 8,000 changed lines. Point
it at an existing codebase and there is no diff to review.

curc fakes the diff. It slices the repo into chunks that fit under the cap, builds a
throwaway commit pair for each one where the "change" is exactly that chunk, and runs
one ultrareview per pair. The reviewer still gets the whole repository to read, so it
can follow an import out of the chunk instead of guessing.

Then it keeps score by content, not by chunk number, so you can sweep a live codebase
over weeks without paying to re-review files that only moved.


## How the chunk trick works

For each chunk curc builds two commits:

```
curc/base-0007    orphan commit: the whole repo MINUS the chunk's files
curc/chunk-0007   the whole repo, parented on that base
```

The diff between them is exactly the chunk, as pure additions. The review runs from a
throwaway worktree with:

```
claude ultrareview curc/base-0007 --json --no-post
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

The package installs one command, `curc`.

You need Node 20+, git, and a Claude Code that is logged in to a claude.ai account
(ultrareview does not work on API keys). curc checks all of that before it spends
anything.

## Use it

```bash
curc
```

That is the whole interface. It surveys the repo, shows you the chunks and what they
cost, lets you pick a few, launches the reviews in the background, and reads the
findings back when they land. Quit whenever; the reviews keep going.

A first sweep usually looks like:

1. `curc` → pick the directories you care about → it plans, say, 12 chunks.
2. Review 3 of them. Wait ten minutes. Read the findings. Decide whether it is worth it.
3. Come back later and review a few more. Repeat until pending hits zero.

<details>
<summary>Subcommands, for scripts and agents</summary>

```bash
curc plan  --scope src,tests --json   # survey and chunk (free)
curc run   --chunks 3-5 --yes         # launch reviews (billed)
curc run   --chunks 3-5 --dry-run     # build and prove the pairs, launch nothing
curc status --json                    # planned / running / done
curc findings --json                  # findings with chunk provenance
curc stop                             # stop the run in flight
curc clean --yes                      # remove curc worktrees and branches
curc unlock                           # clear a lock a dead supervisor left behind
```

`--chunks` takes **chunk ids**, the numbers in the `#` column. They never get reused
across re-plans, so after the first re-plan they stop matching list positions. An id
that is not in the plan is refused rather than substituted.

`curc run` never prompts. `--yes` is the consent, terminal or not; without it curc
prints the cost and exits. Every question the guided flow asks has a flag like that, so
nothing ever hangs waiting on a terminal that is not there.

`--force` re-runs a chunk that may already have been billed (a review that failed,
timed out, or lost its supervisor still consumed a run). curc refuses those without it.
</details>


## Long sweeps

`main` does not stand still for a month. curc records the **git blob sha** of every
file it has reviewed, so on the next plan:

- a file that moved but did not change is still covered, for free
- an edited file gets a new sha and comes back into the plan by itself
- chunk boundaries can shift freely, because nothing ever referred to them

"31 of 51 chunks" becomes something exact: 612 of 779 files covered, 24 chunks to go.

## What it writes

| path | what |
|---|---|
| `.claude/curc/ledger.json` | the plan and the coverage record |
| `.claude/curc/findings/` | raw ultrareview output, one file per chunk |
| `.claude/curc/logs/` | per-chunk logs and the supervisor log |
| `.claude/curc/runs/` | one record per review, plus the claim that says it was launched |
| `.claude/worktrees/curc-*` | review worktrees, removed as each chunk finishes |

curc offers to add `.claude/curc/` and `.claude/worktrees/` to `.gitignore`. It never
edits the file silently. Peak footprint is three worktrees, not one per chunk.

## Safety

curc never writes your index, never moves HEAD, never checks anything out in your
working tree, never commits, pushes or stages, and never creates or deletes a ref
outside `refs/heads/curc/`. It always passes `--no-post`, so nothing is ever commented
on a pull request.

Those are tests, not promises: `test/refs.test.js` asserts the index bytes, `git
status`, HEAD, the current branch and an unstaged edit are byte-identical before and
after a chunk is built, on a deliberately dirty repo.

**Nothing is billed twice by accident.** A run takes a lock before it writes anything,
and each chunk takes an atomic claim immediately before the one call that spends money.
Two `curc run` at once cannot both launch, and a chunk cannot be reviewed twice however
that goes wrong. curc never reclaims a stale lock on its own; `curc unlock` is a
deliberate act. A review that hangs is killed rather than holding a slot forever.

curc reviews **committed** content. Uncommitted changes are not in any review, and it
says so.

## The Claude Code plugin

```
/plugin marketplace add bruw/curc
/plugin install curc@curc
```

The plugin adds a skill that surveys the repo, presents the cost, asks for approval,
and, once the reviews land, triages the findings: re-reading each cited file at current
HEAD, separating confirmed bugs from stale line numbers and false positives, and
grouping by theme rather than by chunk.

The skill deliberately **cannot** launch a billed run. `curc run` is left out of its
allowed tools, so spending always takes a keystroke from you.

## Environment

| variable | effect |
|---|---|
| `CURC_CLAUDE_BIN` | path to the `claude` binary, if it is not on PATH |
| `CURC_COST_LOW` / `CURC_COST_HIGH` | correct the per-review cost band |
| `CURC_WATCHDOG_MS` | shorten curc's own bound on a single review |
| `NO_COLOR` | plain output |

## Contributing

Bug reports and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © bruw
