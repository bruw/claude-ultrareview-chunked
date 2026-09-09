import readline from 'node:readline/promises'
import { stdin, stderr } from 'node:process'
import { c } from './ui.js'

export const isTTY = () => Boolean(stdin.isTTY && stderr.isTTY)

/** Non-TTY callers get told the exact flag to pass instead of a hang. */
export class NeedsFlag extends Error {
  constructor (flag, what) {
    super(`${what} is required when stdin is not a terminal — pass ${flag}`)
    this.flag = flag
    this.exitCode = 5
  }
}

let rl = null
function iface () {
  rl ??= readline.createInterface({ input: stdin, output: stderr })
  return rl
}
export function closePrompt () { rl?.close(); rl = null }

export async function ask (question, { default: def = '' } = {}) {
  const hint = def ? c.dim(` [${def}]`) : ''
  const answer = (await iface().question(`${question}${hint} `)).trim()
  return answer || def
}

export async function confirm (question, { default: def = false } = {}) {
  const hint = def ? 'Y/n' : 'y/N'
  const a = (await ask(`${question} ${c.dim(`(${hint})`)}`)).toLowerCase()
  if (!a) return def
  return a === 'y' || a === 'yes'
}

/**
 * A menu that always returns a key, never an index — so reordering the menu
 * cannot silently change what a choice does.
 */
export async function menu (title, options) {
  stderr.write(`\n${c.bold(title)}\n`)
  options.forEach((o, i) => {
    stderr.write(`  ${c.cyan(String(i + 1))}  ${o.label}${o.hint ? c.dim('  ' + o.hint) : ''}\n`)
  })
  for (;;) {
    const a = await ask('\n>')
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].key
    const byKey = options.find(o => o.key === a.toLowerCase())
    if (byKey) return byKey.key
    stderr.write(c.yellow(`  pick 1–${options.length}\n`))
  }
}

/** Numbered toggle list; Enter accepts. Returns the selected items. */
export async function toggleList (title, items, { render, selected = new Set() } = {}) {
  for (;;) {
    stderr.write(`\n${c.bold(title)}\n`)
    items.forEach((it, i) => {
      const mark = selected.has(i) ? c.green('x') : ' '
      stderr.write(`  [${mark}] ${c.cyan(String(i + 1).padStart(2))}  ${render(it)}\n`)
    })
    stderr.write(c.dim('\n  toggle by number (or "1-4", "1,3"), [a]ll, [n]one, Enter to accept\n'))
    const a = (await ask('>')).toLowerCase()
    if (!a) return items.filter((_, i) => selected.has(i))
    if (a === 'a') { items.forEach((_, i) => selected.add(i)); continue }
    if (a === 'n') { selected.clear(); continue }
    const picked = parseSpec(a, items.length)
    if (!picked.length) { stderr.write(c.yellow('  did not understand that\n')); continue }
    for (const i of picked) selected.has(i) ? selected.delete(i) : selected.add(i)
  }
}

/** "1,3", "2-5", "all" → zero-based indices. */
export function parseSpec (spec, len) {
  if (spec === 'all') return [...Array(len).keys()]
  const picked = new Set()
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y)
      for (let i = a; i <= b; i++) if (i >= 1 && i <= len) picked.add(i - 1)
    } else if (/^\d+$/.test(part)) {
      const i = Number(part)
      if (i >= 1 && i <= len) picked.add(i - 1)
    } else return []
  }
  return [...picked].sort((a, b) => a - b)
}
