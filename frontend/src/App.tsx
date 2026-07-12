import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { DiscreteModeContext } from "./components/Money";
import { Connection, REFRESHED_EVENT, SyncStatus, User } from "./types";
import LoginPage from "./pages/LoginPage";
import TransactionsPage from "./pages/TransactionsPage";
import SpendingPage from "./pages/SpendingPage";
import CashflowPage from "./pages/CashflowPage";
import AssetsPage from "./pages/AssetsPage";
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
  const [discrete, setDiscrete] = useState(
    () => localStorage.getItem("durin-discrete") === "1"
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const alive = useRef(true);
  const pollTimer = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem("durin-discrete", discrete ? "1" : "0");
  }, [discrete]);

  // Close the user menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
    <DiscreteModeContext.Provider value={discrete}>
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
          <NavLink to="/cashflow">Cash flow</NavLink>
          <NavLink to="/assets">Assets</NavLink>
          <NavLink to="/categories">Categories</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={forceRefresh} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh"}
        </button>
        <div className="user-menu" ref={menuRef}>
          <button
            className="btn btn-quiet user-menu-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={user.name}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {discrete && <span className="discrete-badge">DISCRETE</span>}
            <span className="user-email">{user.email}</span>
            <span className="msel-caret">▾</span>
          </button>
          {menuOpen && (
            <div className="msel-pop user-menu-pop" role="menu">
              <button
                type="button"
                className="msel-opt"
                role="menuitem"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                <span className="menu-icon">{theme === "dark" ? "☀" : "☾"}</span>
                <span className="msel-opt-label">
                  Switch to {theme === "dark" ? "light" : "dark"} theme
                </span>
              </button>
              <button
                type="button"
                className="msel-opt"
                role="menuitemcheckbox"
                aria-checked={discrete}
                onClick={() => setDiscrete(!discrete)}
              >
                <input type="checkbox" checked={discrete} readOnly tabIndex={-1} />
                <span className="msel-opt-label">Discrete mode (mask amounts)</span>
              </button>
              <button type="button" className="msel-opt" role="menuitem" onClick={logout}>
                <span className="menu-icon">⏻</span>
                <span className="msel-opt-label">Sign out</span>
              </button>
            </div>
          )}
        </div>
      </header>
      {syncNote && <div className="sync-note">{syncNote}</div>}
      <main>
        <Routes>
          <Route path="/" element={<TransactionsPage />} />
          <Route path="/spending" element={<SpendingPage />} />
          <Route path="/cashflow" element={<CashflowPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<TransactionsPage />} />
        </Routes>
      </main>
    </BrowserRouter>
    </DiscreteModeContext.Provider>
  );
}
