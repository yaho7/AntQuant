import { Select } from "@/components/ui/primitives";
import { LOCALES, t, type Locale } from "@/lib/i18n";

export function LanguageSelect({ id, className, value, onChange }: {
  id?: string;
  className?: string;
  value: Locale;
  onChange: (locale: Locale) => void;
}) {
  return (
    <Select
      id={id}
      className={className}
      aria-label={t("Language")}
      value={value}
      onChange={(event) => onChange(event.target.value as Locale)}
    >
      {LOCALES.map(({ id, label, intl }) => (
        <option key={id} value={id} lang={intl}>{label}</option>
      ))}
    </Select>
  );
}
