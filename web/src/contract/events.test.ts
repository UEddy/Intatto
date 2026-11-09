import { describe, expect, it } from "vitest";
import { parseFastNearTransactions } from "../indexer/fastnear";
import txs from "../test/fixtures/fastnear-transactions-vault.json";
import { eventOwner, eventsFromReceipt, parseLog } from "./events";

const VAULT = "vault-v1.intatto-dev.testnet";

describe("vault events", () => {
  const parsed = parseFastNearTransactions(txs);

  it("parse every event the vault logged on testnet", () => {
    const names = parsed.flatMap((tx) => tx.receipts.flatMap((r) => eventsFromReceipt(r, VAULT))).map((p) => (p.kind === "event" ? p.event.event : `?${p.kind}`));
    expect(names.sort()).toEqual(
      ["agent_set", "agent_set", "deposit", "deposit", "frozen", "swap_completed", "swap_initiated", "swap_rejected", "swap_rejected", "swap_rejected", "swap_rejected", "token_deposit", "unfrozen", "withdrawals_locked"].sort(),
    );
  });

  it("ignore logs from receipts the vault did not execute (wNEAR's ft_transfer, or forgeries)", () => {
    const swap = parsed.find((t) => t.hash === "5KeUAq3hhMv1kcdNBkvGDv7jDX6MNs1YcASDJqf5Bxjt")!;
    const allLogs = swap.receipts.flatMap((r) => r.logs).filter((l) => l.startsWith("EVENT_JSON"));
    expect(allLogs.length).toBeGreaterThan(2);
    const forged = { executorId: "evil.testnet", logs: ['EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"frozen","data":{"owner_id":"a.testnet"}}'] };
    expect(eventsFromReceipt(forged, VAULT)).toEqual([]);
  });

  it("read the rejection reason and the swap's owner", () => {
    const rejected = parsed.find((t) => t.hash === "AyHPvtxVVRCuz8UGiXJV3cegz82vq2aCyRmcBNqMN5K1")!;
    const ev = rejected.receipts.flatMap((r) => eventsFromReceipt(r, VAULT))[0]!;
    expect(ev.kind).toBe("event");
    if (ev.kind === "event" && ev.event.event === "swap_rejected") {
      expect(ev.event.data.reason).toBe("over_per_tx_cap");
      expect(ev.event.data.amount_in).toBe("200000000000000000000000");
      expect(eventOwner(ev.event)).toBe("intatto-dev.testnet");
    } else throw new Error("expected swap_rejected");
  });

  it("keep intatto events it cannot read instead of dropping them", () => {
    expect(parseLog('EVENT_JSON:{"standard":"intatto","version":"2.0.0","event":"frozen","data":{}}')).toMatchObject({ kind: "unrecognised", version: "2.0.0" });
    expect(parseLog('EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"frozen","data":{"owner_id":5}}')).toMatchObject({ kind: "unrecognised" });
    expect(parseLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}')).toMatchObject({ kind: "other" });
    expect(parseLog("plain text")).toMatchObject({ kind: "other" });
  });
});
