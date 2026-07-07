import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, formatDateTime } from "../api";
import Money from "../components/Money";
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
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
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
        api<Account[]>("/api/accounts"),
      ]);
      if (!alive.current) return [];
      setConnections(conns);
      setAccounts(accts);
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

  const statusLabel = (c: Connection) => {
    if (c.syncing) return <span className="badge badge-blue">syncing…</span>;
    if (c.last_sync_status === "ok") return <span className="badge badge-green">ok</span>;
    if (c.last_sync_status === "partial")
      return <span className="badge badge-amber">partial</span>;
    if (c.last_sync_status === "error") return <span className="badge badge-red">error</span>;
    return <span className="badge">never synced</span>;
  };

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
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Accounts</th>
                <th>Last synced</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
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
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Accounts</h3>
        <p className="muted small">
          An alias replaces the bank's account name everywhere else in the app. Leave it
          empty to keep the bank's name.
        </p>
        {accounts.length === 0 ? (
          <p className="muted">No accounts yet — they appear after the first sync.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Institution</th>
                <th>Account</th>
                <th>Alias</th>
                <th className="num">Balance</th>
                <th className="num">Available</th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.org_name || "—"}</td>
                  <td>{a.name}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
