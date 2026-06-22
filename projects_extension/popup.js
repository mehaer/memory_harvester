// Popup controller

// ── State ────────────────────────────────────────────────────────────────────

// personas: [{ description: string, chats: [{ criterion: string, turns: number }] }]
let personas = [{ description: '', chats: [{ criterion: '', turns: 4 }] }];
let currentTab = 'setup';

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSavedPersonas();
  loadSettings();
  renderPersonas();
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
  document.getElementById('addPersonaBtn').addEventListener('click', addPersona);

  // Persist settings on change
  ['cfgPersonaStartIndex']
    .forEach(id => document.getElementById(id).addEventListener('input', saveSettings));
  document.getElementById('cfgTestingMode').addEventListener('change', saveSettings);

  // JSON import
  document.getElementById('importFile').addEventListener('change', importFromFile);
  document.getElementById('importTextBtn').addEventListener('click', importFromText);
  document.getElementById('downloadTemplateBtn').addEventListener('click', downloadTemplate);

  // Results tab
  document.getElementById('exportJsonBtn').addEventListener('click', exportResults);
  document.getElementById('clearResultsBtn').addEventListener('click', clearResults);
  document.getElementById('clearLogBtn').addEventListener('click', clearLog);
});

// ── Tab routing ──────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'results') refreshResults();
  if (tab === 'log') refreshLog();
}

// ── Persona / chat editor ──────────────────────────────────────────────────────

function addPersona() {
  personas.push({ description: '', chats: [{ criterion: '', turns: 4 }] });
  renderPersonas();
  savePersonas();
}

function removePersona(i) {
  personas.splice(i, 1);
  if (!personas.length) personas.push({ description: '', chats: [{ criterion: '', turns: 4 }] });
  renderPersonas();
  savePersonas();
}

function addChat(pi) {
  personas[pi].chats.push({ criterion: '', turns: 4 });
  renderPersonas();
  savePersonas();
}

function removeChat(pi, ci) {
  personas[pi].chats.splice(ci, 1);
  if (!personas[pi].chats.length) personas[pi].chats.push({ criterion: '', turns: 4 });
  renderPersonas();
  savePersonas();
}

function renderPersonas() {
  const list = document.getElementById('personaList');
  list.innerHTML = '';

  personas.forEach((persona, pi) => {
    const card = document.createElement('div');
    card.className = 'batch-card';

    const chatsHtml = persona.chats.map((chat, ci) => `
      <div class="chat-row" data-chat="${ci}">
        <div class="chat-row-head">
          <span class="chat-label">Chat ${ci + 1}</span>
          <button class="btn-small btn-danger-small" data-remove-chat="${ci}">×</button>
        </div>
        <label>Criterion (optional — blank = free chat)
          <textarea data-criterion="${ci}" rows="2" placeholder="e.g. ask about growing tomato plants">${escHtml(chat.criterion)}</textarea>
        </label>
        <label>Approx. turns
          <input type="number" data-turns="${ci}" value="${Number(chat.turns) || 4}" min="1" max="50" />
        </label>
      </div>
    `).join('');

    card.innerHTML = `
      <div class="batch-header">
        <span>Persona ${pi + 1}</span>
        <button class="btn-small btn-danger-small" data-remove-persona="${pi}">Remove</button>
      </div>
      <label>Persona description (who the human is)
        <textarea data-description placeholder="e.g. A 34-year-old first-time gardener in Oregon, casual and curious…" rows="3">${escHtml(persona.description)}</textarea>
      </label>
      <div class="chats-wrap">${chatsHtml}</div>
      <button class="btn-small" data-add-chat="${pi}">+ Chat</button>
    `;

    list.appendChild(card);

    // Persona-level wiring
    card.querySelector('[data-remove-persona]').addEventListener('click', () => removePersona(pi));
    card.querySelector('[data-description]').addEventListener('input', e => {
      personas[pi].description = e.target.value;
      savePersonas();
    });
    card.querySelector('[data-add-chat]').addEventListener('click', () => addChat(pi));

    // Chat-level wiring
    card.querySelectorAll('.chat-row').forEach(row => {
      const ci = parseInt(row.dataset.chat);
      row.querySelector('[data-remove-chat]').addEventListener('click', () => removeChat(pi, ci));
      row.querySelector('[data-criterion]').addEventListener('input', e => {
        personas[pi].chats[ci].criterion = e.target.value;
        savePersonas();
      });
      row.querySelector('[data-turns]').addEventListener('input', e => {
        const v = parseInt(e.target.value);
        if (!isNaN(v) && v >= 1) { personas[pi].chats[ci].turns = v; savePersonas(); }
      });
    });
  });
}

function savePersonas() {
  chrome.storage.local.set({ personaHarvesterPersonas: personas });
}

function loadSavedPersonas() {
  chrome.storage.local.get(['personaHarvesterPersonas'], data => {
    if (data.personaHarvesterPersonas && data.personaHarvesterPersonas.length) {
      personas = data.personaHarvesterPersonas;
      renderPersonas();
    }
  });
}

// ── Settings persistence ────────────────────────────────────────────────────────

function saveSettings() {
  chrome.storage.local.set({
    personaHarvesterSettings: {
      personaStartIndex: document.getElementById('cfgPersonaStartIndex').value,
      testingMode: document.getElementById('cfgTestingMode').checked,
    },
  });
}

function loadSettings() {
  chrome.storage.local.get(['personaHarvesterSettings'], data => {
    const s = data.personaHarvesterSettings;
    if (!s) return;
    if (s.personaStartIndex != null) document.getElementById('cfgPersonaStartIndex').value = s.personaStartIndex;
    if (s.testingMode != null) document.getElementById('cfgTestingMode').checked = s.testingMode;
  });
}

// ── JSON import ────────────────────────────────────────────────────────────────

// Accepts either {personas:[…]} or a bare [...] array. Each persona: { description,
// chats:[{ criterion?, turns? }] }. A missing/blank criterion = free conversation.
function normalizeImported(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.personas) ? raw.personas : null);
  if (!arr) throw new Error('Expected {"personas":[…]} or a JSON array of personas.');

  return arr.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`Persona ${i + 1} is not an object.`);
    const chatsSrc = Array.isArray(p.chats) ? p.chats : [];
    const chats = chatsSrc.map(c => ({
      criterion: (c && c.criterion != null) ? String(c.criterion) : '',
      turns: Math.max(1, parseInt(c && c.turns) || 4),
    }));
    return {
      description: p.description != null ? String(p.description) : '',
      chats: chats.length ? chats : [{ criterion: '', turns: 4 }],
    };
  });
}

function applyImported(raw) {
  const imported = normalizeImported(raw);
  if (!imported.length) throw new Error('No personas found in the JSON.');
  personas = imported;
  renderPersonas();
  savePersonas();
  setImportStatus(`Imported ${imported.length} persona(s).`, false);
}

function importFromText() {
  const text = document.getElementById('importText').value.trim();
  if (!text) { setImportStatus('Paste some JSON first.', true); return; }
  try {
    applyImported(JSON.parse(text));
  } catch (e) {
    setImportStatus('Import failed: ' + e.message, true);
  }
}

function importFromFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyImported(JSON.parse(reader.result));
    } catch (err) {
      setImportStatus('Import failed: ' + err.message, true);
    }
  };
  reader.onerror = () => setImportStatus('Could not read the file.', true);
  reader.readAsText(file);
  e.target.value = ''; // allow re-importing the same file
}

function setImportStatus(msg, isError) {
  const el = document.getElementById('importStatus');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger, #e5534b)' : 'var(--text-muted)';
}

function downloadTemplate() {
  const template = {
    personas: [
      {
        description: 'A 34-year-old first-time gardener in Oregon, casual and curious.',
        chats: [
          { criterion: 'ask about growing tomato plants', turns: 4 },
          { turns: 3 },
        ],
      },
    ],
  };
  downloadJson(template, 'personas-template.json');
}

// ── Automation controls ───────────────────────────────────────────────────────

function getConfig() {
  return {
    personaStartIndex: parseInt(document.getElementById('cfgPersonaStartIndex').value) || 1,
    testingMode: document.getElementById('cfgTestingMode').checked,
  };
}

function startAutomation() {
  const config = getConfig();

  // A chat is valid with or without a criterion (blank = free conversation); a persona
  // is valid as long as it has at least one chat.
  const validPersonas = personas
    .map(p => ({
      description: p.description,
      chats: p.chats.map(c => ({ criterion: (c.criterion || '').trim(), turns: Math.max(1, parseInt(c.turns) || 4) })),
    }))
    .filter(p => p.chats.length > 0);

  if (!validPersonas.length) {
    alert('Add at least one persona with a chat before starting.');
    return;
  }

  chrome.runtime.sendMessage({ type: 'START', personas: validPersonas, config }, res => {
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
    `Persona ${status.currentBatchIndex + 1} · ${status.resultsCount} collected`;

  if (currentTab === 'results') refreshResults();
  if (currentTab === 'log') refreshLog();
}

// ── Results display ──────────────────────────────────────────────────────────

function refreshResults() {
  chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, res => {
    if (!res?.ok) return;
    renderResults(res.results || []);
  });
}

function renderResults(results) {
  const list = document.getElementById('resultsList');
  const count = document.getElementById('resultsCount');
  count.textContent = `${results.length} turn${results.length !== 1 ? 's' : ''} collected`;

  if (!results.length) {
    list.innerHTML = '<div class="empty">No results yet</div>';
    return;
  }

  list.innerHTML = '';
  // Show newest first
  [...results].reverse().forEach(r => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const chatLabel = (r.chatIndex != null ? ` · Chat ${r.chatIndex + 1}` : '');
    card.innerHTML = `
      <div class="meta">${escHtml(r.personaName)}${chatLabel} · Turn ${r.turnIndex + 1} · ${new Date(r.timestamp).toLocaleTimeString()}</div>
      ${renderVerification(r.verification)}
      <div class="prompt-text">${escHtml(r.prompt.slice(0, 160))}${r.prompt.length > 160 ? '…' : ''}</div>
      <div class="reply-text">${escHtml(r.reply || '(no reply)')}</div>
    `;
    list.appendChild(card);
  });
}

// Show the verifier's verdict + reasoning. If the draft was revised, show what the
// simulator originally wrote vs. what was actually sent.
function renderVerification(v) {
  if (!v) return '';
  const cls = v.approved === null ? 'verdict-flagged' : v.approved ? 'verdict-ok' : (v.usedRevision ? 'verdict-revised' : 'verdict-flagged');
  const revisedNote = v.usedRevision
    ? `<div class="verify-original">orig: ${escHtml((v.original || '').slice(0, 160))}${(v.original || '').length > 160 ? '…' : ''}</div>`
    : '';
  return `
    <div class="verify ${cls}">
      <span class="verify-badge">${escHtml(v.verdict || (v.approved ? 'APPROVED' : 'FLAGGED'))}</span>
      ${v.reason ? `<span class="verify-reason">${escHtml(v.reason)}</span>` : ''}
      ${revisedNote}
    </div>`;
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
  chrome.storage.local.remove(['personaHarvesterLog'], refreshLog);
}

// ── Export / clear ────────────────────────────────────────────────────────────

function exportResults() {
  chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, res => {
    if (!res?.ok) return;
    downloadJson(res.results, 'persona-harvester-export.json');
  });
}

function clearResults() {
  if (!confirm('Clear all collected results?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => refreshResults());
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
