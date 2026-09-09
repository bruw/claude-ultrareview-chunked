import { styleText } from 'node:util'

const plain = () => !process.stderr.isTTY || process.env.NO_COLOR || process.argv.includes('--no-color')

export const c = {
  dim: s => plain() ? s : styleText('dim', s),
  bold: s => plain() ? s : styleText('bold', s),
  green: s => plain() ? s : styleText('green', s),
  yellow: s => plain() ? s : styleText('yellow', s),
  red: s => plain() ? s : styleText('red', s),
  cyan: s => plain() ? s : styleText('cyan', s)
}

/** stderr is for the user; stdout is reserved for the answer. */
export const say = (...a) => process.stderr.write(a.join(' ') + '\n')
export const out = s => process.stdout.write(s.endsWith('\n') ? s : s + '\n')

export function num (n) {
  return n.toLocaleString('en-US')
}

export function table (headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map(r => r.map(x => String(x ?? '')))
  const w = headers.map((_, i) => Math.max(...all.map(r => visible(r[i]).length)))
  const line = r => r.map((cell, i) =>
    align[i] === 'r' ? pad(cell, w[i], true) : pad(cell, w[i])).join('  ').trimEnd()
  return [c.dim(line(all[0])), ...all.slice(1).map(line)].join('\n')
}

// styleText wraps cells in escapes; column width has to ignore them.
const visible = s => s.replace(/\x1b\[[0-9;]*m/g, '')
function pad (s, n, right = false) {
  const gap = ' '.repeat(Math.max(0, n - visible(s).length))
  return right ? gap + s : s + gap
}

export const STATUS_STYLE = {
  covered: s => c.dim(s), done: s => c.green(s), running: s => c.cyan(s),
  queued: s => c.cyan(s), pending: s => s, new: s => s, partial: s => c.yellow(s),
  failed: s => c.red(s), timeout: s => c.red(s), crashed: s => c.red(s),
  orphaned: s => c.red(s), interrupted: s => c.yellow(s)
}

export function paintStatus (s) {
  return (STATUS_STYLE[s] ?? (x => x))(s)
}

/** The cost band is a documented default, correctable without a release. */
export const COST_LOW = Number(process.env.CURC_COST_LOW ?? 5)
export const COST_HIGH = Number(process.env.CURC_COST_HIGH ?? 25)

export function costBand (n) {
  return `$${num(n * COST_LOW)}–$${num(n * COST_HIGH)}`
}
