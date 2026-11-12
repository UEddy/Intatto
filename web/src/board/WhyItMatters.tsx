import { Icon } from "../ui/primitives";

const SOURCE = "https://www.theblock.co/post/318074/banana-gun-exploit-refund";

/** The README's Banana Gun paragraph, with what changes when the key leaves the bot. */
export function WhyItMatters() {
  return (
    <div className="why">
      <div className="why-story">
        <p>
          Today most trading bots hold your private key. In September 2024, attackers exploited a flaw in the Telegram trading bot Banana Gun and drained about $3
          million from 11 users' bot wallets; because the bot held the keys, every transfer was a valid signed transaction that nothing on chain could refuse. The
          team refunded the users from its treasury.
        </p>
        <p className="why-source small muted">
          Source:{" "}
          <a href={SOURCE} target="_blank" rel="noopener noreferrer">
            The Block <Icon name="external" size={12} />
          </a>
        </p>
      </div>
      <ul className="why-compare" aria-label="A bot that holds your key, and Intatto">
        <li className="why-row why-row--bad">
          <span className="why-tag">A bot with your key</span>
          <span>Every transfer it signs is valid. Nothing on chain can refuse it.</span>
        </li>
        <li className="why-row why-row--good">
          <span className="why-tag">Intatto</span>
          <span>The agent signs only calls the vault's policy allows, and the money stays in a contract it cannot empty.</span>
        </li>
      </ul>
    </div>
  );
}
