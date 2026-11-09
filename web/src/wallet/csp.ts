/**
 * What the wallet executors need from the CSP, beyond the RPC and indexer hosts in the network
 * configs. Measured on testnet on 2026-11-09 by driving the Meteor and Intear connect and sign
 * flows (e2e/harness) and recording every request their sandboxed iframes made; the reason for
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
];

/** Iframes the executors load inside their own sandboxed iframe. */
export const WALLET_FRAME_SRC: readonly string[] = [
  // Intear's "choose how to connect" page.
  "https://wallet.intear.tech",
];
