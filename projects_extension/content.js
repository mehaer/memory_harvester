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

  await new Promise(r => setTimeout(r, 300));
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
  const projectsLink = document.querySelector('a[href="/projects"]')
    || findByText('a, button, div[role="button"]', /^projects$/i);
  if (!projectsLink) throw new Error('Projects nav item not found');
  projectsLink.click();
  await new Promise(r => setTimeout(r, 800));

  bgLog('openProjectsPanel: confirming Projects list page loaded…');
  await waitForTextEl('h1, h2', /^projects$/i, 6000).catch(() => {
    throw new Error('Clicked Projects but the Projects list page never loaded');
  });
  bgLog('openProjectsPanel: Projects list page confirmed.');
}

// Step: click "New project" to open the create-project popup
async function clickNewProject() {
  bgLog('clickNewProject: looking for New project button…');
  const newBtn = await waitForTextEl('button, a, div[role="button"]', /^new project$|^new$/i);
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

  heading.click();
  bgLog('setProjectOnlyMemory: clicked "Project-only" option.');
}

// Step: type the project name. Clicking "New project" already places the cursor in the
// name field, so we type into whatever's currently focused rather than re-querying for it.
async function typeProjectName(name) {
  bgLog(`typeProjectName: typing "${name}"…`);
  let target = document.activeElement;
  if (!target || !(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    target = document.querySelector('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] [contenteditable="true"]');
  }
  if (!target) throw new Error('Project name field not found/focused');

  target.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, name);

  await new Promise(r => setTimeout(r, 200));
  const after = (target.value !== undefined ? target.value : (target.innerText || target.textContent)) || '';
  bgLog(`typeProjectName: field now reads "${after.trim()}".`);
  return target;
}

// Step: click "Create project" to submit the popup.
// (A synthetic Enter keypress doesn't trigger native form submission since it's
// not a browser-trusted event, so we click the actual button instead.)
async function clickCreateProject() {
  bgLog('clickCreateProject: looking for Create button…');
  const btn = await waitForTextEl('button', /^create project$|^create$/i);
  btn.click();
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

  await waitForElement(SELECTORS.input, 15000);
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
