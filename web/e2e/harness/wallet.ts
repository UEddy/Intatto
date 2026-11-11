// Measurement only: exposes the real adapter so a script can drive each wallet's connect and
// sign flows and record their network use. Served by the dev server; not part of the build.
// `?network=mainnet` measures on mainnet (all four pinned wallets plus passkey), else testnet.
import { MAINNET, TESTNET } from "../../src/config/networks";
import { NearConnectAdapter } from "../../src/wallet/nearConnect";

const config = new URLSearchParams(location.search).get("network") === "mainnet" ? MAINNET : TESTNET;
// The harness signs nothing (no wallet is logged in), so the adapter never waits for finality.
const adapter = new NearConnectAdapter(config, async () => {}, "/");
// A freeze of the caller's own vault: harmless if a wallet ever did sign it.
const receiverId = config.vaultId ?? "vault-v1.intatto-dev.testnet";
(window as unknown as { harness: unknown }).harness = {
  network: config.networkId,
  ready: adapter.connector.whenManifestLoaded,
  wallets: () => adapter.connector.availableWallets.map((w) => w.manifest.id),
  connect: (walletId: string) => adapter.connector.connect({ walletId }).then(() => "connected", (e: unknown) => `connect error: ${String(e)}`),
  sign: async (walletId: string) => {
    const wallet = await adapter.connector.wallet(walletId);
    return wallet
      .signAndSendTransactions({
        network: config.networkId,
        transactions: [{ receiverId, actions: [{ type: "FunctionCall", params: { methodName: "freeze", args: {}, gas: "30000000000000", deposit: "0" } }] }],
      })
      .then(() => "signed", (e: unknown) => `sign error: ${String(e)}`);
  },
};

// Real buttons, so flows start with a user gesture the way they do on the site.
for (const id of ["meteor-wallet", "intear-wallet", "hot-wallet", "mynearwallet"]) {
  for (const flow of ["connect", "sign"] as const) {
    const b = document.createElement("button");
    b.id = `${flow}-${id}`;
    b.textContent = `${flow} ${id}`;
    b.onclick = () => {
      const h = (window as unknown as { harness: Record<string, (id: string) => Promise<string>> }).harness;
      void h[flow]!(id).then((r) => (document.title = r));
    };
    document.body.append(b);
  }
}
