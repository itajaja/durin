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
}

export interface SpendingResponse {
  granularity: "day" | "week" | "month" | "year";
  buckets: string[];
  series: SpendingSeries[];
  grand_total: number;
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

/** Window event dispatched by the top-bar refresh when a sync completes. */
export const REFRESHED_EVENT = "durin:refreshed";
