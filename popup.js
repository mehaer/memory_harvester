// Popup controller

// ── State ────────────────────────────────────────────────────────────────────

let batches = [{ prompts: [] }]; // array of { prompts: string[] }
let currentTab = 'setup';

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSavedBatches();
  renderBatches();
  refreshResults();
  refreshLog();
  pollStatus();

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Controls
  document.getElementById('startBtn').addEventListener('click', startAutomation);
  document.getElementById('stopBtn').addEventListener('click', stopAutomation);
  document.getElementById('addBatchBtn').addEventListener('click', addBatch);

  // Results tab
  document.getElementById('exportJsonBtn').addEventListener('click', exportResults);
  document.getElementById('clearResultsBtn').addEventListener('click', clearResults);
  document.getElementById('exportMemoryBtn').addEventListener('click', exportMemory);
  document.getElementById('clearLogBtn').addEventListener('click', clearLog);

  // Listen for background status updates
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'STATUS_UPDATE') applyStatus(msg.status);
  });
});

// ── Tab routing ──────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'results') refreshResults();
  if (tab === 'memory') refreshResults();
  if (tab === 'log') refreshLog();
}

// ── Batch editor ─────────────────────────────────────────────────────────────

function addBatch() {
  batches.push({ prompts: [] });
  renderBatches();
  saveBatches();
}

function removeBatch(i) {
  batches.splice(i, 1);
  if (!batches.length) batches.push({ prompts: [] });
  renderBatches();
  saveBatches();
}

function renderBatches() {
  const list = document.getElementById('batchList');
  list.innerHTML = '';
  batches.forEach((batch, i) => {
    const card = document.createElement('div');
    card.className = 'batch-card';
    card.innerHTML = `
      <div class="batch-header">
        <span>Batch ${i + 1}</span>
        <button class="btn-small btn-danger-small" data-remove="${i}">Remove</button>
      </div>
      <label>Prompts (one per line)
        <textarea data-batch="${i}" placeholder="Enter one prompt per line…" rows="4">${batch.prompts.join('\n')}</textarea>
      </label>
    `;
    list.appendChild(card);
    card.querySelector('[data-remove]').addEventListener('click', () => removeBatch(i));
    card.querySelector('textarea').addEventListener('input', e => {
      batches[i].prompts = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
      saveBatches();
    });
  });
}

function saveBatches() {
  chrome.storage.local.set({ harvesterBatches: batches });
}

function loadSavedBatches() {
  chrome.storage.local.get(['harvesterBatches'], data => {
    if (data.harvesterBatches && data.harvesterBatches.length) {
      batches = data.harvesterBatches;
      renderBatches();
    }
  });
}

// ── Automation controls ───────────────────────────────────────────────────────

function getConfig() {
  return {
    messagesPerChat: parseInt(document.getElementById('cfgMessagesPerChat').value) || 5,
    delayBetweenMessages: parseInt(document.getElementById('cfgDelayMessages').value) || 3000,
    delayBetweenChats: parseInt(document.getElementById('cfgDelayChats').value) || 2000,
    extractPerBatch: document.getElementById('cfgExtractPerBatch').checked,
  };
}

function startAutomation() {
  const validBatches = batches.filter(b => b.prompts.length > 0);
  if (!validBatches.length) {
    alert('Add at least one prompt to a batch before starting.');
    return;
  }
  chrome.runtime.sendMessage({ type: 'START', batches: validBatches, config: getConfig() }, res => {
    if (!res?.ok) alert('Failed to start: ' + (res?.error || 'Unknown error'));
  });
}

function stopAutomation() {
  chrome.runtime.sendMessage({ type: 'STOP' });
}

// ── Status polling ───────────────────────────────────────────────────────────

function pollStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, res => {
    if (res?.ok) applyStatus(res);
  });
  setTimeout(pollStatus, 2000);
}

function applyStatus(status) {
  const badge = document.getElementById('statusBadge');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const progressArea = document.getElementById('progressArea');

  if (status.running) {
    badge.textContent = 'Running';
    badge.className = 'status-badge running';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    progressArea.style.display = 'flex';
  } else {
    badge.textContent = 'Idle';
    badge.className = 'status-badge';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    progressArea.style.display = 'none';
  }

  document.getElementById('progressLabel').textContent =
    `Batch ${status.currentBatchIndex + 1} · Prompt ${status.currentPromptIndex + 1} · ${status.resultsCount} collected`;

  if (currentTab === 'results') refreshResults();
}

// ── Results display ──────────────────────────────────────────────────────────

function refreshResults() {
  chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, res => {
    if (!res?.ok) return;
    renderResults(res.results || []);
    renderMemory(res.memoryExtracts || []);
  });
}

function renderResults(results) {
  const list = document.getElementById('resultsList');
  const count = document.getElementById('resultsCount');
  count.textContent = `${results.length} response${results.length !== 1 ? 's' : ''} collected`;

  if (!results.length) {
    list.innerHTML = '<div class="empty">No results yet</div>';
    return;
  }

  list.innerHTML = '';
  // Show newest first
  [...results].reverse().forEach(r => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="meta">Batch ${r.batchIndex + 1} · Prompt ${r.promptIndex + 1} · ${new Date(r.timestamp).toLocaleTimeString()}</div>
      <div class="prompt-text">${escHtml(r.prompt.slice(0, 120))}${r.prompt.length > 120 ? '…' : ''}</div>
      <div class="reply-text">${escHtml(r.reply || '(no reply)')}</div>
    `;
    list.appendChild(card);
  });
}

function renderMemory(extracts) {
  const list = document.getElementById('memoryList');
  const count = document.getElementById('memoryCount');
  count.textContent = `${extracts.length} extraction${extracts.length !== 1 ? 's' : ''}`;

  if (!extracts.length) {
    list.innerHTML = '<div class="empty">No memory extractions yet</div>';
    return;
  }

  list.innerHTML = '';
  [...extracts].reverse().forEach(e => {
    const card = document.createElement('div');
    card.className = 'memory-card';
    const items = e.memories.length
      ? e.memories.map(m => `<li>${escHtml(m)}</li>`).join('')
      : '<li><em>(no memories found)</em></li>';
    card.innerHTML = `
      <div class="meta">Batch ${e.batchIndex + 1} · ${new Date(e.timestamp).toLocaleTimeString()} · ${e.memories.length} items</div>
      <ul>${items}</ul>
    `;
    list.appendChild(card);
  });
}

// ── Log display ───────────────────────────────────────────────────────────────

function refreshLog() {
  chrome.runtime.sendMessage({ type: 'GET_LOG' }, res => {
    if (!res?.ok) return;
    const list = document.getElementById('logList');
    const logs = res.log || [];
    if (!logs.length) { list.innerHTML = '<div class="empty">No log entries</div>'; return; }
    list.innerHTML = '';
    [...logs].reverse().forEach(l => {
      const el = document.createElement('div');
      el.className = 'log-entry';
      el.innerHTML = `<span class="log-time">${new Date(l.ts).toLocaleTimeString()}</span><span class="log-msg">${escHtml(l.msg)}</span>`;
      list.appendChild(el);
    });
  });
}

function clearLog() {
  chrome.storage.local.remove(['harvesterLog'], refreshLog);
}

// ── Export / clear ────────────────────────────────────────────────────────────

function exportResults() {
  chrome.runtime.sendMessage({ type: 'EXPORT' }, res => {
    if (!res?.ok) return;
    downloadJson({ results: res.results, memoryExtracts: res.memoryExtracts }, 'harvester-export.json');
  });
}

function exportMemory() {
  chrome.runtime.sendMessage({ type: 'EXPORT' }, res => {
    if (!res?.ok) return;
    downloadJson(res.memoryExtracts, 'harvester-memory.json');
  });
}

function clearResults() {
  if (!confirm('Clear all collected results and memory extractions?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => refreshResults());
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
