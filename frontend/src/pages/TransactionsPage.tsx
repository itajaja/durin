import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate, formatMoney } from "../api";
import { Account, Connection, SyncStatus, Txn, TxnPage } from "../types";

type SortField = "posted" | "amount";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 50;

export default function TransactionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sort, setSort] = useState<SortField>("posted");
  const [dir, setDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<TxnPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);

  // Unmount / staleness guards: timers and in-flight fetches must neither
  // fire after unmount nor overwrite newer results with older ones.
  const alive = useRef(true);
  const pollTimer = useRef<number | null>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Filters reset the page *synchronously* in their handlers (below) rather
  // than via an effect — an effect-based reset would first fetch with the
  // new filter but the stale page number, wasting a full server-side query.

  const loadAccounts = useCallback(async () => {
    try {
      const accts = await api<Account[]>("/api/accounts");
      if (alive.current) setAccounts(accts);
    } catch {
      // ignore; the table still works without account names in the filter
    }
  }, []);

  const loadTxns = useCallback(async () => {
    const mySeq = ++fetchSeq.current;
    setLoading(true);
    const params = new URLSearchParams({
      sort,
      dir,
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    if (accountId) params.set("account_id", accountId);
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (debouncedQ) params.set("q", debouncedQ);
    try {
      const result = await api<TxnPage>(`/api/transactions?${params}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setData(result);
      setError("");
      // If the result set shrank (e.g. after a delete), don't strand the
      // user past the last page.
      const lastPage = Math.max(1, Math.ceil(result.total / result.page_size));
      if (result.items.length === 0 && result.total > 0 && page > lastPage) {
        setPage(lastPage);
      }
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load transactions");
    } finally {
      if (alive.current && mySeq === fetchSeq.current) setLoading(false);
    }
  }, [accountId, start, end, debouncedQ, sort, dir, page]);

  // The refresh poll chain outlives individual renders; give it the *latest*
  // loaders so it never reloads with stale filter values.
  const loadTxnsRef = useRef(loadTxns);
  const loadAccountsRef = useRef(loadAccounts);
  useEffect(() => {
    loadTxnsRef.current = loadTxns;
    loadAccountsRef.current = loadAccounts;
  }, [loadTxns, loadAccounts]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadTxns();
  }, [loadTxns]);

  const finishRefresh = useCallback(async () => {
    if (!alive.current) return;
    setSyncing(false);
    loadAccountsRef.current();
    loadTxnsRef.current();
    try {
      const conns = await api<Connection[]>("/api/connections");
      if (!alive.current) return;
      const bad = conns.filter(
        (c) => c.last_sync_status === "error" || c.last_sync_status === "partial"
      );
      if (bad.length > 0) {
        setError(
          `Sync problem with ${bad.map((c) => c.name).join(", ")} — details in Settings.`
        );
      }
    } catch {
      // connection status is best-effort here
    }
  }, []);

  const pollUntilDone = useCallback(
    (attempt: number) => {
      pollTimer.current = window.setTimeout(async () => {
        if (!alive.current) return;
        let stillSyncing = false;
        try {
          const status = await api<SyncStatus>("/api/sync/status");
          if (!alive.current) return;
          stillSyncing = status.syncing;
          if (stillSyncing && attempt < 150) {
            pollUntilDone(attempt + 1);
            return;
          }
        } catch {
          // fall through and refresh anyway
        }
        await finishRefresh();
        if (stillSyncing && alive.current) {
          setError(
            "Sync is still running in the background — data will keep updating. Check Settings for progress."
          );
        }
      }, 2000);
    },
    [finishRefresh]
  );

  const forceRefresh = async () => {
    setSyncing(true);
    setError("");
    try {
      const res = await api<{ total: number }>("/api/sync", { method: "POST", body: "{}" });
      if (res.total === 0) {
        setSyncing(false);
        setError("No SimpleFin connections yet — add one in Settings.");
        return;
      }
      pollUntilDone(0);
    } catch (err) {
      setSyncing(false);
      setError(err instanceof Error ? err.message : "Refresh failed");
    }
  };

  const toggleSort = (field: SortField) => {
    if (sort === field) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setDir(field === "posted" ? "desc" : "asc");
    }
    setPage(1);
  };

  const sortIndicator = (field: SortField) =>
    sort === field ? (dir === "asc" ? " ▲" : " ▼") : "";

  const clearFilters = () => {
    setAccountId("");
    setStart("");
    setEnd("");
    setQ("");
    setPage(1);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const hasFilters = accountId || start || end || q;

  // Net total only makes sense in a single currency: use the filtered
  // account's currency, or the common one when all accounts agree.
  const selectedAccount = accounts.find((a) => String(a.id) === accountId);
  const currencies = new Set(accounts.map((a) => a.currency));
  const netCurrency =
    selectedAccount?.currency ?? (currencies.size <= 1 ? accounts[0]?.currency : null);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Transactions</h2>
        <button className="btn btn-primary" onClick={forceRefresh} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh from banks"}
        </button>
      </div>

      <div className="filters">
        <label>
          Account
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.org_name ? `${a.org_name} — ${a.name}` : a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="grow">
          Search
          <input
            type="search"
            placeholder="Description, payee, memo…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {hasFilters && (
          <button className="btn btn-quiet" onClick={clearFilters}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {data && (
        <div className="summary muted">
          {data.total} transaction{data.total === 1 ? "" : "s"}
          {hasFilters ? " (filtered)" : ""}
          {netCurrency && (
            <>
              {" "}
              · net{" "}
              <strong className={data.total_amount < 0 ? "neg" : "pos"}>
                {formatMoney(String(data.total_amount), netCurrency)}
              </strong>
            </>
          )}
        </div>
      )}

      <table className="txn-table">
        <thead>
          <tr>
            <th className="sortable" onClick={() => toggleSort("posted")}>
              Date{sortIndicator("posted")}
            </th>
            <th>Account</th>
            <th>Description</th>
            <th className="sortable num" onClick={() => toggleSort("amount")}>
              Amount{sortIndicator("amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {loading && !data ? (
            <tr>
              <td colSpan={4} className="empty">
                Loading…
              </td>
            </tr>
          ) : data && data.items.length === 0 ? (
            <tr>
              <td colSpan={4} className="empty">
                {hasFilters
                  ? "No transactions match these filters."
                  : "No transactions yet. Add a SimpleFin connection in Settings, then refresh."}
              </td>
            </tr>
          ) : (
            data?.items.map((t: Txn) => (
              <tr key={t.id} className={t.pending ? "pending-row" : ""}>
                <td className="nowrap">{formatDate(t.posted)}</td>
                <td className="nowrap">
                  <span className="acct-name">{t.account_name}</span>
                  {t.org_name && <span className="muted small"> · {t.org_name}</span>}
                </td>
                <td>
                  {t.description || t.payee || "(no description)"}
                  {t.pending && <span className="badge">pending</span>}
                  {(t.payee || t.memo) && (
                    <div className="muted small">
                      {[t.payee, t.memo].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </td>
                <td className={`num nowrap ${t.amount < 0 ? "neg" : "pos"}`}>
                  {formatMoney(t.amount_str, t.currency)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {data && data.total > PAGE_SIZE && (
        <div className="pager">
          <button
            className="btn btn-quiet"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            ← Prev
          </button>
          <span className="muted">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn-quiet"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
