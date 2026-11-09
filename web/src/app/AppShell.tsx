import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { switchNetwork } from "../config/active";
import type { NetworkId } from "../config/networks";
import { Icon } from "../ui/primitives";
import { useServices } from "./services";
import { useTheme } from "./theme";
import { useWallet } from "../wallet/WalletProvider";
import { shorten } from "../ui/format";

export function AppShell({ children }: { children: ReactNode }) {
  const { config } = useServices();
  const { dark, toggle } = useTheme();
  const other: NetworkId = config.networkId === "testnet" ? "mainnet" : "testnet";

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      {config.networkId === "testnet" && (
        <div className="network-strip" role="note">
          <span className="mono">TESTNET</span> Test tokens only. Nothing here has real value.
        </div>
      )}
      <header className="masthead">
        <div className="masthead-inner">
          <NavLink to="/" className="wordmark" aria-label="Intatto, home">
            <span className="wordmark-name">Intatto</span>
            <span className="wordmark-tag">Your money stays intact.</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end className="nav-link">
              Board
            </NavLink>
            <NavLink to="/vault" className="nav-link">
              Your vault
            </NavLink>
          </nav>
          <div className="masthead-tools">
            <button type="button" className="net-switch mono" onClick={() => switchNetwork(other)} title={`Switch to ${other}`} aria-label={`${config.label}. Switch to ${other}`}>
              <span className={`net-dot net-dot--${config.networkId}`} aria-hidden="true" />
              <span className="net-label">{config.label}</span>
            </button>
            <WalletButton />
            <button type="button" className="icon-btn" onClick={toggle} aria-label={dark ? "Use light theme" : "Use dark theme"}>
              <Icon name={dark ? "sun" : "moon"} size={18} />
            </button>
          </div>
        </div>
      </header>
      {children}
      <footer className="colophon">
        <div className="colophon-inner">
          <p className="colophon-rule">
            <Icon name="shield" size={16} /> Rules are enforced by the vault contract on chain; this page only reads and asks your wallet to sign.
          </p>
          <p className="colophon-meta">
            Reads from <span className="mono">{new URL(config.rpcUrl).host}</span>. No keys are held by this page.{" "}
            <a href={config.repoUrl} target="_blank" rel="noopener noreferrer">
              Source
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

function WalletButton() {
  const w = useWallet();
  if (w.status === "connected" && w.accountId) {
    return (
      <details className="wallet-menu">
        <summary className="wallet-btn mono" title={w.accountId}>
          <span className="wallet-dot" aria-hidden="true" />
          {shorten(w.accountId, 14, 8)}
        </summary>
        <div className="wallet-pop">
          <p className="muted small">Signed in as</p>
          <p className="mono wallet-acct">{w.accountId}</p>
          <button type="button" className="btn btn--quiet btn--small btn--block" onClick={() => void w.disconnect()}>
            Disconnect
          </button>
        </div>
      </details>
    );
  }
  return (
    <button type="button" className="wallet-btn" onClick={() => void w.connect()} disabled={w.status === "connecting" || w.status === "restoring"}>
      {w.status === "connecting" ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
