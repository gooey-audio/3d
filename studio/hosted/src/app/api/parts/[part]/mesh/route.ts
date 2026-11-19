import { fail, noStore, partName, route, type PartCtx } from "@/lib/http";
import * as store from "@/lib/store";

/** The last good mesh (binary STL). */
export const GET = route(async (req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const m = await store.openMesh(part);
  if (!m) throw fail(404, `part \`${part}\` has no mesh yet`);
  const download = req.nextUrl.searchParams.has("download");
  return new Response(m.stream, {
    headers: {
      ...noStore,
      "content-type": "model/stl",
      "content-length": String(m.size),
      ...(download ? { "content-disposition": `attachment; filename="${part}.stl"` } : {}),
    },
  });
});
