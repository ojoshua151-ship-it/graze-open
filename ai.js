// Graze Open: server function that routes each request to the cheapest open model that can do the job.
// Everything tunable lives in Vercel environment variables (see .env.example).

// Hackathon rule: use NVIDIA open source models. Nemotron 3 Nano, Super and Ultra map to the small, mid and large tiers.
// Check the exact model ids in your Nebius Token Factory model list and override them in Vercel environment variables.
const MODELS = {
  small: process.env.MODEL_SMALL || "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  mid: process.env.MODEL_MID || "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
  large: process.env.MODEL_LARGE || "nvidia/NVIDIA-Nemotron-3-Ultra"
};

// Providers. Nebius Token Factory is the main one. NVIDIA's hosted API catalog (build.nvidia.com) is an optional
// fallback that serves the same NVIDIA Nemotron open models, used only when no Nebius key is available.
// Older model names that may still work if the newer ones are rejected.
const NVIDIA_EXTRA = ["nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b"];
const good = {}; // remembers the model that last worked for each provider and tier (per warm instance)

const PROVIDERS = {
  nebius: { url: "https://api.tokenfactory.nebius.com/v1/chat/completions", models: MODELS },
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    models: {
      small: process.env.NVIDIA_MODEL_SMALL || "nvidia/nemotron-3.5-lightning-30b-a3b",
      mid: process.env.NVIDIA_MODEL_MID || "nvidia/nemotron-3.5-super-vl-120b-a12b",
      large: process.env.NVIDIA_MODEL_LARGE || "nvidia/nemotron-3-ultra-550b-a55b"
    }
  }
};

// Example prices in USD per 1M tokens, used for the cost estimate only. Override in Vercel settings.
const num = (v, d) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);
const PRICE = {
  small: num(process.env.PRICE_SMALL, 0.1),
  mid: num(process.env.PRICE_MID, 0.8),
  large: num(process.env.PRICE_LARGE, 2.5),
  frontier: num(process.env.PRICE_FRONTIER, 10)
};

const TAIL = " Reply in plain text, no markdown, under 150 words.";
const TASKS = {
  extract: { base: 0, system: "List every email, phone number, date, amount and link in the user's text, one per line with its type." + TAIL },
  triage: { base: 0, system: "The user pastes emails separated by blank lines. For each, give a category (Urgent, Spam, Newsletter or Action needed) and one next step." + TAIL },
  toil: { base: 1, system: "The user pastes a log of steps they repeat. Name the repeating pattern and say how to automate it, with a trigger and the steps." + TAIL },
  analyze: { base: 1, system: "The user pastes a small table with a header row. Give three plain findings with numbers." + TAIL }
};
const TIERS = ["small", "mid", "large"];

const MAX_INPUT = 4000;
const TIMEOUT_MS = 15000;
const PER_IP_LIMIT = num(process.env.RATE_LIMIT_PER_HOUR, 20);
const GLOBAL_LIMIT = num(process.env.GLOBAL_LIMIT_PER_HOUR, 400); // hard ceiling on spend per warm instance
const HOUR = 3600000;

const hits = new Map(); // ip -> timestamps. Best effort: each warm instance has its own copy and it resets on cold start.
let globalHits = [];

// Score how hard a request is, then move up from the task's base tier.
// Inputs: task type (base), length, number of lines, and how dense the text is.
function route(task, input) {
  const t = TASKS[task];
  const len = input.length;
  const lines = input.split("\n").filter((l) => l.trim()).length;
  const reasons = [];
  let score = t.base;
  if (t.base === 1) reasons.push("task needs reasoning");
  if (len > 1200) { score += 1; reasons.push("long input"); }
  if (len > 2500) { score += 1; reasons.push("very long input"); }
  if (lines > 40) { score += 1; reasons.push("many lines"); }
  const tier = TIERS[Math.min(score, 2)];
  return { tier, score, reasons };
}

function clientIp(req) {
  // Vercel sets these itself, so they are harder to spoof than a client-supplied x-forwarded-for.
  const h = req.headers || {};
  const v = h["x-real-ip"] || h["x-vercel-forwarded-for"] || (h["x-forwarded-for"] || "").split(",")[0] || "unknown";
  return String(v).trim();
}

function allow(ip, useGlobal) {
  const now = Date.now();
  globalHits = globalHits.filter((x) => now - x < HOUR);
  if (useGlobal && globalHits.length >= GLOBAL_LIMIT) return "busy";
  const recent = (hits.get(ip) || []).filter((x) => now - x < HOUR);
  if (recent.length >= PER_IP_LIMIT) return "rate";
  recent.push(now);
  hits.set(ip, recent);
  if (useGlobal) globalHits.push(now);
  if (hits.size > 5000) { // keep memory bounded
    for (const [k, v] of hits) if (!v.some((x) => now - x < HOUR)) hits.delete(k);
  }
  return null;
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b && typeof b === "object" ? b : {};
}

function costInfo(tier, tokens) {
  const cost = (tokens / 1e6) * PRICE[tier];
  const frontier = (tokens / 1e6) * PRICE.frontier;
  return {
    cost: Number(cost.toFixed(6)),
    frontierCost: Number(frontier.toFixed(6)),
    savedPct: frontier > 0 ? Math.round((1 - cost / frontier) * 100) : 0
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = parseBody(req);
  const t = TASKS[body.task];
  const text = body.text;
  if (!t || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "bad request" });

  const input = text.slice(0, MAX_INPUT);
  const r = route(body.task, input);
  const model = MODELS[r.tier];
  const routeInfo = { tier: r.tier, score: r.score, reasons: r.reasons };

  // Mock mode: runs the real routing and cost maths with a canned answer, so the page can be tested without a key.
  if (body.mock === true) {
    const tokens = Math.ceil(input.length / 4) + 60;
    return res.status(200).json(Object.assign({
      live: true, mock: true, model, route: routeInfo, tokens,
      answer: "This is a mock answer. The real one comes from " + model + " once NEBIUS_API_KEY is set."
    }, costInfo(r.tier, tokens)));
  }

  // Visitors (for example hackathon judges) can test live answers with their own Nebius key, sent in a header.
  // The key is used for this one request only. It is never stored or logged.
  const h = req.headers || {};
  let userKey = String(h["x-nebius-key"] || "").trim();
  if (userKey && (userKey.length > 400 || /\s/.test(userKey))) userKey = "";
  // Pick a provider: the visitor's own Nebius key first, then the site's Nebius key, then the NVIDIA fallback key.
  let provName = "", key = "";
  if (userKey) { provName = userKey.indexOf("nvapi-") === 0 ? "nvidia" : "nebius"; key = userKey; } // a pasted nvapi- key goes to NVIDIA
  else if (process.env.NEBIUS_API_KEY) { provName = "nebius"; key = process.env.NEBIUS_API_KEY; }
  else if (process.env.NVIDIA_API_KEY) { provName = "nvidia"; key = process.env.NVIDIA_API_KEY; }
  if (!key) return res.status(200).json({ live: false, reason: "no_key" }); // page keeps using its rules
  const prov = PROVIDERS[provName];

  const blocked = allow(clientIp(req), !userKey);
  if (blocked === "rate") return res.status(429).json({ live: false, reason: "rate_limited", error: "too many requests" });
  if (blocked === "busy") return res.status(429).json({ live: false, reason: "busy", error: "busy, try again later" });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const call = (m, thinkOff) => fetch(prov.url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(Object.assign({ model: m, max_tokens: 400, temperature: 0.2, messages: [{ role: "system", content: t.system }, { role: "user", content: input }] }, thinkOff ? { chat_template_kwargs: { enable_thinking: false } } : {}))
    });
    // On NVIDIA's catalog the Nemotron 3 models can "think" first, which would use up our short answer budget, so switch it off.
    const thinkOff = provName === "nvidia";
    // Try the model for this tier first, then the others, so one wrong model name does not break the demo.
    const order = [good[provName + r.tier], prov.models[r.tier], prov.models.small, prov.models.mid, prov.models.large].concat(provName === "nvidia" ? NVIDIA_EXTRA : []);
    const candidates = order.filter((m, i) => m && order.indexOf(m) === i);
    const REJECT = [400, 404, 410, 422]; // request rejected or model retired: worth trying the next option
    let up = null, usedModel = candidates[0];
    for (const cand of candidates) {
      usedModel = cand;
      up = await call(cand, thinkOff);
      if (REJECT.indexOf(up.status) >= 0 && thinkOff) up = await call(cand, false); // maybe the thinking switch was the problem
      if (up.ok || REJECT.indexOf(up.status) < 0) break;
      console.error(provName + " rejected", up.status, cand);
    }
    const tierOf = (m) => Object.keys(prov.models).filter((k) => prov.models[k] === m)[0] || r.tier;
    const usedTier = tierOf(usedModel);
    if (up.status === 401 || up.status === 403) return res.status(200).json({ live: false, reason: "bad_key" });
    if (!up.ok) {
      let detail = "";
      try { detail = (await up.text()).slice(0, 200); } catch (e) {}
      console.error(provName + " error", up.status, usedModel, detail); // visible in Vercel logs
      return res.status(200).json({ live: false, reason: "upstream_error", status: up.status, detail });
    }
    good[provName + r.tier] = usedModel;
    const j = await up.json();
    const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    if (!answer) return res.status(200).json({ live: false, reason: "empty_answer" });
    const tokens = (j.usage && j.usage.total_tokens) || 0;
    return res.status(200).json(Object.assign({ live: true, provider: provName, answer, model: usedModel, route: Object.assign({}, routeInfo, { tier: usedTier }), tokens }, costInfo(usedTier, tokens)));
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    console.error(provName + " call failed", timedOut ? "timeout" : e && e.message);
    return res.status(200).json({ live: false, reason: timedOut ? "timeout" : "network_error" });
  } finally {
    clearTimeout(timer);
  }
};
