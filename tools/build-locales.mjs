#!/usr/bin/env node
/**
 * Compiles locale/*.json into the generated dictionary block of lib/client.js.
 * Usage: node tools/build-locales.mjs [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALE_DIR = path.join(ROOT, 'locale')
const CLIENT_PATH = path.join(ROOT, 'lib', 'client.js')
export const BEGIN = '/* @generated locales:begin */'
export const END = '/* @generated locales:end */'
const PLURAL_SUFFIX = /^(.*)\.(zero|one|two|few|many|other)$/
const TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/
const BASE = 'en'

export function readCatalogs(localeDir = LOCALE_DIR) {
  const catalogs = {}
  for (const file of fs.readdirSync(localeDir).filter((name) => name.endsWith('.json')).sort()) {
    const tag = file.slice(0, -'.json'.length)
    if (!TAG.test(tag)) throw new Error(`${file}: "${tag}" is not a BCP-47 language tag`)
    const parsed = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error(`${file}: expected an object`)
    if (parsed.meta === null || typeof parsed.meta !== 'object') throw new Error(`${file}: meta is missing`)
    if (typeof parsed.meta.nativeName !== 'string' || parsed.meta.nativeName.trim() === '') throw new Error(`${file}: meta.nativeName is required`)
    if (parsed.meta.dir !== undefined && parsed.meta.dir !== 'ltr' && parsed.meta.dir !== 'rtl') throw new Error(`${file}: meta.dir must be "ltr" or "rtl"`)
    if (parsed.strings === null || typeof parsed.strings !== 'object') throw new Error(`${file}: strings is missing`)
    for (const [key, value] of Object.entries(parsed.strings)) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`${file}: "${key}" must be a non-empty string`)
    }
    catalogs[tag] = parsed
  }
  if (catalogs[BASE] === undefined) throw new Error('locale/en.json is required: English is the fallback')
  return catalogs
}

function pluralBase(key) {
  const match = PLURAL_SUFFIX.exec(key)
  return match === null ? null : match[1]
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
}

function validate(catalogs) {
  const english = catalogs[BASE].strings
  const englishKeys = Object.keys(english).filter((key) => pluralBase(key) === null).sort()
  const bases = new Set()
  for (const catalog of Object.values(catalogs)) {
    for (const key of Object.keys(catalog.strings)) {
      const base = pluralBase(key)
      if (base !== null) bases.add(base)
    }
  }
  for (const [tag, catalog] of Object.entries(catalogs)) {
    const strings = catalog.strings
    const ownKeys = Object.keys(strings).filter((key) => pluralBase(key) === null)
    const missing = englishKeys.filter((key) => !ownKeys.includes(key))
    const extra = ownKeys.filter((key) => english[key] === undefined)
    if (missing.length > 0) throw new Error(`${tag}: missing keys: ${missing.join(', ')}`)
    if (extra.length > 0) throw new Error(`${tag}: keys not in en: ${extra.join(', ')}`)
    for (const key of englishKeys) {
      if (placeholders(strings[key]) !== placeholders(english[key])) throw new Error(`${tag}: placeholders differ for ${key}`)
    }
    const required = new Set(new Intl.PluralRules(tag).resolvedOptions().pluralCategories)
    for (const base of bases) {
      const forms = new Set(Object.keys(strings)
        .filter((key) => pluralBase(key) === base)
        .map((key) => key.slice(base.length + 1)))
      for (const category of required) {
        if (!forms.has(category)) throw new Error(`${tag}: ${base}.${category} is missing`)
      }
      for (const form of forms) {
        if (!required.has(form)) throw new Error(`${tag}: ${base}.${form} is not a plural category of ${tag}`)
      }
      const reference = english[`${base}.other`] ?? english[`${base}.one`] ?? strings[`${base}.other`] ?? strings[`${base}.one`]
      if (reference !== undefined) {
        for (const form of forms) {
          const key = `${base}.${form}`
          if (placeholders(strings[key]) !== placeholders(reference)) throw new Error(`${tag}: placeholders differ for ${key}`)
        }
      }
    }
  }
}

export function render(catalogs) {
  const tags = Object.keys(catalogs).sort((a, b) => a === BASE ? -1 : b === BASE ? 1 : a.localeCompare(b))
  const lines = [BEGIN, 'const DICTIONARIES = {']
  for (const tag of tags) {
    lines.push(`  ${JSON.stringify(tag)}: {`)
    for (const key of Object.keys(catalogs[tag].strings).sort()) {
      lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(catalogs[tag].strings[key])},`)
    }
    lines.push('  },')
  }
  lines.push('}', END)
  return lines.join('\n')
}

export function replaceRegion(source, block) {
  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin < 0 || end < 0 || end < begin) throw new Error(`lib/client.js has no ${BEGIN} … ${END} region`)
  // Keep the region aligned with the code around it: the block lives inside the
  // plugin factory, so every generated line inherits the marker's indentation.
  const lineStart = source.lastIndexOf('\n', begin) + 1
  const indent = source.slice(lineStart, begin)
  if (indent.trim() !== '') throw new Error('the generated locale block must start on its own line')
  const aligned = block.split('\n').map((line) => line === '' ? line : indent + line).join('\n')
  return source.slice(0, lineStart) + aligned + source.slice(end + END.length)
}

function main() {
  const check = process.argv.includes('--check')
  const catalogs = readCatalogs()
  validate(catalogs)
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const next = replaceRegion(source, render(catalogs))
  if (check) {
    if (next !== source) {
      console.error('lib/client.js locale block is stale; run: node tools/build-locales.mjs')
      process.exit(1)
    }
    console.log('locale block is up to date')
    return
  }
  if (next !== source) {
    fs.writeFileSync(CLIENT_PATH, next, 'utf8')
    console.log('updated lib/client.js locale block')
  } else {
    console.log('locale block is already up to date')
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
