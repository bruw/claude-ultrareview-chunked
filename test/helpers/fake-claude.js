#!/usr/bin/env node
// Stand-in for the `claude` CLI. Behaviour is driven entirely by env, so the
// whole tool can be exercised end to end without a cent of usage credit.
import fs from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success'

if (argv[0] === '--version') { process.stdout.write((process.env.FAKE_CLAUDE_VERSION ?? '2.1.266') + '\n'); process.exit(0) }
if (argv[0] === 'ultrareview' && argv[1] === '--help') process.exit(Number(process.env.FAKE_CLAUDE_NO_ULTRAREVIEW ? 1 : 0))
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify(
    process.env.FAKE_CLAUDE_LOGGED_OUT
      ? { loggedIn: false }
      : { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) + '\n')
  process.exit(0)
}

if (argv[0] !== 'ultrareview') { process.stderr.write(`fake-claude: unsupported ${argv.join(' ')}\n`); process.exit(2) }

// Only real reviews are logged — the probes above are free and would otherwise
// drown the signal a test is looking for.
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG,
    JSON.stringify({ at: Date.now(), cwd: process.cwd(), argv }) + '\n')
}

const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)
setTimeout(() => {
  process.stderr.write(`Review session: https://claude.ai/code/session_fake${process.pid}\n`)
  if (mode === 'fail') { process.stderr.write('fake failure\n'); process.exit(1) }
  if (mode === 'garbage') { process.stdout.write('not json at all'); process.exit(0) }
  const findings = process.env.FAKE_CLAUDE_FINDINGS
    ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_FINDINGS, 'utf8'))
    : { findings: [{ title: `bug in ${argv[1]}`, file: 'src/core/mod1.py', line: 3 }] }
  process.stdout.write(JSON.stringify(findings))
  process.exit(0)
}, delay)
