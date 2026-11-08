import { Info } from "lucide-react";
import { Delta } from "@/components/common";
import { Card } from "@/components/ui/primitives";
import { money, num, pct } from "@/lib/format";
import type { Metrics } from "@/types/api";
import { t } from "@/lib/i18n";

export function MetricsGrid({ metrics, notes = {} }: { metrics: Metrics; notes?: Record<string, string> }) {
  const items: { key: keyof Metrics; label: string; value: React.ReactNode }[] = [
    {
      key: "total_return",
      label: t("Total return"),
      value: <Delta value={metrics.total_return}>{pct(metrics.total_return, 2, true)}</Delta>,
    },
    {
      key: "annualized_return",
      label: t("Annualized return"),
      value: <Delta value={metrics.annualized_return}>{pct(metrics.annualized_return, 2, true)}</Delta>,
    },
    { key: "sharpe_ratio", label: t("Sharpe ratio"), value: num(metrics.sharpe_ratio, 2) },
    {
      key: "max_drawdown",
      label: t("Max drawdown"),
      value: <Delta value={metrics.max_drawdown}>{pct(metrics.max_drawdown)}</Delta>,
    },
    { key: "win_rate", label: t("Win rate"), value: pct(metrics.win_rate, 1) },
    { key: "profit_factor", label: t("Profit factor"), value: num(metrics.profit_factor, 2) },
    { key: "number_of_trades", label: t("Number of trades"), value: num(metrics.number_of_trades, 0) },
    { key: "ending_value", label: t("Ending value"), value: money(metrics.ending_value) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it) => (
        <Card key={it.key} className="min-w-0 p-4">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {it.label}
            {notes[it.key] && (
              <span title={notes[it.key]} aria-label={notes[it.key]}>
                <Info className="size-3" />
              </span>
            )}
          </p>
          <p className="font-display mt-1 text-2xl">{it.value}</p>
          {notes[it.key] && <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{notes[it.key]}</p>}
        </Card>
      ))}
    </div>
  );
}
