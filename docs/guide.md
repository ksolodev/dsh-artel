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
   **Conductor** ("Three agents divide the files; the conductor accepts the work"), **Fusion**
   ("Three models answer independently, a judge merges them, one model does the work") or
   **Orchestrator** ("A planner splits a big goal into parts, each part gets its own copy and a
   reviewer").
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

1. copies the project into a separate directory outside it (in Orchestrator mode the copies are made
   later, one per part, after the planner has split the goal);
2. starts one agent (Solo), three (Swarm), a conductor with its workers (Conductor), five Fusion
   agents — three panel models, the judge and the implementer — or, in Orchestrator, the planner first
   and then a part agent and a reviewer per part, all with their copy as their working directory;
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

## Orchestrator

Orchestrator is for a goal too big for one agent: a direction, not a ten-minute task. A planner splits
it into independent parts, each part is worked in its own copy of the project and checked by a reviewer
against the plan's conditions, and only the accepted parts are assembled into one copy for you to
apply. The split is visible before any work starts.

**1. The planner splits the goal.** The run starts with one agent, the planner, reading the real
project in read-only mode. It answers with a short plan: a summary and `orchestratorParts` parts (three
by default, at most four), each with a title, a goal, a "done when" condition and the files it expects
to touch. The split appears in the feed as a **Plan** card, so you see the parts before anything is
edited. If the planner does not produce a readable plan, Artel asks once more and then fails the run —
nothing has been edited.

**2. One copy and two agents per part.** For each part Artel makes a separate copy of the project and
starts two agents in it: the part agent does the work, and a reviewer — read-only — reads that part's
changes and compares them with the written conditions. When the part agent finishes, the reviewer
either accepts the part or returns it for rework and lists the problems. A returned part goes back to
its agent with those problems; a part may be returned at most twice, after that it is accepted with
the reviewer's remarks on record. Part agents work in parallel, in separate copies, so they cannot
overwrite each other; the planner and the reviewers never edit anything.

**3. Assembly.** When every part is accepted, Artel writes the accepted changes into one assembled
copy. Files that only one part changed go in as they are; files that several parts changed are a
conflict and go to a merger agent, which resolves them where they belong. Artel then checks that every
conflicted file really differs from the original before the run is handed to you. A merge that cannot
be finished fails the run with the merge recorded: the assembled copy stays readable for the diff, but
**Apply** is refused until you discard the run.

**The decision is yours.** When the assembly is finished, the run ends **Waiting for you**: the
**Changes** card shows the diff of the assembled copy and only your **Apply** writes it into your
project. The **Parts** card on the run page lists the parts with their status (working, in review,
back for rework, accepted) and the plan's done conditions, so you can see what was verified and what
the reviewer asked for. Part copies are deleted as soon as the parts are assembled.

Orchestrator needs no subagent stack: every agent is an ordinary session, titled after its part —
`Artel · Orchestrator · <agent> — <task>` for the planner, `Artel · Part N — <title> · <agent> — <task>`
for a part agent, `Artel · Review · Part N — <title> · <agent> — <task>` for its reviewer and
`Artel · Merge · <agent> — <task>` for the merger. While the planner is splitting the goal the run is
in **Planning** and messages are refused; after that the normal message rules apply.

## Auto-queue

Every chat session has its own queue, and the **Waiting** column of the panel is where it lives. Write
the next task into "What to do next…" and press **Add**: the task joins the queue instead of starting a
run, and it can be given its own mode (Solo, Swarm, Conductor or Fusion) and model. The queue belongs to
the session, so another chat stacks its own tasks; a chat message sent while the queue runs does not
interrupt the agent — it becomes the first task.

Flip **Auto-queue** to run the stack unattended, one task after another. The queue only matters while the
toggle is on: with it off a task waits in the **Waiting** column and nothing starts. Before the first task
the pre-flight shows what is about to happen: the check command and the task limit, and any earlier
versions that were never saved or parked — you decide for each one whether to save it as a version or park
it. The check command is guessed from the project's manifests (**Guessed from the project**) and can be
replaced by hand or switched off with **Without a check**; with no usable command the version is saved on
the agent's word and marked as such. The limit ("No more than N tasks per run", twenty by default) caps
how many tasks one night takes.

An auto-queue task runs under the night-shift rules, which the agent receives on every turn: it is a fresh
worker per task, nobody will answer, so it makes the smallest reasonable assumption and records it instead
of asking. The first question of a task is answered for it — "decide yourself and record the assumption" —
and a second question parks the task. The agent never sends anything outward (no push, pull request,
publish, deploy, tracker comment or message outside the machine), never raises a preview and never starts a
long-running dev server, stays in its copy, runs the project's checks and ends with a short summary of what
it changed, checked and assumed.

A finished task must pass the check before it becomes a version. A failed check is sent back to the same
worker as a fix attempt, at most twice; the task then either passes and is saved as a version, or is
parked. A version is an ordinary Artel version: the next task starts from the last successful one, so the
queue builds on its own result, while the diff base stays the real project, so you still review and apply a
version exactly like a manual run.

**Parked** collects the tasks that cannot pass unattended: the check failed after two fixes, the diff
contains a secret or junk, the agent tried to publish outward, or the agent reported that it is blocked. A
parked task is labelled with a
`vf/parked-…` branch name, keeps its partial copy, can be returned to the queue to continue from it, and
does not stop the rest — the queue takes the next task. A subscription limit only pauses the queue and it
resumes after the reset; a lost login ends it.

**Stop** interrupts the agent and parks the partial work, **Finish after the current task** lets the
current task pass its check and then stops, and switching **Auto-queue** off stops taking new tasks. The
queue ends by itself when it is empty, when the task limit is reached, after three parks in a row, when the
login is lost, or when the disk is nearly full. The **Auto-queue results** card then shows the versions it
saved with their checks, the parked tasks with their reasons and the tasks that were not taken.

## Factory

The **Factory** turns a project into a ticket pipeline: a board keeps the tickets of one project, and
agents move each ticket from **Incoming** to **Ready for PR** without you; **Done** comes after you open
the pull request or merge the result. Open it with **Open the Factory**,
create a board for the project with **Create a board**, and switch it on with **Enable** — a board can only
be enabled after **Check readiness** passes. A paused board stops taking new tickets:
**Pause** stops new tickets while started ones finish, **Resume** returns it.

Readiness blocks on three things: the project is a git repository, it has at least one commit (the Factory
diffs against it) and at least one engine is logged in. A test command (or the project's suggested one), a
preview command and Playwright are reported in the list but do not block. If no test command is
configured, the board's check command and then the suggested one are used; without a usable command the
tests stage is skipped with a note.

The board shows seven columns — **Incoming**, **Triage**, **Working**, **Checks**, **Ready for PR**,
**Waiting for you**, **Done** — while the pipeline behind them has nine stages: incoming, triage, working,
tests, check, review, ready, waiting and done. **Checks** collapses the tests, app check and review stages.

**Incoming.** File a ticket with **Title**, **Description** and **Files and screenshots** (**Attach**),
add it with **Add the ticket**, or import a GitHub issue with **From a GitHub issue** — `#12` (the board's
project repository), `owner/repo#12` or the issue URL, read through an installed and signed-in `gh` and
never twice. A failed import says why: `gh` is missing or not signed in, the repository or the issue was
not found. Trackers (GitHub, GitLab, Jira, Linear) are
polled every five minutes when the board has them, with optional comment back; **Poll trackers now**
checks at once.

**Triage.** A read-only agent reads the project and the ticket and answers with a spec, acceptance
criteria, assumptions and a route. It proposes the cheapest sufficient route out of the allowed ones
(Solo, Swarm, Fusion, Orchestrator); the Factory may only cheapen that route, never upgrade it. Questions
go to **Waiting for you**: answer them with **Answer** and the ticket returns to triage. **Spec**,
**Criteria** and **Route** are then shown on the ticket.

**Working.** The ticket starts an ordinary Artel run of its route, under the same night-shift rules as an
auto-queue task; the first question is answered for it and a second sends the ticket to **Waiting for you**.
On an Orchestrator route the run stops after the plan and waits for **Approve the plan**.

**Tests** runs the board's test command and returns a failure to work with the output. **App check** runs
the preview and looks at the result in a read-only copy — only for UI tickets, only when the template
wants it, and only when a preview command and Playwright are configured. **Review** has one or two
reviewers read the ticket's diff against its criteria. A failed test command, app check or review becomes
a repair round back in **Working** with the findings, up to the template's limit; when the rounds are out
the ticket waits for you. A ticket that passes review moves to **Ready for PR**.

Templates: **Normal** — tests, app check and review, up to two repair rounds; **Fast** — no app check and
one repair round, for small tickets; **Strict** — two reviewers and up to three repair rounds. **Waiting
for you** collects triage questions, an orchestrator plan waiting for approval, exhausted repair rounds,
an interrupted ticket, a run with nothing to work on and tickets you postponed with **Postpone**; **One
more round** and **Accept as is** decide an exhausted ticket, and **Return to the factory** sends a ticket
you changed back through triage. The board and every ticket keep a journal of what happened.

**Ready for PR** offers three actions. **Pull Request** requires a clean working tree and a remote: it
creates the branch `factory/ticket-<number>`, applies the ticket's run to the real project, commits,
pushes and calls `gh pr create` with a body built from the spec, criteria, checks, assumptions and review
notes; the link is commented back into the tracker when the board asks for it. **Merge** applies the
ticket's cumulative diff to the project without a branch or a push. **Return with a comment** sends the
ticket back to work with your comment as a repair turn. **Open the session** attaches to the ticket's
session for a manual takeover. The Factory never sends anything outward by itself: push, pull request and
comments happen only when you press the button.

Settings per board: models per role (**Triage**, **Work**, **Tests**, **Review**), **Allowed routes**,
**Spend ceiling** (**Tickets at once**, **Tickets per day**, **Workers per ticket**, **Allow the «API»
engine**, **Allow nearly-exhausted subscriptions**), **Commands** (**Test command**, **Check command**,
**Preview command**), the "Append tests when the change touches none" quirk and **Ticket intake**
(trackers with their kind, label, project/URL and comment back).

## The run page

The selected run's page opens on the right: the task at the top, the mode tag (**Solo**, **Swarm**,
**Conductor**, **Fusion** or **Orchestrator**), the status, a tag with the number of changed files (once
there are any) and a phase line — the same short stage description as in the rail.

Run statuses: **Preparing**, **Planning**, **Working**, **Waiting for you**, **Finished**,
**Stopped**, **Failed**, **Applied**, **Discarded**.

While the run is active or waiting, the header also says what it waits for — «Waiting for your
answer», «Waiting for plan approval», «Waiting for Nova», «The agents are working», «Assembling the
result» — and how long it has been waiting; a tag next to it sums the tokens the whole run has spent
(hover it for input, output and cache). Under the header the **Right now** strip lists every agent:
its state dot, the last step — the tool call it is running (`write src/app.js`) or «writing a
reply» — the time spent on the current turn and how full its context window is, in tokens and
percent, with the composition (system, tools, messages) in the tooltip. All of it is part of the run
summary the Host already sends, so it costs no extra request.

![The run page: agent replies and grouped tool calls](artel-in-chat/screens/run.png)

While a run is active the header has a **Stop** button. It asks for confirmation: "Stop this Artel
run?" with **Stop run** and **Keep working** (and "Stopping…" while the request is in flight). A
stopped run becomes **Stopped**; the copy and the diff stay available, and messaging the agents puts
it back to work.

### The feed

- Full agent replies: an avatar with the initial, the name, the role and the time; the text is
  rendered as markdown.
- Tool calls are grouped into compact rows: the tool name and the file path or command. A row with
  more to tell — the arguments the agent passed and the output (or the error) the tool returned — is
  a button: it expands onto both and the chevron turns down; **Collapse all** closes every open row.
  Rows that only repeat the name, like `read README.md`, stay plain.
- Status rows with a timestamp and a **Plan** card with the split of work. In Conductor mode the
  **Plan** card also carries the conductor's decisions: the handed-out shares, the rework round and the
  acceptance. In Fusion mode it carries the judge's merged decision and the disputed places count. In
  Orchestrator mode it carries the planner's split with the done conditions, the reviewer's verdict on
  every part and the assembly card; the **Parts** card above the diff lists the parts and their status.
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
and the implementer once the work starts. In Orchestrator mode messages are refused while the planner
is splitting the goal ("Wait until the planner splits the goal into parts") and while a stopped merge is
still unfinished ("The merge was stopped. Discard the run and plan it again."); otherwise writing works
as usual.

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

In Orchestrator mode **Apply** has one more gate: the parts must be assembled first. If you stopped the
run in the middle of the merge, or the merger could not resolve a file that several parts changed,
**Apply** is refused and the card says the merge is not finished — the assembled copy stays readable,
but the only way forward is **Discard** and a new run.

An apply is final: the run becomes **Applied**, its changes are in the project, and the isolated copy is
deleted right away. The diff stays in the run feed, so you can still read what changed.

## Where the data lives

- Copies: `<DSH home>/artel/<profile>/copies/<run id>` — deleted when the run is applied or discarded; a
  copy left behind by a crash is removed at the next start. An Orchestrator run keeps one copy per part
  (`<run id>-p1`, `<run id>-p2`, …) until the parts are assembled, then only the assembled `<run id>`
  copy remains.
- Run index and feeds: `<DSH home>/artel/<profile>/state/runs` — a JSON index and one JSONL file per
  run, with a size limit.
- Auto-queue and Factory: `<DSH home>/artel/<profile>/state/queue/<session>.json` (one queue per chat
  session), `.../state/tickets/boards.json` (ticket boards) and `.../state/attachments/<board>/<ticket>/`
  (ticket files).
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
