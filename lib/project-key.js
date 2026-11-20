/**
 * One folder, one key.
 *
 * The same project reaches the plugin under many spellings: `D:\app`,
 * `d:/app/`, a directory symlink, or a path whose case the Host normalised.
 * The project-chat list groups runs by this key, so two chats of one project
 * have to agree on it even when their run records do not.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Canonical comparison key for a project directory.
 *
 * `realpath` collapses aliases and symlinks; when the directory is gone (a run
 * whose copy folder was deleted) the resolved path is the best answer left, so
 * the call never fails. Windows paths compare case-insensitively, so the key is
 * lowercased there — POSIX paths keep their case.
 * @param {string} projectPath - project directory, absolute or relative.
 * @returns {Promise<string>} canonical comparison key.
 */
export async function projectKeyOf(projectPath) {
  const resolved = path.resolve(projectPath)
  let canonical = resolved
  try {
    canonical = await fs.promises.realpath(resolved)
  } catch {
    // Deleted or not-yet-created directory: the resolved path still groups runs.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}
