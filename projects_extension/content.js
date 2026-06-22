// Content script — runs on chatgpt.com
// Drives the ChatGPT Projects UI: create a project per batch (Project-only memory),
// send the batch's prompts, and open new chats within the same project as needed.

if (window.__personaHarvesterLoaded) throw new Error('already loaded');
window.__personaHarvesterLoaded = true;

function bgLog(msg) {
  chrome.runtime.sendMessage({ type: 'CONTENT_LOG', msg }).catch(() => {});
}

const SELECTORS = {
  input: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Send prompt"]',
  stopButton: 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Human-timing simulation ──────────────────────────────────────────────────

let testingMode = false;

// Box-Muller: returns a sample from the standard normal N(0,1)
function gaussianRandom() {
  let u;
  do { u = Math.random(); } while (u === 0); // avoid log(0)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// Log-normal sample with the given mean (ms) and coefficient of variation.
// CV controls spread: CV=0.4 → moderate, CV=0.5 → wider.
// Being log-normal it is always positive and naturally right-skewed — occasional
// longer pauses happen more than shorter ones, just like real human behaviour.
function lognormalMs(meanMs, cv) {
  const sigma2 = Math.log(1 + cv * cv);
  const mu = Math.log(meanMs) - sigma2 / 2;
  return Math.exp(mu + Math.sqrt(sigma2) * gaussianRandom());
}

// Delay before clicking send: simulates the user thinking + typing the message.
// Normal mode: mean = (words / 70 WPM) * 2 minutes (thinking + typing overhead).
// Testing mode: fixed mean of 27 s, capped at 55 s — quick enough to iterate but
// still humanly variable.
function humanTypingDelay(text) {
  if (testingMode) {
    return Math.min(55_000, Math.max(8_000, lognormalMs(27_000, 0.4)));
  }
  const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
  const meanMs = (words / 70) * 2 * 60_000; // minutes → ms
  return Math.max(800, lognormalMs(meanMs, 0.4));
}

// Delay before a button press / UI interaction: mean ~1 s, floored at 300 ms.
// CV=0.5 gives a wider spread — some clicks are quick, some involve a pause.
function humanClickDelay() {
  return Math.max(300, lognormalMs(1000, 0.5));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForElement(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${selector}`));
    }, timeout);
  });
}

function findByText(tagSelector, regex) {
  return [...document.querySelectorAll(tagSelector)].find(el => regex.test((el.textContent || '').trim()));
}

// Dispatch a full, browser-like click sequence. Some React handlers (e.g. project
// cards) respond to pointer/mouse events rather than a bare programmatic .click().
function dispatchRealClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

function waitForCondition(fn, timeout = 8000, interval = 200) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function check() {
      let ok = false;
      try { ok = fn(); } catch (_) {}
      if (ok) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('waitForCondition timed out'));
      setTimeout(check, interval);
    }
    check();
  });
}

function waitForTextEl(tagSelector, regex, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function check() {
      const el = findByText(tagSelector, regex);
      if (el) return resolve(el);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for element matching ${regex}`));
      setTimeout(check, 250);
    }
    check();
  });
}

function waitForResponseComplete(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let streamingStarted = false;
    const initialMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;
    bgLog(`waitForResponseComplete: starting (initialMsgCount=${initialMsgCount})`);

    function check() {
      if (Date.now() - start > timeout) return reject(new Error('Response timeout'));
      const stopBtn = document.querySelector(SELECTORS.stopButton);
      const currentMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

      if ((stopBtn || currentMsgCount > initialMsgCount) && !streamingStarted) {
        streamingStarted = true;
        bgLog(`waitForResponseComplete: streaming started (stopBtn=${!!stopBtn}, msgCount=${currentMsgCount})`);
      }

      if (streamingStarted && !stopBtn) {
        bgLog('waitForResponseComplete: complete, resolving.');
        setTimeout(resolve, 800);
      } else {
        setTimeout(check, 500);
      }
    }
    setTimeout(check, 1500);
  });
}

function getLastAssistantMessage() {
  const messages = document.querySelectorAll(SELECTORS.assistantMessage);
  if (!messages.length) return '';
  const last = messages[messages.length - 1];
  return last.innerText || last.textContent || '';
}

async function sendMessage(text) {
  bgLog('sendMessage: waiting for input element…');
  const input = await waitForElement(SELECTORS.input);
  bgLog(`sendMessage: found input (tag=${input.tagName}, contenteditable=${input.contentEditable})`);
  input.focus();

  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, text);

  const afterExec = (input.innerText || input.value || '').trim();
  bgLog(`sendMessage: after execCommand, text in input="${afterExec.slice(0, 60)}"`);

  if (!afterExec) {
    bgLog('sendMessage: execCommand produced no text, trying fallback…');
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    const afterFallback = (input.innerText || input.value || '').trim();
    bgLog(`sendMessage: after fallback, text in input="${afterFallback.slice(0, 60)}"`);
  }

  // Simulate thinking + typing time before hitting send
  const typingMs = humanTypingDelay(text);
  bgLog(`sendMessage: simulating typing delay ${(typingMs / 1000).toFixed(1)} s…`);
  await sleep(typingMs);

  bgLog('sendMessage: waiting for send button to be enabled…');
  const sendBtn = await waitForEnabledSendButton();
  bgLog('sendMessage: clicking send button.');
  sendBtn.click();
}

function waitForEnabledSendButton(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function check() {
      const btn = document.querySelector(SELECTORS.sendButton)
        || document.querySelector('button[data-testid$="send-button"]')
        || [...document.querySelectorAll('form button, [role="presentation"] button')]
            .find(b => !b.disabled && b.querySelector('svg'));
      if (btn && !btn.disabled) return resolve(btn);
      if (Date.now() > deadline) return reject(new Error('Send button never enabled'));
      setTimeout(check, 200);
    }
    check();
  });
}

// ── Projects UI automation ──────────────────────────────────────────────────

// Step: click "Projects" in the left sidebar, then confirm the Projects list page
// actually loaded (distinctive "New" button + project rows) rather than silently
// staying on whatever page/chat we were already on.
async function openProjectsPanel() {
  bgLog('openProjectsPanel: looking for Projects nav item…');

  // Wait for the sidebar to render and the Projects link to appear.
  // Try the href selector first, then fall back to text matching.
  let projectsLink = null;

  try {
    projectsLink = await waitForElement('a[href="/projects"]', 8000);
    bgLog('openProjectsPanel: found Projects link via href.');
  } catch (_) {}

  if (!projectsLink) {
    bgLog('openProjectsPanel: href selector missed, trying text search…');
    try {
      projectsLink = await waitForTextEl(
        'a, button, div[role="button"], nav li, [class*="nav"] *',
        /^projects$/i,
        8000,
      );
      bgLog('openProjectsPanel: found Projects link via text match.');
    } catch (_) {}
  }

  if (!projectsLink) {
    // Last resort: any element whose text is exactly "Projects"
    projectsLink = [...document.querySelectorAll('*')]
      .find(el => el.children.length === 0 && /^projects$/i.test(el.textContent.trim()));
    if (projectsLink) bgLog('openProjectsPanel: found Projects link via full-DOM leaf search.');
  }

  if (!projectsLink) {
    // Log visible nav links to help diagnose
    const navLinks = [...document.querySelectorAll('nav a, nav button, [class*="sidebar"] a')]
      .map(el => `"${el.textContent.trim()}"`)
      .filter(Boolean)
      .slice(0, 20);
    throw new Error(`Projects nav item not found. Nav items: [${navLinks.join(', ')}]`);
  }

  await sleep(humanClickDelay());
  projectsLink.click();
  await new Promise(r => setTimeout(r, 1000));

  bgLog('openProjectsPanel: confirming Projects list page loaded…');
  await waitForTextEl('h1, h2', /^projects$/i, 8000).catch(() => {
    throw new Error('Clicked Projects but the Projects list page never loaded');
  });
  bgLog('openProjectsPanel: Projects list page confirmed.');
}

// Step: click "New project" to open the create-project popup
async function clickNewProject() {
  bgLog('clickNewProject: looking for New project button…');
  const newBtn = await waitForTextEl('button, a, div[role="button"]', /^new project$|^new$/i);
  await sleep(humanClickDelay());
  newBtn.click();
  await new Promise(r => setTimeout(r, 800));
  bgLog('clickNewProject: clicked New.');
}

// Step: click the gear icon in the create-project modal header to reveal the memory setting
async function openProjectSettingsGear() {
  bgLog('openProjectSettingsGear: looking for gear icon…');
  const dialog = document.querySelector('[role="dialog"]') || document.body;
  const buttons = [...dialog.querySelectorAll('button')];

  let gearBtn = buttons.find(b => /settings/i.test(b.getAttribute('aria-label') || ''))
    || buttons.find(b => b.querySelector('svg path[d*="M"]') && /gear|cog|settings/i.test(b.className));

  if (!gearBtn) {
    // Fallback: the gear is the icon-only button immediately before the "Close" (X) button
    const closeBtn = buttons.find(b => /close/i.test(b.getAttribute('aria-label') || ''));
    if (closeBtn) {
      const idx = buttons.indexOf(closeBtn);
      gearBtn = buttons[idx - 1];
    }
  }

  if (!gearBtn) throw new Error('Project settings gear icon not found');
  await sleep(humanClickDelay());
  gearBtn.click();
  await new Promise(r => setTimeout(r, 500));
  bgLog('openProjectSettingsGear: clicked gear icon.');
}

// Step: in the create-project popup, switch memory from "Default" to "Project-only".
// Clicking the gear opens a "Memory" popover with two selectable rows ("Default" and
// "Project-only") directly visible — no separate dropdown trigger to click first.
async function setProjectOnlyMemory() {
  await openProjectSettingsGear();
  bgLog('setProjectOnlyMemory: looking for "Project-only" option…');

  // Find the leaf node whose own text is exactly "Project-only" (the row heading),
  // not the whole row (which also contains the description paragraph as descendant text).
  const heading = await (async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const found = [...document.querySelectorAll('div, span, p, li, h1, h2, h3, h4')]
        .find(el => el.children.length === 0 && /^project-only$/i.test((el.textContent || '').trim()));
      if (found) return found;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  })();

  if (!heading) throw new Error('Memory option "Project-only" not found');

  await sleep(humanClickDelay());
  heading.click();
  bgLog('setProjectOnlyMemory: clicked "Project-only" option.');
}

// Step: type the project name.
// The "Search projects" box is also an input[type="text"] on this page, so we
// can NOT use a generic input selector — we must find the input that is adjacent
// to the "Project name" label inside the create-project dialog.
async function typeProjectName(name) {
  bgLog('typeProjectName: waiting for "Project name" label in create dialog…');

  let target = null;
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    // Find the label element whose own text is "Project name"
    const labelEl = [...document.querySelectorAll('label, div, span, p, h1, h2, h3')]
      .find(el => /^project name$/i.test(el.textContent.trim()));

    if (labelEl) {
      // Walk up to the nearest containing block and find the input inside it
      let container = labelEl.parentElement;
      while (container && !container.querySelector('input')) {
        container = container.parentElement;
      }
      target = container?.querySelector('input');
      if (target) {
        bgLog('typeProjectName: found input via "Project name" label.');
        break;
      }
    }
    await sleep(200);
  }

  if (!target) throw new Error('Project name field not found (no "Project name" label located)');

  // Simulate thinking + typing delay for the project name
  const nameTypingMs = humanTypingDelay(name);
  bgLog(`typeProjectName: simulating name-typing delay ${(nameTypingMs / 1000).toFixed(1)} s…`);
  await sleep(nameTypingMs);

  // Click the field to properly focus it (triggers React's onFocus handlers)
  dispatchRealClick(target);
  await sleep(200);

  // Reset React's internal value tracker so it detects the change and enables Create
  if (target._valueTracker) target._valueTracker.setValue('');

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(target, name);
  } else {
    target.value = name;
  }

  target.dispatchEvent(new InputEvent('input', {
    bubbles: true, cancelable: true, inputType: 'insertText', data: name,
  }));
  target.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(300);
  const after = target.value || '';
  bgLog(`typeProjectName: field now reads "${after.trim()}".`);
  return target;
}

// Step: click "Create project" to submit the popup.
// Waits for the button to be both present AND enabled — the button stays disabled
// until React sees a valid (non-empty) project name in its state.
async function clickCreateProject() {
  bgLog('clickCreateProject: waiting for Create button to be enabled…');

  const deadline = Date.now() + 10000;
  let btn = null;
  while (Date.now() < deadline) {
    btn = findByText('button', /^create project$|^create$/i);
    if (btn && !btn.disabled) break;
    await sleep(300);
  }

  if (!btn) throw new Error('Create project button not found');
  if (btn.disabled) bgLog('clickCreateProject: WARNING — button still disabled, clicking anyway');

  bgLog('clickCreateProject: button enabled, clicking…');
  await sleep(humanClickDelay());
  dispatchRealClick(btn);
  await new Promise(r => setTimeout(r, 1500));
  bgLog('clickCreateProject: clicked Create.');
}

// Full create-project flow for a new persona/batch
async function createProject(name) {
  await openProjectsPanel();
  await clickNewProject();

  await typeProjectName(name);
  await setProjectOnlyMemory();
  await clickCreateProject();

  // Wait for the page to navigate away from /projects and show a chat input.
  // The exact URL after creation varies, so we just wait for the textarea.
  bgLog('createProject: waiting for chat input after project creation…');
  await waitForElement(SELECTORS.input, 30000);
  bgLog(`createProject: project "${name}" created and chat input ready.`);
}

// Find the leaf text node whose own text exactly matches `name` — used instead of
// waitForTextEl when the matching element is a plain div/span/etc. with no role/tag
// that would narrow a tag-based query (same issue we hit with the memory option rows).
function findLeafTextEl(regex) {
  return [...document.querySelectorAll('a, button, div, span, p, li')]
    .find(el => el.children.length === 0 && regex.test((el.textContent || '').trim()));
}

async function waitForLeafTextEl(regex, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = findLeafTextEl(regex);
    if (found) return found;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for element matching ${regex}`);
}

// Open an existing project's home (where typing starts a fresh chat in that project)
async function openProjectAndStartNewChat(name) {
  await openProjectsPanel();
  bgLog(`openProjectAndStartNewChat: looking for project "${name}" in the projects list…`);

  // Scope the search to the MAIN content area, NOT the whole document. The project name
  // also appears in the left sidebar nav, and clicking that entry reopens the project's
  // last chat instead of the project home (the "same chat opens up" bug). The projects
  // LIST page renders cards inside <main>.
  const root = document.querySelector('main') || document.body;
  const re = new RegExp(`^${escapeRegex(name)}$`, 'i');

  const cardLink = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const leaf = [...root.querySelectorAll('a, div, span, p, li, h1, h2, h3, h4')]
        .find(el => el.children.length === 0 && re.test((el.textContent || '').trim()));
      if (leaf) {
        // Prefer the actual navigable anchor (project URL ends in /project).
        return leaf.closest('a[href]') || leaf.closest('a, button, [role="button"]') || leaf;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  })();

  if (!cardLink) throw new Error(`Project "${name}" not found in the projects list`);

  const href = cardLink.getAttribute ? cardLink.getAttribute('href') : null;
  bgLog(`openProjectAndStartNewChat: clicking project card (tag=${cardLink.tagName}, href=${href}).`);
  await sleep(humanClickDelay());
  dispatchRealClick(cardLink);

  // Verify we landed on the project HOME via the URL — the project home path ends in
  // "/project", whereas an open conversation has a /c/<chatId> segment. This is far more
  // reliable than matching tab text. If it never changes, the click didn't navigate.
  bgLog('openProjectAndStartNewChat: confirming navigation to project home (URL ends in /project)…');
  await waitForCondition(() => /\/project\/?$/.test(location.pathname), 8000).catch(() => {
    throw new Error(`Clicked "${name}" but never landed on its home — still at ${location.pathname}`);
  });

  await waitForElement(SELECTORS.input, 10000);
  bgLog('openProjectAndStartNewChat: project home confirmed, chat input ready.');
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'CREATE_PROJECT': {
          await createProject(msg.name);
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_PROJECT_NEW_CHAT': {
          await openProjectAndStartNewChat(msg.name);
          sendResponse({ ok: true });
          break;
        }
        case 'SEND_MESSAGE': {
          await sendMessage(msg.text);
          await waitForResponseComplete();
          const reply = getLastAssistantMessage();
          sendResponse({ ok: true, reply });
          break;
        }
        case 'SET_CONFIG': {
          testingMode = !!msg.testingMode;
          bgLog(`SET_CONFIG: testingMode=${testingMode}`);
          sendResponse({ ok: true });
          break;
        }
        case 'PING': {
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep message channel open for async
});
