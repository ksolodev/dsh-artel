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

export const OWNERSHIP_MARKER = 'OWNERSHIP:'

function taskBlock(task) {
  return `Task from the user (verbatim, in their own language):\n\n${task.trim()}\n`
}

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

${finishNoteSolo()}`
}
