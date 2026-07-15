export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(resp.status, detail);
  }
  return (await resp.json()) as T;
}

export function formatMoney(amount: string | number, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function compactMoney(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(v);
  } catch {
    return v.toFixed(0);
  }
}

export function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

/** Local-timezone YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** isoDate for epoch-second timestamps (used in CSV cells, where an
 * unambiguous date beats the localized display format). */
export function isoDateFromTs(ts: number | null): string {
  return ts ? isoDate(new Date(ts * 1000)) : "";
}

/** Local-timezone YYYY-MM-DD HH:MM, for CSV cells holding datetimes. */
export function isoDateTimeFromTs(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleString();
}
