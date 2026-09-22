/**
 * Decision Flood — Cloudflare Pages Functions 共享逻辑
 *
 * 与本地 server.js 同源改写到 Workers 运行时：
 *   - ES Modules，密钥从 context.env 注入（Cloudflare Secret），不落代码
 *   - events.json / replay.json 由 esbuild 打包成 JSON import（Workers 无 fs）
 *   - 公网部署：不提供 /api/warmup；真实调用端点带每 IP 限流（防滥用烧钱）
 */
import EVENTS from "../data/events.json";
import REPLAY from "../data/replay.json";

export { EVENTS, REPLAY };

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

// 计费口径：官方定价 $0.042 / 百万输入 token（输出免费），按 usage 回执折算
const PRICE_PER_MTOK = 0.042;

// ---------- 三问定义（一次调用并行评估） ----------
export const QUESTIONS = {
  queue: {
    type: "choice",
    instructions: "这条消息应该由哪个团队处理",
    criteria: {
      billing: "账单、扣款、发票、价格与费用疑问",
      technical: "登录失败、崩溃、故障等App或网站问题",
      refund: "退款、取消订单、重复扣款退回",
      sales: "购买意向、企业版、报价与合作咨询",
      account: "账号安全、盗号、手机号更换、实名认证",
      churn: "取消订阅、注销账号、挽留相关",
      noise: "灌水、测试、无关内容、纯表扬，无需业务处理",
    },
  },
  anger: {
    type: "score",
    instructions: "用户当前的不满程度",
    criteria: [
      "平静，仅陈述事实",
      "不满，但语气克制",
      "强烈不满，语气激烈",
      "暴怒，威胁投诉或曝光",
    ],
  },
  human: {
    type: "noul",
    instructions: "该消息需要人工立即介入",
  },
};

// 门禁阈值
export const GATE = { auto: 0.85, review: 0.6, humanNoul: 0.8, reviewNoul: 0.5 };

function gateOf(confidence, noul) {
  // Noul 有优先否决权：模型认为"需要人工"时，无论 Choice 多自信都不自动放行
  if (noul !== undefined && noul >= GATE.humanNoul) return "human";
  if (confidence >= GATE.auto) {
    return noul !== undefined && noul >= GATE.reviewNoul ? "review" : "auto";
  }
  if (confidence >= GATE.review) return "review";
  return "human";
}

// ---------- 真实调用 ----------
async function callJev(text, apiKey) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: text, questions: QUESTIONS }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Jev API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const latency = Date.now() - t0;
  // 真实调用留痕：wrangler tail / 函数日志里能看到每一笔，可与页面流水交叉核对
  const q = (data.answers && data.answers.queue) || {};
  const u = data.usage || {};
  console.log(
    `[jev] ${new Date().toISOString()}  ${latency}ms  ${u.input_tokens || 0} in / ${u.output_tokens || 0} out  -> ${q.choice || "?"} (conf ${q.confidence})`
  );
  return shape(data, latency, "live");
}

function shape(data, latency, mode) {
  const a = data.answers || {};
  const queue = a.queue || {};
  const anger = a.anger || {};
  const human = a.human || {};
  const inputTokens = (data.usage && data.usage.input_tokens) || 0;
  const cost = inputTokens * PRICE_PER_MTOK / 1e6;
  return {
    mode,
    model: data.model || MODEL,
    queue: {
      choice: queue.choice || null,
      confidence: queue.confidence ?? null,
      probabilities: queue.probabilities || {},
    },
    anger: {
      score: anger.score ?? null,
      confidence: anger.confidence ?? null,
      probabilities: anger.probabilities || {},
      legend: anger.legend || { "0": "平静", "1": "不满", "2": "激烈", "3": "暴怒" },
    },
    human: { noul: human.noul ?? null },
    gate: gateOf(queue.confidence ?? 0, human.noul),
    latency_ms: latency,
    usage: data.usage || { input_tokens: inputTokens, output_tokens: 0 },
    cost_usd: cost,
  };
}

// ---------- 模拟器（无 key 时保证整屏可跑） ----------
const KW = [
  [/^[\d\s]+$|哈哈|666|签到|沙发|打卡|码住|前排|围观|asdfghjkl|测试测试|复制错|打扰了|先占个位置|留个记号|感谢|好评|表扬/, "noise"],
  [/退款|退回|退了|退款到|退款被|退回多扣/, "refund"],
  [/扣款|扣了|账单|发票|续费|价格|收费|涨价|金额|优惠券|优惠码|套餐|对账|充值|消费限额/, "billing"],
  [/登录|闪退|白屏|崩溃|卡|报错|超时|加载|上传|429|bug|接口|回调|SSO|验证码收不到|收不到验证码|鸿蒙|同步/, "technical"],
  [/企业版|报价|采购|购买|商务|合作|授权|教育版|对公|席位/, "sales"],
  [/被盗|盗号|账号安全|注销账号|实名|手机号|误操作|权限|管理员|封了|个人信息|身份证/, "account"],
  [/取消|注销|投诉|曝光|12315|退订|不再用|垃圾|欺诈|踢皮球|没有然后/, "churn"],
];
function simDecide(text) {
  let queue = "technical";
  for (const [re, q] of KW) if (re.test(text)) { queue = q; break; }
  const angry = /！！|!{2,}|投诉|曝光|垃圾|欺诈|骗子|差|轰|滚|必须|立即|马上|最后|说法/.test(text);
  const mild = /麻烦|帮忙|请问|咨询|谢谢|建议|能不/.test(text);
  const anger = angry ? 2 + (Math.random() < 0.6 ? 1 : 0) : mild ? (Math.random() < 0.7 ? 0 : 1) : 1 + (Math.random() < 0.3 ? 1 : 0);
  const urgent = /立即|马上|最后希望|被盗|数据丢失|投诉|12315|不能登录|全空|三年|永久注销|曝光|报警|起诉|律师|严肃|事故|多次|四次|没有任何回复/.test(text);
  const noul = urgent ? 0.75 + Math.random() * 0.2 : Math.random() * 0.3;
  // 概率分布：主选项 0.60~0.97，其余按权重分摊，并归一到严格和为 1
  const opts = Object.keys(QUESTIONS.queue.criteria);
  const others = opts.filter((o) => o !== queue);
  const main = 0.6 + Math.random() * 0.37;
  const weights = others.map(() => Math.random() + 0.05);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const probs = {};
  others.forEach((o, i) => { probs[o] = Number(((1 - main) * weights[i] / wsum).toFixed(4)); });
  const used = others.reduce((a, o) => a + probs[o], 0);
  probs[queue] = Number((1 - used).toFixed(4));
  const conf = Math.min(0.99, main * (0.9 + Math.random() * 0.1));
  const latency = 70 + Math.floor(Math.random() * 430);
  const inputTokens = 320 + Math.floor(Math.random() * 160);
  // Score 等级概率分布：以命中等级为中心的三角分布
  const levels = QUESTIONS.anger.criteria.length;
  const raw = {};
  let sum = 0;
  for (let i = 0; i < levels; i++) {
    const w = 1 / (1 + Math.abs(i - anger) * 2.4) + Math.random() * 0.08;
    raw[String(i)] = w; sum += w;
  }
  const aProbs = {};
  Object.keys(raw).forEach((k) => { aProbs[k] = Number((raw[k] / sum).toFixed(3)); });
  const scoreVal = Math.min(levels - 1, Math.max(0, anger + (Math.random() - 0.5) * 0.3));
  return shape(
    {
      model: "jev-sim",
      answers: {
        queue: { type: "choice", choice: queue, confidence: Number(conf.toFixed(3)), probabilities: probs },
        anger: { type: "score", score: Number(scoreVal.toFixed(3)), confidence: Number((0.8 + Math.random() * 0.19).toFixed(3)), probabilities: aProbs, legend: { "0": "平静，仅陈述事实", "1": "不满，但语气克制", "2": "强烈不满，语气激烈", "3": "暴怒，威胁投诉或曝光" } },
        human: { type: "noul", noul: Number(noul.toFixed(3)) },
      },
      usage: { input_tokens: inputTokens, output_tokens: 65 },
    },
    latency,
    "sim"
  );
}

export async function decide(text, env) {
  if (env.TYPESAFE_API_KEY) {
    try { return await callJev(text, env.TYPESAFE_API_KEY); }
    catch (e) { return { error: e.message, status: e.status || 500 }; }
  }
  return simDecide(text);
}

// ---------- 回放池 ----------
let replayCursor = 0; // 单 isolate 内游标；多 isolate 下各自从 0 起，对演示无影响

export async function floodTick(n, forceLive, env) {
  const out = [];
  // 真实模式下每次调用要 0.3~2.5s，串行 12 条会让请求挂 30 秒，封顶 3
  if (forceLive) n = Math.min(n, 3);
  for (let i = 0; i < n; i++) {
    if (forceLive && env.TYPESAFE_API_KEY) {
      const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
      const r = await decide(ev.text, env);
      if (r.error) continue;
      out.push({ event: ev, result: r, fromPool: false, forced: true });
      continue;
    }
    if (REPLAY.length > 0) {
      const item = REPLAY[replayCursor % REPLAY.length];
      replayCursor++;
      out.push({ ...item, fromPool: true });
    } else {
      const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
      out.push({ event: ev, result: simDecide(ev.text), fromPool: false });
    }
  }
  return out;
}

// ---------- 公网限流（每 isolate 每 IP 每分钟 N 次真实调用；防 casual 滥用） ----------
const RATE = new Map(); // ip -> { count, resetAt }
export function rateLimited(request, cost = 1, limit = 30, windowMs = 60000) {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const now = Date.now();
  let e = RATE.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; RATE.set(ip, e); }
  e.count += cost;
  return e.count > limit;
}

// ---------- 响应工具 ----------
export function json(data, code = 200) {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
