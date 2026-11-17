/**
 * dsh-artel — Client half.
 *
 * One session-scoped right-sidebar page: start a run (solo or swarm), watch the
 * work feed, review the diff of the isolated copy line by line, then apply the
 * files you like to your own project. Everything here talks to the Host half
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

    /** Locale namespace; also the plugin package name. */
    const NS = PACKAGE_ID
    /** Right-sidebar tab type id, kind, and slot keys. */
    const TAB_ID = 'dsh-artel'
    const TAB_KIND = 'artel'
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const HEADER_ACTION_SLOT = 'conversation.session.header.actions'
    const HEADER_ACTION_ID = 'dsh-artel'
    /** Host HTTP prefix. */
    const API_PREFIX = '/api/dsh-artel'
    /** Poll cadence: fast while agents work, slow when the run waits for the user. */
    const POLL_ACTIVE_MS = 1400
    const POLL_IDLE_MS = 5000
    /** Statuses where agents are still busy. */
    const ACTIVE_STATUSES = new Set(['preparing', 'planning', 'running'])
    /** Statuses where the user may review and apply. */
    const REVIEW_STATUSES = new Set(['waiting', 'finished', 'interrupted', 'failed'])
    /** Statuses where a user message can still reach the agents. */
    const MESSAGE_STATUSES = new Set(['running', 'waiting', 'finished', 'failed', 'interrupted'])

    /* ------------------------------------------------------------ strings */

    const en = {
      'tab.title': 'Artel',
      'guide.title': 'Artel',
      'guide.description': 'Run a task in a copy of your project, review the diff, apply it yourself.',
      'action.open': 'Open Artel',
      'action.newTask': 'New task',
      'action.stop': 'Stop',
      'action.refresh': 'Refresh',
      'action.openConversation': 'Open conversation',
      'action.apply': 'Apply',
      'action.discard': 'Discard',
      'action.keep': 'Keep',
      'action.cancel': 'Cancel',
      'action.showDiff': 'Show diff',
      'action.hideDiff': 'Hide diff',

      loading: 'Loading…',
      'error.title': 'Artel could not do that',
      'error.apiMissing': 'The Artel API is not answering. Check that the plugin started without errors.',
      'error.load': 'Artel could not load its runs.',
      'error.retry': 'Try again',
      'error.dismiss': 'Dismiss',

      'empty.title': 'Start a Artel run',
      'empty.lead': 'Describe the task the way you would describe it to a colleague. Artel copies the project first, so the agents never touch your files.',
      'empty.project': 'Project',
      'empty.noProject': 'This chat has no project directory yet.',
      'empty.hint': 'Copy of the project',
      'empty.hintText': 'The agents work only inside that copy. Nothing reaches your files until you apply.',

      'mode.legend': 'How should the work run?',
      'mode.solo': 'Solo',
      'mode.solo.hint': 'One agent does the whole task in its own copy.',
      'mode.swarm': 'Swarm',
      'mode.swarm.hint': 'Three agents share one copy, divide the files first, and see each other\'s messages while they work.',

      'task.label': 'Task',
      'task.placeholder': 'For example: the settings page forgets the selected theme after a reload. Fix it and keep the existing wording.',
      'start': 'Start',
      'starting': 'Starting…',

      'runs.title': 'Previous runs',
      'runs.empty': 'No runs in this chat yet.',

      'status.preparing': 'Preparing',
      'status.planning': 'Dividing work',
      'status.running': 'Working',
      'status.waiting': 'Waiting for you',
      'status.finished': 'Finished',
      'status.failed': 'Failed',
      'status.interrupted': 'Stopped',
      'status.applied': 'Applied',
      'status.discarded': 'Discarded',

      'run.changedFiles': '{n} files changed',
      'run.changedOne': '1 file changed',
      'run.copy': 'Copy',
      'run.project': 'Project',

      'agents.title': 'Agents',
      'agents.owns': 'Owns',
      'agents.none': 'No area announced',
      'agents.whole': 'The whole task',
      'agents.open': 'Open conversation',
      'agents.starting': 'Starting',
      'agents.planning': 'Planning',
      'agents.working': 'Working',
      'agents.idle': 'Idle',
      'agents.failed': 'Failed',
      'agents.peerHint': 'One team, one conversation: messages the agents send each other appear in the feed.',

      'feed.title': 'Work feed',
      'feed.empty': 'Nothing has happened yet. The first actions appear here.',
      'feed.you': 'You',
      'feed.plan': 'Work divided',

      'changes.title': 'Changes',
      'changes.pending': 'Changes appear here when the agents pause.',
      'changes.reading': 'Reading the copy…',
      'changes.empty': 'No files changed.',
      'changes.selectAll': 'All',
      'changes.selectNone': 'None',
      'changes.apply': 'Apply {n} files',
      'changes.applyOne': 'Apply 1 file',
      'changes.applyNone': 'Choose files',
      'changes.discard': 'Discard run',
      'changes.discardQuestion': 'Discard the copy? Your project is not touched.',
      'changes.reviewHint': 'Tick the files you want, then apply them.',
      'changes.binary': 'Binary file — no line diff',
      'changes.addedFile': 'New file',
      'changes.deletedFile': 'Deleted file',
      'changes.noSelection': 'Select at least one file.',
      'changes.blocked': 'Nothing was applied.',
      'changes.applied': 'Applied {n} files to your project.',
      'changes.appliedOne': 'Applied 1 file to your project.',
      'changes.skipped': '{n} files were skipped.',

      'composer.placeholder': 'Ask for a change or describe what is wrong…',
      'composer.send': 'Send',
      'composer.to': 'To',
      'composer.all': 'All agents',
      'composer.cmdEnter': 'Ctrl+Enter sends',

      'notice.started': 'The run has started.',
      'notice.sent': 'Message sent.',
      'notice.stopped': 'The run is stopped. The diff stays available.',
      'notice.discarded': 'Run discarded. Your project was not touched.',

      'time.now': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
    }

    const ru = {
      'tab.title': 'Artel',
      'guide.title': 'Artel',
      'guide.description': 'Запустите задачу в копии проекта, посмотрите диф и примените его сами.',
      'action.open': 'Открыть Artel',
      'action.newTask': 'Новая задача',
      'action.stop': 'Остановить',
      'action.refresh': 'Обновить',
      'action.openConversation': 'Открыть диалог',
      'action.apply': 'Применить',
      'action.discard': 'Выбросить',
      'action.keep': 'Оставить',
      'action.cancel': 'Отмена',
      'action.showDiff': 'Показать диф',
      'action.hideDiff': 'Скрыть диф',

      loading: 'Загрузка…',
      'error.title': 'Artel не смог это сделать',
      'error.apiMissing': 'API Artel не отвечает. Проверьте, что плагин запустился без ошибок.',
      'error.load': 'Artel не смог загрузить прогоны.',
      'error.retry': 'Повторить',
      'error.dismiss': 'Закрыть',

      'empty.title': 'Запустить прогон',
      'empty.lead': 'Опишите задачу так, как описали бы коллеге. Сначала Artel сделает копию проекта, поэтому агенты не тронут ваши файлы.',
      'empty.project': 'Проект',
      'empty.noProject': 'У этого чата ещё нет папки проекта.',
      'empty.hint': 'Копия проекта',
      'empty.hintText': 'Агенты работают только внутри копии. В ваши файлы ничего не попадёт, пока вы не примените.',

      'mode.legend': 'Как вести работу?',
      'mode.solo': 'Solo',
      'mode.solo.hint': 'Один агент делает всю задачу в своей копии.',
      'mode.swarm': 'Swarm',
      'mode.swarm.hint': 'Три агента работают в одной общей копии, сначала делят файлы и видят сообщения друг друга.',

      'task.label': 'Задача',
      'task.placeholder': 'Например: страница настроек теряет выбранную тему после перезагрузки. Исправьте и сохраните текущие формулировки.',
      'start': 'Запустить',
      'starting': 'Запускаю…',

      'runs.title': 'Прошлые прогоны',
      'runs.empty': 'В этом чате ещё не было прогонов.',

      'status.preparing': 'Подготовка',
      'status.planning': 'Делят работу',
      'status.running': 'Работают',
      'status.waiting': 'Ждут вас',
      'status.finished': 'Готово',
      'status.failed': 'Ошибка',
      'status.interrupted': 'Остановлено',
      'status.applied': 'Применено',
      'status.discarded': 'Выброшено',

      'run.changedFiles': 'Файлов изменено: {n}',
      'run.changedOne': 'Изменён 1 файл',
      'run.copy': 'Копия',
      'run.project': 'Проект',

      'agents.title': 'Агенты',
      'agents.owns': 'Ведёт',
      'agents.none': 'Участок не объявлен',
      'agents.whole': 'Вся задача',
      'agents.open': 'Открыть диалог',
      'agents.starting': 'Запуск',
      'agents.planning': 'Планирует',
      'agents.working': 'Работает',
      'agents.idle': 'Свободен',
      'agents.failed': 'Ошибка',
      'agents.peerHint': 'Одна команда, один общий диалог: сообщения агентов друг другу видны в ленте.',

      'feed.title': 'Лента работы',
      'feed.empty': 'Пока ничего не произошло. Первые действия появятся здесь.',
      'feed.you': 'Вы',
      'feed.plan': 'Работа поделена',

      'changes.title': 'Изменения',
      'changes.pending': 'Изменения появятся здесь, когда агенты сделают паузу.',
      'changes.reading': 'Читаю копию…',
      'changes.empty': 'Ни один файл не изменён.',
      'changes.selectAll': 'Все',
      'changes.selectNone': 'Ничего',
      'changes.apply': 'Применить файлов: {n}',
      'changes.applyOne': 'Применить 1 файл',
      'changes.applyNone': 'Выберите файлы',
      'changes.discard': 'Выбросить прогон',
      'changes.discardQuestion': 'Удалить копию? Ваш проект не затрагивается.',
      'changes.reviewHint': 'Отметьте нужные файлы и примените их.',
      'changes.binary': 'Бинарный файл — построчного дифа нет',
      'changes.addedFile': 'Новый файл',
      'changes.deletedFile': 'Удалённый файл',
      'changes.noSelection': 'Отметьте хотя бы один файл.',
      'changes.blocked': 'Ничего не применено.',
      'changes.applied': 'В проект применено файлов: {n}.',
      'changes.appliedOne': 'В проект применён 1 файл.',
      'changes.skipped': 'Пропущено файлов: {n}.',

      'composer.placeholder': 'Попросите доработку или опишите, что не так…',
      'composer.send': 'Отправить',
      'composer.to': 'Кому',
      'composer.all': 'Всем агентам',
      'composer.cmdEnter': 'Ctrl+Enter — отправить',

      'notice.started': 'Прогон запущен.',
      'notice.sent': 'Сообщение отправлено.',
      'notice.stopped': 'Прогон остановлен. Диф остаётся доступным.',
      'notice.discarded': 'Прогон выброшен. Ваш проект не тронут.',

      'time.now': 'только что',
      'time.minutes': '{n} мин назад',
      'time.hours': '{n} ч назад',
    }

    const DICTIONARIES = { en, ru }

    /* ------------------------------------------------------------- styles */

    const STYLES = `
.dsh-artel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; line-height: 1.45; color: var(--dsw-alias-label-primary); background: transparent; }
.dsh-artel * { box-sizing: border-box; }
.dsh-artel button { font: inherit; color: inherit; }
.dsh-artel__body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.dsh-artel__footer { flex: 0 0 auto; border-top: 1px solid var(--dsw-alias-border-l2); padding: 8px 12px 10px; background: var(--dsw-alias-bg-base); }

.dsh-artel__card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-module-platform); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dsh-artel__card--plain { background: transparent; }
.dsh-artel__section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__section-title b { font-weight: 600; color: var(--dsw-alias-label-secondary); }

.dsh-artel__badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-artel__badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-artel__badge--mode { background: var(--dsw-alias-state-business-primary); color: #fff; border-color: transparent; }
.dsh-artel__badge--active { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.dsh-artel__badge--attention { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.dsh-artel__badge--error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsh-artel__badge--muted { color: var(--dsw-alias-label-tertiary); }

.dsh-artel__btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 8px; border: 1px solid transparent; padding: 5px 10px; min-height: 28px; font-size: 12px; cursor: pointer; background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.dsh-artel__btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-artel__btn:disabled { opacity: .45; cursor: default; }
.dsh-artel__btn--primary { background: var(--dsw-alias-state-business-primary); color: #fff; }
.dsh-artel__btn--primary:hover { background: var(--dsw-alias-state-business-primary); filter: brightness(1.06); }
.dsh-artel__btn--ghost { background: transparent; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-artel__btn--ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-artel__btn--danger { background: transparent; border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-artel__btn--danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dsh-artel__btn--icon { padding: 3px; min-height: 24px; width: 26px; background: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-artel__btn--icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-artel__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.dsh-artel__task { margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); }
.dsh-artel__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.dsh-artel__banner { display: flex; align-items: flex-start; gap: 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); padding: 8px 10px; font-size: 12px; }
.dsh-artel__banner--error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.dsh-artel__banner--notice { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.dsh-artel__banner-body { flex: 1 1 auto; min-width: 0; }
.dsh-artel__banner-body strong { display: block; font-weight: 600; }

.dsh-artel__field { display: flex; flex-direction: column; gap: 5px; }
.dsh-artel__label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__input, .dsh-artel__textarea, .dsh-artel__select { width: 100%; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 7px 9px; font: inherit; font-size: 12.5px; outline: none; }
.dsh-artel__textarea { resize: vertical; min-height: 84px; line-height: 1.45; }
.dsh-artel__input:focus, .dsh-artel__textarea:focus, .dsh-artel__select:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 var(--dsw-focus-ring-width, 2px) color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent); }

.dsh-artel__modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dsh-artel__mode { text-align: left; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: transparent; padding: 9px 10px; display: flex; flex-direction: column; gap: 3px; cursor: pointer; }
.dsh-artel__mode:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-artel__mode--on { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.dsh-artel__mode b { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.dsh-artel__mode small { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 1.4; }

.dsh-artel__hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__empty-note { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

.dsh-artel__runs { display: flex; flex-direction: column; gap: 4px; }
.dsh-artel__run-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; padding: 6px 8px; cursor: pointer; }
.dsh-artel__run-row:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.dsh-artel__run-row--on { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-artel__run-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dsh-artel__run-row-task { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel__run-row-sub { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); display: flex; gap: 8px; }

.dsh-artel__agents { display: flex; flex-direction: column; gap: 6px; }
.dsh-artel__agents-hint { margin-top: 6px; }
.dsh-artel__agent { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.dsh-artel__agent-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-artel__agent-top { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.dsh-artel__agent-state { font-size: 10.5px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__agent-state--working { color: var(--dsw-alias-state-business-primary); }
.dsh-artel__claims { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-artel__claim { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; padding: 0 5px; border-radius: 5px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-secondary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel__claim--none { background: transparent; color: var(--dsw-alias-label-tertiary); font-style: italic; font-family: inherit; }

.dsh-artel__feed { display: flex; flex-direction: column; gap: 2px; max-height: 46vh; overflow: auto; border-radius: 8px; padding: 2px; }
.dsh-artel__feed-row { display: grid; grid-template-columns: 58px 1fr; gap: 8px; padding: 3px 4px; border-radius: 6px; font-size: 12px; }
.dsh-artel__feed-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.dsh-artel__feed-who { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 1px; }
.dsh-artel__feed-text { min-width: 0; white-space: pre-wrap; word-break: break-word; }
.dsh-artel__feed-row--status .dsh-artel__feed-text { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.dsh-artel__feed-row--user .dsh-artel__feed-text { color: var(--dsw-alias-label-primary); }
.dsh-artel__feed-row--assistant .dsh-artel__feed-text { color: var(--dsw-alias-label-primary); }
.dsh-artel__feed-row--tool .dsh-artel__feed-text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
.dsh-artel__feed-row--error .dsh-artel__feed-text { color: var(--dsw-alias-state-error-primary); }
.dsh-artel__feed-row--collision .dsh-artel__feed-text { color: var(--dsw-alias-state-error-primary); }
.dsh-artel__feed-row--peer .dsh-artel__feed-text { color: var(--dsw-alias-label-primary); font-style: italic; }
.dsh-artel__feed-row--peer .dsh-artel__feed-who { color: var(--dsw-alias-label-secondary); }
.dsh-artel__feed-row--plan .dsh-artel__feed-text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); border-radius: 6px; padding: 6px 8px; }
.dsh-artel__feed-empty { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); padding: 4px 2px; }

.dsh-artel__files { display: flex; flex-direction: column; gap: 2px; }
.dsh-artel__file { border-radius: 8px; border: 1px solid transparent; }
.dsh-artel__file--open { border-color: var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); }
.dsh-artel__file-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 6px; background: transparent; border: none; border-radius: 8px; cursor: pointer; text-align: left; color: inherit; }
.dsh-artel__file-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-artel__check { width: 14px; height: 14px; flex: 0 0 auto; accent-color: var(--dsw-alias-state-business-primary); }
.dsh-artel__file-status { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; font-weight: 700; width: 14px; text-align: center; }
.dsh-artel__file-status--added { color: #3fa25a; }
.dsh-artel__file-status--deleted { color: var(--dsw-alias-state-error-primary); }
.dsh-artel__file-status--modified { color: var(--dsw-alias-state-business-primary); }
.dsh-artel__file-status--binary { color: var(--dsw-alias-label-tertiary); }
.dsh-artel__file-name { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel__counts { flex: 0 0 auto; display: flex; gap: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; }
.dsh-artel__count-add { color: #3fa25a; }
.dsh-artel__count-del { color: var(--dsw-alias-state-error-primary); }
.dsh-artel__chevron { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); display: inline-flex; transition: transform .12s ease; }
.dsh-artel__chevron--open { transform: rotate(90deg); }

.dsh-artel__diff { margin: 0 0 6px 22px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: auto; max-height: 340px; background: var(--dsw-alias-bg-base); }
.dsh-artel__diff pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; }
.dsh-artel__diff-line { display: grid; grid-template-columns: 38px 38px 14px 1fr; }
.dsh-artel__diff-no { color: var(--dsw-alias-label-tertiary); text-align: right; padding: 0 5px; user-select: none; border-right: 1px solid var(--dsw-alias-border-l2); }
.dsh-artel__diff-mark { text-align: center; user-select: none; color: var(--dsw-alias-label-tertiary); }
.dsh-artel__diff-text { padding: 0 8px; white-space: pre-wrap; word-break: break-word; }
.dsh-artel__diff-line--add { background: var(--dsw-alias-file-diff-added-bg, color-mix(in srgb, #3fa25a 15%, transparent)); }
.dsh-artel__diff-line--add .dsh-artel__diff-mark { color: #3fa25a; }
.dsh-artel__diff-line--add .dsh-artel__diff-no { background: var(--dsw-alias-file-diff-added-gutter, transparent); }
.dsh-artel__diff-line--del { background: var(--dsw-alias-file-diff-deleted-bg, color-mix(in srgb, #d9534f 15%, transparent)); }
.dsh-artel__diff-line--del .dsh-artel__diff-mark { color: var(--dsw-alias-state-error-primary); }
.dsh-artel__diff-line--del .dsh-artel__diff-no { background: var(--dsw-alias-file-diff-deleted-gutter, transparent); }
.dsh-artel__diff-head { display: block; padding: 2px 8px; color: var(--dsw-alias-label-tertiary); border-top: 1px solid var(--dsw-alias-border-l1); }

.dsh-artel__composer { display: flex; flex-direction: column; gap: 6px; }
.dsh-artel__composer-row { display: flex; align-items: center; gap: 8px; }
.dsh-artel__composer-row .dsh-artel__select { width: auto; flex: 0 0 auto; max-width: 45%; }
.dsh-artel__composer-row .dsh-artel__hint { margin-left: auto; }
.dsh-artel__composer textarea { min-height: 48px; max-height: 140px; resize: none; }

.dsh-artel__header-button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-artel__header-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-artel__tab-title { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.dsh-artel__tab-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel__spinner { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l3); border-top-color: var(--dsw-alias-state-business-primary); animation: dsh-artel-spin .8s linear infinite; flex: 0 0 auto; }
@keyframes dsh-artel-spin { to { transform: rotate(360deg); } }
`

    /** Inject the page stylesheet once, tagged as plugin CSS so the client keeps it. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById('dsh-artel-style')
      if (existing !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-artel-style'
      style.dataset.plugin = 'dsh-artel'
      style.dataset.pluginCss = 'dsh-artel/client.css'
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- api */

    /** Resolve the API prefix against the page base so subpath deployments work. */
    function resolveApiBase(baseUri) {
      let pathname = '/'
      try {
        pathname = new URL(baseUri ?? document.baseURI, document.baseURI).pathname
      } catch {
        pathname = '/'
      }
      const directory = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1)
      return `${directory.replace(/\/+$/, '')}${API_PREFIX}`
    }

    /**
     * Build the Fetch client for the Host routes.
     * @param {(key: string, fallback?: string) => string} tt translate.
     * @returns {object} API surface.
     */
    function createApi(tt) {
      const request = async (method, path, body, options = {}) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000)
        try {
          const init = { method, signal: controller.signal, headers: { accept: 'application/json' } }
          if (body !== undefined) {
            init.headers['content-type'] = 'application/json'
            init.body = JSON.stringify(body)
          }
          const response = await fetch(resolveApiBase() + path, init)
          const text = await response.text()
          let payload = null
          if (text !== '') {
            try {
              payload = JSON.parse(text)
            } catch {
              payload = null
            }
          }
          if (!response.ok) {
            const error = new Error(
              response.status === 404
                ? tt('error.apiMissing')
                : (payload !== null && (payload.error || payload.message)) || `HTTP ${response.status}`,
            )
            error.status = response.status
            error.code = payload !== null && typeof payload.code === 'string' ? payload.code : undefined
            throw error
          }
          if (payload === null) {
            const error = new Error(tt('error.apiMissing'))
            error.status = response.status
            error.code = 'artel/bad-response'
            throw error
          }
          return payload
        } finally {
          clearTimeout(timer)
        }
      }
      return {
        health: () => request('GET', '/health'),
        listRuns: (sessionId) => request('GET', `/runs?sessionId=${encodeURIComponent(sessionId)}`),
        startRun: (payload) => request('POST', '/runs', payload, { timeoutMs: 180000 }),
        getRun: (runId, cursor, limit) => request(
          'GET',
          `/runs/${encodeURIComponent(runId)}?cursor=${cursor ?? 0}&limit=${limit ?? 200}`,
        ),
        sendMessage: (runId, payload) => request('POST', `/runs/${encodeURIComponent(runId)}/messages`, payload),
        interrupt: (runId) => request('POST', `/runs/${encodeURIComponent(runId)}/interrupt`, {}),
        changes: (runId) => request('GET', `/runs/${encodeURIComponent(runId)}/changes`, undefined, { timeoutMs: 180000 }),
        diff: (runId, filePath) => request(
          'GET',
          `/runs/${encodeURIComponent(runId)}/diff?path=${encodeURIComponent(filePath)}`,
        ),
        apply: (runId, paths) => request(
          'POST',
          `/runs/${encodeURIComponent(runId)}/apply`,
          Array.isArray(paths) ? { paths } : {},
          { timeoutMs: 180000 },
        ),
        discard: (runId) => request('POST', `/runs/${encodeURIComponent(runId)}/discard`, {}),
      }
    }

    /* -------------------------------------------------------------- utils */

    /**
     * Fill `{name}` placeholders in a translated string.
     * @param {string} template - translated text.
     * @param {Record<string, unknown>} values - placeholder values.
     * @returns {string} filled text.
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        values !== null && values !== undefined && name in values ? String(values[name]) : match
      ))
    }

    /** Last path segment of a native or POSIX path. */
    function baseName(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]+/).filter((part) => part !== '')
      return parts.length === 0 ? value : parts[parts.length - 1]
    }

    /** Compact "3m ago" style label for a timestamp. */
    function formatWhen(tt, at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const delta = Date.now() - at
      if (delta < 45000) return tt('time.now')
      if (delta < 3600000) return fill(tt('time.minutes'), { n: Math.max(1, Math.round(delta / 60000)) })
      if (delta < 86400000) return fill(tt('time.hours'), { n: Math.round(delta / 3600000) })
      try {
        return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** One-line description of a failed API call. */
    function describeError(error, tt) {
      if (error === null || error === undefined) return tt('error.title')
      const code = typeof error.code === 'string' ? error.code : ''
      const message = typeof error.message === 'string' ? error.message : String(error)
      if (code === 'artel/apply-conflict') return message
      return message
    }

    /** Statuses that get the "attention" badge treatment. */
    function statusTone(status) {
      if (status === 'waiting' || status === 'finished') return 'attention'
      if (status === 'failed' || status === 'interrupted') return 'error'
      if (ACTIVE_STATUSES.has(status)) return 'active'
      return 'muted'
    }

    /** Status label key. */
    function statusLabel(tt, status) {
      const key = `status.${status}`
      return tt(key)
    }

    /* -------------------------------------------------------------- icons */

    const ICON_PATHS = {
      artel: ['M3.5 7.25A1.75 1.75 0 0 1 5.25 5.5h4.7l1.6 1.9h7.2a1.75 1.75 0 0 1 1.75 1.75v6.6a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75z'],
      play: ['M8.5 5.4v13.2L19 12z'],
      stop: ['M7 7h10v10H7z'],
      plus: ['M12 5.5v13', 'M5.5 12h13'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
      chevron: ['M9.5 6.5l6 5.5-6 5.5'],
      file: ['M6.5 3.5h6.6l4.4 4.4v12.6H6.5z', 'M13 3.5v4.6h4.5'],
      users: ['M9 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3.8 19.2c.5-2.6 2.6-4.2 5.2-4.2s4.7 1.6 5.2 4.2', 'M15.6 11a2.6 2.6 0 1 0 0-5.2', 'M16.4 14.6c2 .4 3.4 1.9 3.8 4'],
      refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v5h-5'],
      arrows: ['M8 4.5v6', 'M8 4.5L5.5 7', 'M8 4.5L10.5 7', 'M16 19.5v-6', 'M16 19.5L13.5 17', 'M16 19.5L18.5 17'],
    }

    /**
     * Inline stroke icon.
     * @param {string} kind - icon name.
     * @param {number} [size] - square size in pixels.
     * @returns {object} React element.
     */
    function icon(kind, size) {
      const paths = ICON_PATHS[kind] ?? ICON_PATHS.file
      const filled = kind === 'play' || kind === 'stop'
      return h(
        'svg',
        {
          width: size ?? 16,
          height: size ?? 16,
          viewBox: '0 0 24 24',
          fill: filled ? 'currentColor' : 'none',
          stroke: filled ? 'none' : 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    /* --------------------------------------------------------- persistence */

    /** localStorage slot that remembers the run the user was looking at. */
    function storageKey(sessionId) {
      return `dsh-artel:last-run:${sessionId}`
    }

    function readStoredRun(sessionId) {
      try {
        return window.localStorage.getItem(storageKey(sessionId))
      } catch {
        return null
      }
    }

    function storeRun(sessionId, runId) {
      try {
        if (typeof runId === 'string' && runId !== '') window.localStorage.setItem(storageKey(sessionId), runId)
        else window.localStorage.removeItem(storageKey(sessionId))
      } catch {
        // Private mode or a locked store: remembering the tab is optional.
      }
    }

    /* ----------------------------------------------------------- section UI */

    function SectionTitle({ text, aside }) {
      return h(
        'div',
        { className: 'dsh-artel__section-title' },
        h('b', null, text),
        aside ?? null,
      )
    }

    function ErrorBanner({ tt, error, onDismiss, onRetry }) {
      return h(
        'div',
        { className: 'dsh-artel__banner dsh-artel__banner--error', role: 'alert' },
        h('div', { className: 'dsh-artel__banner-body' },
          h('strong', null, tt('error.title')),
          h('div', null, error)),
        onRetry !== undefined ? h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', onClick: onRetry }, tt('error.retry')) : null,
        onDismiss !== undefined ? h('button', { className: 'dsh-artel__btn dsh-artel__btn--icon', type: 'button', onClick: onDismiss, title: tt('error.dismiss') }, icon('x', 12)) : null,
      )
    }

    function NoticeBanner({ tt, text, onDismiss }) {
      return h(
        'div',
        { className: 'dsh-artel__banner dsh-artel__banner--notice', role: 'status' },
        h('div', { className: 'dsh-artel__banner-body' }, text),
        onDismiss !== undefined ? h('button', { className: 'dsh-artel__btn dsh-artel__btn--icon', type: 'button', onClick: onDismiss, title: tt('error.dismiss') }, icon('x', 12)) : null,
      )
    }

    /* -------------------------------------------------------------- new run */

    function ModePicker({ tt, mode, onPick }) {
      const options = [
        { id: 'solo', title: tt('mode.solo'), hint: tt('mode.solo.hint'), glyph: 'file' },
        { id: 'swarm', title: tt('mode.swarm'), hint: tt('mode.swarm.hint'), glyph: 'users' },
      ]
      return h(
        'div',
        { className: 'dsh-artel__field' },
        h('span', { className: 'dsh-artel__label' }, tt('mode.legend')),
        h('div', { className: 'dsh-artel__modes' },
          options.map((option) => h(
            'button',
            {
              key: option.id,
              type: 'button',
              className: `dsh-artel__mode${mode === option.id ? ' dsh-artel__mode--on' : ''}`,
              onClick: () => onPick(option.id),
              'aria-pressed': mode === option.id,
            },
            h('b', null, icon(option.glyph, 13), option.title),
            h('small', null, option.hint),
          ))),
      )
    }

    function RunRow({ tt, run, active, onOpen }) {
      const sub = [
        statusLabel(tt, run.status),
        fill(tt('run.changedFiles'), { n: run.changeCount ?? 0 }),
        formatWhen(tt, run.updatedAt ?? run.createdAt),
      ].filter((part) => typeof part === 'string' && part !== '')
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-artel__run-row${active ? ' dsh-artel__run-row--on' : ''}`,
          onClick: () => onOpen(run.id),
          title: run.task,
        },
        h('span', { className: `dsh-artel__badge${run.mode === 'swarm' ? ' dsh-artel__badge--mode' : ''}` }, run.mode === 'swarm' ? tt('mode.swarm') : tt('mode.solo')),
        h('span', { className: 'dsh-artel__run-row-main' },
          h('span', { className: 'dsh-artel__run-row-task' }, run.task),
          h('span', { className: 'dsh-artel__run-row-sub' }, sub.map((part, index) => h('span', { key: index }, part)))),
      )
    }

    function NewRunView({ tt, sessionId, run, runs, busy, error, onDismissError, onStart, onOpenRun, projectPath }) {
      const [mode, setMode] = useState('solo')
      const [task, setTask] = useState('')
      const areaRef = useRef(null)

      useEffect(() => {
        const area = areaRef.current
        if (area !== null && typeof area.focus === 'function') area.focus()
      }, [])

      const start = () => {
        const text = task.trim()
        if (text === '' || busy) return
        onStart(mode, text)
      }

      return h(
        'div',
        { className: 'dsh-artel__body' },
        error !== null ? h(ErrorBanner, { tt, error, onDismiss: onDismissError }) : null,
        run !== null ? h(
          'section',
          { className: 'dsh-artel__card dsh-artel__card--plain' },
          h('div', { className: 'dsh-artel__section-title' }, h('b', null, tt('status.' + run.status))),
          h('p', { className: 'dsh-artel__task' }, run.task),
          h('div', { className: 'dsh-artel__actions' },
            h('button', { className: 'dsh-artel__btn dsh-artel__btn--primary', type: 'button', onClick: () => onOpenRun(run.id) }, tt('action.open'))),
        ) : null,
        h(
          'section',
          { className: 'dsh-artel__card' },
          h('div', { className: 'dsh-artel__section-title' }, h('b', null, tt('empty.title'))),
          h('p', { className: 'dsh-artel__hint' }, tt('empty.lead')),
          projectPath !== null && projectPath !== undefined && projectPath !== ''
            ? h('div', { className: 'dsh-artel__meta' },
              h('span', { title: projectPath }, `${tt('empty.project')}: ${projectPath}`))
            : null,
          h(ModePicker, { tt, mode, onPick: setMode }),
          h('div', { className: 'dsh-artel__field' },
            h('label', { className: 'dsh-artel__label', htmlFor: 'dsh-artel-task' }, tt('task.label')),
            h('textarea', {
              id: 'dsh-artel-task',
              ref: areaRef,
              className: 'dsh-artel__textarea',
              value: task,
              placeholder: tt('task.placeholder'),
              onChange: (event) => setTask(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  start()
                }
              },
            })),
          h('div', { className: 'dsh-artel__empty-note' },
            h('strong', null, tt('empty.hint')),
            h('div', null, tt('empty.hintText'))),
          h('div', { className: 'dsh-artel__actions' },
            h('button', {
              className: 'dsh-artel__btn dsh-artel__btn--primary',
              type: 'button',
              disabled: busy || task.trim() === '',
              onClick: start,
            }, busy ? h('span', { className: 'dsh-artel__spinner' }) : icon('play', 12), busy ? tt('starting') : tt('start'))),
        ),
        h(
          'section',
          { className: 'dsh-artel__card dsh-artel__card--plain' },
          h(SectionTitle, { text: tt('runs.title'), aside: h('span', { className: 'dsh-artel__hint' }, String(runs.length)) }),
          runs.length === 0
            ? h('div', { className: 'dsh-artel__hint' }, tt('runs.empty'))
            : h('div', { className: 'dsh-artel__runs' },
              runs.map((item) => h(RunRow, { key: item.id, tt, run: item, active: run !== null && item.id === run.id, onOpen: onOpenRun }))),
        ),
      )
    }

    /* ---------------------------------------------------------------- run UI */

    function AgentsSection({ tt, run, onOpenAgent }) {
      const agents = Array.isArray(run.agents) ? run.agents : []
      if (agents.length === 0) return null
      const solo = run.mode === 'solo'
      // Swarm members live inside the lead's conversation, so there is no separate
      // chat window to open for them; what they say to each other is in the feed.
      const hasMembers = agents.some((agent) => agent.kind === 'member')
      return h(
        'section',
        { className: 'dsh-artel__card' },
        h(SectionTitle, { text: tt('agents.title'), aside: h('span', { className: 'dsh-artel__hint' }, String(agents.length)) }),
        h('div', { className: 'dsh-artel__agents' },
          agents.map((agent) => {
            const state = agent.status ?? 'starting'
            const stateKey = `agents.${state}`
            const claims = Array.isArray(agent.claimed) ? agent.claimed : []
            return h(
              'div',
              { key: agent.id, className: 'dsh-artel__agent' },
              h('div', { className: 'dsh-artel__agent-main' },
                h('div', { className: 'dsh-artel__agent-top' },
                  h('span', null, agent.name),
                  h('span', { className: `dsh-artel__agent-state${state === 'working' ? ' dsh-artel__agent-state--working' : ''}` }, tt(stateKey)),
                  agent.kind !== 'member' && typeof agent.sessionId === 'string' && agent.sessionId !== ''
                    ? h('button', {
                      className: 'dsh-artel__btn dsh-artel__btn--icon',
                      type: 'button',
                      title: tt('agents.open'),
                      onClick: () => onOpenAgent(agent.sessionId),
                    }, icon('arrows', 12))
                    : null),
                solo
                  ? h('div', { className: 'dsh-artel__claims' }, h('span', { className: 'dsh-artel__claim dsh-artel__claim--none' }, tt('agents.whole')))
                  : claims.length === 0
                    ? h('div', { className: 'dsh-artel__claims' }, h('span', { className: 'dsh-artel__claim dsh-artel__claim--none' }, tt('agents.none')))
                    : h('div', { className: 'dsh-artel__claims' },
                      claims.map((claim, index) => h('span', { key: index, className: 'dsh-artel__claim', title: String(claim) }, String(claim)))),
              ),
            )
          })),
        hasMembers ? h('div', { className: 'dsh-artel__hint dsh-artel__agents-hint' }, tt('agents.peerHint')) : null,
      )
    }

    function FeedSection({ tt, events }) {
      const boxRef = useRef(null)
      const stickRef = useRef(true)

      useEffect(() => {
        const box = boxRef.current
        if (box === null) return
        if (stickRef.current) box.scrollTop = box.scrollHeight
      }, [events.length])

      const onScroll = () => {
        const box = boxRef.current
        if (box === null) return
        stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48
      }

      const rows = events.map((event, index) => {
        const kind = typeof event.kind === 'string' ? event.kind : 'status'
        const who = kind === 'peer'
          ? (typeof event.from === 'string' && event.from !== '' ? `${event.from} → ${event.agent ?? ''}` : (event.agent ?? ''))
          : kind === 'user' ? (event.agent !== undefined ? `${tt('feed.you')} → ${event.agent}` : tt('feed.you'))
            : kind === 'assistant' || kind === 'tool' || kind === 'collision' ? (event.agent ?? '')
              : kind === 'plan' ? tt('feed.plan')
                : ''
        const text = typeof event.text === 'string' && event.text !== '' ? event.text : ''
        return h(
          'div',
          { key: event.seq ?? `${kind}-${index}`, className: `dsh-artel__feed-row dsh-artel__feed-row--${kind}` },
          h('span', { className: 'dsh-artel__feed-who', title: who }, who),
          h('span', { className: 'dsh-artel__feed-text' }, text),
        )
      })

      return h(
        'section',
        { className: 'dsh-artel__card' },
        h(SectionTitle, { text: tt('feed.title'), aside: h('span', { className: 'dsh-artel__hint' }, String(events.length)) }),
        events.length === 0
          ? h('div', { className: 'dsh-artel__feed-empty' }, tt('feed.empty'))
          : h('div', { ref: boxRef, className: 'dsh-artel__feed', onScroll }, rows),
      )
    }

    function DiffView({ tt, change }) {
      if (change.binary === true) {
        return h('div', { className: 'dsh-artel__diff' }, h('pre', { className: 'dsh-artel__diff-head' }, tt('changes.binary')))
      }
      const hunks = Array.isArray(change.hunks) ? change.hunks : []
      if (hunks.length === 0) {
        const note = change.status === 'added' ? tt('changes.addedFile')
          : change.status === 'deleted' ? tt('changes.deletedFile')
            : tt('changes.empty')
        return h('div', { className: 'dsh-artel__diff' }, h('pre', { className: 'dsh-artel__diff-head' }, note))
      }
      const rows = []
      let key = 0
      for (const hunk of hunks) {
        if (typeof hunk.header === 'string' && hunk.header !== '') {
          rows.push(h('pre', { key: `h-${key++}`, className: 'dsh-artel__diff-head' }, hunk.header))
        }
        let oldLine = Number.isFinite(hunk.oldStart) ? hunk.oldStart : 1
        let newLine = Number.isFinite(hunk.newStart) ? hunk.newStart : 1
        for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
          const type = line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'ctx'
          const oldNo = type === 'add' ? '' : String(oldLine)
          const newNo = type === 'del' ? '' : String(newLine)
          rows.push(h('div', { key: `l-${key++}`, className: `dsh-artel__diff-line${type === 'add' ? ' dsh-artel__diff-line--add' : type === 'del' ? ' dsh-artel__diff-line--del' : ''}` },
            h('span', { className: 'dsh-artel__diff-no' }, oldNo),
            h('span', { className: 'dsh-artel__diff-no' }, newNo),
            h('span', { className: 'dsh-artel__diff-mark' }, type === 'add' ? '+' : type === 'del' ? '-' : ''),
            h('span', { className: 'dsh-artel__diff-text' }, typeof line.text === 'string' ? line.text : '')))
          if (type !== 'add') oldLine += 1
          if (type !== 'del') newLine += 1
        }
      }
      return h('div', { className: 'dsh-artel__diff' }, h('pre', null, rows))
    }

    function FileRow({ tt, change, selected, onToggleSelected }) {
      const [open, setOpen] = useState(false)
      const status = typeof change.status === 'string' ? change.status : 'modified'
      const letter = status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'binary' ? 'B' : 'M'
      return h(
        'div',
        { className: `dsh-artel__file${open ? ' dsh-artel__file--open' : ''}` },
        h(
          'div',
          { className: 'dsh-artel__file-head', role: 'button', tabIndex: 0, onClick: () => setOpen((value) => !value), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value) } } },
          h('input', {
            className: 'dsh-artel__check',
            type: 'checkbox',
            checked: selected === true,
            'aria-label': change.path,
            onClick: (event) => event.stopPropagation(),
            onChange: (event) => onToggleSelected(change.path, event.target.checked),
          }),
          h('span', { className: `dsh-artel__file-status dsh-artel__file-status--${status}` }, letter),
          h('span', { className: 'dsh-artel__file-name', title: change.path }, change.path),
          h('span', { className: 'dsh-artel__counts' },
            change.added > 0 ? h('span', { className: 'dsh-artel__count-add' }, `+${change.added}`) : null,
            change.removed > 0 ? h('span', { className: 'dsh-artel__count-del' }, `-${change.removed}`) : null),
          h('span', { className: `dsh-artel__chevron${open ? ' dsh-artel__chevron--open' : ''}` }, icon('chevron', 12)),
        ),
        open ? h(DiffView, { tt, change }) : null,
      )
    }

    function ChangesSection({ tt, run, changes, selection, busy, onToggleSelected, onSelectAll, onSelectNone, onApply, onDiscard }) {
      const [confirmDiscard, setConfirmDiscard] = useState(false)
      const list = changes !== null && Array.isArray(changes.list) ? changes.list : null
      const selectedPaths = Object.keys(selection).filter((path) => selection[path] === true)
      const reviewable = REVIEW_STATUSES.has(run.status)
      const applied = run.status === 'applied'

      if (!reviewable && !applied) {
        return h(
          'section',
          { className: 'dsh-artel__card dsh-artel__card--plain' },
          h(SectionTitle, { text: tt('changes.title') }),
          h('div', { className: 'dsh-artel__hint' }, tt('changes.pending')),
        )
      }
      if (applied) return null

      const applyLabel = selectedPaths.length === 0
        ? tt('changes.applyNone')
        : selectedPaths.length === 1 ? tt('changes.applyOne') : fill(tt('changes.apply'), { n: selectedPaths.length })

      return h(
        'section',
        { className: 'dsh-artel__card' },
        h(SectionTitle, {
          text: tt('changes.title'),
          aside: h('div', { className: 'dsh-artel__actions' },
            list !== null && list.length > 0
              ? h(React.Fragment, null,
                h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', onClick: onSelectAll }, tt('changes.selectAll')),
                h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', onClick: onSelectNone }, tt('changes.selectNone')))
              : null),
        }),
        changes !== null && changes.error !== undefined
          ? h(ErrorBanner, { tt, error: changes.error })
          : null,
        list === null
          ? h('div', { className: 'dsh-artel__hint' }, tt('changes.reading'))
          : list.length === 0
            ? h('div', { className: 'dsh-artel__hint' }, tt('changes.empty'))
            : h(React.Fragment, null,
              h('div', { className: 'dsh-artel__hint' }, tt('changes.reviewHint')),
              h('div', { className: 'dsh-artel__files' },
                list.map((change) => h(FileRow, {
                  key: change.path,
                  tt,
                  change,
                  selected: selection[change.path] === true,
                  onToggleSelected,
                }))),
              h('div', { className: 'dsh-artel__actions' },
                h('button', {
                  className: 'dsh-artel__btn dsh-artel__btn--primary',
                  type: 'button',
                  disabled: busy || selectedPaths.length === 0,
                  onClick: onApply,
                }, busy ? h('span', { className: 'dsh-artel__spinner' }) : icon('check', 12), applyLabel),
                confirmDiscard
                  ? h(React.Fragment, null,
                    h('span', { className: 'dsh-artel__hint' }, tt('changes.discardQuestion')),
                    h('button', { className: 'dsh-artel__btn dsh-artel__btn--danger', type: 'button', disabled: busy, onClick: () => { setConfirmDiscard(false); onDiscard() } }, tt('changes.discard')),
                    h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', onClick: () => setConfirmDiscard(false) }, tt('action.keep')))
                  : h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', disabled: busy, onClick: () => setConfirmDiscard(true) }, tt('action.discard')),
              )),
      )
    }

    function Composer({ tt, run, busy, onSend }) {
      const [text, setText] = useState('')
      const [agentId, setAgentId] = useState('')
      const agents = Array.isArray(run.agents) ? run.agents : []
      const swarm = run.mode === 'swarm' && agents.length > 1
      const canSend = text.trim() !== '' && !busy

      const send = () => {
        if (!canSend) return
        const value = text.trim()
        setText('')
        onSend(value, agentId === '' ? undefined : agentId)
      }

      return h(
        'div',
        { className: 'dsh-artel__footer' },
        h('div', { className: 'dsh-artel__composer' },
          h('div', { className: 'dsh-artel__composer-row' },
            swarm
              ? h('select', {
                className: 'dsh-artel__select',
                value: agentId,
                'aria-label': tt('composer.to'),
                onChange: (event) => setAgentId(event.target.value),
              },
              h('option', { value: '' }, tt('composer.all')),
              agents.map((agent) => h('option', { key: agent.id, value: agent.id }, agent.name)))
              : null,
            h('span', { className: 'dsh-artel__hint' }, tt('composer.cmdEnter'))),
          h('textarea', {
            className: 'dsh-artel__textarea',
            value: text,
            rows: 2,
            placeholder: tt('composer.placeholder'),
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dsh-artel__actions' },
            h('button', { className: 'dsh-artel__btn dsh-artel__btn--primary', type: 'button', disabled: !canSend, onClick: send }, icon('play', 12), tt('composer.send')))),
      )
    }

    function RunView({ tt, run, feed, changes, selection, busy, error, notice, onDismissError, onDismissNotice, onStop, onNewTask, onToggleSelected, onSelectAll, onSelectNone, onApply, onDiscard, onSend, onOpenAgent, runs, onOpenRun }) {
      const active = ACTIVE_STATUSES.has(run.status)
      const messageable = MESSAGE_STATUSES.has(run.status)
      const changedLabel = (run.changeCount ?? 0) === 1 ? tt('run.changedOne') : fill(tt('run.changedFiles'), { n: run.changeCount ?? 0 })
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dsh-artel__body' },
          error !== null ? h(ErrorBanner, { tt, error, onDismiss: onDismissError }) : null,
          notice !== null ? h(NoticeBanner, { tt, text: notice, onDismiss: onDismissNotice }) : null,
          h(
            'section',
            { className: 'dsh-artel__card' },
            h('div', { className: 'dsh-artel__badges' },
              h('span', { className: 'dsh-artel__badge dsh-artel__badge--mode' }, run.mode === 'swarm' ? tt('mode.swarm') : tt('mode.solo')),
              h('span', { className: `dsh-artel__badge dsh-artel__badge--${statusTone(run.status)}` },
                active ? h('span', { className: 'dsh-artel__spinner' }) : null,
                statusLabel(tt, run.status)),
              h('span', { className: 'dsh-artel__badge dsh-artel__badge--muted' }, changedLabel)),
            h('p', { className: 'dsh-artel__task' }, run.task),
            run.error !== undefined && run.error !== null && run.error !== ''
              ? h('div', { className: 'dsh-artel__banner dsh-artel__banner--error' }, run.error)
              : null,
            h('div', { className: 'dsh-artel__actions' },
              active
                ? h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', disabled: busy, onClick: onStop }, icon('stop', 11), tt('action.stop'))
                : null,
              h('button', { className: 'dsh-artel__btn dsh-artel__btn--ghost', type: 'button', onClick: onNewTask }, icon('plus', 12), tt('action.newTask'))),
            h('div', { className: 'dsh-artel__meta' },
              h('span', { title: run.projectPath }, `${tt('run.project')}: ${baseName(run.projectPath)}`),
              h('span', { title: run.copyPath }, `${tt('run.copy')}: ${baseName(run.copyPath)}`)),
          ),
          h(AgentsSection, { tt, run, onOpenAgent }),
          h(FeedSection, { tt, events: feed }),
          h(ChangesSection, {
            tt,
            run,
            changes,
            selection,
            busy,
            onToggleSelected,
            onSelectAll,
            onSelectNone,
            onApply,
            onDiscard,
          }),
          runs.length > 1
            ? h('section', { className: 'dsh-artel__card dsh-artel__card--plain' },
              h(SectionTitle, { text: tt('runs.title') }),
              h('div', { className: 'dsh-artel__runs' },
                runs.map((item) => h(RunRow, { key: item.id, tt, run: item, active: item.id === run.id, onOpen: onOpenRun }))))
            : null,
        ),
        messageable ? h(Composer, { tt, run, busy, onSend }) : null,
      )
    }

    /* ------------------------------------------------------------ the page */

    function ArtelTab(props) {
      const { sessionId, api, tt, openAgentSession } = props
      const [booting, setBooting] = useState(true)
      const [fatal, setFatal] = useState(null)
      const [runs, setRuns] = useState([])
      const [runId, setRunId] = useState(null)
      const [run, setRun] = useState(null)
      const [feed, setFeed] = useState([])
      const [changes, setChanges] = useState(null)
      const [selection, setSelection] = useState({})
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const cursorRef = useRef(0)
      const statusRef = useRef(null)
      const projectPathRef = useRef(null)
      /* True while the start form is open on purpose: the run list must not
         pull the user back into a run they already dismissed. */
      const formOpenRef = useRef(false)

      /* --- the run list, polled slowly --- */
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setBooting(false)
          return undefined
        }
        let alive = true
        const load = async () => {
          try {
            const data = await api.listRuns(sessionId)
            if (!alive) return
            const list = Array.isArray(data?.runs) ? data.runs : []
            setRuns(list)
            setBooting(false)
            setFatal(null)
            const first = list.find((item) => item.status !== 'applied' && item.status !== 'discarded')
            if (first !== undefined) projectPathRef.current = first.projectPath ?? null
            setRunId((current) => {
              if (current !== null && list.some((item) => item.id === current)) return current
              if (formOpenRef.current) return null
              const stored = readStoredRun(sessionId)
              if (stored !== null && list.some((item) => item.id === stored)) return stored
              return first !== undefined ? first.id : null
            })
          } catch (failure) {
            if (!alive) return
            setBooting(false)
            setFatal(describeError(failure, tt))
          }
        }
        load()
        const timer = setInterval(() => { load().catch(() => {}) }, 8000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId, reloadKey])

      /* --- the selected run, polled fast while agents work --- */
      useEffect(() => {
        if (runId === null) {
          setRun(null)
          setFeed([])
          setChanges(null)
          setSelection({})
          cursorRef.current = 0
          statusRef.current = null
          return undefined
        }
        let alive = true
        let timer = null
        cursorRef.current = 0
        statusRef.current = null
        setFeed([])
        setChanges(null)
        setSelection({})
        setRun((current) => (current !== null && current.id === runId ? current : null))

        const tick = async () => {
          if (!alive) return
          try {
            const data = await api.getRun(runId, cursorRef.current, 200)
            if (!alive) return
            const nextRun = data?.run ?? null
            const events = Array.isArray(data?.feed?.events) ? data.feed.events : []
            if (typeof data?.feed?.cursor === 'number') cursorRef.current = data.feed.cursor
            if (nextRun !== null) {
              statusRef.current = nextRun.status
              projectPathRef.current = nextRun.projectPath ?? projectPathRef.current
              setRun(nextRun)
            }
            if (events.length > 0) setFeed((current) => [...current, ...events])
          } catch (failure) {
            if (!alive) return
            setFatal(describeError(failure, tt))
          }
          if (!alive) return
          const active = statusRef.current !== null && ACTIVE_STATUSES.has(statusRef.current)
          timer = setTimeout(() => { tick().catch(() => {}) }, active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
        }
        tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [runId, reloadKey])

      /* --- the diff of the copy, fetched while the run is reviewable --- */
      const reviewable = run !== null && REVIEW_STATUSES.has(run.status)
      const changeCount = run !== null ? (run.changeCount ?? 0) : 0
      useEffect(() => {
        if (!reviewable || run === null) return undefined
        const stale = changes === null || changes.runId !== run.id || changes.forCount !== changeCount
        if (!stale) return undefined
        let alive = true
        api.changes(run.id)
          .then((data) => {
            if (!alive) return
            const list = Array.isArray(data?.changes) ? data.changes : []
            setChanges({ runId: run.id, forCount: changeCount, list })
            const next = {}
            for (const change of list) next[change.path] = true
            setSelection(next)
          })
          .catch((failure) => {
            if (!alive) return
            setChanges({ runId: run.id, forCount: changeCount, list: [], error: describeError(failure, tt) })
          })
        return () => {
          alive = false
        }
      }, [reviewable, run !== null ? run.id : null, changeCount])

      /* --- notices fade out on their own --- */
      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 7000)
        return () => clearTimeout(timer)
      }, [notice])

      const store = useCallback((id) => {
        formOpenRef.current = id === null
        setRunId(id)
        if (typeof sessionId === 'string') storeRun(sessionId, id)
      }, [sessionId])

      const startRun = useCallback(async (mode, task) => {
        setBusy(true)
        setError(null)
        try {
          const data = await api.startRun({ sessionId, mode, task })
          const created = data?.run ?? null
          if (created !== null) {
            setRun(created)
            store(created.id)
            setNotice(tt('notice.started'))
          }
        } catch (failure) {
          setError(describeError(failure, tt))
        } finally {
          setBusy(false)
        }
      }, [api, sessionId, store, tt])

      const sendMessage = useCallback(async (text, agentId) => {
        if (run === null) return
        setBusy(true)
        setError(null)
        try {
          const payload = agentId === undefined ? { text } : { text, agentId }
          const data = await api.sendMessage(run.id, payload)
          if (data?.run !== undefined) setRun(data.run)
          setNotice(tt('notice.sent'))
        } catch (failure) {
          setError(describeError(failure, tt))
        } finally {
          setBusy(false)
        }
      }, [api, run, tt])

      const stopRun = useCallback(async () => {
        if (run === null) return
        setBusy(true)
        setError(null)
        try {
          const data = await api.interrupt(run.id)
          if (data?.run !== undefined) setRun(data.run)
          setNotice(tt('notice.stopped'))
        } catch (failure) {
          setError(describeError(failure, tt))
        } finally {
          setBusy(false)
        }
      }, [api, run, tt])

      const applyChanges = useCallback(async () => {
        if (run === null) return
        const paths = Object.keys(selection).filter((path) => selection[path] === true)
        if (paths.length === 0) {
          setError(tt('changes.noSelection'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const data = await api.apply(run.id, paths)
          const applied = Array.isArray(data?.applied) ? data.applied.length : 0
          const skipped = Array.isArray(data?.skipped) ? data.skipped.length : 0
          const label = applied === 1 ? tt('changes.appliedOne') : fill(tt('changes.applied'), { n: applied })
          setNotice(skipped > 0 ? `${label} ${fill(tt('changes.skipped'), { n: skipped })}` : label)
          if (data?.run !== undefined) setRun(data.run)
          setChanges(null)
          setSelection({})
          setReloadKey((value) => value + 1)
        } catch (failure) {
          setError(describeError(failure, tt))
        } finally {
          setBusy(false)
        }
      }, [api, run, selection, tt])

      const discardRun = useCallback(async () => {
        if (run === null) return
        setBusy(true)
        setError(null)
        try {
          const data = await api.discard(run.id)
          if (data?.run !== undefined) setRun(data.run)
          setChanges(null)
          setSelection({})
          setNotice(tt('notice.discarded'))
          setReloadKey((value) => value + 1)
        } catch (failure) {
          setError(describeError(failure, tt))
        } finally {
          setBusy(false)
        }
      }, [api, run, tt])

      const toggleSelected = useCallback((path, checked) => {
        setSelection((current) => ({ ...current, [path]: checked === true }))
      }, [])

      const selectAll = useCallback(() => {
        if (changes === null || !Array.isArray(changes.list)) return
        const next = {}
        for (const change of changes.list) next[change.path] = true
        setSelection(next)
      }, [changes])

      const selectNone = useCallback(() => {
        setSelection({})
      }, [])

      const openAgent = useCallback((id) => {
        if (typeof openAgentSession === 'function') openAgentSession(id)
      }, [openAgentSession])

      const newTask = useCallback(() => {
        store(null)
      }, [store])

      const openRun = useCallback((id) => {
        store(id)
      }, [store])

      const refresh = useCallback(() => {
        setFatal(null)
        setReloadKey((value) => value + 1)
      }, [])

      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { className: 'dsh-artel' }, h('div', { className: 'dsh-artel__body' },
          h('div', { className: 'dsh-artel__hint' }, tt('empty.noProject'))))
      }

      const body = booting
        ? h('div', { className: 'dsh-artel__body' }, h('div', { className: 'dsh-artel__hint' }, tt('loading')))
        : fatal !== null
          ? h('div', { className: 'dsh-artel__body' }, h(ErrorBanner, { tt, error: fatal, onRetry: refresh }))
          : run !== null
            ? h(RunView, {
              tt,
              run,
              feed,
              changes,
              selection,
              busy,
              error,
              notice,
              onDismissError: () => setError(null),
              onDismissNotice: () => setNotice(null),
              onStop: stopRun,
              onNewTask: newTask,
              onToggleSelected: toggleSelected,
              onSelectAll: selectAll,
              onSelectNone: selectNone,
              onApply: applyChanges,
              onDiscard: discardRun,
              onSend: sendMessage,
              onOpenAgent: openAgent,
              runs,
              onOpenRun: openRun,
            })
            : h(NewRunView, {
              tt,
              sessionId,
              run: null,
              runs,
              busy,
              error,
              onDismissError: () => setError(null),
              onStart: startRun,
              onOpenRun: openRun,
              projectPath: projectPathRef.current,
            })

      return h('div', { className: 'dsh-artel' }, body)
    }

    /* ------------------------------------------------------- tab decorations */

    function ArtelTabTitle(props) {
      const { tt } = props
      return h('span', { className: 'dsh-artel__tab-title' }, icon('artel', 13), h('span', null, tt('tab.title')))
    }

    function ArtelHeaderButton(props) {
      const { tt, open } = props
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-artel__header-button',
          title: tt('action.open'),
          'aria-label': tt('action.open'),
          onClick: open,
        },
        icon('artel', 15),
      )
    }

    /* -------------------------------------------------------- registration */

    /**
     * Read the callable face of an optional client service.
     * @param {object} ctx - client plugin context.
     * @param {string} name - service name.
     * @param {string[]} methods - required methods.
     * @returns {object | null} bound methods, or null when unavailable.
     */
    function readFace(ctx, name, methods) {
      let service
      try {
        service = ctx.get(name)
      } catch {
        return null
      }
      if (service === null || service === undefined || (typeof service !== 'object' && typeof service !== 'function')) return null
      const face = {}
      for (const method of methods) {
        const fn = service[method]
        if (typeof fn !== 'function') return null
        face[method] = fn.bind(service)
      }
      return face
    }

    /** Slot kind, or null when the slot shape cannot be inspected. */
    function slotKind(ctx, name) {
      try {
        const spec = typeof ctx.slots.spec === 'function' ? ctx.slots.spec(name) : null
        if (spec !== null && typeof spec === 'object' && typeof spec.kind === 'string') return spec.kind
        return null
      } catch {
        return null
      }
    }

    function registerTabType(ctx, tt, report) {
      let registered = false
      const attempt = () => {
        if (registered) return
        const tabs = readFace(ctx, 'sidebarRightTabs', ['register'])
        if (tabs === null) {
          report.note('tabType.skip', 'sidebarRightTabs service is not available')
          return
        }
        registered = true
        try {
          ctx.effect(() => {
            const dispose = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: () => tt('tab.title'),
              // The registry expects a LIST of guide entries: it maps over them
              // and flats them into the sidebar's "Start" page.
              guide: [
                {
                  id: TAB_ID,
                  order: 45,
                  title: () => tt('guide.title'),
                  description: () => tt('guide.description'),
                },
              ],
            })
            report.note('tabType.ok', { id: TAB_ID, kind: TAB_KIND, disposer: typeof dispose })
            return typeof dispose === 'function' ? dispose : () => {}
          }, 'dsh-artel: tab type')
        } catch (error) {
          registered = false
          report.note('tabType.error', String(error && error.message ? error.message : error))
        }
      }
      attempt()
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['sidebarRightTabs'], attempt)
      } catch {
        // Older clients have no late-injection hook; the first attempt is enough.
      }
    }

    function registerTabBody(ctx, dependencies) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject(TAB_SLOT, () => {
          const kind = slotKind(ctx, TAB_SLOT)
          if (kind !== null && kind !== 'keyed') return () => {}
          const registration = ctx.slots.register({
            name: TAB_SLOT,
            key: TAB_ID,
            locale: NS,
            inject: () => dependencies,
          }, ArtelTab)
          return typeof registration === 'function' ? registration : () => {}
        })
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // The slot store may already be gone during shutdown.
          }
        }
      }, 'dsh-artel: tab body')
    }

    function registerTabTitle(ctx, tt) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject(TAB_TITLE_SLOT, () => {
          const kind = slotKind(ctx, TAB_TITLE_SLOT)
          if (kind !== null && kind !== 'keyed') return () => {}
          const registration = ctx.slots.register({
            name: TAB_TITLE_SLOT,
            key: TAB_ID,
            locale: NS,
            inject: () => ({ tt }),
          }, ArtelTabTitle)
          return typeof registration === 'function' ? registration : () => {}
        })
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // The slot store may already be gone during shutdown.
          }
        }
      }, 'dsh-artel: tab title')
    }

    function registerHeaderAction(ctx, dependencies) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject(HEADER_ACTION_SLOT, () => {
          const kind = slotKind(ctx, HEADER_ACTION_SLOT)
          if (kind !== null && kind !== 'list') return () => {}
          const registration = ctx.slots.register({
            name: HEADER_ACTION_SLOT,
            id: HEADER_ACTION_ID,
            order: 12,
            locale: NS,
            inject: (sessionId) => ({
              tt: dependencies.tt,
              open: () => {
                if (typeof dependencies.openArtel === 'function') dependencies.openArtel(sessionId)
              },
            }),
          }, ArtelHeaderButton)
          return typeof registration === 'function' ? registration : () => {}
        })
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // The slot store may already be gone during shutdown.
          }
        }
      }, 'dsh-artel: session action')
    }

    /* ------------------------------------------------------------- plugin */

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        const report = { version: '0.1.0', stage: 'applying', steps: [] }
        report.note = (step, info) => {
          try {
            report.steps.push(info === undefined ? { step } : { step, info })
            console.info('[dsh-artel] ' + step, info === undefined ? '' : info)
          } catch {
            // Diagnostics must never break the plugin.
          }
        }
        try {
          if (typeof window === 'object' && window !== null) window.__DSH_FORGE_CLIENT__ = report
        } catch {
          // A locked-down window object is not worth failing over.
        }
        try {
          if (window.localStorage && window.localStorage.getItem('dsh-artel:debug') === '1') {
            window.__DSH_FORGE_CTX__ = ctx
          }
        } catch {
          // Debug hook only.
        }
        try {
          registerPlugin(ctx, report)
          report.stage = 'ready'
          try {
            console.info('[dsh-artel] client ready')
          } catch {}
        } catch (error) {
          report.stage = 'failed'
          report.error = String(error && error.stack ? error.stack : error)
          try {
            console.error('[dsh-artel] client failed', error)
          } catch {}
        }
        sendClientReport(report)
      },
    }

    /** POST the registration trace to the Host so it survives a closed console. */
    function sendClientReport(report) {
      try {
        if (typeof fetch !== 'function') return
        const body = {
          version: report.version,
          stage: report.stage,
          error: report.error ?? null,
          steps: report.steps ?? [],
          rev: (() => {
            try {
              const boot = window.__DSH_BOOT__
              return boot && typeof boot.rev === 'string' ? boot.rev : null
            } catch {
              return null
            }
          })(),
          ua: (() => {
            try {
              return window.navigator.userAgent
            } catch {
              return null
            }
          })(),
        }
        fetch(resolveApiBase() + '/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {})
      } catch {
        // Reporting is best effort only.
      }
    }

    /** Register every Artel surface; keeps `apply` small enough to trace. */
    function registerPlugin(ctx, report) {
      ensureStyles()
      report.note('context', {
        slots: ctx.slots !== undefined,
        effect: typeof ctx.effect,
        get: typeof ctx.get,
        inject: typeof ctx.inject,
        locale: ctx.locale !== undefined,
      })
      try {
        const tabs = readFace(ctx, 'sidebarRightTabs', ['register'])
        const right = readFace(ctx, 'sidebarRight', ['openTabIn', 'openTab'])
        report.note('faces', { tabs: tabs !== null, sidebar: right !== null })
      } catch (error) {
        report.note('faces.error', String(error && error.message ? error.message : error))
      }

        let translate
        try {
          translate = ctx.locale.bind(NS)
        } catch {
          translate = null
        }
        const tt = (key, fallback) => {
          if (typeof translate === 'function') {
            try {
              const value = translate(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            } catch {
              // Fall back to the bundled English dictionary.
            }
          }
          return DICTIONARIES.en[key] ?? fallback ?? key
        }

        try {
          ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-artel: dictionaries')
        } catch {
          // A locale service that refuses extra dictionaries still gets English defaults.
        }

        const api = createApi(tt)

        /** Open the Artel page in the right sidebar of the given session. */
        const openArtel = (sessionId) => {
          const sidebar = readFace(ctx, 'sidebarRight', ['openTabIn', 'openTab'])
          if (sidebar === null) return false
          try {
            if (typeof sessionId === 'string' && sessionId !== '') {
              sidebar.openTabIn(sessionId, TAB_KIND)
            } else {
              sidebar.openTab(TAB_KIND)
            }
            return true
          } catch {
            return false
          }
        }

        /** Open one agent conversation in the main conversation surface. */
        const openAgentSession = (sessionId) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          const workspace = readFace(ctx, 'uiWorkspace', ['openSession'])
          if (workspace !== null) {
            try {
              workspace.openSession(sessionId)
              return
            } catch {
              // Fall through to the plain session action.
            }
          }
          const sessions = readFace(ctx, 'sessions', ['open'])
          if (sessions !== null) {
            try {
              sessions.open(sessionId)
            } catch {
              // Nothing else to try: the conversation simply does not open.
            }
          }
        }

        try {
          report.note('slots', {
            tab: slotKind(ctx, TAB_SLOT),
            tabTitle: slotKind(ctx, TAB_TITLE_SLOT),
            header: slotKind(ctx, HEADER_ACTION_SLOT),
            inject: typeof ctx.slots?.inject,
            register: typeof ctx.slots?.register,
          })
        } catch (error) {
          report.note('slots.error', String(error && error.message ? error.message : error))
        }
        const step = (label, run) => {
          try {
            run()
            report.note(label + '.ok')
          } catch (error) {
            report.note(label + '.error', String(error && error.message ? error.message : error))
          }
        }
        step('tabType', () => registerTabType(ctx, tt, report))
        step('tabBody', () => registerTabBody(ctx, { api, tt, openAgentSession }))
        step('tabTitle', () => registerTabTitle(ctx, tt))
        step('headerAction', () => registerHeaderAction(ctx, { tt, openArtel }))
      report.stage = 'registered'
    }
  },
})
})()
