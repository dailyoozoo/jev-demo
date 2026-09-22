/* Decision Flood — 大屏前端 */
const $ = (id) => document.getElementById(id);
const LLM_COST = 0.01388;   // 官方 demo 口径 $/call
const LLM_LAT = 8566;       // ms

const state = {
  scene: "flood", speed: 1, paused: false, status: null, started: false, source: "pool",
  decided: 0, latSum: 0, latN: 0, costSum: 0, llmCostSum: 0,
  lanes: { auto: 0, review: 0, human: 0 }, calls: 0,
  liveCalls: 0, liveCost: 0, history: [], lats: [],
};

let evSeq = 1000, queue = [], refilling = false, loopTimer = null;
let lastEvents = [];

const GATE_LABEL = { auto: "自动执行", review: "升级复核", human: "转人工" };
const QUEUE_COLORS = ["var(--accent)", "var(--purple)", "#94A3B8", "#CBD5E1"];
const ANGER_COLORS = ["var(--green)", "var(--amber)", "#EA8C55", "var(--red)"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (v, n = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(n));
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return r.json();
}

/* ---------- 通用小部件 ---------- */
function el(cls, html) { const d = document.createElement("div"); if (cls) d.className = cls; if (html !== undefined) d.innerHTML = html; return d; }
function animateBars(root, delay = 0) {
  const bars = root.querySelectorAll(".bars i[data-w], .sl-bars i[data-w]");
  const instant = state.instant === true;   // 静态帧模式：直接给终态，便于录制定格
  // 洪流幕每 620ms 就重建一次决策卡，级联必须在这个周期内跑完，所以间隔压到 26ms
  bars.forEach((b, i) => {
    if (instant) { b.style.transition = "none"; b.style.width = b.dataset.w + "%"; return; }
    setTimeout(() => { b.style.width = b.dataset.w + "%"; }, delay + i * 26);
  });
}

/* ---------- 幕一：洪流 ---------- */
let liveBusy = false;
function startLoop() {
  clearTimeout(loopTimer);
  const run = () => {
    if (state.paused || state.scene !== "flood") return;
    if (state.source === "live") {
      liveStep();                                   // 真实模式：节奏跟着真实延迟走
      loopTimer = setTimeout(run, 260);
    } else {
      step();                                       // 回放模式：匀速
      loopTimer = setTimeout(run, 620 / state.speed);
    }
  };
  run();
}
/* 洪流幕逐条真实调用（由控制条「数据源：真实」开启） */
async function liveStep() {
  if (liveBusy || !state.status || state.status.mode !== "live") return;
  liveBusy = true;
  try {
    const arr = await api("/api/flood-tick", { n: 1, live: true });
    const item = Array.isArray(arr) ? arr[0] : null;
    if (item && item.result && !item.result.error) {
      evSeq++;
      pushInflow(item.event, evSeq);
      renderCore(item, evSeq);
      applyResult(item.result, evSeq, false, item.event);
    }
  } catch (e) { /* 跳过这一条，下一轮重试 */ }
  liveBusy = false;
}
function step() {
  refill();
  const item = queue.shift();
  if (!item) return;
  evSeq++;
  pushInflow(item.event, evSeq);
  renderCore(item, evSeq);
  applyResult(item.result, evSeq, item.fromPool, item.event);
}
async function refill() {
  if (queue.length > 4 || refilling) return;
  refilling = true;
  try {
    const arr = await api("/api/flood-tick", { n: 10 });
    if (Array.isArray(arr)) queue.push(...arr);
  } catch (e) { /* 保持静默，下一轮重试 */ }
  refilling = false;
}

function pushInflow(ev, seq) {
  const box = $("inflow");
  const node = el("ev", `
    <div class="ev-head"><span class="chan">${ev.channel}</span><span class="evid">#${seq}</span></div>
    <p class="ev-text">${esc(ev.text)}</p>`);
  box.prepend(node);
  while (box.children.length > 7) box.removeChild(box.lastChild);
  $("inflowCnt").textContent = String(Number($("inflowCnt").textContent) + 1);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ---------- 决策核心 ---------- */
function renderCore(item, seq) {
  const r = item.result;
  if (!r || r.error) {
    $("coreIdle").hidden = false; $("coreCard").hidden = true;
    $("coreLatency").textContent = "API 错误";
    return;
  }
  $("coreIdle").hidden = true;
  $("coreCard").hidden = false;
  // 每条新决策都重触发入场动画（元素常驻，不重触发的话卡片动画只在第一条时播一次）
  const cc = $("coreCard");
  cc.classList.remove("card-flash"); void cc.offsetWidth; cc.classList.add("card-flash");

  $("sChan").textContent = item.event.channel;
  $("sId").textContent = "#" + seq;
  $("sText").textContent = item.event.text;
  $("coreLatency").textContent = Math.round(r.latency_ms) + " ms" + (r.mode === "sim" ? " · sim" : "");

  const ql = $("qlist"); ql.innerHTML = "";
  ql.appendChild(buildChoice(r));
  ql.appendChild(buildScore(r));
  ql.appendChild(buildNoul(r));

  $("mLatency").textContent = Math.round(r.latency_ms) + " ms";
  $("mGate").textContent = fmt(r.queue.confidence) + " → " + GATE_LABEL[r.gate];
  $("mCost").textContent = "$" + (r.cost_usd || 0).toFixed(6);
  $("mGate").classList.remove("gate-flash"); void $("mGate").offsetWidth; $("mGate").classList.add("gate-flash");
}

function buildChoice(r) {
  const probs = r.queue.probabilities || {};
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4);
  // 洪流幕直接给终态宽度：CSS transition 走真实时钟，而这里每 620ms 重建一次，
  // 加了过渡反而会永远停在起步阶段（截图/录屏定帧尤其明显）。展开动画只留给慢镜头幕。
  return el("q", `
    <div class="qhead"><span class="qname"><b>Choice</b> · 路由到哪个队列</span>
      <span class="qval">${esc(r.queue.choice || "—")} · ${fmt(r.queue.confidence)}</span></div>
    <div class="bars">${top.map(([k, v], i) => `<i style="width:${Math.max(0.6, v * 100).toFixed(1)}%;background:${QUEUE_COLORS[i]}"></i>`).join("")}</div>
    <div class="qsub"><span>${top.map(([k, v]) => `${esc(k)} ${v.toFixed(2)}`).join(" · ")}</span><span>confidence ${fmt(r.queue.confidence)}</span></div>`);
}
function buildScore(r) {
  const legend = r.anger.legend || { "0": "平静", "1": "不满", "2": "激烈", "3": "暴怒" };
  const probs = r.anger.probabilities || {};
  const keys = Object.keys(legend).sort((a, b) => Number(a) - Number(b));
  const idx = Math.min(Math.round(r.anger.score ?? 0), keys.length - 1);
  return el("q", `
    <div class="qhead"><span class="qname"><b>Score</b> · 用户不满程度</span>
      <span class="qval">${fmt(r.anger.score, 1)} / ${keys.length - 1} · ${fmt(r.anger.confidence)}</span></div>
    <div class="bars">${keys.map((k, i) => `<i style="width:${Math.max(0.6, (probs[k] || 0) * 100).toFixed(1)}%;background:${ANGER_COLORS[i] || "#94A3B8"}"></i>`).join("")}</div>
    <div class="qsub"><span>${keys.map(k => esc(legend[k]) + " " + (probs[k] || 0).toFixed(2)).join(" · ")}</span><span>命中：${esc(legend[keys[idx]])}</span></div>`);
}
function buildNoul(r) {
  const n = r.human.noul;
  const yes = Number(n ?? 0);
  return el("q", `
    <div class="qhead"><span class="qname"><b>Noul</b> · 需要人工立即介入？</span>
      <span class="qval">noul ${fmt(n)}</span></div>
    <div class="bars">
      <i style="width:${Math.max(0.6, yes * 100).toFixed(1)}%;background:${yes >= 0.5 ? "var(--red)" : "var(--green)"}"></i>
      <i style="width:${Math.max(0.6, (1 - yes) * 100).toFixed(1)}%;background:#CBD5E1"></i>
    </div>
    <div class="qsub"><span>${yes >= 0.5 ? "→ 需人工介入" : "→ 无需人工"}</span><span>是 ${fmt(n)} · 否 ${fmt(1 - yes)}</span></div>`);
}

/* ---------- 分流与计分板 ---------- */
function applyResult(r, seq, fromPool, event) {
  if (!r || r.error) return;
  // 三种来源必须分清，否则"真实调用次数"会虚高：
  //   live   = 本页面刚刚真实发出的请求
  //   replay = 读取真实调用的历史存档（洪流幕默认，不产生新调用）
  //   sim    = 本地模拟（无 key，或用 SIM 模式预热出来的存档）
  // 关键：以 result.mode 为准，而不是"来自回放池"就一律算 replay ——
  // 否则用 SIM 模式跑 --warmup 生成的存档会被错标成「回放」，与诚实标注原则冲突。
  const kind = r.mode === "live" ? (fromPool ? "replay" : "live") : "sim";
  state.decided++; state.calls++;
  state.latSum += r.latency_ms; state.latN++;
  state.costSum += r.cost_usd || 0; state.llmCostSum += LLM_COST;
  state.lanes[r.gate]++;
  if (kind === "live") {
    state.liveCalls++;
    state.liveCost += r.cost_usd || 0;
    state.lats.push(r.latency_ms);
    if (state.lats.length > 300) state.lats.shift();   // 长时间演示也不让它无限增长
  }
  // 完整决策档案：原文 + 三问完整结果 + 门禁，供流水回看与 CSV 导出
  state.history.unshift({
    seq, t: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    kind, gate: r.gate,
    channel: (event && event.channel) || "—", text: (event && event.text) || "",
    queue: r.queue.choice || "—", conf: r.queue.confidence,
    anger: r.anger.score, noul: r.human.noul,
    latency: Math.round(r.latency_ms),
    tokIn: (r.usage && r.usage.input_tokens) || 0, tokOut: (r.usage && r.usage.output_tokens) || 0,
    cost: r.cost_usd || 0,
    full: { queue: r.queue, anger: r.anger, human: r.human, latency_ms: r.latency_ms, usage: r.usage, cost_usd: r.cost_usd, mode: r.mode },
  });
  if (state.history.length > 300) state.history.pop();
  updateRealBadge();
  const badge = { auto: "已入队", review: "待复核", human: "已接管" }[r.gate];
  pushLaneChip(r.gate, `#${seq} <b>${r.queue.choice || "—"}</b> · conf ${fmt(r.queue.confidence)} · ${badge}`);
  updateScoreboard();
}
function updateRealBadge() {
  const n = $("realBadge");
  const t = `真实调用 ${state.liveCalls} 次`;
  if (n.textContent !== t) { n.textContent = t; n.classList.remove("bump"); void n.offsetWidth; n.classList.add("bump"); }
  n.classList.toggle("on", state.liveCalls > 0);
}
function pushLaneChip(gate, html) {
  const list = $(gate === "auto" ? "laneListAuto" : gate === "review" ? "laneListReview" : "laneListHuman");
  list.prepend(el("lanechip", html));
  while (list.children.length > 4) list.removeChild(list.lastChild);
}
function updateScoreboard() {
  const total = Object.values(state.lanes).reduce((a, b) => a + b, 0) || 1;
  ["auto", "review", "human"].forEach((g) => {
    const cap = g[0].toUpperCase() + g.slice(1);
    bump("laneCnt" + cap, state.lanes[g]);
    $("laneBar" + cap).style.width = Math.max(2, (state.lanes[g] / total) * 100) + "%";
  });
  $("laneTotal").textContent = state.decided;
  bump("sbDecided", state.decided);
  $("sbLatency").textContent = state.latN ? Math.round(state.latSum / state.latN) + " ms" : "— ms";
  $("sbCost").textContent = "$" + state.costSum.toFixed(6);
  $("sbLlm").textContent = "$" + state.llmCostSum.toFixed(4);
  saveStats();
}

/* 统计持久化：切幕、切换视图、刷新都不会丢（重置按钮会清空）。
   洪流幕每 620ms 就会触发一次保存，序列化 300 条档案很浪费 —— 节流到 500ms 一次 */
const STORE_KEY = "decision-flood-stats-v1";
let saveTimer = null;
function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        decided: state.decided, calls: state.calls, liveCalls: state.liveCalls, liveCost: state.liveCost,
        latSum: state.latSum, latN: state.latN, costSum: state.costSum, llmCostSum: state.llmCostSum,
        lanes: state.lanes, history: state.history.slice(0, 300), lats: state.lats.slice(-300),
      }));
    } catch (e) { /* 隐私模式下不可用，忽略 */ }
  }, 400);
}
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && typeof s === "object") Object.assign(state, s);
  } catch (e) { /* 忽略损坏数据 */ }
}
function clearStats() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(STORE_KEY); } catch (e) { }
}
function bump(id, value) {
  const n = $(id);
  if (n.textContent === String(value)) return;
  // 数字滚动（count-up）：洪流幕计数持续狂跳时最有动感；静态帧模式直接给终值
  const from = Number(n.textContent), to = Number(value);
  if (!state.instant && Number.isFinite(from) && Number.isFinite(to)) {
    // 用 setTimeout 而不是 rAF —— 无头/虚拟时钟下 rAF 可能根本不触发，数字会冻结
    clearTimeout(n.__timer);
    const t0 = Date.now(), dur = 320;
    const step = () => {
      // 钳制 [0,1]：时钟回跳时 p 为负会导致 (1-p)^3 指数爆炸
      const p = Math.max(0, Math.min(1, (Date.now() - t0) / dur));
      const eased = 1 - Math.pow(1 - p, 3);
      n.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1) n.__timer = setTimeout(step, 28);
    };
    step();
  } else {
    n.textContent = value;
  }
  n.classList.remove("bump"); void n.offsetWidth; n.classList.add("bump");
}

/* ---------- 场景切换 ---------- */
function setScene(scene) {
  state.scene = scene;
  $("slowmo").hidden = scene !== "slowmo";
  $("board").hidden = scene !== "board";
  document.querySelectorAll(".btn[data-scene]").forEach(b => b.classList.toggle("active", b.dataset.scene === scene));
  if (scene === "flood") { startLoop(); }
  else {
    clearTimeout(loopTimer);
    if (scene === "slowmo") {
      // 只有静态帧模式（截图/录制定帧）才自动跑一条；正常进入不发起任何调用，等你输入
      if (state.instant && !$("slBody").dataset.loaded) slowmoNext(true);
      else if (!$("slBody").dataset.loaded) slowmoIdle();
      $("slInput").focus();
    }
    if (scene === "board") fillBoard();
  }
}

/* ---------- 幕二：实测台 ---------- */
function randomEvent() {
  return lastEvents[Math.floor(Math.random() * lastEvents.length)];
}
function slowmoIdle(msg) {
  $("slBody").innerHTML = `<div class="sl-empty">
    <div class="idle-ring"></div>
    <p>在上方粘贴任意评论 / 工单 / 邮件，按 Ctrl+Enter 立即判定</p>
    <p style="font-size:.85rem;opacity:.75">或点「随机一条」，从 1000 条语料里抽一条</p>
  </div>`;
  $("slNote").textContent = msg || "待输入 · 本题不计费";
}

/* 最近判定历史 */
const hist = [];
function pushHist(text) {
  const i = hist.indexOf(text);
  if (i >= 0) hist.splice(i, 1);
  hist.unshift(text);
  if (hist.length > 5) hist.pop();
  const box = $("slHist");
  box.innerHTML = hist.map((t, k) =>
    `<span class="sl-histchip" data-k="${k}" title="${esc(t)}">${esc(t.slice(0, 16))}${t.length > 16 ? "…" : ""}</span>`).join("");
  box.querySelectorAll(".sl-histchip").forEach((c) => c.addEventListener("click", () => {
    $("slInput").value = hist[Number(c.dataset.k)];
    $("slInput").focus();
  }));
}

/* 提交入口：判定用户输入 / 随机取一条 */
function runSlowmo(text) {
  if ($("slRun").disabled) return;   // 防止 Ctrl+Enter 连按并发触发多次真实调用
  const t = String(text !== undefined ? text : $("slInput").value).trim();
  if (!t) {
    slowmoIdle("请先输入内容，或点「随机一条」");
    $("slInput").focus();
    return;
  }
  $("slInput").value = t;
  slowmoNext(state.instant, { channel: "手输", text: t });
}
async function runRandom() {
  if ($("slRun").disabled) return;   // 上一次判定还在飞，别重复真实调用（「随机一条」不经过 runSlowmo 的守卫）
  if (!lastEvents.length) lastEvents = await api("/api/pool");
  const ev = randomEvent();
  $("slInput").value = ev.text;
  slowmoNext(state.instant, ev);
}

async function slowmoNext(instant, evOverride) {
  if (!lastEvents.length) { lastEvents = await api("/api/pool"); }
  const ev = evOverride || randomEvent();
  instant = instant === true || state.instant === true;
  pushHist(ev.text);
  const body = $("slBody");
  body.dataset.loaded = "1";
  body.innerHTML = `
    <div class="sl-left">
      <div class="sl-state" id="slState">
        <div class="statebox-head"><span class="chan">${esc(ev.channel)}</span><span class="evid">state · 输入</span></div>
        <p id="slText"><span class="caret"></span></p>
      </div>
      <div class="sl-q" id="slCallBox" style="border-style:dashed">
        <div class="qhead"><span class="qname">一次 HTTP 调用 · 三问并行</span><span class="qval" id="slTiming">等待中</span></div>
        <div class="sl-legend">POST https://api.typesafe.ai/v1/systemone<br>model: jev-latest · questions: { queue, anger, human }</div>
      </div>
      <div class="sl-verdict" id="slVerdict" style="visibility:hidden">
        <div><p class="vt">置信度门禁判定</p><p class="vv" id="slGateVal">—</p></div>
        <div style="text-align:right"><p class="vt">动作</p><p class="vv" id="slAction">—</p></div>
      </div>
    </div>
    <div class="sl-right" id="slRight"></div>`;
  $("slNote").textContent = "调用中…";
  $("slRun").disabled = true;

  const reqPromise = api("/api/decide", { text: ev.text });
  if (instant) $("slText").innerHTML = esc(ev.text);
  else await typeText($("slText"), ev.text);
  $("slTiming").textContent = "并行评估中…";
  const right = document.querySelector(".sl-right");
  try {
    right.innerHTML = qSkeleton("Choice", "路由到哪个队列")
      + qSkeleton("Score", "用户不满程度")
      + qSkeleton("Noul", "需要人工立即介入？");

    const r = await reqPromise;
    if (r.error) {
      $("slTiming").textContent = "API 错误";
      $("slNote").textContent = r.error;
      $("slRun").disabled = false;
      return;
    }
    if (!instant) await sleep(420);
    right.innerHTML = slChoice(r) + slScore(r) + slNoul(r);
    animateBars(right, 80);

    const v = $("slVerdict");
    v.className = "sl-verdict " + r.gate;
    v.style.visibility = "visible";
    // 判定落定时刻触发"盖章"动画（元素早就创建好了，动画要在可见后重触发才有观感）
    void v.offsetWidth; v.classList.add("stamp");
    $("slGateVal").textContent = fmt(r.queue.confidence) + " · " + GATE_LABEL[r.gate];
    $("slAction").textContent = { auto: "自动派单", review: "升级 LLM 复核", human: "人工坐席" }[r.gate];

    $("slTiming").textContent = `${Math.round(r.latency_ms)} ms · ${r.usage ? r.usage.input_tokens : 0} in / ${r.usage ? r.usage.output_tokens : 0} out`;
    $("slNote").textContent = `${r.mode === "live" ? "真实调用" : "模拟模式（未配置 API key）"} · 服务端端到端 ${Math.round(r.latency_ms)} ms · 本次成本 $${(r.cost_usd || 0).toFixed(6)} · 同任务 LLM 估算 $${LLM_COST} / ${(LLM_LAT / 1000).toFixed(3)}s`;
    $("slRun").disabled = false;
    evSeq++;
    applyResult(r, evSeq, false, ev);
  } catch (e) {
    $("slNote").textContent = "渲染错误：" + (e && e.message ? e.message : e);
    $("slRun").disabled = false;
  }
}
function qSkeleton(name, desc) {
  return `<div class="sl-q lit skel">
    <div class="qhead"><span class="qname"><b>${name}</b> · ${desc}</span><span class="qval" style="color:var(--muted)">评估中…</span></div>
    <div class="sl-bars"><i style="width:100%;background:#E2E8F0"></i></div>
    <div class="sl-legend">与其他问题在同一份 state 上并行评估</div></div>`;
}
function slChoice(r) {
  const probs = r.queue.probabilities || {};
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return `<div class="sl-q lit">
    <div class="qhead"><span class="qname"><b>Choice</b> · 路由到哪个队列</span><span class="qval">${esc(r.queue.choice || "—")} · ${fmt(r.queue.confidence)}</span></div>
    <div class="sl-bars">${top.map(([k, v], i) => `<i data-w="${(v * 100).toFixed(1)}" style="width:0;background:${QUEUE_COLORS[i]}"></i>`).join("")}</div>
    <div class="sl-legend">${top.map(([k, v]) => `${esc(k)} ${v.toFixed(2)}`).join(" · ")}</div></div>`;
}
function slScore(r) {
  const legend = r.anger.legend || {};
  const probs = r.anger.probabilities || {};
  const keys = Object.keys(legend).sort((a, b) => Number(a) - Number(b));
  return `<div class="sl-q lit">
    <div class="qhead"><span class="qname"><b>Score</b> · 用户不满程度</span><span class="qval">${fmt(r.anger.score, 1)} / ${keys.length - 1} · ${fmt(r.anger.confidence)}</span></div>
    <div class="sl-bars">${keys.map((k, i) => `<i data-w="${((probs[k] || 0) * 100).toFixed(1)}" style="width:0;background:${ANGER_COLORS[i] || "#94A3B8"}"></i>`).join("")}</div>
    <div class="sl-legend">${keys.map(k => esc(legend[k]) + " " + (probs[k] || 0).toFixed(2)).join(" · ")}</div></div>`;
}
function slNoul(r) {
  const n = Number(r.human.noul ?? 0);
  return `<div class="sl-q lit">
    <div class="qhead"><span class="qname"><b>Noul</b> · 需要人工立即介入？</span><span class="qval">noul ${fmt(r.human.noul)}</span></div>
    <div class="sl-bars"><i data-w="${(n * 100).toFixed(1)}" style="width:0;background:${n >= 0.5 ? "var(--red)" : "var(--green)"}"></i><i data-w="${((1 - n) * 100).toFixed(1)}" style="width:0;background:#CBD5E1"></i></div>
    <div class="sl-legend">${n >= 0.5 ? "→ 需人工介入" : "→ 无需人工"} · 是 ${fmt(n)} / 否 ${fmt(1 - n)}</div></div>`;
}
async function typeText(node, text) {
  const caret = '<span class="caret"></span>';
  const step = Math.max(14, Math.min(46, 1100 / text.length));
  for (let i = 1; i <= text.length; i++) {
    node.innerHTML = esc(text.slice(0, i)) + caret;
    await sleep(step);
  }
  node.innerHTML = esc(text) + caret;
}

/* ---------- 幕三：数据板 ---------- */
function fillBoard() {
  $("bdLiveCalls").textContent = state.liveCalls;
  const lat = state.lats.slice().sort((a, b) => a - b);
  const pick = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor((lat.length - 1) * p))]);
  $("bdLiveLat").textContent = lat.length ? `${pick(0.5)} / ${pick(0.9)} ms` : "—";
  $("bdLiveCost").textContent = "$" + state.liveCost.toFixed(6);
  $("bdLiveMode").textContent = state.status ? state.status.mode.toUpperCase() : "—";

  const KIND = { live: "真实", replay: "回放", sim: "模拟" };
  window.__KIND = KIND;
  const log = $("bdLog");
  $("bdHistCount").textContent = state.history.length;
  // 把「流水条数」和「真实调用次数」的关系直接写在标题里：
  // 洪流幕走回放池，条数会远多于真实调用数 —— 这是设计如此，不是数据有假。
  const cnt = { live: 0, replay: 0, sim: 0 };
  state.history.forEach((x) => { if (cnt[x.kind] !== undefined) cnt[x.kind]++; });
  const parts = [];
  if (cnt.live) parts.push(`真实 ${cnt.live}`);
  if (cnt.replay) parts.push(`回放 ${cnt.replay}`);
  if (cnt.sim) parts.push(`模拟 ${cnt.sim}`);
  $("bdHistBreak").textContent = parts.length ? `（${parts.join(" · ")}）` : "";
  if (!state.history.length) {
    log.innerHTML = `<p class="bd-logempty">还没有决策记录。去「实测台」粘一条试试，或让洪流幕先跑一会儿。</p>`;
  } else {
    // 全量渲染（容器内滚动），点击任意一行回看该次决策的完整三问结果
    log.innerHTML = state.history.map((x, i) =>
      `<div class="bd-logrow ${x.kind}" data-i="${i}" title="点击回看完整决策"${state.instant || i > 13 ? "" : ` style="animation-delay:${i * 24}ms"`}>
        <span class="t">#${x.seq} · ${x.t}</span>
        <span class="q">${esc(x.queue)}</span>
        <span class="x">${esc(x.text.slice(0, 30))}${x.text.length > 30 ? "…" : ""}</span>
        <span class="d">${x.latency} ms</span>
        <span class="k">${KIND[x.kind] || x.kind}</span>
      </div>`).join("");
  }
}

/* 回看单条决策的完整档案 */
function showDetail(i) {
  const h = state.history[i];
  if (!h) return;
  const KIND = window.__KIND || {};
  const r = h.full;
  $("detailBody").innerHTML = `
    <div class="sl-left">
      <div class="sl-state">
        <div class="statebox-head"><span class="chan">${esc(h.channel)}</span><span class="evid">#${h.seq} · ${h.t} · ${KIND[h.kind] || h.kind}</span></div>
        <p>${esc(h.text)}</p>
      </div>
      <div class="sl-q lit">
        <div class="qhead"><span class="qname">调用回执</span><span class="qval">${h.latency} ms</span></div>
        <div class="sl-legend">${r.usage ? r.usage.input_tokens : 0} in / ${r.usage ? r.usage.output_tokens : 0} out · 成本 $${(r.cost_usd || 0).toFixed(6)}<br>门禁判定：conf ${fmt(h.conf)} → ${GATE_LABEL[h.gate]}</div>
      </div>
    </div>
    <div class="sl-right">${slChoice(r) + slScore(r) + slNoul(r)}</div>`;
  animateBars($("detailBody"), 40);
  $("detailOverlay").hidden = false;
}

/* 全部历史导出 CSV */
function exportCsv() {
  if (!state.history.length) { $("slNote") && ($("slNote").textContent = "还没有可导出的记录"); return; }
  const head = ["seq", "time", "source", "queue", "confidence", "anger_score", "noul", "gate", "latency_ms", "input_tokens", "output_tokens", "cost_usd", "channel", "text"];
  // 防 CSV 公式注入：Excel 会把 = + - @ 以及制表/回车开头的单元格当公式执行
  const q = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [head.join(",")].concat(state.history.map((h) => [
    h.seq, h.t, h.kind, h.queue, h.conf, h.anger, h.noul, h.gate,
    h.latency, h.tokIn, h.tokOut, h.cost, h.channel, h.text,
  ].map(q).join(",")));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `decision-flood-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 启动 ---------- */
function startShow(scene) {
  state.started = true;
  state.paused = false;
  $("pauseBtn").textContent = "暂停";
  $("standby").hidden = true;
  $("controls").classList.remove("hidden");
  setScene(scene || "flood");
}
function resetAll() {
  clearTimeout(loopTimer);
  if (state.closeDetail) state.closeDetail();
  Object.assign(state, {
    decided: 0, calls: 0, liveCalls: 0, liveCost: 0, latSum: 0, latN: 0, costSum: 0, llmCostSum: 0,
    lanes: { auto: 0, review: 0, human: 0 }, history: [], lats: [], started: false, paused: true,
  });
  hist.length = 0;
  ["inflow", "laneListAuto", "laneListReview", "laneListHuman", "slHist"].forEach((id) => { $(id).innerHTML = ""; });
  $("inflowCnt").textContent = "0";
  $("slInput").value = "";
  $("slBody").innerHTML = ""; $("slBody").dataset.loaded = "";
  $("pauseBtn").textContent = "暂停";
  state.source = "pool";
  $("srcBtn").textContent = "数据源：回放";
  $("srcBtn").classList.remove("warn");
  $("slowmo").hidden = true; $("board").hidden = true;
  state.scene = "flood";
  clearStats();
  updateScoreboard(); updateRealBadge();
  $("controls").classList.add("hidden");
  $("standby").hidden = false;
}

async function boot() {
  try {
    state.status = await api("/api/status");
    lastEvents = await api("/api/pool");
  } catch (e) {
    // 直接打开了 index.html（file://）或服务没启动 —— 给出明确指引，而不是白屏
    $("offline").hidden = false;
    return;
  }
  const badge = $("modeBadge");
  badge.textContent = state.status.mode === "live" ? "LIVE · 真实调用" : "SIM · 未配置 key";
  badge.classList.toggle("live", state.status.mode === "live");
  $("sbOut").textContent = "免费";
  loadStats();
  updateScoreboard();
  updateRealBadge();
  // 门禁阈值是可调的（server.js 的 GATE）。泳道标题必须跟着走，
  // 否则改了阈值之后画面还写着 0.85/0.6，改了等于没改。
  const g = state.status.gate;
  $("laneNameAuto").textContent = `≥${g.auto} 自动执行`;
  $("laneNameReview").textContent = `${g.review}–${g.auto} 升级复核`;
  $("laneNameHuman").textContent = `<${g.review} / noul≥${g.humanNoul} 转人工`;
  $("sbStats").innerHTML = `
    <div class="sb-stat"><p class="l">语料池</p><p class="v">${state.status.events} 条</p></div>
    <div class="sb-stat"><p class="l">接口模式</p><p class="v">${state.status.mode === "live" ? "LIVE · key 已配置" : "SIM · 未配置 key"}</p></div>
    <div class="sb-stat"><p class="l">门禁阈值</p><p class="v">${state.status.gate.auto} / ${state.status.gate.review}</p></div>
    <div class="sb-stat"><p class="l">API 消耗</p><p class="v">按需触发</p></div>`;

  setInterval(() => {
    const d = new Date();
    $("clock").textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, "0")).join(":");
  }, 1000);

  document.querySelectorAll(".btn[data-scene]").forEach(b => b.addEventListener("click", () => { state.started ? setScene(b.dataset.scene) : startShow(b.dataset.scene); }));
  $("startBtn").addEventListener("click", () => startShow("flood"));
  $("resetBtn").addEventListener("click", resetAll);
  $("slRun").addEventListener("click", () => runSlowmo());
  $("bdLog").addEventListener("click", (e) => {
    const row = e.target.closest(".bd-logrow");
    if (row) showDetail(Number(row.dataset.i));
  });
  $("csvBtn").addEventListener("click", exportCsv);
  const closeDetail = () => { $("detailOverlay").hidden = true; };
  $("detailClose").addEventListener("click", closeDetail);
  $("detailOverlay").addEventListener("click", (e) => { if (e.target === $("detailOverlay")) closeDetail(); });
  state.closeDetail = closeDetail;
  $("slRandom").addEventListener("click", () => runRandom());
  $("slClear").addEventListener("click", () => { $("slInput").value = ""; slowmoIdle("已清空 · 待输入"); $("slInput").focus(); });
  $("slInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSlowmo(); }
  });
  $("speedBtn").addEventListener("click", () => {
    if (state.source === "live") {
      // 真实模式节奏跟着 API 延迟走，调速无意义
      $("speedBtn").textContent = "真实模式不可调速";
      setTimeout(() => { $("speedBtn").textContent = "洪流节奏 " + state.speed + "×"; }, 1400);
      return;
    }
    state.speed = state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1;
    $("speedBtn").textContent = "洪流节奏 " + state.speed + "×";
    if (state.scene === "flood") startLoop();
  });
  $("srcBtn").addEventListener("click", () => {
    if (!state.status || state.status.mode !== "live") {
      $("srcBtn").textContent = "需要 API key";
      setTimeout(() => { $("srcBtn").textContent = "数据源：回放"; }, 1600);
      return;
    }
    state.source = state.source === "live" ? "pool" : "live";
    const on = state.source === "live";
    $("srcBtn").textContent = "数据源：" + (on ? "真实" : "回放");
    $("srcBtn").classList.toggle("warn", on);
    if (state.scene === "flood") startLoop();
  });
  $("pauseBtn").addEventListener("click", () => {
    state.paused = !state.paused;
    $("pauseBtn").textContent = state.paused ? "继续" : "暂停";
    if (!state.paused && state.scene === "flood") startLoop();
  });
  const hideToggle = () => $("controls").classList.toggle("hidden");
  $("hideBtn").addEventListener("click", hideToggle);
  $("fullBtn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });
  document.addEventListener("keydown", (e) => {
    // 焦点在输入框里时不响应全局快捷键，否则打字会误触切幕 / 暂停
    const tag = String((e.target && e.target.tagName) || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return;
    if (e.key === "Escape" && !$("detailOverlay").hidden) { state.closeDetail(); return; }
    const go = (s) => { state.started ? setScene(s) : startShow(s); };
    if (e.key === "1") go("flood");
    if (e.key === "2") go("slowmo");
    if (e.key === "3") go("board");
    if (e.key.toLowerCase() === "h") hideToggle();
    if (e.key.toLowerCase() === "f") $("fullBtn").click();
    if (e.key === " ") {
      e.preventDefault();
      if (!state.started) startShow("flood"); else $("pauseBtn").click();
    }
    if (e.key === "Enter" && state.started && state.scene === "slowmo") runSlowmo();
  });

  // 支持 ?scene=flood|slowmo|board 直达某一幕；?static=1 跳过打字机（截图/静态帧用）
  const params = new URLSearchParams(location.search);
  state.instant = params.get("static") === "1";
  if (state.instant) document.body.classList.add("static");
  const want = params.get("scene");
  if (["flood", "slowmo", "board"].includes(want)) startShow(want);
  else { $("standby").hidden = false; $("controls").classList.add("hidden"); }   // 停在首页，等你点「开始演示」
  // ?detail=N：数据板自动展开第 N 条决策详情（录制特写 / 调试用）
  if (params.get("detail") !== null && want === "board") {
    const idx = Number(params.get("detail")) || 0;
    setTimeout(() => showDetail(idx), 400);
  }
}
boot();
