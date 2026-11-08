import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Inbox,
  Loader2,
  Minus,
  PauseCircle,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Badge, Card, Input, Skeleton } from "@/components/ui/primitives";
import { direction, NA } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/types/api";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingState({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("grid gap-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <Icon className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <AlertTriangle className="size-7 text-loss" />
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="max-w-lg break-words text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          Retry
        </Button>
      )}
    </div>
  );
}

/** Wraps a query: skeleton while loading, error with retry, then content. */
export function QueryBoundary<T>({
  query,
  rows,
  children,
}: {
  query: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  rows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isLoading) return <LoadingState rows={rows} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return <LoadingState rows={rows} />;
  return <>{children(query.data)}</>;
}

/** A gain/loss value with an arrow and sign, so meaning does not depend on colour. */
export function Delta({
  value,
  children,
  className,
}: {
  value: number | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  const dir = direction(value);
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-0.5",
        dir === "up" && "text-gain",
        dir === "down" && "text-loss",
        dir === "none" && "text-muted-foreground",
        className,
      )}
    >
      {dir !== "none" && <Icon className="size-3.5 shrink-0" aria-hidden />}
      <span>{children}</span>
      <span className="sr-only">{dir === "up" ? "gain" : dir === "down" ? "loss" : ""}</span>
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-28" />
      ) : (
        <p className="num mt-1 text-xl font-semibold tracking-tight">{value ?? NA}</p>
      )}
      {sub && <div className="mt-1 text-xs">{sub}</div>}
    </Card>
  );
}

const statusTone: Record<TaskStatus, "neutral" | "info" | "gain" | "loss" | "warning"> = {
  pending: "neutral",
  starting: "info",
  running: "info",
  completed: "gain",
  failed: "loss",
  stopped: "neutral",
};

const statusIcon = {
  pending: CircleDashed,
  starting: Loader2,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  stopped: CircleSlash,
};

export function StatusBadge({ status, paused }: { status: TaskStatus; paused?: boolean }) {
  if (paused && (status === "running" || status === "starting")) {
    return (
      <Badge tone="warning">
        <PauseCircle /> Paused
      </Badge>
    );
  }
  const Icon = statusIcon[status];
  return (
    <Badge tone={statusTone[status]}>
      <Icon className={cn((status === "running" || status === "starting") && "animate-spin")} />
      {status[0]!.toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  if (mode === "live") return <Badge tone="loss">LIVE</Badge>;
  if (mode === "paper") return <Badge tone="info">Paper</Badge>;
  return <Badge>Backtest</Badge>;
}

/** Confirmation dialog. With `phrase`, the user must type it to enable the button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  phrase,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  phrase?: string;
  loading?: boolean;
  onConfirm: (typed: string) => void;
  children?: React.ReactNode;
}) {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const ok = !phrase || typed === phrase;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {children}
        {phrase && (
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="confirm-phrase">
              Type <span className="font-mono font-semibold text-foreground">{phrase}</span> to
              confirm
            </label>
            <Input
              id="confirm-phrase"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!ok}
            loading={loading}
            onClick={() => onConfirm(typed)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
