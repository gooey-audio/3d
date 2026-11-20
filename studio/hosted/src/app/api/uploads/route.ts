import { NextResponse } from "next/server";
import { fail, noStore, route } from "@/lib/http";
import { DIRECT_UPLOAD_MAX, looksLikeStl } from "@/lib/stl";
import * as store from "@/lib/store";

export const GET = route(async () => NextResponse.json(await store.listUploads(), { headers: noStore }));

/** Small STLs as multipart form data (`file` fields). Larger ones use /api/uploads/presign. */
export const POST = route(async (req) => {
  const form = await req.formData().catch(() => {
    throw fail(400, "want multipart form data with `file` fields (at most 4 MB in total; larger files upload directly)");
  });
  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (!files.length) throw fail(400, "no `file` in the form");
  const out: store.Upload[] = [];
  for (const f of files) {
    if (f.size > DIRECT_UPLOAD_MAX) throw fail(413, `${f.name} is over 4 MB; upload it directly`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!looksLikeStl(bytes)) throw fail(400, `${f.name} is not an STL`);
    out.push(await store.saveUpload(f.name, bytes));
  }
  return NextResponse.json(out, { status: 201 });
});
