/**
 * Line diffing for review UI and for apply-time reporting.
 *
 * No external dependencies: a Myers edit-distance walk over lines, grouped into
 * unified-diff hunks with context. Text is treated as UTF-8; a NUL byte in the
 * first 8k characters marks a file as binary and no line diff is attempted.
 */

const BINARY_PROBE = 8192
const MAX_EDIT_DISTANCE = 4000

/** Split text into lines, keeping line content without the trailing "\n". */
export function splitLines(text) {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function looksBinary(text) {
  const probe = text.slice(0, BINARY_PROBE)
  return probe.includes('\u0000')
}

/**
 * Myers diff. Returns operations [{ type: 'eq' | 'del' | 'ins', text }].
 * Falls back to "replace the differing middle" when the edit distance explodes,
 * which keeps memory bounded on pathological inputs.
 */
export function diffLines(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((text) => ({ type: 'ins', text, aIndex: -1, bIndex: 0 }))
  if (m === 0) return a.map((text) => ({ type: 'del', text, aIndex: 0, bIndex: -1 }))

  let prefix = 0
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++

  const head = a.slice(0, prefix).map((text) => ({ type: 'eq', text }))
  const tail = a.slice(n - suffix).map((text) => ({ type: 'eq', text }))
  const midA = a.slice(prefix, n - suffix)
  const midB = b.slice(prefix, m - suffix)

  const middle = midA.length === 0
    ? midB.map((text) => ({ type: 'ins', text }))
    : midB.length === 0
      ? midA.map((text) => ({ type: 'del', text }))
      : myers(midA, midB)

  return [...head, ...middle, ...tail]
}

function myers(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  const limit = Math.min(max, MAX_EDIT_DISTANCE)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace = []

  let found = -1
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
    if (found >= 0) break
  }

  if (found < 0) {
    // Too many edits: replace the differing middle wholesale.
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'ins', text })),
    ]
  }

  // Walk the trace backwards, emitting operations.
  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d] // snapshot of v *before* step d, i.e. distances for d-1
    const k = x - y
    const prevK = (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--; y--
      ops.push({ type: 'eq', text: a[x] })
    }
    if (x === prevX) {
      y--
      ops.push({ type: 'ins', text: b[y] })
    } else {
      x--
      ops.push({ type: 'del', text: a[x] })
    }
  }
  while (x > 0 && y > 0) {
    x--; y--
    ops.push({ type: 'eq', text: a[x] })
  }
  while (x > 0) { x--; ops.push({ type: 'del', text: a[x] }) }
  while (y > 0) { y--; ops.push({ type: 'ins', text: b[y] }) }
  return ops.reverse()
}

/**
 * Build unified hunks from the operation list.
 * Each hunk: { oldStart, oldCount, newStart, newCount, header, lines: [{ type, text }] }
 * type is ' ', '-' or '+'.
 */
export function toHunks(ops, context = 3) {
  const rows = []
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    if (op.type === 'eq') {
      rows.push({ type: ' ', text: op.text, oldNo, newNo })
      oldNo++; newNo++
    } else if (op.type === 'del') {
      rows.push({ type: '-', text: op.text, oldNo, newNo: -1 })
      oldNo++
    } else {
      rows.push({ type: '+', text: op.text, oldNo: -1, newNo })
      newNo++
    }
  }

  const changed = rows.map((row, index) => (row.type === ' ' ? -1 : index)).filter((index) => index >= 0)
  if (changed.length === 0) return []

  const ranges = []
  let start = Math.max(0, changed[0] - context)
  let end = Math.min(rows.length - 1, changed[0] + context)
  for (let i = 1; i < changed.length; i++) {
    const next = changed[i]
    if (next - context <= end + 1) {
      end = Math.min(rows.length - 1, next + context)
    } else {
      ranges.push([start, end])
      start = Math.max(0, next - context)
      end = Math.min(rows.length - 1, next + context)
    }
  }
  ranges.push([start, end])

  return ranges.map(([from, to]) => {
    const slice = rows.slice(from, to + 1)
    const oldStart = slice.find((row) => row.type !== '+')?.oldNo ?? (slice[0].oldNo > 0 ? slice[0].oldNo : 1)
    const newStart = slice.find((row) => row.type !== '-')?.newNo ?? (slice[0].newNo > 0 ? slice[0].newNo : 1)
    const oldCount = slice.filter((row) => row.type !== '+').length
    const newCount = slice.filter((row) => row.type !== '-').length
    return {
      oldStart,
      oldCount,
      newStart,
      newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: slice.map(({ type, text }) => ({ type, text })),
    }
  })
}

/**
 * Full file diff descriptor for the review UI.
 * status: added | deleted | modified | binary
 */
export function diffFile({ path, before, after, context = 3 }) {
  const existedBefore = before !== null && before !== undefined
  const existsAfter = after !== null && after !== undefined
  if (existedBefore && existsAfter && before === after) {
    return { path, status: 'unchanged', added: 0, removed: 0, hunks: [] }
  }

  const sample = existsAfter ? after : before
  if (looksBinary(sample)) {
    return {
      path,
      status: existedBefore ? (existsAfter ? 'binary' : 'deleted') : 'added',
      added: 0,
      removed: 0,
      binary: true,
      hunks: [],
    }
  }

  const operations = diffLines(splitLines(existedBefore ? before : ''), splitLines(existsAfter ? after : ''))
  const hunks = toHunks(operations, context)
  const added = operations.filter((op) => op.type === 'ins').length
  const removed = operations.filter((op) => op.type === 'del').length
  const status = !existedBefore ? 'added' : !existsAfter ? 'deleted' : 'modified'
  return { path, status, added, removed, hunks, binary: false }
}

/** Render hunks as a unified patch body ("--- a/x\n+++ b/x\n@@ ..."). */
export function toUnifiedPatch(path, hunks) {
  const head = [`--- a/${path}`, `+++ b/${path}`]
  const body = hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => line.type + line.text)])
  return [...head, ...body].join('\n') + '\n'
}
