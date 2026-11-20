/**
 * dsh-artel — Client half.
 *
 * The Artel surface lives over the chat: a launcher button in the composer tool
 * row opens a fixed overlay that covers the conversation area. The overlay has
 * its own session rail and a hero for starting a run, then shows the live feed
 * of the selected run as full agent messages. Everything talks to the Host half
 * over `/api/dsh-artel` on the same origin; the page never touches files.
 *
 * The module is loaded by the DSH client module loader, so it is a classic
 * script (no ESM syntax) that hands a factory to `window.__ModuleLoader__`.
 */

/**
 * The published package name. The module loader keys its boot graph by package
 * name, so this string MUST equal `name` in package.json: when the package is
 * published under a scope, change both together.
 *
 * Everything below sits inside an IIFE because the desktop client re-executes
 * a bundle when the Host rebuilds it: top-level `const` would then collide with
 * itself in the same realm and abort the reload.
 */
;(function () {
  'use strict'

  const PACKAGE_ID = 'dsh-artel'

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    /* Host primitives are optional: the overlay degrades to plain text and
     * hand-drawn markers when the loader does not expose them. */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    let reactDom = null
    try {
      reactDom = require('react-dom')
    } catch {
      reactDom = null
    }

    /** Locale namespace; also the plugin package name. */
    const NS = PACKAGE_ID
    /**
     * Chat composer-row launcher entry. It is the single mount point: the
     * button and the portal-mounted surface both come from this component,
     * because input.left renders in both the hero and the regular composer
     * phase while conversation.composer.dock does not exist on blank sessions.
     */
    const LAUNCHER_SLOT = 'conversation.input.left'
    const LAUNCHER_ID = 'artel-launcher'
    const LAUNCHER_ORDER = 40
    /** Host HTTP prefix. */
    const API_PREFIX = '/api/dsh-artel'
    /** Poll cadence: fast while a run is busy, slower for the run list. */
    const POLL_ACTIVE_MS = 900
    const POLL_RUNS_MS = 2500
    /** Statuses where agents are still busy. */
    const ACTIVE_STATUSES = new Set(['preparing', 'planning', 'running'])
    /** Statuses where the user may review and apply. */
    const REVIEW_STATUSES = new Set(['waiting', 'finished', 'interrupted', 'failed'])
    /** Statuses where a user message can still reach the agents. */
    const MESSAGE_STATUSES = new Set(['running', 'waiting', 'finished', 'failed', 'interrupted'])
    /** Agent statuses that mean "this agent finished its current turn". */
    const AGENT_DONE_STATUSES = new Set(['idle', 'failed'])
    const MODES = ['solo', 'swarm', 'conductor', 'fusion', 'orchestrator']
    /** A Fusion run always has three panel models plus a judge and an implementer. */
    const FUSION_PANEL_SIZE = 3
    const FUSION_SLOT_COUNT = FUSION_PANEL_SIZE + 2
    /**
     * Orchestrator part states and the pill tone each one paints with:
     * pending/working are quiet, the reviewer's turn is accented, a rework
     * round warns and the final states are success/error.
     */
    const PART_STATUS_TONES = {
      pending: 'muted',
      working: 'active',
      reviewing: 'active',
      rework: 'warn',
      accepted: 'ok',
      failed: 'error',
    }
    const STORAGE_LAST_RUN = 'dsh-artel:last-run:'
    const OVERLAY_Z_INDEX = 50

    /* ------------------------------------------------------------ strings */

    const en = {
      'surface.title': 'Artel',
      'surface.back': 'Chat',
      'surface.backTitle': 'Back to chat',
      'surface.close': 'Close Artel',

      'launcher.title': 'Artel',
      'launcher.open': 'Open Artel',
      'launcher.busy': 'Artel is working',

      'rail.title': 'Sessions',
      'rail.new': 'New session',
      'rail.empty': 'No sessions yet.',
      'rail.groupFallback': 'No project',
      'rail.footerRuns': '{n} sessions',
      'rail.footerFiles': '{n} files',
      'rail.refresh': 'Refresh',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': 'New task',
      'hero.placeholder': 'Describe the task for the agents…',
      'hero.hint': 'The task runs in an isolated copy of the "{project}" project. Your files stay untouched until you apply the changes.',
      'hero.hintNoProject': 'The task runs in an isolated copy of the project. Your files stay untouched until you apply the changes.',
      'hero.start': 'Go →',
      'hero.starting': 'Starting…',
      'hero.taskLabel': 'Task',
      'hero.mode': 'Mode',
      'hero.model': 'Model',
      'hero.effort': 'Reasoning',
      'hero.effortAuto': 'Adapter default',
      'model.title': 'Agent models',
      'model.agent': 'Agent',
      'model.effort': 'Reasoning',
      'model.default': 'Adapter default',
      'model.unavailable': 'The model catalog is unavailable in this profile',
      'model.saving': 'Saving…',
      'model.hint': 'Each agent switches from its next step; a running step keeps its model.',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': 'One agent, one copy',
      'mode.swarm.hint': 'Three agents divide the files',
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Three agents divide the files; the conductor accepts the work',
      'mode.fusion': 'Fusion',
      'mode.fusion.hint': 'Three models answer independently, a judge merges them, one model does the work',
      'mode.orchestrator': 'Orchestrator',
      'mode.orchestrator.hint': 'The goal is split into parts, each built in its own copy and checked before the parts are assembled.',
      'hero.fusion.title': 'Fusion routes',
      'hero.fusion.panel': 'Panel {n}',
      'hero.fusion.judge': 'Judge',
      'hero.fusion.implementer': 'Implementer',
      'role.conductor': 'conductor',
      'role.worker': 'agent',
      'role.panelist': 'panelist',
      'role.judge': 'judge',
      'role.implementer': 'implementer',
      'role.planner': 'Planner',
      'role.part': 'Part agent',
      'role.reviewer': 'Reviewer',
      'role.merger': 'Merger',

      'partStatus.pending': 'Pending',
      'partStatus.working': 'Working',
      'partStatus.reviewing': 'In review',
      'partStatus.rework': 'Back to work',
      'partStatus.accepted': 'Accepted',
      'partStatus.failed': 'Failed',

      'parts.title': 'Parts',
      'parts.item': 'Part {n} — {title}',
      'parts.summaryLabel': 'Plan',
      'parts.conditionsLabel': 'Done when',
      'parts.filesLabel': 'Files',
      'parts.rounds': 'Rework round {n} of 2',
      'parts.mergeResolved': 'Merger resolved {n} conflict(s)',
      'parts.mergeUnresolved': 'The merge is not finished — apply is unavailable.',
      'parts.accepted': '{done}/{total} accepted',

      'run.new': 'New session',
      'run.taskLabel': 'Task',
      'run.project': 'Project',
      'run.changes': '{n} changed files',
      'run.changesOne': '1 changed file',
      'run.stop': 'Stop',
      'run.stopping': 'Stopping…',
      'run.stopQuestion': 'Stop this Artel run?',
      'run.stopYes': 'Stop run',
      'run.stopNo': 'Keep working',
      'run.feedEmpty': 'The agents are getting ready — their messages will appear here.',
      'run.feedLoading': 'Loading the feed…',
      'run.openSession': 'Open the agent conversation',

      'changes.title': 'Changes · {n} files',
      'changes.titleFew': 'Changes · {n} files',
      'changes.titleOne': 'Changes · 1 file',
      'changes.titleZero': 'Changes',
      'changes.refresh': 'Refresh changes',
      'changes.show': 'Show changes',
      'changes.hide': 'Hide changes',
      'changes.loading': 'Loading the changes…',
      'changes.empty': 'No file changes in this run.',
      'changes.loadError': 'Could not load the changes',
      'changes.apply': 'Apply',
      'changes.applying': 'Applying…',
      'changes.discard': 'Discard',
      'changes.discarding': 'Discarding…',
      'changes.applyQuestion': 'Apply these changes?',
      'changes.applyHint': 'The changes will be written to {project}. The isolated copy will be deleted.',
      'changes.applyYes': 'Apply',
      'changes.applyNo': 'Cancel',
      'changes.discardQuestion': 'Discard these changes?',
      'changes.discardHint': 'The isolated copy will be deleted; {project} will stay untouched.',
      'changes.discardYes': 'Discard',
      'changes.discardNo': 'Cancel',
      'changes.applied': 'Applied',
      'changes.discarded': 'Discarded',
      'changes.appliedHint': 'The changes are written to {project}.',
      'changes.appliedHintNoProject': 'The changes are written to your project.',
      'changes.discardedHint': 'The copy was deleted; the project is unchanged.',
      'changes.skipped': 'Skipped: {n}',
      'changes.binary': 'binary',
      'changes.file.added': 'added',
      'changes.file.deleted': 'deleted',
      'changes.file.modified': 'modified',
      'changes.file.binary': 'binary',
      'changes.expandFile': 'Show the diff',
      'changes.collapseFile': 'Hide the diff',

      'feed.you': 'You',
      'feed.to': '→ {name}',
      'feed.toAll': '→ Everyone',
      'feed.plan': 'Plan',
      'feed.collision': 'Edit collision',
      'feed.error': 'Error',
      'feed.tools': '{n} tool calls',
      'feed.toolOne': '1 tool call',
      'feed.toolOpen': 'Show the arguments and the output',
      'feed.toolClose': 'Hide the arguments and the output',
      'feed.collapseAll': 'Collapse all',
      'feed.toolArgs': 'Arguments',
      'feed.toolResult': 'Output',
      'feed.toolError': 'Error',
      'feed.toolOk': 'done',
      'feed.toolFailed': 'failed',
      'feed.toolPending': 'Still running…',
      'feed.toolEmpty': 'No output',
      'feed.empty': 'Nothing yet.',
      'feed.copy': 'Copy',
      'feed.copied': 'Copied',
      'feed.code': 'Code',
      'feed.wrap': 'Wrap lines',
      'feed.unwrap': 'No wrap',
      'feed.footnotes': 'Footnotes',

      // Live view: what each agent is doing right now, and what the run waits for.
      'live.title': 'Right now',
      'live.tool': 'using {tool}',
      'live.thinking': 'writing a reply',
      'live.turn': 'Time on the current turn',
      'live.context': '{used} of {window} tokens · {pct}% of the window',
      'live.composition': 'system {system} · tools {tools} · messages {messages}',
      'live.spend': '{n} tokens',
      'live.spendTitle': 'input {input} · output {output} · cache {cache}',
      'live.waitUser': 'Waiting for your answer',
      'live.waitApproval': 'Waiting for plan approval',
      'live.waitAgents': 'The agents are working',
      'live.waitAgent': 'Waiting for {name}',
      'live.waitAgentTwo': 'Waiting for {a} and {b}',
      'live.waitAgentsNames': 'Waiting for {names}',
      'live.waitHost': 'Assembling the result',

      'composer.placeholder': 'Write to the agents…',
      'composer.send': 'Send',
      'composer.to': 'To',
      'composer.all': 'Everyone',
      'composer.hint': 'Ctrl+Enter — send',

      'agent.starting': 'starting',
      'agent.planning': 'planning',
      'agent.working': 'working',
      'agent.idle': 'idle',
      'agent.failed': 'failed',

      'status.preparing': 'Preparing',
      'status.planning': 'Planning',
      'status.running': 'Working',
      'status.waiting': 'Waiting for you',
      'status.finished': 'Finished',
      'status.interrupted': 'Stopped',
      'status.failed': 'Failed',
      'status.applied': 'Applied',
      'status.discarded': 'Discarded',
      'status.starting': 'Starting',

      'error.title': 'Something went wrong',
      'error.retry': 'Retry',
      'error.dismiss': 'Dismiss',
      'error.apiMissing': 'The Artel host half is unavailable. Check that the plugin is enabled.',
      'error.start': 'Could not start Artel',
      'error.load': 'Could not load Artel runs',
      'error.send': 'Could not send the message',
      'error.stop': 'Could not stop the run',
      'error.timeout': 'The host took too long to answer',
      'error.notFound': 'This Artel run no longer exists',
      'error.restarting': 'The Artel host is restarting — retry in a moment',

      'queue.title': 'Waiting',
      'queue.autopilot': 'Auto-queue',
      'queue.heroHint': 'Stack tasks and flip «Auto-queue»: they run unattended, each saved as its own version. Nothing leaves this copy without your button.',
      'queue.runHint': 'The «Waiting» column: tasks stacked for this chat session, plus tasks of the current plan without a free worker yet.',
      'queue.add': 'Add',
      'queue.addPlaceholder': 'What to do next…',
      'queue.empty': 'Nothing is waiting. Add a task to the queue.',
      'queue.parked': 'Parked',
      'queue.results': 'Auto-queue results',
      'queue.resultsVersions': 'Versions: {n}',
      'queue.resultsParked': 'Parked: {n}',
      'queue.resultsNotTaken': 'Not taken: {n}',
      'queue.rework': 'Rework it',
      'queue.rollback': 'Roll back',
      'queue.stop': 'Stop',
      'queue.finishAfter': 'Finish after the current task',
      'queue.resume': 'Resume',
      'queue.saveVersion': 'Save as a version',
      'queue.postponeVersion': 'Park it',
      'queue.retry': 'Return',
      'queue.remove': 'Remove',
      'queue.moveUp': 'Up',
      'queue.moveDown': 'Down',
      'queue.clear': 'Clear finished',
      'queue.limit': 'No more than N tasks per run',
      'queue.checkCommand': 'Check command',
      'queue.checkDisabled': 'Without a check',
      'queue.checkGuessed': 'Guessed from the project',
      'queue.preflight': 'Before starting',
      'queue.preflightPending': 'Unsaved versions',
      'queue.saveThem': 'Save them as versions',
      'queue.postponeThem': 'Park them',
      'queue.continue': 'Continue',
      'queue.preflightNone': 'No check command: versions will be saved on the agent’s word and marked as such.',
      'queue.reason': 'Reason',
      'queue.questions': 'Questions: {n}',
      'queue.fixes': 'Fixes: {n}',
      'queue.version': 'Version',
      'queue.versions': 'Versions',
      'queue.notTaken': 'Not taken',
      'queue.stoppedBecause': 'Auto-queue stopped: {reason}',
      'queue.open': 'Show the queue',
      'queue.close': 'Hide the queue',
      'queue.heroToggle': 'Auto-queue',
      'queue.heroToggleHint': 'Run tasks back-to-back unattended',
      'queue.busy': 'Working…',
      'queue.hint': 'A chat message does not interrupt the queue: it becomes the first task.',
      'queue.status.queued': 'Queued',
      'queue.status.running': 'Running',
      'queue.status.passed': 'Version saved',
      'queue.status.parked': 'Parked',
      'queue.status.skipped': 'Skipped',
      'queue.status.stopped': 'Stopped',
      'queue.diskLow': 'Not enough disk space for another copy.',
      'queue.disabled': 'The queue is off: flip «Auto-queue» to run it unattended.',
      'queue.waitingForReset': 'Waiting for the subscription reset: {when}',
      'queue.progressSimple': '{done} of {total} done',
      'queue.showAll': 'Show all tasks ({n})',

      'factory.title': 'Factory',
      'factory.subtitle': 'Ticket pipeline',
      'factory.open': 'Open the Factory',
      'factory.close': 'Back to sessions',
      'factory.create': 'Create a board',
      'factory.createHint': 'A board keeps its own tickets for one project. The factory only takes tickets while it is enabled.',
      'factory.board': 'Board',
      'factory.settings': 'Settings',
      'factory.save': 'Save',
      'factory.saved': 'Saved',
      'factory.enabled': 'Factory is on',
      'factory.enable': 'Enable',
      'factory.pause': 'Pause',
      'factory.resume': 'Resume',
      'factory.paused': 'Paused: new tickets are not taken, started ones finish.',
      'factory.disabledHint': 'The factory is off: new tickets wait in «Incoming».',
      'factory.readiness': 'Check readiness',
      'factory.ready': 'Ready',
      'factory.notReady': 'Not ready: blocking problems',
      'factory.problems': 'Problems',
      'factory.template': 'Pipeline template',
      'factory.template.normal': 'Normal',
      'factory.template.fast': 'Fast',
      'factory.template.strict': 'Strict',
      'factory.template.normal.hint': 'Tests, app check and review, up to two repair rounds.',
      'factory.template.fast.hint': 'No app check, one repair round — for small tickets.',
      'factory.template.strict.hint': 'Two reviewers on different engines, up to three repair rounds.',
      'factory.routes': 'Allowed routes',
      'factory.models': 'Models per role',
      'factory.model.triage': 'Triage',
      'factory.model.work': 'Work',
      'factory.model.tests': 'Tests',
      'factory.model.review': 'Review',
      'factory.auto': 'Auto',
      'factory.limits': 'Spend ceiling',
      'factory.ticketsAtOnce': 'Tickets at once',
      'factory.ticketsPerDay': 'Tickets per day',
      'factory.workers': 'Workers per ticket',
      'factory.allowApi': 'Allow the «API» engine',
      'factory.allowLow': 'Allow nearly-exhausted subscriptions',
      'factory.commands': 'Commands',
      'factory.testCommand': 'Test command',
      'factory.checkCommand': 'Check command',
      'factory.previewCommand': 'Preview command',
      'factory.appendTests': 'Append tests when the change touches none',
      'factory.trackers': 'Ticket intake',
      'factory.trackerKind': 'Kind',
      'factory.trackerLabel': 'Label',
      'factory.trackerProject': 'Project / URL',
      'factory.trackerComment': 'Comment the result back into the task',
      'factory.trackerAdd': 'Add a tracker',
      'factory.trackerRemove': 'Remove',
      'factory.trackerNone': 'No trackers: tickets come from the «Incoming» field and GitHub issues.',
      'factory.incoming': 'Incoming',
      'factory.ticketTitle': 'Title',
      'factory.ticketText': 'Description',
      'factory.ticketPlaceholder': 'What should be done…',
      'factory.addTicket': 'Add the ticket',
      'factory.attachments': 'Files and screenshots',
      'factory.attach': 'Attach',
      'factory.importIssue': 'From a GitHub issue',
      'factory.import': 'Import',
      'factory.importPlaceholder': '#12 or an issue URL',
      'factory.importHint': '`#12` — from the board project\'s repository; `owner/repo#12` or an issue link — from any repository. Needs an installed and signed-in `gh`.',
      'factory.importError.badRef': 'Enter an issue number (“#12”), a link or “owner/repo#12”.',
      'factory.importError.ghMissing': 'GitHub CLI not found: install `gh` (https://cli.github.com) and run `gh auth login`.',
      'factory.importError.ghAuth': '`gh` is not signed in: run `gh auth login` and import again.',
      'factory.importError.repoNotFound': 'Repository not found: check “owner/repo” and your access to it.',
      'factory.importError.notFound': 'Issue not found: check the number and the repository.',
      'factory.importError.unavailable': 'Could not read the issue through `gh`. Check `gh auth status` and the reference.',
      'factory.pollTrackers': 'Poll trackers now',
      'factory.polled': 'Added from trackers: {n}',
      'factory.empty': 'No tickets yet.',
      'factory.column.incoming': 'Incoming',
      'factory.column.triage': 'Triage',
      'factory.column.working': 'Working',
      'factory.column.checks': 'Checks',
      'factory.column.ready': 'Ready for PR',
      'factory.column.waiting': 'Waiting for you',
      'factory.column.done': 'Done',
      'factory.stage.tests': 'Tests',
      'factory.stage.check': 'App check',
      'factory.stage.review': 'Review',
      'factory.waiting.triageQuestions': 'Triage has questions',
      'factory.waiting.plan': 'Plan needs approval',
      'factory.waiting.repairExhausted': 'Repair rounds are out',
      'factory.waiting.interrupted': 'Work interrupted',
      'factory.waiting.nothingToRun': 'Nothing to run it on',
      'factory.waiting.postponed': 'Postponed by you',
      'factory.action.answer': 'Answer',
      'factory.action.approvePlan': 'Approve the plan',
      'factory.action.more': 'One more round',
      'factory.action.accept': 'Accept as is',
      'factory.action.postpone': 'Postpone',
      'factory.action.return': 'Return to the factory',
      'factory.action.comment': 'Return with a comment',
      'factory.action.pr': 'Pull Request',
      'factory.action.merge': 'Merge',
      'factory.action.openSession': 'Open the session',
      'factory.action.takeOver': 'Take over manually',
      'factory.action.back': 'Back to the board',
      'factory.answerPlaceholder': 'Answers to triage questions',
      'factory.commentPlaceholder': 'What should be fixed',
      'factory.send': 'Send',
      'factory.spec': 'Spec',
      'factory.criteria': 'Criteria',
      'factory.met': 'met',
      'factory.unmet': 'unmet',
      'factory.route': 'Route',
      'factory.repairRound': 'Repair round {n}/{max}',
      'factory.check': 'Check',
      'factory.review': 'Review',
      'factory.findings': 'Findings',
      'factory.versions': 'Versions of this ticket',
      'factory.session': 'Ticket session',
      'factory.events': 'Journal',
      'factory.eventEmpty': 'The board journal is empty.',
      'factory.prUrl': 'Pull request: {url}',
      'factory.takeover': 'Taken manually',
      'factory.done': 'Done',
      'factory.count': '{n}',
      'factory.refresh': 'Refresh',
      'factory.skip': 'Skipped: {reason}',
      'factory.waitingHint': 'The factory never sends anything outward: only you press «Pull Request» or «Merge».',
      'factory.triageQuestionsHint': 'Answer by line: each line answers one question.',
      'factory.dirtyTree': 'The project has uncommitted changes.',
      'factory.selectBoard': 'Choose a project for the board',
      'factory.noBoards': 'No boards yet. Create one for this project.',

      'loading': 'Loading…',
      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
    }

    const ru = {
      'surface.title': 'Артель',
      'surface.back': 'Чат',
      'surface.backTitle': 'Вернуться в чат',
      'surface.close': 'Закрыть «Артель»',

      'launcher.title': 'Артель',
      'launcher.open': 'Открыть «Артель»',
      'launcher.busy': 'Артель работает',

      'rail.title': 'Сессии',
      'rail.new': 'Новая сессия',
      'rail.empty': 'Пока нет ни одной сессии.',
      'rail.groupFallback': 'Без проекта',
      'rail.footerRuns': 'сессий: {n}',
      'rail.footerFiles': 'файлов: {n}',
      'rail.refresh': 'Обновить',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': 'Новая задача',
      'hero.placeholder': 'Опишите задачу для агентов…',
      'hero.hint': 'Задача выполняется в изолированной копии проекта «{project}». Ваши файлы не меняются, пока вы не примените изменения.',
      'hero.hintNoProject': 'Задача выполняется в изолированной копии проекта. Ваши файлы не меняются, пока вы не примените изменения.',
      'hero.start': 'Поехали →',
      'hero.starting': 'Запускаю…',
      'hero.taskLabel': 'Задача',
      'hero.mode': 'Режим',
      'hero.model': 'Модель',
      'hero.effort': 'Рассуждение',
      'hero.effortAuto': 'По умолчанию адаптера',
      'model.title': 'Модели агентов',
      'model.agent': 'Агент',
      'model.effort': 'Рассуждение',
      'model.default': 'По умолчанию адаптера',
      'model.unavailable': 'Каталог моделей недоступен в этом профиле',
      'model.saving': 'Сохраняю…',
      'model.hint': 'Каждый агент переключается со следующего шага; текущий шаг сохраняет свою модель.',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': 'Один агент, одна копия',
      'mode.swarm.hint': 'Три агента делят файлы',
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Трое делят файлы, дирижёр принимает работу',
      'mode.fusion': 'Fusion',
      'mode.fusion.hint': 'Три модели отвечают независимо, судья сводит ответы, одна модель делает работу',
      'mode.orchestrator': 'Оркестратор',
      'mode.orchestrator.hint': 'Цель режется на части, каждая в своей копии; старший проверяет каждую часть до сборки.',
      'hero.fusion.title': 'Маршруты Fusion',
      'hero.fusion.panel': 'Панель {n}',
      'hero.fusion.judge': 'Судья',
      'hero.fusion.implementer': 'Исполнитель',
      'role.conductor': 'дирижёр',
      'role.worker': 'агент',
      'role.panelist': 'панелист',
      'role.judge': 'судья',
      'role.implementer': 'исполнитель',
      'role.planner': 'Планировщик',
      'role.part': 'Агент части',
      'role.reviewer': 'Проверяющий',
      'role.merger': 'Сборщик',

      'partStatus.pending': 'Ожидает',
      'partStatus.working': 'В работе',
      'partStatus.reviewing': 'На проверке',
      'partStatus.rework': 'Возвращена в работу',
      'partStatus.accepted': 'Принята',
      'partStatus.failed': 'Ошибка',

      'parts.title': 'Части',
      'parts.item': 'Часть {n} — {title}',
      'parts.summaryLabel': 'План',
      'parts.conditionsLabel': 'Сделано, если',
      'parts.filesLabel': 'Файлы',
      'parts.rounds': 'Возврат {n} из 2',
      'parts.mergeResolved': 'Сборщик разрешил конфликтов: {n}',
      'parts.mergeUnresolved': 'Сборка не завершена — применить нельзя.',
      'parts.accepted': '{done}/{total} принято',

      'run.new': 'Новая сессия',
      'run.taskLabel': 'Задача',
      'run.project': 'Проект',
      'run.changes': 'файлов изменено: {n}',
      'run.changesOne': '1 файл изменён',
      'run.stop': 'Остановить',
      'run.stopping': 'Останавливаю…',
      'run.stopQuestion': 'Остановить артель?',
      'run.stopYes': 'Остановить',
      'run.stopNo': 'Продолжить',
      'run.feedEmpty': 'Агенты готовятся — первые сообщения появятся здесь.',
      'run.feedLoading': 'Загружаю ленту…',
      'run.openSession': 'Открыть чат агента',

      'changes.title': 'Изменения · {n} файлов',
      'changes.titleFew': 'Изменения · {n} файла',
      'changes.titleOne': 'Изменения · 1 файл',
      'changes.titleZero': 'Изменения',
      'changes.refresh': 'Обновить изменения',
      'changes.show': 'Показать изменения',
      'changes.hide': 'Скрыть изменения',
      'changes.loading': 'Загружаю изменения…',
      'changes.empty': 'В этой артели нет изменений в файлах.',
      'changes.loadError': 'Не удалось загрузить изменения',
      'changes.apply': 'Применить',
      'changes.applying': 'Применяю…',
      'changes.discard': 'Отклонить',
      'changes.discarding': 'Отклоняю…',
      'changes.applyQuestion': 'Применить изменения?',
      'changes.applyHint': 'Изменения будут записаны в {project}. Копия будет удалена.',
      'changes.applyYes': 'Применить',
      'changes.applyNo': 'Отмена',
      'changes.discardQuestion': 'Отклонить изменения?',
      'changes.discardHint': 'Изолированная копия будет удалена, а {project} останется без изменений.',
      'changes.discardYes': 'Отклонить',
      'changes.discardNo': 'Отмена',
      'changes.applied': 'Применено',
      'changes.discarded': 'Отклонено',
      'changes.appliedHint': 'Изменения записаны в {project}.',
      'changes.appliedHintNoProject': 'Изменения записаны в проект.',
      'changes.discardedHint': 'Копия удалена; проект не изменён.',
      'changes.skipped': 'Пропущено: {n}',
      'changes.binary': 'двоичный',
      'changes.file.added': 'добавлен',
      'changes.file.deleted': 'удалён',
      'changes.file.modified': 'изменён',
      'changes.file.binary': 'двоичный',
      'changes.expandFile': 'Показать дифф',
      'changes.collapseFile': 'Скрыть дифф',

      'feed.you': 'Вы',
      'feed.to': '→ {name}',
      'feed.toAll': '→ Всем',
      'feed.plan': 'План',
      'feed.collision': 'Конфликт правок',
      'feed.error': 'Ошибка',
      'feed.tools': 'инструментов: {n}',
      'feed.toolOne': '1 вызов инструмента',
      'feed.toolOpen': 'Показать аргументы и результат',
      'feed.toolClose': 'Скрыть аргументы и результат',
      'feed.collapseAll': 'Свернуть все',
      'feed.toolArgs': 'Аргументы',
      'feed.toolResult': 'Результат',
      'feed.toolError': 'Ошибка',
      'feed.toolOk': 'готово',
      'feed.toolFailed': 'ошибка',
      'feed.toolPending': 'Ещё выполняется…',
      'feed.toolEmpty': 'Без вывода',
      'feed.empty': 'Пока тихо.',
      'feed.copy': 'Копировать',
      'feed.copied': 'Скопировано',
      'feed.code': 'Код',
      'feed.wrap': 'Переносить строки',
      'feed.unwrap': 'Без переноса',
      'feed.footnotes': 'Сноски',

      // Живой вид: чем занят каждый агент и чего ждём.
      'live.title': 'Сейчас',
      'live.tool': 'инструмент {tool}',
      'live.thinking': 'пишет ответ',
      'live.turn': 'Время текущего хода',
      'live.context': '{used} из {window} токенов · {pct}% окна',
      'live.composition': 'система {system} · инструменты {tools} · сообщения {messages}',
      'live.spend': 'токенов: {n}',
      'live.spendTitle': 'вход {input} · выход {output} · кэш {cache}',
      'live.waitUser': 'Ждёт вашего ответа',
      'live.waitApproval': 'Ждёт утверждения плана',
      'live.waitAgents': 'Агенты работают',
      'live.waitAgent': 'Ждём: {name}',
      'live.waitAgentTwo': 'Ждём: {a} и {b}',
      'live.waitAgentsNames': 'Ждём: {names}',
      'live.waitHost': 'Сводит результат',

      'composer.placeholder': 'Написать агентам…',
      'composer.send': 'Отправить',
      'composer.to': 'Кому',
      'composer.all': 'Всем',
      'composer.hint': 'Ctrl+Enter — отправить',

      'agent.starting': 'стартует',
      'agent.planning': 'планирует',
      'agent.working': 'работает',
      'agent.idle': 'свободен',
      'agent.failed': 'ошибка',

      'status.preparing': 'Подготовка',
      'status.planning': 'Планирование',
      'status.running': 'В работе',
      'status.waiting': 'Ждёт вас',
      'status.finished': 'Готово',
      'status.interrupted': 'Остановлено',
      'status.failed': 'Ошибка',
      'status.applied': 'Применено',
      'status.discarded': 'Выброшено',
      'status.starting': 'Запуск',

      'error.title': 'Не получилось',
      'error.retry': 'Повторить',
      'error.dismiss': 'Закрыть',
      'error.apiMissing': 'Серверная часть «Артели» недоступна. Проверьте, что плагин включён.',
      'error.start': 'Не удалось запустить артель',
      'error.load': 'Не удалось загрузить артели',
      'error.send': 'Не удалось отправить сообщение',
      'error.stop': 'Не удалось остановить артель',
      'error.timeout': 'Сервер слишком долго не отвечает',
      'error.notFound': 'Эта артель больше не существует',
      'error.restarting': 'Сервер «Артели» перезапускается — повторите чуть позже',

      'queue.title': 'Ожидают',
      'queue.autopilot': 'Автоочередь',
      'queue.heroHint': 'Складывайте задачи и включите «Автоочередь»: они пойдут одна за другой без вас, каждая сохраняется своей версией. Наружу ничего не уходит без вашей кнопки.',
      'queue.runHint': 'Колонка «Ожидают»: задачи, поставленные в очередь этого сеанса, и задачи текущего плана, которым ещё не досталось свободного работника.',
      'queue.add': 'В очередь',
      'queue.addPlaceholder': 'Что сделать дальше…',
      'queue.empty': 'Никого не ждём. Добавьте задачу в очередь.',
      'queue.parked': 'Отложенное',
      'queue.results': 'Итоги автоочереди',
      'queue.resultsVersions': 'Версий: {n}',
      'queue.resultsParked': 'Отложено: {n}',
      'queue.resultsNotTaken': 'Не взято: {n}',
      'queue.rework': 'Доработать',
      'queue.rollback': 'Откатить',
      'queue.stop': 'Стоп',
      'queue.finishAfter': 'Закончить после текущей',
      'queue.resume': 'Продолжить',
      'queue.saveVersion': 'Сохранить версией',
      'queue.postponeVersion': 'Отложить',
      'queue.retry': 'Вернуть',
      'queue.remove': 'Убрать',
      'queue.moveUp': 'Выше',
      'queue.moveDown': 'Ниже',
      'queue.clear': 'Убрать завершённые',
      'queue.limit': 'Не больше задач за запуск',
      'queue.checkCommand': 'Команда проверки',
      'queue.checkDisabled': 'Без проверки',
      'queue.checkGuessed': 'Подобрана по проекту',
      'queue.preflight': 'Перед запуском',
      'queue.preflightPending': 'Не сохранённые версии',
      'queue.saveThem': 'Сохранить их версией',
      'queue.postponeThem': 'Отложить',
      'queue.continue': 'Продолжить',
      'queue.preflightNone': 'Проверки нет: версии сохранятся на слово агента и будут помечены.',
      'queue.reason': 'Причина',
      'queue.questions': 'Вопросов: {n}',
      'queue.fixes': 'Починок: {n}',
      'queue.version': 'Версия',
      'queue.versions': 'Версии',
      'queue.notTaken': 'Не взято',
      'queue.stoppedBecause': 'Автоочередь остановлена: {reason}',
      'queue.open': 'Показать очередь',
      'queue.close': 'Скрыть очередь',
      'queue.heroToggle': 'Автоочередь',
      'queue.heroToggleHint': 'Вести задачи одна за другой без вас',
      'queue.busy': 'Работаю…',
      'queue.hint': 'Сообщение в чате не прерывает очередь: оно встаёт первой задачей.',
      'queue.status.queued': 'В очереди',
      'queue.status.running': 'Идёт',
      'queue.status.passed': 'Версия сохранена',
      'queue.status.parked': 'Отложено',
      'queue.status.skipped': 'Пропущено',
      'queue.status.stopped': 'Остановлено',
      'queue.diskLow': 'Не хватает места на диске для ещё одной копии.',
      'queue.disabled': 'Очередь стоит: включите «Автоочередь», чтобы она пошла сама.',
      'queue.waitingForReset': 'Ждём сброса подписки: {when}',
      'queue.progressSimple': 'Готово {done} из {total}',
      'queue.showAll': 'Показать все задачи ({n})',

      'factory.title': 'Фабрика',
      'factory.subtitle': 'Конвейер тикетов',
      'factory.open': 'Открыть «Фабрику»',
      'factory.close': 'К сеансам',
      'factory.create': 'Создать доску',
      'factory.createHint': 'У каждого проекта своя доска тикетов. Фабрика берёт тикеты, пока она включена.',
      'factory.board': 'Доска',
      'factory.settings': 'Настройки',
      'factory.save': 'Сохранить',
      'factory.saved': 'Сохранено',
      'factory.enabled': 'Фабрика включена',
      'factory.enable': 'Включить',
      'factory.pause': 'Пауза',
      'factory.resume': 'Продолжить',
      'factory.paused': 'Пауза: новые тикеты не берутся, начатые заканчиваются.',
      'factory.disabledHint': 'Фабрика выключена: новые тикеты ждут во «Входящих».',
      'factory.readiness': 'Проверить',
      'factory.ready': 'Готова',
      'factory.notReady': 'Не готова: есть блокирующие проблемы',
      'factory.problems': 'Проблемы',
      'factory.template': 'Шаблон конвейера',
      'factory.template.normal': 'Обычный',
      'factory.template.fast': 'Быстрый',
      'factory.template.strict': 'Строгий',
      'factory.template.normal.hint': 'Тесты, проверка приложения и ревью, до двух кругов починки.',
      'factory.template.fast.hint': 'Без проверки приложения, один круг починки — для мелких тикетов.',
      'factory.template.strict.hint': 'Два ревьюера на разных движках, до трёх кругов починки.',
      'factory.routes': 'Разрешённые маршруты',
      'factory.models': 'Модели по ролям',
      'factory.model.triage': 'Разбор',
      'factory.model.work': 'Работа',
      'factory.model.tests': 'Тесты',
      'factory.model.review': 'Ревью',
      'factory.auto': 'Авто',
      'factory.limits': 'Потолок расхода',
      'factory.ticketsAtOnce': 'Тикетов одновременно',
      'factory.ticketsPerDay': 'Тикетов в день',
      'factory.workers': 'Работников на тикет',
      'factory.allowApi': 'Разрешить движок «API»',
      'factory.allowLow': 'Разрешать почти исчерпанные подписки',
      'factory.commands': 'Команды',
      'factory.testCommand': 'Команда тестов',
      'factory.checkCommand': 'Команда проверки',
      'factory.previewCommand': 'Команда preview',
      'factory.appendTests': 'Дописывать тесты, если правки их не трогали',
      'factory.trackers': 'Приём тикетов',
      'factory.trackerKind': 'Тип',
      'factory.trackerLabel': 'Метка',
      'factory.trackerProject': 'Проект / ссылка',
      'factory.trackerComment': 'Комментировать результат в задаче',
      'factory.trackerAdd': 'Добавить трекер',
      'factory.trackerRemove': 'Убрать',
      'factory.trackerNone': 'Трекеров нет: тикеты приходят из «Входящих» и из GitHub issues.',
      'factory.incoming': 'Входящие',
      'factory.ticketTitle': 'Заголовок',
      'factory.ticketText': 'Текст',
      'factory.ticketPlaceholder': 'Что нужно сделать…',
      'factory.addTicket': 'Добавить тикет',
      'factory.attachments': 'Файлы и скриншоты',
      'factory.attach': 'Прикрепить',
      'factory.importIssue': 'Из GitHub issue',
      'factory.import': 'Импорт',
      'factory.importPlaceholder': '#12 или ссылка на issue',
      'factory.importHint': '`#12` — из репозитория проекта доски; `owner/repo#12` или ссылка на issue — из любого. Нужен установленный и авторизованный `gh`.',
      'factory.importError.badRef': 'Укажите номер issue («#12»), ссылку или «owner/repo#12».',
      'factory.importError.ghMissing': 'GitHub CLI не найден: установите `gh` (https://cli.github.com) и выполните `gh auth login`.',
      'factory.importError.ghAuth': '`gh` не авторизован: выполните `gh auth login` и повторите импорт.',
      'factory.importError.repoNotFound': 'Репозиторий не найден: проверьте «owner/repo» и доступ к нему.',
      'factory.importError.notFound': 'Issue не найден: проверьте номер и репозиторий.',
      'factory.importError.unavailable': 'Не удалось прочитать issue через `gh`. Проверьте `gh auth status` и ссылку.',
      'factory.pollTrackers': 'Проверить трекеры',
      'factory.polled': 'Добавлено из трекеров: {n}',
      'factory.empty': 'Тикетов пока нет.',
      'factory.column.incoming': 'Входящие',
      'factory.column.triage': 'Разбор',
      'factory.column.working': 'Работа',
      'factory.column.checks': 'Проверки',
      'factory.column.ready': 'Готово к PR',
      'factory.column.waiting': 'Ждёт вас',
      'factory.column.done': 'Готово',
      'factory.stage.tests': 'Тесты',
      'factory.stage.check': 'Проверка приложения',
      'factory.stage.review': 'Ревью',
      'factory.waiting.triageQuestions': 'У разбора есть вопросы',
      'factory.waiting.plan': 'План ждёт утверждения',
      'factory.waiting.repairExhausted': 'Круги починки кончились',
      'factory.waiting.interrupted': 'Работа прервалась',
      'factory.waiting.nothingToRun': 'Не на чем запускать',
      'factory.waiting.postponed': 'Отложено вами',
      'factory.action.answer': 'Ответить',
      'factory.action.approvePlan': 'Утвердить план',
      'factory.action.more': 'Ещё круг',
      'factory.action.accept': 'Принять как есть',
      'factory.action.postpone': 'Отложить',
      'factory.action.return': 'Вернуть фабрике',
      'factory.action.comment': 'Вернуть с комментарием',
      'factory.action.pr': 'Pull Request',
      'factory.action.merge': 'Влить',
      'factory.action.openSession': 'Открыть сессию',
      'factory.action.takeOver': 'Взять вручную',
      'factory.action.back': 'Назад к доске',
      'factory.answerPlaceholder': 'Ответы на вопросы разбора',
      'factory.commentPlaceholder': 'Что исправить',
      'factory.send': 'Отправить',
      'factory.spec': 'Спецификация',
      'factory.criteria': 'Критерии',
      'factory.met': 'выполнено',
      'factory.unmet': 'не выполнено',
      'factory.route': 'Маршрут',
      'factory.repairRound': 'Круг починки {n}/{max}',
      'factory.check': 'Проверка',
      'factory.review': 'Ревью',
      'factory.findings': 'Находки',
      'factory.versions': 'Версии этого тикета',
      'factory.session': 'Сессия тикета',
      'factory.events': 'Журнал',
      'factory.eventEmpty': 'Журнал доски пуст.',
      'factory.prUrl': 'Pull request: {url}',
      'factory.takeover': 'Взят вручную',
      'factory.done': 'Готово',
      'factory.count': '{n}',
      'factory.refresh': 'Обновить',
      'factory.skip': 'Пропущено: {reason}',
      'factory.waitingHint': 'Фабрика сама ничего не отправляет наружу: «Pull Request» и «Влить» нажимаете только вы.',
      'factory.triageQuestionsHint': 'Ответьте по строке: каждая строка — ответ на один вопрос.',
      'factory.dirtyTree': 'В проекте есть незакоммиченные изменения.',
      'factory.selectBoard': 'Выберите проект для доски',
      'factory.noBoards': 'Досок пока нет. Создайте доску для этого проекта.',

      'loading': 'Загружаю…',
      'time.now': 'только что',
      'time.minutes': '{n} мин назад',
      'time.hours': '{n} ч назад',
    }

    const zh = {
      'surface.title': 'Artel',
      'surface.back': '聊天',
      'surface.backTitle': '返回聊天',
      'surface.close': '关闭 Artel',

      'launcher.title': 'Artel',
      'launcher.open': '打开 Artel',
      'launcher.busy': 'Artel 正在工作',

      'rail.title': '会话',
      'rail.new': '新建会话',
      'rail.empty': '还没有会话。',
      'rail.groupFallback': '未选择项目',
      'rail.footerRuns': '会话：{n}',
      'rail.footerFiles': '文件：{n}',
      'rail.refresh': '刷新',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': '新任务',
      'hero.placeholder': '描述任务，交给智能体…',
      'hero.hint': '任务在项目「{project}」的隔离副本中运行。在应用更改之前，你的文件不会被修改。',
      'hero.hintNoProject': '任务在项目的隔离副本中运行。在应用更改之前，你的文件不会被修改。',
      'hero.start': '开始 →',
      'hero.starting': '启动中…',
      'hero.taskLabel': '任务',
      'hero.mode': '模式',
      'hero.model': '模型',
      'hero.effort': '推理强度',
      'hero.effortAuto': '适配器默认',
      'model.title': '智能体模型',
      'model.agent': '智能体',
      'model.effort': '推理强度',
      'model.default': '适配器默认',
      'model.unavailable': '当前配置无法获取模型目录',
      'model.saving': '保存中…',
      'model.hint': '每个智能体从下一步开始切换；正在运行的步骤保留原模型。',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': '一个智能体，一份副本',
      'mode.swarm.hint': '三个智能体划分文件',
      'mode.conductor': '指挥',
      'mode.conductor.hint': '三个智能体划分文件，指挥验收成果',
      'mode.fusion': '融合',
      'mode.fusion.hint': '三个模型独立回答，评审汇总，一个模型执行',
      'mode.orchestrator': '编排',
      'mode.orchestrator.hint': '目标拆成多个部分，每部分在各自的副本中完成，组装前逐一验收。',
      'hero.fusion.title': '融合路由',
      'hero.fusion.panel': '模型 {n}',
      'hero.fusion.judge': '评审',
      'hero.fusion.implementer': '执行者',
      'role.conductor': '指挥',
      'role.worker': '智能体',
      'role.panelist': '组员',
      'role.judge': '评审',
      'role.implementer': '执行者',
      'role.planner': '规划者',
      'role.part': '部分代理',
      'role.reviewer': '审查者',
      'role.merger': '合并者',

      'partStatus.pending': '等待',
      'partStatus.working': '进行中',
      'partStatus.reviewing': '审核中',
      'partStatus.rework': '返工',
      'partStatus.accepted': '已通过',
      'partStatus.failed': '失败',

      'parts.title': '部分',
      'parts.item': '第 {n} 部分 — {title}',
      'parts.summaryLabel': '计划',
      'parts.conditionsLabel': '完成条件',
      'parts.filesLabel': '文件',
      'parts.rounds': '返工 {n}/2',
      'parts.mergeResolved': '合并者解决了 {n} 处冲突',
      'parts.mergeUnresolved': '合并未完成——暂时无法应用。',
      'parts.accepted': '已通过 {done}/{total}',

      'run.new': '新建会话',
      'run.taskLabel': '任务',
      'run.project': '项目',
      'run.changes': '已修改 {n} 个文件',
      'run.changesOne': '已修改 1 个文件',
      'run.stop': '停止',
      'run.stopping': '停止中…',
      'run.stopQuestion': '停止这次 Artel 运行？',
      'run.stopYes': '停止运行',
      'run.stopNo': '继续',
      'run.feedEmpty': '智能体正在准备——消息会出现在这里。',
      'run.feedLoading': '正在加载动态…',
      'run.openSession': '打开智能体会话',

      'changes.title': '变更 · {n} 个文件',
      'changes.titleFew': '变更 · {n} 个文件',
      'changes.titleOne': '变更 · 1 个文件',
      'changes.titleZero': '变更',
      'changes.refresh': '刷新更改',
      'changes.show': '显示更改',
      'changes.hide': '隐藏更改',
      'changes.loading': '正在加载更改…',
      'changes.empty': '本次运行没有文件更改。',
      'changes.loadError': '无法加载更改',
      'changes.apply': '应用',
      'changes.applying': '应用中…',
      'changes.discard': '丢弃',
      'changes.discarding': '丢弃中…',
      'changes.applyQuestion': '应用这些更改？',
      'changes.applyHint': '更改将写入 {project}。隔离副本将被删除。',
      'changes.applyYes': '应用',
      'changes.applyNo': '取消',
      'changes.discardQuestion': '丢弃这些更改？',
      'changes.discardHint': '隔离副本将被删除，{project} 保持不变。',
      'changes.discardYes': '丢弃',
      'changes.discardNo': '取消',
      'changes.applied': '已应用',
      'changes.discarded': '已丢弃',
      'changes.appliedHint': '更改已写入 {project}。',
      'changes.appliedHintNoProject': '更改已写入项目。',
      'changes.discardedHint': '副本已删除；项目未更改。',
      'changes.skipped': '已跳过：{n}',
      'changes.binary': '二进制',
      'changes.file.added': '新增',
      'changes.file.deleted': '删除',
      'changes.file.modified': '修改',
      'changes.file.binary': '二进制',
      'changes.expandFile': '显示差异',
      'changes.collapseFile': '隐藏差异',

      'feed.you': '你',
      'feed.to': '→ {name}',
      'feed.toAll': '→ 所有人',
      'feed.plan': '计划',
      'feed.collision': '编辑冲突',
      'feed.error': '错误',
      'feed.tools': '工具调用：{n}',
      'feed.toolOne': '1 次工具调用',
      'feed.toolOpen': '显示参数和输出',
      'feed.toolClose': '隐藏参数和输出',
      'feed.collapseAll': '全部收起',
      'feed.toolArgs': '参数',
      'feed.toolResult': '输出',
      'feed.toolError': '错误',
      'feed.toolOk': '完成',
      'feed.toolFailed': '失败',
      'feed.toolPending': '仍在执行…',
      'feed.toolEmpty': '没有输出',
      'feed.empty': '暂无内容。',
      'feed.copy': '复制',
      'feed.copied': '已复制',
      'feed.code': '代码',
      'feed.wrap': '自动换行',
      'feed.unwrap': '取消换行',
      'feed.footnotes': '脚注',

      // 实时视图：每个智能体此刻在做什么、整次运行在等什么。
      'live.title': '当前',
      'live.tool': '正在使用 {tool}',
      'live.thinking': '正在写回复',
      'live.turn': '当前轮次耗时',
      'live.context': '已用 {used} / {window} 个 token · 占窗口 {pct}%',
      'live.composition': '系统 {system} · 工具 {tools} · 消息 {messages}',
      'live.spend': '{n} 个 token',
      'live.spendTitle': '输入 {input} · 输出 {output} · 缓存 {cache}',
      'live.waitUser': '等待你的回答',
      'live.waitApproval': '等待计划确认',
      'live.waitAgents': '智能体正在工作',
      'live.waitAgent': '等待 {name}',
      'live.waitAgentTwo': '等待 {a} 和 {b}',
      'live.waitAgentsNames': '等待 {names}',
      'live.waitHost': '正在汇总结果',

      'composer.placeholder': '给智能体发消息…',
      'composer.send': '发送',
      'composer.to': '发给',
      'composer.all': '所有人',
      'composer.hint': 'Ctrl+Enter — 发送',

      'agent.starting': '启动中',
      'agent.planning': '规划中',
      'agent.working': '工作中',
      'agent.idle': '空闲',
      'agent.failed': '失败',

      'status.preparing': '准备中',
      'status.planning': '规划中',
      'status.running': '进行中',
      'status.waiting': '等待你',
      'status.finished': '已完成',
      'status.interrupted': '已停止',
      'status.failed': '失败',
      'status.applied': '已应用',
      'status.discarded': '已丢弃',
      'status.starting': '启动中',

      'error.title': '出错了',
      'error.retry': '重试',
      'error.dismiss': '关闭',
      'error.apiMissing': 'Artel 服务端不可用。请检查插件是否已启用。',
      'error.start': '无法启动 Artel',
      'error.load': '无法加载 Artel 运行',
      'error.send': '无法发送消息',
      'error.stop': '无法停止运行',
      'error.timeout': '服务端响应超时',
      'error.notFound': '这次 Artel 运行已不存在',
      'error.restarting': 'Artel 服务端正在重启——请稍后重试',

      'queue.title': '等待中',
      'queue.autopilot': '自动队列',
      'queue.heroHint': '把任务排进队列并打开「自动队列」：它们会依次无人值守地跑，每个任务各自保存为一个版本。没有你的按钮，任何东西都不会离开这个副本。',
      'queue.runHint': '「等待中」列：为这个会话排队的任务，以及当前计划里还没分到空闲执行者的任务。',
      'queue.add': '排队',
      'queue.addPlaceholder': '接下来做什么…',
      'queue.empty': '没有等待的任务。往队列里加一个。',
      'queue.parked': '已搁置',
      'queue.results': '自动队列结果',
      'queue.resultsVersions': '版本：{n}',
      'queue.resultsParked': '已搁置：{n}',
      'queue.resultsNotTaken': '未取：{n}',
      'queue.rework': '继续修改',
      'queue.rollback': '回滚',
      'queue.stop': '停止',
      'queue.finishAfter': '做完当前任务后结束',
      'queue.resume': '继续',
      'queue.saveVersion': '保存为版本',
      'queue.postponeVersion': '搁置',
      'queue.retry': '归队',
      'queue.remove': '移除',
      'queue.moveUp': '上移',
      'queue.moveDown': '下移',
      'queue.clear': '清除已完成',
      'queue.limit': '每次运行最多 N 个任务',
      'queue.checkCommand': '检查命令',
      'queue.checkDisabled': '不做检查',
      'queue.checkGuessed': '根据项目推测',
      'queue.preflight': '启动前',
      'queue.preflightPending': '未保存的版本',
      'queue.saveThem': '保存为版本',
      'queue.postponeThem': '搁置',
      'queue.continue': '继续',
      'queue.preflightNone': '没有检查命令：版本会按执行者的说法保存，并做标记。',
      'queue.reason': '原因',
      'queue.questions': '提问：{n}',
      'queue.fixes': '修复：{n}',
      'queue.version': '版本',
      'queue.versions': '版本',
      'queue.notTaken': '未取',
      'queue.stoppedBecause': '自动队列已停止：{reason}',
      'queue.open': '显示队列',
      'queue.close': '隐藏队列',
      'queue.heroToggle': '自动队列',
      'queue.heroToggleHint': '无人值守地连续执行任务',
      'queue.busy': '处理中…',
      'queue.hint': '聊天消息不会打断队列：它会变成第一个任务。',
      'queue.status.queued': '排队中',
      'queue.status.running': '进行中',
      'queue.status.passed': '版本已保存',
      'queue.status.parked': '已搁置',
      'queue.status.skipped': '已跳过',
      'queue.status.stopped': '已停止',
      'queue.diskLow': '磁盘空间不足，无法再建一个副本。',
      'queue.disabled': '队列已停止：打开「自动队列」即可无人值守运行。',
      'queue.waitingForReset': '等待订阅额度重置：{when}',
      'queue.progressSimple': '已完成 {done} / {total}',
      'queue.showAll': '显示全部任务（{n}）',

      'factory.title': '工厂',
      'factory.subtitle': '工单流水线',
      'factory.open': '打开「工厂」',
      'factory.close': '返回会话',
      'factory.create': '创建看板',
      'factory.createHint': '每个项目有自己的工单看板。工厂启用时才会接新工单。',
      'factory.board': '看板',
      'factory.settings': '设置',
      'factory.save': '保存',
      'factory.saved': '已保存',
      'factory.enabled': '工厂已启用',
      'factory.enable': '启用',
      'factory.pause': '暂停',
      'factory.resume': '继续',
      'factory.paused': '已暂停：不再接新工单，已开始的会做完。',
      'factory.disabledHint': '工厂未启用：新工单会留在「收件箱」。',
      'factory.readiness': '检查就绪',
      'factory.ready': '已就绪',
      'factory.notReady': '未就绪：有阻塞问题',
      'factory.problems': '问题',
      'factory.template': '流水线模板',
      'factory.template.normal': '常规',
      'factory.template.fast': '快速',
      'factory.template.strict': '严格',
      'factory.template.normal.hint': '测试、应用检查与评审，最多两轮修复。',
      'factory.template.fast.hint': '不做应用检查，一轮修复——适合小工单。',
      'factory.template.strict.hint': '两个评审者在不同引擎上，最多三轮修复。',
      'factory.routes': '允许的路线',
      'factory.models': '各角色模型',
      'factory.model.triage': '分诊',
      'factory.model.work': '执行',
      'factory.model.tests': '测试',
      'factory.model.review': '评审',
      'factory.auto': '自动',
      'factory.limits': '开销上限',
      'factory.ticketsAtOnce': '同时处理工单',
      'factory.ticketsPerDay': '每日工单',
      'factory.workers': '每单执行者',
      'factory.allowApi': '允许「API」引擎',
      'factory.allowLow': '允许接近用尽的订阅',
      'factory.commands': '命令',
      'factory.testCommand': '测试命令',
      'factory.checkCommand': '检查命令',
      'factory.previewCommand': '预览命令',
      'factory.appendTests': '改动未涉及测试时补写测试',
      'factory.trackers': '工单来源',
      'factory.trackerKind': '类型',
      'factory.trackerLabel': '标签',
      'factory.trackerProject': '项目 / 链接',
      'factory.trackerComment': '把结果评论回任务',
      'factory.trackerAdd': '添加跟踪器',
      'factory.trackerRemove': '移除',
      'factory.trackerNone': '没有跟踪器：工单来自「收件箱」字段和 GitHub issue。',
      'factory.incoming': '收件箱',
      'factory.ticketTitle': '标题',
      'factory.ticketText': '描述',
      'factory.ticketPlaceholder': '需要做什么…',
      'factory.addTicket': '添加工单',
      'factory.attachments': '文件与截图',
      'factory.attach': '附加',
      'factory.importIssue': '来自 GitHub issue',
      'factory.import': '导入',
      'factory.importPlaceholder': '#12 或 issue 链接',
      'factory.importHint': '`#12` — 来自看板项目所在的仓库；`owner/repo#12` 或 issue 链接 — 来自任意仓库。需要已安装并已登录的 `gh`。',
      'factory.importError.badRef': '请输入 issue 编号（“#12”）、链接或 “owner/repo#12”。',
      'factory.importError.ghMissing': '未找到 GitHub CLI：请安装 `gh`（https://cli.github.com）并执行 `gh auth login`。',
      'factory.importError.ghAuth': '`gh` 未登录：请执行 `gh auth login` 后重试。',
      'factory.importError.repoNotFound': '未找到仓库：请检查 “owner/repo” 及访问权限。',
      'factory.importError.notFound': '未找到 issue：请检查编号和仓库。',
      'factory.importError.unavailable': '无法通过 `gh` 读取 issue。请检查 `gh auth status` 和引用。',
      'factory.pollTrackers': '立即轮询跟踪器',
      'factory.polled': '从跟踪器添加工单：{n}',
      'factory.empty': '还没有工单。',
      'factory.column.incoming': '收件箱',
      'factory.column.triage': '分诊',
      'factory.column.working': '执行',
      'factory.column.checks': '检查',
      'factory.column.ready': '待 PR',
      'factory.column.waiting': '等你处理',
      'factory.column.done': '完成',
      'factory.stage.tests': '测试',
      'factory.stage.check': '应用检查',
      'factory.stage.review': '评审',
      'factory.waiting.triageQuestions': '分诊有问题',
      'factory.waiting.plan': '计划待批准',
      'factory.waiting.repairExhausted': '修复轮次用尽',
      'factory.waiting.interrupted': '执行被中断',
      'factory.waiting.nothingToRun': '没有可运行的对象',
      'factory.waiting.postponed': '被你搁置',
      'factory.action.answer': '回答',
      'factory.action.approvePlan': '批准计划',
      'factory.action.more': '再来一轮',
      'factory.action.accept': '按现状接受',
      'factory.action.postpone': '搁置',
      'factory.action.return': '交回工厂',
      'factory.action.comment': '带评论交回',
      'factory.action.pr': 'Pull Request',
      'factory.action.merge': '合并',
      'factory.action.openSession': '打开会话',
      'factory.action.takeOver': '人工接管',
      'factory.action.back': '返回看板',
      'factory.answerPlaceholder': '对分诊问题的回答',
      'factory.commentPlaceholder': '需要修什么',
      'factory.send': '发送',
      'factory.spec': '规格',
      'factory.criteria': '验收标准',
      'factory.met': '已满足',
      'factory.unmet': '未满足',
      'factory.route': '路线',
      'factory.repairRound': '修复轮 {n}/{max}',
      'factory.check': '检查',
      'factory.review': '评审',
      'factory.findings': '发现',
      'factory.versions': '该工单的版本',
      'factory.session': '工单会话',
      'factory.events': '日志',
      'factory.eventEmpty': '看板日志为空。',
      'factory.prUrl': 'Pull request：{url}',
      'factory.takeover': '已人工接管',
      'factory.done': '完成',
      'factory.count': '{n}',
      'factory.refresh': '刷新',
      'factory.skip': '已跳过：{reason}',
      'factory.waitingHint': '工厂自己不会向外发送任何东西：「Pull Request」和「合并」只有你会按，',
      'factory.triageQuestionsHint': '按行回答：每行回答一个问题。',
      'factory.dirtyTree': '项目里有未提交的改动。',
      'factory.selectBoard': '为看板选择项目',
      'factory.noBoards': '还没有看板。为这个项目创建一个。',

      'loading': '加载中…',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
    }

    const DICTIONARIES = { en, ru, zh }

    /* ------------------------------------------------------------- styles */

    const STYLES = `
.dsh-artel-surface {
  --a-accent: var(--dsw-alias-brand-primary, #7c6cff);
  --a-accent-soft: rgba(124, 108, 255, 0.16);
  --a-line: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  --a-line-2: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.11));
  --a-fg: var(--dsw-alias-fg-primary, #eeedf5);
  --a-fg-2: var(--dsw-alias-fg-secondary, #b4b5c3);
  --a-fg-3: var(--dsw-alias-fg-tertiary, #828396);
  --a-grad: linear-gradient(135deg, #8f7bff, #6f5cf0 52%, #58a8ff);
  --a-ease: cubic-bezier(0.2, 0.7, 0.3, 1);
  position: fixed;
  z-index: 50;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--a-line-2);
  border-radius: 20px;
  background:
    radial-gradient(120% 92% at 0% -22%, rgba(124, 108, 255, 0.24), transparent 58%),
    radial-gradient(80% 62% at 100% -12%, rgba(88, 168, 255, 0.14), transparent 62%),
    linear-gradient(180deg, rgba(20, 21, 30, 0.93), rgba(10, 11, 16, 0.96));
  -webkit-backdrop-filter: blur(30px) saturate(1.2);
  backdrop-filter: blur(30px) saturate(1.2);
  box-shadow:
    0 44px 120px -28px rgba(0, 0, 0, 0.8),
    0 0 0 0.5px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.09);
  color: var(--a-fg);
  font-family: var(--dsw-alias-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: -0.005em;
}
.dsh-artel-surface *,
.dsh-artel-surface *::before,
.dsh-artel-surface *::after { box-sizing: border-box; }
.dsh-artel-surface ::selection { background: rgba(124, 108, 255, 0.34); color: #fff; }
.dsh-artel-surface ::-webkit-scrollbar { width: 10px; height: 10px; }
.dsh-artel-surface ::-webkit-scrollbar-track { background: transparent; }
.dsh-artel-surface ::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.16);
  background-clip: content-box;
}
.dsh-artel-surface ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); background-clip: content-box; }
.dsh-artel-surface :focus-visible { outline: 2px solid rgba(124, 108, 255, 0.85); outline-offset: 2px; border-radius: 8px; }

@keyframes dsh-artel-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dsh-artel-spin { to { transform: rotate(360deg); } }
@keyframes dsh-artel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

/* Header ----------------------------------------------------------------- */
.dsh-artel-surface__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 12px 0 10px;
  border-bottom: 1px solid var(--a-line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.004));
}
.dsh-artel-surface__back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px 0 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 140ms var(--a-ease), color 140ms var(--a-ease), border-color 140ms var(--a-ease);
}
.dsh-artel-surface__back:hover {
  border-color: var(--a-line-2);
  background: rgba(255, 255, 255, 0.06);
  color: var(--a-fg);
}
.dsh-artel-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  background: var(--a-grad);
  box-shadow: 0 6px 16px -8px rgba(124, 108, 255, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.3);
  color: #fff;
}
.dsh-artel-surface__title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  color: var(--a-fg);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dsh-artel-surface__spacer { flex: 1 1 auto; min-width: 8px; }
.dsh-artel-surface__body { display: flex; flex: 1 1 auto; min-height: 0; }

/* Rail ------------------------------------------------------------------- */
.dsh-artel-rail {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 236px;
  min-width: 236px;
  min-height: 0;
  border-right: 1px solid var(--a-line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.024), rgba(255, 255, 255, 0.006));
}
.dsh-artel-rail__head { padding: 14px 12px 10px; }
.dsh-artel-rail__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 10px;
  padding: 0 4px;
  color: var(--a-fg-2);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.dsh-artel-rail__new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  height: 34px;
  border: 1px solid rgba(124, 108, 255, 0.42);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.26), rgba(124, 108, 255, 0.12));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 8px 20px -14px rgba(124, 108, 255, 0.9);
  color: #ded8ff;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 150ms var(--a-ease), box-shadow 150ms var(--a-ease), transform 150ms var(--a-ease);
}
.dsh-artel-rail__new:hover {
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.36), rgba(124, 108, 255, 0.18));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 12px 26px -14px rgba(124, 108, 255, 1);
  transform: translateY(-1px);
  color: #fff;
}
.dsh-artel-rail__new:active { transform: translateY(0); }
.dsh-artel-rail__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; scrollbar-width: thin; }
.dsh-artel-rail__group { margin: 12px 0 2px; }
.dsh-artel-rail__group-label {
  overflow: hidden;
  padding: 0 8px 6px;
  color: var(--a-fg-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.dsh-artel-rail__empty { padding: 14px 10px; color: var(--a-fg-3); font-size: 12px; }
.dsh-artel-rail__footer {
  display: flex;
  flex: none;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--a-line);
  color: var(--a-fg-3);
  font-size: 10.5px;
}
.dsh-artel-rail__footer span + span::before { content: "·"; margin-right: 6px; opacity: 0.6; }

.dsh-artel-row {
  position: relative;
  display: block;
  width: 100%;
  margin: 3px 0;
  padding: 9px 10px 9px 13px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 150ms var(--a-ease), border-color 150ms var(--a-ease), transform 150ms var(--a-ease);
}
.dsh-artel-row::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 11px;
  bottom: 11px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 150ms var(--a-ease);
}
.dsh-artel-row:hover { border-color: var(--a-line); background: rgba(255, 255, 255, 0.05); }
.dsh-artel-row[data-active="true"] {
  border-color: rgba(124, 108, 255, 0.34);
  background: linear-gradient(120deg, rgba(124, 108, 255, 0.2), rgba(124, 108, 255, 0.05));
  box-shadow: 0 10px 24px -18px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.dsh-artel-row[data-active="true"]::before { background: var(--a-grad); }
.dsh-artel-row__top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dsh-artel-row__title {
  display: -webkit-box;
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--a-fg);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dsh-artel-row__meta {
  overflow: hidden;
  margin-top: 4px;
  padding-left: 14px;
  color: var(--a-fg-3);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Workspace + hero ------------------------------------------------------- */
.dsh-artel-workspace { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-artel-hero {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 40px 44px 36px;
}
.dsh-artel-hero__title {
  margin: 0 0 22px;
  color: var(--a-fg);
  font-size: 30px;
  font-weight: 620;
  line-height: 1.14;
  letter-spacing: -0.03em;
  text-wrap: balance;
}
.dsh-artel-hero__title em { font-style: normal; color: #a795ff; }
.dsh-artel-card {
  border: 1px solid var(--a-line-2);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.015));
  box-shadow: 0 24px 60px -34px rgba(0, 0, 0, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  transition: border-color 180ms var(--a-ease), box-shadow 180ms var(--a-ease);
}
.dsh-artel-hero__composer { padding: 14px 14px 12px; }
.dsh-artel-hero__composer:focus-within {
  border-color: rgba(124, 108, 255, 0.55);
  box-shadow: 0 0 0 4px rgba(124, 108, 255, 0.12), 0 28px 70px -34px rgba(0, 0, 0, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.dsh-artel-hero__textarea {
  display: block;
  width: 100%;
  min-height: 104px;
  max-height: 260px;
  padding: 6px 4px;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--a-fg);
  font: inherit;
  font-size: 14.5px;
  line-height: 1.6;
}
.dsh-artel-hero__textarea::placeholder { color: var(--a-fg-3); }
.dsh-artel-hero__textarea:focus-visible { outline: 0; }
.dsh-artel-hero__models {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  margin-top: 6px;
  padding: 12px 2px 2px;
  border-top: 1px solid var(--a-line);
}
.dsh-artel-hero__modelHint { padding: 10px 2px 0; color: var(--a-fg-3); font-size: 10.5px; line-height: 1.45; }
.dsh-artel-hero__fusion { align-items: flex-start; }
.dsh-artel-hero__fusion-title {
  flex-basis: 100%;
  color: var(--a-fg-3);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  line-height: 1.3;
  text-transform: uppercase;
}
.dsh-artel-model-pick__pair { display: flex; align-items: center; gap: 4px; }
.dsh-artel-model-pick__select--effort { min-width: 84px; }
.dsh-artel-model-pick {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  padding: 5px 8px 5px 11px;
  border: 1px solid var(--a-line-2);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.035);
  cursor: pointer;
  transition: background 140ms var(--a-ease), border-color 140ms var(--a-ease);
}
.dsh-artel-model-pick:hover { border-color: rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.07); }
.dsh-artel-model-pick:has(.dsh-artel-select:focus-visible) {
  border-color: rgba(124, 108, 255, 0.55);
  background: rgba(255, 255, 255, 0.06);
}
.dsh-artel-model-pick:has(.dsh-artel-select[data-open="true"]) {
  border-color: rgba(124, 108, 255, 0.55);
  background: rgba(124, 108, 255, 0.12);
}
.dsh-artel-model-pick__label {
  color: var(--a-fg-2);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  line-height: 1.3;
  text-transform: uppercase;
}
.dsh-artel-hero__toolbar { display: flex; align-items: center; gap: 10px; padding: 14px 2px 2px; }
.dsh-artel-hero__mode-hint { color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-hero__hint { margin: 16px 2px 0; color: var(--a-fg-3); font-size: 11px; line-height: 1.55; }
.dsh-artel-hero__hint kbd {
  padding: 1px 5px;
  border: 1px solid var(--a-line-2);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--a-fg-2);
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  font-size: 10px;
}
.dsh-artel-hero__foot { display: flex; align-items: center; gap: 10px; margin-top: 16px; }

/* Controls --------------------------------------------------------------- */
.dsh-artel-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--a-line);
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.32);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
}
.dsh-artel-segmented__option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: background 150ms var(--a-ease), color 150ms var(--a-ease), box-shadow 150ms var(--a-ease);
}
.dsh-artel-segmented__option:hover { color: var(--a-fg); background: rgba(255, 255, 255, 0.05); }
.dsh-artel-segmented__option[data-selected="true"] {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.08));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.22);
  color: #fff;
}
.dsh-artel-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: var(--a-fg-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: background 150ms var(--a-ease), color 150ms var(--a-ease), transform 150ms var(--a-ease), box-shadow 150ms var(--a-ease), filter 150ms var(--a-ease);
}
.dsh-artel-btn:hover { background: rgba(255, 255, 255, 0.07); color: var(--a-fg); }
.dsh-artel-btn[disabled] { cursor: default; opacity: 0.5; }
.dsh-artel-btn[disabled]:hover { background: transparent; color: var(--a-fg-2); }
.dsh-artel-btn--primary {
  height: 38px;
  padding: 0 18px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  background: var(--a-grad);
  box-shadow: 0 12px 26px -12px rgba(124, 108, 255, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.3);
  color: #fff;
  font-weight: 600;
}
.dsh-artel-btn--primary:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
  background: var(--a-grad);
  box-shadow: 0 16px 30px -12px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.32);
}
.dsh-artel-btn--primary:active { transform: translateY(0); }
.dsh-artel-btn--primary[disabled] { filter: saturate(0.5); box-shadow: none; transform: none; }
.dsh-artel-btn--primary[disabled]:hover { background: var(--a-grad); color: #fff; }
.dsh-artel-btn--danger { border-color: rgba(255, 120, 120, 0.3); color: #ff9e9e; }
.dsh-artel-btn--danger:hover { border-color: rgba(255, 120, 120, 0.5); background: rgba(255, 110, 110, 0.14); color: #ffc0c0; }

/* Run header ------------------------------------------------------------- */
.dsh-artel-run { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-artel-run__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--a-line);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent);
}
.dsh-artel-run__head-main { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.dsh-artel-run__task {
  overflow: hidden;
  color: var(--a-fg);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.012em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-artel-run__sub { display: flex; align-items: center; gap: 7px; min-width: 0; margin-top: 6px; color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-run__phase { overflow: hidden; min-width: 0; color: var(--a-fg-3); text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-run__waiting {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  max-width: 46%;
  padding: 2px 8px 2px 6px;
  border: 1px solid rgba(240, 180, 92, 0.3);
  border-radius: 999px;
  background: rgba(240, 180, 92, 0.1);
  color: #f3c98f;
  font-size: 11px;
}
.dsh-artel-run__waiting[data-kind='agents'] {
  border-color: rgba(124, 108, 255, 0.32);
  background: rgba(124, 108, 255, 0.12);
  color: #c4b9ff;
}
.dsh-artel-run__waiting-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-run__waiting-clock { flex: none; opacity: 0.7; font-variant-numeric: tabular-nums; }
.dsh-artel-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--a-line-2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--a-fg-2);
  font-size: 10.5px;
  font-weight: 500;
  white-space: nowrap;
}
.dsh-artel-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--a-line-2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--a-fg-2);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.dsh-artel-pill[data-tone="active"] { border-color: rgba(124, 108, 255, 0.4); background: rgba(124, 108, 255, 0.16); color: #d6ccff; }
.dsh-artel-pill[data-tone="ok"] { border-color: rgba(96, 205, 150, 0.34); background: rgba(96, 205, 150, 0.12); color: #aef0cb; }
.dsh-artel-pill[data-tone="warn"] { border-color: rgba(235, 190, 100, 0.36); background: rgba(235, 190, 100, 0.12); color: #f5dda8; }
.dsh-artel-pill[data-tone="error"] { border-color: rgba(255, 120, 120, 0.36); background: rgba(255, 120, 120, 0.12); color: #ffbcbc; }
.dsh-artel-run__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px 8px; scrollbar-width: thin; }
.dsh-artel-run__feed { display: flex; flex-direction: column; gap: 8px; max-width: 780px; margin: 0 auto; }
.dsh-artel-run__empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 34px;
  color: var(--a-fg-3);
  font-size: 12.5px;
  text-align: center;
}

/* Per-agent route bar ---------------------------------------------------- */
.dsh-artel-models {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--a-line);
  background: rgba(255, 255, 255, 0.012);
}
.dsh-artel-models__row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px 4px 6px;
  border: 1px solid var(--a-line-2);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.032);
  transition: border-color 140ms var(--a-ease), background 140ms var(--a-ease);
}
.dsh-artel-models__row:hover { border-color: rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.06); }
.dsh-artel-models__row .dsh-artel-avatar {
  width: 18px;
  height: 18px;
  font-size: 9px;
  box-shadow: none;
}
.dsh-artel-models__name {
  color: var(--a-fg);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.dsh-artel-models__role {
  max-width: 120px;
  overflow: hidden;
  color: var(--a-fg-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-artel-models__select { max-width: 168px; }
.dsh-artel-models__select--effort { max-width: 112px; }
.dsh-artel-models__saving { color: var(--a-fg-3); font-size: 10px; animation: dsh-artel-pulse 1.2s ease-in-out infinite; }

/* Feed ------------------------------------------------------------------- */
.dsh-artel-msg {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 14px;
  animation: dsh-artel-rise 260ms var(--a-ease) both;
  transition: background 150ms var(--a-ease), border-color 150ms var(--a-ease);
}
.dsh-artel-msg:hover { border-color: var(--a-line); background: rgba(255, 255, 255, 0.022); }
.dsh-artel-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16), 0 4px 12px -6px rgba(0, 0, 0, 0.8);
  color: #12121a;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.dsh-artel-msg__main { min-width: 0; flex: 1 1 auto; }
.dsh-artel-msg__head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dsh-artel-msg__name { color: var(--a-fg); font-size: 12.5px; font-weight: 600; }
.dsh-artel-msg__role {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--a-fg-3);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dsh-artel-msg__time { margin-left: auto; color: var(--a-fg-3); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.75; }
.dsh-artel-msg__body { margin-top: 3px; color: #dcdce7; font-size: 12.8px; line-height: 1.62; overflow-wrap: anywhere; }
.dsh-artel-msg__body p { margin: 0 0 7px; }
.dsh-artel-msg__body p:last-child { margin-bottom: 0; }
.dsh-artel-msg__body pre {
  overflow-x: auto;
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--a-line);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.38);
  font: 11.5px/1.6 var(--dsw-alias-font-mono, ui-monospace, "SF Mono", Consolas, monospace);
  white-space: pre;
}
.dsh-artel-msg__body code { font-family: var(--dsw-alias-font-mono, ui-monospace, "SF Mono", Consolas, monospace); font-size: 0.94em; }
.dsh-artel-msg__body ul, .dsh-artel-msg__body ol { margin: 5px 0; padding-left: 18px; }
.dsh-artel-msg__body h1, .dsh-artel-msg__body h2, .dsh-artel-msg__body h3 { margin: 10px 0 5px; font-size: 13px; }
.dsh-artel-msg__body a { color: #a99bff; text-underline-offset: 2px; }
.dsh-artel-tools {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 38px;
  padding: 7px 11px;
  border: 1px solid var(--a-line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.018);
}
.dsh-artel-tool { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 2px 0; color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-tool__icon { flex: none; color: var(--a-fg-3); opacity: 0.8; }
.dsh-artel-tool__name {
  padding: 0 6px;
  border-radius: 5px;
  background: rgba(124, 108, 255, 0.12);
  color: #b3a7ff;
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  font-size: 10.5px;
}
.dsh-artel-tool__text { overflow: hidden; flex: 1 1 auto; text-overflow: ellipsis; white-space: nowrap; }
/* A tool row opens onto its own arguments and output; the chevron points at it. */
.dsh-artel-tools__collapse {
  align-self: flex-end;
  padding: 0;
  border: 0;
  background: none;
  color: var(--a-fg-3);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  opacity: 0.7;
}
.dsh-artel-tools__collapse:hover { opacity: 1; }
.dsh-artel-tool--openable { flex-direction: column; align-items: stretch; gap: 0; padding: 0; }
.dsh-artel-tool__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.dsh-artel-tool__head:hover { color: var(--a-fg); }
.dsh-artel-tool__head:hover .dsh-artel-tool__icon { color: #b3a7ff; opacity: 1; }
.dsh-artel-tool__head:focus-visible { outline: 1px solid #7c6cff; outline-offset: 2px; }
.dsh-artel-tool[data-open='true'] .dsh-artel-tool__icon { color: #b3a7ff; opacity: 1; }
.dsh-artel-tool__flag { flex: none; font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.65; }
.dsh-artel-tool__flag[data-tone='error'] { color: #f06d6d; opacity: 1; }
.dsh-artel-tool__body { display: flex; flex-direction: column; gap: 6px; padding: 3px 0 6px 19px; }
.dsh-artel-tool__part { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsh-artel-tool__label {
  color: var(--a-fg-3);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.7;
}
.dsh-artel-tool__code {
  max-height: 220px;
  margin: 0;
  padding: 7px 9px;
  overflow: auto;
  border: 1px solid var(--a-line);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  color: var(--a-fg);
  font-family: var(--dsw-alias-font-mono, ui-monospace, "SF Mono", Consolas, monospace);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-artel-tool__code[data-tone='error'] { border-color: rgba(240, 109, 109, 0.35); color: #f2a4a4; }
/* Live per-agent strip: who is busy, with what, how long, how full the context is. */
.dsh-artel-live {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 12px 8px;
  border-bottom: 1px solid var(--a-line);
  background: rgba(255, 255, 255, 0.012);
}
.dsh-artel-live__head { display: flex; align-items: center; gap: 8px; }
.dsh-artel-live__title {
  color: var(--a-fg-3);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.8;
}
.dsh-artel-live__row { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-live__name {
  overflow: hidden;
  flex: none;
  max-width: 96px;
  color: var(--a-fg);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-artel-live__tool {
  flex: none;
  padding: 0 6px;
  border-radius: 5px;
  background: rgba(124, 108, 255, 0.12);
  color: #b3a7ff;
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  font-size: 10px;
}
.dsh-artel-live__text { overflow: hidden; flex: 1 1 auto; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-live__clock { flex: none; font-variant-numeric: tabular-nums; opacity: 0.75; }
.dsh-artel-live__ctx { display: inline-flex; flex: none; align-items: center; gap: 5px; }
.dsh-artel-live__ctx--empty { opacity: 0.35; }
.dsh-artel-live__bar { display: block; width: 44px; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.09); }
.dsh-artel-live__bar-fill { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7c6cff, #a99bff); }
.dsh-artel-live__ctx[data-tone='mid'] .dsh-artel-live__bar-fill { background: linear-gradient(90deg, #f0b45c, #f7d29a); }
.dsh-artel-live__ctx[data-tone='high'] .dsh-artel-live__bar-fill { background: linear-gradient(90deg, #f06d6d, #f3a1a1); }
.dsh-artel-live__ctx[data-tone='mid'] .dsh-artel-live__pct { color: #f3c98f; }
.dsh-artel-live__ctx[data-tone='high'] .dsh-artel-live__pct { color: #f2a4a4; }
.dsh-artel-live__pct { min-width: 26px; font-size: 10.5px; font-variant-numeric: tabular-nums; text-align: right; }
.dsh-artel-live__used { font-size: 10.5px; font-variant-numeric: tabular-nums; opacity: 0.7; }
.dsh-artel-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 12px 2px 40px;
  color: var(--a-fg-3);
  font-size: 11.5px;
}
.dsh-artel-status-row .dsh-artel-msg__time { margin-left: auto; }
.dsh-artel-plan {
  position: relative;
  margin-left: 38px;
  padding: 10px 13px 10px 15px;
  overflow: hidden;
  border-radius: 12px;
  background: linear-gradient(120deg, rgba(124, 108, 255, 0.14), rgba(124, 108, 255, 0.05));
}
.dsh-artel-plan::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--a-grad); }
.dsh-artel-plan__label {
  color: #b3a7ff;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.dsh-artel-plan__text { margin-top: 4px; color: var(--a-fg-2); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-artel-user { display: flex; justify-content: flex-end; padding: 4px 0; }
.dsh-artel-user__bubble {
  max-width: 76%;
  padding: 9px 14px;
  border: 1px solid rgba(124, 108, 255, 0.32);
  border-radius: 16px 16px 5px 16px;
  background: linear-gradient(135deg, rgba(124, 108, 255, 0.26), rgba(124, 108, 255, 0.12));
  box-shadow: 0 10px 24px -18px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: var(--a-fg);
  font-size: 12.8px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-artel-user__to { display: block; margin-top: 4px; color: #b6acd8; font-size: 10px; }
.dsh-artel-note { margin-left: 38px; padding: 8px 11px; border-radius: 10px; font-size: 11.5px; }
.dsh-artel-note[data-tone="warn"] { border: 1px solid rgba(235, 190, 100, 0.28); background: rgba(235, 190, 100, 0.09); color: #f0daa6; }
.dsh-artel-note[data-tone="error"] { border: 1px solid rgba(255, 120, 120, 0.28); background: rgba(255, 120, 120, 0.09); color: #ffbcbc; }
.dsh-artel-note__label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.9; }
.dsh-artel-peer { margin-left: 38px; color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-peer b { color: var(--a-fg-2); font-weight: 600; }

/* Composer --------------------------------------------------------------- */
.dsh-artel-composer { flex: none; padding: 8px 18px 16px; }
.dsh-artel-composer__card {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 780px;
  margin: 0 auto;
  padding: 7px 7px 7px 14px;
  border: 1px solid var(--a-line-2);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.02));
  box-shadow: 0 18px 40px -30px rgba(0, 0, 0, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  transition: border-color 160ms var(--a-ease), box-shadow 160ms var(--a-ease);
}
.dsh-artel-composer__card:focus-within {
  border-color: rgba(124, 108, 255, 0.55);
  box-shadow: 0 0 0 4px rgba(124, 108, 255, 0.12), 0 18px 40px -30px rgba(0, 0, 0, 0.95);
}
.dsh-artel-composer__input {
  flex: 1 1 auto;
  min-height: 26px;
  max-height: 132px;
  padding: 6px 0;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--a-fg);
  font: inherit;
  font-size: 12.8px;
  line-height: 1.55;
}
.dsh-artel-composer__input::placeholder { color: var(--a-fg-3); }
.dsh-artel-composer__send {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 11px;
  background: var(--a-grad);
  box-shadow: 0 8px 18px -10px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  color: #fff;
  cursor: pointer;
  transition: transform 140ms var(--a-ease), filter 140ms var(--a-ease);
}
.dsh-artel-composer__send:hover:not([disabled]) { transform: translateY(-1px); filter: brightness(1.08); }
.dsh-artel-composer__send[disabled] { cursor: default; opacity: 0.42; box-shadow: none; }
.dsh-artel-composer__foot { display: flex; align-items: center; gap: 10px; max-width: 780px; margin: 7px auto 0; padding: 0 3px; color: var(--a-fg-3); font-size: 10.5px; }
.dsh-artel-composer__hint { margin-left: auto; }
/* A picker is a trigger button plus a Host-painted menu. The native <select>
 * popup is an OS window that ignores every theme token, so the listbox is ours:
 * a translucent rounded panel with grouped captions, rounded rows, a checkmark
 * on the current value and the arrow/Home/End/Enter/Esc keyboard model. */
.dsh-artel-picker { position: relative; display: inline-flex; min-width: 0; }
.dsh-artel-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px 0 7px;
  border: 1px solid var(--a-line-2);
  border-radius: 8px;
  background-color: rgba(0, 0, 0, 0.26);
  color: var(--a-fg-2);
  font: inherit;
  font-size: 10.5px;
  line-height: 1.2;
  outline: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  transition: background-color 140ms var(--a-ease), border-color 140ms var(--a-ease), color 140ms var(--a-ease);
}
.dsh-artel-select:hover {
  border-color: rgba(255, 255, 255, 0.2);
  background-color: rgba(255, 255, 255, 0.05);
  color: var(--a-fg);
}
.dsh-artel-select:focus-visible { outline: 2px solid rgba(124, 108, 255, 0.55); outline-offset: 2px; }
.dsh-artel-select[disabled] { cursor: default; opacity: 0.5; }
.dsh-artel-select[data-open="true"] {
  border-color: rgba(255, 255, 255, 0.24);
  background-color: rgba(255, 255, 255, 0.07);
  color: var(--a-fg);
}
.dsh-artel-select__value { min-width: 0; max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-select__caret { display: inline-flex; flex: none; color: var(--a-fg-3); transition: transform 160ms var(--a-ease); }
.dsh-artel-select[data-open="true"] .dsh-artel-select__caret { transform: rotate(180deg); }
.dsh-artel-menu {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: 40;
  width: max-content;
  min-width: max(100%, 208px);
  max-width: min(340px, 80vw);
  max-height: 300px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding-block: 7px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
  padding: 5px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 14px;
  background-color: rgba(28, 28, 34, 0.72);
  -webkit-backdrop-filter: blur(28px) saturate(190%) contrast(106%);
  backdrop-filter: blur(28px) saturate(190%) contrast(106%);
  box-shadow: 0 26px 64px -20px rgba(0, 0, 0, 0.95), 0 0 0 0.5px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  animation: dsh-artel-menu-in 130ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.dsh-artel-menu[data-placement="down"] { transform-origin: top left; }
.dsh-artel-menu[data-placement="up"] { transform-origin: bottom left; animation-name: dsh-artel-menu-in-up; }
.dsh-artel-menu__group { padding: 2px 0; }
.dsh-artel-menu__group + .dsh-artel-menu__group {
  margin-top: 2px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 4px;
}
.dsh-artel-menu__group-label { padding: 5px 9px 3px 27px; color: var(--a-fg-3); font-size: 10px; font-weight: 600; letter-spacing: 0.01em; }
.dsh-artel-menu__item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 31px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--a-fg);
  font: inherit;
  font-size: 13px;
  font-weight: 450;
  text-align: left;
  cursor: default;
  user-select: none;
  scroll-margin-block: 8px;
}
.dsh-artel-menu__item[data-selected="true"]:not([data-active="true"]) { background: rgba(124, 108, 255, 0.16); }
.dsh-artel-menu__item[data-active="true"] { background: linear-gradient(135deg, #7059ee, #5a47d8 52%, #3474c0); color: #fff; }
.dsh-artel-menu__check { display: inline-flex; flex: none; justify-content: center; width: 14px; color: var(--a-accent); }
.dsh-artel-menu__item[data-active="true"] .dsh-artel-menu__check { color: #fff; }
.dsh-artel-menu__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-menu::-webkit-scrollbar { width: 11px; }
.dsh-artel-menu::-webkit-scrollbar-track { background: transparent; }
.dsh-artel-menu::-webkit-scrollbar-thumb {
  border: 4px solid transparent;
  border-radius: 9px;
  background-color: rgba(255, 255, 255, 0.14);
  background-clip: padding-box;
}
.dsh-artel-menu:hover::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.26); }
@keyframes dsh-artel-menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dsh-artel-menu-in-up {
  from { opacity: 0; transform: translateY(4px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-artel-menu { animation: none; }
  .dsh-artel-select__caret { transition: none; }
}
/* The chip already draws the frame: its trigger is only the value row. */
.dsh-artel-model-pick .dsh-artel-model-pick__select {
  height: auto;
  max-width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background-color: transparent;
  color: var(--a-fg);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
  gap: 5px;
}
.dsh-artel-model-pick .dsh-artel-model-pick__select:hover,
.dsh-artel-model-pick .dsh-artel-model-pick__select[data-open="true"] {
  border-color: transparent;
  background-color: transparent;
  color: var(--a-fg);
}
.dsh-artel-model-pick .dsh-artel-model-pick__select:focus-visible { outline: 0; }
.dsh-artel-model-pick .dsh-artel-select__value { max-width: 196px; }
.dsh-artel-models__row .dsh-artel-select {
  height: 24px;
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  background-color: transparent;
  color: var(--a-fg-2);
  font-size: 11px;
}
.dsh-artel-models__row .dsh-artel-select:hover,
.dsh-artel-models__row .dsh-artel-select[data-open="true"] {
  background-color: rgba(255, 255, 255, 0.06);
  color: var(--a-fg);
}
.dsh-artel-models__row .dsh-artel-select--effort { color: #b3a7ff; }
.dsh-artel-models__row .dsh-artel-select .dsh-artel-select__value { max-width: 150px; }
.dsh-artel-composer__foot .dsh-artel-select { height: 24px; padding: 0 5px; font-size: 10.5px; }

/* Changes card ----------------------------------------------------------- */
.dsh-artel-changes {
  flex: none;
  margin: 8px 18px 0;
  border: 1px solid var(--a-line-2);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015));
  box-shadow: 0 20px 50px -34px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.dsh-artel-changes__head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 8px 6px 14px; }
.dsh-artel-changes__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--a-fg);
  font-size: 12.5px;
  font-weight: 600;
}
.dsh-artel-changes__counts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  font-weight: 500;
}
.dsh-artel-changes__add { color: #6fd79b; }
.dsh-artel-changes__del { color: #ff8f8f; }
.dsh-artel-changes__spacer,
.dsh-artel-changes__grow { flex: 1 1 auto; min-width: 8px; }
.dsh-artel-changes__iconbtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--a-fg-3);
  font: inherit;
  cursor: pointer;
  transition: background 140ms var(--a-ease), color 140ms var(--a-ease);
}
.dsh-artel-changes__iconbtn:hover { background: rgba(255, 255, 255, 0.07); color: var(--a-fg); }
.dsh-artel-changes__iconbtn[disabled] { opacity: 0.5; cursor: default; }
.dsh-artel-changes__iconbtn[aria-expanded="false"] svg { transform: rotate(-90deg); }
.dsh-artel-changes__body {
  max-height: 36vh;
  overflow-y: auto;
  padding: 6px 8px;
  border-top: 1px solid var(--a-line);
  scrollbar-width: thin;
}
.dsh-artel-changes__files { display: flex; flex-direction: column; gap: 2px; }
.dsh-artel-change-item { display: flex; flex-direction: column; min-width: 0; }
.dsh-artel-change {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 140ms var(--a-ease);
}
.dsh-artel-change:hover { background: rgba(255, 255, 255, 0.055); }
.dsh-artel-change[data-open="true"] { background: rgba(255, 255, 255, 0.065); }
.dsh-artel-change[disabled] { cursor: default; }
.dsh-artel-change__chevron {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 12px;
  color: var(--a-fg-3);
  transition: transform 160ms var(--a-ease);
}
.dsh-artel-change[data-open="true"] .dsh-artel-change__chevron { transform: rotate(90deg); }
.dsh-artel-change__icon { display: inline-flex; flex: none; align-items: center; color: var(--a-fg-3); }
.dsh-artel-change__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--a-fg-2);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-artel-change__status {
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--a-fg-3);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}
.dsh-artel-change__num {
  flex: none;
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-artel-change__num-add { color: #6fd79b; }
.dsh-artel-change__num-del { color: #ff8f8f; }
.dsh-artel-change__num-muted { color: var(--a-fg-3); }
.dsh-artel-changes__empty { display: flex; align-items: center; gap: 8px; padding: 10px 4px; color: var(--a-fg-3); font-size: 12px; }
.dsh-artel-changes__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--a-line);
}
.dsh-artel-changes__question { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-artel-changes__question-title { color: var(--a-fg); font-size: 12px; font-weight: 600; }
.dsh-artel-changes__question-hint { color: var(--a-fg-3); font-size: 11px; overflow-wrap: anywhere; }
.dsh-artel-changes__plate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--a-line);
  color: #6fd79b;
  font-size: 12px;
  font-weight: 500;
}
.dsh-artel-changes__plate[data-tone="muted"] { color: var(--a-fg-2); }
.dsh-artel-changes__plate-hint { min-width: 0; color: var(--a-fg-3); font-size: 11px; font-weight: 400; overflow-wrap: anywhere; }
.dsh-artel-changes__skipped { padding: 0 12px 10px; color: #f0b45c; font-size: 11px; }
.dsh-artel-diff {
  max-height: 300px;
  margin: 3px 8px 10px;
  overflow: auto;
  border: 1px solid var(--a-line);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.32);
}
.dsh-artel-diff__hunk {
  padding: 4px 12px;
  background: rgba(124, 108, 255, 0.12);
  color: #a99bff;
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
  white-space: pre;
}
.dsh-artel-diff__line {
  min-width: max-content;
  padding: 0 12px;
  color: var(--a-fg-2);
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre;
}
.dsh-artel-diff__line[data-type="+"] { background: rgba(96, 205, 150, 0.13); color: #c2f5da; }
.dsh-artel-diff__line[data-type="-"] { background: rgba(255, 110, 110, 0.13); color: #ffcaca; }

/* Orchestrator parts card ------------------------------------------------ */
.dsh-artel-parts {
  flex: none;
  margin: 8px 18px 0;
  border: 1px solid var(--a-line-2);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015));
  box-shadow: 0 20px 50px -34px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.dsh-artel-parts__head { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 8px 6px 14px; }
.dsh-artel-parts__title { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--a-fg); font-size: 12.5px; font-weight: 600; }
.dsh-artel-parts__count { color: var(--a-fg-3); font-size: 11px; font-weight: 500; }
.dsh-artel-parts__spacer { flex: 1 1 auto; min-width: 8px; }
.dsh-artel-parts__body { max-height: 40vh; overflow-y: auto; padding: 4px 12px 10px; border-top: 1px solid var(--a-line); scrollbar-width: thin; }
.dsh-artel-parts__summary { display: flex; flex-direction: column; gap: 3px; padding: 8px 2px 4px; color: var(--a-fg-2); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.dsh-artel-parts__summary-label { color: #b3a7ff; font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.dsh-artel-part { display: flex; flex-direction: column; gap: 6px; padding: 10px 2px; border-top: 1px solid var(--a-line); }
.dsh-artel-part__head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-artel-part__title { flex: 1 1 auto; min-width: 0; color: var(--a-fg); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-artel-part__goal { color: var(--a-fg-2); font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-artel-part__label { color: var(--a-fg-3); font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.dsh-artel-part__conditions { display: flex; flex-direction: column; gap: 4px; }
.dsh-artel-part__list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.dsh-artel-part__condition { display: flex; align-items: flex-start; gap: 6px; color: var(--a-fg-2); font-size: 11.5px; line-height: 1.45; overflow-wrap: anywhere; }
.dsh-artel-part__condition svg { flex: none; margin-top: 2px; color: #6fd79b; }
.dsh-artel-part__files { color: var(--a-fg-3); font-size: 11px; overflow-wrap: anywhere; }
.dsh-artel-part__people { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--a-fg-3); font-size: 11px; }
.dsh-artel-part__rounds { color: #f0b45c; font-size: 11px; }
.dsh-artel-part__remarks { padding: 6px 9px; border-radius: 9px; background: rgba(255, 255, 255, 0.045); color: var(--a-fg-2); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-artel-parts__merge { padding: 8px 2px 0; color: var(--a-fg-3); font-size: 11px; }
.dsh-artel-parts__warning { display: flex; align-items: flex-start; gap: 7px; margin-top: 8px; padding: 8px 11px; border: 1px solid rgba(235, 190, 100, 0.28); border-radius: 10px; background: rgba(235, 190, 100, 0.09); color: #f0daa6; font-size: 11px; line-height: 1.5; }
.dsh-artel-parts__warning svg { flex: none; margin-top: 1px; }
.dsh-artel-changes__merge { display: flex; align-items: center; gap: 7px; padding: 8px 12px; border-top: 1px solid var(--a-line); color: #f0b45c; font-size: 11px; line-height: 1.45; }
.dsh-artel-changes__merge svg { flex: none; }

/* Launcher + status dot -------------------------------------------------- */

/* The launcher is a brand chip, not a spinner. The composer row is shared with
   the host's own state indicators, and a bare 8-ray mark next to a host
   spinner reads as a second loading indicator, so the launcher repeats the
   surface-header identity instead: a violet chip is the only thing the row has
   to explain, and the busy state stays a small status dot in the corner. */
.dsh-artel-launcher {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px 0 7px;
  border: 1px solid rgba(124, 108, 255, 0.32);
  border-radius: 9px;
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.24), rgba(124, 108, 255, 0.1));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
  color: #ece7ff;
  cursor: pointer;
  transition: background 150ms var(--a-ease), color 150ms var(--a-ease), border-color 150ms var(--a-ease), box-shadow 150ms var(--a-ease);
}
.dsh-artel-launcher__label {
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
@container (max-width: 460px) {
  .dsh-artel-launcher { gap: 0; padding: 0; width: 28px; }
  .dsh-artel-launcher__label { display: none; }
}
.dsh-artel-launcher:hover {
  border-color: rgba(124, 108, 255, 0.52);
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.34), rgba(124, 108, 255, 0.16));
  color: #fff;
}
.dsh-artel-launcher:focus-visible {
  outline: 2px solid rgba(124, 108, 255, 0.62);
  outline-offset: 2px;
}
.dsh-artel-launcher[data-active='true'] {
  border-color: rgba(124, 108, 255, 0.62);
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.42), rgba(124, 108, 255, 0.2));
  box-shadow: 0 8px 20px -14px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  color: #fff;
}
.dsh-artel-launcher > .dsh-artel-dot,
.dsh-artel-launcher > span[data-state] {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(11, 12, 16, 0.95);
  pointer-events: none;
}
.dsh-artel-dot {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--a-fg-3);
}
.dsh-artel-dot[data-state='ongoing'] { background: #f0b45c; animation: dsh-artel-pulse 1.4s ease-in-out infinite; }
.dsh-artel-dot[data-state='done'] { background: #63c58b; }
.dsh-artel-dot[data-state='warning'] { background: #f0b45c; }
.dsh-artel-dot[data-state='error'] { background: #f06d6d; }

/* Banners ---------------------------------------------------------------- */
.dsh-artel-banner {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 10px 18px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 120, 120, 0.3);
  border-radius: 12px;
  background: rgba(255, 110, 110, 0.1);
  color: #ffc6c6;
  font-size: 12px;
}
.dsh-artel-banner__body { flex: 1 1 auto; min-width: 0; }
.dsh-artel-banner__title { font-weight: 600; }
.dsh-artel-banner__text { margin-top: 2px; color: #ffd2d2; opacity: 0.88; overflow-wrap: anywhere; }
.dsh-artel-banner__actions { display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-artel-banner--notice { border-color: rgba(124, 108, 255, 0.32); background: rgba(124, 108, 255, 0.1); color: #d9d2ff; }
.dsh-artel-banner--notice .dsh-artel-banner__text { color: #cfc6ff; }
.dsh-artel-spin {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 1.5px solid rgba(255, 255, 255, 0.26);
  border-top-color: rgba(255, 255, 255, 0.92);
  border-radius: 50%;
  animation: dsh-artel-spin 700ms linear infinite;
}
.dsh-artel-hint { color: var(--a-fg-3); font-size: 11px; }

/* Queue («Ожидают» column and the autopilot strip) ----------------------- */
.dsh-artel-queue { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dsh-artel-queue__head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 0; }
.dsh-artel-queue__title { font-size: 11px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--a-fg-3); }
.dsh-artel-queue__count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px; border: 1px solid var(--a-line-2); background: rgba(255, 255, 255, 0.05); color: var(--a-fg-2); font-size: 10.5px; font-weight: 600; }
.dsh-artel-queue__progress { margin-left: auto; color: var(--a-fg-2); font-size: 11px; white-space: nowrap; }
.dsh-artel-queue__progress[data-running="true"] { color: #c9bfff; }
.dsh-artel-switch { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 8px 0 6px; border: 1px solid var(--a-line-2); border-radius: 99px; background: rgba(255, 255, 255, 0.04); color: var(--a-fg-2); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; transition: border-color 140ms var(--a-ease), background 140ms var(--a-ease), color 140ms var(--a-ease); }
.dsh-artel-switch:hover { border-color: rgba(124, 108, 255, 0.5); color: var(--a-fg); }
.dsh-artel-switch__track { position: relative; display: inline-block; width: 24px; height: 13px; border-radius: 99px; background: rgba(255, 255, 255, 0.16); transition: background 160ms var(--a-ease); }
.dsh-artel-switch__knob { position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: #cfd0dc; transition: transform 160ms var(--a-ease), background 160ms var(--a-ease); }
.dsh-artel-switch[data-on="true"] { border-color: rgba(124, 108, 255, 0.45); background: var(--a-accent-soft); color: #d6ccff; }
.dsh-artel-switch[data-on="true"] .dsh-artel-switch__track { background: rgba(124, 108, 255, 0.55); }
.dsh-artel-switch[data-on="true"] .dsh-artel-switch__knob { transform: translateX(11px); background: #fff; }
.dsh-artel-switch[disabled] { opacity: 0.5; cursor: default; }
.dsh-artel-queue__add { display: flex; align-items: center; gap: 6px; }
.dsh-artel-queue__add input { flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 10px; border: 1px solid var(--a-line); border-radius: 10px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 12px; }
.dsh-artel-queue__add input::placeholder { color: var(--a-fg-3); }
.dsh-artel-queue__add input:focus { outline: 0; border-color: rgba(124, 108, 255, 0.55); background: rgba(124, 108, 255, 0.06); }
.dsh-artel-queue__list { display: flex; flex-direction: column; gap: 5px; max-height: 200px; overflow-y: auto; scrollbar-width: thin; }
.dsh-artel-queue__task { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--a-line); border-radius: 10px; background: rgba(255, 255, 255, 0.025); }
.dsh-artel-queue__task[data-status="running"] { border-color: rgba(124, 108, 255, 0.38); background: rgba(124, 108, 255, 0.08); }
.dsh-artel-queue__task[data-status="parked"] { border-color: rgba(255, 120, 120, 0.24); }
.dsh-artel-queue__task[data-status="passed"] { opacity: 0.72; }
.dsh-artel-queue__taskMain { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.dsh-artel-queue__taskTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--a-fg); }
.dsh-artel-queue__taskMeta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--a-fg-3); }
.dsh-artel-queue__taskActions { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.dsh-artel-queue__ico { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--a-fg-3); font: inherit; font-size: 10px; cursor: pointer; }
.dsh-artel-queue__ico:hover { border-color: var(--a-line-2); background: rgba(255, 255, 255, 0.06); color: var(--a-fg); }
.dsh-artel-queue__empty { padding: 10px 2px; color: var(--a-fg-3); font-size: 11.5px; }
.dsh-artel-queue__parked { display: flex; flex-direction: column; gap: 5px; padding-top: 4px; border-top: 1px dashed rgba(255, 120, 120, 0.22); }
.dsh-artel-queue__results { padding: 10px 11px; border: 1px solid rgba(96, 205, 150, 0.26); border-radius: 12px; background: rgba(96, 205, 150, 0.06); }
.dsh-artel-queue__resultsTitle { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; font-size: 12px; font-weight: 650; color: #aef0cb; }
.dsh-artel-queue__resultsLine { color: var(--a-fg-2); font-size: 11.5px; line-height: 1.55; }
.dsh-artel-queue__preflight { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 1px solid rgba(235, 190, 100, 0.3); border-radius: 12px; background: rgba(235, 190, 100, 0.06); }
.dsh-artel-queue__preflightTitle { font-size: 12px; font-weight: 650; color: #f5dda8; }
.dsh-artel-queue__field { display: flex; flex-direction: column; gap: 4px; }
.dsh-artel-queue__label { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--a-fg-3); }
.dsh-artel-queue__check { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--a-fg-2); }
.dsh-artel-queue__check input { accent-color: #7c6cff; }
.dsh-artel-queue__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-artel-queue__hint { color: var(--a-fg-3); font-size: 10.5px; line-height: 1.5; }
.dsh-artel-queue__error { color: #ffbcbc; font-size: 11px; }

/* Factory (ticket board) ------------------------------------------------- */
.dsh-artel-factory { display: flex; flex-direction: column; gap: 10px; min-height: 0; height: 100%; padding: 14px 16px 12px; overflow: hidden; }
.dsh-artel-factory__head { display: flex; align-items: center; gap: 8px; flex: none; }
.dsh-artel-factory__title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-artel-factory__title strong { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.dsh-artel-factory__title span { color: var(--a-fg-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-factory__headTools { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.dsh-artel-factory__body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.dsh-artel-factory__columns { flex: 1 1 auto; min-height: 0; display: flex; gap: 10px; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; scrollbar-width: thin; }
.dsh-artel-factory__column { display: flex; flex-direction: column; gap: 7px; flex: 1 0 190px; min-width: 190px; max-width: 290px; min-height: 0; padding: 8px; border: 1px solid var(--a-line); border-radius: 12px; background: rgba(255, 255, 255, 0.018); }
.dsh-artel-factory__column[data-waiting="true"] { border-color: rgba(235, 190, 100, 0.26); background: rgba(235, 190, 100, 0.035); }
.dsh-artel-factory__columnHead { display: flex; align-items: center; gap: 6px; padding: 0 2px; }
.dsh-artel-factory__columnTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--a-fg-3); }
.dsh-artel-factory__columnCount { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 99px; border: 1px solid var(--a-line-2); color: var(--a-fg-2); font-size: 10px; font-weight: 600; }
.dsh-artel-factory__cards { display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.dsh-artel-factory__card { position: relative; display: flex; flex-direction: column; gap: 5px; padding: 8px 9px; border: 1px solid var(--a-line); border-radius: 10px; background: rgba(255, 255, 255, 0.035); color: var(--a-fg); text-align: left; font: inherit; cursor: pointer; transition: border-color 140ms var(--a-ease), background 140ms var(--a-ease), transform 140ms var(--a-ease); }
.dsh-artel-factory__card:hover { border-color: rgba(124, 108, 255, 0.4); background: rgba(124, 108, 255, 0.07); transform: translateY(-1px); }
.dsh-artel-factory__card[data-active="true"] { border-color: rgba(124, 108, 255, 0.55); background: rgba(124, 108, 255, 0.11); }
.dsh-artel-factory__card[data-waiting="true"] { border-color: rgba(235, 190, 100, 0.34); }
.dsh-artel-factory__cardTop { display: flex; align-items: center; gap: 6px; }
.dsh-artel-factory__num { color: var(--a-fg-3); font-size: 10.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dsh-artel-factory__cardTitle { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12px; line-height: 1.4; }
.dsh-artel-factory__cardMeta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: var(--a-fg-3); font-size: 10.5px; }
.dsh-artel-factory__badge { display: inline-flex; align-items: center; gap: 4px; height: 17px; padding: 0 6px; border: 1px solid var(--a-line-2); border-radius: 99px; background: rgba(255, 255, 255, 0.04); color: var(--a-fg-2); font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em; }
.dsh-artel-factory__badge[data-tone="wait"] { border-color: rgba(235, 190, 100, 0.36); background: rgba(235, 190, 100, 0.1); color: #f5dda8; }
.dsh-artel-factory__badge[data-tone="repair"] { border-color: rgba(255, 120, 120, 0.34); background: rgba(255, 120, 120, 0.09); color: #ffbcbc; }
.dsh-artel-factory__badge[data-tone="ok"] { border-color: rgba(96, 205, 150, 0.3); background: rgba(96, 205, 150, 0.09); color: #aef0cb; }
.dsh-artel-factory__repair { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px dashed rgba(255, 120, 120, 0.36); border-radius: 8px; color: #ffbcbc; font-size: 10px; }
.dsh-artel-factory__repair::before { content: "↩"; font-size: 12px; }
.dsh-artel-factory__empty { padding: 10px 2px; color: var(--a-fg-3); font-size: 11px; }
.dsh-artel-factory__incoming { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--a-line); border-radius: 10px; background: rgba(255, 255, 255, 0.02); }
.dsh-artel-factory__incoming input,
.dsh-artel-factory__incoming textarea { width: 100%; min-width: 0; padding: 6px 8px; border: 1px solid var(--a-line); border-radius: 8px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 11.5px; resize: vertical; }
.dsh-artel-factory__incoming textarea { min-height: 54px; }
.dsh-artel-factory__incoming input::placeholder,
.dsh-artel-factory__incoming textarea::placeholder { color: var(--a-fg-3); }
.dsh-artel-factory__incoming input:focus,
.dsh-artel-factory__incoming textarea:focus { outline: 0; border-color: rgba(124, 108, 255, 0.5); }
.dsh-artel-factory__incomingRow { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dsh-artel-factory__incomingRow input { flex: 1 1 90px; }
.dsh-artel-factory__import { display: flex; flex-direction: column; gap: 5px; padding-top: 6px; border-top: 1px solid var(--a-line); }
.dsh-artel-factory__importError { color: #ffd2d2; font-size: 10.5px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-artel-factory__log { flex: none; max-height: 96px; overflow-y: auto; padding: 8px 10px; border: 1px solid var(--a-line); border-radius: 10px; background: rgba(0, 0, 0, 0.18); scrollbar-width: thin; }
.dsh-artel-factory__logTitle { margin-bottom: 4px; color: var(--a-fg-3); font-size: 9.5px; font-weight: 650; letter-spacing: 0.09em; text-transform: uppercase; }
.dsh-artel-factory__logRow { display: flex; gap: 7px; font-size: 10.5px; line-height: 1.55; color: var(--a-fg-2); }
.dsh-artel-factory__logTime { flex: none; color: var(--a-fg-3); font-variant-numeric: tabular-nums; }
.dsh-artel-factory__detail { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; }
.dsh-artel-factory__detailHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-artel-factory__detailTitle { font-size: 14px; font-weight: 650; }
.dsh-artel-factory__section { display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; border: 1px solid var(--a-line); border-radius: 11px; background: rgba(255, 255, 255, 0.022); }
.dsh-artel-factory__sectionTitle { color: var(--a-fg-3); font-size: 9.5px; font-weight: 650; letter-spacing: 0.09em; text-transform: uppercase; }
.dsh-artel-factory__criteria { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.dsh-artel-factory__criteria li { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5; color: var(--a-fg-2); }
.dsh-artel-factory__criteria li::before { content: "○"; flex: none; color: var(--a-fg-3); }
.dsh-artel-factory__criteria li[data-met="true"]::before { content: "●"; color: #aef0cb; }
.dsh-artel-factory__criteria li[data-met="false"]::before { content: "●"; color: #ffbcbc; }
.dsh-artel-factory__actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dsh-artel-factory__actions input,
.dsh-artel-factory__actions textarea { flex: 1 1 220px; min-width: 0; padding: 7px 9px; border: 1px solid var(--a-line); border-radius: 9px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 12px; }
.dsh-artel-factory__actions textarea { min-height: 48px; resize: vertical; }
.dsh-artel-factory__actions input:focus,
.dsh-artel-factory__actions textarea:focus { outline: 0; border-color: rgba(124, 108, 255, 0.5); }
.dsh-artel-factory__settings { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; scrollbar-width: thin; }
.dsh-artel-factory__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.dsh-artel-factory__field { display: flex; flex-direction: column; gap: 4px; }
.dsh-artel-factory__field > span { color: var(--a-fg-3); font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.dsh-artel-factory__field input,
.dsh-artel-factory__field select { height: 28px; padding: 0 8px; border: 1px solid var(--a-line); border-radius: 8px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 11.5px; }
.dsh-artel-factory__field select { appearance: none; }
.dsh-artel-factory__field input:focus,
.dsh-artel-factory__field select:focus { outline: 0; border-color: rgba(124, 108, 255, 0.5); }
.dsh-artel-factory__checks { display: flex; flex-direction: column; gap: 4px; }
.dsh-artel-factory__checks label { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--a-fg-2); }
.dsh-artel-factory__checks input { accent-color: #7c6cff; }
.dsh-artel-factory__problems { margin: 0; padding-left: 16px; color: #ffbcbc; font-size: 11px; line-height: 1.6; }
.dsh-artel-factory__tracker { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--a-fg-2); }
.dsh-artel-factory__hint { color: var(--a-fg-3); font-size: 10.5px; line-height: 1.5; }
.dsh-artel-factory__error { color: #ffbcbc; font-size: 11px; }
.dsh-artel-factory__feed { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; scrollbar-width: thin; }

/* Queue & factory add-ons (0.8.0) --------------------------------------- */
.dsh-artel-input { height: 30px; min-width: 0; padding: 0 9px; border: 1px solid var(--a-line); border-radius: 9px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 12px; }
.dsh-artel-input::placeholder { color: var(--a-fg-3); }
.dsh-artel-input:focus { outline: 0; border-color: rgba(124, 108, 255, 0.55); background: rgba(124, 108, 255, 0.06); }
.dsh-artel-btn--ghost { height: 24px; min-width: 24px; padding: 0 6px; border-color: transparent; background: transparent; color: var(--a-fg-2); }
.dsh-artel-btn--ghost:hover { border-color: var(--a-line-2); background: rgba(255, 255, 255, 0.06); color: var(--a-fg); }
.dsh-artel-btn[data-active="true"] { border-color: rgba(124, 108, 255, 0.6); background: rgba(124, 108, 255, 0.16); color: #d9d2ff; }
.dsh-artel-queue[data-variant="hero"] { margin-top: 14px; }
.dsh-artel-queue__progress { width: 0; height: 0; margin: 0; overflow: hidden; }
.dsh-artel-queue__switchRow { display: inline-flex; align-items: center; gap: 7px; }
.dsh-artel-queue__switchLabel { font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--a-fg-3); }
.dsh-artel-queue__more { align-self: flex-start; color: var(--a-fg-3); font-size: 10.5px; }
.dsh-artel-queue__field--narrow { width: 96px; }
.dsh-artel-rail__factory { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border: 1px solid var(--a-line); border-radius: 99px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg-2); font: inherit; font-size: 11px; cursor: pointer; }
.dsh-artel-rail__factory:hover { border-color: var(--a-line-2); background: rgba(255, 255, 255, 0.07); color: var(--a-fg); }
.dsh-artel-rail__factory[data-active="true"] { border-color: rgba(124, 108, 255, 0.55); background: rgba(124, 108, 255, 0.16); color: #d9d2ff; }
.dsh-artel-factory__bottom { display: flex; gap: 10px; align-items: stretch; min-height: 0; }
.dsh-artel-factory__bottom .dsh-artel-factory__incoming { flex: 1 1 auto; }
.dsh-artel-factory__bottom .dsh-artel-factory__log { flex: 0 0 220px; }
.dsh-artel-factory__textarea { width: 100%; min-height: 54px; padding: 7px 9px; border: 1px solid var(--a-line); border-radius: 9px; background: rgba(255, 255, 255, 0.03); color: var(--a-fg); font: inherit; font-size: 12px; resize: vertical; }
.dsh-artel-factory__textarea:focus { outline: 0; border-color: rgba(124, 108, 255, 0.5); }
.dsh-artel-factory__attach { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.dsh-artel-factory__link { color: #c9bfff; font-size: 11px; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
.dsh-artel-factory__emptyState { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 20px; text-align: center; }
.dsh-artel-factory__emptyTitle { font-size: 16px; font-weight: 650; }
.dsh-artel-factory__line { color: var(--a-fg-2); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.dsh-artel-factory__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-artel-factory__label { flex: 0 0 128px; color: var(--a-fg-3); font-size: 10.5px; }
.dsh-artel-factory__row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dsh-artel-factory__check { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--a-fg-2); }
.dsh-artel-factory__check input { accent-color: #7c6cff; }
.dsh-artel-factory__check--enabled { margin-top: 4px; font-size: 12px; color: var(--a-fg); }
.dsh-artel-factory__headTools { display: inline-flex; align-items: center; gap: 6px; }
.dsh-artel-factory__checks .dsh-artel-factory__row[data-ok="true"] .dsh-artel-factory__checkLabel { color: var(--a-fg-2); }
.dsh-artel-factory__checks .dsh-artel-factory__row[data-ok="false"] .dsh-artel-factory__checkLabel { color: #f5dda8; }
.dsh-artel-factory__checks .dsh-artel-factory__row[data-blocking="true"] .dsh-artel-factory__checkLabel { color: #ffbcbc; }

/* Responsive ------------------------------------------------------------- */
@media (max-width: 760px) {
  .dsh-artel-rail { width: 200px; min-width: 200px; }
  .dsh-artel-hero__mode-hint { display: none; }
  .dsh-artel-hero { padding: 28px 22px; }
  .dsh-artel-hero__title { font-size: 24px; }
  .dsh-artel-models { padding: 8px 12px; }
}


@media (prefers-reduced-motion: reduce) {
  .dsh-artel-spin { animation: none; }
  .dsh-artel-dot[data-state='ongoing'] { animation: none; }
  .dsh-artel-msg { animation: none; }
  .dsh-artel-surface * { transition: none !important; }
}
`

    /** Inject the plugin stylesheet once per page. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-artel-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-artel-style'
      style.setAttribute('data-plugin', PACKAGE_ID)
      style.setAttribute('data-plugin-css', PACKAGE_ID + '/client.css')
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- api */

    /** Resolve the HTTP prefix against the page base (also under sub-paths). */
    function resolveApiBase(baseUri) {
      try {
        return new URL(API_PREFIX, baseUri ?? document.baseURI).toString().replace(/\/$/, '')
      } catch {
        return API_PREFIX
      }
    }

    /** Build the fetch wrapper used by the client surface. */
    function createApi(tt) {
      const base = resolveApiBase()
      const t = typeof tt === 'function' ? tt : (key) => DICTIONARIES.en[key] ?? key

      async function request(method, path, body, options) {
        const opts = options ?? {}
        const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(base + path, {
            method,
            headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller === undefined ? undefined : controller.signal,
          })
          const text = await response.text()
          let payload = null
          if (text !== '') {
            try { payload = JSON.parse(text) } catch { payload = null }
          }
          if (!response.ok) {
            /* The Host answers `{ error: <message>, code }`; older routes sent only
               `{ error: <code> }`. Read both shapes so the message is not lost. */
            const payloadCode = payload && typeof payload.code === 'string' ? payload.code : undefined
            const payloadError = payload && typeof payload.error === 'string' ? payload.error : undefined
            let code = payloadCode ?? payloadError
            let message = payload && typeof payload.message === 'string' ? payload.message : ''
            if (message === '' && payloadCode !== undefined && payloadError !== undefined) message = payloadError
            if (message === '') message = response.statusText || ('HTTP ' + response.status)
            const error = new Error(message)
            error.status = response.status
            error.code = code
            throw error
          }
          return payload
        } catch (reason) {
          if (reason instanceof Error && reason.name === 'AbortError') {
            const error = new Error(t('error.timeout'))
            error.code = 'timeout'
            throw error
          }
          throw reason
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }

      return {
        base,
        request,
        health: () => request('GET', '/health'),
        models: () => request('GET', '/models', undefined, { timeoutMs: 20000 }),
        project: (sessionId) => request('GET', '/project?sessionId=' + encodeURIComponent(sessionId)),
        listRuns: (sessionId) => request('GET', '/runs?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 15000 }),
        startRun: (payload) => request('POST', '/runs', payload, { timeoutMs: 180000 }),
        getRun: (runId, cursor, limit) =>
          request('GET', '/runs/' + encodeURIComponent(runId) + '?cursor=' + encodeURIComponent(String(cursor ?? 0)) + '&limit=' + encodeURIComponent(String(limit ?? 200)), undefined, { timeoutMs: 15000 }),
        sendMessage: (runId, text, agentId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/messages', agentId === undefined ? { text } : { text, agentId }, { timeoutMs: 30000 }),
        setAgentModel: (runId, agentId, model) => request('POST', '/runs/' + encodeURIComponent(runId) + '/agents/' + encodeURIComponent(agentId) + '/model', { model }, { timeoutMs: 30000 }),
        interrupt: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/interrupt', {}, { timeoutMs: 30000 }),
        changes: (runId) => request('GET', '/runs/' + encodeURIComponent(runId) + '/changes', undefined, { timeoutMs: 180000 }),
        diff: (runId, path) => request('GET', '/runs/' + encodeURIComponent(runId) + '/diff?path=' + encodeURIComponent(path)),
        apply: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/apply', {}, { timeoutMs: 180000 }),
        discard: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/discard', {}, { timeoutMs: 180000 }),
        // «Автоочередь» ---------------------------------------------------
        queue: (sessionId, projectPath) =>
          request('GET', '/queue?sessionId=' + encodeURIComponent(sessionId) + (projectPath ? '&projectPath=' + encodeURIComponent(projectPath) : ''), undefined, { timeoutMs: 15000 }),
        queueAdd: (payload) => request('POST', '/queue', payload, { timeoutMs: 30000 }),
        queuePreflight: (sessionId, projectPath) =>
          request('GET', '/queue/preflight?sessionId=' + encodeURIComponent(sessionId) + (projectPath ? '&projectPath=' + encodeURIComponent(projectPath) : ''), undefined, { timeoutMs: 20000 }),
        setQueueAutopilot: (payload) => request('POST', '/queue/autopilot', payload, { timeoutMs: 30000 }),
        queueStop: (sessionId) => request('POST', '/queue/stop', { sessionId }, { timeoutMs: 30000 }),
        queueFinishAfterCurrent: (sessionId) => request('POST', '/queue/finish-after-current', { sessionId }, { timeoutMs: 30000 }),
        queueClear: (sessionId) => request('POST', '/queue/clear', { sessionId }, { timeoutMs: 30000 }),
        queueRetry: (sessionId, taskId) => request('POST', '/queue/tasks/' + encodeURIComponent(taskId) + '/retry', { sessionId }, { timeoutMs: 30000 }),
        queueRemove: (sessionId, taskId) => request('DELETE', '/queue/tasks/' + encodeURIComponent(taskId) + '?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 30000 }),
        queueMove: (sessionId, taskId, direction) => request('POST', '/queue/tasks/' + encodeURIComponent(taskId) + '/move', { sessionId, direction }, { timeoutMs: 30000 }),
        queueSaveVersion: (sessionId, runId) => request('POST', '/queue/versions/' + encodeURIComponent(runId) + '/save', { sessionId }, { timeoutMs: 30000 }),
        queuePostponeVersion: (sessionId, runId) => request('POST', '/queue/versions/' + encodeURIComponent(runId) + '/postpone', { sessionId }, { timeoutMs: 30000 }),
        // «Фабрика» -------------------------------------------------------
        factoryBoards: () => request('GET', '/factory', undefined, { timeoutMs: 15000 }),
        factoryCreateBoard: (payload) => request('POST', '/factory', payload, { timeoutMs: 30000 }),
        factoryBoard: (boardId) => request('GET', '/factory/' + encodeURIComponent(boardId), undefined, { timeoutMs: 20000 }),
        factorySettings: (boardId, patch) => request('POST', '/factory/' + encodeURIComponent(boardId) + '/settings', patch, { timeoutMs: 60000 }),
        factoryReadiness: (boardId) => request('POST', '/factory/' + encodeURIComponent(boardId) + '/readiness', {}, { timeoutMs: 60000 }),
        factoryPoll: (boardId) => request('POST', '/factory/' + encodeURIComponent(boardId) + '/poll', {}, { timeoutMs: 120000 }),
        factoryPollAll: (boardId) => request('POST', '/factory/poll-trackers', boardId ? { boardId } : {}, { timeoutMs: 120000 }),
        factoryAddTicket: (boardId, payload) => request('POST', '/factory/' + encodeURIComponent(boardId) + '/tickets', payload, { timeoutMs: 120000 }),
        factoryImport: (boardId, ref) => request('POST', '/factory/' + encodeURIComponent(boardId) + '/import', { ref }, { timeoutMs: 120000 }),
        factoryTicket: (boardId, ticketId, cursor) =>
          request('GET', '/factory/' + encodeURIComponent(boardId) + '/tickets/' + encodeURIComponent(ticketId) + '?cursor=' + encodeURIComponent(String(cursor ?? 0)), undefined, { timeoutMs: 15000 }),
        factoryTicketAction: (boardId, ticketId, verb, payload) =>
          request('POST', '/factory/' + encodeURIComponent(boardId) + '/tickets/' + encodeURIComponent(ticketId) + '/' + verb, payload ?? {}, { timeoutMs: 180000 }),
      }
    }

    /** Always-current Host client for the current page. */
    let apiClient = null
    function getApi() {
      if (apiClient === null) apiClient = createApi((key) => DICTIONARIES.en[key] ?? key)
      return apiClient
    }

    /* --------------------------------------------------------------- util */

    const STATUS_TONES = {
      preparing: 'active',
      planning: 'active',
      running: 'active',
      waiting: 'warn',
      finished: 'ok',
      applied: 'ok',
      interrupted: 'warn',
      discarded: 'muted',
      failed: 'error',
    }

    const STATUS_DOTS = {
      preparing: 'ongoing',
      planning: 'ongoing',
      running: 'ongoing',
      waiting: 'warning',
      finished: 'done',
      applied: 'done',
      interrupted: 'warning',
      discarded: 'idle',
      failed: 'error',
    }

    /** Replace `{name}` placeholders in a localized template. */
    function fill(template, values) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
        const value = values?.[key]
        return value === undefined || value === null ? match : String(value)
      })
    }

    /** Last path segment for labels (handles both separators). */
    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /** Human "when" for a timestamp; falls back to a locale time string. */
    function formatWhen(tt, at) {
      const t = typeof tt === 'function' ? tt : (key) => DICTIONARIES.en[key] ?? key
      const timestamp = typeof at === 'number' ? at : at === undefined ? undefined : Date.parse(String(at))
      if (timestamp === undefined || Number.isNaN(timestamp)) return ''
      const delta = Math.max(0, Date.now() - timestamp)
      if (delta < 60 * 1000) return t('time.now')
      if (delta < 60 * 60 * 1000) return fill(t('time.minutes'), { n: Math.round(delta / 60000) })
      if (delta < 24 * 60 * 60 * 1000) return fill(t('time.hours'), { n: Math.round(delta / 3600000) })
      try {
        return new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** Readable reason for a failed request. */
    function describeError(error, tt) {
      const t = typeof tt === 'function' ? tt : (key) => DICTIONARIES.en[key] ?? key
      if (error === undefined || error === null) return ''
      if (typeof error === 'string') return error
      const code = typeof error === 'object' ? error.code : undefined
      if (code === 'restarting') return t('error.restarting')
      if (code === 'unauthorized' || (typeof error === 'object' && error.status === 401)) return t('error.apiMissing')
      if (code === 'not_found' || (typeof error === 'object' && error.status === 404)) return t('error.notFound')
      if (code === 'timeout') return t('error.timeout')
      if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message
      return t('error.title')
    }

    /** Localized reason for a failed GitHub issue import, keyed by its stable code. */
    function importErrorText(error, tt) {
      const t = typeof tt === 'function' ? tt : (key) => DICTIONARIES.en[key] ?? key
      const keys = {
        'factory/bad-issue-ref': 'factory.importError.badRef',
        'factory/gh-missing': 'factory.importError.ghMissing',
        'factory/gh-auth': 'factory.importError.ghAuth',
        'factory/repo-not-found': 'factory.importError.repoNotFound',
        'factory/issue-not-found': 'factory.importError.notFound',
        'factory/issue-unreadable': 'factory.importError.unavailable',
        'factory/issue-unavailable': 'factory.importError.unavailable',
      }
      const key = typeof error?.code === 'string' ? keys[error.code] : undefined
      return key === undefined ? describeError(error, t) : t(key)
    }

    function statusTone(status) {
      return STATUS_TONES[status] ?? 'muted'
    }

    function statusDotState(status) {
      return STATUS_DOTS[status] ?? 'idle'
    }

    function statusLabel(tt, status) {
      const key = 'status.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    function modeLabel(tt, mode) {
      const key = 'mode.' + String(mode ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(mode ?? '') : translated
    }

    /* ------------------------------------------------- queue & factory --- */

    /** Modes the «Автоочередь» accepts (the orchestrator is not a queue mode). */
    const QUEUE_MODE_IDS = ['solo', 'swarm', 'conductor', 'fusion']

    /** Routes a factory board may allow; mirrors FACTORY_ROUTES in lib/factory.js. */
    const FACTORY_ROUTES = ['solo', 'swarm', 'fusion', 'orchestrator']

    /** Ticket trackers the «Приём тикетов» section can poll. */
    const TRACKER_KIND_IDS = ['github', 'gitlab', 'jira', 'linear']

    /** Board columns of the 0.8.0 ticket board (checks collapses three stages). */
    const FACTORY_COLUMN_IDS = ['incoming', 'triage', 'working', 'checks', 'ready', 'waiting', 'done']
    const FACTORY_COLUMNS = [
      { id: 'incoming', waiting: false },
      { id: 'triage', waiting: false },
      { id: 'working', waiting: false },
      { id: 'checks', waiting: false },
      { id: 'ready', waiting: false },
      { id: 'waiting', waiting: true },
      { id: 'done', waiting: false },
    ]
    const FACTORY_TEMPLATE_IDS = ['normal', 'fast', 'strict']
    const FACTORY_STAGE_COLUMN = {
      incoming: 'incoming',
      triage: 'triage',
      working: 'working',
      tests: 'checks',
      check: 'checks',
      review: 'checks',
      ready: 'ready',
      waiting: 'waiting',
      done: 'done',
    }

    function queueStatusLabel(tt, status) {
      const key = 'queue.status.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    function queueStatusTone(status) {
      if (status === 'running') return 'active'
      if (status === 'passed') return 'ok'
      if (status === 'parked') return 'error'
      if (status === 'stopped') return 'warn'
      return 'muted'
    }

    /** One-line meta under a queue task title. */
    function queueTaskMeta(tt, task) {
      const bits = [modeLabel(tt, task?.mode)]
      if (task?.status === 'passed') bits.push(fill(tt('queue.resultsVersions'), { n: task.changeCount ?? 0 }))
      if ((task?.questions ?? 0) > 0) bits.push(fill(tt('queue.questions'), { n: task.questions }))
      if ((task?.fixes ?? 0) > 0) bits.push(fill(tt('queue.fixes'), { n: task.fixes }))
      if (task?.check?.skipped === true) bits.push(tt('queue.checkDisabled'))
      if (typeof task?.reason === 'string' && task.reason !== '') bits.push(task.reason)
      return bits.filter(Boolean).join(' · ')
    }

    function factoryColumnLabel(tt, column) {
      const key = 'factory.column.' + String(column ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(column ?? '') : translated
    }

    function factoryStageLabel(tt, stage) {
      const key = 'factory.stage.' + String(stage ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      if (translated !== key && translated !== undefined) return translated
      const column = FACTORY_STAGE_COLUMN[stage]
      return column === undefined ? String(stage ?? '') : factoryColumnLabel(tt, column)
    }

    /** The waiting kinds travel as kebab-case, the dictionary keys are camelCase. */
    function waitingKindKey(kind) {
      return String(kind ?? '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    }

    function factoryWaitingLabel(tt, kind) {
      const key = 'factory.waiting.' + waitingKindKey(kind)
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(kind ?? '') : translated
    }

    function factoryTicketColumn(ticket) {
      if (ticket?.waiting !== null && ticket?.waiting !== undefined) return 'waiting'
      return FACTORY_STAGE_COLUMN[ticket?.stage] ?? 'incoming'
    }

    /** Criteria of the ticket with their review marks: [{ text, met }]. */
    function ticketCriteriaList(ticket) {
      const specCriteria = Array.isArray(ticket?.spec?.criteria) ? ticket.spec.criteria : []
      const reviewCriteria = Array.isArray(ticket?.review?.criteria) ? ticket.review.criteria : []
      return specCriteria.map((item, index) => {
        const text = typeof item === 'string' ? item : String(item?.text ?? '')
        const mark = reviewCriteria[index]
        const met = typeof item === 'object' && item !== null && typeof item.met === 'boolean' ? item.met : typeof mark?.met === 'boolean' ? mark.met : null
        return { text, met }
      })
    }

    function clockLabel(at) {
      const timestamp = typeof at === 'number' ? at : at === undefined ? undefined : Date.parse(String(at))
      if (timestamp === undefined || Number.isNaN(timestamp)) return ''
      try {
        return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function factoryTemplateLabel(tt, id) {
      const key = 'factory.template.' + String(id ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(id ?? '') : translated
    }

    function factoryTemplateHint(tt, id) {
      const key = 'factory.template.' + String(id ?? '') + '.hint'
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? '' : translated
    }

    /** Flatten one catalog into picker rows: `provider/model` with its efforts. */
    function catalogRows(catalog) {
      const rows = []
      const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
      for (const provider of providers) {
        const models = Array.isArray(provider?.models) ? provider.models : []
        for (const model of models) {
          if (typeof model?.id !== 'string' || model.id === '') continue
          rows.push({
            key: String(provider.id) + '/' + model.id,
            provider: provider.id,
            providerName: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
            model: model.id,
            modelName: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
            efforts: Array.isArray(model.efforts) ? model.efforts : [],
            defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : undefined,
          })
        }
      }
      return rows
    }

    /** The picker row a selection names, or undefined when it left the catalog. */
    function catalogRowOf(catalog, selection) {
      if (selection === null || selection === undefined) return undefined
      const key = String(selection.provider ?? '') + '/' + String(selection.model ?? '')
      return catalogRows(catalog).find((row) => row.key === key)
    }

    /** One selection from a picker row, carrying the model's default effort. */
    function selectionFromRow(row) {
      if (row === undefined) return null
      return {
        provider: row.provider,
        model: row.model,
        ...(row.defaultEffort !== undefined ? { reasoningEffort: row.defaultEffort } : {}),
      }
    }

    /** Short `provider/model · effort` label for a selection. */
    function selectionLabel(catalog, selection) {
      const row = catalogRowOf(catalog, selection)
      if (row === undefined) {
        if (selection === null || selection === undefined) return ''
        return [selection.provider, selection.model].filter(Boolean).join('/')
      }
      const effort = typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? ' · ' + selection.reasoningEffort
        : ''
      return row.providerName + '/' + row.modelName + effort
    }

    function agentStatusLabel(tt, status) {
      const key = 'agent.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    /** Localized label for an agent role; unknown roles keep their raw id. */
    function roleLabel(tt, role) {
      const value = role === null || role === undefined || role === '' ? 'agent' : role
      const key = 'role.' + String(value)
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(value) : translated
    }

    /** The run's plan parts, tolerating summaries from before Orchestrator. */
    function planParts(run) {
      const parts = run?.plan?.parts
      return Array.isArray(parts) ? parts.filter((part) => part !== null && part !== undefined) : []
    }

    function partStatusTone(status) {
      return PART_STATUS_TONES[status] ?? 'muted'
    }

    function partStatusLabel(tt, status) {
      const key = 'partStatus.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    /** A non-empty merge.unresolved list means applying would lose work. */
    function mergeBlocked(run) {
      const unresolved = run?.merge?.unresolved
      return Array.isArray(unresolved) && unresolved.length > 0
    }

    /** A run is busy while any agent still works. */
    function isActiveRun(run) {
      return run !== null && run !== undefined && ACTIVE_STATUSES.has(run.status)
    }

    /** Progress share: ordinary modes count finished agents; Orchestrator counts
     *  accepted parts, because its planner/reviewer/merger are not a share of
     *  the work and part agents appear and disappear as the plan advances. */
    function agentProgress(run) {
      if (run?.mode === 'orchestrator') {
        const parts = planParts(run)
        let done = 0
        for (const part of parts) if (part?.status === 'accepted') done += 1
        return { done, total: parts.length }
      }
      const agents = Array.isArray(run?.agents) ? run.agents.filter((agent) => agent?.role !== 'conductor') : []
      let done = 0
      for (const agent of agents) if (agent !== null && agent !== undefined && AGENT_DONE_STATUSES.has(agent.status)) done += 1
      return { done, total: agents.length }
    }

    /** Current phase line for a run: explicit phase or the localized status. */
    function phaseOf(tt, run) {
      if (run !== null && run !== undefined && typeof run.phase === 'string' && run.phase.trim() !== '') return run.phase.trim()
      return statusLabel(tt, run?.status)
    }

    /** Two-line rail meta: `Solo · 3/6 · planning`. */
    function runMeta(tt, run) {
      const progress = agentProgress(run)
      const values = { mode: modeLabel(tt, run?.mode), done: progress.done, total: progress.total, phase: phaseOf(tt, run) }
      if (progress.total === 0) return fill('{mode} · {phase}', values)
      return fill(typeof tt === 'function' ? tt('row.meta') : DICTIONARIES.en['row.meta'], values)
    }

    /* ---------------------------------------------------------- live view */

    /**
     * Compact token count for the agent rows: `812`, `4.2K`, `128K`, `1.3M`.
     * @param {unknown} value - token count.
     * @returns {string} the short form, or an empty string when there is no number.
     */
    function tokenCount(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
      if (number === null) return ''
      if (number < 1000) return String(number)
      const trim = (text) => text.replace(/\.0$/, '')
      if (number < 10000) return trim((number / 1000).toFixed(1)) + 'K'
      if (number < 1000000) return Math.round(number / 1000) + 'K'
      return trim((number / 1000000).toFixed(1)) + 'M'
    }

    /**
     * How full one agent's context is, as a whole percentage.
     *
     * Both halves come from the Host's own token metering — the last sized
     * request against the model's window — so the number matches the ring the
     * chat composer draws.
     * @param {object} agent - run summary agent row.
     * @returns {number | null} 0..100, or null when the Host has not sized a request yet.
     */
    function contextShare(agent) {
      const context = agent?.stats?.context
      const tokens = typeof context?.tokens === 'number' ? context.tokens : null
      const window = typeof context?.window === 'number' && context.window > 0 ? context.window : null
      if (tokens === null || window === null) return null
      return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)))
    }

    /**
     * Composition of one agent's prompt surface: the system prompts, the tool
     * schemas and the messages, as the Host's own `contextBreakdown` projection
     * prices them.
     * @param {object} agent - run summary agent row.
     * @returns {{ system: number, tools: number, messages: number } | null} the composition, or null when the Host has not priced it yet.
     */
    function compositionOf(agent) {
      const parts = agent?.stats?.context?.breakdown
      if (parts === null || parts === undefined) return null
      const numbers = [parts.system, parts.tools, parts.messages]
      if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null
      if (numbers.every((value) => value === 0)) return null
      return { system: parts.system, tools: parts.tools, messages: parts.messages }
    }

    /**
     * Two-line tooltip of one agent's context: occupancy in tokens and percent,
     * then what the prompt is made of.
     * @param {Function} tt - dictionary lookup.
     * @param {object} agent - run summary agent row.
     * @returns {string} the hint, or an empty string when the Host has no number yet.
     */
    function contextHint(tt, agent) {
      const context = agent?.stats?.context
      const share = contextShare(agent)
      const lines = []
      if (share !== null) {
        lines.push(fill(tt('live.context'), { used: tokenCount(context?.tokens), window: tokenCount(context?.window), pct: share }))
      }
      const parts = compositionOf(agent)
      if (parts !== null) {
        lines.push(fill(tt('live.composition'), {
          system: tokenCount(parts.system),
          tools: tokenCount(parts.tools),
          messages: tokenCount(parts.messages),
        }))
      }
      return lines.join('\n')
    }

    /**
     * Elapsed time of one turn or one wait: `12s`, `1:04`, `1:02:03`.
     * @param {unknown} from - start timestamp.
     * @param {number} [now] - end timestamp, defaults to the browser clock.
     * @returns {string} the elapsed form, or an empty string without a start.
     */
    function durationLabel(from, now) {
      if (typeof from !== 'number' || !Number.isFinite(from)) return ''
      const end = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      const seconds = Math.max(0, Math.round((end - from) / 1000))
      const rest = String(seconds % 60).padStart(2, '0')
      if (seconds < 60) return seconds + 's'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ':' + rest
      return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') + ':' + rest
    }

    /**
     * Split the live activity of one agent into the tool badge and its detail,
     * so the row can style them apart. The host stores the same one-line text
     * the feed shows (`write src/app.js`); the name is peeled off here.
     * @param {object} agent - run summary agent row.
     * @returns {{ kind: string, tool: string, text: string } | null} activity, or null when the agent is not doing anything.
     */
    function activityOf(agent) {
      const activity = agent?.activity
      if (activity === null || activity === undefined) return null
      if (activity.kind === 'tool') {
        const tool = String(activity.tool ?? 'tool')
        let text = String(activity.text ?? '')
        if (text.startsWith(tool + ' ')) text = text.slice(tool.length + 1)
        return { kind: 'tool', tool, text }
      }
      return { kind: String(activity.kind ?? ''), tool: '', text: String(activity.text ?? '') }
    }

    /**
     * What the run is waiting for, as one sentence for the header.
     * @param {Function} tt - dictionary lookup.
     * @param {object} run - run summary.
     * @returns {string} the sentence, or an empty string when the run is not waiting.
     */
    function waitingLabel(tt, run) {
      const wait = run?.waitingFor
      if (wait === null || wait === undefined) return ''
      if (wait.kind === 'user') return tt('live.waitUser')
      if (wait.kind === 'approval') return tt('live.waitApproval')
      if (wait.kind === 'agents') {
        const names = Array.isArray(wait.names) ? wait.names.filter((name) => typeof name === 'string' && name.trim() !== '') : []
        if (names.length === 0) return tt('live.waitAgents')
        if (names.length === 1) return fill(tt('live.waitAgent'), { name: names[0] })
        if (names.length === 2) return fill(tt('live.waitAgentTwo'), { a: names[0], b: names[1] })
        return fill(tt('live.waitAgentsNames'), { names: names.join(', ') })
      }
      if (wait.kind === 'host') return tt('live.waitHost')
      return ''
    }

    /** Group runs by their project for the rail. */
    function groupRunsByProject(runs) {
      const groups = new Map()
      for (const run of Array.isArray(runs) ? runs : []) {
        if (run === null || run === undefined) continue
        const key = typeof run.projectPath === 'string' && run.projectPath !== '' ? run.projectPath : ''
        if (!groups.has(key)) groups.set(key, { key, projectPath: key, runs: [] })
        groups.get(key).runs.push(run)
      }
      const list = Array.from(groups.values())
      for (const group of list) group.runs.sort((a, b) => timestampOf(b?.updatedAt) - timestampOf(a?.updatedAt))
      list.sort((a, b) => timestampOf(b.runs[0]?.updatedAt) - timestampOf(a.runs[0]?.updatedAt))
      return list
    }

    function timestampOf(at) {
      if (typeof at === 'number') return at
      if (typeof at === 'string') {
        const parsed = Date.parse(at)
        if (!Number.isNaN(parsed)) return parsed
      }
      return 0
    }

    /** Project label for rail groups / hero: name first, then basename. */
    function projectLabel(tt, run) {
      const path = run?.projectPath
      const name = typeof run?.projectName === 'string' && run.projectName !== '' ? run.projectName : baseName(path)
      return name !== '' ? name : (typeof tt === 'function' ? tt('rail.groupFallback') : DICTIONARIES.en['rail.groupFallback'])
    }

    /**
     * Choose the project shown by the hero: the live Host answer first, then the
     * most recent run, then the session cwd supplied by the shell.
     */
    function chooseProject(project, runs, sessionCwd) {
      const fromProject = project !== null && project !== undefined && typeof project.projectPath === 'string' && project.projectPath !== ''
      if (fromProject) {
        const name = typeof project.name === 'string' && project.name !== '' ? project.name : baseName(project.projectPath)
        return { projectPath: project.projectPath, name }
      }
      const recent = Array.isArray(runs) ? runs.find((run) => run !== null && run !== undefined && typeof run.projectPath === 'string' && run.projectPath !== '') : undefined
      if (recent !== undefined) return { projectPath: recent.projectPath, name: baseName(recent.projectPath) }
      if (typeof sessionCwd === 'string' && sessionCwd !== '') return { projectPath: sessionCwd, name: baseName(sessionCwd) }
      return { projectPath: '', name: '' }
    }

    /** Pick the run to focus after a refresh: current, then stored, then newest. */
    function chooseActiveRunId(runs, preferred) {
      const list = Array.isArray(runs) ? runs : []
      if (preferred !== undefined && preferred !== null && list.some((run) => run?.id === preferred)) return preferred
      return list.length > 0 ? list[0].id : null
    }

    /** Number of summarized events that belong to one agent turn. */
    function changeTotal(runs) {
      let total = 0
      for (const run of Array.isArray(runs) ? runs : []) {
        if (run !== null && run !== undefined && typeof run.changeCount === 'number' && Number.isFinite(run.changeCount)) total += run.changeCount
      }
      return total
    }

    /** Card ordering for change statuses: new files first, binary last. */
    const CHANGE_STATUS_ORDER = ['added', 'modified', 'deleted', 'binary']

    /** True for a run status that still has reviewable changes. */
    function isReviewStatus(status) {
      return REVIEW_STATUSES.has(String(status ?? ''))
    }

    /**
     * The changes card is shown for review statuses, for already decided runs
     * and whenever a count is known. `changeCount` is NOT trustworthy (the Host
     * can report 0 while the copy has edits), so it is only a fallback signal.
     */
    function showsChanges(run) {
      if (run === null || run === undefined) return false
      const status = String(run.status ?? '')
      if (REVIEW_STATUSES.has(status) || status === 'applied' || status === 'discarded') return true
      return typeof run.changeCount === 'number' && run.changeCount > 0
    }

    /** Normalize the `/changes` payload into the shape the card renders. */
    function normalizeChanges(payload) {
      const list = Array.isArray(payload?.changes) ? payload.changes : Array.isArray(payload) ? payload : []
      const changes = []
      for (const entry of list) {
        if (entry === null || entry === undefined || typeof entry.path !== 'string' || entry.path === '') continue
        const known = entry.status === 'added' || entry.status === 'deleted' || entry.status === 'modified' || entry.status === 'binary'
        const binary = entry.binary === true || entry.status === 'binary'
        const status = known ? entry.status : binary ? 'binary' : 'modified'
        const hunks = Array.isArray(entry.hunks) ? entry.hunks.map((hunk) => ({
          header: typeof hunk?.header === 'string' ? hunk.header : '',
          lines: Array.isArray(hunk?.lines)
            ? hunk.lines
              .filter((line) => line !== null && line !== undefined && (line.type === ' ' || line.type === '+' || line.type === '-'))
              .map((line) => ({ type: line.type, text: String(line.text ?? '') }))
            : [],
        })) : []
        changes.push({
          path: entry.path,
          status,
          binary,
          added: Number.isFinite(entry.added) ? Math.max(0, Math.trunc(entry.added)) : 0,
          removed: Number.isFinite(entry.removed) ? Math.max(0, Math.trunc(entry.removed)) : 0,
          hunks,
        })
      }
      return changes
    }

    /** `{ files, added, removed }` totals for the card header. */
    function changeTotals(changes) {
      const list = Array.isArray(changes) ? changes : []
      let added = 0
      let removed = 0
      for (const change of list) {
        if (change === null || change === undefined) continue
        if (Number.isFinite(change.added)) added += Math.max(0, Math.trunc(change.added))
        if (Number.isFinite(change.removed)) removed += Math.max(0, Math.trunc(change.removed))
      }
      return { files: list.length, added, removed }
    }

    /** Group changes by status in display order, sorted by path inside a group. */
    function groupChangesByStatus(changes) {
      const groups = new Map()
      for (const status of CHANGE_STATUS_ORDER) groups.set(status, [])
      for (const change of Array.isArray(changes) ? changes : []) {
        if (change === null || change === undefined) continue
        const status = CHANGE_STATUS_ORDER.includes(change.status) ? change.status : 'modified'
        groups.get(status).push(change)
      }
      const result = []
      for (const status of CHANGE_STATUS_ORDER) {
        const items = groups.get(status)
        if (items.length === 0) continue
        items.sort((left, right) => String(left.path ?? '').localeCompare(String(right.path ?? '')))
        result.push({ status, items })
      }
      return result
    }

    /** Flat file list in card order (new first, binary last). */
    function orderedChanges(changes) {
      const result = []
      for (const group of groupChangesByStatus(changes)) for (const change of group.items) result.push(change)
      return result
    }

    /** Localized label for a file change status. */
    function changeStatusLabel(tt, status) {
      const key = 'changes.file.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    /** Card title with a grammatical count for one/few/many files. */
    function changeTitle(tt, count) {
      const t = typeof tt === 'function' ? tt : (key) => DICTIONARIES.en[key] ?? key
      const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
      if (n === 0) return t('changes.titleZero')
      if (n === 1) return t('changes.titleOne')
      if (n >= 2 && n <= 4) return fill(t('changes.titleFew'), { n })
      return fill(t('changes.title'), { n })
    }

    /** Deterministic avatar tone derived from the agent name. */
    function avatarTone(name) {
      const text = String(name ?? '')
      let hash = 0
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0
      return Math.abs(hash) % 8
    }

    const AVATAR_TONES = ['#c8c2ff', '#a9e3c4', '#f3c99a', '#9fd2ef', '#e9b4dc', '#c9dfa0', '#f0b7a8', '#b8c7f0']

    /**
     * Collapse consecutive tool events of one agent into a single compact group,
     * so the feed reads like a reply stream instead of a log.
     *
     * A tool's own row keeps its result: `tool/result` events (and the errors a
     * failing call reports) are folded into the group that holds their call, so
     * opening a row can show what came back instead of only what went in.
     */
    function feedGroups(events) {
      const groups = []
      /** callId → the tools group that owns that call. */
      const calls = new Map()
      for (const event of Array.isArray(events) ? events : []) {
        if (event === null || event === undefined) continue
        const kind = String(event.kind ?? '')
        const callId = typeof event.callId === 'string' ? event.callId : ''
        if ((kind === 'tool-result' || kind === 'error') && callId !== '') {
          const owner = calls.get(callId)
          if (owner !== undefined) {
            owner.results.set(callId, event)
            continue
          }
        }
        if (kind === 'tool-result') continue
        if (kind === 'tool') {
          const current = groups[groups.length - 1]
          if (current !== undefined && current.type === 'tools' && current.agent === event.agent) {
            current.items.push(event)
            if (callId !== '') calls.set(callId, current)
          } else {
            const group = { type: 'tools', agent: event.agent, items: [event], results: new Map() }
            groups.push(group)
            if (callId !== '') calls.set(callId, group)
          }
          continue
        }
        groups.push({ type: kind === '' ? 'unknown' : kind, event })
      }
      return groups
    }

    /** Newest known agent name for the composer recipient picker. */
    function recipientsOf(run) {
      const agents = Array.isArray(run?.agents) ? run.agents : []
      return agents
        .filter((agent) => agent !== null && agent !== undefined && typeof agent.name === 'string' && agent.name !== '')
        .map((agent) => ({ id: agent.id, name: agent.name, role: agent.role }))
    }

    /* --------------------------------------------------------------- icons */

    const ICON_PATHS = {
      artel: 'M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21M5.9 5.9l2.4 2.4M15.7 15.7l2.4 2.4M18.1 5.9l-2.4 2.4M8.3 15.7l-2.4 2.4',
      plus: 'M12 5v14M5 12h14',
      back: 'M15 6l-6 6 6 6',
      send: 'M5 12h13M12 5l7 7-7 7',
      stop: 'M7 7h10v10H7z',
      play: 'M8 5.5v13l11-6.5z',
      file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
      users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17.5 14.4A5.5 5.5 0 0 1 20.5 20',
      refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
      arrowRight: 'M4 12h15M13 6l6 6-6 6',
      alert: 'M12 8v5M12 16.5v.5M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z',
      dot: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      check: 'M5 12.5 10 17l9-10',
      x: 'M6 6l12 12M18 6 6 18',
      chevronRight: 'M9 6l6 6-6 6',
      chevronDown: 'M6 9l6 6 6-6',
    }

    /** Stroke SVG icon, sized for the dense UI. */
    function icon(kind, size) {
      const path = ICON_PATHS[kind] ?? ICON_PATHS.dot
      const dimension = size ?? 14
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: path, stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /* --------------------------------------------------------- persistence */

    function storageKey(sessionId) {
      return STORAGE_LAST_RUN + String(sessionId ?? '')
    }

    function readStoredRun(sessionId) {
      try {
        if (typeof localStorage === 'undefined') return null
        return localStorage.getItem(storageKey(sessionId))
      } catch {
        return null
      }
    }

    function storeRun(sessionId, runId) {
      try {
        if (typeof localStorage === 'undefined') return
        if (runId === null || runId === undefined) localStorage.removeItem(storageKey(sessionId))
        else localStorage.setItem(storageKey(sessionId), String(runId))
      } catch { /* storage is optional */ }
    }

    /* -------------------------------------------------------------- store */

    /** Per-session surface store. One instance per chat session. */
    function createArtelStore(sessionId, translate) {
      const api = getApi()
      const t = typeof translate === 'function' ? translate : (key) => DICTIONARIES.en[key] ?? key
      const state = {
        sessionId,
        open: false,
        runs: [],
        runsLoaded: false,
        project: null,
        projectLoaded: false,
        models: null,
        modelsLoaded: false,
        modelsLoading: false,
        modelsError: null,
        modelSaving: null,
        activeRunId: null,
        /* Set when the user opened «Новая сессия», so a background refresh
         * must not silently restore the previous run (the hero has to stay). */
        newRun: false,
        run: null,
        feed: [],
        cursor: 0,
        feedLoading: false,
        busy: false,
        starting: false,
        sending: false,
        stopping: false,
        error: null,
        startError: null,
        changes: [],
        changesLoaded: false,
        changesLoading: false,
        changesError: null,
        applying: false,
        discarding: false,
        decided: null,
        appliedFiles: [],
        skippedFiles: [],
        /* «Автоочередь» ---------------------------------------------------- */
        queue: null,
        queueLoaded: false,
        queueLoading: false,
        queueError: null,
        queueBusy: false,
        queuePreflight: null,
        /* «Фабрика» -------------------------------------------------------- */
        factoryOpen: false,
        factoryBoards: [],
        factoryBoardsLoaded: false,
        factoryBoard: null,
        factoryTickets: [],
        factoryLoading: false,
        factoryBusy: null,
        factoryError: null,
        factoryImportError: null,
        factoryReadiness: null,
        factoryTicket: null,
        factoryFeed: [],
      }
      const listeners = new Set()
      let snapshot = { ...state }
      let timer = null
      let refreshing = false
      let projectLoading = false
      let loadedChangesFor = null

      function getSnapshot() {
        return snapshot
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return () => {}
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }

      function publish(patch) {
        let changed = false
        for (const key of Object.keys(patch)) {
          if (state[key] !== patch[key]) { state[key] = patch[key]; changed = true }
        }
        if (!changed) return
        snapshot = { ...state }
        for (const listener of Array.from(listeners)) {
          try { listener() } catch { /* a broken subscriber must not stop the others */ }
        }
      }

      function mergeEvents(previous, incoming) {
        const merged = new Map()
        for (const event of Array.isArray(previous) ? previous : []) merged.set(event?.seq ?? merged.size, event)
        for (const event of Array.isArray(incoming) ? incoming : []) {
          const key = event?.seq ?? ('n' + merged.size)
          merged.set(key, event)
        }
        return Array.from(merged.values()).sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
      }

      function clearTimer() {
        if (timer !== null) { clearTimeout(timer); timer = null }
      }

      function schedule() {
        if (timer !== null || snapshot.open !== true) return
        const delay = snapshot.busy ? POLL_ACTIVE_MS : POLL_RUNS_MS
        timer = setTimeout(() => { timer = null; void tick() }, delay)
      }

      async function tick() {
        if (snapshot.open !== true) return
        if (typeof document !== 'undefined' && document.hidden === true) { schedule(); return }
        if (refreshing === false) {
          await refreshRuns({ silent: true })
          if (snapshot.activeRunId !== null) await loadRun(snapshot.activeRunId, { reset: false, silent: true })
          await loadQueue({ silent: true })
          if (snapshot.factoryOpen === true) await loadFactoryBoard(null, { silent: true })
        }
        schedule()
      }

      async function refreshRuns(options) {
        const silent = options?.silent === true
        if (refreshing) return
        refreshing = true
        try {
          const payload = await api.listRuns(sessionId)
          const runs = Array.isArray(payload?.runs) ? payload.runs : []
          const previous = snapshot.activeRunId
          const activeRunId = snapshot.newRun === true ? null : chooseActiveRunId(runs, previous ?? readStoredRun(sessionId))
          const patch = { runs, runsLoaded: true }
          if (silent === false) patch.error = null
          if (activeRunId !== previous) {
            patch.activeRunId = activeRunId
            patch.run = null
            patch.feed = []
            patch.cursor = 0
            patch.busy = false
            Object.assign(patch, changesResetPatch())
          }
          publish(patch)
          if (activeRunId !== null && (previous !== activeRunId || snapshot.run === null)) {
            if (previous !== activeRunId) storeRun(sessionId, activeRunId)
            await loadRun(activeRunId, { reset: true, silent })
          }
        } catch (error) {
          if (silent === false) publish({ error: describeError(error, t), runsLoaded: true })
        } finally {
          refreshing = false
        }
      }

      async function loadRun(runId, options) {
        if (runId === null || runId === undefined) return
        const reset = options?.reset === true
        const silent = options?.silent === true
        const cursor = reset ? 0 : snapshot.cursor
        const previousStatus = snapshot.run !== null && snapshot.run !== undefined ? snapshot.run.status : undefined
        try {
          const payload = await api.getRun(runId, cursor, 200)
          if (snapshot.activeRunId !== runId) return
          const run = payload?.run ?? snapshot.run
          const feed = payload?.feed ?? {}
          const events = Array.isArray(feed.events) ? feed.events : []
          const merged = reset ? mergeEvents([], events) : mergeEvents(snapshot.feed, events)
          const nextCursor = typeof feed.cursor === 'number' ? feed.cursor : snapshot.cursor
          publish({
            run,
            feed: merged,
            cursor: nextCursor,
            feedLoading: false,
            busy: isActiveRun(run),
            ...(silent ? {} : { error: null }),
          })
          // Changes are not trusted from `changeCount`: load them from the copy
          // whenever the run enters (or is opened in) a review status.
          if (snapshot.decided === null && (reset || previousStatus !== run?.status)) maybeLoadChanges(run)
        } catch (error) {
          if (silent === false) publish({ error: describeError(error, t), feedLoading: false })
        }
      }

      async function ensureProject() {
        if (snapshot.projectLoaded || projectLoading) return
        projectLoading = true
        try {
          const project = await api.project(sessionId)
          publish({ project, projectLoaded: true })
        } catch {
          publish({ projectLoaded: true })
        } finally {
          projectLoading = false
        }
      }

      /** Load the provider/model catalog the Host profile advertises. */
      async function loadModels(options) {
        const silent = options?.silent === true
        if (snapshot.modelsLoading === true) return
        publish({ modelsLoading: true })
        try {
          const payload = await api.models()
          const providers = Array.isArray(payload?.providers) ? payload.providers : []
          const models = { providers, default: payload?.default ?? null }
          publish({ models, modelsLoaded: true, modelsLoading: false, modelsError: null })
        } catch (error) {
          publish({ modelsLoaded: true, modelsLoading: false, ...(silent ? {} : { modelsError: describeError(error, t) }) })
        }
      }

      /** Route one live agent of the active run to another model/effort. */
      async function setAgentModel(agentId, model) {
        const runId = snapshot.activeRunId
        if (runId === null || runId === undefined || snapshot.modelSaving !== null) return false
        publish({ modelSaving: agentId })
        try {
          const payload = await api.setAgentModel(runId, agentId, model)
          if (payload?.run !== undefined && payload.run !== null) publish({ run: payload.run, busy: isActiveRun(payload.run) })
          publish({ modelSaving: null })
          return true
        } catch (error) {
          publish({ modelSaving: null, error: describeError(error, t) })
          return false
        }
      }

      /** Patch that clears every change-card field when the run changes. */
      function changesResetPatch() {
        loadedChangesFor = null
        return {
          changes: [],
          changesLoaded: false,
          changesLoading: false,
          changesError: null,
          applying: false,
          discarding: false,
          decided: null,
          appliedFiles: [],
          skippedFiles: [],
        }
      }

      /** Load the file changes of a reviewable run from its isolated copy. */
      async function loadChanges(runId, options) {
        const target = runId ?? snapshot.activeRunId
        if (target === null || target === undefined) return
        const force = options?.force === true
        if (snapshot.changesLoading === true) return
        if (force !== true && loadedChangesFor === target) return
        loadedChangesFor = target
        publish({ changesLoading: true })
        try {
          const payload = await api.changes(target)
          if (loadedChangesFor !== target) return
          publish({ changes: normalizeChanges(payload), changesLoaded: true, changesLoading: false, changesError: null })
        } catch (error) {
          if (loadedChangesFor !== target) return
          publish({ changesLoading: false, changesLoaded: true, changesError: describeError(error, t) })
        }
      }

      /** Auto-load changes when a run enters (or opens in) a review status. */
      function maybeLoadChanges(run) {
        if (run === null || run === undefined || run.id === undefined) return
        if (snapshot.decided !== null) return
        if (!REVIEW_STATUSES.has(run.status)) return
        void loadChanges(run.id)
      }

      /** Apply the active run's changes to the real project. */
      async function applyChanges() {
        const runId = snapshot.activeRunId
        if (runId === null || runId === undefined) return
        if (snapshot.applying === true || snapshot.discarding === true || snapshot.decided !== null) return
        publish({ applying: true, changesError: null })
        try {
          const payload = await api.apply(runId)
          if (snapshot.activeRunId !== runId) { publish({ applying: false }); return }
          const applied = Array.isArray(payload?.applied) ? payload.applied.map((path) => String(path)) : []
          const skipped = Array.isArray(payload?.skipped) ? payload.skipped : []
          publish({
            applying: false,
            decided: 'applied',
            appliedFiles: applied,
            skippedFiles: skipped,
            ...(payload?.run !== undefined && payload.run !== null ? { run: payload.run, busy: isActiveRun(payload.run) } : {}),
          })
          void refreshRuns({ silent: true })
          void loadRun(runId, { reset: false, silent: true })
        } catch (error) {
          publish({ applying: false, changesError: describeError(error, t) })
        }
      }

      /** Discard the active run's copy; the project stays untouched. */
      async function discardChanges() {
        const runId = snapshot.activeRunId
        if (runId === null || runId === undefined) return
        if (snapshot.applying === true || snapshot.discarding === true || snapshot.decided !== null) return
        publish({ discarding: true, changesError: null })
        try {
          const payload = await api.discard(runId)
          if (snapshot.activeRunId !== runId) { publish({ discarding: false }); return }
          publish({
            discarding: false,
            decided: 'discarded',
            appliedFiles: [],
            skippedFiles: [],
            ...(payload?.run !== undefined && payload.run !== null ? { run: payload.run, busy: isActiveRun(payload.run) } : {}),
          })
          void refreshRuns({ silent: true })
          void loadRun(runId, { reset: false, silent: true })
        } catch (error) {
          publish({ discarding: false, changesError: describeError(error, t) })
        }
      }

      /* -------------------------------------------------- Автоочередь --- */

      /** Project the queue belongs to: the session project or the queue's own. */
      function queueProjectPath() {
        const project = snapshot.project
        if (project !== null && project !== undefined && typeof project.projectPath === 'string' && project.projectPath !== '') return project.projectPath
        const queue = snapshot.queue
        if (queue !== null && queue !== undefined && typeof queue.projectPath === 'string' && queue.projectPath !== '') return queue.projectPath
        const firstRun = snapshot.runs[0]
        return typeof firstRun?.projectPath === 'string' && firstRun.projectPath !== '' ? firstRun.projectPath : null
      }

      /** Turn a runner payload into the store patch that keeps `queue` fresh. */
      function queuePatch(payload) {
        const patch = {}
        if (payload !== null && typeof payload === 'object') {
          const summary = payload.queue !== undefined ? payload.queue : payload
          if (summary !== undefined) { patch.queue = summary; patch.queueLoaded = true }
          if (payload.blocked !== undefined) patch.queuePreflight = payload.blocked
        }
        return patch
      }

      async function loadQueue(options) {
        const silent = options?.silent === true
        if (snapshot.queueLoading === true) return
        publish({ queueLoading: true })
        try {
          const summary = await api.queue(sessionId, queueProjectPath())
          publish({ queue: summary ?? null, queueLoaded: true, queueLoading: false, ...(silent ? {} : { queueError: null }) })
        } catch (error) {
          publish({ queueLoading: false, queueLoaded: true, ...(silent ? {} : { queueError: describeError(error, t) }) })
        }
      }

      async function addQueueTasks(input) {
        if (snapshot.queueBusy === true) return 0
        const texts = Array.isArray(input?.texts) ? input.texts.map((item) => String(item ?? '').trim()).filter((item) => item !== '') : []
        const task = String(input?.task ?? '').trim()
        const list = task === '' ? texts : [...texts, task]
        if (list.length === 0) return 0
        publish({ queueBusy: true, queueError: null })
        try {
          const payload = await api.queueAdd({
            sessionId,
            projectPath: queueProjectPath(),
            texts: list,
            mode: input?.mode ?? 'solo',
            model: input?.model ?? null,
            basePath: typeof input?.basePath === 'string' && input.basePath !== '' ? input.basePath : null,
          })
          publish({ ...queuePatch(payload), queueBusy: false })
          return typeof payload?.added === 'number' ? payload.added : list.length
        } catch (error) {
          publish({ queueBusy: false, queueError: describeError(error, t) })
          return 0
        }
      }

      /** Roll a saved auto-queue version back: discard the run and refresh history. */
      async function queueDiscardVersion(runId) {
        if (snapshot.queueBusy === true || typeof runId !== 'string' || runId === '') return null
        publish({ queueBusy: true, queueError: null })
        try {
          const payload = await api.discard(runId)
          publish({ queueBusy: false })
          await refreshRuns({ silent: true })
          await loadQueue({ silent: true })
          return payload ?? null
        } catch (error) {
          publish({ queueBusy: false, queueError: describeError(error, t) })
          return null
        }
      }

      async function loadQueuePreflight() {
        try {
          const report = await api.queuePreflight(sessionId, queueProjectPath())
          publish({ queuePreflight: report ?? null })
          return report ?? null
        } catch (error) {
          publish({ queueError: describeError(error, t) })
          return null
        }
      }

      /**
       * Flip «Автоочередь». The runner answers `{blocked}` when the pre-flight
       * still has open questions (unsaved versions); the caller then collects
       * decisions and calls again with them.
       */
      async function setQueueAutopilot(input) {
        if (snapshot.queueBusy === true) return null
        publish({ queueBusy: true, queueError: null })
        try {
          const payload = await api.setQueueAutopilot({ sessionId, projectPath: queueProjectPath(), ...input })
          publish({ ...queuePatch(payload), queueBusy: false })
          if (input?.autopilot === true && (payload?.blocked === undefined || payload?.blocked === null)) publish({ queuePreflight: null })
          return payload ?? null
        } catch (error) {
          publish({ queueBusy: false, queueError: describeError(error, t) })
          return null
        }
      }

      /** One queue action whose answer is a `{queue}` patch. */
      async function queueAction(run) {
        if (snapshot.queueBusy === true) return null
        publish({ queueBusy: true, queueError: null })
        try {
          const payload = await run()
          publish({ ...queuePatch(payload), queueBusy: false })
          return payload ?? null
        } catch (error) {
          publish({ queueBusy: false, queueError: describeError(error, t) })
          return null
        }
      }

      function queueStop() { return queueAction(() => api.queueStop(sessionId)) }
      function queueFinishAfterCurrent() { return queueAction(() => api.queueFinishAfterCurrent(sessionId)) }
      function queueClear() { return queueAction(() => api.queueClear(sessionId)) }
      function queueRetry(taskId) { return queueAction(() => api.queueRetry(sessionId, taskId)) }
      function queueRemove(taskId) { return queueAction(() => api.queueRemove(sessionId, taskId)) }
      function queueMove(taskId, direction) { return queueAction(() => api.queueMove(sessionId, taskId, direction)) }
      function queueSaveVersion(runId) { return queueAction(() => api.queueSaveVersion(sessionId, runId)) }
      function queuePostponeVersion(runId) { return queueAction(() => api.queuePostponeVersion(sessionId, runId)) }
      function dismissQueuePreflight() { publish({ queuePreflight: null }) }

      /* ----------------------------------------------------- Фабрика --- */

      function factoryProjectPath() {
        const project = snapshot.project
        if (project !== null && project !== undefined && typeof project.projectPath === 'string' && project.projectPath !== '') return project.projectPath
        const firstRun = snapshot.runs[0]
        return typeof firstRun?.projectPath === 'string' && firstRun.projectPath !== '' ? firstRun.projectPath : null
      }

      async function loadFactoryBoards(options) {
        const silent = options?.silent === true
        try {
          const payload = await api.factoryBoards()
          const boards = Array.isArray(payload?.boards) ? payload.boards : []
          publish({ factoryBoards: boards, factoryBoardsLoaded: true, ...(silent ? {} : { factoryError: null }) })
          return boards
        } catch (error) {
          publish({ factoryBoardsLoaded: true, ...(silent ? {} : { factoryError: describeError(error, t) }) })
          return []
        }
      }

      /** Replace the selected ticket in the board list after an action. */
      function factoryTicketPatch(ticket) {
        if (ticket === null || ticket === undefined || typeof ticket !== 'object') return {}
        const tickets = snapshot.factoryTickets.map((entry) => (entry?.id === ticket.id ? ticket : entry))
        return { factoryTicket: ticket, factoryTickets: tickets }
      }

      async function loadFactoryBoard(boardId, options) {
        const silent = options?.silent === true
        const id = boardId ?? snapshot.factoryBoard?.id
        if (typeof id !== 'string' || id === '') return null
        if (snapshot.factoryLoading === true && silent !== true) return null
        if (silent !== true) publish({ factoryLoading: true })
        try {
          const payload = await api.factoryBoard(id)
          const board = payload?.board ?? null
          const tickets = Array.isArray(payload?.tickets) ? payload.tickets : []
          const boards = Array.isArray(payload?.boards) ? payload.boards : snapshot.factoryBoards
          const current = snapshot.factoryTicket
          const selected = current === null ? null : tickets.find((ticket) => ticket?.id === current.id) ?? null
          publish({
            factoryBoards: boards,
            factoryBoardsLoaded: true,
            factoryBoard: board ?? snapshot.factoryBoard,
            factoryTickets: tickets,
            factoryTicket: selected,
            ...(selected === null ? { factoryFeed: [] } : {}),
            ...(silent ? {} : { factoryLoading: false, factoryError: null }),
          })
          return board
        } catch (error) {
          publish({ ...(silent ? {} : { factoryLoading: false, factoryError: describeError(error, t) }) })
          return null
        }
      }

      async function loadFactoryTicketFeed(ticketId, options) {
        const boardId = snapshot.factoryBoard?.id
        if (typeof boardId !== 'string') return null
        try {
          const payload = await api.factoryTicket(boardId, ticketId)
          const events = Array.isArray(payload?.feed?.events) ? payload.feed.events : []
          publish({
            factoryFeed: mergeEvents([], events),
            ...(payload?.ticket !== undefined ? factoryTicketPatch(payload.ticket) : {}),
            ...(options?.silent === true ? {} : { factoryError: null }),
          })
          return payload ?? null
        } catch (error) {
          publish({ factoryError: describeError(error, t) })
          return null
        }
      }

      async function selectFactoryBoard(boardId) {
        publish({ factoryBoard: null, factoryTickets: [], factoryTicket: null, factoryFeed: [], factoryError: null })
        return loadFactoryBoard(boardId, { silent: false })
      }

      async function createFactoryBoard(input) {
        publish({ factoryBusy: 'create', factoryError: null })
        try {
          const payload = await api.factoryCreateBoard({ projectPath: input?.projectPath ?? factoryProjectPath(), name: input?.name ?? null })
          const board = payload?.board ?? null
          const boards = board === null ? snapshot.factoryBoards : [board, ...snapshot.factoryBoards.filter((entry) => entry?.id !== board.id)]
          publish({ factoryBusy: null, factoryBoards: boards, factoryBoardsLoaded: true })
          if (board !== null) await loadFactoryBoard(board.id, { silent: false })
          return board
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      async function updateFactorySettings(patch) {
        const board = snapshot.factoryBoard
        if (board === null || typeof board?.id !== 'string') return null
        publish({ factoryBusy: 'settings', factoryError: null })
        try {
          const payload = await api.factorySettings(board.id, patch)
          const next = payload?.board ?? null
          publish({ factoryBusy: null, ...(next === null ? {} : { factoryBoard: next, factoryReadiness: next.readiness ?? snapshot.factoryReadiness }) })
          return next
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      async function checkFactoryReadiness() {
        const board = snapshot.factoryBoard
        if (board === null || typeof board?.id !== 'string') return null
        publish({ factoryBusy: 'readiness', factoryError: null })
        try {
          const payload = await api.factoryReadiness(board.id)
          publish({ factoryBusy: null, ...(payload?.board === undefined ? {} : { factoryBoard: payload.board }), factoryReadiness: payload?.readiness ?? null })
          return payload?.readiness ?? null
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      async function addFactoryTicket(payload) {
        const board = snapshot.factoryBoard
        if (board === null || typeof board?.id !== 'string') return null
        publish({ factoryBusy: 'ticket', factoryError: null })
        try {
          const answer = await api.factoryAddTicket(board.id, payload)
          publish({ factoryBusy: null, factoryError: null })
          if (answer?.ticket !== undefined) {
            const tickets = [...snapshot.factoryTickets.filter((entry) => entry?.id !== answer.ticket.id), answer.ticket]
            publish({ factoryTickets: tickets })
          }
          void loadFactoryBoard(board.id, { silent: true })
          return answer?.ticket ?? null
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      async function importFactoryIssue(ref) {
        const board = snapshot.factoryBoard
        if (board === null || typeof board?.id !== 'string' || String(ref ?? '').trim() === '') return null
        publish({ factoryBusy: 'import', factoryError: null, factoryImportError: null })
        try {
          const answer = await api.factoryImport(board.id, String(ref).trim())
          publish({ factoryBusy: null, factoryError: null, factoryImportError: null })
          void loadFactoryBoard(board.id, { silent: true })
          return answer?.ticket ?? null
        } catch (error) {
          const text = importErrorText(error, t)
          publish({ factoryBusy: null, factoryError: null, factoryImportError: text })
          return null
        }
      }

      async function pollFactoryTrackers() {
        const board = snapshot.factoryBoard
        publish({ factoryBusy: 'poll', factoryError: null })
        try {
          const answer = await api.factoryPoll(board?.id)
          publish({ factoryBusy: null, factoryError: null })
          if (board !== null && typeof board?.id === 'string') void loadFactoryBoard(board.id, { silent: true })
          return answer ?? null
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      async function openFactory() {
        publish({ factoryOpen: true, factoryError: null })
        const boards = await loadFactoryBoards({ silent: true })
        const previous = snapshot.factoryBoard
        const projectPath = factoryProjectPath()
        const boardId = previous?.id ?? boards.find((board) => board?.projectPath === projectPath)?.id ?? null
        if (boardId !== null) await loadFactoryBoard(boardId, { silent: false })
      }

      function closeFactory() {
        publish({ factoryOpen: false })
      }

      async function selectFactoryTicket(ticketId) {
        if (ticketId === null || ticketId === undefined) {
          publish({ factoryTicket: null, factoryFeed: [] })
          return
        }
        const ticket = snapshot.factoryTickets.find((entry) => entry?.id === ticketId) ?? null
        publish({ factoryTicket: ticket, factoryFeed: [] })
        await loadFactoryTicketFeed(ticketId, { silent: false })
      }

      async function factoryAction(verb, payload) {
        const board = snapshot.factoryBoard
        const ticket = snapshot.factoryTicket
        if (board === null || typeof board?.id !== 'string' || ticket === null || typeof ticket?.id !== 'string') return null
        publish({ factoryBusy: 'ticket', factoryError: null })
        try {
          const answer = await api.factoryTicketAction(board.id, ticket.id, verb, payload)
          publish({ factoryBusy: null, factoryError: null, ...(answer?.ticket === undefined ? {} : factoryTicketPatch(answer.ticket)) })
          void loadFactoryBoard(board.id, { silent: true })
          if (ticket.runId !== null && ticket.runId !== undefined) void loadFactoryTicketFeed(ticket.id, { silent: true })
          return answer?.ticket ?? null
        } catch (error) {
          publish({ factoryBusy: null, factoryError: describeError(error, t) })
          return null
        }
      }

      function dismissChangesError() {
        publish({ changesError: null })
      }

      function open() {
        if (snapshot.open === true) return
        publish({ open: true })
        void ensureProject()
        void loadModels({ silent: true })
        void loadQueue({ silent: true })
        void loadFactoryBoards({ silent: true })
        void refreshRuns({ silent: false })
        schedule()
      }

      function close() {
        clearTimer()
        if (snapshot.open !== true) return
        publish({ open: false })
      }

      function toggle() {
        if (snapshot.open === true) close()
        else open()
      }

      function selectRun(runId) {
        if (runId === null || runId === undefined) {
          storeRun(sessionId, null)
          publish({ activeRunId: null, newRun: true, run: null, feed: [], cursor: 0, busy: false, feedLoading: false, ...changesResetPatch() })
          return
        }
        if (snapshot.activeRunId === runId) return
        storeRun(sessionId, runId)
        publish({ activeRunId: runId, newRun: false, run: null, feed: [], cursor: 0, busy: false, feedLoading: true, ...changesResetPatch() })
        void loadRun(runId, { reset: true, silent: false })
      }

      async function startRun(input) {
        if (snapshot.starting === true) return
        const task = String(input?.task ?? '').trim()
        if (task === '') return
        const mode = input?.mode === 'conductor' ? 'conductor' : input?.mode === 'swarm' ? 'swarm' : input?.mode === 'fusion' ? 'fusion' : input?.mode === 'orchestrator' ? 'orchestrator' : 'solo'
        publish({ starting: true, startError: null })
        try {
          const payload = await api.startRun({
            sessionId,
            mode,
            task,
            ...(input?.model ? { model: input.model } : {}),
            ...(input?.models ? { models: input.models } : {}),
            ...(input?.projectPath ? { projectPath: input.projectPath } : {}),
          })
          const run = payload?.run ?? null
          if (run === null || run === undefined || run.id === undefined) throw new Error(t('error.start'))
          const runs = [run, ...snapshot.runs.filter((entry) => entry?.id !== run.id)]
          publish({ starting: false, runs, runsLoaded: true, activeRunId: run.id, newRun: false, run, feed: [], cursor: 0, busy: isActiveRun(run), ...changesResetPatch() })
          storeRun(sessionId, run.id)
          void loadRun(run.id, { reset: true, silent: false })
        } catch (error) {
          publish({ starting: false, startError: describeError(error, t) })
        }
      }

      async function send(text, agentId) {
        const runId = snapshot.activeRunId
        const body = String(text ?? '').trim()
        if (runId === null || body === '' || snapshot.sending === true) return false
        publish({ sending: true })
        try {
          const payload = await api.sendMessage(runId, body, agentId)
          if (payload?.run !== undefined && payload.run !== null) publish({ run: payload.run, busy: isActiveRun(payload.run) })
          publish({ sending: false })
          void loadRun(runId, { reset: false, silent: true })
          return true
        } catch (error) {
          publish({ sending: false, error: describeError(error, t) })
          return false
        }
      }

      async function interrupt() {
        const runId = snapshot.activeRunId
        if (runId === null || snapshot.stopping === true) return
        publish({ stopping: true })
        try {
          const payload = await api.interrupt(runId)
          if (payload?.run !== undefined && payload.run !== null) publish({ run: payload.run, busy: isActiveRun(payload.run) })
          publish({ stopping: false })
          void loadRun(runId, { reset: false, silent: true })
        } catch (error) {
          publish({ stopping: false, error: describeError(error, t) })
        }
      }

      function dismissError() {
        publish({ error: null, startError: null, factoryError: null, factoryImportError: null })
      }

      /** Hide the inline reason of a failed issue import while the user edits it. */
      function dismissFactoryImportError() {
        if (snapshot.factoryImportError !== null) publish({ factoryImportError: null })
      }

      function dispose() {
        clearTimer()
        listeners.clear()
      }

      return {
        sessionId, getSnapshot, subscribe, open, close, toggle, refreshRuns, selectRun, startRun, send, interrupt,
        loadModels, setAgentModel, loadChanges, applyChanges, discardChanges, dismissChangesError, dismissError, dispose,
        loadQueue, addQueueTasks, loadQueuePreflight, setQueueAutopilot, queueStop, queueFinishAfterCurrent, queueClear,
        queueRetry, queueRemove, queueMove, queueSaveVersion, queuePostponeVersion, queueDiscardVersion, dismissQueuePreflight,
        openFactory, closeFactory, loadFactoryBoards, selectFactoryBoard, createFactoryBoard, loadFactoryBoard,
        updateFactorySettings, checkFactoryReadiness, addFactoryTicket, importFactoryIssue, dismissFactoryImportError, pollFactoryTrackers,
        selectFactoryTicket, factoryAction,
      }
    }

    const STORES = new Map()

    /** Get (or lazily create) the store for a chat session. */
    function getStore(sessionId, translate) {
      const key = String(sessionId ?? 'unknown')
      let store = STORES.get(key)
      if (store === undefined) {
        store = createArtelStore(key, translate)
        STORES.set(key, store)
      }
      return store
    }

    /** Subscribe a component to a store; no useSyncExternalStore dependency. */
    function useArtelStore(store) {
      const [snap, setSnap] = useState(() => store.getSnapshot())
      useEffect(() => {
        setSnap(store.getSnapshot())
        return store.subscribe(() => setSnap(store.getSnapshot()))
      }, [store])
      return snap
    }

    /** Pick the locale namespace translator, falling back to English. */
    function translator(props) {
      if (typeof props?.t === 'function') return props.t
      return (key) => DICTIONARIES.en[key] ?? key
    }

    function sessionIdOf(props) {
      return props?.sessionId ?? props?.session?.sessionId ?? props?.session?.id
    }

    /* --------------------------------------------------------- primitives */

    const HostStateDot = primitives !== null && typeof primitives === 'object' ? primitives.StateDot : undefined
    const HostMarkdown = primitives !== null && typeof primitives === 'object' ? primitives.MarkdownText : undefined

    /** Status marker; uses the Host primitive when the loader exposes it. */
    function Dot(props) {
      const state = props?.state ?? 'idle'
      if (typeof HostStateDot === 'function' || (HostStateDot !== null && typeof HostStateDot === 'object')) {
        return h(HostStateDot, { state })
      }
      return h('span', { className: 'dsh-artel-dot', 'data-state': state, 'aria-hidden': 'true' })
    }

    /**
     * Labels bag for the Host markdown primitive.
     *
     * The primitive reads `labels.code` whenever a reply contains a fenced
     * code block (`QW` in the shell bundle: `labels: r.labels.code`), so a bare
     * `text` call throws `Cannot read properties of undefined (reading 'code')`
     * as soon as an agent answers with code. Fill every label the code-block
     * header (`Rp`) reads: `copyLabel`, `copiedLabel`, `codeLabel`, `wrapLabel`,
     * `unwrapLabel`.
     */
    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('feed.copy'),
          copiedLabel: t('feed.copied'),
          toolbarLabels: {
            codeLabel: t('feed.code'),
            wrapLabel: t('feed.wrap'),
            unwrapLabel: t('feed.unwrap'),
          },
        },
        footnotes: t('feed.footnotes'),
      }
    }

    /**
     * Error boundary around the markdown primitive: one malformed node must not
     * take down the whole composer slot entry (which unmounts the launcher and
     * the surface). The fallback shows the raw text. Built lazily because the
     * test harness fakes `react` without a `Component` base class.
     */
    function makeMarkdownBoundary() {
      if (typeof React.Component !== 'function') return null
      return class MarkdownBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        render() {
          if (this.state.failed === true) return this.props.fallback
          return this.props.children
        }
      }
    }

    const MarkdownBoundary = makeMarkdownBoundary()

    /** Markdown body with a plain-text fallback. */
    function Markdown(props) {
      const text = String(props?.text ?? '')
      const t = typeof props?.t === 'function' ? props.t : (key) => DICTIONARIES.en[key] ?? key
      const plain = h('div', { className: 'dsh-artel-msg__body' }, text)
      if (typeof HostMarkdown === 'function' || (HostMarkdown !== null && typeof HostMarkdown === 'object')) {
        const body = h(HostMarkdown, { text, variant: 'compact', labels: markdownLabels(t) })
        return MarkdownBoundary === null ? body : h(MarkdownBoundary, { fallback: plain }, body)
      }
      return plain
    }

    function Avatar(props) {
      const name = String(props?.name ?? '?')
      const tone = AVATAR_TONES[avatarTone(name)] ?? AVATAR_TONES[0]
      const initial = name.trim().slice(0, 1).toUpperCase() || '?'
      return h('span', { className: 'dsh-artel-avatar', style: { background: tone }, 'aria-hidden': 'true' }, initial)
    }

    function Pill(props) {
      return h('span', { className: 'dsh-artel-pill', 'data-tone': props?.tone ?? 'muted' }, props?.children)
    }

    function Tag(props) {
      const title = typeof props?.title === 'string' && props.title !== '' ? props.title : undefined
      return h('span', { className: 'dsh-artel-tag', title }, props?.children)
    }

    function SegmentedControl(props) {
      const value = props?.value
      const options = Array.isArray(props?.options) ? props.options : []
      return h(
        'div',
        { className: 'dsh-artel-segmented', role: 'radiogroup', 'aria-label': props?.label },
        options.map((option) => h(
          'button',
          {
            key: option.value,
            type: 'button',
            role: 'radio',
            'aria-checked': option.value === value,
            'data-selected': option.value === value ? 'true' : 'false',
            className: 'dsh-artel-segmented__option',
            title: option.hint,
            onClick: () => { if (typeof props?.onChange === 'function') props.onChange(option.value) },
          },
          option.label,
        )),
      )
    }

    /* ----------------------------------------------------------- picker menu */

    let pickerSeq = 0
    /* Only one picker menu may be open: opening a second one closes the first. */
    let closeOtherPicker = null

    /** Flat option list of a picker, in render order. */
    function pickerFlat(groups) {
      const options = []
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const option of Array.isArray(group?.options) ? group.options : []) {
          options.push({
            value: option?.value === null || option?.value === undefined ? '' : String(option.value),
            label: String(option?.label ?? option?.value ?? ''),
          })
        }
      }
      return options
    }

    /**
     * Apple-style picker. A native <select> always opens the OS popup, which
     * cannot be themed; this one paints its own translucent listbox while the
     * trigger keeps the combobox role and the arrow/Home/End/Enter/Esc model.
     */
    function Picker(props) {
      const groups = Array.isArray(props?.groups) ? props.groups : []
      const flat = pickerFlat(groups)
      const value = props?.value === null || props?.value === undefined ? '' : String(props.value)
      const selectedIndex = flat.findIndex((option) => option.value === value)
      const selectedLabel = selectedIndex === -1 ? value : flat[selectedIndex].label
      const disabled = props?.disabled === true
      const [open, setOpen] = useState(false)
      const [activeIndex, setActiveIndex] = useState(selectedIndex === -1 ? -1 : selectedIndex)
      const [placement, setPlacement] = useState('down')
      const [geometry, setGeometry] = useState(null)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const menuIdRef = useRef(null)
      if (menuIdRef.current === null) {
        pickerSeq += 1
        menuIdRef.current = LAUNCHER_ID + '-menu-' + pickerSeq
      }
      const menuId = menuIdRef.current

      /* Open the menu on the side that has room, align it with the whole chip
       * (the inner button is only the value row), keep a real gap from the chip
       * and clamp the panel inside the surface. Refs are null in a DOM-less
       * render, so every measurement is guarded. */
      const measure = () => {
        const trigger = triggerRef.current
        if (trigger === null || trigger === undefined || typeof trigger.getBoundingClientRect !== 'function') return
        const root = rootRef.current
        const rootRect = root !== null && root !== undefined && typeof root.getBoundingClientRect === 'function'
          ? root.getBoundingClientRect()
          : { left: 0, top: 0, right: 0, bottom: 0 }
        const chip = typeof trigger.closest === 'function' ? trigger.closest('.dsh-artel-model-pick') : null
        const box = chip !== null && chip !== undefined && typeof chip.getBoundingClientRect === 'function'
          ? chip.getBoundingClientRect()
          : trigger.getBoundingClientRect()
        let bounds = null
        if (typeof trigger.closest === 'function') {
          const surface = trigger.closest('.dsh-artel-surface')
          if (surface !== null && surface !== undefined && typeof surface.getBoundingClientRect === 'function') bounds = surface.getBoundingClientRect()
        }
        const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : null
        const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : null
        const margin = 8
        const left = bounds !== null ? bounds.left + margin : margin
        const right = bounds !== null ? bounds.right - margin : (viewportWidth === null ? box.right + 340 : viewportWidth - margin)
        const top = bounds !== null ? bounds.top + margin : margin
        const bottom = bounds !== null ? bounds.bottom - margin : (viewportHeight === null ? box.bottom + 320 : viewportHeight - margin)
        const menu = menuRef.current
        const menuHeight = menu !== null && menu !== undefined && typeof menu.offsetHeight === 'number' && menu.offsetHeight > 0 ? menu.offsetHeight : 300
        const menuWidth = menu !== null && menu !== undefined && typeof menu.offsetWidth === 'number' && menu.offsetWidth > 0
          ? menu.offsetWidth
          : Math.min(340, Math.max(box.width, 208))
        const below = bottom - box.bottom
        const above = box.top - top
        const nextPlacement = menuHeight > below && above > below ? 'up' : 'down'
        /* The menu must also stay inside the viewport, not only the surface, and
         * max-height sizes the content box, so subtract padding and border. */
        const viewportBelow = viewportHeight === null ? below : viewportHeight - box.bottom - 8
        const viewportAbove = box.top - 8
        const room = Math.max(120, Math.min(nextPlacement === 'up' ? above : below, nextPlacement === 'up' ? viewportAbove : viewportBelow) - 12)
        let offsetLeft = box.left - rootRect.left
        if (offsetLeft + rootRect.left + menuWidth > right) offsetLeft = right - menuWidth - rootRect.left
        if (offsetLeft + rootRect.left < left) offsetLeft = left - rootRect.left
        const offsetTop = nextPlacement === 'up'
          ? box.top - rootRect.top - menuHeight - 7
          : box.bottom - rootRect.top + 7
        setPlacement(nextPlacement)
        setGeometry({
          left: Math.round(offsetLeft),
          top: Math.round(offsetTop),
          maxHeight: Math.round(room),
        })
      }

      const openMenu = () => {
        if (disabled) return
        if (typeof closeOtherPicker === 'function') {
          const other = closeOtherPicker
          closeOtherPicker = null
          other()
        }
        measure()
        setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex)
        setOpen(true)
        closeOtherPicker = () => { setOpen(false); setGeometry(null) }
      }

      const dismissMenu = () => {
        setOpen(false)
        setGeometry(null)
        if (typeof closeOtherPicker === 'function') closeOtherPicker = null
      }

      const closeMenu = () => {
        dismissMenu()
        const trigger = triggerRef.current
        if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus()
      }

      const choose = (nextValue) => {
        setOpen(false)
        setGeometry(null)
        if (typeof props?.onChange === 'function' && nextValue !== value) props.onChange(nextValue)
        const trigger = triggerRef.current
        if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus()
      }

      const move = (delta) => {
        if (flat.length === 0) return
        if (activeIndex === -1) { setActiveIndex(delta > 0 ? 0 : flat.length - 1); return }
        setActiveIndex(Math.min(flat.length - 1, Math.max(0, activeIndex + delta)))
      }

      const onTriggerKeyDown = (event) => {
        if (disabled) return
        const key = String(event?.key ?? '')
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault()
          if (open !== true) openMenu()
          else move(key === 'ArrowDown' ? 1 : -1)
          return
        }
        if ((key === 'Home' || key === 'End') && open === true) {
          event.preventDefault()
          setActiveIndex(key === 'Home' ? 0 : flat.length - 1)
          return
        }
        if (key === 'Enter' || key === ' ') {
          event.preventDefault()
          if (open !== true) openMenu()
          else if (flat[activeIndex] !== undefined) choose(flat[activeIndex].value)
          return
        }
        if (key === 'Escape' && open === true) {
          event.preventDefault()
          // The overlay closes on Escape too (its listener sits on window), so
          // the first Escape must only dismiss the menu, not the whole panel.
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          closeMenu()
          return
        }
        if (key === 'Tab') dismissMenu()
      }

      useEffect(() => {
        if (open !== true) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root !== null && root !== undefined && typeof root.contains === 'function' && event?.target !== undefined && root.contains(event.target)) return
          dismissMenu()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        return () => {
          if (typeof document.removeEventListener === 'function') document.removeEventListener('mousedown', onPointerDown, true)
        }
      }, [open])

      /* An open picker owns Escape from the document: it dismisses the menu and
       * stops the overlay from closing the whole panel in the same keystroke. */
      useEffect(() => {
        if (open !== true) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (String(event?.key ?? '') !== 'Escape') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          dismissMenu()
          const trigger = triggerRef.current
          if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          if (typeof document.removeEventListener === 'function') document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      /* Re-measure once the menu exists: its real height decides up/down and
       * the panel can then be clamped against the surface. */
      useEffect(() => {
        if (open !== true) return undefined
        measure()
        return undefined
      }, [open])

      useEffect(() => {
        if (open !== true) return undefined
        const menu = menuRef.current
        if (menu === null || menu === undefined || typeof menu.querySelector !== 'function') return undefined
        const active = menu.querySelector('[data-active="true"]')
        if (active === null || active === undefined) return undefined
        const group = active.parentElement !== null && active.parentElement !== undefined ? active.parentElement : null
        const firstOption = group !== null && typeof group.querySelector === 'function' ? group.querySelector('[role="option"]') : null
        const target = firstOption !== null && firstOption === active && group !== null ? group : active
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
        return undefined
      }, [open, activeIndex])

      let itemIndex = -1
      const menuGroups = groups.map((group, groupIndex) => {
        const options = Array.isArray(group?.options) ? group.options : []
        return h(
          'div',
          {
            key: 'group-' + (group?.id ?? groupIndex),
            className: 'dsh-artel-menu__group',
            role: 'group',
            'aria-label': typeof group?.label === 'string' && group.label !== '' ? group.label : undefined,
          },
          typeof group?.label === 'string' && group.label !== ''
            ? h('div', { className: 'dsh-artel-menu__group-label', 'aria-hidden': 'true' }, group.label)
            : null,
          options.map((option, optionIndex) => {
            itemIndex += 1
            const index = itemIndex
            const optionValue = option?.value === null || option?.value === undefined ? '' : String(option.value)
            const selected = optionValue === value
            return h(
              'div',
              {
                key: 'option-' + (option?.key ?? optionValue ?? optionIndex),
                id: menuId + '-option-' + index,
                className: 'dsh-artel-menu__item',
                role: 'option',
                'aria-selected': selected === true ? 'true' : 'false',
                'data-value': optionValue,
                'data-index': index,
                'data-active': index === activeIndex ? 'true' : 'false',
                'data-selected': selected === true ? 'true' : 'false',
                onMouseEnter: () => setActiveIndex(index),
                onClick: () => choose(optionValue),
              },
              h('span', { className: 'dsh-artel-menu__check', 'aria-hidden': 'true' }, selected === true ? icon('check', 12) : null),
              h('span', { className: 'dsh-artel-menu__text' }, String(option?.label ?? optionValue)),
            )
          }),
        )
      })

      return h(
        'span',
        {
          ref: rootRef,
          className: 'dsh-artel-picker',
          'data-open': open === true ? 'true' : 'false',
          onBlur: (event) => {
            const root = rootRef.current
            const next = event?.relatedTarget
            if (root !== null && root !== undefined && next !== null && next !== undefined && typeof root.contains === 'function' && root.contains(next)) return
            dismissMenu()
          },
        },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dsh-artel-select' + (typeof props?.className === 'string' && props.className !== '' ? ' ' + props.className : ''),
            disabled: disabled === true,
            role: 'combobox',
            'aria-haspopup': 'listbox',
            'aria-expanded': open === true ? 'true' : 'false',
            'aria-controls': open === true ? menuId : undefined,
            'aria-owns': open === true ? menuId : undefined,
            'aria-activedescendant': open === true && activeIndex >= 0 ? menuId + '-option-' + activeIndex : undefined,
            'aria-label': props?.ariaLabel ?? selectedLabel,
            'data-value': value,
            'data-open': open === true ? 'true' : 'false',
            onClick: () => { if (open === true) closeMenu(); else openMenu() },
            onKeyDown: onTriggerKeyDown,
          },
          h('span', { className: 'dsh-artel-select__value' }, selectedLabel),
          h('span', { className: 'dsh-artel-select__caret', 'aria-hidden': 'true' }, icon('chevronDown', 10)),
        ),
        open === true
          ? h(
            'div',
            {
              ref: menuRef,
              id: menuId,
              className: 'dsh-artel-menu',
              role: 'listbox',
              tabIndex: -1,
              'data-placement': placement,
              'aria-label': props?.ariaLabel ?? selectedLabel,
              style: geometry === null || geometry === undefined
                ? undefined
                : { left: geometry.left + 'px', top: geometry.top + 'px', maxHeight: geometry.maxHeight + 'px' },
              onMouseDown: (event) => {
                const menu = menuRef.current
                const native = event?.nativeEvent ?? event
                const offsetX = typeof native?.offsetX === 'number' ? native.offsetX : null
                if (menu !== null && menu !== undefined && offsetX !== null && native?.target === menu && offsetX > (menu.clientWidth ?? 0)) return
                if (typeof event?.preventDefault === 'function') event.preventDefault()
              },
            },
            menuGroups,
          )
          : null,
      )
    }

    function ErrorBanner(props) {
      const t = props?.t ?? ((key) => DICTIONARIES.en[key] ?? key)
      const title = props?.title ?? t('error.title')
      return h(
        'div',
        { className: 'dsh-artel-banner', role: 'alert' },
        h('span', { className: 'dsh-artel-tool__icon' }, icon('alert', 14)),
        h(
          'div',
          { className: 'dsh-artel-banner__body' },
          h('div', { className: 'dsh-artel-banner__title' }, title),
          props?.text ? h('div', { className: 'dsh-artel-banner__text' }, props.text) : null,
        ),
        h(
          'div',
          { className: 'dsh-artel-banner__actions' },
          typeof props?.onRetry === 'function' ? h('button', { type: 'button', className: 'dsh-artel-btn', onClick: props.onRetry }, t('error.retry')) : null,
          typeof props?.onDismiss === 'function' ? h('button', { type: 'button', className: 'dsh-artel-btn', onClick: props.onDismiss, title: t('error.dismiss') }, icon('x', 12)) : null,
        ),
      )
    }

    /* ------------------------------------------------------- launcher + root */

    /**
     * Composer tool-row launcher. This is the only mount point for our UI:
     * conversation.input.left renders in both the hero and the regular composer
     * phase, so the button and the portal-mounted surface live in one component.
     * The surface itself is owned by the module store, not by component state,
     * so it survives the entry being re-created by the host.
     */
    function ArtelLauncherRoot(props) {
      const t = translator(props)
      const sessionId = sessionIdOf(props)
      const store = getStore(sessionId, t)
      const snap = useArtelStore(store)
      const open = snap.open === true
      const button = h(
        'button',
        {
          type: 'button',
          className: 'dsh-artel-launcher',
          title: open ? t('surface.close') : t('launcher.open'),
          'aria-label': t('launcher.title'),
          'aria-expanded': open,
          'data-active': open ? 'true' : 'false',
          'data-busy': snap.busy ? 'true' : 'false',
          onClick: () => store.toggle(),
        },
        icon('artel', 15),
        h('span', { className: 'dsh-artel-launcher__label', 'aria-hidden': 'true' }, t('surface.title')),
        snap.busy ? h(Dot, { state: 'ongoing' }) : null,
      )
      if (open !== true) return button
      const surface = h(ArtelOverlay, { store, snap, t, sessionId, useSessions: props.useSessions })
      let mounted = surface
      if (reactDom !== null && typeof reactDom.createPortal === 'function' && typeof document !== 'undefined' && document.body !== undefined && document.body !== null) {
        mounted = reactDom.createPortal(surface, document.body)
      }
      return h(React.Fragment, null, button, mounted)
    }

    /* --------------------------------------------------------------- surface */

    function findConversationHost(sessionId) {
      if (typeof document === 'undefined') return null
      if (typeof document.querySelector !== 'function') return null
      let host = null
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          host = document.querySelector('[data-conversation-content][data-conversation-session="' + CSS.escape(String(sessionId ?? '')) + '"]')
        }
      } catch { host = null }
      if (host === null || host === undefined) host = document.querySelector('[data-conversation-content]')
      if (host === null || host === undefined) host = document.querySelector('[data-conversation-region="chat"]')
      return host ?? null
    }

    function measureConversationRect(sessionId) {
      const host = findConversationHost(sessionId)
      if (host === null || typeof host.getBoundingClientRect !== 'function') return { top: 0, left: 0, width: 0, height: 0 }
      try {
        const rect = host.getBoundingClientRect()
        return {
          top: Math.max(0, Math.round(rect.top)),
          left: Math.max(0, Math.round(rect.left)),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        }
      } catch {
        return { top: 0, left: 0, width: 0, height: 0 }
      }
    }

    /** Fixed overlay that covers exactly the conversation area. */
    function ArtelOverlay(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const sessionId = props.sessionId
      const [rect, setRect] = useState(() => measureConversationRect(sessionId))

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const update = () => setRect(measureConversationRect(sessionId))
        update()
        window.addEventListener('resize', update)
        let observer = null
        try {
          if (typeof ResizeObserver === 'function') {
            const host = findConversationHost(sessionId)
            if (host !== null) {
              observer = new ResizeObserver(update)
              observer.observe(host)
            }
          }
        } catch { observer = null }
        return () => {
          window.removeEventListener('resize', update)
          if (observer !== null) observer.disconnect()
        }
      }, [sessionId])

      // Escape must work no matter where the focus is: the overlay is a portal
      // and the composer/textarea swallows keydown, so listen on the window.
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          const key = event?.key ?? event?.keyCode
          if (key !== 'Escape' && key !== 'Esc' && key !== 27) return
          // A picker menu owns Escape while it is open (the menu listens on its
          // trigger); don't let the same key stroke also close the panel.
          if (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('.dsh-artel-menu') !== null) return
          store.close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeyDown)
        }
      }, [store])

      const sessionCwd = typeof props.useSessions === 'function' ? props.useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) : undefined
      // A conversation host can report a box wider than the window (side panels,
      // a stale rect after a resize); never let the surface spill past the viewport.
      const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0
      const fitWidth = (value, origin) => (value > 0 && viewportWidth > 0 ? Math.max(320, Math.min(value, viewportWidth - Math.max(0, origin))) : value)
      const fitHeight = (value, origin) => (value > 0 && viewportHeight > 0 ? Math.max(240, Math.min(value, viewportHeight - Math.max(0, origin))) : value)
      const fitted = {
        width: fitWidth(rect.width, rect.left),
        height: fitHeight(rect.height, rect.top),
      }
      const style = {
        top: rect.top + 'px',
        left: rect.left + 'px',
        width: fitted.width > 0 ? fitted.width + 'px' : undefined,
        height: fitted.height > 0 ? fitted.height + 'px' : undefined,
        right: fitted.width > 0 ? undefined : 24,
        bottom: fitted.height > 0 ? undefined : 20,
      }

      const run = snap.run
      const showHero = snap.activeRunId === null || run === null

      return h(
        'div',
        {
          className: 'dsh-artel-surface',
          role: 'dialog',
          'aria-label': t('surface.title'),
          style,
          'data-artel-surface': 'true',
        },
        h(
          'div',
          { className: 'dsh-artel-surface__header' },
          h(
            'button',
            { type: 'button', className: 'dsh-artel-surface__back', title: t('surface.backTitle'), 'aria-label': t('surface.backTitle'), onClick: () => store.close() },
            icon('back', 14),
            h('span', null, t('surface.back')),
          ),
          h(
            'div',
            { className: 'dsh-artel-surface__title' },
            h('span', { className: 'dsh-artel-mark', 'aria-hidden': 'true' }, icon('artel', 15)),
            h('span', null, t('surface.title')),
          ),
          h('div', { className: 'dsh-artel-surface__spacer' }),
          run !== null && run !== undefined
            ? h(Pill, { tone: statusTone(run.status) }, h(Dot, { state: statusDotState(run.status) }), h('span', null, statusLabel(t, run.status)))
            : null,
          snap.busy && run === null ? h('span', { className: 'dsh-artel-spin', 'aria-label': t('loading') }) : null,
          run !== null && run !== undefined
            ? h(
              'button',
              { type: 'button', className: 'dsh-artel-btn dsh-artel-refresh', title: t('rail.refresh'), 'aria-label': t('rail.refresh'), onClick: () => { void store.refreshRuns({ silent: false }) } },
              icon('refresh', 13),
            )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-artel-surface__body' },
          h(Rail, { store, snap, t }),
          h(
            'div',
            { className: 'dsh-artel-workspace' },
            snap.error !== null && snap.error !== undefined
              ? h(ErrorBanner, { t, text: snap.error, onRetry: () => { void store.refreshRuns({ silent: false }) }, onDismiss: () => store.dismissError() })
              : null,
            snap.factoryOpen === true
              ? h(FactoryPane, { store, snap, t })
              : showHero
                ? h(HeroNewRun, { store, snap, t, sessionId, sessionCwd })
                : h(RunPane, { store, snap, t }),
          ),
        ),
      )
    }

    /* ----------------------------------------------------------------- rail */

    function Rail(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const groups = useMemo(() => groupRunsByProject(snap.runs), [snap.runs])
      const files = useMemo(() => changeTotal(snap.runs), [snap.runs])
      return h(
        'aside',
        { className: 'dsh-artel-rail', 'aria-label': t('rail.title') },
        h(
          'div',
          { className: 'dsh-artel-rail__head' },
          h('div', { className: 'dsh-artel-rail__title' }, h('span', null, t('rail.title'))),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-artel-rail__factory',
              'data-active': snap.factoryOpen === true ? 'true' : 'false',
              title: t('factory.open'),
              'aria-label': t('factory.open'),
              onClick: () => {
                if (snap.factoryOpen === true) store.closeFactory()
                else void store.openFactory()
              },
            },
            icon('check', 12),
            h('span', null, t('factory.title')),
            snap.queue?.autopilot === true ? h(Dot, { state: 'ongoing' }) : null,
          ),
          snap.activeRunId === null || snap.run === null
            ? null
            : h(
              'button',
              { type: 'button', className: 'dsh-artel-rail__new', onClick: () => store.selectRun(null) },
              icon('plus', 13),
              h('span', null, t('rail.new')),
            ),
        ),
        h(
          'div',
          { className: 'dsh-artel-rail__scroll' },
          snap.runsLoaded !== true && snap.runs.length === 0
            ? h('div', { className: 'dsh-artel-rail__empty' }, t('loading'))
            : null,
          snap.runsLoaded === true && snap.runs.length === 0
            ? h(
              'div',
              { className: 'dsh-artel-rail__empty' },
              h('div', null, t('rail.empty')),
            )
            : null,
          groups.map((group) => h(
            'div',
            { key: group.key === '' ? '__none__' : group.key, className: 'dsh-artel-rail__group' },
            h('div', { className: 'dsh-artel-rail__group-label', title: group.projectPath }, projectLabel(t, group.runs[0])),
            group.runs.map((run) => h(RailRow, { key: run.id, run, active: run.id === snap.activeRunId, t, onSelect: () => store.selectRun(run.id) })),
          )),
        ),
        snap.runs.length === 0
          ? null
          : h(
            'div',
            { className: 'dsh-artel-rail__footer' },
            h('span', null, fill(t('rail.footerRuns'), { n: snap.runs.length })),
            h('span', null, fill(t('rail.footerFiles'), { n: files })),
          ),
      )
    }

    function RailRow(props) {
      const t = props.t
      const run = props.run
      const title = typeof run.task === 'string' && run.task.trim() !== '' ? run.task.trim() : t('run.taskLabel')
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-artel-row',
          'data-active': props.active ? 'true' : 'false',
          'data-run-id': run.id,
          title,
          onClick: props.onSelect,
        },
        h(
          'div',
          { className: 'dsh-artel-row__top' },
          h(Dot, { state: statusDotState(run.status) }),
          h('span', { className: 'dsh-artel-row__title' }, title),
          run.autoqueue === true ? h(Tag, null, t('queue.autopilot')) : null,
        ),
        h('div', { className: 'dsh-artel-row__meta' }, runMeta(t, run)),
      )
    }

    /* ----------------------------------------------------------------- hero */

    function HeroNewRun(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const [task, setTask] = useState('')
      const [mode, setMode] = useState('solo')
      const [picked, setPicked] = useState(null)
      const [fusionPicked, setFusionPicked] = useState(null)
      const textareaRef = useRef(null)
      const project = useMemo(
        () => chooseProject(snap.project, snap.runs, props.sessionCwd),
        [snap.project, snap.runs, props.sessionCwd],
      )
      const rows = useMemo(() => catalogRows(snap.models), [snap.models])
      const fallback = catalogRowOf(snap.models, snap.models?.default) !== undefined
        ? snap.models?.default
        : selectionFromRow(rows[0])
      const selection = picked ?? fallback
      const row = catalogRowOf(snap.models, selection)
      const efforts = row?.efforts ?? []
      const catalogReady = rows.length > 0
      const providerGroups = useMemo(
        () => (snap.models?.providers ?? []).map((provider) => ({
          id: provider.id,
          label: provider.name,
          options: (provider.models ?? []).map((model) => ({ value: provider.id + '/' + model.id, label: model.name ?? model.id })),
        })),
        [snap.models],
      )
      // Fusion pre-seeds five slots: the panel gets distinct catalog rows when
      // the profile has them, the judge and the implementer start on the
      // profile default and can be changed here or on the run page.
      const fusionDefaults = useMemo(() => {
        if (rows.length === 0) return null
        const base = snap.models?.default ?? selectionFromRow(rows[0])
        const slots = []
        for (let index = 0; index < FUSION_SLOT_COUNT; index += 1) {
          slots.push(index < FUSION_PANEL_SIZE ? selectionFromRow(rows[index % rows.length]) : base)
        }
        return slots
      }, [rows, snap.models])
      const fusionSelections = fusionPicked ?? fusionDefaults
      const fusionSlot = (index) => (Array.isArray(fusionSelections) ? fusionSelections[index] : null)
      const chooseFusionModel = (index, key) => {
        const next = rows.find((candidate) => candidate.key === key)
        if (next === undefined) return
        const slots = [...(fusionPicked ?? fusionDefaults ?? [])]
        slots[index] = selectionFromRow(next)
        setFusionPicked(slots)
      }
      const chooseFusionEffort = (index, value) => {
        const current = fusionSlot(index)
        if (current === null || current === undefined) return
        const next = { provider: current.provider, model: current.model }
        if (value !== '') next.reasoningEffort = value
        const slots = [...(fusionPicked ?? fusionDefaults ?? [])]
        slots[index] = next
        setFusionPicked(slots)
      }
      useEffect(() => {
        if (textareaRef.current !== null && typeof textareaRef.current.focus === 'function') textareaRef.current.focus()
      }, [])
      const chooseModel = (key) => {
        const next = rows.find((candidate) => candidate.key === key)
        if (next !== undefined) setPicked(selectionFromRow(next))
      }
      const chooseEffort = (value) => {
        if (selection === null || selection === undefined) return
        const next = { provider: selection.provider, model: selection.model }
        if (value !== '') next.reasoningEffort = value
        setPicked(next)
      }
      const title = t('hero.title')
      const hint = project.name !== ''
        ? fill(t('hero.hint'), { project: project.name })
        : t('hero.hintNoProject')
      const start = () => {
        if (snap.starting === true || task.trim() === '') return
        const fusion = mode === 'fusion'
          ? (Array.isArray(fusionSelections) && fusionSelections.length === FUSION_SLOT_COUNT && fusionSelections.every((slot) => slot !== null && slot !== undefined)
            ? {
              models: {
                panel: fusionSelections.slice(0, FUSION_PANEL_SIZE),
                judge: fusionSelections[FUSION_PANEL_SIZE],
                implementer: fusionSelections[FUSION_SLOT_COUNT - 1],
              },
            }
            : {})
          : selection === null || selection === undefined ? {} : { model: selection }
        void store.startRun({
          task,
          mode,
          ...fusion,
          projectPath: project.projectPath,
        })
      }
      const renderFusionRoutes = () => h(
        'div',
        { className: 'dsh-artel-hero__models dsh-artel-hero__fusion' },
        h('span', { className: 'dsh-artel-hero__fusion-title' }, t('hero.fusion.title')),
        Array.from({ length: FUSION_SLOT_COUNT }, (_, index) => {
          const slot = fusionSlot(index)
          const slotRow = catalogRowOf(snap.models, slot)
          const slotEfforts = slotRow?.efforts ?? []
          const label = index < FUSION_PANEL_SIZE
            ? fill(t('hero.fusion.panel'), { n: index + 1 })
            : index === FUSION_PANEL_SIZE
              ? t('hero.fusion.judge')
              : t('hero.fusion.implementer')
          return h(
            'div',
            { className: 'dsh-artel-model-pick dsh-artel-hero__fusion-pick', key: 'fusion-slot-' + index },
            h('span', { className: 'dsh-artel-model-pick__label' }, label),
            h(
              'div',
              { className: 'dsh-artel-model-pick__pair' },
              h(Picker, {
                className: 'dsh-artel-model-pick__select',
                ariaLabel: label,
                value: slotRow?.key ?? '',
                groups: providerGroups,
                onChange: (key) => chooseFusionModel(index, key),
              }),
              slotEfforts.length > 0
                ? h(Picker, {
                  className: 'dsh-artel-model-pick__select dsh-artel-model-pick__select--effort',
                  ariaLabel: label + ' ' + t('hero.effort'),
                  value: slot?.reasoningEffort ?? '',
                  groups: [{
                    id: 'effort',
                    options: [
                      { value: '', label: t('hero.effortAuto') },
                      ...slotEfforts.map((effort) => ({ value: effort.id, label: effort.label ?? effort.id })),
                    ],
                  }],
                  onChange: (value) => chooseFusionEffort(index, value),
                })
                : null,
            ),
          )
        }),
      )
      return h(
        'div',
        { className: 'dsh-artel-hero' },
        h('h1', { className: 'dsh-artel-hero__title' }, title),
        h(
          'div',
          { className: 'dsh-artel-card dsh-artel-hero__composer' },
          h('textarea', {
            ref: textareaRef,
            className: 'dsh-artel-hero__textarea',
            value: task,
            placeholder: t('hero.placeholder'),
            'aria-label': t('hero.taskLabel'),
            onChange: (event) => setTask(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) { event.preventDefault(); start() }
            },
          }),
          mode === 'fusion' && catalogReady
            ? renderFusionRoutes()
            : catalogReady
              ? h(
                'div',
                { className: 'dsh-artel-hero__models' },
              h(
                'div',
                {
                  className: 'dsh-artel-model-pick',
                  onClick: (event) => {
                    const chip = event?.currentTarget
                    const button = chip !== null && chip !== undefined && typeof chip.querySelector === 'function' ? chip.querySelector('.dsh-artel-select') : null
                    if (button === null || button === undefined) return
                    const target = event?.target
                    if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dsh-artel-select') !== null) return
                    if (typeof button.focus === 'function') button.focus()
                    if (typeof button.click === 'function') button.click()
                  },
                },
                h('span', { className: 'dsh-artel-model-pick__label' }, t('hero.model')),
                h(Picker, {
                  className: 'dsh-artel-model-pick__select',
                  ariaLabel: t('hero.model'),
                  value: row?.key ?? '',
                  groups: snap.models.providers.map((provider) => ({
                    id: provider.id,
                    label: provider.name,
                    options: (provider.models ?? []).map((model) => ({ value: provider.id + '/' + model.id, label: model.name ?? model.id })),
                  })),
                  onChange: chooseModel,
                }),
              ),
              efforts.length > 0
                ? h(
                  'div',
                  {
                    className: 'dsh-artel-model-pick',
                    onClick: (event) => {
                      const chip = event?.currentTarget
                      const button = chip !== null && chip !== undefined && typeof chip.querySelector === 'function' ? chip.querySelector('.dsh-artel-select') : null
                      if (button === null || button === undefined) return
                      const target = event?.target
                      if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.dsh-artel-select') !== null) return
                      if (typeof button.focus === 'function') button.focus()
                      if (typeof button.click === 'function') button.click()
                    },
                  },
                  h('span', { className: 'dsh-artel-model-pick__label' }, t('hero.effort')),
                  h(Picker, {
                    className: 'dsh-artel-model-pick__select',
                    ariaLabel: t('hero.effort'),
                    value: selection?.reasoningEffort ?? '',
                    groups: [{
                      id: 'effort',
                      options: [
                        { value: '', label: t('hero.effortAuto') },
                        ...efforts.map((effort) => ({ value: effort.id, label: effort.label ?? effort.id })),
                      ],
                    }],
                    onChange: chooseEffort,
                  }),
                )
                : null,
            )
            : snap.modelsLoaded === true
              ? h('div', { className: 'dsh-artel-hero__modelHint' }, t('model.unavailable'))
              : null,
          h(
            'div',
            { className: 'dsh-artel-hero__toolbar' },
            h(SegmentedControl, {
              label: t('hero.mode'),
              value: mode,
              onChange: setMode,
              options: MODES.map((value) => ({ value, label: t('mode.' + value), hint: t('mode.' + value + '.hint') })),
            }),
            h('span', { className: 'dsh-artel-hero__mode-hint' }, t('mode.' + mode + '.hint')),
            h('div', { className: 'dsh-artel-surface__spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-artel-btn dsh-artel-btn--primary',
                disabled: snap.starting === true || task.trim() === '',
                onClick: start,
              },
              snap.starting === true ? h('span', { className: 'dsh-artel-spin' }) : null,
              h('span', null, snap.starting === true ? t('hero.starting') : t('hero.start')),
            ),
          ),
        ),
        snap.startError !== null && snap.startError !== undefined
          ? h(ErrorBanner, { t, title: t('error.start'), text: snap.startError, onDismiss: () => store.dismissError() })
          : null,
        h('div', { className: 'dsh-artel-hero__hint' }, hint),
        h(QueueStrip, { store, snap, t, variant: 'hero' }),
      )
    }

    /* --------------------------------------------------------- changes card */

    /** File icon with a fallback for realms without Host primitives. */
    function ChangeFileIcon(props) {
      if (primitives !== null && typeof primitives.FileTypeIcon === 'function') {
        return h(primitives.FileTypeIcon, { size: 14, path: props.path, className: 'dsh-artel-change__icon' })
      }
      return h('span', { className: 'dsh-artel-change__icon', 'aria-hidden': 'true' }, icon('file', 13))
    }

    /** Path label; the primitive splits directories and shows the full title. */
    function ChangePathLabel(props) {
      if (primitives !== null && typeof primitives.PathLabel === 'function') {
        return h(primitives.PathLabel, { path: props.path, className: 'dsh-artel-change__path' })
      }
      return h('span', { className: 'dsh-artel-change__path', title: props.path }, baseName(props.path))
    }

    /** Render unified-diff hunks: a muted header plus coloured lines. */
    function DiffHunks(props) {
      const hunks = Array.isArray(props.hunks) ? props.hunks : []
      const children = []
      for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
        const hunk = hunks[hunkIndex]
        if (hunk === null || hunk === undefined) continue
        if (typeof hunk.header === 'string' && hunk.header !== '') {
          children.push(h('div', { key: 'hunk-' + hunkIndex, className: 'dsh-artel-diff__hunk' }, hunk.header))
        }
        const lines = Array.isArray(hunk.lines) ? hunk.lines : []
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex]
          if (line === null || line === undefined) continue
          children.push(h(
            'div',
            { key: 'line-' + hunkIndex + '-' + lineIndex, className: 'dsh-artel-diff__line', 'data-type': line.type },
            line.text === '' ? ' ' : line.text,
          ))
        }
      }
      return h('div', { className: 'dsh-artel-diff' }, children)
    }

    /** One file row; click expands the lazily fetched diff hunks. */
    function ChangeRow(props) {
      const t = props.t
      const change = props.change
      const open = props.open === true
      const canExpand = change.binary !== true && Array.isArray(change.hunks) && change.hunks.some((hunk) => Array.isArray(hunk?.lines) && hunk.lines.length > 0)
      const label = changeStatusLabel(t, change.status)
      const nums = change.binary === true
        ? [h('span', { key: 'binary', className: 'dsh-artel-change__num dsh-artel-change__num-muted' }, t('changes.binary'))]
        : [
          h('span', { key: 'added', className: 'dsh-artel-change__num dsh-artel-change__num-add' }, '+' + change.added),
          h('span', { key: 'removed', className: 'dsh-artel-change__num dsh-artel-change__num-del' }, '−' + change.removed),
        ]
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-artel-change',
          'data-open': open ? 'true' : 'false',
          'aria-expanded': canExpand === true ? (open ? 'true' : 'false') : undefined,
          'aria-label': change.path + ' — ' + label,
          title: canExpand === true ? (open ? t('changes.collapseFile') : t('changes.expandFile')) : change.path,
          disabled: canExpand === false,
          onClick: canExpand === true ? () => props.onToggle(change.path) : undefined,
        },
        h('span', { className: 'dsh-artel-change__chevron' }, canExpand === true ? icon('chevronRight', 11) : null),
        h(ChangeFileIcon, { path: change.path }),
        h(ChangePathLabel, { path: change.path }),
        h('span', { className: 'dsh-artel-change__status' }, label),
        nums,
      )
    }

    /**
     * Review card: the file list, lazy diffs and the two-step Apply/Discard
     * confirmation. It sits between the feed and the composer; the run's
     * `changeCount` is ignored because the Host can report 0 while editing.
     */
    function ChangesCard(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const run = props.run
      const [collapsed, setCollapsed] = useState(false)
      const [openPath, setOpenPath] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const runId = run?.id

      useEffect(() => {
        setOpenPath(null)
        setConfirming(null)
      }, [runId])

      // Safety net for the review flow: even if the store's loadRun missed the
      // transition, render the card only once the /changes request has run.
      useEffect(() => {
        if (run === null || run === undefined || run.id === undefined) return
        if (!REVIEW_STATUSES.has(run.status)) return
        if (snap.decided !== null) return
        if (snap.changesLoaded === true || snap.changesLoading === true) return
        void store.loadChanges(run.id)
      }, [runId, run?.status, snap.changesLoaded, snap.changesLoading, snap.decided, store])

      if (showsChanges(run) !== true) return null

      const status = String(run.status ?? '')
      const reviewable = REVIEW_STATUSES.has(status)
      const decided = snap.decided !== null && snap.decided !== undefined
        ? snap.decided
        : status === 'applied' ? 'applied' : status === 'discarded' ? 'discarded' : null
      const totals = changeTotals(snap.changes)
      const ordered = orderedChanges(snap.changes)
      const busy = snap.applying === true || snap.discarding === true
      const canDecide = decided === null && reviewable === true && busy === false && snap.changesLoading !== true && ordered.length > 0
      // Orchestrator safety: a half-finished merge has no valid tree to apply,
      // so Apply waits (the Host answers 409 too) while Discard stays available.
      const mergeWarning = mergeBlocked(run)
      const applyDisabled = canDecide === false || mergeWarning === true
      const projectName = baseName(run.projectPath) || t('rail.groupFallback')
      const title = changeTitle(t, ordered.length)
      const appliedHint = typeof run.projectPath === 'string' && run.projectPath !== ''
        ? fill(t('changes.appliedHint'), { project: projectName })
        : t('changes.appliedHintNoProject')

      const head = h(
        'div',
        { className: 'dsh-artel-changes__head' },
        h(
          'div',
          { className: 'dsh-artel-changes__title' },
          icon('file', 13),
          h('span', null, title),
          totals.added > 0 || totals.removed > 0
            ? h(
              'span',
              { className: 'dsh-artel-changes__counts' },
              h('span', { className: 'dsh-artel-changes__add' }, '+' + totals.added),
              h('span', { className: 'dsh-artel-changes__del' }, '−' + totals.removed),
            )
            : null,
        ),
        h('div', { className: 'dsh-artel-changes__spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-artel-changes__iconbtn',
            title: t('changes.refresh'),
            'aria-label': t('changes.refresh'),
            disabled: snap.changesLoading === true || decided !== null,
            onClick: () => {
              if (snap.changesLoading === true) return
              void store.loadChanges(run.id, { force: true })
            },
          },
          snap.changesLoading === true ? h('span', { className: 'dsh-artel-spin' }) : icon('refresh', 12),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-artel-changes__iconbtn',
            title: collapsed ? t('changes.show') : t('changes.hide'),
            'aria-label': collapsed ? t('changes.show') : t('changes.hide'),
            'aria-expanded': collapsed ? 'false' : 'true',
            onClick: () => setCollapsed(!collapsed),
          },
          icon('chevronRight', 12),
        ),
      )

      const bodyChildren = []
      if (snap.changesError !== null && snap.changesError !== undefined) {
        bodyChildren.push(h(ErrorBanner, {
          key: 'error',
          t,
          title: t('changes.loadError'),
          text: snap.changesError,
          onDismiss: () => store.dismissChangesError(),
        }))
      }
      if (snap.changesLoading === true && ordered.length === 0) {
        bodyChildren.push(h('div', { key: 'loading', className: 'dsh-artel-changes__empty' }, h('span', { className: 'dsh-artel-spin' }), h('span', null, t('changes.loading'))))
      }
      if (snap.changesLoading !== true && ordered.length === 0 && decided === null) {
        bodyChildren.push(h('div', { key: 'empty', className: 'dsh-artel-changes__empty' }, t('changes.empty')))
      }
      if (ordered.length > 0) {
        bodyChildren.push(h(
          'div',
          { key: 'files', className: 'dsh-artel-changes__files' },
          ordered.map((change) => h(
            'div',
            { key: change.path, className: 'dsh-artel-change-item' },
            h(ChangeRow, {
              change,
              open: openPath === change.path,
              t,
              onToggle: (path) => setOpenPath(openPath === path ? null : path),
            }),
            openPath === change.path ? h(DiffHunks, { hunks: change.hunks }) : null,
          )),
        ))
      }

      let actions = null
      if (decided !== null) {
        actions = h(
          'div',
          { className: 'dsh-artel-changes__plate', 'data-tone': decided === 'applied' ? 'ok' : 'muted' },
          icon(decided === 'applied' ? 'check' : 'x', 13),
          h('span', null, decided === 'applied' ? t('changes.applied') : t('changes.discarded')),
          h('span', { className: 'dsh-artel-changes__plate-hint' }, decided === 'applied' ? appliedHint : t('changes.discardedHint')),
        )
      } else if (confirming === 'apply') {
        actions = h(
          'div',
          { className: 'dsh-artel-changes__actions' },
          h(
            'div',
            { className: 'dsh-artel-changes__question' },
            h('div', { className: 'dsh-artel-changes__question-title' }, t('changes.applyQuestion')),
            h('div', { className: 'dsh-artel-changes__question-hint' }, fill(t('changes.applyHint'), { project: projectName })),
          ),
          h('div', { className: 'dsh-artel-changes__grow' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-artel-btn dsh-artel-btn--primary',
              disabled: busy === true || mergeWarning === true,
              'aria-label': t('changes.applyYes'),
              onClick: () => {
                if (mergeWarning === true) return
                setConfirming(null)
                void store.applyChanges()
              },
            },
            snap.applying === true ? h('span', { className: 'dsh-artel-spin' }) : null,
            h('span', null, snap.applying === true ? t('changes.applying') : t('changes.applyYes')),
          ),
          h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => setConfirming(null) }, t('changes.applyNo')),
        )
      } else if (confirming === 'discard') {
        actions = h(
          'div',
          { className: 'dsh-artel-changes__actions' },
          h(
            'div',
            { className: 'dsh-artel-changes__question' },
            h('div', { className: 'dsh-artel-changes__question-title' }, t('changes.discardQuestion')),
            h('div', { className: 'dsh-artel-changes__question-hint' }, fill(t('changes.discardHint'), { project: projectName })),
          ),
          h('div', { className: 'dsh-artel-changes__grow' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-artel-btn dsh-artel-btn--danger',
              disabled: busy === true,
              'aria-label': t('changes.discardYes'),
              onClick: () => { setConfirming(null); void store.discardChanges() },
            },
            snap.discarding === true ? h('span', { className: 'dsh-artel-spin' }) : null,
            h('span', null, snap.discarding === true ? t('changes.discarding') : t('changes.discardYes')),
          ),
          h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => setConfirming(null) }, t('changes.discardNo')),
        )
      } else if (reviewable === true && ordered.length > 0) {
        actions = h(
          'div',
          { className: 'dsh-artel-changes__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-artel-btn dsh-artel-btn--primary',
              disabled: applyDisabled,
              title: t('changes.apply'),
              'aria-label': t('changes.apply'),
              onClick: () => {
                if (mergeWarning === true) return
                setConfirming('apply')
              },
            },
            snap.applying === true ? h('span', { className: 'dsh-artel-spin' }) : null,
            h('span', null, snap.applying === true ? t('changes.applying') : t('changes.apply')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-artel-btn dsh-artel-btn--danger',
              disabled: canDecide === false,
              title: t('changes.discard'),
              'aria-label': t('changes.discard'),
              onClick: () => setConfirming('discard'),
            },
            snap.discarding === true ? h('span', { className: 'dsh-artel-spin' }) : null,
            h('span', null, snap.discarding === true ? t('changes.discarding') : t('changes.discard')),
          ),
        )
      }

      const skipped = decided === 'applied' && Array.isArray(snap.skippedFiles) && snap.skippedFiles.length > 0
        ? h('div', { className: 'dsh-artel-changes__skipped' }, fill(t('changes.skipped'), { n: snap.skippedFiles.length }))
        : null

      const mergeNote = mergeWarning === true && decided === null
        ? h(
          'div',
          { className: 'dsh-artel-changes__merge', role: 'status' },
          icon('alert', 12),
          h('span', null, t('parts.mergeUnresolved')),
        )
        : null

      return h(
        'section',
        {
          className: 'dsh-artel-changes',
          'aria-label': title,
          'data-state': decided !== null ? decided : status,
        },
        head,
        collapsed === true
          ? null
          : h('div', { className: 'dsh-artel-changes__body' }, bodyChildren),
        mergeNote,
        actions,
        skipped,
      )
    }

    /* ------------------------------------------------------------- parts card */

    /**
     * Orchestrator plan dashboard. The plan is the promise the user accepts:
     * one row per part with its acceptance conditions (always shown), the
     * agents building and checking it, rework rounds and reviewer remarks,
     * then the merge outcome. It reads only the run summary, so it renders the
     * same while the run is planning, running or waiting.
     */
    function PartsCard(props) {
      const t = props.t
      const run = props.run
      if (run?.mode !== 'orchestrator') return null
      const plan = run?.plan
      if (plan === null || plan === undefined || typeof plan !== 'object') return null
      const parts = planParts(run)
      const summary = typeof plan.summary === 'string' ? plan.summary.trim() : ''
      if (parts.length === 0 && summary === '') return null
      const merge = run?.merge
      const conflicts = Array.isArray(merge?.conflicts) ? merge.conflicts : []
      const unresolved = Array.isArray(merge?.unresolved) ? merge.unresolved : []
      const accepted = parts.filter((part) => part?.status === 'accepted').length
      return h(
        'section',
        {
          className: 'dsh-artel-parts',
          'aria-label': t('parts.title'),
          'data-state': String(run.status ?? ''),
        },
        h(
          'div',
          { className: 'dsh-artel-parts__head' },
          h(
            'div',
            { className: 'dsh-artel-parts__title' },
            icon('users', 13),
            h('span', null, t('parts.title')),
            parts.length > 0
              ? h('span', { className: 'dsh-artel-parts__count' }, fill(t('parts.accepted'), { done: accepted, total: parts.length }))
              : null,
          ),
          h('div', { className: 'dsh-artel-parts__spacer' }),
        ),
        h(
          'div',
          { className: 'dsh-artel-parts__body' },
          summary !== ''
            ? h(
              'div',
              { className: 'dsh-artel-parts__summary' },
              h('span', { className: 'dsh-artel-parts__summary-label' }, t('parts.summaryLabel')),
              h('span', { className: 'dsh-artel-parts__summary-text' }, summary),
            )
            : null,
          parts.map((part, index) => h(PartRow, { key: typeof part?.id === 'string' && part.id !== '' ? part.id : 'part-' + index, part, index, t })),
          conflicts.length > 0
            ? h('div', { className: 'dsh-artel-parts__merge' }, fill(t('parts.mergeResolved'), { n: conflicts.length }))
            : null,
          unresolved.length > 0
            ? h(
              'div',
              { className: 'dsh-artel-parts__warning', role: 'status' },
              icon('alert', 13),
              h('span', null, t('parts.mergeUnresolved')),
            )
            : null,
        ),
      )
    }

    /** One plan part: title + status pill, then the conditions and the trace
     *  the run has collected around it (goal, files, people, rounds, remarks). */
    function PartRow(props) {
      const t = props.t
      const part = props.part
      const index = props.index
      const status = String(part?.status ?? 'pending')
      const conditions = Array.isArray(part?.conditions)
        ? part.conditions.filter((condition) => typeof condition === 'string' && condition.trim() !== '')
        : []
      const files = Array.isArray(part?.files)
        ? part.files.filter((file) => typeof file === 'string' && file !== '')
        : []
      const rounds = typeof part?.rounds === 'number' && part.rounds > 0 ? part.rounds : 0
      const goal = typeof part?.goal === 'string' ? part.goal.trim() : ''
      const remarks = typeof part?.remarks === 'string' ? part.remarks.trim() : ''
      const title = fill(t('parts.item'), {
        n: index + 1,
        title: typeof part?.title === 'string' && part.title.trim() !== '' ? part.title.trim() : status,
      })
      return h(
        'div',
        {
          className: 'dsh-artel-part',
          'data-part-id': typeof part?.id === 'string' && part.id !== '' ? part.id : 'p' + (index + 1),
          'data-status': status,
        },
        h(
          'div',
          { className: 'dsh-artel-part__head' },
          h('span', { className: 'dsh-artel-part__title' }, title),
          h(Pill, { tone: partStatusTone(status) }, partStatusLabel(t, status)),
        ),
        goal !== '' ? h('div', { className: 'dsh-artel-part__goal' }, goal) : null,
        conditions.length > 0
          ? h(
            'div',
            { className: 'dsh-artel-part__conditions' },
            h('div', { className: 'dsh-artel-part__label' }, t('parts.conditionsLabel')),
            h(
              'ul',
              { className: 'dsh-artel-part__list' },
              conditions.map((condition, conditionIndex) => h(
                'li',
                { key: 'condition-' + conditionIndex, className: 'dsh-artel-part__condition' },
                icon('check', 10),
                h('span', null, condition),
              )),
            ),
          )
          : null,
        files.length > 0
          ? h('div', { className: 'dsh-artel-part__files' }, t('parts.filesLabel') + ': ' + files.join(', '))
          : null,
        typeof part?.workerName === 'string' || typeof part?.reviewerName === 'string'
          ? h(
            'div',
            { className: 'dsh-artel-part__people' },
            typeof part?.workerName === 'string' && part.workerName !== ''
              ? h('span', null, roleLabel(t, 'part') + ': ' + part.workerName)
              : null,
            typeof part?.reviewerName === 'string' && part.reviewerName !== ''
              ? h('span', null, roleLabel(t, 'reviewer') + ': ' + part.reviewerName)
              : null,
          )
          : null,
        rounds > 0
          ? h('div', { className: 'dsh-artel-part__rounds' }, fill(t('parts.rounds'), { n: rounds }))
          : null,
        remarks !== '' ? h('div', { className: 'dsh-artel-part__remarks' }, remarks) : null,
      )
    }

    /* -------------------------------------------------------------- run pane */

    function RunPane(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const run = snap.run
      const groups = useMemo(() => feedGroups(snap.feed), [snap.feed])
      const scrollRef = useRef(null)
      useEffect(() => {
        const node = scrollRef.current
        if (node !== null && node !== undefined && node.scrollHeight !== undefined) node.scrollTop = node.scrollHeight
      }, [snap.feed.length])
      return h(
        'div',
        { className: 'dsh-artel-run' },
        h(RunHeader, { run, snap, store, t }),
        h(AgentModelBar, { run, snap, store, t }),
        h(AgentLiveStrip, { run, t }),
        h(
          'div',
          { className: 'dsh-artel-run__scroll', ref: scrollRef },
          snap.feedLoading === true && groups.length === 0
            ? h('div', { className: 'dsh-artel-run__empty' }, h('span', { className: 'dsh-artel-spin' }), h('span', null, t('run.feedLoading')))
            : null,
          groups.length === 0 && snap.feedLoading !== true
            ? h('div', { className: 'dsh-artel-run__empty' }, h(Dot, { state: 'ongoing' }), h('span', null, t('run.feedEmpty')))
            : null,
          groups.length > 0
            ? h('div', { className: 'dsh-artel-run__feed' }, groups.map((group, index) => h(FeedRow, { key: feedKey(group, index), group, run, t })))
            : null,
        ),
        h(PartsCard, { run, t }),
        h(ChangesCard, { store, snap, t, run }),
        h(QueueStrip, { store, snap, t, variant: 'run' }),
        h(ArtelComposer, { store, snap, t, run }),
      )
    }

    /**
     * Per-agent model controls.
     *
     * The hero picks the route every agent starts on; this bar re-routes one
     * agent at a time while the run lives, which is the "reasoning effort per
     * agent" half of the feature: a member can run a cheap model for planning
     * and a strong one for edits, or the other way around.
     */
    function AgentModelBar(props) {
      const t = props.t
      const run = props.run
      const snap = props.snap
      const agents = Array.isArray(run?.agents) ? run.agents : []
      const rows = catalogRows(snap.models)
      if (agents.length === 0 || rows.length === 0) return null
      const editable = !['applied', 'discarded'].includes(run?.status)
      return h(
        'div',
        { className: 'dsh-artel-models', 'aria-label': t('model.title'), title: t('model.hint') },
        agents.map((agent) => h(AgentModelRow, {
          key: agent.id,
          agent,
          rows,
          catalog: snap.models,
          editable,
          saving: snap.modelSaving,
          store: props.store,
          t,
        })),
      )
    }

    function AgentModelRow(props) {
      const t = props.t
      const agent = props.agent
      const selection = agent?.model ?? null
      const row = catalogRowOf(props.catalog, selection)
      const efforts = row?.efforts ?? []
      const saving = props.saving !== null && props.saving !== undefined
      const editable = props.editable === true && saving !== true
      const chooseModel = (key) => {
        const next = props.rows.find((candidate) => candidate.key === key)
        if (next === undefined) return
        void props.store.setAgentModel(agent.id, selectionFromRow(next))
      }
      const chooseEffort = (value) => {
        if (row === undefined) return
        const next = { provider: row.provider, model: row.model }
        if (value !== '') next.reasoningEffort = value
        void props.store.setAgentModel(agent.id, next)
      }
      return h(
        'div',
        { className: 'dsh-artel-models__row', 'data-agent-id': agent.id, title: selectionLabel(props.catalog, selection) || undefined },
        h(Avatar, { name: agent.name }),
        h('span', { className: 'dsh-artel-models__name' }, agent.name),
        h('span', { className: 'dsh-artel-models__role', 'data-role': agent.role ?? 'agent' }, roleLabel(t, agent.role)),
        h(Picker, {
          className: 'dsh-artel-models__select',
          ariaLabel: t('model.agent') + ' ' + agent.name,
          value: row?.key ?? '',
          disabled: editable !== true,
          groups: [
            ...(row === undefined ? [{ id: 'default', options: [{ value: '', label: t('model.default') }] }] : []),
            ...props.catalog.providers.map((provider) => ({
              id: provider.id,
              label: provider.name,
              options: (provider.models ?? []).map((model) => ({ value: provider.id + '/' + model.id, label: model.name ?? model.id })),
            })),
          ],
          onChange: chooseModel,
        }),
        efforts.length > 0
          ? h(Picker, {
            className: 'dsh-artel-models__select dsh-artel-models__select--effort',
            ariaLabel: t('model.effort') + ' ' + agent.name,
            value: selection?.reasoningEffort ?? '',
            disabled: editable !== true,
            groups: [{
              id: 'effort',
              options: [
                { value: '', label: t('model.default') },
                ...efforts.map((effort) => ({ value: effort.id, label: effort.label ?? effort.id })),
              ],
            }],
            onChange: chooseEffort,
          })
          : null,
        saving === true && props.saving === agent.id
          ? h('span', { className: 'dsh-artel-models__saving' }, t('model.saving'))
          : null,
      )
    }

    /** Dot state for one agent row: busy, done, failed, or neither. */
    function agentDotState(agent) {
      const status = String(agent?.status ?? '')
      if (status === 'failed') return 'error'
      if (status === 'working' || status === 'starting' || status === 'planning') return 'ongoing'
      if (status === 'idle') return 'done'
      return 'idle'
    }

    /**
     * What every agent is doing right now.
     *
     * The model bar answers "who runs on what"; this strip answers "who is busy,
     * with what, how long and how full its context is", plus which agents hold
     * the run open. Every number comes from the run summary the Host already
     * sends — the activity of the last session event and the token metering of
     * the agent's own session — so the strip costs no extra request and moves
     * with the same poll as the feed.
     */
    function AgentLiveStrip(props) {
      const t = props.t
      const run = props.run
      const agents = Array.isArray(run?.agents) ? run.agents : []
      if (agents.length === 0) return null
      const live = isActiveRun(run) === true || run?.status === 'waiting'
      if (live !== true) return null
      return h(
        'div',
        { className: 'dsh-artel-live', role: 'list', 'aria-label': t('live.title') },
        h('div', { className: 'dsh-artel-live__head' }, h('span', { className: 'dsh-artel-live__title' }, t('live.title'))),
        agents.map((agent) => h(AgentLiveRow, { key: agent.id, agent, t })),
      )
    }

    function AgentLiveRow(props) {
      const t = props.t
      const agent = props.agent
      const activity = activityOf(agent)
      const share = contextShare(agent)
      const hint = contextHint(t, agent)
      const used = tokenCount(agent?.stats?.context?.tokens)
      const busy = agent?.status === 'working'
      const clock = busy ? durationLabel(agent.turnStartedAt) : ''
      const fallback = activity === null
        ? agentStatusLabel(t, agent?.status)
        : (activity.kind === 'tool' ? fill(t('live.tool'), { tool: activity.tool }) : t('live.thinking'))
      const detail = (activity?.text ?? '') !== '' ? activity.text : fallback
      return h(
        'div',
        { className: 'dsh-artel-live__row', role: 'listitem', 'data-agent-id': agent.id, 'data-status': String(agent.status ?? '') },
        h(Dot, { state: agentDotState(agent) }),
        h('span', { className: 'dsh-artel-live__name', title: agent.name }, agent.name),
        activity === null || activity.kind !== 'tool' ? null : h('span', { className: 'dsh-artel-live__tool' }, activity.tool),
        h('span', { className: 'dsh-artel-live__text', title: detail }, detail),
        clock === '' ? null : h('span', { className: 'dsh-artel-live__clock', title: t('live.turn') }, clock),
        share === null
          ? h('span', { className: 'dsh-artel-live__ctx dsh-artel-live__ctx--empty', title: hint }, '—')
          : h(
            'span',
            { className: 'dsh-artel-live__ctx', title: hint, 'data-fill': String(share), 'data-tone': share >= 80 ? 'high' : (share >= 50 ? 'mid' : 'low') },
            h('span', { className: 'dsh-artel-live__bar', 'aria-hidden': 'true' }, h('span', { className: 'dsh-artel-live__bar-fill', style: { width: share + '%' } })),
            used === '' ? null : h('span', { className: 'dsh-artel-live__used' }, used),
            h('span', { className: 'dsh-artel-live__pct' }, share + '%'),
          ),
      )
    }

    function feedKey(group, index) {
      if (group.type === 'tools' && group.items.length > 0) return 'tools-' + group.items[0].seq
      if (group.event !== undefined && group.event !== null) return group.type + '-' + (group.event.seq ?? index)
      return 'row-' + index
    }

    function RunHeader(props) {
      const t = props.t
      const run = props.run
      const snap = props.snap
      const store = props.store
      const [confirming, setConfirming] = useState(false)
      if (run === null || run === undefined) {
        return h('div', { className: 'dsh-artel-run__head' }, h('div', { className: 'dsh-artel-run__head-main' }, h('div', { className: 'dsh-artel-run__task' }, t('loading'))))
      }
      const task = typeof run.task === 'string' && run.task.trim() !== '' ? run.task.trim() : t('run.taskLabel')
      const active = isActiveRun(run)
      const changeCount = Array.isArray(snap.changes) && snap.changesLoaded === true ? snap.changes.length : (typeof run.changeCount === 'number' ? run.changeCount : 0)
      const changes = changeCount > 0
        ? (changeCount === 1 ? t('run.changesOne') : fill(t('run.changes'), { n: changeCount }))
        : null
      // What the run is waiting for, and how long it has been waiting: the answer
      // to "чего мы ждём" without opening a single agent.
      const waiting = waitingLabel(t, run)
      const waitingKind = run.waitingFor?.kind
      const waitingDot = waitingKind === 'user' || waitingKind === 'approval' ? 'warning' : 'ongoing'
      const waited = waiting === '' ? '' : durationLabel(run.waitingFor?.since)
      const spend = typeof run.spend?.totalTokens === 'number' && run.spend.totalTokens > 0 ? tokenCount(run.spend.totalTokens) : ''
      // The Tag stays short; the split behind it — fresh input, output and
      // cache — is the tooltip, so a wide run does not grow a second row.
      const spendTitle = spend === ''
        ? ''
        : fill(t('live.spendTitle'), {
          input: tokenCount(run.spend.inputTokens),
          output: tokenCount(run.spend.outputTokens),
          cache: tokenCount((run.spend.cacheReadTokens ?? 0) + (run.spend.cacheWriteTokens ?? 0)),
        })
      return h(
        'div',
        { className: 'dsh-artel-run__head' },
        h(
          'div',
          { className: 'dsh-artel-run__head-main' },
          h('div', { className: 'dsh-artel-run__task', title: task }, task),
          h(
            'div',
            { className: 'dsh-artel-run__sub' },
            h(Tag, null, modeLabel(t, run.mode)),
            run.autoqueue === true ? h(Tag, null, t('queue.autopilot')) : null,
            h(Pill, { tone: statusTone(run.status) }, h(Dot, { state: statusDotState(run.status) }), h('span', null, statusLabel(t, run.status))),
            changes !== null ? h(Tag, null, changes) : null,
            waiting !== ''
              ? h(
                'span',
                { className: 'dsh-artel-run__waiting', 'data-kind': String(waitingKind ?? ''), title: waiting + (waited === '' ? '' : ' · ' + waited) },
                h(Dot, { state: waitingDot }),
                h('span', { className: 'dsh-artel-run__waiting-text' }, waiting),
                waited === '' ? null : h('span', { className: 'dsh-artel-run__waiting-clock' }, waited),
              )
              : null,
            spend === '' ? null : h(Tag, { title: spendTitle }, fill(t('live.spend'), { n: spend })),
            h('span', { className: 'dsh-artel-run__phase', title: phaseOf(t, run) }, phaseOf(t, run)),
          ),
        ),
        active
          ? confirming
            ? h(
              'div',
              { className: 'dsh-artel-banner__actions' },
              h('span', { className: 'dsh-artel-hint' }, t('run.stopQuestion')),
              h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--danger', disabled: snap.stopping === true, onClick: () => { setConfirming(false); void store.interrupt() } }, snap.stopping === true ? t('run.stopping') : t('run.stopYes')),
              h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => setConfirming(false) }, t('run.stopNo')),
            )
            : h(
              'button',
              { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--danger', onClick: () => setConfirming(true) },
              icon('stop', 12),
              h('span', null, t('run.stop')),
            )
          : null,
      )
    }

    /* ----------------------------------------------------------------- feed */

    function FeedRow(props) {
      const group = props.group
      const t = props.t
      const run = props.run
      if (group.type === 'tools') return h(ToolsRow, { group, t })
      const event = group.event
      if (event === null || event === undefined) return null
      if (group.type === 'assistant') return h(AgentMessage, { event, t, run })
      if (group.type === 'user') return h(UserBubble, { event, t })
      if (group.type === 'status') return h(StatusRow, { event, t })
      if (group.type === 'plan') return h(PlanCard, { event, t })
      if (group.type === 'peer') return h(PeerRow, { event, t })
      if (group.type === 'collision') return h(NoteRow, { event, t, tone: 'warn', label: t('feed.collision') })
      if (group.type === 'error') return h(NoteRow, { event, t, tone: 'error', label: t('feed.error') })
      if (group.type === 'turnStart' || group.type === 'turnEnd') return h(StatusRow, { event, t })
      if (typeof event.text === 'string' && event.text !== '') return h(StatusRow, { event, t })
      return null
    }

    /** Agent role label: known roles are translated, unknown ones stay raw. */
    function agentRole(t, run, name) {
      const agents = Array.isArray(run?.agents) ? run.agents : []
      let role = 'agent'
      for (const agent of agents) if (agent?.name === name && typeof agent.role === 'string' && agent.role !== '') role = agent.role
      return roleLabel(t, role)
    }

    function AgentMessage(props) {
      const t = props.t
      const event = props.event
      const name = typeof event.agent === 'string' && event.agent !== '' ? event.agent : t('surface.title')
      const role = agentRole(t, props.run, name)
      return h(
        'div',
        { className: 'dsh-artel-msg' },
        h(Avatar, { name }),
        h(
          'div',
          { className: 'dsh-artel-msg__main' },
          h(
            'div',
            { className: 'dsh-artel-msg__head' },
            h('span', { className: 'dsh-artel-msg__name' }, name),
            h('span', { className: 'dsh-artel-msg__role' }, role),
            h('span', { className: 'dsh-artel-msg__time' }, formatWhen(t, event.at)),
          ),
          h(Markdown, { text: event.text, t }),
        ),
      )
    }

    function UserBubble(props) {
      const t = props.t
      const event = props.event
      const recipient = typeof event.agent === 'string' && event.agent !== '' ? fill(t('feed.to'), { name: event.agent }) : t('feed.toAll')
      return h(
        'div',
        { className: 'dsh-artel-user' },
        h(
          'div',
          { className: 'dsh-artel-user__bubble' },
          String(event.text ?? ''),
          h('span', { className: 'dsh-artel-user__to' }, t('feed.you') + ' ' + recipient),
        ),
      )
    }

    function StatusRow(props) {
      const event = props.event
      const text = typeof event.text === 'string' ? event.text.trim() : ''
      if (text === '') return null
      return h(
        'div',
        { className: 'dsh-artel-status-row' },
        h(Dot, { state: 'idle' }),
        h('span', null, text),
        event.at !== undefined ? h('span', { className: 'dsh-artel-msg__time' }, formatWhen(props.t, event.at)) : null,
      )
    }

    function PlanCard(props) {
      const event = props.event
      return h(
        'div',
        { className: 'dsh-artel-plan' },
        h('div', { className: 'dsh-artel-plan__label' }, props.t('feed.plan')),
        h('div', { className: 'dsh-artel-plan__text' }, String(event.text ?? '')),
      )
    }

    function PeerRow(props) {
      const event = props.event
      const from = typeof event.from === 'string' && event.from !== '' ? event.from : props.t('surface.title')
      return h(
        'div',
        { className: 'dsh-artel-peer' },
        h('b', null, from),
        h('span', null, ' → '),
        h('span', null, String(event.text ?? '')),
      )
    }

    function NoteRow(props) {
      const event = props.event
      const label = props.label
      const pieces = [String(event.text ?? '')]
      if (typeof event.path === 'string' && event.path !== '') pieces.push('(' + event.path + ')')
      return h(
        'div',
        { className: 'dsh-artel-note', 'data-tone': props.tone },
        h('div', { className: 'dsh-artel-note__label' }, label),
        h('div', null, pieces.join(' ')),
      )
    }

    /**
     * The tool calls of one agent, collapsed into one card.
     *
     * Each row is a real disclosure: the chevron rotates and the row opens onto
     * the arguments the agent sent and the output (or error) that came back.
     * The chevron was decoration before — it pointed at nothing, which is exactly
     * what "the triangles do not work" meant.
     */
    function ToolsRow(props) {
      const group = props.group
      const t = props.t
      const label = group.items.length === 1 ? t('feed.toolOne') : fill(t('feed.tools'), { n: group.items.length })
      const [open, setOpen] = useState(() => new Set())
      const toggle = (key) => {
        setOpen((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
      const closeAll = () => setOpen(new Set())
      const expanded = open.size > 0
      return h(
        'div',
        { className: 'dsh-artel-tools', title: label },
        expanded
          ? h('button', { type: 'button', className: 'dsh-artel-tools__collapse', onClick: closeAll }, t('feed.collapseAll'))
          : null,
        group.items.map((event, index) => {
          const key = event.seq ?? index
          const callId = typeof event.callId === 'string' ? event.callId : ''
          const result = callId === '' ? undefined : group.results?.get(callId)
          const args = typeof event.args === 'string' && event.args !== '' ? event.args : ''
          const failed = result !== undefined && result.ok === false
          const output = result === undefined ? '' : String(result.text ?? '')
          const expandable = args !== '' || result !== undefined
          const isOpen = open.has(key)
          const name = String(event.tool ?? 'tool')
          const detail = typeof event.path === 'string' && event.path !== '' ? event.path : String(event.text ?? '')
          if (expandable !== true) {
            return h(
              'div',
              { key, className: 'dsh-artel-tool' },
              h('span', { className: 'dsh-artel-tool__icon' }, icon('chevronRight', 11)),
              h('span', { className: 'dsh-artel-tool__name' }, name),
              h('span', { className: 'dsh-artel-tool__text', title: detail }, detail),
            )
          }
          return h(
            'div',
            { key, className: 'dsh-artel-tool dsh-artel-tool--openable', 'data-open': isOpen === true ? 'true' : 'false', 'data-tone': failed ? 'error' : undefined },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-artel-tool__head',
                'aria-expanded': isOpen === true,
                title: isOpen === true ? t('feed.toolClose') : t('feed.toolOpen'),
                onClick: () => toggle(key),
              },
              h('span', { className: 'dsh-artel-tool__icon' }, icon(isOpen === true ? 'chevronDown' : 'chevronRight', 11)),
              h('span', { className: 'dsh-artel-tool__name' }, name),
              h('span', { className: 'dsh-artel-tool__text', title: detail }, detail),
              result === undefined
                ? null
                : h('span', { className: 'dsh-artel-tool__flag', 'data-tone': failed ? 'error' : 'done' }, failed ? t('feed.toolFailed') : t('feed.toolOk')),
            ),
            isOpen === true
              ? h(
                'div',
                { className: 'dsh-artel-tool__body' },
                args === '' ? null : h('div', { className: 'dsh-artel-tool__part' },
                  h('div', { className: 'dsh-artel-tool__label' }, t('feed.toolArgs')),
                  h('pre', { className: 'dsh-artel-tool__code' }, args),
                ),
                result === undefined
                  ? h('div', { className: 'dsh-artel-tool__label' }, t('feed.toolPending'))
                  : h('div', { className: 'dsh-artel-tool__part' },
                    h('div', { className: 'dsh-artel-tool__label' }, failed ? t('feed.toolError') : t('feed.toolResult')),
                    output === ''
                      ? h('div', { className: 'dsh-artel-tool__label' }, t('feed.toolEmpty'))
                      : h('pre', { className: 'dsh-artel-tool__code', 'data-tone': failed ? 'error' : undefined }, output),
                  ),
              )
              : null,
          )
        }),
      )
    }

    /* ------------------------------------------------------------- composer */

    function ArtelComposer(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const run = props.run
      const [text, setText] = useState('')
      const [recipient, setRecipient] = useState('')
      const recipients = useMemo(() => recipientsOf(run), [run])
      const inputRef = useRef(null)
      useEffect(() => {
        if (recipients.some((agent) => agent.id === recipient || agent.name === recipient)) return
        setRecipient('')
      }, [recipients, recipient])
      const canSend = text.trim() !== '' && snap.sending !== true
      const send = () => {
        if (canSend === false) return
        const ok = store.send(text, recipient === '' ? undefined : recipient)
        Promise.resolve(ok).then((accepted) => {
          if (accepted === true) { setText(''); if (inputRef.current !== null) inputRef.current.focus() }
        })
      }
      return h(
        'div',
        { className: 'dsh-artel-composer' },
        h(
          'div',
          { className: 'dsh-artel-composer__card' },
          h('textarea', {
            ref: inputRef,
            className: 'dsh-artel-composer__input',
            value: text,
            rows: 1,
            placeholder: t('composer.placeholder'),
            'aria-label': t('composer.placeholder'),
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey === true || event.ctrlKey === true)) { event.preventDefault(); send() }
            },
          }),
          h(
            'button',
            { type: 'button', className: 'dsh-artel-composer__send', disabled: canSend === false, onClick: send, title: t('composer.send'), 'aria-label': t('composer.send') },
            icon('send', 14),
          ),
        ),
        h(
          'div',
          { className: 'dsh-artel-composer__foot' },
          recipients.length > 0
            ? h(
              'div',
              { className: 'dsh-artel-composer__foot' },
              h('span', null, t('composer.to')),
              h(Picker, {
                ariaLabel: t('composer.to'),
                value: recipient,
                groups: [{
                  id: 'recipient',
                  options: [
                    { value: '', label: t('composer.all') },
                    ...recipients.map((agent) => ({ value: agent.id ?? agent.name, label: agent.name })),
                  ],
                }],
                onChange: setRecipient,
              }),
            )
            : null,
          h('span', { className: 'dsh-artel-composer__hint' }, t('composer.hint')),
        ),
      )
    }

    /* -------------------------------------------------------------- queue */

    function bytesLabel(bytes) {
      if (typeof bytes !== 'number' || Number.isFinite(bytes) !== true || bytes < 0) return ''
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
      return Math.max(0, Math.round(bytes / (1024 * 1024))) + ' MB'
    }

    /** Dot state of a queue task status (the Dot primitive wants state names). */
    function queueDotState(status) {
      if (status === 'running') return 'ongoing'
      if (status === 'passed') return 'done'
      if (status === 'parked') return 'error'
      if (status === 'stopped' || status === 'skipped') return 'warning'
      return 'idle'
    }

    function selectionKey(selection) {
      if (selection === null || selection === undefined) return ''
      if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return ''
      return selection.provider + '/' + selection.model
    }

    function selectionOfKey(key) {
      const text = String(key ?? '')
      const slash = text.indexOf('/')
      if (slash <= 0 || slash === text.length - 1) return null
      return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
    }

    /** Toggle switch used by «Автоочередь» and «Фабрика включена». */
    function Switch(props) {
      const on = props.on === true
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dsh-artel-switch',
          'data-on': on ? 'true' : 'false',
          'aria-checked': on,
          'aria-label': props.label,
          title: props.label,
          disabled,
          onClick: () => { if (disabled !== true && typeof props.onChange === 'function') props.onChange(on !== true) },
        },
        h('span', { className: 'dsh-artel-switch__track', 'aria-hidden': 'true' }, h('span', { className: 'dsh-artel-switch__knob' })),
      )
    }

    /**
     * The «Ожидают» strip: everything waiting for the night shift lives here —
     * the queue of tasks, the toggle, the pre-flight and the results card.
     * Rendered above the composer on a run page and under the hero card on the
     * new-session screen, so a task can be queued from both places.
     */
    function QueueStrip(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const variant = props.variant ?? 'run'
      const queue = snap.queue
      const busy = snap.queueBusy === true
      const counts = queue?.counts ?? null
      const tasks = Array.isArray(queue?.tasks) ? queue.tasks : []
      const autopilot = queue?.autopilot === true
      const preflight = snap.queuePreflight
      const results = queue?.results ?? null
      const [text, setText] = useState('')
      const [mode, setMode] = useState('solo')
      const [showAll, setShowAll] = useState(false)
      const [form, setForm] = useState(null)

      useEffect(() => {
        if (preflight === null || preflight === undefined) { setForm(null); return }
        setForm({
          command: preflight?.check?.command ?? '',
          disabled: preflight?.check?.disabled === true,
          limit: String(preflight?.limit ?? 20),
          choices: {},
        })
      }, [preflight])

      const pending = Array.isArray(preflight?.pendingVersions) ? preflight.pendingVersions : []
      const visible = showAll ? tasks : tasks.filter((task) => task.status === 'running' || task.status === 'queued').slice(0, 4)
      const canAdd = text.trim() !== '' && busy !== true
      const add = () => {
        if (canAdd !== true) return
        void Promise.resolve(store.addQueueTasks({ task: text.trim(), mode })).then((added) => {
          if (added > 0) setText('')
        })
      }
      const flip = () => { void store.setQueueAutopilot({ autopilot: autopilot !== true }) }
      const choose = (runId, choice) => setForm((current) => {
        if (current === null) return current
        const choices = { ...current.choices }
        if (choices[runId] === choice) delete choices[runId]
        else choices[runId] = choice
        return { ...current, choices }
      })
      const decide = () => {
        if (form === null) return
        const saveVersionRunIds = Object.keys(form.choices).filter((id) => form.choices[id] === 'save')
        const postponeVersionRunIds = Object.keys(form.choices).filter((id) => form.choices[id] === 'postpone')
        const limit = Number.parseInt(form.limit, 10)
        const payload = {
          autopilot: true,
          decisions: true,
          saveVersionRunIds,
          postponeVersionRunIds,
          checkDisabled: form.disabled === true,
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          ...(form.command.trim() === '' ? {} : { checkCommand: form.command.trim() }),
        }
        void store.setQueueAutopilot(payload).then(() => setForm(null))
      }
      const taskRow = (task) => h(
        'div',
        { key: task.id, className: 'dsh-artel-queue__task', 'data-status': task.status },
        h(
          'div',
          { className: 'dsh-artel-queue__taskMain' },
          h(Dot, { state: queueDotState(task.status) }),
          h('span', { className: 'dsh-artel-queue__taskTitle', title: task.text ?? task.title }, task.title ?? task.text),
          h('span', { className: 'dsh-artel-queue__taskMeta' }, queueTaskMeta(t, task)),
        ),
        h(
          'div',
          { className: 'dsh-artel-queue__taskActions' },
          task.runId !== null && task.runId !== undefined
            ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('queue.open'), onClick: () => store.selectRun(task.runId) }, icon('arrowRight', 12))
            : null,
          task.status === 'parked' || task.status === 'stopped' || task.status === 'skipped'
            ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, onClick: () => { void store.queueRetry(task.id) } }, t('queue.retry'))
            : null,
          task.status === 'queued'
            ? h(
              'span',
              { className: 'dsh-artel-queue__ico' },
              h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('queue.moveUp'), 'aria-label': t('queue.moveUp'), disabled: busy, onClick: () => { void store.queueMove(task.id, 'up') } }, '↑'),
              h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('queue.moveDown'), 'aria-label': t('queue.moveDown'), disabled: busy, onClick: () => { void store.queueMove(task.id, 'down') } }, '↓'),
            )
            : null,
          h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('queue.remove'), 'aria-label': t('queue.remove'), disabled: busy, onClick: () => { void store.queueRemove(task.id) } }, icon('x', 12)),
        ),
      )
      const preflightCard = preflight === null || preflight === undefined
        ? null
        : h(
          'div',
          { className: 'dsh-artel-queue__preflight' },
          h('div', { className: 'dsh-artel-queue__preflightTitle' }, t('queue.preflight')),
          pending.length > 0
            ? h('div', { className: 'dsh-artel-queue__label' }, t('queue.preflightPending'))
            : null,
          pending.length > 0
            ? h(
              'div',
              { className: 'dsh-artel-queue__list' },
              justify(pending, (version) => h(
                'div',
                { key: version.runId, className: 'dsh-artel-queue__task' },
                h(
                  'div',
                  { className: 'dsh-artel-queue__taskMain' },
                  h('span', { className: 'dsh-artel-queue__taskTitle', title: version.title }, version.title),
                  h('span', { className: 'dsh-artel-queue__taskMeta' }, statusLabel(t, version.status) + ' · ' + fill(t('queue.versions'), { n: version.changeCount ?? 0 })),
                ),
                form === null
                  ? null
                  : h(
                    'div',
                    { className: 'dsh-artel-queue__taskActions' },
                    h(
                      'button',
                      { type: 'button', className: 'dsh-artel-btn', 'data-active': form.choices[version.runId] === 'save' ? 'true' : 'false', onClick: () => choose(version.runId, 'save') },
                      t('queue.saveVersion'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-artel-btn', 'data-active': form.choices[version.runId] === 'postpone' ? 'true' : 'false', onClick: () => choose(version.runId, 'postpone') },
                      t('queue.postponeVersion'),
                    ),
                  ),
              )),
            )
            : h('div', { className: 'dsh-artel-queue__hint' }, t('queue.preflightNone')),
          form === null
            ? null
            : h(
              'div',
              { className: 'dsh-artel-queue__row' },
              h(
                'label',
                { className: 'dsh-artel-queue__field' },
                h('span', { className: 'dsh-artel-queue__label' }, t('queue.checkCommand')),
                h('input', {
                  type: 'text',
                  className: 'dsh-artel-input',
                  value: form.command,
                  placeholder: preflight?.check?.guessed === true ? t('queue.checkGuessed') : '',
                  onChange: (event) => setForm({ ...form, command: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dsh-artel-queue__field dsh-artel-queue__field--narrow' },
                h('span', { className: 'dsh-artel-queue__label' }, t('queue.limit')),
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 200,
                  className: 'dsh-artel-input',
                  value: form.limit,
                  onChange: (event) => setForm({ ...form, limit: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dsh-artel-queue__check' },
                h('input', { type: 'checkbox', checked: form.disabled, onChange: (event) => setForm({ ...form, disabled: event.target.checked }) }),
                h('span', null, t('queue.checkDisabled')),
              ),
            ),
          form === null
            ? null
            : h(
              'div',
              { className: 'dsh-artel-queue__row' },
              h(
                'button',
                { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy, onClick: decide },
                t('queue.continue'),
              ),
              h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => store.dismissQueuePreflight() }, t('queue.close')),
            ),
        )
      const resultsCard = results === null || results === undefined
        ? null
        : h(
          'div',
          { className: 'dsh-artel-queue__results' },
          h('div', { className: 'dsh-artel-queue__resultsTitle' }, t('queue.results')),
          results.stopText !== null && results.stopText !== undefined ? h('div', { className: 'dsh-artel-queue__resultsLine' }, results.stopText) : null,
          justify(results.passed ?? [], (entry) => {
            const versionRun = (Array.isArray(snap.runs) ? snap.runs : []).find((item) => item.id === entry.runId) ?? null
            const versionPath = typeof versionRun?.copyPath === 'string' ? versionRun.copyPath : null
            return h(
              'div',
              { key: 'p-' + entry.taskId, className: 'dsh-artel-queue__resultsLine' },
              h(Dot, { state: 'done' }),
              h('span', null, entry.title),
              h('span', { className: 'dsh-artel-queue__taskMeta' }, fill(t('queue.versions'), { n: entry.changeCount ?? 0 })),
              entry.runId ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, title: t('queue.open'), onClick: () => store.selectRun(entry.runId) }, icon('arrowRight', 12)) : null,
              entry.runId ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, onClick: () => { void store.addQueueTasks({ task: t('queue.rework') + ': ' + entry.title, basePath: versionPath }) } }, t('queue.rework')) : null,
              entry.runId ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, onClick: () => { void store.queueDiscardVersion(entry.runId) } }, t('queue.rollback')) : null,
            )
          }),
          justify(results.parked ?? [], (entry) => h(
            'div',
            { key: 'k-' + entry.taskId, className: 'dsh-artel-queue__resultsLine' },
            h(Dot, { state: 'error' }),
            h('span', null, entry.title),
            h('span', { className: 'dsh-artel-queue__taskMeta' }, entry.reason ?? ''),
          )),
          justify(results.notTaken ?? [], (entry) => h(
            'div',
            { key: 'n-' + entry.taskId, className: 'dsh-artel-queue__resultsLine' },
            h(Dot, { state: 'idle' }),
            h('span', null, entry.title),
            h('span', { className: 'dsh-artel-queue__taskMeta' }, queueStatusLabel(t, entry.status)),
          )),
          h(
            'div',
            { className: 'dsh-artel-queue__row' },
            h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { void store.queueClear() } }, t('queue.clear')),
          ),
        )
      return h(
        'section',
        { className: 'dsh-artel-queue', 'data-variant': variant, 'aria-label': t('queue.title') },
        h(
          'div',
          { className: 'dsh-artel-queue__head' },
          h('div', { className: 'dsh-artel-queue__title' }, icon('users', 14), h('span', null, t('queue.title'))),
          counts !== null
            ? h('span', { className: 'dsh-artel-queue__count', 'data-running': autopilot ? 'true' : 'false' }, queue?.progress?.text ?? fill(t('queue.progressSimple'), { done: counts.done ?? 0, total: counts.total ?? 0 }))
            : null,
          h('span', { className: 'dsh-artel-queue__progress', 'data-running': autopilot ? 'true' : 'false' }),
          h('div', { className: 'dsh-artel-surface__spacer' }),
          autopilot
            ? h(
              'div',
              { className: 'dsh-artel-queue__row' },
              h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { void store.queueFinishAfterCurrent() } }, t('queue.finishAfter')),
              h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--danger', disabled: busy, onClick: () => { void store.queueStop() } }, icon('stop', 11), h('span', null, t('queue.stop'))),
            )
            : null,
          h('div', { className: 'dsh-artel-queue__switchRow' }, h('span', { className: 'dsh-artel-queue__switchLabel' }, t('queue.autopilot')), h(Switch, { on: autopilot, label: t('queue.autopilot'), disabled: busy, onChange: flip })),
        ),
        snap.queueError !== null && snap.queueError !== undefined
          ? h(ErrorBanner, { t, text: snap.queueError, onDismiss: () => store.dismissError?.() })
          : null,
        preflightCard,
        queue === null || queue === undefined
          ? h('div', { className: 'dsh-artel-queue__empty' }, t('queue.empty'))
          : h(
            'div',
            { className: 'dsh-artel-queue__list' },
            visible.length === 0 ? h('div', { className: 'dsh-artel-queue__empty' }, t('queue.empty')) : null,
            visible.map(taskRow),
            tasks.length > visible.length || showAll
              ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost dsh-artel-queue__more', onClick: () => setShowAll(showAll !== true) }, showAll ? t('queue.close') : fill(t('queue.showAll'), { n: tasks.length }))
              : null,
          ),
        h(
          'div',
          { className: 'dsh-artel-queue__add' },
          h('input', {
            type: 'text',
            className: 'dsh-artel-input dsh-artel-queue__input',
            value: text,
            placeholder: t('queue.addPlaceholder'),
            'aria-label': t('queue.addPlaceholder'),
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } },
          }),
          h(Picker, {
            ariaLabel: t('queue.title'),
            value: mode,
            className: 'dsh-artel-queue__mode',
            groups: [{ id: 'mode', options: QUEUE_MODE_IDS.map((id) => ({ value: id, label: modeLabel(t, id) })) }],
            onChange: setMode,
          }),
          h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: canAdd !== true, onClick: add }, t('queue.add')),
        ),
        resultsCard,
        h('div', { className: 'dsh-artel-queue__hint' }, autopilot ? t('queue.runHint') : t('queue.heroToggleHint')),
      )
    }

    /* ------------------------------------------------------------ factory */

    /** Small helpers shared by the factory board and the ticket panel. */
    function justify(list, render) {
      return (Array.isArray(list) ? list : []).map((entry, index) => {
        const node = render(entry, index)
        if (node === null || node === undefined) return null
        if (node.key !== undefined && node.key !== null) return node
        return h(React.Fragment, { key: 'row-' + index }, node)
      })
    }

    function ticketNumber(ticket) {
      const number = Number(ticket?.number)
      return Number.isFinite(number) && number > 0 ? '#' + number : '#–'
    }

    function ticketBadge(ticket, t) {
      if (ticket?.waiting !== null && ticket?.waiting !== undefined) {
        return h('span', { className: 'dsh-artel-factory__badge', 'data-tone': ticket.waiting.kind === 'repair-exhausted' ? 'repair' : 'wait' }, factoryWaitingLabel(t, ticket.waiting.kind))
      }
      if (ticket?.stage === 'ready') return h('span', { className: 'dsh-artel-factory__badge', 'data-tone': 'ok' }, factoryStageLabel(t, 'ready'))
      if (ticket?.stage === 'done') return h('span', { className: 'dsh-artel-factory__badge', 'data-tone': 'ok' }, factoryStageLabel(t, 'done'))
      const round = Number(ticket?.repairRound) || 0
      if (round > 0) return h('span', { className: 'dsh-artel-factory__badge', 'data-tone': 'repair' }, t('factory.repairRound') + ' ' + round)
      return null
    }

    function readinessCard(props) {
      const t = props.t
      const readiness = props.readiness
      if (readiness === null || readiness === undefined) return null
      const checks = Array.isArray(readiness.checks) ? readiness.checks : []
      const problems = checks.filter((check) => check.ok !== true && check.blocking === true)
      if (readiness.ready === true && problems.length === 0 && props.always !== true) return null
      return h(
        'div',
        { className: 'dsh-artel-factory__checks' },
        h('div', { className: 'dsh-artel-factory__sectionTitle' }, props.title ?? t('factory.readiness')),
        checks.map((check) => h(
          'div',
          { key: check.id, className: 'dsh-artel-factory__row', 'data-ok': check.ok === true ? 'true' : 'false', 'data-blocking': check.blocking === true ? 'true' : 'false' },
          h(Dot, { state: check.ok === true ? 'done' : check.blocking === true ? 'error' : 'warning' }),
          h('span', { className: 'dsh-artel-factory__checkLabel' }, check.label ?? check.id),
          check.ok !== true && check.hint !== undefined && check.hint !== null ? h('span', { className: 'dsh-artel-factory__hint' }, check.hint) : null,
        )),
      )
    }

    function factoryFeedRows(props) {
      const t = props.t
      const events = Array.isArray(props.events) ? props.events : []
      if (events.length === 0) return h('div', { className: 'dsh-artel-factory__empty' }, t('factory.eventEmpty'))
      return events.map((event) => h(
        'div',
        { key: event.seq ?? event.at, className: 'dsh-artel-factory__logRow' },
        h('span', { className: 'dsh-artel-factory__logTime' }, clockLabel(event.at)),
        h('span', { className: 'dsh-artel-factory__logText' }, (typeof event.agent === 'string' && event.agent !== '' ? event.agent + ': ' : '') + String(event.text ?? '')),
      ))
    }

    /**
     * «Фабрика»: the per-project ticket board. The pane renders one of three
     * things — the board, a ticket detail, or the board settings — and lives in
     * the same workspace slot as a run, so it is reachable from the rail.
     */
    function FactoryPane(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const board = snap.factoryBoard
      const tickets = Array.isArray(snap.factoryTickets) ? snap.factoryTickets : []
      const ticket = snap.factoryTicket
      const readiness = snap.factoryReadiness ?? board?.readiness ?? null
      const busy = snap.factoryBusy !== null && snap.factoryBusy !== undefined
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [draft, setDraft] = useState(null)
      const [title, setTitle] = useState('')
      const [text, setText] = useState('')
      const [attachments, setAttachments] = useState([])
      const [issueRef, setIssueRef] = useState('')
      const [answer, setAnswer] = useState('')
      const [comment, setComment] = useState('')
      const [newText, setNewText] = useState('')

      useEffect(() => {
        if (board === null || board === undefined) { setDraft(null); return }
        setDraft({
          template: board.template ?? 'normal',
          routes: Array.isArray(board.routes) ? [...board.routes] : ['solo', 'swarm', 'fusion', 'orchestrator'],
          models: { triage: board.models?.triage ?? null, work: board.models?.work ?? null, tests: board.models?.tests ?? null, review: board.models?.review ?? null },
          limits: { workersPerTicket: board.limits?.workersPerTicket ?? 1, ticketsAtOnce: board.limits?.ticketsAtOnce ?? 1, ticketsPerDay: board.limits?.ticketsPerDay ?? 20, allowApiEngine: board.limits?.allowApiEngine !== false, allowLowSubscriptions: board.limits?.allowLowSubscriptions === true },
          commands: { test: board.commands?.test ?? '', check: board.commands?.check ?? '', preview: board.commands?.preview ?? '' },
          appendTests: board.quirks?.appendTests === true,
          trackers: Array.isArray(board.trackers) ? board.trackers.map((entry) => ({ ...entry })) : [],
          enabled: board.enabled === true,
        })
      }, [board?.id, board === null])

      useEffect(() => { setAnswer(''); setComment(''); setNewText(''); setSettingsOpen(false) }, [ticket?.id])

      const rows = catalogRows(snap.models)
      const providerGroups = (snap.models?.providers ?? []).map((provider) => ({
        id: provider.id,
        label: provider.name,
        options: (provider.models ?? []).map((model) => ({ value: provider.id + '/' + model.id, label: model.name ?? model.id })),
      }))
      const modelGroups = [{ id: 'auto', options: [{ value: '', label: t('factory.auto') }] }, ...providerGroups]
      const boardOptions = (snap.factoryBoards ?? []).map((entry) => ({ value: entry.id, label: entry.name ?? entry.projectPath }))
      const updateDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }))
      const updateLimit = (key, value) => setDraft((current) => (current === null ? current : { ...current, limits: { ...current.limits, [key]: value } }))
      const updateCommand = (key, value) => setDraft((current) => (current === null ? current : { ...current, commands: { ...current.commands, [key]: value } }))
      const updateModel = (role, key) => setDraft((current) => (current === null ? current : { ...current, models: { ...current.models, [role]: selectionOfKey(key) } }))
      const toggleRoute = (route) => setDraft((current) => {
        if (current === null) return current
        const routes = current.routes.includes(route) ? current.routes.filter((entry) => entry !== route) : [...current.routes, route]
        return { ...current, routes }
      })
      const addTracker = () => setDraft((current) => {
        if (current === null) return current
        const entry = { kind: 'github', label: 'factory', commentBack: true }
        return { ...current, trackers: [...current.trackers, entry] }
      })
      const updateTracker = (index, patch) => setDraft((current) => {
        if (current === null) return current
        const trackers = current.trackers.map((entry, at) => (at === index ? { ...entry, ...patch } : entry))
        return { ...current, trackers }
      })
      const removeTracker = (index) => setDraft((current) => (current === null ? current : { ...current, trackers: current.trackers.filter((entry, at) => at !== index) }))
      const saveSettings = () => {
        if (draft === null) return
        const patch = {
          template: draft.template,
          routes: draft.routes,
          models: draft.models,
          limits: {
            workersPerTicket: Math.max(1, Number(draft.limits.workersPerTicket) || 1),
            ticketsAtOnce: Math.max(1, Number(draft.limits.ticketsAtOnce) || 1),
            ticketsPerDay: Math.max(1, Number(draft.limits.ticketsPerDay) || 20),
            allowApiEngine: draft.limits.allowApiEngine === true,
            allowLowSubscriptions: draft.limits.allowLowSubscriptions === true,
          },
          commands: draft.commands,
          quirks: { appendTests: draft.appendTests === true },
          trackers: draft.trackers,
          enabled: draft.enabled === true,
        }
        void store.updateFactorySettings(patch)
      }
      const readFiles = (fileList) => {
        const files = Array.from(fileList ?? []).slice(0, 8)
        for (const file of files) {
          if (typeof FileReader !== 'function') continue
          try {
            const reader = new FileReader()
            reader.addEventListener('load', () => {
              const result = String(reader.result ?? '')
              const comma = result.indexOf(',')
              const base64 = comma >= 0 ? result.slice(comma + 1) : ''
              if (base64 === '') return
              setAttachments((current) => [...current, { name: String(file.name ?? 'file'), data: base64 }].slice(0, 8))
            })
            reader.readAsDataURL(file)
          } catch { /* attachments are optional */ }
        }
      }
      const submitTicket = () => {
        if (text.trim() === '') return
        void Promise.resolve(store.addFactoryTicket({ title: title.trim(), text: text.trim(), attachments })).then((created) => {
          if (created !== null && created !== undefined) { setTitle(''); setText(''); setAttachments([]) }
        })
      }
      const importIssue = () => {
        if (issueRef.trim() === '') return
        void Promise.resolve(store.importFactoryIssue(issueRef.trim())).then((created) => {
          if (created !== null && created !== undefined) setIssueRef('')
        })
      }
      const doAction = (verb, payload) => { void store.factoryAction(verb, payload) }

      /* ---- ticket detail ---- */
      if (ticket !== null && ticket !== undefined) {
        const spec = ticket.spec ?? null
        const waiting = ticket.waiting ?? null
        const criteria = ticketCriteriaList(ticket)
        const check = ticket.check ?? null
        const review = ticket.review ?? null
        const waitingKind = waiting?.kind ?? null
        const findings = Array.isArray(waiting?.findings) ? waiting.findings : []
        return h(
          'div',
          { className: 'dsh-artel-factory' },
          h(
            'div',
            { className: 'dsh-artel-factory__head' },
            h(
              'button',
              { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', onClick: () => { void store.selectFactoryTicket(null) } },
              icon('back', 13),
              h('span', null, t('factory.action.back')),
            ),
            h('div', { className: 'dsh-artel-factory__title' }, ticketNumber(ticket) + ' ' + (ticket.title ?? '')),
            h('span', { className: 'dsh-artel-surface__spacer' }),
            h(Pill, { tone: ticket.stage === 'done' ? 'ok' : waitingKind === null ? 'active' : 'warn' }, factoryStageLabel(t, ticket.stage)),
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('rail.refresh'), 'aria-label': t('rail.refresh'), onClick: () => { void store.loadFactoryBoard(board?.id, { silent: false }); void store.selectFactoryTicket(ticket.id) } }, icon('refresh', 12)),
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', onClick: () => store.closeFactory() }, t('factory.close')),
          ),
          h(
            'div',
            { className: 'dsh-artel-factory__body' },
            snap.factoryError !== null && snap.factoryError !== undefined
              ? h(ErrorBanner, { t, text: snap.factoryError, onDismiss: () => store.dismissError?.() })
              : null,
            h(
              'div',
              { className: 'dsh-artel-factory__detail' },
              h(
                'div',
                { className: 'dsh-artel-factory__detailHead' },
                h('div', { className: 'dsh-artel-factory__detailTitle' }, ticket.title ?? ticketNumber(ticket)),
                h('div', { className: 'dsh-artel-factory__meta' },
                  h(Tag, null, t('factory.route') + ': ' + modeLabel(t, ticket.route?.mode ?? ticket.spec?.route ?? 'solo')),
                  ticket.check?.command !== undefined && ticket.check?.command !== null ? h(Tag, null, t('factory.check') + ': ' + String(ticket.check.command)) : null,
                  Array.isArray(ticket.versions) && ticket.versions.length > 0 ? h(Tag, null, fill(t('factory.versions'), { n: ticket.versions.length })) : null,
                ),
              ),
              waiting === null
                ? null
                : h(
                  'div',
                  { className: 'dsh-artel-factory__section dsh-artel-factory__section--waiting' },
                  h('div', { className: 'dsh-artel-factory__sectionTitle' }, factoryWaitingLabel(t, waitingKind)),
                  waitingKind === 'triage-questions' && Array.isArray(waiting.questions)
                    ? justify(waiting.questions, (question) => h('div', { className: 'dsh-artel-factory__line' }, '• ' + question))
                    : null,
                  waitingKind === 'triage-questions'
                    ? h('textarea', { className: 'dsh-artel-factory__textarea', value: answer, placeholder: t('factory.answerPlaceholder'), onChange: (event) => setAnswer(event.target.value) })
                    : null,
                  (waitingKind === 'interrupted' || waitingKind === 'nothing-to-run' || waitingKind === 'postponed') && waiting?.reason !== undefined
                    ? h('div', { className: 'dsh-artel-factory__line' }, waiting.reason)
                    : null,
                  waitingKind === 'plan' ? h('div', { className: 'dsh-artel-factory__line' }, spec?.summary ?? t('factory.waitingHint')) : null,
                  waitingKind === 'repair-exhausted' ? justify(findings, (finding) => h('div', { className: 'dsh-artel-factory__line' }, '• ' + finding)) : null,
                  h(
                    'div',
                    { className: 'dsh-artel-factory__actions' },
                    waitingKind === 'triage-questions'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy || answer.trim() === '', onClick: () => { doAction('answers', { text: answer.trim() }) } }, t('factory.send'))
                      : null,
                    waitingKind === 'plan'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy, onClick: () => { doAction('approve-plan', {}) } }, t('factory.action.approvePlan'))
                      : null,
                    waitingKind === 'repair-exhausted'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { doAction('repair', { action: 'more' }) } }, t('factory.action.more'))
                      : null,
                    waitingKind === 'repair-exhausted'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { doAction('repair', { action: 'accept' }) } }, t('factory.action.accept'))
                      : null,
                    waitingKind === 'repair-exhausted'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { doAction('repair', { action: 'postpone' }) } }, t('factory.action.postpone'))
                      : null,
                    waitingKind !== null && waitingKind !== 'triage-questions' && waitingKind !== 'repair-exhausted'
                      ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { doAction('return', {}) } }, t('factory.action.return'))
                      : null,
                  ),
                  waitingKind === 'triage-questions' || waitingKind === 'interrupted' || waitingKind === 'postponed'
                    ? h(
                      'div',
                      { className: 'dsh-artel-factory__row' },
                      h('textarea', { className: 'dsh-artel-factory__textarea', value: newText, placeholder: t('factory.ticketPlaceholder'), onChange: (event) => setNewText(event.target.value) }),
                      h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy || newText.trim() === '', onClick: () => { doAction('return', { text: newText.trim() }) } }, t('factory.action.return')),
                    )
                    : null,
                ),
              h(
                'div',
                { className: 'dsh-artel-factory__section' },
                h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.spec')),
                h('div', { className: 'dsh-artel-factory__line' }, spec?.summary ?? ticket.text ?? ''),
                criteria.length > 0
                  ? h('div', { className: 'dsh-artel-factory__label' }, t('factory.criteria'))
                  : null,
                criteria.length > 0
                  ? h(
                    'ul',
                    { className: 'dsh-artel-factory__criteria' },
                    justify(criteria, (criterion, index) => h(
                      'li',
                      { key: 'criterion-' + index, 'data-met': criterion.met === true ? 'true' : criterion.met === false ? 'false' : 'unknown' },
                      h(Dot, { state: criterion.met === true ? 'done' : criterion.met === false ? 'error' : 'idle' }),
                      h('span', null, criterion.text),
                    )),
                  )
                  : null,
                Array.isArray(spec?.assumptions) && spec.assumptions.length > 0
                  ? h('div', { className: 'dsh-artel-factory__line' }, spec.assumptions.join(' · '))
                  : null,
                Array.isArray(ticket.route?.notes) && ticket.route.notes.length > 0
                  ? h('div', { className: 'dsh-artel-factory__line' }, ticket.route.notes.join(' · '))
                  : null,
              ),
              check !== null && check !== undefined
                ? h(
                  'div',
                  { className: 'dsh-artel-factory__section' },
                  h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.check')),
                  h('div', { className: 'dsh-artel-factory__line' }, check.command ?? ''),
                  check.reason !== undefined && check.reason !== null ? h('div', { className: 'dsh-artel-factory__line' }, check.reason) : null,
                )
                : null,
              review !== null && review !== undefined
                ? h(
                  'div',
                  { className: 'dsh-artel-factory__section' },
                  h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.review')),
                  h(Pill, { tone: review.verdict === 'accept' ? 'ok' : review.verdict === 'rework' ? 'warn' : 'muted' }, review.verdict ?? ''),
                  justify([...(review.blockers ?? []), ...(review.important ?? [])], (finding) => h('div', { className: 'dsh-artel-factory__line' }, '• ' + finding)),
                  justify(review.minor ?? [], (finding) => h('div', { className: 'dsh-artel-factory__hint' }, finding)),
                )
                : null,
              ticket.pr !== null && ticket.pr !== undefined && ticket.pr.url
                ? h(
                  'div',
                  { className: 'dsh-artel-factory__section' },
                  h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.prUrl')),
                  h('a', { className: 'dsh-artel-factory__link', href: ticket.pr.url, target: '_blank', rel: 'noreferrer' }, ticket.pr.url),
                )
                : null,
              ticket.stage === 'ready'
                ? h(
                  'div',
                  { className: 'dsh-artel-factory__actions' },
                  h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy, onClick: () => { doAction('pull-request', {}) } }, t('factory.action.pr')),
                  h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { doAction('merge', {}) } }, t('factory.action.merge')),
                  h('textarea', { className: 'dsh-artel-factory__textarea', value: comment, placeholder: t('factory.commentPlaceholder'), onChange: (event) => setComment(event.target.value) }),
                  h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy || comment.trim() === '', onClick: () => { doAction('comment', { comment: comment.trim() }) } }, t('factory.action.comment')),
                )
                : null,
              h(
                'div',
                { className: 'dsh-artel-factory__actions dsh-artel-factory__actions--session' },
                typeof (ticket.runId ?? ticket.triageRunId) === 'string'
                  ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-artel-btn dsh-artel-btn--ghost',
                      disabled: busy,
                      onClick: () => {
                        const runId = ticket.runId ?? ticket.triageRunId
                        if (typeof runId === 'string') {
                          store.selectRun(runId)
                          store.closeFactory()
                        }
                      },
                    },
                    icon('arrowRight', 13),
                    h('span', null, t('factory.action.openSession')),
                  )
                  : null,
                ticket.stage !== 'done'
                  ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-artel-btn dsh-artel-btn--ghost',
                      disabled: busy,
                      onClick: () => { doAction('takeover', {}) },
                    },
                    icon('stop', 12),
                    h('span', null, t('factory.action.takeOver')),
                  )
                  : null,
              ),
              h(
                'div',
                { className: 'dsh-artel-factory__section' },
                h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.session')),
                h('div', { className: 'dsh-artel-factory__feed' }, factoryFeedRows({ t, events: snap.factoryFeed })),
              ),
            ),
          ),
        )
      }

      /* ---- settings ---- */
      if (settingsOpen === true && draft !== null) {
        return h(
          'div',
          { className: 'dsh-artel-factory' },
          h(
            'div',
            { className: 'dsh-artel-factory__head' },
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', onClick: () => setSettingsOpen(false) }, icon('back', 13), h('span', null, t('factory.action.back'))),
            h('div', { className: 'dsh-artel-factory__title' }, t('factory.settings')),
            h('span', { className: 'dsh-artel-surface__spacer' }),
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy, onClick: saveSettings }, busy ? t('loading') : t('factory.save')),
          ),
          h(
            'div',
            { className: 'dsh-artel-factory__body dsh-artel-factory__settings' },
            snap.factoryError !== null && snap.factoryError !== undefined ? h(ErrorBanner, { t, text: snap.factoryError, onDismiss: () => store.dismissError?.() }) : null,
            h(
              'div',
              { className: 'dsh-artel-factory__grid' },
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.template')),
              h(SegmentedControl, {
                label: t('factory.template'),
                value: draft.template,
                options: FACTORY_TEMPLATE_IDS.map((id) => ({ value: id, label: factoryTemplateLabel(t, id), hint: factoryTemplateHint(t, id) })),
                onChange: (value) => updateDraft({ template: value }),
              }),
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.routes')),
              h('div', { className: 'dsh-artel-factory__checks' }, FACTORY_ROUTES.map((route) => h(
                'label',
                { key: route, className: 'dsh-artel-factory__check' },
                h('input', { type: 'checkbox', checked: draft.routes.includes(route), onChange: () => toggleRoute(route) }),
                h('span', null, modeLabel(t, route)),
              ))),
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.models')),
              justify(['triage', 'work', 'tests', 'review'], (role) => h(
                'div',
                { key: role, className: 'dsh-artel-factory__row' },
                h('span', { className: 'dsh-artel-factory__label' }, t('factory.model.' + role)),
                h(Picker, {
                  ariaLabel: t('factory.model.' + role),
                  value: selectionKey(draft.models[role]),
                  groups: modelGroups,
                  onChange: (key) => updateModel(role, key),
                }),
              )),
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.limits')),
              justify([
                ['workersPerTicket', t('factory.workers')],
                ['ticketsAtOnce', t('factory.ticketsAtOnce')],
                ['ticketsPerDay', t('factory.ticketsPerDay')],
              ], (row) => h(
                'label',
                { key: row[0], className: 'dsh-artel-factory__row' },
                h('span', { className: 'dsh-artel-factory__label' }, row[1]),
                h('input', {
                  type: 'number',
                  min: 1,
                  className: 'dsh-artel-input',
                  value: draft.limits[row[0]],
                  onChange: (event) => updateLimit(row[0], event.target.value),
                }),
              )),
              h('label', { className: 'dsh-artel-factory__check' }, h('input', { type: 'checkbox', checked: draft.limits.allowApiEngine, onChange: (event) => updateLimit('allowApiEngine', event.target.checked) }), h('span', null, t('factory.allowApi'))),
              h('label', { className: 'dsh-artel-factory__check' }, h('input', { type: 'checkbox', checked: draft.limits.allowLowSubscriptions, onChange: (event) => updateLimit('allowLowSubscriptions', event.target.checked) }), h('span', null, t('factory.allowLow'))),
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.commands')),
              justify([
                ['test', t('factory.testCommand')],
                ['check', t('factory.checkCommand')],
                ['preview', t('factory.previewCommand')],
              ], (row) => h(
                'label',
                { key: row[0], className: 'dsh-artel-factory__row' },
                h('span', { className: 'dsh-artel-factory__label' }, row[1]),
                h('input', { type: 'text', className: 'dsh-artel-input', value: draft.commands[row[0]], onChange: (event) => updateCommand(row[0], event.target.value) }),
              )),
              h('label', { className: 'dsh-artel-factory__check' }, h('input', { type: 'checkbox', checked: draft.appendTests, onChange: (event) => updateDraft({ appendTests: event.target.checked }) }), h('span', null, t('factory.appendTests'))),
              h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.trackers')),
              justify(draft.trackers, (tracker, index) => h(
                'div',
                { key: 'tracker-' + index, className: 'dsh-artel-factory__tracker' },
                h(Picker, {
                  ariaLabel: t('factory.trackerKind'),
                  value: tracker.kind ?? 'github',
                  groups: [{ id: 'kind', options: TRACKER_KIND_IDS.map((kind) => ({ value: kind, label: kind })) }],
                  onChange: (value) => updateTracker(index, { kind: value }),
                }),
                h('input', { type: 'text', className: 'dsh-artel-input', value: tracker.label ?? '', placeholder: t('factory.trackerLabel'), onChange: (event) => updateTracker(index, { label: event.target.value }) }),
                h('label', { className: 'dsh-artel-factory__check' }, h('input', { type: 'checkbox', checked: tracker.commentBack !== false, onChange: (event) => updateTracker(index, { commentBack: event.target.checked }) }), h('span', null, t('factory.trackerComment'))),
                h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', title: t('factory.trackerRemove'), onClick: () => removeTracker(index) }, icon('x', 12)),
              )),
              h('div', { className: 'dsh-artel-factory__actions' },
                h('button', { type: 'button', className: 'dsh-artel-btn', onClick: addTracker }, t('factory.trackerAdd')),
                h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { void store.checkFactoryReadiness() } }, busy ? t('loading') : t('factory.readiness')),
                h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { void store.pollFactoryTrackers() } }, t('factory.pollTrackers')),
              ),
              readinessCard({ t, readiness, always: true }),
              h(
                'label',
                { className: 'dsh-artel-factory__check dsh-artel-factory__check--enabled' },
                h(Switch, { on: draft.enabled, label: t('factory.enabled'), disabled: busy, onChange: (value) => updateDraft({ enabled: value }) }),
                h('span', null, t('factory.enabled')),
              ),
              board?.paused === true ? h('div', { className: 'dsh-artel-factory__hint' }, t('factory.paused')) : null,
            ),
          ),
        )
      }

      /* ---- board ---- */
      const columnOf = (ticketRecord) => factoryTicketColumn(ticketRecord)
      const incoming = h(
        'div',
        { className: 'dsh-artel-factory__incoming' },
        h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.incoming')),
        h('input', { type: 'text', className: 'dsh-artel-input', value: title, placeholder: t('factory.ticketTitle'), 'aria-label': t('factory.ticketTitle'), onChange: (event) => setTitle(event.target.value) }),
        h('textarea', { className: 'dsh-artel-factory__textarea', value: text, placeholder: t('factory.ticketPlaceholder'), 'aria-label': t('factory.ticketPlaceholder'), onChange: (event) => setText(event.target.value) }),
        h(
          'div',
          { className: 'dsh-artel-factory__incomingRow' },
          h(
            'label',
            { className: 'dsh-artel-btn dsh-artel-factory__attach' },
            icon('file', 12),
            h('span', null, t('factory.attach')),
            h('input', { type: 'file', multiple: true, accept: 'image/*,.txt,.md,.pdf', style: { display: 'none' }, onChange: (event) => readFiles(event.target.files) }),
          ),
          attachments.length > 0
            ? h('span', { className: 'dsh-artel-factory__hint' }, attachments.map((entry) => entry.name).join(', '))
            : null,
          h('div', { className: 'dsh-artel-surface__spacer' }),
          h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy || text.trim() === '', onClick: submitTicket }, t('factory.addTicket')),
        ),
        h(
          'div',
          { className: 'dsh-artel-factory__import' },
          h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.importIssue')),
          h('div', { className: 'dsh-artel-factory__hint' }, t('factory.importHint')),
          h(
            'div',
            { className: 'dsh-artel-factory__incomingRow' },
            h('input', {
              type: 'text',
              className: 'dsh-artel-input',
              value: issueRef,
              placeholder: t('factory.importPlaceholder'),
              'aria-label': t('factory.importIssue'),
              onChange: (event) => { setIssueRef(event.target.value); store.dismissFactoryImportError?.() },
              onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); importIssue() } },
            }),
            h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy || issueRef.trim() === '', onClick: importIssue }, busy && snap.factoryBusy === 'import' ? t('loading') : t('factory.import')),
          ),
          snap.factoryImportError !== null && snap.factoryImportError !== undefined
            ? h('div', { className: 'dsh-artel-factory__importError', role: 'alert' }, snap.factoryImportError)
            : null,
        ),
      )
      const boardCard = h(
        'div',
        { className: 'dsh-artel-factory__body' },
        snap.factoryError !== null && snap.factoryError !== undefined
          ? h(ErrorBanner, { t, text: snap.factoryError, onDismiss: () => store.dismissError?.() })
          : null,
        readinessCard({ t, readiness }),
        h(
          'div',
          { className: 'dsh-artel-factory__columns' },
          FACTORY_COLUMNS.map((column) => {
            const cards = tickets.filter((entry) => columnOf(entry) === column.id)
            return h(
              'div',
              { key: column.id, className: 'dsh-artel-factory__column', 'data-waiting': column.waiting === true ? 'true' : 'false' },
              h(
                'div',
                { className: 'dsh-artel-factory__columnHead' },
                h('span', { className: 'dsh-artel-factory__columnTitle' }, factoryColumnLabel(t, column.id)),
                h('span', { className: 'dsh-artel-factory__columnCount' }, cards.length),
              ),
              h(
                'div',
                { className: 'dsh-artel-factory__cards' },
                cards.length === 0 ? h('div', { className: 'dsh-artel-factory__empty' }, t('factory.empty')) : null,
                cards.map((entry) => h(
                  'button',
                  {
                    key: entry.id,
                    type: 'button',
                    className: 'dsh-artel-factory__card',
                    'data-active': snap.factoryTicket?.id === entry.id ? 'true' : 'false',
                    'data-waiting': entry.waiting !== null && entry.waiting !== undefined ? 'true' : 'false',
                    onClick: () => { void store.selectFactoryTicket(entry.id) },
                  },
                  h(
                    'div',
                    { className: 'dsh-artel-factory__cardTop' },
                    h('span', { className: 'dsh-artel-factory__num' }, ticketNumber(entry)),
                    h('span', { className: 'dsh-artel-factory__cardTitle' }, entry.title),
                  ),
                  h(
                    'div',
                    { className: 'dsh-artel-factory__cardMeta' },
                    ticketBadge(entry, t),
                    h('span', { className: 'dsh-artel-factory__hint' }, factoryStageLabel(t, entry.stage)),
                  ),
                )),
              ),
            )
          }),
        ),
        h(
          'div',
          { className: 'dsh-artel-factory__bottom' },
          incoming,
          h(
            'div',
            { className: 'dsh-artel-factory__log' },
            h('div', { className: 'dsh-artel-factory__sectionTitle' }, t('factory.events')),
            factoryFeedRows({ t, events: board?.events?.slice(-8) ?? [] }),
          ),
        ),
      )
      return h(
        'div',
        { className: 'dsh-artel-factory' },
        h(
          'div',
          { className: 'dsh-artel-factory__head' },
          h('div', { className: 'dsh-artel-factory__title' }, icon('check', 14), h('span', null, t('factory.title'))),
          board === null || board === undefined
            ? null
            : h(Picker, {
              ariaLabel: t('factory.board'),
              value: board.id,
              groups: [{ id: 'boards', options: boardOptions }],
              onChange: (value) => { void store.selectFactoryBoard(value) },
            }),
          board !== null && board !== undefined && board.paused === true ? h(Pill, { tone: 'warn' }, t('factory.paused')) : null,
          board !== null && board !== undefined && board.enabled === true && board.paused !== true ? h(Pill, { tone: 'ok' }, t('factory.enabled')) : null,
          h('span', { className: 'dsh-artel-surface__spacer' }),
          board === null || board === undefined
            ? null
            : h(
              'div',
              { className: 'dsh-artel-factory__headTools' },
              h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, title: t('rail.refresh'), 'aria-label': t('rail.refresh'), onClick: () => { void store.loadFactoryBoard(board.id, { silent: false }) } }, icon('refresh', 12)),
              h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => { void store.updateFactorySettings({ paused: board.paused !== true }) } }, board.paused === true ? t('factory.resume') : t('factory.pause')),
              h('button', { type: 'button', className: 'dsh-artel-btn', disabled: busy, onClick: () => setSettingsOpen(true) }, t('factory.settings')),
            ),
          h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', onClick: () => store.closeFactory() }, t('factory.close')),
        ),
        board === null || board === undefined
          ? h(
            'div',
            { className: 'dsh-artel-factory__emptyState' },
            h('div', { className: 'dsh-artel-factory__emptyTitle' }, t('factory.title')),
            h('div', { className: 'dsh-artel-factory__hint' }, t('factory.createHint')),
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: busy, onClick: () => { void store.createFactoryBoard({}) } }, busy ? t('loading') : t('factory.create')),
          )
          : boardCard,
      )
    }

    /* ---------------------------------------------------------- registration */

    const CLIENT_VERSION = '0.8.2'

    /**
     * Register the composer-row entry that mounts both the launcher and the
     * surface portal. The slot is session scoped, so `inject(sessionId)` runs
     * once per session binding and must stay a pure function.
     */
    function registerLauncher(ctx, report) {
      const factory = () => ctx.slots.register(
        {
          name: LAUNCHER_SLOT,
          id: LAUNCHER_ID,
          order: LAUNCHER_ORDER,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        },
        ArtelLauncherRoot,
      )
      ctx.slots.inject(LAUNCHER_SLOT, factory)
      report.steps.push({ step: 'slots', slot: LAUNCHER_SLOT, id: LAUNCHER_ID, order: LAUNCHER_ORDER })
    }

    /** Build the Host-facing diagnostics record (also used by the live dev host). */
    function createReport() {
      return {
        version: CLIENT_VERSION,
        stage: 'applying',
        error: null,
        steps: [],
        rev: typeof window !== 'undefined' && window.__DSH_BOOT__ !== undefined ? window.__DSH_BOOT__.rev : null,
      }
    }

    /** Fire-and-forget client diagnostics for the Host route. */
    function sendClientReport(report) {
      try {
        const base = resolveApiBase()
        const body = JSON.stringify({
          version: report.version,
          stage: report.stage,
          error: report.error,
          steps: report.steps,
          rev: report.rev,
          ua: typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : '',
        })
        if (typeof fetch === 'function') {
          fetch(base + '/client-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {})
        }
      } catch { /* diagnostics must never break the plugin */ }
    }

    /** Expose pure view-model helpers for tests and live debugging. */
    function publishDebug() {
      const debug = {
        version: CLIENT_VERSION,
        dictionaries: DICTIONARIES,
        modes: MODES,
        fill,
        baseName,
        formatWhen,
        describeError,
        statusTone,
        statusDotState,
        statusLabel,
        modeLabel,
        agentStatusLabel,
        roleLabel,
        agentRole,
        isActiveRun,
        agentProgress,
        planParts,
        partStatusTone,
        partStatusLabel,
        mergeBlocked,
        phaseOf,
        runMeta,
        groupRunsByProject,
        timestampOf,
        projectLabel,
        chooseProject,
        chooseActiveRunId,
        changeTotal,
        normalizeChanges,
        changeTotals,
        groupChangesByStatus,
        orderedChanges,
        changeStatusLabel,
        changeTitle,
        showsChanges,
        isReviewStatus,
        avatarTone,
        tokenCount,
        contextShare,
        compositionOf,
        contextHint,
        durationLabel,
        activityOf,
        waitingLabel,
        agentDotState,
        feedGroups,
        recipientsOf,
        createArtelStore,
        getStore,
        measureConversationRect,
        queueHelpers: {
          modes: QUEUE_MODE_IDS,
          statusLabel: queueStatusLabel,
          statusTone: queueStatusTone,
          dotState: queueDotState,
          taskMeta: queueTaskMeta,
          progress: (queue) => queue?.progress?.text ?? '',
          bytesLabel,
        },
        factoryHelpers: {
          routes: FACTORY_ROUTES,
          columns: FACTORY_COLUMN_IDS,
          stageColumn: FACTORY_STAGE_COLUMN,
          templates: FACTORY_TEMPLATE_IDS,
          trackers: TRACKER_KIND_IDS,
          columnLabel: factoryColumnLabel,
          stageLabel: factoryStageLabel,
          waitingLabel: factoryWaitingLabel,
          ticketColumn: factoryTicketColumn,
          criteria: ticketCriteriaList,
          templateLabel: factoryTemplateLabel,
          templateHint: factoryTemplateHint,
          clockLabel,
          selectionKey,
          selectionOfKey,
          ticketNumber,
          importErrorText,
        },
      }
      try { globalThis.__DSH_ARTEL_DEBUG__ = debug } catch { /* ignore */ }
      if (typeof window !== 'undefined') {
        try { window.__DSH_ARTEL_DEBUG__ = debug } catch { /* ignore */ }
        window.__DSH_ARTEL_CLIENT__ = { version: CLIENT_VERSION }
      }
    }

    /* --------------------------------------------------------------- plugin */

    const plugin = {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        const report = createReport()
        try {
          ensureStyles()
          publishDebug()

          const register = (fn, label) => {
            try { fn() } catch (error) {
              report.steps.push({ step: label, ok: false, error: String(error?.message ?? error) })
            }
          }

          if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
            // The untyped three-argument form registers one locale at a time and
            // does not require the LocaleNamespaceMap declaration merging.
            const install = () => {
              const disposers = []
              for (const locale of Object.keys(DICTIONARIES)) {
                try {
                  const dispose = ctx.locale.register(NS, locale, DICTIONARIES[locale])
                  if (typeof dispose === 'function') disposers.push(dispose)
                } catch (error) {
                  report.steps.push({ step: 'locale', locale, ok: false, error: String(error?.message ?? error) })
                }
              }
              return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
            }
            if (typeof ctx.effect === 'function') ctx.effect(install, 'dsh-artel/dictionaries')
            else install()
            report.steps.push({ step: 'locale', ns: NS, locales: Object.keys(DICTIONARIES) })
          }

          if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
            register(() => registerLauncher(ctx, report), 'launcher')
          } else {
            report.steps.push({ step: 'slots', ok: false, error: 'slots service unavailable' })
          }

          if (typeof localStorage !== 'undefined') {
            try {
              if (localStorage.getItem('dsh-artel:debug') === '1') window.__DSH_ARTEL_CTX__ = ctx
            } catch { /* ignore */ }
          }

          report.stage = 'ready'
          window.__DSH_ARTEL_CLIENT__ = report
          sendClientReport(report)
          // Cordis runs apply() as an effect: the return value is validated as a
          // disposer/effect, so an object would be rejected with "Invalid effect".
          return undefined
        } catch (error) {
          report.stage = 'error'
          report.error = String(error?.stack ?? error)
          try { window.__DSH_ARTEL_CLIENT__ = report } catch { /* ignore */ }
          sendClientReport(report)
          throw error
        }
      },
    }

    return plugin
  },
})
})()
