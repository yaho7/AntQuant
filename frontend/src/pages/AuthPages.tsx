import { useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlpacaKeysForm } from "@/components/AlpacaKeysForm";
import { BrandIcon } from "@/components/BrandIcon";
import { BrokerPicker, SchwabForm } from "@/components/BrokerConnection";
import type { BrokerName } from "@/types/api";
import { LanguageSelect } from "@/components/LanguageSelect";
import { Button } from "@/components/ui/button";
import { Alert, Card, Field, Input } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/useAuth";
import { api, ApiError } from "@/services/api";
import { getLocale, setLocale, t } from "@/lib/i18n";

function Shell({ children, title, subtitle }: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="view-enter w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandIcon className="size-5" />
          </div>
          <span className="font-semibold tracking-tight">{t("AntQuant")}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">{subtitle}</p>
        <Card className="p-5">{children}</Card>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const login = useMutation({
    mutationFn: () => api.post("/api/auth/login", { username, password }),
    onSuccess: () => refresh(),
  });
  return (
    <Shell title={t("Sign in")} subtitle={t("Administrator access to your trading workspace.")}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Field label={t("Username")} htmlFor="u">
          <Input id="u" autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label={t("Password")} htmlFor="p">
          <Input id="p" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {login.error && <Alert tone="loss">{t(login.error.message)}</Alert>}
        <Button type="submit" loading={login.isPending}>{t("Sign in")}</Button>
      </form>
    </Shell>
  );
}

/** Optional broker connection after creating the administrator account. */
export function ConnectBrokerPage() {
  const navigate = useNavigate();
  const finish = () => navigate("/", { replace: true });
  const [broker, setBroker] = React.useState<BrokerName>("alpaca");
  return (
    <Shell
      title={t("Connect a broker (optional)")}
      subtitle={t("Step 2 of 2 · You can do this later in Settings.")}
    >
      <div className="grid gap-4">
        <BrokerPicker value={broker} onChange={setBroker} />
        {broker === "alpaca" ? <AlpacaKeysForm onSaved={finish} /> : <SchwabForm onSaved={finish} />}
        <Button variant="ghost" onClick={finish}>{t("Skip for now")}</Button>
      </div>
    </Shell>
  );
}

export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [locale, setSelectedLocale] = React.useState(getLocale);
  const [form, setForm] = React.useState({
    username: "admin",
    password: "",
    confirm: "",
  });
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const create = useMutation({
    mutationFn: () =>
      api.post("/api/auth/setup", {
        username: form.username.trim(),
        password: form.password,
      }),
    onSuccess: async () => {
      navigate("/setup/connect", { replace: true });
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void refresh();
    },
  });

  return (
    <Shell title={t("Welcome")} subtitle={t("Step 1 of 2 · Create the administrator account.")}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) create.mutate();
        }}
      >
        <Field label={t("Language")} htmlFor="setup-language">
          <LanguageSelect id="setup-language" value={locale} onChange={(next) => {
            setLocale(next, false);
            setSelectedLocale(next);
          }} />
        </Field>
        <Field label={t("Username")} htmlFor="su">
          <Input id="su" autoComplete="username" value={form.username} required
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label={t("Password")} htmlFor="sp" hint={t("At least 10 characters.")}>
          <Input id="sp" type="password" autoComplete="new-password" minLength={10} required
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label={t("Confirm password")} htmlFor="sc">
          <Input id="sc" type="password" autoComplete="new-password" required
            value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            aria-invalid={mismatch} />
        </Field>
        {mismatch && <Alert tone="loss">{t("Passwords do not match.")}</Alert>}
        {create.error && <Alert tone="loss">{t(create.error.message)}</Alert>}
        <Button type="submit" loading={create.isPending} disabled={mismatch}>
          <ShieldCheck /> {t("Create account")} </Button>
      </form>
    </Shell>
  );
}
