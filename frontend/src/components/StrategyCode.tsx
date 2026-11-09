import * as React from "react";
import { t } from "@/lib/i18n";
import { api } from "@/services/api";
import type { DiscoveredStrategy } from "@/types/api";

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

export async function scanStrategyCode(code: string, filename: string): Promise<DiscoveredStrategy[]> {
  const result = await api.post<{ classes: DiscoveredStrategy[]; error?: string; line?: number; reason?: string }>(
    "/api/strategies/scan", { code, filename },
  );
  if (result.error) {
    throw new Error(result.line
      ? t("Python syntax error on line {line}: {reason}", { line: result.line, reason: result.reason ?? "" })
      : t(result.error));
  }
  return result.classes;
}

export function StrategyCodeGuide() {
  return (
    <details className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-sm font-medium text-foreground">{t("How to write a strategy")}</summary>
      <ul className="mt-2 grid list-disc gap-2 pl-4">
        <li>{t("Import Strategy from lumibot.strategies and define a class such as MyStrategy(Strategy). Use initialize for setup and on_trading_iteration for the work to repeat.")}</li>
        <li>{t("Put editable defaults in a class-level parameters dictionary, for example {example}. Read the saved value with {access}.", {
          example: 'parameters = {"symbol": "SPY"}',
          access: 'self.parameters["symbol"]',
        })}</li>
        <li>{t("AntQuant supplies the selected broker account and Endpoint through self.broker. Replace reads of ALPACA_API_KEY and ALPACA_API_SECRET with the provided broker connection.")}</li>
        <li>{t("Use self.create_order and self.submit_order so AntQuant can apply trading controls and sync fills to Wealthfolio. The template only logs prices.")}</li>
      </ul>
    </details>
  );
}
