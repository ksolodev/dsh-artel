/**
 * Config and data-path tests for the Host half.
 *
 * `lib/index.js` is imported for real: it only pulls node builtins and the
 * plugin's own modules, so it parses outside a DSH Host.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { defaultDataRoot, legacyDataRoot, migrateDataRoot, profileOf, resolveConfig } from '../lib/index.js'

test('the data root follows DSH_HOME and DSH_PROFILE', () => {
  const root = defaultDataRoot({ DSH_HOME: 'D:\\dsh-home', DSH_PROFILE: 'desktop' }, 'C:\\Users\\me')
  assert.equal(root, path.join('D:\\dsh-home', 'artel', 'desktop'))
})

test('the data root falls back to ~/.dsh and the default profile', () => {
  const root = defaultDataRoot({}, 'C:\\Users\\me')
  assert.equal(root, path.join('C:\\Users\\me', '.dsh', 'artel', 'default'))
})

test('the profile name comes from the profile directory when DSH_PROFILE is missing', () => {
  assert.equal(profileOf({ DSH_PROFILE_DIR: 'C:\\Users\\me\\.dsh\\profiles\\desktop' }), 'desktop')
  assert.equal(profileOf({ DSH_PROFILE: 'custom', DSH_PROFILE_DIR: 'C:\\profiles\\other' }), 'custom')
  assert.equal(profileOf({ DSH_PROFILE_DIR: 'C:\\profiles\\' }), 'profiles')
  assert.equal(profileOf({}), 'default')
})

test('the configuration has working defaults', () => {
  const settings = resolveConfig({}, { DSH_HOME: 'D:\\dsh-home', DSH_PROFILE: 'desktop' })
  assert.equal(settings.copyRoot, path.join('D:\\dsh-home', 'artel', 'desktop', 'copies'))
  assert.equal(settings.stateDir, path.join('D:\\dsh-home', 'artel', 'desktop', 'state'))
  assert.equal(settings.swarmAgentCount, 3)
  assert.equal(settings.maxRunsPerSession, 10)
  assert.equal(settings.keepCopiesHours, 72)
  assert.equal(settings.diffContext, 3)
  assert.equal(settings.idleGraceMs, 1200)
  assert.deepEqual(settings.excludeGlobs, [])
})

test('the configuration clamps numbers and keeps explicit paths and globs', () => {
  const settings = resolveConfig({
    swarmAgentCount: 99,
    maxRunsPerSession: 0,
    keepCopiesHours: -5,
    diffContext: 40,
    idleGraceMs: 99_000,
    copyRoot: 'D:\\copies',
    stateDir: 'D:\\state',
    exclude: ['dist/**', '', 42],
  }, {})

  assert.equal(settings.swarmAgentCount, 8)
  assert.equal(settings.maxRunsPerSession, 1)
  assert.equal(settings.keepCopiesHours, 0)
  assert.equal(settings.diffContext, 12)
  assert.equal(settings.idleGraceMs, 10_000)
  assert.equal(settings.copyRoot, 'D:\\copies')
  assert.equal(settings.stateDir, 'D:\\state')
  assert.deepEqual(settings.excludeGlobs, ['dist/**'])
})

test('the pre-rename data root is moved to the new directory on first start', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-artel-migrate-'))
  try {
    const env = { DSH_PROFILE: 'desktop' }
    const legacy = legacyDataRoot(env, home)
    mkdirSync(path.join(legacy, 'state'), { recursive: true })
    writeFileSync(path.join(legacy, 'state', 'runs.json'), '{"runs":[]}')

    const result = migrateDataRoot(env, home)

    assert.equal(result.moved, true)
    assert.equal(result.how, 'renamed')
    assert.equal(result.from, legacy)
    assert.equal(result.to, defaultDataRoot(env, home))
    assert.equal(readFileSync(path.join(result.to, 'state', 'runs.json'), 'utf8'), '{"runs":[]}')
    assert.equal(existsSync(legacy), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an existing new data root is never overwritten by the migration', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-artel-keep-'))
  try {
    const env = { DSH_PROFILE: 'desktop' }
    const legacy = legacyDataRoot(env, home)
    const root = defaultDataRoot(env, home)
    mkdirSync(legacy, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(legacy, 'old.txt'), 'old')
    writeFileSync(path.join(root, 'new.txt'), 'new')

    const result = migrateDataRoot(env, home)

    assert.equal(result.moved, false)
    assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new')
    assert.equal(existsSync(path.join(root, 'old.txt')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the migration is a no-op when there is nothing to move', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-artel-fresh-'))
  try {
    const result = migrateDataRoot({ DSH_PROFILE: 'desktop' }, home)
    assert.equal(result.moved, false)
    assert.equal(existsSync(defaultDataRoot({ DSH_PROFILE: 'desktop' }, home)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
