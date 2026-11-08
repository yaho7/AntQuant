/**
 * i18n. English text is the message key; other languages map it to a
 * translation and fall back to English when a string is missing.
 *
 *   t("Start backtest")                 -> "开始回测" in Chinese
 *   t("Stopped {n} runs", { n: 2 })     -> placeholders are replaced
 *
 * To add a language, add a dictionary in `./locales/` and list it in LOCALES.
 */
import { zh } from "./locales/zh";

export type Locale = "en" | "zh";

export const LOCALES: { id: Locale; label: string; intl: string }[] = [
  { id: "en", label: "English", intl: "en-US" },
  { id: "zh", label: "中文", intl: "zh-CN" },
];

const dictionaries: Record<Locale, Record<string, string>> = { en: {}, zh };
const KEY = "lumibot-ui-locale";

function initial(): Locale {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  if (saved === "en" || saved === "zh") return saved;
  return "en"; // English by default until the user picks a language
}

let locale: Locale = initial();

export function getLocale(): Locale {
  return locale;
}

/** Intl locale for dates and chart axes. */
export function intlLocale(): string {
  return LOCALES.find((l) => l.id === locale)?.intl ?? "en-US";
}

/** Switch language. The page reloads so every string is rendered again. */
export function setLocale(next: Locale): void {
  localStorage.setItem(KEY, next);
  if (next !== locale) location.reload();
}

export function t(text: string, vars?: Record<string, string | number>): string {
  let out = dictionaries[locale][text] ?? text;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

if (typeof document !== "undefined") {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}
