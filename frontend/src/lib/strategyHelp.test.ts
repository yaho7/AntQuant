import { describe, expect, it } from "vitest";
import type { CodeIssue } from "@/types/api";
import { aiPrompt, aiRules, diffRows, guessDefault, hintText, issueText, withParameter } from "./strategyHelp";

const issue = (code: CodeIssue["code"], params: Record<string, string> = {}): CodeIssue =>
  ({ code, severity: "error", line: 2, params, fixable: false });

describe("strategy help", () => {
  it("explains local files and missing libraries differently", () => {
    expect(issueText(issue("missing_module", { module: ".helpers" }))).toContain("file next to it");
    expect(issueText(issue("missing_module", { module: "talib" }))).toContain("no module named talib");
    expect(issueText(issue("module_alias", { module: "pandas_ta", alias: "pandas_ta_classic" })))
      .toBe("pandas_ta runs here as pandas_ta_classic, which has the same functions.");
  });

  it("turns trial hints into advice and falls back for unknown codes", () => {
    expect(hintText({ code: "missing_parameter", params: { name: "symbol" }, line: 9 }))
      .toBe("Parameter symbol has no value. Add it under Parameters.");
    expect(hintText({ code: "something_new", params: {}, line: null })).toBe("The strategy stopped with an error.");
  });

  it("adds a missing parameter once, guessing text or number", () => {
    expect(guessDefault("symbol")).toBe("");
    expect(guessDefault("lookback")).toBe(0);
    const params = withParameter({ symbol: "SPY" }, "lookback");
    expect(params).toEqual({ symbol: "SPY", lookback: 0 });
    expect(withParameter(params, "symbol")).toBe(params);
  });

  it("reads a unified diff without its file headers", () => {
    const diff = "--- before.py\n+++ after.py\n@@ -1,2 +1,3 @@\n keep\n-old\n+if x:\n+    new\n";
    expect(diffRows(diff)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "same", text: "keep" },
      { kind: "del", text: "old" },
      { kind: "add", text: "if x:" },
      { kind: "add", text: "    new" },
    ]);
  });

  it("builds a prompt with the rules, and with the code and problem when fixing", () => {
    const blank = aiPrompt();
    expect(blank).toContain(`${aiRules().length}. ${aiRules().at(-1)}`);
    expect(blank.trimEnd().endsWith("My idea:")).toBe(true);
    const fix = aiPrompt({ code: "class Bot(Strategy):\n    pass\n\n", problem: "KeyError: 'symbol'", line: 7 });
    expect(fix).toContain("Problem: KeyError: 'symbol'\nLine 7 of the code.");
    expect(fix).toContain("```python\nclass Bot(Strategy):\n    pass\n```");
  });
});
