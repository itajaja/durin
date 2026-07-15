import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, isoDate } from "../api";
import CopyableTable from "../components/CopyableTable";
import { useMoney } from "../components/Money";
import DatePresets from "../components/DatePresets";
import Select from "../components/Dropdown";
import useUrlFilterSync from "../components/useUrlFilterSync";
import { csvAmount } from "../csv";
import { Account, CashflowResponse, REFRESHED_EVENT } from "../types";

type Granularity = "day" | "week" | "month" | "year";

const CHART_W = 900;
const CHART_H = 340;
const MARGIN = { top: 14, right: 10, bottom: 30, left: 62 };

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

function monthLabel(bucket: string): string {
  const [y, m] = bucket.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
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

export default function CashflowPage() {
  const { fmt, fmtCompact, plain } = useMoney();
  const [searchParams] = useSearchParams();
  const urlInit = useRef({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    g: searchParams.get("g"),
  });

  const [{ start: defStart, end: defEnd }] = useState(defaultRange);
  const [start, setStart] = useState(urlInit.current.from ?? defStart);
  const [end, setEnd] = useState(urlInit.current.to ?? defEnd);
  const [granularity, setGranularity] = useState<Granularity>(() => {
    const g = urlInit.current.g;
    return g === "day" || g === "week" || g === "year" ? g : "month";
  });
  const [data, setData] = useState<CashflowResponse | null>(null);
  // Month-grouped series for the table below the chart; reuses the chart
  // response when the chart itself is grouped by month.
  const [monthData, setMonthData] = useState<CashflowResponse | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [mixedCurrencies, setMixedCurrencies] = useState(false);
  const [error, setError] = useState("");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const alive = useRef(true);
  const fetchSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
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
    loadAccounts();
  }, [loadAccounts]);

  // Two-way URL sync: filter changes push history entries (so Back/Forward
  // steps through filter states), and popping an entry re-hydrates the state.
  useUrlFilterSync(
    () => {
      const p = new URLSearchParams();
      if (start !== defStart) p.set("from", start);
      if (end !== defEnd) p.set("to", end);
      if (granularity !== "month") p.set("g", granularity);
      return p;
    },
    (p) => {
      setStart(p.get("from") ?? defStart);
      setEnd(p.get("to") ?? defEnd);
      const g = p.get("g");
      setGranularity(g === "day" || g === "week" || g === "year" ? g : "month");
    },
    [start, end, granularity]
  );

  const loadCashflow = useCallback(async () => {
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
    const fetchOne = (g: Granularity) =>
      api<CashflowResponse>(`/api/cashflow?${new URLSearchParams({ start, end, granularity: g })}`);
    try {
      // The table below the chart is always monthly, whatever Group by says.
      const [resp, monthResp] = await Promise.all([
        fetchOne(granularity),
        granularity === "month" ? null : fetchOne("month"),
      ]);
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setData(resp);
      setMonthData(monthResp ?? resp);
      setError("");
      setHoverIdx(null);
    } catch (err) {
      if (!alive.current || mySeq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : "Failed to load cash flow");
    }
  }, [start, end, granularity]);

  useEffect(() => {
    loadCashflow();
  }, [loadCashflow]);

  // Top-bar refresh finished: new transactions may exist.
  useEffect(() => {
    const onRefreshed = () => {
      loadCashflow();
    };
    window.addEventListener(REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(REFRESHED_EVENT, onRefreshed);
  }, [loadCashflow]);

  // ---- chart geometry: diverging axis, income up / spending down ----
  const plotW = CHART_W - MARGIN.left - MARGIN.right;
  const plotH = CHART_H - MARGIN.top - MARGIN.bottom;
  const buckets = data?.buckets ?? [];
  const n = buckets.length;
  const income = data?.income ?? [];
  const spending = data?.spending ?? [];
  const net = data?.net ?? [];
  const yTop = niceCeil(Math.max(...income, 0) * 1.05);
  const yBot = niceCeil(Math.max(...spending, 0) * 1.05);
  const y = (v: number) => MARGIN.top + ((yTop - v) / (yTop + yBot)) * plotH;
  const yTicks = [yTop, yTop / 2, 0, -yBot / 2, -yBot];
  const slotW = n > 0 ? plotW / n : plotW;
  const barW = Math.min(slotW * 0.7, 64);
  const x = (i: number) => MARGIN.left + i * slotW + (slotW - barW) / 2;
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const hasAnyFlow = income.some((v) => v > 0) || spending.some((v) => v > 0);
  const netPoints = buckets
    .map((_, i) => `${MARGIN.left + i * slotW + slotW / 2},${y(net[i])}`)
    .join(" ");

  const hovered = hoverIdx !== null && data ? hoverIdx : null;

  const summary = data && (
    <div className="summary muted">
      <div>
        Total income:{" "}
        <strong className="pos">{fmt(data.total_income, currency)}</strong> ·
        avg/month{" "}
        <strong className="pos">{fmt(data.avg_income_month, currency)}</strong>
      </div>
      <div>
        Total spending:{" "}
        <strong className="neg">{fmt(data.total_spending, currency)}</strong> ·
        avg/month{" "}
        <strong className="neg">{fmt(data.avg_spending_month, currency)}</strong>
      </div>
      <div>
        Total net:{" "}
        <strong className={data.total_net < 0 ? "neg" : "pos"}>
          {fmt(data.total_net, currency)}
        </strong>{" "}
        · avg/month{" "}
        <strong className={data.avg_net_month < 0 ? "neg" : "pos"}>
          {fmt(data.avg_net_month, currency)}
        </strong>
      </div>
    </div>
  );

  return (
    <div className="page">
      <h2>Cash flow</h2>

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
        <Select
          label="Group by"
          value={granularity}
          options={[
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
            { value: "day", label: "Day" },
            { value: "year", label: "Year" },
          ]}
          onChange={(v) => setGranularity(v as Granularity)}
        />
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {mixedCurrencies && (
        <div className="alert alert-error">
          Your accounts use different currencies — these totals add the raw numbers together, so
          treat them as approximate.
        </div>
      )}

      {data && !hasAnyFlow ? (
        <div className="card empty">No cash flow in this range.</div>
      ) : data ? (
        <div className="chart-wrap card">
          {summary}
          <div className="chart-scroll">
            <div className="chart-inner">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                className="spend-chart cf-chart"
                role="img"
                aria-label="Cash flow chart: income up, spending down, net line"
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

                {/* income grows up from the baseline, spending hangs below */}
                {buckets.map((_, i) => (
                  <g key={i}>
                    {income[i] > 0 && (
                      <rect
                        x={x(i)}
                        y={y(income[i])}
                        width={barW}
                        height={Math.max(y(0) - y(income[i]) - 1, 1)}
                        className="cf-in"
                        rx={1.5}
                      />
                    )}
                    {spending[i] > 0 && (
                      <rect
                        x={x(i)}
                        y={y(0) + 1}
                        width={barW}
                        height={Math.max(y(-spending[i]) - y(0) - 1, 1)}
                        className="cf-out"
                        rx={1.5}
                      />
                    )}
                  </g>
                ))}

                {/* net line */}
                {n > 1 && <polyline points={netPoints} className="cf-net-line" />}
                {n === 1 && (
                  <circle
                    cx={MARGIN.left + slotW / 2}
                    cy={y(net[0])}
                    r={3}
                    className="cf-net-dot"
                  />
                )}

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

                {/* zero baseline */}
                <line
                  x1={MARGIN.left}
                  x2={CHART_W - MARGIN.right}
                  y1={y(0)}
                  y2={y(0)}
                  className="axis-line"
                />

                {/* hover hit targets */}
                {buckets.map((_, i) => (
                  <rect
                    key={i}
                    x={MARGIN.left + i * slotW}
                    y={MARGIN.top}
                    width={slotW}
                    height={plotH}
                    fill="transparent"
                    onMouseMove={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
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
                  <div className="tt-row">
                    <span className="cat-dot" style={{ background: "var(--credit)" }} />
                    <span className="tt-name">Income</span>
                    <span className="tt-val">{fmt(income[hovered], currency)}</span>
                  </div>
                  <div className="tt-row">
                    <span className="cat-dot" style={{ background: "var(--debit)" }} />
                    <span className="tt-name">Spending</span>
                    <span className="tt-val">{fmt(spending[hovered], currency)}</span>
                  </div>
                  <div className="tt-row tt-total">
                    <span className="tt-name">Net</span>
                    <span className={`tt-val ${net[hovered] < 0 ? "neg" : "pos"}`}>
                      {fmt(net[hovered], currency)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card empty">Loading…</div>
      )}

      {data && hasAnyFlow && monthData && (
        <CopyableTable
          className="txn-table"
          csvHeader={["Month", "Income", "Spending", "Net"]}
          toCsv={(b, i) => [
            // Raw "2026-01" buckets sort cleanly in a spreadsheet.
            b,
            plain(csvAmount(monthData.income[i])),
            plain(csvAmount(monthData.spending[i])),
            plain(csvAmount(monthData.net[i])),
          ]}
          data={monthData.buckets}
          header={
            <tr>
              <th>Month</th>
              <th className="num">Income</th>
              <th className="num">Spending</th>
              <th className="num">Net</th>
            </tr>
          }
          renderRow={(b, i) => (
            <tr key={b}>
              <td className="nowrap">{monthLabel(b)}</td>
              <td className="num nowrap pos">{fmt(monthData.income[i], currency)}</td>
              <td className="num nowrap neg">{fmt(monthData.spending[i], currency)}</td>
              <td className={`num nowrap ${monthData.net[i] < 0 ? "neg" : "pos"}`}>
                {fmt(monthData.net[i], currency)}
              </td>
            </tr>
          )}
        />
      )}
    </div>
  );
}
