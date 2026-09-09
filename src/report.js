import fs from 'node:fs'
import path from 'node:path'
import { readRun, runState, classifyChunk } from './ledger.js'
import { chunkLabel } from './chunker.js'
import { pad } from './paths.js'
import { lockHolder } from './preflight.js'

/** One merged view of the plan and every run record. Read-only. */
export function statusRows (L, ledger) {
  return (ledger?.chunks ?? []).map(ch => {
    const run = readRun(L, ch.id)
    return {
      id: ch.id,
      label: pad(ch.id),
      files: ch.files.length,
      lines: ch.lines,
      area: chunkLabel(ch),
      coverage: classifyChunk(ch, ledger.reviewed),
      state: runState(run),
      run
    }
  })
}

export function doneRows (L, ledger) {
  return (ledger?.archive ?? []).map(a => {
    const run = readRun(L, a.id)
    return {
      id: a.id,
      label: pad(a.id),
      files: a.files.length,
      lines: a.lines,
      area: chunkLabel(a),
      findings: run?.findingCount ?? null,
      sessionUrl: run?.sessionUrl ?? null,
      at: run?.finishedAt ?? a.at
    }
  })
}

export function snapshot (L, ledger) {
  const rows = statusRows(L, ledger)
  const counts = {}
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1
  return {
    snapshot: ledger?.snapshot ?? null,
    caps: ledger?.caps ?? {},
    scope: ledger?.scope ?? {},
    supervisor: lockHolder(L),
    counts,
    pending: rows,
    completed: doneRows(L, ledger),
    reviewedFiles: Object.keys(ledger?.reviewed ?? {}).length
  }
}

/** Findings across chunks, each carrying where and when it came from. */
export function collectFindings (L, ledger, ids = null) {
  const out = []
  for (const a of ledger?.archive ?? []) {
    if (ids && !ids.includes(a.id)) continue
    const p = L.findingsFor(a.id)
    if (!fs.existsSync(p)) continue
    let parsed = null
    const raw = fs.readFileSync(p, 'utf8')
    try { parsed = JSON.parse(raw) } catch {
      out.push({ _curc: { chunkId: a.id, parseError: true, findingsPath: path.relative(L.root, p) } })
      continue
    }
    const list = Array.isArray(parsed) ? parsed
      : parsed?.findings ?? parsed?.bugs ?? parsed?.results ?? []
    const run = readRun(L, a.id)
    for (const f of list) {
      out.push({ ...f, _curc: { chunkId: a.id, snapshot: a.snapshot, reviewedAt: run?.finishedAt ?? a.at, sessionUrl: run?.sessionUrl ?? null } })
    }
  }
  return out
}
