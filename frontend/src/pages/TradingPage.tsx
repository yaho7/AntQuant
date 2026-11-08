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
import { useAccountSummary, useOrders, usePositions, useTradingTasks } from "@/hooks/queries";
import { between, dateTime, duration, money, signedMoney } from "@/lib/format";
import { api } from "@/services/api";

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
  const [confirmEmergency, setConfirmEmergency] = React.useState(false);
  const [confirmLiquidate, setConfirmLiquidate] = React.useState(false);

  const unrealized = (positions.data ?? []).reduce((s, p) => s + (p.unrealized_pl ?? 0), 0);
  const activeTasks = (tasks.data ?? []).filter((t) => ["pending", "starting", "running"].includes(t.status));

  const emergency = useMutation({
    mutationFn: () => api.post<{ stopped: string[] }>("/api/trading/emergency-stop"),
    onSuccess: (r) => {
      setConfirmEmergency(false);
      toast.success(`Stop sent to ${r.stopped.length} strategy process(es). Positions kept.`);
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
        title="Trading"
        description="Paper trading on your Alpaca account."
        actions={
          <>
            <Button variant="outline" disabled={activeTasks.length === 0} onClick={() => setConfirmEmergency(true)}>
              <OctagonX /> Emergency stop all
            </Button>
            <Button variant="destructive" disabled={!connected} onClick={() => setConfirmLiquidate(true)}>
              <Flame /> Liquidate account
            </Button>
          </>
        }
      />

      <Alert tone="info" className="mb-4">
        <Lock />
        <div>
          <b>Mode: Paper.</b> Live trading is not available in this release. The server refuses live
          orders regardless of what the browser sends.
        </div>
      </Alert>

      {summary.isLoading ? (
        <LoadingState rows={2} />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : !summary.data?.connected ? (
        <Card className="mb-4"><ConnectBrokerPrompt /></Card>
      ) : summary.data.error ? (
        <Alert tone="loss" className="mb-4">{summary.data.error}</Alert>
      ) : account ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Account" value={<span className="text-base">{account.account_id}</span>} sub={<ModeBadge mode={account.paper ? "paper" : "live"} />} />
          <StatCard label="Equity" value={money(account.equity)} />
          <StatCard label="Buying power" value={money(account.buying_power)} />
          <StatCard label="Unrealized P&L" loading={positions.isLoading}
            value={<Delta value={positions.data ? unrealized : null}>{signedMoney(positions.data ? unrealized : null)}</Delta>} />
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <div>
            <CardTitle>Strategy runs</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Pause blocks orders that open or grow a position; exits still go through. Stop ends the
              process and keeps positions. Liquidate closes every position in the account.
            </p>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <QueryBoundary query={tasks}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No paper runs yet" description="Start a strategy from the Strategies page."
                  action={<Button asChild variant="outline"><Link to="/strategies">Strategies</Link></Button>} />
              ) : (
                <Table>
                  <thead><tr><Th>Strategy</Th><Th>Status</Th><Th>Mode</Th><Th>Started</Th><Th>Running for</Th><Th>Last iteration</Th><Th className="text-right">Controls</Th></tr></thead>
                  <tbody>
                    {list.map((t) => {
                      const active = ["pending", "starting", "running"].includes(t.status);
                      return (
                        <tr key={t.id}>
                          <Td>
                            {t.strategy_id ? <Link className="font-medium hover:underline" to={`/strategies/${t.strategy_id}`}>{t.strategy_name}</Link> : t.strategy_name}
                            {t.error_message && !active && <p className="max-w-xs truncate text-xs text-muted-foreground" title={t.error_message}>{t.error_message}</p>}
                          </Td>
                          <Td><StatusBadge status={t.status} paused={t.paused} /></Td>
                          <Td><ModeBadge mode={t.mode} /></Td>
                          <Td className="num text-xs">{dateTime(t.started_at)}</Td>
                          <Td className="num text-xs">{t.started_at ? duration(between(t.started_at, t.ended_at)) : "—"}</Td>
                          <Td className="num text-xs">{t.heartbeat ? dateTime(t.heartbeat.time) : "—"}</Td>
                          <Td className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button asChild size="sm" variant="ghost"><Link to={`/logs?source=task:${t.id}`}>Log</Link></Button>
                              {active && t.strategy_id && <TradingControls strategyId={t.strategy_id} task={t} brokerConnected={connected} />}
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
              <TabsTrigger value="positions">Positions</TabsTrigger>
              <TabsTrigger value="open">Open orders</TabsTrigger>
              <TabsTrigger value="history">Order history</TabsTrigger>
            </TabsList>
            <TabsContent value="positions" className="-mx-4">
              <QueryBoundary query={positions}>{(p) => <PositionsTable positions={p} />}</QueryBoundary>
            </TabsContent>
            <TabsContent value="open" className="-mx-4">
              <QueryBoundary query={openOrders}>{(o) => <OrdersTable orders={o} empty="No open orders" />}</QueryBoundary>
            </TabsContent>
            <TabsContent value="history" className="-mx-4">
              <QueryBoundary query={closedOrders}>{(o) => <OrdersTable orders={o} empty="No closed orders" />}</QueryBoundary>
            </TabsContent>
          </Tabs>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Account-level data from Alpaca. When several strategies share this account, positions are not split per strategy.
          </p>
        </Card>
      )}

      <ConfirmDialog
        open={confirmEmergency}
        onOpenChange={setConfirmEmergency}
        title="Stop all strategies?"
        description={`Sends a stop signal to ${activeTasks.length} running strategy process(es). Positions and resting orders stay as they are.`}
        confirmLabel="Stop all"
        destructive
        loading={emergency.isPending}
        onConfirm={() => emergency.mutate()}
      />
      <ConfirmDialog
        open={confirmLiquidate}
        onOpenChange={setConfirmLiquidate}
        title="Liquidate the whole account?"
        description="Cancels all open orders and submits market orders to close EVERY position in this Alpaca account, including positions opened outside LumiBot UI. Running strategies are not stopped and may open new positions."
        confirmLabel="Liquidate"
        destructive
        phrase="LIQUIDATE"
        loading={liquidate.isPending}
        onConfirm={(typed) => liquidate.mutate(typed)}
      >
        <Alert tone="warning"><ShieldAlert /> Stop strategies first if you want the account to stay flat.</Alert>
      </ConfirmDialog>
    </>
  );
}
