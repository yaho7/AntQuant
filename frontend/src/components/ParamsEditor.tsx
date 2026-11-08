import * as React from "react";
import { Textarea } from "@/components/ui/primitives";
import type { Params } from "@/types/api";

/** JSON editor for strategy parameters. Reports the parsed object or an error. */
export function ParamsEditor({
  value,
  onChange,
  id,
}: {
  value: Params;
  onChange: (next: Params | null, error: string | null) => void;
  id?: string;
}) {
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
              throw new Error("Parameters must be a JSON object, e.g. {\"symbol\": \"SPY\"}");
            }
            const bad = Object.keys(parsed).find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
            if (bad) throw new Error(`"${bad}" is not a valid parameter name`);
            setError(null);
            last.current = parsed;
            onChange(parsed, null);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Invalid JSON";
            setError(msg);
            onChange(null, msg);
          }
        }}
      />
      {error ? (
        <p className="text-xs text-loss">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          JSON object passed to the strategy as <code>self.parameters</code>.
        </p>
      )}
    </div>
  );
}
