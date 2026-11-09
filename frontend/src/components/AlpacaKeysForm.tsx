import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PlugZap } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { api } from "@/services/api";
import { t } from "@/lib/i18n";

interface TestResult {
  ok: boolean;
  error?: string;
  account_id?: string;
  status?: string;
  paper?: boolean;
}

/** Write-only form: the secret is sent once and never read back. */
export function AlpacaKeysForm({ onSaved, initialPaper = true }: {
  onSaved?: () => void;
  initialPaper?: boolean;
}) {
  const qc = useQueryClient();
  const [key, setKey] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [paper, setPaper] = React.useState(initialPaper);
  const body = { api_key: key.trim(), api_secret: secret.trim(), paper };
  const test = useMutation({
    mutationFn: () => api.post<TestResult>("/api/settings/alpaca/test", body),
  });
  const save = useMutation({
    mutationFn: () => api.put("/api/settings/alpaca/credentials", body),
    onSuccess: async () => {
      setSecret("");
      setKey("");
      await qc.invalidateQueries();
      onSaved?.();
    },
  });
  const filled = body.api_key.length > 0 && body.api_secret.length > 0;
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled && !save.isPending) save.mutate();
      }}
    >
      <Field label={t("Alpaca account type")} htmlFor="alpaca-mode">
        <Select id="alpaca-mode" value={paper ? "paper" : "live"} onChange={(event) => {
          setPaper(event.target.value === "paper");
          test.reset();
        }}>
          <option value="paper">{t("Paper account")}</option>
          <option value="live">{t("Live account")}</option>
        </Select>
      </Field>
      <Field label={t("API key ID")} htmlFor="ak">
        <Input id="ak" autoComplete="off" spellCheck={false} className="font-mono"
          value={key} onChange={(e) => { setKey(e.target.value); test.reset(); }} required />
      </Field>
      <Field label={t("API secret key")} htmlFor="as">
        <Input id="as" type="password" autoComplete="off" className="font-mono"
          value={secret} onChange={(e) => { setSecret(e.target.value); test.reset(); }} required />
      </Field>
      {test.data?.ok && (
        <Alert tone="info">
          <CheckCircle2 className="text-gain" />
          {t("Connected to {mode} · {account} ({status}).", {
            mode: t(test.data.paper ? "Paper account" : "Live account"),
            account: test.data.account_id ?? "",
            status: test.data.status ?? "",
          })}
        </Alert>
      )}
      {test.data && !test.data.ok && <Alert tone="loss">{t(test.data.error ?? "Connection failed")}</Alert>}
      {(test.error || save.error) && (
        <Alert tone="loss">{t((test.error ?? save.error)!.message)}</Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!filled} loading={test.isPending}
          onClick={() => test.mutate()}>
          <PlugZap /> {t("Test connection")} </Button>
        <Button type="submit" disabled={!filled} loading={save.isPending}>{t("Save keys")} </Button>
      </div>
    </form>
  );
}
