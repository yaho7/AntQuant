import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FlaskConical, History, Pencil, ScrollText } from "lucide-react";
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
import type { LineFocus } from "@/components/PythonEditor";
import { StrategyCodeEditor } from "@/components/StrategyCode";
import { CodeChecks, FixDialog, Step, TrialPanel, TrustCheck, useStrategyDraft } from "@/components/StrategyChecks";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfiles, useStrategies, useTradingTasks } from "@/hooks/queries";
import { dateTime, money, num, pct } from "@/lib/format";
import { api, qs } from "@/services/api";
import type { Backtest, CodeFix, Fill, Params, Strategy, StrategySource, StrategyVersion } from "@/types/api";
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

function savedCode(qc: ReturnType<typeof useQueryClient>, strategyId: number) {
  return async (saved: Strategy) => {
    qc.setQueryData(["strategy", strategyId], saved);
    await qc.invalidateQueries({ queryKey: ["strategy", strategyId, "source"] });
    void qc.invalidateQueries({ queryKey: ["strategy", strategyId, "versions"] });
    void qc.invalidateQueries({ queryKey: ["strategies"] });
  };
}

/** Editing uploaded code: the same check, fix and trial steps as adding a strategy. */
function CodeEditor({ strategy, source, onClose }: { strategy: Strategy; source: StrategySource; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const filename = source.source_path.split("/").pop() ?? "strategy.py";
  const [code, setCode] = React.useState(source.code);
  const [version] = React.useState(source.version);
  const [focus, setFocus] = React.useState<LineFocus | null>(null);
  const [fix, setFix] = React.useState<CodeFix | null>(null);
  const [discarding, setDiscarding] = React.useState(false);
  const draft = useStrategyDraft(code, filename, { className: strategy.class_name, parameters: strategy.parameters });
  const goTo = (line: number) => setFocus({ line, nonce: Date.now() });
  const save = useMutation({
    mutationFn: () => api.put<Strategy>(`/api/strategies/${strategy.id}/source`, {
      code, filename, class_name: draft.picked, parameters: draft.params,
      expected_version: version, acknowledge_risk: draft.ack,
    }),
    onSuccess: async (saved) => {
      await savedCode(qc, strategy.id)(saved);
      onClose();
      toast.success(t("Saved as version {v}", { v: saved.version }));
    },
    onError: (error) => {
      toast.error(error);
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id] });
    },
  });
  const busy = save.isPending || draft.trial.isPending;
  const outdated = source.version !== version;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid min-w-0 content-start gap-3">
        <StrategyCodeEditor code={code} label={t("Python strategy code")} focusLine={focus} minHeight="20rem"
          onChange={busy ? undefined : setCode} />
        {outdated && <Alert tone="warning">{t("This strategy was updated. Reload it before saving.")}</Alert>}
      </div>
      <div className="grid content-start gap-5">
        <Step n={1} title={t("Check")} busy={draft.scan.pending && !!draft.scan.result}>
          <CodeChecks draft={draft} onLine={goTo} onFix={setFix} />
        </Step>
        {draft.item && (
          <>
            <Step n={2} title={t("Parameters")}>
              <ParamsEditor key={draft.revision} id="code-params" value={draft.params} onChange={draft.setParams} />
            </Step>
            <Step n={3} title={t("Trial run")}>
              <TrustCheck draft={draft} disabled={busy} />
              <TrialPanel draft={draft} onLine={goTo} disabled={busy} />
            </Step>
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => {
            if (code !== source.code) setDiscarding(true);
            else onClose();
          }}>{t("Cancel")}</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}
            disabled={!draft.ready || !draft.ack || draft.trial.isPending || outdated}>{t("Save new version")}</Button>
        </div>
      </div>
      <FixDialog fix={fix} onOpenChange={(open) => { if (!open) setFix(null); }}
        onApply={(fixed) => { setCode(fixed); setFix(null); }} />
      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title={t("Discard code edits?")}
        description={t("The editor will reopen with the last saved code.")}
        confirmLabel={t("Discard changes")} destructive onConfirm={() => { setDiscarding(false); onClose(); }} />
    </div>
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
  const [editing, setEditing] = React.useState(false);
  const saveFile = useMutation({
    mutationFn: () => api.patch<Strategy>(path, { expected_version: source.data!.version }),
    onSuccess: async (saved) => {
      await savedCode(qc, strategy.id)(saved);
      toast.success(t("Saved as version {v}", { v: saved.version }));
    },
    onError: (error) => {
      toast.error(error);
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id] });
    },
  });

  return (
    <Card>
      <QueryBoundary query={source}>
        {(s) => (
          <CardContent className="grid gap-4 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="max-w-full truncate font-mono">{s.source_path}</span>
              {s.editable && !editing && (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil /> {t("Edit code")}</Button>
              )}
            </div>
            {editing ? (
              <CodeEditor strategy={strategy} source={s} onClose={() => setEditing(false)} />
            ) : (
              <>
                <StrategyCodeEditor code={s.code} label={t("Python strategy code")} />
                {!s.editable && <p className="text-xs text-muted-foreground">{t("For strategies from a folder, edit the Python file in that folder.")}</p>}
                {s.modified && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{t("The file on disk differs from the saved version.")}</p>
                    <Button size="sm" variant="outline" loading={saveFile.isPending}
                      onClick={() => saveFile.mutate()}>{t("Save file as new version")}</Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        )}
      </QueryBoundary>
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
