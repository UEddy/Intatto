// Measurement only: exposes the real adapter so a script can drive each wallet's connect and
// sign flows and record their network use. Served by the dev server; not part of the build.
import { TESTNET } from "../../src/config/networks";
import { NearConnectAdapter } from "../../src/wallet/nearConnect";

// Testnet: no passkey wallet, so the adapter never waits for finality; the harness signs nothing.
const adapter = new NearConnectAdapter(TESTNET, async () => {}, "/");
(window as unknown as { harness: unknown }).harness = {
  ready: adapter.connector.whenManifestLoaded,
  wallets: () => adapter.connector.availableWallets.map((w) => w.manifest.id),
  connect: (walletId: string) => adapter.connector.connect({ walletId }).then(() => "connected", (e: unknown) => `connect error: ${String(e)}`),
  sign: async (walletId: string) => {
    const wallet = await adapter.connector.wallet(walletId);
    return wallet
      .signAndSendTransactions({
        network: "testnet",
        transactions: [{ receiverId: "vault-v1.intatto-dev.testnet", actions: [{ type: "FunctionCall", params: { methodName: "freeze", args: {}, gas: "30000000000000", deposit: "0" } }] }],
      })
      .then(() => "signed", (e: unknown) => `sign error: ${String(e)}`);
  },
};

// Real buttons, so flows start with a user gesture the way they do on the site.
for (const id of ["meteor-wallet", "intear-wallet"]) {
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
