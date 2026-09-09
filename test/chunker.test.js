import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkFiles } from '../src/chunker.js'

const f = (path, lines) => ({ path, blob: path, lines })

test('every file lands in exactly one chunk', () => {
  const files = [f('a/1.js', 10), f('a/2.js', 10), f('b/1.js', 10)]
  const seen = chunkFiles(files, { maxLines: 25, maxFiles: 10 }).flatMap(c => c.files.map(x => x.path))
  assert.deepEqual(seen.sort(), files.map(x => x.path).sort())
})

test('no chunk exceeds either cap', () => {
  const files = Array.from({ length: 40 }, (_, i) => f(`d${i % 5}/f${i}.js`, 300))
  for (const c of chunkFiles(files, { maxLines: 1000, maxFiles: 3 })) {
    assert.ok(c.lines <= 1000, `chunk ${c.id} has ${c.lines} lines`)
    assert.ok(c.files.length <= 3, `chunk ${c.id} has ${c.files.length} files`)
  }
})

test('a directory that fits is kept whole', () => {
  const files = [f('a/1.js', 100), f('a/2.js', 100), f('b/1.js', 100)]
  const chunks = chunkFiles(files, { maxLines: 250, maxFiles: 10 })
  const withA = chunks.find(c => c.files.some(x => x.path.startsWith('a/')))
  assert.equal(withA.files.filter(x => x.path.startsWith('a/')).length, 2)
})

test('a directory too big for one chunk is split, not overflowed', () => {
  const files = Array.from({ length: 10 }, (_, i) => f(`big/f${i}.js`, 400))
  const chunks = chunkFiles(files, { maxLines: 1000, maxFiles: 100 })
  assert.ok(chunks.length >= 4)
  for (const c of chunks) assert.ok(c.lines <= 1000)
})

test('chunk ids are 1-based and contiguous', () => {
  const chunks = chunkFiles([f('a/1.js', 5), f('b/1.js', 5)], { maxLines: 5, maxFiles: 10 })
  assert.deepEqual(chunks.map(c => c.id), chunks.map((_, i) => i + 1))
})

test('no files means no chunks', () => {
  assert.deepEqual(chunkFiles([], { maxLines: 100, maxFiles: 10 }), [])
})
