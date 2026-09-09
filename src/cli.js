import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { repoRoot } from './git.js'
import { layout, ensureDirs } from './paths.js'
import { readLedger, writeLedger, ledgerStatus } from './ledger.js'
import { survey, planFrom, drift } from './plan.js'
import { preflight, lockHolder } from './preflight.js'
import { snapshot as statusSnapshot, statusRows, collectFindings } from './report.js'
import { launch, supervise, stopAll, unlock, MAX_CONCURRENCY, DEFAULT_TIMEOUT_MIN } from './supervisor.js'
import { buildPair, dropPair, dropRef, pairSize } from './branches.js'
import { removeWorktree, removeWorktreeDir, sweepable } from './worktree.js'
import { reviewArgv } from './claude.js'
import { guided } from './app.js'
import { c, say, out, num, table, paintStatus, costBand, costRange, sanitize } from './ui.js'
import { resolveIds } from './prompt.js'
import { withLock } from './lock.js'

// One source of truth: the version lived here, in package.json, and in two
// plugin manifests, which is three chances to forget one.
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  repo: { type: 'string' },
  scope: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'max-files': { type: 'string' },
  'max-lines': { type: 'string' },
  chunks: { type: 'string' },
  concurrency: { type: 'string' },
  timeout: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  yes: { type: 'boolean' },
  all: { type: 'boolean' }
}

export async function main (argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (e) {
    say(c.red(e.message))
    return 2
  }
  const { values: v, positionals } = parsed
  const cmd = positionals[0]

  if (v.version) { out(VERSION); return 0 }
  if (v.help || cmd === 'help') { usage(); return 0 }

  const cwd = v.repo ?? process.cwd()

  if (cmd === '__supervise') return supervise(repoRoot(cwd), positionals[1])
  if (!cmd) return guided(cwd)

  // Every command below reads git state, so the repository checks run before
  // any of them — an unborn HEAD must say so, not "nothing planned".
  const repoOk = preflight(cwd, { claudeChecks: false })
  if (!repoOk.ok) {
    for (const ck of repoOk.checks.filter(x => !x.ok)) say(`${c.red('✗')} ${ck.name}: ${ck.detail}\n  ${c.yellow('→')} ${ck.remedy}`)
    return repoOk.exitCode
  }

  const L = layout(repoRoot(cwd))
  ensureDirs(L)

  switch (cmd) {
    case 'plan': return cmdPlan(L, v)
    case 'status': return cmdStatus(L, v)
    case 'findings': return cmdFindings(L, v)
    case 'run': return cmdRun(L, v)
    case 'stop': return cmdStop(L, v)
    case 'clean': return cmdClean(L, v)
    case 'unlock': return cmdUnlock(L, v)
    default:
      say(c.red(`unknown command: ${cmd}`))
      usage()
      return 2
  }
}

/* ---- argument handling -------------------------------------------------- */

/** A flag that failed validation, reported by name rather than as a symptom. */
class BadFlag extends Error {
  constructor (msg) { super(msg); this.exitCode = 2 }
}

/**
 * An integer flag, or a refusal naming the flag.
 *
 * Coercing silently is how `--concurrency 0` became a supervisor that started
 * nothing and exited without a word, and `--timeout soon` became a literal
 * `--timeout null` on a billed command line.
 */
function intArg (name, raw, { min = 1, max = Infinity, fallback } = {}) {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = max === Infinity ? `an integer >= ${min}` : `an integer ${min}-${max}`
    throw new BadFlag(`--${name} needs ${range}, got ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * Pathspec flags accept both documented shapes: repeated flags, and one flag
 * carrying a comma-separated list. `--scope src,tests` is what the README has
 * always shown, and it used to be read as a single pathspec literally named
 * "src,tests", which matches nothing and plans zero chunks without complaint.
 */
function pathspecs (values) {
  if (!values) return undefined
  return values.flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean)
}

/* ---- commands ----------------------------------------------------------- */

/**
 * Why a --chunks spec selected nothing usable, or null if it is fine.
 *
 * An unknown id is refused rather than skipped: every number curc prints is a
 * chunk id, so a spec naming one that is not there means the caller and the
 * plan disagree — and quietly reviewing the rest bills for chunks nobody chose.
 */
function whyNot (r, available, noun) {
  const list = available.length ? available.join(', ') : '(none)'
  if (r.malformed) return `could not read --chunks — try 1, 1-3, 1,4, or all\n${noun}: ${list}`
  if (r.unknown.length) return `no ${noun} chunk with id ${r.unknown.join(', ')}\n${noun}: ${list}`
  if (!r.ids.length) return `--chunks selected nothing\n${noun}: ${list}`
  return null
}

async function cmdPlan (L, v) {
  const maxFiles = intArg('max-files', v['max-files'])
  const maxLines = intArg('max-lines', v['max-lines'])
  // Held for the whole of it, survey included: a run that starts during the
  // survey would otherwise have its refs and worktree deleted by the re-plan.
  const r = await withLock(L, `plan-${process.pid}`, async () => {
    const prev = readLedger(L)
    const include = pathspecs(v.scope) ?? prev?.scope?.include ?? []
    const exclude = pathspecs(v.exclude) ?? prev?.scope?.exclude ?? []
    const s = await survey(L.root, { include, exclude, maxFiles, maxLines, reviewed: prev?.reviewed ?? {} })
    for (const ch of prev?.chunks ?? []) { dropPair(L, ch.id); removeWorktree(L, ch.id) }
    const next = planFrom(prev, s, { include, exclude })
    writeLedger(L, next)
    return { s, next }
  })
  if (!r.ok) { say(c.red(r.remedy ?? 'a run is in flight — `curc stop` first')); return 6 }
  const { s, next } = r.value

  if (v.json) {
    out(JSON.stringify({
      snapshot: next.snapshot,
      caps: next.caps,
      scope: next.scope,
      totals: { files: s.files.length, lines: s.files.reduce((n, f) => n + f.lines, 0), chunks: next.chunks.length },
      coverage: s.coverage,
      dropped: s.dropped,
      drift: drift(next, L.root),
      costEstimateUsd: costRange(next.chunks.length),
      chunks: next.chunks.map(ch => ({ id: ch.id, files: ch.files.length, lines: ch.lines, paths: ch.files.map(f => f.path) }))
    }, null, 2))
    return 0
  }
  out(table(['#', 'files', 'lines'], next.chunks.map(ch => [ch.id, num(ch.files.length), num(ch.lines)]), { align: [null, 'r', 'r'] }))
  say(`\n${next.chunks.length} chunk(s), estimated ${costBand(next.chunks.length)}`)
  return 0
}

/**
 * "No plan yet" and "a plan this build cannot read" are not the same news —
 * the second is a sweep somebody paid for, and saying nothing about it is how
 * a coverage record looks like it evaporated.
 */
function noLedger (L) {
  const st = ledgerStatus(L)
  if (st.state === 'version-mismatch') {
    return `the ledger here is version ${st.found ?? '?'} and this curc writes ${st.expected}, ` +
      'so its coverage cannot be read — `curc plan` will start a fresh one'
  }
  if (st.state === 'unreadable') {
    return 'the ledger here could not be parsed — `curc plan` will start a fresh one'
  }
  return 'no plan yet — run `curc plan`'
}

function cmdStatus (L, v) {
  const ledger = readLedger(L)
  if (!ledger) { say(c.yellow(noLedger(L))); return 0 }
  const snap = statusSnapshot(L, ledger)
  if (v.json) { out(JSON.stringify(snap, null, 2)); return 0 }
  out(table(['#', 'files', 'lines', 'area', 'status'],
    snap.pending.map(r => [r.label, num(r.files), num(r.lines), r.area, paintStatus(r.state)]),
    { align: [null, 'r', 'r'] }))
  say(`\n${snap.completed.length} done, ${snap.pending.length} pending`)
  return 0
}

function cmdFindings (L, v) {
  const ledger = readLedger(L)
  const done = (ledger?.archive ?? []).map(a => a.id)
  let ids = null
  if (v.chunks) {
    const r = resolveIds(v.chunks, done)
    const bad = whyNot(r, done, 'reviewed')
    if (bad) { say(c.red(bad)); return 2 }
    ids = r.ids
  }
  const all = collectFindings(L, ledger, ids)
  if (v.json) { out(JSON.stringify(all, null, 2)); return 0 }
  say(`${all.length} finding(s)`)
  for (const f of all) out(sanitize(`  [chunk ${f._curc.chunkId}] ${f.title ?? f.summary ?? JSON.stringify(f).slice(0, 120)}`))
  return 0
}

async function cmdRun (L, v) {
  const ledger = readLedger(L)
  if (!ledger?.chunks?.length) { say(c.yellow('nothing planned — run `curc plan`')); return 0 }

  const pre = preflight(L.root, { ledger, forRun: true })
  if (!pre.ok) {
    for (const ck of pre.checks.filter(x => !x.ok)) say(`${c.red('✗')} ${ck.name}: ${ck.detail}\n  → ${ck.remedy}`)
    return pre.exitCode
  }
  if (lockHolder(L)?.alive) { say(c.red('a run is already in flight — `curc status`')); return 6 }

  const rows = statusRows(L, ledger)
  const planned = rows.map(r => r.id)
  if (!v.chunks) {
    say(c.red('which chunks? pass --chunks (e.g. --chunks 1-3, --chunks all)'))
    say(c.dim(`planned: ${planned.join(', ')}`))
    return 5
  }
  const picked = resolveIds(v.chunks, planned)
  const bad = whyNot(picked, planned, 'planned')
  if (bad) { say(c.red(bad)); return 2 }
  const ids = picked.ids

  // A chunk that is queued, or that has ever been launched — running,
  // orphaned, failed, timed out, interrupted — may already have been paid for:
  // a review that starts and then dies still consumes a run, and the cloud
  // side does not care that curc lost track. Without --force the claim file
  // refuses the spend anyway; saying so here is better than watching a chunk
  // come back "already-claimed".
  if (!v.force) {
    const risky = rows.filter(r => ids.includes(r.id) && (r.claimed || ['running', 'queued', 'orphaned'].includes(r.state)))
    if (risky.length) {
      say(c.red(`${risky.length} chunk(s) may already have been billed:`))
      for (const r of risky) say(`  ${r.label}  ${r.state}${r.claimed && !['running', 'queued'].includes(r.state) ? '  (a review was launched for this content before)' : ''}`)
      say('`curc status` to look, or --force to review them again anyway.')
      return 6
    }
  }

  const concurrency = intArg('concurrency', v.concurrency, { min: 1, max: MAX_CONCURRENCY, fallback: MAX_CONCURRENCY })
  const timeout = intArg('timeout', v.timeout, { min: 1, fallback: DEFAULT_TIMEOUT_MIN })

  if (v['dry-run']) {
    const proved = []
    for (const id of ids) {
      const ch = ledger.chunks.find(x => x.id === id)
      buildPair(L, { id, snapshot: ledger.snapshot, snapshotTree: ledger.snapshotTree, files: ch.files })
      const size = pairSize(L, id)
      const argv = reviewArgv(L.baseRef(id), { timeout })
      proved.push({ id, files: size.files, lines: size.lines, argv })
      if (!v.json) out(`chunk ${id}: ${size.files} files / ${size.lines} lines — claude ${argv.join(' ')}`)
      dropPair(L, id)
    }
    if (v.json) out(JSON.stringify({ dryRun: true, chunks: proved, costEstimateUsd: costRange(ids.length) }, null, 2))
    say(c.dim('\ndry run — nothing launched, nothing billed'))
    return 0
  }

  if (!v.yes) {
    say(c.red(`${ids.length} review(s) would cost ${costBand(ids.length)} in usage credits.`))
    say('Pass --yes to confirm. Nothing has been billed.')
    return 5
  }

  const started = launch(L, { chunkIds: ids, concurrency, timeout, force: Boolean(v.force) })
  if (!started.ok) { say(c.red(started.remedy ?? started.reason)); return 6 }

  const { runId, pid } = started
  if (v.json) out(JSON.stringify({ runId, supervisorPid: pid, chunks: ids, costEstimateUsd: costRange(ids.length) }, null, 2))
  else say(c.green(`started ${runId}`) + c.dim(` (pid ${pid}) — \`curc status\` to follow`))
  return 0
}

/**
 * Clear a lock nobody is using.
 *
 * curc never reclaims a lock on its own: the check-then-unlink that would be
 * needed cannot be made atomic, and two supervisors both deciding a lock is
 * stale is a double-billed sweep. So a wedged repo is cleared here, by someone
 * who can see the holder is gone.
 */
function cmdUnlock (L, v) {
  const held = lockHolder(L)
  if (!held) { say(c.dim('no lock to clear')); return 0 }
  if (held.alive && !v.yes) {
    say(c.red(`run ${held.runId ?? '?'} still looks alive (pid ${held.pid ?? '?'}, heartbeat ${held.heartbeatAgeSec}s ago)`))
    say('`curc stop` first — or `curc unlock --yes` if you are certain it is gone.')
    return 6
  }
  const r = unlock(L)
  say(r.removed ? c.yellow(`cleared the lock from ${r.holder.runId ?? 'an earlier run'}`) : c.dim(r.reason))
  return 0
}

function cmdStop (L) {
  const r = stopAll(L)
  say(r.stopped ? c.yellow(`stopped supervisor pid ${r.pid}`) : c.dim(r.reason))
  return 0
}

function cmdClean (L, v) {
  if (lockHolder(L)?.alive) { say(c.red('a run is in flight — `curc stop` first')); return 6 }
  const { refs, worktreeDirs } = sweepable(L)
  if (!refs.length && !worktreeDirs.length) { say(c.dim('nothing to clean')); return 0 }
  if (!v.yes) {
    say(`${refs.length} curc/ branch(es) and ${worktreeDirs.length} worktree(s) would be removed. Pass --yes.`)
    say(c.dim('findings and the ledger are kept'))
    return 5
  }
  // Driven off what is actually in the repository, not off the ledger: a
  // re-plan renumbers chunks, so the refs worth cleaning are precisely the
  // ones no ledger entry points at any more.
  for (const name of worktreeDirs) removeWorktreeDir(L, name)
  for (const ref of refs) dropRef(L, ref)
  say(c.green(`cleaned ${refs.length} branch(es), ${worktreeDirs.length} worktree(s)`))
  return 0
}

function usage () {
  out(`curc ${VERSION} — chunked ultrareview for whole codebases (unofficial)

  curc                       guided, interactive — start here
  curc plan   [--scope s]    survey and chunk the repo (free)
  curc run    --chunks 3-5   launch reviews  ${c.red('(billed)')}  — needs --yes
  curc status                what is planned, running, done
  curc findings [--json]     findings from completed chunks
  curc stop                  stop the run in flight
  curc clean  --yes          remove curc worktrees and branches
  curc unlock                clear a lock left behind by a dead supervisor

  --chunks    chunk ids, the numbers in the # column: 3, 3-5, 3,7, all
  --scope     --scope src,tests  or  --scope src --scope tests
  --json      machine-readable output      --repo <path>   act on another repo
  --dry-run   build and prove, launch nothing
  --force     review a chunk that may already have been billed
  --yes       consent to spend; run never prompts, and without it nothing starts

Each chunk is one cloud ultrareview: $5–$25 in usage credits after the 3 free runs.
Not affiliated with Anthropic.`)
}
