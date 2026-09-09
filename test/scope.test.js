import test from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, matchesAny, collectFiles } from '../src/scope.js'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'

test('** matches across directories and also zero of them', () => {
  assert.ok(globToRegExp('**/*.png').test('a/b/c.png'))
  assert.ok(globToRegExp('**/*.png').test('c.png'))
  assert.ok(!globToRegExp('**/*.png').test('c.pngx'))
})

test('* does not cross a directory boundary', () => {
  assert.ok(globToRegExp('src/*.js').test('src/a.js'))
  assert.ok(!globToRegExp('src/*.js').test('src/nested/a.js'))
})

test('lockfiles, binaries and oversize files are dropped, each for its own reason', async () => {
  const { dir } = tmpRepo({
    'src/a.js': lines(10),
    'src/huge.js': lines(5000),
    'package-lock.json': '{}\n',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('binary')
  })
  const { files, dropped } = await collectFiles(dir, { include: [], exclude: [], maxLines: 1000 })
  assert.deepEqual(files.map(f => f.path), ['src/a.js'])
  assert.ok(dropped.excluded.includes('package-lock.json'))
  assert.ok(dropped.excluded.includes('assets/logo.png'))
  assert.equal(dropped.oversize[0].path, 'src/huge.js')
  cleanup(dir)
})

test('a file bigger than the cap is dropped, never made into an over-cap chunk', async () => {
  const { dir } = tmpRepo({ 'src/huge.js': lines(9000) })
  const { files, dropped } = await collectFiles(dir, { include: [], exclude: [], maxLines: 7500 })
  assert.equal(files.length, 0)
  assert.equal(dropped.oversize.length, 1)
  cleanup(dir)
})

test('extra excludes are honoured', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(5), 'gen/b.js': lines(5) })
  const { files } = await collectFiles(dir, { include: [], exclude: ['gen/**'], maxLines: 1000 })
  assert.deepEqual(files.map(f => f.path), ['src/a.js'])
  cleanup(dir)
})
