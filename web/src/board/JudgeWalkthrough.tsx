import type { ReactNode } from "react";
import { TxLink } from "../ui/primitives";
import type { ProofTarget } from "./HeroProof";
import { BOARD_POLL_MS } from "./useBoard";

/**
 * A 60-second path through the evidence for a first-time reviewer. Mainnet only: every link is a
 * mainnet transaction from the README's "Mainnet smoke test, 2026-11-11", "First intent swap,
 * 2026-11-11" and the 2026-11-12 prompt-injection runs on vault.intatto.near.
 */
export const MAINNET_TX = {
  overCap: "8o7EGQoMWfxUzeST7cTzA63J5MzvxB5ZiWk4NENa8XHU",
  badPool: "G5d3Fu838aDw5SSpRvh694TpHLKLg6Vk4LVZRJzssekc",
  slippage: "CEpq15YceDiwqHWtpUszmZH8LegBoyyZzgrdJ8HRaEck",
  injection: "FNkp2gprgvRs49L6wskMo8JcaYwpoqk2T3YVjGa6oqtw",
  swap: "JAFaEDBhStuPgwgCyNJKU7mQH2K7evjG328zrhudoaC8",
  withdraw: "2tqfhEiJm1jqAe6DNDZBFnfzbHZqfnmThVfFmJToFtYW",
  intentSettle: "73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE",
  freeze: "6YRqjJXZcNuyeHHSnAeMoURtT6vHfG44VpGJ34uDBCk2",
  frozenRefusal: "7bm6uGYGGJG3hJnuJQYoFfxBckCp6Qasvs5fVHzSW3Li",
} as const;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="judge-step">
      <span className="judge-n mono" aria-hidden="true">
        {String(n).padStart(2, "0")}
      </span>
      <div>
        <h3 className="judge-title">{title}</h3>
        <p className="judge-body">{children}</p>
      </div>
    </li>
  );
}

export function JudgeWalkthrough({ onJump, onShowKey }: { onJump: (t: ProofTarget) => void; onShowKey: () => void }) {
  return (
    <ol className="judge">
      <Step n={1} title="The bounty and the public key">
        The panel above is read live from the chain: the balance, how long it has held, every attempt.{" "}
        <button type="button" className="linklike" onClick={onShowKey}>
          See the published key
        </button>
        . Anyone can sign with it.
      </Step>
      <Step n={2} title="What a refusal looks like">
        The agent's calls refused on mainnet: <TxLink hash={MAINNET_TX.overCap}>over the per-trade cap</TxLink>, <TxLink hash={MAINNET_TX.badPool}>a pool not allowed</TxLink>,{" "}
        <TxLink hash={MAINNET_TX.slippage}>slippage too loose</TxLink>, and a prompt-injected agent <TxLink hash={MAINNET_TX.injection}>trying to drain the vault</TxLink>.
      </Step>
      <Step n={3} title="A trade that went through, then the owner's withdrawal">
        A Rhea <TxLink hash={MAINNET_TX.swap}>swap within the limits</TxLink>, the owner <TxLink hash={MAINNET_TX.withdraw}>withdrawing the proceeds</TxLink>, and a{" "}
        <TxLink hash={MAINNET_TX.intentSettle}>NEAR Intents swap settled</TxLink> above the owner's price floor.
      </Step>
      <Step n={4} title="The freeze">
        The owner <TxLink hash={MAINNET_TX.freeze}>freezes the vault</TxLink> in one call, and the agent's next trade is <TxLink hash={MAINNET_TX.frozenRefusal}>refused</TxLink>.
      </Step>
      <Step n={5} title="The code is the published code">
        <button type="button" className="linklike" onClick={() => onJump("integrity-section-title")}>
          The integrity check
        </button>{" "}
        compares the vault's running code hash with the reproducible build, every {BOARD_POLL_MS / 1000} seconds.
      </Step>
    </ol>
  );
}
