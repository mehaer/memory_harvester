// Content script — runs on chatgpt.com
// Receives commands from background via chrome.runtime.onMessage

const SELECTORS = {
  input: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Send prompt"]',
  stopButton: 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  newChatButton: 'a[href="/"]',
  assistantMessage: '[data-message-author-role="assistant"]',
};

// ── DOM helpers ──────────────────────────────────────────────────────────────

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

// Find a button whose visible text matches a regex
function findButton(regex, root = document) {
  return Array.from(root.querySelectorAll('button')).find(b => regex.test(b.textContent.trim()));
}

// Find a clickable element (button, div, li) whose text matches a regex
function findClickable(regex, root = document) {
  const candidates = root.querySelectorAll('button, [role="menuitem"], [role="option"], li, div[tabindex]');
  return Array.from(candidates).find(el => regex.test(el.textContent.trim()));
}

// ── Chat input helpers ───────────────────────────────────────────────────────

function waitForResponseComplete(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let streamingStarted = false;
    const initialMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

    function check() {
      if (Date.now() - start > timeout) return reject(new Error('Response timeout'));
      const stopBtn = document.querySelector(SELECTORS.stopButton);
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      const currentMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

      if (stopBtn || currentMsgCount > initialMsgCount) streamingStarted = true;

      if (streamingStarted && !stopBtn && sendBtn && !sendBtn.disabled) {
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
  const input = await waitForElement(SELECTORS.input);
  input.focus();

  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, text);

  if (!(input.innerText || '').trim()) {
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }

  await sleep(300);
  const sendBtn = await waitForEnabledSendButton();
  sendBtn.click();
}

function waitForEnabledSendButton(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function check() {
      const btn = document.querySelector(SELECTORS.sendButton);
      if (btn && !btn.disabled) return resolve(btn);
      if (Date.now() > deadline) return reject(new Error('Send button never enabled'));
      setTimeout(check, 200);
    }
    check();
  });
}

async function openNewChat() {
  const newChat = document.querySelector(SELECTORS.newChatButton)
    || document.querySelector('button[aria-label="New chat"]')
    || document.querySelector('a[data-testid="create-new-chat-button"]');

  if (newChat) {
    newChat.click();
  } else {
    window.location.href = 'https://chatgpt.com/';
  }
  await waitForElement(SELECTORS.input, 10000);
  await sleep(500);
}

// ── Memory settings helpers ──────────────────────────────────────────────────

// Waits for the settings dialog/modal to appear after navigating to /#settings/...
async function waitForSettingsDialog(timeout = 10000) {
  // ChatGPT settings open as a dialog; try multiple selector patterns
  const selectors = [
    '[data-testid="settings-dialog"]',
    'dialog[open]',
    '[role="dialog"]',
  ];
  for (const sel of selectors) {
    try {
      return await waitForElement(sel, timeout / selectors.length);
    } catch (_) {}
  }
  // Last attempt: wait for any dialog-like overlay
  return await waitForElement('[class*="modal"], [class*="dialog"], [class*="Modal"]', 3000);
}

// Clicks the "Manage" button next to Memory in Personalization settings
async function openManageMemory() {
  await waitForSettingsDialog();
  await sleep(800);

  // The button is typically labeled "Manage" near a "Memory" heading
  const manageBtn = findButton(/^manage$/i) || findButton(/manage memory/i);
  if (!manageBtn) throw new Error('Manage memory button not found in settings');
  manageBtn.click();
  await sleep(1200);
}

// Scrapes the memory items / memory summary text from the manage memory panel
function scrapeMemoryItems() {
  // ChatGPT renders individual memories as list items inside the manage panel
  const testIdItems = document.querySelectorAll('[data-testid="memory-item"]');
  if (testIdItems.length) {
    return Array.from(testIdItems).map(el => el.innerText.trim()).filter(Boolean);
  }

  // Memory summary view — a single prose block
  const summaryEl = document.querySelector('[data-testid="memory-summary"], [class*="memorySummary"], [class*="memory-summary"]');
  if (summaryEl) return [summaryEl.innerText.trim()];

  // Generic: grab <li> elements inside any open dialog
  const dialog = document.querySelector('[role="dialog"], dialog[open]');
  if (dialog) {
    const items = dialog.querySelectorAll('li');
    const texts = Array.from(items).map(el => el.innerText.trim()).filter(Boolean);
    if (texts.length) return texts;

    // Fallback: grab all paragraph text in the dialog body, excluding buttons/controls
    const paras = dialog.querySelectorAll('p, [class*="memory"]');
    const paraTexts = Array.from(paras).map(el => el.innerText.trim()).filter(Boolean);
    if (paraTexts.length) return paraTexts;
  }

  return [];
}

// Clicks the 3-dot/kebab menu in the manage memory modal and selects
// "Delete & disable memory", then confirms
async function clearAllMemory() {
  // Find the overflow / 3-dot menu button inside the dialog
  const dialog = document.querySelector('[role="dialog"], dialog[open]');
  if (!dialog) throw new Error('Settings dialog not found for memory clear');

  // Try data-testid first, then aria patterns, then svg-only buttons at the top of the dialog
  let menuBtn = dialog.querySelector('[data-testid="memory-options-menu"], button[aria-label*="more" i], button[aria-label*="option" i], button[aria-haspopup="menu"]');

  if (!menuBtn) {
    // Look for a small icon-only button (no visible text) in the dialog header area
    const allBtns = Array.from(dialog.querySelectorAll('button'));
    menuBtn = allBtns.find(b => {
      const text = b.textContent.trim();
      return text === '' || text === '⋯' || text === '…' || text === '•••';
    });
  }

  if (!menuBtn) throw new Error('3-dot menu button not found in manage memory panel');
  menuBtn.click();
  await sleep(600);

  // Find "Delete & disable memory" in the dropdown
  const deleteItem = findClickable(/delete.*disable|disable.*delete/i)
    || findClickable(/delete memory/i);
  if (!deleteItem) throw new Error('"Delete & disable memory" option not found in menu');
  deleteItem.click();
  await sleep(900);

  // Confirm the destructive action dialog
  const confirmBtn = findButton(/^(confirm|delete|yes|ok)$/i)
    || findButton(/confirm|delete/i);
  if (confirmBtn && !/cancel/i.test(confirmBtn.textContent)) {
    confirmBtn.click();
    await sleep(1200);
  }
}

// Clicks "Delete all chats" from the Data Controls settings panel and confirms
async function deleteAllChats() {
  await waitForSettingsDialog();
  await sleep(800);

  const deleteBtn = findButton(/delete all chats/i);
  if (!deleteBtn) throw new Error('"Delete all chats" button not found in Data Controls');
  deleteBtn.click();
  await sleep(800);

  // Confirm dialog
  const confirmBtn = findButton(/^(confirm|delete|yes|ok)$/i)
    || findButton(/delete all/i);
  if (confirmBtn && !/cancel/i.test(confirmBtn.textContent)) {
    confirmBtn.click();
    await sleep(1500);
  }
}

// Re-enables the Memory toggle in Personalization settings after it was disabled
async function reEnableMemory() {
  await waitForSettingsDialog();
  await sleep(800);

  // Look for a toggle/switch near "Memory" text that is currently off
  const switches = Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"]'));

  // Find the one associated with "Memory" — walk up to find a label or nearby text
  let memorySwitch = null;
  for (const sw of switches) {
    const container = sw.closest('label, [class*="setting"], [class*="row"], li, div') || sw.parentElement;
    if (container && /memory/i.test(container.textContent)) {
      memorySwitch = sw;
      break;
    }
  }

  if (!memorySwitch) {
    // Fallback: any switch that is currently aria-checked=false
    memorySwitch = switches.find(sw =>
      sw.getAttribute('aria-checked') === 'false' || (sw.tagName === 'INPUT' && !sw.checked)
    );
  }

  if (!memorySwitch) throw new Error('Memory toggle not found in Personalization settings');

  const isOff = memorySwitch.getAttribute('aria-checked') === 'false'
    || (memorySwitch.tagName === 'INPUT' && !memorySwitch.checked);

  if (isOff) {
    memorySwitch.click();
    await sleep(800);
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'SEND_MESSAGE': {
          await sendMessage(msg.text);
          await waitForResponseComplete();
          const reply = getLastAssistantMessage();
          sendResponse({ ok: true, reply });
          break;
        }
        case 'NEW_CHAT': {
          await openNewChat();
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_MANAGE_MEMORY': {
          await openManageMemory();
          sendResponse({ ok: true });
          break;
        }
        case 'SCRAPE_MEMORY': {
          const memories = scrapeMemoryItems();
          sendResponse({ ok: true, memories });
          break;
        }
        case 'CLEAR_MEMORY': {
          await clearAllMemory();
          sendResponse({ ok: true });
          break;
        }
        case 'DELETE_ALL_CHATS': {
          await deleteAllChats();
          sendResponse({ ok: true });
          break;
        }
        case 'REENABLE_MEMORY': {
          await reEnableMemory();
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
  return true;
});
