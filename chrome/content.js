/**
 * WNS Address Resolver — content script
 *
 * Replaces Ethereum address links with their WNS names. Only operates on
 * <a> elements — never modifies bare text nodes.
 *
 * Matching hierarchy (first match wins per anchor):
 *   1. CUSTOM    — user-defined href rules (multiple supported)
 *   2. PRIMARY   — href contains a full 40-hex Ethereum address
 *                  (smart selection: display text > URL structure > fallback last)
 *   3. SECONDARY — display text looks like 0xABCD…1234 and the prefix/suffix
 *                  hex chars can be found in a full address within the href
 */

// Full 40-hex-char Ethereum address (default; may be overridden by config)
const DEFAULT_ETH_RE = /\b0x[0-9a-fA-F]{40}\b/g;

// Abbreviated address in display text (default; may be overridden by config)
const DEFAULT_ABBR_RE = /\b0x([0-9a-fA-F]{4,})[…\.]{2,3}([0-9a-fA-F]{4,})\b/;

// Validates that a captured string is a real Ethereum address
const VALID_ETH_RE = /^0x[0-9a-fA-F]{40}$/;

let ETH_RE = DEFAULT_ETH_RE;
let ABBR_RE = DEFAULT_ABBR_RE;
let HREF_RULES = []; // array of { re: RegExp, group: number }

const DONE_ATTR = 'data-wns-resolved';

let loggingEnabled = false;
function log(...args) { if (loggingEnabled) console.log('[WNS]', ...args); }

// ─── Config loading ─────────────────────────────────────────────────────────

/** Parse hrefRules JSON into compiled rule objects. */
function parseHrefRules(raw) {
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const rules = [];
  for (const entry of arr) {
    if (!entry || typeof entry.pattern !== 'string') continue;
    const group = typeof entry.group === 'number' ? entry.group : 1;
    try {
      rules.push({ re: new RegExp(entry.pattern), group });
    } catch {
      // skip invalid regex
    }
  }
  return rules;
}

/** Try each href rule in order; return first validated address or null. */
function matchHrefRules(href) {
  for (const rule of HREF_RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(href);
    const captured = m?.[rule.group];
    if (captured && VALID_ETH_RE.test(captured)) {
      return captured.toLowerCase();
    }
  }
  return null;
}

/** Load config from storage. Called before scanning so overrides apply immediately. */
async function loadConfig() {
  const config = await getConfig();
  loggingEnabled = config.logging;
  ETH_RE = config.ethRe ? new RegExp(config.ethRe, 'g') : DEFAULT_ETH_RE;
  ABBR_RE = config.abbrRe ? new RegExp(config.abbrRe) : DEFAULT_ABBR_RE;

  // hrefRules takes priority; fall back to legacy hrefRe (auto-migrate)
  if (config.hrefRules) {
    HREF_RULES = parseHrefRules(config.hrefRules);
  } else if (config.hrefRe) {
    try {
      HREF_RULES = [{ re: new RegExp(config.hrefRe), group: 1 }];
    } catch {
      HREF_RULES = [];
    }
  } else {
    HREF_RULES = [];
  }

  log('config loaded, hrefRules:', HREF_RULES.length);
  return config;
}

// ─── Background communication ─────────────────────────────────────────────────

async function resolveAddresses(addresses) {
  log('sending RESOLVE for', addresses.length, 'addresses');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESOLVE', addresses });
    log('response:', response);
    return new Map(Object.entries(response?.names ?? {}));
  } catch (err) {
    log('sendMessage error:', err.message);
    return new Map();
  }
}

// ─── Address extraction from hrefs ───────────────────────────────────────────

/** Return all full Ethereum addresses found in a URL string. */
function allAddressesInHref(href) {
  if (!href) return [];
  ETH_RE.lastIndex = 0;
  const found = [];
  let m;
  while ((m = ETH_RE.exec(href)) !== null) found.push(m[0].toLowerCase());
  return found;
}

/**
 * Match abbreviated display text (e.g. "0x357836fF…3c961902b") against a list
 * of full addresses. Returns the first address whose hex starts with the prefix
 * and ends with the suffix, or null.
 */
function matchAbbrToAddresses(displayText, addresses) {
  const m = ABBR_RE.exec(displayText);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const suffix = m[2].toLowerCase();
  for (const addr of addresses) {
    const hex = addr.slice(2); // strip 0x
    if (hex.startsWith(prefix) && hex.endsWith(suffix)) return addr;
  }
  return null;
}

/** Shorthand: match abbreviated display text against all addresses in an href. */
function matchAbbrToHref(displayText, href) {
  return matchAbbrToAddresses(displayText, allAddressesInHref(href));
}

// ─── Smart address selection ─────────────────────────────────────────────────

/**
 * Pick the "subject" address from a list of addresses found in a URL.
 * Uses a tiered approach:
 *   Tier 1 — display text match (strongest signal)
 *   Tier 2 — URL structure scoring
 *   Tier 3 — fallback to last address
 */
function pickSubjectAddress(href, addresses, displayText) {
  if (addresses.length === 1) return addresses[0];

  // Tier 1: display text is abbreviated — match it against addresses
  const abbrHit = matchAbbrToAddresses(displayText, addresses);
  if (abbrHit) {
    log('pickSubjectAddress: tier 1 (display text) →', abbrHit);
    return abbrHit;
  }
  // Also check if the full display text IS one of the addresses
  const displayLower = displayText.toLowerCase();
  if (VALID_ETH_RE.test(displayText)) {
    for (const addr of addresses) {
      if (addr === displayLower) {
        log('pickSubjectAddress: tier 1 (exact display) →', addr);
        return addr;
      }
    }
  }

  // Tier 2: URL structure scoring
  let url;
  try { url = new URL(href); } catch { /* fall through to tier 3 */ }

  if (url) {
    const scores = new Map();
    for (const addr of addresses) scores.set(addr, 0);

    const hashStr = (url.hash || '').toLowerCase();

    for (const addr of addresses) {
      let score = 0;

      // Path segment signals
      const pathLower = url.pathname.toLowerCase();
      const addrIdx = pathLower.indexOf(addr);
      if (addrIdx !== -1) {
        const before = pathLower.substring(0, addrIdx);
        if (before.endsWith('/address/') || before.endsWith('/holder/')) score += 10;
        if (before.endsWith('/token/') || before.endsWith('/contract/')) score -= 5;
      }

      // Query param signals
      for (const [key, val] of url.searchParams) {
        if (val.toLowerCase() !== addr) continue;
        if (['a', 'holder', 'address'].includes(key.toLowerCase())) score += 10;
        if (['token', 'contract'].includes(key.toLowerCase())) score -= 5;
      }

      // Hash signals (e.g. Etherscan #balances?holder=0x...)
      if (hashStr.includes(addr)) {
        if (hashStr.includes('holder=' + addr)) score += 10;
        if (hashStr.includes('address=' + addr)) score += 10;
      }

      scores.set(addr, score);
    }

    // Pick the highest-scoring address
    let best = addresses[0];
    let bestScore = scores.get(best);
    for (const addr of addresses) {
      const s = scores.get(addr);
      if (s > bestScore) { best = addr; bestScore = s; }
    }
    if (bestScore !== 0) {
      log('pickSubjectAddress: tier 2 (URL structure, score', bestScore, ') →', best);
      return best;
    }
  }

  // Tier 3: fallback — last address (preserves existing behavior)
  log('pickSubjectAddress: tier 3 (fallback last) →', addresses[addresses.length - 1]);
  return addresses[addresses.length - 1];
}

// ─── Link collection ──────────────────────────────────────────────────────────

/**
 * Scan root for <a> elements that contain an Ethereum address — either in the
 * href directly (primary) or matched via abbreviated display text (secondary).
 *
 * Returns [{ anchor, fullAddress }], and populates addressSet.
 * Anchors already processed (DONE_ATTR) are skipped.
 * An anchor is only included once (first match wins).
 */
function collectEthereumLinks(root, addressSet) {
  const results = [];

  // root itself may be an <a> (when MutationObserver fires on a directly added anchor)
  const candidates = root.querySelectorAll ? [...root.querySelectorAll(`a:not([${DONE_ATTR}])`)] : [];
  if (root.tagName === 'A' && !root.hasAttribute(DONE_ATTR)) candidates.unshift(root);

  for (const anchor of candidates) {
    // Use .href (fully resolved URL) so relative hrefs like ?a=0x... expand correctly
    const href = anchor.href || '';

    // CUSTOM: user-defined href rules (multiple supported, first valid wins)
    if (HREF_RULES.length) {
      const ruleMatch = matchHrefRules(href);
      if (ruleMatch) {
        addressSet.add(ruleMatch);
        results.push({ anchor, fullAddress: ruleMatch });
        continue;
      }
    }

    // PRIMARY: full address anywhere in the href
    const hrefAddresses = allAddressesInHref(href);
    if (hrefAddresses.length) {
      const displayText = anchor.textContent.trim();
      const fullAddress = pickSubjectAddress(href, hrefAddresses, displayText);
      addressSet.add(fullAddress);
      results.push({ anchor, fullAddress });
      continue;
    }

    // SECONDARY: display text is abbreviated and matches an address in the href
    const displayText = anchor.textContent.trim();
    const matched = matchAbbrToHref(displayText, href);
    if (matched) {
      addressSet.add(matched);
      results.push({ anchor, fullAddress: matched });
    }
  }

  return results;
}

// ─── Replacement ──────────────────────────────────────────────────────────────

function replaceAnchor(anchor, fullAddress, nameMap, replaceEns, ignoreSet) {
  const name = nameMap.get(fullAddress);
  if (!name) return;

  const displayText = anchor.textContent.trim();
  if (!displayText) return;
  if (ignoreSet.has(displayText)) {
    log('ignoring (ignore list match):', displayText);
    return;
  }
  if (displayText.endsWith('.eth')) {
    if (!replaceEns) return;
  } else if (!displayText.startsWith('0x')) {
    return;
  }
  log(`displayText: ${displayText} -> ${name}`);

  // Find the text node containing the address and replace just its text
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.trim()) {
      node.textContent = name;
      break;
    }
  }

  anchor.setAttribute(DONE_ATTR, '');
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function processRoot(root) {
  // Load config BEFORE scanning so custom regexes apply on first run
  const config = await loadConfig();

  const addressSet = new Set();
  const links = collectEthereumLinks(root, addressSet);
  log('found', links.length, 'ethereum links');
  if (!addressSet.size) return;

  const nameMap = await resolveAddresses([...addressSet]);
  if (!nameMap.size) return;

  const ignoreSet = new Set(config.ignoreList);
  log('ignoreList:', [...ignoreSet]);
  for (const { anchor, fullAddress } of links) {
    if (document.contains(anchor)) replaceAnchor(anchor, fullAddress, nameMap, config.replaceEns, ignoreSet);
  }
}

// ─── MutationObserver (SPAs / dynamic content) ───────────────────────────────

let debounceTimer = null;
const pendingRoots = new Set();

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        pendingRoots.add(node);
      } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
        pendingRoots.add(node.parentElement);
      }
    }
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) {
      if (document.contains(root)) processRoot(root);
    }
  }, 500);
});

// ─── Bootstrap (skip iframe if allFrames is disabled) ─────────────────────────

(async () => {
  if (window !== window.top) {
    const config = await getConfig();
    if (!config.allFrames) return;
  }

  await processRoot(document.body);
  observer.observe(document.body, { childList: true, subtree: true });
})();
