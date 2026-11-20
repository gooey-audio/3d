"use client";
import { useState } from "react";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? res.statusText);
      const next = new URLSearchParams(location.search).get("next");
      location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <form className="login-form" onSubmit={submit}>
      <strong>gooey-studio</strong>
      <input type="password" name="password" placeholder="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="primary" type="submit" disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
