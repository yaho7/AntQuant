/**
 * Minimal i18n: English is the default and only shipped language. To add one,
 * add a dictionary with the same keys and register it in `dictionaries`.
 */
const en = {
  "nav.dashboard": "Dashboard",
  "nav.strategies": "Strategies",
  "nav.backtesting": "Backtesting",
  "nav.trading": "Trading",
  "nav.logs": "Logs",
  "nav.settings": "Settings",
  "common.na": "N/A",
  "common.retry": "Retry",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.paper": "Paper",
  "common.live": "Live",
} as const;

export type MessageKey = keyof typeof en;

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = { en };

let locale = "en";

export function setLocale(next: string): void {
  if (dictionaries[next]) locale = next;
}

export function t(key: MessageKey): string {
  return dictionaries[locale]?.[key] ?? en[key];
}
