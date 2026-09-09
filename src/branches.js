import fs from 'node:fs'
import path from 'node:path'
import { git, tryGit } from './git.js'
import { REF_PREFIX, pad } from './paths.js'

/** Fixed identity and dates, so the same plan always produces the same SHAs. */
function commitEnv (snapshotDate) {
  return {
    GIT_AUTHOR_NAME: 'curc',
    GIT_AUTHOR_EMAIL: 'curc@localhost',
    GIT_COMMITTER_NAME: 'curc',
    GIT_COMMITTER_EMAIL: 'curc@localhost',
    GIT_AUTHOR_DATE: snapshotDate,
    GIT_COMMITTER_DATE: snapshotDate
  }
}

/**
 * Build the commit pair that makes one chunk reviewable.
 *
 *   base-NN   orphan commit, tree = snapshot tree MINUS the chunk's files
 *   chunk-NN  tree = the FULL snapshot tree, parented on base-NN
 *
 * The diff between them is exactly the chunk, as pure additions, while the
 * sandbox still receives the whole repository — so a reviewer can follow an
 * import out of the chunk instead of staring at orphan files.
 *
 * GIT_INDEX_FILE is passed per call, never exported, so no other code path in
 * this process can reach the user's index even by accident.
 */
export function buildPair (L, { id, snapshot, snapshotTree, files }) {
  const cwd = L.root
  const idxFile = path.join(L.tmp, `idx-${pad(id)}`)
  fs.mkdirSync(L.tmp, { recursive: true })
  fs.rmSync(idxFile, { force: true })

  const date = git(['show', '-s', '--format=%cI', snapshot], { cwd })
  const env = { GIT_INDEX_FILE: idxFile }

  let baseTree
  try {
    git(['read-tree', snapshotTree], { cwd, env })
    git(['update-index', '--force-remove', '-z', '--stdin'], {
      cwd, env, input: files.map(f => f.path).join('\0') + '\0'
    })
    baseTree = git(['write-tree'], { cwd, env })
  } finally {
    fs.rmSync(idxFile, { force: true })
  }

  const cenv = commitEnv(date)
  const base = git(['commit-tree', baseTree, '-m',
    `curc base for chunk ${pad(id)} — ${snapshot.slice(0, 8)} minus ${files.length} files`],
  { cwd, env: cenv })
  const chunk = git(['commit-tree', snapshotTree, '-p', base, '-m',
    `curc chunk ${pad(id)} — ${files.length} files, review against ${L.baseRef(id)}`],
  { cwd, env: cenv })

  git(['branch', '-f', L.baseRef(id), base], { cwd })
  git(['branch', '-f', L.chunkRef(id), chunk], { cwd })

  assertPair(L, { id, files, base, chunk, snapshotTree })
  return { base, chunk, baseRef: L.baseRef(id), chunkRef: L.chunkRef(id) }
}

/**
 * The pair is the whole mechanism, so it is checked rather than trusted. Any
 * failure here aborts before a worktree exists and long before anything bills.
 */
export function assertPair (L, { id, files, base, chunk, snapshotTree }) {
  const cwd = L.root

  const mb = git(['merge-base', chunk, base], { cwd })
  if (mb !== base) throw new Error(`chunk ${pad(id)}: merge-base is ${mb.slice(0, 8)}, expected the base commit`)

  if (snapshotTree) {
    const t = git(['rev-parse', `${chunk}^{tree}`], { cwd })
    if (t !== snapshotTree) throw new Error(`chunk ${pad(id)}: chunk tree is not the snapshot tree`)
  }

  const changed = git(['diff', '--name-only', '-z', base, chunk, '--'], { cwd }).split('\0').filter(Boolean).sort()
  const expected = files.map(f => f.path).sort()
  if (changed.length !== expected.length || changed.some((p, i) => p !== expected[i])) {
    throw new Error(`chunk ${pad(id)}: diff lists ${changed.length} files, expected ${expected.length}`)
  }

  // --diff-filter=a is "everything that is NOT an addition"; it must be empty.
  const nonAdds = git(['diff', '--name-only', '--diff-filter=a', base, chunk, '--'], { cwd })
  if (nonAdds) throw new Error(`chunk ${pad(id)}: diff contains non-additions:\n${nonAdds}`)
}

/** Changed-file and changed-line counts as ultrareview will see them. */
export function pairSize (L, id) {
  const out = git(['diff', '--numstat', L.baseRef(id), L.chunkRef(id), '--'], { cwd: L.root })
  let files = 0
  let lines = 0
  for (const line of out.split('\n').filter(Boolean)) {
    const [add] = line.split('\t')
    files++
    lines += Number(add) || 0
  }
  return { files, lines }
}

/** Delete one ref. Refuses anything outside the curc namespace. */
export function dropRef (L, ref) {
  if (!ref.startsWith(`${REF_PREFIX}/`)) throw new Error(`refusing to delete ${ref}: outside ${REF_PREFIX}/`)
  return tryGit(['branch', '-D', ref], { cwd: L.root }).code === 0
}

/** Delete a chunk's ref pair. */
export function dropPair (L, id) {
  for (const ref of [L.baseRef(id), L.chunkRef(id)]) dropRef(L, ref)
}

export function listRefs (L) {
  const r = tryGit(['for-each-ref', '--format=%(refname:short)', `refs/heads/${REF_PREFIX}/`], { cwd: L.root })
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
}
