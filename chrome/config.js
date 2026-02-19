/**
 * Shared configuration defaults — single source of truth for background.js,
 * content.js, and options.js.
 */

const WNS_DEFAULTS = {
  rpcUrl: 'https://eth.llamarpc.com',
  replaceEns: false,
  logging: false,
  cacheEnabled: true,
  cacheTtlMinutes: 60,
  hrefRe: '',
  hrefRules: '',
  ethRe: '\\b0x[0-9a-fA-F]{40}\\b',
  abbrRe: '\\b0x([0-9a-fA-F]{4,})[…\\.]{2,3}([0-9a-fA-F]{4,})\\b',
  maxBatchSize: 50,
  rpcCooldownMs: 2000,
  allFrames: true,
  ignoreList: [],
  rpcHeaders: '',
};

/**
 * Determine which chrome.storage area holds config (sync or local).
 * The useSync flag itself always lives in chrome.storage.local.
 * Returns chrome.storage.sync or chrome.storage.local.
 */
async function getConfigStorage() {
  const { useSync } = await chrome.storage.local.get({ useSync: false });
  return useSync ? chrome.storage.sync : chrome.storage.local;
}

/** Read config from the active storage area, merged with WNS_DEFAULTS. */
async function getConfig() {
  const store = await getConfigStorage();
  return new Promise(resolve => store.get(WNS_DEFAULTS, resolve));
}

/** Write config to the active storage area. */
async function setConfig(data) {
  const store = await getConfigStorage();
  return new Promise(resolve => store.set(data, resolve));
}
