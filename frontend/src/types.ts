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
}

export interface TxnPage {
  items: Txn[];
  total: number;
  total_amount: number;
  page: number;
  page_size: number;
}

export interface SyncStatus {
  syncing: boolean;
  connections: Record<string, boolean>;
}
