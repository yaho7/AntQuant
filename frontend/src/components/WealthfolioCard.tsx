import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Link2, Unplug } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { WealthfolioStatus } from "@/types/api";
import { api, qs } from "@/services/api";

interface DestinationAccount {
  id: string;
  name: string;
  currency: string;
}

const queryKey = ["settings", "wealthfolio"] as const;

function ConnectionForm({ profileId, initialEndpoint, onSaved }: {
  profileId: string;
  initialEndpoint: string;
  onSaved: () => void;
}) {
  const id = useId();
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState("");
  const scope = qs({ profile_id: profileId });
  const credentials = { endpoint: endpoint.trim(), password };
  const discover = useMutation({
    mutationFn: () => api.post<{ accounts: DestinationAccount[] }>(`/api/settings/wealthfolio/accounts${scope}`, credentials),
    onSuccess: ({ accounts }) => setAccount(accounts[0]?.id ?? ""),
  });
  const save = useMutation({
    mutationFn: () => api.put(`/api/settings/wealthfolio/connection${scope}`, { ...credentials, account_id: account }),
    onSuccess: onSaved,
  });
  const error = save.error ?? discover.error;

  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (!discover.data) discover.mutate();
      else if (account) save.mutate();
    }}>
      <Field label={t("Endpoint")} htmlFor={`${id}-endpoint`} hint={t("Use the base URL of your Wealthfolio web server.")}>
        <Input id={`${id}-endpoint`} type="url" value={endpoint} autoComplete="url" spellCheck={false}
          placeholder="http://wealthfolio:8088" onChange={(e) => { setEndpoint(e.target.value); discover.reset(); }} required />
      </Field>
      <Field label={t("Wealthfolio password")} htmlFor={`${id}-password`}
        hint={t("Leave blank if your server does not require a password or to keep the saved password.")}>
        <Input id={`${id}-password`} type="password" value={password} autoComplete="off"
          onChange={(e) => { setPassword(e.target.value); discover.reset(); }} />
      </Field>
      {discover.data && (
        discover.data.accounts.length ? (
          <Field label={t("Destination account")} htmlFor={`${id}-account`}>
            <Select id={`${id}-account`} value={account} onChange={(e) => setAccount(e.target.value)}>
              {discover.data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
            </Select>
          </Field>
        ) : <Alert tone="info">{t("Create an account in Wealthfolio before connecting.")}</Alert>
      )}
      {error && <Alert tone="loss">{t(error.message)}</Alert>}
      <Button type="submit" className="justify-self-start" loading={discover.isPending || save.isPending}
        disabled={!!discover.data && !account}>
        <Link2 /> {t(discover.data ? "Enable fill sync" : "Load Wealthfolio accounts")}
      </Button>
    </form>
  );
}

export function WealthfolioCard({ profileId, connected }: { profileId: string; connected: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const connectionPath = `/api/settings/wealthfolio/connection${qs({ profile_id: profileId })}`;
  const query = useQuery({
    queryKey: [...queryKey, profileId],
    queryFn: () => api.get<WealthfolioStatus>(connectionPath),
    refetchInterval: (q) => q.state.data?.configured ? 10_000 : false,
  });
  const disconnect = useMutation({
    mutationFn: () => api.del(connectionPath),
    onSuccess: async () => {
      setRemove(false);
      await qc.invalidateQueries({ queryKey });
      toast.success("Wealthfolio sync paused");
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("Wealthfolio")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("Sync confirmed stock and ETF fills from this account to Wealthfolio.")}</p>
        </div>
        {query.data?.configured && <Badge className="shrink-0 self-start" tone="gain">{t("Sync enabled")}</Badge>}
      </CardHeader>
      <CardContent className="grid gap-3">
        <QueryBoundary query={query}>
          {(state) => state.configured && !edit ? (
            <>
              <p className="text-sm">{t("Destination account")} · <b>{state.account_name}</b></p>
              <p className="break-all font-mono text-xs text-muted-foreground">{state.endpoint}</p>
              <p className="text-xs text-muted-foreground">
                {t("{n} fills pending", { n: state.pending ?? 0 })}
                {state.last_synced_at && ` · ${t("Last synced {time}", { time: dateTime(state.last_synced_at) })}`}
              </p>
              {state.parked > 0 && <Alert tone="info">{t("{n} fills paused at their original destination.", { n: state.parked })}</Alert>}
              {state.last_error && <Alert tone="warning">{t(state.last_error)}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={!connected} onClick={() => setEdit(true)}><ArrowUpRight /> {t("Edit destination")}</Button>
                <Button variant="ghost" size="sm" onClick={() => setRemove(true)}><Unplug /> {t("Pause sync")}</Button>
              </div>
            </>
          ) : (
            <>
              {state.parked > 0 && <Alert tone="info">{t("{n} fills paused at their original destination.", { n: state.parked })}</Alert>}
              {connected ? <ConnectionForm profileId={profileId} initialEndpoint={state.endpoint ?? ""} onSaved={() => {
                void qc.invalidateQueries({ queryKey });
                setEdit(false);
                toast.success("Wealthfolio sync enabled");
              }} /> : <Alert tone="info">{t("Connect a broker before configuring Wealthfolio.")}</Alert>}
              {edit && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setEdit(false)}>{t("Cancel")}</Button>}
            </>
          )}
        </QueryBoundary>
        <ConfirmDialog open={remove} onOpenChange={setRemove}
          title={t("Pause Wealthfolio sync?")}
          description={t("New fills will stop syncing. Queued fills stay linked to their original destination.")}
          confirmLabel={t("Pause sync")} destructive loading={disconnect.isPending} onConfirm={() => disconnect.mutate()} />
      </CardContent>
    </Card>
  );
}
