import { AlertTriangle, CheckCircle2, CircleSlash, KeyRound } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import {
  AllocationBar,
  ConnectBrokerPrompt,
  OrdersTable,
  PositionsTable,
} from "@/components/AccountWidgets";
import { Segmented, TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import {
  Delta,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
} from "@/components/common";
import { WealthfolioCard } from "@/components/WealthfolioCard";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import {
  useAccountSummary,
  useHistory,
  useOrders,
  usePositions,
  useTradingTasks,
  useSystemStatus,
} from "@/hooks/queries";
import { between, duration, money, pct, signedMoney } from "@/lib/format";
import { t } from "@/lib/i18n";
import { authorizationWarning, profileLabel, profilePath, providerLabel } from "@/lib/profiles";
import type { BrokerProfile } from "@/types/api";

const PERIODS = [
  { v: "1W", label: "past week", short: "1W" },
  { v: "1M", label: "past month", short: "1M" },
  { v: "3M", label: "past 3 months", short: "3M" },
  { v: "1A", label: "past year", short: "1Y" },
  { v: "all", label: "all time", short: "All" },
];

export function DashboardPage({ profile }: { profile: BrokerProfile }) {
  const summary = useAccountSummary(profile.id);
  const connected = !!summary.data?.account;
  const [period, setPeriod] = React.useState("1M");
  const history = useHistory(connected && profile.provider === "alpaca", period, profile.id);
  const positions = usePositions(connected, profile.id);
  const orders = useOrders(connected, profile.id, "closed", 10);
  const status = useSystemStatus();
  const tasks = useTradingTasks(profile.id, true);

  const account = summary.data?.account;
  const periodPnl = history.data?.length ? history.data[history.data.length - 1]!.profit_loss : null;
  const equitySeries = React.useMemo(
    () => [
      {
        name: t("Equity"),
        color: "--chart-1",
        data: (history.data ?? []).map((p) => ({ time: p.time, value: p.equity })),
      },
    ],
    [history.data],
  );
  const warning = authorizationWarning(profile);
  const tradingPath = `${profilePath(profile.id)}/trading`;

  return (
    <>
      <PageHeader title={profileLabel(profile)}
        description={[providerLabel(profile.provider), profile.account_hint].filter(Boolean).join(" · ")}
        actions={<Button asChild variant="outline"><Link to={tradingPath}>{t("Trading")}</Link></Button>} />
      {warning && (
        <Alert tone={profile.authorization_expired ? "loss" : "warning"} className="mb-4">
          <KeyRound />
          <div className="grid gap-2">
            <p>{t(warning)}</p>
            <Button asChild variant="outline" size="sm" className="justify-self-start">
              <Link to="/settings">{t("Renew authorization")}</Link>
            </Button>
          </div>
        </Alert>
      )}
      {summary.isLoading ? (
        <LoadingState rows={2} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !summary.data?.connected ? (
        <>
          <Card className="mb-8">
            <ConnectBrokerPrompt />
          </Card>
        </>
      ) : summary.data.error ? (
        <>
          <Alert tone="loss" className="mb-8">
            <AlertTriangle />
            <div>
              <p className="font-medium">{t("Could not load the broker account")}</p>
              <p className="text-muted-foreground">{t(summary.data.error)}</p>
            </div>
          </Alert>
        </>
      ) : null}

      {account && (
        <section className="mb-10" aria-label={t("Account overview")}>
          <p className="mb-1 text-xs text-muted-foreground">{t("Equity")}</p>
          <h2 className="font-display sensitive text-5xl font-normal tracking-tight sm:text-6xl">
            {money(account.equity, account.currency)}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5">
              <Delta value={account.daily_pnl}><span className="sensitive">{signedMoney(account.daily_pnl, account.currency)}</span></Delta>
              <Delta value={account.daily_pnl_pct}>{pct(account.daily_pnl_pct, 2, true)}</Delta>
              <span className="text-muted-foreground">{t("today")}</span>
            </span>
            <span className="h-4 border-e" aria-hidden />
            <span className="flex items-center gap-1.5">
              <Delta value={periodPnl}><span className="sensitive">{signedMoney(periodPnl, account.currency)}</span></Delta>
              <span className="text-muted-foreground">{t(PERIODS.find((p) => p.v === period)?.label ?? "")}</span>
            </span>
          </div>
          {account.trading_blocked && (
            <Alert tone="warning" className="mt-4">
              <AlertTriangle /> {t("The broker reports trading is blocked on this account.")} </Alert>
          )}

          {profile.provider === "alpaca" && (
            <Card className="mt-6">
              <CardHeader className="flex-wrap gap-y-2">
                <CardTitle>{t("Equity history")}</CardTitle>
                <Segmented
                  options={PERIODS.map((item) => item.v)}
                  labels={Object.fromEntries(PERIODS.map((item) => [item.v, t(item.short)]))}
                  value={period}
                  onChange={setPeriod}
                  ariaLabel={t("History period")}
                />
              </CardHeader>
              <CardContent>
                {history.isLoading ? (
                  <LoadingState rows={6} />
                ) : history.error ? (
                  <ErrorState error={history.error} onRetry={() => history.refetch()} />
                ) : equitySeries[0]!.data.length < 2 ? (
                  <EmptyState title={t("Not enough history yet")} description={t("The broker has no portfolio history for this period.")} />
                ) : (
                  <TimeSeriesChart key={period} series={equitySeries} currency={account.currency} showRanges={false} height={265} />
                )}
              </CardContent>
            </Card>
          )}

          <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("Cash balance")} value={money(account.cash, account.currency)} />
            <StatCard label={t("Buying power")} value={money(account.buying_power, account.currency)} />
            <StatCard label={t("Long market value")} value={money(account.long_market_value, account.currency)} />
            <StatCard
              label={t("Daily P&L")}
              value={<Delta value={account.daily_pnl}>{signedMoney(account.daily_pnl, account.currency)}</Delta>}
            />
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <div className="grid content-start gap-6">
        {connected && (
          <Card>
            <CardHeader><CardTitle>{t("Holdings")}</CardTitle></CardHeader>
            <CardContent className="px-0">
              {positions.data ? <PositionsTable positions={positions.data} /> : <LoadingState />}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>{t("Recent trades")}</CardTitle>
            {connected && <Link className="text-xs text-primary" to={tradingPath}>{t("View all")}</Link>}
          </CardHeader>
          <CardContent className="px-0">
            {!connected ? (
              <EmptyState title={t("Connect a broker to see trades")} />
            ) : orders.isLoading ? (
              <LoadingState />
            ) : orders.error ? (
              <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
            ) : (
              <OrdersTable orders={(orders.data ?? []).filter((o) => o.filled_quantity)} empty={t("No filled orders yet")} />
            )}
          </CardContent>
        </Card>
        </div>

        <div className="grid content-start gap-4">
          {account && (
            <Card>
              <CardHeader>
                <CardTitle>{t("Allocation")}</CardTitle>
              </CardHeader>
              <CardContent>
                {positions.isLoading ? (
                  <LoadingState />
                ) : positions.error ? (
                  <ErrorState error={positions.error} onRetry={() => positions.refetch()} />
                ) : (
                  <AllocationBar positions={positions.data ?? []} cash={account.cash} currency={account.currency} />
                )}
              </CardContent>
            </Card>
          )}
          <WealthfolioCard profileId={profile.id} connected={profile.connected} />

          <Card>
            <CardHeader>
              <CardTitle>{t("Running tasks")}</CardTitle>
            </CardHeader>
            <CardContent>
              {tasks.isLoading ? (
                <LoadingState rows={2} />
              ) : !tasks.data?.length ? (
                <p className="text-sm text-muted-foreground">{t("Nothing running.")}</p>
              ) : (
                <ul className="grid gap-2">
                  {tasks.data.map((task) => (
                    <li key={task.id} className="grid gap-0.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          className="truncate font-medium hover:underline"
                          to={tradingPath}
                        >
                          {task.strategy_name}
                        </Link>
                        <StatusBadge status={task.status} paused={task.paused} />
                      </div>
                      <span className="num text-xs text-muted-foreground">
                        {t(task.kind === "backtest" ? "Backtest" : task.mode === "live" ? "Live trading" : "Paper trading")} ·{" "}
                        {duration(between(task.started_at, null))}
                        {task.progress != null && ` · ${task.progress.toFixed(0)}%`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("System status")}</CardTitle>
            </CardHeader>
            <CardContent>
              {status.data ? (
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">{t("Broker")}</dt>
                  <dd className="flex items-center gap-1">
                    {profile.connected ? (
                      <><CheckCircle2 className="size-3.5 text-gain" /> {providerLabel(profile.provider)}</>
                    ) : (
                      <><CircleSlash className="size-3.5 text-muted-foreground" /> {t("Not connected")}</>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">{t("LumiBot")}</dt>
                  <dd className="num flex items-center gap-1">
                    {status.data.lumibot_version ?? "missing"}
                    {!status.data.lumibot_verified && <Badge tone="warning">{t("unverified")}</Badge>}
                  </dd>
                  <dt className="text-muted-foreground">{t("UI version")}</dt>
                  <dd className="num">{status.data.ui_version}</dd>
                  <dt className="text-muted-foreground">{t("Uptime")}</dt>
                  <dd className="num">{duration(status.data.uptime_seconds)}</dd>
                </dl>
              ) : status.error ? (
                <ErrorState error={status.error} />
              ) : (
                <LoadingState rows={3} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

    </>
  );
}
