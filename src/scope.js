import path from 'node:path'
import { lsFilesStaged, measureBlobs } from './git.js'

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
  // curc's own state, so a repo that commits it never pays to review it.
  '.claude/curc/**', '.claude/worktrees/**'
]

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
  return globs.some(g => globToRegExp(g).test(p))
}

/**
 * Everything tracked under `include`, minus what is excluded, binary, or too
 * big to fit in any chunk. Returns the survivors plus why each casualty fell,
 * so the UI can show its work instead of silently shrinking the scope.
 */
export async function collectFiles (root, { include = [], exclude = [], maxLines }) {
  const globs = [...DEFAULT_EXCLUDES, ...exclude]
  const tracked = lsFilesStaged(root, include)

  const kept = []
  const dropped = { excluded: [], binary: [], oversize: [] }

  const candidates = tracked.filter(f => {
    if (matchesAny(f.path, globs)) { dropped.excluded.push(f.path); return false }
    return true
  })

  const sizes = await measureBlobs(root, candidates.map(f => f.blob))
  for (const f of candidates) {
    const m = sizes.get(f.blob) ?? { lines: 0, binary: false }
    if (m.binary) { dropped.binary.push(f.path); continue }
    if (m.lines > maxLines) { dropped.oversize.push({ path: f.path, lines: m.lines }); continue }
    kept.push({ path: f.path, blob: f.blob, lines: m.lines })
  }
  kept.sort((a, b) => a.path.localeCompare(b.path))
  return { files: kept, dropped }
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
