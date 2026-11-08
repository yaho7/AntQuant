import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Delta, EmptyState, PageHeader, QueryBoundary, StatusBadge } from "@/components/common";
import { ParamsEditor } from "@/components/ParamsEditor";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Table, Td, Th } from "@/components/ui/primitives";
import { useBacktests, useStrategies } from "@/hooks/queries";
import { between, dateTime, duration, num, pct } from "@/lib/format";
import { api } from "@/services/api";
import type { Backtest, BacktestDefaults, DataSource, Params } from "@/types/api";
import { t } from "@/lib/i18n";

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" role="progressbar"
      aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-primary transition-all" style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}

function NewBacktestForm() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const strategies = useStrategies();
  const options = useQuery({
    queryKey: ["backtests", "options"],
    queryFn: () => api.get<{ data_sources: DataSource[]; defaults: BacktestDefaults }>("/api/backtests/options"),
  });
  const [strategyId, setStrategyId] = React.useState<string>(search.get("strategy") ?? "");
  const [source, setSource] = React.useState("yahoo");
  const [start, setStart] = React.useState(isoDaysAgo(365 * 2));
  const [end, setEnd] = React.useState(isoDaysAgo(1));
  const [budget, setBudget] = React.useState("100000");
  const [benchmark, setBenchmark] = React.useState("SPY");
  const [params, setParams] = React.useState<Params>({});
  const [paramsError, setParamsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const d = options.data?.defaults;
    if (d) {
      setSource(d.data_source);
      setBudget(String(d.budget));
      setBenchmark(d.benchmark);
    }
  }, [options.data]);
  const strategy = strategies.data?.find((s) => String(s.id) === strategyId);
  React.useEffect(() => {
    if (strategy) setParams(strategy.parameters);
  }, [strategy]);

  const run = useMutation({
    mutationFn: () =>
      api.post<Backtest>("/api/backtests", {
        strategy_id: Number(strategyId),
        data_source: source,
        start,
        end,
        budget: Number(budget),
        benchmark: benchmark.trim() || null,
        parameters: params,
      }),
    onSuccess: (task) => {
      void qc.invalidateQueries({ queryKey: ["backtests"] });
      navigate(`/backtesting/${task.id}`);
    },
    onError: toast.error,
  });

  const ds = options.data?.data_sources.find((d) => d.id === source);
  const invalid = !strategyId || !start || !end || end <= start || !(Number(budget) > 0) || !!paramsError;

  return (
    <Card>
      <CardHeader><CardTitle>{t("New backtest")}</CardTitle></CardHeader>
      <CardContent>
        {strategies.data?.length === 0 ? (
          <EmptyState title={t("No strategies")} description={t("Add a strategy first.")}
            action={<Button asChild><Link to="/strategies">{t("Go to Strategies")}</Link></Button>} />
        ) : (
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!invalid) run.mutate(); }}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("1. Strategy")} htmlFor="bs">
                <Select id="bs" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
                  <option value="">{t("Choose…")}</option>
                  {(strategies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} (v{s.version})</option>)}
                </Select>
              </Field>
              <Field label={t("2. Data source")} htmlFor="bd" hint={ds?.note}>
                <Select id="bd" value={source} onChange={(e) => setSource(e.target.value)}>
                  {(options.data?.data_sources ?? []).map((d) => (
                    <option key={d.id} value={d.id} disabled={!d.available}>
                      {d.label}{!d.available ? " (needs Alpaca keys)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("Benchmark")} htmlFor="bb" hint={t("Leave empty for none.")}>
                <Input id="bb" value={benchmark} maxLength={16} onChange={(e) => setBenchmark(e.target.value.toUpperCase())} />
              </Field>
              <Field label={t("3. Start date")} htmlFor="b1">
                <Input id="b1" type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label={t("End date")} htmlFor="b2">
                <Input id="b2" type="date" value={end} min={start} max={isoDaysAgo(0)} onChange={(e) => setEnd(e.target.value)} />
              </Field>
              <Field label={t("4. Initial capital (USD)")} htmlFor="b3">
                <Input id="b3" type="number" min={1} step="any" className="num" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </Field>
            </div>
            {strategy && (
              <Field label={t("5. Parameters for this run")} htmlFor="bp">
                <ParamsEditor id="bp" value={params} onChange={(p, err) => { if (p) setParams(p); setParamsError(err); }} />
              </Field>
            )}
            {end <= start && <Alert tone="loss">{t("End date must be after the start date.")}</Alert>}
            <div className="flex justify-end">
              <Button type="submit" disabled={invalid} loading={run.isPending}><Play /> {t("6. Start backtest")}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function BacktestingPage() {
  const backtests = useBacktests();
  return (
    <>
      <PageHeader title={t("Backtesting")} description={t("Runs in a separate process. You can close this page while it runs.")} />
      <div className="grid gap-4">
        <NewBacktestForm />
        <Card>
          <CardHeader><CardTitle>{t("History")}</CardTitle></CardHeader>
          <CardContent className="px-0">
            <QueryBoundary query={backtests}>
              {(list) =>
                list.length === 0 ? (
                  <EmptyState title={t("No backtests yet")} />
                ) : (
                  <Table>
                    <thead>
                      <tr><Th>{t("Strategy")}</Th><Th>{t("Period")}</Th><Th>{t("Status")}</Th><Th>{t("Duration")}</Th><Th className="text-right">{t("Return")}</Th><Th className="text-right">{t("Max DD")}</Th><Th className="text-right">{t("Sharpe")}</Th><Th className="text-right">{t("Trades")}</Th></tr>
                    </thead>
                    <tbody>
                      {list.map((b) => (
                        <tr key={b.id} className="hover:bg-accent/40">
                          <Td>
                            <Link to={`/backtesting/${b.id}`} className="font-medium hover:underline">{b.strategy_name}</Link>
                            <p className="num text-xs text-muted-foreground">{dateTime(b.created_at)}</p>
                          </Td>
                          <Td className="num text-xs">{String(b.config.start)} → {String(b.config.end)}</Td>
                          <Td>
                            <div className="flex items-center gap-2">
                              <StatusBadge status={b.status} />
                              {b.status === "running" && <Progress value={b.progress} />}
                            </div>
                          </Td>
                          <Td className="num text-xs">{b.started_at ? duration(between(b.started_at, b.ended_at)) : "—"}</Td>
                          <Td className="text-right"><Delta value={b.metrics?.total_return}>{pct(b.metrics?.total_return, 2, true)}</Delta></Td>
                          <Td className="num text-right">{pct(b.metrics?.max_drawdown)}</Td>
                          <Td className="num text-right">{num(b.metrics?.sharpe_ratio)}</Td>
                          <Td className="num text-right">{num(b.metrics?.number_of_trades, 0)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )
              }
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
