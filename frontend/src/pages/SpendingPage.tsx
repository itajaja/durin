import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useMoney } from "../components/Money";
import DatePresets from "../components/DatePresets";
import {
  Account,
  CategoriesResponse,
  Category,
  REFRESHED_EVENT,
  SpendingResponse,
  UNCATEGORIZED_COLOR,
} from "../types";

type Granularity = "day" | "week" | "month" | "year";

const CHART_W = 900;
const CHART_H = 340;
const MARGIN = { top: 14, right: 10, bottom: 30, left: 62 };

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

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const unit = v / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

function bucketLabel(bucket: string, granularity: Granularity): string {
  if (granularity === "year") return bucket;
  if (granularity === "month") {
    const [y, m] = bucket.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    const label = d.toLocaleDateString(undefined, { month: "short" });
    return m === 1 ? `${label} ${y}` : label;
  }
  const [y, m, day] = bucket.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
  });
}

interface PickerEntry {
  key: string;
  name: string;
  emoji: string;
  color: string;
}

export default function SpendingPage() {
  const { fmt, fmtCompact } = useMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlInit = useRef({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    g: searchParams.get("g"),
    cats: searchParams.get("cats"),
  });

  const [{ start: defStart, end: defEnd }] = useState(defaultRange);
  const [start, setStart] = useState(urlInit.current.from ?? defStart);
  const [end, setEnd] = useState(urlInit.current.to ?? defEnd);
  const [granularity, setGranularity] = useState<Granularity>(() => {
    const g = urlInit.current.g;
    return g === "day" || g === "week" || g === "year" ? g : "month";
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = not initialized
  const [data, setData] = useState<SpendingResponse | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [mixedCurrencies, setMixedCurrencies] = useState(false);
  const [error, setError] = useState("");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const alive = useRef(true);
  const fetchSeq = useRef(0);
  const knownIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Spendable categories only: is_transaction ones never count as spending.
  const spendable = useMemo(
    () => categories.filter((c) => !c.is_transaction),
    [categories]
  );

  const loadCategories = useCallback(async () => {
    try {
      const resp = await api<CategoriesResponse>("/api/categories");
      if (!alive.current) return;
      setCategories(resp.categories);
      const validKeys = new Set([
        ...resp.categories.filter((c) => !c.is_transaction).map((c) => String(c.id)),
        "none",
      ]);
      // Snapshot outside the updater: React (StrictMode) may run the
      // updater twice, so it must stay pure.
      const prevKnown = new Set(knownIds.current);
      knownIds.current = validKeys;
      setSelected((prev) => {
        if (prev === null) {
          // First hydration: honor a subset carried in the URL.
          const fromUrl = urlInit.current.cats;
          if (fromUrl != null) {
            if (fromUrl === "~") return new Set();
            return new Set(fromUrl.split(",").filter((k) => validKeys.has(k)));
          }
          return new Set(validKeys);
        }
        // Keep the user's choices for keys that still exist; newly created
        // categories join checked by default.
        const next = new Set([...prev].filter((k) => validKeys.has(k)));
        for (const k of validKeys) {
          if (!prevKnown.has(k)) next.add(k);
        }
        return next;
      });
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : "Failed to load categories");
      }
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const accts = await api<Account[]>("/api/accounts");
      if (!alive.current) return;
      const currencies = new Set(accts.map((a) => a.currency));
      if (currencies.size === 1 && accts.length > 0) setCurrency(accts[0].currency);
      setMixedCurrencies(currencies.size > 1);
    } catch {
      // keep the USD default
    }
  }, []);

  useEffect(() => {
    loadCategories();
    loadAccounts();
  }, [loadCategories, loadAccounts]);

  const selectedKey = selected ? [...selected].sort().join(",") : "";

  // Mirror the state into the URL so reloads and shared links restore it.
  useEffect(() => {
    if (selected === null && urlInit.current.cats != null) return; // not hydrated
    const allSelected =
      selected === null ||
      (knownIds.current.size > 0 && [...knownIds.current].every((k) => selected.has(k)));
    const p = new URLSearchParams();
    if (start !== defStart) p.set("from", start);
    if (end !== defEnd) p.set("to", end);
    if (granularity !== "month") p.set("g", granularity);
    if (selected !== null && !allSelected) {
      p.set("cats", selected.size === 0 ? "~" : [...selected].sort().join(","));
    }
    setSearchParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, granularity, selectedKey, selected === null]);

  const loadSpending = useCallback(async () => {
    if (selected === null) return;
    if (selected.size === 0) {
      setData(null);
      return;
    }
    // Skip fetches for half-typed dates (typing a year fires per-keystroke
    // change events with values like 0002-01-01).
    if (!start || !end || start < "1970-01-01" || end < "1970-01-01") {
      return;
    }
    if (start > end) {
      // Don't leave the previous range's chart silently posing as this one.
      setError("The From date is after the To date.");
      return;
    }
    const mySeq = ++fetchSeq.current;
    const params = new URLSearchParams({ start, end, granularity, categories: selectedKey });
    try {
      const resp = await api<SpendingResponse>(`/api/spending?${params}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setData(resp);
      setError("");
      setHoverIdx(null);
      setHoverKey(null);
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load spending");
    }
  }, [start, end, granularity, selectedKey, selected]);

  useEffect(() => {
    loadSpending();
  }, [loadSpending]);

  // Top-bar refresh finished: new transactions/categories may exist.
  useEffect(() => {
    const onRefreshed = () => {
      loadCategories();
      loadSpending();
    };
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [loadCategories, loadSpending]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const seriesTotals = new Map((data?.series ?? []).map((s) => [s.key, s.total]));

  const pickerEntries: PickerEntry[] = [
    ...spendable.map((c) => ({
      key: String(c.id),
      name: c.name,
      emoji: c.emoji,
      color: c.color,
    })),
    { key: "none", name: "Uncategorized", emoji: "", color: UNCATEGORIZED_COLOR },
  ];

  // ---- chart geometry ----
  const plotW = CHART_W - MARGIN.left - MARGIN.right;
  const plotH = CHART_H - MARGIN.top - MARGIN.bottom;
  const buckets = data?.buckets ?? [];
  const n = buckets.length;
  const bucketTotals = buckets.map((_, i) =>
    (data?.series ?? []).reduce((acc, s) => acc + s.values[i], 0)
  );
  const yMax = niceCeil(Math.max(...bucketTotals, 0) * 1.05);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const slotW = n > 0 ? plotW / n : plotW;
  const barW = Math.min(slotW * 0.7, 64);
  const x = (i: number) => MARGIN.left + i * slotW + (slotW - barW) / 2;
  const y = (v: number) => MARGIN.top + plotH - (v / yMax) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const hasAnySpending = bucketTotals.some((t) => t > 0);

  const hovered = hoverIdx !== null && data ? hoverIdx : null;

  return (
    <div className="page">
      <h2>Spending</h2>

      <div className="filters">
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
        <label>
          Group by
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
          >
            <option value="month">Month</option>
            <option value="week">Week</option>
            <option value="day">Day</option>
            <option value="year">Year</option>
          </select>
        </label>
      </div>

      <div className="cat-picker card">
        <button
          className="btn btn-quiet btn-small"
          disabled={!selected || selected.size === 0}
          onClick={() => setSelected(new Set())}
        >
          Unselect all
        </button>
        {pickerEntries.map((entry) => (
          <label key={entry.key} className="cat-check">
            <input
              type="checkbox"
              checked={selected?.has(entry.key) ?? false}
              onChange={() => toggle(entry.key)}
            />
            <span className="cat-dot" style={{ background: entry.color }} />
            <span>
              {entry.emoji ? `${entry.emoji} ` : ""}
              {entry.name}
            </span>
            {seriesTotals.has(entry.key) && (
              <span className="muted small">
                {fmt(seriesTotals.get(entry.key)!, currency)}
              </span>
            )}
          </label>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {mixedCurrencies && (
        <div className="alert alert-error">
          Your accounts use different currencies — these totals add the raw numbers together, so
          treat them as approximate.
        </div>
      )}

      {selected !== null && selected.size === 0 ? (
        <div className="card empty">Pick at least one category to plot.</div>
      ) : data && !hasAnySpending ? (
        <div className="card empty">No spending in this range for the selected categories.</div>
      ) : data ? (
        <>
          <div className="chart-wrap card">
            <div className="summary muted">
              Total spent:{" "}
              <strong className="neg">{fmt(data.grand_total, currency)}</strong> · avg/month{" "}
              <strong className="neg">{fmt(data.grand_avg_month, currency)}</strong>
            </div>
            <div className="chart-scroll">
              <div className="chart-inner">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                className="spend-chart"
                role="img"
                aria-label="Stacked bar chart of spending by category over time"
              >
                {/* gridlines + y labels */}
                {yTicks.map((t) => (
                  <g key={t}>
                    <line
                      x1={MARGIN.left}
                      x2={CHART_W - MARGIN.right}
                      y1={y(t)}
                      y2={y(t)}
                      className="grid-line"
                    />
                    <text x={MARGIN.left - 8} y={y(t) + 4} className="axis-label" textAnchor="end">
                      {fmtCompact(t, currency)}
                    </text>
                  </g>
                ))}

                {/* hover highlight band */}
                {hovered !== null && (
                  <rect
                    x={MARGIN.left + hovered * slotW}
                    y={MARGIN.top}
                    width={slotW}
                    height={plotH}
                    className="hover-band"
                  />
                )}

                {/* stacked bars: 2px surface gaps between segments; hovering
                    a segment spotlights that category across every bar */}
                {buckets.map((_, i) => {
                  let acc = 0;
                  return (
                    <g key={i}>
                      {data.series.map((s) => {
                        const v = s.values[i];
                        if (v <= 0) return null;
                        const y1 = y(acc + v);
                        const h = Math.max(y(acc) - y1 - 2, v > 0 ? 1 : 0);
                        acc += v;
                        return (
                          <rect
                            key={s.key}
                            x={x(i)}
                            y={y1 + 1}
                            width={barW}
                            height={h}
                            fill={s.color}
                            rx={1.5}
                            opacity={hoverKey && s.key !== hoverKey ? 0.3 : 1}
                          />
                        );
                      })}
                    </g>
                  );
                })}

                {/* x labels (thinned) */}
                {buckets.map((b, i) =>
                  i % labelEvery === 0 ? (
                    <text
                      key={b}
                      x={MARGIN.left + i * slotW + slotW / 2}
                      y={CHART_H - 8}
                      className="axis-label"
                      textAnchor="middle"
                    >
                      {bucketLabel(b, data.granularity)}
                    </text>
                  ) : null
                )}

                {/* baseline */}
                <line
                  x1={MARGIN.left}
                  x2={CHART_W - MARGIN.right}
                  y1={y(0)}
                  y2={y(0)}
                  className="axis-line"
                />

                {/* hover hit targets: track both the column and, from the
                    pointer's y position, the segment under it */}
                {buckets.map((_, i) => (
                  <rect
                    key={i}
                    x={MARGIN.left + i * slotW}
                    y={MARGIN.top}
                    width={slotW}
                    height={plotH}
                    fill="transparent"
                    onMouseMove={(e) => {
                      setHoverIdx(i);
                      const svg = e.currentTarget.ownerSVGElement;
                      if (!svg) return;
                      const box = svg.getBoundingClientRect();
                      const yView = ((e.clientY - box.top) * CHART_H) / box.height;
                      let acc = 0;
                      let key: string | null = null;
                      for (const s of data.series) {
                        const v = s.values[i];
                        if (v <= 0) continue;
                        if (yView >= y(acc + v) && yView <= y(acc)) {
                          key = s.key;
                          break;
                        }
                        acc += v;
                      }
                      setHoverKey(key);
                    }}
                    onMouseLeave={() => {
                      setHoverIdx(null);
                      setHoverKey(null);
                    }}
                  />
                ))}
              </svg>

              {hovered !== null && (
                <div
                  className="chart-tooltip"
                  style={{
                    left: `${((MARGIN.left + hovered * slotW + slotW / 2) / CHART_W) * 100}%`,
                    transform:
                      hovered > n / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
                  }}
                >
                  <div className="tt-title">{bucketLabel(buckets[hovered], data.granularity)}</div>
                  {data.series
                    .filter((s) => s.values[hovered] > 0)
                    .sort((a, b) => b.values[hovered] - a.values[hovered])
                    .map((s) => (
                      <div
                        key={s.key}
                        className={`tt-row${s.key === hoverKey ? " tt-row-active" : ""}`}
                      >
                        <span className="cat-dot" style={{ background: s.color }} />
                        <span className="tt-name">
                          {s.emoji ? `${s.emoji} ` : ""}
                          {s.name}
                        </span>
                        <span className="tt-val">
                          {fmt(s.values[hovered], currency)}
                        </span>
                      </div>
                    ))}
                  <div className="tt-row tt-total">
                    <span className="tt-name">Total</span>
                    <span className="tt-val">
                      {fmt(bucketTotals[hovered], currency)}
                    </span>
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Totals for this range</h3>
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Spent</th>
                  <th className="num">Avg / month</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {[...data.series]
                  .sort((a, b) => b.total - a.total)
                  .map((s) => (
                    <tr key={s.key}>
                      <td>
                        <span className="cat-chip">
                          <span className="cat-dot" style={{ background: s.color }} />
                          {s.emoji ? `${s.emoji} ` : ""}
                          {s.name}
                        </span>
                      </td>
                      <td className="num nowrap">{fmt(s.total, currency)}</td>
                      <td className="num nowrap">{fmt(s.avg_month, currency)}</td>
                      <td className="num nowrap muted">
                        {data.grand_total > 0
                          ? `${((s.total / data.grand_total) * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="card empty">Loading…</div>
      )}
    </div>
  );
}
