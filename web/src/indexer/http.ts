import { IndexerError, type ActivitySource } from "./types";

export interface HttpOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * One request, one answer: no retries here (the ResilientSource backs off between polls).
 * Anything but a 200 with a JSON body throws an IndexerError.
 */
export async function getJson(
  source: ActivitySource["id"],
  url: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  options: HttpOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let status: number;
  let raw: string;
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      // GETs send no Content-Type, so they stay CORS "simple requests" with no preflight.
      ...(init.method === "POST"
        ? { headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(init.body) }
        : { headers: { Accept: "application/json" } }),
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    status = res.status;
    raw = await res.text();
  } catch (e) {
    const what = controller.signal.aborted ? "timed out" : `network error (${String(e)})`;
    throw new IndexerError(source, `${what}; possibly rate limited`, true);
  } finally {
    clearTimeout(timer);
  }
  if (status === 429) throw new IndexerError(source, "rate limited (HTTP 429)", true, raw);
  if (status !== 200) throw new IndexerError(source, `HTTP ${status}`, false, raw);
  try {
    return JSON.parse(raw);
  } catch {
    throw new IndexerError(source, "response is not JSON", false, raw);
  }
}
