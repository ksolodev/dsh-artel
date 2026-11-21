import fs from 'node:fs/promises'
import path from 'node:path'

export const SETTINGS_VERSION = 1
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/

export function isValidLanguageTag(value) {
  return typeof value === 'string' && LANGUAGE_TAG.test(value.trim())
}

export function settingsPath(stateDir) {
  return path.join(stateDir, 'settings.json')
}

export function defaultSettings() {
  return { version: SETTINGS_VERSION, language: null }
}

/** Settings of one profile; a missing or unreadable file means "all defaults". */
export async function readSettings(stateDir) {
  let raw
  try {
    raw = await fs.readFile(settingsPath(stateDir), 'utf8')
  } catch {
    return defaultSettings()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultSettings()
  }
  if (parsed === null || typeof parsed !== 'object') return defaultSettings()
  return {
    version: SETTINGS_VERSION,
    language: isValidLanguageTag(parsed.language) ? parsed.language : null,
  }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, text, 'utf8')
  try {
    await fs.rename(temp, file)
  } catch (error) {
    // Windows refuses to replace an open file; removing first is the portable fix.
    if (process.platform !== 'win32') throw error
    await fs.rm(file, { force: true })
    await fs.rename(temp, file)
  }
}

/** Merge `patch` into the current settings and persist atomically. */
export async function writeSettings(stateDir, patch) {
  const current = await readSettings(stateDir)
  const next = { ...current, ...patch, version: SETTINGS_VERSION }
  if (next.language !== null && next.language !== undefined && !isValidLanguageTag(next.language)) {
    throw new Error(`invalid language tag: ${next.language}`)
  }
  next.language = next.language ?? null
  await writeAtomic(settingsPath(stateDir), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** Every `<tag>.json` in `localeDir`, English first, with its native name. */
export async function availableLocales(localeDir) {
  const entries = await fs.readdir(localeDir, { withFileTypes: true })
  const catalogues = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!isValidLanguageTag(id)) continue
    let meta = {}
    try {
      meta = JSON.parse(await fs.readFile(path.join(localeDir, entry.name), 'utf8')).meta ?? {}
    } catch {
      continue
    }
    catalogues.push({
      id,
      nativeName: typeof meta.nativeName === 'string' && meta.nativeName.trim() !== '' ? meta.nativeName : id,
      dir: meta.dir === 'rtl' ? 'rtl' : 'ltr',
    })
  }
  return catalogues.sort((left, right) => {
    if (left.id === 'en') return -1
    if (right.id === 'en') return 1
    return left.id.localeCompare(right.id)
  })
}
