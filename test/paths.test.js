import test from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, isCopyExcluded, isInside, normalizeRelPath, resolveIn } from '../lib/paths.js'

test('normalizeRelPath accepts project-relative paths', () => {
  assert.equal(normalizeRelPath('src/a.ts'), 'src/a.ts')
  assert.equal(normalizeRelPath('./src/a.ts'), 'src/a.ts')
  assert.equal(normalizeRelPath('src\\a.ts'), 'src/a.ts')
  assert.equal(normalizeRelPath('src//a.ts'), 'src/a.ts')
})

test('normalizeRelPath rejects escapes and absolute paths', () => {
  assert.throws(() => normalizeRelPath('../secret'), /parent escape/)
  assert.throws(() => normalizeRelPath('src/../../secret'), /parent escape/)
  assert.throws(() => normalizeRelPath('C:/Windows/x'), /drive path/)
  assert.throws(() => normalizeRelPath('/etc/passwd'), /absolute path/)
  assert.throws(() => normalizeRelPath(''), /empty path/)
})

test('isInside handles root itself and siblings', () => {
  assert.equal(isInside('C:/work/project', 'C:/work/project/app/lib'), true)
  assert.equal(isInside('C:/work/project', 'C:/work/project'), true)
  assert.equal(isInside('C:/work/project', 'C:/work/project2/app'), false)
  assert.equal(isInside('C:/work/project', 'C:/work'), false)
})

test('resolveIn joins safely', () => {
  const resolved = resolveIn('C:/work/project', 'src/app/a.ts')
  assert.match(resolved.replace(/\\/g, '/'), /project\/src\/app\/a\.ts$/)
  assert.throws(() => resolveIn('C:/work/project', '../x'), /parent escape/)
})

test('globToRegExp behaves like a path glob', () => {
  assert.equal(globToRegExp('**/*.log').test('logs/a.log'), true)
  assert.equal(globToRegExp('**/*.log').test('a.log'), true)
  assert.equal(globToRegExp('*.log').test('logs/a.log'), false)
  assert.equal(globToRegExp('src/**').test('src/a/b.ts'), true)
  assert.equal(globToRegExp('src/**').test('src'), true)
})

test('isCopyExcluded skips vcs, deps and configured globs', () => {
  assert.equal(isCopyExcluded('.git/config'), true)
  assert.equal(isCopyExcluded('node_modules/react/index.js'), true)
  assert.equal(isCopyExcluded('src/index.ts'), false)
  assert.equal(isCopyExcluded('dist/bundle.js', { exclude: ['dist/**'] }), true)
  assert.equal(isCopyExcluded('dist', { exclude: ['dist/**'] }), true)
  assert.equal(isCopyExcluded('logs/app.log', { exclude: ['**/*.log'] }), true)
  assert.equal(isCopyExcluded('logs/latest/app.log', { exclude: ['**/*.log'] }), true)
  assert.equal(isCopyExcluded('src/log.ts', { exclude: ['**/*.log'] }), false)
  assert.equal(isCopyExcluded('tmp/build/x', { exclude: ['tmp/'] }), true)
})
