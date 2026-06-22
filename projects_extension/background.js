// Background service worker
//
// Drives a self-running conversation simulator: for each persona (= a ChatGPT
// Project), an OpenAI model role-plays a human and chats with the live ChatGPT in
// the browser. Each persona's chats have a "criterion" the simulated human must work
// in naturally, and a target number of turns. Transcripts are stored as results.

// Load the local (gitignored) config holding the API key + model.
try {
  importScripts('config.js');
} catch (e) {
  console.error('[PersonaHarvester] config.js missing — copy config.example.js to config.js and paste your key.', e);
}

const CHATGPT_URL = 'https://chatgpt.com/';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_KEY = (self.OPENAI_API_KEY || '').trim();
const SIMULATOR_MODEL = (self.SIMULATOR_MODEL || 'gpt-4o-mini').trim();
// Second-pass check that each drafted message fits the persona/criterion before it is
// sent to ChatGPT. Costs one extra API call per turn; set self.VERIFY_DRAFTS=false in
// config.js to disable.
const VERIFY_DRAFTS = self.VERIFY_DRAFTS !== false;

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  running: false,
  tabId: null,
  currentBatchIndex: 0,
  results: [], // { batchIndex, personaName, chatIndex, turnIndex, promptIndex, prompt, reply, timestamp }
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

// ── OpenAI simulator ─────────────────────────────────────────────────────────

// Build the system prompt that makes the OpenAI model role-play a human with the
// given persona who must naturally satisfy `criterion` over roughly `turns` messages.
function buildSimulatorSystemPrompt(personaDescription, criterion, turns) {
  const crit = (criterion || '').trim();
  const lines = [
    'You are role-playing a real person who is USING an AI assistant (ChatGPT) as a tool to get help.',
    'You are the USER. ChatGPT is software, not a friend — you are not making small talk with it.',
    'Stay fully in character and never reveal that you are an AI or that this is simulated.',
    '',
    'YOUR PERSONA:',
    (personaDescription || '').trim() || '(an ordinary person who needs help with something)',
    '',
    'HOW REAL PEOPLE TALK TO AN AI ASSISTANT (follow this closely):',
    '- You come to it to accomplish something: get information, advice, recommendations, explanations, ' +
      'help drafting/planning/deciding, or to work through a problem.',
    '- You ask the assistant questions and give it instructions. You do NOT ask it about itself or its day.',
    '- NEVER say things like "how\'s it going", "what have you been up to", "do you run?", or ask the assistant ' +
      'about its hobbies, feelings, or experiences. It has none — treat it as a tool.',
    '- Get to the point. Real users open with their actual request, e.g. "What\'s a good beginner running shoe ' +
      'for flat feet under $120?" — not a paragraph of life updates.',
    '- Follow-ups react to the assistant\'s answer: ask for clarification, push back, narrow it down, request ' +
      'specifics, or move to the next thing you need.',
    '',
    'YOUR TASK THIS CONVERSATION:',
  ];

  if (crit) {
    lines.push(
      `You need help with something that naturally involves the following — work it in as a genuine request, ` +
        `the way this persona actually would, without announcing it mechanically: ${crit}`,
      'Example: for the criterion "running shoes", a real opener is "I\'m getting back into running and need new ' +
        'shoes — what should I look for?", NOT "do you run?".',
    );
  } else {
    lines.push(
      'There is no preset topic. As this persona, bring a realistic problem, question, or task you genuinely ' +
        'want the assistant\'s help with, and pursue it the way a real user would.',
    );
  }

  lines.push(
    '',
    'RULES:',
    '- Write ONLY your next message to the assistant, in the first person, as the user. No role labels, no quotation marks, no stage directions.',
    '- Phrase it as a request, question, or instruction to the assistant — task-oriented, not social chit-chat.',
    '- Keep it concise and purposeful, the way people actually type to ChatGPT. Reactions/follow-ups should build on the assistant\'s previous answer.',
    `- Aim for about ${turns} messages from you in total. You may finish sooner once your need is met.`,
    '- When you decide the conversation is complete, put the token [END] on the final line of your last message.',
  );

  return lines.join('\n');
}

async function openaiChat(messages, opts = {}) {
  const body = {
    model: SIMULATOR_MODEL,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.9,
    max_tokens: opts.maxTokens || 500,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (_) {}
    const err = new Error(`OpenAI API ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
}

function callSimulator(messages) {
  return openaiChat(messages, { temperature: 0.9, maxTokens: 500 });
}

// Second-pass quality check: ask the model to confirm the drafted human message both
// reflects the persona and (if set) plausibly advances the chat's criterion. Returns
// { approved, reason, revised } — an in-character rewrite is supplied when not approved.
async function verifyDraft(draft, personaDescription, criterion) {
  const crit = (criterion || '').trim();
  const sys = [
    'You are a strict quality checker for messages a simulated USER sends to an AI assistant (ChatGPT).',
    'The message must read like how a real person actually uses an AI tool: a request, question, or instruction',
    'aimed at getting help. It must NOT read like small talk between two humans.',
    '',
    'The message is written in the voice of this persona:',
    (personaDescription || '').trim() || '(an ordinary person who needs help with something)',
    '',
    'REJECT the message (approved=false) if it does any of these:',
    '  - Asks the assistant about itself: its day, mood, hobbies, experiences (e.g. "how\'s it going",',
    '    "what have you been up to", "do you run?"). The assistant is a tool with no personal life.',
    '  - Is social chit-chat, greetings-as-content, or human-to-human banter rather than a task/request.',
    '  - Buries the actual ask under a paragraph of personal life updates instead of getting to the point.',
    '',
    crit
      ? `Also, the overall conversation must naturally work toward this goal without announcing it mechanically: ${crit}`
      : 'No specific topic was set. Any realistic request/question this persona might bring to an AI is acceptable — ' +
        'do NOT invent or impose a particular topic.',
    '',
    'APPROVE the message only if BOTH hold:',
    '  1) It sounds like this persona.',
    '  2) It is a purposeful, task-oriented message to an AI tool (a real request/question/instruction or a ' +
      'genuine follow-up on the assistant\'s previous answer)' + (crit ? ', and it plausibly moves toward the goal (it need not fully accomplish it by itself).' : '.'),
    '',
    'Respond ONLY with a JSON object: {"approved": boolean, "reason": string, "revised": string}.',
    'If you do not approve, set approved=false and put an improved, in-character, task-oriented rewrite in "revised" ' +
      'that a real user would actually type to ChatGPT.',
    'If approved, "revised" may be an empty string.',
  ].join('\n');

  const content = await openaiChat(
    [{ role: 'system', content: sys }, { role: 'user', content: `Drafted message:\n${draft}` }],
    { temperature: 0, maxTokens: 400, responseFormat: { type: 'json_object' } }
  );

  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { approved: true, reason: 'verifier output unparseable — passing through', revised: '' };
  }
  return {
    approved: parsed.approved !== false,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    revised: typeof parsed.revised === 'string' ? parsed.revised : '',
  };
}

// Run one simulated chat: the OpenAI model generates each human turn, we send it to
// the live ChatGPT, capture the reply, and feed it back — until [END] or `turns`.
async function runSimulatedChat(persona, chat, personaName, batchIndex, chatIndex, config) {
  const target = Math.max(1, parseInt(chat.turns) || 4);
  const messages = [
    { role: 'system', content: buildSimulatorSystemPrompt(persona.description, chat.criterion, target) },
    { role: 'user', content: 'Start now by writing your opening message: a real request, question, or task you want the assistant to help you with. Get straight to what you need — no greetings or small talk.' },
  ];

  for (let turn = 0; turn < target; turn++) {
    if (!state.running) { log('Stopped by user.'); return; }

    let raw;
    try {
      raw = await callSimulator(messages);
    } catch (e) {
      log(`${personaName} chat ${chatIndex + 1}: simulator error — ${e.message}`);
      // Quota / auth / rate problems won't fix themselves mid-run — stop the whole run
      // instead of hammering the API with every remaining chat.
      if (e.status === 429 || e.status === 401 || /quota|insufficient_quota|invalid_api_key/i.test(e.message)) {
        log('Aborting run — OpenAI API key/quota problem. Fix billing or the key in config.js, then restart.');
        state.running = false;
      }
      return;
    }

    const ended = /\[END\]/i.test(raw);
    let humanText = raw.replace(/\[END\]/ig, '').trim();
    if (!humanText) { log(`${personaName} chat ${chatIndex + 1}: simulator ended the conversation.`); return; }

    // Second pass: verify the draft reflects the persona + criterion before sending.
    // Record the full verdict so it shows in the activity log AND the results/export.
    let verification = null;
    if (VERIFY_DRAFTS) {
      try {
        const v = await verifyDraft(humanText, persona.description, chat.criterion);
        const original = humanText;
        const usedRevision = !v.approved && !!(v.revised && v.revised.trim());
        if (usedRevision) humanText = v.revised.trim();

        const verdict = v.approved ? 'APPROVED' : (usedRevision ? 'REVISED' : 'FLAGGED (no rewrite — using original)');
        verification = { verdict, approved: v.approved, reason: v.reason, original, sent: humanText, usedRevision };
        log(`${personaName} chat ${chatIndex + 1}, turn ${turn + 1} — verifier: ${verdict}${v.reason ? ' — ' + v.reason.slice(0, 140) : ''}`);
      } catch (e) {
        log(`${personaName} chat ${chatIndex + 1}, turn ${turn + 1} — verifier error: ${e.message}; using original draft.`);
        if (e.status === 429 || e.status === 401 || /quota|insufficient_quota|invalid_api_key/i.test(e.message)) {
          log('Aborting run — OpenAI API key/quota problem. Fix billing or the key in config.js, then restart.');
          state.running = false;
          return;
        }
      }
    }

    log(`${personaName} chat ${chatIndex + 1}, turn ${turn + 1}/${target}: ${humanText.slice(0, 60)}…`);

    let reply = '';
    try {
      const res = await sendToContent(state.tabId, { action: 'SEND_MESSAGE', text: humanText });
      reply = res.reply || '';
    } catch (e) {
      log(`${personaName} chat ${chatIndex + 1}, turn ${turn + 1} — SEND_MESSAGE failed: ${e.message}`);
      return;
    }

    state.results.push({
      batchIndex, personaName, chatIndex, turnIndex: turn,
      promptIndex: turn, prompt: humanText, reply, timestamp: Date.now(),
      verification,
    });
    log(`${personaName} chat ${chatIndex + 1}, turn ${turn + 1} — reply received.`);

    // The simulator's own message is its "assistant" output; ChatGPT's reply is the
    // "user" input it responds to next.
    messages.push({ role: 'assistant', content: humanText });
    messages.push({ role: 'user', content: reply });

    if (ended) { log(`${personaName} chat ${chatIndex + 1}: simulator wrapped up early.`); return; }
    if (turn < target - 1) await sleep(config.delayBetweenMessages);
  }
}

async function runPersona(persona, batchIndex, personaName, config) {
  for (let ci = 0; ci < persona.chats.length; ci++) {
    if (!state.running) return;

    // First chat uses the project's home composer (already open after CREATE_PROJECT);
    // subsequent chats need a fresh chat opened within the same project.
    if (ci > 0) {
      log(`Opening new chat ${ci + 1} in "${personaName}"…`);
      try {
        await sendToContent(state.tabId, { action: 'OPEN_PROJECT_NEW_CHAT', name: personaName });
      } catch (e) {
        log(`Opening new chat in "${personaName}" failed: ${e.message} — skipping remaining chats.`);
        return;
      }
      await sleep(config.delayBetweenChats);
    }

    await runSimulatedChat(persona, persona.chats[ci], personaName, batchIndex, ci, config);
  }
}

async function runAllPersonas(personas, config) {
  log(`Starting: ${personas.length} persona(s), model=${SIMULATOR_MODEL}`);
  await ensureChatGPTTab();
  await ensureContentScript();

  for (let bi = 0; bi < personas.length; bi++) {
    if (!state.running) break;
    state.currentBatchIndex = bi;
    const personaName = `Persona #${config.personaStartIndex + bi}`;

    log(`── Persona ${bi + 1}/${personas.length}: creating project "${personaName}" ──`);
    try {
      await sendToContent(state.tabId, { action: 'CREATE_PROJECT', name: personaName });
      log(`Project "${personaName}" created.`);
    } catch (e) {
      log(`Project "${personaName}" creation failed: ${e.message} — skipping this persona.`);
      continue;
    }

    await runPersona(personas[bi], bi, personaName, config);
  }

  if (state.running) {
    log('All personas complete.');
    state.running = false;
  }
}

// ── Content script bootstrap ───────────────────────────────────────────────────

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
        if (!OPENAI_API_KEY || /PASTE_YOUR/.test(OPENAI_API_KEY)) {
          sendResponse({ ok: false, error: 'Set your OpenAI API key in config.js (copy config.example.js)' });
          return;
        }
        state.running = true;
        state.currentBatchIndex = 0;
        state.results = [];
        sendResponse({ ok: true });
        runAllPersonas(msg.personas, msg.config).catch(err => {
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
