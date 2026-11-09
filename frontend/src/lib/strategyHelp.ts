/**
 * Plain-language text for strategy checks and trial runs, and the prompt for
 * AI tools. The server returns codes and values; the wording lives here so it
 * follows the UI language.
 */
import { t } from "@/lib/i18n";
import type { CodeIssue, DiscoveredStrategy, Params, TrialHint } from "@/types/api";

export function issueText(issue: CodeIssue): string {
  const p = issue.params;
  switch (issue.code) {
    case "missing_module":
      return p.module?.startsWith(".")
        ? t("This file imports {module} from a file next to it. AntQuant takes one file, so copy that code into this file.", { module: p.module })
        : t("This server has no module named {module}. A file from your computer, such as a config.py with API keys, is not needed here. A library is not installed on this server.", { module: p.module ?? "" });
    case "module_alias":
      return t("{module} runs here as {alias}, which has the same functions.", { module: p.module ?? "", alias: p.alias ?? "" });
    case "run_code":
      return t("This code starts a run as soon as the file loads. AntQuant runs the strategy itself, so it belongs under if __name__ == \"__main__\":.");
    case "data_source":
      return t("AntQuant backtests use Yahoo or Alpaca data, so {names} in this file is not used.", { names: p.names ?? "" });
    case "intraday":
      return t("This strategy asks for minute or hour bars. Yahoo only has daily bars, so pick Alpaca data when you backtest it.");
    case "env_credentials":
      return t("The strategy reads {name} itself. AntQuant does not set it: the broker connection comes from the account you pick.", { name: p.name ?? "" });
  }
}

export function parameterSourcesText(item: DiscoveredStrategy): string {
  const parts = item.parameter_sources.map((source) => {
    switch (source.kind) {
      case "class":
        return t("the parameters dict (line {line})", { line: source.line });
      case "initialize":
        return t("initialize() (line {line})", { line: source.line });
      case "get":
        return t("parameters.get() defaults");
      case "call":
        return t("the run call on line {line}", { line: source.line });
    }
  });
  return t("Parameters from {sources}.", { sources: parts.join(t(", ")) });
}

export function hintText(hint: TrialHint): string {
  const p = hint.params;
  switch (hint.code) {
    case "missing_parameter":
      return t("Parameter {name} has no value. Add it under Parameters.", { name: p.name ?? "" });
    case "missing_module":
      return t("This server cannot import {module}. Remove that import, or ask the AI to use pandas, numpy or pandas_ta instead.", { module: p.module ?? "" });
    case "key_error":
      return t("The code looked up {key}, but it was not there.", { key: p.key ?? "" });
    case "name_error":
      return t("{name} is used but never defined or imported.", { name: p.name ?? "" });
    case "no_data":
      return t("No market data came back. Check the symbol, and check for None before using what get_historical_prices returns.");
    case "data_download":
      return t("Yahoo data could not be downloaded. Check the server's internet connection, then try again.");
    case "broker_auth":
      return t("The file connects to a broker itself, and the login was refused. Remove that code: AntQuant connects the broker for you.");
    case "timeout":
      return t("The trial did not finish within {seconds} seconds. A minute or hour sleeptime makes daily data slow to run.", { seconds: p.seconds ?? "" });
    default:
      return t("The strategy stopped with an error.");
  }
}

/** A starting value for a parameter the code reads without a default. */
export function guessDefault(name: string): string | number {
  return /symbol|ticker|asset|coin|pair|stock|etf|market|interval|timeframe|sleeptime|side|mode|type|name/i.test(name)
    ? ""
    : 0;
}

export function withParameter(params: Params, name: string): Params {
  return Object.hasOwn(params, name) ? params : { ...params, [name]: guessDefault(name) };
}

export type DiffRow = { kind: "add" | "del" | "same" | "hunk"; text: string };

/** Rows of a unified diff, without the file header lines. */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
    rows.push({ kind, text: kind === "hunk" ? line : line.slice(1) });
  }
  return rows;
}

export function aiRules(): string[] {
  return [
    t("Put everything in one Python file. Import Strategy with from lumibot.strategies import Strategy and define one class, such as class MyStrategy(Strategy):."),
    t("Put every setting a user may change in a class-level parameters dict, using only text, numbers, true/false and lists. Read them with self.parameters[\"name\"]."),
    t("In initialize, set self.sleeptime = \"1D\" for one decision per day. Put the trading logic in on_trading_iteration."),
    t("Get prices with self.get_last_price(symbol) and self.get_historical_prices(symbol, length, \"day\"). The second can return None, so check it before using .df."),
    t("Place orders with self.create_order(symbol, quantity, \"buy\") and self.submit_order(order). Check self.get_position(symbol) and self.get_cash() first."),
    t("Do not create a broker, a Trader or API keys, and do not call backtest(). AntQuant connects the broker and runs backtests itself. Code that runs the file on your own computer goes under if __name__ == \"__main__\":."),
    t("Use only these libraries: lumibot, pandas, numpy, scipy, pandas_ta and yfinance."),
    t("Backtests use daily Yahoo Finance bars for US stocks and ETFs."),
  ];
}

export function aiPrompt(fix?: { code: string; problem: string; line?: number | null }): string {
  const rules = aiRules().map((rule, index) => `${index + 1}. ${rule}`).join("\n");
  const intro = t("Write a trading strategy for AntQuant, a web app that runs LumiBot strategies. Follow these rules:");
  const reply = t("Reply with the complete file in one code block.");
  if (!fix) return `${intro}\n${rules}\n\n${reply}\n\n${t("My idea:")} `;
  const where = fix.line ? `\n${t("Line {line} of the code.", { line: fix.line })}` : "";
  return [
    `${intro}\n${rules}`,
    `${t("The strategy below does not run in AntQuant. Fix it.")} ${reply}`,
    `${t("Problem:")} ${fix.problem}${where}`,
    `\`\`\`python\n${fix.code.replace(/\n+$/, "")}\n\`\`\``,
  ].join("\n\n");
}
