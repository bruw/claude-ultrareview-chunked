import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const FIXED = '2026-01-01T00:00:00Z'

export function tmpRepo (files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ultrareview-chunked-test-'))
  const git = (...a) => spawnSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: FIXED, GIT_COMMITTER_DATE: FIXED }
  })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'core.autocrlf', 'false')
  write(dir, files)
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git, write: more => write(dir, more) }
}

export function write (dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(dir, p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

/** N lines of filler, so a fixture can hit a cap on purpose. */
export function lines (n, tag = 'x') {
  return Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n') + '\n'
}

/**
 * Remove a fixture repo.
 *
 * A detached supervisor may still be writing into it — the sweep is over, but
 * its last teardown can lag the run records slightly — so a removal that races
 * one is retried rather than allowed to fail the test that asked for it. This
 * is far likelier on a shared CI runner than on a developer's machine.
 */
export function cleanup (dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch {}
  }
}
