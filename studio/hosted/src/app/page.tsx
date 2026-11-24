import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Studio } from "@/components/studio/Studio";
import { studioAccount } from "@/lib/auth";
import { workspacePrefix } from "@/lib/workspace";


export default function Page() {
  return <Suspense><AccountStudio /></Suspense>;
}

async function AccountStudio() {
  await connection();
  const account = await studioAccount({ page: true });
  if (account.status !== "ok") redirect("/login");

  const interestEmail = process.env.STUDIO_AI_INTEREST_EMAIL?.trim();
  return (
    <Studio
      accountEmail={account.user.email}
      uploadPrefix={`${workspacePrefix(account.user.id)}uploads/incoming/`}
      interestUrl={interestEmail ? `mailto:${encodeURIComponent(interestEmail).replace("%40", "@")}?subject=Gooey%20Studio%20AI%20access` : undefined}
    />
  );
}
