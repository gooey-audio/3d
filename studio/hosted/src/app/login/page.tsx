import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { studioAccount } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in · gooey-studio" };

type SearchParams = Promise<{ google?: string | string[] }>;

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return <Suspense><AccountSignIn searchParams={searchParams} /></Suspense>;
}

async function AccountSignIn({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const account = await studioAccount({ page: true });
  if (account.status === "ok") redirect("/");
  const { google } = await searchParams;
  return (
    <main className="login">
      <section className="login-card">
        <h1>gooey-studio</h1>
        <p>Build parametric 3D models, check them in a live preview, and export STL or STEP files.</p>
        {account.status === "unavailable" ? (
          <p className="error" role="status">Sign-in is temporarily unavailable.</p>
        ) : (
          <>
            <p className="muted">Sign in to the private beta to access your parts, conversations, and renders.</p>
            {account.status === "denied" && <p className="error" role="alert">This account does not have beta access.</p>}
            <LoginForm googleFailed={google === "failed"} />
          </>
        )}
      </section>
    </main>
  );
}
