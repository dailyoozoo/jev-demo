import { decide, json, readJson, rateLimited } from "../_lib.js";

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  const text = String(body.text || "").slice(0, 8000);
  if (!text) return json({ error: "text required" }, 400);
  // 有 key 才限流；模拟模式不花钱，不拦
  if (context.env.TYPESAFE_API_KEY && rateLimited(context.request, 1, 20, 60000)) {
    return json({ error: "rate limited: 20 live calls / minute / IP" }, 429);
  }
  const r = await decide(text, context.env);
  if (r.error) return json(r, r.status || 502);
  return json(r);
}
