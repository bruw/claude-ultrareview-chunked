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

/** Index modes that are not reviewable file content. */
export const MODE_GITLINK = '160000'
export const MODE_SYMLINK = '120000'

/**
 * Tracked entries with their object ids: [{ path, blob, mode }].
 *
 * The mode is kept rather than discarded because it is the only reliable way
 * to recognise a submodule: `ls-files -s` reports a gitlink's *commit* sha in
 * the object column, and that commit is absent from the superproject after an
 * ordinary `git clone` — the exact shape that used to desync measureBlobs.
 */
export function lsFilesStaged (cwd, paths = []) {
  const out = git(['ls-files', '-s', '-z', '--', ...paths], { cwd })
  return out.split('\0').filter(Boolean).map(rec => {
    // "<mode> <blob> <stage>\t<path>"
    const tab = rec.indexOf('\t')
    const [mode, blob] = rec.slice(0, tab).split(' ')
    return { path: rec.slice(tab + 1), blob, mode }
  })
}

/**
 * Per-blob newline count and binary flag, read from the object store rather
 * than the working tree so sizing stays honest on a dirty checkout.
 *
 * Returns one entry per requested blob:
 *   { ok: true,  type: 'blob', bytes, lines, binary }
 *   { ok: false, reason: 'missing' | 'ambiguous' | 'not-a-blob', type? }
 *
 * There is deliberately no "unknown looks like empty" fallback: a caller that
 * cannot tell those apart drops real files on the floor and says nothing.
 *
 * Two passes, because one cannot be made safe. `--batch-check` emits exactly
 * one line per input and no content, so it cannot lose alignment however odd
 * the objects are; it classifies everything before a single byte of content is
 * read. `--batch` then runs only over objects already proven to be blobs, and
 * its parse is incremental — content is counted as it streams past and never
 * retained.
 */
export async function measureBlobs (cwd, blobs) {
  const result = new Map()
  if (blobs.length === 0) return result

  const want = [...new Set(blobs)]
  const checked = await batchCheck(cwd, want)

  const readable = []
  for (const blob of want) {
    const c = checked.get(blob)
    if (!c) throw new Error(`git cat-file --batch-check: no record for ${blob}`)
    if (!c.ok) { result.set(blob, c); continue }
    if (c.type !== 'blob') { result.set(blob, { ok: false, reason: 'not-a-blob', type: c.type }); continue }
    readable.push(blob)
  }

  if (readable.length) {
    const sizes = new Map(readable.map(b => [b, checked.get(b).bytes]))
    for (const [blob, m] of await batchContent(cwd, readable, sizes)) result.set(blob, m)
  }
  return result
}

/**
 * Pass one: type and size for every object, one line each.
 *
 * `<sha> <type> <size>` for anything that resolves; `<sha> missing` or
 * `<sha> ambiguous` — bodyless, and the reason the old single-pass parser lost
 * the stream — for anything that does not.
 */
function batchCheck (cwd, want) {
  return runCatFile(cwd, ['--batch-check', '--buffer'], want, (out, feed) => {
    let carry = ''
    return {
      data (text) {
        carry += text
        let nl
        while ((nl = carry.indexOf('\n')) !== -1) {
          feed(parseHeader(carry.slice(0, nl), out.length), out)
          carry = carry.slice(nl + 1)
        }
      },
      end () {
        if (carry.trim()) throw new Error(`git cat-file --batch-check: trailing partial line ${JSON.stringify(carry)}`)
      }
    }
  })
}

/** `<sha> missing` / `<sha> ambiguous` / `<sha> <type> <size>`. */
function parseHeader (line, index) {
  const sp = line.indexOf(' ')
  if (sp < 0) throw new Error(`git cat-file: unparseable header ${JSON.stringify(line)} at position ${index}`)
  const name = line.slice(0, sp)
  const rest = line.slice(sp + 1)

  if (rest === 'missing' || rest === 'ambiguous') return { name, ok: false, reason: rest }

  const sp2 = rest.indexOf(' ')
  const type = sp2 < 0 ? '' : rest.slice(0, sp2)
  const size = sp2 < 0 ? '' : rest.slice(sp2 + 1)
  if (!type || !/^\d+$/.test(size)) {
    throw new Error(`git cat-file: unrecognised header ${JSON.stringify(line)} at position ${index}`)
  }
  return { name, ok: true, type, bytes: Number(size) }
}

/**
 * Pass two: stream the content of objects pass one proved are blobs, counting
 * newlines and watching for a NUL as the bytes go past.
 *
 * A record is `<header>\n<exactly size bytes>\n`, for *every* object type — a
 * present commit or tree is framed exactly like a blob. So the body is always
 * consumed by byte count and never by looking for a delimiter, and the only
 * bodyless forms are the two statuses pass one has already excluded. Meeting
 * one here means the object store changed under us, which is a hard failure
 * rather than something to parse around.
 */
function batchContent (cwd, want, sizes) {
  const HEADER = 0
  const BODY = 1
  const TERM = 2
  const MAX_HEADER = 1024

  return runCatFile(cwd, ['--batch', '--buffer'], want, (out, feed) => {
    let state = HEADER
    let carry = Buffer.alloc(0)
    let remaining = 0
    let pending = null
    let lines = 0
    let binary = false
    let lastByte = -1

    const start = header => {
      const m = parseHeader(header, out.length)
      if (!m.ok) throw new Error(`git cat-file --batch: ${m.name} became ${m.reason} between passes`)
      if (m.type !== 'blob') throw new Error(`git cat-file --batch: ${m.name} is a ${m.type}, not a blob`)
      const expected = want[out.length]
      if (m.name !== expected) throw new Error(`git cat-file --batch desync: got ${m.name}, wanted ${expected}`)
      if (m.bytes !== sizes.get(expected)) {
        throw new Error(`git cat-file --batch: ${m.name} is ${m.bytes} bytes, --batch-check said ${sizes.get(expected)}`)
      }
      pending = expected
      remaining = m.bytes
      lines = 0
      binary = false
      lastByte = -1
      state = remaining === 0 ? TERM : BODY
    }

    return {
      data (buf) {
        let i = 0
        while (i < buf.length) {
          if (state === HEADER) {
            const nl = buf.indexOf(0x0a, i)
            if (nl === -1) {
              carry = Buffer.concat([carry, buf.subarray(i)])
              if (carry.length > MAX_HEADER) throw new Error('git cat-file --batch: header longer than 1 KiB')
              return
            }
            const line = carry.length
              ? Buffer.concat([carry, buf.subarray(i, nl)]).toString('latin1')
              : buf.toString('latin1', i, nl)
            carry = Buffer.alloc(0)
            i = nl + 1
            start(line)
          } else if (state === BODY) {
            const take = Math.min(remaining, buf.length - i)
            for (let j = i; j < i + take; j++) {
              const b = buf[j]
              if (b === 0x0a) lines++
              else if (b === 0) binary = true
            }
            lastByte = buf[i + take - 1]
            remaining -= take
            i += take
            if (remaining === 0) state = TERM
          } else {
            if (buf[i] !== 0x0a) throw new Error('git cat-file --batch: expected LF after object body — stream desynced')
            i++
            // A final line with no trailing newline still counts as a line.
            if (sizes.get(pending) > 0 && lastByte !== 0x0a) lines++
            feed({ name: pending, ok: true, type: 'blob', bytes: sizes.get(pending), lines, binary }, out)
            state = HEADER
          }
        }
      },
      end () {
        if (state !== HEADER || carry.length) throw new Error('git cat-file --batch: truncated output')
      }
    }
  })
}

/**
 * Drive one `git cat-file` invocation to completion.
 *
 * stderr is drained rather than left to fill its pipe — an unread pipe is how a
 * repo that emits per-object warnings turns into a hang with no timeout — and
 * stdin errors are swallowed so that a git which exits early surfaces as its
 * own exit code instead of an unhandled EPIPE that takes the process down.
 */
function runCatFile (cwd, args, want, makeParser) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', ...args], { cwd })
    const out = []
    const map = new Map()
    let errText = ''
    let settled = false

    const fail = err => {
      if (settled) return
      settled = true
      child.kill()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const feed = (rec, list) => {
      const expected = want[list.length]
      if (rec.name !== expected) throw new Error(`git cat-file desync: got ${rec.name}, wanted ${expected}`)
      const { name, ...m } = rec
      map.set(name, m)
      list.push(name)
    }

    const parser = makeParser(out, feed)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => { if (errText.length < 8192) errText += d })
    child.stderr.on('error', () => {})
    child.stdin.on('error', () => {})   // git exiting early must not crash us
    child.on('error', fail)

    if (args[0] === '--batch-check') child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => { if (!settled) try { parser.data(d) } catch (e) { fail(e) } })
    child.stdout.on('error', fail)

    child.on('close', code => {
      if (settled) return
      const detail = errText.trim() ? `: ${errText.trim()}` : ''
      if (code !== 0) return fail(new Error(`git cat-file exited ${code}${detail}`))
      try { parser.end() } catch (e) { return fail(e) }
      if (out.length !== want.length) {
        return fail(new Error(`git cat-file: read ${out.length} records, expected ${want.length}${detail}`))
      }
      settled = true
      resolve(map)
    })

    child.stdin.end(want.join('\n') + '\n')
  })
}
