import type { VaultView } from "../contract/abi.gen";
import { useAction } from "./ActionSheet";
import { freeze, unfreeze } from "./intents";

/**
 * The kill switch. `freeze` needs no deposit, so the wallet can sign it with any key it holds for
 * the account; the review sheet still shows it before signing, because nothing is signed unseen.
 * On phones it is a fixed bar at the bottom of the screen.
 */
export function KillSwitch({ vaultId, vault }: { vaultId: string; vault: VaultView }) {
  const run = useAction();
  if (vault.frozen) {
    return (
      <div className="kill kill--frozen" role="region" aria-label="Kill switch">
        <div className="kill-text">
          <p className="kill-title">Frozen</p>
          <p className="kill-sub">Every agent spend and swap is refused.</p>
        </div>
        <button type="button" className="btn btn--quiet kill-btn" onClick={() => run(unfreeze({ vaultId, frozen: true }), { doneVerb: "Unfrozen" })}>
          Unfreeze
        </button>
      </div>
    );
  }
  return (
    <div className="kill" role="region" aria-label="Kill switch">
      <div className="kill-text">
        <p className="kill-title">Kill switch</p>
        <p className="kill-sub">Stops the agent from the next call on. Your funds stay.</p>
      </div>
      <button type="button" className="kill-btn kill-btn--wax" onClick={() => run(freeze({ vaultId, frozen: false }), { doneVerb: "Frozen" })}>
        Freeze vault
      </button>
    </div>
  );
}
