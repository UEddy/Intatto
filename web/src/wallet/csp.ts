/**
 * What the wallet executors need from the CSP, beyond the RPC and indexer hosts in the network
 * configs. Measured by driving each wallet's connect and sign flows (e2e/harness) and recording
 * every request their sandboxed iframes made: Meteor and Intear on testnet on 2026-11-09, all four
 * on mainnet on 2026-11-11 (HOT and MyNearWallet run on mainnet only); the reason for
 * each entry is in THREAT_MODEL.md, "Frontend". Nothing else is allowed, so anything a wallet
 * adds later is blocked (and shows up as a CSP violation) until it is measured and listed here.
 */
export const WALLET_CONNECT_SRC: readonly string[] = [
  // Executor code, fetched by near-connect at connect time. Meteor, HOT and MyNearWallet.
  "https://raw.githubusercontent.com",
  // Executor code of Intear.
  "https://wallet.intear.tech",
  // Meteor Connect bridge: /api/action and /api/bridge/... (web handoff and mobile QR pairing).
  "https://mc.meteorwallet.app",
  "wss://mc.meteorwallet.app",
  // Intear's bridge for its App connection method and logout notices (from its executor code;
  // the Web method measured here does not open it).
  "wss://logout-bridge-service.intear.tech",
  // HOT (mainnet only, measured 2026-11-11): the relay its QR, app and Telegram connections pass
  // the request and the wallet's answer through (/<id>/request, /<id>/response), and the clock it
  // dates requests with (/api/v1/web/time).
  "https://h4n.app",
  "https://api0.herewallet.app",
  // MyNearWallet (mainnet only, measured 2026-11-11) needs nothing here: it logs in and signs in
  // its own window (app.mynearwallet.com) and reads the chain through the configured RPC.
];

/** Iframes the executors load inside their own sandboxed iframe. */
export const WALLET_FRAME_SRC: readonly string[] = [
  // Intear's "choose how to connect" page.
  "https://wallet.intear.tech",
];

/**
 * Images the executors load. HOT's executor shuts itself down (near-connect removes its iframe
 * and the connection never starts) when its own logo or QR frame image fails to load, so these
 * are not cosmetic for HOT (measured 2026-11-11). Other wallets' images stay blocked; their
 * pickers work without them.
 */
export const WALLET_IMG_SRC: readonly string[] = [
  // HOT's logo and QR frame (desktop layout).
  "https://hot-labs.org",
  // HOT's logo in its mobile layout (from its executor code).
  "https://storage.herewallet.app",
];
