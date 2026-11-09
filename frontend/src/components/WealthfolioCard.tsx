import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Link2, Unplug } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui/primitives";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { api } from "@/services/api";

interface ConnectionStatus {
  configured: boolean;
  active?: boolean;
  endpoint?: string;
  account_name?: string;
  pending?: number;
  last_error?: string | null;
  last_synced_at?: string | null;
}

interface DestinationAccount {
  id: string;
  name: string;
  currency: string;
}

const connectionPath = "/api/settings/wealthfolio/connection";
const queryKey = ["settings", "wealthfolio"] as const;

function ConnectionForm({ initialEndpoint, onSaved }: { initialEndpoint: string; onSaved: () => void }) {
  const id = useId();
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState("");
  const credentials = { endpoint: endpoint.trim(), password };
  const discover = useMutation({
    mutationFn: () => api.post<{ accounts: DestinationAccount[] }>("/api/settings/wealthfolio/accounts", credentials),
    onSuccess: ({ accounts }) => setAccount(accounts[0]?.id ?? ""),
  });
  const save = useMutation({
    mutationFn: () => api.put(connectionPath, { ...credentials, account_id: account }),
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

export function WealthfolioCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: () => api.get<ConnectionStatus>(connectionPath),
    refetchInterval: (q) => q.state.data?.configured ? 10_000 : false,
  });
  const disconnect = useMutation({
    mutationFn: () => api.del(connectionPath),
    onSuccess: async () => {
      setRemove(false);
      await qc.invalidateQueries({ queryKey });
      toast.success("Wealthfolio disconnected");
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("Wealthfolio")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("Sync confirmed stock and ETF fills from the selected broker to Wealthfolio.")}</p>
        </div>
        {query.data?.configured && <Badge className="shrink-0 self-start" tone={query.data.active ? "gain" : "warning"}>{t(query.data.active ? "Sync enabled" : "Broker changed")}</Badge>}
      </CardHeader>
      <CardContent className="grid gap-3">
        <QueryBoundary query={query}>
          {(state) => state.configured && !edit ? (
            <>
              <p className="text-sm">{t("Destination account")} · <b>{state.account_name}</b></p>
              <p className="break-all font-mono text-xs text-muted-foreground">{state.endpoint}</p>
              {!state.active && <Alert tone="warning">{t("New fills sync only from the broker account linked to this destination.")}</Alert>}
              <p className="text-xs text-muted-foreground">
                {t("{n} fills pending", { n: state.pending ?? 0 })}
                {state.last_synced_at && ` · ${t("Last synced {time}", { time: dateTime(state.last_synced_at) })}`}
              </p>
              {state.last_error && <Alert tone="warning">{t(state.last_error)}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setEdit(true)}><ArrowUpRight /> {t("Edit destination")}</Button>
                <Button variant="ghost" size="sm" onClick={() => setRemove(true)}><Unplug /> {t("Disconnect")}</Button>
              </div>
            </>
          ) : (
            <>
              <ConnectionForm initialEndpoint={state.endpoint ?? ""} onSaved={() => {
                void qc.invalidateQueries({ queryKey });
                setEdit(false);
                toast.success("Wealthfolio sync enabled");
              }} />
              {edit && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setEdit(false)}>{t("Cancel")}</Button>}
            </>
          )}
        </QueryBoundary>
        <ConfirmDialog open={remove} onOpenChange={setRemove}
          title={t("Disconnect Wealthfolio?")}
          description={t("New fills will stop syncing. Queued fills stay linked to their original destination.")}
          confirmLabel={t("Disconnect")} destructive loading={disconnect.isPending} onConfirm={() => disconnect.mutate()} />
      </CardContent>
    </Card>
  );
}
