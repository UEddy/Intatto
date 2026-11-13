import { useQuery } from "@tanstack/react-query";
import { useServices } from "../app/services";
import type { VaultView } from "../contract/abi.gen";
import { Icon } from "../ui/primitives";
import { hasVaultKey, progress, setupSteps } from "./setup";

/**
 * The owner's setup as a checklist read from the chain: what is done, what to do next, and a jump
 * to the section that does it. It signs nothing. Hidden once the required steps are done.
 */
function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SetupProgress({ vault, vaultId, lockActive }: { vault: VaultView | null; vaultId: string; lockActive: boolean }) {
  const { chain, config } = useServices();
  const agentId = vault?.agent_id ?? null;
  const keys = useQuery({
    queryKey: [config.networkId, "agent-keys", agentId],
    queryFn: () => chain.accessKeyList(agentId!),
    enabled: !!agentId,
    refetchInterval: 15_000,
  });
  const steps = setupSteps(vault, agentId ? hasVaultKey(keys.data?.value, vaultId) : false, lockActive);
  const { done, total } = progress(steps);
  if (done === total) return null;
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  return (
    <section className="setup" aria-labelledby="setup-title">
      <header className="setup-head">
        <h2 id="setup-title" className="setup-title">
          Set up in {total} steps
        </h2>
        <p className="setup-count mono" aria-label={`${done} of ${total} done`}>
          {done}/{total}
        </p>
      </header>
      <div className="setup-bar" aria-hidden="true">
        <span style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={`setup-step setup-step--${s.state}`} aria-current={s.state === "next" ? "step" : undefined}>
            <button type="button" className="setup-btn" onClick={() => go(s.target)}>
              <span className="setup-mark" aria-hidden="true">
                {s.state === "done" ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span className="setup-text">
                <span className="setup-step-title">
                  {s.title}
                  {s.optional && <span className="setup-optional"> · optional</span>}
                  <span className="visually-hidden">{s.state === "done" ? " (done)" : s.state === "next" ? " (next)" : ""}</span>
                </span>
                {s.state === "next" && <span className="setup-detail">{s.detail}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
