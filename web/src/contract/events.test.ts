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

  const ticket = { spend_id: "3", owner_id: "o.testnet", pool_id: 0, token_in: "wrap.testnet", token_out: "usdt.testnet", amount_in: "100", min_amount_out: "10000" };
  const completed = (version: string, data: Record<string, unknown>) =>
    `EVENT_JSON:${JSON.stringify({ standard: "intatto", version, event: "swap_completed", data: { swap: ticket, held_on_exchange: false, ...data } })}`;

  it("read swap_completed 1.1.0 with its fee and net, and 1.0.0 without", () => {
    const v11 = parseLog(completed("1.1.0", { amount_out: "10000", fee: "10", net: "9990" }));
    expect(v11).toMatchObject({ kind: "event", event: { event: "swap_completed", data: { amount_out: "10000", fee: "10", net: "9990" } } });
    const v10 = parseLog(completed("1.0.0", { amount_out: "10000" }));
    expect(v10).toMatchObject({ kind: "event", event: { event: "swap_completed", data: { amount_out: "10000" } } });
    if (v10.kind === "event" && v10.event.event === "swap_completed") expect(v10.event.data.fee).toBeUndefined();
  });

  it("refuse a swap_completed whose fields do not match its version, or whose split does not add up", () => {
    expect(parseLog(completed("1.1.0", { amount_out: "10000" }))).toMatchObject({ kind: "unrecognised", version: "1.1.0" });
    expect(parseLog(completed("1.0.0", { amount_out: "10000", fee: "10", net: "9990" }))).toMatchObject({ kind: "unrecognised" });
    expect(parseLog(completed("1.1.0", { amount_out: "10000", fee: "10", net: "9991" }))).toMatchObject({ kind: "unrecognised" });
    // Only swap_completed has a 1.1.0.
    expect(parseLog('EVENT_JSON:{"standard":"intatto","version":"1.1.0","event":"frozen","data":{"owner_id":"a.testnet"}}')).toMatchObject({ kind: "unrecognised" });
  });

  it("read fee withdrawals as treasury events, not any owner's", () => {
    const log = 'EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"fees_withdrawn","data":{"treasury_id":"t.testnet","token_id":"usdt.testnet","amount":"10"}}';
    const p = parseLog(log);
    expect(p).toMatchObject({ kind: "event", event: { event: "fees_withdrawn" } });
    if (p.kind === "event") expect(eventOwner(p.event)).toBeNull();
    const refunded = parseLog(log.replace("fees_withdrawn", "fees_withdraw_refunded"));
    expect(refunded).toMatchObject({ kind: "event", event: { event: "fees_withdraw_refunded" } });
  });

  it("keep intatto events it cannot read instead of dropping them", () => {
    expect(parseLog('EVENT_JSON:{"standard":"intatto","version":"2.0.0","event":"frozen","data":{}}')).toMatchObject({ kind: "unrecognised", version: "2.0.0" });
    expect(parseLog('EVENT_JSON:{"standard":"intatto","version":"1.0.0","event":"frozen","data":{"owner_id":5}}')).toMatchObject({ kind: "unrecognised" });
    expect(parseLog('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}')).toMatchObject({ kind: "other" });
    expect(parseLog("plain text")).toMatchObject({ kind: "other" });
  });
});
