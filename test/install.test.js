import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  INSTALL_MANIFEST,
  MAX_INSTALL_STEPS,
  bundleResultLine,
  detectInstallNeeds,
  installFeedLine,
  mergeInstallRecord,
  normalizeBundleResult,
  runInstallCommand,
} from '../lib/install.js'

/** A throwaway project with the given files, under the suite's scratch folder. */
async function project(name, files = {}) {
  const root = path.join(process.cwd(), 'test', '.tmp', `install-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  await fs.mkdir(root, { recursive: true })
  for (const [relPath, content] of Object.entries(files)) {
    const file = path.join(root, relPath)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

const BUNDLE_PACKAGE = JSON.stringify({
  name: '@local/browser-tools',
  version: '1.2.3',
  private: true,
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)

const PATCH = '- insert:\n    - id: browser-tools\n      name: @local/browser-tools\n'

test('detectInstallNeeds finds nothing in a plain project', async () => {
  const p = await project('plain', { 'README.md': '# Demo\n', 'src/app.js': 'export const answer = 1\n' })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.bundle, null)
    assert.deepEqual(install.steps, [])
    assert.deepEqual(install.warnings, [])
    assert.equal(typeof install.detectedAt, 'number')
    assert.equal(installFeedLine(install), null)
  } finally {
    await p.cleanup()
  }
})

test('a DSH bundle is read from package.json and its patch file', async () => {
  const p = await project('bundle', { 'package.json': BUNDLE_PACKAGE, 'cordis.patch.yml': PATCH })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.deepEqual(install.warnings, [])
    assert.deepEqual(install.bundle, {
      name: '@local/browser-tools',
      version: '1.2.3',
      patch: './cordis.patch.yml',
      installable: true,
      status: null,
      result: null,
    })
    assert.deepEqual(install.steps, [])
    assert.match(installFeedLine(install), /DSH bundle/)
  } finally {
    await p.cleanup()
  }
})

test('a declared bundle patch that is missing is not installable', async () => {
  const p = await project('missing-patch', {
    'package.json': JSON.stringify({ name: '@local/nowhere', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.bundle.installable, false)
    assert.equal(install.bundle.patch, 'cordis.patch.yml')
    assert.equal(install.warnings.length, 1)
    assert.match(install.warnings[0], /cordis\.patch\.yml/)
  } finally {
    await p.cleanup()
  }
})

test('a root cordis.patch.yml alone still names the bundle after the folder', async () => {
  const p = await project('root-patch', { 'cordis.patch.yml': PATCH })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.bundle.patch, 'cordis.patch.yml')
    assert.equal(install.bundle.name, path.basename(p.root))
    assert.equal(install.bundle.version, null)
    assert.equal(install.bundle.installable, false, 'without a package name the plugin manager cannot install it')
    assert.ok(install.warnings.some((warning) => /package\.json has no name/.test(warning)))
  } finally {
    await p.cleanup()
  }
})

test('manifest steps are offered in order, with the command as the fallback title', async () => {
  const p = await project('manifest', {
    [INSTALL_MANIFEST]: JSON.stringify({
      steps: [
        { title: 'Install the runtime', command: 'node install/runtime.mjs' },
        { command: 'node install/post.mjs' },
      ],
    }),
    'install/install.py': 'print("never runs here")\n',
  })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.bundle, null)
    assert.equal(install.steps.length, 2)
    assert.equal(install.steps[0].id, 'step-1')
    assert.equal(install.steps[0].index, 0)
    assert.equal(install.steps[0].title, 'Install the runtime')
    assert.equal(install.steps[0].command, 'node install/runtime.mjs')
    assert.equal(install.steps[0].origin, 'manifest')
    assert.equal(install.steps[0].status, 'idle')
    assert.equal(install.steps[1].title, 'node install/post.mjs')
    assert.match(installFeedLine(install), /2 install steps/)
  } finally {
    await p.cleanup()
  }
})

test('the manifest wins over a conventional installer script', async () => {
  const p = await project('manifest-wins', {
    [INSTALL_MANIFEST]: JSON.stringify({ steps: [{ title: 'Custom', command: 'node custom.mjs' }] }),
    'install/install.py': 'print(1)\n',
  })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.steps.length, 1)
    assert.equal(install.steps[0].command, 'node custom.mjs')
  } finally {
    await p.cleanup()
  }
})

test('unusable manifest entries are skipped with a warning', async () => {
  const p = await project('bad-steps', {
    [INSTALL_MANIFEST]: JSON.stringify({
      steps: [
        { command: '' },
        { command: 'one\ntwo' },
        { title: 'Fine', command: 'npm ci' },
        { command: 42 },
      ],
    }),
  })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.steps.length, 1)
    assert.equal(install.steps[0].command, 'npm ci')
    assert.equal(install.warnings.filter((warning) => /runnable "command"/.test(warning)).length, 3)
  } finally {
    await p.cleanup()
  }
})

test('an explicit manifest caps the offered steps', async () => {
  const steps = Array.from({ length: MAX_INSTALL_STEPS + 3 }, (unused, index) => ({ title: `Step ${index}`, command: `node step-${index}.mjs` }))
  const p = await project('capped', { [INSTALL_MANIFEST]: JSON.stringify({ steps }) })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.steps.length, MAX_INSTALL_STEPS)
    assert.ok(install.warnings.some((warning) => /first 8 install steps/.test(warning)))
  } finally {
    await p.cleanup()
  }
})

test('a broken manifest is a warning, not a failed detection', async () => {
  const p = await project('broken-manifest', { [INSTALL_MANIFEST]: '{ not json' })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.deepEqual(install.steps, [])
    assert.ok(install.warnings.some((warning) => /not valid JSON/.test(warning)))
  } finally {
    await p.cleanup()
  }
})

test('a conventional installer script becomes a detected step', async () => {
  const p = await project('detected', { 'install/install.py': 'print(1)\n' })
  try {
    const install = await detectInstallNeeds(p.root)
    assert.equal(install.steps.length, 1)
    assert.equal(install.steps[0].origin, 'detected')
    assert.match(install.steps[0].command, /^python(3)? install\/install\.py$/)
  } finally {
    await p.cleanup()
  }
})

test('mergeInstallRecord keeps done steps and resets a changed command', async () => {
  const p = await project('merge', {
    [INSTALL_MANIFEST]: JSON.stringify({ steps: [{ title: 'Install', command: 'node install.mjs' }] }),
    'package.json': JSON.stringify({ name: '@local/demo', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '- insert:\n    - id: demo\n      name: demo\n',
  })
  try {
    const fresh = await detectInstallNeeds(p.root)
    assert.equal(fresh.bundle.installable, true)
    const previous = {
      ...fresh,
      steps: [{
        ...fresh.steps[0],
        status: 'done',
        output: 'all good',
        outputTruncated: false,
        exitCode: 0,
        startedAt: 10,
        finishedAt: 20,
      }],
      bundle: { ...fresh.bundle, status: 'restart-required', result: { status: 'restart-required' } },
    }
    const same = mergeInstallRecord(previous, fresh)
    assert.equal(same.steps[0].status, 'done')
    assert.equal(same.steps[0].output, 'all good')
    assert.equal(same.steps[0].exitCode, 0)
    assert.equal(same.bundle.status, 'restart-required', 'a bundle result survives a refresh with the same patch')
    assert.equal(same.bundle.installable, true)

    const changed = mergeInstallRecord(previous, { ...fresh, steps: [{ ...fresh.steps[0], command: 'node other.mjs' }] })
    assert.equal(changed.steps[0].status, 'idle', 'a new command starts from scratch')
    assert.equal(changed.steps[0].output, null)

    const differentPatch = mergeInstallRecord(previous, { ...fresh, bundle: { ...fresh.bundle, patch: 'other.patch.yml' } })
    assert.equal(differentPatch.bundle.patch, 'other.patch.yml')
    assert.equal(differentPatch.bundle.status, null, 'a different patch starts from scratch: the old result does not carry over')
    assert.equal(differentPatch.bundle.result, null)
  } finally {
    await p.cleanup()
  }
})

test('normalizeBundleResult maps every plugin-manager outcome', () => {
  assert.equal(normalizeBundleResult({ changed: true, application: 'applied' }).status, 'installed')
  const restart = normalizeBundleResult({ changed: true, application: 'restart-required', restartReason: 'no-hmr', bundle: 'demo', version: '1.0.0' })
  assert.equal(restart.status, 'restart-required')
  assert.equal(restart.restartReason, 'no-hmr')
  assert.equal(restart.bundle, 'demo')
  assert.equal(restart.version, '1.0.0')
  assert.equal(normalizeBundleResult({ application: 'overridden' }).status, 'overridden')
  assert.equal(normalizeBundleResult({ application: 'cancelled' }).status, 'cancelled')
  assert.equal(normalizeBundleResult({ changed: false, application: 'applied' }).status, 'already-installed')
  assert.equal(normalizeBundleResult({ changed: true }).status, 'failed')
  assert.equal(normalizeBundleResult(null).status, 'failed')
  assert.match(normalizeBundleResult(null).errorMessage, /no result/)

  const benign = normalizeBundleResult(null, { code: 'already-installed', message: 'already-installed' })
  assert.equal(benign.status, 'already-installed')
  assert.equal(benign.errorMessage, null, 'an already installed bundle is not an error the user must read')

  const broken = normalizeBundleResult({ changed: true, error: { code: 'incompatible-version', diagnostic: 'dsh >= 9 is required' } })
  assert.equal(broken.status, 'failed')
  assert.equal(broken.errorCode, 'incompatible-version')
  assert.equal(broken.errorMessage, 'dsh >= 9 is required')

  assert.match(normalizeBundleResult(null, new Error('no network')).errorMessage, /no network/)
})

test('feed lines say what is left and what happened', () => {
  const bundle = { name: 'demo', version: null, patch: 'cordis.patch.yml', installable: true, status: null, result: null }
  const step = { id: 'step-1', command: 'node install.mjs' }
  assert.match(installFeedLine({ bundle, steps: [] }), /DSH bundle/)
  assert.match(installFeedLine({ bundle: null, steps: [step] }), /1 install step/)
  assert.match(installFeedLine({ bundle, steps: [step] }), /1 install step/)
  assert.match(bundleResultLine('demo', { status: 'installed' }), /active now/)
  assert.match(bundleResultLine('demo', { status: 'restart-required' }), /Restart DSH/)
  assert.match(bundleResultLine('demo', { status: 'failed', errorMessage: 'bad patch' }), /bad patch/)
  assert.match(bundleResultLine('demo', { status: 'failed' }), /Could not install demo\./)
})

test('runInstallCommand captures output and exit codes', async () => {
  const p = await project('command', { 'README.md': '# Demo\n' })
  try {
    const ok = await runInstallCommand({ command: 'node -e "process.stdout.write(\'installed\')"', cwd: p.root })
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.timedOut, false)
    assert.equal(ok.error, null)
    assert.equal(ok.output, 'installed')

    const bad = await runInstallCommand({ command: 'node -e "process.stderr.write(\'nope\');process.exit(3)"', cwd: p.root })
    assert.equal(bad.exitCode, 3)
    assert.match(bad.output, /nope/)
  } finally {
    await p.cleanup()
  }
})

test('runInstallCommand stops a step at the time limit', async () => {
  const p = await project('timeout', {})
  try {
    const outcome = await runInstallCommand({ command: 'node -e "setTimeout(() => {}, 5000)"', cwd: p.root, timeoutMs: 1000 })
    assert.equal(outcome.timedOut, true)
    assert.notEqual(outcome.exitCode, 0)
  } finally {
    await p.cleanup()
  }
})

test('runInstallCommand bounds a chatty installer', async () => {
  const p = await project('chatty', {})
  try {
    const outcome = await runInstallCommand({
      command: 'node -e "process.stdout.write(\'x\'.repeat(40000))"',
      cwd: p.root,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.outputTruncated, true)
    assert.ok(outcome.output.length < 14000, `bounded output, got ${outcome.output.length}`)
  } finally {
    await p.cleanup()
  }
})
