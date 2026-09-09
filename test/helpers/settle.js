import fs from 'node:fs'
import { readLedger, readRun, runState, TERMINAL } from '../../src/ledger.js'
import { lockState } from '../../src/lock.js'

/**
 * Wait for a run to be genuinely over.
 *
 * Keyed on the supervisor releasing its lock, not on the run records: those
 * are written the moment a review exits, *before* the worktree and refs are
 * torn down, so waiting on them raced the teardown that several tests then
 * assert has happened.
 *
 * (The lock is now created by `launch` in the parent, before it returns, so
 * there is no longer a window where it does not yet exist — which is what the
 * earlier record-based wait was working around.)
 */
export async function settle (L, ids, ms = 30000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!lockState(L) && ids.every(id => TERMINAL.has(runState(readRun(L, id))))) return readLedger(L)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const states = ids.map(id => `${id}:${runState(readRun(L, id))}`).join(' ')
  throw new Error(
    `supervisor did not settle — ${states}\n` +
    `lock: ${JSON.stringify(lockState(L))}\n` +
    `supervisor log:\n${tail(L.supervisorLog)}`
  )
}

/** The last few log lines, so a timeout says why rather than just "queued". */
export function tail (p, n = 20) {
  try {
    return fs.readFileSync(p, 'utf8').trimEnd().split('\n').slice(-n).map(l => `  ${l}`).join('\n')
  } catch { return '  (no supervisor log)' }
}
