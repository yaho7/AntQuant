import { useQuery } from "@tanstack/react-query";
import { api, qs } from "@/services/api";
import type {
  AccountSummary,
  Backtest,
  EquityPoint,
  Order,
  Position,
  SettingsView,
  Strategy,
  SystemStatus,
  TradingTask,
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

export const useAccountSummary = () =>
  useQuery({
    queryKey: keys.summary,
    queryFn: () => api.get<AccountSummary>("/api/account/summary"),
    refetchInterval: 15_000,
  });

export const usePositions = (enabled: boolean) =>
  useQuery({
    queryKey: keys.positions,
    queryFn: () => api.get<Position[]>("/api/account/positions"),
    enabled,
    refetchInterval: 15_000,
  });

export const useOrders = (enabled: boolean, status: "open" | "closed" | "all", limit = 50) =>
  useQuery({
    queryKey: keys.orders(status, limit),
    queryFn: () => api.get<Order[]>(`/api/account/orders${qs({ status, limit })}`),
    enabled,
    refetchInterval: 20_000,
  });

export const useHistory = (enabled: boolean, period: string) =>
  useQuery({
    queryKey: keys.history(period),
    queryFn: () => api.get<EquityPoint[]>(`/api/account/history${qs({ period })}`),
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

export const useTradingTasks = () =>
  useQuery({
    queryKey: keys.trading,
    queryFn: () => api.get<TradingTask[]>("/api/trading/tasks"),
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
