import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, formatDateTime, isoDateTimeFromTs } from "../api";
import CopyableTable from "../components/CopyableTable";
import Money, { useMoney } from "../components/Money";
import { csvAmount } from "../csv";
import { Account, Connection } from "../types";

/** Inline alias editor: saves on blur or Enter, only when the value
 * actually changed. An empty value clears the alias. */
function AliasInput({
  account,
  onSaved,
  onError,
}: {
  account: Account;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(account.alias);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(account.alias);
  }, [account.alias]);

  const save = async () => {
    const next = value.trim();
    if (next === account.alias) return;
    setBusy(true);
    try {
      await api(`/api/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ alias: next }),
      });
      onSaved();
    } catch (err) {
      setValue(account.alias);
      onError(err instanceof Error ? err.message : "Could not save the alias");
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      className="alias-input"
      type="text"
      placeholder={account.name}
      title="Shown instead of the bank's name everywhere outside Settings"
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setValue(account.alias);
      }}
    />
  );
}

export default function SettingsPage() {
  const { plain } = useMoney();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showOff, setShowOff] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollTimer = useRef<number | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [conns, accts] = await Promise.all([
        api<Connection[]>("/api/connections"),
        api<Account[]>("/api/accounts?include_disabled=1"),
      ]);
      if (!alive.current) return [];
      setConnections(conns);
      // The built frontend goes live before the backend restarts, so an
      // older backend may not send `enabled` yet — treat missing as on.
      setAccounts(accts.map((a) => ({ ...a, enabled: a.enabled ?? true })));
      return conns;
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : "Failed to load settings");
      }
      return [];
    }
  }, []);

  // Poll while any connection is syncing so status/accounts update live.
  const scheduleRefresh = useCallback(
    (conns: Connection[]) => {
      if (!alive.current) return;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      if (conns.some((c) => c.syncing)) {
        pollTimer.current = window.setTimeout(async () => {
          if (!alive.current) return;
          scheduleRefresh(await load());
        }, 2000);
      }
    },
    [load]
  );

  useEffect(() => {
    alive.current = true;
    load().then(scheduleRefresh);
    return () => {
      alive.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [load, scheduleRefresh]);

  const addConnection = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api<Connection>("/api/connections", {
        method: "POST",
        body: JSON.stringify({ token, name }),
      });
      setToken("");
      setName("");
      setNotice("Connection added — first sync is running, transactions will appear shortly.");
      scheduleRefresh(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add connection");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async (id: number) => {
    setError("");
    try {
      await api(`/api/connections/${id}/sync`, { method: "POST", body: "{}" });
      scheduleRefresh(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed to start");
    }
  };

  const remove = async (conn: Connection) => {
    if (
      !window.confirm(
        `Delete "${conn.name}" and all of its accounts and transactions? This cannot be undone.`
      )
    ) {
      return;
    }
    setError("");
    try {
      await api(`/api/connections/${conn.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const toggleAccount = async (a: Account) => {
    if (
      a.enabled &&
      !window.confirm(
        `Turn off "${a.alias || a.name}"? All of its transactions and balance history ` +
          `will be deleted, and it will disappear everywhere outside Settings. You can ` +
          `turn it back on later and its data will re-sync.`
      )
    ) {
      return;
    }
    setError("");
    try {
      await api(`/api/accounts/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !a.enabled }),
      });
      // Turning an account back on starts a background sync; poll it.
      scheduleRefresh(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the account");
    }
  };

  // Status as text (shared with the CSV copy) and as a colored badge.
  const statusText = (c: Connection) => {
    if (c.syncing) return "syncing…";
    if (c.last_sync_status === "ok") return "ok";
    if (c.last_sync_status === "partial") return "partial";
    if (c.last_sync_status === "error") return "error";
    return "never synced";
  };
  const statusLabel = (c: Connection) => {
    const color = c.syncing
      ? " badge-blue"
      : c.last_sync_status === "ok"
        ? " badge-green"
        : c.last_sync_status === "partial"
          ? " badge-amber"
          : c.last_sync_status === "error"
            ? " badge-red"
            : "";
    return <span className={`badge${color}`}>{statusText(c)}</span>;
  };

  const offCount = accounts.filter((a) => !a.enabled).length;
  const shownAccounts = showOff ? accounts : accounts.filter((a) => a.enabled);

  return (
    <div className="page">
      <h2>Settings</h2>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <section className="card">
        <h3>Add a SimpleFin connection</h3>
        <p className="muted">
          Get a setup token from your SimpleFin server — for real banks, create an account at{" "}
          <a href="https://bridge.simplefin.org" target="_blank" rel="noreferrer">
            bridge.simplefin.org
          </a>
          , connect your banks, then click <em>New App Connection</em> and paste the setup token
          here. Setup tokens are one-time use. (A raw access URL also works.)
        </p>
        <form onSubmit={addConnection} className="add-form">
          <label>
            Setup token
            <textarea
              required
              rows={3}
              placeholder="Paste your SimpleFin setup token…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label>
            Name (optional)
            <input
              type="text"
              placeholder="e.g. Personal banks"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="btn btn-primary" disabled={busy || !token.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
        <details className="muted small">
          <summary>Just trying it out?</summary>
          <p>
            SimpleFin publishes a demo server with fake data. Paste this access URL above:{" "}
            <code>https://demo:demo@beta-bridge.simplefin.org/simplefin</code>
          </p>
        </details>
      </section>

      <section className="card">
        <h3>Connections</h3>
        {connections.length === 0 ? (
          <p className="muted">No connections yet.</p>
        ) : (
          <CopyableTable
            csvHeader={["Name", "Status", "Accounts", "Last synced", "Error"]}
            toCsv={(c) => [
              c.name,
              statusText(c),
              String(c.account_count),
              isoDateTimeFromTs(c.last_sync_at),
              c.last_sync_error || "",
            ]}
            data={connections}
            header={
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Accounts</th>
                <th>Last synced</th>
                <th></th>
              </tr>
            }
            renderRow={(c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  {statusLabel(c)}
                  {c.last_sync_error && (
                    <div
                      className={`muted small ${
                        c.last_sync_status === "ok" ? "" : "error-text"
                      }`}
                    >
                      {c.last_sync_error}
                    </div>
                  )}
                </td>
                <td>{c.account_count}</td>
                <td className="nowrap">{formatDateTime(c.last_sync_at)}</td>
                <td className="nowrap actions">
                  <button
                    className="btn btn-quiet"
                    onClick={() => syncNow(c.id)}
                    disabled={c.syncing}
                  >
                    Sync now
                  </button>
                  <button className="btn btn-danger" onClick={() => remove(c)}>
                    Delete
                  </button>
                </td>
              </tr>
            )}
          />
        )}
      </section>

      <section className="card">
        <div className="cat-card-head">
          <h3>Accounts</h3>
          <div className="spacer" />
          {offCount > 0 && (
            <button className="btn btn-quiet btn-small" onClick={() => setShowOff(!showOff)}>
              {showOff
                ? "Hide turned-off accounts"
                : `Show ${offCount} turned-off account${offCount === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
        <p className="muted small">
          An alias replaces the bank's account name everywhere else in the app. Leave it
          empty to keep the bank's name. Turning an account off deletes its transactions
          and balance history and hides it everywhere outside this page; turning it back
          on re-syncs its data.
        </p>
        {accounts.length === 0 ? (
          <p className="muted">No accounts yet — they appear after the first sync.</p>
        ) : shownAccounts.length === 0 ? (
          <p className="muted">
            All accounts are turned off — use the button above to show them.
          </p>
        ) : (
          <CopyableTable
            csvHeader={[
              "Institution",
              "Account",
              "Alias",
              "Balance",
              "Available",
              "Currency",
              "As of",
              "On",
            ]}
            toCsv={(a) => [
              a.org_name,
              a.name,
              a.alias,
              plain(csvAmount(a.balance)),
              a.available_balance != null ? plain(csvAmount(a.available_balance)) : "",
              a.currency,
              isoDateTimeFromTs(a.balance_date),
              a.enabled ? "yes" : "no",
            ]}
            data={shownAccounts}
            header={
              <tr>
                <th>Institution</th>
                <th>Account</th>
                <th>Alias</th>
                <th className="num">Balance</th>
                <th className="num">Available</th>
                <th>As of</th>
                <th></th>
              </tr>
            }
            renderRow={(a) => (
              <tr key={a.id} className={a.enabled ? undefined : "row-off"}>
                <td>{a.org_name || "—"}</td>
                <td>
                  {a.name}
                  {!a.enabled && <span className="badge">off</span>}
                </td>
                <td>
                  <AliasInput
                    account={a}
                    onSaved={load}
                    onError={(msg) => setError(msg)}
                  />
                </td>
                <td className="num nowrap">
                  <Money amount={a.balance} currency={a.currency} />
                </td>
                <td className="num nowrap">
                  {a.available_balance != null ? (
                    <Money amount={a.available_balance} currency={a.currency} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="nowrap">{formatDateTime(a.balance_date)}</td>
                <td className="nowrap actions">
                  <button
                    className={a.enabled ? "btn btn-danger" : "btn btn-quiet"}
                    onClick={() => toggleAccount(a)}
                  >
                    {a.enabled ? "Turn off" : "Turn on"}
                  </button>
                </td>
              </tr>
            )}
          />
        )}
      </section>
    </div>
  );
}
