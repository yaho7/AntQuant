import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import * as React from "react";
import { money, pct } from "@/lib/format";
import { intlLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Point } from "@/types/api";

export interface SeriesSpec {
  name: string;
  data: Point[];
  color: string; // CSS variable name, e.g. "--chart-1"
  kind?: "area" | "line";
}

type ValueFormat = "money" | "pct";

const RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "6M", days: 182 },
  { label: "1Y", days: 365 },
  { label: t("All"), days: 0 },
] as const;

/** Resolve a CSS variable (possibly oklch) to rgba() via a 1px canvas, for the chart engine. */
function cssColor(variable: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx || !raw) return `rgba(100,116,139,${alpha})`;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${alpha})`;
}

function toTime(s: string): Time {
  // Dates ("2024-01-02") are business days; datetimes become timestamps.
  if (s.length <= 10) return s as Time;
  return Math.floor(new Date(s).getTime() / 1000) as UTCTimestamp;
}

function useDarkMode(): boolean {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));
  React.useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function TimeSeriesChart({
  series,
  format = "money",
  height = 280,
  className,
  showRanges = true,
  minimal = false,
}: {
  series: SeriesSpec[];
  format?: ValueFormat;
  height?: number;
  className?: string;
  showRanges?: boolean;
  /** Hero style: no grid, no price axis, no legend. */
  minimal?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const dark = useDarkMode();
  const [legend, setLegend] = React.useState<{ time: string; values: (number | null)[] } | null>(
    null,
  );
  const [range, setRange] = React.useState<string>("All");
  const fmt = React.useCallback(
    (v: number | null | undefined) => (format === "pct" ? pct(v) : money(v)),
    [format],
  );

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = cssColor("--muted-foreground");
    const grid = cssColor("--border", 0.6);
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: grid, visible: !minimal } },
      rightPriceScale: { borderVisible: false, visible: !minimal },
      timeScale: { borderVisible: false, visible: !minimal },
      crosshair: { mode: CrosshairMode.Magnet },
      localization: { locale: intlLocale(), priceFormatter: (p: number) => fmt(p) },
      handleScale: true,
      handleScroll: true,
    });
    chartRef.current = chart;
    const apis: ISeriesApi<"Area" | "Line">[] = series.map((s) => {
      const line = cssColor(s.color);
      const api =
        s.kind === "line"
          ? chart.addSeries(LineSeries, { color: line, lineWidth: 2, priceLineVisible: false })
          : chart.addSeries(AreaSeries, {
              lineColor: line,
              topColor: cssColor(s.color, minimal ? 0.18 : 0.22),
              bottomColor: cssColor(s.color, 0),
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: !minimal,
            });
      api.setData(s.data.map((p) => ({ time: toTime(p.time), value: p.value })));
      return api;
    });
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setLegend(null);
        return;
      }
      const values = apis.map((api) => {
        const d = param.seriesData.get(api) as { value?: number } | undefined;
        return d?.value ?? null;
      });
      const t = param.time;
      const label =
        typeof t === "string"
          ? t
          : typeof t === "number"
            ? new Date(t * 1000).toLocaleString()
            : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
      setLegend({ time: label, values });
    });
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [series, height, dark, fmt, minimal]);

  const applyRange = (label: string, days: number) => {
    setRange(label);
    const chart = chartRef.current;
    const all = series[0]?.data ?? [];
    if (!chart || all.length === 0) return;
    if (!days) {
      chart.timeScale().fitContent();
      return;
    }
    const last = new Date(all[all.length - 1]!.time);
    const from = new Date(last.getTime() - days * 86400_000);
    const fromIdx = all.findIndex((p) => new Date(p.time) >= from);
    chart.timeScale().setVisibleRange({
      from: toTime(all[Math.max(0, fromIdx)]!.time),
      to: toTime(all[all.length - 1]!.time),
    });
  };

  const latest = series.map((s) => s.data[s.data.length - 1]?.value ?? null);
  const shown = legend?.values ?? latest;

  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2", minimal && "hidden")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {series.map((s, i) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: `var(${s.color})` }}
                aria-hidden
              />
              <span className="text-muted-foreground">{s.name}</span>
              <span className="num font-medium">{fmt(shown[i])}</span>
            </span>
          ))}
          {legend && <span className="num text-muted-foreground">{legend.time}</span>}
        </div>
        {showRanges && (
          <Segmented
            options={RANGES.map((r) => r.label)}
            value={range}
            onChange={(label) => applyRange(label, RANGES.find((r) => r.label === label)!.days)}
            ariaLabel={t("Time range")}
          />
        )}
      </div>
      <div ref={ref} style={{ height }} className="w-full min-w-0 overflow-hidden" />
    </div>
  );
}

/** Pill segmented control, used for period and range pickers. */
export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
  labels,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  labels?: Record<string, string>;
}) {
  return (
    <div className="inline-flex rounded-full bg-muted p-0.5" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={cn(
            "num h-7 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === o && "bg-background text-foreground shadow-sm",
          )}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}
