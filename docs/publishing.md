# Publishing Artel

Artel is a DSH bundle: `package.json` carries `dsh.bundle.patch` → `cordis.patch.yml`, and the
client half is declared under `dsh.client` with an `exports["./client"]` target. That is all a DSH
host needs to install it; dsh-market only adds discovery on top.

## Package name

The npm name **`dsh-artel`** is free as of 2026-11-16 and is the name this package publishes under.
The client module loader keys its boot graph by **package name**, so three places must agree:

1. `name` in `package.json`
2. `PACKAGE_ID` at the top of `lib/client.js` (the `id` passed to `window.__ModuleLoader__.load`)
3. the package name in the `cordis.patch.yml` row

Change them together, then rebuild the tarball. The tab type id (`TAB_ID = 'dsh-artel'`) and the
`/api/dsh-artel` route prefix are independent of the package name and can stay as they are.

A scoped publish (for example `@your-name/dsh-artel`) works too, but then `PACKAGE_ID` and the two ids
must be changed to match, the profile's install source has to be re-pointed, and the host restarted.

**Why not `dsh-forge`?** That was the project's first working name, but it is now reserved on npm by
an unrelated placeholder (`v0.0.1`, "Scaffold new dsh plugins from templates"), and "forge" is already
crowded in DSH — including the official `@deepseek-ai/dsh-experimental-forge*` family, which is a
different product (GitHub commits, compare, pull requests, reviews). Artel (артель) is a team of
craftsmen sharing one job, which is exactly the Swarm model.

## Upgrading a profile from the old name

The plugin's data root moved from `<DSH_HOME>/forge/<profile>` to `<DSH_HOME>/artel/<profile>`.
`migrateDataRoot()` in `lib/index.js` renames it on the first start of the new build (and falls back to
copying when the old directory is still held open), so runs, copies and feeds survive the rename. A
profile that still depends on `dsh-forge` must be re-pointed to `dsh-artel` before the restart; the tab
id changed too, so an already open Forge tab will not restore.

## Build a release tarball

```sh
pnpm version patch          # or minor / major
pnpm pack --pack-destination dist
```

That produces `dist/<name>-<version>.tgz` (~63 KB) containing:

```text
package.json  cordis.patch.yml  icon.svg  LICENSE  README.md
lib/index.js  lib/client.js  lib/diff.js  lib/paths.js  lib/ownership.js
lib/copy.js   lib/prompts.js  lib/run-store.js  lib/engine.js  lib/host-driver.js  lib/routes.js
locale/en.json  locale/ru.json  locale/zh.json
docs/guide.md  docs/guide.ru.md  docs/guide.zh.md  docs/publishing.md
```

`files` in `package.json` is explicit: anything new that the host reads at runtime must be listed
there, or it will be missing from the tarball while the workspace copy keeps working.

Smoke-test the tarball before publishing:

```sh
mkdir /tmp/artel-check && tar -xzf dist/dsh-artel-*.tgz -C /tmp/artel-check
node --check /tmp/artel-check/package/lib/index.js
node -e "import('/tmp/artel-check/package/lib/index.js').then(m => console.log(Object.keys(m)))"
node -e "const s = require('fs').readFileSync('/tmp/artel-check/package/lib/client.js','utf8'); new Function('window','document','fetch','setTimeout','setInterval','clearTimeout','clearInterval', s); console.log('client parses')"
```

## Publish

```sh
pnpm publish --access public
```

Then tag the release and attach the same `.tgz` to the GitHub release — dsh-market can install from
either an npm version or a pinned release asset, and an archive install is only ever updated through
its own source.

## Get listed in dsh-market

dsh-market is the market app, not the catalog. Its plugin list is fetched live from the curated
registry **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**, and
installs are restricted to sources listed there.

1. Make the repository public, with the tarball (or npm package) installable as it stands.
2. Open a PR against `awesome-dsh-plugin/awesome-dsh-plugin` that adds **one bullet** to the
   category that fits — `Development & Runtime` or `Workflow & Automation` fits Artel:

   ```markdown
   - [your-name/dsh-artel](https://github.com/your-name/dsh-artel) - Runs a development task in an
     isolated copy of the project — one agent in Solo, three sharing one copy in Swarm — shows the
     diff line by line and applies only the files you approve.
   ```

   Keep it to one sentence that is literally true of the plugin: submissions are checked against the
   source, and the description is compared with what the code does.
3. Their CI refreshes `https://awesome-dsh-plugin.com/plugins.json` and the npm-served
   `dsh-plugin-catalog` index; dsh-market picks the entry up on its next open (usually within a day).

Listing criteria the plugin already meets: it installs with `dsh plugin add`, it declares a
`dsh.bundle` manifest, and it works without side channels (the Host API is loopback-only and every
request is fenced).

## Install a build by hand

From a checkout, or from a packed tarball, in the desktop app use **Settings → Plugins → Install
from file**, or from a shell:

```sh
dsh plugin --profile <profile> add C:/path/to/dsh-artel-<version>.tgz
```

The same thing through the running host's agent tools is `plugin_manager install_bundle` with an
absolute path to the directory or the `.tgz`. A directory install is recorded as a `link:` dependency,
so later edits in the checkout are live after a host reload (or an app restart, which also recomposes
the client boot graph).

## Release checklist

- [ ] `node --test test/*.test.js` — all tests green.
- [ ] `pnpm pack` and extract the tarball; `lib/index.js` and `lib/client.js` parse from the package.
- [ ] Install that tarball into a scratch profile, restart the host, open a chat, click **Artel** in
      the session header: the page renders, the **Начало/Start** guide lists an Artel tile.
- [ ] Solo run on a scratch project: feed streams, diff renders, Apply writes exactly the reviewed
      files, Discard deletes the copy.
- [ ] Swarm run on a scratch project: the plan turn lists owners, agents that message each other show
      up in the feed as `Agent <name> sent a message:`, all agents edit their own files, and the
      combined diff applies in one go.
- [ ] Apply conflict check: edit a file in the project while a run waits, then Apply — Artel reports
      that file as skipped and leaves your edit alone.
- [ ] UI language switch (en / ru) and the plugin card title/description/icon in the plugin manager.
- [ ] `README.md` and `docs/guide*.md` describe the current behavior, including the limitations
      (Swarm messaging needs the lead session to stay live, interrupted runs after a restart, and the
      fallback for profiles without the subagent stack).
