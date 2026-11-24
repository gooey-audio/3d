import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { fail, route } from "@/lib/http";
import { UPLOAD_MAX } from "@/lib/stl";
import { validIncoming } from "@/lib/store";

/** Presigned URLs for browser uploads of large STLs straight to Blob (past the function body
 *  limit), only to `the account’s uploads/incoming/<random>.stl`. /api/uploads/register files them. */
export const POST = route(async (req) => {
  const body = (await req.json()) as HandleUploadPresignedBody;
  if (body?.type !== "blob.generate-presigned-url") throw fail(400, "only presigned URL requests");
  const result = await handleUploadPresigned({
    body,
    request: req,
    // Not used (no completion callback), but the helper insists on one.
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY ?? "unused",
    getSignedToken: async (pathname) => {
      if (!validIncoming(pathname)) throw fail(400, "bad upload path");
      const validUntil = Date.now() + 15 * 60_000;
      const token = await issueSignedToken({ pathname, operations: ["put"], maximumSizeInBytes: UPLOAD_MAX, validUntil });
      return { token, urlOptions: { validUntil, maximumSizeInBytes: UPLOAD_MAX, addRandomSuffix: false, allowOverwrite: false } };
    },
  });
  return NextResponse.json(result);
});
