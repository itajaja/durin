import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatDate } from "../api";
import { useMoney } from "../components/Money";
import DatePresets from "../components/DatePresets";
import { AssetAccount, AssetsResponse, REFRESHED_EVENT } from "../types";

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
  const start = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  return { start: isoDate(start), end: isoDate(now) };
}

function parseIso(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Every calendar day from `from` to `to`, inclusive (local time). */
function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = parseIso(from);
  const stop = parseIso(to);
  while (cur <= stop && days.length < 4000) {
    days.push(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/** Round the data extent out to tick-friendly bounds (~5 ticks). Balances
 * can be negative (credit cards), so this is a floor/ceil pair rather than
 * the spending chart's zero-based ceiling. */
function niceDomain(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1);
    min -= pad;
    max += pad;
  }
  const step = niceStep((max - min) / 4);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(t);
  return { lo, hi, ticks };
}

function dayLabel(day: string, withYear: boolean): string {
  return parseIso(day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

export default function AssetsPage() {
  const { fmt, fmtCompact } = useMoney();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlInit = useRef({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    accts: searchParams.get("accts"),
    grp: searchParams.get("grp"),
  });

  const [{ start: defStart, end: defEnd }] = useState(defaultRange);
  const [start, setStart] = useState(urlInit.current.from ?? defStart);
  const [end, setEnd] = useState(urlInit.current.to ?? defEnd);
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = not initialized
  const [error, setError] = useState("");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [balSort, setBalSort] = useState<"desc" | "asc" | null>(null);
  const [groupByInst, setGroupByInst] = useState(urlInit.current.grp === "1");
  const alive = useRef(true);
  const fetchSeq = useRef(0);
  const knownIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadAssets = useCallback(async () => {
    if (!start || !end || start < "1970-01-01" || end < "1970-01-01") return;
    if (start > end) {
      setError("The From date is after the To date.");
      return;
    }
    const mySeq = ++fetchSeq.current;
    const params = new URLSearchParams({ start, end });
    try {
      const resp = await api<AssetsResponse>(`/api/assets?${params}`);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setData(resp);
      setError("");
      setHoverIdx(null);
      // Accounts without any history in range are hidden entirely, so they
      // can't be picked either.
      const validKeys = new Set(
        resp.accounts.filter((a) => a.points.length > 0).map((a) => String(a.id))
      );
      const prevKnown = new Set(knownIds.current);
      knownIds.current = validKeys;
      setSelected((prev) => {
        if (prev === null) {
          const fromUrl = urlInit.current.accts;
          if (fromUrl != null) {
            if (fromUrl === "~") return new Set();
            return new Set(fromUrl.split(",").filter((k) => validKeys.has(k)));
          }
          return new Set(validKeys);
        }
        // Keep choices for accounts that still exist; new ones join checked.
        const next = new Set([...prev].filter((k) => validKeys.has(k)));
        for (const k of validKeys) {
          if (!prevKnown.has(k)) next.add(k);
        }
        return next;
      });
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, [start, end]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    const onRefreshed = () => loadAssets();
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [loadAssets]);

  const selectedKey = selected ? [...selected].sort().join(",") : "";

  // Mirror the state into the URL so reloads and shared links restore it.
  useEffect(() => {
    if (selected === null && urlInit.current.accts != null) return; // not hydrated
    const allSelected =
      selected === null ||
      (knownIds.current.size > 0 && [...knownIds.current].every((k) => selected.has(k)));
    const p = new URLSearchParams();
    if (start !== defStart) p.set("from", start);
    if (end !== defEnd) p.set("to", end);
    if (selected !== null && !allSelected) {
      p.set("accts", selected.size === 0 ? "~" : [...selected].sort().join(","));
    }
    if (groupByInst) p.set("grp", "1");
    setSearchParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, selectedKey, selected === null, groupByInst]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Hide accounts with no history to show in this range; snapshots start
  // accumulating for them with each sync, so they appear once they have data.
  const rawCount = data?.accounts.length ?? 0;
  const accounts = useMemo(
    () => (data?.accounts ?? []).filter((a) => a.points.length > 0),
    [data]
  );
  const currencies = new Set(accounts.map((a) => a.currency));
  const currency = currencies.size === 1 && accounts.length > 0 ? accounts[0].currency : "USD";
  const mixedCurrencies = currencies.size > 1;

  // Group by institution (accounts arrive sorted by org, name).
  const groups = useMemo(() => {
    const byOrg = new Map<string, { name: string; accounts: AssetAccount[] }>();
    for (const a of accounts) {
      const key = a.org_name || "Other";
      let g = byOrg.get(key);
      if (!g) {
        g = { name: key, accounts: [] };
        byOrg.set(key, g);
      }
      g.accounts.push(a);
    }
    return [...byOrg.values()];
  }, [accounts]);

  const shown = accounts.filter((a) => selected?.has(String(a.id)) ?? false);

  // ---- series building: calendar-day axis, forward-filled ----
  const { days, totals } = useMemo(() => {
    const today = isoDate(new Date());
    const stop = end < today ? end : today; // never fill into the future
    let first: string | null = null;
    for (const a of shown) {
      if (a.points.length > 0 && (first === null || a.points[0].day < first)) {
        first = a.points[0].day;
      }
    }
    if (first === null || first > stop) {
      return { days: [] as string[], series: [], totals: [] as (number | null)[] };
    }
    const days = dayRange(first, stop);
    const index = new Map(days.map((d, i) => [d, i]));
    const series = shown.map((a) => {
      const values: (number | null)[] = new Array(days.length).fill(null);
      for (const p of a.points) {
        const i = index.get(p.day);
        if (i !== undefined) values[i] = p.balance;
      }
      let last: number | null = null;
      for (let i = 0; i < days.length; i++) {
        if (values[i] === null) values[i] = last;
        else last = values[i];
      }
      return { account: a, values };
    });
    const totals: (number | null)[] = days.map((_, i) => {
      let sum = 0;
      let any = false;
      for (const s of series) {
        const v = s.values[i];
        if (v !== null) {
          sum += v;
          any = true;
        }
      }
      return any ? sum : null;
    });
    return { days, series, totals };
  }, [shown, end]);

  const n = days.length;
  const hasData = n > 0;

  // ---- chart geometry ----
  const plotW = CHART_W - MARGIN.left - MARGIN.right;
  const plotH = CHART_H - MARGIN.top - MARGIN.bottom;
  // Only the sum is plotted, so the y domain fits it alone.
  const allValues: number[] = [];
  for (const v of totals) if (v !== null) allValues.push(v);
  const { lo, hi, ticks } = niceDomain(
    Math.min(...(allValues.length ? allValues : [0])),
    Math.max(...(allValues.length ? allValues : [0]))
  );
  const dayW = n > 1 ? plotW / (n - 1) : 0;
  const x = (i: number) => (n > 1 ? MARGIN.left + i * dayW : MARGIN.left + plotW / 2);
  const y = (v: number) => MARGIN.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const withYear = days.length > 0 && days[0].slice(0, 4) !== days[n - 1].slice(0, 4);

  const linePath = (values: (number | null)[]) => {
    let d = "";
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) continue;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return d;
  };
  // Drawable points after forward-filling; a path needs at least 2.
  const pointCount = (values: (number | null)[]) =>
    values.filter((v) => v !== null).length;

  // ---- summary ----
  const lastIdx = (() => {
    for (let i = n - 1; i >= 0; i--) if (totals[i] !== null) return i;
    return -1;
  })();
  const firstIdx = (() => {
    for (let i = 0; i < n; i++) if (totals[i] !== null) return i;
    return -1;
  })();
  const netNow = lastIdx >= 0 ? (totals[lastIdx] as number) : null;
  const netFirst = firstIdx >= 0 ? (totals[firstIdx] as number) : null;
  const change = netNow !== null && netFirst !== null ? netNow - netFirst : null;
  const changePct =
    change !== null && netFirst !== null && Math.abs(netFirst) > 0.005
      ? (change / Math.abs(netFirst)) * 100
      : null;

  const hovered = hoverIdx !== null && hoverIdx < n ? hoverIdx : null;

  return (
    <div className="page">
      <h2>Assets</h2>

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
      </div>

      {accounts.length > 0 && (
        <div className="asset-picker card">
          <div>
            <button
              className="btn btn-quiet btn-small"
              onClick={() =>
                setSelected(
                  selected && selected.size > 0 ? new Set() : new Set(knownIds.current)
                )
              }
            >
              {selected && selected.size > 0 ? "Unselect all" : "Select all"}
            </button>
          </div>
          {groups.map((g) => {
            const keys = g.accounts.map((a) => String(a.id));
            const on = keys.filter((k) => selected?.has(k) ?? false).length;
            return (
              <div key={g.name} className="picker-group">
                <label className="cat-check group-head">
                  <input
                    type="checkbox"
                    checked={on === keys.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < keys.length;
                    }}
                    onChange={() => {
                      setSelected((prev) => {
                        const next = new Set(prev ?? []);
                        if (on === keys.length) keys.forEach((k) => next.delete(k));
                        else keys.forEach((k) => next.add(k));
                        return next;
                      });
                    }}
                  />
                  <strong>{g.name}</strong>
                </label>
                <div className="group-accounts">
                  {g.accounts.map((a) => (
                    <label key={a.id} className="cat-check">
                      <input
                        type="checkbox"
                        checked={selected?.has(String(a.id)) ?? false}
                        onChange={() => toggle(String(a.id))}
                      />
                      <span>{a.name}</span>
                      <span className="muted small">{fmt(a.balance, a.currency)}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}
      {mixedCurrencies && (
        <div className="alert alert-error">
          Your accounts use different currencies — the total adds the raw numbers together, so
          treat it as approximate.
        </div>
      )}

      {data === null ? (
        <div className="card empty">Loading…</div>
      ) : rawCount === 0 ? (
        <div className="card empty">
          No accounts yet — add a SimpleFin connection in Settings.
        </div>
      ) : accounts.length === 0 ? (
        <div className="card empty">
          No balance history in this range yet. Durin records a snapshot of every account's
          balance at each sync, so history builds up from today — SimpleFin has no historical
          balances to backfill.
        </div>
      ) : selected !== null && selected.size === 0 ? (
        <div className="card empty">Pick at least one account to plot.</div>
      ) : !hasData ? (
        <div className="card empty">
          No balance history in this range yet. Durin records a snapshot of every account's
          balance at each sync, so history builds up from today — SimpleFin has no historical
          balances to backfill.
        </div>
      ) : (
        <div className="chart-wrap card">
          <div className="summary muted">
            Net balance:{" "}
            <strong>{netNow !== null ? fmt(netNow, currency) : "—"}</strong>
            {change !== null && lastIdx !== firstIdx && (
              <>
                {" "}
                · change over range:{" "}
                <strong className={change < 0 ? "neg" : "pos"}>
                  {change >= 0 ? "+" : "−"}
                  {fmt(Math.abs(change), currency)}
                  {changePct !== null ? ` (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)` : ""}
                </strong>
              </>
            )}
          </div>
          <div className="chart-scroll">
            <div className="chart-inner">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                className="spend-chart"
                role="img"
                aria-label="Line chart of account balances over time"
              >
                {/* gridlines + y labels */}
                {ticks.map((t) => (
                  <g key={t}>
                    <line
                      x1={MARGIN.left}
                      x2={CHART_W - MARGIN.right}
                      y1={y(t)}
                      y2={y(t)}
                      className={t === 0 ? "axis-line" : "grid-line"}
                    />
                    <text x={MARGIN.left - 8} y={y(t) + 4} className="axis-label" textAnchor="end">
                      {fmtCompact(t, currency)}
                    </text>
                  </g>
                ))}

                {/* crosshair */}
                {hovered !== null && (
                  <line
                    x1={x(hovered)}
                    x2={x(hovered)}
                    y1={MARGIN.top}
                    y2={MARGIN.top + plotH}
                    className="crosshair"
                  />
                )}

                {/* the sum of the selected accounts, as a single line */}
                {pointCount(totals) === 1 ? (
                  <circle
                    cx={x(totals.findIndex((v) => v !== null))}
                    cy={y(totals.find((v) => v !== null) as number)}
                    r={3}
                    className="total-dot"
                  />
                ) : (
                  <path
                    d={linePath(totals)}
                    fill="none"
                    className="total-line"
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}

                {/* hovered-day marker */}
                {hovered !== null && totals[hovered] !== null && (
                  <circle
                    cx={x(hovered)}
                    cy={y(totals[hovered] as number)}
                    r={4}
                    className="total-dot point-ring"
                  />
                )}

                {/* x labels (thinned) */}
                {days.map((d, i) =>
                  i % labelEvery === 0 ? (
                    <text
                      key={d}
                      x={x(i)}
                      y={CHART_H - 8}
                      className="axis-label"
                      textAnchor="middle"
                    >
                      {dayLabel(d, withYear)}
                    </text>
                  ) : null
                )}

                {/* hover hit target */}
                <rect
                  x={MARGIN.left}
                  y={MARGIN.top}
                  width={plotW}
                  height={plotH}
                  fill="transparent"
                  onMouseMove={(e) => {
                    const svg = e.currentTarget.ownerSVGElement;
                    if (!svg || n === 0) return;
                    const box = svg.getBoundingClientRect();
                    const xView = ((e.clientX - box.left) * CHART_W) / box.width;
                    const i = n > 1 ? Math.round((xView - MARGIN.left) / dayW) : 0;
                    setHoverIdx(Math.max(0, Math.min(n - 1, i)));
                  }}
                  onMouseLeave={() => setHoverIdx(null)}
                />
              </svg>

              {hovered !== null && (
                <div
                  className="chart-tooltip"
                  style={{
                    left: `${(x(hovered) / CHART_W) * 100}%`,
                    transform:
                      hovered > n / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
                  }}
                >
                  <div className="tt-title">{dayLabel(days[hovered], true)}</div>
                  {totals[hovered] !== null && (
                    <div className="tt-row tt-total">
                      <span className="tt-name">Total</span>
                      <span className="tt-val">{fmt(totals[hovered] as number, currency)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {shown.length > 0 && (
        <div className="card">
          <div className="card-head-row">
            <h3>Current balances</h3>
            <label className="cat-check">
              <input
                type="checkbox"
                checked={groupByInst}
                onChange={() => setGroupByInst(!groupByInst)}
              />
              <span>Group by institution</span>
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th
                  className="num sortable"
                  onClick={() => setBalSort(balSort === "desc" ? "asc" : "desc")}
                >
                  Balance{balSort ? (balSort === "asc" ? " ▲" : " ▼") : ""}
                </th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const bal = (a: AssetAccount) => Number(a.balance) || 0;
                const sorted = balSort
                  ? [...shown].sort((a, b) =>
                      balSort === "asc" ? bal(a) - bal(b) : bal(b) - bal(a)
                    )
                  : shown;
                if (!groupByInst)
                  return sorted.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.name}
                        {a.org_name ? <span className="muted"> · {a.org_name}</span> : null}
                      </td>
                      <td className={`num nowrap bal-cell ${bal(a) < 0 ? "neg" : "pos"}`}>
                        {fmt(a.balance, a.currency)}
                      </td>
                      <td className="muted nowrap">{formatDate(a.balance_date)}</td>
                    </tr>
                  ));
                const instGroups = new Map<string, AssetAccount[]>();
                for (const a of sorted) {
                  const key = a.org_name || "Other";
                  instGroups.set(key, [...(instGroups.get(key) ?? []), a]);
                }
                let entries = [...instGroups.entries()];
                if (balSort) {
                  const sub = (accts: AssetAccount[]) =>
                    accts.reduce((s, a) => s + bal(a), 0);
                  entries = entries.sort((x, y) =>
                    balSort === "asc" ? sub(x[1]) - sub(y[1]) : sub(y[1]) - sub(x[1])
                  );
                }
                // Grouped view rolls each institution up to its sum alone.
                return entries.map(([inst, accts]) => {
                  const subtotal = accts.reduce((s, a) => s + bal(a), 0);
                  return (
                    <tr key={`inst:${inst}`}>
                      <td>
                        {inst}
                        <span className="muted small"> · {accts.length} account{accts.length === 1 ? "" : "s"}</span>
                      </td>
                      <td className={`num nowrap bal-cell ${subtotal < 0 ? "neg" : "pos"}`}>
                        {fmt(subtotal, accts[0].currency)}
                      </td>
                      <td />
                    </tr>
                  );
                });
              })()}
            </tbody>
            <tfoot>
              <tr className="total-row">
                <td>Total</td>
                <td className="num nowrap">
                  {fmt(
                    shown.reduce((sum, a) => sum + (Number(a.balance) || 0), 0),
                    currency
                  )}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
