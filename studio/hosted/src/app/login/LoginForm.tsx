"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ googleFailed }: { googleFailed: boolean }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [error, setError] = useState(googleFailed ? "Google sign-in did not finish. Try again or use an email code." : "");

  async function signInWithGoogle() {
    setBusy("google");
    setError("");
    try {
      const result = await authClient.signIn.social({ provider: "google" });
      if (result.error || !result.data?.redirect) throw new Error();
      // The auth client follows the provider redirect.
    } catch {
      setError("Could not start Google sign-in. Try again or use an email code.");
      setBusy(null);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("email");
    setError("");
    const address = email.trim().toLowerCase();
    try {
      if (sent) {
        const result = await authClient.signIn.emailOtp({ email: address, otp: code.trim() });
        if (result.error) throw new Error(result.error.message || "That code could not be verified.");
        location.replace("/");
      } else {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: address, type: "sign-in" });
        if (result.error) throw new Error(result.error.message || "Could not send a code.");
        setSent(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <button className="primary" type="button" disabled={!!busy} onClick={signInWithGoogle}>
        {busy === "google" ? "Connecting to Google…" : "Continue with Google"}
      </button>
      <div className="login-divider">or use an email code</div>
      <label htmlFor={sent ? "code" : "email"}>{sent ? "Sign-in code" : "Invited email address"}</label>
      {sent ? (
        <>
          <p className="muted">If {email.trim()} is invited, you’ll receive a one-time code.</p>
          <input key="code" id="code" name="code" value={code} onChange={(e) => setCode(e.target.value)}
            inputMode="numeric" autoComplete="one-time-code" autoFocus required />
        </>
      ) : (
        <input key="email" id="email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" placeholder="you@example.com" autoFocus required />
      )}
      <button className="primary" type="submit" disabled={!!busy}>{sent ? "Sign in" : "Email me a code"}</button>
      {sent && (
        <button className="link" type="button" disabled={!!busy} onClick={() => { setSent(false); setCode(""); setError(""); }}>
          Use another address or request a new code
        </button>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  );
}
