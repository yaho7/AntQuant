import * as React from "react";
import { t } from "@/lib/i18n";
import type { DiscoveredStrategy, Params } from "@/types/api";

const PythonEditor = React.lazy(() => import("@/components/PythonEditor"));

export const strategyTemplate = `from lumibot.strategies import Strategy


class MyStrategy(Strategy):
    parameters = {"symbol": "SPY", "interval": "1D"}

    def initialize(self):
        self.sleeptime = self.parameters["interval"]

    def on_trading_iteration(self):
        symbol = self.parameters["symbol"]
        price = self.get_last_price(symbol)
        self.log_message(f"{symbol}: {price}")
`;

export function StrategyCodeEditor(props: React.ComponentProps<typeof PythonEditor>) {
  return (
    <React.Suspense fallback={<div className="rounded-lg border p-4 text-sm text-muted-foreground">{t("Loading…")}</div>}>
      <PythonEditor {...props} />
    </React.Suspense>
  );
}

/**
 * New defaults from a scan, keeping values the user already set when the type
 * still matches, and values given for keys the code reads without a default.
 * With no defaults found, the current values stay as they are.
 */
export function mergeScannedParameters(item: DiscoveredStrategy, current: Params): Params {
  if (Object.keys(item.parameters).length === 0) return current;
  const type = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const merged: Params = Object.fromEntries(Object.entries(item.parameters).map(([key, fallback]) => [
    key, Object.hasOwn(current, key) && type(current[key]) === type(fallback) ? current[key] : fallback,
  ]));
  for (const { name } of item.missing_parameters ?? []) {
    if (Object.hasOwn(current, name) && !Object.hasOwn(merged, name)) merged[name] = current[name];
  }
  return merged;
}
