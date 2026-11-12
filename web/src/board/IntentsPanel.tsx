import type { UseQueryResult } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import { useServices } from "../app/services";
import type { IntentsConfig } from "../config/networks";
import { floorFor, meetsFloor, rateScaled, TX_PROBLEM, type KeyState, type SwapCheck, type SwapValue, type Verdict } from "../intents/check";
import { useIntents } from "../intents/useIntents";
import { base58ToHex } from "../near/base58";
import { NO_CODE_HASH } from "../near/chain";
import { formatUnits } from "../near/units";
import { formatInt, shorten } from "../ui/format";
import { AccountLink, Badge, Icon, SectionMark, Skeleton, Traceable, TxLink } from "../ui/primitives";

/** Rates are stated to 3 decimals, rounded down. */
const RATE_PLACES = 3;

/**
 * What a check shows. "unverified" (no answer) is neutral and offers a retry; it is never drawn
 * as a pass, and never as a fail, which is reserved for the chain contradicting the claim.
 */
type Status<T> = { kind: "checking" } | { kind: "unverified"; reason: string } | { kind: "pass" | "fail"; value: T };

function statusOf<T>(q: UseQueryResult<Verdict<T>>): Status<T> {
  const d = q.data;
  if (!d) return { kind: "checking" };
  // Stays "unverified" while a poll or a retry runs: no flipping back to a loading state, ever.
  if (d.verdict === "unverified") return { kind: "unverified", reason: d.reason };
  return { kind: d.verdict, value: d.value };
}

const KEY_FAIL: Record<Exclude<KeyState, "one-derived" | "unknown">, { badge: string; title: string }> = {
  extra: { badge: "Extra key", title: "intents.near accepts another key for the vault" },
  mismatch: { badge: "Mismatch", title: "The key on intents.near is not the derived one" },
  none: { badge: "No key", title: "No key on intents.near: the vault cannot sign intents" },
};

export function IntentsPanel() {
  const { config } = useServices();
  const ref = useRef<HTMLElement>(null);
  const q = useIntents(ref);
  const cfg = q.cfg;
  if (!cfg) return null;
  const repo = config.repoUrl;

  const build = statusOf(q.build);
  const key = statusOf(q.key);
  const keyFail = key.kind === "fail" && key.value.state !== "one-derived" && key.value.state !== "unknown" ? KEY_FAIL[key.value.state] : null;
  const swap = statusOf(q.swap);

  return (
    <section ref={ref} className="intents" aria-labelledby="intents-title">
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
        <Check
          n="1"
          label="Build"
          status={build}
          query={q.build}
          pass={{ badge: "Matches", title: "Runs the published build" }}
          fail={{ badge: "Changed", title: "CODE CHANGED" }}
          checking="Reading the vault's code…"
        >
          <dl className="hashes">
            <div className="hash-row">
              <dt>Running on chain</dt>
              <dd>
                {build.kind === "pass" || build.kind === "fail" ? (
                  <Traceable source={build.value.source ?? undefined} path=".code_hash">
                    <span className="mono hash">{build.value.codeHash === null ? "account deleted" : build.value.codeHash === NO_CODE_HASH ? "no code" : build.value.codeHash}</span>
                  </Traceable>
                ) : (
                  <Pending checking={build.kind === "checking"} />
                )}
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

        <Check
          n="2"
          label="Key"
          status={key}
          query={q.key}
          pass={{ badge: "One key", title: "One key on intents.near, and it is the MPC network's" }}
          fail={keyFail ?? { badge: "Mismatch", title: "The keys do not match" }}
          checking="Reading both keys…"
        >
          <dl className="hashes">
            <div className="hash-row">
              <dt>Keys for the vault on {cfg.verifierId}</dt>
              <dd>
                {key.kind === "pass" || key.kind === "fail" ? (
                  <Traceable source={key.value.keysSource}>
                    {key.value.keys.length === 0 ? (
                      <span className="mono hash">none</span>
                    ) : (
                      <ul className="key-list" aria-label={`${key.value.keys.length} key${key.value.keys.length === 1 ? "" : "s"}`}>
                        {key.value.keys.map((k) => (
                          <li key={k} className={`mono hash${k !== key.value.derived ? " hash--odd" : ""}`}>
                            {k}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Traceable>
                ) : (
                  <Pending checking={key.kind === "checking"} />
                )}
              </dd>
            </div>
            <div className="hash-row">
              <dt>Derived by {cfg.signerId} for the vault</dt>
              <dd>
                {key.kind === "pass" || key.kind === "fail" ? (
                  <Traceable source={key.value.derivedSource}>
                    <span className="mono hash">{key.value.derived}</span>
                  </Traceable>
                ) : (
                  <Pending checking={key.kind === "checking"} />
                )}
              </dd>
              <dd className="hash-from mono">
                path {cfg.keyPath} · domain {cfg.keyDomain} (Ed25519)
              </dd>
            </div>
          </dl>
          <p className="intents-fact">
            <Icon name="lock" size={16} />
            <span>
              <strong>No single party holds its private key:</strong> it exists only as shares across {cfg.signerId}'s MPC nodes, and signing needs a threshold of them.
              They sign under it only for requests that come from <span className="mono">{cfg.vaultId}</span> itself.
            </span>
          </p>
        </Check>

        <Check
          n="3"
          label="Swap"
          status={swap}
          query={q.swap}
          pass={{ badge: "Settled", title: "One swap, signed, executed and settled" }}
          fail={{ badge: "Check failed", title: "The swap's transactions do not check out" }}
          checking="Reading the swap's three transactions…"
        >
          {swap.kind === "pass" || swap.kind === "fail" ? <SwapBody cfg={cfg} v={swap.value} derived={key.kind === "pass" || key.kind === "fail" ? key.value.derived : undefined} /> : null}
        </Check>
      </ol>

      <Caveat cfg={cfg} q={q.caveat} repo={repo} />
    </section>
  );
}

function Check<T>({
  n,
  label,
  status,
  query,
  pass,
  fail,
  checking,
  children,
}: {
  n: string;
  label: string;
  status: Status<T>;
  query: UseQueryResult<Verdict<T>>;
  pass: { badge: string; title: string };
  fail: { badge: string; title: string };
  checking: string;
  children: ReactNode;
}) {
  const k = status.kind;
  return (
    <li className={`icheck icheck--${k}`} aria-live="polite" aria-busy={k === "checking"}>
      <span className="rules-num" aria-hidden="true">
        {n}
      </span>
      <div className="icheck-body">
        <h3 className="icheck-title">
          <span className="icheck-label">{label}</span>
          {k === "pass" ? (
            <Badge tone="ok">
              <Icon name="check" size={12} /> {pass.badge}
            </Badge>
          ) : k === "fail" ? (
            <Badge tone="alert">{fail.badge}</Badge>
          ) : k === "unverified" ? (
            <Badge tone="neutral">Unverified</Badge>
          ) : (
            <Badge tone="neutral">Checking</Badge>
          )}
          {k !== "unverified" && <span className="icheck-claim">{k === "pass" ? pass.title : k === "fail" ? fail.title : checking}</span>}
        </h3>
        {status.kind === "unverified" && <RetryLine reason={status.reason} onRetry={() => void query.refetch()} busy={query.isFetching} />}
        {children}
      </div>
    </li>
  );
}

/** The neutral state: no answer from the chain, so nothing is claimed either way. */
function RetryLine({ reason, onRetry, busy, children }: { reason: string; onRetry: () => void; busy: boolean; children?: ReactNode }) {
  return (
    <p className="intents-retry" title={reason}>
      <span>{children ?? "Couldn't verify right now."}</span>
      <button type="button" className="btn btn--quiet btn--small intents-retry-btn" onClick={onRetry} disabled={busy} aria-label="Retry">
        {busy ? "Retrying…" : "Retry"}
      </button>
    </p>
  );
}

/** A value not read yet: a placeholder while checking, "Not read" when unverified. */
function Pending({ checking }: { checking: boolean }) {
  return checking ? <Skeleton size="l" /> : <span className="mono hash hash--unread">Not read</span>;
}

function SwapBody({ cfg, v, derived }: { cfg: IntentsConfig; v: SwapValue; derived: string | undefined }) {
  const s = cfg.swap;
  const { tokenIn: inMeta, tokenOut: outMeta, swap: check } = v;
  const amountIn = BigInt(s.amountIn);
  const amountOut = BigInt(s.amountOut);
  const floor = floorFor(v.policy, s.tokenIn, s.tokenOut);
  const rate = rateScaled(amountIn, amountOut, inMeta.decimals, outMeta.decimals, RATE_PLACES);
  const floorRate = floor ? rateScaled(floor.perIn, floor.minOut, inMeta.decimals, outMeta.decimals, RATE_PLACES) : null;
  const rateText = (r: bigint) => formatUnits(r, RATE_PLACES);
  const pair = `${outMeta.symbol} per ${inMeta.symbol}`;
  const signedKeyOk = check.sign.ok && derived !== undefined ? check.sign.signed.publicKey === derived : null;

  return (
    <>
      <p className="swap-figure" aria-label={`${formatUnits(amountIn, inMeta.decimals)} ${inMeta.symbol} for ${formatUnits(amountOut, outMeta.decimals)} ${outMeta.symbol}`}>
        <span className="swap-amt">
          {formatUnits(amountIn, inMeta.decimals)}
          <span className="swap-unit">{inMeta.symbol}</span>
        </span>
        <span className="swap-arrow" aria-hidden="true">
          <Icon name="arrow" size={22} />
        </span>
        <span className="swap-amt">
          {formatUnits(amountOut, outMeta.decimals)}
          <span className="swap-unit">{outMeta.symbol}</span>
        </span>
      </p>

      <div className="floor">
        {floorRate !== null ? (
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
        ) : (
          <p className="floor-note">The owner's intent policy no longer lists this pair, so the vault would refuse this swap today.</p>
        )}
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
              <dd className="mono">{formatInt(v.policySource.blockHeight)}</dd>
            </div>
          </dl>
        </details>
      </div>

      <ol className="swap-steps">
        <Step
          result={check.sign}
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
          result={check.execute ?? undefined}
          hash={s.executeTxHash}
          method="execute_intents"
          who={<span className="mono">{cfg.verifierId}</span>}
          what={
            check.intentHash ? (
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
          result={check.settle ?? undefined}
          hash={s.settleTxHash}
          method="settle_intent_swap"
          who={<AccountLink id={cfg.agentId} />}
          what={<>The nonce was used, so the vault credited the owner exactly {`${formatUnits(amountOut, outMeta.decimals)} ${outMeta.symbol}`}.</>}
        />
      </ol>
    </>
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
          <Badge tone="neutral">Not checked</Badge>
        ) : result.ok ? (
          <Badge tone="ok">
            <Icon name="check" size={12} /> Verified
          </Badge>
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
  // A label is centred on its point, except in the scale's last quarter, where it ends at its
  // point instead, so it never runs past the panel's edge on a narrow screen.
  const end = (r: bigint) => ((r * 100n) / top > 75n ? " floor-label--end" : "");
  return (
    <div className="floor-scale" aria-hidden="true">
      <div className="floor-track">
        <span className="floor-refused" style={{ width: at(floorRate) }} />
        <span className="floor-mark" style={{ left: at(floorRate) }} />
        <span className="floor-dot" style={{ left: at(rate) }} />
      </div>
      <span className={`floor-label floor-label--swap${end(rate)}`} style={{ left: at(rate) }}>
        this swap {text(rate)}
      </span>
      <span className={`floor-label floor-label--floor${end(floorRate)}`} style={{ left: at(floorRate) }}>
        floor {text(floorRate)}
      </span>
      <span className="floor-label floor-label--zero">refused below the floor</span>
    </div>
  );
}

function Caveat({ cfg, q, repo }: { cfg: IntentsConfig; q: ReturnType<typeof useIntents>["caveat"]; repo: string }) {
  const status = statusOf(q);
  const link = (
    <a href={`${repo}/blob/master/THREAT_MODEL.md#trust-assumptions-intents-path`} target="_blank" rel="noopener noreferrer" className="intents-caveat-link">
      THREAT_MODEL.md <Icon name="external" size={12} />
    </a>
  );
  const v = status.kind === "pass" || status.kind === "fail" ? status.value : null;
  return (
    <aside className={`intents-caveat intents-caveat--${status.kind}`} role="note" aria-live="polite" aria-busy={status.kind === "checking"}>
      <Icon name="key" size={18} />
      <div className="intents-caveat-text">
        {status.kind === "checking" ? (
          <p>
            <Skeleton size="l" />
          </p>
        ) : status.kind === "unverified" ? (
          <>
            <RetryLine reason={status.reason} onRetry={() => void q.refetch()} busy={q.isFetching} />
            <p>Whether {cfg.vaultId} still holds its full-access upgrade key could not be read. {link}</p>
          </>
        ) : v && v.keys === null ? (
          <p>
            <strong>{cfg.vaultId} no longer exists.</strong> {link}
          </p>
        ) : v && v.fullAccess.length > 0 ? (
          <p>
            <strong>Caveat: the vault account still holds a full-access upgrade key</strong> (
            {v.fullAccess.map((k, i) => (
              <span key={k}>
                {i > 0 ? ", " : ""}
                <span className="mono" title={k}>
                  {shorten(k, 14, 4)}
                </span>
              </span>
            ))}
            , read at block <span className="mono">{formatInt(v.blockHeight ?? 0)}</span>). Whoever holds it can sign intents for the vault outside every check above, or
            replace its code. The operator keeps it offline until the account is locked. {link}
          </p>
        ) : (
          <p>
            <strong>The vault account holds no full-access key</strong> (read at block <span className="mono">{formatInt(v?.blockHeight ?? 0)}</span>): its code can no
            longer change, and only the contract can ask for signatures. {link}
          </p>
        )}
      </div>
    </aside>
  );
}
