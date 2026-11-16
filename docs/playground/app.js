import {
  scenarios,
  createField,
  makeBatch,
  mountBusinessForm,
  mountItemDesk,
  mailMessages,
} from './scenarios.js';

const $ = (selector) => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const copy = {
  en: {
    skip: 'Skip to the results',
    navLab: 'Try it',
    navResults: 'Comparison',
    navRecord: 'Watch demo',
    heroLine1: 'Learn by doing.',
    heroLine2: 'Get better over time.',
    heroIntro:
      'Your agent works as usual. ReflexRun remembers how it completed the task and reuses the workflow with new inputs.',
    tryExamples: 'Try a sample workflow ↗',
    illustrationTitle: 'Interactive demo',
    illustrationIntro:
      'Run a batch with sample data, then change a button and repair the workflow.',
    illustrationOpen: 'Open demo',
    illustrationClose: 'Close demo',
    expense: 'Expenses',
    invoice: 'Invoices',
    mail: 'Email',
    reset: 'Reset',
    routeInputs: 'New inputs',
    routeMemory: 'Saved path',
    routeResults: 'Saved results',
    batchInputs: 'Batch inputs',
    lineHint: 'One item per line.',
    run: 'Run this batch',
    change: 'Change the page ↻',
    restore: 'Restore the page ↻',
    repairTitle: 'The action button changed.',
    repair: 'Repair once & continue',
    evidenceTitle: 'Computer Use comparison',
    downloadEvidence: 'Raw results ↗',
    capabilityEvidence: 'Cross-task data ↗',
    recordTitle: 'ReflexRun in action',
    videoLoading: 'Loading video…',
    videoUnavailable: 'Video unavailable.',
    videoDownload: 'Open video ↗',
    chapterReplay: 'Batch comparison',
    chapterShared: 'Shared steps',
    chapterCrossTask: 'First run of task C',
    chapterLabel: 'Video chapters',
    installTitle: 'Install ReflexRun',
    installIntro: 'Requires Node.js 20+, npm and Codex Desktop with Computer Use.',
    checkTools: '1. Check your tools.',
    cloneSource: '2. Clone ReflexRun.',
    zipSource: 'For a source ZIP, run these commands in the folder containing it.',
    installStep: '3. Install and verify.',
    startUsing: 'Once you see “ready: true”, open a new chat and describe the task.',
    skillSelection:
      'Hosts that match skills automatically can load ReflexRun from your request. To select it explicitly in a host that supports $ mentions, try “$reflexrun archive these three emails.”',
    agentsTitle: 'Optional instructions for AGENTS.md',
    agentsIntro:
      'If your host reads AGENTS.md, you can add this rule yourself. The installer leaves AGENTS.md untouched.',
    agentsRule:
      'For Computer Use tasks, load the reflexrun skill if available and look for matching experience before acting. Reuse it when applicable and follow the host’s permission and verification rules.',
    installAfter: '4. To try the sample, start the local demo and leave its terminal running.',
    practiceStep: 'Ask this in a new chat in the project with Computer Use available.',
    openInbox: 'Open the practice inbox ↗',
    practicePrompt: 'Move MAIL-5101 to Archive in the practice inbox.',
    practiceNext: 'After the first task finishes, open a new chat and ask for the next batch.',
    practiceReuse: 'Move MAIL-5102 and MAIL-5103 to Archive.',
    practiceMemory:
      'The Skill saves verified workflows to ~/.reflexrun/memory/ by default. Matching workflows are available across projects and chats under the same local user account.',
    importMemory:
      'To update an earlier install, run these commands in the ReflexRun source directory. For a store in another project, use its absolute path.',
    ready: 'Ready for a batch of new inputs.',
    running: 'Following the saved steps…',
    paused: 'Paused before the action. Repair this path once for the whole batch.',
    complete: (count, repairs) =>
      `${count}/${count} results checked · ${repairs} manual repair${repairs === 1 ? '' : 's'}`,
    repairExplanation: (oldLabel, newLabel) =>
      `The path expects “${oldLabel}”. The page now says “${newLabel}”.`,
    descriptions: 'Expense descriptions',
    orderIds: 'Order IDs',
    mailIds: 'Message IDs',
    first: 'First task',
    warm: 'Three new messages',
    changed: 'Changed interface ×3',
    whole: 'Whole batch · seven emails',
    composition: 'Read and tag an email',
    batchGroup: 'Batch replay',
    compositionGroup: 'First run of C · ReflexRun combines steps learned from A and B',
    task: 'Task',
    modelCalls: (n) => `${n} model call${n === 1 ? '' : 's'}`,
    original: 'Computer Use',
    reflex: '+ ReflexRun',
    evidenceLoading: 'Loading results…',
    evidenceUnavailable: 'Results unavailable.',
    unknown: 'Not recorded',
    practice: 'Open practice page ↗',
    failed: 'This local batch stopped. Reset the illustration to try again.',
    portalNote: 'Fictional business sandbox · local records and downloads',
  },
  zh: {
    skip: '跳到实测结果',
    navLab: '动手体验',
    navResults: '实测对比',
    navRecord: '观看演示',
    heroLine1: '做过就记住，',
    heroLine2: '越用越熟练。',
    heroIntro: '智能体照常操作，ReflexRun 记住成功的做法。下次换了内容，熟悉的步骤可以直接复用。',
    tryExamples: '体验示例流程 ↗',
    illustrationTitle: '互动演示',
    illustrationIntro: '用示例数据试跑一批任务，再模拟按钮改名，修复后继续。',
    illustrationOpen: '展开体验',
    illustrationClose: '收起演示',
    expense: '报销单',
    invoice: '订单发票',
    mail: '邮箱整理',
    reset: '重置',
    routeInputs: '换入新内容',
    routeMemory: '复用已学流程',
    routeResults: '保存结果',
    batchInputs: '批量输入',
    lineHint: '每行一项。',
    run: '运行这一批',
    change: '让页面变一下 ↻',
    restore: '恢复原来的页面 ↻',
    repairTitle: '操作按钮发生了变化。',
    repair: '修复一次，继续整批',
    evidenceTitle: 'Computer Use 实测对比',
    downloadEvidence: '原始数据 ↗',
    capabilityEvidence: '跨任务数据 ↗',
    recordTitle: 'ReflexRun 实操',
    videoLoading: '正在加载视频……',
    videoUnavailable: '暂时无法播放视频。',
    videoDownload: '打开视频 ↗',
    chapterReplay: '批量复用对比',
    chapterShared: '共享步骤',
    chapterCrossTask: '首次完成任务 C',
    chapterLabel: '视频章节',
    installTitle: '安装 ReflexRun',
    installIntro: '需要 Node.js 20+、npm 和支持 Computer Use 的 Codex Desktop。',
    checkTools: '1. 检查工具。',
    cloneSource: '2. 克隆 ReflexRun。',
    zipSource: '已有源码 ZIP 时，在 ZIP 所在目录运行下面两行。',
    installStep: '3. 安装并检查。',
    startUsing: '看到「ready: true」后，打开新聊天，直接说任务。',
    skillSelection:
      '支持自动匹配 Skill 的宿主可以根据任务加载 ReflexRun。若想明确指定，可在支持 $ 调用的宿主里输入「$reflexrun 把这三封邮件归档」。',
    agentsTitle: '可选的 AGENTS.md 配置',
    agentsIntro: '如果宿主读取 AGENTS.md，可以手动加入下方这句。安装器不会修改 AGENTS.md。',
    agentsRule:
      '处理 Computer Use 任务时，如果 reflexrun Skill 可用，先加载它并查找匹配的经验。符合当前任务时优先复用，并遵守宿主的授权和核验规则。',
    installAfter: '4. 想试用示例时，启动本地 Demo 并保持终端运行。',
    practiceStep: '在项目里打开支持 Computer Use 的新聊天，直接说下面这句话。',
    openInbox: '打开练习收件箱 ↗',
    practicePrompt: '把练习收件箱里的 MAIL-5101 移到「归档」。',
    practiceNext: '第一个任务完成后，打开新聊天并发出下一条任务。',
    practiceReuse: '把 MAIL-5102 和 MAIL-5103 移到「归档」。',
    practiceMemory:
      'Skill 默认把核验成功的流程存到 ~/.reflexrun/memory/。同一个本地用户账号下，换项目或开新聊天都能复用匹配的经验。',
    importMemory:
      '升级旧版时，在 ReflexRun 源码目录运行下方命令。导入其他项目的经验时，使用绝对路径。',
    ready: '准备好换入一批新内容。',
    running: '正在执行记住的步骤……',
    paused: '在执行前暂停。只需修复一次，整批继续。',
    complete: (count, repairs) => `${count}/${count} 项结果已核对 · ${repairs} 次手动修复`,
    repairExplanation: (oldLabel, newLabel) =>
      `流程记住的是“${oldLabel}”，页面现在显示“${newLabel}”。`,
    descriptions: '报销事项',
    orderIds: '订单编号',
    mailIds: '邮件编号',
    first: '首次任务',
    warm: '换三封新邮件复用',
    changed: '界面变化后三封',
    whole: '整批七封邮件',
    composition: '标为已读并加标签',
    batchGroup: '批量复用',
    compositionGroup: '首次做 C · ReflexRun 自动组合 A、B 的步骤',
    task: '任务',
    modelCalls: (n) => `${n} 次模型调用`,
    original: 'Computer Use',
    reflex: '+ ReflexRun',
    evidenceLoading: '正在加载实测结果……',
    evidenceUnavailable: '暂时无法加载实测结果。',
    practice: '打开独立练习页 ↗',
    unknown: '未记录',
    failed: '本地演示意外停止，可以重置后再试。',
    portalNote: '虚构业务沙盒 · 仅含本地记录与下载',
  },
};

function mountPortal() {
  const scenario = Object.hasOwn(scenarios, query.get('portal')) ? query.get('portal') : 'expense';
  const language = query.get('lang') === 'zh' ? 'zh' : 'en';
  const key = `reflexrun:portal:${scenario}:${query.get('run') || 'default'}`;
  let records;
  try {
    records = JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    records = [];
  }
  if (!Array.isArray(records)) records = [];
  records = records.filter(
    (record) => record?.scenario === scenario && record.fields && typeof record.fields === 'object',
  );
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = scenarios[scenario].brand[language];
  document.body.className = 'portal-body';
  const main = document.createElement('main');
  main.className = 'business-portal';
  const surface = document.createElement('section');
  surface.className = 'portal-card';
  const note = document.createElement('p');
  note.className = 'portal-note';
  note.textContent = copy[language].portalNote;
  main.append(surface, note);
  document.body.replaceChildren(main);
  const config = {
    scenario,
    language,
    records,
    onSave(record) {
      records.push(record);
      localStorage.setItem(key, JSON.stringify(records));
    },
  };
  if (scenario === 'invoice' || scenario === 'mail') {
    if (scenario === 'mail') {
      try {
        config.messages = JSON.parse(localStorage.getItem(`${key}:messages`) || 'null');
      } catch {
        config.messages = null;
      }
      if (!Array.isArray(config.messages) || config.messages.length !== mailMessages.length)
        config.messages = mailMessages;
      localStorage.setItem(`${key}:messages`, JSON.stringify(config.messages));
      config.onMessagesChange = (messages) =>
        localStorage.setItem(`${key}:messages`, JSON.stringify(messages));
    }
    mountItemDesk(surface, config);
  } else mountBusinessForm(surface, config);
}

if (query.has('portal')) {
  mountPortal();
} else {
  const state = {
    scenario: 'expense',
    language: query.get('lang') === 'zh' ? 'zh' : 'en',
    changed: false,
    savedChanged: false,
    records: [],
    messages: structuredClone(mailMessages),
    batch: null,
    running: false,
    blocked: false,
    repairs: 0,
    status: 'ready',
    evidence: null,
    evidenceError: false,
  };
  let business;
  const t = (key, ...args) =>
    typeof copy[state.language][key] === 'function'
      ? copy[state.language][key](...args)
      : copy[state.language][key];
  const actionButton = () => business.save || business.action;
  const currentConfig = () => scenarios[state.scenario];
  const saveLabel = (changed = state.changed) =>
    currentConfig().action[state.language][Number(changed)];

  function renderStatus() {
    $('#run-status').textContent =
      state.status === 'complete'
        ? t('complete', state.batch.length, state.repairs)
        : t(state.status);
    $('#run-state-icon').textContent = state.blocked
      ? '↻'
      : state.running
        ? '↗'
        : state.status === 'complete'
          ? '✓'
          : '○';
    $('.workspace').dataset.phase = state.blocked
      ? 'blocked'
      : state.running
        ? 'running'
        : state.status;
    $('[data-flow="input"]').dataset.state = state.batch ? 'done' : 'ready';
    $('[data-flow="memory"]').dataset.state = state.blocked
      ? 'blocked'
      : state.batch
        ? 'done'
        : 'ready';
    $('[data-flow="result"]').dataset.state = state.status === 'complete' ? 'done' : 'ready';
    $('#repair-card').hidden = !state.blocked;
    $('#repair-explanation').textContent = t(
      'repairExplanation',
      saveLabel(state.savedChanged),
      saveLabel(),
    );
    $('#rename-button').textContent = t(state.changed ? 'restore' : 'change');
    for (const node of document.querySelectorAll(
      '#parameters-form button, #parameters-form input, #parameters-form textarea, #parameters-form select, #rename-button, [data-scenario], [data-lang]',
    ))
      node.disabled = state.running || state.blocked;
    $('#run-button').disabled = state.running || state.blocked;
  }

  function mountSurface() {
    const config = {
      scenario: state.scenario,
      language: state.language,
      records: state.records,
      onSave(record) {
        state.records.push(record);
      },
      messages: state.messages,
      onMessagesChange(messages) {
        state.messages = messages;
      },
    };
    business =
      state.scenario === 'invoice' || state.scenario === 'mail'
        ? mountItemDesk($('#business-surface'), config)
        : mountBusinessForm($('#business-surface'), config);
    actionButton().textContent = saveLabel();
    $('#business-surface').inert = true;
    $('#surface-title').textContent = currentConfig().brand[state.language];
  }

  function renderInputs({ common = currentConfig().defaults, values } = {}) {
    const config = currentConfig();
    const root = $('#common-fields');
    root.replaceChildren();
    for (const field of config.common) {
      const node = createField(field, state.language, 'batch');
      const input = node.querySelector('input, select, textarea');
      input.value = common[field];
      root.append(node);
    }
    $('#batch-label').textContent = t(
      state.scenario === 'expense'
        ? 'descriptions'
        : state.scenario === 'invoice'
          ? 'orderIds'
          : 'mailIds',
    );
    $('#batch-values').value = values ?? config.values.slice(0, 3).join('\n');
  }

  function readInputs() {
    const form = $('#parameters-form');
    const common = Object.fromEntries(
      currentConfig().common.map((field) => [field, form.elements.namedItem(field).value]),
    );
    return { common, values: $('#batch-values').value };
  }

  function renderLanguage(inputs) {
    const isZh = state.language === 'zh';
    document.documentElement.lang = isZh ? 'zh-CN' : 'en';
    document.title = `ReflexRun — ${t('heroLine1')}${isZh ? '' : ' '}${t('heroLine2')}`;
    for (const node of document.querySelectorAll('[data-i18n]'))
      node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-lang]'))
      node.setAttribute('aria-pressed', String(node.dataset.lang === state.language));
    for (const node of document.querySelectorAll('[data-scenario]'))
      node.setAttribute('aria-pressed', String(node.dataset.scenario === state.scenario));
    $('#lab-title').textContent = currentConfig().title[state.language];
    $('#practice-link').href = `?portal=${state.scenario}&run=practice&lang=${state.language}`;
    $('#setup-inbox').href = `?portal=mail&run=quickstart&lang=${state.language}`;
    renderInputs(inputs);
    mountSurface();
    renderStatus();
    renderEvidence();
  }

  function reset() {
    state.records = [];
    state.messages = structuredClone(mailMessages);
    state.batch = null;
    state.blocked = false;
    state.running = false;
    state.changed = false;
    state.savedChanged = false;
    state.repairs = 0;
    state.status = 'ready';
    renderLanguage();
  }

  function setValue(field, value) {
    const control = business.form.elements.namedItem(field);
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function runBatch() {
    state.running = true;
    state.blocked = false;
    state.status = 'running';
    renderStatus();
    try {
      for (
        let index = state.records.length - state.batchStart;
        index < state.batch.length;
        index++
      ) {
        if (actionButton().textContent !== saveLabel(state.savedChanged)) {
          state.blocked = true;
          state.status = 'paused';
          break;
        }
        const fields = state.batch[index];
        const prior = state.records.map((record) => JSON.stringify(record));
        if (state.scenario === 'invoice' || state.scenario === 'mail') {
          business.choose(fields[state.scenario === 'invoice' ? 'orderId' : 'mailId']);
          if (state.scenario === 'mail') business.folder.value = fields.folder;
          business.action.click();
        } else {
          for (const [field, value] of Object.entries(fields)) setValue(field, value);
          business.form.requestSubmit(business.save);
        }
        const latest = state.records.at(-1);
        if (
          state.records.length !== state.batchStart + index + 1 ||
          !currentConfig().fields.every((field) => latest.fields[field] === fields[field]) ||
          !prior.every((record, position) => JSON.stringify(state.records[position]) === record)
        )
          throw new Error('Saved draft did not match the input');
      }
      if (!state.blocked) state.status = 'complete';
    } catch {
      state.status = 'failed';
    } finally {
      state.running = false;
      renderStatus();
    }
  }

  const seconds = (ms) => (ms / 1000).toFixed(2);

  function comparisonRow(label, baseline, reflex) {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    row.append(heading);
    for (const result of [baseline, reflex]) {
      const cell = document.createElement('td');
      if (Number.isFinite(result?.medianMs)) {
        const time = document.createElement('span');
        time.className = 'comparison-time';
        time.textContent = seconds(result.medianMs);
        const unit = document.createElement('span');
        unit.className = 'comparison-unit';
        unit.textContent = ' s';
        time.append(unit);
        cell.append(time);
      } else {
        cell.textContent = t('unknown');
      }
      if (Number.isInteger(result?.maxModelCalls)) {
        const detail = document.createElement('small');
        detail.textContent = t('modelCalls', result.maxModelCalls);
        cell.append(detail);
      }
      row.append(cell);
    }
    return row;
  }

  function comparisonGroup(label, rows) {
    const group = document.createElement('tbody');
    const header = group.insertRow();
    header.className = 'comparison-group';
    const heading = document.createElement('th');
    heading.scope = 'rowgroup';
    heading.colSpan = 3;
    heading.textContent = label;
    header.append(heading);
    group.append(...rows);
    return group;
  }

  function renderEvidence() {
    const evidence = state.evidence;
    const loading = !evidence && !state.evidenceError;
    const current = evidence?.schemaVersion === 7;
    const ready =
      current &&
      evidence.status === 'completed' &&
      evidence.summary?.baseline &&
      evidence.summary?.reflex;
    const videoReady = ready && evidence.video?.ready === true;
    const video = $('#demo-video');
    video.hidden = !videoReady;
    $('#video-pending').hidden = videoReady;
    $('#video-pending p').textContent = t(loading ? 'videoLoading' : 'videoUnavailable');
    $('#video-link').hidden = !videoReady;
    const chapters = $('#video-chapters');
    chapters.hidden = !videoReady;
    chapters.setAttribute('aria-label', t('chapterLabel'));
    const chapterStarts = {
      replay: evidence?.video?.warmReplayStartSeconds,
      shared: evidence?.video?.sharedStepsStartSeconds,
      crossTask: evidence?.video?.pairedCompositionStartSeconds,
    };
    for (const button of chapters.querySelectorAll('[data-chapter]')) {
      const seconds = chapterStarts[button.dataset.chapter];
      button.hidden = !Number.isFinite(seconds);
      button.dataset.seconds = String(seconds);
    }
    if (videoReady && !video.getAttribute('src')) {
      const version = evidence.video.sha256.slice(0, 12);
      const videoUrl = '../demo.mp4?v=' + version;
      video.src = videoUrl;
      $('#video-link').href = videoUrl;
      video.poster = '../demo-poster.jpg?v=' + version;
      video.preload = 'metadata';
      video.load();
    }
    const root = $('#evidence-results');
    root.replaceChildren();
    root.hidden = !ready;
    const context = $('#evidence-context');
    context.hidden = ready;
    $('#evidence-link').hidden = !current;
    if (!ready) {
      context.textContent = t(loading ? 'evidenceLoading' : 'evidenceUnavailable');
      return;
    }
    const table = document.createElement('table');
    table.className = 'comparison-table';
    table.setAttribute('aria-labelledby', 'evidence-title');
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const text of [t('task'), t('original'), t('reflex')]) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = text;
      header.append(cell);
    }
    head.append(header);
    table.append(head);
    table.append(
      comparisonGroup(
        t('batchGroup'),
        ['first', 'warm', 'changed', 'whole'].map((phase) =>
          comparisonRow(t(phase), evidence.summary.baseline[phase], evidence.summary.reflex[phase]),
        ),
      ),
    );
    const composition = evidence.compositionComparison;
    if (
      Number.isInteger(composition?.rounds) &&
      composition.rounds > 0 &&
      Number.isFinite(composition.baseline?.medianMs) &&
      Number.isFinite(composition.reflex?.medianMs)
    ) {
      table.append(
        comparisonGroup(t('compositionGroup'), [
          comparisonRow(t('composition'), composition.baseline, composition.reflex),
        ]),
      );
    }
    root.append(table);
  }

  $('#parameters-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.running || state.blocked) return;
    const { common, values } = readInputs();
    const entries = values
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!entries.length) {
      $('#batch-values').setCustomValidity(
        state.language === 'zh' ? '请至少输入一项。' : 'Enter at least one item.',
      );
      $('#batch-values').reportValidity();
      return;
    }
    state.batch = makeBatch(state.scenario, common, entries);
    state.batchStart = state.records.length;
    state.repairs = 0;
    runBatch();
  });
  $('#batch-values').addEventListener('input', () => $('#batch-values').setCustomValidity(''));
  $('#rename-button').addEventListener('click', () => {
    state.changed = !state.changed;
    actionButton().textContent = saveLabel();
    state.status = 'ready';
    renderStatus();
  });
  $('#repair-button').addEventListener('click', () => {
    if (!state.blocked) return;
    state.savedChanged = state.changed;
    state.repairs++;
    runBatch();
  });
  $('#reset-button').addEventListener('click', reset);
  for (const link of document.querySelectorAll('a[href="#playground"]'))
    link.addEventListener('click', () => {
      $('#illustration').open = true;
    });
  for (const button of document.querySelectorAll('[data-scenario]'))
    button.addEventListener('click', () => {
      state.scenario = button.dataset.scenario;
      reset();
    });
  for (const button of document.querySelectorAll('[data-lang]'))
    button.addEventListener('click', () => {
      const inputs = readInputs();
      state.language = button.dataset.lang;
      renderLanguage(inputs);
    });
  $('#video-chapters').addEventListener('click', (event) => {
    const seconds = Number(event.target.closest('button')?.dataset.seconds);
    if (!Number.isFinite(seconds)) return;
    const video = $('#demo-video');
    video.currentTime = seconds;
    video.play().catch(() => {});
  });
  renderLanguage();
  fetch('../../benchmarks/showcase.json')
    .then((response) => {
      if (!response.ok) throw new Error('Unavailable');
      return response.json();
    })
    .then((data) => {
      state.evidence = data;
      renderEvidence();
    })
    .catch(() => {
      state.evidenceError = true;
      renderEvidence();
    });
}
