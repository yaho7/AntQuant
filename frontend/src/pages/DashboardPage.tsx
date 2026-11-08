import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";
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
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import {
  useAccountSummary,
  useHistory,
  useOrders,
  usePositions,
  useStrategies,
  useSystemStatus,
} from "@/hooks/queries";
import { between, duration, money, pct, signedMoney } from "@/lib/format";
import { t } from "@/lib/i18n";

const PERIODS = [
  { v: "1W", label: t("past week"), short: "1W" },
  { v: "1M", label: t("past month"), short: "1M" },
  { v: "3M", label: t("past 3 months"), short: "3M" },
  { v: "1A", label: t("past year"), short: "1Y" },
  { v: "all", label: "all time", short: t("All") },
];

export function DashboardPage() {
  const summary = useAccountSummary();
  const connected = !!summary.data?.account;
  const [period, setPeriod] = React.useState("1M");
  const history = useHistory(connected, period);
  const positions = usePositions(connected);
  const orders = useOrders(connected, "closed", 10);
  const status = useSystemStatus();
  const strategies = useStrategies();

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
  const activeStrategies = (strategies.data ?? []).filter(
    (s) => s.trading_task && ["starting", "running"].includes(s.trading_task.status),
  );

  return (
    <>
      {summary.isLoading ? (
        <LoadingState rows={2} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !summary.data?.connected ? (
        <>
          <PageHeader title={t("Dashboard")} description={t("Your broker account at a glance.")} />
          <Card className="mb-8">
            <ConnectBrokerPrompt />
          </Card>
        </>
      ) : summary.data.error ? (
        <>
          <PageHeader title={t("Dashboard")} />
          <Alert tone="loss" className="mb-8">
            <AlertTriangle />
            <div>
              <p className="font-medium">{t("Could not load the Alpaca account")}</p>
              <p className="text-muted-foreground">{summary.data.error}</p>
            </div>
          </Alert>
        </>
      ) : null}

      {account && (
        <section className="mb-10" aria-label={t("Account overview")}>
          <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            Alpaca {account.paper ? "paper" : "LIVE"} account · {account.account_id}
            <Badge tone="info">{account.paper ? "Paper" : "LIVE"}</Badge>
          </p>
          <h1 className="font-display sensitive text-5xl font-normal tracking-tight sm:text-6xl">
            {money(account.equity, account.currency)}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5">
              <Delta value={account.daily_pnl}><span className="sensitive">{signedMoney(account.daily_pnl)}</span></Delta>
              <Delta value={account.daily_pnl_pct}>{pct(account.daily_pnl_pct, 2, true)}</Delta>
              <span className="text-muted-foreground">{t("today")}</span>
            </span>
            <span className="h-4 border-e" aria-hidden />
            <span className="flex items-center gap-1.5">
              <Delta value={periodPnl}><span className="sensitive">{signedMoney(periodPnl)}</span></Delta>
              <span className="text-muted-foreground">{PERIODS.find((p) => p.v === period)?.label}</span>
            </span>
          </div>
          {account.trading_blocked && (
            <Alert tone="warning" className="mt-4">
              <AlertTriangle /> {t("Alpaca reports trading is blocked on this account.")} </Alert>
          )}

          <div className="-mx-4 mt-6 sm:-mx-8">
            {history.isLoading ? (
              <LoadingState rows={6} className="px-8" />
            ) : history.error ? (
              <ErrorState error={history.error} onRetry={() => history.refetch()} />
            ) : equitySeries[0]!.data.length < 2 ? (
              <EmptyState title={t("Not enough history yet")} description={t("Alpaca has no portfolio history for this period.")} />
            ) : (
              <TimeSeriesChart series={equitySeries} showRanges={false} minimal height={240} />
            )}
          </div>
          <div className="mt-3 flex justify-center">
            <Segmented
              options={PERIODS.map((p) => p.v)}
              labels={Object.fromEntries(PERIODS.map((p) => [p.v, p.short]))}
              value={period}
              onChange={setPeriod}
              ariaLabel={t("History period")}
            />
          </div>

          <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("Cash balance")} value={money(account.cash, account.currency)} />
            <StatCard label={t("Buying power")} value={money(account.buying_power, account.currency)} />
            <StatCard label={t("Long market value")} value={money(account.long_market_value, account.currency)} />
            <StatCard
              label={t("Daily P&L")}
              value={<Delta value={account.daily_pnl}>{signedMoney(account.daily_pnl)}</Delta>}
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
            {connected && <Link className="text-xs text-primary" to="/trading">{t("View all")}</Link>}
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
                  <AllocationBar positions={positions.data ?? []} cash={account.cash} />
                )}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{t("Active strategies")}</CardTitle>
              <Link className="text-xs text-primary" to="/strategies">{t("Manage")}</Link>
            </CardHeader>
            <CardContent>
              {strategies.isLoading ? (
                <LoadingState rows={2} />
              ) : activeStrategies.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("No strategy is trading.")}</p>
              ) : (
                <ul className="grid gap-2">
                  {activeStrategies.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link to={`/strategies/${s.id}`} className="truncate font-medium hover:underline">
                        {s.name}
                      </Link>
                      <StatusBadge status={s.trading_task!.status} paused={s.trading_task!.paused} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("Running tasks")}</CardTitle>
            </CardHeader>
            <CardContent>
              {status.isLoading ? (
                <LoadingState rows={2} />
              ) : !status.data?.active_tasks.length ? (
                <p className="text-sm text-muted-foreground">{t("Nothing running.")}</p>
              ) : (
                <ul className="grid gap-2">
                  {status.data.active_tasks.map((task) => (
                    <li key={task.id} className="grid gap-0.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          className="truncate font-medium hover:underline"
                          to={task.kind === "backtest" ? `/backtesting/${task.id}` : "/trading"}
                        >
                          {task.strategy_name}
                        </Link>
                        <StatusBadge status={task.status} paused={task.paused} />
                      </div>
                      <span className="num text-xs text-muted-foreground">
                        {task.kind === "backtest" ? t("Backtest") : t("Paper trading")} ·{" "}
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
                    {status.data.broker.configured ? (
                      <><CheckCircle2 className="size-3.5 text-gain" /> {t("Alpaca paper")}</>
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
