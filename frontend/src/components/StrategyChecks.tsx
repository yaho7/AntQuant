/**
 * The shared "check, fix, try" flow for strategy code: a debounced scan of the
 * editor text, the list of problems with fixes, and a trial run on one month
 * of daily Yahoo data. Used when adding a strategy and when editing its code.
 */
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FlaskConical, Info, Loader2, Plus, ShieldAlert, Wand2, XCircle } from "lucide-react";
import * as React from "react";
import { AiHelpButton, type AiFix } from "@/components/AiHelp";
import { mergeScannedParameters } from "@/components/StrategyCode";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field, Select } from "@/components/ui/primitives";
import { pct } from "@/lib/format";
import { t } from "@/lib/i18n";
import { diffRows, hintText, issueText, parameterSourcesText, withParameter } from "@/lib/strategyHelp";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { CodeFix, CodeIssue, CodeScan, Params, TrialResult } from "@/types/api";

const SCAN_DELAY_MS = 400;

export function useCodeScan(code: string, filename: string) {
  const [settled, setSettled] = React.useState(code);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(code), SCAN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code]);
  const query = useQuery({
    queryKey: ["strategy-scan", filename, settled],
    queryFn: () => api.post<CodeScan>("/api/strategies/scan", { code: settled, filename }),
    enabled: settled.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const empty = !code.trim();
  return {
    result: empty ? undefined : query.data,
    /** True when the result belongs to the text in the editor right now. */
    fresh: !empty && settled === code && !!query.data && !query.isPlaceholderData && !query.isFetching,
    pending: !empty && (settled !== code || query.isFetching),
    error: query.error,
  };
}

export type StrategyDraft = ReturnType<typeof useStrategyDraft>;

/** Editor text plus everything derived from it: the class, its parameters, trust and the trial. */
export function useStrategyDraft(code: string, filename: string, initial?: { className: string; parameters: Params }) {
  const scan = useCodeScan(code, filename);
  const [picked, setPicked] = React.useState(initial?.className ?? "");
  const [params, setParams] = React.useState<Params>(initial?.parameters ?? {});
  const [paramsError, setParamsError] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);
  const [ack, setAck] = React.useState(false);
  const defaults = React.useRef<string | null>(null);
  const classes = scan.result?.classes ?? [];
  const item = classes.find((entry) => entry.class_name === picked);

  React.useEffect(() => {
    const list = scan.result?.classes ?? [];
    const next = list.find((entry) => entry.class_name === picked) ?? (list.length === 1 ? list[0] : undefined);
    if (!next) return;
    if (next.class_name !== picked) setPicked(next.class_name);
    const key = `${next.class_name}\u0000${JSON.stringify(next.parameters)}`;
    if (defaults.current === key) return;
    defaults.current = key;
    setParams((current) => mergeScannedParameters(next, current));
    setParamsError(null);
    setRevision((value) => value + 1);
  }, [scan.result, picked]);

  const trialKey = JSON.stringify([code, picked, params]);
  const trial = useMutation({
    mutationFn: async (key: string) => ({
      key,
      result: await api.post<TrialResult>("/api/strategies/trial", {
        code, filename, class_name: picked, parameters: params, acknowledge_risk: ack,
      }),
    }),
  });

  return {
    code,
    scan,
    classes,
    item,
    picked,
    pick: setPicked,
    params,
    paramsError,
    revision,
    setParams: (next: Params | null, error: string | null) => {
      if (next) setParams(next);
      setParamsError(error);
    },
    addParameter: (name: string) => {
      setParams((current) => withParameter(current, name));
      setRevision((value) => value + 1);
    },
    ack,
    setAck,
    trial,
    trialStale: !!trial.data && trial.data.key !== trialKey,
    runTrial: () => trial.mutate(trialKey),
    /** A class is chosen from a scan of the current text and its parameters are valid. */
    ready: !!item && !paramsError && scan.fresh && !scan.result?.error,
  };
}

function Row({ tone, children, line, onLine, action }: {
  tone: "ok" | "error" | "warning" | "info";
  children: React.ReactNode;
  line?: number | null;
  onLine?: (line: number) => void;
  action?: React.ReactNode;
}) {
  const Icon = { ok: CheckCircle2, error: XCircle, warning: AlertTriangle, info: Info }[tone];
  const color = { ok: "text-gain", error: "text-loss", warning: "text-warning", info: "text-muted-foreground" }[tone];
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", color)} aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="break-words leading-snug">
          <span className="sr-only">{t({ ok: "Passed", error: "Problem", warning: "Warning", info: "Tip" }[tone])}: </span>
          {line && onLine ? (
            <button type="button" className="mr-1 font-medium underline-offset-2 hover:underline"
              onClick={() => onLine(line)}>{t("Line {line}", { line })}</button>
          ) : line ? <span className="mr-1 font-medium">{t("Line {line}", { line })}</span> : null}
          <span className={tone === "info" ? "text-muted-foreground" : undefined}>{children}</span>
        </p>
        {action && <div className="flex flex-wrap gap-1">{action}</div>}
      </div>
    </li>
  );
}

const toneOf = (issue: CodeIssue) => issue.severity;

/** Problems found in the code, each with its line and, where possible, a fix. */
export function CodeChecks({ draft, onLine, onFix }: {
  draft: StrategyDraft;
  onLine: (line: number) => void;
  onFix?: (fix: CodeFix) => void;
}) {
  const { scan, item, classes } = draft;
  const result = scan.result;
  if (!draft.code.trim()) {
    return <p className="text-xs text-muted-foreground">{t("Paste code to check it. Checks read the file without running it.")}</p>;
  }
  if (!result) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t("Checking…")}</p>;
  }
  const aiFix = (problem: string, line?: number | null): AiFix => ({ code: draft.code, problem, line });
  if (result.error) {
    const message = result.line
      ? t("Python syntax error on line {line}: {reason}", { line: result.line, reason: result.reason ?? "" })
      : t(result.error);
    return (
      <ul className="grid gap-2">
        <Row tone="error" action={<AiHelpButton fix={aiFix(message, result.line)} />}>
          {result.line ? (
            <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onLine(result.line!)}>{message}</button>
          ) : message}
        </Row>
      </ul>
    );
  }
  const missing = (item?.missing_parameters ?? []).filter((entry) => !Object.hasOwn(draft.params, entry.name));
  const problems = [
    ...missing.map((entry) => t("Line {line} reads parameter {name}, but no default is set.", entry)),
    ...result.issues.filter((issue) => issue.severity === "error").map(issueText),
  ];
  const unfixable = result.issues.some((issue) => issue.severity === "error" && !issue.fixable) || missing.length > 0;
  const blocking = result.issues.some((issue) => issue.severity !== "info") || missing.length > 0;
  return (
    <div className="grid gap-3">
      {classes.length > 1 && (
        <Field label={t("Strategy class")} htmlFor="draft-class">
          <Select id="draft-class" value={draft.picked} onChange={(event) => draft.pick(event.target.value)}>
            <option value="" disabled>{t("Choose a class")}</option>
            {classes.map((entry) => <option key={entry.class_name} value={entry.class_name}>{entry.class_name}</option>)}
          </Select>
        </Field>
      )}
      <ul className="grid gap-2">
        {item ? (
          <Row tone="ok">{t("Strategy class {name}", { name: item.class_name })}</Row>
        ) : classes.length > 1 ? (
          <Row tone="warning">{t("This file has several strategy classes. Choose one.")}</Row>
        ) : null}
        {item && (item.parameter_sources.length > 0
          ? <Row tone="ok">{parameterSourcesText(item)}</Row>
          : <Row tone="info">{t("No parameters to edit.")}</Row>)}
        {item && item.unread_parameters.length > 0 && (
          <Row tone="info">{t("Defaults for {names} are not plain values. They still apply, but cannot be edited here.", { names: item.unread_parameters.join(", ") })}</Row>
        )}
        {missing.map((entry) => (
          <Row key={entry.name} tone="error" line={entry.line} onLine={onLine}
            action={<Button type="button" size="sm" variant="outline" onClick={() => draft.addParameter(entry.name)}><Plus /> {t("Add {name}", { name: entry.name })}</Button>}>
            {t("Reads parameter {name}, but no default is set.", { name: entry.name })}
          </Row>
        ))}
        {result.issues.map((issue, index) => (
          <Row key={`${issue.code}-${issue.line}-${index}`} tone={toneOf(issue)} line={issue.line} onLine={onLine}>
            {issueText(issue)}
          </Row>
        ))}
        {item && !blocking && <Row tone="ok">{t("Nothing here stops this code from running in AntQuant.")}</Row>}
      </ul>
      {(result.fix || unfixable) && (
        <div className="flex flex-wrap gap-2">
          {result.fix && onFix && (
            <Button type="button" size="sm" variant="secondary" onClick={() => onFix(result.fix!)}><Wand2 /> {t("Fix automatically")}</Button>
          )}
          {unfixable && <AiHelpButton variant="outline" fix={aiFix(problems.join("\n"))} />}
        </div>
      )}
    </div>
  );
}

/** Shows the automatic fix as a diff before it is applied. */
export function FixDialog({ fix, onOpenChange, onApply }: {
  fix: CodeFix | null;
  onOpenChange: (open: boolean) => void;
  onApply: (code: string) => void;
}) {
  return (
    <Dialog open={!!fix} onOpenChange={onOpenChange}>
      {fix && (
        <DialogContent className="max-w-3xl" title={t("Fix the code")}
          description={t("Only code that AntQuant does not run moves. The strategy class stays as it is.")}>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {fix.changes.map((change) => (
              <li key={`${change.kind}-${change.line}`}>
                {change.kind === "run_code"
                  ? t("Line {line}: move the run code under if __name__ == \"__main__\":", { line: change.line })
                  : change.moved
                    ? t("Line {line}: move the import there too, because only that code uses it", { line: change.line })
                    : t("Line {line}: remove an import that nothing uses", { line: change.line })}
              </li>
            ))}
          </ul>
          <pre className="max-h-[50vh] overflow-auto rounded-lg border bg-card py-2 font-mono text-xs leading-relaxed" aria-label={t("Changes")}>
            {diffRows(fix.diff).map((row, index) => (
              <div key={index} className={cn("whitespace-pre px-3",
                row.kind === "add" && "bg-gain/10 text-gain",
                row.kind === "del" && "bg-loss/10 text-loss",
                row.kind === "hunk" && "pt-2 text-muted-foreground")}>
                <span aria-hidden className="mr-2 select-none opacity-70">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
                {row.text || " "}
              </div>
            ))}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button onClick={() => onApply(fix.code)}><Wand2 /> {t("Apply changes")}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

export function TrustCheck({ draft, disabled }: { draft: StrategyDraft; disabled?: boolean }) {
  return (
    <Alert tone="warning">
      <ShieldAlert />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={draft.ack} disabled={disabled}
          onChange={(event) => draft.setAck(event.target.checked)} />
        {t("I wrote or reviewed this code and accept that it runs with server permissions.")}
      </label>
    </Alert>
  );
}

/** Runs the code on the last month of daily Yahoo data and explains what happened. */
export function TrialPanel({ draft, onLine, disabled }: {
  draft: StrategyDraft;
  onLine: (line: number) => void;
  disabled?: boolean;
}) {
  const { trial } = draft;
  const outcome = trial.data?.result;
  const canRun = draft.ready && draft.ack && !disabled;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={outcome?.ok && !draft.trialStale ? "outline" : "secondary"} size="sm"
          loading={trial.isPending} disabled={!canRun} onClick={draft.runTrial}>
          <FlaskConical /> {t(outcome ? "Try again" : "Try it on the last month")}
        </Button>
        {!draft.ack && !trial.isPending && (
          <span className="text-xs text-muted-foreground">{t("Tick the box above first. A trial runs the code on the server.")}</span>
        )}
      </div>
      {trial.isPending && (
        <p className="text-xs text-muted-foreground">{t("Running a backtest on daily Yahoo data. This usually takes a few seconds.")}</p>
      )}
      {trial.isError && <Alert tone="loss">{trial.error.message}</Alert>}
      {outcome && !trial.isPending && (
        <div className={cn("grid gap-2", draft.trialStale && "opacity-60")}>
          {draft.trialStale && <p className="text-xs text-muted-foreground">{t("The code or parameters changed after this trial.")}</p>}
          {outcome.ok ? <TrialSuccess outcome={outcome} /> : <TrialFailure outcome={outcome} draft={draft} onLine={onLine} />}
        </div>
      )}
    </div>
  );
}

function TrialSuccess({ outcome }: { outcome: TrialResult }) {
  return (
    <ul className="grid gap-2">
      <Row tone="ok">
        {t("Ran without errors from {start} to {end}. {result}", {
          start: outcome.start,
          end: outcome.end,
          result: outcome.trades
            ? t("{n} orders placed, return {ret}.", { n: outcome.trades, ret: pct(outcome.total_return, 2, true) })
            : t("No orders in this month. That can be normal; check the logic if you expected trades."),
        })}
      </Row>
    </ul>
  );
}

function TrialFailure({ outcome, draft, onLine }: { outcome: TrialResult; draft: StrategyDraft; onLine: (line: number) => void }) {
  const hint = outcome.hint;
  const advice = hint ? hintText(hint) : t("The strategy stopped with an error.");
  const name = hint?.code === "missing_parameter" ? String(hint.params.name ?? "") : "";
  const details = [outcome.traceback, outcome.log].filter(Boolean).join("\n\n");
  return (
    <ul className="grid gap-2">
      <Row tone="error" line={hint?.line} onLine={onLine}
        action={
          <>
            {name && !Object.hasOwn(draft.params, name) && (
              <Button type="button" size="sm" variant="outline" onClick={() => draft.addParameter(name)}><Plus /> {t("Add {name}", { name })}</Button>
            )}
            <AiHelpButton variant="outline" fix={{ code: draft.code, problem: `${advice}\n${outcome.error ?? ""}`.trim(), line: hint?.line }} />
          </>
        }>
        {advice}
      </Row>
      {outcome.error && <li className="break-words pl-6 font-mono text-xs text-muted-foreground">{outcome.error}</li>}
      {details && (
        <li className="pl-6">
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t("Details")}</summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-card p-3 font-mono text-[11px]">{details}</pre>
          </details>
        </li>
      )}
    </ul>
  );
}

/** A numbered step in the code flow, styled like the backtest form's numbered labels. */
export function Step({ n, title, children, busy }: { n: number; title: string; children: React.ReactNode; busy?: boolean }) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {n}. {title}
        {busy && <Loader2 className="size-3 animate-spin" aria-label={t("Checking…")} />}
      </h3>
      {children}
    </section>
  );
}
