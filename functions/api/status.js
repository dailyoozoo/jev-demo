import { EVENTS, REPLAY, GATE, json } from "../_lib.js";

export async function onRequestGet(context) {
  const live = Boolean(context.env.TYPESAFE_API_KEY);
  return json({
    mode: live ? "live" : "sim",
    model: "jev-latest",
    events: EVENTS.length,
    replay: REPLAY.length,
    gate: GATE,
  });
}
