import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { api, setCsrfToken, setUnauthorizedHandler } from "@/services/api";

interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
}

interface Me {
  username: string;
  csrf_token: string;
}

interface AuthState {
  status: AuthStatus | undefined;
  me: Me | undefined;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["auth", "status"],
    queryFn: () => api.get<AuthStatus>("/api/auth/status"),
    staleTime: Infinity,
    retry: 1,
  });
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<Me>("/api/auth/me"),
    enabled: !!status.data?.authenticated,
    staleTime: Infinity,
  });

  React.useEffect(() => {
    setCsrfToken(me.data?.csrf_token ?? null);
  }, [me.data]);

  const refresh = React.useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["auth"] });
  }, [qc]);

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      qc.setQueryData(["auth", "status"], (s: AuthStatus | undefined) =>
        s ? { ...s, authenticated: false } : s,
      );
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const logout = React.useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      setCsrfToken(null);
      qc.clear();
      await qc.invalidateQueries({ queryKey: ["auth"] });
    }
  }, [qc]);

  const value: AuthState = {
    status: status.data,
    me: me.data,
    loading: status.isLoading || (!!status.data?.authenticated && me.isLoading),
    error: status.error,
    refresh,
    logout,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
