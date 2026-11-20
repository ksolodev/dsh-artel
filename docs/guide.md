# Artel

Artel runs a development task in an isolated copy of the project that the current chat session works
in: it shows the work as it happens and moves the result into your project only when you ask.

Artel opens from the chat itself. The **Artel** icon button sits in the composer tool row, next to
"+". It lays a panel (overlay) over the current chat; the chat stays underneath and is not changed.
The panel belongs to this session, and the session's working directory is the project.

![The Artel panel: the session rail and the new-run form](artel-in-chat/screens/hero.png)

## Open Artel

1. Open a chat whose working directory contains the project.
2. Click **Artel** in the tool row under the chat composer (next to **+**). While a run in this
   session is active, the button shows a dot.
3. The panel covers the chat area. To get back to the chat, use **Chat** in the panel header or
   press Esc. Closing the panel does not stop the run: the agents keep working, and the next time
   you open the panel it returns to the last selected run.

The header holds **Chat** (a back chevron and the word), the title **Artel**, the status of the selected run, and **Refresh** (it
re-reads the run list and the open run; the feed itself updates while the panel is open).

The left side is the **Sessions** rail: every Artel run of the current session, grouped by project.
A row shows a state dot, the task and a short `Solo · 1/3 · phase` line — the mode, how many agents
have finished a turn out of the total, and the current phase (the last status or plan message). The
active run is highlighted; clicking a row opens its page. **New session** returns to the new-run
form from a run page, and the rail footer shows `{n} sessions` and `{n} files`. While there are no
runs the rail says "No sessions yet."; the create action is hidden while the form is already open.

## New task

The form takes the right side of the panel. Its heading is the short "New task"; the model and
effort pickers open a menu with provider sections, a checkmark on the current value and full
keyboard support, and the note under the card names the project the run will work in and says
that it works in an isolated copy.

1. Describe the task in "Describe the task for the agents…": what should come out and
   where it lives in the project. You do not need to prepare any files — the agents find and read
   them.
2. Pick a mode: **Solo** ("One agent, one copy"), **Swarm** ("Three agents divide the files"),
   **Conductor** ("Three agents divide the files; the conductor accepts the work") or **Fusion**
   ("Three models answer independently, a judge merges them, one model does the work").
3. Press **Go →** (or Ctrl+Enter). While the request is in flight the button reads "Starting…".

Below the form: "Artel works in an isolated copy of the project. Your files stay untouched until you
apply the changes." If a run does not start, a banner titled "Could not start Artel" with the error
text appears under the button.

## Model and reasoning effort

The new-run form also picks the route. **Model** groups every provider the profile advertises and the
models it offers; **Effort** offers the reasoning efforts that model reports, with **Auto** meaning
the adapter default. Artel starts every agent of the run on that route. Without a choice the agents
use the profile default model.

On the run page the route bar under the header lists the agents with their own **model** and
**effort** pickers, so one member can plan on a cheap model and edit with a strong one. Changing a
row reroutes that agent only, from its next step — the step already running keeps the route it
started with. The bar is read-only once the run has been applied or discarded. If the Host cannot
reach an agent, the row keeps the profile default and the feed shows a warning instead of failing
the run.

In **Fusion** the form replaces the single route chip with five slots — **Panel 1**, **Panel 2**,
**Panel 3**, **Judge** and **Implementer** — each with its own model and effort picker (the effort
picker appears when the chosen model offers efforts). The panel starts on distinct catalog rows when
the profile advertises several models; the judge and the implementer start on the profile default. The
five routes can still be changed on the run page while the run is alive, before that agent's turn.

## Starting a run

Artel then:

1. copies the project into a separate directory outside it;
2. starts one agent (Solo), three (Swarm), a conductor with its workers (Conductor) or five Fusion
   agents — three panel models, the judge and the implementer — all with the copy as their working
   directory;
3. hands them the task and a few rules: edit only the copy, never touch the real project, run the
   appropriate checks and finish by explaining what was done.

The copy is made once per run and all agents work in it. The project itself never changes.

The agents run unattended: Artel gives them the approval policy `never` and inherits the sandbox
mode of the parent chat session. Tools that are unavailable in that sandbox return a refusal to the
agent instead of leaving the run waiting for an approval.

## Solo

One agent carries the task from start to finish. Its messages, tool calls and edits appear in the
feed right away. You can write to it at any time — the message joins the conversation without
stopping the work.

## Swarm

Three agents work in the same copy and see each other's edits: each one reads the files the others
have already changed and adapts to them. They also talk to each other: the whole team lives in one
conversation tree, so `send_message({ agent: "<name>", message: "..." })` reaches a neighbour as a
real turn, and `list_agents()` lists the whole team. Their exchanges appear in the feed as separate
rows: the sender's name, an arrow and the message text.

**The first turn is planning.** The agents may not edit anything. They read the project, agree who
owns which files (if a boundary is unclear, they message the neighbour) and end the turn with a
single line:

```
OWNERSHIP: src/app/settings/**
```

Artel collects the claims, leaves a contested area to the first claimant and shows the split as a
**Plan** card in the feed. If two agents claim the same files, the feed names both and the winner.

**Then parallel work.** Artel sends each agent its area and starts them all at once. Each one reads
the files the others have already changed and adapts to them; if a change outside the area is
needed, the agent messages the owner instead of editing someone else's file and mentions it in the
final report. A message that arrives while an agent is idle wakes it for a new turn; Artel waits
briefly before declaring the run waiting so a short exchange between two agents does not look like
finished work.

While the run is active Artel watches the edits. When a second agent touches a file another agent
has already touched, an **Edit collision** row appears in the feed with both names and the path.
Ownership is declared, not enforced: the overlap is visible, the edit is not blocked.

An agent that claimed nothing receives the unclaimed files with a "nobody claimed it" note in the
plan, so it does not sit idle; if there are no unclaimed files, it becomes a reviewer of the shared
copy and says so in its report.

If nobody claims an area during the planning turn, Artel asks again. If the second attempt is empty
too, Artel splits the top level of the project between the agents so the run does not stall, and
says so in the feed.

## Conductor

A conductor leads the team and answers for the result. It is one more agent on top of the Swarm team:
one conductor plus the configured number of workers (`swarmAgentCount`, three by default), one shared
copy, one conversation tree. The run happens in five acts.

**1. The task reaches the team.** The workers and the conductor start on the copy and read the project.
The workers each propose a narrow area; the conductor ends the planning turn with its decision. Nothing
is edited in this step, and the feed shows the proposal as a **Plan** card: "Proposed shares (the
conductor decides)".

**2. The shares are handed out.** The conductor approves the layout or reassigns it — its word is
final, so a dispute over whose file it is cannot go round in circles. Artel sends each worker its area
and shows the final map in a **Plan** card: "The shares are handed out. No edits yet." This is the
*shares handed out / no edits yet* moment of the run.

**3. The files are edited in parallel.** The workers edit their own files while the conductor watches.
A worker that is stuck asks the conductor and gets an answer without waiting for you. If a worker fails
or stops, the conductor moves its share to a live worker and the feed names both — the files are edited
in parallel while *your project stays untouched*.

**4. The conductor accepts the work as a whole.** When every worker is idle, the conductor reads the
changed files, runs the project's checks and compares the copy with the task. It answers **accept** or
**rework**: a rework sends the named shares back with remarks while the others are accepted for now —
*share B is back for rework, shares A and C are accepted*. A run gets at most two rework rounds; a third
request is turned into an accept with remarks, and the run goes to you with those remarks.

**5. The decision is yours.** An accepted run ends **Waiting for you**, like the other modes. The
**Changes** card shows one combined diff of the whole copy, and the panel notes that the checks ran and
the conductor accepted the result — but nothing has entered your project yet: **Apply** is still the
button that writes it. The checks are done, the decision is yours.

Conductor needs the subagent stack in the DSH profile: without it the run is refused with "Conductor
mode needs the subagent stack in this profile." There is no fallback to independent sessions. While the
conductor is deciding the shares, reviewing the copy or handing a share over, Artel refuses messages
with "The conductor is deciding. Wait for the next stage."; from the next stage writing works again.

## Fusion

Fusion is for the question in front of the work: *which* approach to take and *how* it is better done.
Three models answer the same task independently, a judge merges the answers into one decision, and one
model implements that decision. The run happens in three acts; the first two edit nothing.

**1. Three answers, no peeking.** The task goes to three panel models at the same moment. Each answers
in its own conversation — the models cannot see each other's answers and cannot message each other —
and each is asked for a recommendation: approach, trade-offs, risks, and how to verify it. The panel
runs in the read-only sandbox, so a panel model physically cannot edit a file: this step is a
discussion about how to do the work. Nothing is edited, and your project stays untouched.

**2. The judge merges.** When all three answers are in, a separate judge model reads them and builds
one shared decision: where the answers converged, where they diverged, what only one of them noticed,
and the merged plan. Nobody wins — the strong parts of each answer are kept. The merged decision appears
in the feed as a **Plan** card, and the status line counts the disputed places the judge found. If a
panel model stopped, the judge merges the answers that are in; if the judge itself stops or answers
nothing, Artel asks it once more and then fails the run.

**3. One model implements.** The implementer receives the merged decision *as a whole* with the normal
work rules and edits the copy: it reads the project first, makes the smallest coherent change and runs
the project's checks. From here the run behaves like Solo — the implementer's replies are in the feed,
you can write to it, and when it goes idle the runs stops.

**The decision is yours.** When the implementer is idle, the run ends **Waiting for you** like the
other modes. The **Changes** card shows the diff of the copy and only your **Apply** writes it into
your project. A failed implementer leaves the run waiting with whatever was already written.

The panel and the judge accept your messages only while their stage is active; during the merge the
run stays in **Planning**, so the other modes' "wait for the next stage" rule applies. Fusion needs no
subagent stack: all five agents are ordinary sessions, and each one is a separate chat in the session
sidebar, titled `Artel · Fusion · <role> — <task>`.

## The run page

The selected run's page opens on the right: the task at the top, the mode tag (**Solo**, **Swarm**,
**Conductor** or **Fusion**), the status, a tag with the number of changed files (once there are any)
and a phase line — the same short stage description as in the rail.

Run statuses: **Preparing**, **Planning**, **Working**, **Waiting for you**, **Finished**,
**Stopped**, **Failed**, **Applied**, **Discarded**.

![The run page: agent replies and grouped tool calls](artel-in-chat/screens/run.png)

While a run is active the header has a **Stop** button. It asks for confirmation: "Stop this Artel
run?" with **Stop run** and **Keep working** (and "Stopping…" while the request is in flight). A
stopped run becomes **Stopped**; the copy and the diff stay available, and messaging the agents puts
it back to work.

### The feed

- Full agent replies: an avatar with the initial, the name, the role and the time; the text is
  rendered as markdown.
- Tool calls are grouped into compact rows: the tool name and the file path or command.
- Status rows with a timestamp and a **Plan** card with the split of work. In Conductor mode the
  **Plan** card also carries the conductor's decisions: the handed-out shares, the rework round and the
  acceptance. In Fusion mode it carries the judge's merged decision and the disputed places count.
- Your messages: a bubble labelled "You → Everyone" or "You → <agent>".
- Agents talking to each other: the sender's name, an arrow and the message text.
- **Edit collision** when two agents touched one path; **Error** when an agent's turn failed. Both
  name the path underneath when it is known.

While the feed is empty it says "The agents are getting ready — their messages will appear here.";
while it loads, "Loading the feed…".

### Messaging the agents

The field at the bottom is "Write to the agents…", with a **Send** button. The footer has **To**:
**Everyone** by default, and a specific agent can also be chosen. Next to it: "Ctrl+Enter — send".
The message appears in the feed as "You → …" and puts a waiting or stopped run back to work while the
copy is still neither applied nor discarded. In Conductor mode a message is refused while the conductor
is deciding the shares, reviewing the copy or handing a share over — the feed says "The conductor is
deciding. Wait for the next stage." — and writing works again from the next stage. In Fusion mode you
can message only the agents of the active stage: the panel while it answers, the judge while it merges,
and the implementer once the work starts.

## Changes: apply or discard

When the agents go idle, Artel stops, computes the difference against your project and moves the run
to **Waiting for you**. The **Changes** card at the bottom of the page lists the files that differ
from your project: the heading "Changes · N files" and total `+N/−M` counts. Each row has a status —
**added**, **modified**, **deleted** or **binary** — and its own `+N/−M`. Click a file to open its
diff (**Show the diff**); click again to close it (**Hide the diff**). Binary files cannot be
expanded. The card header has **Refresh changes** and a collapse toggle (**Show changes** / **Hide
changes**).

![The Changes card with a file diff open](artel-in-chat/screens/changes.png)

- **Apply** first asks for confirmation: "Apply these changes?" and "The changes will be written to
  <project>. The isolated copy will be deleted.", with **Apply** and **Cancel**. It writes every
  file in the card; there is no per-file selection.
- **Discard** asks "Discard these changes?" and "The isolated copy will be deleted; <project> will
  stay untouched.", with **Discard** and **Cancel**.

After the decision a plate replaces the buttons: **Applied** with "The changes are written to
<project>." or **Discarded** with "The copy was deleted; the project is unchanged." If some files
could not be written, the card adds "Skipped: N".

Before writing, Artel re-reads your project. For each file it checks whether the file still matches
the state it had when the run started:

- If it does, the file is applied.
- If you edited it during the run, Artel refuses: "Nothing was applied. <file>: changed in your
  project during the run" — and writes nothing, so you can decide again.
- A file that appeared in the project during the run is rejected the same way.

An apply is final: the run becomes **Applied**, its changes are in the project, and the isolated copy is
deleted right away. The diff stays in the run feed, so you can still read what changed.

## Where the data lives

- Copies: `<DSH home>/artel/<profile>/copies/<run id>` — deleted when the run is applied or discarded; a
  copy left behind by a crash is removed at the next start.
- Run index and feeds: `<DSH home>/artel/<profile>/state/runs` — a JSON index and one JSONL file per
  run, with a size limit.
- Agent conversations: ordinary DSH sessions in your session store.

Artel keeps at most `maxRunsPerSession` runs per session: the oldest finished runs (applied,
discarded, stopped, failed) are dropped from the list together with their copies. Runs still waiting
for your decision are never dropped.

## Troubleshooting

**"The Artel host half is unavailable. Check that the plugin is enabled."** — the client half loaded
but the host half does not answer: the plugin is disabled or the host half failed to load. Enable
the plugin and reload the page.

**"The Artel host is restarting — retry in a moment."** — the host is updating or restarting. Wait
and press **Retry** in the banner.

**"This chat session has no project directory yet, so there is nothing to copy"** — the session has
no working directory, so there is nothing to copy. Open a workspace or start the session in a
directory. If the project directory exists but was deleted or moved, the host answers
"The project directory does not exist".

**"Could not copy the project: project is larger than 536870912 bytes; excluded folders or a smaller
project are required"** — the project exceeds the 512 MB copy limit. Artel does not make a partial
copy: the run is refused. Exclude heavy directories with `excludeGlobs` or use a smaller project.
Files larger than 32 MB are left out of the copy.

**"Another run is already in progress in this session"** — one active run per session. Finish it or
stop it.

**No changes** — the agents may have finished without edits; the card says "No file changes in this
run.". Read the feed; if the task needs a nudge, write to the agents.

**The apply was rejected** — the card's banner lists the files that changed in the project during
the run. Discard the run, wait until the file is free and start again: applying only the remaining
files is not possible, because the card has no per-file selection.

**The run was interrupted by a restart** — if the plugin or the host restarted, active runs become
**Stopped**. The copy and the diff stay: you can apply or discard them.
