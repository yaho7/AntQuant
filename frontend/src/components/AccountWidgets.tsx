import { PlugZap } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, Delta } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Table, Td, Th } from "@/components/ui/primitives";
import { dateTime, money, num, pct, signedMoney } from "@/lib/format";
import type { Order, Position } from "@/types/api";
import { t } from "@/lib/i18n";

export function ConnectBrokerPrompt() {
  return (
    <EmptyState
      icon={PlugZap}
      title={t("No broker account connected")}
      description={t("Connect a broker in Settings to see equity, positions and orders here.")}
      action={
        <Button asChild>
          <Link to="/settings">{t("Connect broker")}</Link>
        </Button>
      }
    />
  );
}

export function PositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) return <EmptyState title={t("No open positions")} />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>{t("Symbol")}</Th>
          <Th>{t("Side")}</Th>
          <Th className="text-right">{t("Qty")}</Th>
          <Th className="text-right">{t("Avg entry")}</Th>
          <Th className="text-right">{t("Price")}</Th>
          <Th className="text-right">{t("Market value")}</Th>
          <Th className="text-right">{t("Unrealized P&L")}</Th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.symbol}>
            <Td className="font-medium">{p.symbol}</Td>
            <Td className="capitalize">{t(p.side.toLowerCase())}</Td>
            <Td className="num sensitive text-right">{num(p.quantity, 4)}</Td>
            <Td className="num text-right">{money(p.avg_entry_price)}</Td>
            <Td className="num text-right">{money(p.current_price)}</Td>
            <Td className="num sensitive text-right">{money(p.market_value)}</Td>
            <Td className="text-right">
              <Delta value={p.unrealized_pl}>
                {signedMoney(p.unrealized_pl)} ({pct(p.unrealized_plpc, 2, true)})
              </Delta>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function OrdersTable({ orders, empty }: { orders: Order[]; empty: string }) {
  if (orders.length === 0) return <EmptyState title={empty} />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>{t("Time")}</Th>
          <Th>{t("Symbol")}</Th>
          <Th>{t("Side")}</Th>
          <Th>{t("Type")}</Th>
          <Th>{t("Status")}</Th>
          <Th className="text-right">{t("Qty")}</Th>
          <Th className="text-right">{t("Filled")}</Th>
          <Th className="text-right">{t("Avg price")}</Th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <Td className="num text-muted-foreground">{dateTime(o.filled_at ?? o.submitted_at)}</Td>
            <Td className="font-medium">{o.symbol}</Td>
            <Td className="capitalize">{t(o.side.toLowerCase())}</Td>
            <Td className="capitalize">{t(o.type.toLowerCase().replace(/_/g, " "))}</Td>
            <Td className="capitalize">{t(o.status.toLowerCase().replace(/_/g, " "))}</Td>
            <Td className="num text-right">{num(o.quantity, 4)}</Td>
            <Td className="num text-right">{num(o.filled_quantity, 4)}</Td>
            <Td className="num text-right">{money(o.filled_avg_price)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const SLICE_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

interface AllocationSlice {
  id: string;
  label: string;
  value: number;
  color?: string;
}

export function AllocationBreakdown({ slices, currency }: { slices: AllocationSlice[]; currency: string }) {
  const ordered = slices.filter((slice) => slice.value > 0).sort((a, b) => b.value - a.value);
  const total = ordered.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return <EmptyState title={t("Nothing to allocate")} />;
  const top = ordered.slice(0, 6);
  const rest = ordered.slice(6).reduce((sum, slice) => sum + slice.value, 0);
  if (rest > 0) top.push({ id: "other", label: t("Other"), value: rest });
  const color = (slice: AllocationSlice, i: number) => `var(${slice.color ?? SLICE_COLORS[i % SLICE_COLORS.length]})`;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {top.map((slice, i) => (
          <div key={slice.id} className="min-w-0" style={{ flexGrow: slice.value, background: color(slice, i) }} />
        ))}
      </div>
      <ul className="grid gap-1.5 text-sm">
        {top.map((slice, i) => (
          <li key={slice.id} className="flex min-w-0 items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color(slice, i) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={slice.label}>{slice.label}</span>
            <span className="num sensitive shrink-0 text-muted-foreground">{money(slice.value, currency, 0)}</span>
            <span className="num w-14 shrink-0 text-right font-medium">{pct(slice.value / total, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AllocationBar({ positions, cash, currency = "USD" }: {
  positions: Position[];
  cash: number;
  currency?: string;
}) {
  const slices = [
    ...positions.map((position, i) => ({ id: `${position.symbol}:${i}`, label: position.symbol, value: position.market_value ?? 0 })),
    { id: "cash", label: t("Cash"), value: cash, color: "--muted-foreground" },
  ];
  return (
    <div className="grid gap-3">
      <AllocationBreakdown slices={slices} currency={currency} />
      <p className="text-xs text-muted-foreground">{t("Long positions by market value. Short positions are not shown in this chart.")}</p>
    </div>
  );
}
