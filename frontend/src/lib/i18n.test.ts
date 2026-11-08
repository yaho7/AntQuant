import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { zh } from "./locales/zh";

describe("i18n", () => {
  it("falls back to the English key and fills placeholders", () => {
    expect(t("Untranslated text")).toBe("Untranslated text");
    expect(t("Saved as version {v}", { v: 3 })).toBe("Saved as version 3");
  });

  it("keeps placeholders in Chinese translations", () => {
    for (const [en, cn] of Object.entries(zh)) {
      const want = (en.match(/\{\w+\}/g) ?? []).sort();
      const got = (cn.match(/\{\w+\}/g) ?? []).sort();
      expect(got, en).toEqual(want);
    }
  });
});
