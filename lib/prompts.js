/**
 * Prompt templates for Artel runs.
 *
 * Kept in one place so the product's agent contract is reviewable: the copy
 * rule ("the real project is untouched"), the swarm planning turn ("no edits"),
 * the OWNERSHIP line that the host parses, the go-ahead that pins down the file
 * map, and — for the shared-conversation swarm — how the agents may talk to each
 * other while they work. Conductor runs add the lead's turns: the decision on the
 * proposed shares, the review of the whole copy, the rework and the handover of a
 * stopped worker's share.
 *
 * Every swarm prompt accepts both shapes of `peers`: plain display names
 * (legacy, agents are separate conversations) or `{ name, address }` objects,
 * where `address` is the name the agent types into `send_message` ({ name,
 * address } comes from the engine's agent tree).
 */

import { INSTALL_MANIFEST, MAX_INSTALL_STEPS } from './install.js'

export const OWNERSHIP_MARKER = 'OWNERSHIP:'

function taskBlock(task) {
  return `Task from the user (verbatim, in their own language):\n\n${task.trim()}\n`
}

/**
 * The post-Apply contract every editing agent follows.
 *
 * Artel writes files only: it never installs the result into the running DSH and
 * never runs the project's own installer — those are explicit actions on the
 * changes card after Apply. An agent that does not know this either attempts the
 * impossible (write into the DSH profile, call the plugin manager) or leaves the
 * project uninstallable, which is exactly how issue #9 ended: a valid bundle, a
 * successful Apply, and nothing live.
 * @returns {string} prompt paragraph.
 */
export function installNotes() {
  return `INSTALLING WHAT YOU BUILD (read before you finish)
- Artel writes files only. It never installs the result into the running DSH and never runs the project's installer: the changes card does that after Apply, and only when the user clicks. So do not try to install anything yourself, do not write into the user's home directory, the DSH profile or node_modules, and do not call plugin_manager.
- Leave the project ready to be installed instead. A DSH bundle needs package.json with "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } and that patch file at the path it names.
- Any command the user must run after Apply (a runtime setup, a data download, an external tool) goes into ${INSTALL_MANIFEST} at the project root:
  { "steps": [{ "title": "Install the runtime", "command": "python install/install.py" }] }
  At most ${MAX_INSTALL_STEPS} steps. Each step is ONE command the user confirms in the changes card; the card runs it in the project root and shows its output. An installer the project already ships conventionally (install/install.py, install.sh, install.mjs) is offered even without this file, but the file is how the project states its own order and titles.
- If a step is required before the result works, say so in your summary and repeat the exact command in the README.
`
}

/**
 * The planning agent's version of the contract: installation is never a part.
 * @returns {string} prompt paragraph.
 */
export function plannerInstallNotes() {
  return `INSTALLING IS NOT A PART. Artel writes files only; after Apply the changes card offers to install the result and never installs anything by itself. The plan must NOT schedule a part that installs the project, writes into the user's home directory or the DSH profile, or calls plugin_manager — the sandbox refuses all of that. A part prepares the project instead:
- a DSH bundle part ends with package.json declaring "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } and that patch file existing;
- every command the user still has to run goes into ${INSTALL_MANIFEST} at the project root: { "steps": [{ "title": "...", "command": "..." }] }, at most ${MAX_INSTALL_STEPS}, one command per step;
- if installation is part of the goal, the PLAN line says it happens after Apply and names the exact command.
`}

/**
 * Normalise the two accepted peer shapes into one list.
 * @param {Array<string | { name?: string, address?: string | null }>} peers
 * @returns {Array<{ name: string, address: string | null }>} normalised peers.
 */
function normalizePeers(peers) {
  if (!Array.isArray(peers)) return []
  const list = []
  for (const peer of peers) {
    if (typeof peer === 'string') {
      if (peer !== '') list.push({ name: peer, address: null })
      continue
    }
    const name = typeof peer?.name === 'string' ? peer.name : ''
    if (name === '') continue
    list.push({ name, address: typeof peer?.address === 'string' && peer.address !== '' ? peer.address : null })
  }
  return list
}

/**
 * Names a member may send to, as one readable line.
 * @param {Array<{ name: string, address: string | null }>} peers
 * @returns {string} comma separated `Name ("address")` pairs.
 */
function addressLine(peers) {
  return peers.map((peer) => (peer.address ? `${peer.name} ("${peer.address}")` : peer.name)).join(', ')
}

/**
 * The first-turn prompt of a swarm member: read the copy, divide the work, do
 * not touch a single file. In the shared-conversation swarm the members can
 * message each other while they plan, which is what makes the division real
 * rather than three simultaneous guesses.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy the team works in.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} request.peers - the other agents.
 * @param {string} request.selfName - this agent's display name.
 * @param {string} [request.selfAddress] - this agent's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the planning prompt.
 */
export function swarmPlanPrompt({ copyPath, projectPath, task, peers, selfName, selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const peerList = list
    .map((peer) => (peer.address ? `- ${peer.name} — send_message name "${peer.address}"` : `- ${peer.name}`))
    .join('\n')
  const selfLine = selfAddress ? ` and the name you answer to is "${selfAddress}"` : ''
  const talk = canMessage
    ? `- You are a live team, not three separate conversations: every other agent READS what you send, and you read what they send. Talk with send_message({ agent: "<address>", message: "<text>" }) — the address is the short lowercase name quoted in the list above and it is case-sensitive ("orion", not "Orion"). list_agents({}) shows the whole team${selfLine}. Every message is also shown to the user in the shared feed.
- Use messaging for real coordination only: announce the area you are taking, answer one concrete question, or warn a peer about a clash. Two short messages is the ceiling — never wait for a reply and never start a chat.
- Do not call wait_agent in this turn: the go-ahead arrives from Artel only after every agent ends its turn, so waiting here stalls the whole team. Announce, then end your turn.
- The ownership decision itself still goes into the OWNERSHIP line below: Artel collects those lines, resolves overlaps (first claim wins) and sends everyone the final map. Files nobody claimed are handed to agents that claimed nothing.`
    : `- Do not try to reach the other agents with send_message or list_agents: each agent is a separate conversation and those calls fail. Coordination happens through the OWNERSHIP line below — Artel collects the claims, resolves overlaps (first claim wins) and sends everyone the final map. Files nobody claimed are handed to agents that claimed nothing.`
  const shared = canMessage
    ? 'You all work in the same directory at the same time and you can see each other\'s messages.'
    : 'You all work in the same directory at the same time.'
  return `You are ${selfName}, one of ${list.length + 1} agents sharing ONE copy of the user's project at the same time: ${copyPath}

The other agents are:
${peerList}

${shared} The user's real project (${projectPath}) stays untouched; one combined review follows the run.

THIS IS THE PLANNING TURN — DO NOT EDIT ANYTHING.
- Do not create, edit, delete, move or format a single file in this turn. Read-only tools only.
- Read enough of the code to divide the work cleanly.
- Pick the files or directories you will own. Keep your area narrow and independent from what the others are likely to take.
- If the task is small enough for one agent, claim nothing: Artel then makes you a verifier of the whole shared copy, which is more useful than an invented area — unless Artel hands you files nobody claimed, in which case you edit them like your own.
- Never write prose next to the OWNERSHIP line: a claimed path must be a real file or directory, and a placeholder like "none" must be the whole line.
${talk}
- End your message with exactly one line in this format, listing every path you will edit:
${OWNERSHIP_MARKER} <comma separated paths, directories may end with /**>
- Then stop and end your turn. You will get the go-ahead with the final ownership map.

${taskBlock(task)}
Plan now: no edits, one OWNERSHIP line, then stop.`
}

/**
 * The go-ahead prompt: pins the final file map and — in the shared-conversation
 * swarm — keeps the team reachable while the work happens.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy.
 * @param {string} request.ownershipMap - readable ownership lines.
 * @param {string[]} request.ownClaims - paths this agent owns.
 * @param {Array<{ path: string, ownerName: string }>} request.contested - paths claimed by others.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} [request.peers] - the other agents.
 * @param {string} [request.selfAddress] - this agent's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the work prompt.
 */
export function swarmGoPrompt({ copyPath, ownershipMap, ownClaims, contested, task, peers = [], selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const own = ownClaims.length > 0 ? ownClaims.join(', ') : 'nothing — act as a reader/reviewer and report defects in the shared feed'
  const contestedLines = contested.length > 0
    ? `\nContested paths that are NOT yours (never edit them):\n${contested.map((entry) => `- ${entry.path} belongs to ${entry.ownerName}`).join('\n')}\n`
    : ''
  const beyond = canMessage
    ? `If a needed change falls outside it, message the owner with send_message({ agent: "<owner's address from the team line>", message: "<what and why>" }) and mention it in your final summary — never edit the owner's files.`
    : `If a needed change falls outside it, say so in your final summary instead of editing the owner's files — send_message does not reach the other agents in this run.`
  const team = canMessage
    ? `\nThe team is live: you are "${selfAddress ?? 'lead'}", the others are ${addressLine(list)}. Use exactly the quoted address in send_message — the names are case-sensitive. Incoming messages arrive as a user turn that begins "Agent <name> sent a message:"; answer briefly if a peer asks something, then carry on. A peer message starts a new turn for you, so never wait for a reply. Everything is shown to the user in the shared feed.\n`
    : ''
  return `Planning is over. Final ownership map for this run:

${ownershipMap}
${contestedLines}
Your area: ${own}
${team}
Now do the work in ${copyPath}:
- Edit only files in your area. ${beyond}
- Files marked "(nobody claimed it)" in the map above are yours now: edit them like your own, do not leave them to someone else.
- If nothing in your area needs a change for this task, change nothing and say so plainly in your summary. Do not invent work.
- Read the copy as the other agents write: their edits are already on disk, so adapt your work to theirs.
- The checks run on the whole shared copy, so a failure may come from a peer's files: report it in your summary instead of editing outside your area.
- Do not commit, push or publish. Do not change dependency manifests unless the task requires it.
- When your part is done and verified, reply with a short summary: what changed, what you checked, what is still open.

${installNotes()}
${taskBlock(task)}`
}

/**
 * The solo agent prompt: one agent, one copy, one task.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the copy the agent works in.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @returns {string} the work prompt.
 */
export function soloPrompt({ copyPath, projectPath, task }) {
  return `You are working on ONE copy of the user's project: ${copyPath}

The user's real project (${projectPath}) is untouched and must stay untouched. Do all work inside the copy; when the user applies the run, only the files you changed are copied back.

${taskBlock(task)}
Work directly in the copy:
- Read the project before editing. Follow its existing style, structure and conventions.
- Make the smallest coherent change that fully solves the task.
- Run the project's own checks (tests, lint, build) when they exist: a change that does not pass its own checks is not done.
- Do not commit, push or publish. Do not change dependency manifests unless the task requires it.
- Keep the user informed: say briefly what you are doing and why.

${installNotes()}
${finishNoteSolo()}`
}

export function userMessagePrompt({ text, broadcast, agentName }) {
  if (broadcast) {
    return `The user has written to the whole run (you are ${agentName}, and the other agents received the same message):\n\n${text.trim()}\n\nTake it into account in the work you are doing right now.`
  }
  return `The user wrote to you:\n\n${text.trim()}\n\nTake it into account in the work you are doing right now.`
}

export function collisionNotice({ path, ownerName, ownerAgentName, ownerAddress, canMessage = false }) {
  const owner = ownerName ?? ownerAgentName ?? 'another agent'
  const tail = canMessage
    ? ` Message the owner${ownerAddress ? ` (send_message name "${ownerAddress}")` : ''} if the change is really needed.`
    : ''
  return `Heads-up from the run coordinator: you wrote to ${path}, which belongs to ${owner}'s area. Do not edit that file again.${tail}`
}

export function finishNoteSolo() {
  return 'When the task is fully done and verified, finish with a short summary: what you changed, how you checked it, and anything the user should know before applying the changes.'
}

export function finishNoteSwarm() {
  return 'When your part is done and verified, finish with a short summary: what you changed, what you checked, and anything still open for the other agents.'
}

/* ---------------------------------------------------------------- conductor */

// Markers shared with lib/conductor.js; the prompts are where the model reads
// them, so they stay literal in the prompt bodies.
const SHARES_MARKER = 'SHARES:'
const VERDICT_MARKER = 'VERDICT:'
const REWORK_MARKER = 'REWORK:'

/**
 * Render the "each worker's own words" block of the decide prompt.
 *
 * The engine passes an array of `{ name, claims: string[] }` in team order; a
 * record of name → claims and a plain array of lines are accepted too so the
 * prompt does not depend on one internal shape.
 * @param {Array<object>} workers - normalised workers.
 * @param {unknown} claims - raw claims announced by the workers.
 * @returns {string} one line per worker.
 */
function describeClaims(workers, claims) {
  const nothing = '- (no OWNERSHIP lines were announced)'
  if (Array.isArray(claims)) {
    if (claims.length === 0) return nothing
    return claims.map((entry) => {
      if (typeof entry === 'string') return `- ${entry}`
      const value = entry?.claims ?? entry?.paths ?? entry?.text ?? ''
      const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
      const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : 'agent'
      return `- ${name}: ${text === '' ? 'nothing' : text}`
    }).join('\n')
  }
  if (claims !== null && typeof claims === 'object') {
    const lines = Object.entries(claims).map(([name, value]) => {
      const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
      return `- ${name}: ${text === '' ? 'nothing' : text}`
    })
    return lines.length > 0 ? lines.join('\n') : nothing
  }
  return nothing
}

/**
 * The live-team paragraph shared by the conductor's worker prompts. The
 * conductor is always addressable as `conductor`; the other workers keep their
 * subagent addresses.
 * @param {Array<{ name: string, address: string | null }>} list - normalised peers.
 * @param {string} [selfAddress] - this worker's `send_message` name.
 * @param {boolean} canMessage - whether the agents share one conversation tree.
 * @returns {string} the paragraph, or '' when messaging is unavailable.
 */
function conductorTeamLine(list, selfAddress, canMessage) {
  if (!canMessage) return ''
  return `\nThe team is live: you are "${selfAddress ?? 'agent'}", the conductor and the other workers are ${addressLine(list)}. Use exactly the quoted address in send_message — the names are case-sensitive; the conductor answers as "conductor". Incoming messages arrive as a user turn that begins "Agent <name> sent a message:"; answer briefly if a peer or the conductor asks something, then carry on. A message starts a new turn for you, so never wait for a reply. Everything is shown to the user in the shared feed.\n`
}

/**
 * The conductor's first turn: read the copy, write acceptance criteria, claim
 * nothing. The workers' OWNERSHIP proposals arrive after this turn; the
 * conductor approves the layout in the next one.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy the team works in.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} request.workers - the workers.
 * @param {string} request.selfName - the conductor's display name.
 * @returns {string} the planning prompt.
 */
export function conductorPlanPrompt({ copyPath, projectPath, task, workers, selfName }) {
  const list = normalizePeers(workers)
  const team = list.length > 0
    ? list.map((peer) => (peer.address ? `- ${peer.name} — send_message name "${peer.address}"` : `- ${peer.name}`)).join('\n')
    : '- (no workers)'
  return `You are ${selfName}, the conductor of ${list.length} worker${list.length === 1 ? '' : 's'} sharing ONE copy of the user's project at the same time: ${copyPath}

Your team:
${team}

The user's real project (${projectPath}) stays untouched. The team edits only the copy; you never edit a project file yourself — you decide the shares, answer the workers while they work, and accept the work at the end.

THIS IS THE PLANNING TURN — DO NOT EDIT ANYTHING AND DO NOT CLAIM FILES.
- Read-only tools only. Read enough of the project to judge the task.
- Write a short list of acceptance criteria: what must be true for the user's task to be done. Say plainly what the workers must not touch.
- The workers will send you their OWNERSHIP: proposals — the files or folders each one wants. Keep the areas narrow and independent, and get ready to approve or redraw the layout.
- Do not announce a layout of your own yet: the proposals are not in. You will answer with SHARES: lines in the next turn and your word there is binding.
- Keep this message short and end your turn when the criteria are written. Nothing is edited in this step.

${taskBlock(task)}
Plan now: acceptance criteria and anything off-limits, no edits, then stop and end your turn.`
}

/**
 * A worker's conductor-mode planning turn: read-only, claim a narrow area, one
 * OWNERSHIP line, then stop. The conductor runs the team, so the worker is told
 * where to bring a blocking question.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy the team works in.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} request.peers - the conductor and the other workers.
 * @param {string} request.selfName - this worker's display name.
 * @param {string} [request.selfAddress] - this worker's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the planning prompt.
 */
export function conductorWorkerPlanPrompt({ copyPath, projectPath, task, peers, selfName, selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const peerList = list
    .map((peer) => (peer.address ? `- ${peer.name} — send_message name "${peer.address}"` : `- ${peer.name}`))
    .join('\n')
  const selfLine = selfAddress ? ` and the name you answer to is "${selfAddress}"` : ''
  const talk = canMessage
    ? `- You are a live team, not separate conversations: every other agent READS what you send, and you read what they send. Talk with send_message({ agent: "<address>", message: "<text>" }) — the address is the short lowercase name quoted in the list above and it is case-sensitive ("orion", not "Orion"). list_agents({}) shows the whole team${selfLine}. Every message is also shown to the user in the shared feed.
- Use messaging for real coordination only: announce the area you are taking, answer one concrete question, or tell the conductor about a clash. Two short messages is the ceiling — never wait for a reply and never start a chat. The conductor is the lead: bring it a question that blocks you instead of guessing.
- Do not call wait_agent in this turn: the go-ahead arrives from Artel only after every agent ends its turn, so waiting here stalls the whole team. Announce, then end your turn.
- The ownership decision itself still goes into the OWNERSHIP line below: Artel collects those lines, resolves overlaps (first claim wins) and the conductor approves or redraws the final map.`
    : `- Do not try to reach the other agents with send_message or list_agents: each agent is a separate conversation and those calls fail. Coordination happens through the OWNERSHIP line below — Artel collects the claims, resolves overlaps (first claim wins) and the conductor approves the final map.`
  const shared = canMessage
    ? 'You all work in the same directory at the same time and you can see each other\'s messages.'
    : 'You all work in the same directory at the same time.'
  return `You are ${selfName}, one of ${list.length + 1} agents sharing ONE copy of the user's project at the same time: ${copyPath}

The other agents are:
${peerList}

${shared} ${list.length > 0 ? 'The conductor is the lead: it approves the shares, answers you while you work, and accepts the whole result at the end. ' : ''}The user's real project (${projectPath}) stays untouched; one combined review follows the run.

THIS IS THE PLANNING TURN — DO NOT EDIT ANYTHING.
- Do not create, edit, delete, move or format a single file in this turn. Read-only tools only — never edit a file during planning.
- Read enough of the code to propose one narrow, independent area.
- Pick the files or directories you will own. Keep your area narrow and independent from what the others are likely to take.
- If the task is small enough for one agent, claim nothing: the conductor decides how to use you — unless it hands you files nobody claimed, in which case you edit them like your own.
- Never write prose next to the OWNERSHIP line: a claimed path must be a real file or directory, and a placeholder like "none" must be the whole line.
${talk}
- End your message with exactly one line in this format, listing every path you will edit:
${OWNERSHIP_MARKER} <comma separated paths, directories may end with /**>
- Then stop and end your turn. The go-ahead with the conductor's final shares arrives after every agent ends its turn.

${taskBlock(task)}
Plan now: no edits, one OWNERSHIP line, then stop.`
}

/**
 * The conductor's decide turn: approve the resolved proposal or redraw the
 * layout. Every worker must be accounted for, one way or another.
 * @param {object} request - prompt inputs.
 * @param {string} request.proposalMap - the proposed ownership map.
 * @param {Array<{ name: string, claims: string[] }> | object} request.claims - the workers' raw claims.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} request.workers - the workers.
 * @returns {string} the decide prompt.
 */
export function conductorDecidePrompt({ proposalMap, claims, task, workers }) {
  const list = normalizePeers(workers)
  const roster = list.length > 0 ? list.map((peer) => (peer.address ? `${peer.name} ("${peer.address}")` : peer.name)).join(', ') : 'none'
  return `You are the conductor. The workers finished their planning turn and nobody has edited a file. Artel resolved their OWNERSHIP: proposals first-claim-wins into this provisional layout:

PROPOSED SHARES (a proposal, not final):
${proposalMap}

Each worker's own words:
${describeClaims(list, claims)}

The team: ${roster}

DECIDE THE SHARES NOW — DO NOT EDIT ANY FILE.
- Approve the layout when every area is narrow and independent and the task is fully covered. Or change it: move files between workers, close a share that has nothing to do.
- Every worker must appear in your decision, including workers that get nothing.
- End your final answer with exactly one decision block. Either the single line:
${SHARES_MARKER} approve
or one line per worker:
${SHARES_MARKER} <WorkerName> = <comma separated paths>
and use none for a worker that gets no files:
${SHARES_MARKER} <WorkerName> = none
- Use the worker display names exactly as listed above. Nothing comes after the decision block, and this is the only SHARES: block in your answer — the host reads it as binding.

${taskBlock(task)}
Decide now: approve or the complete share list, then stop and end your turn.`
}

/**
 * A worker's go-ahead in conductor mode: the conductor's approved shares are
 * final; the work rules are the swarm ones plus the conductor as the lead.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy.
 * @param {string} request.ownershipMap - readable ownership lines.
 * @param {string[]} request.ownClaims - paths this worker owns.
 * @param {Array<{ path: string, ownerName: string }>} request.contested - paths claimed by others.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} [request.peers] - the conductor and the other workers.
 * @param {string} [request.selfAddress] - this worker's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the work prompt.
 */
export function conductorWorkerGoPrompt({ copyPath, ownershipMap, ownClaims, contested, task, peers = [], selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const own = ownClaims.length > 0 ? ownClaims.join(', ') : 'nothing — act as a reader/reviewer and report defects in the shared feed'
  const contestedList = Array.isArray(contested) ? contested : []
  const contestedLines = contestedList.length > 0
    ? `\nContested paths that are NOT yours (never edit them):\n${contestedList.map((entry) => `- ${entry.path} belongs to ${entry.ownerName}`).join('\n')}\n`
    : ''
  const beyond = canMessage
    ? `If a needed change falls outside it, message the owner with send_message({ agent: "<owner's address from the team line>", message: "<what and why>" }) and mention it in your final summary — never edit the owner's files.`
    : `If a needed change falls outside it, say so in your final summary instead of editing the owner's files — send_message does not reach the other agents in this run.`
  const team = conductorTeamLine(list, selfAddress, canMessage)
  return `Planning is over. The conductor approved the shares. Final ownership map for this run:

${ownershipMap}
${contestedLines}
Your area: ${own}
${team}
Now do the work in ${copyPath}:
- Edit only files in your area. ${beyond}
- Files marked "(nobody claimed it)" in the map above are yours now: edit them like your own, do not leave them to someone else.
- If nothing in your area needs a change for this task, change nothing and say so plainly in your summary. Do not invent work.
- Read the copy as the other agents write: their edits are already on disk, so adapt your work to theirs.
- Run the project's own checks (tests, lint, build) when they exist. The checks run on the whole shared copy, so a failure may come from a peer's files: report it in your summary instead of editing outside your area.
- Do not commit, push or publish. Do not change dependency manifests unless the task requires it.
- When your part is done and verified, reply with a short summary: what changed, what you checked, what is still open. Then stop and end your turn — do not wait for the other agents; the conductor reviews once every agent is idle.

${installNotes()}
${taskBlock(task)}`
}

/**
 * The conductor's review turn: the whole copy is checked as one piece and gets
 * an accept or a (max two) rework verdict.
 * @param {object} request - prompt inputs.
 * @param {string} request.digest - `changeDigest()` output for the whole copy.
 * @param {string} request.ownershipMap - the approved ownership map.
 * @param {string} request.task - the user's task.
 * @param {number} request.roundsLeft - rework rounds still available.
 * @param {string} [request.previousRemarks] - remarks from the previous round.
 * @returns {string} the review prompt.
 */
export function conductorReviewPrompt({ digest, ownershipMap, task, roundsLeft, previousRemarks }) {
  const left = typeof roundsLeft === 'number' && Number.isFinite(roundsLeft) ? Math.max(0, Math.floor(roundsLeft)) : 0
  const digestText = typeof digest === 'string' && digest.trim() !== '' ? digest.trim() : 'No files changed in the copy.'
  const remarks = typeof previousRemarks === 'string' && previousRemarks.trim() !== ''
    ? `Your remarks from the previous round (verbatim):\n${previousRemarks.trim()}\n\n`
    : ''
  const limit = left <= 0
    ? 'NO REWORK ROUNDS ARE LEFT: the rework option is closed. Accept the work and put anything still unfinished into the notes so the user knows what to look at.'
    : `Rework rounds left after this verdict: ${left}.`
  return `You are the conductor. Every worker is idle and the whole shared copy is yours to review as one piece.

THE APPROVED SHARES:
${ownershipMap}

EVERY CHANGE IN THE COPY:
${digestText}

${remarks}${limit}
REVIEW NOW — DO NOT EDIT ANY FILE.
- Read the changed files and compare the whole result with the user's task.
- Run the project's own checks (tests, lint, build) on the shared copy. A green check is necessary, not sufficient: the task itself must be closed.
- Accept only when the goal is actually met. Send the work back with concrete remarks when a share is not done — name the files and the defect.
- End your final answer with exactly one verdict line, either:
${VERDICT_MARKER} accept — <short notes for the user>
or
${VERDICT_MARKER} rework — <what must be fixed>
- After a rework verdict add one optional line naming only the workers that must redo their share. Omit it, or write all, when the whole team goes back:
${REWORK_MARKER} <WorkerName, WorkerName>

${taskBlock(task)}
Give the verdict now, then stop and end your turn.`
}

/**
 * A worker's rework turn: the conductor's remarks, the worker's own area, and
 * the same no-commit work rules. Ends with a short summary.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy.
 * @param {string} request.ownershipMap - readable ownership lines.
 * @param {string[]} request.ownClaims - paths this worker owns.
 * @param {string} request.remarks - the conductor's remarks, verbatim.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} [request.peers] - the conductor and the other workers.
 * @param {string} [request.selfAddress] - this worker's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the rework prompt.
 */
export function conductorReworkPrompt({ copyPath, ownershipMap, ownClaims, remarks, task, peers = [], selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const own = ownClaims.length > 0 ? ownClaims.join(', ') : 'nothing — re-check the whole copy and report what is still wrong'
  const remarksText = typeof remarks === 'string' && remarks.trim() !== ''
    ? remarks.trim()
    : '(the conductor left no details — re-read the task and fix whatever is still open in your area)'
  const team = conductorTeamLine(list, selfAddress, canMessage)
  return `You are back for a rework round. The conductor reviewed the whole copy and sent part of the work back, with these remarks (verbatim):

${remarksText}

Final ownership map for this run:

${ownershipMap}

Your area: ${own}
${team}
Now do the rework in ${copyPath}:
- Edit only files in your area. If a remark clearly points at a file outside it, message the owner (or the conductor) instead of editing it.
- Fix every remark that concerns your share; do not rewrite work the conductor already accepted.
- Read the copy as the other agents write: their fixes are already on disk, so adapt your work to theirs.
- Run the project's own checks (tests, lint, build) when they exist. The checks run on the whole shared copy, so a failure may come from a peer's files: report it in your summary instead of editing outside your area.
- Do not commit, push or publish.
- When your share is fixed and verified, reply with a short summary: what you fixed, what you checked, what is still open. Then stop and end your turn — do not wait for the other agents; the conductor reviews again once every agent is idle.

${taskBlock(task)}`
}

/**
 * The conductor's handover turn: one worker failed, its share must go somewhere
 * or be closed.
 * @param {object} request - prompt inputs.
 * @param {string} request.failedName - the worker that stopped.
 * @param {string[]} request.failedFiles - the failed worker's claimed paths.
 * @param {string} request.ownershipMap - the current ownership map.
 * @param {string[]} request.aliveNames - the workers that can still take work.
 * @param {string} request.task - the user's task.
 * @returns {string} the handover prompt.
 */
export function conductorHandoverPrompt({ failedName, failedFiles, ownershipMap, aliveNames, task }) {
  const files = Array.isArray(failedFiles) && failedFiles.length > 0 ? failedFiles.join(', ') : 'nothing'
  const alive = Array.isArray(aliveNames) && aliveNames.length > 0 ? aliveNames.join(', ') : 'nobody'
  return `You are the conductor. ${failedName} stopped and can no longer finish its share.

Its files were: ${files}

CURRENT OWNERSHIP MAP:
${ownershipMap}

Agents still alive: ${alive}

DECIDE THE HANDOVER NOW — DO NOT EDIT ANY FILE.
- Move the share to one of the alive workers:
${SHARES_MARKER} <WorkerName> = <comma separated paths>
- Or accept the host's suggestion and hand the files to the least-loaded alive worker:
${SHARES_MARKER} approve
- Or close the share when nobody needs those files:
${SHARES_MARKER} <WorkerName> = none
- Use an alive worker's display name exactly as listed. End your answer with the decision block and nothing after it; the host applies it to the stored shares.

${taskBlock(task)}
Answer now with your handover, then stop and end your turn.`
}

/**
 * A live worker's share-update turn: the conductor moved a failed share to it.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the shared copy.
 * @param {string} request.ownershipMap - readable ownership lines.
 * @param {string[]} request.ownClaims - paths this worker owns, added files included.
 * @param {string} request.task - the user's task.
 * @param {Array<string | object>} [request.peers] - the conductor and the other workers.
 * @param {string} [request.selfAddress] - this worker's `send_message` name.
 * @param {boolean} [request.canMessage] - whether the agents can message each other.
 * @returns {string} the share-update prompt.
 */
export function conductorShareUpdatePrompt({ copyPath, ownershipMap, ownClaims, task, peers = [], selfAddress, canMessage = false }) {
  const list = normalizePeers(peers)
  const own = ownClaims.length > 0 ? ownClaims.join(', ') : 'nothing yet — take the files the conductor just moved to you'
  const team = conductorTeamLine(list, selfAddress, canMessage)
  return `The conductor moved part of another agent's share to you. You now also own it.

THESE ADDED FILES ARE YOURS: ${own}

CURRENT OWNERSHIP MAP:
${ownershipMap}
${team}
Finish the added work in ${copyPath}:
- Edit only files in your area, the added files included. Ask the owner (or the conductor) before touching anything outside it.
- Pick up where the failed share stopped: read what is already on disk before changing it, and do not redo work that is already correct.
- Run the project's own checks (tests, lint, build) when they exist. The checks run on the whole shared copy, so a failure may come from a peer's files: report it in your summary instead of editing outside your area.
- Do not commit, push or publish.
- When the added share is done and verified, reply with a short summary: what you finished, what you checked, what is still open. Then stop and end your turn — do not wait for the other agents; the conductor reviews once every agent is idle.

${taskBlock(task)}`
}

/* ------------------------------------------------------------------- fusion */

// The judge ends with this marker; the engine parses it through lib/fusion.js.
// The prompts are where the model reads it, so it stays literal here too.
const DISPUTES_MARKER = 'DISPUTES:'

/**
 * Cap one panel answer before it goes into the judge's prompt, so three long
 * answers cannot crowd out the judge's own reasoning.
 * @param {unknown} value - the panel answer.
 * @param {number} [max] - character budget per answer.
 * @returns {string} the answer, cut with a note when it was too long.
 */
function compactAnswer(value, max = 16000) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (this answer was cut at ${max} characters)`
}

/**
 * A panel member's only turn: answer the task independently, read-only.
 *
 * The panel is not a team: each model answers in its own conversation, never
 * sees the others and is never asked to implement. The judge is the only reader
 * of these answers, so the prompt asks for a concrete, implementable position
 * rather than a polite survey of options.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the read-only copy the panel reads.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {string} request.selfName - this model's display name.
 * @param {number} [request.panelSize] - how many models answer the same task.
 * @returns {string} the panel prompt.
 */
export function fusionPanelPrompt({ copyPath, projectPath, task, selfName, panelSize = 3 }) {
  return `You are ${selfName}, one of ${panelSize} independent models asked the SAME question at the same moment. You are not a team: the other models are in separate conversations, you never see their answers and they never see yours. A judge reads all the answers and merges them into one decision; that merged decision is what gets implemented.

The project is at ${copyPath} — a read-only copy of the user's project. The user's real project (${projectPath}) is untouched and stays untouched.

THIS IS A DELIBERATION TURN — DO NOT EDIT ANYTHING.
- Do not create, edit, delete, move or format a single file.
- Read the project as much as you need: any file, any directory.
- Answer the question of HOW the task should be done: the approach you would take, the files and areas it touches, the order of the steps, the risks, and what should be verified when it is done.
- Give your honest independent position. Do not try to guess what the other models would say, and do not hedge every point: where you are confident, say so and say why.
- Where the task is ambiguous, name the ambiguity and the reading you would choose.
- Be concrete enough that one model can implement your answer without asking you again.

End with a short section titled "RECOMMENDATION:" stating, in a few lines, the approach you would implement and why this one over the alternatives you considered.

${taskBlock(task)}
Answer now: read-only, no edits, then stop and end your turn.`
}

/**
 * The judge's one turn: merge the panel answers into one decision.
 *
 * The answers arrive verbatim (each capped), with the model that wrote them. The
 * prompt demands a machine-readable `DISPUTES:` line at the very end so the host
 * can show how many places are still contested, and a fixed structure so the
 * merged decision is always the first thing the user and the implementer read.
 * @param {object} request - prompt inputs.
 * @param {string} request.task - the user's task.
 * @param {Array<{ name: string, model?: string, text: string }>} request.answers - panel answers.
 * @param {number} [request.panelSize] - how many models were asked.
 * @returns {string} the judge prompt.
 */
export function fusionJudgePrompt({ task, answers, panelSize = 3 }) {
  const list = Array.isArray(answers) ? answers : []
  const rendered = list.length === 0
    ? '(no panel answers arrived)'
    : list
      .map((answer, index) => {
        const name = typeof answer?.name === 'string' && answer.name !== '' ? answer.name : `Model ${index + 1}`
        const model = typeof answer?.model === 'string' && answer.model !== '' ? ` — ${answer.model}` : ''
        return `### Answer ${index + 1}: ${name}${model}\n\n${compactAnswer(answer?.text)}`
      })
      .join('\n\n')
  return `You are the judge of a Fusion run. ${list.length} of ${panelSize} independent models received the SAME task at the same moment. They could not see each other's answers and they edited nothing. Their full answers are below, verbatim.

THE PANEL ANSWERS:
${rendered}

MERGE THEM INTO ONE DECISION — DO NOT EDIT ANY FILE.
- Nobody wins: keep the strongest parts of every answer, never the answer with the most confident tone.
- When two or three answers agree on an approach, that approach leads the merged decision.
- When they diverge, pick the approach best supported by the project as it actually is, and say in one line why the other one loses.
- Keep a point only one answer made when it is right — that is often the most valuable part of the panel.
- Do not hide a real disagreement behind vague wording; the user has to see what is still open.
- The merged decision must be concrete: approach, files and areas, order of steps, checks to run, and what must NOT be touched.
- Write no code in place of the decision: a separate implementer model does the work from your text.

Structure your answer exactly like this:
## Merged decision
<the one decision, concrete enough to implement>
## Where the answers converged
<bullets>
## Where they diverged
<bullets, one line of why per side>
## What only one answer saw
<bullets, or "nothing that changes the decision">
## Disputed places
<one line per real disagreement, or "none">

End your answer with exactly one final line and nothing after it:
${DISPUTES_MARKER} <number of real disagreements from the section above>

${taskBlock(task)}
Judge now, then stop and end your turn.`
}

/**
 * The implementer's turn: carry the merged decision into the copy.
 *
 * The implementer sees the merged decision as the plan and works under the
 * normal solo rules: read first, smallest coherent change, run the project's own
 * checks, no commit. It is also allowed to disagree with one concrete point of
 * the decision, as long as it says so in its summary.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the copy the implementer works in.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {string} request.decision - the judge's merged decision.
 * @returns {string} the implementation prompt.
 */
export function fusionImplementPrompt({ copyPath, projectPath, task, decision }) {
  const merged = typeof decision === 'string' && decision.trim() !== ''
    ? decision.trim()
    : '(the judge produced no text — treat the task below as the whole decision)'
  return `You are the implementer of a Fusion run. Three independent models answered the user's task separately; a judge merged their answers into the ONE decision below. That merged decision is the plan you now carry out.

THE MERGED DECISION:
${merged}

You are working on ONE copy of the user's project: ${copyPath}
The user's real project (${projectPath}) is untouched and must stay untouched. Do all work inside the copy; when the user applies the run, only the files you changed are copied back.

${taskBlock(task)}
Work directly in the copy:
- Follow the merged decision. Where it is silent, use your own judgement; where a concrete point of it is wrong, fix it and say so plainly in your summary.
- Read the project before editing. Follow its existing style, structure and conventions.
- Make the smallest coherent change that fully solves the task.
- Run the project's own checks (tests, lint, build) when they exist: a change that does not pass its own checks is not done.
- Do not commit, push or publish. Do not change dependency manifests unless the task requires it.
- Keep the user informed: say briefly what you are doing and why.

${installNotes()}
${finishNoteSolo()}`
}

/* ------------------------------------------------------------ orchestrator */

// The planner ends with a fixed shape; the engine parses it through
// lib/orchestrator.js. The markers stay literal here because this is where the
// model reads them.

/**
 * Render the part contract the worker and the reviewer both read.
 * @param {object} part - part record from the plan.
 * @returns {string} the part goal, conditions and starting files.
 */
function partContract(part) {
  const conditions = Array.isArray(part?.conditions) ? part.conditions.filter((condition) => typeof condition === 'string' && condition.trim() !== '') : []
  const files = Array.isArray(part?.files) ? part.files.filter((file) => typeof file === 'string' && file.trim() !== '') : []
  const done = conditions.length > 0 ? conditions.map((condition) => `- ${condition.trim()}`).join('\n') : '- (the plan lists no conditions — treat the goal as the condition)'
  const starts = files.length > 0 ? files.join(', ') : '(the plan lists no starting files — find them yourself)'
  return `TITLE: ${typeof part?.title === 'string' && part.title.trim() !== '' ? part.title.trim() : 'untitled part'}
GOAL: ${typeof part?.goal === 'string' && part.goal.trim() !== '' ? part.goal.trim() : '(the plan lists no goal — the task is the goal)'}
DONE — the result is accepted only when every line below is true:
${done}
STARTING FILES (a hint, not a cage): ${starts}`
}

/**
 * The planner's only turn: split the user's goal into independent parts.
 *
 * The answer is the plan the whole run is built on: after this turn the host
 * creates one copy of the project per part, one worker per part and one
 * reviewer per part. The prompt therefore demands objective, checkable DONE
 * conditions and forbids any edit.
 * @param {object} request - prompt inputs.
 * @param {string} request.projectPath - the user's real project, read-only here.
 * @param {string} request.task - the user's task.
 * @param {number} [request.maxParts] - how many parts the host asks for at most.
 * @param {boolean} [request.retry] - true when the previous answer was unreadable.
 * @returns {string} the planning prompt.
 */
export function orchestratorPlanPrompt({ projectPath, task, maxParts = 3, retry = false }) {
  const limit = Number.isFinite(maxParts) ? Math.max(2, Math.floor(maxParts)) : 3
  const intro = retry
    ? 'Your previous answer did not contain a readable plan: the host found no PART lines in it. Reply again with the plan in exactly the shape below and nothing else.'
    : 'You are the planner of an Orchestrator run. A big goal must be split into parts that can be done at the same time, each one in its OWN copy of the project, and then assembled back into one result.'
  return `${intro}

The project is at ${projectPath} — the user's real project. It is read-only for you: the sandbox refuses a write. Read it as much as you need: its layout, build files, tests and the areas the goal touches.

${taskBlock(task)}
SPLIT THE GOAL INTO AT MOST ${limit} PARTS — DO NOT EDIT ANY FILE.
- A part must be finishable on its own: its worker gets a copy of the project taken BEFORE the run, cannot see the other parts' copies and must not wait for another part's result. If two pieces depend on each other's output, put them in the same part.
- Parts should not edit the same files. Overlapping files are possible (a merger resolves them at the end), but every overlap costs an extra merge step: keep the file sets apart where the goal honestly allows it.
- Every part gets:
  - a short concrete TITLE;
  - a GOAL of one or two sentences: what exists when this part is done;
  - DONE conditions: 1 to 4 objective statements another model can verify by reading the part's copy and running the project's own checks. Describe the RESULT, not the activity ("POST /api/login answers 201 and its test passes", not "implement the login endpoint"). Separate the conditions with semicolons;
  - FILES: a best guess of the files or directories to start from; it is a hint for the worker, not a boundary.
- Write the titles, goals and conditions in the language of the user's task.
- Two parts is a normal plan; one part is valid when the goal really is one thread. Never invent a part just to fill the count.

${plannerInstallNotes()}
Reply with exactly this shape, one field per line, parts in order, and nothing after the last part:
PLAN: <one sentence: what the user gets when all parts are assembled>
PART 1: <short title>
GOAL: <what exists when this part is done>
DONE: <condition>; <condition>
FILES: <comma separated paths to start from>
PART 2: <short title>
GOAL: <what exists when this part is done>
DONE: <condition>
FILES: <comma separated paths to start from>

The host parses these lines literally and does not ask again when they are missing. Give the plan now, then stop and end your turn.`
}

/**
 * A part worker's turn: implement one part of the plan in its own copy.
 *
 * The worker never sees the other parts: its copy was taken from the project
 * before the run and the other copies are separate. It must therefore finish
 * its own part completely, and its changes are the only source for that part.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - this part's own copy of the project.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {object} request.part - the part record (title, goal, conditions, files).
 * @param {number} [request.partNumber] - one-based part number.
 * @param {number} [request.partCount] - how many parts the plan has.
 * @returns {string} the worker prompt.
 */
export function orchestratorWorkerPrompt({ copyPath, projectPath, task, part, partNumber = 1, partCount = 1 }) {
  const label = `Part ${partNumber} of ${partCount}`
  return `You are the worker of ${label} in an Orchestrator run. The user's goal was split into independent parts; you own exactly this one. Other agents are doing the other parts at the same time in their own separate copies.

YOUR PART:
${partContract(part)}

You are working on YOUR copy of the project: ${copyPath}
The user's real project (${projectPath}) is untouched and must stay untouched. Other parts live in other copies: you cannot see them, they cannot see you, and nobody will send you their work. Do not wait for anyone and do not try to coordinate.

Work directly in the copy:
- Read the project before editing. Follow its existing style, structure and conventions.
- Do the whole part: the goal must really exist when you finish, not be scaffolded for someone else to complete.
- Treat every DONE line as an acceptance test a separate reviewer will check against what is actually on disk. Where a line names a behaviour, make it observable; where it names a command, make it pass.
- Make the smallest coherent change that fully delivers the part.
- Run the project's own checks (tests, lint, build) when they exist: a part that does not pass its own checks is not done.
- Do not commit, push or publish. Do not change dependency manifests unless the part requires it.
- If a condition turns out to be impossible to meet inside this part's copy, do the closest honest thing and say so plainly in your summary — the reviewer will see it.

${installNotes()}
${taskBlock(task)}
When the part is done:
- Re-read every DONE line and verify it against the copy yourself.
- Reply with a short summary: what you built, how each condition is met, what you checked, and anything the user must know about this part. Then stop and end your turn — the reviewer takes over from here.`
}

/**
 * A reviewer's turn: check one part against its plan conditions.
 *
 * The reviewer reads the part's own copy and is read-only: it may not repair the
 * work itself, only send it back with concrete defects.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the part's copy the reviewer reads.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {object} request.part - the part record (title, goal, conditions, files).
 * @param {string} request.digest - `changeDigest()` output for this part's copy.
 * @param {number} [request.round] - zero-based number of completed review rounds.
 * @param {boolean} [request.retry] - true when the previous answer was unreadable.
 * @returns {string} the review prompt.
 */
export function orchestratorReviewPrompt({ copyPath, projectPath, task, part, digest, round = 0, retry = false }) {
  const digestText = typeof digest === 'string' && digest.trim() !== '' ? digest.trim() : 'No files changed in this copy.'
  const attempt = Number.isFinite(round) ? Math.floor(round) : 0
  const intro = retry
    ? 'Your previous answer did not contain a readable verdict: the host found no VERDICT line. Reply again with the verdict block below and nothing else.'
    : 'You are the reviewer of one part of an Orchestrator run. Another agent did this part in its own copy of the project. Your job is to decide whether the plan conditions are actually met — you do not repair the work, you check it.'
  const retryLine = attempt > 0
    ? `This part was already sent back once; it is now back for review (review round ${attempt + 1}). Judge the copy as it is now.`
    : ''
  return `${intro}

THE PART AND ITS CONTRACT:
${partContract(part)}

THE COPY TO REVIEW: ${copyPath}
The user's real project (${projectPath}) is untouched. This copy is read-only for you: the sandbox refuses a write. Do not edit any file.

CHANGES IN THIS COPY SINCE IT WAS TAKEN FROM THE USER'S PROJECT:
${digestText}
${retryLine}
REVIEW NOW — DO NOT EDIT ANY FILE.
- Read the changed files and the project around them as much as you need.
- Check every DONE line against what is actually on disk, not against the worker's summary. A condition is met only if the file, the behaviour or the command is really there.
- Run the project's own checks (tests, lint, build) in ${copyPath} when they exist. A green check is necessary, not sufficient: the part's goal must be delivered.
- Accept only when every DONE line is true and the part genuinely delivers its goal.
- Send the part back with concrete defects: name the file, say what is wrong and what must be true instead. One line per real defect. No style nitpicks and no new scope; request only what the plan and the goal already demand.
- If a defect is minor but the goal is met, accept and put the observation in the notes.

End your answer with exactly one verdict block and nothing after it.

Accept:
VERDICT: accept — <short notes for the user>

Send back:
VERDICT: rework — <one sentence: what is still wrong>
PROBLEMS:
- <file>: <what is wrong and what must be true instead>
- <file>: <what is wrong and what must be true instead>

${taskBlock(task)}
Give the verdict now, then stop and end your turn.`
}

/**
 * A rework turn: the worker fixes the reviewer's concrete defects.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - this part's own copy of the project.
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {object} request.part - the part record (title, goal, conditions, files).
 * @param {string[]} request.problems - the reviewer's defects, verbatim.
 * @param {number} [request.round] - the rework round that starts now (one-based).
 * @param {number} [request.maxRounds] - rework rounds available in total.
 * @param {number} [request.partNumber] - one-based part number.
 * @param {number} [request.partCount] - how many parts the plan has.
 * @returns {string} the rework prompt.
 */
export function orchestratorReworkPrompt({ copyPath, projectPath, task, part, problems, round = 1, maxRounds = 2, partNumber = 1, partCount = 1 }) {
  const list = Array.isArray(problems) ? problems.filter((problem) => typeof problem === 'string' && problem.trim() !== '') : []
  const defects = list.length > 0
    ? list.map((problem) => `- ${problem.trim()}`).join('\n')
    : '- (the reviewer left no details — re-read the contract and fix whatever is still open in this copy)'
  const attempt = Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1
  const total = Number.isFinite(maxRounds) ? Math.max(1, Math.floor(maxRounds)) : 2
  return `Your part was reviewed and sent back. This is rework round ${attempt} of ${total}.
You are the worker of Part ${partNumber} of ${partCount} in an Orchestrator run, back in YOUR copy: ${copyPath}
The user's real project (${projectPath}) is untouched and must stay untouched.

THE REVIEWER'S DEFECTS (verbatim):
${defects}

YOUR PART:
${partContract(part)}

Fix it in the copy:
- Address every defect above. If a defect points at something already correct, explain that in your summary instead of rewriting it.
- Keep the work that already meets the conditions; do not redo the part for taste and do not widen its scope.
- Re-read every DONE line again after the fix; the same reviewer checks the same lines.
- Run the project's own checks (tests, lint, build) when they exist.
- Do not commit, push or publish.

${taskBlock(task)}
When the fix is done, reply with a short summary: what you changed, how each defect is resolved, what you checked. Then stop and end your turn — the reviewer takes over from here.`
}

/**
 * The merger's turn: resolve the files more than one part edited.
 *
 * Every variant is on disk in a conflict bundle next to the base version; the
 * merger writes the final content at the real path inside the assembly copy and
 * the host verifies afterwards that every conflicting path was actually touched.
 * @param {object} request - prompt inputs.
 * @param {string} request.copyPath - the assembly copy (all accepted parts combined).
 * @param {string} request.projectPath - the user's real project, never touched.
 * @param {string} request.task - the user's task.
 * @param {Array<{ path: string, dir: string, parts: string[] }>} request.conflicts - bundles to resolve.
 * @param {string} request.conflictsDir - directory holding the conflict bundles.
 * @param {string[]} [request.unresolved] - paths the host still sees untouched after a failed attempt.
 * @param {boolean} [request.retry] - true when this is the second and final attempt.
 * @returns {string} the merger prompt.
 */
export function orchestratorMergePrompt({ copyPath, projectPath, task, conflicts = [], conflictsDir, unresolved = [], retry = false }) {
  const list = Array.isArray(conflicts) ? conflicts : []
  const rendered = list.length === 0
    ? '(the host listed no conflicts)'
    : list
      .map((conflict) => `- ${conflict.path}\n  bundle: ${conflict.dir}\n  edited by: ${Array.isArray(conflict.parts) && conflict.parts.length > 0 ? conflict.parts.join(', ') : 'several parts'}`)
      .join('\n')
  const left = Array.isArray(unresolved) ? unresolved.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  const intro = retry
    ? `The host checked the assembly after your attempt and found paths you did not resolve: ${left.length > 0 ? left.join(', ') : '(none listed)'}. This is the FINAL attempt. Write the final content at the real place inside the assembly copy for each of these paths.`
    : 'You are the merger of an Orchestrator run. Every part was accepted on its own. The accepted changes of all parts were combined into ONE assembly copy, but some files were edited by more than one part, so the host could not choose between the versions.'
  return `${intro}

THE ASSEMBLY COPY: ${copyPath}
The user's real project (${projectPath}) is untouched and must stay untouched. You work inside the assembly copy.

THE CONFLICT BUNDLES (everything is under ${conflictsDir}):
- Each bundle has path.txt — the file path inside the project.
- base — the file as it was in the user's project (absent when the file is new).
- one copy of the file per part that changed it, named after the part (part-p1, part-p2, …). A file named part-pX.deleted means that part deleted the file.

FILES THAT NEED A DECISION:
${rendered}

YOUR JOB:
- For every listed path, decide the final content and write it at its REAL place inside ${copyPath} — not inside the bundle.
- Merge the parts' work: keep what each part needs, drop what contradicts another part, and leave one coherent file. Keeping one variant wholesale is right only when the other variants genuinely add nothing; say so when you do it.
- When the parts together mean the file must be deleted, delete it from the assembly copy.
- Do not touch any file that is not in the list above.
- After the last path, run the project's own checks (tests, lint, build) on the assembly copy when they exist.

${taskBlock(task)}
Reply with a short summary: per path, what you kept and why, what you dropped, and what passed. Then stop and end your turn — the host verifies each path and hands the assembled work to the user.`
}

/* ------------------------------------------------- unattended runs / factory */

// Markers shared with lib/factory.js; they stay literal in the prompt bodies
// because the model is the one that writes them.
export const TRIAGE_SPEC_MARKER = 'SPEC:'
export const TRIAGE_CRITERIA_MARKER = 'CRITERIA:'
export const TRIAGE_ROUTE_MARKER = 'ROUTE:'
export const TRIAGE_QUESTION_MARKER = 'QUESTION:'
export const TRIAGE_ASSUMPTION_MARKER = 'ASSUMPTION:'
export const FACTORY_VERDICT_MARKER = 'VERDICT:'
export const FACTORY_BLOCKER_MARKER = 'BLOCKER:'
export const FACTORY_IMPORTANT_MARKER = 'IMPORTANT:'
export const FACTORY_MINOR_MARKER = 'MINOR:'
export const FACTORY_CRITERIA_MARKER = 'CRITERIA:'
export const APP_CHECK_VERDICT_MARKER = 'CHECK:'

const ROUTE_VALUES = 'solo, swarm, fusion, orchestrator'

/**
 * The rules of an unattended turn: nothing leaves the machine, nobody answers
 * questions, and every decision the agent makes on its own is written down.
 *
 * The engine appends this block to every prompt of a run started with
 * `autoqueue: true` (and the Factory sets that flag for its pipeline runs), so a
 * task that runs while the user is away cannot ask, publish or deploy.
 * @returns {string} the rule block.
 */
export function nightShiftRules() {
  return `UNATTENDED RUN — the user is away and nobody will answer:
- Do not ask the user anything, and do not wait for an answer. If something is unclear, make the smallest reasonable assumption, write it down as "Assumption: <one line>" in your final summary, and continue.
- If a decision truly cannot be made without the user (a product choice, a credential, a destructive migration), stop and end your turn with one short message starting with "BLOCKED: " and the reason. The queue parks this task for the user instead of guessing.
- Never send anything outward: no git push, no pull/merge request, no publish, no deploy, no comment on a tracker, no message outside this machine. The user presses the outward buttons later.
- Do not raise a preview or start a long-running dev server for the user.
- Stay inside the copy. The user's real project must stay untouched.
- Run the project's own checks when they exist, and keep the change small enough to be checked automatically.
- Finish with a short summary: what changed, how it was checked, and the assumptions you made.`
}

/**
 * The answer sent to an unattended agent that asked a question anyway. It is the
 * one automatic reply a night-shift task gets; a second question parks the task.
 * @returns {string} the automatic reply.
 */
export function autoAnswerPrompt() {
  return 'The user is away and cannot answer. Decide yourself: pick the smallest reasonable option, write it down as an assumption, and continue the task without asking again. Finish with a short summary that lists the assumptions.'
}

/**
 * The repair turn after the project's own check command failed.
 * @param {object} request - prompt inputs.
 * @param {string} request.command - the check command that failed.
 * @param {string} request.output - bounded tail of the failure output.
 * @param {number} [request.attempt] - which fix attempt this is (1-based).
 * @param {number} [request.attempts] - how many attempts are allowed.
 * @returns {string} the fix prompt.
 */
export function checkRepairPrompt({ command, output, attempt = 1, attempts = 2 }) {
  return `The project's own check failed after your turn. This is fix attempt ${attempt} of ${attempts}.

COMMAND: ${command}
OUTPUT (tail):
${output.trim() === '' ? '(the command printed nothing)' : output.trim()}

Fix the failure in the copy and run the check again yourself. Do not ask the user: pick the smallest correct fix and record the assumption if the failure is about an unclear requirement. Do not weaken or delete tests just to make the command pass. When the check passes, finish with a short summary of what you fixed.`
}

/**
 * The triage turn of a Factory ticket: one read-only answer that turns raw
 * ticket text into a spec, acceptance criteria, a route and — only when truly
 * needed — questions for the user.
 * @param {object} request - prompt inputs.
 * @param {object} request.ticket - stored ticket ({ number, title, text, source, attachments }).
 * @param {string} request.projectPath - the user's real project (read-only for this turn).
 * @param {string[]} [request.routes] - routes the factory may use.
 * @returns {string} the triage prompt.
 */
export function triagePrompt({ ticket, projectPath, routes = ['solo', 'swarm', 'fusion', 'orchestrator'] }) {
  const attachments = Array.isArray(ticket.attachments) && ticket.attachments.length > 0
    ? `\nAttached files (read them; they are part of the ticket):\n${ticket.attachments.map((file) => `- ${file.path}${file.name ? ` (${file.name})` : ''}`).join('\n')}\n`
    : ''
  const source = ticket.source && ticket.source.url ? `\nSource: ${ticket.source.url}\n` : ''
  return `You are triaging ONE ticket for a Factory board. You are READ-ONLY in this turn: read the project, change nothing.

THE TICKET #${ticket.number}: ${ticket.title}
${ticket.text.trim()}
${source}${attachments}
THE PROJECT: ${projectPath}

Write the answer in exactly these sections, in this order:
${TRIAGE_SPEC_MARKER} one short paragraph: what the ticket asks for, in terms of this project.
${TRIAGE_CRITERIA_MARKER} the acceptance criteria, one per line, each line starting with "- ". They must be checkable from the diff ("Exports report.csv with a header row", not "works well"). 2–6 criteria.
${TRIAGE_ROUTE_MARKER} one of: ${routes.join(', ')}. Pick the cheapest route that is enough: solo for a small clear change, swarm for a change that touches several areas, fusion when the approach is genuinely unclear, orchestrator only for a large goal that splits into independent parts.
${TRIAGE_ASSUMPTION_MARKER} (optional) one per line, each "- ": what you filled in yourself because the ticket leaves it open.
${TRIAGE_QUESTION_MARKER} (optional) one per line, each "- ": ONLY questions the user must answer (a product decision or a missing external fact). Do not ask about implementation details you can decide yourself. If there are none, do not write this section at all.

End your turn after the sections. Do not edit anything.`
}

/**
 * The working turn of a Factory ticket: the ticket's spec and criteria are the
 * contract, the copy is the workspace.
 * @param {object} request - prompt inputs.
 * @param {object} request.ticket - stored ticket with a parsed spec.
 * @param {string} request.copyPath - the ticket's copy.
 * @param {string} request.projectPath - the user's real project.
 * @returns {string} the work prompt.
 */
export function factoryWorkPrompt({ ticket, copyPath = '', projectPath }) {
  const spec = ticket.spec ?? {}
  const criteria = Array.isArray(spec.criteria)
    ? spec.criteria.map((item) => (typeof item === 'string' ? item : item?.text)).filter((item) => typeof item === 'string' && item !== '')
    : []
  return `You are implementing ticket #${ticket.number} of the project's Factory board: ${ticket.title}

You work in ONE copy of the user's project${copyPath === '' ? ' (your working directory is that copy)' : `: ${copyPath}`}
The user's real project (${projectPath}) is untouched and must stay untouched.

THE TICKET:
${ticket.text.trim()}

THE SPEC FROM TRIAGE:
${typeof spec.summary === 'string' && spec.summary.trim() !== '' ? spec.summary.trim() : '(no separate summary — use the ticket text)'}

ACCEPTANCE CRITERIA (the review checks exactly these):
${criteria.length > 0 ? criteria.map((item) => `- ${item}`).join('\n') : '- (triage wrote none — satisfy the ticket text)'}

Rules:
- Read the project before editing and follow its conventions.
- Make the smallest coherent change that satisfies every criterion. Do not widen the scope.
- Add or adjust tests when the change needs them. The pipeline runs the project's own check command afterwards.
- Do not commit, push, publish, deploy or open anything outward; the user does that from the ticket card.
- Finish with a short summary: what changed, how it was checked, and the assumptions you made.`
}

/**
 * The Factory review turn: a read-only reviewer reads exactly the ticket diff
 * and the acceptance criteria, then returns a machine-readable verdict.
 * @param {object} request - prompt inputs.
 * @param {object} request.ticket - stored ticket with spec.
 * @param {string} request.copyPath - a read-only copy that contains the ticket diff.
 * @param {string} request.projectPath - the user's real project (diff base).
 * @param {string} request.digest - rendered change digest of the ticket.
 * @returns {string} the review prompt.
 */
export function factoryReviewPrompt({ ticket, copyPath = '', projectPath, digest }) {
  const spec = ticket.spec ?? {}
  const criteria = Array.isArray(spec.criteria)
    ? spec.criteria.map((item) => (typeof item === 'string' ? item : item?.text)).filter((item) => typeof item === 'string' && item !== '')
    : []
  return `You are reviewing ONE ticket diff in a Factory pipeline. You are READ-ONLY: read, run checks if useful, change nothing.

THE TICKET #${ticket.number}: ${ticket.title}
${ticket.text.trim()}

THE SPEC:
${typeof spec.summary === 'string' && spec.summary.trim() !== '' ? spec.summary.trim() : '(none)'}

ACCEPTANCE CRITERIA:
${criteria.length > 0 ? criteria.map((item) => `- ${item}`).join('\n') : '- (none)'}

THE REVIEW COPY (contains the full ticket diff)${copyPath === '' ? ' is your working directory' : `: ${copyPath}`}
The user's real project (${projectPath}) is the diff base; do not edit either.

CHANGED FILES:
${digest.trim() === '' ? '(the host found no changed files)' : digest.trim()}

Judge the diff itself, not your taste:
- A BLOCKER is a defect that must be fixed before a PR: a broken criterion, a bug, data loss, a security or secret leak, a broken public contract, tests that do not test what they claim.
- An IMPORTANT finding is worth fixing now: a real risk, a missed edge case, a missing test for new behavior.
- MINOR items are polish; they go into the PR body and are NOT a reason to rework.

Answer in exactly this format:
${FACTORY_VERDICT_MARKER} accept | rework
${FACTORY_BLOCKER_MARKER} one per line (optional), each "- path: problem"
${FACTORY_IMPORTANT_MARKER} one per line (optional), each "- path: problem"
${FACTORY_MINOR_MARKER} one per line (optional), each "- path: note"
${FACTORY_CRITERIA_MARKER} one per line for EVERY criterion: "- <criterion> — met | unmet"

Verdict "rework" only if there is at least one blocker or important finding, or a criterion is unmet. End your turn after the sections.`
}

/**
 * The self-repair turn of the Factory: fix the review findings in the ticket copy.
 * @param {object} request - prompt inputs.
 * @param {object} request.ticket - stored ticket.
 * @param {string[]} request.findings - findings to fix, already rendered as lines.
 * @param {number} [request.round] - repair round (1-based).
 * @param {number} [request.rounds] - how many rounds the template allows.
 * @returns {string} the repair prompt.
 */
export function factoryRepairPrompt({ ticket, findings, round = 1, rounds = 2 }) {
  return `The review of ticket #${ticket.number} (${ticket.title}) found problems. This is repair round ${round} of ${rounds}.

WHAT MUST BE FIXED:
${findings.length > 0 ? findings.map((line) => `- ${line}`).join('\n') : '- (the reviewer wrote no readable findings; re-read the criteria and the diff)'}

Fix these in the ticket copy you already have. Do not redo the ticket for taste, do not widen the scope, and keep the criteria that already pass passing. Run the project's own checks when they exist. Do not ask the user: decide, write the assumption down, and continue. Finish with a short summary of what you fixed.`
}

/**
 * The app-check turn: exercise the running app against the ticket criteria.
 * Used only when the board has a preview command and Playwright is available;
 * otherwise the host records an explicit skip with the reason.
 * @param {object} request - prompt inputs.
 * @param {object} request.ticket - stored ticket.
 * @param {string} request.copyPath - the ticket copy.
 * @param {string} [request.previewCommand] - command that starts the app preview.
 * @returns {string} the app-check prompt.
 */
export function factoryAppCheckPrompt({ ticket, copyPath, previewCommand = '' }) {
  return `You are the app checker of a Factory pipeline for ticket #${ticket.number}: ${ticket.title}

The ticket copy: ${copyPath}
${previewCommand ? `The board's preview command: ${previewCommand}\n` : ''}

Your job:
- Check the acceptance criteria that are about the running app, using the preview and browser tools available to you. If a preview command is given, use it and stop the preview when you are done.
- If the app cannot be exercised here, say so plainly with the reason — a skip is a valid result, a guess is not.
- Do not edit files. Do not send anything outward.

Answer in exactly this format:
${APP_CHECK_VERDICT_MARKER} pass | fail | skip — one short reason after the verdict, e.g. "skip — no preview configured".
FINDING: one per line for real defects (optional), each "- what is wrong and where".
Finish with one short paragraph on what you exercised.`
}
