import { useQueries } from "@tanstack/react-query";
import { ArrowUpRight, Layers3, Settings2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { AllocationBreakdown } from "@/components/AccountWidgets";
import { EmptyState, PageHeader, QueryBoundary, StatCard } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { accountSummaryQuery, useProfiles, useTradingTasks, useWealthfolioStatuses } from "@/hooks/queries";
import { money } from "@/lib/format";
import { t } from "@/lib/i18n";
import { authorizationWarning, profileLabel, profilePath, providerLabel } from "@/lib/profiles";
import { DashboardPage } from "@/pages/DashboardPage";
import { TradingPage } from "@/pages/TradingPage";
import type { BrokerProfile } from "@/types/api";

export function ProfilePage({ trading = false }: { trading?: boolean }) {
  const { profileId } = useParams();
  const profiles = useProfiles();
  return (
    <QueryBoundary query={profiles}>
      {({ profiles: items }) => {
        const profile = items.find((item) => item.id === profileId);
        if (!profile) return <Card><EmptyState title={t("Broker account not found.")}
          action={<Button asChild variant="outline"><Link to="/">{t("All accounts")}</Link></Button>} /></Card>;
        return trading ? <TradingPage profile={profile} /> : <DashboardPage profile={profile} />;
      }}
    </QueryBoundary>
  );
}

function AccountsOverview({ profiles }: { profiles: BrokerProfile[] }) {
  const summaries = useQueries({
    queries: profiles.map((profile) => ({
      ...accountSummaryQuery(profile.id),
      enabled: profile.connected && !profile.authorization_expired,
    })),
  });
  const tasks = useTradingTasks(undefined, true);
  const sync = useWealthfolioStatuses();
  const totals = new Map<string, { equity: number; cash: number; count: number }>();
  const breakdowns = new Map<string, { id: string; label: string; value: number }[]>();
  const activeCounts = new Map<string, number>();
  for (const task of tasks.data ?? []) {
    const id = task.config.broker_key;
    if (typeof id === "string") activeCounts.set(id, (activeCounts.get(id) ?? 0) + 1);
  }
  summaries.forEach((summary, index) => {
    if (!profiles[index]?.connected || profiles[index]?.authorization_expired || summary.error) return;
    const account = summary.data?.account;
    if (!account) return;
    const profile = profiles[index]!;
    const total = totals.get(account.currency) ?? { equity: 0, cash: 0, count: 0 };
    totals.set(account.currency, { equity: total.equity + account.equity, cash: total.cash + account.cash, count: total.count + 1 });
    if (account.equity > 0) {
      const slices = breakdowns.get(account.currency) ?? [];
      slices.push({ id: profile.id, label: profileLabel(profile), value: account.equity });
      breakdowns.set(account.currency, slices);
    }
  });
  const excluded = profiles.length - [...totals.values()].reduce((sum, group) => sum + group.count, 0);

  return (
    <div className="grid gap-4">
      {profiles.length === 0 ? (
        <Card><EmptyState icon={Layers3} title={t("No broker accounts yet")}
          description={t("Add a broker account to create its profile and connect a Wealthfolio destination.")}
          action={<Button asChild><Link to="/settings">{t("Add account")}</Link></Button>} /></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[...totals].flatMap(([currency, totals]) => [
              <StatCard key={`${currency}-equity`} label={`${t("Equity")} · ${currency}`} value={money(totals.equity, currency)} />,
              <StatCard key={`${currency}-cash`} label={`${t("Cash balance")} · ${currency}`} value={money(totals.cash, currency)} />,
            ])}
            <StatCard label={t("Running strategies")} value={tasks.data?.length ?? "—"} loading={tasks.isLoading} />
            <StatCard label={t("Wealthfolio pending")} value={sync.data ? Object.values(sync.data.profiles).reduce((sum, state) => sum + state.pending, 0) : "—"} loading={sync.isLoading} />
          </div>
          {excluded > 0 && !summaries.some((query) => query.isLoading) && (
            <Alert tone="info">{t("{n} accounts are excluded from totals because balances are unavailable.", { n: excluded })}</Alert>
          )}
          {(sync.data?.unassigned ?? 0) > 0 && (
            <Alert tone="warning">{t("{n} older fills have an unassigned destination and are held for review.", { n: sync.data?.unassigned ?? 0 })}</Alert>
          )}
          {breakdowns.size > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>{t("Equity by account")}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">{t("Share of positive equity within each currency.")}</p>
                </div>
              </CardHeader>
              <CardContent className="grid gap-5 lg:grid-cols-2">
                {[...breakdowns].map(([currency, slices]) => (
                  <div key={currency} className="grid min-w-0 gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{currency}</p>
                    <AllocationBreakdown slices={slices} currency={currency} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>{t("Broker accounts")}</CardTitle></CardHeader>
            <CardContent className="grid gap-1">
              {profiles.map((profile, index) => {
                const summary = summaries[index];
                const account = profile.connected && !profile.authorization_expired && !summary?.error ? summary?.data?.account : null;
                const state = sync.data?.profiles[profile.id];
                const warning = authorizationWarning(profile);
                return (
                  <Link key={profile.id} to={profilePath(profile.id)}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-lg px-3 py-3 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{profileLabel(profile)}</p>
                      <p className="truncate text-xs text-muted-foreground">{[providerLabel(profile.provider), profile.account_hint].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="flex items-center gap-2 text-right">
                      <span className="num sensitive text-sm font-semibold">{account ? money(account.equity, account.currency) : "—"}</span>
                      <ArrowUpRight className="size-4 text-muted-foreground" aria-hidden />
                    </div>
                    <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                      {warning && <Badge tone="warning">{t(profile.authorization_expired ? "Authorization expired" : "Expires soon")}</Badge>}
                      {!profile.connected && <Badge>{t("Not connected")}</Badge>}
                      {profile.connected && (summary?.error || summary?.data?.error) && <Badge tone="warning">{t("Balance unavailable")}</Badge>}
                      <Badge>{t("{n} strategies running", { n: activeCounts.get(profile.id) ?? 0 })}</Badge>
                      {state?.last_error ? <Badge tone="warning">{t("Wealthfolio needs attention")}</Badge>
                        : state && (state.configured || state.pending > 0) && <Badge title={state.account_name ?? undefined}>{t("{n} fills pending", { n: state.pending })}</Badge>}
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function ProfilesPage() {
  const profiles = useProfiles();
  return (
    <>
      <PageHeader title={t("All accounts")} description={t("Balances, running strategies and sync status across your broker accounts.")}
        actions={<Button asChild variant="outline"><Link to="/settings"><Settings2 /> {t("Manage accounts")}</Link></Button>} />
      <QueryBoundary query={profiles}>{({ profiles: items }) => <AccountsOverview profiles={items} />}</QueryBoundary>
    </>
  );
}
