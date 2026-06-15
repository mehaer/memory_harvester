// Background service worker — orchestrates batch automation

const CHATGPT_URL = 'https://chatgpt.com/';
const MEMORY_SETTINGS_URL = 'https://chatgpt.com/#settings/Personalization';

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  running: false,
  currentBatchIndex: 0,
  currentPromptIndex: 0,
  tabId: null,
  results: [],      // { batchIndex, promptIndex, prompt, reply, timestamp }
  memoryExtracts: [], // { batchIndex, memories, timestamp }
};

// ── Storage helpers ──────────────────────────────────────────────────────────

async function saveState() {
  await chrome.storage.local.set({ harvesterResults: state.results, harvesterMemory: state.memoryExtracts });
}

async function loadPersistedData() {
  const data = await chrome.storage.local.get(['harvesterResults', 'harvesterMemory']);
  state.results = data.harvesterResults || [];
  state.memoryExtracts = data.harvesterMemory || [];
}

// ── Tab helpers ──────────────────────────────────────────────────────────────

async function ensureChatGPTTab() {
  // First, check if we already have a tracked tab that's still a ChatGPT tab
  if (state.tabId) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && isChatGPTUrl(tab.url)) {
        await chrome.tabs.update(state.tabId, { active: true });
        return state.tabId;
      }
    } catch (_) {}
  }

  // Look for any existing ChatGPT tab the user already has open
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url && isChatGPTUrl(t.url));
  if (existing) {
    state.tabId = existing.id;
    await chrome.tabs.update(state.tabId, { active: true });
    return state.tabId;
  }

  // No existing tab found — create one
  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: true });
  state.tabId = tab.id;
  await waitForTabLoad(state.tabId);
  return state.tabId;
}

function isChatGPTUrl(url) {
  return url && (url.includes('chatgpt.com') || url.includes('chat.openai.com'));
}

function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeout);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000); // let page JS initialise
      }
    });
  });
}

async function navigateTab(url) {
  await chrome.tabs.update(state.tabId, { url });
  await waitForTabLoad(state.tabId);
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function sendToContent(tabId, msg, retries = 3) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      chrome.tabs.sendMessage(tabId, msg, response => {
        if (chrome.runtime.lastError) {
          if (n > 0) return setTimeout(() => attempt(n - 1), 1500);
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) return reject(new Error('No response from content script'));
        if (!response.ok) return reject(new Error(response.error || 'Content script error'));
        resolve(response);
      });
    }
    attempt(retries);
  });
}

// ── Core automation ──────────────────────────────────────────────────────────

async function runBatch(batch, batchIndex, config) {
  const { delayBetweenMessages } = config;

  for (let pi = state.currentPromptIndex; pi < batch.prompts.length; pi++) {
    if (!state.running) break;

    state.currentPromptIndex = pi;
    broadcastStatus();

    const prompt = batch.prompts[pi];

    log(`Batch ${batchIndex + 1}, prompt ${pi + 1}/${batch.prompts.length}: ${prompt.slice(0, 60)}…`);

    const res = await sendToContent(state.tabId, { action: 'SEND_MESSAGE', text: prompt });

    state.results.push({
      batchIndex,
      promptIndex: pi,
      prompt,
      reply: res.reply,
      timestamp: Date.now(),
    });

    await saveState();
    broadcastStatus();

    if (pi < batch.prompts.length - 1) await sleep(delayBetweenMessages);
  }
}

async function extractAndClearMemory(batchIndex) {
  log('Navigating to memory settings…');
  await navigateTab(MEMORY_SETTINGS_URL);
  await sleep(2000);

  let memories = [];
  try {
    const res = await sendToContent(state.tabId, { action: 'SCRAPE_MEMORY' });
    memories = res.memories || [];
  } catch (e) {
    log('Memory scrape failed: ' + e.message);
  }

  state.memoryExtracts.push({ batchIndex, memories, timestamp: Date.now() });
  log(`Extracted ${memories.length} memory items for batch ${batchIndex + 1}.`);

  try {
    await sendToContent(state.tabId, { action: 'CLEAR_MEMORY' });
    log('Memory cleared.');
  } catch (e) {
    log('Memory clear failed: ' + e.message);
  }

  await saveState();
  broadcastStatus();

  // Return to ChatGPT main page
  await navigateTab(CHATGPT_URL);
  await sleep(1500);
}

async function runAllBatches(batches, config) {
  await loadPersistedData();
  await ensureChatGPTTab();

  // Wait until the content script is ready (retries up to ~15 s)
  let contentReady = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sendToContent(state.tabId, { action: 'PING' });
      contentReady = true;
      break;
    } catch (_) {
      await sleep(3000);
    }
  }
  if (!contentReady) log('Warning: content script may not be ready — proceeding anyway.');

  for (let bi = state.currentBatchIndex; bi < batches.length; bi++) {
    if (!state.running) break;

    state.currentBatchIndex = bi;
    state.currentPromptIndex = 0;
    broadcastStatus();

    log(`Starting batch ${bi + 1}/${batches.length}`);
    await runBatch(batches[bi], bi, config);

    if (!state.running) break;
  }

  if (state.running) {
    log('All batches complete.');
    state.running = false;
    broadcastStatus();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  console.log('[Harvester]', msg);
  chrome.storage.local.get(['harvesterLog'], data => {
    const logs = data.harvesterLog || [];
    logs.push({ msg, ts: Date.now() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    chrome.storage.local.set({ harvesterLog: logs });
  });
}

function broadcastStatus() {
  const status = {
    running: state.running,
    currentBatchIndex: state.currentBatchIndex,
    currentPromptIndex: state.currentPromptIndex,
    resultsCount: state.results.length,
    memoryExtractsCount: state.memoryExtracts.length,
  };
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status }).catch(() => {});
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'START': {
        if (state.running) { sendResponse({ ok: false, error: 'Already running' }); return; }
        state.running = true;
        state.currentBatchIndex = 0;
        state.currentPromptIndex = 0;
        state.results = [];
        state.memoryExtracts = [];
        sendResponse({ ok: true });
        runAllBatches(msg.batches, msg.config).catch(err => {
          log('Fatal error: ' + err.message);
          state.running = false;
          broadcastStatus();
        });
        break;
      }
      case 'STOP': {
        state.running = false;
        sendResponse({ ok: true });
        broadcastStatus();
        break;
      }
      case 'GET_RESULTS': {
        await loadPersistedData();
        sendResponse({ ok: true, results: state.results, memoryExtracts: state.memoryExtracts });
        break;
      }
      case 'CLEAR_RESULTS': {
        state.results = [];
        state.memoryExtracts = [];
        await chrome.storage.local.remove(['harvesterResults', 'harvesterMemory', 'harvesterLog']);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({
          ok: true,
          running: state.running,
          currentBatchIndex: state.currentBatchIndex,
          currentPromptIndex: state.currentPromptIndex,
          resultsCount: state.results.length,
          memoryExtractsCount: state.memoryExtracts.length,
        });
        break;
      }
      case 'GET_LOG': {
        const data = await chrome.storage.local.get(['harvesterLog']);
        sendResponse({ ok: true, log: data.harvesterLog || [] });
        break;
      }
      case 'EXPORT': {
        await loadPersistedData();
        sendResponse({ ok: true, results: state.results, memoryExtracts: state.memoryExtracts });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true;
});
