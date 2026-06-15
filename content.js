// Content script — runs on chatgpt.com
// Receives commands from background via chrome.runtime.onMessage

const SELECTORS = {
  input: '#prompt-textarea',
  // Combined selectors survive ChatGPT UI updates that rename these buttons
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Send prompt"]',
  stopButton: 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[data-testid="stop-button"]',
  newChatButton: 'a[href="/"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  // Memory settings page selectors
  memoryItem: '.memory-item, [data-testid="memory-item"]',
  clearAllMemoryButton: 'button[data-testid="clear-memory-button"]',
  confirmClearButton: 'button.btn-danger, button[data-testid="confirm-clear-memory"]',
  memoryText: '.memory-item-text, [data-testid="memory-item-text"]',
};

// Wait for an element matching selector to appear in the DOM
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

function waitForResponseComplete(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let streamingStarted = false;
    // Track message count as a fallback signal that a response began
    const initialMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

    function check() {
      if (Date.now() - start > timeout) return reject(new Error('Response timeout'));
      const stopBtn = document.querySelector(SELECTORS.stopButton);
      const sendBtn = document.querySelector(SELECTORS.sendButton);
      const currentMsgCount = document.querySelectorAll(SELECTORS.assistantMessage).length;

      // Mark streaming started if either the stop button appeared OR a new assistant message exists
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

// Get the last assistant message text
function getLastAssistantMessage() {
  const messages = document.querySelectorAll(SELECTORS.assistantMessage);
  if (!messages.length) return '';
  const last = messages[messages.length - 1];
  // Extract plain text, preserving code blocks with newlines
  return last.innerText || last.textContent || '';
}


async function sendMessage(text) {
  const input = await waitForElement(SELECTORS.input);
  input.focus();

  // Explicitly select-all and delete first so execCommand reliably fires
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, text);

  // Verify insertion worked
  if (!(input.innerText || '').trim()) {
    // React-compatible fallback: clone and dispatch a proper InputEvent
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }

  // Wait for React to recognise the text and enable the send button
  await new Promise(r => setTimeout(r, 300));
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

// Navigate to new chat by clicking the sidebar button
async function openNewChat() {
  // Try sidebar new chat link
  const newChat = document.querySelector(SELECTORS.newChatButton)
    || document.querySelector('button[aria-label="New chat"]')
    || document.querySelector('a[data-testid="create-new-chat-button"]');

  if (newChat) {
    newChat.click();
  } else {
    // Fallback: navigate directly
    window.location.href = 'https://chatgpt.com/';
  }
  // Wait for the input to be ready in the fresh chat
  await waitForElement(SELECTORS.input, 10000);
  await new Promise(r => setTimeout(r, 500));
}

// Scrape all memory items from the memory management page
function scrapeMemoryItems() {
  const items = document.querySelectorAll(SELECTORS.memoryItem);
  if (items.length) {
    return Array.from(items).map(el => el.innerText || el.textContent);
  }
  // Fallback: look for any list of memories in the settings modal
  const fallback = document.querySelectorAll('[class*="memory"] li, [class*="Memory"] li');
  return Array.from(fallback).map(el => el.innerText || el.textContent);
}

// Click "Clear all memories" and confirm
async function clearAllMemory() {
  let clearBtn = document.querySelector(SELECTORS.clearAllMemoryButton)
    || document.querySelector('button[aria-label*="Clear"]')
    || [...document.querySelectorAll('button')].find(b => /clear all/i.test(b.textContent));

  if (!clearBtn) throw new Error('Clear memory button not found');
  clearBtn.click();

  await new Promise(r => setTimeout(r, 800));

  let confirmBtn = document.querySelector(SELECTORS.confirmClearButton)
    || [...document.querySelectorAll('button')].find(b => /confirm|yes|clear/i.test(b.textContent) && b !== clearBtn);

  if (confirmBtn) confirmBtn.click();
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
