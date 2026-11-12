import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ServicesProvider } from "../app/services";
import { MAINNET } from "../config/networks";
import { WalletRejectedError, type SignerAdapter } from "./types";
import { useWallet, WalletProvider } from "./WalletProvider";

function adapterThatFails(error: Error): SignerAdapter {
  return {
    id: "stub",
    label: "Stub",
    capabilities: { batch: true },
    accountId: async () => null,
    connect: async () => {
      throw error;
    },
    disconnect: async () => {},
    submit: async () => {
      throw new Error("never");
    },
  };
}

function Probe() {
  const w = useWallet();
  return (
    <>
      <button type="button" onClick={() => void w.connect()}>
        Connect
      </button>
      <p data-testid="status">{w.status}</p>
      {w.error && <p role="alert">{w.error}</p>}
    </>
  );
}

async function connectWith(error: Error) {
  render(
    <ServicesProvider config={MAINNET}>
      <WalletProvider adapter={adapterThatFails(error)}>
        <Probe />
      </WalletProvider>
    </ServicesProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  });
}

describe("connecting a wallet", () => {
  it("resets quietly when the picker is dismissed: no error shown", async () => {
    await connectWith(new WalletRejectedError());
    expect(screen.getByTestId("status").textContent).toBe("disconnected");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("cancelled");
  });

  it("shows a real failure", async () => {
    await connectWith(new Error("The wallet connected without an account"));
    expect(screen.getByTestId("status").textContent).toBe("disconnected");
    expect(screen.getByRole("alert").textContent).toBe("The wallet connected without an account");
  });
});
