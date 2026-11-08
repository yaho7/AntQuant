import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import {
  AllocationBar,
  ConnectBrokerPrompt,
  OrdersTable,
  PositionsTable,
} from "@/components/AccountWidgets";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import {
  Delta,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
} from "@/components/common";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Select } from "@/components/ui/primitives";
import {
  useAccountSummary,
  useHistory,
  useOrders,
  usePositions,
  useStrategies,
  useSystemStatus,
} from "@/hooks/queries";
import { between, duration, money, pct, signedMoney } from "@/lib/format";

const PERIODS = [
  { v: "1W", label: "1 week" },
  { v: "1M", label: "1 month" },
  { v: "3M", label: "3 months" },
  { v: "1A", label: "1 year" },
  { v: "all", label: "All" },
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
        name: "Equity",
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
      <PageHeader
        title="Dashboard"
        description="Broker account overview. Values are account-wide, not per strategy."
        actions={
          account && (
            <Badge tone="info">
              Alpaca {account.paper ? "Paper" : "LIVE"} · {account.account_id}
            </Badge>
          )
        }
      />

      {summary.isLoading ? (
        <LoadingState rows={2} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !summary.data?.connected ? (
        <Card className="mb-6">
          <ConnectBrokerPrompt />
        </Card>
      ) : summary.data.error ? (
        <Alert tone="loss" className="mb-6">
          <AlertTriangle />
          <div>
            <p className="font-medium">Could not load the Alpaca account</p>
            <p className="text-muted-foreground">{summary.data.error}</p>
          </div>
        </Alert>
      ) : null}

      {account && (
        <>
          {account.trading_blocked && (
            <Alert tone="warning" className="mb-4">
              <AlertTriangle /> Alpaca reports trading is blocked on this account.
            </Alert>
          )}
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Account equity" value={money(account.equity, account.currency)} />
            <StatCard label="Cash balance" value={money(account.cash, account.currency)} />
            <StatCard label="Buying power" value={money(account.buying_power, account.currency)} />
            <StatCard
              label="Daily P&L"
              value={<Delta value={account.daily_pnl}>{signedMoney(account.daily_pnl)}</Delta>}
              sub={<Delta value={account.daily_pnl_pct}>{pct(account.daily_pnl_pct, 2, true)}</Delta>}
            />
            <StatCard
              label={`Total P&L · ${PERIODS.find((p) => p.v === period)?.label}`}
              loading={history.isLoading}
              value={<Delta value={periodPnl}>{signedMoney(periodPnl)}</Delta>}
              sub={<span className="text-muted-foreground">From Alpaca portfolio history</span>}
            />
          </div>

          <div className="mb-6 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Equity curve</CardTitle>
                <Select
                  className="h-8 w-32"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  aria-label="History period"
                >
                  {PERIODS.map((p) => (
                    <option key={p.v} value={p.v}>{p.label}</option>
                  ))}
                </Select>
              </CardHeader>
              <CardContent>
                {history.isLoading ? (
                  <LoadingState rows={6} />
                ) : history.error ? (
                  <ErrorState error={history.error} onRetry={() => history.refetch()} />
                ) : equitySeries[0]!.data.length < 2 ? (
                  <EmptyState title="Not enough history yet" description="Alpaca has no portfolio history for this period." />
                ) : (
                  <TimeSeriesChart series={equitySeries} showRanges={false} />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Asset allocation</CardTitle>
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
          </div>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent trades</CardTitle>
            {connected && <Link className="text-xs text-primary" to="/trading">View all</Link>}
          </CardHeader>
          <CardContent className="px-0">
            {!connected ? (
              <EmptyState title="Connect a broker to see trades" />
            ) : orders.isLoading ? (
              <LoadingState />
            ) : orders.error ? (
              <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
            ) : (
              <OrdersTable orders={(orders.data ?? []).filter((o) => o.filled_quantity)} empty="No filled orders yet" />
            )}
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Active strategies</CardTitle>
              <Link className="text-xs text-primary" to="/strategies">Manage</Link>
            </CardHeader>
            <CardContent>
              {strategies.isLoading ? (
                <LoadingState rows={2} />
              ) : activeStrategies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No strategy is trading.</p>
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
              <CardTitle>Running tasks</CardTitle>
            </CardHeader>
            <CardContent>
              {status.isLoading ? (
                <LoadingState rows={2} />
              ) : !status.data?.active_tasks.length ? (
                <p className="text-sm text-muted-foreground">Nothing running.</p>
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
                        {task.kind === "backtest" ? "Backtest" : "Paper trading"} ·{" "}
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
              <CardTitle>System status</CardTitle>
            </CardHeader>
            <CardContent>
              {status.data ? (
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Broker</dt>
                  <dd className="flex items-center gap-1">
                    {status.data.broker.configured ? (
                      <><CheckCircle2 className="size-3.5 text-gain" /> Alpaca paper</>
                    ) : (
                      <><CircleSlash className="size-3.5 text-muted-foreground" /> Not connected</>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">LumiBot</dt>
                  <dd className="num flex items-center gap-1">
                    {status.data.lumibot_version ?? "missing"}
                    {!status.data.lumibot_verified && <Badge tone="warning">unverified</Badge>}
                  </dd>
                  <dt className="text-muted-foreground">UI version</dt>
                  <dd className="num">{status.data.ui_version}</dd>
                  <dt className="text-muted-foreground">Uptime</dt>
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

      {connected && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Positions</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {positions.data ? <PositionsTable positions={positions.data} /> : <LoadingState />}
          </CardContent>
        </Card>
      )}
    </>
  );
}
