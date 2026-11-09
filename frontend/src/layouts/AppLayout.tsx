import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CandlestickChart,
  Check,
  CircleUserRound,
  Eye,
  EyeOff,
  FlaskConical,
  Languages,
  Layers3,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { BrandIcon } from "@/components/BrandIcon";
import { useAuth } from "@/hooks/useAuth";
import { useProfiles } from "@/hooks/queries";
import { usePrivacy } from "@/hooks/usePrivacy";
import { type Theme, useTheme } from "@/hooks/useTheme";
import { getLocale, LOCALES, setLocale, t, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { profileLabel, profilePath } from "@/lib/profiles";
import { qs } from "@/services/api";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/strategies", label: "Strategies", icon: Workflow },
  { to: "/backtesting", label: "Backtesting", icon: FlaskConical },
  { to: "/trading", label: "Trading", icon: CandlestickChart },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

const NEXT_THEME: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };
const railButtonClass = "press-feedback flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[18px]";
const railMenuButtonClass = cn(railButtonClass, "data-[state=open]:bg-accent data-[state=open]:text-foreground");
const railNavClass = "press-feedback group flex w-16 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground";
const railNavIconClass = "flex h-8 w-11 items-center justify-center rounded-full transition-colors group-hover:bg-accent";

function RailButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={railButtonClass}
    >
      {children}
    </button>
  );
}

function LanguageMenu({ side }: { side: "right" | "bottom" }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={railMenuButtonClass}
        aria-label={t("Language")}
        title={t("Language")}
      >
        <Languages aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="language-menu z-50 min-w-32 rounded-xl border bg-card p-1 text-card-foreground shadow-md"
        >
          <DropdownMenu.RadioGroup value={getLocale()} onValueChange={(value) => setLocale(value as Locale)}>
            {LOCALES.map(({ id, label, intl }) => (
              <DropdownMenu.RadioItem
                key={id}
                value={id}
                lang={intl}
                className="flex min-h-9 cursor-default items-center justify-between gap-4 rounded-lg px-2.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                {label}
                <DropdownMenu.ItemIndicator><Check className="size-4" aria-hidden /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ProfileMenu({ profileId, mobile, trading }: {
  profileId: string | undefined;
  mobile?: boolean;
  trading: boolean;
}) {
  const { data } = useProfiles();
  const navigate = useNavigate();
  const profile = data?.profiles.find((item) => item.id === profileId);
  const current = profile ? profileLabel(profile) : t("All accounts");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={mobile ? railMenuButtonClass : cn(railNavClass, "data-[state=open]:text-foreground")}
        aria-label={t("Switch account: {account}", { account: current })}
        title={t("Switch account: {account}", { account: current })}
      >
        {mobile ? <CircleUserRound aria-hidden /> : (
          <>
            <span className={cn(railNavIconClass, "group-data-[state=open]:bg-accent")}>
              <CircleUserRound className="size-[18px]" aria-hidden />
            </span>
            {t("Accounts")}
          </>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={mobile ? "bottom" : "right"} align="start" sideOffset={8} collisionPadding={8}
          className="language-menu z-50 max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] min-w-48 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border bg-card p-1 text-card-foreground shadow-md">
          <DropdownMenu.RadioGroup value={profile?.id ?? ""}
            onValueChange={(id) => navigate(id ? `${profilePath(id)}${trading ? "/trading" : ""}` : "/")}>
            {[{ id: "", label: t("All accounts") }, ...(data?.profiles ?? []).map((item) => ({ id: item.id, label: profileLabel(item) }))].map(({ id, label }) => (
              <DropdownMenu.RadioItem key={id} value={id}
                className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2.5 text-sm outline-none data-[highlighted]:bg-accent">
                {id ? <CircleUserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  : <Layers3 className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <DropdownMenu.ItemIndicator><Check className="size-4 shrink-0" aria-hidden /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Icon rail on desktop, bottom tab bar on phones. */
export function AppLayout() {
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const profileId = useMatch("/profiles/:profileId/*")?.params.profileId ?? search.get("profile") ?? undefined;
  const accountPath = profileId ? profilePath(profileId) : "";
  const nav = NAV.map((item) => ({
    ...item,
    to: item.to === "/" ? accountPath || "/" : item.to === "/trading" ? `${accountPath}/trading`
      : `${item.to}${qs({ profile: profileId })}`,
  }));
  const { me, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const [privacy, togglePrivacy] = usePrivacy();
  const ThemeIcon = THEME_ICON[theme];
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-[76px] shrink-0 flex-col items-center gap-1 overflow-y-auto py-4 md:flex">
        <div className="mb-5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground" title={t("AntQuant")}>
          <BrandIcon className="size-6" />
        </div>
        <nav className="flex flex-col items-center gap-1" aria-label={t("Main")}>
          <ProfileMenu profileId={profileId} trading={pathname.endsWith("/trading")} />
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={t(label)}
              className={({ isActive }) =>
                cn(
                  railNavClass,
                  isActive && "text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      railNavIconClass,
                      isActive && "bg-card shadow-sm ring-1 ring-border",
                    )}
                  >
                    <Icon className="size-[18px]" />
                  </span>
                  {t(label)}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <RailButton label={privacy ? t("Show amounts") : t("Hide amounts")} onClick={togglePrivacy} pressed={privacy}>
            {privacy ? <EyeOff /> : <Eye />}
          </RailButton>
          <LanguageMenu side="right" />
          <RailButton label={t("Theme: {theme}", { theme: t(theme) })} onClick={() => setTheme(NEXT_THEME[theme])}>
            <ThemeIcon />
          </RailButton>
          <RailButton label={`${t("Sign out")}${me ? ` (${me.username})` : ""}`} onClick={() => void logout()}>
            <LogOut />
          </RailButton>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur md:hidden">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BrandIcon className="size-5" />
          </div>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("AntQuant")}</span>
          <div className="flex shrink-0 items-center">
            <ProfileMenu profileId={profileId} mobile trading={pathname.endsWith("/trading")} />
            <RailButton label={privacy ? t("Show amounts") : t("Hide amounts")} onClick={togglePrivacy} pressed={privacy}>
              {privacy ? <EyeOff /> : <Eye />}
            </RailButton>
            <LanguageMenu side="bottom" />
            <RailButton label={t("Theme: {theme}", { theme: t(theme) })} onClick={() => setTheme(NEXT_THEME[theme])}>
              <ThemeIcon />
            </RailButton>
            <RailButton label={t("Sign out")} onClick={() => void logout()}>
              <LogOut />
            </RailButton>
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 pb-24 pt-6 sm:px-8 md:pb-10 md:pt-10">
          <div className="view-enter" key={pathname}>
            <Outlet />
          </div>
        </main>
      </div>

      <nav
        className="fixed inset-x-3 bottom-3 z-40 flex justify-around rounded-2xl border bg-card/95 p-1.5 shadow-lg backdrop-blur md:hidden"
        aria-label={t("Main")}
      >
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "press-feedback flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px] text-muted-foreground",
                isActive && "bg-accent text-foreground",
              )
            }
          >
            <Icon className="size-[18px]" />
            {t(label)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
