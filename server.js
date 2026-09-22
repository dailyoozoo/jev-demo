/**
 * Decision Flood — Jev System One 实时决策大屏 · 后端服务
 * 零依赖，Node 22+（内置 fetch）
 *
 * 启动：
 *   node server.js                 # 无 key = SIM 模拟模式；有 key = LIVE 真实模式
 *   TYPESAFE_API_KEY=sk-xxx node server.js --warmup 40
 *                                  # LIVE 模式下预调用 40 条生成回放池 data/replay.json
 *
 * 洪流幕使用回放池（不消耗 API、满帧流畅）；慢镜头幕始终真实调用（LIVE）。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
// 只监听本机回环：这不是一个要对外服务的站点，且 /api/decide、/api/warmup 会真实花钱。
// 绑 0.0.0.0 会让同网段任何人都能触发付费调用。
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;

// 读取同目录 .env（零依赖；已存在的环境变量优先）
const ENV_PATH = path.join(ROOT, ".env");
if (fs.existsSync(ENV_PATH)) {
  fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  });
}

const API_URL = "https://api.typesafe.ai/v1/systemone";
const API_KEY = process.env.TYPESAFE_API_KEY || "";
const LIVE = API_KEY.length > 0;
const MODEL = "jev-latest";

// 计费口径：官方定价 $0.042 / 百万输入 token（输出免费），用于按 usage 回执折算每次成本
const PRICE_PER_MTOK = 0.042;

const EVENTS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "events.json"), "utf8"));
const REPLAY_PATH = path.join(ROOT, "data", "replay.json");
let replay = fs.existsSync(REPLAY_PATH) ? JSON.parse(fs.readFileSync(REPLAY_PATH, "utf8")) : [];
let replayCursor = 0;

// ---------- 三问定义（一次调用并行评估） ----------
const QUESTIONS = {
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
const GATE = { auto: 0.85, review: 0.6, humanNoul: 0.8, reviewNoul: 0.5 };
// 单次 HTTP 预热的硬上限：这是个会真实花钱的接口，防止被误用（或局域网内被乱调）一次烧掉大量额度
const WARMUP_MAX = 200;

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
async function callJev(text) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
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
  // 真实调用留痕：运行服务的窗口里能看到每一笔，可与页面上的流水交叉核对
  const q = (data.answers && data.answers.queue) || {};
  const u = data.usage || {};
  console.log(
    `[jev] ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ` +
    `${String(latency).padStart(4)}ms  ${u.input_tokens || 0} in / ${u.output_tokens || 0} out  ` +
    `-> ${q.choice || "?"} (conf ${q.confidence})`
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

async function decide(text) {
  if (LIVE) {
    try { return await callJev(text); }
    catch (e) { return { error: e.message, status: e.status || 500 }; }
  }
  return simDecide(text);
}

// ---------- 回放池 ----------
async function warmup(count) {
  const out = [];
  for (let i = 0; i < Math.min(count, EVENTS.length); i++) {
    const ev = EVENTS[i];
    const r = LIVE ? await callJev(ev.text) : simDecide(ev.text);
    if (r.error) { console.error(`warmup #${i} failed:`, r.error); continue; }
    out.push({ event: ev, result: r });
    process.stdout.write(`\rwarmup ${out.length}/${count} `);
  }
  console.log("");
  replay = out; replayCursor = 0;
  fs.writeFileSync(REPLAY_PATH, JSON.stringify(out, null, 1));
  return out.length;
}

async function floodTick(n, forceLive) {
  const out = [];
  // 真实模式下每次调用要 0.3~2.5s，串行 12 条会让 HTTP 请求挂 30 秒，封顶 3
  if (forceLive) n = Math.min(n, 3);
  for (let i = 0; i < n; i++) {
    // forceLive：洪流幕也逐条真实调用（节奏会跟着真实延迟走，而不是匀速）
    if (forceLive && LIVE) {
      const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
      const r = await decide(ev.text);
      if (r.error) continue;
      out.push({ event: ev, result: r, fromPool: false, forced: true });
      continue;
    }
    if (replay.length > 0) {
      const item = replay[replayCursor % replay.length];
      replayCursor++;
      // 注意：存档里 result.mode 可能是 "sim"（无 key 时预热出来的），前端据此判定真实/回放/模拟
      out.push({ ...item, fromPool: true });
    } else {
      const ev = EVENTS[Math.floor(Math.random() * EVENTS.length)];
      out.push({ event: ev, result: simDecide(ev.text), fromPool: false });
    }
  }
  return out;
}

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { finish(d ? JSON.parse(d) : {}); } catch { finish({}); } });
    // 超限 destroy 或客户端中途断开时 'end' 不会触发，缺了这两个监听 Promise 会永久悬挂
    req.on("close", () => finish({}));
    req.on("error", () => finish({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public", "index.html")), MIME[".html"]);
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public", "app.js")), MIME[".js"]);
    }
    if (req.method === "GET" && url.pathname === "/style.css") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public", "style.css")), MIME[".css"]);
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return send(res, 200, JSON.stringify({ mode: LIVE ? "live" : "sim", model: MODEL, events: EVENTS.length, replay: replay.length, gate: GATE }));
    }
    if (req.method === "GET" && url.pathname === "/api/pool") {
      return send(res, 200, JSON.stringify(EVENTS));
    }
    if (url.pathname === "/api/flood-tick" && req.method === "POST") {
      const b = await readBody(req);
      return send(res, 200, JSON.stringify(await floodTick(Math.min(Number(b.n) || 1, 12), b.live === true)));
    }
    if (url.pathname === "/api/decide" && req.method === "POST") {
      const b = await readBody(req);
      if (!b.text) return send(res, 400, JSON.stringify({ error: "text required" }));
      const r = await decide(String(b.text).slice(0, 8000));
      return send(res, 200, JSON.stringify(r));
    }
    if (url.pathname === "/api/warmup" && req.method === "POST") {
      const b = await readBody(req);
      const want = Number(b.count) || 40;
      const n = await warmup(Math.min(want, WARMUP_MAX));
      return send(res, 200, JSON.stringify({ warmed: n, requested: want, cappedAt: WARMUP_MAX }));
    }
    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
});

if (process.argv.includes("--warmup")) {
  const i = process.argv.indexOf("--warmup");
  const count = Number(process.argv[i + 1]) || 40;
  warmup(count).then((n) => { console.log(`replay pool ready: ${n} items -> ${REPLAY_PATH}`); process.exit(0); });
} else {
  // 端口被占用时自动往后找，避免"上一次没关干净"导致启动失败
  let listenPort = PORT;
  const OPEN = process.argv.includes("--open");
  const banner = () => {
    console.log(`Decision Flood running -> http://localhost:${listenPort}  (仅本机可访问 ${HOST})`);
    console.log(`mode: ${LIVE ? "LIVE (real Jev API)" : "SIM (no TYPESAFE_API_KEY, simulated probabilities)"}`);
    console.log(`events: ${EVENTS.length}   replay pool: ${replay.length}`);
    if (LIVE && replay.length === 0) console.log("hint: run `node server.js --warmup 200` once to pre-record real responses for the flood scene (optional, costs ~$0.005)");
    console.log("Ctrl+C to stop");
    if (OPEN) {
      try {
        require("child_process").exec(`start "" "http://localhost:${listenPort}"`, () => {});
      } catch (e) {
        console.log("(could not open the browser automatically, please visit the URL above)");
      }
    }
  };
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && listenPort < PORT + 10) {
      console.log(`port ${listenPort} is busy, trying ${listenPort + 1} ...`);
      listenPort++;
      setTimeout(() => server.listen(listenPort, HOST), 60);
    } else {
      console.error("server error:", e.message);
      process.exit(1);
    }
  });
  server.listen(listenPort, HOST, banner);
}
