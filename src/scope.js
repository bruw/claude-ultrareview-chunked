import path from 'node:path'
import { lsTree, measureBlobs, MODE_GITLINK, MODE_SYMLINK } from './git.js'

/**
 * Paths that cost review budget and return nothing: binaries by extension,
 * lockfiles, vendored trees, build output, and generated bundles. Binary
 * content is caught separately by a NUL-byte check, so this list only has to
 * cover text files that are nonetheless not worth a reviewer's attention.
 */
export const DEFAULT_EXCLUDES = [
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.ico', '**/*.svg',
  '**/*.pdf', '**/*.zip', '**/*.gz', '**/*.tgz', '**/*.bz2', '**/*.xz', '**/*.7z',
  '**/*.ttf', '**/*.otf', '**/*.woff', '**/*.woff2', '**/*.eot',
  '**/*.mp3', '**/*.mp4', '**/*.mov', '**/*.wav', '**/*.webm',
  '**/*.so', '**/*.dylib', '**/*.dll', '**/*.exe', '**/*.wasm', '**/*.class', '**/*.jar',
  '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb',
  '**/uv.lock', '**/poetry.lock', '**/Cargo.lock', '**/composer.lock', '**/Gemfile.lock',
  '**/go.sum',
  '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/.venv/**',
  '**/__snapshots__/**', '**/*.snap',
  // claude-ultrareview-chunked's own state, so a repo that commits it never pays to review it.
  '.claude/claude-ultrareview-chunked/**', '.claude/worktrees/**'
]

/**
 * Compiled globs are cached: collectFiles tests every tracked file against the
 * whole exclude list, so compiling per test is tens of thousands of identical
 * RegExp constructions on a repo of any size.
 */
const compiled = new Map()

function globRe (glob) {
  let re = compiled.get(glob)
  if (!re) { re = globToRegExp(glob); compiled.set(glob, re) }
  return re
}

/** Translate a glob subset (`**`, `*`, `?`) into a RegExp. */
export function globToRegExp (glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the group.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny (p, globs) {
  return globs.some(g => globRe(g).test(p))
}

/**
 * Everything in `commit`'s tree under `include`, minus what is excluded,
 * binary, or too big to fit in any chunk. Returns the survivors plus why each
 * casualty fell, so the UI can show its work instead of silently shrinking
 * the scope.
 */
export async function collectFiles (root, { commit = 'HEAD', include = [], exclude = [], maxLines }) {
  const globs = [...DEFAULT_EXCLUDES, ...exclude]
  const tracked = lsTree(root, commit, include)

  const kept = []
  const dropped = { excluded: [], submodule: [], symlink: [], binary: [], oversize: [], unreadable: [] }

  const candidates = tracked.filter(f => {
    // Gitlinks go by mode, before measurement. `ls-files -s` puts a submodule's
    // *commit* sha in the object column, and after an ordinary clone that commit
    // is not in this repository at all — so this is both the cheapest and the
    // only reliable way to recognise one.
    if (f.mode === MODE_GITLINK) { dropped.submodule.push(f.path); return false }
    if (f.mode === MODE_SYMLINK) { dropped.symlink.push(f.path); return false }
    if (matchesAny(f.path, globs)) { dropped.excluded.push(f.path); return false }
    return true
  })

  const sizes = await measureBlobs(root, candidates.map(f => f.blob))
  for (const f of candidates) {
    const m = sizes.get(f.blob)
    // No "unknown looks empty" default: that is how an unmeasurable object used
    // to sail through as a 0-line file nobody ever heard about again.
    if (!m) throw new Error(`measureBlobs returned no record for ${f.path} (${f.blob})`)
    if (!m.ok) { dropped.unreadable.push({ path: f.path, reason: m.reason }); continue }
    if (m.binary) { dropped.binary.push(f.path); continue }
    if (m.lines > maxLines) { dropped.oversize.push({ path: f.path, lines: m.lines }); continue }
    kept.push({ path: f.path, blob: f.blob, lines: m.lines })
  }
  kept.sort((a, b) => a.path.localeCompare(b.path))
  return { files: kept, dropped }
}

/** Total dropped, and a per-reason breakdown, without hardcoding the reasons. */
export function droppedSummary (dropped) {
  const parts = Object.entries(dropped ?? {})
    .filter(([, v]) => v.length)
    .map(([name, v]) => ({ name, count: v.length }))
  return { total: parts.reduce((n, p) => n + p.count, 0), parts }
}

/** Per-top-level-directory totals, for the scope picker. */
export function topLevelSummary (files) {
  const byRoot = new Map()
  for (const f of files) {
    const root = f.path.includes('/') ? f.path.split('/')[0] : '.'
    const e = byRoot.get(root) ?? { name: root, files: 0, lines: 0 }
    e.files++; e.lines += f.lines
    byRoot.set(root, e)
  }
  return [...byRoot.values()].sort((a, b) => b.lines - a.lines)
}

export function dirOf (p) {
  const d = path.posix.dirname(p)
  return d === '.' ? '' : d
}
