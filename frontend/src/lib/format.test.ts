import { describe, expect, it } from "vitest";
import { direction, duration, money, NA, pct, signedMoney } from "./format";

describe("format", () => {
  it("renders missing values as N/A, never zero", () => {
    expect(money(null)).toBe(NA);
    expect(pct(undefined)).toBe(NA);
    expect(pct(Number.NaN)).toBe(NA);
    expect(direction(null)).toBe("none");
  });

  it("formats money and percentages", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(signedMoney(-12)).toBe("−$12.00");
    expect(signedMoney(12)).toBe("+$12.00");
    expect(pct(0.1234)).toBe("12.34%");
    expect(pct(-0.05, 1, true)).toBe("−5.0%");
    expect(pct(0.05, 1, true)).toBe("+5.0%");
  });

  it("formats durations", () => {
    expect(duration(59)).toBe("59s");
    expect(duration(3700)).toBe("1h 1m");
    expect(duration(90000)).toBe("1d 1h");
  });
});
