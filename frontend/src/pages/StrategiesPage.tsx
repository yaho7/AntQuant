import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, Plus, ShieldAlert, Upload } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { EmptyState, PageHeader, QueryBoundary, StatusBadge } from "@/components/common";
import { ParamsEditor } from "@/components/ParamsEditor";
import { TradingControls } from "@/components/TradingControls";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Badge, Card, Field, Input, Select, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccountSummary, useStrategies } from "@/hooks/queries";
import { dateTime } from "@/lib/format";
import { api } from "@/services/api";
import type { DiscoveredStrategy, Params, Strategy } from "@/types/api";

function AddStrategyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const discovered = useQuery({
    queryKey: ["strategies", "discover"],
    queryFn: () => api.get<DiscoveredStrategy[]>("/api/strategies/discover"),
    enabled: open,
  });
  const [picked, setPicked] = React.useState<string>("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [params, setParams] = React.useState<Params>({});
  const [paramsError, setParamsError] = React.useState<string | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [ack, setAck] = React.useState(false);

  const item = discovered.data?.find((d) => `${d.source_path}::${d.class_name}` === picked);
  React.useEffect(() => {
    if (item) {
      setParams(item.parameters);
      setName((n) => n || item.class_name);
      setDescription((d) => d || item.docstring);
    }
  }, [item]);
  React.useEffect(() => {
    if (!open) {
      setPicked("");
      setName("");
      setDescription("");
      setParams({});
      setFile(null);
      setAck(false);
    }
  }, [open]);

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("file", file!);
      form.append("acknowledge_risk", String(ack));
      return api.upload<DiscoveredStrategy[]>("/api/strategies/upload", form);
    },
    onSuccess: async (found) => {
      await qc.invalidateQueries({ queryKey: ["strategies", "discover"] });
      setPicked(`${found[0]!.source_path}::${found[0]!.class_name}`);
      setFile(null);
      toast.success(`Uploaded: found ${found.map((f) => f.class_name).join(", ")}`);
    },
    onError: toast.error,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Strategy>("/api/strategies", {
        name: name.trim(),
        description,
        source_path: item!.source_path,
        class_name: item!.class_name,
        parameters: params,
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["strategies"] });
      onOpenChange(false);
      navigate(`/strategies/${s.id}`);
    },
    onError: toast.error,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add strategy" description="Register a LumiBot Strategy class so you can backtest and run it." className="max-w-2xl">
        <Tabs defaultValue="existing">
          <TabsList>
            <TabsTrigger value="existing"><FileCode2 className="mr-1 size-3.5" /> From strategy folder</TabsTrigger>
            <TabsTrigger value="upload"><Upload className="mr-1 size-3.5" /> Upload .py file</TabsTrigger>
          </TabsList>
          <TabsContent value="existing">
            <p className="text-xs text-muted-foreground">
              Classes found in <code>strategies/examples</code> and in your data folder
              <code> data/strategies</code>. Files are parsed, not executed, while listing.
            </p>
          </TabsContent>
          <TabsContent value="upload" className="grid gap-3">
            <Alert tone="warning">
              <ShieldAlert />
              <div className="grid gap-1">
                <b>Only upload code you trust.</b>
                <span>
                  Strategy code runs as a separate process with the same permissions as the server:
                  it can read files in the data folder (including the encrypted key store) and use
                  your broker keys. There is no sandbox.
                </span>
              </div>
            </Alert>
            <Input type="file" accept=".py,text/x-python" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I wrote or reviewed this code and accept that it runs with server permissions.
            </label>
            <Button variant="outline" disabled={!file || !ack} loading={upload.isPending} onClick={() => upload.mutate()}>
              <Upload /> Upload and scan
            </Button>
          </TabsContent>
        </Tabs>

        <Field label="Strategy class" htmlFor="pick">
          <Select id="pick" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">{discovered.isLoading ? "Loading…" : "Choose a class"}</option>
            {(discovered.data ?? []).map((d) => (
              <option key={`${d.source_path}::${d.class_name}`} value={`${d.source_path}::${d.class_name}`}>
                {d.class_name} — {d.source_path}
              </option>
            ))}
          </Select>
        </Field>
        {item && (
          <>
            {!item.parameters_parsed && (
              <Alert tone="warning">Default parameters could not be read from the file; enter them below.</Alert>
            )}
            <Field label="Name" htmlFor="sn">
              <Input id="sn" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
            </Field>
            <Field label="Description" htmlFor="sd">
              <Textarea id="sd" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Parameters" htmlFor="sparams">
              <ParamsEditor id="sparams" value={params} onChange={(p, err) => { if (p) setParams(p); setParamsError(err); }} />
            </Field>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!item || !name.trim() || !!paramsError} loading={create.isPending} onClick={() => create.mutate()}>
            <Plus /> Add strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StrategiesPage() {
  const strategies = useStrategies();
  const summary = useAccountSummary();
  const [adding, setAdding] = React.useState(false);
  const connected = !!summary.data?.connected;
  return (
    <>
      <PageHeader
        title="Strategies"
        description="Registered LumiBot strategies. Each run executes in its own process."
        actions={<Button onClick={() => setAdding(true)}><Plus /> Add strategy</Button>}
      />
      <Card>
        <QueryBoundary query={strategies} rows={4}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState
                title="No strategies yet"
                description="Add one of the bundled examples or upload your own LumiBot strategy file."
                action={<Button onClick={() => setAdding(true)}><Plus /> Add strategy</Button>}
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Class</Th>
                    <Th>Version</Th>
                    <Th>Paper trading</Th>
                    <Th>Updated</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id} className="hover:bg-accent/40">
                      <Td>
                        <Link to={`/strategies/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                        <p className="max-w-xs truncate text-xs text-muted-foreground">{s.source_path}</p>
                      </Td>
                      <Td className="font-mono text-xs">{s.class_name}</Td>
                      <Td><Badge>v{s.version}</Badge></Td>
                      <Td>
                        {s.trading_task ? (
                          <StatusBadge status={s.trading_task.status} paused={s.trading_task.paused} />
                        ) : (
                          <span className="text-xs text-muted-foreground">Never run</span>
                        )}
                      </Td>
                      <Td className="num text-xs text-muted-foreground">{dateTime(s.updated_at)}</Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button asChild size="sm" variant="ghost">
                            <Link to={`/backtesting?strategy=${s.id}`}>Backtest</Link>
                          </Button>
                          <TradingControls strategyId={s.id} task={s.trading_task} brokerConnected={connected} />
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      </Card>
      <AddStrategyDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
