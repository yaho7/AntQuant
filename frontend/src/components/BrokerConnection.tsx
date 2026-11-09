import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { t } from "@/lib/i18n";
import { providerLabel } from "@/lib/profiles";
import { api } from "@/services/api";
import type { BrokerName, BrokerProfile } from "@/types/api";

export function BrokerPicker({ value, onChange }: {
  value: BrokerName;
  onChange: (broker: BrokerName) => void;
}) {
  const id = useId();
  return (
    <Field label={t("Broker")} htmlFor={id}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value as BrokerName)}>
        <option value="alpaca">{providerLabel("alpaca")}</option>
        <option value="schwab">{providerLabel("schwab")}</option>
      </Select>
    </Field>
  );
}

export function SchwabForm({ onSaved, profile }: {
  onSaved: () => void;
  profile?: BrokerProfile;
}) {
  const qc = useQueryClient();
  const id = useId();
  const renewing = !!profile?.connected;
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [callback, setCallback] = useState(profile?.callback_url ?? "https://127.0.0.1:8182");
  const [redirect, setRedirect] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const authorize = useMutation({
    mutationFn: () => api.post<{ authorization_url: string; flow_id: string }>("/api/profiles/schwab/authorize", {
      app_key: key.trim(), app_secret: secret.trim(), callback_url: callback.trim(),
      profile_id: renewing ? profile.id : undefined,
    }),
    onSuccess: () => setSecret(""),
  });
  const accountsPath = `/api/profiles/schwab/${authorize.data?.flow_id}/accounts`;
  const accounts = useMutation({
    mutationFn: () => api.post<{ accounts: { id: number; label: string; required: boolean }[] }>(accountsPath, {
      redirect_url: redirect.trim(),
    }),
    onSuccess: ({ accounts: items }) => {
      setRedirect("");
      const first = renewing ? items.find((item) => item.required) : items[0];
      setSelected(first ? [first.id] : []);
    },
  });
  const connect = useMutation({
    mutationFn: () => api.put(accountsPath, {
      accounts: selected,
      name: selected.length === 1 && name.trim() ? name.trim() : undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onSaved();
    },
  });
  const error = connect.error ?? accounts.error ?? authorize.error;
  const busy = authorize.isPending || accounts.isPending || connect.isPending;
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      if (accounts.data) {
        if (selected.length) connect.mutate();
      } else if (authorize.data) accounts.mutate();
      else authorize.mutate();
    }}>
      {accounts.data ? (
        <>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t("Authorized Schwab accounts")}</legend>
            {accounts.data.accounts.filter((item) => !renewing || item.required).map(({ id: accountId, label }) => (
              <label key={accountId} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <input type="checkbox" checked={selected.includes(accountId)} disabled={renewing || busy}
                  onChange={(event) => setSelected((current) => event.target.checked
                    ? [...current, accountId] : current.filter((value) => value !== accountId))} />
                <span className="font-mono">{label}</span>
              </label>
            ))}
          </fieldset>
          {renewing && !selected.length && <Alert tone="warning">{t("Select the same Schwab account to renew access.")}</Alert>}
          {!renewing && selected.length === 1 && (
            <Field label={t("Account name (optional)")} htmlFor={`${id}-name`}>
              <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
            </Field>
          )}
        </>
      ) : authorize.data ? (
        <>
          <Button asChild variant="outline" className="justify-self-start">
            <a href={authorize.data.authorization_url} target="_blank" rel="noreferrer">
              <ExternalLink /> {t("Authorize on Schwab")}
            </a>
          </Button>
          <Field label={t("Authorization redirect URL")} htmlFor={`${id}-redirect`}
            hint={t("After approving access, copy the full URL from the address bar and paste it here, even if the callback page did not load.")}>
            <Input id={`${id}-redirect`} type="url" autoComplete="off" spellCheck={false}
              value={redirect} onChange={(e) => setRedirect(e.target.value)} required />
          </Field>
        </>
      ) : (
        <>
          <Alert tone="info"><KeyRound /> {t("Schwab requires OAuth authorization. Renew access every seven days.")}</Alert>
          <Field label={t("App key")} htmlFor={`${id}-key`}
            hint={renewing ? t("Leave both credential fields blank to use the saved Schwab app.") : undefined}>
            <Input id={`${id}-key`} value={key} onChange={(e) => setKey(e.target.value)}
              autoComplete="off" spellCheck={false} required={!renewing} />
          </Field>
          <Field label={t("App secret")} htmlFor={`${id}-secret`}>
            <Input id={`${id}-secret`} value={secret} onChange={(e) => setSecret(e.target.value)}
              type="password" autoComplete="off" required={!renewing} />
          </Field>
          <Field label={t("Callback URL")} htmlFor={`${id}-callback`}
            hint={t("Use the exact HTTPS callback URL registered in the Schwab Developer Portal.")}>
            <Input id={`${id}-callback`} type="url" value={callback}
              onChange={(e) => setCallback(e.target.value)} required />
          </Field>
        </>
      )}
      {error && <Alert tone="loss">{t(error.message)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={!!accounts.data && !selected.length}>
          {t(accounts.data ? (renewing ? "Renew authorization" : "Connect Schwab")
            : authorize.data ? "Find authorized accounts" : "Prepare authorization")}
        </Button>
        {authorize.data && <Button type="button" variant="ghost" disabled={busy} onClick={() => {
          setRedirect("");
          authorize.reset();
          accounts.reset();
          connect.reset();
        }}>{t("Start authorization again")}</Button>}
      </div>
    </form>
  );
}
