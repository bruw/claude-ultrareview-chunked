import fs from 'node:fs'

/**
 * The one lock in the system: it guards the *writer role*, not a file.
 *
 * Everything here fails closed. A review costs $5–$25, so the expensive
 * mistake is two supervisors believing they hold the lock — not one repo that
 * needs a human to type `curc unlock`. Every judgement below is biased
 * accordingly, and the reasoning is written down because the previous version
 * had this predicate implemented twice, in two files, with two different
 * answers.
 */

export const HEARTBEAT_MS = 15_000
/** How long a heartbeat may go quiet before a dead-looking holder is stale. */
export const STALE_AFTER_S = 60

const read = L => {
  try {
    const rec = JSON.parse(fs.readFileSync(L.lock, 'utf8'))
    const ageSec = Math.max(0, (Date.now() - fs.statSync(L.lock).mtimeMs) / 1000)
    return { rec, ageSec }
  } catch { return null }
}

/**
 * Is a pid running? EPERM means "yes, and not yours", which still counts.
 *
 * A malformed pid answers *true*: an unreadable holder is not evidence that
 * nobody holds the lock, and treating it as absent is how a live run gets its
 * refs deleted underneath it.
 */
export function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * Who holds the lock, and whether anything should defer to them.
 *
 * `stale` is `!pidAlive && quiet`, deliberately an AND. Either half alone is
 * wrong in a way that costs money: a supervisor that is alive but stalled — a
 * suspended laptop mid-sweep, a swapped-out process, a stuck utimes — has a
 * live pid and an old heartbeat, and reclaiming it starts a second supervisor
 * on the same chunks. A recycled pid is the mirror image and needs the
 * heartbeat to catch it. Requiring both means a stall is never reclaimed
 * automatically and a genuine death waits out one quiet minute first.
 */
export function lockState (L) {
  const r = read(L)
  if (!r) return null
  const { rec, ageSec } = r
  const alive = pidAlive(rec.pid)
  const quiet = ageSec > STALE_AFTER_S
  const stale = !alive && quiet
  return {
    runId: rec.runId ?? null,
    pid: Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : null,
    startedAt: rec.startedAt ?? null,
    pidAlive: alive,
    heartbeatAgeSec: Math.round(ageSec),
    state: stale ? 'stale' : 'running',
    // Anything not provably dead counts as in flight.
    alive: !stale,
    // True once a heartbeat is late enough to be worth mentioning, whether or
    // not the holder is reclaimable — a stalled supervisor is worth saying out
    // loud precisely because curc will not act on it by itself.
    stalled: quiet
  }
}

/**
 * Take the lock, or report who has it. Never reclaims.
 *
 * Reclaiming used to be `rm` then `wx`, which is two syscalls and therefore
 * two processes can both pass the staleness test, both unlink, and both
 * create. Node exposes no flock, and no arrangement of wx/mkdir/link makes
 * check-then-unlink atomic — so the only honest options are a race or a
 * refusal, and at these prices it is a refusal. `curc unlock` is the way out.
 */
export function acquire (L, runId, pid) {
  try {
    const fd = fs.openSync(L.lock, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ runId, pid, startedAt: new Date().toISOString() }))
    return { ok: true, fd }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const holder = lockState(L)
    if (!holder) return acquire(L, runId, pid)   // vanished between open and read
    return {
      ok: false,
      reason: holder.state === 'stale' ? 'stale' : 'in-flight',
      holder,
      remedy: holder.state === 'stale'
        ? `no supervisor is running, but a lock from ${holder.runId ?? 'an earlier run'} is still there — \`curc unlock\` to clear it`
        : `run ${holder.runId ?? '?'} is in flight (pid ${holder.pid ?? '?'}) — \`curc status\`, or \`curc stop\``
    }
  }
}

/** Record the real pid once spawn() has handed it over. */
export function attachPid (L, runId, pid) {
  if (!owns(L, runId)) return false
  const rec = JSON.parse(fs.readFileSync(L.lock, 'utf8'))
  fs.writeFileSync(L.lock, JSON.stringify({ ...rec, pid, startedAt: new Date().toISOString() }))
  return true
}

/** Is the lock still ours? Checked before every mutation of it. */
export function owns (L, runId) {
  const r = read(L)
  return Boolean(r && r.rec.runId === runId)
}

/**
 * Keep the lock warm. Returns false if it is no longer ours, which is the
 * supervisor's cue to stand down rather than keep a stranger's lock alive.
 */
export function heartbeat (L, runId) {
  if (!owns(L, runId)) return false
  try { fs.utimesSync(L.lock, new Date(), new Date()); return true } catch { return false }
}

/** Release, but only what we actually hold. */
export function release (L, runId) {
  if (!owns(L, runId)) return false
  fs.rmSync(L.lock, { force: true })
  return true
}

/** `curc unlock`: the deliberate human act that replaces automatic reclaim. */
export function forceUnlock (L) {
  const holder = lockState(L)
  if (!holder) return { removed: false, reason: 'no lock file' }
  fs.rmSync(L.lock, { force: true })
  return { removed: true, holder }
}
