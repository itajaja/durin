export interface User {
  id: number;
  email: string;
  name: string;
  picture: string;
}

export interface AuthConfig {
  google_enabled: boolean;
  magic_link_enabled: boolean;
  dev_login_enabled: boolean;
}

export interface Connection {
  id: number;
  name: string;
  created_at: number;
  last_sync_at: number | null;
  last_success_at: number | null;
  last_sync_status: "never" | "ok" | "partial" | "error";
  last_sync_error: string;
  syncing: boolean;
  account_count: number;
}

export interface Account {
  id: number;
  connection_id: number;
  name: string;
  /** User-chosen display name; when set it replaces `name` everywhere
   * except the Settings page. */
  alias: string;
  org_name: string;
  currency: string;
  balance: string;
  available_balance: string | null;
  balance_date: number | null;
  /** Turned-off accounts only appear on the Settings page; their data is
   * deleted and sync skips them until turned back on. */
  enabled: boolean;
}

export interface CategoryRule {
  id: number;
  substring: string;
  /** "payee" and "description" match their field exactly (a vendor's
   * automatic category); "substring" matches anywhere in the text. */
  match_type: "substring" | "payee" | "description";
}

export interface Category {
  id: number;
  name: string;
  emoji: string;
  color: string;
  /** Not real spending (transfers, card payments): excluded from Spending
   * and from Cash flow entirely. */
  is_transaction: boolean;
  /** Real income (salary…): excluded from Spending; the only thing Cash
   * flow counts as income. */
  is_income: boolean;
  txn_count: number;
  rules: CategoryRule[];
}

export interface CategoriesResponse {
  categories: Category[];
  uncategorized_count: number;
}

export interface PreviewTxn {
  id: number;
  posted: number;
  description: string;
  amount_str: string;
  currency: string;
}

export interface PreviewResponse {
  count: number;
  sample: PreviewTxn[];
}

export interface SpendingSeries {
  key: string;
  category_id: number | null;
  name: string;
  emoji: string;
  color: string;
  values: number[];
  total: number;
  avg_month: number;
}

export interface SpendingResponse {
  granularity: "day" | "week" | "month" | "year";
  buckets: string[];
  series: SpendingSeries[];
  grand_total: number;
  grand_avg_month: number;
}

export interface CashflowResponse {
  granularity: "day" | "week" | "month" | "year";
  buckets: string[];
  income: number[];
  spending: number[];
  net: number[];
  total_income: number;
  total_spending: number;
  total_net: number;
  avg_income_month: number;
  avg_spending_month: number;
  avg_net_month: number;
}

export interface AssetPoint {
  day: string; // YYYY-MM-DD
  balance: number;
}

export interface AssetAccount {
  id: number;
  name: string;
  org_name: string;
  currency: string;
  balance: string;
  balance_date: number | null;
  points: AssetPoint[];
}

export interface AssetsResponse {
  accounts: AssetAccount[];
}

export interface Txn {
  id: number;
  account_id: number;
  account_name: string;
  org_name: string;
  currency: string;
  posted: number;
  amount: number;
  amount_str: string;
  description: string;
  payee: string;
  memo: string;
  pending: boolean;
  category_id: number | null;
  category_manual: boolean;
  edited: boolean;
}

export interface TxnPage {
  items: Txn[];
  total: number;
  total_amount: number;
  total_spend: number;
  total_income: number;
  page: number;
  page_size: number;
}

export interface Vendor {
  /** Server-side group identity ("source:lowercased name"). */
  key: string;
  name: string;
  /** Which field the vendor name came from; "none" is the pseudo-vendor
   * for transactions with neither payee nor description (no rule
   * management for it). */
  source: "payee" | "description" | "none";
  count: number;
  total: number;
  spend: number;
  income: number;
  avg_month: number;
  /** The vendor's own exact rule, when one exists — the thing the page
   * edits and removes. Categories inherited from substring rules are not
   * reported. */
  rule_id: number | null;
  rule_category_id: number | null;
}

export interface VendorsResponse {
  vendors: Vendor[];
  months_span: number;
}

export interface SyncStatus {
  syncing: boolean;
  connections: Record<string, boolean>;
}

export const UNCATEGORIZED_COLOR = "#9b998e";

/** Category color palette (validated for the spending chart: lightness band
 * and chroma floor pass; the neutral gray is deliberate for not-spending
 * categories). Ordered so neighboring swatches stay distinguishable. */
export const CATEGORY_COLORS = [
  "#2a78d6", // blue
  "#eda100", // amber
  "#008300", // green
  "#e34948", // red
  "#00a3d8", // cyan
  "#93379f", // plum
  "#66a61e", // chartreuse
  "#e87ba4", // pink
  "#0aa08c", // teal
  "#a5692c", // brown
  "#4a3aa7", // indigo
  "#e88a83", // salmon
  "#1baf7a", // emerald
  "#b02e63", // raspberry
  "#4b6cb0", // slate blue
  "#eb6834", // orange
  "#8a6fd1", // lavender
  "#85871f", // olive
  "#8a8984", // gray (for transfers / not-spending)
  "#c98500", // gold
];

/** Window event dispatched by the top-bar refresh when a sync completes. */
export const REFRESHED_EVENT = "durin:refreshed";
