import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { applyChanges, collectChanges, copyProjectTree, hashFile, removeCopy } from '../lib/copy.js'

const TMP_ROOT = path.join(process.cwd(), 'test', '.tmp')

async function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
}

async function freshDir(name) {
  const dir = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function exists(abs) {
  try {
    await fs.stat(abs)
    return true
  } catch {
    return false
  }
}

test('copy excludes vcs/deps, links node_modules and records a base manifest', async () => {
  const root = await freshDir('copy')
  const project = path.join(root, 'project')
  const target = path.join(root, 'run-1')
  await makeTree(project, {
    'a.txt': 'alpha\n',
    'src/b.ts': 'export const b = 1\n',
    '.git/config': '[core]\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
    'debug.log': 'noise\n',
  })

  const result = await copyProjectTree(project, target, { exclude: ['**/*.log'] })
  assert.deepEqual(Object.keys(result.base).sort(), ['a.txt', 'src/b.ts'])
  assert.equal(result.files, 2)
  assert.equal(result.linkedNodeModules, true)
  assert.equal(await exists(path.join(target, '.git')), false)
  assert.equal(await exists(path.join(target, 'debug.log')), false)
  assert.equal(await exists(path.join(target, 'src/b.ts')), true)
  // Linked dependency tree is readable but was not copied.
  assert.equal(await exists(path.join(target, 'node_modules/pkg/index.js')), true)

  await fs.rm(root, { recursive: true, force: true })
})

test('collectChanges reports added, modified and deleted files with hunks', async () => {
  const root = await freshDir('collect')
  const project = path.join(root, 'project')
  const target = path.join(root, 'run')
  await makeTree(project, {
    'keep.txt': 'same\n',
    'edit.txt': 'one\ntwo\nthree\n',
    'gone.txt': 'bye\n',
  })
  const { base } = await copyProjectTree(project, target)

  await fs.writeFile(path.join(target, 'edit.txt'), 'one\nTWO\nthree\n')
  await fs.writeFile(path.join(target, 'fresh.txt'), 'hello\n')
  await fs.rm(path.join(target, 'gone.txt'))

  const changes = await collectChanges({ copyRoot: target, beforeRoot: project, base })
  const byPath = Object.fromEntries(changes.map((change) => [change.path, change]))
  assert.equal(byPath['keep.txt'], undefined)
  assert.equal(byPath['edit.txt'].status, 'modified')
  assert.equal(byPath['edit.txt'].added, 1)
  assert.equal(byPath['edit.txt'].removed, 1)
  assert.equal(byPath['edit.txt'].hunks[0].lines.map((line) => line.type + line.text).join('|'), ' one|-two|+TWO| three')
  assert.equal(byPath['fresh.txt'].status, 'added')
  assert.equal(byPath['gone.txt'].status, 'deleted')

  await fs.rm(root, { recursive: true, force: true })
})

test('apply writes changes into the project and can be filtered by path', async () => {
  const root = await freshDir('apply')
  const project = path.join(root, 'project')
  const target = path.join(root, 'run')
  await makeTree(project, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'old.txt': 'old\n' })
  const { base } = await copyProjectTree(project, target)

  await fs.writeFile(path.join(target, 'a.txt'), 'a2\n')
  await fs.writeFile(path.join(target, 'b.txt'), 'b2\n')
  await fs.writeFile(path.join(target, 'new.txt'), 'new\n')
  await fs.rm(path.join(target, 'old.txt'))
  const changes = await collectChanges({ copyRoot: target, beforeRoot: project, base })

  const partial = await applyChanges({ projectRoot: project, copyRoot: target, base, changes, paths: ['a.txt'] })
  assert.deepEqual(partial.applied, ['a.txt'])
  assert.equal(await fs.readFile(path.join(project, 'b.txt'), 'utf8'), 'b\n')

  const rest = await applyChanges({
    projectRoot: project,
    copyRoot: target,
    base,
    changes,
    paths: ['b.txt', 'new.txt', 'old.txt'],
  })
  assert.deepEqual(rest.applied.sort(), ['b.txt', 'new.txt', 'old.txt'])
  assert.equal(await fs.readFile(path.join(project, 'a.txt'), 'utf8'), 'a2\n')
  assert.equal(await fs.readFile(path.join(project, 'new.txt'), 'utf8'), 'new\n')
  assert.equal(await exists(path.join(project, 'old.txt')), false)

  await fs.rm(root, { recursive: true, force: true })
})

test('apply refuses to overwrite a file the user changed during the run', async () => {
  const root = await freshDir('guard')
  const project = path.join(root, 'project')
  const target = path.join(root, 'run')
  await makeTree(project, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const { base } = await copyProjectTree(project, target)

  await fs.writeFile(path.join(target, 'a.txt'), 'agent-change\n')
  await fs.writeFile(path.join(target, 'b.txt'), 'agent-change\n')
  await fs.writeFile(path.join(project, 'a.txt'), 'user-change\n') // user edited meanwhile
  const changes = await collectChanges({ copyRoot: target, beforeRoot: project, base })

  const result = await applyChanges({ projectRoot: project, copyRoot: target, base, changes })
  assert.deepEqual(result.applied, ['b.txt'])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].path, 'a.txt')
  assert.match(result.skipped[0].reason, /changed in your project/)
  assert.equal(await fs.readFile(path.join(project, 'a.txt'), 'utf8'), 'user-change\n')

  await fs.rm(root, { recursive: true, force: true })
})

test('apply rejects path traversal and excluded paths', async () => {
  const root = await freshDir('traversal')
  const project = path.join(root, 'project')
  const target = path.join(root, 'run')
  await makeTree(project, { 'a.txt': 'a\n' })
  const { base } = await copyProjectTree(project, target)
  await fs.writeFile(path.join(target, 'a.txt'), 'a2\n')
  const changes = await collectChanges({ copyRoot: target, beforeRoot: project, base })

  const result = await applyChanges({
    projectRoot: project,
    copyRoot: target,
    base,
    changes,
    paths: ['../outside.txt', 'node_modules/evil.js', 'a.txt'],
  })
  assert.deepEqual(result.applied, ['a.txt'])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].path, '../outside.txt')
  assert.match(result.skipped[0].reason, /parent escape/)

  await fs.rm(root, { recursive: true, force: true })
})

test('removeCopy refuses paths outside the copy root', async () => {
  const root = await freshDir('remove')
  const copyRoot = path.join(root, 'copies')
  const inside = path.join(copyRoot, 'run')
  await fs.mkdir(inside, { recursive: true })
  await assert.rejects(() => removeCopy(copyRoot, path.join(root, 'project')), /refusing to remove copy outside/)
  await removeCopy(copyRoot, inside)
  assert.equal(await exists(inside), false)
  await fs.rm(root, { recursive: true, force: true })
})

test('copy refuses a target inside the project', async () => {
  const root = await freshDir('inside')
  const project = path.join(root, 'project')
  await fs.mkdir(project, { recursive: true })
  await assert.rejects(() => copyProjectTree(project, path.join(project, 'copy')), /outside the project/)
  await fs.rm(root, { recursive: true, force: true })
})

test('hashFile returns null for missing files and a hash for real ones', async () => {
  const root = await freshDir('hash')
  const file = path.join(root, 'x.txt')
  await fs.writeFile(file, 'x')
  const entry = await hashFile(file)
  assert.equal(entry.size, 1)
  assert.equal(entry.hash.length, 64)
  assert.equal(await hashFile(path.join(root, 'nope.txt')), null)
  await fs.rm(root, { recursive: true, force: true })
})
