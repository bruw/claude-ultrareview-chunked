#!/usr/bin/env node
import { main } from '../src/cli.js'

main(process.argv.slice(2))
  .then(code => { process.exitCode = code ?? 0 })
  .catch(err => {
    process.stderr.write(`curc: ${err?.message ?? err}\n`)
    process.exitCode = err?.exitCode ?? 1
  })
