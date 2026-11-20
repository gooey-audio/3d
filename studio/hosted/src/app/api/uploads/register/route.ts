import { NextResponse } from "next/server";
import { z } from "zod";
import { body, fail, route } from "@/lib/http";
import { looksLikeStl } from "@/lib/stl";
import * as store from "@/lib/store";

export const maxDuration = 60;

const Register = z.object({ pathname: z.string(), name: z.string().max(200) });

/** Files a presigned upload under uploads/<sha256>.stl with its metadata. */
export const POST = route(async (req) => {
  const { pathname, name } = await body(req, Register);
  if (!store.validIncoming(pathname)) throw fail(400, "bad upload path");
  const u = await store.adoptIncoming(pathname, name);
  const got = await store.readUpload(u.sha256);
  if (!got || !looksLikeStl(got.stl)) {
    await store.deleteUpload(u.sha256);
    throw fail(400, `${name} is not an STL`);
  }
  return NextResponse.json(u, { status: 201 });
});
