import { fail, route } from "@/lib/http";
import * as store from "@/lib/store";

export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const img = await store.openJobImage(id);
  if (!img) throw fail(404, `no image for render ${id}`);
  const download = req.nextUrl.searchParams.has("download");
  return new Response(img.stream, {
    headers: {
      "content-type": "image/png",
      "content-length": String(img.size),
      // A job's image never changes once written.
      "cache-control": "private, max-age=86400, immutable",
      ...(download ? { "content-disposition": `attachment; filename="${id}.png"` } : {}),
    },
  });
});
