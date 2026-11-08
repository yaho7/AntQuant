import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play, Search } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, PageHeader, QueryBoundary } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, Field, Input, Select } from "@/components/ui/primitives";
import { useStrategies } from "@/hooks/queries";
import { api, qs } from "@/services/api";
import { cn } from "@/lib/utils";
import type { LogEntry, LogSource } from "@/types/api";

const LEVEL_STYLE: Record<string, string> = {
  DEBUG: "text-muted-foreground",
  INFO: "text-primary",
  WARNING: "text-warning",
  ERROR: "text-loss",
  CRITICAL: "text-loss font-bold",
};

export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const strategies = useStrategies();
  const strategyId = params.get("strategy") ?? "";
  const [source, setSource] = React.useState(params.get("source") ?? "system");
  const [level, setLevel] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [auto, setAuto] = React.useState(true);
  const bottom = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const sources = useQuery({
    queryKey: ["logs", "sources", strategyId],
    queryFn: () => api.get<LogSource[]>(`/api/logs/sources${qs({ strategy_id: strategyId || null })}`),
    refetchInterval: 10_000,
  });
  React.useEffect(() => {
    const list = sources.data;
    if (list && list.length && !list.some((s) => s.id === source)) setSource(list[0]!.id);
  }, [sources.data, source]);

  const logs = useQuery({
    queryKey: ["logs", source, level, query],
    queryFn: () =>
      api.get<{ entries: LogEntry[] }>(`/api/logs${qs({ source, level: level || null, q: query || null, limit: 1000 })}`),
    refetchInterval: auto ? 3_000 : false,
  });
  React.useEffect(() => {
    if (auto) bottom.current?.scrollIntoView({ block: "end" });
  }, [logs.data, auto]);

  const groups: Record<string, string> = { system: "System", backtest: "Backtests", trading: "Paper trading" };

  return (
    <>
      <PageHeader
        title="Logs"
        description="System, API, audit, backtest and strategy logs. Secrets are masked."
        actions={
          <>
            <Button variant="outline" onClick={() => setAuto((a) => !a)} aria-pressed={auto}>
              {auto ? <Pause /> : <Play />} {auto ? "Auto-refresh on" : "Auto-refresh off"}
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/logs/download${qs({ source })}`}><Download /> Download</a>
            </Button>
          </>
        }
      />
      <Card className="mb-3 grid gap-3 p-3 md:grid-cols-4">
        <Field label="Strategy" htmlFor="ls">
          <Select id="ls" value={strategyId} onChange={(e) => {
            const v = e.target.value;
            setParams(v ? { strategy: v } : {});
          }}>
            <option value="">All (system logs)</option>
            {(strategies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Source" htmlFor="lsrc">
          <Select id="lsrc" value={source} onChange={(e) => setSource(e.target.value)}>
            {Object.entries(groups).map(([g, label]) => {
              const items = (sources.data ?? []).filter((s) => s.group === g);
              return items.length ? (
                <optgroup key={g} label={label}>
                  {items.map((s) => <option key={s.id} value={s.id}>{s.label}{s.status ? ` (${s.status})` : ""}</option>)}
                </optgroup>
              ) : null;
            })}
          </Select>
        </Field>
        <Field label="Minimum level" htmlFor="ll">
          <Select id="ll" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">All</option>
            {["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].map((l) => <option key={l}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Search" htmlFor="lq">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input id="lq" className="pl-8" value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} placeholder="Filter text" />
          </div>
        </Field>
      </Card>
      <Card className="overflow-hidden">
        <QueryBoundary query={logs} rows={10}>
          {(data) =>
            data.entries.length === 0 ? (
              <EmptyState title="No log lines match" />
            ) : (
              <div className="max-h-[65vh] overflow-auto bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                {data.entries.map((e, i) => (
                  <div key={i} className="grid grid-cols-[auto_auto_1fr] gap-x-3 border-b border-border/40 py-0.5 last:border-0">
                    <span className="num whitespace-nowrap text-muted-foreground">{e.time ?? ""}</span>
                    <span className={cn("w-16", LEVEL_STYLE[e.level])}>{e.level}</span>
                    <span className="whitespace-pre-wrap break-words">
                      {e.logger && <span className="text-muted-foreground">{e.logger} · </span>}
                      {e.message}
                    </span>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
            )
          }
        </QueryBoundary>
      </Card>
    </>
  );
}
