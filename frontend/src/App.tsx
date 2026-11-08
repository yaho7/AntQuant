import { Navigate, Route, Routes } from "react-router-dom";
import { ErrorState, LoadingState } from "@/components/common";
import { useAuth } from "@/hooks/useAuth";
import { AppLayout } from "@/layouts/AppLayout";
import { ConnectBrokerPage, LoginPage, SetupPage } from "@/pages/AuthPages";
import { BacktestingPage } from "@/pages/BacktestingPage";
import { BacktestReportPage } from "@/pages/BacktestReportPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { LogsPage } from "@/pages/LogsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StrategiesPage } from "@/pages/StrategiesPage";
import { StrategyDetailPage } from "@/pages/StrategyDetailPage";
import { TradingPage } from "@/pages/TradingPage";
import { t } from "@/lib/i18n";

export function App() {
  const { status, loading, error } = useAuth();
  if (loading) {
    return (
      <div className="mx-auto max-w-md p-10">
        <LoadingState rows={3} />
      </div>
    );
  }
  if (error || !status) return <ErrorState error={error ?? t("Server not reachable")} onRetry={() => location.reload()} />;
  if (status.setup_required) return <SetupPage />;
  if (!status.authenticated) return <LoginPage />;
  return (
    <Routes>
      <Route path="/setup/connect" element={<ConnectBrokerPage />} />
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="strategies" element={<StrategiesPage />} />
        <Route path="strategies/:id" element={<StrategyDetailPage />} />
        <Route path="backtesting" element={<BacktestingPage />} />
        <Route path="backtesting/:id" element={<BacktestReportPage />} />
        <Route path="trading" element={<TradingPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
