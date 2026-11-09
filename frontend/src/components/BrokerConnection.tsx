import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input, Select } from "@/components/ui/primitives";
import { t } from "@/lib/i18n";
import { api } from "@/services/api";
import type { BrokerName } from "@/types/api";

export function BrokerPicker({ value, onChange }: {
  value: BrokerName;
  onChange: (broker: BrokerName) => void;
}) {
  const id = useId();
  return (
    <Field label={t("Broker")} htmlFor={id}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value as BrokerName)}>
        <option value="alpaca">Alpaca</option>
        <option value="schwab">{t("Charles Schwab")}</option>
      </Select>
    </Field>
  );
}

export function SchwabForm({ onSaved, initialCallback = "https://127.0.0.1:8182", hasSavedApp = false }: {
  onSaved: () => void;
  initialCallback?: string;
  hasSavedApp?: boolean;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [callback, setCallback] = useState(initialCallback);
  const [redirect, setRedirect] = useState("");
  const [account, setAccount] = useState("0");
  const authorize = useMutation({
    mutationFn: () => api.post<{ authorization_url: string }>("/api/settings/schwab/authorize", {
      app_key: key.trim(), app_secret: secret.trim(), callback_url: callback.trim(),
    }),
    onSuccess: () => setSecret(""),
  });
  const accounts = useMutation({
    mutationFn: () => api.post<{ accounts: { id: number; label: string }[] }>("/api/settings/schwab/accounts", {
      redirect_url: redirect.trim(),
    }),
    onSuccess: () => setRedirect(""),
  });
  const connect = useMutation({
    mutationFn: () => api.put("/api/settings/schwab/connection", { account: Number(account) }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onSaved();
    },
  });
  const error = connect.error ?? accounts.error ?? authorize.error;
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (accounts.data) connect.mutate();
      else if (authorize.data) accounts.mutate();
      else authorize.mutate();
    }}>
      {accounts.data ? (
        <Field label={t("Authorized Schwab account")} htmlFor={`${id}-account`}>
          <Select id={`${id}-account`} value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.data.accounts.map(({ id: accountId, label }) => (
              <option key={accountId} value={accountId}>{label}</option>
            ))}
          </Select>
        </Field>
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
          <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => {
            setRedirect("");
            authorize.reset();
            accounts.reset();
          }}>{t("Start authorization again")}</Button>
        </>
      ) : (
        <>
          <Alert tone="info"><KeyRound /> {t("Schwab requires OAuth authorization. Renew access every seven days.")}</Alert>
          <Field label={t("App key")} htmlFor={`${id}-key`}
            hint={hasSavedApp ? t("Leave both credential fields blank to use the saved Schwab app.") : undefined}>
            <Input id={`${id}-key`} value={key} onChange={(e) => setKey(e.target.value)}
              autoComplete="off" spellCheck={false} required={!hasSavedApp} />
          </Field>
          <Field label={t("App secret")} htmlFor={`${id}-secret`}>
            <Input id={`${id}-secret`} value={secret} onChange={(e) => setSecret(e.target.value)}
              type="password" autoComplete="off" required={!hasSavedApp} />
          </Field>
          <Field label={t("Callback URL")} htmlFor={`${id}-callback`}
            hint={t("Use the exact HTTPS callback URL registered in the Schwab Developer Portal.")}>
            <Input id={`${id}-callback`} type="url" value={callback}
              onChange={(e) => setCallback(e.target.value)} required />
          </Field>
        </>
      )}
      {error && <Alert tone="loss">{t(error.message)}</Alert>}
      <Button type="submit" loading={authorize.isPending || accounts.isPending || connect.isPending}
        className="justify-self-start">
        {t(accounts.data ? "Connect Schwab" : authorize.data ? "Find authorized accounts" : "Prepare authorization")}
      </Button>
    </form>
  );
}
