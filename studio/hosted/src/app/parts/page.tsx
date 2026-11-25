import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Parts } from "@/components/studio/Parts";
import { studioAccount } from "@/lib/auth";

export const metadata: Metadata = { title: "Parts · gooey-studio" };

export default function PartsPage() {
  return <Suspense><AccountParts /></Suspense>;
}

async function AccountParts() {
  await connection();
  const account = await studioAccount({ page: true });
  if (account.status !== "ok") redirect("/login");
  return <Parts accountEmail={account.user.email} />;
}
