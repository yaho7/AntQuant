import {
  Activity,
  CandlestickChart,
  Eye,
  Languages,
  EyeOff,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { usePrivacy } from "@/hooks/usePrivacy";
import { type Theme, useTheme } from "@/hooks/useTheme";
import { getLocale, setLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: t("Dashboard"), icon: LayoutDashboard, end: true },
  { to: "/strategies", label: t("Strategies"), icon: Workflow },
  { to: "/backtesting", label: t("Backtesting"), icon: FlaskConical },
  { to: "/trading", label: t("Trading"), icon: CandlestickChart },
  { to: "/logs", label: t("Logs"), icon: ScrollText },
  { to: "/settings", label: t("Settings"), icon: Settings },
];

const NEXT_THEME: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };

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
      className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[18px]"
    >
      {children}
    </button>
  );
}

/** Icon rail on desktop, bottom tab bar on phones. */
export function AppLayout() {
  const { me, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const [privacy, togglePrivacy] = usePrivacy();
  const ThemeIcon = THEME_ICON[theme];
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-[76px] shrink-0 flex-col items-center gap-1 py-4 md:flex">
        <div className="mb-5 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground" title={t("LumiBot UI")}>
          <Activity className="size-5" />
        </div>
        <nav className="flex flex-col items-center gap-1" aria-label={t("Main")}>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                cn(
                  "group flex w-16 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "flex h-8 w-11 items-center justify-center rounded-full transition-colors group-hover:bg-accent",
                      isActive && "bg-card shadow-sm ring-1 ring-border",
                    )}
                  >
                    <Icon className="size-[18px]" />
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <RailButton label={privacy ? t("Show amounts") : t("Hide amounts")} onClick={togglePrivacy} pressed={privacy}>
            {privacy ? <EyeOff /> : <Eye />}
          </RailButton>
          <RailButton label={getLocale() === "zh" ? "English" : "中文"} onClick={() => setLocale(getLocale() === "zh" ? "en" : "zh")}>
            <Languages />
          </RailButton>
          <RailButton label={`Theme: ${theme}`} onClick={() => setTheme(NEXT_THEME[theme])}>
            <ThemeIcon />
          </RailButton>
          <RailButton label={`${t("Sign out")}${me ? ` (${me.username})` : ""}`} onClick={() => void logout()}>
            <LogOut />
          </RailButton>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur md:hidden">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="size-4" />
          </div>
          <span className="text-sm font-semibold">{t("LumiBot UI")}</span>
          <div className="ml-auto flex">
            <RailButton label={privacy ? t("Show amounts") : t("Hide amounts")} onClick={togglePrivacy} pressed={privacy}>
              {privacy ? <EyeOff /> : <Eye />}
            </RailButton>
            <RailButton label={getLocale() === "zh" ? "English" : "中文"} onClick={() => setLocale(getLocale() === "zh" ? "en" : "zh")}>
            <Languages />
          </RailButton>
          <RailButton label={`Theme: ${theme}`} onClick={() => setTheme(NEXT_THEME[theme])}>
              <ThemeIcon />
            </RailButton>
            <RailButton label={t("Sign out")} onClick={() => void logout()}>
              <LogOut />
            </RailButton>
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 pb-24 pt-6 sm:px-8 md:pb-10 md:pt-10">
          <Outlet />
        </main>
      </div>

      <nav
        className="fixed inset-x-3 bottom-3 z-40 flex justify-around rounded-2xl border bg-card/95 p-1.5 shadow-lg backdrop-blur md:hidden"
        aria-label={t("Main")}
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[10px] text-muted-foreground",
                isActive && "bg-accent text-foreground",
              )
            }
          >
            <Icon className="size-[18px]" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
