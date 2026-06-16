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

// Broader stop-button selector to survive ChatGPT UI renames
const STOP_BUTTON_SELECTOR =
  'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], ' +
  'button[data-testid="stop-button"], button[aria-label*="stop" i]';

function waitForResponseComplete(timeout = 120000) {
  return new Promise(resolve => {
    const start = Date.now();
    let streamingStarted = false;
    const initialMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

    function check() {
      const elapsed = Date.now() - start;

      // Hard timeout — resolve so the batch can continue regardless
      if (elapsed > timeout) { resolve(); return; }

      const stopBtn = document.querySelector(STOP_BUTTON_SELECTOR);
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      const currentMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

      if (stopBtn || currentMsgCount > initialMsgCount) streamingStarted = true;

      // Normal path: streaming detected and now done
      if (streamingStarted && !stopBtn && sendBtn && !sendBtn.disabled) {
        setTimeout(resolve, 500);
        return;
      }

      // Fallback: send button re-enabled but streaming was never detected
      // (fast response or selector miss) — wait at least 5 s to avoid false trigger
      if (!streamingStarted && elapsed > 5000 && sendBtn && !sendBtn.disabled) {
        resolve();
        return;
      }

      // Safety valve: streaming detected but still going after 90 s
      if (streamingStarted && elapsed > 90000) { resolve(); return; }

      setTimeout(check, 500);
    }
    setTimeout(check, 800); // start checking sooner than 1500 ms
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

  // Clear existing content
  input.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await sleep(100);

  // Primary: execCommand insertText (triggers React's synthetic events)
  const ok = document.execCommand('insertText', false, text);

  // Fallback 1: InputEvent (for ProseMirror / newer React)
  if (!ok || !(input.innerText || input.value || '').trim()) {
    input.focus();
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true,
      data: text, inputType: 'insertText',
    }));
    await sleep(100);
  }

  // Fallback 2: set innerText and fire input event
  if (!(input.innerText || input.value || '').trim()) {
    input.innerText = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Give React time to process the state update before checking send button
  await sleep(600);
  const sendBtn = await waitForEnabledSendButton(15000);
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

// Scrolls the settings dialog to reveal content at the bottom
function scrollDialogToBottom() {
  const dialog = document.querySelector('[role="dialog"], dialog[open]');
  if (!dialog) return;
  // Try every scrollable child first, then the dialog itself
  const scrollable = Array.from(dialog.querySelectorAll('*')).find(el => {
    const s = window.getComputedStyle(el);
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
  }) || dialog;
  scrollable.scrollTop = scrollable.scrollHeight;
}

// Clicks profile → Personalization, waits for dialog, scrolls to bottom, clicks "Manage"
async function openManageMemory() {
  // Open profile menu at the bottom of the sidebar
  const profileBtn =
    document.querySelector('[data-testid="profile-button"]') ||
    document.querySelector('button[aria-label*="account" i]') ||
    document.querySelector('button[aria-label*="user menu" i]') ||
    // fallback: last button in the sidebar nav
    [...document.querySelectorAll('nav button, [class*="sidebar"] button')].at(-1);

  if (!profileBtn) throw new Error('Profile button not found in sidebar');
  profileBtn.click();
  await sleep(800);

  // Click "Personalization" in the dropdown menu
  const personalizationItem =
    findClickable(/^personalization$/i) ||
    findClickable(/personalization/i);
  if (!personalizationItem) throw new Error('Personalization menu item not found');
  personalizationItem.click();
  await sleep(1500);

  // Wait for the settings dialog to open
  await waitForSettingsDialog(8000);
  await sleep(600);

  // Scroll to the bottom — "Memory summary" is at the bottom of Personalization
  scrollDialogToBottom();
  await sleep(600);

  // Find the "Manage" button that is inside a section containing "Memory summary" text.
  // There are multiple "Manage" buttons on this page (e.g. plan management) — we must
  // only click the one anchored to the Memory summary row.
  const allDivs = Array.from(document.querySelectorAll('div, li, section'));
  let manageBtn = null;

  // Primary: find the smallest container that mentions "memory summary" and has a Manage button
  for (const el of allDivs) {
    if (/memory summary/i.test(el.textContent)) {
      const btn = Array.from(el.querySelectorAll('button'))
        .find(b => /^manage$/i.test(b.textContent.trim()));
      if (btn) { manageBtn = btn; break; }
    }
  }

  // Fallback: any "Manage" button near generic "memory" text (not plan/upgrade sections)
  if (!manageBtn) {
    for (const el of allDivs) {
      if (/memory/i.test(el.textContent) && !/upgrade|plan|plus|pro/i.test(el.textContent)) {
        const btn = Array.from(el.querySelectorAll('button'))
          .find(b => /^manage$/i.test(b.textContent.trim()));
        if (btn) { manageBtn = btn; break; }
      }
    }
  }

  if (!manageBtn) {
    const labels = Array.from(document.querySelectorAll('button'))
      .map(b => b.textContent.trim()).filter(Boolean).slice(0, 30);
    throw new Error(`Memory summary Manage button not found. Visible buttons: [${labels.join(' | ')}]`);
  }

  manageBtn.click();
  await sleep(1500);
}

// Scrapes the memory summary text from the manage memory panel.
// Guards against accidentally reading the subscription/upgrade dialog.
function scrapeMemoryItems() {
  const dialog = document.querySelector('[role="dialog"], dialog[open]');

  // Safety check: if the visible dialog looks like a subscription page, bail out
  if (dialog) {
    const headings = Array.from(dialog.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .map(h => h.textContent.trim());
    const isUpgradePage = headings.some(h => /upgrade|plan|plus|pro|subscription/i.test(h));
    if (isUpgradePage) return [];
  }

  // Preferred: data-testid memory items
  const testIdItems = document.querySelectorAll('[data-testid="memory-item"]');
  if (testIdItems.length) {
    return Array.from(testIdItems).map(el => el.innerText.trim()).filter(Boolean);
  }

  // Memory summary view — prose block
  const summaryEl = document.querySelector(
    '[data-testid="memory-summary"], [class*="memorySummary"], [class*="memory-summary"]'
  );
  if (summaryEl) return [summaryEl.innerText.trim()].filter(Boolean);

  // Generic fallback: only grab list items from a dialog whose heading mentions "memory"
  if (dialog) {
    const heading = dialog.querySelector('h1, h2, h3, [role="heading"]');
    const headingText = heading?.textContent?.trim() || '';
    if (/memory/i.test(headingText)) {
      const items = Array.from(dialog.querySelectorAll('li'))
        .map(el => el.innerText.trim()).filter(Boolean);
      if (items.length) return items;

      const paras = Array.from(dialog.querySelectorAll('p, [class*="memory"]'))
        .map(el => el.innerText.trim()).filter(Boolean);
      if (paras.length) return paras;
    }
  }

  return [];
}

// Clicks the triple-dot menu in the memory overview → "Delete and turn off memory" → confirms
async function clearAllMemory() {
  const dialog = document.querySelector('[role="dialog"], dialog[open]');
  if (!dialog) throw new Error('Memory overview dialog not found');

  // Find the triple-dot (⋯) icon button at the top of the memory overview
  let menuBtn =
    dialog.querySelector('[data-testid="memory-options-menu"]') ||
    dialog.querySelector('button[aria-haspopup="menu"]') ||
    dialog.querySelector('button[aria-label*="more" i]');

  if (!menuBtn) {
    // Icon-only buttons have no visible text
    menuBtn = Array.from(dialog.querySelectorAll('button')).find(b => {
      const text = b.textContent.trim();
      return text === '' || /^[.…⋯•·]+$/.test(text);
    });
  }

  if (!menuBtn) {
    const labels = Array.from(dialog.querySelectorAll('button')).map(b => `"${b.textContent.trim()}"`).slice(0, 20);
    throw new Error(`Triple-dot menu not found. Dialog buttons: [${labels.join(', ')}]`);
  }
  menuBtn.click();
  await sleep(700);

  // Click "Delete and turn off memory" in the dropdown
  const deleteItem =
    findClickable(/delete and turn off/i) ||
    findClickable(/delete.*turn off/i);
  if (!deleteItem) {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li, button'))
      .map(el => `"${el.textContent.trim()}"`).filter(s => s.length > 2).slice(0, 20);
    throw new Error(`"Delete and turn off" not found. Visible: [${items.join(', ')}]`);
  }
  deleteItem.click();
  await sleep(1000);

  // Confirm — the popup button also says "Delete and turn off memory"
  const confirmBtn =
    findButton(/delete and turn off/i) ||
    findButton(/^delete$/i) ||
    findButton(/confirm/i);
  if (!confirmBtn) throw new Error('Delete confirmation button not found');
  confirmBtn.click();
  await sleep(2000);
}

// Clicks "Delete all chats" from the Data Controls settings panel and confirms
async function deleteAllChats() {
  await waitForSettingsDialog();
  await sleep(800);

  const deleteBtn = findButton(/delete all chats/i);
  if (!deleteBtn) throw new Error('"Delete all chats" button not found in Data Controls');

  // Snapshot button count before clicking so we can detect the new confirm dialog
  const btnsBefore = document.querySelectorAll('button').length;
  deleteBtn.click();

  // Wait for the confirmation modal to inject new buttons into the DOM
  await new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (document.querySelectorAll('button').length !== btnsBefore) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
  });
  await sleep(300);

  // The confirm dialog button will NOT say "Delete all chats" — it will be a short label
  // like "Delete", "Confirm", "Yes". Exclude the original trigger button by text length.
  const allBtns = Array.from(document.querySelectorAll('button'));
  const confirmBtn = allBtns.find(b => {
    const text = b.textContent.trim();
    return /^(delete|confirm|yes|ok)$/i.test(text) || /confirm deletion/i.test(text);
  });

  if (!confirmBtn) {
    const labels = allBtns.map(b => b.textContent.trim()).filter(Boolean).slice(0, 20);
    throw new Error(`Delete confirm button not found. Visible: [${labels.join(' | ')}]`);
  }

  confirmBtn.click();
  await sleep(2000);
}

// Opens profile → Personalization, scrolls to bottom, re-enables the memory toggle
async function reEnableMemory() {
  // Open profile menu
  const profileBtn =
    document.querySelector('[data-testid="profile-button"]') ||
    document.querySelector('button[aria-label*="account" i]') ||
    document.querySelector('button[aria-label*="user menu" i]') ||
    [...document.querySelectorAll('nav button, [class*="sidebar"] button')].at(-1);

  if (!profileBtn) throw new Error('Profile button not found for re-enable');
  profileBtn.click();
  await sleep(800);

  const personalizationItem =
    findClickable(/^personalization$/i) ||
    findClickable(/personalization/i);
  if (!personalizationItem) throw new Error('Personalization menu item not found for re-enable');
  personalizationItem.click();
  await sleep(1500);

  await waitForSettingsDialog(8000);
  await sleep(600);

  // Scroll to bottom where "Enable memory" toggle lives
  scrollDialogToBottom();
  await sleep(600);

  // Find toggle near "enable memory" or "memory" text
  const switches = Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"], button[aria-checked]'));
  let memorySwitch = null;

  for (const sw of switches) {
    const container = sw.closest('label, [class*="setting"], [class*="row"], li, div') || sw.parentElement;
    if (container && /enable memory|memory/i.test(container.textContent)) {
      memorySwitch = sw;
      break;
    }
  }

  if (!memorySwitch) {
    const info = switches.map(sw => {
      const c = sw.closest('div') || sw.parentElement;
      return `[aria-checked="${sw.getAttribute('aria-checked')}" near:"${c?.textContent?.trim().slice(0, 30)}"]`;
    }).join(', ');
    throw new Error(`Enable memory toggle not found. Switches: ${info}`);
  }

  const isOff =
    memorySwitch.getAttribute('aria-checked') === 'false' ||
    (memorySwitch.tagName === 'INPUT' && !memorySwitch.checked);

  if (isOff) {
    memorySwitch.click();
    await sleep(1000);
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
