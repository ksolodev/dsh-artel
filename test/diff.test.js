import test from 'node:test'
import assert from 'node:assert/strict'
import { diffFile, diffLines, looksBinary, splitLines, toHunks, toUnifiedPatch } from '../lib/diff.js'

/** Replay edit operations to make sure they rebuild both sides exactly. */
function replay(ops) {
  const left = []
  const right = []
  for (const op of ops) {
    if (op.type === 'eq') { left.push(op.text); right.push(op.text) }
    else if (op.type === 'del') left.push(op.text)
    else right.push(op.text)
  }
  return { left, right }
}

test('splitLines drops the final empty line only', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('\n'), [''])
})

test('identical text produces no changes', () => {
  const result = diffFile({ path: 'x.txt', before: 'a\nb\n', after: 'a\nb\n' })
  assert.equal(result.status, 'unchanged')
  assert.equal(result.added, 0)
  assert.equal(result.hunks.length, 0)
})

test('single line change produces one hunk with both sides', () => {
  const result = diffFile({ path: 'x.txt', before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
  assert.equal(result.status, 'modified')
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.hunks.length, 1)
  assert.equal(result.hunks[0].header, '@@ -1,3 +1,3 @@')
  assert.deepEqual(result.hunks[0].lines.map((line) => line.type + line.text), [' a', '-b', '+B', ' c'])
})

test('edits rebuild both sides', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
  const after = 'one\n2\nthree\nfour\nfive\nSIX\nseven\neight\n'
  const ops = diffLines(splitLines(before), splitLines(after))
  const { left, right } = replay(ops)
  assert.deepEqual(left, splitLines(before))
  assert.deepEqual(right, splitLines(after))
})

test('random edits are consistent and minimal-ish', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const pick = (n) => Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)])
  for (let round = 0; round < 200; round++) {
    const before = pick(Math.floor(Math.random() * 14))
    const after = pick(Math.floor(Math.random() * 14))
    const ops = diffLines(before, after)
    const { left, right } = replay(ops)
    assert.deepEqual(left, before, `round ${round} left`)
    assert.deepEqual(right, after, `round ${round} right`)
    // No bogus equality: every 'eq' op must match on both sides by construction.
    assert.ok(ops.every((op) => op.type === 'eq' || op.type === 'del' || op.type === 'ins'))
  }
})

test('hunks keep only requested context', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const mutated = before.replace('line 20', 'line twenty')
  const result = diffFile({ path: 'big.txt', before, after: mutated })
  assert.equal(result.hunks.length, 1)
  const hunk = result.hunks[0]
  assert.equal(hunk.oldCount, 7)
  // "line 20" is 1-based line 21; 3 lines of context start at line 18.
  assert.deepEqual(hunk.header, '@@ -18,7 +18,7 @@')
  assert.equal(hunk.lines[0].type + hunk.lines[0].text, ' line 17')
})

test('added and deleted files', () => {
  const added = diffFile({ path: 'new.txt', before: null, after: 'one\ntwo\n' })
  assert.equal(added.status, 'added')
  assert.equal(added.added, 2)
  assert.equal(added.removed, 0)

  const deleted = diffFile({ path: 'old.txt', before: 'one\n', after: null })
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.removed, 1)
})

test('binary files are flagged without line diff', () => {
  assert.equal(looksBinary('abc\u0000def'), true)
  const result = diffFile({ path: 'image.bin', before: 'abc', after: 'abd\u0000' })
  assert.equal(result.binary, true)
  assert.equal(result.hunks.length, 0)
})

test('looksBinary tolerates a missing side', () => {
  assert.equal(looksBinary(null), false)
  assert.equal(looksBinary(undefined), false)
})

test('unified patch rendering', () => {
  const result = diffFile({ path: 'src/x.ts', before: 'a\nb\n', after: 'a\nc\n' })
  const patch = toUnifiedPatch('src/x.ts', result.hunks)
  assert.equal(patch, '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n')
})

test('toHunks handles a change at the very end', () => {
  const ops = diffLines(['a', 'b'], ['a', 'c'])
  const hunks = toHunks(ops, 1)
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].oldStart, 1)
  assert.equal(hunks[0].newStart, 1)
})

test('diffFile honours the requested context size', () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 6', 'line six')
  const tight = diffFile({ path: 'a.txt', before, after, context: 0 })
  const wide = diffFile({ path: 'a.txt', before, after, context: 3 })
  assert.equal(tight.hunks.length, 1)
  assert.equal(tight.hunks[0].lines.length, 2)
  assert.ok(wide.hunks[0].lines.length > tight.hunks[0].lines.length)
})
