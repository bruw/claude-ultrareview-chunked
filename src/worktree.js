import fs from 'node:fs'
import { git, tryGit } from './git.js'
import { REF_PREFIX } from './paths.js'

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

export function listWorktrees (L) {
  const r = tryGit(['worktree', 'list', '--porcelain'], { cwd: L.root })
  if (r.code !== 0) return []
  return r.stdout.split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length))
    .filter(p => p.includes(`${REF_PREFIX}-`) || p.includes(`/worktrees/curc-`))
}
