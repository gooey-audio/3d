import { fail, noStore, partName, route, type PartCtx } from "@/lib/http";
import * as modal from "@/lib/modal";
import * as store from "@/lib/store";

export const maxDuration = 60;

/** Builds the current script with STEP output and downloads it. */
export const GET = route(async (_req, ctx: PartCtx) => {
  const part = partName((await ctx.params).part);
  const [script, scene] = await Promise.all([store.readScript(part), store.readScene(part)]);
  if (script === null) throw fail(404, `no part \`${part}\``);
  const res = await modal.build(script, scene.params ?? {}, { filename: `${part}.js`, step: true });
  if (!res.ok || !res.step_b64) throw fail(422, `the build failed: ${res.error?.kind ?? "?"}: ${res.error?.message ?? "no STEP output"}`);
  return new Response(Buffer.from(res.step_b64, "base64"), {
    headers: { ...noStore, "content-type": "model/step", "content-disposition": `attachment; filename="${part}.step"` },
  });
});
