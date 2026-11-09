import type { UseQueryResult } from "@tanstack/react-query";
import { useServices } from "../app/services";
import type { IntegrityState } from "../canary/board";
import type { SourceMetadata } from "../contract/views";
import { base58ToHex } from "../near/base58";
import { NO_CODE_HASH, type Sourced } from "../near/chain";
import { formatAgo, formatInt } from "../ui/format";
import { Badge, Icon, SectionMark, Skeleton } from "../ui/primitives";
import { useNow } from "../ui/useNow";

type Account = Sourced<{ amount: bigint; locked: bigint; codeHash: string; storageUsage: number }> | null;

const HEADLINE: Record<IntegrityState, string> = {
  matches: "Matches the published build",
  changed: "CODE CHANGED",
  unconfigured: "No published build to compare yet",
  unknown: "Checking…",
};

export function IntegrityCheck({ state, code, sourceMeta }: { state: IntegrityState; code: UseQueryResult<Account>; sourceMeta: UseQueryResult<Sourced<SourceMetadata>> }) {
  const { config } = useServices();
  const now = useNow(1000);
  const expected = config.expectedBuild;
  const onChain = code.data === null ? "account deleted" : code.data?.value.codeHash === NO_CODE_HASH ? "no code" : code.data?.value.codeHash;
  const buildInfo = sourceMeta.data?.value.build_info;

  return (
    <section className={`integrity integrity--${state}`} aria-labelledby="integrity-title" aria-live="polite">
      <div className="integrity-head">
        <SectionMark>Integrity check</SectionMark>
        <h2 id="integrity-title" className="integrity-title">
          {state === "matches" ? <Badge tone="ok">Matches</Badge> : null}
          <span>{HEADLINE[state]}</span>
        </h2>
        <p className="integrity-when">
          {code.dataUpdatedAt ? (
            <>
              Last checked {formatAgo(now - code.dataUpdatedAt)}
              {code.data ? (
                <>
                  {" "}
                  at block <span className="mono">{formatInt(code.data.source.blockHeight)}</span>
                </>
              ) : null}
              {code.isError ? " (the latest check failed; retrying)" : ""}
            </>
          ) : (
            "Reading the vault's code…"
          )}
        </p>
      </div>

      <dl className="hashes">
        <div className="hash-row">
          <dt>Running on chain</dt>
          <dd className="mono hash">{onChain ?? <Skeleton size="l" />}</dd>
          {code.data && code.data.value.codeHash !== NO_CODE_HASH && <dd className="mono hash-hex">hex {hexOrBlank(code.data.value.codeHash)}</dd>}
          <dd className="hash-from">
            <span className="mono">view_account({config.vaultId}).code_hash</span>
          </dd>
        </div>
        <div className="hash-row">
          <dt>Published reproducible build</dt>
          <dd className="mono hash">{expected ? expected.codeHash : "not configured"}</dd>
          {expected && <dd className="mono hash-hex">hex {hexOrBlank(expected.codeHash)}</dd>}
          <dd className="hash-from">
            {expected ? (
              <>
                <a href={`${config.repoUrl}/commit/${expected.commit}`} target="_blank" rel="noopener noreferrer" className="mono">
                  commit {expected.commit.slice(0, 7)}
                </a>{" "}
                · <span className="mono">{expected.image}</span>
              </>
            ) : (
              "The reproducible build's hash goes in the network config."
            )}
          </dd>
        </div>
      </dl>

      <details className="verify">
        <summary>Verify it yourself</summary>
        <ol>
          <li>
            Check out {expected ? <span className="mono">{expected.commit.slice(0, 7)}</span> : "the published commit"} of{" "}
            <a href={config.repoUrl} target="_blank" rel="noopener noreferrer">
              the repository
            </a>{" "}
            and run <code>cargo near build reproducible-wasm</code>. It builds in the pinned Docker image, so you get the same bytes.
          </li>
          <li>
            Hash the file: <code>sha256sum target/near/intatto.wasm</code>. That prints hex, the second line of each hash above.
          </li>
          <li>
            Compare with what the chain runs:{" "}
            <code>
              near account view-account-summary {config.vaultId} network-config {config.networkId} now
            </code>{" "}
            prints it as "Local Contract (SHA-256 checksum hex)". RPC reports the same digest in base58, the first line.
          </li>
        </ol>
        <p className="muted small">
          The contract's own source metadata (NEP-330){" "}
          {buildInfo ? (
            <>
              names build environment <span className="mono">{buildInfo.build_environment}</span> and snapshot <span className="mono">{buildInfo.source_code_snapshot}</span>.
            </>
          ) : sourceMeta.data ? (
            <>
              has <span className="mono">build_info: null</span>: the code running now was not built reproducibly.
            </>
          ) : (
            "is loading."
          )}
        </p>
      </details>
      <p className="integrity-note">
        <Icon name="shield" size={16} /> A code change does not prove theft, and a match does not prove safety. It tells you whether the code you can read is the code
        that runs.
      </p>
    </section>
  );
}

function hexOrBlank(b58: string): string {
  try {
    return base58ToHex(b58);
  } catch {
    return "(not base58)";
  }
}
