import { spawnSync, spawn } from 'node:child_process'

/**
 * The only place curc spawns `claude`. One boundary means the test suite has
 * exactly one thing to stand in for — see CURC_CLAUDE_BIN.
 */
export function claudeBin () {
  return process.env.CURC_CLAUDE_BIN || 'claude'
}

function run (args, opts = {}) {
  const r = spawnSync(claudeBin(), args, { encoding: 'utf8', timeout: opts.timeout ?? 30000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

export function isInstalled () {
  const r = run(['--version'])
  return !r.error && r.code === 0
}

export function version () {
  const r = run(['--version'])
  return r.code === 0 ? r.stdout.trim() : null
}

/**
 * Capability probe rather than a version comparison: `ultrareview --help`
 * exits 0 without network or auth, so it answers "does this build support the
 * subcommand" directly instead of against a version floor that will rot.
 */
export function supportsUltrareview () {
  return run(['ultrareview', '--help']).code === 0
}

export function authStatus () {
  const r = run(['auth', 'status', '--json'])
  if (r.code !== 0) return { loggedIn: false, reason: r.stderr.trim() || 'auth status failed' }
  try { return JSON.parse(r.stdout) } catch { return { loggedIn: false, reason: 'unparseable auth status' } }
}

/** The exact argv used for a chunk review — also what --dry-run prints. */
export function reviewArgv (baseRef, { timeout = 45 } = {}) {
  return ['ultrareview', baseRef, '--json', '--no-post', '--timeout', String(timeout)]
}

/**
 * Launch one review. stdout is the raw bugs.json payload and goes straight to
 * a file undiluted, so a malformed payload still lands on disk intact; stderr
 * carries progress and the session URL.
 */
export function spawnReview (baseRef, { cwd, timeout, outFd, errFd }) {
  return spawn(claudeBin(), reviewArgv(baseRef, { timeout }), {
    cwd,
    stdio: ['ignore', outFd, errFd]
  })
}

const URL_RE = /https:\/\/\S*claude\.ai\/\S+/

export function sessionUrlFromLog (text) {
  const m = URL_RE.exec(text)
  return m ? m[0].replace(/[)\].,]+$/, '') : null
}

export function countFindings (raw) {
  try {
    const p = JSON.parse(raw)
    if (Array.isArray(p)) return p.length
    for (const k of ['findings', 'bugs', 'results']) if (Array.isArray(p?.[k])) return p[k].length
    return null
  } catch { return null }
}
