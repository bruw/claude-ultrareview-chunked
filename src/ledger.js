import fs from 'node:fs'
import path from 'node:path'
import { pad } from './paths.js'

export const LEDGER_VERSION = 1

export function emptyLedger () {
  return {
    version: LEDGER_VERSION,
    tool: 'curc',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    snapshot: null,
    snapshotTree: null,
    caps: {},
    scope: { include: [], exclude: [] },
    nextId: 1,
    chunks: [],
    reviewed: {}
  }
}

export function readLedger (L) {
  try {
    const l = JSON.parse(fs.readFileSync(L.ledger, 'utf8'))
    return l.version === LEDGER_VERSION ? l : null
  } catch { return null }
}

export function writeLedger (L, ledger) {
  ledger.updatedAt = new Date().toISOString()
  writeJsonAtomic(L.ledger, ledger)
}

/* ---- run records -------------------------------------------------------- */
/* One file per chunk, written by the supervisor the moment a review exits and
   before any teardown. That is what lets `status` report a finished run long
   after the process that launched it is gone — nothing polls, the supervisor
   records its own outcome. */

export function runPath (L, id) {
  return path.join(L.runs, `${pad(id)}.json`)
}

export function readRun (L, id) {
  try { return JSON.parse(fs.readFileSync(runPath(L, id), 'utf8')) } catch { return null }
}

export function writeRun (L, id, rec) {
  writeJsonAtomic(runPath(L, id), rec)
}

export function patchRun (L, id, patch) {
  writeRun(L, id, { ...(readRun(L, id) ?? {}), ...patch })
}

export function isAlive (pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * State is derived, never stored as one field: a record with no outcome and a
 * dead pid is a crash, not a run still in flight.
 */
export function runState (rec) {
  if (!rec) return 'pending'
  if (rec.finishedAt) {
    if (rec.exitCode === 0) return 'done'
    // The watchdog says so explicitly, and it must be asked first: killing a
    // review looks exactly like any other signalled death from the outside.
    if (rec.reason === 'timeout') return 'timeout'
    // Stopped, rather than broken. SIGINT exits 130, but `curc stop` sends
    // SIGTERM — 143, or no code at all and a signal instead, depending on how
    // the child was reaped.
    if (rec.signal || rec.exitCode === 130 || rec.exitCode === 143) return 'interrupted'
    return 'failed'
  }
  if (rec.startedAt) return isAlive(rec.supervisorPid) ? 'running' : 'orphaned'
  return 'queued'
}

export const TERMINAL = new Set(['done', 'failed', 'timeout', 'interrupted'])

/* ---- coverage ----------------------------------------------------------- */

/**
 * Coverage is keyed by blob sha, not by path or chunk number. Git content-
 * addresses blobs, so a file that moved but did not change keeps its sha and
 * stays covered for free, while an edited file gets a new sha and re-enters
 * the plan on its own. Chunk boundaries can shift under a re-plan without
 * costing a single review, because nothing ever referred to them.
 *
 * Two byte-identical files collapse to one entry — same content, same bugs —
 * which is documented rather than worked around.
 */
export function classifyChunk (chunk, reviewed) {
  let seen = 0
  for (const f of chunk.files) if (reviewed[f.blob]) seen++
  if (seen === chunk.files.length) return 'covered'
  return seen === 0 ? 'new' : 'partial'
}

export function recordCoverage (ledger, chunk, runId) {
  const at = new Date().toISOString()
  for (const f of chunk.files) {
    ledger.reviewed[f.blob] = { path: f.path, chunk: chunk.id, runId, at }
  }
}

export function coverageStats (files, reviewed) {
  let covered = 0
  let coveredLines = 0
  for (const f of files) if (reviewed[f.blob]) { covered++; coveredLines += f.lines }
  return { files: files.length, covered, coveredLines }
}

function writeJsonAtomic (p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, p)
}
