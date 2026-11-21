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
pnpm version minor          # patch / minor / major, then commit the bump
pnpm pack --pack-destination dist
```

That produces `dist/<name>-<version>.tgz` containing:

```text
package.json  cordis.patch.yml  icon.svg  LICENSE  README.md
lib/index.js  lib/client.js  lib/diff.js  lib/paths.js  lib/ownership.js
lib/copy.js   lib/prompts.js  lib/run-store.js  lib/engine.js  lib/host-driver.js  lib/routes.js
lib/models.js  lib/conductor.js  lib/fusion.js  lib/install.js
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

If the CLI has no TTY (agent shells, CI-less sessions), the same publish goes through
`.tmp/publish-webauth.cjs`: it publishes the packed tarball with `libnpmpublish`, answers npm's
web-OTP challenge by opening the `authUrl` in the browser, polls `doneUrl` for the token and retries.
It reads the account token from `.tmp/npmrc` (`//registry.npmjs.org/:_authToken=…`), so run
`npm login --auth-type=web --userconfig .tmp/npmrc` once before it.

Then tag the release and attach the same `.tgz` to the GitHub release **twice**: as
`dsh-artel-<version>.tgz` (pinned, for anyone who wants an exact version) and as a version-free
`dsh-artel.tgz`. The alias keeps `releases/latest/download/dsh-artel.tgz` working across releases —
a pinned-version asset under `latest/download/` 404s the moment the next release ships, and the
catalog entry uses that stable URL. dsh-market can install from either an npm version or a pinned
release asset, and an archive install is only ever updated through its own source.

## Get listed in dsh-market

dsh-market is the market app, not the catalog. Its plugin list is fetched live from the curated
registry **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**, and
installs are restricted to sources listed there.

Artel is listed: its entry is `data/plugins/ksolodev__dsh-artel.yml` (category `dev`), and the
storefront reads the plugin's own `screenshots.json` from this repository.

1. The list stores one YAML file per plugin — `data/plugins/<owner>__<repo>.yml`. The READMEs are
   generated from those files, so never edit them by hand: change only your own file.
2. Keep the description literally true — maintainers compare it with the code:
   `url`, `name`, `category`, a one-sentence `description.en` (+ `description.zh`, optional), and
   optionally `tarball:` (an https `.tgz` on GitHub Releases) and `icon:` (a GitHub-hosted **raster**
   image; SVG is refused).
3. Point `tarball:` at the version-free asset, so it never rots:
   `https://github.com/ksolodev/dsh-artel/releases/latest/download/dsh-artel.tgz`.
4. Open a PR that touches only that file, and state what changed in the release — a version bump, the
   new tarball and a corrected description go in the same PR.
5. Their CI refreshes `https://awesome-dsh-plugin.com/index.json` (and the npm-served
   `dsh-plugin-catalog` index), and dsh-market picks the entry up on its next open (usually within a
   day). The npm ↔ repo link is derived from the package's `repository` field — do not hand-write an
   `npm:` key.

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
- [ ] Version bumped in `package.json`, `lib/index.js` and the `CLIENT_VERSION` in `lib/client.js`;
      `CHANGELOG.md` has a dated section for the new version.
- [ ] `pnpm pack` and extract the tarball; `lib/index.js` and `lib/client.js` parse from the package
      and `import()` of `lib/index.js` exposes `apply`.
- [ ] Install that tarball into a scratch profile, restart the host, open a chat and click **Artel**
      in the composer tool row (next to **+**): the panel opens over the chat, the **Sessions** rail
      lists the previous runs and **New session** shows the new-run form.
- [ ] Solo run on a scratch project: full agent replies stream into the feed, the changes card lists
      the files, the per-file diff renders, **Apply** writes exactly those files and deletes the copy.
- [ ] Swarm run on a scratch project: the plan turn lists owners, agents that message each other show
      up in the feed as `Agent <name> sent a message:`, all agents edit their own files, and the
      combined diff applies in one go.
- [ ] Conductor run on a scratch project: the plan card proposes the shares, the conductor's decision
      hands them out (no edits before that), the workers edit in parallel, and the review ends with a
      verdict — try one rework round and then an accept; **Apply** is still the only thing that writes
      the project.
- [ ] Apply conflict check: edit a file in the project while a run waits, then Apply — Artel rejects
      the apply and reports the conflicting file, leaving your edit alone.
- [x] UI language switch (en / ru / zh) and the plugin card title/description/icon in the plugin
      manager; also switch a persisted run, a queue task and a Factory ticket between all three
      languages and check no Host prose leaks through.
- [ ] `npm publish` (or the web-OTP driver), GitHub release with both tarball assets, and the
      awesome-dsh-plugin entry updated (`tarball:` + `description`).
- [ ] `README.md` and `docs/guide*.md` describe the current behavior, including the limitations
      (Swarm messaging needs the lead session to stay live, Conductor needs the subagent stack with no
      fallback and reviews at most twice, interrupted runs after a restart, and the fallback for
      profiles without the subagent stack).
