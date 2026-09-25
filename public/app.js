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
  refreshDsAgreement(result.id);
}

// Records DeepSeek's answer for an item without touching Jev's card/board -
// Jev and DeepSeek results are shown in fully separate boards/lanes (see the
// engine tabs) and only meet again in the detail modal's side-by-side compare.
function storeDeepseekResult(id, dsResult) {
  deepseekResultsById.set(id, dsResult);
}

// ---- DeepSeek's own board (separate from Jev's; only holds its race sample) ----

const dsBoard = document.getElementById('ds-board');
const dsColumnCardsByCategory = {};
const dsColumnCountByCategory = {};
const dsCardsById = new Map(); // item id -> {card, agreeTag}

function buildDsBoard(categories) {
  dsBoard.replaceChildren();
  for (const key of Object.keys(dsColumnCardsByCategory)) delete dsColumnCardsByCategory[key];
  for (const key of Object.keys(dsColumnCountByCategory)) delete dsColumnCountByCategory[key];
  dsCardsById.clear();

  const cols = [...categories, { key: 'unclear', label: 'Unclear / error', color: '#8b93a7' }];
  for (const cat of cols) {
    const col = el('div', 'column');
    col.style.setProperty('--category-color', cat.color);

    const header = el('div', 'column-header');
    const top = el('div', 'column-header-top');
    top.append(el('span', 'column-title', cat.label), el('span', 'column-count', '0'));
    header.append(top);

    const cards = el('div', 'column-cards');
    col.append(header, cards);
    dsBoard.appendChild(col);
    dsColumnCardsByCategory[cat.key] = cards;
    dsColumnCountByCategory[cat.key] = top.lastChild;
  }
}

function appendDsCard(item, dsResult) {
  const ok = !dsResult.timed_out && !dsResult.error;
  const cat = ok ? parseDeepseekCategory(dsResult.answer) : null;
  const catKey = cat ? cat.key : 'unclear';
  const container = dsColumnCardsByCategory[catKey] || dsColumnCardsByCategory.unclear;
  if (!container || !item) return;

  const card = el('div', 'card');
  card.append(el('div', 'card-text', item.text));

  const meta = el('div', 'card-meta');
  meta.appendChild(el('span', 'latency-badge', `${Math.round(dsResult.latency_ms)}ms`));
  card.appendChild(meta);

  card.appendChild(el('div', 'card-action', formatDeepseekAnswer(dsResult)));

  const agreeTag = el('span', 'badge', '');
  agreeTag.hidden = true;
  card.appendChild(agreeTag);

  card.addEventListener('click', () => openDetailModal(resultsById.get(item.id) || item));
  container.prepend(card);
  dsColumnCountByCategory[catKey].textContent = String(container.children.length);
  dsCardsById.set(item.id, { card, agreeTag });

  refreshDsAgreement(item.id);
}

// Whichever of Jev/DeepSeek finishes an item last, check if the other side
// already has a result too and paint the "agrees/disagrees" tag on DeepSeek's
// own card then - the two boards fill independently and in any order.
function refreshDsAgreement(id) {
  const entry = dsCardsById.get(id);
  if (!entry) return;
  const jevResult = resultsById.get(id);
  const dsResult = deepseekResultsById.get(id);
  if (!jevResult || !dsResult) return;
  if (dsResult.timed_out || dsResult.error) return;
  paintAgreeBadge(entry.agreeTag, deepseekAgrees(dsResult.answer, jevResult.category));
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

// ---- DeepSeek's own queue + in-flight tray (mirrors Jev's above, own sample only) ----

const dsQueueList = document.getElementById('ds-queue');
const dsQueueCount = document.getElementById('ds-queue-count');
const dsQueueItems = new Map();

function updateDsQueueCount() {
  dsQueueCount.textContent = dsQueueItems.size ? `(${dsQueueItems.size})` : '';
}

function renderDsQueue(items) {
  dsQueueItems.clear();
  dsQueueList.replaceChildren();
  for (const item of items) {
    const node = el('div', 'queue-item', `#${item.id} ${item.text}`);
    node.addEventListener('click', () => openDetailModal(item));
    dsQueueList.appendChild(node);
    dsQueueItems.set(item.id, node);
  }
  updateDsQueueCount();
}

function removeFromDsQueue(id) {
  const node = dsQueueItems.get(id);
  if (!node) return;
  node.remove();
  dsQueueItems.delete(id);
  updateDsQueueCount();
}

const dsInflightGrid = document.getElementById('ds-inflight');
const dsInflightCount = document.getElementById('ds-inflight-count');
const dsInflightCards = new Map();

function addDsInflight(item) {
  const card = el('div', 'inflight-card');
  const text = el('div', 'inflight-text', item.text);
  const timer = el('div', 'inflight-timer', '0ms');
  card.append(text, timer);
  card.addEventListener('click', () => openDetailModal(item));
  dsInflightGrid.appendChild(card);

  const startedAt = performance.now();
  const intervalId = setInterval(() => {
    timer.textContent = `${Math.round(performance.now() - startedAt)}ms`;
  }, 60);

  dsInflightCards.set(item.id, { node: card, intervalId });
  dsInflightCount.textContent = `(${dsInflightCards.size})`;
}

function removeDsInflight(id) {
  const entry = dsInflightCards.get(id);
  if (!entry) return;
  clearInterval(entry.intervalId);
  entry.node.remove();
  dsInflightCards.delete(id);
  dsInflightCount.textContent = dsInflightCards.size ? `(${dsInflightCards.size})` : '';
}

function clearAllDsInflight() {
  for (const entry of dsInflightCards.values()) clearInterval(entry.intervalId);
  dsInflightCards.clear();
  dsInflightGrid.replaceChildren();
  dsInflightCount.textContent = '';
}

// ---- Stats ----

const statProcessed = document.getElementById('stat-processed');
const statElapsed = document.getElementById('stat-elapsed');
const statThroughput = document.getElementById('stat-throughput');
const statAvgLatency = document.getElementById('stat-avg-latency');
const statCost = document.getElementById('stat-cost');
const startBtn = document.getElementById('start-btn');
const newBatchBtn = document.getElementById('new-batch-btn');
const batchRaceToggle = document.getElementById('batch-race-toggle');
const batchRaceOptions = document.getElementById('batch-race-options');
const batchRaceReasoning = document.getElementById('batch-race-reasoning');
const batchRaceConcise = document.getElementById('batch-race-concise');
const errorsBox = document.getElementById('errors');

// Engine tabs (Jev / DeepSeek) - only shown while racing, so each engine gets
// its own board and its own metrics instead of DeepSeek's answers being
// squeezed into Jev's cards.
const engineTabs = document.getElementById('engine-tabs');
const tabBtnJev = document.getElementById('tab-btn-jev');
const tabBtnDeepseek = document.getElementById('tab-btn-deepseek');
const tabJevCount = document.getElementById('tab-jev-count');
const tabDsCount = document.getElementById('tab-ds-count');
const tabDsPulse = document.getElementById('tab-ds-pulse');
const jevPanel = document.getElementById('jev-panel');
const deepseekPanel = document.getElementById('deepseek-panel');
const jevProgress = document.getElementById('jev-progress');
const dsProgress = document.getElementById('ds-progress');
const dsStatProcessed = document.getElementById('ds-stat-processed');
const dsStatElapsed = document.getElementById('ds-stat-elapsed');
const dsStatThroughput = document.getElementById('ds-stat-throughput');
const dsStatAvgLatency = document.getElementById('ds-stat-avg-latency');
const dsStatCost = document.getElementById('ds-stat-cost');
const dsStatAuto = document.getElementById('ds-stat-auto');
const dsStatAgreement = document.getElementById('ds-stat-agreement');

function setActiveTab(tab) {
  const jev = tab === 'jev';
  tabBtnJev.classList.toggle('active', jev);
  tabBtnDeepseek.classList.toggle('active', !jev);
  jevPanel.hidden = !jev;
  deepseekPanel.hidden = jev;
}
tabBtnJev.addEventListener('click', () => setActiveTab('jev'));
tabBtnDeepseek.addEventListener('click', () => setActiveTab('deepseek'));

// ---- Race chart (Jev % done vs DeepSeek % done, over elapsed time) ----

const raceChartWrap = document.getElementById('race-chart-wrap');
const raceChartCanvas = document.getElementById('race-chart');
const raceChartCtx = raceChartCanvas.getContext('2d');
let raceChartStartedAt = 0;
let jevChartPoints = [];
let dsChartPoints = [];

function resetRaceChart() {
  raceChartStartedAt = performance.now();
  jevChartPoints = [[0, 0]];
  dsChartPoints = [[0, 0]];
  drawRaceChart();
}

function pushChartPoint(series, pct) {
  series.push([(performance.now() - raceChartStartedAt) / 1000, pct]);
  drawRaceChart();
}

function drawRaceChart() {
  const w = raceChartCanvas.width;
  const h = raceChartCanvas.height;
  const ctx = raceChartCtx;
  ctx.clearRect(0, 0, w, h);

  const pad = 28;
  const maxT = Math.max(1, jevChartPoints.at(-1)[0], dsChartPoints.at(-1)[0]) * 1.05;
  const sx = (t) => pad + (t / maxT) * (w - pad * 1.5);
  const sy = (pct) => h - pad - (pct / 100) * (h - pad * 1.5);

  ctx.strokeStyle = 'rgba(139,147,167,0.15)';
  ctx.fillStyle = 'rgba(139,147,167,0.6)';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (const pct of [0, 25, 50, 75, 100]) {
    const y = sy(pct);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad * 0.5, y);
    ctx.stroke();
    ctx.fillText(`${pct}%`, 2, y + 3);
  }

  function drawSeries(points, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach(([t, pct], i) => {
      const x = sx(t);
      const y = sy(pct);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const [lastT, lastPct] = points.at(-1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx(lastT), sy(lastPct), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawSeries(jevChartPoints, '#5eead4');
  drawSeries(dsChartPoints, '#c084fc');
}

let latencySum = 0;
let latencyCount = 0;
let dsSampleTotal = 0;
let dsSampleCompleted = 0;
let dsAgreeCount = 0;
let dsLatencySum = 0;
let dsLatencyCount = 0;
let dsCostSum = 0;
let dsAutoCount = 0; // "auto-resolved" proxy: answer parsed into a known category (see tile tooltip)

batchRaceToggle.addEventListener('change', () => {
  batchRaceOptions.hidden = !batchRaceToggle.checked;
});

function updateDsStats() {
  dsStatProcessed.textContent = `${dsSampleCompleted}/${dsSampleTotal}`;
  const elapsedS = (performance.now() - raceChartStartedAt) / 1000;
  dsStatElapsed.textContent = `${elapsedS.toFixed(1)}s`;
  dsStatThroughput.textContent = `${(dsSampleCompleted / Math.max(elapsedS, 0.001)).toFixed(1)}/s`;
  dsStatAvgLatency.textContent = dsLatencyCount ? `${Math.round(dsLatencySum / dsLatencyCount)} ms` : '-- ms';
  dsStatCost.textContent = `$${dsCostSum.toFixed(4)}`;
  dsStatAuto.textContent = `${dsAutoCount}/${dsSampleCompleted}`;
  const pct = dsSampleCompleted ? Math.round((dsAgreeCount / dsSampleCompleted) * 100) : 0;
  dsStatAgreement.textContent = dsSampleCompleted ? `${pct}%` : '--';
  tabDsCount.textContent = `${dsSampleCompleted}/${dsSampleTotal}`;
  tabDsPulse.hidden = dsSampleTotal === 0 || dsSampleCompleted >= dsSampleTotal;
}

function resetBoard() {
  for (const cat of SCENARIO.categories) {
    columnCardsByCategory[cat.key].replaceChildren();
    columnCountByCategory[cat.key].textContent = '0';
    columnWorkloadByCategory[cat.key].textContent = '';
    agentCountsByCategory[cat.key] = new Map();
  }
  buildDsBoard(SCENARIO.categories);
  errorsBox.hidden = true;
  errorsBox.replaceChildren();
  clearAllInflight();
  clearAllDsInflight();
  renderQueue(ALL_ITEMS);
  renderDsQueue([]);
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
  dsLatencySum = 0;
  dsLatencyCount = 0;
  dsCostSum = 0;
  dsAutoCount = 0;
  statProcessed.textContent = `0/${ALL_ITEMS.length}`;
  statElapsed.textContent = '0.0s';
  statThroughput.textContent = '0.0/s';
  statAvgLatency.textContent = '-- ms';
  statCost.textContent = '$0.0000';
  tabJevCount.textContent = `0/${ALL_ITEMS.length}`;
  tabDsCount.textContent = '';
  tabDsPulse.hidden = true;
  jevProgress.hidden = true;
  dsProgress.hidden = true;
  updateAutoStat();
  updateDsStats();
  resetRaceChart();
}

function updateStats(msg) {
  statProcessed.textContent = `${msg.completed}/${msg.total}`;
  tabJevCount.textContent = `${msg.completed}/${msg.total}`;
  jevProgress.hidden = msg.completed >= msg.total;
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
  pushChartPoint(jevChartPoints, (msg.completed / msg.total) * 100);
}

startBtn.addEventListener('click', () => {
  resetBoard();
  const racing = batchRaceToggle.checked;
  engineTabs.hidden = !racing;
  raceChartWrap.hidden = !racing;
  jevPanel.classList.toggle('tabbed', racing);
  deepseekPanel.classList.toggle('tabbed', racing);
  setActiveTab('jev');
  if (racing) jevProgress.hidden = false;

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
    dsProgress.hidden = false;
    const sampleItems = msg.ids.map((id) => ALL_ITEMS.find((i) => i.id === id)).filter(Boolean);
    renderDsQueue(sampleItems);
    updateDsStats();
  });

  source.addEventListener('deepseek-dispatch', (e) => {
    const item = JSON.parse(e.data);
    removeFromDsQueue(item.id);
    addDsInflight(item);
  });

  source.addEventListener('deepseek-item-done', (e) => {
    const msg = JSON.parse(e.data);
    removeDsInflight(msg.id);
    dsSampleCompleted = msg.completed;
    const jevResult = resultsById.get(msg.id);
    const ok = !msg.timed_out && !msg.error;
    if (ok) {
      dsLatencySum += msg.latency_ms;
      dsLatencyCount += 1;
      if (typeof msg.cost === 'number') dsCostSum += msg.cost;
      if (parseDeepseekCategory(msg.answer)) dsAutoCount++;
    }
    if (jevResult && ok && deepseekAgrees(msg.answer, jevResult.category)) dsAgreeCount++;
    updateDsStats();
    storeDeepseekResult(msg.id, msg);
    appendDsCard(ALL_ITEMS.find((i) => i.id === msg.id), msg);
    pushChartPoint(dsChartPoints, (msg.completed / msg.total) * 100);
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
    clearAllDsInflight();
    jevProgress.hidden = true;
    dsProgress.hidden = true;
    tabDsPulse.hidden = true;
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
      clearAllDsInflight();
      jevProgress.hidden = true;
      dsProgress.hidden = true;
      tabDsPulse.hidden = true;
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
  buildDsBoard(SCENARIO.categories);
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
      if (liveJevResult.id) storeDeepseekResult(liveJevResult.id, result);
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
  buildDsBoard(SCENARIO.categories);

  await Promise.all([loadItems(), loadActions()]);
  renderQueue(ALL_ITEMS);
  statProcessed.textContent = `0/${ALL_ITEMS.length}`;
  tabJevCount.textContent = `0/${ALL_ITEMS.length}`;
  updateAutoStat();
})();
