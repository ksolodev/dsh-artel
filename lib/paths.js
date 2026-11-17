/**
 * Path helpers shared by the host half: copy planning, containment guards and
 * the path checks behind review/apply. Pure functions only (no IO) so they can
 * be unit-tested without a running DSH host.
 */

import path from 'node:path'

/** Convert any separator mix to POSIX form (what we store and show). */
export function toPosix(input) {
  return input.replace(/\\/g, '/')
}

/**
 * Normalize a project-relative path for storage and comparison.
 * Throws for absolute paths, drive letters and parent escapes.
 */
export function normalizeRelPath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('empty path')
  const posix = toPosix(input.trim())
  if (posix.startsWith('/')) throw new Error(`absolute path not allowed: ${input}`)
  if (/^[a-zA-Z]:/.test(posix)) throw new Error(`drive path not allowed: ${input}`)
  if (posix.includes('\u0000')) throw new Error('NUL byte in path')
  const parts = posix.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new Error(`parent escape not allowed: ${input}`)
  return parts.join('/')
}

/** True when `candidate` is `root` itself or lives below it. Case-insensitive on Windows. */
export function isInside(root, candidate) {
  const rootAbs = path.resolve(root)
  const candidateAbs = path.resolve(candidate)
  let rel = path.relative(rootAbs, candidateAbs)
  if (process.platform === 'win32') rel = rel.toLowerCase()
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function assertInside(root, candidate, label = 'path') {
  if (!isInside(root, candidate)) {
    throw new Error(`${label} escapes the allowed root: ${candidate}`)
  }
  return path.resolve(candidate)
}

/** Join a project-relative POSIX path onto a root, refusing escapes. */
export function resolveIn(root, relPath) {
  const rel = normalizeRelPath(relPath)
  return assertInside(root, path.join(root, rel), rel)
}

const DEFAULT_SKIP_SEGMENTS = new Set(['.git', 'node_modules', '.dsh-artel', 'Thumbs.db', '.DS_Store'])

/** Glob -> RegExp for project-relative POSIX paths ("**" spans segments). */
export function globToRegExp(glob) {
  let pattern = toPosix(glob).replace(/^\.\//, '')
  if (pattern.endsWith('/')) pattern += '**'
  let suffix = ''
  if (pattern.endsWith('/**')) {
    pattern = pattern.slice(0, -3)
    suffix = '(?:/.*)?'
  }
  let out = ''
  let i = 0
  while (pattern.startsWith('**/', i)) {
    out += '(?:.*/)?'
    i += 3
  }
  for (; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++ }
      else out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}${suffix}$`)
}

function matchesGlob(regex, relPath) {
  const segments = normalizeRelPath(relPath).split('/')
  const candidates = new Set([segments.join('/'), `${segments.join('/')}/`])
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('/')
    candidates.add(prefix)
    candidates.add(`${prefix}/`)
  }
  for (const candidate of candidates) {
    if (regex.test(candidate)) return true
  }
  return false
}

/**
 * Decide whether a project-relative path is copied into a run copy.
 * `node_modules` is handled separately (linked or skipped) by the copy code.
 */
export function isCopyExcluded(relPath, options = {}) {
  const segments = normalizeRelPath(relPath).split('/')
  if (segments.some((segment) => DEFAULT_SKIP_SEGMENTS.has(segment))) return true
  for (const rule of options.exclude ?? []) {
    if (matchesGlob(globToRegExp(rule), segments.join('/'))) return true
  }
  return false
}

/** Breadth-first safety limit for copies; mirrored by config caps. */
export const COPY_LIMITS = {
  maxFiles: 20000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
}
