import fs from 'node:fs'
import path from 'node:path'
import { git, tryGit } from './git.js'
import { REF_PREFIX } from './paths.js'
import { listRefs } from './branches.js'

export function addWorktree (L, id) {
  const dir = L.worktreeFor(id)
  if (fs.existsSync(dir)) removeWorktree(L, id)
  fs.mkdirSync(L.worktrees, { recursive: true })
  git(['worktree', 'add', '--detach', dir, L.chunkRef(id)], { cwd: L.root })
  return dir
}

/**
 * Detached HEAD on purpose: the worktree exists only to give the reviewer a
 * checkout, and a detached one cannot be confused for a branch someone is
 * working on.
 */
export function removeWorktree (L, id) {
  const dir = L.worktreeFor(id)
  tryGit(['worktree', 'remove', '--force', dir], { cwd: L.root })
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  tryGit(['worktree', 'prune'], { cwd: L.root })
}

/**
 * Every claude-ultrareview-chunked ref and worktree in the repo, whoever made them.
 *
 * Counted from the repository rather than from the ledger, because the things
 * most in need of cleaning are exactly the ones the ledger has lost track of:
 * a re-plan renumbers chunks, so the refs of the old numbering belong to no
 * chunk any more. `clean` used to count these and then delete only what the
 * ledger still knew about, which meant it reported the strays and left every
 * one of them behind.
 */
export function sweepable (L) {
  const worktreeDirs = fs.existsSync(L.worktrees)
    ? fs.readdirSync(L.worktrees).filter(n => n.startsWith(`${REF_PREFIX}-`))
    : []
  return { refs: listRefs(L), worktreeDirs }
}

/** Remove one worktree by directory name, rather than by chunk id. */
export function removeWorktreeDir (L, name) {
  const dir = path.join(L.worktrees, name)
  tryGit(['worktree', 'remove', '--force', dir], { cwd: L.root })
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  tryGit(['worktree', 'prune'], { cwd: L.root })
}
