import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Select } from "@/components/ui/primitives";
import { useProfiles } from "@/hooks/queries";
import { profileLabel, providerLabel } from "@/lib/profiles";
import { api } from "@/services/api";
import type { BrokerProfile, Task } from "@/types/api";
import { t } from "@/lib/i18n";

/**
 * Start / Pause / Resume / Stop for one strategy. Stop never liquidates;
 * liquidation is a separate account-level action on the Trading page.
 */
export function TradingControls({
  strategyId,
  task,
  runningProfiles = [],
  size = "sm",
}: {
  strategyId: number;
  task: Task | null | undefined;
  runningProfiles?: string[];
  size?: "sm" | "default";
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useProfiles();
  const [search] = useSearchParams();
  const profiles = (data?.profiles ?? []).filter((profile) => profile.connected);
  const [confirmStart, setConfirmStart] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const [confirmStop, setConfirmStop] = React.useState(false);
  const fieldId = React.useId();
  const profile = profiles.find((item) => item.id === selected);
  const live = profile?.mode === "live";
  const blocked = !profile ? "Select a broker account."
    : runningProfiles.includes(profile.id) ? "This strategy is already running on this account."
    : profile.authorization_expired ? "Schwab authorization expired. Reconnect in Settings."
    : live && !data?.live_available ? "Live trading is disabled on this server."
    : null;
  const active = !!task && ["pending", "starting", "running"].includes(task.status);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["strategies"] });
    void qc.invalidateQueries({ queryKey: ["trading"] });
    void qc.invalidateQueries({ queryKey: ["system"] });
  };
  const start = useMutation({
    mutationFn: (account: BrokerProfile) =>
      api.post<Task>("/api/trading/start", { strategy_id: strategyId, mode: account.mode, profile_id: account.id }),
    onSuccess: (_task, account) => {
      setConfirmStart(false);
      toast.success(t("Strategy started on {account}.", { account: profileLabel(account) }));
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
        <Button size={size} disabled={!profiles.length}
          title={!profiles.length ? t("Connect a broker in Settings first") : undefined}
          onClick={() => {
            const preferred = profiles.find((item) => item.id === search.get("profile"));
            setSelected(preferred?.id ?? (profiles.length === 1 ? profiles[0]!.id : ""));
            setConfirmStart(true);
          }}>
          <Play /> {t("Start strategy")}
        </Button>
        <Dialog open={confirmStart} onOpenChange={setConfirmStart}>
          <DialogContent title={t("Start strategy")} description={t("Choose which account this strategy will trade on.")}>
            <Field label={t("Broker account")} htmlFor={fieldId}>
              <Select id={fieldId} value={selected} disabled={start.isPending} onChange={(event) => setSelected(event.target.value)}>
                <option value="">{t("Choose…")}</option>
                {profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {profileLabel(item)} · {providerLabel(item.provider)}{item.account_hint ? ` · ${item.account_hint}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            {profile && blocked && <Alert tone="warning">{t(blocked)}</Alert>}
            {profile && !blocked && live && (
              <Alert tone="warning">{t("This strategy can place real orders on {account}.", { account: profileLabel(profile) })}</Alert>
            )}
            <DialogFooter>
              <Button variant="ghost" disabled={start.isPending} onClick={() => setConfirmStart(false)}>{t("Cancel")}</Button>
              <Button variant={live ? "destructive" : "default"} disabled={!!blocked} loading={start.isPending}
                onClick={() => { if (profile && !blocked) start.mutate(profile); }}>
                <Play /> {t(live ? "Start live trading" : "Start strategy")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
