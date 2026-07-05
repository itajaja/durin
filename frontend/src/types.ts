export interface User {
  id: number;
  email: string;
  name: string;
  picture: string;
}

export interface AuthConfig {
  google_enabled: boolean;
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
  org_name: string;
  currency: string;
  balance: string;
  available_balance: string | null;
  balance_date: number | null;
}

export interface CategoryRule {
  id: number;
  substring: string;
  match_type: "substring" | "payee";
}

export interface Category {
  id: number;
  name: string;
  emoji: string;
  color: string;
  is_transaction: boolean;
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
