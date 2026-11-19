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
    const MODES = ['solo', 'swarm', 'conductor']
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
      'role.conductor': 'conductor',
      'role.worker': 'agent',

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
      'role.conductor': 'дирижёр',
      'role.worker': 'агент',

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
      'role.conductor': '指挥',
      'role.worker': '智能体',

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

/* Launcher + status dot -------------------------------------------------- */
.dsh-artel-launcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--a-fg-2);
  cursor: pointer;
  transition: background 150ms var(--a-ease), color 150ms var(--a-ease), border-color 150ms var(--a-ease), box-shadow 150ms var(--a-ease);
}
.dsh-artel-launcher:hover {
  border-color: var(--a-line-2);
  background: rgba(255, 255, 255, 0.07);
  color: var(--a-fg);
}
.dsh-artel-launcher[data-active='true'] {
  border-color: rgba(124, 108, 255, 0.46);
  background: linear-gradient(180deg, rgba(124, 108, 255, 0.28), rgba(124, 108, 255, 0.14));
  box-shadow: 0 8px 20px -14px rgba(124, 108, 255, 1), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  color: #ded8ff;
}
.dsh-artel-launcher > .dsh-artel-dot,
.dsh-artel-launcher > span[data-state] {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(11, 12, 16, 0.95);
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

    /** A run is busy while any agent still works. */
    function isActiveRun(run) {
      return run !== null && run !== undefined && ACTIVE_STATUSES.has(run.status)
    }

    /** Agent completion: idle agents have finished their turn. The conductor
     *  stands above the team and its idle state is not a share of the work. */
    function agentProgress(run) {
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

      function dismissChangesError() {
        publish({ changesError: null })
      }

      function open() {
        if (snapshot.open === true) return
        publish({ open: true })
        void ensureProject()
        void loadModels({ silent: true })
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
        const mode = input?.mode === 'conductor' ? 'conductor' : input?.mode === 'swarm' ? 'swarm' : 'solo'
        publish({ starting: true, startError: null })
        try {
          const payload = await api.startRun({
            sessionId,
            mode,
            task,
            ...(input?.model ? { model: input.model } : {}),
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

      return { sessionId, getSnapshot, subscribe, open, close, toggle, refreshRuns, selectRun, startRun, send, interrupt, loadModels, setAgentModel, loadChanges, applyChanges, discardChanges, dismissChangesError, dismissError, dispose }
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
        void store.startRun({
          task,
          mode,
          ...(selection === null || selection === undefined ? {} : { model: selection }),
          projectPath: project.projectPath,
        })
      }
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
          catalogReady
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
              options: [
                { value: 'solo', label: t('mode.solo'), hint: t('mode.solo.hint') },
                { value: 'swarm', label: t('mode.swarm'), hint: t('mode.swarm.hint') },
                { value: 'conductor', label: t('mode.conductor'), hint: t('mode.conductor.hint') },
              ],
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
        h(AgentModelBar, { run, snap, store, t }),
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

    /** Agent role label: known roles are translated, unknown ones stay raw. */
    function agentRole(t, run, name) {
      const agents = Array.isArray(run?.agents) ? run.agents : []
      let role = 'agent'
      for (const agent of agents) if (agent?.name === name && typeof agent.role === 'string' && agent.role !== '') role = agent.role
      const key = 'role.' + role
      const translated = typeof t === 'function' ? t(key) : undefined
      return translated === key || translated === undefined ? role : translated
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

    /* ---------------------------------------------------------- registration */

    const CLIENT_VERSION = '0.5.0'

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
        agentRole,
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
