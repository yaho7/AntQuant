import { useMutation } from "@tanstack/react-query";
import { Activity, KeyRound, ShieldCheck, Terminal } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlpacaKeysForm } from "@/components/AlpacaKeysForm";
import { Button } from "@/components/ui/button";
import { Alert, Card, Field, Input } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/useAuth";
import { api } from "@/services/api";

function Shell({ children, title, subtitle }: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="size-4" />
          </div>
          <span className="font-semibold tracking-tight">LumiBot UI</span>
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
    <Shell title="Sign in" subtitle="Administrator access to your trading workspace.">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Field label="Username" htmlFor="u">
          <Input id="u" autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="p">
          <Input id="p" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {login.error && <Alert tone="loss">{(login.error as Error).message}</Alert>}
        <Button type="submit" loading={login.isPending}>Sign in</Button>
      </form>
    </Shell>
  );
}

/** First-run wizard: claim the instance with the setup token, then connect Alpaca. */
export function ConnectBrokerPage() {
  const navigate = useNavigate();
  const finish = () => navigate("/", { replace: true });
  return (
    <Shell
      title="Connect Alpaca (optional)"
      subtitle="Step 2 of 2 · Paper trading only. You can do this later in Settings."
    >
      <div className="grid gap-4">
        <Alert tone="info">
          <KeyRound />
          <div>
            Use keys from an Alpaca <b>paper</b> account. Keys are encrypted on the server and
            are never shown again in the browser.
          </div>
        </Alert>
        <AlpacaKeysForm onSaved={finish} />
        <Button variant="ghost" onClick={finish}>Skip for now</Button>
      </div>
    </Shell>
  );
}

export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = React.useState({
    setup_token: "",
    username: "admin",
    password: "",
    confirm: "",
  });
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const create = useMutation({
    mutationFn: () =>
      api.post("/api/auth/setup", {
        setup_token: form.setup_token.trim(),
        username: form.username.trim(),
        password: form.password,
      }),
    onSuccess: async () => {
      navigate("/setup/connect", { replace: true });
      await refresh();
    },
  });

  return (
    <Shell title="Welcome" subtitle="Step 1 of 2 · Create the administrator account.">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) create.mutate();
        }}
      >
        <Alert tone="info">
          <Terminal />
          <div className="grid gap-1">
            <span>Enter the setup token printed in the server log. With Docker:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              docker compose logs lumibot-ui | grep "setup token"
            </code>
          </div>
        </Alert>
        <Field label="Setup token" htmlFor="tok">
          <Input id="tok" autoComplete="off" value={form.setup_token} required
            className="font-mono"
            onChange={(e) => setForm({ ...form, setup_token: e.target.value })} />
        </Field>
        <Field label="Username" htmlFor="su">
          <Input id="su" autoComplete="username" value={form.username} required
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="sp" hint="At least 10 characters.">
          <Input id="sp" type="password" autoComplete="new-password" minLength={10} required
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Confirm password" htmlFor="sc">
          <Input id="sc" type="password" autoComplete="new-password" required
            value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            aria-invalid={mismatch} />
        </Field>
        {mismatch && <Alert tone="loss">Passwords do not match.</Alert>}
        {create.error && <Alert tone="loss">{(create.error as Error).message}</Alert>}
        <Button type="submit" loading={create.isPending} disabled={mismatch}>
          <ShieldCheck /> Create account
        </Button>
      </form>
    </Shell>
  );
}
