# Contributing to curc

Thanks for looking. curc is small on purpose: ~2,500 lines, no runtime dependencies,
one linter, one test runner. Keep it that way and most PRs will be easy to take.

## Setup

```bash
git clone https://github.com/bruw/curc
cd curc
npm install          # only pulls in the linter
npm test
npm run lint
```

Node 20+ and git. The suite drives real git repositories in a temp dir and a fake
`claude` binary (`test/helpers/fake-claude.js`), so it runs offline and costs nothing.
Nothing in the suite may ever call the real `claude`.

## Ground rules

**Money is the design constraint.** Every review is $5–$25 of someone's credits. Any
change that touches launching, locking, claiming, or the consent prompts needs a test
that shows the failure mode it guards against, and the commit message should say what
the money-losing scenario was. Fail closed: when curc cannot tell whether a chunk was
billed, it refuses and names the flag, it does not guess.

**Never touch the user's repo.** No writes to the index, HEAD, the working tree, or
any ref outside `refs/heads/curc/`. `test/refs.test.js` enforces this byte-for-byte;
if your change makes it fail, the change is wrong, not the test.

**No runtime dependencies.** `package.json` has none and `npx -y claude-ultrareview-chunked@latest` is the
install path. If you need something, write it; if it is too big to write, it is
probably too big for curc.

**stdout is the answer, stderr is the conversation.** `--json` output goes to stdout
and nothing else does. Every prompt in the guided flow has a flag equivalent, and a
missing terminal produces an error naming the flag, never a hang.

## Tests

`node --test`, plain `assert/strict`, one behaviour per test with a name that reads as
a sentence. Use the helpers:

- `tmpRepo({ 'path': 'content' })` makes a committed repo in a temp dir
- `lines(n)` makes filler to hit a cap on purpose
- `settle(L, ids)` waits for a background run to finish, keyed on the lock being released
- `FAKE_CLAUDE_MODE=fail|garbage`, `FAKE_CLAUDE_DELAY_MS`, `FAKE_CLAUDE_ARGV_LOG` drive
  the fake `claude`

Extend the test file that covers the module you touched. Start a new file only for a
genuinely new module.

## Style

`npm run lint` is [standard](https://standardjs.com); `npm run lint:fix` handles most
of it. Comments explain *why*, and especially why the obvious approach was wrong, since
that is the thing the next reader cannot recover from the code.

## Commits and PRs

One coherent change per commit, with a message that says what could go wrong before
and why it cannot now. Small PRs land fast; a PR that fixes a bug and refactors around
it should be two.

If you are unsure whether something fits, open an issue first. It is cheaper than a PR
nobody wants.

## Releasing (maintainers)

The version lives in `package.json`, `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`, and `test/args.test.js` fails if they disagree.
Bump all three, tag, `npm publish`.
