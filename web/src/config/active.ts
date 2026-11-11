/**
 * Which network the page runs on: `?network=mainnet|testnet` in the URL, else the last choice
 * (localStorage), else the build default (VITE_DEFAULT_NETWORK, mainnet if unset). Switching
 * reloads the page so no query, cache or wallet session crosses networks.
 */
import { NETWORKS, type NetworkConfig, type NetworkId } from "./networks";

const KEY = "intatto.network";

function isNetworkId(v: unknown): v is NetworkId {
  return v === "testnet" || v === "mainnet";
}

export function resolveNetwork(search: string, stored: string | null, buildDefault: string | undefined): NetworkId {
  const fromUrl = new URLSearchParams(search).get("network");
  if (isNetworkId(fromUrl)) return fromUrl;
  if (isNetworkId(stored)) return stored;
  if (isNetworkId(buildDefault)) return buildDefault;
  return "mainnet";
}

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function activeNetwork(): NetworkConfig {
  const id = resolveNetwork(window.location.search, readStored(), import.meta.env.VITE_DEFAULT_NETWORK as string | undefined);
  return NETWORKS[id];
}

export function switchNetwork(id: NetworkId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Without storage the URL parameter still carries the choice.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("network", id);
  window.location.assign(url.toString());
}
