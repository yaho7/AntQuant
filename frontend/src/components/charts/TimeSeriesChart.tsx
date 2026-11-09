import {
  AreaSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type UTCTimestamp,
} from "lightweight-charts";
import { Minus, Plus, RotateCcw } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { money, pct } from "@/lib/format";
import { intlLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Point } from "@/types/api";

export interface SeriesSpec {
  name: string;
  data: Point[];
  color: string;
  kind?: "area" | "line";
}

type ValueFormat = "money" | "pct";
type ChartSeries = ISeriesApi<"Area" | "Line">;
type Observation = { time: UTCTimestamp; values: (number | null)[] };

const RANGES = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "6M", days: 182 },
  { label: "1Y", days: 365 },
  { label: "All", days: 0 },
] as const;

const DAY_SECONDS = 86400;

/** Resolve a theme token to a color understood by the canvas chart. */
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

function normalizedPoints(points: Point[]) {
  const values = new Map<UTCTimestamp, number>();
  for (const point of points) {
    const time = Math.floor(Date.parse(point.time) / 1000) as UTCTimestamp;
    if (Number.isFinite(time) && Number.isFinite(point.value)) values.set(time, point.value);
  }
  return values;
}

function fitRange(chart: IChartApi, times: UTCTimestamp[], label: string) {
  const days = RANGES.find((range) => range.label === label)?.days ?? 0;
  const last = times.at(-1);
  const first = last === undefined ? undefined : times.find((time) => time >= last - days * DAY_SECONDS);
  if (!days || first === undefined || last === undefined || first === last) chart.timeScale().fitContent();
  else chart.timeScale().setVisibleRange({ from: first, to: last });
}

function useDarkMode(): boolean {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));
  React.useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function TimeSeriesChart({
  series,
  format = "money",
  currency = "USD",
  height = 280,
  className,
  showRanges = true,
}: {
  series: SeriesSpec[];
  format?: ValueFormat;
  currency?: string;
  height?: number;
  className?: string;
  showRanges?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<{ chart: IChartApi; apis: ChartSeries[] } | null>(null);
  const dark = useDarkMode();
  const helpId = React.useId();
  const [observation, setObservation] = React.useState<Observation | null>(null);
  const [keyboardReading, setKeyboardReading] = React.useState("");
  const [range, setRange] = React.useState("All");
  const rangeRef = React.useRef("All");
  const data = React.useMemo(() => series.map((item) => normalizedPoints(item.data)), [series]);
  const times = React.useMemo(() => [...new Set(data.flatMap((values) => [...values.keys()]))]
    .sort((a, b) => a - b), [data]);
  const intraday = times.some((time) => time % DAY_SECONDS !== 0);
  const dateFormat = React.useMemo(() => new Intl.DateTimeFormat(intlLocale(), {
    dateStyle: "medium", timeStyle: intraday ? "short" : undefined, timeZone: "UTC",
  }), [intraday]);
  const fmt = React.useCallback(
    (v: number | null | undefined) => format === "pct" ? pct(v) : money(v, currency),
    [format, currency],
  );

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = cssColor("--muted-foreground");
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: cssColor("--border", 0.6) } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.13, bottom: 0.13 } },
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, minBarSpacing: 0.5 },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: cssColor("--muted-foreground", 0.45), style: LineStyle.Dashed, width: 1, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: { locale: intlLocale(), priceFormatter: fmt },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: false } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const apis = series.map((item, index) => {
      const line = cssColor(item.color);
      const shared = { lineWidth: 2 as const, priceLineVisible: false, lastValueVisible: false };
      const api = item.kind === "line"
        ? chart.addSeries(LineSeries, { ...shared, color: line })
        : chart.addSeries(AreaSeries, {
          ...shared, lineColor: line, topColor: cssColor(item.color, 0.22),
          bottomColor: cssColor(item.color, 0),
        });
      const values = data[index]!;
      api.setData(times.flatMap((time) => {
        const value = values.get(time);
        return value === undefined ? [] : [{ time, value }];
      }));
      return api;
    });
    chartRef.current = { chart, apis };
    fitRange(chart, times, rangeRef.current);
    chart.subscribeCrosshairMove(({ time }) => {
      setObservation(typeof time === "number" ? {
        time: time as UTCTimestamp, values: data.map((values) => values.get(time as UTCTimestamp) ?? null),
      } : null);
    });
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [series, data, times, height, dark, fmt, intraday]);

  function applyRange(label: string) {
    rangeRef.current = label;
    setRange(label);
    setObservation(null);
    setKeyboardReading("");
    const chart = chartRef.current?.chart;
    if (!chart) return;
    chart.clearCrosshairPosition();
    fitRange(chart, times, label);
  }

  function zoom(factor: number) {
    const scale = chartRef.current?.chart.timeScale();
    const visible = scale?.getVisibleLogicalRange();
    if (!scale || !visible || times.length < 3) return;
    const center = (visible.from + visible.to) / 2;
    const span = Math.min(times.length, Math.max(2, (visible.to - visible.from) * factor));
    const from = Math.max(-0.5, Math.min(center - span / 2, times.length - span - 0.5));
    scale.setVisibleLogicalRange({ from, to: from + span });
  }

  function inspect(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !times.length) return;
    const instance = chartRef.current;
    if (!instance) return;
    event.preventDefault();
    const current = observation ? times.indexOf(observation.time) : times.length - 1;
    const index = event.key === "Home" ? 0 : event.key === "End" ? times.length - 1
      : Math.max(0, Math.min(times.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1)));
    const time = times[index]!;
    const values = data.map((item) => item.get(time) ?? null);
    const first = values.findIndex((value) => value !== null);
    const scale = instance.chart.timeScale();
    const visible = scale.getVisibleLogicalRange();
    if (visible && (index < visible.from || index > visible.to)) {
      const offset = index < visible.from ? index - visible.from : index - visible.to;
      scale.setVisibleLogicalRange({ from: visible.from + offset, to: visible.to + offset });
    }
    if (first >= 0) instance.chart.setCrosshairPosition(values[first]!, time, instance.apis[first]!);
    setObservation({ time, values });
    setKeyboardReading([dateFormat.format(time * 1000), ...series.map((item, i) => `${item.name} ${fmt(values[i])}`)].join(", "));
  }

  const currentTime = observation?.time ?? times.at(-1);
  const values = observation?.values ?? data.map((item) => {
    const last = [...item.keys()].sort((a, b) => b - a)[0];
    return last === undefined ? null : item.get(last) ?? null;
  });

  return (
    <div className={cn("grid min-w-0 gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {series.map((item, i) => (
            <span key={item.name} className="inline-flex items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: `var(${item.color})` }} aria-hidden />
              <span className="text-muted-foreground">{item.name}</span>
              <span className="num sensitive font-medium">{fmt(values[i])}</span>
            </span>
          ))}
          {currentTime !== undefined && <span className="num text-muted-foreground">{dateFormat.format(currentTime * 1000)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" size="icon" variant="ghost" aria-label={t("Zoom in")} title={t("Zoom in")}
            disabled={times.length < 3} onClick={() => zoom(0.65)}><Plus /></Button>
          <Button type="button" size="icon" variant="ghost" aria-label={t("Zoom out")} title={t("Zoom out")}
            disabled={times.length < 3} onClick={() => zoom(1.5)}><Minus /></Button>
          <Button type="button" size="icon" variant="ghost" aria-label={t("Reset view")} title={t("Reset view")}
            onClick={() => applyRange("All")}><RotateCcw /></Button>
        </div>
      </div>
      <div role="region" tabIndex={0} aria-label={series.map((item) => item.name).join(", ")}
        aria-describedby={helpId} onKeyDown={inspect}
        onBlur={() => { chartRef.current?.chart.clearCrosshairPosition(); setObservation(null); }}
        className="min-w-0 rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
        <p id={helpId} className="sr-only">{t("Use the left and right arrow keys to inspect chart values.")}</p>
        <div role="status" className="sr-only">{keyboardReading}</div>
        <div ref={ref} style={{ height }} className="sensitive w-full min-w-0 overflow-hidden" aria-hidden />
      </div>
      {showRanges && <Segmented
        options={RANGES.map((item) => item.label)}
        labels={{ All: t("All") }}
        value={range}
        onChange={applyRange}
        ariaLabel={t("Time range")}
      />}
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
            "press-feedback num h-7 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === o && "bg-background text-foreground shadow-sm",
          )}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}
