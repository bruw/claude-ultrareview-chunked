import { dirOf } from './scope.js'

export const DEFAULT_MAX_FILES = 450
export const DEFAULT_MAX_LINES = 7500

/**
 * Pack files into chunks that fit under both caps.
 *
 * Grouping runs directory by directory so a chunk stays topically coherent —
 * a reviewer looking at one chunk sees a module, not an alphabetical slice
 * through the repo. A directory that busts a cap on its own is split, in path
 * order, rather than being allowed to overflow.
 */
export function chunkFiles (files, { maxFiles = DEFAULT_MAX_FILES, maxLines = DEFAULT_MAX_LINES } = {}) {
  const byDir = new Map()
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const d = dirOf(f.path)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(f)
  }

  const chunks = []
  let cur = []
  let curLines = 0

  const flush = () => {
    if (cur.length) { chunks.push(cur); cur = []; curLines = 0 }
  }

  for (const group of byDir.values()) {
    const groupLines = group.reduce((n, f) => n + f.lines, 0)

    if (groupLines > maxLines || group.length > maxFiles) {
      flush()
      let sub = []
      let subLines = 0
      for (const f of group) {
        if (sub.length && (subLines + f.lines > maxLines || sub.length >= maxFiles)) {
          chunks.push(sub); sub = []; subLines = 0
        }
        sub.push(f); subLines += f.lines
      }
      if (sub.length) chunks.push(sub)
      continue
    }

    if (cur.length && (curLines + groupLines > maxLines || cur.length + group.length > maxFiles)) flush()
    cur.push(...group); curLines += groupLines
  }
  flush()

  return chunks.map((fs, i) => ({
    id: i + 1,
    files: fs,
    lines: fs.reduce((n, f) => n + f.lines, 0)
  }))
}

/** Human label for a chunk: the directories it spans. */
export function chunkLabel (chunk, width = 48) {
  const dirs = [...new Set(chunk.files.map(f => dirOf(f.path) || '.'))]
  const label = dirs.length === 1 ? dirs[0] : `${dirs[0]} +${dirs.length - 1} more`
  return label.length > width ? '…' + label.slice(-(width - 1)) : label
}
