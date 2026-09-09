import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { layout, ensureDirs, pad } from './paths.js'
import { readLedger, writeLedger, patchRun, writeRun, readRun, recordCoverage, runState, TERMINAL } from './ledger.js'
import { buildPair, dropPair, pairSize } from './branches.js'
import { addWorktree, removeWorktree } from './worktree.js'
import * as claude from './claude.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
export const HARD_MAX_FILES = 500
export const HARD_MAX_LINES = 8000

/** Three reviews in flight is the ceiling, wherever the number comes from. */
export const MAX_CONCURRENCY = 3
/** Matches `claude ultrareview --timeout <minutes>`, whose own default is 45. */
export const DEFAULT_TIMEOUT_MIN = 45

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
  const runId = `r-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`
  const queue = { runId, chunkIds, concurrency, timeout, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(L.home, 'queue.json'), JSON.stringify(queue, null, 2))

  for (const id of chunkIds) writeRun(L, id, { chunkId: id, runId, queuedAt: queue.startedAt })

  const logFd = fs.openSync(L.supervisorLog, 'a')
  const child = spawn(process.execPath, [BIN, '__supervise', runId], {
    cwd: L.root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CURC_SUPERVISOR: '1' }
  })
  child.unref()
  return { runId, pid: child.pid }
}

/** Entry point for the detached process. Never called directly by a user. */
export async function supervise (root, runId) {
  const L = layout(root)
  ensureDirs(L)

  const lockFd = acquireLock(L, runId)
  if (!lockFd) { log(L, `another supervisor holds the lock; exiting`); return 1 }
  const beat = setInterval(() => { try { fs.utimesSync(L.lock, new Date(), new Date()) } catch {} }, 15000)
  beat.unref?.()

  const queue = JSON.parse(fs.readFileSync(path.join(L.home, 'queue.json'), 'utf8'))
  // Clamped here, not only in the callers: a concurrency the pump cannot honour
  // is a supervisor that starts nothing and exits without saying so.
  queue.concurrency = clampConcurrency(queue.concurrency)
  const pending = [...queue.chunkIds]
  const live = new Set()
  let stopping = false
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true })

  await new Promise(resolve => {
    const pump = () => {
      if (stopping || (pending.length === 0 && live.size === 0)) {
        if (live.size === 0) resolve()
        return
      }
      while (!stopping && live.size < queue.concurrency && pending.length) {
        const id = pending.shift()
        const p = runChunk(L, id, queue).finally(() => { live.delete(p); pump() })
        live.add(p)
      }
    }
    pump()
  })

  clearInterval(beat)
  releaseLock(L, lockFd)
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

    const dir = addWorktree(L, id)
    const outFd = fs.openSync(L.findingsFor(id), 'w')
    const errFd = fs.openSync(L.logFor(id), 'w')
    log(L, `chunk ${pad(id)}: ${size.files} files / ${size.lines} lines — starting review`)

    const exitCode = await new Promise(resolve => {
      const child = claude.spawnReview(L.baseRef(id), { cwd: dir, timeout: queue.timeout, outFd, errFd })
      patchRun(L, id, { pid: child.pid, diffFiles: size.files, diffLines: size.lines })
      child.on('error', () => resolve(1))
      child.on('close', code => resolve(code ?? 1))
    })
    fs.closeSync(outFd); fs.closeSync(errFd)

    const errText = safeRead(L.logFor(id))
    const raw = safeRead(L.findingsFor(id))
    patchRun(L, id, {
      finishedAt: now(),
      exitCode,
      sessionUrl: claude.sessionUrlFromLog(errText),
      findingCount: exitCode === 0 ? claude.countFindings(raw) : null,
      findingsPath: path.relative(L.root, L.findingsFor(id)),
      logPath: path.relative(L.root, L.logFor(id))
    })

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
    // Peak footprint is the concurrency limit, never the whole sweep.
    removeWorktree(L, id)
    if (runState(readRun(L, id)) === 'done') dropPair(L, id)
  }
}

/* ---- the one lock in the system: it guards the writer role, not a file ---- */

function acquireLock (L, runId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(L.lock, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, startedAt: now() }))
      return fd
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (!stale(L)) return null
      fs.rmSync(L.lock, { force: true })   // previous supervisor died; reclaim
    }
  }
  return null
}

function stale (L) {
  try {
    const rec = JSON.parse(fs.readFileSync(L.lock, 'utf8'))
    const age = (Date.now() - fs.statSync(L.lock).mtimeMs) / 1000
    try { process.kill(rec.pid, 0) } catch (e) { if (e.code !== 'EPERM') return true }
    return age > 60
  } catch { return true }
}

function releaseLock (L, fd) {
  try { fs.closeSync(fd) } catch {}
  fs.rmSync(L.lock, { force: true })
}

export function stopAll (L) {
  let rec
  try { rec = JSON.parse(fs.readFileSync(L.lock, 'utf8')) } catch { return { stopped: false, reason: 'no supervisor running' } }
  try { process.kill(-rec.pid, 'SIGTERM') } catch { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
  return { stopped: true, pid: rec.pid }
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
