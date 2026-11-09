import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FlaskConical, History, Pencil, ScanLine, ScrollText, ShieldAlert } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ConfirmDialog,
  Delta,
  EmptyState,
  ModeBadge,
  PageHeader,
  QueryBoundary,
  StatusBadge,
} from "@/components/common";
import { ParamsEditor } from "@/components/ParamsEditor";
import { mergeScannedParameters, scanStrategyCode, StrategyCodeEditor, StrategyCodeGuide } from "@/components/StrategyCode";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfiles, useStrategies, useTradingTasks } from "@/hooks/queries";
import { dateTime, money, num, pct } from "@/lib/format";
import { api, qs } from "@/services/api";
import type { Backtest, DiscoveredStrategy, Fill, Params, Strategy, StrategySource, StrategyVersion } from "@/types/api";
import { t } from "@/lib/i18n";
import { profileLabel, taskProfileLabel } from "@/lib/profiles";

function OverviewTab({ strategy }: { strategy: Strategy }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = React.useState(strategy.name);
  const [description, setDescription] = React.useState(strategy.description);
  const [params, setParams] = React.useState<Params>(strategy.parameters);
  const [paramsError, setParamsError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    setName(strategy.name);
    setDescription(strategy.description);
    setParams(strategy.parameters);
    setParamsError(null);
  }, [strategy]);
  const dirty =
    name !== strategy.name ||
    description !== strategy.description ||
    JSON.stringify(params) !== JSON.stringify(strategy.parameters);
  const save = useMutation({
    mutationFn: () =>
      api.patch<Strategy>(`/api/strategies/${strategy.id}`, { name, description, parameters: params, note, expected_version: strategy.version }),
    onSuccess: (s) => {
      qc.setQueryData(["strategy", strategy.id], s);
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id, "versions"] });
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id, "source"] });
      setNote("");
      toast.success(t("Saved as version {v}", { v: s.version }));
    },
    onError: toast.error,
  });
  const running = strategy.trading_task && ["starting", "running"].includes(strategy.trading_task.status);
  return (
    <Card>
      <CardContent className="grid gap-4 pt-4">
        {running && (
          <Alert tone="info">{t("Changes apply to the next run. The running strategy keeps the parameters it started with.")} </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t("Name")} htmlFor="n"><Input id="n" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Source")}>
            <p className="flex h-9 items-center truncate font-mono text-xs text-muted-foreground">
              {strategy.source_path} · {strategy.class_name}
            </p>
          </Field>
        </div>
        <Field label={t("Description")} htmlFor="d"><Textarea id="d" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label={t("Parameters")} htmlFor="p">
          <ParamsEditor key={strategy.version} id="p" value={params} onChange={(p, err) => { if (p) setParams(p); setParamsError(err); }} />
        </Field>
        <Field label={t("Change note (optional)")} htmlFor="note">
          <Input id="note" value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder={t("e.g. Faster SMA window")} />
        </Field>
        <div className="flex justify-end">
          <Button disabled={!dirty || !!paramsError || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>{t("Save new version")} </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PerformanceTab({ strategyId }: { strategyId: number }) {
  const { data: profiles } = useProfiles();
  const perf = useQuery({
    queryKey: ["strategy", strategyId, "performance"],
    queryFn: () => api.get<{ backtests: Backtest[]; fills: Fill[] }>(`/api/strategies/${strategyId}/performance`),
    refetchInterval: 10_000,
  });
  return (
    <QueryBoundary query={perf}>
      {(data) => (
        <div className="grid gap-4">
          <Card>
            <CardHeader><CardTitle>{t("Backtests")}</CardTitle></CardHeader>
            <CardContent className="px-0">
              {data.backtests.length === 0 ? (
                <EmptyState title={t("No backtests yet")} />
              ) : (
                <Table>
                  <thead><tr><Th>{t("Started")}</Th><Th>{t("Period")}</Th><Th>{t("Status")}</Th><Th className="text-right">{t("Return")}</Th><Th className="text-right">{t("Max DD")}</Th><Th className="text-right">{t("Sharpe")}</Th></tr></thead>
                  <tbody>
                    {data.backtests.map((b) => (
                      <tr key={b.id}>
                        <Td><Link className="hover:underline" to={`/backtesting/${b.id}`}>{dateTime(b.created_at)}</Link></Td>
                        <Td className="num text-xs">{String(b.config.start)} → {String(b.config.end)}</Td>
                        <Td><StatusBadge status={b.status} /></Td>
                        <Td className="text-right"><Delta value={b.metrics?.total_return}>{pct(b.metrics?.total_return, 2, true)}</Delta></Td>
                        <Td className="num text-right">{pct(b.metrics?.max_drawdown)}</Td>
                        <Td className="num text-right">{num(b.metrics?.sharpe_ratio)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("Fills by this strategy")}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Fills recorded by this strategy's own runs. Account equity is shared by all strategies on the account, so per-strategy P&L is not derived from it.")}
                </p>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              {data.fills.length === 0 ? (
                <EmptyState title={t("No fills recorded")} />
              ) : (
                <Table>
                  <thead><tr><Th>{t("Time")}</Th><Th>{t("Broker account")}</Th><Th>{t("Symbol")}</Th><Th>{t("Side")}</Th><Th className="text-right">{t("Qty")}</Th><Th className="text-right">{t("Price")}</Th></tr></thead>
                  <tbody>
                    {data.fills.map((f, i) => (
                      <tr key={i}>
                        <Td className="num text-xs">{dateTime(f.time)}</Td>
                        <Td>{(() => {
                          const profile = profiles?.profiles.find((item) => item.id === f.profile_id);
                          return profile ? profileLabel(profile) : f.profile_name || t("Unassigned account");
                        })()}</Td>
                        <Td>{f.symbol}</Td>
                        <Td className="capitalize">{f.side}</Td>
                        <Td className="num text-right">{num(f.quantity, 4)}</Td>
                        <Td className="num text-right">{money(f.price)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </QueryBoundary>
  );
}

function versionNote(note: string) {
  const restored = /^Restored (code and parameters|parameters) from v(\d+)$/.exec(note);
  if (!restored) return t(note);
  return t(restored[1] === "parameters" ? "Restored parameters from v{v}" : "Restored code and parameters from v{v}",
    { v: restored[2]! });
}

function VersionsTab({ strategyId }: { strategyId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const versions = useQuery({
    queryKey: ["strategy", strategyId, "versions"],
    queryFn: () => api.get<StrategyVersion[]>(`/api/strategies/${strategyId}/versions`),
  });
  const [restoring, setRestoring] = React.useState<StrategyVersion | null>(null);
  const restore = useMutation({
    mutationFn: (v: StrategyVersion) => api.post<Strategy>(
      `/api/strategies/${strategyId}/versions/${v.version}/restore${qs({ parameters_only: !v.code_available })}`,
    ),
    onSuccess: (s) => {
      qc.setQueryData(["strategy", strategyId], s);
      void qc.invalidateQueries({ queryKey: ["strategy", strategyId, "versions"] });
      void qc.invalidateQueries({ queryKey: ["strategy", strategyId, "source"] });
      setRestoring(null);
      toast.success(t("Restored as version {v}", { v: s.version }));
    },
    onError: toast.error,
  });
  return (
    <Card>
      <QueryBoundary query={versions}>
        {(list) => (
          <Table>
            <thead><tr><Th>{t("Version")}</Th><Th>{t("Saved")}</Th><Th>{t("Note")}</Th><Th>{t("Code hash")}</Th><Th>{t("Parameters")}</Th><Th /></tr></thead>
            <tbody>
              {list.map((v, i) => (
                <tr key={v.version}>
                  <Td><Badge tone={i === 0 ? "info" : "neutral"}>v{v.version}</Badge></Td>
                  <Td className="num text-xs">{dateTime(v.created_at)}</Td>
                  <Td className="text-xs">{versionNote(v.note)}</Td>
                  <Td className="font-mono text-xs" title={v.code_sha256}>{v.code_sha256.slice(0, 10)}</Td>
                  <Td className="max-w-xs truncate font-mono text-xs" title={JSON.stringify(v.parameters)}>{JSON.stringify(v.parameters)}</Td>
                  <Td className="text-right">
                    {i > 0 && (
                      <Button size="sm" variant="ghost" disabled={restore.isPending} onClick={() => setRestoring(v)}>
                        <History /> {t(v.code_available ? "Restore" : "Restore parameters")} </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
      {restoring && (
        <ConfirmDialog open onOpenChange={(open) => { if (!open && !restore.isPending) setRestoring(null); }}
          title={t("Restore version {v}?", { v: restoring.version })}
          description={t(restoring.code_available
            ? "Restore its code and parameters as a new version for future runs."
            : "This version has no matching code copy. Restore its parameters to the current code.")}
          confirmLabel={t(restoring.code_available ? "Restore" : "Restore parameters")}
          loading={restore.isPending} onConfirm={() => restore.mutate(restoring)} />
      )}
    </Card>
  );
}

function CodeTab({ strategy }: { strategy: Strategy }) {
  const qc = useQueryClient();
  const toast = useToast();
  const path = `/api/strategies/${strategy.id}`;
  const source = useQuery({
    queryKey: ["strategy", strategy.id, "source"],
    queryFn: () => api.get<StrategySource>(`${path}/source`),
  });
  const [draft, setDraft] = React.useState<{ code: string; original: string; version: number } | null>(null);
  const [picked, setPicked] = React.useState("");
  const [params, setParams] = React.useState<Params>({});
  const [paramsError, setParamsError] = React.useState<string | null>(null);
  const [formRevision, setFormRevision] = React.useState(0);
  const [ack, setAck] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const filename = source.data?.source_path.split("/").pop() ?? "strategy.py";

  function selectClass(item: DiscoveredStrategy) {
    const previous = item.class_name === picked ? params : item.class_name === strategy.class_name ? strategy.parameters : {};
    setPicked(item.class_name);
    setParams(mergeScannedParameters(item, previous));
    setParamsError(null);
    setFormRevision((value) => value + 1);
  }

  const scan = useMutation({
    mutationFn: async (code: string) => ({ code, classes: await scanStrategyCode(code, filename) }),
    onSuccess: ({ classes }) => {
      const item = classes.find((entry) => entry.class_name === picked)
        ?? classes.find((entry) => entry.class_name === strategy.class_name)
        ?? (classes.length === 1 ? classes[0] : undefined);
      if (item) selectClass(item);
      else setPicked("");
    },
  });

  const save = useMutation({
    mutationFn: (edit: typeof draft) => edit
      ? api.put<Strategy>(`${path}/source`, {
        code: edit.code, filename, class_name: picked, parameters: params,
        expected_version: edit.version, acknowledge_risk: ack,
      })
      : api.patch<Strategy>(path, { expected_version: source.data!.version }),
    onSuccess: async (saved) => {
      qc.setQueryData(["strategy", strategy.id], saved);
      await qc.invalidateQueries({ queryKey: ["strategy", strategy.id, "source"] });
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id, "versions"] });
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      setDraft(null);
      scan.reset();
      toast.success(t("Saved as version {v}", { v: saved.version }));
    },
    onError: (error) => {
      toast.error(error);
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id] });
    },
  });

  const busy = scan.isPending || save.isPending;
  const scanned = draft && scan.data?.code === draft.code ? scan.data.classes : [];
  const selected = scanned.find((item) => item.class_name === picked);

  function startEdit(s: StrategySource) {
    setDraft({ code: s.code, original: s.code, version: s.version });
    setPicked(strategy.class_name);
    setParams(strategy.parameters);
    setParamsError(null);
    setAck(false);
    scan.reset();
  }

  return (
    <Card>
      <QueryBoundary query={source}>
        {(s) => (
          <CardContent className="grid gap-4 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="max-w-full truncate font-mono">{s.source_path}</span>
              {s.editable && !draft && (
                <Button size="sm" variant="outline" onClick={() => startEdit(s)}><Pencil /> {t("Edit code")}</Button>
              )}
            </div>
            <StrategyCodeEditor code={draft?.code ?? s.code} label={t("Python strategy code")}
              onChange={draft && !busy ? (code) => {
                setDraft({ ...draft, code });
                setAck(false);
                if (scan.isError) scan.reset();
              } : undefined} />
            {draft ? (
              <>
                <StrategyCodeGuide />
                {s.version !== draft.version && (
                  <Alert tone="warning">{t("This strategy was updated. Reload it before saving.")}</Alert>
                )}
                <Button variant="outline" loading={scan.isPending}
                  disabled={save.isPending || !draft.code.trim()} className="justify-self-start"
                  onClick={() => scan.mutate(draft.code)}><ScanLine /> {t("Scan code")}</Button>
                {scan.isError && <Alert tone="warning" role="alert">{scan.error.message}</Alert>}
                {scanned.length > 0 && (
                  <Field label={t("Strategy class")} htmlFor={scanned.length > 1 ? "code-class" : undefined}>
                    {scanned.length === 1 ? (
                      <p className="rounded-lg border bg-card px-3 py-2 font-mono text-xs">{scanned[0]!.class_name}</p>
                    ) : (
                      <Select id="code-class" value={picked} disabled={busy} onChange={(event) => {
                        const item = scanned.find((entry) => entry.class_name === event.target.value);
                        if (item) selectClass(item);
                      }}>
                        <option value="" disabled>{t("Choose a class")}</option>
                        {scanned.map((item) => <option key={item.class_name} value={item.class_name}>{item.class_name}</option>)}
                      </Select>
                    )}
                  </Field>
                )}
                {selected && (
                  <fieldset disabled={busy} className="grid min-w-0 gap-4">
                    {!selected.parameters_parsed && (
                      <Alert tone="warning">{t("Default parameters could not be read from the file; enter them below.")}</Alert>
                    )}
                    <Field label={t("Parameters")} htmlFor="code-params">
                      <ParamsEditor key={formRevision} id="code-params" value={params}
                        onChange={(value, error) => { if (value) setParams(value); setParamsError(error); }} />
                    </Field>
                    <Alert tone="warning">
                      <ShieldAlert />
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-1" checked={ack} onChange={(event) => setAck(event.target.checked)} />
                        {t("I wrote or reviewed this code and accept that it runs with server permissions.")}
                      </label>
                    </Alert>
                  </fieldset>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => {
                    if (draft.code !== draft.original) setDiscarding(true);
                    else { setDraft(null); scan.reset(); }
                  }}>{t("Cancel")}</Button>
                  <Button loading={save.isPending}
                    disabled={!selected || !!paramsError || !ack || scan.isPending || s.version !== draft.version}
                    onClick={() => save.mutate(draft)}>{t("Save new version")}</Button>
                </div>
              </>
            ) : (
              <>
                {!s.editable && <p className="text-xs text-muted-foreground">{t("For strategies from a folder, edit the Python file in that folder.")}</p>}
                {s.modified && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{t("The file on disk differs from the saved version.")}</p>
                    <Button size="sm" variant="outline" loading={save.isPending}
                      onClick={() => save.mutate(null)}>{t("Save file as new version")}</Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        )}
      </QueryBoundary>
      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title={t("Discard code edits?")}
        description={t("The editor will reopen with the last saved code.")}
        confirmLabel={t("Discard changes")} destructive onConfirm={() => {
          setDiscarding(false); setDraft(null); scan.reset();
        }} />
    </Card>
  );
}

export function StrategyDetailPage() {
  const { id } = useParams();
  const sid = Number(id);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { data: profiles } = useProfiles();
  const runs = useTradingTasks(undefined, true);
  const active = (runs.data ?? []).filter((task) => task.strategy_id === sid);
  const profileIds = active.map((task) => task.config.broker_key).filter((id): id is string => typeof id === "string");
  const [archiving, setArchiving] = React.useState(false);
  const [codeVisited, setCodeVisited] = React.useState(false);
  const strategy = useQuery({
    queryKey: ["strategy", sid],
    queryFn: () => api.get<Strategy>(`/api/strategies/${sid}`),
  });
  const list = useStrategies();
  const trading = list.data?.find((s) => s.id === sid)?.trading_task ?? null;
  const archive = useMutation({
    mutationFn: () => api.post(`/api/strategies/${sid}/archive?archived=true`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      toast.success("Strategy archived");
      navigate("/strategies");
    },
    onError: toast.error,
  });

  return (
    <QueryBoundary query={strategy} rows={6}>
      {(s) => (
        <>
          <PageHeader
            title={s.name}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <Badge>v{s.version}</Badge>
                <span className="font-mono text-xs">{s.class_name}</span>
                {trading && <StatusBadge status={trading.status} paused={trading.paused} />}
                {trading && <ModeBadge mode={trading.mode} />}
              </span>
            }
            actions={
              <>
                <Button asChild variant="outline" size="sm"><Link to={`/backtesting${qs({ strategy: s.id, profile: search.get("profile") })}`}><FlaskConical /> {t("Backtest")}</Link></Button>
                <Button asChild variant="outline" size="sm"><Link to={`/logs?strategy=${s.id}`}><ScrollText /> {t("Logs")}</Link></Button>
                <TradingControls strategyId={s.id} task={null} runningProfiles={profileIds} />
                <Button variant="ghost" size="sm" onClick={() => setArchiving(true)}><Archive /> {t("Archive")}</Button>
              </>
            }
          />
          {trading?.error_message && trading.status === "failed" && (
            <Alert tone="loss" className="mb-4">{t("Last trading run failed: {error}", { error: trading.error_message })}</Alert>
          )}
          {active.length > 0 && (
            <Card className="mb-4">
              <CardHeader><CardTitle>{t("Running strategies")}</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                {active.map((task) => (
                  <div key={task.id} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{taskProfileLabel(task, profiles?.profiles ?? [])}</span>
                      <StatusBadge status={task.status} paused={task.paused} />
                    </div>
                    <TradingControls strategyId={s.id} task={task} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          <Tabs defaultValue="overview" onValueChange={(tab) => { if (tab === "code") setCodeVisited(true); }}>
            <TabsList>
              <TabsTrigger value="overview">{t("Configuration")}</TabsTrigger>
              <TabsTrigger value="performance">{t("Performance")}</TabsTrigger>
              <TabsTrigger value="versions">{t("Versions")}</TabsTrigger>
              <TabsTrigger value="code">{t("Code")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><OverviewTab strategy={s} /></TabsContent>
            <TabsContent value="performance"><PerformanceTab strategyId={s.id} /></TabsContent>
            <TabsContent value="versions"><VersionsTab strategyId={s.id} /></TabsContent>
            <TabsContent value="code" forceMount={codeVisited ? true : undefined} className="data-[state=inactive]:hidden">
              <CodeTab key={s.id} strategy={s} />
            </TabsContent>
          </Tabs>
          <ConfirmDialog
            open={archiving}
            onOpenChange={setArchiving}
            title={t("Archive strategy?")}
            description={t("It disappears from lists. History, backtests and logs are kept. Running tasks must be stopped first.")}
            confirmLabel={t("Archive")}
            loading={archive.isPending}
            onConfirm={() => archive.mutate()}
          />
        </>
      )}
    </QueryBoundary>
  );
}
