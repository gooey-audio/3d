import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { aiSpend } from "@/lib/ai-spend";
import { studioAccount } from "@/lib/auth";
import { aiInterestUrl } from "@/lib/chat-quota";
import { listModels } from "@/lib/models";
import { Settings } from "./Settings";

export const metadata: Metadata = { title: "Settings · gooey-studio" };

type SearchParams = Promise<{ part?: string | string[] }>;

export default function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return <Suspense><AccountSettings searchParams={searchParams} /></Suspense>;
}

async function AccountSettings({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const account = await studioAccount({ page: true });
  if (account.status !== "ok") redirect("/login");
  // The part the studio had open, so the back link returns to it.
  const { part } = await searchParams;
  // This month's AI spend, read here and only for admins (never sent to anyone else). A
  // database outage shows as unavailable rather than failing the page.
  const spend = account.admin
    ? await aiSpend().catch((e) => {
        console.error("reading the AI spend failed", e);
        return null;
      })
    : null;

  return (
    <Settings
      accountEmail={account.user.email}
      backHref={typeof part === "string" && part ? `/?part=${encodeURIComponent(part)}` : "/"}
      models={listModels()}
      interestUrl={aiInterestUrl()}
      isAdmin={account.admin}
      spend={spend}
    />
  );
}
