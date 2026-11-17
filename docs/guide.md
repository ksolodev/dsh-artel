# Artel

Artel runs a development task in an isolated copy of the project open in your chat session, shows the
work while it happens, and applies the result to your project only when you say so.

Open the **Artel** tab from the session header (**Artel** button) or from the right sidebar guide. The
tab belongs to the current chat session, and that session's working directory is the project.

## Start a run

1. Choose a mode: **Solo** or **Swarm**.
2. Describe the task in your own words: what should come out, and where in the project it lives. You do
   not have to prepare files — the agents find and read them.
3. Press **Start** (or Ctrl+Enter).

Artel then:

1. copies the project into a fresh directory outside it;
2. starts one agent (Solo) or three agents (Swarm) whose working directory is the copy;
3. sends them the task and a short set of rules: own the copy, never touch the real project, run the
   checks that fit the change, and explain what they did at the end.

The copy is created once per run and shared by every agent in it. The project itself is not modified.

## Solo

One agent carries the task from start to finish. Its messages, tool calls and file edits appear in the
feed as they happen. Write to it at any time; the message joins the conversation without stopping it.

## Swarm

Three agents work in one copy and read each other's edits on disk as they appear. They also talk to
each other: the team shares one conversation tree, so `send_message({ agent: "<name>", message: "..." })`
reaches a teammate as a real turn, and `list_agents()` shows the whole team. Messages the agents send
each other appear in the feed with both names (`Orion → Vega`), so you can follow the negotiation
without opening their conversations.

**First turn — planning.** The agents are told not to edit anything. They read the project, decide who
takes which files, talk it over when a boundary is unclear, and end their turn with one line:

```
OWNERSHIP: src/app/settings/**
```

Artel collects those claims, keeps the first claim on a contested path, and shows the divided map in
the feed. If two agents claim the same files, the feed names both agents and the winner.

**Then — parallel work.** Artel sends each agent its final area and starts them together. Each agent
reads the files the others already changed on disk and adapts to them; an agent that needs something
outside its area messages the owner instead of editing the owner's files, and says so in its final
summary. A message that arrives while an agent is idle wakes it for another turn; Artel waits a moment
before calling the run waiting, so a short exchange between two agents does not look like a finished run.

While the run is active, Artel watches every edit tool call. When a second agent touches a path that
another agent already touched, the feed shows a collision line with both names. Ownership is
announced, not enforced: the collision is visible, but the edit is not blocked.

An agent that ends up with no claimed files is handed unclaimed files that sit next to the claimed work,
marked "nobody claimed it" in the plan. If the task is small enough for one agent, the other two simply
change nothing, verify the copy and say so in their summaries.

If no agent announces ownership in the planning turn, Artel asks once more. If the second attempt also
comes back empty, Artel splits the top level of the project between the agents so the run can still
proceed, and says so in the feed.

## While the run is active

The header shows the run status: preparing, dividing work, working, waiting for you, applied,
discarded, failed, interrupted.

- **Feed** — every message, tool call, status change, plan and collision, in order.
- **Agents** — one row per agent with its state and claimed files. **Open conversation** opens the
  agent's full DSH conversation in a new chat; those chats also appear in the sidebar titled
  `Artel · <agent> — <task>` and can be archived like any other chat. In Swarm only the lead agent has
  its own chat: the other two are its subagents and live inside that conversation tree, which is exactly
  what lets all three message each other. Their traffic is in the feed instead.
- **Write to the agents** — the composer at the bottom of the run. In Solo it goes to the agent; in
  Swarm you choose one agent or **All agents** (broadcast). A message turns a waiting run back into a
  working run.
- **Stop** interrupts every agent. The work already done in the copy stays available for review.

When every agent goes idle, Artel stops the run, computes the diff against the copy and marks the run
as **Waiting for you**.

## Review, apply, discard

The **Changes** list shows every file that differs from your project: `A` added, `M` modified,
`D` deleted, `B` binary (binary files can be applied but not previewed as text). Added and removed line
counts are shown per file; open a file to read its hunks.

- Untick files you do not want to apply. **Select all** and **Select none** are shortcuts.
- **Apply N files** copies the selected files into your project.
- **Discard** throws the copy away. Nothing reaches your project.
- **New task** starts a fresh run; the previous run stays in the list.

Before writing anything, Artel re-reads your project. For every selected file it checks whether the
file still matches the state it had when the run started:

- If it does, the file is applied.
- If you changed it during the run, Artel refuses that file and says `changed in your project during
  the run`; the rest of the selection is not applied either — the whole Apply is rejected so that you
  can decide again.
- A file that appeared in your project during the run is refused the same way.

Applying a run is final: the run becomes **Applied** and its copy stays on disk for later inspection
until the sweep removes it.

## Where the data lives

- Copies: `<DSH home>/artel/<profile>/copies/<run id>` — deleted on Discard, and on startup when older
  than `keepCopiesHours`.
- Run index and feeds: `<DSH home>/artel/<profile>/state/runs` — JSON index plus one JSONL feed per
  run, capped per run.
- Agent conversations: ordinary DSH sessions in your session store.

Artel keeps at most `maxRunsPerSession` runs per session; the oldest are dropped from the list.

## Troubleshooting

**"Artel cannot see the web server"** — the profile does not expose a Host web server, so the page
cannot be served. This plugin needs the desktop/web profile.

**"This chat session has no project directory yet"** — the session has no working directory. Open a
workspace or start the session in a directory first.

**"The project is too large to copy"** — the copy limits are 20,000 files, 32 MB per file, 512 MB in
total. Exclude heavy directories with `excludeGlobs`.

**"Another run is already in progress in this session"** — one active run per session. Stop or finish
it before starting another.

**No changes are shown** — the agents may have finished without editing files. Read the feed; if the
task needs a nudge, write to the agents.

**Apply is refused** — the message names the files that changed in your project during the run.
Discard the run, or re-run after the file is quiet, or apply the remaining files by starting a new run.
