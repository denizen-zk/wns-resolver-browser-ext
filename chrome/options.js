// Defaults are in config.js (loaded via options.html script tag)

const rpcUrlInput = document.getElementById('rpcUrl');
const replaceEnsInput = document.getElementById('replaceEns');
const loggingInput = document.getElementById('logging');
const cacheEnabledInput = document.getElementById('cacheEnabled');
const cacheTtlInput = document.getElementById('cacheTtlMinutes');
const maxBatchSizeInput = document.getElementById('maxBatchSize');
const rpcCooldownMsInput = document.getElementById('rpcCooldownMs');
const clearCacheBtn = document.getElementById('clearCache');
const useSyncInput = document.getElementById('useSync');
const allFramesInput = document.getElementById('allFrames');
const hrefRulesInput = document.getElementById('hrefRules');
const ethReInput = document.getElementById('ethRe');
const abbrReInput = document.getElementById('abbrRe');
const ignoreListInput = document.getElementById('ignoreList');
const headersContainer = document.getElementById('headersContainer');
const addHeaderBtn = document.getElementById('addHeader');
const saveBtn = document.getElementById('save');
const resetBtn = document.getElementById('reset');
const statusEl = document.getElementById('status');

/** Validate that an RPC URL uses HTTPS (or is localhost). */
function isValidRpcUrl(url) {
  if (url.startsWith('https://')) return true;
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return true;
  return false;
}

/**
 * Lightweight ReDoS heuristic — rejects patterns with nested quantifiers
 * that commonly cause catastrophic backtracking (e.g. (a+)+, (.*)*).
 * Returns null if safe, or a reason string if dangerous.
 */
function detectReDoS(pattern) {
  // Nested quantifiers: a quantified group containing a quantified element
  // Matches patterns like (x+)+, (x*)+, (x+)*, (x{2,})+ etc.
  if (/(\([^)]*[+*][^)]*\))[+*]|\(\?:[^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    return 'nested quantifiers (e.g. (a+)+) can cause catastrophic backtracking';
  }
  // Overlapping alternation with quantifiers: (a|a)+
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) {
    const inner = pattern.match(/\(([^)]*\|[^)]*)\)[+*]/);
    if (inner) {
      const alts = inner[1].split('|').map(s => s.replace(/[\\^$.*+?()[\]{}|]/g, ''));
      const unique = new Set(alts);
      if (unique.size < alts.length) {
        return 'overlapping alternation with quantifier can cause backtracking';
      }
    }
  }
  return null;
}

function addHeaderRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML =
    '<input type="text" placeholder="Header name" class="header-key">' +
    '<input type="text" placeholder="Value" class="header-value">' +
    '<button type="button" class="remove-header" title="Remove">\u00d7</button>';
  row.querySelector('.header-key').value = key;
  row.querySelector('.header-value').value = value;
  row.querySelector('.remove-header').addEventListener('click', () => row.remove());
  headersContainer.appendChild(row);
}

function collectHeaders() {
  return [...headersContainer.querySelectorAll('.header-row')].map(row => ({
    key: row.querySelector('.header-key').value.trim(),
    value: row.querySelector('.header-value').value.trim(),
  })).filter(h => h.key);
}

function populateForm(config) {
  rpcUrlInput.value = config.rpcUrl || WNS_DEFAULTS.rpcUrl;
  replaceEnsInput.checked = config.replaceEns;
  loggingInput.checked = config.logging;
  cacheEnabledInput.checked = config.cacheEnabled !== false;
  cacheTtlInput.value = config.cacheTtlMinutes ?? WNS_DEFAULTS.cacheTtlMinutes;
  maxBatchSizeInput.value = config.maxBatchSize ?? WNS_DEFAULTS.maxBatchSize;
  rpcCooldownMsInput.value = config.rpcCooldownMs ?? WNS_DEFAULTS.rpcCooldownMs;
  allFramesInput.checked = config.allFrames !== false;
  ethReInput.value = config.ethRe || WNS_DEFAULTS.ethRe;
  abbrReInput.value = config.abbrRe || WNS_DEFAULTS.abbrRe;
  ignoreListInput.value = (config.ignoreList || []).join('\n');

  // Migrate legacy hrefRe → hrefRules display
  if (config.hrefRules) {
    hrefRulesInput.value = config.hrefRules;
  } else if (config.hrefRe) {
    hrefRulesInput.value = JSON.stringify([{ pattern: config.hrefRe, group: 1 }], null, 2);
  } else {
    hrefRulesInput.value = '';
  }

  // Request Headers
  headersContainer.innerHTML = '';
  if (config.rpcHeaders) {
    try {
      const headers = JSON.parse(config.rpcHeaders);
      headers.forEach(h => addHeaderRow(h.key, h.value));
    } catch { /* ignore bad data */ }
  }
}

// Load useSync flag, then populate form from the active storage area
(async () => {
  const { useSync } = await chrome.storage.local.get({ useSync: false });
  useSyncInput.checked = useSync;
  const config = await getConfig();
  populateForm(config);
})();

addHeaderBtn.addEventListener('click', () => addHeaderRow());

saveBtn.addEventListener('click', async () => {
  const rpcUrl = rpcUrlInput.value.trim() || WNS_DEFAULTS.rpcUrl;

  // Validate RPC URL scheme
  if (!isValidRpcUrl(rpcUrl)) {
    showError('RPC URL must use HTTPS (localhost/127.0.0.1 exempt)');
    return;
  }

  const replaceEns = replaceEnsInput.checked;
  const logging = loggingInput.checked;
  const cacheEnabled = cacheEnabledInput.checked;
  const cacheTtlMinutes = Math.max(1, parseInt(cacheTtlInput.value, 10) || WNS_DEFAULTS.cacheTtlMinutes);
  const maxBatchSize = Math.max(1, Math.min(500, parseInt(maxBatchSizeInput.value, 10) || WNS_DEFAULTS.maxBatchSize));
  const rpcCooldownRaw = parseInt(rpcCooldownMsInput.value, 10);
  const rpcCooldownMs = Math.max(0, Math.min(30000, Number.isNaN(rpcCooldownRaw) ? WNS_DEFAULTS.rpcCooldownMs : rpcCooldownRaw));
  const useSync = useSyncInput.checked;
  const allFrames = allFramesInput.checked;
  const hrefRules = hrefRulesInput.value.trim();
  const ethRe = ethReInput.value.trim();
  const abbrRe = abbrReInput.value.trim();

  // Validate simple regexes
  for (const [label, pattern] of [['Full Address Pattern', ethRe], ['Abbreviated Display Text Pattern', abbrRe]]) {
    if (!pattern) continue;
    try { new RegExp(pattern); } catch {
      showError(`Invalid regex: ${label}`);
      return;
    }
    const redos = detectReDoS(pattern);
    if (redos) {
      showError(`${label}: ${redos}`);
      return;
    }
  }

  // Validate hrefRules JSON + each regex
  if (hrefRules) {
    let arr;
    try { arr = JSON.parse(hrefRules); } catch {
      showError('Custom Href Rules: invalid JSON');
      return;
    }
    if (!Array.isArray(arr)) {
      showError('Custom Href Rules: must be a JSON array');
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (!entry || typeof entry.pattern !== 'string') {
        showError(`Rule ${i + 1}: missing "pattern" string`);
        return;
      }
      try { new RegExp(entry.pattern); } catch {
        showError(`Rule ${i + 1}: invalid regex`);
        return;
      }
      const redos = detectReDoS(entry.pattern);
      if (redos) {
        showError(`Rule ${i + 1}: ${redos}`);
        return;
      }
    }
  }

  const ignoreList = ignoreListInput.value.split('\n').map(s => s.trim()).filter(Boolean);
  const rpcHeaders = JSON.stringify(collectHeaders());
  const configData = { rpcUrl, replaceEns, logging, cacheEnabled, cacheTtlMinutes, maxBatchSize, rpcCooldownMs, allFrames, hrefRules, hrefRe: '', ethRe, abbrRe, ignoreList, rpcHeaders };

  // Handle useSync toggle — migrate config between storage areas if changed
  const { useSync: prevSync } = await chrome.storage.local.get({ useSync: false });
  if (useSync !== prevSync) {
    // Clear config keys from the old storage area
    const oldStore = prevSync ? chrome.storage.sync : chrome.storage.local;
    await oldStore.remove(Object.keys(WNS_DEFAULTS));
  }

  // Persist the useSync flag (always in local)
  await chrome.storage.local.set({ useSync });

  // Write config to the (now active) storage area
  await setConfig(configData);

  chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, () => {
    showSuccess('Saved!');
  });
});

clearCacheBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (response) => {
    if (chrome.runtime.lastError) {
      showSuccess('Cache cleared');
    } else {
      showSuccess(`Cache cleared (${response.cleared} entries)`);
    }
  });
});

resetBtn.addEventListener('click', async () => {
  populateForm(WNS_DEFAULTS);
  useSyncInput.checked = false;
  await chrome.storage.local.set({ useSync: false });
  await setConfig(WNS_DEFAULTS);
  showSuccess('Defaults restored!');
});

function showSuccess(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = '#2a7a2a';
  statusEl.classList.add('visible');
  setTimeout(() => statusEl.classList.remove('visible'), 2000);
}

function showError(msg) {
  statusEl.textContent = msg;
  statusEl.style.color = '#c00';
  statusEl.classList.add('visible');
  setTimeout(() => { statusEl.classList.remove('visible'); statusEl.style.color = ''; }, 3000);
}
