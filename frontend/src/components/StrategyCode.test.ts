import { describe, expect, it } from "vitest";
import type { DiscoveredStrategy } from "@/types/api";
import { mergeScannedParameters } from "./StrategyCode";

const scanned = (parameters: DiscoveredStrategy["parameters"], missing: string[] = []): DiscoveredStrategy => ({
  file: "bot.py", root: "user", source_path: "user/bot.py", class_name: "Bot", docstring: "", sha256: "",
  parameters, parameters_parsed: true, parameter_sources: [], unread_parameters: [],
  missing_parameters: missing.map((name) => ({ name, line: 1 })),
});

describe("mergeScannedParameters", () => {
  it("keeps edited values of the same type and takes new defaults otherwise", () => {
    const merged = mergeScannedParameters(scanned({ symbol: "SPY", fast: 10, slow: 30 }), { symbol: "QQQ", fast: "x", old: 1 });
    expect(merged).toEqual({ symbol: "QQQ", fast: 10, slow: 30 });
  });

  it("keeps values the user added for parameters the code reads without a default", () => {
    const merged = mergeScannedParameters(scanned({ symbol: "SPY" }, ["lookback"]), { symbol: "SPY", lookback: 14 });
    expect(merged).toEqual({ symbol: "SPY", lookback: 14 });
  });

  it("leaves the values alone when the file has no defaults", () => {
    const current = { symbol: "QQQ" };
    expect(mergeScannedParameters(scanned({}), current)).toBe(current);
  });
});
