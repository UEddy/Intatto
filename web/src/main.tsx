import "@fontsource-variable/bodoni-moda/opsz.css";
import "@fontsource-variable/bodoni-moda/opsz-italic.css";
import "@fontsource-variable/instrument-sans/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/board.css";
import "./styles/seal.css";
import "./styles/landing.css";
import "./styles/console.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Outlet, RouterProvider } from "react-router";
import { AppShell } from "./app/AppShell";
import { ServicesProvider } from "./app/services";
import { BoardPage } from "./board/BoardPage";
import { activeNetwork } from "./config/active";
import { ConsolePage } from "./console/ConsolePage";
import { WalletProvider } from "./wallet/WalletProvider";

const config = activeNetwork();
document.documentElement.dataset.network = config.networkId;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The RPC client already retries with backoff; one more round at this level is plenty.
      retry: 1,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      staleTime: 5_000,
    },
  },
});

// Hash routes: GitHub Pages serves one index.html, so the path never reaches the server.
const router = createHashRouter([
  {
    element: (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
    children: [
      { path: "/", element: <BoardPage /> },
      { path: "/vault", element: <ConsolePage /> },
    ],
  },
]);

// E2E builds swap in a scripted wallet; the production build drops this branch and the module.
const testAdapter = import.meta.env.VITE_E2E === "1" ? new (await import("./wallet/fakeAdapter")).FakeAdapter() : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ServicesProvider config={config}>
        <WalletProvider {...(testAdapter ? { adapter: testAdapter } : {})}>
          <RouterProvider router={router} />
        </WalletProvider>
      </ServicesProvider>
    </QueryClientProvider>
  </StrictMode>,
);
