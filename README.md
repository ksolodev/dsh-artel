# dsh-artel

[![npm version](https://img.shields.io/npm/v/dsh-artel.svg)](https://www.npmjs.com/package/dsh-artel)
[![CI](https://github.com/ksolodev/dsh-artel/actions/workflows/ci.yml/badge.svg)](https://github.com/ksolodev/dsh-artel/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Artel — review the diff, apply it yourself](docs/preview.svg)

Run a development task in an isolated copy of your project, watch the work as it happens, review the
diff line by line, then apply it yourself.

Artel is a DeepSeek Harness plugin. It adds an **Artel** tab to the right sidebar of a chat session.
The chat session's working directory is the project; Artel never touches it until you press Apply.

## Install

Artel is a DSH bundle: it installs with the standard plugin CLI and needs no build step.

**From npm**

```sh
dsh plugin --profile <profile> add dsh-artel
```

**From the release tarball** — download `dsh-artel-0.1.0.tgz` from the
[v0.1.0 release](https://github.com/ksolodev/dsh-artel/releases/tag/v0.1.0), then:

```sh
dsh plugin --profile <profile> add C:/path/to/dsh-artel-0.1.0.tgz
```

**From a checkout** — point the plugin CLI at the directory:

```sh
dsh plugin --profile <profile> add C:/path/to/dsh-artel
```

A directory install is recorded as a `link:` dependency, so edits in the checkout are live after a
host reload. In the desktop app you can also use **Settings → Plugins → Install from file** and pick
the `.tgz` or the checkout folder.

After installing, restart DeepSeek Harness (or reload the page, which recomposes the client boot
graph), open a chat session that has a project directory, and click **Artel** in the session header.
The plugin's page is served over a loopback-only HTTP API, so the plugin and the host must run on the
same machine.

## How it works

1. **Copy** — Artel copies the project into a fresh directory under your DSH home. `node_modules` is
   linked, not copied, so the agents can still run the project's checks. The real project is not
   touched.
2. **Agents** — one agent works in the copy in **Solo**; three agents share one copy and one agent
   tree in **Swarm**, so they can message each other with `send_message`/`list_agents`. The first
   Swarm turn is planning only: the agents divide the files and announce who owns what.
3. **Diff** — when every agent goes idle, Artel stops the run and shows every changed file with added
   and removed line counts and a line-by-line diff.
4. **Apply** — you tick the files you want and press **Apply**. Before writing, Artel checks each file
   against the state it had when the run started; a file you edited during the run is reported and
   never overwritten. **Discard** deletes the copy and changes nothing.

## Two ways to run a task

**Solo** — one agent does the whole task in its own copy of the project. It reads the code, edits the
copy, and runs whatever checks it needs. Use it when the task is small and well understood: fix a
bug, add a screen, change some text.

Write the task the way you would write it to a colleague: what should come out, and where in the
project it lives. The agent finds and reads the files itself.

**Swarm** — three agents share one copy and one conversation tree. Their first turn is a planning
turn: they make no edits, they divide the files among themselves and say out loud who owns what, so
that nobody edits the same file. They can also message each other directly: the team has
`send_message`/`list_agents`, so a question, a heads-up or a promise to take an area reaches the
other agents as a real turn, and every such message appears in the shared feed. After the planning
turn they work in parallel, read each other's edits on disk, and Artel flags any file that two agents
touch. Checks run once, against the whole copy.

Use Swarm when the work splits into pieces that do not meet in the same files.

## Review and apply

While a run is active, the Artel tab shows the live feed of every agent. You can write to an agent at
any time without waiting for it to finish; in Swarm you can also address one agent only.

When every agent is idle, Artel stops and waits for you:

- **Changes** lists every changed file with added and removed line counts. Open a file to see the diff.
- Untick the files you do not want.
- **Apply N files** copies the selected files into your project. A file that you edited during the run
  is never overwritten: Artel reports it and leaves it alone.
- **Discard** deletes the copy. Nothing was applied.

The copy lives outside the project, under your DSH home directory, and is removed when the run is
discarded or when it gets older than `keepCopiesHours`.

## Open it

1. Open a chat session that has a project directory.
2. Click the **Artel** button in the session header, or open it from the right sidebar guide.
3. Pick Solo or Swarm, write the task, press Start.

Each agent works in the copy as its working directory. The first agent of a Swarm run is an ordinary
DSH session, so you can open its full conversation from the Agents section of the Artel tab; the other
two are that session's subagents, live in the same agent tree, and are not listed in the sidebar as
separate chats. Solo agents are ordinary sessions as well, titled `Artel · <agent> — <task>`; archive
or delete those sessions when you no longer need them.

## Upgrading from `dsh-forge`

The plugin was renamed to Artel (the npm name `dsh-forge` belongs to an unrelated placeholder package).
On its first start the Host moves the previous data root from `<DSH home>/forge/<profile>` to
`<DSH home>/artel/<profile>`, so existing run records, feeds and copies stay available. The plugin id
changed with the name, so an already open Forge tab does not restore — open the **Artel** tab once after
the restart.

## Requirements

- DSH `^0.2.2-rc.1` with a Host that provides the session controller (the desktop app or `dsh web`).
- Node `^22.19.0 || >=24` — the same runtime the Host uses.
- No Git, no extra binaries and no global install: copies, diffs and applying are done by the plugin.

## Configuration

All values are optional; set them in the bundle's plugin configuration.

| Key | Default | Meaning |
| --- | --- | --- |
| `swarmAgentCount` | `3` | Agents per Swarm run (2–8). |
| `maxRunsPerSession` | `10` | Runs kept per session. Older runs are dropped. |
| `keepCopiesHours` | `72` | Copies older than this are deleted on startup. `0` disables the sweep. |
| `diffContext` | `3` | Context lines around each diff hunk (0–12). |
| `idleGraceMs` | `1200` | How long Artel waits for a possible agent-to-agent message before it calls the run idle (0–10000). |
| `excludeGlobs` | `[]` | Extra paths never copied, diffed, or applied. |
| `copyRoot` | `<DSH home>/artel/<profile>/copies` | Where run copies are created. |
| `stateDir` | `<DSH home>/artel/<profile>/state` | Run index and feeds. |

## Limitations

- The project is copied as files, not through Git. Git metadata is not copied, and Artel does not
  require Git to be installed.
- A copy holds up to 20,000 files, 32 MB per file and 512 MB in total. Larger projects are refused
  with an error instead of a partial copy.
- `node_modules` is linked into the copy instead of copied, so agents can run project checks.
- Artel watches the copy, not your project: it cannot know about edits you make during the run until
  you apply, and then it refuses to overwrite those files.
- Only files are applied. Deleted files are deleted on Apply; renames arrive as one deletion and one
  addition.
- Swarm agents live in one agent tree: the first agent is the session at the root of that tree and the
  other two are its subagents. That is what lets them message each other, and it means the root session
  must exist for their messages to be delivered. Closing that session (or restarting the Host) ends the
  transport, exactly like the "runs stop on restart" rule below. A profile that does not provide the
  subagent stack falls back to three independent sessions: the run still works, but the agents cannot
  message each other and coordinate only through the ownership line and the files on disk.
- If no one claims a file, Artel hands the unclaimed files that sit next to claimed work to the agents
  that claimed nothing, and marks them in the plan as "nobody claimed it" — so nobody idles through a
  run. If the task is small enough for one agent, the other two end up verifying the copy and say so
  in their summaries instead of inventing work.
- Restarting the plugin or the Host interrupts active runs. Their work stays reviewable and can still
  be applied or discarded, but the agents stop and no longer accept messages.

## Data and privacy

Run records and feeds are plain JSON and JSONL files under `stateDir`. Agent conversations are
ordinary DSH sessions and stay in your session store. The plugin serves its page over a loopback-only
HTTP API; every request is checked for a local socket, a local Host header and a same-origin origin.

## Development

```sh
node --test test/*.test.js
```

No build step: the host half is plain ESM (`lib/*.js`) and the client half is hand-written
`React.createElement` (`lib/client.js`). CI runs the suite on Ubuntu and Windows with Node 22 and 24.

- [ARCHITECTURE.md](ARCHITECTURE.md) — host/client design, the run and data model, the route surface.
- [docs/publishing.md](docs/publishing.md) — how a release is packed, published and listed.
- [docs/guide.md](docs/guide.md), [docs/guide.ru.md](docs/guide.ru.md),
  [docs/guide.zh.md](docs/guide.zh.md) — the user guide (en / ru / zh).
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## License

MIT © dsh-artel contributors — see [LICENSE](LICENSE).
