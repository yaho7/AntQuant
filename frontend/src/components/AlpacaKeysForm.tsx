import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PlugZap } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input } from "@/components/ui/primitives";
import { api } from "@/services/api";
import { t } from "@/lib/i18n";
import { profileLabel } from "@/lib/profiles";
import type { BrokerProfile } from "@/types/api";

interface TestResult {
  ok: boolean;
  error?: string;
  account_id?: string;
  status?: string;
  endpoint?: string;
}

/** Write-only form: the secret is sent once and never read back. */
export function AlpacaKeysForm({ onSaved, profile }: {
  onSaved?: () => void;
  profile?: BrokerProfile;
}) {
  const qc = useQueryClient();
  const id = React.useId();
  const [name, setName] = React.useState(profile ? profileLabel(profile) : "");
  const [key, setKey] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [endpoint, setEndpoint] = React.useState(profile?.endpoint ?? "https://api.alpaca.markets");
  const body = { api_key: key.trim(), api_secret: secret.trim(), endpoint: endpoint.trim() };
  const test = useMutation({
    mutationFn: () => api.post<TestResult>("/api/settings/alpaca/test", body),
  });
  const save = useMutation({
    mutationFn: () => profile
      ? api.put(`/api/profiles/${encodeURIComponent(profile.id)}/alpaca`, { ...body, name: name.trim() })
      : api.post("/api/profiles/alpaca", { ...body, name: name.trim() }),
    onSuccess: async () => {
      setSecret("");
      setKey("");
      await qc.invalidateQueries();
      onSaved?.();
    },
  });
  const filled = body.api_key.length > 0 && body.api_secret.length > 0 && body.endpoint.length > 0;
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled && name.trim() && !save.isPending && !test.isPending) save.mutate();
      }}
    >
      <Field label={t("Account name")} htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </Field>
      <Field label={t("Endpoint")} htmlFor={`${id}-endpoint`} hint={t("Enter the base URL of your Alpaca trading API.")}>
        <Input id={`${id}-endpoint`} type="url" autoComplete="url" spellCheck={false} className="font-mono"
          value={endpoint} onChange={(e) => { setEndpoint(e.target.value); test.reset(); }} required />
      </Field>
      <Field label={t("API key ID")} htmlFor={`${id}-key`}>
        <Input id={`${id}-key`} autoComplete="off" spellCheck={false} className="font-mono"
          value={key} onChange={(e) => { setKey(e.target.value); test.reset(); }} required />
      </Field>
      <Field label={t("API secret key")} htmlFor={`${id}-secret`}>
        <Input id={`${id}-secret`} type="password" autoComplete="off" className="font-mono"
          value={secret} onChange={(e) => { setSecret(e.target.value); test.reset(); }} required />
      </Field>
      {test.data?.ok && (
        <Alert tone="info">
          <CheckCircle2 className="text-gain" />
          {t("Connected to account {account} ({status}).", {
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
        <Button type="submit" disabled={!filled || !name.trim() || test.isPending} loading={save.isPending}>{t("Save keys")} </Button>
      </div>
    </form>
  );
}
