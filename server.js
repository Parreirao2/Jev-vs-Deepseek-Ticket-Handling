const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { SCENARIOS, DEFAULT_SCENARIO } = require('./lib/scenarios');

const PORT = process.env.PORT || 5173;
const CONCURRENCY = 25;
const DEEPSEEK_BATCH_CONCURRENCY = 4; // DeepSeek calls are heavy CLI spawns - keep this far below Jev's CONCURRENCY
const DEEPSEEK_BATCH_SAMPLE_DEFAULT = 18;
const FALLBACK_COST_PER_CALL = 0.000034; // used only if the API response omits usage.cost
const DEEPSEEK_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEEPSEEK_TIMEOUT_MS = 45000;
const ACTION_CONFIDENCE_THRESHOLD = 0.5; // below this, per the Jev skill's confidence gating, don't trust the pick

// Falls back to a local credentials file if present, but each browser can also supply
// its own OpenRouter/OpenCode keys via the settings drawer (see /api/classify, /api/stream,
// /api/race) so the demo works plug-and-play for anyone without server-side setup.
const credPath = path.join(process.env.LOCALAPPDATA || os.homedir(), 'jev', 'credentials.json');
const DEFAULT_JEV_KEY = fs.existsSync(credPath)
  ? JSON.parse(fs.readFileSync(credPath, 'utf8')).openrouter_api_key
  : null;

const DATA_DIR = path.join(__dirname, 'data');
const dataPath = (key) => path.join(DATA_DIR, `${key}.json`);

function loadOrGenerate(key) {
  const p = dataPath(key);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const items = SCENARIOS[key].generate(150);
  fs.writeFileSync(p, JSON.stringify(items, null, 2));
  return items;
}

function buildQuestions(scenario, actions) {
  return {
    category: {
      type: 'choice',
      instructions: scenario.categoryQuestion.instructions,
      criteria: Object.fromEntries(scenario.categories.map((c) => [c.key, c.criteria])),
    },
    severity: {
      type: 'score',
      instructions: scenario.severityQuestion.instructions,
      criteria: scenario.severityQuestion.criteria,
    },
    needs_human: {
      type: 'noul',
      instructions: scenario.humanQuestion.instructions,
    },
    action: {
      type: 'choice',
      instructions: scenario.actionQuestion.instructions,
      criteria: {
        ...Object.fromEntries(actions.map((a) => [a.key, a.criteria])),
        none: scenario.actionQuestion.noneCriteria,
      },
    },
  };
}

// Actions start from each scenario's static defaults but can grow at runtime
// via POST /api/actions, so a presenter can add a new canned reply live and
// have Jev start picking it on the very next classify call.
const liveActions = {};
function getActions(key) {
  if (!liveActions[key]) liveActions[key] = SCENARIOS[key].actions.slice();
  return liveActions[key];
}

function slugify(label) {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'action';
}

function uniqueActionKey(label, actions) {
  const base = slugify(label);
  if (base === 'none' || !actions.some((a) => a.key === base)) return base === 'none' ? `${base}_2` : base;
  let n = 2;
  while (actions.some((a) => a.key === `${base}_${n}`)) n++;
  return `${base}_${n}`;
}

let activeKey = DEFAULT_SCENARIO;
let scenario = SCENARIOS[activeKey];
let QUESTIONS = buildQuestions(scenario, getActions(activeKey));
let ITEMS = loadOrGenerate(activeKey);
let agentCounters = {};

function switchScenario(key) {
  activeKey = key;
  scenario = SCENARIOS[activeKey];
  QUESTIONS = buildQuestions(scenario, getActions(activeKey));
  ITEMS = loadOrGenerate(activeKey);
  agentCounters = {};
}

function publicScenario(s) {
  return {
    key: s.key,
    label: s.label,
    description: s.description,
    itemNoun: s.itemNoun,
    inputPlaceholder: s.inputPlaceholder,
    categories: s.categories.map((c) => ({ key: c.key, label: c.label, color: c.color })),
    severityLabel: s.severityQuestion.label,
    severityLevels: s.severityQuestion.criteria,
    humanLabel: s.humanQuestion.label,
    actionLabel: s.actionQuestion.label,
    agentNoun: s.agentNoun,
  };
}

async function classifyItem(text, jevKey) {
  const key = jevKey || DEFAULT_JEV_KEY;
  if (!key) throw new Error('No OpenRouter API key. Enter one in Settings, or set up credentials.json on the server.');
  const start = Date.now();
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: '~typesafe/jev-latest', state: text, questions: QUESTIONS }),
  });
  const latency_ms = Date.now() - start;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Jev call failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return { latency_ms, data };
}

// Runs DeepSeek V4.1 Flash via the local `opencode` CLI (OpenCode Go provider) on
// the same classification task Jev just did, for the live speed-comparison race.
// Must use `spawn` (not `execFile`) with stdin explicitly closed — otherwise the
// CLI hangs indefinitely waiting on a TTY prompt that never arrives headlessly.
// `dsKey`, if provided, overrides the OpenCode CLI's globally logged-in credentials for
// just this one process via OPENCODE_API_KEY - the env var the OpenCode Go provider's own
// catalog declares for auth, so per-request keys never touch the CLI's shared auth.json.
function runDeepSeek(text, { reasoning, concise }, scenario, dsKey) {
  return new Promise((resolve) => {
    // Embedded newlines in a shell argument get mangled by cmd.exe's command-line
    // parsing on Windows, so the whole prompt (and the ticket text) must stay single-line.
    const flatten = (s) => s.replace(/\s*\n+\s*/g, ' ').trim();
    const categoryList = scenario.categories.map((c) => c.key).join(', ');
    const instruction = concise
      ? 'Reply with ONLY the single category word, nothing else - no punctuation, no explanation.'
      : 'Briefly explain your reasoning in one short sentence, then state just the category word at the end.';
    const prompt = `Classify the following ${scenario.itemNoun.singular} into exactly one of these categories: ${categoryList}. ${instruction} ${scenario.itemNoun.singular}: ${flatten(text)}`;

    const args = ['run', '--model', DEEPSEEK_MODEL, '--variant', reasoning ? 'high' : 'minimal', prompt];
    const start = Date.now();
    const env = dsKey ? { ...process.env, OPENCODE_API_KEY: dsKey } : process.env;
    const child = spawn('opencode', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    const killTimer = setTimeout(() => child.kill(), DEEPSEEK_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const latency_ms = Date.now() - start;
      if (code !== 0 && !out.trim()) {
        resolve({
          latency_ms,
          answer: null,
          timed_out: latency_ms >= DEEPSEEK_TIMEOUT_MS - 1000,
          error: err.trim().slice(0, 300) || `exited with code ${code}`,
        });
        return;
      }
      resolve({ latency_ms, answer: out.trim(), timed_out: false, error: null });
    });

    child.on('error', (spawnErr) => {
      clearTimeout(killTimer);
      resolve({ latency_ms: Date.now() - start, answer: null, timed_out: false, error: String(spawnErr.message || spawnErr) });
    });
  });
}

function handleRace(req, res, url) {
  const text = (url.searchParams.get('text') || '').trim();
  const reasoning = url.searchParams.get('reasoning') === 'on';
  const concise = url.searchParams.get('concise') !== 'off';
  const jevKey = url.searchParams.get('jevKey') || '';
  const dsKey = url.searchParams.get('dsKey') || '';

  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'text is required' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { text, reasoning, concise });

  const jevDone = classifyItem(text, jevKey)
    .then(({ latency_ms, data }) => {
      send('jev-done', { ...toResult({ id: `race-${Date.now()}`, text }, latency_ms, data), cost: estimateCost(data) });
    })
    .catch((err) => send('jev-done', { error: String(err.message || err) }));

  const deepseekDone = runDeepSeek(text, { reasoning, concise }, scenario, dsKey).then((result) => send('deepseek-done', result));

  Promise.all([jevDone, deepseekDone]).then(() => {
    send('race-done', {});
    res.end();
  });
}

function estimateCost(data) {
  if (typeof data?.usage?.cost === 'number') return data.usage.cost;
  return FALLBACK_COST_PER_CALL;
}

function assignAgent(categoryKey) {
  const roster = scenario.agents[categoryKey];
  if (!roster || !roster.length) return null;
  agentCounters[categoryKey] = (agentCounters[categoryKey] || 0) + 1;
  return roster[(agentCounters[categoryKey] - 1) % roster.length];
}

function toResult(item, latency_ms, data) {
  const answers = data.answers;
  const actionConfident = answers.action.confidence >= ACTION_CONFIDENCE_THRESHOLD;
  const actionChoice = answers.action.choice;
  const severityIdx = Math.max(0, Math.min(scenario.slaHoursBySeverity.length - 1, Math.round(answers.severity.score)));
  const slaHours = scenario.slaHoursBySeverity[severityIdx];

  return {
    id: item.id,
    text: item.text,
    category: answers.category.choice,
    category_confidence: answers.category.confidence,
    category_probabilities: answers.category.probabilities,
    severity: answers.severity.score,
    severity_confidence: answers.severity.confidence,
    severity_probabilities: answers.severity.probabilities,
    severity_legend: answers.severity.legend,
    needs_human: answers.needs_human.noul,
    action: actionConfident && actionChoice !== 'none' ? actionChoice : null,
    action_confidence: answers.action.confidence,
    action_probabilities: answers.action.probabilities,
    agent: assignAgent(answers.category.choice),
    sla_due_at: new Date(Date.now() + slaHours * 3600 * 1000).toISOString(),
    latency_ms,
  };
}

function handleBatchStream(req, res, url) {
  const raceOn = url.searchParams.get('race') === 'on';
  const raceSampleSize = Math.max(1, Math.min(50, parseInt(url.searchParams.get('raceSample'), 10) || DEEPSEEK_BATCH_SAMPLE_DEFAULT));
  const reasoning = url.searchParams.get('reasoning') === 'on';
  const concise = url.searchParams.get('concise') !== 'off';
  const jevKey = url.searchParams.get('jevKey') || '';
  const dsKey = url.searchParams.get('dsKey') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const items = ITEMS;
  const total = items.length;
  let completed = 0;
  let costTotal = 0;
  let stopped = false;
  const startAll = Date.now();
  let idx = 0;

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  async function jevWorker() {
    while (!stopped && idx < items.length) {
      const item = items[idx++];
      send('dispatch', { id: item.id, text: item.text });
      try {
        const { latency_ms, data } = await classifyItem(item.text, jevKey);
        costTotal += estimateCost(data);
        completed++;
        send('result', {
          ...toResult(item, latency_ms, data),
          completed,
          total,
          elapsed_ms: Date.now() - startAll,
          cost_estimate_running: costTotal,
        });
      } catch (err) {
        completed++;
        send('error', { id: item.id, message: String(err.message || err), completed, total });
      }
    }
  }

  const jevDone = Promise.all(Array.from({ length: CONCURRENCY }, jevWorker));

  let deepseekDone = Promise.resolve();
  if (raceOn) {
    const sample = [...items].sort(() => Math.random() - 0.5).slice(0, Math.min(raceSampleSize, items.length));
    send('race-sample', { ids: sample.map((it) => it.id), total: sample.length });

    let dsCompleted = 0;
    let dsIdx = 0;
    async function deepseekWorker() {
      while (!stopped && dsIdx < sample.length) {
        const item = sample[dsIdx++];
        const result = await runDeepSeek(item.text, { reasoning, concise }, scenario, dsKey);
        dsCompleted++;
        send('deepseek-item-done', { id: item.id, ...result, completed: dsCompleted, total: sample.length });
      }
    }
    deepseekDone = Promise.all(Array.from({ length: DEEPSEEK_BATCH_CONCURRENCY }, deepseekWorker));
  }

  Promise.all([jevDone, deepseekDone]).then(() => {
    if (!stopped) {
      send('done', { total, elapsed_ms: Date.now() - startAll, cost_estimate: costTotal });
      res.end();
    }
  });

  req.on('close', () => {
    stopped = true;
  });
}

function handleLiveClassify(req, res) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    try {
      const { text } = JSON.parse(body || '{}');
      if (!text || !text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text is required' }));
        return;
      }
      const trimmed = text.trim();
      const jevKey = req.headers['x-jev-key'] || '';
      const { latency_ms, data } = await classifyItem(trimmed, jevKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(toResult({ id: `live-${Date.now()}`, text: trimmed }, latency_ms, data)));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/scenarios') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenarios: Object.values(SCENARIOS).map(publicScenario), active: activeKey }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/scenario') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicScenario(scenario)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/scenario') {
    readJsonBody(req)
      .then(({ key }) => {
        if (!SCENARIOS[key]) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown scenario "${key}"` }));
          return;
        }
        switchScenario(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publicScenario(scenario)));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/actions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ actions: getActions(activeKey) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/actions') {
    readJsonBody(req)
      .then(({ label, criteria, body }) => {
        if (!label?.trim() || !criteria?.trim() || !body?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'label, criteria and body are all required' }));
          return;
        }
        const actions = getActions(activeKey);
        const action = {
          key: uniqueActionKey(label.trim(), actions),
          label: label.trim(),
          criteria: criteria.trim(),
          body: body.trim(),
        };
        actions.push(action);
        QUESTIONS = buildQuestions(scenario, actions);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ action, actions }));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: ITEMS.length, items: ITEMS }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/items/generate') {
    ITEMS = scenario.generate(150);
    fs.writeFileSync(dataPath(activeKey), JSON.stringify(ITEMS, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: ITEMS.length, items: ITEMS }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    handleBatchStream(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/classify') {
    handleLiveClassify(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/race') {
    handleRace(req, res, url);
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Jev Live Triage running at http://localhost:${PORT}`);
});
