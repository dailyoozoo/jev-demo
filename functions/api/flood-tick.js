import { floodTick, json, readJson, rateLimited } from "../_lib.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  const n = Math.min(Math.max(Number(body.n) || 1, 1), 12);
  const live = body.live === true;
  // 真实洪流：每次最多 3 条，按条数计额度（20 次/分钟/IP）
  if (live && context.env.TYPESAFE_API_KEY) {
    const cost = Math.min(n, 3);
    if (rateLimited(context.request, cost, 20, 60000)) {
      return json({ error: "rate limited: 20 live calls / minute / IP" }, 429);
    }
  }
  return json(await floodTick(n, live, context.env));
}
