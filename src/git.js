import { spawnSync, spawn } from 'node:child_process'

/** Run git, returning the raw result. Never throws. */
export function tryGit (args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: opts.encoding === 'buffer' ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/** Run git, throwing on failure. Returns trimmed stdout. */
export function git (args, opts = {}) {
  const r = tryGit(args, opts)
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`)
  return r.stdout.trim()
}

export function isRepo (cwd) {
  const r = tryGit(['rev-parse', '--is-inside-work-tree'], { cwd })
  return r.code === 0 && r.stdout.trim() === 'true'
}

export function repoRoot (cwd) {
  return git(['rev-parse', '--show-toplevel'], { cwd })
}

export function headSha (cwd) {
  return git(['rev-parse', 'HEAD'], { cwd })
}

export function treeOf (cwd, sha) {
  return git(['rev-parse', `${sha}^{tree}`], { cwd })
}

export function shortSha (sha) {
  return sha.slice(0, 8)
}

/** Tracked files with their blob shas: [{ path, blob }]. */
export function lsFilesStaged (cwd, paths = []) {
  const out = git(['ls-files', '-s', '-z', '--', ...paths], { cwd })
  return out.split('\0').filter(Boolean).map(rec => {
    // "<mode> <blob> <stage>\t<path>"
    const tab = rec.indexOf('\t')
    const [, blob] = rec.slice(0, tab).split(' ')
    return { path: rec.slice(tab + 1), blob }
  })
}

/**
 * Stream many blobs through one `git cat-file --batch` and report, per blob,
 * its newline count and whether it looks binary. Reading from the object store
 * rather than the working tree keeps sizing honest on a dirty checkout.
 */
export function measureBlobs (cwd, blobs) {
  return new Promise((resolve, reject) => {
    const result = new Map()
    if (blobs.length === 0) return resolve(result)
    const child = spawn('git', ['cat-file', '--batch'], { cwd })
    const chunks = []
    child.stdout.on('data', d => chunks.push(d))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`))
      const buf = Buffer.concat(chunks)
      let at = 0
      for (const blob of blobs) {
        const nl = buf.indexOf(0x0a, at)
        if (nl === -1) return reject(new Error('git cat-file: truncated output'))
        const header = buf.toString('utf8', at, nl) // "<sha> blob <size>"
        const size = Number(header.split(' ')[2])
        const start = nl + 1
        const body = buf.subarray(start, start + size)
        result.set(blob, { lines: countLines(body), binary: body.includes(0) })
        at = start + size + 1 // trailing newline after the object
      }
      resolve(result)
    })
    child.stdin.end(blobs.join('\n') + '\n')
  })
}

function countLines (buf) {
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
  // A final line with no trailing newline still counts as a line.
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++
  return n
}
