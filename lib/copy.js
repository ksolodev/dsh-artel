/**
 * Project copying, change computation and apply-back.
 *
 * The real project is only ever read by the run (and by review/apply). Agents
 * work in `<copyRoot>/<runId>`, which is a plain directory copy: `.git`,
 * `node_modules` and configured globs are not copied, except that a top-level
 * `node_modules` of the project is linked (junction on Windows, dir symlink
 * elsewhere) so checks can run in the copy without a reinstall.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { COPY_LIMITS, isCopyExcluded, isInside, normalizeRelPath, resolveIn } from './paths.js'
import { diffFile } from './diff.js'

export class CopyLimitError extends Error {
  constructor(message) {
    super(message)
    this.code = 'copy-limit'
  }
}

async function listTree(root, options = {}) {
  const files = []
  const dirs = []
  const skipped = []
  const queue = ['']
  while (queue.length > 0) {
    const rel = queue.shift()
    const abs = rel === '' ? root : path.join(root, rel)
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: rel || '.', reason: `unreadable: ${error.code ?? error.message}` })
      continue
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (isCopyExcluded(childRel, options)) {
        skipped.push({ path: childRel, reason: 'excluded' })
        continue
      }
      if (entry.isDirectory()) {
        dirs.push(childRel)
        queue.push(childRel)
      } else if (entry.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: 'symlink' })
      } else if (entry.isFile()) {
        files.push(childRel)
      } else {
        skipped.push({ path: childRel, reason: 'unsupported entry' })
      }
    }
  }
  return { files, dirs, skipped }
}

async function linkNodeModules(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, 'node_modules')
  try {
    const stat = await fs.stat(source)
    if (!stat.isDirectory()) return false
  } catch {
    return false
  }
  const target = path.join(targetRoot, 'node_modules')
  try {
    await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/**
 * Copy the project into `targetRoot`, returning the base hash manifest used
 * later for change detection and for the apply-time conflict check.
 */
export async function copyProjectTree(sourceRoot, targetRoot, options = {}) {
  const limits = { ...COPY_LIMITS, ...(options.limits ?? {}) }
  if (isInside(sourceRoot, targetRoot)) {
    throw new Error('copy target must live outside the project directory')
  }
  await fs.mkdir(targetRoot, { recursive: true })
  const { files, dirs, skipped } = await listTree(sourceRoot, options)
  for (const rel of dirs) await fs.mkdir(path.join(targetRoot, rel), { recursive: true })

  const base = {}
  let totalBytes = 0
  for (const rel of files) {
    const from = path.join(sourceRoot, rel)
    const to = path.join(targetRoot, rel)
    const stat = await fs.stat(from)
    if (stat.size > limits.maxFileBytes) {
      skipped.push({ path: rel, reason: `larger than ${limits.maxFileBytes} bytes` })
      continue
    }
    totalBytes += stat.size
    if (totalBytes > limits.maxTotalBytes) {
      throw new CopyLimitError(`project is larger than ${limits.maxTotalBytes} bytes; excluded folders or a smaller project are required`)
    }
    const bytes = await fs.readFile(from)
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.writeFile(to, bytes)
    base[rel] = { hash, size: stat.size }
  }

  let linkedNodeModules = false
  if (options.linkNodeModules !== false) {
    linkedNodeModules = await linkNodeModules(sourceRoot, targetRoot)
  }
  return { base, files: Object.keys(base).length, bytes: totalBytes, skipped, linkedNodeModules }
}

/** Read and hash one file; returns null when the file does not exist. */
export async function hashFile(absPath) {
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) return null
    const bytes = await fs.readFile(absPath)
    return { hash: crypto.createHash('sha256').update(bytes).digest('hex'), size: stat.size, bytes }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Hash a whole tree with the same exclusions used by the copy step. */
export async function hashTree(root, options = {}) {
  const { files, skipped } = await listTree(root, options)
  const result = { files: {}, skipped }
  for (const rel of files) {
    const entry = await hashFile(path.join(root, rel))
    if (entry) result.files[rel] = { hash: entry.hash, size: entry.size }
  }
  return result
}

/**
 * Compare the copy against the base manifest.
 * Returns per-file descriptors { path, status, added, removed, hunks } ordered
 * by path; `before` text is taken from `beforeRoot` (the project) because a run
 * must not modify the project.
 */
export async function collectChanges({ copyRoot, beforeRoot, base, options = {} }) {
  const current = await hashTree(copyRoot, options)
  const changes = []
  const paths = new Set([...Object.keys(base ?? {}), ...Object.keys(current.files)])
  for (const rel of [...paths].sort()) {
    const beforeEntry = base?.[rel]
    const afterEntry = current.files[rel]
    const beforeHash = beforeEntry?.hash
    const afterHash = afterEntry?.hash
    if (beforeHash === afterHash) continue

    const isText = await isProbablyText(rel)
    if (!isText) {
      changes.push({
        path: rel,
        status: !beforeEntry ? 'added' : !afterEntry ? 'deleted' : 'binary',
        added: 0,
        removed: 0,
        binary: true,
        hunks: [],
      })
      continue
    }

    const before = beforeEntry ? await readText(path.join(beforeRoot, rel)) : null
    const after = afterEntry ? await readText(path.join(copyRoot, rel)) : null
    changes.push(diffFile({ path: rel, before, after, context: options.context }))
  }
  return changes
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'wasm', 'node', 'exe', 'dll',
  'so', 'dylib', 'class', 'jar', 'sqlite', 'db',
])

function extensionOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

async function isProbablyText(relPath) {
  return !BINARY_EXTENSIONS.has(extensionOf(relPath))
}

async function readText(absPath) {
  const entry = await hashFile(absPath)
  if (!entry) return null
  return entry.bytes.toString('utf8')
}

/**
 * Apply selected changed files to the project.
 * Every file is checked against the base hash first: if the user changed it
 * during the run, that file is skipped instead of being overwritten.
 */
export async function applyChanges({ projectRoot, copyRoot, base, changes, paths }) {
  const applied = []
  const skipped = []
  let wanted = null
  if (paths && paths.length > 0) {
    wanted = new Set()
    for (const requested of paths) {
      try {
        wanted.add(normalizeRelPath(requested))
      } catch (error) {
        skipped.push({ path: String(requested), reason: error.message })
      }
    }
  }
  for (const change of changes) {
    if (wanted && !wanted.has(change.path)) continue
    let rel
    try {
      rel = normalizeRelPath(change.path)
    } catch (error) {
      skipped.push({ path: change.path, reason: error.message })
      continue
    }
    if (isCopyExcluded(rel)) {
      skipped.push({ path: rel, reason: 'path is excluded from runs' })
      continue
    }
    const target = resolveIn(projectRoot, rel)
    const source = resolveIn(copyRoot, rel)
    const current = await hashFile(target)
    const baseEntry = base?.[rel]
    if (baseEntry && current && current.hash !== baseEntry.hash) {
      skipped.push({ path: rel, reason: 'changed in your project during the run' })
      continue
    }
    if (!baseEntry && current) {
      skipped.push({ path: rel, reason: 'file appeared in your project during the run' })
      continue
    }
    try {
      if (change.status === 'deleted') {
        await fs.rm(target, { force: true })
        applied.push(rel)
        continue
      }
      const data = await hashFile(source)
      if (!data) {
        skipped.push({ path: rel, reason: 'copy file is missing' })
        continue
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, data.bytes)
      applied.push(rel)
    } catch (error) {
      skipped.push({ path: rel, reason: error.message })
    }
  }
  return { applied, skipped }
}

/**
 * Check a set of changes before writing anything: every selected file is
 * inspected against the base hashes, so an apply either goes through fully or
 * writes nothing at all.
 */
export async function preflightApply({ projectRoot, copyRoot, base, changes, paths }) {
  const ready = []
  const blocked = []
  let wanted = null
  if (paths && paths.length > 0) {
    wanted = new Set()
    for (const requested of paths) {
      try {
        wanted.add(normalizeRelPath(requested))
      } catch (error) {
        blocked.push({ path: String(requested), reason: error.message })
      }
    }
  }
  for (const change of changes) {
    if (wanted && !wanted.has(change.path)) continue
    let rel
    try {
      rel = normalizeRelPath(change.path)
    } catch (error) {
      blocked.push({ path: change.path, reason: error.message })
      continue
    }
    if (isCopyExcluded(rel)) {
      blocked.push({ path: rel, reason: 'path is excluded from runs' })
      continue
    }
    const target = resolveIn(projectRoot, rel)
    const source = resolveIn(copyRoot, rel)
    const current = await hashFile(target)
    const baseEntry = base?.[rel]
    if (baseEntry && current && current.hash !== baseEntry.hash) {
      blocked.push({ path: rel, reason: 'changed in your project during the run' })
      continue
    }
    if (!baseEntry && current) {
      blocked.push({ path: rel, reason: 'file appeared in your project during the run' })
      continue
    }
    if (change.status !== 'deleted' && !(await hashFile(source))) {
      blocked.push({ path: rel, reason: 'copy file is missing' })
      continue
    }
    ready.push(rel)
  }
  return { ready, blocked }
}

/** Remove a run copy, refusing anything that is not an existing directory under copyRoot. */
export async function removeCopy(copyRoot, copyPath) {
  if (!isInside(copyRoot, copyPath) || path.resolve(copyPath) === path.resolve(copyRoot)) {
    throw new Error(`refusing to remove copy outside ${copyRoot}`)
  }
  await fs.rm(copyPath, { recursive: true, force: true, maxRetries: 3 })
  try {
    const remaining = await fs.readdir(copyRoot)
    if (remaining.length === 0) await fs.rmdir(copyRoot)
  } catch {
    /* copyRoot may not exist */
  }
}

/** Remove stale copies left behind by runs that are no longer active. */
export async function sweepCopies(copyRoot, keepNames) {
  let entries = []
  try {
    entries = await fs.readdir(copyRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const removed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (keepNames.has(entry.name)) continue
    await removeCopy(copyRoot, path.join(copyRoot, entry.name))
    removed.push(entry.name)
  }
  return removed
}
