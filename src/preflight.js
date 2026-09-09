import { isRepo, tryGit } from './git.js'
import * as claude from './claude.js'
import { listRefs } from './branches.js'
import { REF_PREFIX, pad } from './paths.js'

/**
 * Everything that must hold before claude-ultrareview-chunked spends anything. Each result carries
 * its own remedy, because a check that only says "no" makes the user guess.
 */
export function preflight (root, { ledger = null, forRun = false, claudeChecks = true } = {}) {
  const checks = []
  const add = (name, ok, detail, remedy, fatal = true) =>
    checks.push({ name, ok, detail, remedy, fatal })

  if (!isRepo(root)) {
    add('git repository', false, 'claude-ultrareview-chunked must run inside a git repository',
      'cd into one, run `git init`, or pass --repo <path>')
    return { checks, ok: false, exitCode: 3 }
  }
  add('git repository', true, root)

  const head = tryGit(['rev-parse', '--verify', 'HEAD'], { cwd: root })
  if (head.code !== 0) {
    add('HEAD', false, 'the repository has no commits',
      'make at least one commit — claude-ultrareview-chunked reviews committed content')
    return { checks, ok: false, exitCode: 3 }
  }
  add('HEAD', true, head.stdout.trim().slice(0, 8))

  if (/[/\\]\.claude[/\\]worktrees[/\\]claude-ultrareview-chunked-/.test(root)) {
    add('not recursing', false, 'this is a claude-ultrareview-chunked worktree',
      'run claude-ultrareview-chunked from the main checkout, not from one of its review worktrees')
    return { checks, ok: false, exitCode: 6 }
  }

  // A branch literally named `claude-ultrareview-chunked` makes every `claude-ultrareview-chunked/base-NNNN` impossible —
  // git cannot have both a ref and a directory of refs at the same path — and
  // the failure otherwise surfaces per chunk, mid-run, as raw git text.
  if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${REF_PREFIX}`], { cwd: root }).code === 0) {
    add('claude-ultrareview-chunked/ namespace', false, `a branch named \`${REF_PREFIX}\` blocks the \`${REF_PREFIX}/\` namespace`,
      `rename or delete it — git cannot hold both \`${REF_PREFIX}\` and \`${REF_PREFIX}/base-0001\``)
    return { checks, ok: false, exitCode: 3 }
  }

  // These are repository facts, so they belong above the Claude probes: `plan`,
  // `status` and `clean` are exactly the commands run after an interrupted
  // sweep, and they used to skip the stray-ref check entirely.
  const known = new Set()
  for (const c of ledger?.chunks ?? []) { known.add(`${REF_PREFIX}/base-${pad(c.id)}`); known.add(`${REF_PREFIX}/chunk-${pad(c.id)}`) }
  const strays = listRefs({ root }).filter(r => !known.has(r))
  if (strays.length) {
    add(`${REF_PREFIX}/ refs`, false, `${strays.length} ref(s) under ${REF_PREFIX}/ that this ledger does not own`,
      `inspect them, then \`claude-ultrareview-chunked clean --yes\`: ${strays.slice(0, 3).join(', ')}${strays.length > 3 ? '…' : ''}`,
      false)
  } else add(`${REF_PREFIX}/ refs`, true, 'clean')

  // Claude Code has to be there before anything else is worth doing — but the
  // free commands (plan, status, findings) do not need it, and probing costs a
  // subprocess, so they ask for the repository checks only.
  if (!claudeChecks) return finish(checks)

  if (!claude.isInstalled()) {
    add('claude code', false, `\`${claude.claudeBin()}\` not found or not runnable`,
      'install Claude Code (https://claude.com/claude-code), or point CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN at it')
    return { checks, ok: false, exitCode: 4 }
  }
  add('claude code', true, claude.version() ?? 'installed')

  if (!claude.supportsUltrareview()) {
    add('ultrareview support', false, 'this build has no `claude ultrareview` subcommand',
      'run `claude update` — ultrareview needs a recent Claude Code')
    return { checks, ok: false, exitCode: 4 }
  }
  add('ultrareview support', true, 'available')

  const auth = claude.authStatus()
  if (!auth.loggedIn) {
    add('authentication', false, auth.reason ?? 'not logged in',
      'run `claude /login` — ultrareview needs a claude.ai account, not an API key')
    return { checks, ok: false, exitCode: 4 }
  }
  add('authentication', true, auth.subscriptionType ? `claude.ai (${auth.subscriptionType})` : 'claude.ai')

  const dirty = tryGit(['status', '--porcelain'], { cwd: root }).stdout.trim()
  if (dirty) {
    add('working tree', true,
      `${dirty.split('\n').length} uncommitted change(s) — not included in any review`,
      'commit them first if you want them reviewed; claude-ultrareview-chunked reviews HEAD', false)
  } else add('working tree', true, 'clean')

  if (forRun && process.platform === 'win32') {
    add('platform', false, 'background runs are POSIX-only in this version',
      'run claude-ultrareview-chunked under WSL — the supervisor needs POSIX process groups')
  }

  return finish(checks)
}

function finish (checks) {
  const fatalFail = checks.find(c => !c.ok && c.fatal)
  return { checks, ok: !fatalFail, exitCode: fatalFail ? 4 : 0 }
}

/**
 * Who holds the run lock. One implementation, in `lock.js`.
 *
 * This used to be a second, subtly different copy of the predicate in
 * `supervisor.js` — and the two disagreeing about whether a stalled supervisor
 * counts as running is what let `plan` and `clean --yes` delete branches and
 * worktrees out from under a review that was still going.
 */
export { lockState as lockHolder } from './lock.js'
