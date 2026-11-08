import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square } from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { Task } from "@/types/api";

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
  const [confirmStop, setConfirmStop] = React.useState(false);
  const active = !!task && ["pending", "starting", "running"].includes(task.status);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["strategies"] });
    void qc.invalidateQueries({ queryKey: ["trading"] });
    void qc.invalidateQueries({ queryKey: ["system"] });
  };
  const start = useMutation({
    mutationFn: () => api.post<Task>("/api/trading/start", { strategy_id: strategyId, mode: "paper" }),
    onSuccess: () => {
      toast.success("Paper trading started");
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
      <Button
        size={size}
        onClick={() => start.mutate()}
        loading={start.isPending}
        disabled={!brokerConnected}
        title={brokerConnected ? "Start paper trading" : "Connect Alpaca in Settings first"}
      >
        <Play /> Start paper
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {task.paused ? (
        <Button size={size} variant="outline" loading={pause.isPending} onClick={() => pause.mutate(false)}>
          <Play /> Resume
        </Button>
      ) : (
        <Button
          size={size}
          variant="outline"
          loading={pause.isPending}
          disabled={task.status === "pending"}
          onClick={() => pause.mutate(true)}
          title="Block new or larger positions. Exits and broker-side stops keep working."
        >
          <Pause /> Pause
        </Button>
      )}
      <Button size={size} variant="outline" onClick={() => setConfirmStop(true)}>
        <Square /> Stop
      </Button>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop this strategy?"
        description="The strategy process stops. Open positions and resting broker orders are NOT closed. Use Liquidate on the Trading page to close positions."
        confirmLabel="Stop strategy"
        loading={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
    </div>
  );
}
