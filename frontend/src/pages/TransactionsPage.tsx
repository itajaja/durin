import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatDate } from "../api";
import DatePresets from "../components/DatePresets";
import Money, { useMoney } from "../components/Money";
import MultiSelect from "../components/MultiSelect";
import {
  Account,
  CategoriesResponse,
  Category,
  REFRESHED_EVENT,
  Txn,
  TxnPage,
} from "../types";

type SortField = "posted" | "amount";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 50;

export default function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Snapshot of the URL at mount: it seeds the initial state, then the URL
  // follows the state (replace, no history spam).
  const urlInit = useRef({
    accounts: searchParams.get("accounts"),
    cats: searchParams.get("cats"),
    from: searchParams.get("from") ?? "",
    to: searchParams.get("to") ?? "",
    q: searchParams.get("q") ?? "",
    sort: searchParams.get("sort"),
    dir: searchParams.get("dir"),
  });

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // Accounts: empty set = no filter (all).
  const [accountIds, setAccountIds] = useState<Set<string>>(
    () => new Set(urlInit.current.accounts?.split(",").filter(Boolean) ?? [])
  );
  // Categories use the facet model: every key ("none" + ids) starts
  // selected; null until the category list loads.
  const [categoryKeys, setCategoryKeys] = useState<Set<string> | null>(null);
  const knownCatKeys = useRef<Set<string>>(new Set());
  const [start, setStart] = useState(urlInit.current.from);
  const [end, setEnd] = useState(urlInit.current.to);
  const [q, setQ] = useState(urlInit.current.q);
  const [debouncedQ, setDebouncedQ] = useState(urlInit.current.q);
  const [sort, setSort] = useState<SortField>(
    urlInit.current.sort === "amount" ? "amount" : "posted"
  );
  const [dir, setDir] = useState<SortDir>(urlInit.current.dir === "asc" ? "asc" : "desc");

  const [items, setItems] = useState<Txn[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    net: number;
    spend: number;
    income: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchCategory, setBatchCategory] = useState<string>("none");
  const [batchBusy, setBatchBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [addRuleBusy, setAddRuleBusy] = useState(false);
  const addRuleRef = useRef<HTMLDivElement | null>(null);
  // Inline pickers: change one row's category (chip) or create a payee rule.
  const [picker, setPicker] = useState<
    { kind: "chip" | "payee"; txnId: number; payee?: string } | null
  >(null);
  const { maskText } = useMoney();

  const alive = useRef(true);
  const fetchSeq = useRef(0);
  const itemsLenRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const categoriesRef = useRef<Category[]>([]);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);
  useEffect(() => {
    itemsLenRef.current = items.length;
  }, [items]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Close the add-substring popover on outside click / Escape.
  useEffect(() => {
    if (!addRuleOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addRuleRef.current && !addRuleRef.current.contains(e.target as Node)) {
        setAddRuleOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddRuleOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addRuleOpen]);

  // Close the inline row pickers on outside click / Escape.
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".inline-pop")) setPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [picker]);

  // Change one transaction's category in place (marked manual server-side).
  const setRowCategory = async (txnId: number, categoryId: number | null) => {
    setPicker(null);
    try {
      const updated = await api<Txn>(`/api/transactions/${txnId}`, {
        method: "PATCH",
        body: JSON.stringify({ category_id: categoryId }),
      });
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      loadMeta();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the category");
    }
  };

  // Create a payee-match rule from a row's payee.
  const addPayeeRule = async (payee: string, cat: Category) => {
    setPicker(null);
    setError("");
    try {
      const res = await api<{ categorized: number }>(`/api/categories/${cat.id}/rules`, {
        method: "POST",
        body: JSON.stringify({ substring: payee, match_type: "payee" }),
      });
      setNotice(
        `Payee "${payee}" now maps to ${cat.name} — categorized ${res.categorized} transaction${
          res.categorized === 1 ? "" : "s"
        }.`
      );
      loadMeta();
      loadFresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the payee rule");
    }
  };

  // Initialize the facet selection to "everything" once categories load;
  // afterwards drop dead keys and auto-include newly created categories
  // only while the selection still means "all".
  useEffect(() => {
    if (categories.length === 0) return;
    const valid = new Set(["none", ...categories.map((c) => String(c.id))]);
    const prevKnown = knownCatKeys.current;
    knownCatKeys.current = valid;
    setCategoryKeys((prev) => {
      if (prev === null) {
        // First hydration: honor a subset carried in the URL.
        const fromUrl = urlInit.current.cats;
        if (fromUrl != null) {
          if (fromUrl === "~") return new Set();
          return new Set(fromUrl.split(",").filter((k) => valid.has(k)));
        }
        return new Set(valid);
      }
      const wasAll = [...prevKnown].every((k) => prev.has(k));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      if (wasAll) {
        for (const k of valid) next.add(k);
      }
      return next;
    });
  }, [categories]);

  const allCatKeys =
    categories.length > 0 ? ["none", ...categories.map((c) => String(c.id))] : [];
  const allCatsSelected =
    categoryKeys === null || allCatKeys.every((k) => categoryKeys.has(k));
  const accountsKey = [...accountIds].sort().join(",");
  const categoriesKey =
    categoryKeys === null || allCatsSelected ? "" : [...categoryKeys].sort().join(",");
  const noCatsSelected = categoryKeys !== null && categoryKeys.size === 0;

  // Mirror the state into the URL so reloads and shared links restore it.
  useEffect(() => {
    if (categoryKeys === null && urlInit.current.cats != null) return; // not hydrated yet
    const p = new URLSearchParams();
    if (accountsKey) p.set("accounts", accountsKey);
    if (categoryKeys !== null && !allCatsSelected) {
      p.set("cats", categoryKeys.size === 0 ? "~" : [...categoryKeys].sort().join(","));
    }
    if (start) p.set("from", start);
    if (end) p.set("to", end);
    if (debouncedQ) p.set("q", debouncedQ);
    if (sort !== "posted" || dir !== "desc") {
      p.set("sort", sort);
      p.set("dir", dir);
    }
    setSearchParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, categoriesKey, allCatsSelected, start, end, debouncedQ, sort, dir]);

  const loadMeta = useCallback(async () => {
    try {
      const accts = await api<Account[]>("/api/accounts");
      if (alive.current) setAccounts(accts);
    } catch {
      // the table still works without account names
    }
    try {
      const cats = await api<CategoriesResponse>("/api/categories");
      if (alive.current) setCategories(cats.categories);
    } catch {
      // the table still works without the category filter
    }
  }, []);

  const buildParams = useCallback(
    (page: number) => {
      const params = new URLSearchParams({
        sort,
        dir,
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      if (accountsKey) params.set("accounts", accountsKey);
      if (categoriesKey) params.set("categories", categoriesKey);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (debouncedQ) params.set("q", debouncedQ);
      return params;
    },
    [accountsKey, categoriesKey, start, end, debouncedQ, sort, dir]
  );

  const loadFresh = useCallback(async () => {
    const mySeq = ++fetchSeq.current;
    if (noCatsSelected) {
      // Everything was ×'d out of the category facet: nothing can match.
      setItems([]);
      setSummary({ total: 0, net: 0, spend: 0, income: 0 });
      setHasMore(false);
      setSelected(new Set());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api<TxnPage>(`/api/transactions?${buildParams(1)}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setItems(result.items);
      setSummary({
        total: result.total,
        net: result.total_amount,
        spend: result.total_spend,
        income: result.total_income,
      });
      setHasMore(result.items.length < result.total);
      setSelected(new Set());
      setEditingId(null);
      setError("");
      // Rows can reference categories this page hasn't seen yet.
      const known = new Set(categoriesRef.current.map((c) => c.id));
      if (result.items.some((t) => t.category_id != null && !known.has(t.category_id))) {
        loadMeta();
      }
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load transactions");
    } finally {
      if (alive.current && mySeq === fetchSeq.current) setLoading(false);
    }
  }, [buildParams, loadMeta, noCatsSelected]);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || !hasMore) return;
    const mySeq = fetchSeq.current;
    setLoadingMore(true);
    try {
      // Derive the page from how many rows are loaded: after in-place
      // deletes the server offsets shift, and refetching the boundary page
      // (deduped below) picks up shifted-in rows instead of skipping them.
      const next = Math.floor(itemsLenRef.current / PAGE_SIZE) + 1;
      const result = await api<TxnPage>(`/api/transactions?${buildParams(next)}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        const merged = [...prev, ...result.items.filter((t) => !seen.has(t.id))];
        // Stop when the server runs out OR a fetch makes no progress (both
        // can happen when rows shift under us) — otherwise the sentinel
        // would refetch the same page forever. A top-bar refresh re-syncs.
        setHasMore(merged.length > prev.length && merged.length < result.total);
        return merged;
      });
    } catch {
      // transient; the sentinel will retry on the next intersection
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [buildParams, hasMore, loading, loadingMore]);

  const loadMoreRef = useRef(loadMore);
  const loadFreshRef = useRef(loadFresh);
  useEffect(() => {
    loadMoreRef.current = loadMore;
    loadFreshRef.current = loadFresh;
  }, [loadMore, loadFresh]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadFresh();
  }, [loadFresh]);

  // Top-bar refresh finished a sync: reload everything.
  useEffect(() => {
    const onRefreshed = () => {
      loadMeta();
      loadFreshRef.current();
    };
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [loadMeta]);

  // Infinite scroll: a callback ref keeps the observer attached to the
  // *current* sentinel row, which unmounts and remounts as hasMore flips.
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "600px" }
    );
    return () => observerRef.current?.disconnect();
  }, []);

  const sentinelRef = useCallback((node: HTMLTableRowElement | null) => {
    observerRef.current?.disconnect();
    if (node) observerRef.current?.observe(node);
  }, []);

  const toggleSort = (field: SortField) => {
    if (sort === field) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setDir(field === "posted" ? "desc" : "asc");
    }
  };

  const sortIndicator = (field: SortField) =>
    sort === field ? (dir === "asc" ? " ▲" : " ▼") : "";

  const clearFilters = () => {
    setAccountIds(new Set());
    setCategoryKeys(new Set(allCatKeys));
    setStart("");
    setEnd("");
    setQ("");
  };

  const hasFilters =
    accountIds.size > 0 || !allCatsSelected || Boolean(start || end || q);
  const categoriesById = new Map(categories.map((c) => [c.id, c]));

  // Summary currency: the one shared by the accounts in view (the selected
  // subset when the account filter is active), else USD.
  const accountsInView =
    accountIds.size > 0 ? accounts.filter((a) => accountIds.has(String(a.id))) : accounts;
  const viewCurrencies = new Set(accountsInView.map((a) => a.currency));
  const summaryCurrency =
    viewCurrencies.size === 1 && accountsInView.length > 0
      ? accountsInView[0].currency
      : "USD";

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allLoadedSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const toggleSelectAll = () => {
    setSelected(allLoadedSelected ? new Set() : new Set(items.map((t) => t.id)));
  };

  // Remove rows in place (batch delete / row delete) so a deep scroll
  // position survives; the summary is adjusted exactly from the removed
  // amounts instead of refetching.
  const removeRows = useCallback((ids: Set<number>) => {
    setItems((prev) => {
      const removed = prev.filter((t) => ids.has(t.id));
      setSummary((s) =>
        s
          ? {
              total: s.total - removed.length,
              net: s.net - removed.reduce((a, t) => a + t.amount, 0),
              spend:
                s.spend - removed.reduce((a, t) => a + (t.amount < 0 ? -t.amount : 0), 0),
              income:
                s.income - removed.reduce((a, t) => a + (t.amount > 0 ? t.amount : 0), 0),
            }
          : s
      );
      return prev.filter((t) => !ids.has(t.id));
    });
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  // Turn the current search text into a substring rule on the chosen
  // category (applies to uncategorized transactions, like any new rule).
  const addSearchAsRule = async (cat: Category) => {
    const substring = debouncedQ.trim();
    if (!substring) return;
    setAddRuleBusy(true);
    setError("");
    try {
      const res = await api<{ categorized: number }>(`/api/categories/${cat.id}/rules`, {
        method: "POST",
        body: JSON.stringify({ substring }),
      });
      setNotice(
        `Added "${substring}" to ${cat.name} — categorized ${res.categorized} transaction${
          res.categorized === 1 ? "" : "s"
        }.`
      );
      setAddRuleOpen(false);
      loadMeta();
      loadFresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the substring");
    } finally {
      setAddRuleBusy(false);
    }
  };

  const runBatch = async (action: "delete" | "categorize") => {
    if (selected.size === 0) return;
    if (
      action === "delete" &&
      !window.confirm(`Delete ${selected.size} transaction${selected.size === 1 ? "" : "s"}?`)
    ) {
      return;
    }
    setBatchBusy(true);
    setError("");
    try {
      const ids = new Set(selected);
      const body: Record<string, unknown> = { ids: [...ids], action };
      const newCat = batchCategory === "none" ? null : Number(batchCategory);
      if (action === "categorize") {
        body.category_id = newCat;
      }
      const res = await api<{ affected: number }>("/api/transactions/batch", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (action === "delete") {
        removeRows(ids);
        setNotice(`Deleted ${res.affected} transaction${res.affected === 1 ? "" : "s"}.`);
      } else {
        setItems((prev) =>
          prev.map((t) =>
            ids.has(t.id) ? { ...t, category_id: newCat, category_manual: true } : t
          )
        );
        setSelected(new Set());
        setNotice(`Categorized ${res.affected} transaction${res.affected === 1 ? "" : "s"}.`);
      }
      loadMeta();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch action failed");
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Transactions</h2>
      </div>

      <div className="filters">
        <MultiSelect
          label="Accounts"
          allLabel="All accounts"
          options={accounts.map((a) => ({
            value: String(a.id),
            label: a.org_name ? `${a.org_name} — ${a.name}` : a.name,
          }))}
          selected={accountIds}
          onChange={setAccountIds}
        />
        <MultiSelect
          facet
          label="Categories"
          allLabel="All categories"
          options={[
            { value: "none", label: "Uncategorized", color: "#9b998e" },
            ...categories.map((c) => ({
              value: String(c.id),
              label: c.emoji ? `${c.emoji} ${c.name}` : c.name,
              color: c.color,
            })),
          ]}
          selected={categoryKeys ?? new Set(allCatKeys)}
          onChange={setCategoryKeys}
        />
        <label>
          From
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <DatePresets
          onSelect={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
        />
        <label className="grow">
          Search
          <input
            type="search"
            placeholder="Description, payee, memo…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {debouncedQ.trim() && categories.length > 0 && (
          <div className="msel" ref={addRuleRef}>
            <span className="msel-label">&nbsp;</span>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={addRuleBusy}
              onClick={() => setAddRuleOpen(!addRuleOpen)}
            >
              {addRuleBusy
                ? "Adding…"
                : `Add "${
                    debouncedQ.trim().length > 18
                      ? debouncedQ.trim().slice(0, 18) + "…"
                      : debouncedQ.trim()
                  }" to category…`}
            </button>
            {addRuleOpen && (
              <div className="msel-pop">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="msel-opt"
                    onClick={() => addSearchAsRule(c)}
                  >
                    <span className="cat-dot" style={{ background: c.color }} />
                    <span className="msel-opt-label">
                      {c.emoji ? `${c.emoji} ` : ""}
                      {c.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {hasFilters && (
          <button className="btn btn-quiet" onClick={clearFilters}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      {summary && (
        <div className="summary muted">
          {summary.total} transaction{summary.total === 1 ? "" : "s"}
          {hasFilters ? " (filtered)" : ""} · spent{" "}
          <strong className="neg">
            <Money amount={summary.spend} currency={summaryCurrency} />
          </strong>{" "}
          · income{" "}
          <strong className="pos">
            <Money amount={summary.income} currency={summaryCurrency} />
          </strong>{" "}
          · net{" "}
          <strong className={summary.net < 0 ? "neg" : "pos"}>
            <Money amount={summary.net} currency={summaryCurrency} />
          </strong>
        </div>
      )}

      {selected.size > 0 && (
        <div className="batch-bar">
          <span>
            {selected.size} selected
          </span>
          <select value={batchCategory} onChange={(e) => setBatchCategory(e.target.value)}>
            <option value="none">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.emoji ? `${c.emoji} ${c.name}` : c.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={batchBusy}
            onClick={() => runBatch("categorize")}
          >
            Set category
          </button>
          <button className="btn btn-danger" disabled={batchBusy} onClick={() => runBatch("delete")}>
            Delete
          </button>
          <button className="btn btn-quiet" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <table className="txn-table">
        <thead>
          <tr>
            <th className="check-col">
              <input
                type="checkbox"
                checked={allLoadedSelected}
                onChange={toggleSelectAll}
                title="Select all loaded"
              />
            </th>
            <th className="sortable" onClick={() => toggleSort("posted")}>
              Date{sortIndicator("posted")}
            </th>
            <th>Account</th>
            <th>Description</th>
            <th>Category</th>
            <th className="sortable num" onClick={() => toggleSort("amount")}>
              Amount{sortIndicator("amount")}
            </th>
            <th className="edit-col"></th>
          </tr>
        </thead>
        <tbody>
          {loading && items.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                Loading…
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                {hasFilters
                  ? "No transactions match these filters."
                  : "No transactions yet. Add a SimpleFin connection in Settings, then refresh."}
              </td>
            </tr>
          ) : (
            items.map((t: Txn) =>
              editingId === t.id ? (
                <EditRow
                  key={t.id}
                  txn={t}
                  categories={categories}
                  onCancel={() => setEditingId(null)}
                  onSaved={(updated) => {
                    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
                    setEditingId(null);
                    loadMeta();
                  }}
                  onDeleted={() => {
                    removeRows(new Set([t.id]));
                    setEditingId(null);
                    setNotice("Transaction deleted.");
                    loadMeta();
                  }}
                />
              ) : (
                <tr
                  key={t.id}
                  className={`${t.pending ? "pending-row " : ""}${
                    selected.has(t.id) ? "row-selected" : ""
                  }`}
                  onClick={(e) => {
                    // Clicking the row toggles selection — but not when the
                    // click was on a control, a popover, or selected text.
                    if ((e.target as HTMLElement).closest("button, input, a, .inline-pop")) {
                      return;
                    }
                    if (window.getSelection()?.toString()) return;
                    toggleSelected(t.id);
                  }}
                >
                  <td className="check-col">
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelected(t.id)}
                    />
                  </td>
                  <td className="nowrap">{formatDate(t.posted)}</td>
                  <td className="nowrap">
                    <span className="acct-name">{t.account_name}</span>
                    {t.org_name && <span className="muted small"> · {t.org_name}</span>}
                  </td>
                  <td>
                    {maskText(t.description || t.payee || "(no description)")}
                    {t.pending && <span className="badge">pending</span>}
                    {(t.payee || t.memo) && (
                      <div className="muted small">
                        {t.payee && (
                          <span className="payee-wrap">
                            {maskText(t.payee)}
                            <button
                              type="button"
                              className="payee-tag-btn"
                              title={`Always categorize payee "${t.payee}"…`}
                              onClick={() =>
                                setPicker({ kind: "payee", txnId: t.id, payee: t.payee })
                              }
                            >
                              ⌖
                            </button>
                            {picker?.kind === "payee" && picker.txnId === t.id && (
                              <InlinePicker
                                title={`Payee "${t.payee}" always goes to…`}
                                categories={categories}
                                includeUncategorized={false}
                                onPick={(id) => {
                                  const cat = categories.find((c) => c.id === id);
                                  if (cat && picker.payee) addPayeeRule(picker.payee, cat);
                                }}
                              />
                            )}
                          </span>
                        )}
                        {t.payee && t.memo ? " · " : ""}
                        {maskText(t.memo)}
                      </div>
                    )}
                  </td>
                  <td className="nowrap cat-cell">
                    {(() => {
                      const cat =
                        t.category_id != null ? categoriesById.get(t.category_id) : undefined;
                      return (
                        <button
                          type="button"
                          className="cat-chip-btn"
                          title="Change this transaction's category"
                          onClick={() => setPicker({ kind: "chip", txnId: t.id })}
                        >
                          {cat ? (
                            <span className="cat-chip">
                              <span className="cat-dot" style={{ background: cat.color }} />
                              {cat.emoji ? `${cat.emoji} ` : ""}
                              {cat.name}
                              {t.category_manual && <span className="manual-mark">✎</span>}
                            </span>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </button>
                      );
                    })()}
                    {picker?.kind === "chip" && picker.txnId === t.id && (
                      <InlinePicker
                        title="Category for this transaction"
                        categories={categories}
                        includeUncategorized
                        onPick={(id) => setRowCategory(t.id, id)}
                      />
                    )}
                  </td>
                  <td className={`num nowrap ${t.amount < 0 ? "neg" : "pos"}`}>
                    <Money amount={t.amount_str} currency={t.currency} />
                  </td>
                  <td className="edit-col">
                    <button
                      className="btn btn-quiet btn-small"
                      onClick={() => setEditingId(t.id)}
                      title="Edit"
                    >
                      ✎
                    </button>
                  </td>
                </tr>
              )
            )
          )}
          {hasMore && (
            <tr ref={sentinelRef}>
              <td colSpan={7} className="empty small">
                {loadingMore ? "Loading more…" : "Scroll for more"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function InlinePicker({
  title,
  categories,
  includeUncategorized,
  onPick,
}: {
  title: string;
  categories: Category[];
  includeUncategorized: boolean;
  onPick: (categoryId: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [openUp, setOpenUp] = useState(false);
  // Flip upward when the popover would poke below the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.getBoundingClientRect().bottom > window.innerHeight - 8) {
      setOpenUp(true);
    }
  }, []);
  return (
    <div ref={ref} className={`msel-pop inline-pop${openUp ? " inline-pop-up" : ""}`}>
      <div className="inline-pop-title">{title}</div>
      {includeUncategorized && (
        <button type="button" className="msel-opt" onClick={() => onPick(null)}>
          <span className="cat-dot" style={{ background: "#9b998e" }} />
          <span className="msel-opt-label">Uncategorized</span>
        </button>
      )}
      {categories.map((c) => (
        <button type="button" key={c.id} className="msel-opt" onClick={() => onPick(c.id)}>
          <span className="cat-dot" style={{ background: c.color }} />
          <span className="msel-opt-label">
            {c.emoji ? `${c.emoji} ` : ""}
            {c.name}
          </span>
        </button>
      ))}
    </div>
  );
}

function EditRow({
  txn,
  categories,
  onCancel,
  onSaved,
  onDeleted,
}: {
  txn: Txn;
  categories: Category[];
  onCancel: () => void;
  onSaved: (t: Txn) => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(txn.description);
  const [payee, setPayee] = useState(txn.payee);
  const [memo, setMemo] = useState(txn.memo);
  const [categoryId, setCategoryId] = useState(
    txn.category_id != null ? String(txn.category_id) : "none"
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (description !== txn.description) body.description = description;
      if (payee !== txn.payee) body.payee = payee;
      if (memo !== txn.memo) body.memo = memo;
      const newCat = categoryId === "none" ? null : Number(categoryId);
      if (newCat !== txn.category_id) body.category_id = newCat;
      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }
      const updated = await api<Txn>(`/api/transactions/${txn.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Delete this transaction? It will not come back on future syncs.")) return;
    setBusy(true);
    try {
      await api("/api/transactions/batch", {
        method: "POST",
        body: JSON.stringify({ ids: [txn.id], action: "delete" }),
      });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <tr className="edit-row">
      <td colSpan={7}>
        <form onSubmit={save} className="edit-form">
          <div className="edit-fields">
            <label>
              Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label>
              Payee
              <input value={payee} onChange={(e) => setPayee(e.target.value)} />
            </label>
            <label>
              Memo
              <input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </label>
            <label>
              Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="none">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.emoji ? `${c.emoji} ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="edit-actions">
            <span className="muted small">
              {formatDate(txn.posted)} · <Money amount={txn.amount_str} currency={txn.currency} />
            </span>
            <div className="spacer" />
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              Delete
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}
