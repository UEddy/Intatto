/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NearWalletBase } from "@hot-labs/near-connect";
import { MAINNET, TESTNET } from "../config/networks";
import relayedOk from "../test/fixtures/rpc-tx-status-relayed-5DfbUUeE.json";
import relayedFailed from "../test/fixtures/rpc-tx-status-relayed-5WqPivF3.json";
import { hardenedStorage, STORAGE_PREFIX } from "./connectorStorage";
import { offeredWallets } from "./nearConnect";
import {
  PASSKEY_EXECUTOR_COMMIT,
  PASSKEY_EXECUTOR_SHA256,
  PASSKEY_EXPERIMENTAL_LABEL,
  PASSKEY_SPONSOR_ID,
  PASSKEY_WALLET_ID,
  PasskeyAdapter,
  outcomeFailed,
  passkeyManifestEntry,
} from "./passkey";
import { WalletRejectedError, type TxPlan } from "./types";

const plan = (receiverId: string, methodName: string): TxPlan => ({
  receiverId,
  actions: [{ kind: "FunctionCall", methodName, args: {}, gas: 30_000_000_000_000n, deposit: 1n }],
});

/** A connected passkey wallet that answers each signAndSendTransaction with the next outcome. */
function fakeWallet(outcomes: unknown[], log: string[], reject = false) {
  let i = 0;
  return {
    manifest: { id: PASSKEY_WALLET_ID },
    async signAndSendTransaction(params: { receiverId: string; actions: unknown[] }) {
      log.push(`sign ${params.receiverId}`);
      if (reject) throw new Error("Sign-in was cancelled or timed out. Please try again and confirm with your device when it asks.");
      return outcomes[i++];
    },
  } as unknown as NearWalletBase;
}

const withHash = (outcome: unknown, hash: string) => {
  const o = structuredClone(outcome) as { transaction: { hash: string } };
  o.transaction.hash = hash;
  return o;
};

describe("passkey manifest entry", () => {
  it("is mainnet only, runs the self-hosted executor at 798e9e5, and alone asks for WebAuthn", () => {
    const entry = passkeyManifestEntry("/");
    expect(entry.features.mainnet).toBe(true);
    expect(entry.features.testnet).toBe(false);
    expect(entry.executor).toBe("/wallets/passkey-executor-798e9e5.js");
    expect(entry.version).toBe(PASSKEY_EXECUTOR_COMMIT.slice(0, 7));
    expect(entry.permissions).toEqual({ storage: true, webauthn: true });
    expect(entry.description).toBe(PASSKEY_EXPERIMENTAL_LABEL);
    expect(passkeyManifestEntry("/Intatto/").executor).toBe("/Intatto/wallets/passkey-executor-798e9e5.js");
  });

  it("points at the file this site serves, which is the pinned executor byte for byte", () => {
    const file = `public/wallets/passkey-executor-${PASSKEY_EXECUTOR_COMMIT.slice(0, 7)}.js`;
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(PASSKEY_EXECUTOR_SHA256);
  });

  it("is offered on mainnet and never on testnet", () => {
    expect(offeredWallets(TESTNET, "/").map((w) => w.id)).not.toContain(PASSKEY_WALLET_ID);
    expect(offeredWallets(MAINNET, "/").map((w) => w.id)).toContain(PASSKEY_WALLET_ID);
  });

  it("is the only wallet with webauthn, and no wallet gets the permissions the vendored near-connect widened", () => {
    for (const config of [TESTNET, MAINNET]) {
      for (const w of offeredWallets(config, "/")) {
        const p = w.permissions as Record<string, unknown>;
        expect(Boolean(p.webauthn)).toBe(w.id === PASSKEY_WALLET_ID);
        // walletConnect: open any URL, and the ethereum.* bridge. keepAlive: a hidden iframe between calls.
        expect(p.walletConnect).toBeUndefined();
        expect(p.keepAlive).toBeUndefined();
      }
    }
  });
});

describe("PasskeyAdapter", () => {
  it("refuses to exist off mainnet", () => {
    expect(() => new PasskeyAdapter(TESTNET, async () => {})).toThrow(/mainnet only/);
  });

  it("sends a plan one transaction at a time, each final before the next is signed", async () => {
    const log: string[] = [];
    const waitFinal = async (hash: string, sender: string) => {
      log.push(`final ${hash} ${sender}`);
    };
    const adapter = new PasskeyAdapter(MAINNET, waitFinal);
    const ok = relayedOk.result;
    const wallet = fakeWallet([withHash(ok, "HASH1"), withHash(ok, "HASH2")], log);
    const submitted = await adapter.submit(wallet, "0s640d667971eb2a50c512be2e893cbe7851c1fcf9", [plan("usdt.tether-token.near", "storage_deposit"), plan("vault.near", "withdraw_token")]);
    expect(log).toEqual(["sign usdt.tether-token.near", `final HASH1 ${PASSKEY_SPONSOR_ID}`, "sign vault.near"]);
    expect(submitted).toEqual([
      { hash: "HASH1", receiverId: "usdt.tether-token.near", senderId: PASSKEY_SPONSOR_ID },
      { hash: "HASH2", receiverId: "vault.near", senderId: PASSKEY_SPONSOR_ID },
    ]);
  });

  it("stops at the first failed transaction, so later ones that depend on it are never sent", async () => {
    const log: string[] = [];
    const adapter = new PasskeyAdapter(MAINNET, async () => {
      log.push("final");
    });
    expect(outcomeFailed(relayedFailed.result)).toBe(true);
    expect(outcomeFailed(relayedOk.result)).toBe(false);
    const wallet = fakeWallet([relayedFailed.result, relayedOk.result], log);
    const submitted = await adapter.submit(wallet, "0s640d667971eb2a50c512be2e893cbe7851c1fcf9", [plan("wrap.near", "a"), plan("vault.near", "b")]);
    expect(submitted.map((s) => s.receiverId)).toEqual(["wrap.near"]);
    expect(log).toEqual(["sign wrap.near"]);
  });

  it("refuses an outcome not signed by the sponsor", async () => {
    const adapter = new PasskeyAdapter(MAINNET, async () => {});
    const forged = structuredClone(relayedOk.result) as { transaction: { signer_id: string } };
    forged.transaction.signer_id = "someone-else.near";
    await expect(adapter.submit(fakeWallet([forged], []), "0s640d667971eb2a50c512be2e893cbe7851c1fcf9", [plan("wrap.near", "a")])).rejects.toThrow(/not the passkey sponsor/);
  });

  it("reports a cancelled first prompt as a rejection", async () => {
    const adapter = new PasskeyAdapter(MAINNET, async () => {});
    await expect(adapter.submit(fakeWallet([], [], true), "0s640d667971eb2a50c512be2e893cbe7851c1fcf9", [plan("wrap.near", "a")])).rejects.toBeInstanceOf(WalletRejectedError);
  });
});

describe("hardened connector storage", () => {
  const backing = () => {
    const map = new Map<string, string>();
    return { map, store: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } };
  };

  it("never yields or stores debug-wallets, so storage cannot add a wallet", async () => {
    const { map, store } = backing();
    map.set(`${STORAGE_PREFIX}debug-wallets`, JSON.stringify([{ id: "evil", permissions: { webauthn: true } }]));
    map.set("debug-wallets", "[]");
    const s = hardenedStorage(store);
    expect(await s.get("debug-wallets")).toBeNull();
    await s.set("debug-wallets", "[{}]");
    expect(map.get(`${STORAGE_PREFIX}debug-wallets`)).toContain("evil"); // untouched, never read
  });

  it("namespaces the keys near-connect uses", async () => {
    const { map, store } = backing();
    const s = hardenedStorage(store);
    await s.set("selected-wallet", "passkey");
    expect(map.get(`${STORAGE_PREFIX}selected-wallet`)).toBe("passkey");
    expect(map.has("selected-wallet")).toBe(false);
    expect(await s.get("selected-wallet")).toBe("passkey");
    await s.remove("selected-wallet");
    expect(await s.get("selected-wallet")).toBeNull();
  });

  it("survives a storage that throws (private mode)", async () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    const s = hardenedStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(await s.get("selected-wallet")).toBeNull();
    await expect(s.set("selected-wallet", "x")).resolves.toBeUndefined();
  });
});
