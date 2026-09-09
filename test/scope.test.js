import test from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, collectFiles } from '../src/scope.js'
import { measureBlobs } from '../src/git.js'
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

/**
 * `git ls-files -s` reports a submodule's *commit* sha in the object column, and
 * an ordinary `git clone` does not fetch it — so `cat-file` answers "missing",
 * with no size and no body. A parser that assumes every record has a body loses
 * the stream there and mis-measures everything after it.
 */
function repoWithGitlink (extra = {}, { gitlinkLast = false } = {}) {
  const { dir, git } = tmpRepo({ 'a.js': lines(10, 'a'), ...extra })
  // A gitlink whose commit is deliberately not in this object store.
  git('update-index', '--add', '--cacheinfo',
    `160000,0000000000000000000000000000000000000001,${gitlinkLast ? 'zz-sub' : 'sub'}`)
  return dir
}

for (const gitlinkLast of [false, true]) {
  test(`an absent submodule does not corrupt the files ${gitlinkLast ? 'after' : 'before'} it`, async () => {
    const dir = repoWithGitlink({ 'zbig.js': lines(9000, 'z') }, { gitlinkLast })
    const { files, dropped } = await collectFiles(dir, { include: [], exclude: [], maxLines: 7500 })

    // The whole point: the big file is measured at its true size and dropped for
    // the right reason, rather than sailing into a chunk that busts the hard cap.
    assert.deepEqual(dropped.oversize, [{ path: 'zbig.js', lines: 9000 }])
    assert.deepEqual(files.map(f => f.path), ['a.js'])
    assert.equal(files[0].lines, 10)
    assert.equal(dropped.submodule.length, 1)
    assert.deepEqual(dropped.unreadable, [])
    cleanup(dir)
  })
}

test('an empty file measures as zero lines rather than derailing the stream', async () => {
  const { dir } = tmpRepo({ 'empty.js': '', 'after.js': lines(7, 'b') })
  const { files } = await collectFiles(dir, { include: [], exclude: [], maxLines: 100 })
  assert.deepEqual(files.map(f => [f.path, f.lines]), [['after.js', 7], ['empty.js', 0]])
  cleanup(dir)
})

test('a file with no trailing newline still counts its last line', async () => {
  const { dir } = tmpRepo({ 'x.js': 'one\ntwo', 'y.js': 'solo' })
  const { files } = await collectFiles(dir, { include: [], exclude: [], maxLines: 100 })
  assert.deepEqual(files.map(f => [f.path, f.lines]), [['x.js', 2], ['y.js', 1]])
  cleanup(dir)
})

test('byte-identical files share one blob and both measure correctly', async () => {
  const { dir } = tmpRepo({ 'one.js': lines(12, 'same'), 'two.js': lines(12, 'same') })
  const { files } = await collectFiles(dir, { include: [], exclude: [], maxLines: 100 })
  assert.equal(files.length, 2)
  assert.equal(files[0].blob, files[1].blob, 'the fixture is only meaningful if the blobs collide')
  assert.ok(files.every(f => f.lines === 12))
  cleanup(dir)
})

test('content larger than one stream chunk is counted in full', async () => {
  // Comfortably over the 64 KiB pipe buffer, so the parse spans several `data` events.
  const { dir } = tmpRepo({ 'big.js': lines(40000, 'wide-enough-to-span-many-reads') })
  const { files } = await collectFiles(dir, { include: [], exclude: [], maxLines: 100000 })
  assert.deepEqual(files.map(f => [f.path, f.lines]), [['big.js', 40000]])
  cleanup(dir)
})

test('measureBlobs reports an unresolvable object rather than calling it empty', async () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const absent = '0000000000000000000000000000000000000001'
  const m = await measureBlobs(dir, [absent])
  assert.deepEqual(m.get(absent), { ok: false, reason: 'missing' })
  cleanup(dir)
})

test('a non-blob object is reported as such, not measured as content', async () => {
  const { dir, git } = tmpRepo({ 'a.js': lines(4) })
  const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim()
  const m = await measureBlobs(dir, [tree])
  assert.deepEqual(m.get(tree), { ok: false, reason: 'not-a-blob', type: 'tree' })
  cleanup(dir)
})
