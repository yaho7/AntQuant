export type TaskStatus = "pending" | "starting" | "running" | "completed" | "failed" | "stopped";

export interface Task {
  id: string;
  kind: "backtest" | "trading";
  mode: "backtest" | "paper" | "live";
  status: TaskStatus;
  strategy_id: number | null;
  strategy_name: string;
  strategy_version: number | null;
  config: Record<string, unknown>;
  paused: boolean;
  pid: number | null;
  progress: number | null;
  exit_code: number | null;
  error_message: string | null;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Heartbeat {
  time: string;
  paused: boolean;
  portfolio_value: number | null;
  cash: number | null;
}

export interface TradingTask extends Task {
  heartbeat: Heartbeat | null;
}

export type Params = Record<string, unknown>;

export interface Strategy {
  id: number;
  name: string;
  description: string;
  source_path: string;
  class_name: string;
  parameters: Params;
  version: number;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
  trading_task?: Task | null;
}

export interface DiscoveredStrategy {
  file: string;
  root: "examples" | "user";
  source_path: string;
  class_name: string;
  docstring: string;
  parameters: Params;
  parameters_parsed: boolean;
  sha256: string;
}

export interface StrategyVersion {
  version: number;
  name: string;
  description: string;
  parameters: Params;
  source_path: string;
  class_name: string;
  code_sha256: string;
  note: string;
  created_at: string | null;
}

export interface Metrics {
  total_return: number | null;
  annualized_return: number | null;
  sharpe_ratio: number | null;
  max_drawdown: number | null;
  volatility: number | null;
  win_rate: number | null;
  profit_factor: number | null;
  number_of_trades: number | null;
  closed_trades: number | null;
  starting_value: number | null;
  ending_value: number | null;
}

export interface Backtest extends Task {
  metrics: Metrics | null;
  files?: Record<string, string>;
}

export interface Point {
  time: string;
  value: number;
}

export interface Fill {
  time: string;
  symbol: string;
  asset_type?: string;
  side: string;
  quantity: number;
  price: number;
  multiplier?: number;
  fee?: number;
  order_type?: string;
  task_id?: string;
}

export interface BacktestResult {
  metrics: Metrics;
  notes: Record<string, string>;
  equity_curve: Point[];
  drawdown_curve: Point[];
  trades: Fill[];
  files: Record<string, string>;
}

export interface DataSource {
  id: string;
  label: string;
  lumibot_class: string;
  requires_alpaca_keys: boolean;
  note: string;
  available: boolean;
}

export interface BacktestDefaults {
  data_source: string;
  budget: number;
  benchmark: string;
}

export interface Account {
  broker: string;
  account_id: string;
  paper: boolean;
  status: string;
  currency: string;
  equity: number;
  cash: number;
  buying_power: number;
  last_equity: number | null;
  long_market_value: number | null;
  short_market_value: number | null;
  trading_blocked: boolean;
  daily_pnl: number | null;
  daily_pnl_pct: number | null;
}

export interface AccountSummary {
  connected: boolean;
  account: Account | null;
  error: string | null;
}

export interface Position {
  symbol: string;
  asset_class: string;
  side: string;
  quantity: number;
  avg_entry_price: number | null;
  current_price: number | null;
  market_value: number | null;
  cost_basis: number | null;
  unrealized_pl: number | null;
  unrealized_plpc: number | null;
}

export interface Order {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  quantity: number | null;
  filled_quantity: number | null;
  limit_price: number | null;
  stop_price: number | null;
  filled_avg_price: number | null;
  submitted_at: string | null;
  filled_at: string | null;
}

export interface EquityPoint {
  time: string;
  equity: number;
  profit_loss: number | null;
}

export type BrokerName = "alpaca" | "schwab";

export interface SchwabStatus {
  configured: boolean;
  endpoint: string;
  account_hint: string | null;
  callback_url: string | null;
  authorization_expires_at: string | null;
  authorization_expired: boolean;
}

export interface AlpacaStatus {
  configured: boolean;
  api_key_hint: string | null;
  endpoint: string | null;
  paper: boolean;
}

export interface SystemStatus {
  ui_version: string;
  lumibot_version: string | null;
  lumibot_verified: boolean;
  broker: { name: BrokerName; configured: boolean; paper?: boolean };
  uptime_seconds: number;
  active_tasks: Task[];
  events: { time: string; level: string; source: string; message: string }[];
}

export interface SystemInfo {
  ui_version: string;
  lumibot_version: string | null;
  verified_lumibot_versions: string[];
  python: string;
  platform: string;
  data_dir: string;
  disk_free_bytes: number;
  disk_total_bytes: number;
  task_count: number;
  uptime_seconds: number;
  live_trading_available: boolean;
}

export interface CompatReport {
  ok: boolean;
  version: string | null;
  verified: boolean;
  verified_versions: string[];
  checks: { name: string; ok: boolean; detail: string }[];
  error?: string;
}

export interface UpdateInfo {
  lumibot: { installed: string | null; latest: string | null; error: string | null };
  ui: { installed: string; latest: string | null; error: string | null };
}

export interface SettingsView {
  settings: {
    backtest_defaults: BacktestDefaults;
    backtest_timeout_minutes: number;
    max_concurrent_backtests: number;
    log_retention_days: number;
  };
  active_broker: BrokerName;
  alpaca: AlpacaStatus;
  schwab: SchwabStatus;
}

export interface LogEntry {
  time: string | null;
  level: string;
  logger: string;
  message: string;
}

export interface LogSource {
  id: string;
  label: string;
  group: string;
  status?: TaskStatus;
  strategy_id?: number | null;
}

export interface AuditEntry {
  time: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  ip: string;
  success: boolean;
}
