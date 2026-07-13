import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { catOptions, InlinePicker } from "../components/CategoryPicker";
import DatePresets from "../components/DatePresets";
import Money, { useMoney } from "../components/Money";
import MultiSelect from "../components/MultiSelect";
import useUrlFilterSync from "../components/useUrlFilterSync";
import {
  Account,
  CategoriesResponse,
  Category,
  REFRESHED_EVENT,
  Vendor,
  VendorsResponse,
} from "../types";

type SortField = "name" | "count" | "total";
type SortDir = "asc" | "desc";

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  return { start: isoDate(start), end: isoDate(now) };
}

export default function VendorsPage() {
  const { maskText } = useMoney();
  const [searchParams] = useSearchParams();
  // Snapshot of the URL at mount: it seeds the initial state, then the URL
  // follows the state.
  const urlInit = useRef({
    accounts: searchParams.get("accounts"),
    cats: searchParams.get("cats"),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    q: searchParams.get("q") ?? "",
    sort: searchParams.get("sort"),
    dir: searchParams.get("dir"),
  });

  const [{ start: defStart, end: defEnd }] = useState(defaultRange);
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
  const [start, setStart] = useState(urlInit.current.from ?? defStart);
  const [end, setEnd] = useState(urlInit.current.to ?? defEnd);
  const [q, setQ] = useState(urlInit.current.q);
  const [sort, setSort] = useState<SortField>(() => {
    const s = urlInit.current.sort;
    return s === "name" || s === "count" ? s : "total";
  });
  const [dir, setDir] = useState<SortDir>(urlInit.current.dir === "asc" ? "asc" : "desc");

  const [data, setData] = useState<VendorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pickerKey, setPickerKey] = useState<string | null>(null);

  const alive = useRef(true);
  const fetchSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

  // Two-way URL sync: filter changes push history entries, and popping an
  // entry re-hydrates the state.
  useUrlFilterSync(
    () => {
      if (categoryKeys === null && urlInit.current.cats != null) return null; // not hydrated yet
      const p = new URLSearchParams();
      if (accountsKey) p.set("accounts", accountsKey);
      if (categoryKeys !== null && !allCatsSelected) {
        p.set("cats", categoryKeys.size === 0 ? "~" : [...categoryKeys].sort().join(","));
      }
      if (start !== defStart) p.set("from", start);
      if (end !== defEnd) p.set("to", end);
      if (q) p.set("q", q);
      if (sort !== "total" || dir !== "desc") {
        p.set("sort", sort);
        p.set("dir", dir);
      }
      return p;
    },
    (p) => {
      setAccountIds(new Set(p.get("accounts")?.split(",").filter(Boolean) ?? []));
      const cats = p.get("cats");
      setCategoryKeys((prev) => {
        if (prev === null) {
          // Categories haven't loaded yet — leave the hydration marker for
          // the load-time initializer to honor.
          urlInit.current.cats = cats;
          return prev;
        }
        if (cats === null) return new Set(knownCatKeys.current);
        if (cats === "~") return new Set();
        return new Set(cats.split(",").filter((k) => knownCatKeys.current.has(k)));
      });
      setStart(p.get("from") ?? defStart);
      setEnd(p.get("to") ?? defEnd);
      setQ(p.get("q") ?? "");
      const s = p.get("sort");
      setSort(s === "name" || s === "count" ? s : "total");
      setDir(p.get("dir") === "asc" ? "asc" : "desc");
    },
    [accountsKey, categoriesKey, allCatsSelected, start, end, q, sort, dir]
  );

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

  const loadVendors = useCallback(async () => {
    const mySeq = ++fetchSeq.current;
    if (noCatsSelected) {
      // Everything was ×'d out of the category facet: nothing can match.
      setData({ vendors: [], months_span: 1 });
      setLoading(false);
      return;
    }
    // Skip fetches for half-typed dates (typing a year fires per-keystroke
    // change events with values like 0002-01-01).
    if ((start && start < "1970-01-01") || (end && end < "1970-01-01")) return;
    if (start && end && start > end) {
      setError("The From date is after the To date.");
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (accountsKey) params.set("accounts", accountsKey);
      if (categoriesKey) params.set("categories", categoriesKey);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      const resp = await api<VendorsResponse>(`/api/vendors?${params}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setData(resp);
      setError("");
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load vendors");
    } finally {
      if (alive.current && mySeq === fetchSeq.current) setLoading(false);
    }
  }, [accountsKey, categoriesKey, start, end, noCatsSelected]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  // Top-bar refresh finished a sync: reload everything.
  useEffect(() => {
    const onRefreshed = () => {
      loadMeta();
      loadVendors();
    };
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [loadMeta, loadVendors]);

  // Change a vendor's automatic category (null removes the rule). The
  // server re-derives the vendor's non-manual transactions.
  const setVendorCategory = async (v: Vendor, categoryId: number | null) => {
    setPickerKey(null);
    setError("");
    try {
      const res = await api<{ changed: number }>("/api/vendors/rule", {
        method: "PUT",
        body: JSON.stringify({ source: v.source, name: v.name, category_id: categoryId }),
      });
      const catName =
        categoryId != null
          ? (categories.find((c) => c.id === categoryId)?.name ?? "category")
          : null;
      const moved = `${res.changed} transaction${res.changed === 1 ? "" : "s"} moved`;
      setNotice(
        catName
          ? `"${v.name}" now auto-categorizes as ${catName} — ${moved}.`
          : `Removed the automatic category for "${v.name}" — ${moved}.`
      );
      loadVendors();
      loadMeta(); // per-category transaction counts changed
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the vendor");
    }
  };

  const toggleSort = (field: SortField) => {
    if (sort === field) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(field);
      setDir(field === "name" ? "asc" : "desc");
    }
  };

  const sortIndicator = (field: SortField) =>
    sort === field ? (dir === "asc" ? " ▲" : " ▼") : "";

  const clearFilters = () => {
    setAccountIds(new Set());
    setCategoryKeys(new Set(allCatKeys));
    setStart(defStart);
    setEnd(defEnd);
    setQ("");
  };

  const hasFilters =
    accountIds.size > 0 ||
    !allCatsSelected ||
    start !== defStart ||
    end !== defEnd ||
    Boolean(q);

  const categoriesById = new Map(categories.map((c) => [c.id, c]));

  // Summary currency: the one shared by the accounts in view (the selected
  // subset when the account filter is active), else USD.
  const accountsInView =
    accountIds.size > 0 ? accounts.filter((a) => accountIds.has(String(a.id))) : accounts;
  const viewCurrencies = new Set(accountsInView.map((a) => a.currency));
  const currency =
    viewCurrencies.size === 1 && accountsInView.length > 0
      ? accountsInView[0].currency
      : "USD";

  const needle = q.trim().toLowerCase();
  const shown = (data?.vendors ?? [])
    .filter((v) => !needle || v.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const cmp =
        sort === "name"
          ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
          : sort === "count"
            ? a.count - b.count
            : Math.abs(a.total) - Math.abs(b.total);
      return dir === "asc" ? cmp : -cmp;
    });
  const totals = shown.reduce(
    (acc, v) => ({
      count: acc.count + v.count,
      spend: acc.spend + v.spend,
      income: acc.income + v.income,
    }),
    { count: 0, spend: 0, income: 0 }
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>Vendors</h2>
      </div>

      <div className="filters">
        <MultiSelect
          label="Accounts"
          allLabel="All accounts"
          options={accounts.map((a) => ({
            value: String(a.id),
            label: a.alias || (a.org_name ? `${a.org_name} — ${a.name}` : a.name),
          }))}
          selected={accountIds}
          onChange={setAccountIds}
        />
        <MultiSelect
          facet
          label="Categories"
          allLabel="All categories"
          options={catOptions(categories, true)}
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
            placeholder="Vendor name…"
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
      {notice && <div className="alert alert-ok">{notice}</div>}
      {viewCurrencies.size > 1 && (
        <div className="alert alert-error">
          The accounts in view use different currencies — these totals add the raw numbers
          together, so treat them as approximate.
        </div>
      )}

      {data && (
        <div className="summary muted">
          {shown.length} vendor{shown.length === 1 ? "" : "s"}
          {hasFilters ? " (filtered)" : ""} · {totals.count} transaction
          {totals.count === 1 ? "" : "s"} · spent{" "}
          <strong className="neg">
            <Money amount={totals.spend} currency={currency} />
          </strong>{" "}
          · income{" "}
          <strong className="pos">
            <Money amount={totals.income} currency={currency} />
          </strong>
        </div>
      )}

      <table className="txn-table hover-rows">
        <thead>
          <tr>
            <th className="sortable" onClick={() => toggleSort("name")}>
              Vendor{sortIndicator("name")}
            </th>
            <th className="sortable num" onClick={() => toggleSort("count")}>
              Transactions{sortIndicator("count")}
            </th>
            <th className="sortable num" onClick={() => toggleSort("total")}>
              Total{sortIndicator("total")}
            </th>
            <th className="num" title="Total spread over the months in the date range">
              Avg / month
            </th>
            <th>Automatic category</th>
          </tr>
        </thead>
        <tbody>
          {loading && !data ? (
            <tr>
              <td colSpan={5} className="empty">
                Loading…
              </td>
            </tr>
          ) : shown.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                {hasFilters
                  ? "No vendors match these filters."
                  : "No transactions yet. Add a SimpleFin connection in Settings, then refresh."}
              </td>
            </tr>
          ) : (
            shown.map((v) => {
              const cat =
                v.rule_category_id != null
                  ? categoriesById.get(v.rule_category_id)
                  : undefined;
              return (
                <tr key={v.key}>
                  <td>{maskText(v.name)}</td>
                  <td className="num nowrap">
                    <Link
                      to={`/?q=${encodeURIComponent(v.name)}`}
                      className="muted"
                      title="Show these transactions"
                    >
                      {v.count}
                    </Link>
                  </td>
                  <td className={`num nowrap ${v.total < 0 ? "neg" : "pos"}`}>
                    <Money amount={v.total} currency={currency} />
                  </td>
                  <td className={`num nowrap ${v.avg_month < 0 ? "neg" : "pos"}`}>
                    <Money amount={v.avg_month} currency={currency} />
                  </td>
                  <td className="nowrap cat-cell">
                    {v.source === "none" ? (
                      <span className="muted small">—</span>
                    ) : (
                      <button
                        type="button"
                        className="cat-chip-btn"
                        title={
                          v.rule_id != null
                            ? "This vendor has its own rule — click to change or remove it"
                            : "Set an automatic category for this vendor"
                        }
                        onClick={() => setPickerKey(pickerKey === v.key ? null : v.key)}
                      >
                        {cat ? (
                          <span className="cat-chip">
                            <span className="cat-dot" style={{ background: cat.color }} />
                            {cat.emoji ? `${cat.emoji} ` : ""}
                            {cat.name}
                          </span>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </button>
                    )}
                    {pickerKey === v.key && (
                      <InlinePicker
                        title={`"${v.name}" always goes to…`}
                        categories={categories}
                        includeUncategorized={v.rule_id != null}
                        noneLabel="✕ No automatic category"
                        onPick={(id) => setVendorCategory(v, id)}
                        onClose={() => setPickerKey(null)}
                      />
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
