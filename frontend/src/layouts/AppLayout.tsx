import {
  Activity,
  CandlestickChart,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/useAuth";
import { type Theme, useTheme } from "@/hooks/useTheme";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: t("nav.dashboard"), icon: LayoutDashboard, end: true },
  { to: "/strategies", label: t("nav.strategies"), icon: Workflow },
  { to: "/backtesting", label: t("nav.backtesting"), icon: FlaskConical },
  { to: "/trading", label: t("nav.trading"), icon: CandlestickChart },
  { to: "/logs", label: t("nav.logs"), icon: ScrollText },
  { to: "/settings", label: t("nav.settings"), icon: Settings },
];

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const opts: { v: Theme; icon: typeof Sun; label: string }[] = [
    { v: "light", icon: Sun, label: "Light theme" },
    { v: "dark", icon: Moon, label: "Dark theme" },
    { v: "system", icon: Monitor, label: "System theme" },
  ];
  return (
    <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label="Theme">
      {opts.map(({ v, icon: Icon, label }) => (
        <button
          key={v}
          aria-label={label}
          aria-pressed={theme === v}
          onClick={() => setTheme(v)}
          className={cn(
            "flex size-7 items-center justify-center rounded text-muted-foreground",
            theme === v && "bg-card text-foreground shadow-xs",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, logout } = useAuth();
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2 px-2 pt-1">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Activity className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">LumiBot UI</span>
        <Badge tone="info" className="ml-auto">
          Paper
        </Badge>
      </div>
      <nav className="grid gap-0.5" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                isActive && "bg-accent font-medium text-foreground",
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto grid gap-3 border-t pt-3">
        <div className="flex items-center justify-between px-1">
          <ThemeSwitch />
          <Button variant="ghost" size="sm" onClick={() => void logout()} title="Sign out">
            <LogOut /> <span className="sr-only sm:not-sr-only">Sign out</span>
          </Button>
        </div>
        {me && <p className="px-1 text-xs text-muted-foreground">Signed in as {me.username}</p>}
      </div>
    </div>
  );
}

export function AppLayout() {
  const [open, setOpen] = React.useState(false);
  const location = useLocation();
  React.useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-card md:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r bg-card">
            <button
              className="absolute right-3 top-3"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-card/90 px-3 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu />
          </Button>
          <span className="text-sm font-semibold">LumiBot UI</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
