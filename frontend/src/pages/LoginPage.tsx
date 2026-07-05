import { FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { AuthConfig } from "../types";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "That Google account is not on the allowlist (ALLOWED_EMAILS in .env).",
  unverified_email: "Google reported that email as unverified.",
  access_denied: "Google sign-in was cancelled.",
};

/* Stable field of rising gold dust (seeded, so it never re-rolls on
 * re-render). Purely decorative. */
function makeMotes() {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: 42 }, (_, i) => {
    const size = 2 + rand() * 3.5;
    return (
      <div
        key={i}
        className="login-mote"
        style={{
          left: `${(rand() * 100).toFixed(2)}%`,
          width: `${size}px`,
          height: `${size}px`,
          background: rand() > 0.75 ? "#F5D07A" : "#B98A33",
          boxShadow: `0 0 ${(4 + rand() * 8).toFixed(1)}px rgba(227,162,56,0.6)`,
          animationDuration: `${(9 + rand() * 14).toFixed(1)}s`,
          animationDelay: `${(-rand() * 20).toFixed(1)}s`,
        }}
      />
    );
  });
}

const MOTES = makeMotes();

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    api<AuthConfig>("/api/auth/config")
      .then(setConfig)
      .catch(() =>
        setError("Could not reach the server — check that it's running, then reload.")
      );
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) setError(ERROR_MESSAGES[err] ?? `Sign-in failed: ${err}`);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  const onMove = (e: React.MouseEvent) => {
    pending.current = { x: e.clientX, y: e.clientY };
    if (raf.current === null) {
      raf.current = requestAnimationFrame(() => {
        raf.current = null;
        if (pending.current) setTorch(pending.current);
      });
    }
  };

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
    <div className="login-wrap" onMouseMove={onMove}>
      <div
        className="login-torch"
        style={{
          background: torch
            ? `radial-gradient(560px at ${torch.x}px ${torch.y}px, rgba(227,162,56,0.09), rgba(227,162,56,0.03) 45%, transparent 70%)`
            : "none",
        }}
      />
      <div className="login-dust">{MOTES}</div>
      <div className="login-card">
        <div className="login-mark-wrap">
          <h1 className="login-wordmark">Durin</h1>
        </div>
        <div className="login-vein" />
        <p className="muted">Pull and check your finances.</p>

        <div className="login-below">
          {error && <div className="alert alert-error">{error}</div>}

          {config?.google_enabled && (
            <a className="btn-google" href="/api/auth/google/login">
              <GoogleIcon />
              <span>Sign in with Google</span>
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
    </div>
  );
}
