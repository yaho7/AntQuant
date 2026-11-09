import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FlaskConical, History, ScrollText } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Field, Input, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccountSummary } from "@/hooks/queries";
import { dateTime, money, num, pct } from "@/lib/format";
import { api } from "@/services/api";
import type { Backtest, Fill, Params, Strategy, StrategyVersion } from "@/types/api";
import { t } from "@/lib/i18n";

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
  }, [strategy]);
  const dirty =
    name !== strategy.name ||
    description !== strategy.description ||
    JSON.stringify(params) !== JSON.stringify(strategy.parameters);
  const save = useMutation({
    mutationFn: () =>
      api.patch<Strategy>(`/api/strategies/${strategy.id}`, { name, description, parameters: params, note }),
    onSuccess: (s) => {
      qc.setQueryData(["strategy", strategy.id], s);
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      void qc.invalidateQueries({ queryKey: ["strategy", strategy.id, "versions"] });
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
          <ParamsEditor id="p" value={params} onChange={(p, err) => { if (p) setParams(p); setParamsError(err); }} />
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
                  Fills recorded by this strategy's own runs. Account equity is shared by all strategies on the
                  account, so per-strategy P&amp;L is not derived from it.
                </p>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              {data.fills.length === 0 ? (
                <EmptyState title={t("No fills recorded")} />
              ) : (
                <Table>
                  <thead><tr><Th>{t("Time")}</Th><Th>{t("Symbol")}</Th><Th>{t("Side")}</Th><Th className="text-right">{t("Qty")}</Th><Th className="text-right">{t("Price")}</Th></tr></thead>
                  <tbody>
                    {data.fills.map((f, i) => (
                      <tr key={i}>
                        <Td className="num text-xs">{dateTime(f.time)}</Td>
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

function VersionsTab({ strategyId }: { strategyId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const versions = useQuery({
    queryKey: ["strategy", strategyId, "versions"],
    queryFn: () => api.get<StrategyVersion[]>(`/api/strategies/${strategyId}/versions`),
  });
  const restore = useMutation({
    mutationFn: (v: number) => api.post<Strategy>(`/api/strategies/${strategyId}/versions/${v}/restore`),
    onSuccess: (s) => {
      qc.setQueryData(["strategy", strategyId], s);
      void qc.invalidateQueries({ queryKey: ["strategy", strategyId, "versions"] });
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
                  <Td className="text-xs">{v.note}</Td>
                  <Td className="font-mono text-xs" title={v.code_sha256}>{v.code_sha256.slice(0, 10)}</Td>
                  <Td className="max-w-xs truncate font-mono text-xs" title={JSON.stringify(v.parameters)}>{JSON.stringify(v.parameters)}</Td>
                  <Td className="text-right">
                    {i > 0 && (
                      <Button size="sm" variant="ghost" loading={restore.isPending && restore.variables === v.version} onClick={() => restore.mutate(v.version)}>
                        <History /> {t("Restore")} </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryBoundary>
    </Card>
  );
}

function CodeTab({ strategyId }: { strategyId: number }) {
  const source = useQuery({
    queryKey: ["strategy", strategyId, "source"],
    queryFn: () => api.get<{ code: string; sha256: string; source_path: string }>(`/api/strategies/${strategyId}/source`),
  });
  return (
    <Card>
      <QueryBoundary query={source}>
        {(s) => (
          <div>
            <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
              <span className="font-mono">{s.source_path}</span>
              <span className="font-mono">sha256 {s.sha256.slice(0, 12)}</span>
            </div>
            <pre className="max-h-[60vh] overflow-auto p-4 font-mono text-xs leading-relaxed">{s.code}</pre>
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Read-only. Edit the file in your strategy folder; the next version you save records the new hash.
            </p>
          </div>
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
  const summary = useAccountSummary();
  const [archiving, setArchiving] = React.useState(false);
  const strategy = useQuery({
    queryKey: ["strategy", sid],
    queryFn: () => api.get<Strategy>(`/api/strategies/${sid}`),
  });
  const list = useQuery({
    queryKey: ["strategies"],
    queryFn: () => api.get<Strategy[]>("/api/strategies"),
    refetchInterval: 5_000,
  });
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
                <Button asChild variant="outline" size="sm"><Link to={`/backtesting?strategy=${s.id}`}><FlaskConical /> {t("Backtest")}</Link></Button>
                <Button asChild variant="outline" size="sm"><Link to={`/logs?strategy=${s.id}`}><ScrollText /> {t("Logs")}</Link></Button>
                <TradingControls strategyId={s.id} task={trading} brokerConnected={!!summary.data?.connected} />
                <Button variant="ghost" size="sm" onClick={() => setArchiving(true)}><Archive /> {t("Archive")}</Button>
              </>
            }
          />
          {trading?.error_message && trading.status === "failed" && (
            <Alert tone="loss" className="mb-4">{t("Last trading run failed: {error}", { error: trading.error_message })}</Alert>
          )}
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t("Configuration")}</TabsTrigger>
              <TabsTrigger value="performance">{t("Performance")}</TabsTrigger>
              <TabsTrigger value="versions">{t("Versions")}</TabsTrigger>
              <TabsTrigger value="code">{t("Code")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><OverviewTab strategy={s} /></TabsContent>
            <TabsContent value="performance"><PerformanceTab strategyId={s.id} /></TabsContent>
            <TabsContent value="versions"><VersionsTab strategyId={s.id} /></TabsContent>
            <TabsContent value="code"><CodeTab strategyId={s.id} /></TabsContent>
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
