import { PlugZap } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, Delta } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Table, Td, Th } from "@/components/ui/primitives";
import { dateTime, money, num, pct, signedMoney } from "@/lib/format";
import type { Order, Position } from "@/types/api";

export function ConnectBrokerPrompt() {
  return (
    <EmptyState
      icon={PlugZap}
      title="No broker account connected"
      description="Account data comes straight from your broker. Add Alpaca paper keys in Settings to see equity, positions and orders here."
      action={
        <Button asChild>
          <Link to="/settings">Connect Alpaca</Link>
        </Button>
      }
    />
  );
}

export function PositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) return <EmptyState title="No open positions" />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th className="text-right">Qty</Th>
          <Th className="text-right">Avg entry</Th>
          <Th className="text-right">Price</Th>
          <Th className="text-right">Market value</Th>
          <Th className="text-right">Unrealized P&amp;L</Th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.symbol}>
            <Td className="font-medium">{p.symbol}</Td>
            <Td className="capitalize">{p.side}</Td>
            <Td className="num text-right">{num(p.quantity, 4)}</Td>
            <Td className="num text-right">{money(p.avg_entry_price)}</Td>
            <Td className="num text-right">{money(p.current_price)}</Td>
            <Td className="num text-right">{money(p.market_value)}</Td>
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
          <Th>Time</Th>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th>Type</Th>
          <Th>Status</Th>
          <Th className="text-right">Qty</Th>
          <Th className="text-right">Filled</Th>
          <Th className="text-right">Avg price</Th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <Td className="num text-muted-foreground">{dateTime(o.filled_at ?? o.submitted_at)}</Td>
            <Td className="font-medium">{o.symbol}</Td>
            <Td className="capitalize">{o.side}</Td>
            <Td className="capitalize">{o.type.replace(/_/g, " ")}</Td>
            <Td className="capitalize">{o.status.replace(/_/g, " ")}</Td>
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

export function AllocationBar({ positions, cash }: { positions: Position[]; cash: number }) {
  const slices = [
    ...positions
      .filter((p) => (p.market_value ?? 0) > 0)
      .map((p) => ({ label: p.symbol, value: p.market_value ?? 0 })),
    { label: "Cash", value: Math.max(cash, 0) },
  ].sort((a, b) => b.value - a.value);
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <EmptyState title="Nothing to allocate" />;
  const top = slices.slice(0, 6);
  const rest = slices.slice(6).reduce((s, x) => s + x.value, 0);
  if (rest > 0) top.push({ label: "Other", value: rest });
  const color = (label: string, i: number) =>
    label === "Cash" ? "var(--muted-foreground)" : `var(${SLICE_COLORS[i % SLICE_COLORS.length]})`;
  return (
    <div className="grid gap-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {top.map((s, i) => (
          <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: color(s.label, i) }} />
        ))}
      </div>
      <ul className="grid gap-1.5 text-sm">
        {top.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: color(s.label, i) }} />
            <span className="flex-1">{s.label}</span>
            <span className="num text-muted-foreground">{money(s.value, "USD", 0)}</span>
            <span className="num w-14 text-right font-medium">{pct(s.value / total, 1)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Long positions by market value. Short positions are not shown in this chart.
      </p>
    </div>
  );
}
