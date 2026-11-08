import { intlLocale } from "./i18n";

/** Formatting helpers. `null`/`undefined` always render as "N/A", never as 0. */

export const NA = "N/A";

type Num = number | null | undefined;

const isNum = (v: Num): v is number => typeof v === "number" && Number.isFinite(v);

export function money(v: Num, currency = "USD", digits = 2): string {
  if (!isNum(v)) return NA;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

export function signedMoney(v: Num, currency = "USD"): string {
  if (!isNum(v)) return NA;
  const s = money(Math.abs(v), currency);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

/** `v` is a fraction: 0.123 -> "12.30%". */
export function pct(v: Num, digits = 2, signed = false): string {
  if (!isNum(v)) return NA;
  const s = `${(Math.abs(v) * 100).toFixed(digits)}%`;
  if (!signed) return v < 0 ? `−${s}` : s;
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function num(v: Num, digits = 2): string {
  if (!isNum(v)) return NA;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(v);
}

/** Direction of a value, used with an arrow icon so meaning never depends on colour alone. */
export function direction(v: Num): "up" | "down" | "flat" | "none" {
  if (!isNum(v)) return "none";
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(intlLocale(), {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function duration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return NA;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function between(start: string | null, end: string | null): number | null {
  if (!start) return null;
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  return (b - a) / 1000;
}

export function bytes(v: Num): string {
  if (!isNum(v)) return NA;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
