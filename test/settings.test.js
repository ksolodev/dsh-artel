import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { availableLocales, defaultSettings, isValidLanguageTag, readSettings, settingsPath, writeSettings } from '../lib/settings.js'

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artel-settings-'))
}

test('missing settings read as defaults', async () => {
  const dir = await tempDir()
  assert.deepEqual(await readSettings(dir), defaultSettings())
})

test('writeSettings persists and readSettings returns it', async () => {
  const dir = await tempDir()
  await writeSettings(dir, { language: 'ru' })
  assert.deepEqual(await readSettings(dir), { version: 1, language: 'ru' })
  const raw = JSON.parse(await fs.readFile(settingsPath(dir), 'utf8'))
  assert.equal(raw.language, 'ru')
})

test('null language means "follow DSH"', async () => {
  const dir = await tempDir()
  await writeSettings(dir, { language: 'zh' })
  await writeSettings(dir, { language: null })
  assert.equal((await readSettings(dir)).language, null)
})

test('corrupt settings fall back to defaults', async () => {
  const dir = await tempDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(settingsPath(dir), '{not json', 'utf8')
  assert.deepEqual(await readSettings(dir), defaultSettings())
})

test('an invalid tag is rejected and the file is untouched', async () => {
  const dir = await tempDir()
  await writeSettings(dir, { language: 'ru' })
  await assert.rejects(writeSettings(dir, { language: 'ru ru' }), /invalid language tag/)
  assert.equal((await readSettings(dir)).language, 'ru')
})

test('isValidLanguageTag accepts BCP-47 shapes', () => {
  for (const tag of ['en', 'ru', 'zh', 'pt-BR', 'zh-Hans-CN']) assert.equal(isValidLanguageTag(tag), true, tag)
  for (const tag of ['', 'ru ru', 'x', '../ru', 'en_US']) assert.equal(isValidLanguageTag(tag), false, tag)
})

test('availableLocales reads the repository catalogs with native names', async () => {
  const catalogues = await availableLocales(path.resolve('locale'))
  assert.deepEqual(catalogues.map((entry) => entry.id), ['en', 'ru', 'zh'])
  assert.equal(catalogues[0].nativeName, 'English')
  for (const entry of catalogues) assert.ok(entry.nativeName !== '')
})
