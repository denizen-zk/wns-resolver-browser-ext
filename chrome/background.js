/**
 * WNS Address Resolver — background service worker
 *
 * Owns all network calls (avoids CORS issues from content scripts on
 * file:// origins). Listens for RESOLVE messages from content.js,
 * reads provider config from the active storage area, and returns a map
 * of address → name.
 */

importScripts('config.js');

const WNS_CONTRACT = '0x0000000000696760E15f265e828DB644A0c242EB';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// reverseResolve(address) — keccak256("reverseResolve(address)")[0..3]
const REVERSE_RESOLVE_SELECTOR = '0x9af8b7aa';

// aggregate3((address target, bool allowFailure, bytes calldata)[]) — Multicall3
const AGGREGATE3_SELECTOR = '0x82ad56cb';

// Defaults are in config.js (imported via manifest)

let loggingEnabled = false;
getConfig().then(s => { loggingEnabled = s.logging; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.logging) loggingEnabled = changes.logging.newValue;
});
function log(...args) { if (loggingEnabled) console.log('[WNS bg]', ...args); }

// ─── ABI helpers ─────────────────────────────────────────────────────────────

/** Hex chars per 32-byte ABI word. */
const W = 64;

/** Left-pad a hex string to a full 32-byte word. */
function pad32(hex) {
  return hex.padStart(W, '0');
}

/** Encode reverseResolve(address) calldata for one address. */
function encodeReverseResolve(address) {
  const addr = address.toLowerCase().replace('0x', '');
  return REVERSE_RESOLVE_SELECTOR + pad32(addr);
}

/**
 * ABI-encode an aggregate3 call for Multicall3.
 */
function encodeMulticall(addresses) {
  const n = addresses.length;
  const ELEMENT_WORDS = 6;

  const words = [];

  // Top-level: offset to the Call3[] array = 0x20
  words.push(pad32('20'));
  // Array length
  words.push(pad32(n.toString(16)));
  // Offsets to each element, relative to the word after the length word.
  // The head itself contains N offset words (N*32 bytes) before element data begins.
  for (let i = 0; i < n; i++) {
    words.push(pad32((n * 32 + i * ELEMENT_WORDS * 32).toString(16)));
  }

  // Each element encoding
  const wnsTarget = WNS_CONTRACT.toLowerCase().replace('0x', '');
  for (const addr of addresses) {
    const cd = encodeReverseResolve(addr).slice(2); // 72 hex chars = 36 bytes
    words.push(pad32(wnsTarget));    // target = WNS contract (not the address being resolved)
    words.push(pad32('1'));          // bool allowFailure = true
    words.push(pad32('60'));         // offset to bytes data within struct = 3 words
    words.push(pad32('24'));         // bytes length = 36 (0x24)
    words.push(cd.slice(0, W));      // first 32 bytes of calldata
    words.push(cd.slice(W).padEnd(W, '0')); // remaining 4 bytes, padded to 32
  }

  return AGGREGATE3_SELECTOR + words.join('');
}

const MAX_NAME_LENGTH = 64;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Convert a hex string to a Uint8Array. */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Sanitize a resolved name: strip control characters, bidi overrides,
 * zero-width characters, and truncate to MAX_NAME_LENGTH.
 */
function sanitizeName(name) {
  // Strip: C0/C1 control chars, bidi overrides, zero-width chars
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH) : cleaned;
}

/**
 * Decode the aggregate3 return value.
 * Returns array of name strings (or null for failed/empty results).
 */
function decodeAggregate3(hex) {
  if (!hex || hex === '0x') return [];
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;

  const word = (pos) => data.slice(pos, pos + W);
  const uint = (pos) => parseInt(word(pos), 16);

  // Word 0: offset to array = 0x20 (skip it)
  // Word 1: array length
  const n = uint(W);
  if (!n) return [];

  const names = [];
  const arrayBase = 2 * W; // after word0 (offset) + word1 (length)

  for (let i = 0; i < n; i++) {
    const offset = uint(arrayBase + i * W) * 2;
    const base = arrayBase + offset;

    const success = uint(base) === 1;
    if (!success) { names.push(null); continue; }

    // offset to `bytes returnData` within this Result struct
    const bytesOffset = uint(base + W) * 2;
    const bytesBase = base + bytesOffset;
    const bytesLen = uint(bytesBase);
    if (!bytesLen) { names.push(null); continue; }
    // the raw returnData bytes (themselves abi.encode(string))
    // abi.encode(string) = offset(0x20) | strLen | strBytes
    const rdBase = bytesBase + W;
    // word0 of returnData is the offset to the string (always 0x20, skip it)
    const strLen = uint(rdBase + W);
    if (!strLen) { names.push(null); continue; }

    const strHex = data.slice(rdBase + 2 * W, rdBase + 2 * W + strLen * 2);
    try {
      const raw = textDecoder.decode(hexToBytes(strHex));
      names.push(sanitizeName(raw));
    } catch {
      names.push(null);
    }
  }

  return names;
}

// ─── Providers ───────────────────────────────────────────────────────────────

/**
 * Resolve addresses via a single Multicall3 eth_call to a JSON-RPC endpoint.
 * Returns Map<address_lowercase, name>.
 */
async function resolveViaRPC(addresses, rpcUrl, customHeaders = {}) {
  const results = new Map();
  const calldata = encodeMulticall(addresses);

  log('eth_call to', rpcUrl, 'calldata length', calldata.length);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...customHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: MULTICALL3, data: calldata }, 'latest'],
    }),
  });

  const json = await res.json();
  log('rpc response:', JSON.stringify(json).slice(0, 300));
  if (!json.result) return results;

  const names = decodeAggregate3(json.result);
  log('decoded names:', names);
  for (let i = 0; i < addresses.length; i++) {
    if (names[i]) results.set(addresses[i].toLowerCase(), names[i]);
  }

  return results;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

/** Build the storage.local key for a cached address. */
function cacheKey(address) {
  return `wns_${address.toLowerCase()}`;
}

/**
 * Main resolver — checks cache first, then fires an RPC batch only for misses.
 */
async function resolveAddresses(addresses) {
  const stored = await getConfig();
  const rpcUrl = stored.rpcUrl || WNS_DEFAULTS.rpcUrl;
  const cacheEnabled = stored.cacheEnabled !== false;
  const cacheTtlMs = (stored.cacheTtlMinutes ?? WNS_DEFAULTS.cacheTtlMinutes) * 60 * 1000;

  let customHeaders = {};
  if (stored.rpcHeaders) {
    try {
      const arr = JSON.parse(stored.rpcHeaders);
      for (const { key, value } of arr) {
        if (key) customHeaders[key] = value;
      }
    } catch { /* ignore bad data */ }
  }

  const results = new Map();
  let uncached = addresses;

  // ── Cache read ──
  if (cacheEnabled) {
    const keys = addresses.map(cacheKey);
    const cached = await chrome.storage.local.get(keys);
    const now = Date.now();
    uncached = [];

    for (const addr of addresses) {
      const entry = cached[cacheKey(addr)];
      if (entry && (now - entry.t) < cacheTtlMs) {
        if (entry.n) results.set(addr.toLowerCase(), entry.n);
        // else: negative cache hit — address has no name, skip RPC
      } else {
        uncached.push(addr);
      }
    }

    log('cache hit:', addresses.length - uncached.length,
        '/ miss:', uncached.length);
  }

  // ── RPC for misses (chunked by maxBatchSize) ──
  if (uncached.length) {
    const maxBatch = stored.maxBatchSize ?? WNS_DEFAULTS.maxBatchSize;
    const chunks = [];
    for (let i = 0; i < uncached.length; i += maxBatch) {
      chunks.push(uncached.slice(i, i + maxBatch));
    }

    for (const chunk of chunks) {
      const fresh = await resolveViaRPC(chunk, rpcUrl, customHeaders);

      if (cacheEnabled) {
        const now = Date.now();
        const toStore = {};
        for (const addr of chunk) {
          const name = fresh.get(addr.toLowerCase()) || null;
          toStore[cacheKey(addr)] = { n: name, t: now };
        }
        await chrome.storage.local.set(toStore);
      }

      for (const [addr, name] of fresh) results.set(addr, name);
    }
  }

  return results;
}

// ─── RPC cooldown ─────────────────────────────────────────────────────────────

let lastRpcTime = 0;

/** Wait until the cooldown period has elapsed since the last RPC call. */
async function waitForCooldown() {
  const stored = await getConfig();
  const cooldown = stored.rpcCooldownMs ?? WNS_DEFAULTS.rpcCooldownMs;
  const elapsed = Date.now() - lastRpcTime;
  if (elapsed < cooldown) {
    await new Promise(r => setTimeout(r, cooldown - elapsed));
  }
}

/** Wrapper that enforces cooldown around resolveAddresses. */
async function resolveWithCooldown(addresses) {
  await waitForCooldown();
  lastRpcTime = Date.now();
  return resolveAddresses(addresses);
}

// ─── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log('message received:', message.type);

  if (message.type === 'CLEAR_CACHE') {
    (async () => {
      const items = await chrome.storage.local.get(null);
      const wnsKeys = Object.keys(items).filter(k => k.startsWith('wns_'));
      await chrome.storage.local.remove(wnsKeys);
      log('cache cleared:', wnsKeys.length, 'entries');
      sendResponse({ cleared: wnsKeys.length });
    })();
    return true;
  }

  if (message.type !== 'RESOLVE') return false;

  const VALID_ADDR = /^0x[0-9a-fA-F]{40}$/;
  const addresses = (Array.isArray(message.addresses) ? message.addresses : [])
    .filter(a => typeof a === 'string' && VALID_ADDR.test(a));
  if (!addresses.length) {
    sendResponse({ names: {} });
    return false;
  }

  log('resolving', addresses.length, 'addresses:', addresses);
  resolveWithCooldown(addresses).then((nameMap) => {
    log('resolved', nameMap.size, 'names');
    sendResponse({ names: Object.fromEntries(nameMap) });
  }).catch((err) => {
    log('resolve error:', err);
    sendResponse({ names: {} });
  });

  return true;
});
