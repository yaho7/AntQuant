import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, KeyRound, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { AlpacaKeysForm } from "@/components/AlpacaKeysForm";
import { BrokerPicker, SchwabForm } from "@/components/BrokerConnection";
import { ConfirmDialog, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui/primitives";
import { useProfiles, useTradingTasks } from "@/hooks/queries";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { authorizationWarning, profileLabel, profilePath, providerLabel } from "@/lib/profiles";
import { api } from "@/services/api";
import type { BrokerName, BrokerProfile, TradingTask } from "@/types/api";

function ProfileSettings({ profile, tasks }: { profile: BrokerProfile; tasks: TradingTask[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [edit, setEdit] = useState<"name" | "connection" | null>(null);
  const [action, setAction] = useState<"disconnect" | "delete" | null>(null);
  const [name, setName] = useState(profileLabel(profile));
  const path = `/api/profiles/${encodeURIComponent(profile.id)}`;
  const rename = useMutation({
    mutationFn: () => api.patch(path, { name: name.trim() }),
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ["profiles"] }); },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: (deleting: boolean) => api.del(deleting ? `${path}?remove=true` : path),
    onSuccess: (_, deleting) => {
      setAction(null);
      if (deleting) toast.success(t("Account deleted"));
      void qc.invalidateQueries();
    },
    onError: (error) => {
      toast.error(error);
      void qc.invalidateQueries({ queryKey: ["trading"] });
    },
  });
  const deleting = action === "delete";
  const blockers = tasks.filter((task) => task.config.broker_key == null || task.config.broker_key === profile.id);
  const closeAction = (open: boolean) => { if (!open) setAction(null); };
  const warning = authorizationWarning(profile);
  const connectionAction = !profile.connected ? "Reconnect account"
    : profile.provider === "alpaca" ? "Replace keys" : "Renew authorization";
  return (
    <li className="grid gap-2 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <Link className="block truncate text-sm font-semibold hover:underline" to={profilePath(profile.id)}>
            {profileLabel(profile)}
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {[providerLabel(profile.provider), profile.account_hint].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Badge tone={warning ? "warning" : profile.connected ? "gain" : "neutral"}>
          {t(warning ? (profile.authorization_expired ? "Authorization expired" : "Expires soon") : profile.connected ? "Connected" : "Not connected")}
        </Badge>
      </div>
      {profile.endpoint && <p className="break-all font-mono text-xs text-muted-foreground">{profile.endpoint}</p>}
      {profile.authorization_expires_at && <p className="text-xs text-muted-foreground">
        {t("Authorization expires {time}", { time: dateTime(profile.authorization_expires_at) })}
      </p>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" onClick={() => setEdit("connection")}><KeyRound /> {t(connectionAction)}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setName(profileLabel(profile)); setEdit("name"); }}>{t("Rename")}</Button>
        {profile.connected && <Button variant="ghost" size="sm" onClick={() => setAction("disconnect")}>{t("Disconnect")}</Button>}
        <Button asChild variant="ghost" size="sm"><Link to={profilePath(profile.id)}><ArrowUpRight /> {t("Open profile")}</Link></Button>
        <Button variant="ghost" size="sm" className="text-loss" onClick={() => setAction("delete")}><Trash2 /> {t("Delete account")}</Button>
      </div>
      <Dialog open={edit !== null} onOpenChange={(open) => { if (!open) setEdit(null); }}>
        <DialogContent title={t(edit === "name" ? "Rename account" : connectionAction)} description={profileLabel(profile)}>
          {edit === "name" ? (
            <form className="grid gap-3" onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !rename.isPending) rename.mutate();
            }}>
              <Field label={t("Account name")} htmlFor={id}>
                <Input id={id} autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
              </Field>
              <Button type="submit" className="justify-self-start" loading={rename.isPending}>{t("Save")}</Button>
            </form>
          ) : profile.provider === "alpaca" ? (
            <AlpacaKeysForm profile={profile} onSaved={() => setEdit(null)} />
          ) : (
            <SchwabForm profile={profile} onSaved={() => setEdit(null)} />
          )}
        </DialogContent>
      </Dialog>
      {deleting && blockers.length > 0 ? (
        <Dialog open onOpenChange={closeAction}>
          <DialogContent title={t("Delete {account}?", { account: profileLabel(profile) })}
            description={t("Stop strategies on this account before deleting it.")}>
            <ul className="grid gap-1 text-sm">
              {blockers.map((task) => <li key={task.id}>{task.strategy_name}</li>)}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAction(null)}>{t("Cancel")}</Button>
              <Button asChild><Link to="/trading">{t("View trading tasks")}</Link></Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        <ConfirmDialog open={action !== null} onOpenChange={closeAction}
          title={t(deleting ? "Delete {account}?" : "Disconnect {account}?", { account: profileLabel(profile) })}
          description={t(deleting
            ? "This removes the account from AntQuant and clears its broker credentials. Trade and run history are kept. Manage any open orders at your broker."
            : "Saved broker credentials will be removed. This profile and its history are kept.")}
          confirmLabel={t(deleting ? "Delete account" : "Disconnect")} destructive loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)} />
      )}
    </li>
  );
}

export function BrokerProfilesCard() {
  const query = useProfiles();
  const tasks = useTradingTasks(undefined, true);
  const [add, setAdd] = useState(false);
  const [broker, setBroker] = useState<BrokerName>("alpaca");
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("Broker accounts")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("Manage connections for your account profiles.")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => { setBroker("alpaca"); setAdd(true); }}><Plus /> {t("Add account")}</Button>
      </CardHeader>
      <CardContent>
        <QueryBoundary query={query}>
          {({ profiles }) => profiles.length ? (
            <ul>{profiles.map((profile) => <ProfileSettings key={profile.id} profile={profile} tasks={tasks.data ?? []} />)}</ul>
          ) : <Alert tone="info">{t("Connect a broker in Settings first")}</Alert>}
        </QueryBoundary>
      </CardContent>
      <Dialog open={add} onOpenChange={setAdd}>
        <DialogContent title={t("Add broker account")}>
          <BrokerPicker value={broker} onChange={setBroker} />
          {broker === "alpaca" ? <AlpacaKeysForm onSaved={() => setAdd(false)} /> : <SchwabForm onSaved={() => setAdd(false)} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
