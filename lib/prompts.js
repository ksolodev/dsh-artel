/**
 * Prompt templates for Artel runs.
 *
 * Kept in one place so the product's agent contract is reviewable: the copy
 * rule ("the real project is untouched"), the swarm planning turn ("no edits"),
 * the OWNERSHIP line that the host parses, the go-ahead that pins down the file
 * map, and — for the shared-conversation swarm — how the agents may talk to each
 * other while they work.
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
