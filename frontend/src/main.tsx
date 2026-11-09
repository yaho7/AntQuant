import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App";
import { ToastProvider } from "@/components/toast";
import { AuthProvider } from "@/hooks/useAuth";
import { ApiError } from "@/services/api";
import "@/styles/index.css";

window.addEventListener("pointerdown", () => {
  document.documentElement.dataset.input = "pointer";
}, { capture: true, passive: true });
window.addEventListener("keydown", () => {
  document.documentElement.dataset.input = "keyboard";
}, { capture: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (count, err) =>
        count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
