# Wei Name Service (WNS) Resolver - Browser Extensions

Detect, resolve, and replace Ethereum addresses with their [Wei Name Service (WNS)](https://wei.domains) primary names.

by **Denizen.** // dnzn.wei

## Features

- **Automatic Detection** — scans pages for Ethereum addresses in links, including full and abbreviated (`0x1234…5678`) formats
- **Batch Resolution** — resolves all addresses on a page in a single RPC call via [Multicall3](https://www.multicall3.com)
- **Local Caching** — caches resolved names with a configurable TTL to eliminate redundant RPC calls
- **SPA Support** — watches for DOM mutations so dynamically loaded content continues to resolve
- **Configurable** — custom RPC endpoint and headers, cache TTL, regex overrides, ignore list, optional ENS replacement
- **Zero Dependencies** — plain JS, no build requirements

## Implementations

| PLATFORM | STATUS | AUDIT | DOCS |
|:---|:---|:---|:---|
| Chrome (MV3) | `vibe/alpha` | [v26.2.18.1003 // Self Review](audit/self/chrome-26.2.18.1003.md) | [chrome/README](chrome/README.md)

### Contract Dependencies

| NAME | ADDRESS |
|:---|:---|
| Wei Name Service (WNS) | [0x0000000000696760E15f265e828DB644A0c242EB](https://etherscan.io/address/0x0000000000696760e15f265e828db644a0c242eb) |
| Multicall3 | [0xcA11bde05977b3631167028862bE2a173976CA11](https://etherscan.io/address/0xcA11bde05977b3631167028862bE2a173976CA11) |

## License

MIT
