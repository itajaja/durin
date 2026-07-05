import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { Connection, REFRESHED_EVENT, SyncStatus, User } from "./types";
import LoginPage from "./pages/LoginPage";
import TransactionsPage from "./pages/TransactionsPage";
import SpendingPage from "./pages/SpendingPage";
import CategoriesPage from "./pages/CategoriesPage";
import SettingsPage from "./pages/SettingsPage";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("durin-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  // undefined = still checking the session; null = not signed in.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const alive = useRef(true);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("durin-theme", theme);
  }, [theme]);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api<User>("/api/auth/me"));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      // Treat as signed out locally either way; the next load will 401.
      console.error(err);
    }
    setUser(null);
  };

  const finishRefresh = useCallback(async (stillSyncing: boolean) => {
    if (!alive.current) return;
    setSyncing(false);
    window.dispatchEvent(new Event(REFRESHED_EVENT));
    try {
      const conns = await api<Connection[]>("/api/connections");
      if (!alive.current) return;
      const bad = conns.filter(
        (c) => c.last_sync_status === "error" || c.last_sync_status === "partial"
      );
      if (bad.length > 0) {
        setSyncNote(`Sync problem with ${bad.map((c) => c.name).join(", ")} — see Settings.`);
      } else if (stillSyncing) {
        setSyncNote("Sync is still running in the background — data will keep updating.");
      } else {
        setSyncNote("");
      }
    } catch {
      // best-effort
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
        finishRefresh(stillSyncing);
      }, 2000);
    },
    [finishRefresh]
  );

  const forceRefresh = async () => {
    setSyncing(true);
    setSyncNote("");
    try {
      const res = await api<{ total: number }>("/api/sync", { method: "POST", body: "{}" });
      if (res.total === 0) {
        setSyncing(false);
        setSyncNote("No SimpleFin connections yet — add one in Settings.");
        return;
      }
      pollUntilDone(0);
    } catch (err) {
      setSyncing(false);
      setSyncNote(err instanceof Error ? err.message : "Refresh failed");
    }
  };

  if (user === undefined) {
    return <div className="splash">Loading…</div>;
  }
  if (user === null) {
    return <LoginPage onLogin={refreshUser} />;
  }

  return (
    <BrowserRouter>
      <header className="topbar">
        <Link to="/" className="brand">
          Durin
        </Link>
        <nav>
          <NavLink to="/" end>
            Transactions
          </NavLink>
          <NavLink to="/spending">Spending</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={forceRefresh} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh"}
        </button>
        <button
          className="btn btn-quiet theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <span className="user-email" title={user.name}>
          {user.email}
        </span>
        <button className="btn btn-quiet" onClick={logout}>
          Sign out
        </button>
      </header>
      {syncNote && <div className="sync-note">{syncNote}</div>}
      <main>
        <Routes>
          <Route path="/" element={<TransactionsPage />} />
          <Route path="/spending" element={<SpendingPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<TransactionsPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
