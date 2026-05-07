/* ============================================
   Nexus AI — Chat Page Logic
   Multi-key management + auto-rotation
   ============================================ */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const DOM = {
    chatArea: $('#chat-area'),
    messages: $('#messages'),
    welcome: $('#welcome'),
    input: $('#message-input'),
    btnSend: $('#btn-send'),
    btnNewChat: $('#btn-new-chat'),
    btnMenu: $('#btn-menu'),
    btnExport: $('#btn-export'),
    btnSettings: $('#btn-settings'),
    btnAttach: $('#btn-attach'),
    btnClearAll: $('#btn-clear-all'),
    btnAddKey: $('#btn-add-key'),
    btnTestAll: $('#btn-test-all'),
    sidebar: $('#sidebar'),
    sidebarClose: $('#sidebar-close'),
    sidebarOverlay: $('#sidebar-overlay'),
    chatList: $('#chat-list'),
    topbarTitle: $('#topbar-title'),
    settingsModal: $('#settings-modal'),
    settingsClose: $('#settings-close'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    suggestions: $('#suggestions'),
    settingApiStatus: $('#setting-api-status'),
    apiKeyInput: $('#api-key-input'),
    detectedProvider: $('#detected-provider'),
    modelSelect: $('#model-select'),
    detectedModels: $('#detected-models'),
    keyList: $('#key-list'),
    btnTestLabel: $('#btn-test-label'),
    testResult: $('#test-result'),
    testResultIcon: $('#test-result-icon'),
    testResultTitle: $('#test-result-title'),
    testResultDetails: $('#test-result-details'),
    // Media
    fileInput: $('#file-input'),
    btnCamera: $('#btn-camera'),
    btnMic: $('#btn-mic'),
    attachPreview: $('#attach-preview'),
    voiceIndicator: $('#voice-indicator'),
    voiceText: $('#voice-text'),
    btnVoiceStop: $('#btn-voice-stop'),
    cameraModal: $('#camera-modal'),
    cameraClose: $('#camera-close'),
    cameraVideo: $('#camera-video'),
    cameraCanvas: $('#camera-canvas'),
    cameraPreviewImg: $('#camera-preview-img'),
    btnCameraCapture: $('#btn-camera-capture'),
    btnCameraRetake: $('#btn-camera-retake'),
    btnCameraUse: $('#btn-camera-use'),
  };

  // --- Constants ---
  const STORAGE_KEY = 'nexus_chatbot_state';
  const KEYS_STORAGE = 'nexus_api_keys';      // Array of key objects
  const ACTIVE_IDX = 'nexus_active_key_idx';   // Index of active key
  const MODEL_KEY = 'nexus_model';
  const PROVIDER_KEY = 'nexus_provider';

  const SYSTEM_PROMPT = `You are Nexus, a friendly and brilliant AI assistant. You are helpful, creative, and concise. You use markdown formatting when it improves readability. You excel at coding, writing, analysis, math, and general knowledge. Keep your answers clear and well-structured.`;

  let state = { chats: {}, activeChatId: null, isStreaming: false };

  // Pending attachments for next message
  let pendingAttachments = [];  // [{type:'image', name, dataUrl, mimeType}]
  let cameraStream = null;
  let speechRecognition = null;

  // In-memory store for attachment data (not saved to localStorage — too large)
  const attachmentStore = {};  // messageIndex -> [{type, mimeType, dataUrl, name}]

  // =============================================
  // KEY MANAGEMENT — Multi-key system
  // =============================================

  function getKeys() {
    try {
      const raw = localStorage.getItem(KEYS_STORAGE);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveKeys(keys) {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  }

  function getActiveKeyIndex() {
    return parseInt(localStorage.getItem(ACTIVE_IDX) || '0', 10);
  }

  function setActiveKeyIndex(idx) {
    localStorage.setItem(ACTIVE_IDX, String(idx));
  }

  // Get the currently active API key string
  function getActiveKey() {
    const keys = getKeys();
    const idx = getActiveKeyIndex();
    return keys[idx]?.key || '';
  }

  function addKey(keyStr) {
    const keys = getKeys();
    // Don't add duplicates
    if (keys.some(k => k.key === keyStr)) return false;
    keys.push({
      key: keyStr,
      provider: detectProvider(keyStr) || 'unknown',
      status: 'untested',  // untested, active, ready, quota, error
      label: '',
      addedAt: Date.now(),
    });
    saveKeys(keys);
    // If it's the first key, make it active
    if (keys.length === 1) setActiveKeyIndex(0);
    return true;
  }

  function removeKey(idx) {
    const keys = getKeys();
    keys.splice(idx, 1);
    saveKeys(keys);
    // Adjust active index
    const activeIdx = getActiveKeyIndex();
    if (activeIdx >= keys.length) setActiveKeyIndex(Math.max(0, keys.length - 1));
    else if (idx < activeIdx) setActiveKeyIndex(activeIdx - 1);
  }

  function setKeyAsActive(idx) {
    const keys = getKeys();
    keys.forEach((k, i) => {
      if (i === idx && (k.status === 'ready' || k.status === 'quota' || k.status === 'untested')) {
        k.status = 'active';
      } else if (k.status === 'active') {
        k.status = 'ready';
      }
    });
    setActiveKeyIndex(idx);
    saveKeys(keys);
    updateStatus();
    renderKeyList();
  }

  function maskKey(key) {
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  }

  // Render the list of saved keys
  function renderKeyList() {
    const keys = getKeys();
    const activeIdx = getActiveKeyIndex();

    if (keys.length === 0) {
      DOM.keyList.innerHTML = '<div class="key-list-empty">No API keys added yet</div>';
      return;
    }

    DOM.keyList.innerHTML = keys.map((k, i) => {
      const isActive = i === activeIdx;
      const statusClass = isActive ? 'active' : (k.status || 'untested');
      const statusLabels = {
        active: '● Active — in use',
        ready: '● Ready',
        quota: '● Quota limited',
        error: '● Invalid',
        untested: '● Not tested',
      };
      const label = isActive ? statusLabels.active : (statusLabels[k.status] || statusLabels.untested);

      return `
        <div class="key-item ${isActive ? 'active' : ''}" data-idx="${i}">
          <span class="key-item__status ${statusClass}"></span>
          <div class="key-item__info">
            <span class="key-item__masked">${maskKey(k.key)}</span>
            <span class="key-item__label">${label}${k.provider !== 'unknown' ? ' • ' + (k.provider === 'gemini' ? 'Gemini' : 'OpenAI') : ''}</span>
          </div>
          <button class="key-item__use" data-use="${i}" title="Use this key">Use</button>
          <button class="key-item__delete" data-del="${i}" title="Remove key" aria-label="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
    }).join('');

    // Bind events
    DOM.keyList.querySelectorAll('.key-item__use').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setKeyAsActive(parseInt(btn.dataset.use));
      });
    });

    DOM.keyList.querySelectorAll('.key-item__delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeKey(parseInt(btn.dataset.del));
        renderKeyList();
        updateStatus();
      });
    });
  }

  // Migrate old single-key to multi-key format
  function migrateOldKey() {
    const oldKey = localStorage.getItem('nexus_api_key');
    if (oldKey && getKeys().length === 0) {
      addKey(oldKey);
      localStorage.removeItem('nexus_api_key');
    }
  }

  // =============================================
  // TEST ALL KEYS
  // =============================================

  async function testSingleKey(keyObj, index) {
    const key = keyObj.key;
    const provider = keyObj.provider;

    try {
      if (provider === 'gemini' || provider === 'unknown') {
        const model = 'gemini-2.0-flash';
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Hi, respond with just CONNECTED.' }] }],
              generationConfig: { maxOutputTokens: 20, temperature: 0 },
            }),
          }
        );

        if (response.ok) {
          return { status: 'ready', provider: 'gemini' };
        }

        const err = await response.json().catch(() => ({}));
        const errMsg = err.error?.message || '';

        if (response.status === 429 || errMsg.includes('quota') || errMsg.includes('rate') || err.error?.status === 'RESOURCE_EXHAUSTED') {
          return { status: 'quota', provider: 'gemini' };
        }

        if (provider === 'unknown') return { status: 'error', provider: 'unknown' };
        return { status: 'error', provider: 'gemini', error: errMsg };

      } else if (provider === 'openai') {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Hi, respond with just CONNECTED.' }],
            max_tokens: 10, temperature: 0,
          }),
        });

        if (response.ok) return { status: 'ready', provider: 'openai' };

        const err = await response.json().catch(() => ({}));
        if (response.status === 429) return { status: 'quota', provider: 'openai' };
        return { status: 'error', provider: 'openai', error: err.error?.message };
      }
    } catch (e) {
      return { status: 'error', provider: provider, error: e.message };
    }

    return { status: 'error', provider: 'unknown' };
  }

  async function testAllKeys() {
    const keys = getKeys();
    if (keys.length === 0) {
      showTestResult('error', '❌', 'No Keys Added', 'Add at least one API key above first.');
      return;
    }

    const btnEl = DOM.btnTestAll;
    btnEl.classList.add('testing');
    DOM.btnTestLabel.textContent = `Testing ${keys.length} key${keys.length > 1 ? 's' : ''}...`;
    DOM.testResult.style.display = 'none';

    let readyCount = 0;
    let quotaCount = 0;
    let errorCount = 0;
    let bestKeyIdx = -1;

    for (let i = 0; i < keys.length; i++) {
      DOM.btnTestLabel.textContent = `Testing key ${i + 1}/${keys.length}...`;

      const result = await testSingleKey(keys[i], i);
      keys[i].status = result.status;
      if (result.provider !== 'unknown') keys[i].provider = result.provider;

      if (result.status === 'ready') {
        readyCount++;
        if (bestKeyIdx === -1) bestKeyIdx = i;
      } else if (result.status === 'quota') {
        quotaCount++;
        if (bestKeyIdx === -1) bestKeyIdx = i; // Quota keys are still usable
      } else {
        errorCount++;
      }
    }

    // Auto-select the best working key
    if (bestKeyIdx >= 0) {
      keys[bestKeyIdx].status = 'active';
      setActiveKeyIndex(bestKeyIdx);
      localStorage.setItem(PROVIDER_KEY, keys[bestKeyIdx].provider);
    }

    saveKeys(keys);
    renderKeyList();
    updateStatus();

    // Fetch available models for the active key
    const activeKey = getActiveKey();
    if (activeKey && detectProvider(activeKey) === 'gemini') {
      await fetchAvailableModels(activeKey);
    }

    // Show summary
    const total = keys.length;
    if (readyCount > 0) {
      showTestResult('success', '✅', `${readyCount}/${total} Keys Working!`, [
        ['Ready', `${readyCount} key${readyCount > 1 ? 's' : ''} fully working`],
        ...(quotaCount > 0 ? [['Quota Hit', `${quotaCount} key${quotaCount > 1 ? 's' : ''} (valid but rate-limited)`]] : []),
        ...(errorCount > 0 ? [['Failed', `${errorCount} key${errorCount > 1 ? 's' : ''} invalid`]] : []),
        ['Active', `Using key #${bestKeyIdx + 1} (${maskKey(keys[bestKeyIdx].key)})`],
        ['Status', 'Ready to chat! Keys auto-rotate on quota limits.'],
      ]);
    } else if (quotaCount > 0) {
      showTestResult('success', '⚠️', `${quotaCount}/${total} Keys Valid — All Quota-Limited`, [
        ['Quota Hit', `${quotaCount} key${quotaCount > 1 ? 's' : ''} valid but rate-limited`],
        ...(errorCount > 0 ? [['Failed', `${errorCount} key${errorCount > 1 ? 's' : ''} invalid`]] : []),
        ['Active', `Using key #${bestKeyIdx + 1} — will retry when quota resets`],
        ['Status', 'Add more keys or wait for quota reset.'],
      ]);
    } else {
      showTestResult('error', '❌', 'All Keys Failed', [
        ['Failed', `${errorCount} key${errorCount > 1 ? 's' : ''} invalid or expired`],
        ['Tip', 'Check your keys at ai.google.dev or platform.openai.com'],
      ]);
    }

    btnEl.classList.remove('testing');
    DOM.btnTestLabel.textContent = 'Test All Keys';
  }

  // =============================================
  // PROVIDER & MODEL DETECTION
  // =============================================

  function detectProvider(key) {
    if (!key || key.length < 3) return null;
    if (key.startsWith('AIza')) return 'gemini';
    if (key.startsWith('sk-')) return 'openai';
    return null;
  }

  function getProvider() { return localStorage.getItem(PROVIDER_KEY) || 'gemini'; }
  function getModel() { return localStorage.getItem(MODEL_KEY) || 'gemini-2.0-flash'; }
  function setModel(m) { localStorage.setItem(MODEL_KEY, m); }

  function updateDetectedBadge(key) {
    const d = detectProvider(key);
    if (d === 'gemini') {
      DOM.detectedProvider.innerHTML = `<span class="provider-badge gemini">✦ Gemini key detected</span>`;
    } else if (d === 'openai') {
      DOM.detectedProvider.innerHTML = `<span class="provider-badge openai">⬡ OpenAI key detected</span>`;
    } else if (key && key.length > 2) {
      DOM.detectedProvider.innerHTML = `<span class="provider-badge unknown">? Unknown key format</span>`;
    } else {
      DOM.detectedProvider.innerHTML = '';
    }
  }

  async function fetchAvailableModels(key) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      if (!response.ok) return null;

      const data = await response.json();
      if (!data.models) return null;

      const chatModels = data.models.filter(m => m.supportedGenerationMethods?.includes('generateContent'));

      const priority = ['gemini-2.5-pro','gemini-2.5-flash','gemini-2.0-flash-exp','gemini-2.0-flash','gemini-2.0-flash-lite','gemini-1.5-pro','gemini-1.5-flash','gemini-1.5-flash-8b'];

      const sorted = chatModels.sort((a, b) => {
        const aIdx = priority.findIndex(p => a.name.replace('models/', '').startsWith(p));
        const bIdx = priority.findIndex(p => b.name.replace('models/', '').startsWith(p));
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });

      const modelNames = sorted.map(m => ({
        id: m.name.replace('models/', ''),
        displayName: m.displayName || m.name.replace('models/', ''),
        inputLimit: m.inputTokenLimit ? `${Math.round(m.inputTokenLimit / 1000)}K ctx` : '',
      }));

      if (modelNames.length > 0) {
        const existing = DOM.modelSelect.querySelector('#gemini-detected');
        if (existing) existing.remove();

        const optgroup = document.createElement('optgroup');
        optgroup.label = `✦ Your Models (${modelNames.length} available)`;
        optgroup.id = 'gemini-detected';
        modelNames.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${m.displayName}${m.inputLimit ? ' — ' + m.inputLimit : ''}`;
          optgroup.appendChild(opt);
        });
        DOM.modelSelect.insertBefore(optgroup, DOM.modelSelect.firstChild);

        DOM.modelSelect.value = modelNames[0].id;
        setModel(modelNames[0].id);
        DOM.detectedModels.innerHTML = `<span class="provider-badge gemini">✦ ${modelNames.length} models — using ${modelNames[0].displayName}</span>`;
      }

      return modelNames;
    } catch (e) {
      console.warn('Could not fetch models:', e);
      return null;
    }
  }

  // =============================================
  // STATUS
  // =============================================

  function updateStatus() {
    const keys = getKeys();
    const activeKey = getActiveKey();
    const provider = getProvider();
    const readyKeys = keys.filter(k => k.status === 'active' || k.status === 'ready' || k.status === 'quota');

    if (readyKeys.length > 0) {
      DOM.statusDot.className = 'status-dot live';
      DOM.statusText.textContent = `${readyKeys.length} key${readyKeys.length > 1 ? 's' : ''} • ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}`;
      DOM.settingApiStatus.textContent = `✅ ${readyKeys.length} key${readyKeys.length > 1 ? 's' : ''} connected`;
      DOM.settingApiStatus.style.color = 'var(--accent-cyan)';
    } else if (keys.length > 0) {
      DOM.statusDot.className = 'status-dot demo';
      DOM.statusText.textContent = 'Keys untested';
      DOM.settingApiStatus.textContent = `⚪ ${keys.length} key${keys.length > 1 ? 's' : ''} — tap Test All`;
      DOM.settingApiStatus.style.color = 'var(--text-tertiary)';
    } else {
      DOM.statusDot.className = 'status-dot demo';
      DOM.statusText.textContent = 'Demo Mode';
      DOM.settingApiStatus.textContent = '⚪ No keys — Demo mode';
      DOM.settingApiStatus.style.color = 'var(--text-tertiary)';
    }
  }

  function showTestResult(type, icon, title, details) {
    DOM.testResult.style.display = 'block';
    DOM.testResult.className = `test-result ${type}`;
    DOM.testResultIcon.textContent = icon;
    DOM.testResultTitle.textContent = title;

    if (typeof details === 'string') {
      DOM.testResultDetails.innerHTML = `<span class="test-result__detail-value">${escapeHTML(details)}</span>`;
    } else {
      DOM.testResultDetails.innerHTML = details.map(([label, value]) => {
        const hl = label === 'Status';
        return `<span class="test-result__detail-label">${escapeHTML(label)}</span><span class="test-result__detail-value${hl ? ' highlight' : ''}">${escapeHTML(value)}</span>`;
      }).join('');
    }
  }

  // =============================================
  // CHAT MANAGEMENT
  // =============================================

  function saveState() {
    try {
      // Strip attachments from messages before saving (too large for localStorage)
      const cleanChats = {};
      for (const [id, chat] of Object.entries(state.chats)) {
        cleanChats[id] = {
          ...chat,
          messages: chat.messages.map(m => {
            const { attachments, ...rest } = m;
            return rest;
          }),
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats: cleanChats, activeChatId: state.activeChatId }));
    } catch (e) { /* storage full */ }
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.chats) { state.chats = saved.chats; state.activeChatId = saved.activeChatId; }
    } catch (e) {}
  }

  function createChat() {
    const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    state.chats[id] = { id, title: 'New Chat', messages: [], createdAt: Date.now() };
    state.activeChatId = id;
    saveState(); renderSidebar(); renderChat();
    DOM.input.focus(); closeSidebar();
  }

  function switchChat(id) {
    if (!state.chats[id]) return;
    state.activeChatId = id;
    saveState(); renderSidebar(); renderChat(); closeSidebar();
  }

  function deleteChat(id) {
    delete state.chats[id];
    if (state.activeChatId === id) {
      const ids = Object.keys(state.chats);
      state.activeChatId = ids.length ? ids[ids.length - 1] : null;
    }
    saveState(); renderSidebar(); renderChat();
  }

  function getActiveChat() { return state.chats[state.activeChatId] || null; }

  function generateTitle(content) {
    const clean = content.replace(/[#*`]/g, '').trim();
    return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
  }

  // =============================================
  // RENDER SIDEBAR
  // =============================================

  function renderSidebar() {
    const chatIds = Object.keys(state.chats).sort((a, b) => state.chats[b].createdAt - state.chats[a].createdAt);

    if (chatIds.length === 0) {
      DOM.chatList.innerHTML = `<div style="padding:12px;font-size:0.8rem;color:var(--text-tertiary)">No conversations yet</div>`;
      return;
    }

    DOM.chatList.innerHTML = chatIds.map(id => {
      const chat = state.chats[id];
      const isActive = id === state.activeChatId;
      return `
        <div class="chat-item ${isActive ? 'active' : ''}" data-id="${id}">
          <span class="chat-item__icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          <span class="chat-item__text">${escapeHTML(chat.title)}</span>
          <button class="chat-item__delete" data-delete="${id}" title="Delete" aria-label="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;
    }).join('');

    DOM.chatList.querySelectorAll('.chat-item').forEach(el => {
      el.addEventListener('click', (e) => { if (!e.target.closest('.chat-item__delete')) switchChat(el.dataset.id); });
    });
    DOM.chatList.querySelectorAll('.chat-item__delete').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(btn.dataset.delete); });
    });
  }

  // =============================================
  // RENDER CHAT
  // =============================================

  function renderChat() {
    const chat = getActiveChat();
    if (!chat || chat.messages.length === 0) {
      DOM.welcome.style.display = 'flex'; DOM.messages.style.display = 'none'; DOM.messages.innerHTML = '';
      DOM.topbarTitle.textContent = chat ? chat.title : 'New Chat';
      return;
    }
    DOM.welcome.style.display = 'none'; DOM.messages.style.display = 'flex';
    DOM.topbarTitle.textContent = chat.title;
    DOM.messages.innerHTML = chat.messages.map((msg, i) => createMessageHTML(msg.role, msg.content, i)).join('');
    scrollToBottom();
  }

  function createMessageHTML(role, content, index) {
    const isUser = role === 'user';
    const avatar = isUser ? 'U' : '✦';
    const name = isUser ? 'You' : 'Nexus';
    const rendered = isUser ? escapeHTML(content).replace(/\n/g, '<br>') : renderMarkdown(content);
    return `<div class="message ${role}" data-index="${index}"><div class="msg-row"><div class="msg-avatar">${avatar}</div><div class="msg-content"><div class="msg-role">${name}</div><div class="msg-body">${rendered}</div></div></div></div>`;
  }

  // =============================================
  // MARKDOWN RENDERER
  // =============================================

  function renderMarkdown(text) {
    if (!text) return '';
    let html = text;
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><div class="code-header"><span>${lang || 'code'}</span><button class="code-copy-btn" onclick="window.__copyCode(this)">Copy</button></div><code>${escapeHTML(code.trim())}</code></pre>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<(h[1-3]|ul|ol|pre|blockquote|hr)/g, '<$1');
    html = html.replace(/<\/(h[1-3]|ul|ol|pre|blockquote|hr)>\s*<\/p>/g, '</$1>');
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  window.__copyCode = function (btn) {
    const code = btn.closest('pre').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  };

  // =============================================
  // DEMO RESPONSES
  // =============================================

  function getDemoResponse(msg) {
    const m = msg.toLowerCase();
    if (m.includes('hello') || m.includes('hi') || m.includes('hey'))
      return `Hey there! 👋 I'm **Nexus**, your AI assistant.\n\nI'm running in **demo mode** — no API keys connected yet.\n\nTo get real AI responses:\n1. Click ⚙️ **Settings**\n2. Add your **Gemini API key(s)**\n3. Click **Test All Keys**\n\nYou can add multiple keys and I'll auto-rotate between them!`;
    if (m.includes('code') || m.includes('python') || m.includes('javascript') || m.includes('function'))
      return `Here's a **quicksort** implementation:\n\n\`\`\`python\ndef quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[-1]\n    left = [x for x in arr[:-1] if x <= pivot]\n    right = [x for x in arr[:-1] if x > pivot]\n    return quicksort(left) + [pivot] + quicksort(right)\n\nprint(quicksort([38, 27, 43, 3, 9, 82, 10]))\n\`\`\`\n\n*Demo mode — add your API keys for real help!*`;
    if (m.includes('quantum'))
      return `# Quantum Computing 🧬\n\nClassical bits: **0** or **1**\nQubits: **0**, **1**, or **both!** (superposition)\n\n## Applications\n1. **Drug discovery** — molecular simulation\n2. **Cryptography** — breaking & making codes\n3. **AI** — faster model training\n4. **Finance** — portfolio optimization\n\n> A classical computer reads one page at a time; a quantum computer reads all pages simultaneously.\n\n*Demo — add API keys for real explanations!*`;
    if (m.includes('help'))
      return `I can help with:\n- 💻 **Coding** — write, debug, explain\n- ✍️ **Writing** — emails, essays, stories\n- 📊 **Analysis** — data & concepts\n- 🧮 **Math** — equations & problems\n- 🌎 **Knowledge** — any topic\n\n*Add your API keys in ⚙️ Settings!*`;
    return `Thanks! 💬 I'm in **demo mode**.\n\nTo get real AI responses, add your Gemini API key(s) in ⚙️ **Settings** and click **Test All Keys**.\n\nI support **multiple keys** — I'll auto-rotate when one hits a rate limit!\n\n---\n*Try "hello", "help", "code", or "quantum"!*`;
  }

  // =============================================
  // Cache for available models per key (avoids repeated ListModels calls)
  const modelCache = {};

  async function getModelsForKey(apiKey) {
    // Return cached if available (cache for 5 minutes)
    const cached = modelCache[apiKey];
    if (cached && Date.now() - cached.time < 300000) return cached.models;

    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.models) return null;

      // Only models that support generateContent (chat)
      const chatModels = data.models
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));

      modelCache[apiKey] = { models: chatModels, time: Date.now() };
      console.log(`Key models: ${chatModels.join(', ')}`);
      return chatModels;
    } catch {
      return null;
    }
  }

  // Priority order — try these first if available
  const MODEL_PRIORITY = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.5-pro-preview-05-06',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

  async function callGeminiAPI(apiKey, messages) {
    const selectedModel = getModel();

    // Build Gemini message format — includes image attachments as inline_data
    const geminiMessages = messages.slice(-20).map(m => {
      const parts = [];
      if (m.content) parts.push({ text: m.content });

      // Add image attachments as inline_data
      if (m.attachments) {
        m.attachments.forEach(att => {
          if (att.type === 'image' && att.dataUrl) {
            const base64 = att.dataUrl.split(',')[1]; // Strip "data:image/jpeg;base64,"
            parts.push({ inline_data: { mime_type: att.mimeType || 'image/jpeg', data: base64 } });
          } else if (att.type === 'file' && att.dataUrl) {
            // For text files, extract content and add as text
            try {
              const decoded = atob(att.dataUrl.split(',')[1]);
              parts.push({ text: `[File: ${att.name}]\n${decoded}` });
            } catch { parts.push({ text: `[Attached file: ${att.name}]` }); }
          }
        });
      }

      if (parts.length === 0) parts.push({ text: '(empty)' });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    // Step 1: Get REAL models available for this key
    const availableModels = await getModelsForKey(apiKey);

    let modelsToTry;
    if (availableModels && availableModels.length > 0) {
      // Use real models: selected first (if available), then by priority, then rest
      const selected = availableModels.includes(selectedModel) ? [selectedModel] : [];
      const prioritized = MODEL_PRIORITY.filter(m => availableModels.includes(m) && m !== selectedModel);
      const rest = availableModels.filter(m => m !== selectedModel && !MODEL_PRIORITY.includes(m));
      modelsToTry = [...selected, ...prioritized, ...rest];
    } else {
      // Couldn't fetch model list — try selected + safe defaults
      modelsToTry = [selectedModel, 'gemini-2.0-flash', 'gemini-2.0-flash-lite'].filter((v, i, a) => a.indexOf(v) === i);
    }

    console.log(`Trying models in order: ${modelsToTry.join(', ')}`);

    let lastError = '';
    let anyQuota = false;

    for (const model of modelsToTry) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: geminiMessages,
              generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
            }),
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const errMsg = err.error?.message || `HTTP ${response.status}`;
          const isQuota = response.status === 429 || errMsg.includes('quota') || errMsg.includes('rate');

          if (isQuota) anyQuota = true;
          console.log(`Model ${model}: ${isQuota ? 'quota' : 'error'} — trying next...`);
          lastError = errMsg;
          continue;
        }

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';

        // If fell back to different model, update selection
        if (model !== selectedModel) {
          console.log(`Using ${model} (${selectedModel} was unavailable)`);
          DOM.modelSelect.value = model;
          setModel(model);
        }

        return reply;

      } catch (error) {
        lastError = error.message || 'Network error';
        continue;
      }
    }

    throw { message: lastError, isQuota: anyQuota };
  }

  async function callOpenAIAPI(apiKey, messages) {
    const model = getModel().startsWith('gpt') ? getModel() : 'gpt-4o-mini';
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: apiMessages, max_tokens: 2048, temperature: 0.7 }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw { message: err.error?.message || `HTTP ${response.status}`, isQuota: response.status === 429 };
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
  }

  // Try sending with auto-rotation through available keys
  async function sendWithKeyRotation(chat) {
    const keys = getKeys();
    const activeIdx = getActiveKeyIndex();

    // Build order: active key first, then ALL others (try every key, even 'error' ones — they may work now)
    const order = [activeIdx, ...keys.map((_, i) => i).filter(i => i !== activeIdx)];
    // Filter only to valid indices
    const validOrder = order.filter(i => keys[i]);

    let lastError = 'No API keys available.';

    for (const idx of validOrder) {
      const k = keys[idx];
      try {
        let reply;
        if (k.provider === 'openai') {
          reply = await callOpenAIAPI(k.key, chat.messages);
        } else {
          // Default: try as Gemini (covers 'gemini' and 'unknown')
          reply = await callGeminiAPI(k.key, chat.messages);
          if (k.provider === 'unknown') k.provider = 'gemini';
        }

        // Success! Mark this key as active
        keys.forEach((kk, ii) => { kk.status = ii === idx ? 'active' : (kk.status === 'active' ? 'ready' : kk.status); });
        setActiveKeyIndex(idx);
        saveKeys(keys);
        renderKeyList();
        updateStatus();

        return reply;

      } catch (error) {
        lastError = error.message || 'Unknown error';
        if (error.isQuota) {
          keys[idx].status = 'quota';
          saveKeys(keys);
          console.log(`Key #${idx + 1} quota hit, rotating to next...`);
          continue;
        }
        // Other errors — still try next key
        console.log(`Key #${idx + 1} failed: ${error.message}, trying next...`);
        continue;
      }
    }

    // All keys tried — none worked
    renderKeyList();
    updateStatus();

    // Give a clear, friendly error
    const isAllQuota = keys.every(k => k.status === 'quota');
    if (isAllQuota) {
      throw new Error('Your Gemini free tier quota is temporarily exhausted on all keys. Free tier resets every minute — just wait a moment and try again!');
    }
    throw new Error(`Tried ${keys.length} key(s) across multiple models but none worked. Check your keys in Settings.`);
  }

  async function sendMessage(content) {
    const text = (content || '').trim();
    if (!text && pendingAttachments.length === 0) return;
    if (state.isStreaming) return;

    // Grab attachments before clearing
    const attachments = [...pendingAttachments];
    clearAttachments();
    stopVoice();

    let chat = getActiveChat();
    if (!chat) { createChat(); chat = getActiveChat(); }

    // Build display content (text + image indicators)
    const displayContent = text + (attachments.length > 0 ? '\n' + attachments.map(a => a.type === 'image' ? `📷 ${a.name}` : `📄 ${a.name}`).join('\n') : '');
    const msgContent = text || (attachments.length > 0 ? `[Sent ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}]` : '');

    // Store attachments data with the message for API use (in memory only, not localStorage)
    const userMsg = { role: 'user', content: msgContent };
    if (attachments.length > 0) {
      userMsg.attachments = attachments.map(a => ({ type: a.type, mimeType: a.mimeType, dataUrl: a.dataUrl, name: a.name }));
    }
    chat.messages.push(userMsg);

    if (chat.messages.length === 1) { chat.title = generateTitle(msgContent); renderSidebar(); }

    DOM.input.value = '';
    DOM.input.style.height = 'auto';
    updateSendButton();
    saveState();

    DOM.welcome.style.display = 'none';
    DOM.messages.style.display = 'flex';
    DOM.topbarTitle.textContent = chat.title;

    // Show user message with image thumbnails
    let userHTML = createMessageHTML('user', msgContent, chat.messages.length - 1);
    if (attachments.some(a => a.type === 'image')) {
      const thumbsHTML = attachments.filter(a => a.type === 'image').map(a => `<img src="${a.dataUrl}" style="max-width:200px;max-height:150px;border-radius:8px;margin-top:8px;display:block" alt="${escapeHTML(a.name)}">`).join('');
      userHTML = userHTML.replace('</div></div></div>', thumbsHTML + '</div></div></div>');
    }
    DOM.messages.insertAdjacentHTML('beforeend', userHTML);
    scrollToBottom();

    // Typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'message assistant';
    typingEl.innerHTML = `<div class="msg-row"><div class="msg-avatar">✦</div><div class="msg-content"><div class="msg-role">Nexus</div><div class="msg-body"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div></div></div>`;
    DOM.messages.appendChild(typingEl);
    scrollToBottom();

    state.isStreaming = true;
    let reply = '';

    try {
      const keys = getKeys();
      const hasKeys = keys.length > 0;

      if (!hasKeys) {
        await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
        reply = getDemoResponse(msgContent);
      } else {
        reply = await sendWithKeyRotation(chat);
      }

      typingEl.remove();
      chat.messages.push({ role: 'assistant', content: reply });
      saveState();

      const msgEl = document.createElement('div');
      msgEl.className = 'message assistant';
      msgEl.innerHTML = `<div class="msg-row"><div class="msg-avatar">✦</div><div class="msg-content"><div class="msg-role">Nexus</div><div class="msg-body"></div></div></div>`;
      DOM.messages.appendChild(msgEl);

      const bodyEl = msgEl.querySelector('.msg-body');
      bodyEl.innerHTML = renderMarkdown(reply);
      bodyEl.style.opacity = '0';
      bodyEl.style.transform = 'translateY(6px)';
      bodyEl.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
      requestAnimationFrame(() => { bodyEl.style.opacity = '1'; bodyEl.style.transform = 'translateY(0)'; });

    } catch (error) {
      typingEl.remove();
      reply = `⚠️ **Error:** ${error.message}\n\nAll keys were tried. Add more keys or wait for quota reset.`;
      chat.messages.push({ role: 'assistant', content: reply });
      saveState();
      DOM.messages.insertAdjacentHTML('beforeend', createMessageHTML('assistant', reply, chat.messages.length - 1));
    }

    state.isStreaming = false;
    scrollToBottom();
  }

  // =============================================
  // UTILITIES
  // =============================================

  function escapeHTML(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
  function scrollToBottom() { requestAnimationFrame(() => { DOM.chatArea.scrollTop = DOM.chatArea.scrollHeight; }); }

  function updateSendButton() {
    const hasText = DOM.input.value.trim().length > 0;
    const hasAttach = pendingAttachments.length > 0;
    const canSend = (hasText || hasAttach) && !state.isStreaming;
    DOM.btnSend.classList.toggle('active', canSend);
    DOM.btnSend.disabled = !canSend;
  }

  function autoResize() {
    DOM.input.style.height = 'auto';
    DOM.input.style.height = Math.min(DOM.input.scrollHeight, 150) + 'px';
  }

  function openSidebar() { DOM.sidebar.classList.add('open'); DOM.sidebarOverlay.classList.add('open'); }
  function closeSidebar() { DOM.sidebar.classList.remove('open'); DOM.sidebarOverlay.classList.remove('open'); }

  function exportChat() {
    const chat = getActiveChat();
    if (!chat || chat.messages.length === 0) return;
    let text = `# ${chat.title}\n\nExported from Nexus AI — ${new Date().toLocaleString()}\n\n---\n\n`;
    chat.messages.forEach(msg => { text += `**${msg.role === 'user' ? 'You' : 'Nexus'}:**\n${msg.content}\n\n`; });
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `nexus-chat-${chat.id}.md`; a.click();
    URL.revokeObjectURL(url);
  }

  // =============================================
  // FILE ATTACHMENT
  // =============================================

  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const isImage = file.type.startsWith('image/');
        pendingAttachments.push({
          type: isImage ? 'image' : 'file',
          name: file.name,
          mimeType: file.type,
          dataUrl: reader.result,
          size: file.size,
        });
        renderAttachmentPreview();
        updateSendButton();
      };
      reader.readAsDataURL(file);
    });
    DOM.fileInput.value = '';  // Reset so same file can be selected again
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      DOM.attachPreview.style.display = 'none';
      DOM.attachPreview.innerHTML = '';
      return;
    }

    DOM.attachPreview.style.display = 'flex';
    DOM.attachPreview.innerHTML = pendingAttachments.map((att, i) => {
      if (att.type === 'image') {
        return `<div class="attach-chip"><img src="${att.dataUrl}" class="attach-chip__thumb" alt="${escapeHTML(att.name)}" /><span class="attach-chip__name">${escapeHTML(att.name)}</span><button class="attach-chip__remove" data-idx="${i}" title="Remove">×</button></div>`;
      }
      return `<div class="attach-chip"><span class="attach-chip__icon">📄</span><span class="attach-chip__name">${escapeHTML(att.name)}</span><button class="attach-chip__remove" data-idx="${i}" title="Remove">×</button></div>`;
    }).join('');

    DOM.attachPreview.querySelectorAll('.attach-chip__remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingAttachments.splice(parseInt(btn.dataset.idx), 1);
        renderAttachmentPreview();
        updateSendButton();
      });
    });
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachmentPreview();
  }

  // =============================================
  // CAMERA
  // =============================================

  async function openCamera() {
    // Camera requires HTTPS or localhost
    if (location.protocol === 'file:') {
      alert('📸 Camera requires a web server.\n\nRun: node server.js\nThen open: http://localhost:3000/chat.html');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('📸 Camera not supported in this browser. Try Chrome or Edge.');
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      DOM.cameraVideo.srcObject = cameraStream;
      DOM.cameraVideo.style.display = 'block';
      DOM.cameraPreviewImg.style.display = 'none';
      DOM.btnCameraCapture.style.display = '';
      DOM.btnCameraRetake.style.display = 'none';
      DOM.btnCameraUse.style.display = 'none';
      DOM.cameraModal.classList.add('open');
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        alert('📸 Camera access was denied.\n\nPlease allow camera permission in your browser settings and try again.');
      } else if (err.name === 'NotFoundError') {
        alert('📸 No camera found on this device.');
      } else {
        alert(`📸 Camera error: ${err.message}\n\nMake sure you're running on http://localhost or HTTPS.`);
      }
    }
  }

  function closeCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    DOM.cameraVideo.srcObject = null;
    DOM.cameraModal.classList.remove('open');
  }

  function capturePhoto() {
    const video = DOM.cameraVideo;
    const canvas = DOM.cameraCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    DOM.cameraVideo.style.display = 'none';
    DOM.cameraPreviewImg.src = dataUrl;
    DOM.cameraPreviewImg.style.display = 'block';
    DOM.btnCameraCapture.style.display = 'none';
    DOM.btnCameraRetake.style.display = '';
    DOM.btnCameraUse.style.display = '';

    // Pause the stream
    if (cameraStream) cameraStream.getTracks().forEach(t => t.enabled = false);
  }

  function retakePhoto() {
    DOM.cameraVideo.style.display = 'block';
    DOM.cameraPreviewImg.style.display = 'none';
    DOM.btnCameraCapture.style.display = '';
    DOM.btnCameraRetake.style.display = 'none';
    DOM.btnCameraUse.style.display = 'none';
    if (cameraStream) cameraStream.getTracks().forEach(t => t.enabled = true);
  }

  function usePhoto() {
    const dataUrl = DOM.cameraPreviewImg.src;
    pendingAttachments.push({
      type: 'image',
      name: 'camera-photo.jpg',
      mimeType: 'image/jpeg',
      dataUrl,
      size: 0,
    });
    renderAttachmentPreview();
    updateSendButton();
    closeCamera();
  }

  // =============================================
  // VOICE INPUT (Web Speech API)
  // =============================================

  function toggleVoice() {
    if (speechRecognition) {
      stopVoice();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Try Chrome.');
      return;
    }

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';

    let finalTranscript = DOM.input.value;

    speechRecognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      DOM.input.value = finalTranscript + interim;
      DOM.voiceText.textContent = interim ? `"${interim}"` : 'Listening...';
      updateSendButton();
      autoResize();
    };

    speechRecognition.onerror = (e) => {
      console.warn('Speech error:', e.error);
      stopVoice();
    };

    speechRecognition.onend = () => {
      // Auto-restart if still active
      if (speechRecognition) {
        try { speechRecognition.start(); } catch {}
      }
    };

    speechRecognition.start();
    DOM.btnMic.classList.add('recording');
    DOM.voiceIndicator.style.display = 'flex';
    DOM.voiceText.textContent = 'Listening...';
  }

  function stopVoice() {
    if (speechRecognition) {
      speechRecognition.onend = null;
      speechRecognition.stop();
      speechRecognition = null;
    }
    DOM.btnMic.classList.remove('recording');
    DOM.voiceIndicator.style.display = 'none';
    updateSendButton();
  }

  // =============================================
  // INIT
  // =============================================

  function init() {
    migrateOldKey();
    loadState();
    renderSidebar();
    renderKeyList();

    if (state.activeChatId && state.chats[state.activeChatId]) renderChat();

    DOM.modelSelect.value = getModel();
    updateStatus();

    // --- Events ---
    DOM.input.addEventListener('input', () => { updateSendButton(); autoResize(); });
    DOM.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if ((DOM.input.value.trim() || pendingAttachments.length > 0) && !state.isStreaming) sendMessage(DOM.input.value);
      }
    });
    DOM.btnSend.addEventListener('click', () => {
      if ((DOM.input.value.trim() || pendingAttachments.length > 0) && !state.isStreaming) sendMessage(DOM.input.value);
    });

    DOM.btnNewChat.addEventListener('click', createChat);
    DOM.btnMenu.addEventListener('click', openSidebar);
    DOM.sidebarClose.addEventListener('click', closeSidebar);
    DOM.sidebarOverlay.addEventListener('click', closeSidebar);
    DOM.btnExport.addEventListener('click', exportChat);

    // --- File Attachment ---
    DOM.btnAttach.addEventListener('click', () => DOM.fileInput.click());
    DOM.fileInput.addEventListener('change', handleFileSelect);

    // --- Camera ---
    DOM.btnCamera.addEventListener('click', openCamera);
    DOM.cameraClose.addEventListener('click', closeCamera);
    DOM.cameraModal.addEventListener('click', (e) => { if (e.target === DOM.cameraModal) closeCamera(); });
    DOM.btnCameraCapture.addEventListener('click', capturePhoto);
    DOM.btnCameraRetake.addEventListener('click', retakePhoto);
    DOM.btnCameraUse.addEventListener('click', usePhoto);

    // --- Mic ---
    DOM.btnMic.addEventListener('click', toggleVoice);
    DOM.btnVoiceStop.addEventListener('click', stopVoice);

    // Settings modal
    DOM.btnSettings.addEventListener('click', () => DOM.settingsModal.classList.add('open'));
    DOM.settingsClose.addEventListener('click', () => DOM.settingsModal.classList.remove('open'));
    DOM.settingsModal.addEventListener('click', (e) => { if (e.target === DOM.settingsModal) DOM.settingsModal.classList.remove('open'); });

    // Add Key
    DOM.btnAddKey.addEventListener('click', () => {
      const key = DOM.apiKeyInput.value.trim();
      if (!key) return;
      const added = addKey(key);
      if (!added) {
        DOM.detectedProvider.innerHTML = '<span class="provider-badge unknown">Key already added</span>';
        return;
      }
      DOM.apiKeyInput.value = '';
      DOM.detectedProvider.innerHTML = '';
      renderKeyList();
      updateStatus();
    });

    DOM.apiKeyInput.addEventListener('input', () => updateDetectedBadge(DOM.apiKeyInput.value.trim()));
    DOM.apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); DOM.btnAddKey.click(); }
    });

    // Test All Keys
    DOM.btnTestAll.addEventListener('click', testAllKeys);

    // Model select
    DOM.modelSelect.addEventListener('change', () => setModel(DOM.modelSelect.value));

    // Clear all
    DOM.btnClearAll.addEventListener('click', () => {
      if (confirm('Delete all conversations? This cannot be undone.')) {
        state.chats = {}; state.activeChatId = null;
        saveState(); renderSidebar(); renderChat();
        DOM.settingsModal.classList.remove('open');
      }
    });

    // Suggestions
    DOM.suggestions.querySelectorAll('.suggestion').forEach(card => {
      card.addEventListener('click', () => {
        const prompt = card.dataset.prompt;
        if (prompt) { DOM.input.value = prompt; updateSendButton(); sendMessage(prompt); }
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); createChat(); }
      if (e.key === 'Escape') { DOM.settingsModal.classList.remove('open'); closeSidebar(); }
    });

    if (window.innerWidth > 768) DOM.input.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
