import fs from 'node:fs'
import path from 'node:path'
import { repoRoot, shortSha } from './git.js'
import { layout, ensureDirs, pad } from './paths.js'
import { readLedger, writeLedger, runState } from './ledger.js'
import { survey, planFrom, drift } from './plan.js'
import { droppedSummary } from './scope.js'
import { preflight, lockHolder } from './preflight.js'
import { statusRows, doneRows, collectFindings } from './report.js'
import { launch, stopAll, MAX_CONCURRENCY, DEFAULT_TIMEOUT_MIN } from './supervisor.js'
import { dropPair, dropRef } from './branches.js'
import { removeWorktree, removeWorktreeDir, sweepable } from './worktree.js'
import { menu, confirm, toggleList, resolveIds, ask, closePrompt, isTTY } from './prompt.js'
import { c, say, out, num, table, paintStatus, costBand, sanitize } from './ui.js'

const MAX_PER_LAUNCH = MAX_CONCURRENCY

/**
 * The one entry point. Everything a person needs to do — see the plan, pick
 * chunks, spend, watch, read findings, tidy up — happens inside this loop, in
 * whatever order they want. No command has to be run before another.
 */
export async function guided (cwd) {
  if (!isTTY()) {
    say(c.red('curc needs a terminal for its guided mode.'))
    say('Use the subcommands instead — `curc --help`.')
    return 5
  }

  say('')
  say(c.bold('curc') + c.dim(' — chunked ultrareview'))

  // Claude Code has to be there before anything else is worth doing.
  const pre = preflight(cwd)
  renderPreflight(pre)
  if (!pre.ok) return pre.exitCode

  const root = repoRoot(cwd)
  const L = layout(root)
  ensureDirs(L)

  // The readline interface holds stdin open, so anything that leaves this
  // function without closing it leaves the process running on a real terminal
  // — where stdin never reaches EOF to end it for us.
  try {
    await offerGitignore(L)

    let ledger = readLedger(L)
    if (!ledger || !ledger.chunks?.length) ledger = await replan(L, ledger)
    if (!ledger) return 1

    for (;;) {
      // Re-read: a background run finishing moves chunks into the archive, and
      // the board would otherwise keep listing them as pending until a re-plan.
      ledger = readLedger(L) ?? ledger
      const d = drift(ledger, root)
      board(L, ledger, d)

      const choice = await menu('What now?', [
        { key: 'review', label: 'Review chunks', hint: `up to ${MAX_PER_LAUNCH} at a time — this spends money` },
        { key: 'watch', label: 'Check on running reviews' },
        { key: 'findings', label: 'Read findings' },
        { key: 'replan', label: 'Change scope / re-plan' },
        { key: 'clean', label: 'Clean up worktrees and branches' },
        { key: 'quit', label: 'Quit' }
      ])

      if (choice === 'quit') break
      if (choice === 'review') ledger = await doReview(L, ledger) ?? ledger
      else if (choice === 'watch') doWatch(L, ledger)
      else if (choice === 'findings') doFindings(L, ledger)
      else if (choice === 'replan') ledger = await replan(L, ledger) ?? ledger
      else if (choice === 'clean') await doClean(L)
    }

    say('')
    return 0
  } finally {
    closePrompt()
  }
}

/* ---- the board ---------------------------------------------------------- */

function board (L, ledger, d) {
  const rows = statusRows(L, ledger)
  const done = doneRows(L, ledger)
  const sup = lockHolder(L)

  say('')
  say(c.bold(`  ${path.basename(L.root)}`) + c.dim(`  @ ${shortSha(ledger.snapshot)}`))
  say(c.dim(`  scope     `) + (ledger.scope.include.length ? ledger.scope.include.join(', ') : 'whole repo'))
  say(c.dim(`  reviewed  `) + `${num(done.length)} chunk(s), ${num(Object.keys(ledger.reviewed).length)} files`)
  say(c.dim(`  pending   `) + `${num(rows.length)} chunk(s)` + (rows.length ? c.dim(`   est. ${costBand(rows.length)} to finish`) : ''))
  if (sup?.alive) say(c.cyan(`  running   supervisor pid ${sup.pid}`))
  if (d.state === 'drifted') {
    say(c.yellow(`  drift     HEAD is ${shortSha(d.head)}, plan was made at ${shortSha(d.snapshot)} — re-plan to pick up the changes`))
  }
  say('')

  if (!rows.length) { say(c.dim('  nothing pending — everything in scope has been reviewed')); return }
  const shown = rows.slice(0, 25)
  out(table(
    ['  #', 'files', 'lines', 'area', 'status'],
    shown.map(r => [`  ${r.label}`, num(r.files), num(r.lines), sanitize(r.area), paintStatus(r.state)]),
    { align: [null, 'r', 'r'] }
  ))
  if (rows.length > shown.length) {
    say(c.dim(`  … and ${rows.length - shown.length} more — any id is selectable, or \`curc status\` lists them all`))
  }
}

function renderPreflight (pre) {
  say('')
  for (const ck of pre.checks) {
    const mark = ck.ok ? c.green('✓') : c.red('✗')
    say(`  ${mark} ${ck.name}${ck.detail ? c.dim('  ' + ck.detail) : ''}`)
    if (!ck.ok && ck.remedy) say(`      ${c.yellow('→')} ${ck.remedy}`)
  }
}

/* ---- planning ----------------------------------------------------------- */

async function replan (L, ledger) {
  if (lockHolder(L)?.alive) {
    say(c.yellow('\n  A run is in flight. Stop it before re-planning.'))
    return ledger
  }

  say(c.dim('\n  surveying…'))
  let include = ledger?.scope?.include ?? []
  let exclude = ledger?.scope?.exclude ?? []
  let s = await survey(L.root, { include, exclude, reviewed: ledger?.reviewed ?? {} })

  if (s.dirs.length > 1) {
    const picked = await toggleList(
      `Scope — ${num(s.files.length)} files, ${num(s.files.reduce((n, f) => n + f.lines, 0))} lines`,
      s.dirs,
      {
        render: dd => `${dd.name.padEnd(24)} ${String(num(dd.files)).padStart(5)} files  ${String(num(dd.lines)).padStart(8)} lines`,
        selected: new Set(s.dirs.map((_, i) => i).filter(i => !include.length || include.includes(s.dirs[i].name)))
      }
    )
    if (!picked.length) { say(c.yellow('  nothing selected')); return ledger }
    include = includeFor(picked, s.files)
    s = await survey(L.root, { include, exclude, reviewed: ledger?.reviewed ?? {} })
  }

  // Driven off the buckets themselves, so a reason added later cannot go unsaid.
  const dropped = s.dropped
  const { total, parts } = droppedSummary(dropped)
  if (total) {
    say(c.dim(`  skipped ${total}: ${parts.map(p => `${p.count} ${p.name}`).join(', ')}`))
    for (const o of dropped.oversize.slice(0, 5)) say(c.dim(`    ${o.path} (${num(o.lines)} lines — no diff can hold it)`))
    for (const u of dropped.unreadable.slice(0, 5)) say(c.yellow(`    ${u.path} — ${u.reason} from the object store`))
  }

  // Pending chunks from the old plan are about to be renumbered; their refs go.
  for (const ch of ledger?.chunks ?? []) { dropPair(L, ch.id); removeWorktree(L, ch.id) }

  const next = planFrom(ledger, s, { include, exclude })
  writeLedger(L, next)
  say(c.green(`  planned ${next.chunks.length} chunk(s)`) +
    c.dim(` from ${num(s.coverage.files - s.coverage.covered)} unreviewed files` +
      (s.coverage.covered ? `; ${num(s.coverage.covered)} already covered` : '')))
  return next
}

/**
 * Turn the picked top-level buckets into git pathspecs.
 *
 * The '.' bucket is the repo's root-level files, which have no directory to
 * name. Dropping it — as this used to — means picking only root files yields
 * an empty include, and an empty include means the *whole repo*: the exact
 * opposite of the request. Picking '.' alongside `src` silently lost the root
 * files instead. Listing them individually says what was actually chosen.
 */
export function includeFor (picked, files) {
  const specs = []
  for (const p of picked) {
    if (p.name !== '.') { specs.push(p.name); continue }
    for (const f of files) if (!f.path.includes('/')) specs.push(f.path)
  }
  return specs
}

/* ---- reviewing ---------------------------------------------------------- */

async function doReview (L, ledger) {
  const rows = statusRows(L, ledger).filter(r => !['running', 'queued'].includes(r.state))
  if (!rows.length) { say(c.yellow('\n  nothing available to review')); return ledger }

  const sup = lockHolder(L)
  if (sup?.alive) {
    say(c.yellow(`\n  A run is already in flight (pid ${sup.pid}). Wait for it, or stop it first.`))
    return ledger
  }

  const pre = preflight(L.root, { ledger, forRun: true })
  if (!pre.ok) { renderPreflight(pre); return ledger }

  say('')
  say(c.dim(`  Pick up to ${MAX_PER_LAUNCH} chunks by the # in the table above.`))
  const spec = await ask(`  chunks (e.g. "${rows[0].id}", "${rows[0].id}-${rows[Math.min(2, rows.length - 1)].id}")`)
  const byId = new Map(rows.map(r => [r.id, r]))
  const sel = resolveIds(spec, [...byId.keys()])
  if (sel.malformed) { say(c.yellow('  could not read that — try 3, 3-5, 3,7, or all')); return ledger }
  if (sel.unknown.length) {
    say(c.yellow(`  no pending chunk with id ${sel.unknown.join(', ')} — the # column is the id`))
    return ledger
  }
  const picked = sel.ids.slice(0, MAX_PER_LAUNCH).map(id => byId.get(id))
  if (!picked.length) { say(c.yellow('  nothing selected')); return ledger }
  if (sel.ids.length > MAX_PER_LAUNCH) {
    say(c.dim(`  taking the first ${MAX_PER_LAUNCH} of ${sel.ids.length}: ${picked.map(r => r.id).join(', ')}`))
  }

  say('')
  out(table(
    ['  #', 'files', 'lines', 'area'],
    picked.map(r => [`  ${r.label}`, num(r.files), num(r.lines), r.area]),
    { align: [null, 'r', 'r'] }
  ))
  say('')
  say(`  ${picked.length} review(s) — estimated ${c.bold(costBand(picked.length))} in usage credits.`)
  say(c.dim('  The first 3 ultrareviews are free on Pro and Max; curc cannot see how many you have left.'))
  say(c.dim('  A run that starts and then fails still consumes one.'))

  if (!await confirm(`\n  ${c.bold('Start')} ${picked.length} review(s) and spend up to ${costBand(picked.length).split('–')[1]}?`)) {
    say(c.dim('  nothing started'))
    return ledger
  }

  const started = launch(L, {
    chunkIds: picked.map(r => r.id),
    concurrency: Math.min(MAX_PER_LAUNCH, picked.length),
    timeout: DEFAULT_TIMEOUT_MIN
  })
  if (!started.ok) { say(c.red(`\n  ${started.remedy ?? started.reason}`)); return ledger }

  const { runId, pid } = started
  say(c.green(`\n  started ${runId}`) + c.dim(` (supervisor pid ${pid})`))
  say(c.dim('  Reviews take 5–10 minutes each and keep running if you quit.'))
  return readLedger(L) ?? ledger
}

/* ---- watching, findings, cleanup ---------------------------------------- */

function doWatch (L, ledger) {
  const rows = statusRows(L, readLedger(L) ?? ledger)
  const active = rows.filter(r => ['running', 'queued', 'orphaned'].includes(r.state))
  const sup = lockHolder(L)
  say('')
  if (!sup?.alive && !active.length) { say(c.dim('  no run in flight')); return }
  if (sup?.alive) say(c.cyan(`  supervisor pid ${sup.pid}, heartbeat ${sup.heartbeatAgeSec}s ago`))
  for (const r of active) {
    const started = r.run?.startedAt ? `started ${new Date(r.run.startedAt).toLocaleTimeString()}` : 'queued'
    say(`  ${r.label}  ${paintStatus(r.state)}  ${c.dim(started)}${r.run?.sessionUrl ? '\n        ' + c.dim(r.run.sessionUrl) : ''}`)
  }
  say(c.dim(`\n  logs: ${path.relative(L.root, L.logs)}/`))
}

/** '?' hides why: a payload that would not parse is not the same as no findings. */
function findingsCell (r) {
  if (r.findingsParsed === false) return 'unreadable'
  return r.findings ?? '?'
}

function doFindings (L, ledger) {
  const fresh = readLedger(L) ?? ledger
  const done = doneRows(L, fresh)
  say('')
  if (!done.length) { say(c.dim('  no completed reviews yet')); return }
  out(table(
    ['  #', 'files', 'findings', 'area'],
    done.map(r => [`  ${r.label}`, num(r.files), findingsCell(r), sanitize(r.area)]),
    { align: [null, 'r', 'r'] }
  ))
  const unreadable = done.filter(r => r.findingsParsed === false)
  if (unreadable.length) {
    say(c.yellow(`\n  ${unreadable.length} chunk(s) returned a payload curc could not parse: ${unreadable.map(r => r.label).join(', ')}`))
    say(c.dim('  They still count as reviewed, so nothing re-bills — the raw output is on disk.'))
  }
  const all = collectFindings(L, fresh)
  say('')
  say(`  ${num(all.length)} finding(s) across ${done.length} chunk(s).`)
  say(c.dim(`  Full payloads: ${path.relative(L.root, L.findings)}/`))
  say(c.dim('  `curc findings --json` prints them all with chunk provenance.'))
}

async function doClean (L) {
  if (lockHolder(L)?.alive) { say(c.yellow('\n  A run is in flight — stop it first.')); return }
  const { refs, worktreeDirs } = sweepable(L)
  say('')
  if (!refs.length && !worktreeDirs.length) { say(c.dim('  nothing to clean')); return }
  say(`  ${refs.length} branch(es) under curc/, ${worktreeDirs.length} worktree(s).`)
  say(c.dim('  Findings and the ledger are kept.'))
  if (!await confirm('  Remove them?')) return
  // What was counted is what gets removed — see cmdClean.
  for (const name of worktreeDirs) removeWorktreeDir(L, name)
  for (const ref of refs) dropRef(L, ref)
  say(c.green(`  cleaned ${refs.length} branch(es), ${worktreeDirs.length} worktree(s)`))
}

/**
 * Both paths, not just the ledger.
 *
 * `.claude/worktrees/` holds up to three full checkouts of the repo during a
 * sweep. Untracked, they turn `git status` into noise, make preflight's
 * dirty-tree warning fire on curc's own output, and put a habitual
 * `git add -A` one keystroke from staging a copy of the entire tree.
 */
async function offerGitignore (L) {
  const gi = path.join(L.root, '.gitignore')
  const want = ['.claude/curc/', '.claude/worktrees/']
  let text = ''
  try { text = fs.readFileSync(gi, 'utf8') } catch {}

  const have = new Set(text.split('\n').map(l => l.trim()))
  const missing = want.filter(l => !have.has(l))
  if (!missing.length) return

  say('')
  const what = missing.map(l => c.bold(l)).join(' and ')
  if (!await confirm(`  Add ${what} to .gitignore? ${c.dim('(curc writes its state and review worktrees there)')}`, { default: true })) return
  fs.appendFileSync(gi, (text && !text.endsWith('\n') ? '\n' : '') +
    `\n# curc — chunked ultrareview state\n${missing.join('\n')}\n`)
  say(c.green(`  added ${missing.length} line(s)`))
}

export { stopAll, pad }
