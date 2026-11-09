import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, RefreshCw, Trash2, XCircle } from "lucide-react";
import * as React from "react";
import { AlpacaKeysForm } from "@/components/AlpacaKeysForm";
import { BrokerPicker, SchwabForm } from "@/components/BrokerConnection";
import { ConfirmDialog, PageHeader, QueryBoundary } from "@/components/common";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, Td, Th } from "@/components/ui/primitives";
import { useSettings } from "@/hooks/queries";
import { bytes, dateTime, duration } from "@/lib/format";
import { api } from "@/services/api";
import type { AuditEntry, BrokerName, CompatReport, SettingsView, SystemInfo, UpdateInfo } from "@/types/api";
import { t } from "@/lib/i18n";

function AlpacaSettings({ view }: { view: SettingsView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [replace, setReplace] = React.useState(false);
  const [remove, setRemove] = React.useState(false);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; account_id?: string; status?: string }>("/api/settings/alpaca/test"),
  });
  const del = useMutation({
    mutationFn: () => api.del("/api/settings/alpaca/credentials"),
    onSuccess: () => {
      setRemove(false);
      void qc.invalidateQueries();
      toast.success("Alpaca keys removed");
    },
    onError: toast.error,
  });
  const a = view.alpaca;
  return (
    <>
        {a.configured && !replace ? (
          <>
            <p className="flex items-center gap-2 text-sm">{t("Key ID")} <span className="font-mono">{a.api_key_hint}</span> </p>
            {a.endpoint && <p className="break-all text-xs text-muted-foreground">{t("Endpoint")} <span className="font-mono">{a.endpoint}</span></p>}
            {test.data && (test.data.ok ? (
              <Alert tone="info"><CheckCircle2 className="text-gain" />
                {t("Connected to account {account} ({status}).", {
                  account: test.data.account_id ?? "",
                  status: test.data.status ?? "",
                })}
              </Alert>
            ) : (
              <Alert tone="loss">{t(test.data.error ?? "Connection failed")}</Alert>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate()}>{t("Test connection")}</Button>
              <Button variant="outline" size="sm" onClick={() => setReplace(true)}><KeyRound /> {t("Replace keys")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setRemove(true)}><Trash2 /> {t("Remove")}</Button>
            </div>
          </>
        ) : (
          <>
            <AlpacaKeysForm initialEndpoint={a.endpoint ?? undefined} onSaved={() => {
              test.reset();
              setReplace(false);
              toast.success("Alpaca keys saved");
            }} />
            {replace && <Button variant="ghost" size="sm" onClick={() => setReplace(false)}>{t("Cancel")}</Button>}
          </>
        )}
      <ConfirmDialog open={remove} onOpenChange={setRemove} title={t("Remove Alpaca keys?")}
        description={t("Dashboard and trading will stop working until new keys are added. Running strategies must be stopped first.")}
        confirmLabel={t("Remove keys")} destructive loading={del.isPending} onConfirm={() => del.mutate()} />
    </>
  );
}

function SchwabSettings({ view }: { view: SettingsView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reauthorize, setReauthorize] = React.useState(false);
  const [remove, setRemove] = React.useState(false);
  const state = view.schwab;
  const disconnect = useMutation({
    mutationFn: () => api.del("/api/settings/schwab/connection"),
    onSuccess: () => { setRemove(false); void qc.invalidateQueries(); toast.success("Schwab disconnected"); },
    onError: toast.error,
  });
  if (!state.configured || reauthorize) {
    return (
      <>
        <SchwabForm hasSavedApp={state.configured} initialCallback={state.callback_url ?? undefined} onSaved={() => {
          setReauthorize(false);
          toast.success("Schwab connected");
        }} />
        {reauthorize && <Button variant="ghost" className="justify-self-start" onClick={() => setReauthorize(false)}>{t("Cancel")}</Button>}
      </>
    );
  }
  const expires = state.authorization_expires_at ? Date.parse(state.authorization_expires_at) : 0;
  const remaining = expires - Date.now();
  return (
    <>
      <p className="text-sm">{t("Account")} <span className="font-mono">{state.account_hint}</span></p>
      <p className="break-all text-xs text-muted-foreground">{t("Endpoint")} <span className="font-mono">{state.endpoint}</span></p>
      <p className="text-sm">{t("Authorization expires {time}", { time: dateTime(state.authorization_expires_at) })}</p>
      {remaining <= 86_400_000 && (
        <Alert tone={remaining <= 0 ? "loss" : "warning"}>
          {t(remaining <= 0 ? "Schwab authorization expired. Reconnect in Settings." : "Schwab authorization expires within 24 hours. Renew it to keep strategies connected.")}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setReauthorize(true)}><KeyRound /> {t("Renew authorization")}</Button>
        <Button variant="ghost" size="sm" onClick={() => setRemove(true)}><Trash2 /> {t("Remove")}</Button>
      </div>
      <ConfirmDialog open={remove} onOpenChange={setRemove} title={t("Disconnect Schwab?")}
        description={t("Disconnecting clears the saved Schwab authorization.")}
        confirmLabel={t("Disconnect")} destructive loading={disconnect.isPending} onConfirm={() => disconnect.mutate()} />
    </>
  );
}

function BrokerCard({ view }: { view: SettingsView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [broker, setBroker] = React.useState<BrokerName>(view.active_broker);
  const configured = broker === "alpaca" ? view.alpaca.configured : view.schwab.configured;
  const active = broker === view.active_broker && configured;
  const select = useMutation({
    mutationFn: () => api.put("/api/settings/broker/active", { broker }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast.success("Active broker updated");
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("Broker connection")}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{t("Choose the broker used for account data and strategy orders.")}</p>
        </div>
        {active ? <Badge tone="gain"><CheckCircle2 /> {t("Active broker")}</Badge>
          : configured ? <Badge>{t("Configured")}</Badge>
            : <Badge><XCircle /> {t("Not configured")}</Badge>}
      </CardHeader>
      <CardContent className="grid gap-3">
        <BrokerPicker value={broker} onChange={setBroker} />
        {configured && !active && (
          <Button className="justify-self-start" variant="outline" size="sm" loading={select.isPending}
            onClick={() => select.mutate()}>{t("Use this broker")}</Button>
        )}
        {broker === "alpaca" ? <AlpacaSettings view={view} /> : <SchwabSettings view={view} />}
      </CardContent>
    </Card>
  );
}

function BacktestSettingsCard({ view }: { view: SettingsView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = view.settings;
  const [defaults, setDefaults] = React.useState(s.backtest_defaults);
  const [timeout, setTimeoutMin] = React.useState(String(s.backtest_timeout_minutes));
  const [concurrency, setConcurrency] = React.useState(String(s.max_concurrent_backtests));
  const save = useMutation({
    mutationFn: async () => {
      await api.put("/api/settings/backtest_defaults", { ...defaults, budget: Number(defaults.budget) });
      await api.put("/api/settings/backtest_timeout_minutes", { value: Number(timeout) });
      await api.put("/api/settings/max_concurrent_backtests", { value: Number(concurrency) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["backtests", "options"] });
      toast.success("Settings saved");
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader><CardTitle>{t("Backtest defaults")}</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label={t("Data source")} htmlFor="sd">
            <Select id="sd" value={defaults.data_source} onChange={(e) => setDefaults({ ...defaults, data_source: e.target.value })}>
              <option value="yahoo">{t("Yahoo Finance")}</option>
              <option value="alpaca">{t("Alpaca Market Data")}</option>
            </Select>
          </Field>
          <Field label={t("Initial capital (USD)")} htmlFor="sb">
            <Input id="sb" type="number" min={1} className="num" value={defaults.budget}
              onChange={(e) => setDefaults({ ...defaults, budget: Number(e.target.value) })} />
          </Field>
          <Field label={t("Benchmark symbol")} htmlFor="sbm">
            <Input id="sbm" value={defaults.benchmark} maxLength={16} onChange={(e) => setDefaults({ ...defaults, benchmark: e.target.value.toUpperCase() })} />
          </Field>
          <Field label={t("Timeout (minutes)")} htmlFor="st" hint={t("A backtest running longer is stopped and marked failed.")}>
            <Input id="st" type="number" min={5} max={1440} className="num" value={timeout} onChange={(e) => setTimeoutMin(e.target.value)} />
          </Field>
          <Field label={t("Backtests at the same time")} htmlFor="sc" hint={t("Others wait in the queue. Each uses several hundred MB of memory.")}>
            <Input id="sc" type="number" min={1} max={8} className="num" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <div className="flex items-end justify-end sm:col-span-2">
            <Button type="submit" loading={save.isPending}>{t("Save")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = React.useState({ current: "", next: "", confirm: "" });
  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
  const change = useMutation({
    mutationFn: () => api.post("/api/auth/password", { current_password: form.current, new_password: form.next }),
    onSuccess: async () => {
      setForm({ current: "", next: "", confirm: "" });
      await qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success("Password changed. Other sessions were signed out.");
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader><CardTitle>{t("Password")}</CardTitle></CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (!mismatch) change.mutate(); }}>
          <Field label={t("Current password")} htmlFor="pc"><Input id="pc" type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required /></Field>
          <Field label={t("New password")} htmlFor="pn" hint={t("At least 10 characters.")}><Input id="pn" type="password" autoComplete="new-password" minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required /></Field>
          <Field label={t("Confirm new password")} htmlFor="pcf"><Input id="pcf" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required /></Field>
          {mismatch && <Alert tone="loss">{t("Passwords do not match.")}</Alert>}
          <div className="flex justify-end"><Button type="submit" disabled={mismatch} loading={change.isPending}>{t("Change password")}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function SystemCard() {
  const info = useQuery({ queryKey: ["system", "info"], queryFn: () => api.get<SystemInfo>("/api/system/info") });
  const compat = useQuery({ queryKey: ["system", "compat"], queryFn: () => api.get<CompatReport>("/api/system/compat"), staleTime: Infinity });
  const [checkUpdates, setCheckUpdates] = React.useState(false);
  const updates = useQuery({ queryKey: ["system", "updates"], queryFn: () => api.get<UpdateInfo>("/api/system/updates"), enabled: checkUpdates, staleTime: 3600_000 });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("System")}</CardTitle>
        <Button size="sm" variant="outline" loading={updates.isFetching} onClick={() => { setCheckUpdates(true); void updates.refetch(); }}>
          <RefreshCw /> {t("Check for updates")} </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <QueryBoundary query={info}>
          {(i) => (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t("LumiBot UI")}</dt><dd className="num">{i.ui_version}</dd>
              <dt className="text-muted-foreground">{t("LumiBot")}</dt>
              <dd className="num flex items-center gap-2">{i.lumibot_version ?? t("not installed")}
                {i.lumibot_version && i.verified_lumibot_versions.includes(i.lumibot_version)
                  ? <Badge tone="gain">{t("verified")}</Badge> : <Badge tone="warning">{t("not verified")}</Badge>}
              </dd>
              <dt className="text-muted-foreground">{t("Verified versions")}</dt><dd className="num">{i.verified_lumibot_versions.join(", ")}</dd>
              <dt className="text-muted-foreground">{t("Python")}</dt><dd className="num">{i.python}</dd>
              <dt className="text-muted-foreground">{t("Platform")}</dt><dd className="break-all text-xs">{i.platform}</dd>
              <dt className="text-muted-foreground">{t("Data folder")}</dt><dd className="break-all font-mono text-xs">{i.data_dir}</dd>
              <dt className="text-muted-foreground">{t("Disk free")}</dt><dd className="num">{t("{free} of {total}", { free: bytes(i.disk_free_bytes), total: bytes(i.disk_total_bytes) })}</dd>
              <dt className="text-muted-foreground">{t("Tasks recorded")}</dt><dd className="num">{i.task_count}</dd>
              <dt className="text-muted-foreground">{t("Uptime")}</dt><dd className="num">{duration(i.uptime_seconds)}</dd>
            </dl>
          )}
        </QueryBoundary>
        {updates.data && (
          <Alert tone="info">
            <div className="grid gap-1">
              <span>{t("LumiBot latest on PyPI:")} <b className="num">{updates.data.lumibot.latest ?? updates.data.lumibot.error}</b>
                {updates.data.lumibot.latest && updates.data.lumibot.latest !== updates.data.lumibot.installed && ` ${t("(newer than installed; wait for a LumiBot UI release that verifies it)")}`}</span>
              <span>{t("LumiBot UI latest release:")} <b className="num">{updates.data.ui.latest ?? updates.data.ui.error}</b></span>
              <span className="text-xs text-muted-foreground">{t("Nothing is installed automatically. Update by pulling a newer image tag.")}</span>
            </div>
          </Alert>
        )}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("LumiBot API compatibility")}</p>
          <QueryBoundary query={compat}>
            {(c) => (
              <ul className="grid gap-1 text-sm">
                {c.checks.map((ch) => (
                  <li key={ch.name} className="flex items-start gap-2">
                    {ch.ok ? <CheckCircle2 className="mt-0.5 size-4 text-gain" /> : <XCircle className="mt-0.5 size-4 text-loss" />}
                    <span className="font-mono text-xs">{t(ch.name)}</span>
                    <span className="text-xs text-muted-foreground">{t(ch.detail)}</span>
                  </li>
                ))}
                {c.error && <li className="text-xs text-loss">{c.error}</li>}
              </ul>
            )}
          </QueryBoundary>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditCard() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntry[]>("/api/audit?limit=50"), refetchInterval: 15_000 });
  return (
    <Card>
      <CardHeader><CardTitle>{t("Audit log")}</CardTitle></CardHeader>
      <CardContent className="px-0">
        <QueryBoundary query={audit}>
          {(rows) => (
            <div className="max-h-96 overflow-auto">
              <Table>
                <thead><tr><Th>{t("Time")}</Th><Th>{t("Action")}</Th><Th>{t("Target")}</Th><Th>{t("Result")}</Th><Th>{t("IP")}</Th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <Td className="num text-xs">{dateTime(r.time)}</Td>
                      <Td className="font-mono text-xs">{r.action}</Td>
                      <Td className="max-w-48 truncate text-xs" title={r.target}>{r.target}</Td>
                      <Td>{r.success ? <Badge tone="gain">{t("ok")}</Badge> : <Badge tone="loss">{t("refused")}</Badge>}</Td>
                      <Td className="num text-xs">{r.ip}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  return (
    <>
      <PageHeader title={t("Settings")} />
      <QueryBoundary query={settings} rows={6}>
        {(view) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid content-start gap-4">
              <BrokerCard view={view} />
              <BacktestSettingsCard view={view} />
              <PasswordCard />
            </div>
            <div className="grid content-start gap-4">
              <SystemCard />
              <Card>
                <CardHeader><CardTitle>{t("Logging")}</CardTitle></CardHeader>
                <CardContent className="text-sm text-muted-foreground">{t("System log: data/logs/system.log, rotated at 5 MB, 5 files kept. Each task writes its own log in data/tasks/<id>/task.log. Set the level with the LUMIBOT_UI_LOG_LEVEL environment variable.")}</CardContent>
              </Card>
              <AuditCard />
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
