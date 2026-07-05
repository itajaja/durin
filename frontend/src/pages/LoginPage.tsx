import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { AuthConfig } from "../types";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "That Google account is not on the allowlist (ALLOWED_EMAILS in .env).",
  unverified_email: "Google reported that email as unverified.",
  access_denied: "Google sign-in was cancelled.",
};

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthConfig>("/api/auth/config")
      .then(setConfig)
      .catch(() =>
        setError("Could not reach the server — check that it's running, then reload.")
      );
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) setError(ERROR_MESSAGES[err] ?? `Sign-in failed: ${err}`);
  }, []);

  const devLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      onLogin();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Durin</h1>
        <p className="muted">Pull and check your finances.</p>

        {error && <div className="alert alert-error">{error}</div>}

        {config?.google_enabled && (
          <a className="btn btn-google" href="/api/auth/google/login">
            Sign in with Google
          </a>
        )}

        {config?.dev_login_enabled && (
          <form onSubmit={devLogin} className="dev-login">
            {config.google_enabled && <div className="divider">or</div>}
            <label htmlFor="dev-email">Dev login (local only)</label>
            <input
              id="dev-email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !email}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {config && !config.google_enabled && !config.dev_login_enabled && (
          <div className="alert alert-error">
            No sign-in method is configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or
            DEV_LOGIN=true in .env, then restart.
          </div>
        )}
      </div>
    </div>
  );
}
