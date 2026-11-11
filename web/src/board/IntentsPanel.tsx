import type { ReactNode } from "react";
import { useServices } from "../app/services";
import type { IntentsConfig } from "../config/networks";
import { buildState, floorFor, keyState, meetsFloor, rateScaled, TX_PROBLEM, type BuildState, type KeyState, type SwapCheck } from "../intents/check";
import { useIntents } from "../intents/useIntents";
import { base58ToHex } from "../near/base58";
import { NO_CODE_HASH } from "../near/chain";
import { formatUnits } from "../near/units";
import { formatInt, shorten } from "../ui/format";
import { AccountLink, Badge, Icon, SectionMark, Skeleton, Traceable, TxLink, type Tone } from "../ui/primitives";

/** Rates are stated to 3 decimals, rounded down. */
const RATE_PLACES = 3;

const BUILD: Record<BuildState, { tone: Tone; badge: string; title: string }> = {
  matches: { tone: "ok", badge: "Matches", title: "Runs the published build" },
  changed: { tone: "alert", badge: "Changed", title: "CODE CHANGED" },
  unknown: { tone: "neutral", badge: "Checking", title: "Reading the vault's code…" },
};

const KEY: Record<KeyState, { tone: Tone; badge: string; title: string }> = {
  "one-derived": { tone: "ok", badge: "One key", title: "One key on intents.near, and it is the MPC network's" },
  extra: { tone: "alert", badge: "Extra key", title: "intents.near accepts another key for the vault" },
  mismatch: { tone: "alert", badge: "Mismatch", title: "The key on intents.near is not the derived one" },
  none: { tone: "warn", badge: "No key", title: "No key on intents.near: the vault cannot sign intents" },
  unknown: { tone: "neutral", badge: "Checking", title: "Reading both keys…" },
};

export function IntentsPanel() {
  const { config } = useServices();
  const q = useIntents();
  const cfg = q.cfg;
  if (!cfg) return null;

  const onChainHash = q.code.isSuccess ? (q.code.data?.value.codeHash ?? null) : undefined;
  const build = buildState(onChainHash, cfg.expectedBuild.codeHash);
  const keys = q.keysOnVerifier.data?.value;
  const derived = q.derived.data?.value;
  const key = keyState(keys, derived);
  const repo = config.repoUrl;

  return (
    <section className="intents" aria-labelledby="intents-title">
      <div className="intents-head">
        <SectionMark>Agent trades through NEAR Intents</SectionMark>
        <h2 id="intents-title" className="intents-title">
          The agent traded. <em>The MPC network signed.</em>
        </h2>
        <p className="intents-lede">
          A second vault, <AccountLink id={cfg.vaultId} />, lets its agent swap through NEAR Intents. The agent names a pair and two amounts. The vault checks them
          against the owner's policy, writes the intent itself, and has <span className="mono">{cfg.signerId}</span> sign it. Everything here is read from mainnet.
        </p>
      </div>

      <ol className="intents-checks">
        <Check n="1" label="Build" tone={BUILD[build].tone} badge={BUILD[build].badge} title={BUILD[build].title} alert={build === "changed"}>
          <dl className="hashes">
            <div className="hash-row">
              <dt>Running on chain</dt>
              <dd>
                <Traceable source={q.code.data?.source} path=".code_hash">
                  <span className="mono hash">
                    {q.code.data === null ? "account deleted" : onChainHash === NO_CODE_HASH ? "no code" : (onChainHash ?? <Skeleton size="l" />)}
                  </span>
                </Traceable>
              </dd>
            </div>
            <div className="hash-row">
              <dt>Published reproducible build</dt>
              <dd className="mono hash">{cfg.expectedBuild.codeHash}</dd>
              <dd className="mono hash-hex">hex {base58ToHex(cfg.expectedBuild.codeHash)}</dd>
              <dd className="hash-from">
                <a href={`${repo}/tree/${cfg.expectedBuild.tag}`} target="_blank" rel="noopener noreferrer" className="mono">
                  tag {cfg.expectedBuild.tag}
                </a>{" "}
                ·{" "}
                <a href={`${repo}/actions/runs/${cfg.expectedBuild.workflowRun}`} target="_blank" rel="noopener noreferrer">
                  Reproducible build run <span className="mono">{cfg.expectedBuild.workflowRun}</span>
                </a>{" "}
                ·{" "}
                <a href={`${repo}/commit/${cfg.expectedBuild.commit}`} target="_blank" rel="noopener noreferrer" className="mono">
                  commit {cfg.expectedBuild.commit.slice(0, 7)}
                </a>
              </dd>
            </div>
          </dl>
        </Check>

        <Check n="2" label="Key" tone={KEY[key].tone} badge={KEY[key].badge} title={KEY[key].title} alert={key === "extra" || key === "mismatch"}>
          <dl className="hashes">
            <div className="hash-row">
              <dt>Keys for the vault on {cfg.verifierId}</dt>
              <dd>
                <Traceable source={q.keysOnVerifier.data?.source}>
                  {keys === undefined ? (
                    q.keysOnVerifier.isError ? <span className="hash-from">Could not read them; retrying.</span> : <Skeleton size="l" />
                  ) : keys.length === 0 ? (
                    <span className="mono hash">none</span>
                  ) : (
                    <ul className="key-list" aria-label={`${keys.length} key${keys.length === 1 ? "" : "s"}`}>
                      {keys.map((k) => (
                        <li key={k} className={`mono hash${derived !== undefined && k !== derived ? " hash--odd" : ""}`}>
                          {k}
                        </li>
                      ))}
                    </ul>
                  )}
                </Traceable>
              </dd>
            </div>
            <div className="hash-row">
              <dt>Derived by {cfg.signerId} for the vault</dt>
              <dd>
                <Traceable source={q.derived.data?.source}>
                  <span className="mono hash">{derived ?? (q.derived.isError ? "could not read it; retrying" : <Skeleton size="l" />)}</span>
                </Traceable>
              </dd>
              <dd className="hash-from mono">
                path {cfg.keyPath} · domain {cfg.keyDomain} (Ed25519)
              </dd>
            </div>
          </dl>
          <p className="intents-fact">
            <Icon name="lock" size={16} />
            <span>
              <strong>No private key exists for it.</strong> The MPC network's nodes each hold a share, a signature takes a threshold of them together, and they sign
              under this key only for requests that come from <span className="mono">{cfg.vaultId}</span> itself.
            </span>
          </p>
        </Check>

        <SwapCheckRow cfg={cfg} q={q} derived={derived} />
      </ol>

      <FullAccessCaveat cfg={cfg} q={q} repo={repo} />
    </section>
  );
}

function Check({ n, label, tone, badge, title, alert, children }: { n: string; label: string; tone: Tone; badge: string; title: string; alert?: boolean; children: ReactNode }) {
  return (
    <li className={`icheck${alert ? " icheck--alert" : ""}`} aria-live="polite">
      <span className="rules-num" aria-hidden="true">
        {n}
      </span>
      <div className="icheck-body">
        <h3 className="icheck-title">
          <span className="icheck-label">{label}</span>
          <Badge tone={tone}>{badge}</Badge>
          <span className="icheck-claim">{title}</span>
        </h3>
        {children}
      </div>
    </li>
  );
}

type Q = ReturnType<typeof useIntents>;

function SwapCheckRow({ cfg, q, derived }: { cfg: IntentsConfig; q: Q; derived: string | undefined }) {
  const s = cfg.swap;
  const inMeta = q.tokenIn.data?.value;
  const outMeta = q.tokenOut.data?.value;
  const check = q.swap.data;
  const allOk = check?.sign.ok && check.execute?.ok && check.settle?.ok;
  const failed = check !== undefined && !allOk;
  const tone: Tone = allOk ? "ok" : failed ? "alert" : q.swap.isError ? "warn" : "neutral";
  const badge = allOk ? "Settled" : failed ? "Check failed" : q.swap.isError ? "Unchecked" : "Checking";
  const title = allOk ? "One swap, signed, executed and settled" : failed ? "The swap's transactions do not check out" : q.swap.isError ? "Could not read the swap's transactions; retrying" : "Reading the swap's three transactions…";

  const amountIn = BigInt(s.amountIn);
  const amountOut = BigInt(s.amountOut);
  const policy = q.policy.data?.value;
  const floor = policy === undefined ? undefined : floorFor(policy, s.tokenIn, s.tokenOut);
  const rate = inMeta && outMeta ? rateScaled(amountIn, amountOut, inMeta.decimals, outMeta.decimals, RATE_PLACES) : null;
  const floorRate = inMeta && outMeta && floor ? rateScaled(floor.perIn, floor.minOut, inMeta.decimals, outMeta.decimals, RATE_PLACES) : null;
  const rateText = (r: bigint) => formatUnits(r, RATE_PLACES);
  const pair = inMeta && outMeta ? `${outMeta.symbol} per ${inMeta.symbol}` : null;
  const signedKeyOk = check?.sign.ok && derived !== undefined ? check.sign.signed.publicKey === derived : null;

  return (
    <Check n="3" label="Swap" tone={tone} badge={badge} title={title} alert={failed}>
      <p className="swap-figure" aria-label={inMeta && outMeta ? `${formatUnits(amountIn, inMeta.decimals)} ${inMeta.symbol} for ${formatUnits(amountOut, outMeta.decimals)} ${outMeta.symbol}` : undefined}>
        <span className="swap-amt">
          {inMeta ? formatUnits(amountIn, inMeta.decimals) : <Skeleton size="s" />}
          <span className="swap-unit">{inMeta?.symbol}</span>
        </span>
        <span className="swap-arrow" aria-hidden="true">
          <Icon name="arrow" size={22} />
        </span>
        <span className="swap-amt">
          {outMeta ? formatUnits(amountOut, outMeta.decimals) : <Skeleton size="s" />}
          <span className="swap-unit">{outMeta?.symbol}</span>
        </span>
      </p>

      <div className="floor">
        {rate !== null && floorRate !== null && pair ? (
          <>
            <FloorScale rate={rate} floorRate={floorRate} text={rateText} />
            <p className="floor-note">
              <strong>
                {rateText(rate)} {pair}
              </strong>{" "}
              against the owner's floor of{" "}
              <strong>
                {rateText(floorRate)} {pair}
              </strong>
              {floor && !meetsFloor(amountIn, amountOut, floor) ? " (below it: the floor has been raised since)" : ""}. The floor is the lowest price the vault
              accepts, not a target: it would have signed anything down to {rateText(floorRate)}. This price came from the best solver quote the agent took.
            </p>
          </>
        ) : floor === null ? (
          <p className="floor-note">The owner's intent policy no longer lists this pair, so the vault would refuse this swap today.</p>
        ) : (
          <Skeleton size="l" />
        )}
        {q.policy.data && (
          <details className="traceable-drawer floor-source">
            <summary>Source</summary>
            <dl className="source">
              <div>
                <dt>Read</dt>
                <dd className="mono">get_intent_policy({cfg.ownerId})</dd>
              </div>
              <div>
                <dt>On</dt>
                <dd className="mono">{cfg.vaultId}</dd>
              </div>
              <div>
                <dt>Block</dt>
                <dd className="mono">{formatInt(q.policy.data.source.blockHeight)}</dd>
              </div>
            </dl>
          </details>
        )}
      </div>

      <ol className="swap-steps">
        <Step
          result={check?.sign}
          hash={s.signTxHash}
          method="agent_intent_swap"
          who={<AccountLink id={cfg.agentId} />}
          what={
            <>
              The vault checked the policy, wrote the NEP-413 intent itself and had <span className="mono">{cfg.signerId}</span> sign it
              {signedKeyOk === true ? ", under the key above." : signedKeyOk === false ? <strong>, under a key that is not the derived one.</strong> : "."}
            </>
          }
        />
        <Step
          result={check ? (check.execute ?? undefined) : undefined}
          hash={s.executeTxHash}
          method="execute_intents"
          who={<span className="mono">{cfg.verifierId}</span>}
          what={
            check?.intentHash ? (
              <>
                Intent <span className="mono">{shorten(check.intentHash, 6, 4)}</span> executed: exactly the signed token_diff. Its hash was recomputed in this browser
                from the payload the vault signed.
              </>
            ) : (
              "A solver filled the intent; the Verifier executed it."
            )
          }
        />
        <Step
          result={check ? (check.settle ?? undefined) : undefined}
          hash={s.settleTxHash}
          method="settle_intent_swap"
          who={<AccountLink id={cfg.agentId} />}
          what={<>The nonce was used, so the vault credited the owner exactly {outMeta ? `${formatUnits(amountOut, outMeta.decimals)} ${outMeta.symbol}` : "the amount out"}.</>}
        />
      </ol>
    </Check>
  );
}

function Step({ result, hash, method, who, what }: { result: SwapCheck["sign"] | NonNullable<SwapCheck["execute"]> | undefined; hash: string; method: string; who: ReactNode; what: ReactNode }) {
  return (
    <li className="swap-step">
      <p className="swap-step-call">
        <span className="call-method mono">{method}</span>
        <span className="swap-step-who">by {who}</span>
      </p>
      <p className="swap-step-what">{what}</p>
      <p className="swap-step-proof">
        {result === undefined ? (
          <Badge tone="neutral">Unchecked</Badge>
        ) : result.ok ? (
          <Badge tone="ok">Verified</Badge>
        ) : (
          <>
            <Badge tone="alert">Failed</Badge> <span>{TX_PROBLEM[result.problem]}</span>
          </>
        )}
        <TxLink hash={hash} />
      </p>
    </li>
  );
}

/**
 * Where the swap's price sits against the floor, on a scale from zero. Below the floor is what the
 * vault refuses; everything from the floor up it would sign. Text says the same next to it.
 */
function FloorScale({ rate, floorRate, text }: { rate: bigint; floorRate: bigint; text: (r: bigint) => string }) {
  // Up to the next tenth above 120% of the larger figure.
  const top = (((rate > floorRate ? rate : floorRate) * 12n) / 10n / 100n + 1n) * 100n;
  const at = (r: bigint) => `${Number((r * 10000n) / top) / 100}%`;
  return (
    <div className="floor-scale" aria-hidden="true">
      <div className="floor-track">
        <span className="floor-refused" style={{ width: at(floorRate) }} />
        <span className="floor-mark" style={{ left: at(floorRate) }} />
        <span className="floor-dot" style={{ left: at(rate) }} />
      </div>
      <span className="floor-label floor-label--swap" style={{ left: at(rate) }}>
        this swap {text(rate)}
      </span>
      <span className="floor-label floor-label--floor" style={{ left: at(floorRate) }}>
        floor {text(floorRate)}
      </span>
      <span className="floor-label floor-label--zero">refused below the floor</span>
    </div>
  );
}

function FullAccessCaveat({ cfg, q, repo }: { cfg: IntentsConfig; q: Q; repo: string }) {
  const list = q.accountKeys.data;
  const full = list?.value.filter((k) => k.permission === "FullAccess") ?? [];
  const link = (
    <a href={`${repo}/blob/master/THREAT_MODEL.md#trust-assumptions-intents-path`} target="_blank" rel="noopener noreferrer" className="intents-caveat-link">
      THREAT_MODEL.md <Icon name="external" size={12} />
    </a>
  );
  return (
    <aside className="intents-caveat" role="note" aria-live="polite">
      <Icon name="key" size={18} />
      <p>
        {list === undefined ? (
          q.accountKeys.isError ? (
            <>Could not read {cfg.vaultId}'s access keys; retrying. See {link}.</>
          ) : (
            <Skeleton size="l" />
          )
        ) : list === null ? (
          <>
            <strong>{cfg.vaultId} no longer exists.</strong> See {link}.
          </>
        ) : full.length > 0 ? (
          <>
            <strong>Caveat: the vault account still holds a full-access upgrade key</strong> (
            {full.map((k, i) => (
              <span key={k.publicKey}>
                {i > 0 ? ", " : ""}
                <span className="mono" title={k.publicKey}>
                  {shorten(k.publicKey, 14, 4)}
                </span>
              </span>
            ))}
            , read at block <span className="mono">{formatInt(list.source.blockHeight)}</span>). Whoever holds it can sign intents for the vault outside every check
            above, or replace its code. The operator keeps it offline until the account is locked. {link}
          </>
        ) : (
          <>
            <strong>The vault account holds no full-access key</strong> (read at block <span className="mono">{formatInt(list.source.blockHeight)}</span>): its code
            can no longer change, and only the contract can ask for signatures. {link}
          </>
        )}
      </p>
    </aside>
  );
}
