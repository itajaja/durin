import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { api, ApiError } from "./api";
import { User } from "./types";
import LoginPage from "./pages/LoginPage";
import TransactionsPage from "./pages/TransactionsPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  // undefined = still checking the session; null = not signed in.
  const [user, setUser] = useState<User | null | undefined>(undefined);

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
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <span className="user-email" title={user.name}>
          {user.email}
        </span>
        <button className="btn btn-quiet" onClick={logout}>
          Sign out
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<TransactionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<TransactionsPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
