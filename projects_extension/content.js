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

// Step: click "Projects" in the left sidebar
async function openProjectsPanel() {
  bgLog('openProjectsPanel: looking for Projects nav item…');
  const projectsLink = document.querySelector('a[href="/projects"]')
    || findByText('a, button, div[role="button"]', /^projects$/i);
  if (!projectsLink) throw new Error('Projects nav item not found');
  projectsLink.click();
  await new Promise(r => setTimeout(r, 800));
  bgLog('openProjectsPanel: clicked Projects.');
}

// Step: click "New project" to open the create-project popup
async function clickNewProject() {
  bgLog('clickNewProject: looking for New project button…');
  const newBtn = await waitForTextEl('button, a, div[role="button"]', /^new project$|^new$/i);
  newBtn.click();
  await new Promise(r => setTimeout(r, 800));
  bgLog('clickNewProject: clicked New.');
}

// Step: in the create-project popup, switch memory from "Default" to "Project-only"
async function setProjectOnlyMemory() {
  bgLog('setProjectOnlyMemory: looking for memory selector…');

  const select = [...document.querySelectorAll('select')]
    .find(s => [...s.options].some(o => /project.?only/i.test(o.textContent)));
  if (select) {
    const opt = [...select.options].find(o => /project.?only/i.test(o.textContent));
    select.value = opt.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    bgLog('setProjectOnlyMemory: set via <select>.');
    return;
  }

  // Dropdown-button pattern: click the trigger currently showing "Default",
  // then pick "Project-only" from the menu that opens.
  const trigger = findByText('button, div[role="button"]', /^default$/i);
  if (trigger) {
    trigger.click();
    await new Promise(r => setTimeout(r, 400));
    const option = await waitForTextEl('[role="menuitem"], [role="option"], li, div', /project.?only/i, 4000);
    option.click();
    bgLog('setProjectOnlyMemory: set via dropdown menu.');
    return;
  }

  throw new Error('Memory setting control ("Default" -> "Project-only") not found');
}

// Step: type the project name into the create-project popup
async function setProjectName(name) {
  bgLog(`setProjectName: setting name to "${name}"…`);
  const input = document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')
    || document.querySelector('input[placeholder*="name" i]')
    || await waitForElement('input', 5000);

  input.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, name);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: name, inputType: 'insertText' }));
  bgLog(`setProjectName: input now reads "${input.value}".`);
}

// Step: click "Create project" to submit the popup
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
  await setProjectOnlyMemory();
  await setProjectName(name);
  await clickCreateProject();
  await waitForElement(SELECTORS.input, 15000);
  bgLog(`createProject: project "${name}" created and chat input ready.`);
}

// Open an existing project's home (where typing starts a fresh chat in that project)
async function openProjectAndStartNewChat(name) {
  await openProjectsPanel();
  bgLog(`openProjectAndStartNewChat: looking for project "${name}"…`);
  const projectLink = await waitForTextEl(
    'a, div[role="button"], button',
    new RegExp(`^${escapeRegex(name)}$`, 'i'),
    8000
  );
  projectLink.click();
  await new Promise(r => setTimeout(r, 1000));
  await waitForElement(SELECTORS.input, 10000);
  bgLog('openProjectAndStartNewChat: project opened, chat input ready.');
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
