import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesProvider, type Services } from "../app/services";
import { MAINNET } from "../config/networks";
import type { VaultView } from "../contract/abi.gen";
import { SetupProgress } from "./SetupProgress";

const V = "vault.intatto.near";
const vault = (over: Partial<VaultView>) => ({ balance: "1", frozen: false, agent_id: "agent.near", policy: {}, recent_spends: [], tokens: [], withdrawals_locked_until: null, ...over }) as unknown as VaultView;

function renderWith(v: VaultView | null, keys: { permission: unknown }[] | null) {
  const chain = { accessKeyList: async () => (keys ? { value: keys } : null) };
  const services = { config: MAINNET, chain } as unknown as Services;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ServicesProvider config={MAINNET} services={services}>
        <SetupProgress vault={v} vaultId={V} lockActive={false} />
      </ServicesProvider>
    </QueryClientProvider>,
  );
}

describe("SetupProgress", () => {
  it("reads the agent's keys and marks the next step", async () => {
    renderWith(vault({}), [{ permission: { FunctionCall: { allowance: "1", receiver_id: V, method_names: ["agent_swap"] } } }]);
    await waitFor(() => expect(screen.getByLabelText("3 of 4 done")).toBeTruthy());
    const next = document.querySelector('[aria-current="step"]');
    expect(next?.textContent).toContain("Connect the agent");
  });

  it("without a vault-only key, the key step is next", async () => {
    renderWith(vault({}), [{ permission: "FullAccess" }]);
    await waitFor(() => expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Give the agent a vault-only key"));
  });

  it("disappears once the required steps are done", async () => {
    const { container } = renderWith(vault({ recent_spends: [{}] as never }), [{ permission: { FunctionCall: { allowance: "1", receiver_id: V, method_names: ["agent_swap"] } } }]);
    await waitFor(() => expect(container.querySelector(".setup")).toBeNull());
  });
});
