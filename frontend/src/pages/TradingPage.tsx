import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, OctagonX, ShieldAlert, Flame } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { ConnectBrokerPrompt, OrdersTable, PositionsTable } from "@/components/AccountWidgets";
import {
  ConfirmDialog,
  Delta,
  EmptyState,
  ErrorState,
  LoadingState,
  ModeBadge,
  PageHeader,
  QueryBoundary,
  StatCard,
  StatusBadge,
} from "@/components/common";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccountSummary, useOrders, usePositions, useTradingMode, useTradingTasks } from "@/hooks/queries";
import { between, dateTime, duration, money, signedMoney } from "@/lib/format";
import { api } from "@/services/api";
import { t } from "@/lib/i18n";

export function TradingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const summary = useAccountSummary();
  const account = summary.data?.account;
  const connected = !!account;
  const positions = usePositions(connected);
  const openOrders = useOrders(connected, "open", 100);
  const closedOrders = useOrders(connected, "closed", 100);
  const tasks = useTradingTasks();
  const { data: tradingMode } = useTradingMode();
  const live = tradingMode?.mode === "live";
  const canLiquidate = connected && tradingMode?.can_liquidate && account.paper === !live &&
    (!live || tradingMode.live_available);
  const [confirmEmergency, setConfirmEmergency] = React.useState(false);
  const [confirmLiquidate, setConfirmLiquidate] = React.useState(false);

  const unrealized = (positions.data ?? []).reduce((s, p) => s + (p.unrealized_pl ?? 0), 0);
  const activeTasks = (tasks.data ?? []).filter((task) => ["pending", "starting", "running"].includes(task.status));

  const emergency = useMutation({
    mutationFn: () => api.post<{ stopped: string[] }>("/api/trading/emergency-stop"),
    onSuccess: (r) => {
      setConfirmEmergency(false);
      toast.success(t("Stop sent to {n} strategy process(es). Positions kept.", { n: r.stopped.length }));
      void qc.invalidateQueries({ queryKey: ["trading"] });
    },
    onError: toast.error,
  });
  const liquidate = useMutation({
    mutationFn: (phrase: string) => api.post("/api/trading/liquidate", { confirm: phrase, cancel_orders: true }),
    onSuccess: () => {
      setConfirmLiquidate(false);
      toast.success("Liquidation orders submitted to Alpaca");
      void qc.invalidateQueries({ queryKey: ["account"] });
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        title={t("Trading")}
        description={t("Strategy trading on your connected broker account.")}
        actions={
          <>
            <Button variant="outline" disabled={activeTasks.length === 0} onClick={() => setConfirmEmergency(true)}>
              <OctagonX /> {t("Emergency stop all")} </Button>
            {tradingMode?.can_liquidate && (
              <Button variant="destructive" disabled={!canLiquidate} onClick={() => setConfirmLiquidate(true)}>
                <Flame /> {t("Liquidate account")}
              </Button>
            )}
          </>
        }
      />

      {live && (
        <Alert tone={tradingMode.live_available ? "warning" : "info"} className="mb-4">
          <Lock />
          <div><b>{t("Live account")}</b> · {t(tradingMode.live_available
            ? "Orders affect real positions and funds."
            : "Live trading is disabled on this server.")}</div>
        </Alert>
      )}

      {summary.isLoading ? (
        <LoadingState rows={2} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !summary.data?.connected ? (
        <Card className="mb-4"><ConnectBrokerPrompt /></Card>
      ) : summary.data.error ? (
        <Alert tone="loss" className="mb-4">{t(summary.data.error)}</Alert>
      ) : account ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t("Account")} value={<span className="text-base">{account.account_id}</span>} sub={<ModeBadge mode={account.paper ? "paper" : "live"} />} />
          <StatCard label={t("Equity")} value={money(account.equity)} />
          <StatCard label={t("Buying power")} value={money(account.buying_power)} />
          <StatCard label={t("Unrealized P&L")} loading={positions.isLoading}
            value={<Delta value={positions.data ? unrealized : null}>{signedMoney(positions.data ? unrealized : null)}</Delta>} />
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div>
            <CardTitle>{t("Strategy runs")}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Pause blocks orders that open or grow a position; exits still go through. Stop ends the process and keeps positions. Liquidate closes every position in the account.")}
            </p>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <QueryBoundary query={tasks}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title={t("No trading runs yet")} description={t("Start a strategy from the Strategies page.")}
                  action={<Button asChild variant="outline"><Link to="/strategies">{t("Strategies")}</Link></Button>} />
              ) : (
                <Table>
                  <thead><tr><Th>{t("Strategy")}</Th><Th>{t("Status")}</Th><Th>{t("Mode")}</Th><Th>{t("Started")}</Th><Th>{t("Running for")}</Th><Th>{t("Last iteration")}</Th><Th className="text-right">{t("Controls")}</Th></tr></thead>
                  <tbody>
                    {list.map((task) => {
                      const active = ["pending", "starting", "running"].includes(task.status);
                      return (
                        <tr key={task.id}>
                          <Td>
                            {task.strategy_id ? <Link className="font-medium hover:underline" to={`/strategies/${task.strategy_id}`}>{task.strategy_name}</Link> : task.strategy_name}
                            {task.error_message && !active && <p className="max-w-xs truncate text-xs text-muted-foreground" title={task.error_message}>{task.error_message}</p>}
                          </Td>
                          <Td><StatusBadge status={task.status} paused={task.paused} /></Td>
                          <Td><ModeBadge mode={task.mode} /></Td>
                          <Td className="num text-xs">{dateTime(task.started_at)}</Td>
                          <Td className="num text-xs">{task.started_at ? duration(between(task.started_at, task.ended_at)) : "—"}</Td>
                          <Td className="num text-xs">{task.heartbeat ? dateTime(task.heartbeat.time) : "—"}</Td>
                          <Td className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button asChild size="sm" variant="ghost"><Link to={`/logs?source=task:${task.id}`}>{t("Log")}</Link></Button>
                              {active && task.strategy_id && <TradingControls strategyId={task.strategy_id} task={task} brokerConnected={connected} />}
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )
            }
          </QueryBoundary>
        </CardContent>
      </Card>

      {connected && (
        <Card>
          <Tabs defaultValue="positions" className="p-4">
            <TabsList>
              <TabsTrigger value="positions">{t("Positions")}</TabsTrigger>
              <TabsTrigger value="open">{t("Open orders")}</TabsTrigger>
              <TabsTrigger value="history">{t("Order history")}</TabsTrigger>
            </TabsList>
            <TabsContent value="positions" className="-mx-4">
              <QueryBoundary query={positions}>{(p) => <PositionsTable positions={p} />}</QueryBoundary>
            </TabsContent>
            <TabsContent value="open" className="-mx-4">
              <QueryBoundary query={openOrders}>{(o) => <OrdersTable orders={o} empty={t("No open orders")} />}</QueryBoundary>
            </TabsContent>
            <TabsContent value="history" className="-mx-4">
              <QueryBoundary query={closedOrders}>{(o) => <OrdersTable orders={o} empty={t("No closed orders")} />}</QueryBoundary>
            </TabsContent>
          </Tabs>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("Account data comes from your broker. Strategies using the same account share these positions.")} </p>
        </Card>
      )}

      <ConfirmDialog
        open={confirmEmergency}
        onOpenChange={setConfirmEmergency}
        title={t("Stop all strategies?")}
        description={t("Sends a stop signal to {n} running strategy process(es). Positions and resting orders stay as they are.", { n: activeTasks.length })}
        confirmLabel={t("Stop all")}
        destructive
        loading={emergency.isPending}
        onConfirm={() => emergency.mutate()}
      />
      <ConfirmDialog
        open={confirmLiquidate}
        onOpenChange={setConfirmLiquidate}
        title={t("Liquidate the whole account?")}
        description={t("Cancels all open orders and submits market orders to close EVERY position in this Alpaca account, including positions opened outside AntQuant. Running strategies are not stopped and may open new positions.")}
        confirmLabel={t("Liquidate")}
        destructive
        phrase={live ? "LIQUIDATE LIVE" : "LIQUIDATE"}
        loading={liquidate.isPending}
        onConfirm={(typed) => liquidate.mutate(typed)}
      >
        <Alert tone="warning"><ShieldAlert /> {t("Stop strategies first if you want the account to stay flat.")}</Alert>
      </ConfirmDialog>
    </>
  );
}
