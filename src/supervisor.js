import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { layout, ensureDirs, pad } from './paths.js'
import { readLedger, writeLedger, patchRun, writeRun, readRun, recordCoverage, runState, TERMINAL } from './ledger.js'
import { buildPair, dropPair, pairSize } from './branches.js'
import { addWorktree, removeWorktree } from './worktree.js'
import * as claude from './claude.js'
import * as lock from './lock.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
export const HARD_MAX_FILES = 500
export const HARD_MAX_LINES = 8000

/** Three reviews in flight is the ceiling, wherever the number comes from. */
export const MAX_CONCURRENCY = 3
/** Matches `claude ultrareview --timeout <minutes>`, whose own default is 45. */
export const DEFAULT_TIMEOUT_MIN = 45
/** How long past claude's own deadline curc waits before killing a review. */
export const WATCHDOG_GRACE_MIN = 5

/**
 * One supervisor per repo, not one per chunk.
 *
 * A fan-out of detached children cannot hold a queue: when chunk 1 finishes,
 * nobody is left to start chunk 4. The supervisor is the smallest thing that
 * can enforce "three at a time" across a fifty-chunk sweep, and it is also the
 * only writer of the ledger — which is why none of this needs a lock on it.
 */
export function launch (L, { chunkIds, concurrency, timeout }) {
  ensureDirs(L)
  fs.mkdirSync(L.queues, { recursive: true })

  // The reservation is taken here, in the parent, and before a single byte of
  // queue or run state is written. `wx` is one atomic syscall, so two `curc
  // run --yes` a millisecond apart serialise on it — the loser has not yet
  // touched anything to undo. Checking a lock and then launching, which is
  // what this used to do, leaves a window exactly wide enough to bill twice.
  const runId = newRunId()
  const claimed = lock.acquire(L, runId, null)
  if (!claimed.ok) return { ok: false, reason: claimed.reason, holder: claimed.holder, remedy: claimed.remedy }
  fs.closeSync(claimed.fd)

  const startedAt = new Date().toISOString()
  const queue = { runId, chunkIds, concurrency: clampConcurrency(concurrency), timeout, startedAt }
  fs.writeFileSync(queuePath(L, runId), JSON.stringify(queue, null, 2))
  for (const id of chunkIds) writeRun(L, id, { chunkId: id, runId, queuedAt: startedAt })

  const logFd = fs.openSync(L.supervisorLog, 'a')
  let child
  try {
    child = spawn(process.execPath, [BIN, '__supervise', runId], {
      cwd: L.root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CURC_SUPERVISOR: '1' }
    })
  } finally {
    // The parent's copy is no use to it; the child has its own.
    fs.closeSync(logFd)
  }

  // spawn reports failure asynchronously and the child is unref'd, so the
  // parent may well be gone before 'error' fires. A missing pid is the only
  // signal available in time to undo the reservation.
  if (child.pid === undefined) {
    lock.release(L, runId)
    fs.rmSync(queuePath(L, runId), { force: true })
    return { ok: false, reason: 'spawn-failed', remedy: 'could not start the supervisor process' }
  }

  // The parent already has the pid, so the child never has to adopt the lock —
  // which keeps a pid-less record from ever existing for anything to misread.
  lock.attachPid(L, runId, child.pid)
  child.unref()
  return { ok: true, runId, pid: child.pid }
}

/** Ids carry a random tail: one-second resolution collides, and two runs sharing an id share a queue file. */
function newRunId () {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  return `r-${stamp}Z-${randomBytes(3).toString('hex')}`
}

const queuePath = (L, runId) => path.join(L.queues, `${runId}.json`)

/** Entry point for the detached process. Never called directly by a user. */
export async function supervise (root, runId) {
  if (!runId) { process.stderr.write('curc __supervise: no run id\n'); return 2 }
  const L = layout(root)
  ensureDirs(L)

  // The parent reserved this lock under this runId. The child only ever
  // verifies; it never creates one, so a supervisor started by hand against a
  // run it does not own cannot take the lock away from the one that does.
  if (!lock.owns(L, runId)) {
    log(L, `run ${runId}: the lock belongs to someone else; standing down`)
    return 1
  }

  let queue
  try {
    queue = JSON.parse(fs.readFileSync(queuePath(L, runId), 'utf8'))
  } catch (e) {
    log(L, `run ${runId}: cannot read its queue (${e.message}); standing down`)
    lock.release(L, runId)
    return 2
  }

  // Clamped here, not only in the callers: a concurrency the pump cannot
  // honour is a supervisor that starts nothing and exits without a word.
  queue.concurrency = clampConcurrency(queue.concurrency)

  let stopping = false
  const beat = setInterval(() => {
    // A lost lock means someone else is the writer now. Stop taking new work
    // rather than keep a stranger's lock warm.
    if (!lock.heartbeat(L, runId)) {
      log(L, `run ${runId}: lost the lock; standing down`)
      stopping = true
    }
  }, lock.HEARTBEAT_MS)
  beat.unref?.()

  const pending = [...queue.chunkIds]
  const live = new Set()
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true })
  process.on('unhandledRejection', e => log(L, `run ${runId}: unhandled rejection ${e?.message ?? e}`))

  await new Promise(resolve => {
    const pump = () => {
      if (stopping || (pending.length === 0 && live.size === 0)) {
        if (live.size === 0) resolve()
        return
      }
      while (!stopping && live.size < queue.concurrency && pending.length) {
        const id = pending.shift()
        // Teardown can throw; a rejection here would take the whole sweep down.
        const p = runChunk(L, id, queue)
          .catch(e => log(L, `chunk ${pad(id)}: ${e?.message ?? e}`))
          .finally(() => { live.delete(p); pump() })
        live.add(p)
      }
    }
    pump()
  })

  clearInterval(beat)
  lock.release(L, runId)
  fs.rmSync(queuePath(L, runId), { force: true })
  log(L, `run ${runId} finished`)
  return 0
}

/**
 * The whole life of one chunk: build the pair, prove it, check it against the
 * hard caps, review it, record the outcome, tear it down. The record is
 * written before teardown, so a crash between them loses nothing.
 */
async function runChunk (L, id, queue) {
  const ledger = readLedger(L)
  const chunk = ledger?.chunks.find(c => c.id === id)
  if (!chunk) return patchRun(L, id, { finishedAt: now(), exitCode: 1, reason: 'chunk not in ledger' })

  patchRun(L, id, { startedAt: now(), supervisorPid: process.pid, snapshot: ledger.snapshot })

  try {
    buildPair(L, { id, snapshot: ledger.snapshot, snapshotTree: ledger.snapshotTree, files: chunk.files })

    // Last line of defence between a chunker bug and a wasted review.
    const size = pairSize(L, id)
    if (size.files > HARD_MAX_FILES || size.lines > HARD_MAX_LINES) {
      dropPair(L, id)
      return patchRun(L, id, {
        finishedAt: now(), exitCode: 1, reason: 'cap-exceeded',
        detail: `${size.files} files / ${size.lines} lines exceeds ${HARD_MAX_FILES}/${HARD_MAX_LINES}`
      })
    }

    // The claim, not the lock, is what actually makes double-billing
    // impossible. It is one atomic `wx` immediately before the only line in
    // curc that spends money, so however the lock reasoning above is wrong —
    // now or after some later edit — the worst outcome is a chunk that goes
    // unreviewed, never one that is paid for twice.
    if (!claimChunk(L, id)) {
      log(L, `chunk ${pad(id)}: already claimed by another run; skipping`)
      return patchRun(L, id, { finishedAt: now(), exitCode: 1, reason: 'already-claimed' })
    }

    const dir = addWorktree(L, id)
    const outFd = fs.openSync(L.findingsFor(id), 'w')
    const errFd = fs.openSync(L.logFor(id), 'w')
    log(L, `chunk ${pad(id)}: ${size.files} files / ${size.lines} lines — starting review`)

    let timedOut = false
    const { exitCode, signal } = await new Promise(resolve => {
      const child = claude.spawnReview(L.baseRef(id), { cwd: dir, timeout: queue.timeout, outFd, errFd })
      patchRun(L, id, { pid: child.pid, diffFiles: size.files, diffLines: size.lines })

      // claude takes its own --timeout in minutes, but nothing made it keep to
      // it: a review that never returns held a concurrency slot and the lock
      // for as long as the process lived. This is the outer bound.
      const bound = watchdogMs(queue.timeout)
      const watchdog = setTimeout(() => {
        timedOut = true
        log(L, `chunk ${pad(id)}: past ${Math.round(bound / 1000)}s — stopping the review`)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.()
      }, bound)
      watchdog.unref?.()

      child.on('error', () => { clearTimeout(watchdog); resolve({ exitCode: 1, signal: null }) })
      child.on('close', (code, sig) => { clearTimeout(watchdog); resolve({ exitCode: code ?? 1, signal: sig ?? null }) })
    })
    fs.closeSync(outFd); fs.closeSync(errFd)

    const errText = safeRead(L.logFor(id))
    const raw = safeRead(L.findingsFor(id))
    const findingCount = exitCode === 0 ? claude.countFindings(raw) : null
    patchRun(L, id, {
      finishedAt: now(),
      exitCode,
      signal,
      reason: timedOut ? 'timeout' : undefined,
      sessionUrl: claude.sessionUrlFromLog(errText),
      findingCount,
      // Coverage is still recorded on a clean exit, so nothing silently
      // re-bills — but a payload nobody could parse is worth saying out loud
      // rather than counting as a reviewed chunk with "?" findings.
      findingsParsed: exitCode === 0 ? findingCount !== null : null,
      findingsPath: path.relative(L.root, L.findingsFor(id)),
      logPath: path.relative(L.root, L.logFor(id))
    })
    if (exitCode === 0 && findingCount === null) {
      log(L, `chunk ${pad(id)}: exit 0 but the findings payload did not parse`)
    }

    if (exitCode === 0) {
      const fresh = readLedger(L)
      recordCoverage(fresh, chunk, queue.runId)
      fresh.archive = [...(fresh.archive ?? []), {
        id, lines: chunk.lines, files: chunk.files, snapshot: fresh.snapshot, runId: queue.runId, at: now()
      }]
      fresh.chunks = fresh.chunks.filter(c => c.id !== id)
      writeLedger(L, fresh)
    }
    log(L, `chunk ${pad(id)}: exit ${exitCode}`)
  } catch (e) {
    patchRun(L, id, { finishedAt: now(), exitCode: 1, reason: 'error', detail: String(e.message ?? e) })
    log(L, `chunk ${pad(id)}: ${e.message}`)
  } finally {
    // Peak footprint is the concurrency limit, never the whole sweep. Teardown
    // failing is not a reason to lose the sweep, so it is reported, not thrown.
    try { removeWorktree(L, id) } catch (e) { log(L, `chunk ${pad(id)}: worktree teardown — ${e.message}`) }
    try { if (runState(readRun(L, id)) === 'done') dropPair(L, id) } catch (e) {
      log(L, `chunk ${pad(id)}: ref teardown — ${e.message}`)
    }
  }
}

/**
 * Claim a chunk for review, atomically, or report that someone else has it.
 *
 * Deliberately never released: a claim records that this chunk has been paid
 * for once, which stays true after the run that paid ends.
 */
function claimChunk (L, id) {
  try {
    fs.closeSync(fs.openSync(path.join(L.runs, `${pad(id)}.claim`), 'wx'))
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}

/**
 * curc's own bound on a review, in ms — a little beyond the deadline claude
 * was given, so claude gets to finish on its own terms first.
 *
 * CURC_WATCHDOG_MS overrides it outright. The real bound is the better part of
 * an hour, which no test can wait for, and the same seam that makes it
 * testable also lets someone shorten it without a release.
 */
export function watchdogMs (timeout) {
  const override = Number(process.env.CURC_WATCHDOG_MS)
  if (Number.isFinite(override) && override > 0) return override
  const t = Number(timeout)
  return ((Number.isInteger(t) && t > 0 ? t : DEFAULT_TIMEOUT_MIN) + WATCHDOG_GRACE_MIN) * 60_000
}

/**
 * Ask the supervisor to stop. Reports what actually happened rather than
 * assuming, and never negates a pid it has not checked — `-0` is a valid
 * integer and `kill(-0, …)` signals the caller's own process group, which
 * would make `curc stop` take down the shell it was typed into.
 */
export function stopAll (L) {
  const holder = lock.lockState(L)
  if (!holder) return { stopped: false, reason: 'no supervisor running' }
  if (holder.pid === null) return { stopped: false, reason: 'a run is starting but has no pid yet', holder }

  // The supervisor is a process-group leader (spawn --detached), so the
  // negated pid reaches the reviews it started as well as the supervisor.
  const sent = kill(-holder.pid) || kill(holder.pid)
  return sent
    ? { stopped: true, pid: holder.pid, runId: holder.runId }
    : { stopped: false, reason: `could not signal pid ${holder.pid}`, holder }
}

function kill (pid, sig = 'SIGTERM') {
  try { process.kill(pid, sig); return true } catch { return false }
}

/** `curc unlock` — the deliberate act that replaced automatic reclaiming. */
export function unlock (L) {
  return lock.forceUnlock(L)
}

export function clampConcurrency (n) {
  const i = Number(n)
  if (!Number.isInteger(i) || i < 1) return 1
  return Math.min(i, MAX_CONCURRENCY)
}

const now = () => new Date().toISOString()
const safeRead = p => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
function log (L, msg) {
  try { fs.appendFileSync(L.supervisorLog, `${now()} ${msg}\n`) } catch {}
}
export { TERMINAL }
