import { EVENTS, json } from "../_lib.js";

export async function onRequestGet() {
  return json(EVENTS);
}
