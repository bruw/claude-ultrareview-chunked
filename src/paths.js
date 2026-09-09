import path from 'node:path'
import fs from 'node:fs'

export const REF_PREFIX = 'curc'

/** Everything curc writes into a target repo, in one place. */
export function layout (root) {
  const home = path.join(root, '.claude', 'curc')
  return {
    root,
    home,
    ledger: path.join(home, 'ledger.json'),
    lock: path.join(home, 'supervisor.lock'),
    runs: path.join(home, 'runs'),
    queues: path.join(home, 'queues'),
    findings: path.join(home, 'findings'),
    logs: path.join(home, 'logs'),
    tmp: path.join(home, 'tmp'),
    supervisorLog: path.join(home, 'logs', 'supervisor.log'),
    worktrees: path.join(root, '.claude', 'worktrees'),
    worktreeFor: id => path.join(root, '.claude', 'worktrees', `curc-${pad(id)}`),
    baseRef: id => `${REF_PREFIX}/base-${pad(id)}`,
    chunkRef: id => `${REF_PREFIX}/chunk-${pad(id)}`,
    findingsFor: id => path.join(home, 'findings', `${pad(id)}.json`),
    logFor: id => path.join(home, 'logs', `${pad(id)}.log`)
  }
}

export function ensureDirs (L) {
  for (const d of [L.home, L.runs, L.queues, L.findings, L.logs, L.tmp]) fs.mkdirSync(d, { recursive: true })
}

/**
 * Chunk ids are monotonic across re-plans and never reused, so a re-chunked
 * repo cannot overwrite an earlier chunk's findings or log.
 */
export function pad (id) {
  return String(id).padStart(4, '0')
}
