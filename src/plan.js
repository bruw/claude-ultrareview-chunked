import { headSha, treeOf } from './git.js'
import { collectFiles, topLevelSummary } from './scope.js'
import { chunkFiles, DEFAULT_MAX_FILES, DEFAULT_MAX_LINES } from './chunker.js'
import { emptyLedger, coverageStats } from './ledger.js'

/**
 * Survey the repo at HEAD: what is in scope, what was dropped and why, and how
 * much of it has already been reviewed. Costs nothing and launches nothing.
 */
export async function survey (root, { include = [], exclude = [], maxFiles = DEFAULT_MAX_FILES, maxLines = DEFAULT_MAX_LINES, reviewed = {} } = {}) {
  const snapshot = headSha(root)
  const snapshotTree = treeOf(root, snapshot)
  const { files, dropped } = await collectFiles(root, { commit: snapshot, include, exclude, maxLines })
  return {
    snapshot,
    snapshotTree,
    files,
    dropped,
    caps: { maxFiles, maxLines },
    coverage: coverageStats(files, reviewed),
    dirs: topLevelSummary(files)
  }
}

/**
 * Turn a survey into the pending plan.
 *
 * Only files that are not already covered get chunked, so a re-plan on a moved
 * codebase shows the work that remains rather than re-proposing what has been
 * paid for. Chunk ids come from a monotonic counter and are never reused, so
 * an old chunk's findings can never be overwritten by a new chunk of the same
 * ordinal.
 */
export function planFrom (ledger, surveyResult, { include, exclude }) {
  const l = ledger ?? emptyLedger()
  const uncovered = surveyResult.files.filter(f => !l.reviewed[f.blob])
  const chunks = chunkFiles(uncovered, surveyResult.caps)

  let nextId = l.nextId ?? 1
  const withIds = chunks.map(ch => ({
    id: nextId++,
    lines: ch.lines,
    files: ch.files.map(f => ({ path: f.path, blob: f.blob, lines: f.lines }))
  }))

  return {
    ...l,
    snapshot: surveyResult.snapshot,
    snapshotTree: surveyResult.snapshotTree,
    caps: surveyResult.caps,
    scope: { include, exclude },
    dropped: surveyResult.dropped,
    nextId,
    chunks: withIds,
    archive: l.archive ?? []
  }
}

/**
 * Has the ground moved under a plan? Cheap: compare HEAD, then ask whether any
 * blob still waiting to be reviewed has changed since the plan was made.
 */
export function drift (ledger, root) {
  if (!ledger?.snapshot) return { state: 'none' }
  const head = headSha(root)
  if (head === ledger.snapshot) return { state: 'fresh', head }
  return { state: 'drifted', head, snapshot: ledger.snapshot }
}
