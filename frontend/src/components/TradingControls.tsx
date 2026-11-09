import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square } from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useTradingMode } from "@/hooks/queries";
import { api } from "@/services/api";
import type { Task } from "@/types/api";
import { t } from "@/lib/i18n";

/**
 * Start / Pause / Resume / Stop for one strategy. Stop never liquidates;
 * liquidation is a separate account-level action on the Trading page.
 */
export function TradingControls({
  strategyId,
  task,
  brokerConnected,
  size = "sm",
}: {
  strategyId: number;
  task: Task | null | undefined;
  brokerConnected: boolean;
  size?: "sm" | "default";
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: tradingMode } = useTradingMode();
  const [confirmLive, setConfirmLive] = React.useState(false);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const live = tradingMode?.mode === "live";
  const canStart = brokerConnected && !!tradingMode && !tradingMode.authorization_expired && (!live || tradingMode.live_available);
  const active = !!task && ["pending", "starting", "running"].includes(task.status);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["strategies"] });
    void qc.invalidateQueries({ queryKey: ["trading"] });
    void qc.invalidateQueries({ queryKey: ["system"] });
  };
  const startHint = !brokerConnected ? "Connect a broker in Settings first"
    : tradingMode?.authorization_expired ? "Schwab authorization expired. Reconnect in Settings."
    : live && !canStart ? "Live trading is disabled on this server."
    : "Start strategy";
  const start = useMutation({
    mutationFn: (mode: "paper" | "live") =>
      api.post<Task>("/api/trading/start", { strategy_id: strategyId, mode, broker: tradingMode?.broker }),
    onSuccess: (_task, mode) => {
      setConfirmLive(false);
      toast.success(mode === "live" ? "Live trading started" : "Paper trading started");
      done();
    },
    onError: toast.error,
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      api.post<Task>(`/api/trading/${task!.id}/${paused ? "pause" : "resume"}`),
    onSuccess: (_d, paused) => {
      toast.success(paused ? "Paused: no new positions will be opened" : "Resumed");
      done();
    },
    onError: toast.error,
  });
  const stop = useMutation({
    mutationFn: () => api.post<Task>(`/api/trading/${task!.id}/stop`),
    onSuccess: () => {
      setConfirmStop(false);
      toast.success("Stop requested. Positions were left open.");
      done();
    },
    onError: toast.error,
  });

  if (!active) {
    return (
      <>
        <Button
          size={size}
          onClick={() => live ? setConfirmLive(true) : start.mutate("paper")}
          loading={start.isPending}
          disabled={!canStart}
          title={t(startHint)}
        >
          <Play /> {t("Start strategy")}
        </Button>
        <ConfirmDialog
          open={confirmLive}
          onOpenChange={setConfirmLive}
          title={t("Start live trading?")}
          description={t("This strategy can place real orders using the connected broker account.")}
          confirmLabel={t("Start live trading")}
          destructive
          loading={start.isPending}
          onConfirm={() => { if (canStart && live) start.mutate("live"); }}
        />
      </>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {task.paused ? (
        <Button size={size} variant="outline" loading={pause.isPending} onClick={() => pause.mutate(false)}>
          <Play /> {t("Resume")} </Button>
      ) : (
        <Button
          size={size}
          variant="outline"
          loading={pause.isPending}
          disabled={task.status === "pending"}
          onClick={() => pause.mutate(true)}
          title={t("Block new or larger positions. Exits and broker-side stops keep working.")}
        >
          <Pause /> {t("Pause")} </Button>
      )}
      <Button size={size} variant="outline" onClick={() => setConfirmStop(true)}>
        <Square /> {t("Stop")} </Button>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t("Stop this strategy?")}
        description={t("The strategy process stops. Open positions and resting broker orders are NOT closed. Use Liquidate on the Trading page to close positions.")}
        confirmLabel={t("Stop strategy")}
        loading={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
    </div>
  );
}
