import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readCatalogs, render, replaceRegion } from '../tools/build-locales.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALE_DIR = path.join(ROOT, 'locale')
const PLURAL = /^(.*)\.(zero|one|two|few|many|other)$/
const catalogs = readCatalogs(LOCALE_DIR)
const tags = Object.keys(catalogs).sort()

function nonPlural(strings) {
  return Object.keys(strings).filter((key) => !PLURAL.test(key)).sort()
}

test('every catalogue has the English non-plural keys', () => {
  const english = nonPlural(catalogs.en.strings)
  assert.ok(english.length > 400, `expected a full catalog, got ${english.length} keys`)
  for (const tag of tags) {
    assert.deepEqual(nonPlural(catalogs[tag].strings), english, `${tag} keys`)
  }
})

test('every value is a non-empty string', () => {
  for (const tag of tags) {
    for (const [key, value] of Object.entries(catalogs[tag].strings)) {
      assert.equal(typeof value, 'string', `${tag} ${key}`)
      assert.notEqual(value.trim(), '', `${tag} ${key}`)
    }
  }
})

test('each catalogue defines exactly its plural categories', () => {
  const bases = new Set()
  for (const tag of tags) {
    for (const key of Object.keys(catalogs[tag].strings)) {
      const match = PLURAL.exec(key)
      if (match !== null) bases.add(match[1])
    }
  }
  for (const tag of tags) {
    const required = new Intl.PluralRules(tag).resolvedOptions().pluralCategories
    for (const base of bases) {
      const forms = Object.keys(catalogs[tag].strings)
        .filter((key) => PLURAL.test(key) && PLURAL.exec(key)[1] === base)
        .map((key) => key.slice(base.length + 1))
        .sort()
      assert.deepEqual(forms, [...required].sort(), `${tag} ${base} plural forms`)
    }
  }
})

test('placeholders match English', () => {
  const tokens = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const tag of tags) {
    for (const [key, value] of Object.entries(catalogs[tag].strings)) {
      if (PLURAL.test(key)) continue
      assert.deepEqual(tokens(value), tokens(catalogs.en.strings[key]), `${tag} ${key}`)
    }
  }
})

test('meta is complete', () => {
  for (const tag of tags) {
    const { meta } = catalogs[tag]
    assert.equal(typeof meta.title, 'string')
    assert.notEqual(meta.title, '')
    assert.equal(typeof meta.description, 'string')
    assert.equal(typeof meta.nativeName, 'string')
    assert.notEqual(meta.nativeName.trim(), '')
    assert.ok(meta.dir === undefined || meta.dir === 'ltr' || meta.dir === 'rtl', `${tag} dir`)
  }
})

test('the generated client block matches the catalogs', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.equal(replaceRegion(source, render(catalogs)), source, 'run node tools/build-locales.mjs')
})
