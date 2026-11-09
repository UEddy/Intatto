/** A scripted fetch: each call takes the next step, which may inspect the request. */
export type Step =
  | { status: number; body: string | ((request: { url: string; body: unknown }) => string) }
  | { throws: Error };

export interface FakeFetch {
  fetch: typeof fetch;
  calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[];
}

export function fakeFetch(steps: Step[]): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  let i = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
    const step = steps[Math.min(i++, steps.length - 1)];
    if (!step) throw new Error("no step");
    if ("throws" in step) throw step.throws;
    const text = typeof step.body === "function" ? step.body({ url, body }) : step.body;
    return { status: step.status, text: async () => text } as unknown as Response;
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A JSON-RPC body answering the request with the same id. */
export const rpcResult =
  (result: unknown) =>
  ({ body }: { body: unknown }) =>
    JSON.stringify({ jsonrpc: "2.0", id: (body as { id: string }).id, result });

export const rpcError =
  (name: string, cause: string, data: unknown = "") =>
  ({ body }: { body: unknown }) =>
    JSON.stringify({ jsonrpc: "2.0", id: (body as { id: string }).id, error: { name, cause: { name: cause, info: {} }, code: -32000, data, message: "Server error" } });
