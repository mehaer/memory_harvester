// Background service worker

const CHATGPT_URL = 'https://chatgpt.com/';

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  running: false,
  tabId: null,
  currentBatchIndex: 0,
  results: [], // { batchIndex, personaName, promptIndex, prompt, reply, timestamp }
};

// ── Tab helpers ──────────────────────────────────────────────────────────────

async function ensureChatGPTTab() {
  if (state.tabId) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && isChatGPTUrl(tab.url)) {
        await chrome.tabs.update(state.tabId, { active: true });
        return state.tabId;
      }
    } catch (_) {}
  }

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url && isChatGPTUrl(t.url));
  if (existing) {
    state.tabId = existing.id;
    await chrome.tabs.update(state.tabId, { active: true });
    return state.tabId;
  }

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
        setTimeout(resolve, 1000);
      }
    });
  });
}

// ── Messaging helpers ────────────────────────────────────────────────────────

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

async function ensureContentScript() {
  log('Pinging content script…');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sendToContent(state.tabId, { action: 'PING' });
      log('Content script ready.');
      return;
    } catch (e) {
      log(`Ping attempt ${attempt + 1} failed: ${e.message}`);
      try {
        await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ['content.js'] });
        log('Content script re-injected.');
      } catch (injectErr) {
        log(`Re-inject failed: ${injectErr.message}`);
      }
      await sleep(1000);
    }
  }
  log('Warning: content script may not be ready — proceeding anyway.');
}

async function runBatch(batch, batchIndex, personaName, config) {
  const { messagesPerChat, delayBetweenMessages, delayBetweenChats } = config;
  let promptsInCurrentChat = 0;

  for (let pi = 0; pi < batch.prompts.length; pi++) {
    if (!state.running) { log('Stopped by user.'); break; }

    // Open a new chat within the same project every messagesPerChat prompts
    if (promptsInCurrentChat > 0 && promptsInCurrentChat % messagesPerChat === 0) {
      log(`${messagesPerChat} messages sent — opening new chat in "${personaName}"…`);
      try {
        await sendToContent(state.tabId, { action: 'OPEN_PROJECT_NEW_CHAT', name: personaName });
      } catch (e) {
        log(`Opening new chat in "${personaName}" failed: ${e.message}`);
      }
      await sleep(delayBetweenChats);
    }

    const prompt = batch.prompts[pi];
    log(`${personaName}, prompt ${pi + 1}/${batch.prompts.length}: ${prompt.slice(0, 60)}…`);

    try {
      const res = await sendToContent(state.tabId, { action: 'SEND_MESSAGE', text: prompt });
      state.results.push({ batchIndex, personaName, promptIndex: pi, prompt, reply: res.reply, timestamp: Date.now() });
      log(`${personaName}, prompt ${pi + 1} — reply received.`);
    } catch (e) {
      log(`${personaName}, prompt ${pi + 1} — SEND_MESSAGE failed: ${e.message}`);
    }

    promptsInCurrentChat++;
    if (pi < batch.prompts.length - 1) await sleep(delayBetweenMessages);
  }
}

async function runAllBatches(batches, config) {
  log(`Starting: ${batches.length} batch(es), messagesPerChat=${config.messagesPerChat}`);
  await ensureChatGPTTab();
  await ensureContentScript();

  for (let bi = 0; bi < batches.length; bi++) {
    if (!state.running) break;
    state.currentBatchIndex = bi;
    const personaNumber = config.personaStartIndex + bi;
    const personaName = `Persona #${personaNumber}`;

    log(`── Batch ${bi + 1}/${batches.length}: creating project "${personaName}" ──`);
    try {
      await sendToContent(state.tabId, { action: 'CREATE_PROJECT', name: personaName });
      log(`Project "${personaName}" created.`);
    } catch (e) {
      log(`Project "${personaName}" creation failed: ${e.message} — skipping this batch.`);
      continue;
    }

    await runBatch(batches[bi], bi, personaName, config);
  }

  if (state.running) {
    log('All batches complete.');
    state.running = false;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Serialised log queue — prevents concurrent reads overwriting each other
let logQueue = Promise.resolve();
function log(msg) {
  console.log('[PersonaHarvester]', msg);
  logQueue = logQueue.then(() => new Promise(resolve => {
    chrome.storage.local.get(['personaHarvesterLog'], data => {
      const logs = data.personaHarvesterLog || [];
      logs.push({ msg, ts: Date.now() });
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      chrome.storage.local.set({ personaHarvesterLog: logs }, resolve);
    });
  }));
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'START': {
        if (state.running) { sendResponse({ ok: false, error: 'Already running' }); return; }
        state.running = true;
        state.currentBatchIndex = 0;
        state.results = [];
        sendResponse({ ok: true });
        runAllBatches(msg.batches, msg.config).catch(err => {
          log('Fatal error: ' + err.message);
          state.running = false;
        });
        break;
      }
      case 'STOP': {
        state.running = false;
        sendResponse({ ok: true });
        break;
      }
      case 'GET_RESULTS': {
        sendResponse({ ok: true, results: state.results });
        break;
      }
      case 'CLEAR_RESULTS': {
        state.results = [];
        sendResponse({ ok: true });
        break;
      }
      case 'CONTENT_LOG': {
        log('[content] ' + msg.msg);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({ ok: true, running: state.running, currentBatchIndex: state.currentBatchIndex, resultsCount: state.results.length });
        break;
      }
      case 'GET_LOG': {
        const data = await chrome.storage.local.get(['personaHarvesterLog']);
        sendResponse({ ok: true, log: data.personaHarvesterLog || [] });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true;
});
