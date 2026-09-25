// ---- State ----

let SCENARIO = null;
let SEVERITY_MAX = 3;
const ACTIONS_BY_KEY = new Map();
const NO_ACTION = { label: 'No suggested reply', body: 'Needs human assessment.' };
let ALL_ITEMS = [];
let SCENARIOS_LIST = [];

const columnCardsByCategory = {};
const columnCountByCategory = {};
const columnWorkloadByCategory = {};
const agentCountsByCategory = {};

let autoCount = 0;
let autoTotal = 0;

// DeepSeek race bookkeeping, shared by the live classify race and the batch race sample.
const cardsById = new Map(); // item id -> card DOM node (current batch run only)
const resultsById = new Map(); // item id -> Jev result (for agreement checks)
const deepseekResultsById = new Map(); // item id -> {latency_ms, answer, timed_out, error}
let raceSampleIds = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function severityColor(score) {
  const colors = ['var(--sev-0)', 'var(--sev-1)', 'var(--sev-2)', 'var(--sev-3)'];
  const idx = Math.max(0, Math.min(SEVERITY_MAX, Math.round(score)));
  return colors[Math.min(idx, colors.length - 1)];
}

function severityLabelFor(score) {
  const levels = SCENARIO?.severityLevels || [];
  const idx = Math.max(0, Math.min(levels.length - 1, Math.round(score)));
  return levels[idx] || '';
}

function severityPct(score) {
  return Math.max(0, Math.min(1, score / SEVERITY_MAX)) * 100;
}

function categoryByKey(key) {
  return SCENARIO?.categories.find((c) => c.key === key);
}

function actionInfo(result) {
  if (!result.action) return NO_ACTION;
  return ACTIONS_BY_KEY.get(result.action) || NO_ACTION;
}

function isAutoResolved(result) {
  return Boolean(result.action) && result.needs_human <= 0.5;
}

function slaInfo(result) {
  const hoursLeft = (new Date(result.sla_due_at).getTime() - Date.now()) / 3600000;
  let text;
  if (hoursLeft < 1) text = `${Math.max(1, Math.round(hoursLeft * 60))}min`;
  else if (hoursLeft < 24) text = `${Math.round(hoursLeft)}h`;
  else text = `${Math.round(hoursLeft / 24)}d`;
  const urgency = hoursLeft <= 1 ? 'sla-urgent' : hoursLeft <= 4 ? 'sla-soon' : '';
  return { text: `SLA: ${text}`, urgency };
}

function deepseekAgrees(answer, categoryKey) {
  if (!answer || !categoryKey) return false;
  return answer.toLowerCase().includes(categoryKey.toLowerCase());
}

// DeepSeek answers as free text (e.g. "billing" or, in verbose mode, a sentence
// ending in the category word) - find which known category it actually named.
function parseDeepseekCategory(answer) {
  if (!answer || !SCENARIO) return null;
  const lower = answer.toLowerCase();
  return SCENARIO.categories.find((c) => lower.includes(c.key.toLowerCase())) || null;
}

function formatDeepseekAnswer(result) {
  if (result.timed_out) return `Timed out after ${Math.round(result.latency_ms / 1000)}s`;
  if (result.error) return `Error: ${result.error}`;
  return result.answer || '(empty response)';
}

function speedupLabel(jevMs, otherMs) {
  const factor = (otherMs / jevMs).toFixed(1);
  return `${factor}x slower than Jev`;
}

function paintCategoryBadge(node, cat) {
  if (!cat) {
    node.hidden = true;
    return;
  }
  node.textContent = cat.label;
  node.style.background = cat.color;
  node.style.color = '#0b0e14';
  node.hidden = false;
}

function paintAgreeBadge(node, agree) {
  node.textContent = agree ? 'Agrees with Jev' : 'Disagrees with Jev';
  node.className = `badge ${agree ? 'ds-agree' : 'ds-disagree'}`;
  node.hidden = false;
}

// ---- Toasts (escalation) ----

const toastStack = document.getElementById('toast-stack');

function showToast(title, body) {
  const toast = el('div', 'toast');
  toast.append(el('div', 'toast-title', title), el('div', 'toast-body', body));
  toastStack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  }, 4500);
  while (toastStack.children.length > 4) toastStack.firstChild.remove();
}

function maybeEscalate(result) {
  if (Math.round(result.severity) < SEVERITY_MAX) return;
  const to = result.agent ? `${result.agent} (on-call)` : 'the on-call team';
  showToast('Critical item escalated', `${to} — "${result.text.slice(0, 60)}${result.text.length > 60 ? '…' : ''}"`);
}

// ---- API keys (stored per-browser in localStorage; sent only to this app's own server) ----

const JEV_KEY_STORAGE = 'jev_api_key';
const DS_KEY_STORAGE = 'ds_api_key';
const jevKeyInput = document.getElementById('jev-api-key');
const dsKeyInput = document.getElementById('ds-api-key');

try {
  jevKeyInput.value = localStorage.getItem(JEV_KEY_STORAGE) || '';
  dsKeyInput.value = localStorage.getItem(DS_KEY_STORAGE) || '';
} catch {}

jevKeyInput.addEventListener('input', () => {
  try { localStorage.setItem(JEV_KEY_STORAGE, jevKeyInput.value.trim()); } catch {}
});
dsKeyInput.addEventListener('input', () => {
  try { localStorage.setItem(DS_KEY_STORAGE, dsKeyInput.value.trim()); } catch {}
});

function getJevKey() {
  return jevKeyInput.value.trim();
}
function getDsKey() {
  return dsKeyInput.value.trim();
}

// ---- Settings drawer ----

const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const settingsDrawer = document.getElementById('settings-drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const drawerCloseBtn = document.getElementById('drawer-close-btn');

function openDrawer() {
  settingsDrawer.hidden = false;
  drawerOverlay.hidden = false;
}

function closeDrawer() {
  settingsDrawer.hidden = true;
  drawerOverlay.hidden = true;
}

settingsToggleBtn.addEventListener('click', openDrawer);
drawerCloseBtn.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsDrawer.hidden) closeDrawer();
});

// ---- Detail modal ----

const detailModal = document.getElementById('detail-modal');
const modalClose = document.getElementById('modal-close');
const modalText = document.getElementById('modal-text');
const modalBadges = document.getElementById('modal-badges');
const modalCategory = document.getElementById('modal-category');
const modalSeverityFill = document.getElementById('modal-severity-fill');
const modalSeverityLabel = document.getElementById('modal-severity-label');
const modalHuman = document.getElementById('modal-human');
const modalStatus = document.getElementById('modal-status');
const modalLatency = document.getElementById('modal-latency');
const modalMetaRow = document.getElementById('modal-meta-row');
const modalAgent = document.getElementById('modal-agent');
const modalSla = document.getElementById('modal-sla');
const modalActionBlock = document.getElementById('modal-action-block');
const modalActionLabel = document.getElementById('modal-action-label');
const modalActionBody = document.getElementById('modal-action-body');
const modalConfidenceBlock = document.getElementById('modal-confidence-block');
const modalConfidenceRows = document.getElementById('modal-confidence-rows');
const modalDeepseekCompare = document.getElementById('modal-deepseek-compare');
const modalDeepseekText = document.getElementById('modal-deepseek-text');
const modalDsCategory = document.getElementById('modal-ds-category');
const modalDsAgree = document.getElementById('modal-ds-agree');
const modalDsStats = document.getElementById('modal-ds-stats');
const modalDsSpeedTag = document.getElementById('modal-ds-speed-tag');

function confidenceRow(label, value) {
  const row = el('div', 'confidence-row');
  row.append(el('span', 'confidence-row-label', label));
  const barWrap = el('div', 'confidence-row-bar');
  const fill = el('div', 'confidence-row-fill');
  fill.style.width = `${Math.round(value * 100)}%`;
  barWrap.appendChild(fill);
  row.appendChild(barWrap);
  row.append(el('span', 'confidence-row-value', `${Math.round(value * 100)}%`));
  return row;
}

function openDetailModal(item) {
  modalText.textContent = item.text;
  const classified = typeof item.category === 'string';

  modalBadges.hidden = !classified;
  modalMetaRow.hidden = !classified;
  modalActionBlock.hidden = !classified;
  modalConfidenceBlock.hidden = !classified;

  if (classified) {
    const cat = categoryByKey(item.category);
    modalCategory.textContent = cat?.label || item.category;
    modalCategory.style.background = cat?.color || '#8b93a7';
    modalCategory.style.color = '#0b0e14';
    modalSeverityFill.style.width = `${severityPct(item.severity)}%`;
    modalSeverityFill.style.background = severityColor(item.severity);
    modalSeverityLabel.textContent = severityLabelFor(item.severity);
    modalHuman.hidden = !(item.needs_human > 0.5);
    modalLatency.textContent = `${Math.round(item.latency_ms)}ms`;

    const auto = isAutoResolved(item);
    modalStatus.textContent = auto ? 'Auto-resolved' : 'Needs review';
    modalStatus.className = `badge status-badge ${auto ? 'status-auto' : 'status-review'}`;

    modalAgent.textContent = item.agent ? `${SCENARIO.agentNoun.singular}: ${item.agent}` : '';
    modalAgent.hidden = !item.agent;
    const sla = slaInfo(item);
    modalSla.textContent = sla.text;
    modalSla.className = `tag sla-tag ${sla.urgency}`;

    const action = actionInfo(item);
    modalActionLabel.textContent = action.label;
    modalActionLabel.classList.toggle('no-action', action === NO_ACTION);
    modalActionBody.textContent = action.body;

    modalConfidenceRows.replaceChildren(
      confidenceRow('Category', item.category_confidence),
      confidenceRow(SCENARIO.severityLabel, item.severity_confidence),
      confidenceRow(SCENARIO.humanLabel, item.needs_human),
      confidenceRow(SCENARIO.actionLabel, item.action_confidence)
    );

    const dsResult = deepseekResultsById.get(item.id);
    modalDeepseekCompare.hidden = !dsResult;
    if (dsResult) {
      const ok = !dsResult.timed_out && !dsResult.error;
      modalDeepseekText.textContent = `${formatDeepseekAnswer(dsResult)} (${Math.round(dsResult.latency_ms)}ms)`;
      paintCategoryBadge(modalDsCategory, ok ? parseDeepseekCategory(dsResult.answer) : null);
      if (ok) paintAgreeBadge(modalDsAgree, deepseekAgrees(dsResult.answer, item.category));
      else modalDsAgree.hidden = true;
      if (ok) {
        modalDsSpeedTag.textContent = speedupLabel(item.latency_ms, dsResult.latency_ms);
        modalDsStats.hidden = false;
      } else {
        modalDsStats.hidden = true;
      }
    }
  } else {
    modalDeepseekCompare.hidden = true;
  }

  detailModal.hidden = false;
}

function closeDetailModal() {
  detailModal.hidden = true;
}

modalClose.addEventListener('click', closeDetailModal);
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeDetailModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !detailModal.hidden) closeDetailModal();
});

// ---- Board ----

const board = document.getElementById('board');

function buildBoard(categories) {
  board.replaceChildren();
  for (const key of Object.keys(columnCardsByCategory)) delete columnCardsByCategory[key];
  for (const key of Object.keys(columnCountByCategory)) delete columnCountByCategory[key];
  for (const key of Object.keys(columnWorkloadByCategory)) delete columnWorkloadByCategory[key];
  for (const key of Object.keys(agentCountsByCategory)) delete agentCountsByCategory[key];

  for (const cat of categories) {
    const col = el('div', 'column');
    col.style.setProperty('--category-color', cat.color);

    const header = el('div', 'column-header');
    const top = el('div', 'column-header-top');
    top.append(el('span', 'column-title', cat.label), el('span', 'column-count', '0'));
    const workload = el('div', 'column-workload', '');
    header.append(top, workload);

    const cards = el('div', 'column-cards');

    col.append(header, cards);
    board.appendChild(col);
    columnCardsByCategory[cat.key] = cards;
    columnCountByCategory[cat.key] = top.lastChild;
    columnWorkloadByCategory[cat.key] = workload;
    agentCountsByCategory[cat.key] = new Map();
  }
}

function updateWorkload(categoryKey, agent) {
  if (!agent) return;
  const counts = agentCountsByCategory[categoryKey];
  if (!counts) return;
  counts.set(agent, (counts.get(agent) || 0) + 1);
  const text = [...counts.entries()].map(([name, n]) => `${name}: ${n}`).join(' · ');
  columnWorkloadByCategory[categoryKey].textContent = text;
}

function updateAutoStat() {
  const statAuto = document.getElementById('stat-auto');
  const pct = autoTotal ? Math.round((autoCount / autoTotal) * 100) : 0;
  statAuto.textContent = `${autoCount}/${autoTotal} (${pct}%)`;
}

function buildDsLine(id) {
  const line = el('div', 'card-ds ds-pending', 'DeepSeek: racing...');
  return line;
}

function appendCard(result) {
  const category = categoryByKey(result.category) ? result.category : SCENARIO.categories[0].key;
  const container = columnCardsByCategory[category];
  if (!container) return;

  const card = el('div', 'card');
  card.append(el('div', 'card-text', result.text));

  const meta = el('div', 'card-meta');
  const bar = el('div', 'severity-bar');
  const fill = el('div', 'severity-fill');
  fill.style.width = `${severityPct(result.severity)}%`;
  fill.style.background = severityColor(result.severity);
  bar.appendChild(fill);
  meta.appendChild(bar);
  if (result.needs_human > 0.5) meta.appendChild(el('span', 'badge human-badge', 'needs human'));
  meta.appendChild(el('span', 'latency-badge', `${Math.round(result.latency_ms)}ms`));
  card.appendChild(meta);

  const statusRow = el('div', 'card-status-row');
  const auto = isAutoResolved(result);
  const statusBadge = el('span', `badge status-badge ${auto ? 'status-auto' : 'status-review'}`, auto ? 'Auto-resolved' : 'Needs review');
  statusRow.appendChild(statusBadge);
  if (result.agent) statusRow.appendChild(el('span', 'tag', result.agent));
  const sla = slaInfo(result);
  statusRow.appendChild(el('span', `tag sla-tag ${sla.urgency}`, sla.text));
  card.appendChild(statusRow);

  const action = actionInfo(result);
  const actionLine = el('div', 'card-action', action.label);
  actionLine.title = action.body;
  if (action === NO_ACTION) actionLine.classList.add('no-action');
  card.appendChild(actionLine);

  if (raceSampleIds.has(result.id)) card.appendChild(buildDsLine(result.id));

  card.addEventListener('click', () => openDetailModal(result));
  container.prepend(card);
  columnCountByCategory[category].textContent = String(container.children.length);

  cardsById.set(result.id, card);
  resultsById.set(result.id, result);

  updateWorkload(category, result.agent);
  autoTotal += 1;
  if (auto) autoCount += 1;
  updateAutoStat();
  maybeEscalate(result);
}

function applyDeepseekToCard(id, dsResult) {
  deepseekResultsById.set(id, dsResult);
  const card = cardsById.get(id);
  if (!card) return;
  let dsLine = card.querySelector('.card-ds');
  if (!dsLine) {
    dsLine = el('div', 'card-ds');
    card.appendChild(dsLine);
  }
  const jevResult = resultsById.get(id);
  const agree = jevResult && !dsResult.timed_out && !dsResult.error && deepseekAgrees(dsResult.answer, jevResult.category);
  dsLine.className = `card-ds ${dsResult.timed_out || dsResult.error ? '' : agree ? 'ds-agree' : 'ds-disagree'}`;
  dsLine.textContent = `DeepSeek: ${formatDeepseekAnswer(dsResult)} (${Math.round(dsResult.latency_ms)}ms)`;
}

// ---- Queue ----

const queueList = document.getElementById('queue');
const queueCount = document.getElementById('queue-count');
const queueItems = new Map();

function updateQueueCount() {
  queueCount.textContent = queueItems.size ? `(${queueItems.size})` : '';
}

function renderQueue(items) {
  queueItems.clear();
  queueList.replaceChildren();
  for (const item of items) {
    const node = el('div', 'queue-item', `#${item.id} ${item.text}`);
    node.addEventListener('click', () => openDetailModal(item));
    queueList.appendChild(node);
    queueItems.set(item.id, node);
  }
  updateQueueCount();
}

function removeFromQueue(id) {
  const node = queueItems.get(id);
  if (!node) return;
  node.remove();
  queueItems.delete(id);
  updateQueueCount();
}

// ---- In-flight tray ----

const inflightGrid = document.getElementById('inflight');
const inflightCount = document.getElementById('inflight-count');
const inflightCards = new Map();

function addInflight(item) {
  const card = el('div', 'inflight-card');
  const text = el('div', 'inflight-text', item.text);
  const timer = el('div', 'inflight-timer', '0ms');
  card.append(text, timer);
  card.addEventListener('click', () => openDetailModal(item));
  inflightGrid.appendChild(card);

  const startedAt = performance.now();
  const intervalId = setInterval(() => {
    timer.textContent = `${Math.round(performance.now() - startedAt)}ms`;
  }, 60);

  inflightCards.set(item.id, { node: card, intervalId });
  inflightCount.textContent = `(${inflightCards.size})`;
}

function removeInflight(id) {
  const entry = inflightCards.get(id);
  if (!entry) return;
  clearInterval(entry.intervalId);
  entry.node.remove();
  inflightCards.delete(id);
  inflightCount.textContent = inflightCards.size ? `(${inflightCards.size})` : '';
}

function clearAllInflight() {
  for (const entry of inflightCards.values()) clearInterval(entry.intervalId);
  inflightCards.clear();
  inflightGrid.replaceChildren();
  inflightCount.textContent = '';
}

// ---- Stats ----

const statProcessed = document.getElementById('stat-processed');
const statElapsed = document.getElementById('stat-elapsed');
const statThroughput = document.getElementById('stat-throughput');
const statAvgLatency = document.getElementById('stat-avg-latency');
const statCost = document.getElementById('stat-cost');
const statDsWrap = document.getElementById('stat-ds-wrap');
const statDsProgress = document.getElementById('stat-ds-progress');
const statDsAgreeWrap = document.getElementById('stat-ds-agree-wrap');
const statDsAgreement = document.getElementById('stat-ds-agreement');
const startBtn = document.getElementById('start-btn');
const newBatchBtn = document.getElementById('new-batch-btn');
const batchRaceToggle = document.getElementById('batch-race-toggle');
const batchRaceOptions = document.getElementById('batch-race-options');
const batchRaceReasoning = document.getElementById('batch-race-reasoning');
const batchRaceConcise = document.getElementById('batch-race-concise');
const errorsBox = document.getElementById('errors');

let latencySum = 0;
let latencyCount = 0;
let dsSampleTotal = 0;
let dsSampleCompleted = 0;
let dsAgreeCount = 0;

batchRaceToggle.addEventListener('change', () => {
  batchRaceOptions.hidden = !batchRaceToggle.checked;
});

function updateDsStats() {
  statDsProgress.textContent = `${dsSampleCompleted}/${dsSampleTotal}`;
  const pct = dsSampleCompleted ? Math.round((dsAgreeCount / dsSampleCompleted) * 100) : 0;
  statDsAgreement.textContent = dsSampleCompleted ? `${pct}%` : '--';
}

function resetBoard() {
  for (const cat of SCENARIO.categories) {
    columnCardsByCategory[cat.key].replaceChildren();
    columnCountByCategory[cat.key].textContent = '0';
    columnWorkloadByCategory[cat.key].textContent = '';
    agentCountsByCategory[cat.key] = new Map();
  }
  errorsBox.hidden = true;
  errorsBox.replaceChildren();
  clearAllInflight();
  renderQueue(ALL_ITEMS);
  cardsById.clear();
  resultsById.clear();
  deepseekResultsById.clear();
  raceSampleIds = new Set();
  latencySum = 0;
  latencyCount = 0;
  autoCount = 0;
  autoTotal = 0;
  dsSampleTotal = 0;
  dsSampleCompleted = 0;
  dsAgreeCount = 0;
  statProcessed.textContent = '0/0';
  statElapsed.textContent = '0.0s';
  statThroughput.textContent = '0.0/s';
  statAvgLatency.textContent = '-- ms';
  statCost.textContent = '$0.0000';
  updateAutoStat();
  updateDsStats();
}

function updateStats(msg) {
  statProcessed.textContent = `${msg.completed}/${msg.total}`;
  const elapsedS = msg.elapsed_ms / 1000;
  statElapsed.textContent = `${elapsedS.toFixed(1)}s`;
  statThroughput.textContent = `${(msg.completed / Math.max(elapsedS, 0.001)).toFixed(1)}/s`;
  if (typeof msg.latency_ms === 'number') {
    latencySum += msg.latency_ms;
    latencyCount += 1;
  }
  if (latencyCount > 0) statAvgLatency.textContent = `${Math.round(latencySum / latencyCount)} ms`;
  if (typeof msg.cost_estimate_running === 'number') {
    statCost.textContent = `$${msg.cost_estimate_running.toFixed(4)}`;
  }
}

startBtn.addEventListener('click', () => {
  resetBoard();
  const racing = batchRaceToggle.checked;
  statDsWrap.hidden = !racing;
  statDsAgreeWrap.hidden = !racing;

  startBtn.disabled = true;
  newBatchBtn.disabled = true;
  batchRaceToggle.disabled = true;
  setScenarioSwitcherEnabled(false);
  startBtn.textContent = 'Triaging...';

  const params = new URLSearchParams();
  if (racing) {
    params.set('race', 'on');
    params.set('reasoning', batchRaceReasoning.checked ? 'on' : 'off');
    params.set('concise', batchRaceConcise.checked ? 'on' : 'off');
  }
  if (getJevKey()) params.set('jevKey', getJevKey());
  if (getDsKey()) params.set('dsKey', getDsKey());
  const qs = params.toString();
  const source = new EventSource(`/api/stream${qs ? `?${qs}` : ''}`);

  source.addEventListener('dispatch', (e) => {
    const item = JSON.parse(e.data);
    removeFromQueue(item.id);
    addInflight(item);
  });

  source.addEventListener('result', (e) => {
    const result = JSON.parse(e.data);
    removeInflight(result.id);
    appendCard(result);
    updateStats(result);
  });

  source.addEventListener('race-sample', (e) => {
    const msg = JSON.parse(e.data);
    raceSampleIds = new Set(msg.ids);
    dsSampleTotal = msg.total;
    updateDsStats();
  });

  source.addEventListener('deepseek-item-done', (e) => {
    const msg = JSON.parse(e.data);
    dsSampleCompleted = msg.completed;
    const jevResult = resultsById.get(msg.id);
    if (jevResult && !msg.timed_out && !msg.error && deepseekAgrees(msg.answer, jevResult.category)) dsAgreeCount++;
    updateDsStats();
    applyDeepseekToCard(msg.id, msg);
  });

  source.addEventListener('error', (e) => {
    if (!e.data) return;
    const err = JSON.parse(e.data);
    removeInflight(err.id);
    errorsBox.hidden = false;
    errorsBox.appendChild(el('div', null, `Item #${err.id} failed: ${err.message}`));
  });

  source.addEventListener('done', (e) => {
    const msg = JSON.parse(e.data);
    statCost.textContent = `$${msg.cost_estimate.toFixed(4)}`;
    clearAllInflight();
    startBtn.disabled = false;
    newBatchBtn.disabled = false;
    batchRaceToggle.disabled = false;
    setScenarioSwitcherEnabled(true);
    startBtn.textContent = 'Run Again';
    source.close();
  });

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      clearAllInflight();
      startBtn.disabled = false;
      newBatchBtn.disabled = false;
      batchRaceToggle.disabled = false;
      setScenarioSwitcherEnabled(true);
      startBtn.textContent = 'Run Again';
    }
  };
});

newBatchBtn.addEventListener('click', async () => {
  newBatchBtn.disabled = true;
  newBatchBtn.textContent = 'Generating...';
  try {
    const res = await fetch('/api/items/generate', { method: 'POST' });
    const data = await res.json();
    ALL_ITEMS = data.items;
    resetBoard();
    startBtn.textContent = `Start Triage (${data.total} ${SCENARIO.itemNoun.plural})`;
  } finally {
    newBatchBtn.disabled = false;
    newBatchBtn.textContent = 'New Batch';
  }
});

// ---- Scenario switcher ----

const scenarioSwitcher = document.getElementById('scenario-switcher');
const scenarioDescription = document.getElementById('scenario-description');

function setScenarioSwitcherEnabled(enabled) {
  for (const btn of scenarioSwitcher.querySelectorAll('button')) btn.disabled = !enabled;
}

function renderScenarioSwitcher() {
  scenarioSwitcher.replaceChildren();
  for (const s of SCENARIOS_LIST) {
    const btn = el('button', `scenario-btn${s.key === SCENARIO.key ? ' active' : ''}`, s.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (s.key !== SCENARIO.key) switchScenario(s.key);
    });
    scenarioSwitcher.appendChild(btn);
  }
}

async function switchScenario(key) {
  setScenarioSwitcherEnabled(false);
  const res = await fetch('/api/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  SCENARIO = await res.json();
  SEVERITY_MAX = SCENARIO.severityLevels.length - 1;
  scenarioDescription.textContent = SCENARIO.description;
  document.getElementById('live-input').placeholder = SCENARIO.inputPlaceholder;
  renderScenarioSwitcher();

  buildBoard(SCENARIO.categories);
  await Promise.all([loadItems(), loadActions()]);
  resetBoard();
  setScenarioSwitcherEnabled(true);
}

async function loadItems() {
  const res = await fetch('/api/items');
  const data = await res.json();
  ALL_ITEMS = data.items;
  startBtn.textContent = `Start Triage (${data.total} ${SCENARIO.itemNoun.plural})`;
}

async function loadActions() {
  const res = await fetch('/api/actions');
  const data = await res.json();
  ACTIONS_BY_KEY.clear();
  for (const a of data.actions) ACTIONS_BY_KEY.set(a.key, a);
  renderActionsList();
  document.getElementById('actions-count').textContent = `(${data.actions.length})`;
}

// ---- Reply templates (inside settings drawer) ----

const actionsList = document.getElementById('actions-list');
const addActionForm = document.getElementById('add-action-form');
const addActionError = document.getElementById('add-action-error');

function renderActionsList(highlightKey) {
  actionsList.replaceChildren();
  for (const action of ACTIONS_BY_KEY.values()) {
    const row = el('div', `action-row${action.key === highlightKey ? ' new' : ''}`);
    row.append(
      el('div', 'action-row-label', action.label),
      el('div', 'action-row-criteria', `When to use: ${action.criteria}`),
      el('div', 'action-row-body', action.body)
    );
    actionsList.appendChild(row);
  }
}

addActionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('action-label').value.trim();
  const criteria = document.getElementById('action-criteria').value.trim();
  const body = document.getElementById('action-body').value.trim();
  if (!label || !criteria || !body) return;

  const submitBtn = document.getElementById('add-action-submit');
  submitBtn.disabled = true;
  addActionError.hidden = true;

  try {
    const res = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, criteria, body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add action');

    ACTIONS_BY_KEY.set(data.action.key, data.action);
    renderActionsList(data.action.key);
    addActionForm.reset();
    document.getElementById('actions-count').textContent = `(${data.actions.length})`;
    showToast('Template added', `"${data.action.label}" — Jev will start using it on the next classification.`);
  } catch (err) {
    addActionError.textContent = String(err.message || err);
    addActionError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---- Classify (unified live classify + optional DeepSeek race) ----

const liveForm = document.getElementById('live-form');
const liveInput = document.getElementById('live-input');
const liveSubmit = document.getElementById('live-submit');
const liveRaceToggle = document.getElementById('live-race-toggle');
const liveRaceOptions = document.getElementById('live-race-options');
const liveRaceReasoning = document.getElementById('live-race-reasoning');
const liveRaceConcise = document.getElementById('live-race-concise');
const liveResultLanes = document.getElementById('live-result-lanes');
const liveError = document.getElementById('live-error');
const liveLatencyValue = document.getElementById('live-latency-value');
const liveJevLane = document.getElementById('live-jev-lane');
const liveCategory = document.getElementById('live-category');
const liveSeverityFill = document.getElementById('live-severity-fill');
const liveSeverityLabel = document.getElementById('live-severity-label');
const liveHuman = document.getElementById('live-human');
const liveStatus = document.getElementById('live-status');
const liveAgent = document.getElementById('live-agent');
const liveSla = document.getElementById('live-sla');
const liveActionLabel = document.getElementById('live-action-label');
const liveActionBody = document.getElementById('live-action-body');
const liveDeepseekLane = document.getElementById('live-deepseek-lane');
const liveDsTime = document.getElementById('live-ds-time');
const liveDsAnswer = document.getElementById('live-ds-answer');
const liveDsCategory = document.getElementById('live-ds-category');
const liveDsAgree = document.getElementById('live-ds-agree');
const liveDsStats = document.getElementById('live-ds-stats');
const liveDsSpeedTag = document.getElementById('live-ds-speed-tag');

let livePendingInterval = null;
let dsPendingInterval = null;

liveRaceToggle.addEventListener('change', () => {
  liveRaceOptions.hidden = !liveRaceToggle.checked;
});

function renderJevLane(result) {
  liveLatencyValue.textContent = Math.round(result.latency_ms);
  const cat = categoryByKey(result.category);
  liveCategory.textContent = cat?.label || result.category;
  liveCategory.style.background = cat?.color || '#8b93a7';
  liveCategory.style.color = '#0b0e14';
  liveSeverityFill.style.width = `${severityPct(result.severity)}%`;
  liveSeverityFill.style.background = severityColor(result.severity);
  liveSeverityLabel.textContent = severityLabelFor(result.severity);
  liveHuman.hidden = !(result.needs_human > 0.5);

  const auto = isAutoResolved(result);
  liveStatus.textContent = auto ? 'Auto-resolved' : 'Needs review';
  liveStatus.className = `badge status-badge ${auto ? 'status-auto' : 'status-review'}`;

  liveAgent.textContent = result.agent ? `${SCENARIO.agentNoun.singular}: ${result.agent}` : '';
  liveAgent.hidden = !result.agent;
  const sla = slaInfo(result);
  liveSla.textContent = sla.text;
  liveSla.className = `tag sla-tag ${sla.urgency}`;

  const action = actionInfo(result);
  liveActionLabel.textContent = action.label;
  liveActionLabel.classList.toggle('no-action', action === NO_ACTION);
  liveActionBody.textContent = action.body;
}

function resetLiveLanes(racing) {
  liveResultLanes.hidden = false;
  liveJevLane.classList.add('pending');
  liveCategory.textContent = '';
  liveSeverityFill.style.width = '0%';
  liveSeverityLabel.textContent = '';
  liveHuman.hidden = true;
  liveStatus.textContent = '';
  liveAgent.textContent = '';
  liveSla.textContent = '';
  liveActionLabel.textContent = 'Classifying...';
  liveActionLabel.classList.remove('no-action');
  liveActionBody.textContent = '';
  liveLatencyValue.textContent = '0';

  liveDeepseekLane.hidden = !racing;
  if (racing) {
    liveDeepseekLane.classList.add('pending');
    liveDsTime.textContent = '0';
    liveDsAnswer.textContent = 'Racing...';
    liveDsCategory.hidden = true;
    liveDsAgree.hidden = true;
    liveDsStats.hidden = true;
  }
}

liveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = liveInput.value.trim();
  if (!text) return;

  liveSubmit.disabled = true;
  liveError.hidden = true;

  const racing = liveRaceToggle.checked;
  resetLiveLanes(racing);

  const jevStartedAt = performance.now();
  livePendingInterval = setInterval(() => {
    liveLatencyValue.textContent = Math.round(performance.now() - jevStartedAt);
  }, 50);

  if (!racing) {
    try {
      const res = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-jev-key': getJevKey() },
        body: JSON.stringify({ text }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Classification failed');

      clearInterval(livePendingInterval);
      liveJevLane.classList.remove('pending');
      renderJevLane(result);
      appendCard(result);
    } catch (err) {
      clearInterval(livePendingInterval);
      liveResultLanes.hidden = true;
      liveError.textContent = String(err.message || err);
      liveError.hidden = false;
    } finally {
      liveSubmit.disabled = false;
    }
    return;
  }

  // Racing DeepSeek: stream both results via SSE.
  const dsStartedAt = performance.now();
  dsPendingInterval = setInterval(() => {
    liveDsTime.textContent = Math.round(performance.now() - dsStartedAt);
  }, 50);

  const params = new URLSearchParams({
    text,
    reasoning: liveRaceReasoning.checked ? 'on' : 'off',
    concise: liveRaceConcise.checked ? 'on' : 'off',
  });
  if (getJevKey()) params.set('jevKey', getJevKey());
  if (getDsKey()) params.set('dsKey', getDsKey());
  const source = new EventSource(`/api/race?${params.toString()}`);
  let liveJevResult = null;

  source.addEventListener('jev-done', (e) => {
    const result = JSON.parse(e.data);
    clearInterval(livePendingInterval);
    liveJevLane.classList.remove('pending');
    if (result.error) {
      liveError.textContent = result.error;
      liveError.hidden = false;
      return;
    }
    liveJevResult = result;
    renderJevLane(result);
    appendCard(result);
  });

  source.addEventListener('deepseek-done', (e) => {
    const result = JSON.parse(e.data);
    clearInterval(dsPendingInterval);
    liveDeepseekLane.classList.remove('pending');
    liveDsTime.textContent = Math.round(result.latency_ms);
    liveDsAnswer.textContent = formatDeepseekAnswer(result);

    const ok = !result.timed_out && !result.error;
    paintCategoryBadge(liveDsCategory, ok ? parseDeepseekCategory(result.answer) : null);

    if (liveJevResult && ok) {
      paintAgreeBadge(liveDsAgree, deepseekAgrees(result.answer, liveJevResult.category));
      liveDsSpeedTag.textContent = speedupLabel(liveJevResult.latency_ms, result.latency_ms);
      liveDsStats.hidden = false;
      if (liveJevResult.id) applyDeepseekToCard(liveJevResult.id, result);
    } else {
      liveDsAgree.hidden = true;
      liveDsStats.hidden = true;
    }
  });

  source.addEventListener('race-done', () => {
    liveSubmit.disabled = false;
    source.close();
  });

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      clearInterval(livePendingInterval);
      clearInterval(dsPendingInterval);
      liveJevLane.classList.remove('pending');
      liveDeepseekLane.classList.remove('pending');
      liveSubmit.disabled = false;
    }
  };
});

// ---- Initial load ----

(async function init() {
  const scenariosRes = await fetch('/api/scenarios');
  const scenariosData = await scenariosRes.json();
  SCENARIOS_LIST = scenariosData.scenarios;
  SCENARIO = scenariosData.scenarios.find((s) => s.key === scenariosData.active) || scenariosData.scenarios[0];
  SEVERITY_MAX = SCENARIO.severityLevels.length - 1;

  scenarioDescription.textContent = SCENARIO.description;
  liveInput.placeholder = SCENARIO.inputPlaceholder;
  renderScenarioSwitcher();
  buildBoard(SCENARIO.categories);

  await Promise.all([loadItems(), loadActions()]);
  renderQueue(ALL_ITEMS);
  statProcessed.textContent = `0/${ALL_ITEMS.length}`;
  updateAutoStat();
  updateDsStats();
})();
