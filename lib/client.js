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
    const MODES = ['solo', 'swarm']
    const STORAGE_LAST_RUN = 'dsh-artel:last-run:'
    const OVERLAY_Z_INDEX = 50

    /* ------------------------------------------------------------ strings */

    const en = {
      'surface.title': 'Artel',
      'surface.back': '← Chat',
      'surface.close': 'Close Artel',

      'launcher.title': 'Artel',
      'launcher.open': 'Open Artel',
      'launcher.busy': 'Artel is working',

      'rail.title': 'Sessions',
      'rail.new': '+ New Artel',
      'rail.empty': 'No Artel runs yet.',
      'rail.emptyHint': 'Describe a task on the right — the agents work in an isolated copy.',
      'rail.groupFallback': 'No project',
      'rail.footerRuns': '{n} runs',
      'rail.footerFiles': '{n} files',
      'rail.refresh': 'Refresh',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': 'New Artel in {project} · via {mode}',
      'hero.titleNoProject': 'New Artel · via {mode}',
      'hero.placeholder': 'What should the agents do? Describe the task…',
      'hero.hint': 'Artel works in an isolated copy of the project. Your files stay untouched until you apply the changes.',
      'hero.start': 'Go →',
      'hero.starting': 'Starting…',
      'hero.taskLabel': 'Task',
      'hero.mode': 'Mode',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': 'One agent, one copy',
      'mode.swarm.hint': 'Three agents divide the files',

      'run.new': 'New Artel',
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
      'feed.empty': 'Nothing yet.',
      'feed.copy': 'Copy',
      'feed.copied': 'Copied',
      'feed.code': 'Code',
      'feed.wrap': 'Wrap lines',
      'feed.unwrap': 'No wrap',
      'feed.footnotes': 'Footnotes',

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

      'loading': 'Loading…',
      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
    }

    const ru = {
      'surface.title': 'Артель',
      'surface.back': '← Чат',
      'surface.close': 'Закрыть «Артель»',

      'launcher.title': 'Артель',
      'launcher.open': 'Открыть «Артель»',
      'launcher.busy': 'Артель работает',

      'rail.title': 'Сессии',
      'rail.new': '+ Новая артель',
      'rail.empty': 'Пока нет ни одной артели.',
      'rail.emptyHint': 'Опишите задачу справа — агенты работают в изолированной копии.',
      'rail.groupFallback': 'Без проекта',
      'rail.footerRuns': 'артелей: {n}',
      'rail.footerFiles': 'файлов: {n}',
      'rail.refresh': 'Обновить',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': 'Новая артель в {project} · через {mode}',
      'hero.titleNoProject': 'Новая артель · через {mode}',
      'hero.placeholder': 'Что нужно сделать? Опишите задачу для агентов…',
      'hero.hint': 'Артель работает в изолированной копии проекта. Ваши файлы не меняются, пока вы не примените изменения.',
      'hero.start': 'Поехали →',
      'hero.starting': 'Запускаю…',
      'hero.taskLabel': 'Задача',
      'hero.mode': 'Режим',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': 'Один агент, одна копия',
      'mode.swarm.hint': 'Три агента делят файлы',

      'run.new': 'Новая артель',
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
      'feed.empty': 'Пока тихо.',
      'feed.copy': 'Копировать',
      'feed.copied': 'Скопировано',
      'feed.code': 'Код',
      'feed.wrap': 'Переносить строки',
      'feed.unwrap': 'Без переноса',
      'feed.footnotes': 'Сноски',

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

      'loading': 'Загружаю…',
      'time.now': 'только что',
      'time.minutes': '{n} мин назад',
      'time.hours': '{n} ч назад',
    }

    const zh = {
      'surface.title': 'Artel',
      'surface.back': '← 聊天',
      'surface.close': '关闭 Artel',

      'launcher.title': 'Artel',
      'launcher.open': '打开 Artel',
      'launcher.busy': 'Artel 正在工作',

      'rail.title': '会话',
      'rail.new': '+ 新建 Artel',
      'rail.empty': '还没有 Artel 运行。',
      'rail.emptyHint': '在右侧描述任务——智能体将在隔离副本中工作。',
      'rail.groupFallback': '未选择项目',
      'rail.footerRuns': '运行：{n}',
      'rail.footerFiles': '文件：{n}',
      'rail.refresh': '刷新',

      'row.meta': '{mode} · {done}/{total} · {phase}',

      'hero.title': '在 {project} 中新建 Artel · {mode}',
      'hero.titleNoProject': '新建 Artel · {mode}',
      'hero.placeholder': '需要做什么？描述任务…',
      'hero.hint': 'Artel 在项目的隔离副本中工作。在应用更改之前，你的文件不会被修改。',
      'hero.start': '开始 →',
      'hero.starting': '启动中…',
      'hero.taskLabel': '任务',
      'hero.mode': '模式',

      'mode.solo': 'Solo',
      'mode.swarm': 'Swarm',
      'mode.solo.hint': '一个智能体，一份副本',
      'mode.swarm.hint': '三个智能体划分文件',

      'run.new': '新建 Artel',
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
      'feed.empty': '暂无内容。',
      'feed.copy': '复制',
      'feed.copied': '已复制',
      'feed.code': '代码',
      'feed.wrap': '自动换行',
      'feed.unwrap': '取消换行',
      'feed.footnotes': '脚注',

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

      'loading': '加载中…',
      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
    }

    const DICTIONARIES = { en, ru, zh }

    /* ------------------------------------------------------------- styles */

    const STYLES = `
.dsh-artel-surface {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.09));
  border-radius: 16px;
  background:
    radial-gradient(120% 80% at 0% 0%, rgba(124, 108, 255, 0.10), transparent 55%),
    rgba(11, 12, 16, 0.82);
  -webkit-backdrop-filter: blur(26px) saturate(1.15);
  backdrop-filter: blur(26px) saturate(1.15);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-fg-primary, #e9e9f0);
  font-family: var(--dsw-alias-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: -0.005em;
}
.dsh-artel-surface *, .dsh-artel-surface *::before, .dsh-artel-surface *::after { box-sizing: border-box; }
.dsh-artel-surface__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 12px 0 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent);
}
.dsh-artel-surface__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px 0 7px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-fg-secondary, #a9aab6);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.dsh-artel-surface__back:hover {
  border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.05);
  color: var(--dsw-alias-fg-primary, #e9e9f0);
}
.dsh-artel-surface__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-fg-primary, #e9e9f0);
}
.dsh-artel-surface__title-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.dsh-artel-surface__spacer { flex: 1 1 auto; min-width: 8px; }
.dsh-artel-surface__body { display: flex; flex: 1 1 auto; min-height: 0; }

/* Rail ------------------------------------------------------------------ */
.dsh-artel-rail {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 232px;
  min-width: 232px;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  background: rgba(255, 255, 255, 0.018);
}
.dsh-artel-rail__head { padding: 12px 12px 8px; }
.dsh-artel-rail__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 10px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dsh-artel-rail__new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--dsw-alias-fg-primary, #e9e9f0);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dsh-artel-rail__new:hover { background: rgba(255, 255, 255, 0.07); border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16)); }
.dsh-artel-rail__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 8px 10px; scrollbar-width: thin; }
.dsh-artel-rail__group { margin: 10px 0 2px; }
.dsh-artel-rail__group-label {
  overflow: hidden;
  padding: 0 6px 6px;
  color: var(--dsw-alias-fg-tertiary, #7f8090);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.dsh-artel-rail__empty { padding: 12px 8px; color: var(--dsw-alias-fg-tertiary, #878895); font-size: 12px; }
.dsh-artel-rail__empty-hint { margin-top: 6px; color: var(--dsw-alias-fg-tertiary, #6f7080); font-size: 11.5px; line-height: 1.45; }
.dsh-artel-rail__footer {
  display: flex;
  flex: none;
  gap: 6px;
  padding: 9px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
  color: var(--dsw-alias-fg-tertiary, #7f8090);
  font-size: 11px;
}
.dsh-artel-rail__footer span + span::before { content: "·"; margin-right: 6px; }

.dsh-artel-row {
  display: block;
  width: 100%;
  margin: 2px 0;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dsh-artel-row:hover { background: rgba(255, 255, 255, 0.045); border-color: rgba(255, 255, 255, 0.06); }
.dsh-artel-row[data-active="true"] {
  border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.14));
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.045));
}
.dsh-artel-row__top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dsh-artel-row__title {
  display: -webkit-box;
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-fg-primary, #e9e9f0);
  font-size: 12.5px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.dsh-artel-row__meta {
  overflow: hidden;
  margin-top: 3px;
  padding-left: 13px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Workspace ------------------------------------------------------------- */
.dsh-artel-workspace { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-artel-hero {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 40px 40px;
}
.dsh-artel-hero__eyebrow {
  margin-bottom: 10px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.dsh-artel-hero__title {
  margin: 0 0 18px;
  color: var(--dsw-alias-fg-primary, #f0f0f6);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.22;
  letter-spacing: -0.02em;
}
.dsh-artel-hero__title em { font-style: normal; color: var(--dsw-alias-brand-primary, #9f8cff); }
.dsh-artel-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.022));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.dsh-artel-hero__composer { padding: 12px 12px 10px; }
.dsh-artel-hero__textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  max-height: 240px;
  padding: 8px 6px;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dsw-alias-fg-primary, #f0f0f6);
  font: inherit;
  font-size: 14px;
  line-height: 1.55;
}
.dsh-artel-hero__textarea::placeholder { color: var(--dsw-alias-fg-tertiary, #6f7080); }
.dsh-artel-hero__toolbar { display: flex; align-items: center; gap: 10px; padding-top: 8px; }
.dsh-artel-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.22);
}
.dsh-artel-segmented__option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-fg-secondary, #a9aab6);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.dsh-artel-segmented__option:hover { color: var(--dsw-alias-fg-primary, #e9e9f0); }
.dsh-artel-segmented__option[data-selected="true"] {
  background: rgba(255, 255, 255, 0.1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  color: var(--dsw-alias-fg-primary, #f0f0f6);
}
.dsh-artel-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-fg-secondary, #a9aab6);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: filter 120ms ease, background 120ms ease;
}
.dsh-artel-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--dsw-alias-fg-primary, #e9e9f0); }
.dsh-artel-btn[disabled] { cursor: default; opacity: 0.55; }
.dsh-artel-btn--primary {
  border-color: rgba(255, 255, 255, 0.12);
  background: linear-gradient(180deg, var(--dsw-alias-brand-primary, #7c6cff), var(--dsw-alias-brand-primary-hover, #6757e8));
  box-shadow: 0 6px 18px rgba(124, 108, 255, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.24);
  color: #fff;
}
.dsh-artel-btn--primary:hover { filter: brightness(1.06); background: linear-gradient(180deg, var(--dsw-alias-brand-primary, #7c6cff), var(--dsw-alias-brand-primary-hover, #6757e8)); }
.dsh-artel-btn--danger { border-color: rgba(255, 120, 120, 0.28); color: var(--dsw-alias-state-error, #ff8d8d); }
.dsh-artel-btn--danger:hover { background: rgba(255, 110, 110, 0.12); }
.dsh-artel-hero__hint { margin: 14px 2px 0; color: var(--dsw-alias-fg-tertiary, #7f8090); font-size: 11.5px; line-height: 1.5; }
.dsh-artel-hero__foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }

/* Run ------------------------------------------------------------------- */
.dsh-artel-run { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.dsh-artel-run__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
}
.dsh-artel-run__head-main { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.dsh-artel-run__task {
  overflow: hidden;
  color: var(--dsw-alias-fg-primary, #f0f0f6);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-artel-run__sub { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 2px; color: var(--dsw-alias-fg-tertiary, #878895); font-size: 11.5px; }
.dsh-artel-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--dsw-alias-fg-secondary, #b7b8c4);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-artel-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--dsw-alias-fg-secondary, #b7b8c4);
  font-size: 11.5px;
  white-space: nowrap;
}
.dsh-artel-pill[data-tone="active"] { border-color: rgba(124, 108, 255, 0.36); background: rgba(124, 108, 255, 0.12); color: #cfc6ff; }
.dsh-artel-pill[data-tone="ok"] { border-color: rgba(96, 205, 150, 0.32); background: rgba(96, 205, 150, 0.1); color: #a9ebc6; }
.dsh-artel-pill[data-tone="warn"] { border-color: rgba(235, 190, 100, 0.34); background: rgba(235, 190, 100, 0.1); color: #f1d79c; }
.dsh-artel-pill[data-tone="error"] { border-color: rgba(255, 120, 120, 0.34); background: rgba(255, 120, 120, 0.1); color: #ffb4b4; }
.dsh-artel-run__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px 8px; scrollbar-width: thin; }
.dsh-artel-run__feed { display: flex; flex-direction: column; gap: 10px; max-width: 760px; margin: 0 auto; }
.dsh-artel-run__empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 30px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 12.5px;
  text-align: center;
}

/* Feed ------------------------------------------------------------------ */
.dsh-artel-msg { display: flex; gap: 9px; padding: 8px 10px; border: 1px solid transparent; border-radius: 12px; }
.dsh-artel-msg:hover { border-color: rgba(255, 255, 255, 0.05); background: rgba(255, 255, 255, 0.018); }
.dsh-artel-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #101018;
  font-size: 11px;
  font-weight: 700;
}
.dsh-artel-msg__main { min-width: 0; flex: 1 1 auto; }
.dsh-artel-msg__head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.dsh-artel-msg__name { color: var(--dsw-alias-fg-primary, #e9e9f0); font-size: 12.5px; font-weight: 600; }
.dsh-artel-msg__role {
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  border-radius: 5px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.dsh-artel-msg__time { margin-left: auto; color: var(--dsw-alias-fg-tertiary, #6f7080); font-size: 10.5px; white-space: nowrap; }
.dsh-artel-msg__body { margin-top: 2px; color: var(--dsw-alias-fg-primary, #dedee7); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
.dsh-artel-msg__body p { margin: 0 0 6px; }
.dsh-artel-msg__body p:last-child { margin-bottom: 0; }
.dsh-artel-msg__body pre {
  overflow-x: auto;
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.32);
  font: 11.5px/1.5 var(--dsw-alias-font-mono, ui-monospace, "SF Mono", Consolas, monospace);
  white-space: pre;
}
.dsh-artel-msg__body code { font-family: var(--dsw-alias-font-mono, ui-monospace, "SF Mono", Consolas, monospace); font-size: 0.94em; }
.dsh-artel-msg__body ul, .dsh-artel-msg__body ol { margin: 4px 0; padding-left: 18px; }
.dsh-artel-msg__body h1, .dsh-artel-msg__body h2, .dsh-artel-msg__body h3 { margin: 8px 0 4px; font-size: 13px; }
.dsh-artel-msg__body a { color: var(--dsw-alias-brand-primary, #a99bff); }
.dsh-artel-tools {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 35px;
  padding: 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.016);
}
.dsh-artel-tool { display: flex; align-items: baseline; gap: 7px; min-width: 0; padding: 2px 0; color: var(--dsw-alias-fg-tertiary, #90919e); font-size: 11.5px; }
.dsh-artel-tool__icon { flex: none; color: var(--dsw-alias-fg-tertiary, #7f8090); }
.dsh-artel-tool__name { color: var(--dsw-alias-fg-secondary, #b7b8c4); font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11px; }
.dsh-artel-tool__text { overflow: hidden; flex: 1 1 auto; text-overflow: ellipsis; white-space: nowrap; }
.dsh-artel-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 11.5px;
}
.dsh-artel-plan { margin-left: 35px; padding: 9px 11px; border-left: 2px solid var(--dsw-alias-brand-primary, #7c6cff); border-radius: 2px 10px 10px 2px; background: rgba(124, 108, 255, 0.07); }
.dsh-artel-plan__label { color: var(--dsw-alias-brand-primary, #a99bff); font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
.dsh-artel-plan__text { margin-top: 3px; color: var(--dsw-alias-fg-secondary, #c7c8d2); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-artel-user { display: flex; justify-content: flex-end; padding: 2px 0; }
.dsh-artel-user__bubble {
  max-width: 78%;
  padding: 8px 12px;
  border: 1px solid rgba(124, 108, 255, 0.28);
  border-radius: 13px 13px 4px 13px;
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.18), rgba(124, 108, 255, 0.1));
  color: var(--dsw-alias-fg-primary, #e9e9f0);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-artel-user__to { display: block; margin-top: 3px; color: var(--dsw-alias-fg-tertiary, #9a94c8); font-size: 10.5px; }
.dsh-artel-note { margin-left: 35px; padding: 6px 10px; border-radius: 9px; font-size: 11.5px; }
.dsh-artel-note[data-tone="warn"] { border: 1px solid rgba(235, 190, 100, 0.26); background: rgba(235, 190, 100, 0.08); color: #ecd49b; }
.dsh-artel-note[data-tone="error"] { border: 1px solid rgba(255, 120, 120, 0.26); background: rgba(255, 120, 120, 0.08); color: #ffb4b4; }
.dsh-artel-note__label { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.85; }
.dsh-artel-peer { margin-left: 35px; color: var(--dsw-alias-fg-tertiary, #9a9baa); font-size: 11.5px; }
.dsh-artel-peer b { color: var(--dsw-alias-fg-secondary, #c2c3cf); font-weight: 600; }

/* Composer -------------------------------------------------------------- */
.dsh-artel-composer { flex: none; padding: 8px 18px 14px; }
.dsh-artel-composer__card {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 760px;
  margin: 0 auto;
  padding: 8px 8px 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.035);
}
.dsh-artel-composer__card:focus-within { border-color: rgba(124, 108, 255, 0.5); box-shadow: 0 0 0 3px rgba(124, 108, 255, 0.1); }
.dsh-artel-composer__input {
  flex: 1 1 auto;
  min-height: 24px;
  max-height: 120px;
  padding: 5px 0;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dsw-alias-fg-primary, #ececf1);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
}
.dsh-artel-composer__input::placeholder { color: var(--dsw-alias-fg-tertiary, #6f7080); }
.dsh-artel-composer__send {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: linear-gradient(180deg, var(--dsw-alias-brand-primary, #7c6cff), var(--dsw-alias-brand-primary-hover, #6757e8));
  color: #fff;
  cursor: pointer;
}
.dsh-artel-composer__send[disabled] { cursor: default; opacity: 0.45; }
.dsh-artel-composer__foot { display: flex; align-items: center; gap: 8px; max-width: 760px; margin: 5px auto 0; padding: 0 2px; color: var(--dsw-alias-fg-tertiary, #7f8090); font-size: 10.5px; }
.dsh-artel-select {
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.24);
  color: var(--dsw-alias-fg-secondary, #b7b8c4);
  font: inherit;
  font-size: 10.5px;
  outline: 0;
}

/* Launcher + status dot -------------------------------------------------- */
.dsh-artel-launcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-fg-secondary, #b7b8c4);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dsh-artel-launcher:hover {
  border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-fg-primary, #e9e9f0);
}
.dsh-artel-launcher[data-active='true'] {
  border-color: rgba(124, 108, 255, 0.42);
  background: rgba(124, 108, 255, 0.16);
  color: #cfc6ff;
}
.dsh-artel-launcher > .dsh-artel-dot,
.dsh-artel-launcher > span[data-state] {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(11, 12, 16, 0.9);
}
.dsh-artel-dot {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-fg-tertiary, #6f7080);
}
.dsh-artel-dot[data-state='ongoing'] { background: var(--dsw-alias-warning, #f0b45c); }
.dsh-artel-dot[data-state='done'] { background: var(--dsw-alias-success, #63c58b); }
.dsh-artel-dot[data-state='warning'] { background: var(--dsw-alias-warning, #f0b45c); }
.dsh-artel-dot[data-state='error'] { background: var(--dsw-alias-danger, #f06d6d); }

/* Banners --------------------------------------------------------------- */
.dsh-artel-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 120, 120, 0.28);
  border-radius: 10px;
  background: rgba(255, 110, 110, 0.09);
  color: #ffc0c0;
  font-size: 12px;
}
.dsh-artel-banner__body { flex: 1 1 auto; min-width: 0; }
.dsh-artel-banner__title { font-weight: 600; }
.dsh-artel-banner__text { margin-top: 2px; color: #ffd0d0; opacity: 0.85; overflow-wrap: anywhere; }
.dsh-artel-banner__actions { display: flex; gap: 4px; flex: none; }
.dsh-artel-banner--notice { border-color: rgba(124, 108, 255, 0.3); background: rgba(124, 108, 255, 0.09); color: #d6ceff; }
.dsh-artel-banner--notice .dsh-artel-banner__text { color: #cfc6ff; }
.dsh-artel-spin { display: inline-block; width: 11px; height: 11px; border: 1.5px solid rgba(255, 255, 255, 0.28); border-top-color: rgba(255, 255, 255, 0.9); border-radius: 50%; animation: dsh-artel-spin 700ms linear infinite; }
@keyframes dsh-artel-spin { to { transform: rotate(360deg); } }
.dsh-artel-hint { color: var(--dsw-alias-fg-tertiary, #7f8090); font-size: 11px; }

/* Changes card ---------------------------------------------------------- */
.dsh-artel-changes {
  flex: none;
  margin: 6px 18px 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.022));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.dsh-artel-changes__head { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 6px 8px 6px 12px; }
.dsh-artel-changes__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-fg-primary, #e9e9f0);
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
.dsh-artel-changes__add { color: var(--dsw-alias-success, #63c58b); }
.dsh-artel-changes__del { color: var(--dsw-alias-danger, #f06d6d); }
.dsh-artel-changes__spacer,
.dsh-artel-changes__grow { flex: 1 1 auto; min-width: 8px; }
.dsh-artel-changes__iconbtn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font: inherit;
  cursor: pointer;
}
.dsh-artel-changes__iconbtn:hover { background: rgba(255, 255, 255, 0.06); color: var(--dsw-alias-fg-primary, #e9e9f0); }
.dsh-artel-changes__iconbtn[disabled] { opacity: 0.5; cursor: default; }
.dsh-artel-changes__iconbtn:focus-visible,
.dsh-artel-change:focus-visible,
.dsh-artel-changes__actions .dsh-artel-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #7c6cff);
  outline-offset: 1px;
}
.dsh-artel-changes__iconbtn[aria-expanded="false"] svg { transform: rotate(-90deg); }
.dsh-artel-changes__body {
  max-height: 38vh;
  overflow-y: auto;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  padding: 6px 8px;
  scrollbar-width: thin;
}
.dsh-artel-changes__files { display: flex; flex-direction: column; gap: 2px; }
.dsh-artel-change-item { display: flex; flex-direction: column; min-width: 0; }
.dsh-artel-change {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 28px;
  padding: 4px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-artel-change:hover { background: rgba(255, 255, 255, 0.05); }
.dsh-artel-change[data-open="true"] { background: rgba(255, 255, 255, 0.06); }
.dsh-artel-change[disabled] { cursor: default; }
.dsh-artel-change__chevron {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 12px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  transition: transform 120ms ease;
}
.dsh-artel-change[data-open="true"] .dsh-artel-change__chevron { transform: rotate(90deg); }
.dsh-artel-change__icon { display: inline-flex; flex: none; align-items: center; color: var(--dsw-alias-fg-tertiary, #878895); }
.dsh-artel-change__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-fg-secondary, #c3c4cf);
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
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
  border-radius: 5px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.dsh-artel-change__num {
  flex: none;
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-artel-change__num-add { color: var(--dsw-alias-success, #63c58b); }
.dsh-artel-change__num-del { color: var(--dsw-alias-danger, #f06d6d); }
.dsh-artel-change__num-muted { color: var(--dsw-alias-fg-tertiary, #878895); }
.dsh-artel-diff {
  max-height: 280px;
  margin: 2px 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.28);
  overflow: auto;
}
.dsh-artel-diff__hunk {
  padding: 3px 10px;
  background: rgba(124, 108, 255, 0.1);
  color: var(--dsw-alias-fg-tertiary, #8a8b99);
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  white-space: pre;
}
.dsh-artel-diff__line {
  min-width: max-content;
  padding: 0 10px;
  color: var(--dsw-alias-fg-secondary, #b7b8c4);
  font-family: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre;
}
.dsh-artel-diff__line[data-type="+"] { background: rgba(96, 205, 150, 0.12); color: #bdf3d3; }
.dsh-artel-diff__line[data-type="-"] { background: rgba(255, 110, 110, 0.12); color: #ffc4c4; }
.dsh-artel-changes__empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  color: var(--dsw-alias-fg-tertiary, #878895);
  font-size: 12px;
}
.dsh-artel-changes__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
}
.dsh-artel-changes__question { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-artel-changes__question-title { color: var(--dsw-alias-fg-primary, #e9e9f0); font-size: 12px; font-weight: 600; }
.dsh-artel-changes__question-hint { color: var(--dsw-alias-fg-tertiary, #878895); font-size: 11px; overflow-wrap: anywhere; }
.dsh-artel-changes__plate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  color: var(--dsw-alias-success, #63c58b);
  font-size: 12px;
  font-weight: 500;
}
.dsh-artel-changes__plate[data-tone="muted"] { color: var(--dsw-alias-fg-tertiary, #a9aab6); }
.dsh-artel-changes__plate-hint { min-width: 0; color: var(--dsw-alias-fg-tertiary, #878895); font-size: 11px; font-weight: 400; overflow-wrap: anywhere; }
.dsh-artel-changes__skipped { padding: 0 10px 8px; color: var(--dsw-alias-warning, #f0b45c); font-size: 11px; }
@media (prefers-reduced-motion: reduce) {
  .dsh-artel-spin { animation: none; }
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
            const code = payload && typeof payload.error === 'string' ? payload.error : undefined
            const message = (payload && typeof payload.message === 'string' && payload.message) || response.statusText || ('HTTP ' + response.status)
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
        project: (sessionId) => request('GET', '/project?sessionId=' + encodeURIComponent(sessionId)),
        listRuns: (sessionId) => request('GET', '/runs?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 15000 }),
        startRun: (payload) => request('POST', '/runs', payload, { timeoutMs: 180000 }),
        getRun: (runId, cursor, limit) =>
          request('GET', '/runs/' + encodeURIComponent(runId) + '?cursor=' + encodeURIComponent(String(cursor ?? 0)) + '&limit=' + encodeURIComponent(String(limit ?? 200)), undefined, { timeoutMs: 15000 }),
        sendMessage: (runId, text, agentId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/messages', agentId === undefined ? { text } : { text, agentId }, { timeoutMs: 30000 }),
        interrupt: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/interrupt', {}, { timeoutMs: 30000 }),
        changes: (runId) => request('GET', '/runs/' + encodeURIComponent(runId) + '/changes', undefined, { timeoutMs: 180000 }),
        diff: (runId, path) => request('GET', '/runs/' + encodeURIComponent(runId) + '/diff?path=' + encodeURIComponent(path)),
        apply: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/apply', {}, { timeoutMs: 180000 }),
        discard: (runId) => request('POST', '/runs/' + encodeURIComponent(runId) + '/discard', {}, { timeoutMs: 180000 }),
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

    function agentStatusLabel(tt, status) {
      const key = 'agent.' + String(status ?? '')
      const translated = typeof tt === 'function' ? tt(key) : undefined
      return translated === key || translated === undefined ? String(status ?? '') : translated
    }

    /** A run is busy while any agent still works. */
    function isActiveRun(run) {
      return run !== null && run !== undefined && ACTIVE_STATUSES.has(run.status)
    }

    /** Agent completion: idle agents have finished their turn. */
    function agentProgress(run) {
      const agents = Array.isArray(run?.agents) ? run.agents : []
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
     */
    function feedGroups(events) {
      const groups = []
      for (const event of Array.isArray(events) ? events : []) {
        if (event === null || event === undefined) continue
        const kind = String(event.kind ?? '')
        if (kind === 'tool') {
          const current = groups[groups.length - 1]
          if (current !== undefined && current.type === 'tools' && current.agent === event.agent) {
            current.items.push(event)
          } else {
            groups.push({ type: 'tools', agent: event.agent, items: [event] })
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
        activeRunId: null,
        /* Set when the user opened «+ Новая артель», so a background refresh
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

      function dismissChangesError() {
        publish({ changesError: null })
      }

      function open() {
        if (snapshot.open === true) return
        publish({ open: true })
        void ensureProject()
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
        const mode = input?.mode === 'swarm' ? 'swarm' : 'solo'
        publish({ starting: true, startError: null })
        try {
          const payload = await api.startRun({
            sessionId,
            mode,
            task,
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
        publish({ error: null, startError: null })
      }

      function dispose() {
        clearTimer()
        listeners.clear()
      }

      return { sessionId, getSnapshot, subscribe, open, close, toggle, refreshRuns, selectRun, startRun, send, interrupt, loadChanges, applyChanges, discardChanges, dismissChangesError, dismissError, dispose }
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
      return h('span', { className: 'dsh-artel-tag' }, props?.children)
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
          store.close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('keydown', onKeyDown)
        }
      }, [store])

      const sessionCwd = typeof props.useSessions === 'function' ? props.useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) : undefined
      const style = {
        top: rect.top + 'px',
        left: rect.left + 'px',
        width: rect.width > 0 ? rect.width + 'px' : undefined,
        height: rect.height > 0 ? rect.height + 'px' : undefined,
        right: rect.width > 0 ? undefined : 24,
        bottom: rect.height > 0 ? undefined : 20,
      }

      const run = snap.run
      const showHero = snap.activeRunId === null || run === null

      return h(
        'div',
        {
          className: 'dsh-artel-surface',
          style,
          'data-artel-surface': 'true',
        },
        h(
          'div',
          { className: 'dsh-artel-surface__header' },
          h(
            'button',
            { type: 'button', className: 'dsh-artel-surface__back', title: t('surface.close'), onClick: () => store.close() },
            icon('back', 14),
            h('span', null, t('surface.back')),
          ),
          h(
            'div',
            { className: 'dsh-artel-surface__title' },
            icon('artel', 15),
            h('span', null, t('surface.title')),
          ),
          h('div', { className: 'dsh-artel-surface__spacer' }),
          run !== null && run !== undefined
            ? h(Pill, { tone: statusTone(run.status) }, h(Dot, { state: statusDotState(run.status) }), h('span', null, statusLabel(t, run.status)))
            : null,
          snap.busy && run === null ? h('span', { className: 'dsh-artel-spin', 'aria-label': t('loading') }) : null,
          h(
            'button',
            { type: 'button', className: 'dsh-artel-btn', title: t('rail.refresh'), onClick: () => { void store.refreshRuns({ silent: false }) } },
            icon('refresh', 13),
          ),
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
            showHero
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
              h('div', { className: 'dsh-artel-rail__empty-hint' }, t('rail.emptyHint')),
            )
            : null,
          groups.map((group) => h(
            'div',
            { key: group.key === '' ? '__none__' : group.key, className: 'dsh-artel-rail__group' },
            h('div', { className: 'dsh-artel-rail__group-label', title: group.projectPath }, projectLabel(t, group.runs[0])),
            group.runs.map((run) => h(RailRow, { key: run.id, run, active: run.id === snap.activeRunId, t, onSelect: () => store.selectRun(run.id) })),
          )),
        ),
        h(
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
      const textareaRef = useRef(null)
      const project = useMemo(
        () => chooseProject(snap.project, snap.runs, props.sessionCwd),
        [snap.project, snap.runs, props.sessionCwd],
      )
      useEffect(() => {
        if (textareaRef.current !== null && typeof textareaRef.current.focus === 'function') textareaRef.current.focus()
      }, [])
      const title = project.name !== ''
        ? fill(t('hero.title'), { project: project.name, mode: modeLabel(t, mode) })
        : fill(t('hero.titleNoProject'), { mode: modeLabel(t, mode) })
      const start = () => {
        if (snap.starting === true || task.trim() === '') return
        void store.startRun({ task, mode, projectPath: project.projectPath })
      }
      return h(
        'div',
        { className: 'dsh-artel-hero' },
        h('div', { className: 'dsh-artel-hero__eyebrow' }, project.name !== '' ? project.name : t('rail.groupFallback')),
        h('h2', { className: 'dsh-artel-hero__title' }, title),
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
          h(
            'div',
            { className: 'dsh-artel-hero__toolbar' },
            h(SegmentedControl, {
              label: t('hero.mode'),
              value: mode,
              onChange: setMode,
              options: [
                { value: 'solo', label: t('mode.solo'), hint: t('mode.solo.hint') },
                { value: 'swarm', label: t('mode.swarm'), hint: t('mode.swarm.hint') },
              ],
            }),
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
        h('div', { className: 'dsh-artel-hero__hint' }, t('hero.hint')),
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
              disabled: busy === true,
              'aria-label': t('changes.applyYes'),
              onClick: () => { setConfirming(null); void store.applyChanges() },
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
              disabled: canDecide === false,
              title: t('changes.apply'),
              'aria-label': t('changes.apply'),
              onClick: () => setConfirming('apply'),
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
        actions,
        skipped,
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
        h(ChangesCard, { store, snap, t, run }),
        h(ArtelComposer, { store, snap, t, run }),
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
            h(Pill, { tone: statusTone(run.status) }, h(Dot, { state: statusDotState(run.status) }), h('span', null, statusLabel(t, run.status))),
            changes !== null ? h(Tag, null, changes) : null,
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

    function agentRole(t, run, name) {
      const agents = Array.isArray(run?.agents) ? run.agents : []
      for (const agent of agents) if (agent?.name === name && typeof agent.role === 'string' && agent.role !== '') return agent.role
      return 'agent'
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

    function ToolsRow(props) {
      const group = props.group
      const t = props.t
      const label = group.items.length === 1 ? t('feed.toolOne') : fill(t('feed.tools'), { n: group.items.length })
      return h(
        'div',
        { className: 'dsh-artel-tools', title: label },
        group.items.map((event, index) => h(
          'div',
          { key: event.seq ?? index, className: 'dsh-artel-tool' },
          h('span', { className: 'dsh-artel-tool__icon' }, icon('chevronRight', 11)),
          h('span', { className: 'dsh-artel-tool__name' }, String(event.tool ?? 'tool')),
          typeof event.path === 'string' && event.path !== ''
            ? h('span', { className: 'dsh-artel-tool__text', title: event.path }, event.path)
            : h('span', { className: 'dsh-artel-tool__text' }, String(event.text ?? '')),
        )),
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
              'label',
              { className: 'dsh-artel-composer__foot' },
              h('span', null, t('composer.to')),
              h(
                'select',
                { className: 'dsh-artel-select', value: recipient, onChange: (event) => setRecipient(event.target.value) },
                h('option', { value: '' }, t('composer.all')),
                recipients.map((agent) => h('option', { key: agent.id ?? agent.name, value: agent.id ?? agent.name }, agent.name)),
              ),
            )
            : null,
          h('span', { className: 'dsh-artel-composer__hint' }, t('composer.hint')),
        ),
      )
    }

    /* ---------------------------------------------------------- registration */

    const CLIENT_VERSION = '0.2.0'

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
        fill,
        baseName,
        formatWhen,
        describeError,
        statusTone,
        statusDotState,
        statusLabel,
        modeLabel,
        agentStatusLabel,
        isActiveRun,
        agentProgress,
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
        feedGroups,
        recipientsOf,
        createArtelStore,
        getStore,
        measureConversationRect,
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
