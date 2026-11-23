"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
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
      <button className="primary" type="submit" disabled={busy}>{sent ? "Sign in" : "Email me a code"}</button>
      {sent && (
        <button className="link" type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(""); }}>
          Use another address or request a new code
        </button>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  );
}
