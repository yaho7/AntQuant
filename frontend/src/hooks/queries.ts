import { useQuery } from "@tanstack/react-query";
import { api, qs } from "@/services/api";
import type {
  AccountSummary,
  BrokerProfile,
  Backtest,
  EquityPoint,
  Order,
  Position,
  SettingsView,
  Strategy,
  SystemStatus,
  TradingTask,
  WealthfolioStatus,
} from "@/types/api";

export const keys = {
  summary: ["account", "summary"] as const,
  positions: ["account", "positions"] as const,
  orders: (status: string, limit: number) => ["account", "orders", status, limit] as const,
  history: (period: string) => ["account", "history", period] as const,
  strategies: ["strategies"] as const,
  status: ["system", "status"] as const,
  settings: ["settings"] as const,
  trading: ["trading", "tasks"] as const,
  backtests: (sid?: number) => ["backtests", sid ?? "all"] as const,
};

export const accountSummaryQuery = (profileId: string | undefined) => ({
    queryKey: [...keys.summary, profileId],
    queryFn: () => api.get<AccountSummary>(`/api/account/summary${qs({ profile_id: profileId })}`),
    refetchInterval: 15_000,
  });

export const useAccountSummary = (profileId: string | undefined) =>
  useQuery({ ...accountSummaryQuery(profileId), enabled: !!profileId });

export const usePositions = (enabled: boolean, profileId: string | undefined) =>
  useQuery({
    queryKey: [...keys.positions, profileId],
    queryFn: () => api.get<Position[]>(`/api/account/positions${qs({ profile_id: profileId })}`),
    enabled,
    refetchInterval: 15_000,
  });

export const useOrders = (enabled: boolean, profileId: string | undefined, status: "open" | "closed" | "all", limit = 50) =>
  useQuery({
    queryKey: [...keys.orders(status, limit), profileId],
    queryFn: () => api.get<Order[]>(`/api/account/orders${qs({ status, limit, profile_id: profileId })}`),
    enabled,
    refetchInterval: 20_000,
  });

export const useHistory = (enabled: boolean, period: string, profileId: string) =>
  useQuery({
    queryKey: [...keys.history(period), profileId],
    queryFn: () => api.get<EquityPoint[]>(`/api/account/history${qs({ period, profile_id: profileId })}`),
    enabled,
    refetchInterval: 60_000,
  });

export const useStrategies = () =>
  useQuery({
    queryKey: keys.strategies,
    queryFn: () => api.get<Strategy[]>("/api/strategies"),
    refetchInterval: 10_000,
  });

export const useSystemStatus = () =>
  useQuery({
    queryKey: keys.status,
    queryFn: () => api.get<SystemStatus>("/api/system/status"),
    refetchInterval: 5_000,
  });

export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api.get<SettingsView>("/api/settings") });

export const useProfiles = () =>
  useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.get<{ profiles: BrokerProfile[]; live_available: boolean }>("/api/profiles"),
    refetchInterval: 60_000,
  });

export const useWealthfolioStatuses = () =>
  useQuery({
    queryKey: ["settings", "wealthfolio"],
    queryFn: () => api.get<{ profiles: Record<string, WealthfolioStatus>; unassigned: number }>("/api/settings/wealthfolio/statuses"),
    refetchInterval: 15_000,
  });

export const useTradingTasks = (profileId?: string, activeOnly = false) =>
  useQuery({
    queryKey: [...keys.trading, profileId, activeOnly],
    queryFn: () => api.get<TradingTask[]>(`/api/trading/tasks${qs({ profile_id: profileId, active_only: activeOnly, limit: activeOnly ? 500 : 100 })}`),
    refetchInterval: 5_000,
  });

export const useBacktests = (strategyId?: number) =>
  useQuery({
    queryKey: keys.backtests(strategyId),
    queryFn: () => api.get<Backtest[]>(`/api/backtests${qs({ strategy_id: strategyId })}`),
    refetchInterval: (q) =>
      q.state.data?.some((b) => ["pending", "starting", "running"].includes(b.status))
        ? 2_000
        : 15_000,
  });
