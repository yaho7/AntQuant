import { t } from "@/lib/i18n";
import type { BrokerName, BrokerProfile, Task } from "@/types/api";

export const profilePath = (id: string) => `/profiles/${encodeURIComponent(id)}`;

export function providerLabel(provider: BrokerName) {
  return provider === "schwab" ? t("Charles Schwab") : "Alpaca";
}

export function profileLabel(profile: BrokerProfile) {
  return profile.name || [providerLabel(profile.provider), profile.account_hint].filter(Boolean).join(" ");
}

export function taskProfileLabel(task: Task, profiles: BrokerProfile[]) {
  const current = profiles.find((profile) => profile.id === task.config.broker_key);
  if (current) return profileLabel(current);
  const name = task.config.profile_name;
  return typeof name === "string" && name ? name : t("Unassigned account");
}

export function authorizationWarning(profile: BrokerProfile) {
  if (profile.authorization_expired) return "Schwab authorization expired. Reconnect in Settings.";
  if (profile.authorization_expires_at && Date.parse(profile.authorization_expires_at) - Date.now() <= 86_400_000) {
    return "Schwab authorization expires within 24 hours. Renew it to keep strategies connected.";
  }
  return null;
}
