import { parseArgs } from 'node:util'
import { repoRoot } from './git.js'
import { layout, ensureDirs } from './paths.js'
import { readLedger, writeLedger, runState } from './ledger.js'
import { survey, planFrom, drift } from './plan.js'
import { preflight, lockHolder } from './preflight.js'
import { snapshot as statusSnapshot, statusRows, collectFindings } from './report.js'
import { launch, supervise, stopAll } from './supervisor.js'
import { buildPair, dropPair, pairSize, listRefs } from './branches.js'
import { removeWorktree } from './worktree.js'
import { reviewArgv } from './claude.js'
import { guided } from './app.js'
import { c, say, out, num, table, paintStatus, costBand } from './ui.js'
import { resolveIds } from './prompt.js'

const VERSION = '0.1.0'

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
    default:
      say(c.red(`unknown command: ${cmd}`))
      usage()
      return 2
  }
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
  if (lockHolder(L)?.alive) { say(c.red('a run is in flight — `curc stop` first')); return 6 }
  const prev = readLedger(L)
  const s = await survey(L.root, {
    include: v.scope ?? prev?.scope?.include ?? [],
    exclude: v.exclude ?? prev?.scope?.exclude ?? [],
    maxFiles: v['max-files'] ? Number(v['max-files']) : undefined,
    maxLines: v['max-lines'] ? Number(v['max-lines']) : undefined,
    reviewed: prev?.reviewed ?? {}
  })
  for (const ch of prev?.chunks ?? []) { dropPair(L, ch.id); removeWorktree(L, ch.id) }
  const next = planFrom(prev, s, { include: v.scope ?? prev?.scope?.include ?? [], exclude: v.exclude ?? prev?.scope?.exclude ?? [] })
  writeLedger(L, next)

  if (v.json) {
    out(JSON.stringify({
      snapshot: next.snapshot,
      caps: next.caps,
      scope: next.scope,
      totals: { files: s.files.length, lines: s.files.reduce((n, f) => n + f.lines, 0), chunks: next.chunks.length },
      coverage: s.coverage,
      dropped: s.dropped,
      drift: drift(prev, L.root),
      costEstimateUsd: { low: next.chunks.length * 5, high: next.chunks.length * 25 },
      chunks: next.chunks.map(ch => ({ id: ch.id, files: ch.files.length, lines: ch.lines, paths: ch.files.map(f => f.path) }))
    }, null, 2))
    return 0
  }
  out(table(['#', 'files', 'lines'], next.chunks.map(ch => [ch.id, num(ch.files.length), num(ch.lines)]), { align: [null, 'r', 'r'] }))
  say(`\n${next.chunks.length} chunk(s), estimated ${costBand(next.chunks.length)}`)
  return 0
}

function cmdStatus (L, v) {
  const ledger = readLedger(L)
  if (!ledger) { say(c.yellow('no plan yet — run `curc plan`')); return 0 }
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
  for (const f of all) out(`  [chunk ${f._curc.chunkId}] ${f.title ?? f.summary ?? JSON.stringify(f).slice(0, 120)}`)
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

  if (v['dry-run']) {
    for (const id of ids) {
      const ch = ledger.chunks.find(x => x.id === id)
      buildPair(L, { id, snapshot: ledger.snapshot, snapshotTree: ledger.snapshotTree, files: ch.files })
      const size = pairSize(L, id)
      out(`chunk ${id}: ${size.files} files / ${size.lines} lines — claude ${reviewArgv(L.baseRef(id)).join(' ')}`)
      dropPair(L, id)
    }
    say(c.dim('\ndry run — nothing launched, nothing billed'))
    return 0
  }

  if (!v.yes) {
    say(c.red(`${ids.length} review(s) would cost ${costBand(ids.length)} in usage credits.`))
    say('Pass --yes to confirm. Nothing has been billed.')
    return 5
  }

  const { runId, pid } = launch(L, {
    chunkIds: ids,
    concurrency: Math.min(Number(v.concurrency ?? 3), 3),
    timeout: Number(v.timeout ?? 45)
  })
  if (v.json) out(JSON.stringify({ runId, supervisorPid: pid, chunks: ids, costEstimateUsd: { low: ids.length * 5, high: ids.length * 25 } }, null, 2))
  else say(c.green(`started ${runId}`) + c.dim(` (pid ${pid}) — \`curc status\` to follow`))
  return 0
}

function cmdStop (L) {
  const r = stopAll(L)
  say(r.stopped ? c.yellow(`stopped supervisor pid ${r.pid}`) : c.dim(r.reason))
  return 0
}

function cmdClean (L, v) {
  if (lockHolder(L)?.alive) { say(c.red('a run is in flight — `curc stop` first')); return 6 }
  const ledger = readLedger(L)
  const refs = listRefs(L)
  if (!v.yes) { say(`${refs.length} curc/ branch(es) would be removed. Pass --yes.`); return 5 }
  for (const ch of [...(ledger?.chunks ?? []), ...(ledger?.archive ?? [])]) { removeWorktree(L, ch.id); dropPair(L, ch.id) }
  say(c.green('cleaned'))
  return 0
}

function usage () {
  out(`curc ${VERSION} — chunked ultrareview for whole codebases (unofficial)

  curc                       guided, interactive — start here
  curc plan   [--scope s]    survey and chunk the repo (free)
  curc run    --chunks 1-3   launch reviews  ${c.red('(billed)')}  — needs --yes
  curc status                what is planned, running, done
  curc findings [--json]     findings from completed chunks
  curc stop                  stop the run in flight
  curc clean  --yes          remove curc worktrees and branches

  --json      machine-readable output      --repo <path>   act on another repo
  --dry-run   build and prove, launch nothing
  --yes       consent to spend (required when not a terminal)

Each chunk is one cloud ultrareview: $5–$25 in usage credits after the 3 free runs.
Not affiliated with Anthropic.`)
}
