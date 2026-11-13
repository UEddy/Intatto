import { MAINNET, type IntentsConfig } from "../config/networks";

/**
 * The first mainnet intent swap, of 2026-11-11 17:46 UTC: 0.3 wNEAR for 1.130742 USDt (intent id
 * 0), made before the agent asked NEAR AI. The board now shows the AI-decided swap of 2026-11-13;
 * the tests built on this swap's recorded transactions (fixtures/rpc-tx-mainnet-intent-*.json,
 * fixtures/nearblocks-v3-tree-mainnet-intent-*.json) check it with this config.
 */
export const FIRST_SWAP_CFG: IntentsConfig = {
  ...MAINNET.intents!,
  swap: {
    intentId: "0",
    tokenIn: "wrap.near",
    tokenOut: "usdt.tether-token.near",
    amountIn: "300000000000000000000000",
    amountOut: "1130742",
    signTxHash: "GbHfV9nqv8C3xXWCFECWaruJFaQijMhq2GBrKxb1uJjT",
    executeTxHash: "EJY7oiU1SE3w9kg94qhwdcsn2zxFWEZ3eykbVnvUCLUE",
    settleTxHash: "73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE",
  },
};
