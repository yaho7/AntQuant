import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, Plus, ScanLine, ShieldAlert, Upload } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, PageHeader, QueryBoundary, StatusBadge } from "@/components/common";
import { ParamsEditor } from "@/components/ParamsEditor";
import { scanStrategyCode, StrategyCodeEditor, StrategyCodeGuide, strategyTemplate } from "@/components/StrategyCode";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Badge, Card, Field, Input, Select, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStrategies, useTradingTasks } from "@/hooks/queries";
import { dateTime } from "@/lib/format";
import { api, qs } from "@/services/api";
import type { DiscoveredStrategy, Params, Strategy } from "@/types/api";
import { t } from "@/lib/i18n";

type StrategyInput = "upload" | "template" | "existing";

function AddStrategyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [input, setInput] = React.useState<StrategyInput>("upload");
  const [code, setCode] = React.useState(strategyTemplate);
  const [filename, setFilename] = React.useState("");
  const [found, setFound] = React.useState<DiscoveredStrategy[]>([]);
  const [item, setItem] = React.useState<DiscoveredStrategy | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [params, setParams] = React.useState<Params>({});
  const [paramsError, setParamsError] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const discovered = useQuery({
    queryKey: ["strategies", "discover"],
    queryFn: () => api.get<DiscoveredStrategy[]>("/api/strategies/discover"),
    enabled: open && input === "existing",
  });

  function pick(next: DiscoveredStrategy | null) {
    setItem(next);
    setName(next?.class_name ?? "");
    setDescription(next?.docstring ?? "");
    setParams(next?.parameters ?? {});
    setParamsError(null);
    setAck(false);
  }

  const scan = useMutation({
    mutationFn: async (source: File | string) => {
      const fromFile = typeof source !== "string";
      const file = fromFile ? source.name : "strategy.py";
      if (fromFile && !file.endsWith(".py")) throw new Error(t("Only .py files are accepted."));
      if (fromFile && source.size > 512 * 1024) throw new Error(t("File is larger than 512 KB."));
      let content = source;
      if (fromFile) {
        const bytes = await source.arrayBuffer();
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new Error(t("File must be UTF-8 text."));
        }
      }
      if (typeof content !== "string") throw new Error(t("File must be UTF-8 text."));
      const classes = await scanStrategyCode(content, file);
      return { classes, content };
    },
    onSuccess: ({ classes, content }) => {
      setCode(content);
      setFound(classes);
      pick(classes.length === 1 ? classes[0]! : null);
    },
  });

  const create = useMutation({
    mutationFn: () => {
      const fields = { name: name.trim(), description, class_name: item!.class_name, parameters: params };
      return input === "existing"
        ? api.post<Strategy>("/api/strategies", { ...fields, source_path: item!.source_path })
        : api.post<Strategy>("/api/strategies/import", {
          ...fields, code, filename: input === "upload" ? filename : `${item!.class_name}.py`, acknowledge_risk: ack,
        });
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      onOpenChange(false);
      navigate(`/strategies/${s.id}`);
    },
    onError: toast.error,
  });

  function changeInput(next: StrategyInput) {
    setInput(next);
    setFilename("");
    setCode(strategyTemplate);
    setFound([]);
    pick(null);
    scan.reset();
  }

  function startScan(source: File | string) {
    setFound([]);
    pick(null);
    scan.mutate(source);
  }

  const options = input === "existing" ? discovered.data ?? [] : found;
  const selected = item ? `${item.source_path}::${item.class_name}` : "";
  const busy = scan.isPending || create.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent title={t("Add strategy")} description={t("Import a Python strategy or start with a template.")} className="max-w-2xl">
        <Tabs value={input} onValueChange={(value) => changeInput(value as StrategyInput)}>
          <TabsList className="h-auto min-h-9 flex-wrap">
            <TabsTrigger value="upload" disabled={busy}><Upload className="mr-1 size-3.5" /> {t("Upload .py file")}</TabsTrigger>
            <TabsTrigger value="template" disabled={busy}><Plus className="mr-1 size-3.5" /> {t("Use template")}</TabsTrigger>
            <TabsTrigger value="existing" disabled={busy}><FileCode2 className="mr-1 size-3.5" /> {t("From strategy folder")}</TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="grid gap-3">
            <input ref={fileInput} type="file" accept=".py,text/x-python" hidden onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) {
                setFilename(file.name);
                startScan(file);
              }
            }} />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" loading={scan.isPending} disabled={create.isPending} onClick={() => fileInput.current?.click()}>
                <Upload /> {t("Upload and scan")}
              </Button>
              {filename && <span className="max-w-full truncate font-mono text-xs text-muted-foreground">{filename}</span>}
            </div>
          </TabsContent>
          <TabsContent value="template" className="grid gap-3">
            <StrategyCodeEditor code={code} label={t("Python strategy code")} onChange={busy ? undefined : (value) => {
              setCode(value);
              if (found.length) { setFound([]); pick(null); }
              if (scan.isError) scan.reset();
            }} />
            <Button variant="outline" className="justify-self-start" loading={scan.isPending}
              disabled={create.isPending || !code.trim()} onClick={() => startScan(code)}><ScanLine /> {t("Scan code")}</Button>
          </TabsContent>
          <TabsContent value="existing">
            <p className="text-xs text-muted-foreground">{t("Classes found in strategies/examples and in data/strategies. Files are parsed, not executed, while listing.")}</p>
            {discovered.isError && <Alert tone="warning">{discovered.error.message}</Alert>}
          </TabsContent>
        </Tabs>
        {scan.isError && <Alert tone="warning" role="alert">{scan.error.message}</Alert>}
        <StrategyCodeGuide />

        {(input === "existing" || options.length > 0) && (
          <Field label={t("Strategy class")} htmlFor={input !== "existing" && options.length === 1 ? undefined : "pick"}>
            {input !== "existing" && options.length === 1 ? (
              <p className="rounded-lg border bg-card px-3 py-2 font-mono text-xs">{item?.class_name}</p>
            ) : (
              <Select id="pick" value={selected} disabled={busy} onChange={(event) => {
                pick(options.find((d) => `${d.source_path}::${d.class_name}` === event.target.value) ?? null);
              }}>
                <option value="">{input === "existing" && discovered.isLoading ? t("Loading…") : t("Choose a class")}</option>
                {options.map((d) => (
                  <option key={`${d.source_path}::${d.class_name}`} value={`${d.source_path}::${d.class_name}`}>
                    {d.class_name}{input === "existing" ? ` — ${d.source_path}` : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {item && (
          <fieldset disabled={create.isPending} className="grid min-w-0 gap-4">
            {!item.parameters_parsed && (
              <Alert tone="warning">{t("Default parameters could not be read from the file; enter them below.")}</Alert>
            )}
            <Field label={t("Name")} htmlFor="sn">
              <Input id="sn" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
            </Field>
            <Field label={t("Description")} htmlFor="sd">
              <Textarea id="sd" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label={t("Parameters")} htmlFor="sparams">
              <ParamsEditor key={selected} id="sparams" value={params}
                onChange={(p, err) => { if (p) setParams(p); setParamsError(err); }} />
            </Field>
            {input !== "existing" && (
              <Alert tone="warning">
                <ShieldAlert />
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  {t("I wrote or reviewed this code and accept that it runs with server permissions.")}
                </label>
              </Alert>
            )}
          </fieldset>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button disabled={!item || !name.trim() || !!paramsError || scan.isPending || (input !== "existing" && !ack)}
            loading={create.isPending} onClick={() => create.mutate()}>
            <Plus /> {t("Add strategy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StrategiesPage() {
  const strategies = useStrategies();
  const [search] = useSearchParams();
  const running = useTradingTasks(undefined, true);
  const [adding, setAdding] = React.useState(false);
  return (
    <>
      <PageHeader
        title={t("Strategies")}
        description={t("Registered LumiBot strategies. Each run executes in its own process.")}
        actions={<Button onClick={() => setAdding(true)}><Plus /> {t("Add strategy")}</Button>}
      />
      <Card>
        <QueryBoundary query={strategies} rows={4}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState
                title={t("No strategies yet")}
                description={t("Add one of the bundled examples or upload your own LumiBot strategy file.")}
                action={<Button onClick={() => setAdding(true)}><Plus /> {t("Add strategy")}</Button>}
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("Name")}</Th>
                    <Th>{t("Class")}</Th>
                    <Th>{t("Version")}</Th>
                    <Th>{t("Trading")}</Th>
                    <Th>{t("Updated")}</Th>
                    <Th className="text-right">{t("Actions")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const active = (running.data ?? []).filter((task) => task.strategy_id === s.id);
                    const profileIds = active.map((task) => task.config.broker_key).filter((id): id is string => typeof id === "string");
                    return (
                    <tr key={s.id} className="hover:bg-accent/40">
                      <Td>
                        <Link to={`/strategies/${s.id}${qs({ profile: search.get("profile") })}`} className="font-medium hover:underline">{s.name}</Link>
                        <p className="max-w-xs truncate text-xs text-muted-foreground">{s.source_path}</p>
                      </Td>
                      <Td className="font-mono text-xs">{s.class_name}</Td>
                      <Td><Badge>v{s.version}</Badge></Td>
                      <Td>
                        {active.length ? (
                          <Badge tone="gain">{t("{n} active runs", { n: active.length })}</Badge>
                        ) : s.trading_task ? (
                          <StatusBadge status={s.trading_task.status} paused={s.trading_task.paused} />
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("Never run")}</span>
                        )}
                      </Td>
                      <Td className="num text-xs text-muted-foreground">{dateTime(s.updated_at)}</Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button asChild size="sm" variant="ghost">
                            <Link to={`/backtesting${qs({ strategy: s.id, profile: search.get("profile") })}`}>{t("Backtest")}</Link>
                          </Button>
                          <TradingControls strategyId={s.id} task={null} runningProfiles={profileIds} />
                        </div>
                      </Td>
                    </tr>
                    );
                  })}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      </Card>
      {adding && <AddStrategyDialog open onOpenChange={setAdding} />}
    </>
  );
}
