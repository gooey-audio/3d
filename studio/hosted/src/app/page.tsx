import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Studio } from "@/components/studio/Studio";
import { studioAccount } from "@/lib/auth";
import { aiInterestUrl } from "@/lib/chat-quota";
import { workspacePrefix } from "@/lib/workspace";


export default function Page() {
  return <Suspense><AccountStudio /></Suspense>;
}

async function AccountStudio() {
  await connection();
  const account = await studioAccount({ page: true });
  if (account.status !== "ok") redirect("/login");

  return (
    <Studio
      accountEmail={account.user.email}
      isAdmin={account.admin}
      uploadPrefix={`${workspacePrefix(account.user.id)}uploads/incoming/`}
      interestUrl={aiInterestUrl()}
    />
  );
}
