import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FolderOpen, Pencil, Plus, Upload } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AiHelpButton } from "@/components/AiHelp";
import { ConfirmDialog, EmptyState, PageHeader, QueryBoundary, StatusBadge } from "@/components/common";
import { ParamsEditor } from "@/components/ParamsEditor";
import type { LineFocus } from "@/components/PythonEditor";
import { StrategyCodeEditor, strategyTemplate } from "@/components/StrategyCode";
import { CodeChecks, FixDialog, Step, TrialPanel, TrustCheck, useStrategyDraft } from "@/components/StrategyChecks";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Badge, Card, Field, Input, Select, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { useStrategies, useTradingTasks } from "@/hooks/queries";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api, qs } from "@/services/api";
import type { CodeFix, DiscoveredStrategy, Strategy } from "@/types/api";
import { t } from "@/lib/i18n";

/** Pasted, uploaded or example code is saved as an editable copy; a folder file is added in place. */
type Source = { kind: "code"; filename: string } | { kind: "folder"; item: DiscoveredStrategy };

const MAX_FILE_BYTES = 512 * 1024;
const discoveredKey = (item: DiscoveredStrategy) => `${item.source_path}::${item.class_name}`;
const baseName = (path: string) => path.split("/").pop() || "strategy.py";
const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

async function readPythonFile(file: File): Promise<string> {
  if (!file.name.endsWith(".py")) throw new Error(t("Only .py files are accepted."));
  if (file.size > MAX_FILE_BYTES) throw new Error(t("File is larger than 512 KB."));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error(t("File must be UTF-8 text."));
  }
}

function AddStrategyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [source, setSource] = React.useState<Source>({ kind: "code", filename: "" });
  const [code, setCode] = React.useState("");
  const [loaded, setLoaded] = React.useState("");
  const [replacing, setReplacing] = React.useState<{ apply: () => void } | null>(null);
  const [browsing, setBrowsing] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [focus, setFocus] = React.useState<LineFocus | null>(null);
  const [fix, setFix] = React.useState<CodeFix | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [named, setNamed] = React.useState(false);
  const folder = source.kind === "folder";
  const filename = folder ? baseName(source.item.file) : source.filename || "strategy.py";
  const draft = useStrategyDraft(code, filename);
  const discovered = useQuery({
    queryKey: ["strategies", "discover"],
    queryFn: () => api.get<DiscoveredStrategy[]>("/api/strategies/discover"),
    enabled: open,
  });
  const examples = (discovered.data ?? []).filter((item) => item.root === "examples");

  const className = draft.item?.class_name;
  const docstring = draft.item?.docstring;
  React.useEffect(() => {
    if (named || !className) return;
    setName(className);
    setDescription(docstring ?? "");
  }, [className, docstring, named]);

  /** Put new code in the editor, asking first when that would drop typed edits. */
  function load(text: string, next: Source, className?: string) {
    const apply = () => {
      setCode(text);
      setLoaded(text);
      setSource(next);
      setLoadError(null);
      setNamed(false);
      if (className) draft.pick(className);
      draft.setAck(false);
      draft.trial.reset();
      if (next.kind === "code") setBrowsing(false);
    };
    if (code.trim() && code !== loaded) setReplacing({ apply });
    else apply();
  }

  async function loadFile(file: File) {
    try {
      load(await readPythonFile(file), { kind: "code", filename: file.name });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  const loadDiscovered = useMutation({
    mutationFn: async ({ item, copy }: { item: DiscoveredStrategy; copy: boolean }) => {
      const body = await api.get<{ code: string }>(`/api/strategies/discover/source${qs({ source_path: item.source_path })}`);
      return { item, copy, text: body.code };
    },
    onSuccess: ({ item, copy, text }) => {
      const next: Source = copy ? { kind: "code", filename: baseName(item.file) } : { kind: "folder", item };
      load(text, next, item.class_name);
    },
    onError: (error) => setLoadError(error.message),
  });

  const create = useMutation({
    mutationFn: () => {
      const fields = { name: name.trim(), description, class_name: draft.picked, parameters: draft.params };
      return source.kind === "folder"
        ? api.post<Strategy>("/api/strategies", { ...fields, source_path: source.item.source_path })
        : api.post<Strategy>("/api/strategies/import", { ...fields, code, filename, acknowledge_risk: draft.ack });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      onOpenChange(false);
      toast.success(t("Strategy added. Pick the dates and start its first backtest."));
      navigate(`/backtesting${qs({ strategy: saved.id, profile: search.get("profile") })}`);
    },
    onError: toast.error,
  });

  const busy = create.isPending || draft.trial.isPending || loadDiscovered.isPending;
  const goTo = (line: number) => setFocus({ line, nonce: Date.now() });
  const outcome = draft.trial.data && !draft.trialStale ? draft.trial.data.result : undefined;
  const note = !draft.item ? "" : outcome?.ok ? t("Trial passed.")
    : outcome ? t("The trial failed. You can still add it and fix it later.") : t("Tip: try it before you add it.");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent title={t("Add strategy")} className="max-w-5xl"
        description={t("Paste a strategy written for LumiBot or by an AI tool, or drop a .py file. AntQuant checks it, fixes what it can and tries it on the last month of data before you add it.")}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]"
          onDragOverCapture={(event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDropCapture={(event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file && !busy) void loadFile(file);
          }}>
          <div className="grid min-w-0 content-start gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileInput} type="file" accept=".py,text/x-python" hidden onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void loadFile(file);
              }} />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Upload /> {t("Choose .py file")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => load(strategyTemplate, { kind: "code", filename: "strategy.py" })}>
                <FilePlus2 /> {t("Blank template")}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
                <FolderOpen /> {t("From strategy folder")}
              </Button>
              <span className="flex-1" />
              <AiHelpButton />
            </div>
            {examples.length > 0 && (
              <div className="-mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                <span>{t("Or start from an example:")}</span>
                {examples.map((item) => (
                  <Button key={discoveredKey(item)} size="sm" variant="link" className="h-7 px-1.5 text-xs underline"
                    title={item.docstring} disabled={busy} onClick={() => loadDiscovered.mutate({ item, copy: true })}>
                    {item.class_name}
                  </Button>
                ))}
              </div>
            )}
            {browsing && (
              <Field label={t("File in a strategy folder")} htmlFor="folder-pick"
                hint={t("Classes found in strategies/examples and in data/strategies. Files are parsed, not executed, while listing.")}>
                <Select id="folder-pick" disabled={busy} value={folder ? discoveredKey(source.item) : ""} onChange={(event) => {
                  const item = (discovered.data ?? []).find((entry) => discoveredKey(entry) === event.target.value);
                  if (item) loadDiscovered.mutate({ item, copy: false });
                }}>
                  <option value="">{discovered.isLoading ? t("Loading…") : t("Choose a class")}</option>
                  {(discovered.data ?? []).map((item) => (
                    <option key={discoveredKey(item)} value={discoveredKey(item)}>{item.class_name} — {item.source_path}</option>
                  ))}
                </Select>
              </Field>
            )}
            {loadError && <Alert tone="warning" role="alert">{loadError}</Alert>}
            {discovered.isError && browsing && <Alert tone="warning">{discovered.error.message}</Alert>}
            <div className={cn("relative rounded-lg", dragging && "ring-2 ring-ring")}>
              <StrategyCodeEditor code={code} label={t("Python strategy code")} focusLine={focus} minHeight="20rem"
                className={code ? undefined : "border-dashed"}
                placeholder={t("Paste your LumiBot strategy here, or drop a .py file.")}
                onChange={folder || busy ? undefined : setCode} />
              {dragging && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/85 text-sm font-medium">
                  {t("Drop the .py file to load it")}
                </div>
              )}
            </div>
            {folder ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t("Added from {path} as it is. Edit the file in that folder, or edit a copy here.", { path: source.item.source_path })}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSource({ kind: "code", filename })}>
                  <Pencil /> {t("Edit a copy")}
                </Button>
              </div>
            ) : source.filename ? (
              <p className="truncate font-mono text-xs text-muted-foreground">{source.filename}</p>
            ) : null}
          </div>

          <div className="grid content-start gap-5">
            <Step n={1} title={t("Check")} busy={draft.scan.pending && !!draft.scan.result}>
              <CodeChecks draft={draft} onLine={goTo} onFix={setFix} />
            </Step>
            {draft.item && (
              <>
                <Step n={2} title={t("Parameters")}>
                  <ParamsEditor key={draft.revision} id="draft-params" value={draft.params} onChange={draft.setParams} />
                </Step>
                <Step n={3} title={t("Trial run")}>
                  <TrustCheck draft={draft} disabled={busy} />
                  <TrialPanel draft={draft} onLine={goTo} disabled={busy} />
                </Step>
                <Step n={4} title={t("Name")}>
                  <fieldset disabled={create.isPending} className="grid min-w-0 gap-3">
                    <Input id="sn" aria-label={t("Name")} value={name} maxLength={128}
                      onChange={(event) => { setName(event.target.value); setNamed(true); }} />
                    <Field label={t("Description")} htmlFor="sd">
                      <Textarea id="sd" value={description} onChange={(event) => { setDescription(event.target.value); setNamed(true); }} />
                    </Field>
                  </fieldset>
                </Step>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          {note && <p className="text-xs text-muted-foreground sm:mr-auto sm:self-center">{note}</p>}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
          <Button loading={create.isPending} onClick={() => create.mutate()}
            disabled={!draft.ready || !name.trim() || draft.trial.isPending || (!folder && !draft.ack)}>
            <Plus /> {t("Add and backtest")}
          </Button>
        </DialogFooter>
        <FixDialog fix={fix} onOpenChange={(next) => { if (!next) setFix(null); }} onApply={(fixed) => {
          setCode(fixed);
          if (folder) setSource({ kind: "code", filename });
          setFix(null);
        }} />
        {replacing && (
          <ConfirmDialog open onOpenChange={(next) => { if (!next) setReplacing(null); }}
            title={t("Replace the code in the editor?")}
            description={t("Your edits in the editor will be lost.")}
            confirmLabel={t("Replace")} destructive
            onConfirm={() => { replacing.apply(); setReplacing(null); }} />
        )}
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
                description={t("Paste a LumiBot strategy, upload a .py file or start from an example.")}
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
