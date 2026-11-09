import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import type { Params } from "@/types/api";
import { t } from "@/lib/i18n";

type Props = {
  value: Params;
  onChange: (next: Params | null, error: string | null) => void;
  id?: string;
};

export function ParamsEditor({ value, onChange, id }: Props) {
  const [advanced, setAdvanced] = React.useState(false);
  const [emptyNumbers, setEmptyNumbers] = React.useState<string[]>([]);
  const entries = Object.entries(value);
  const scalars = entries.filter(([, v]) => ["string", "number", "boolean"].includes(typeof v));

  function setValue(name: string, next: string | number | boolean | undefined) {
    const errors = emptyNumbers.filter((key) => key !== name);
    if (next === undefined) errors.push(name);
    setEmptyNumbers(errors);
    onChange(next === undefined ? null : { ...value, [name]: next },
      errors.length ? t("Enter a number for {name}.", { name: errors[0]! }) : null);
  }

  return (
    <div className="grid gap-2">
      {advanced ? <JsonParamsEditor id={id} value={value} onChange={onChange} /> : (
        <>
          {scalars.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {scalars.map(([name, current], index) => {
                const fieldId = `${id}-param-${index}`;
                return (
                  <Field key={name} label={name} htmlFor={fieldId}>
                    {typeof current === "boolean" ? (
                      <label className="flex h-9 items-center gap-2 rounded-lg border border-input px-3 text-xs">
                        <input id={fieldId} type="checkbox" checked={current}
                          onChange={(event) => setValue(name, event.target.checked)} />
                        {t(current ? "On" : "Off")}
                      </label>
                    ) : typeof current === "number" ? (
                      <Input id={fieldId} type="number" step="any"
                        value={emptyNumbers.includes(name) ? "" : current}
                        aria-invalid={emptyNumbers.includes(name)}
                        onChange={(event) => {
                          const next = event.target.valueAsNumber;
                          setValue(name, Number.isFinite(next) ? next : undefined);
                        }} />
                    ) : (
                      <Input id={fieldId} value={String(current)} onChange={(event) => setValue(name, event.target.value)} />
                    )}
                  </Field>
                );
              })}
            </div>
          )}
          {entries.length === 0 && <p className="text-xs text-muted-foreground">{t("No configurable parameters found.")}</p>}
          {scalars.length < entries.length && <p className="text-xs text-muted-foreground">{t("Edit lists, objects, and other values in Advanced JSON.")}</p>}
          {emptyNumbers.length > 0 && <p className="text-xs text-loss">{t("Enter a number for {name}.", { name: emptyNumbers[0]! })}</p>}
        </>
      )}
      <Button type="button" id={advanced ? undefined : id} size="sm" variant="ghost" className="justify-self-start"
        aria-label={t(advanced ? "Parameter form" : "Advanced JSON")} aria-expanded={advanced}
        onClick={() => { setAdvanced(!advanced); setEmptyNumbers([]); onChange(null, null); }}>
        {t(advanced ? "Parameter form" : "Advanced JSON")}
      </Button>
    </div>
  );
}

function JsonParamsEditor({
  value,
  onChange,
  id,
}: Props) {
  const [text, setText] = React.useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  const last = React.useRef(value);
  React.useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(JSON.stringify(value, null, 2));
      setError(null);
    }
  }, [value]);
  return (
    <div className="grid gap-1">
      <Textarea
        id={id}
        spellCheck={false}
        className="min-h-40 font-mono text-xs"
        value={text}
        aria-invalid={!!error}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next || "{}");
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error(t("Parameters must be a JSON object."));
            }
            const bad = Object.keys(parsed).find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
            if (bad) throw new Error(t("Invalid parameter name: {name}", { name: bad }));
            setError(null);
            last.current = parsed;
            onChange(parsed, null);
          } catch (err) {
            const msg = err instanceof Error && !(err instanceof SyntaxError) ? err.message : t("Invalid JSON");
            setError(msg);
            onChange(null, msg);
          }
        }}
      />
      {error ? (
        <p className="text-xs text-loss">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("JSON object passed to the strategy as self.parameters.")}
        </p>
      )}
    </div>
  );
}
