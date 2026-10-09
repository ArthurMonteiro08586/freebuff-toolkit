#!/usr/bin/env node
// 解析官方 freebuff 源 → 生成 models.json（供 GitHub Releases 兜底）
// 用法: node scripts/build-freebuff-models-json.mjs [输出路径]
// 默认输出: freebuff-models.json（仓库根目录）
//
// 生成的 JSON 结构：
// {
//   "generatedAt": "ISO 时间",
//   "source": "CodebuffAI/freebuff main",
//   "models": [{ id, session, agent, upstream }, ...],   // 动态模型表
//   "pools": { "premium": [...], "glm": [...], "standard": [...] },
//   "paused": [...]                         // 官方暂停/下线模型
// }
//
// 注意：本脚本是 GitHub Actions 用的独立解析器，
// 与 worker.js 内的解析逻辑保持一致（同一个真源）。

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// 与 worker.js 相同的 3 个源（raw 主源 + jsDelivr 备用）
const SOURCES = {
  agents: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/free-agents.ts",
  ],
  models: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-models.ts",
  ],
  stableIds: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-model-ids.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-model-ids.ts",
  ],
};

// ---- 解析器（与 worker.js 保持一致）----

function parseModelIdConstants(source) {
  const table = {};
  const knownDefaults = { mimoV25: "mimo/mimo-v2.5" };
  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.]+))/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const lit = m[2] ?? m[3] ?? "";
    const expr = m[4] ?? "";
    if (lit) table[name] = lit;
    else if (expr) {
      const member = expr.includes(".") ? expr.split(".").pop() : expr;
      if (knownDefaults[member]) table[name] = knownDefaults[member];
      else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(expr)) table[name] = expr;
    }
  }
  return table;
}

function parseAgentMappings(source, modelIdConstants) {
  const blockNames = {
    root: "FREEBUFF_ROOT_AGENT_ID_BY_MODEL",
    base3: "FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL",
    reviewer: "FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL",
  };
  const result = { root: {}, base3: {}, reviewer: {} };
  const lineRe = /\[\s*([A-Z0-9_]+)\s*\]\s*:\s*'([^']+)'/g;
  for (const [kind, blockName] of Object.entries(blockNames)) {
    const blockRe = new RegExp(`${blockName}[^=]*=\\s*\\{([^}]*)\\}`);
    const blockMatch = blockRe.exec(source);
    if (!blockMatch) continue;
    lineRe.lastIndex = 0;
    let m;
    while ((m = lineRe.exec(blockMatch[1])) !== null) {
      const modelId = modelIdConstants[m[1]];
      if (modelId) result[kind][modelId] = m[2];
    }
  }
  return result;
}

function parseAgentMapping(source, modelIdConstants) {
  return parseAgentMappings(source, modelIdConstants).root;
}

function parseModelPools(source, modelIdConstants) {
  const premium = new Set();
  const glm = new Set();
  const constValues = new Map();
  const constListRe = /export\s+const\s+([A-Z0-9_]+)\s*=\s*\[([^\]]*)\]\s*as\s*const/g;
  let cm;
  while ((cm = constListRe.exec(source)) !== null) {
    const name = cm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(cm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) items.push(["spread", spread]);
      else if (lit) items.push(["lit", lit]);
      else if (expr && modelIdConstants[expr]) items.push(["lit", modelIdConstants[expr]]);
    }
    constValues.set(name, items);
  }
  const poolRe = /export\s+const\s+(FREEBUFF_WEB_PREMIUM_MODEL_IDS|FREEBUFF_GLM_V52_MODEL_IDS|FREEBUFF_PREMIUM_MODEL_IDS)\s*=\s*\[([^\]]*)\]/g;
  let pm;
  while ((pm = poolRe.exec(source)) !== null) {
    const poolName = pm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(pm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) {
        const expand = (n) => {
          const entries = constValues.get(n) || [];
          for (const [kind, val] of entries) {
            if (kind === "spread") expand(val);
            else items.push(val);
          }
        };
        expand(spread);
      } else if (lit) items.push(lit);
      else if (expr && modelIdConstants[expr]) items.push(modelIdConstants[expr]);
    }
    if (poolName === "FREEBUFF_GLM_V52_MODEL_IDS") {
      for (const id of items) glm.add(id);
    } else {
      for (const id of items) premium.add(id);
    }
  }
  return { premium: [...premium], glm: [...glm] };
}

// 解析官方 FREEBUFF_PAUSED_FREE_MODEL_IDS。保留 found 标记，避免把“官方明确
// 为空”误当成“旧源码没有该常量”。
function parsePausedModels(source, modelIdConstants) {
  const listRe = /export\s+const\s+FREEBUFF_PAUSED_FREE_MODEL_IDS\b[^=]*=\s*\[([^\]]*)\]/;
  const listMatch = listRe.exec(source || "");
  if (!listMatch) return { found: false, ids: new Set() };
  const ids = new Set();
  const listBody = listMatch[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const itemRe = /'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
  let item;
  while ((item = itemRe.exec(listBody)) !== null) {
    const literal = item[1] ?? item[2];
    const expression = item[3];
    if (literal) ids.add(literal);
    else if (expression && modelIdConstants[expression]) ids.add(modelIdConstants[expression]);
  }
  return { found: true, ids };
}

// ---- 拉取 ----

async function fetchFirst(urls) {
  for (const url of urls) {
    let timer = null;
    try {
      const ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 100) return text;
      }
    } catch {
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  return null;
}

// ---- 主流程 ----

async function main() {
  const outPath = process.argv[2] || join(REPO_ROOT, "freebuff-models.json");
  const [agentsSrc, modelsSrc, stableIdsSrc] = await Promise.all([
    fetchFirst(SOURCES.agents),
    fetchFirst(SOURCES.models),
    fetchFirst(SOURCES.stableIds),
  ]);
  if (!agentsSrc || !modelsSrc) {
    console.error("❌ 拉取官方源失败（agents 或 models 为空），不生成 JSON");
    process.exit(1);
  }
  try {
    const modelIdConstants = {
      ...parseModelIdConstants(stableIdsSrc || ""),
      ...parseModelIdConstants(modelsSrc),
    };
    const agentMappings = parseAgentMappings(agentsSrc, modelIdConstants);
    if (Object.keys(agentMappings.root).length === 0) {
      console.error("❌ 解析 agent 映射为空，不生成 JSON");
      process.exit(1);
    }
    const pools = parseModelPools(modelsSrc, modelIdConstants);
    const pausedInfo = parsePausedModels(modelsSrc, modelIdConstants);
    if (pausedInfo.found && pausedInfo.ids.size > 0) {
      console.log(`ℹ️  官方暂停模型（已从快照剔除）: ${[...pausedInfo.ids].join(", ")}`);
    }
    const models = Object.entries(agentMappings.root).map(([modelId, rootAgent]) => ({
      id: modelId,
      session: modelId,
      agent: rootAgent,
      root_agent: rootAgent,
      base3_agent: agentMappings.base3[modelId] || null,
      reviewer_agent: agentMappings.reviewer[modelId] || null,
      upstream: modelId,
    })).filter((model) => !pausedInfo.ids.has(model.id));
    const premium = new Set(pools.premium);
    for (const id of pausedInfo.ids) premium.delete(id);
    const glm = new Set(pools.glm);
    for (const id of pausedInfo.ids) glm.delete(id);
    const standard = models
      .map((m) => m.id)
      .filter((id) => !premium.has(id) && !glm.has(id));
    const payload = {
      generatedAt: new Date().toISOString(),
      source: "CodebuffAI/freebuff main",
      models,
      pools: {
        premium: [...premium],
        glm: [...glm],
        standard,
      },
    };
    // 旧官方源码没有暂停常量时不要写入空数组；运行时看到缺失字段后会
    // 使用保守兜底，而不是把“未知”误当成“官方明确没有暂停模型”。
    if (pausedInfo.found) payload.paused = [...pausedInfo.ids].sort();
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
    console.log(`✅ 生成 ${outPath}`);
    console.log(`   模型数: ${models.length}`);

    // ---- 同时生成 MODELS.md（北京时间，Premium 优先） ----
    const mdPath = join(REPO_ROOT, "MODELS.md");
    const beijingTime = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).replace(" ", " ");
    const knownNames = {
      "deepseek/deepseek-v4-flash":   "DeepSeek V4 Flash（推理模型，代码/数学/推理优秀）",
      "deepseek/deepseek-v4-pro":     "DeepSeek V4 Pro（最强推理模型）",
      "minimax/minimax-m3":           "MiniMax M3（综合能力强，中文优秀）",
      "mimo/mimo-v2.5":               "MiMo V2.5（轻量高效，适合快速任务）",
      "openai/gpt-5.6-luna":          "GPT-5.6 Luna（OpenAI 最新，推理顶尖）",
      "z-ai/glm-5.2":                 "GLM 5.2（智谱 AI，推荐解锁后使用）",
      "poolside/laguna-s-2.1":        "Laguna S 2.1（Poolside 代码专用模型）",
      "openrouter/poolside/laguna-s-2.1": "Laguna S 2.1（OpenRouter 通道）",
      "inclusionai/ling-3.0-flash:free": "Ling 3.0 Flash（免费模型，响应快）",
      "crof/greg-2-ultra":            "Greg 2 Ultra（CROF 旗舰模型）",
      "crof/greg-2-super":            "Greg 2 Super（CROF 高性能模型）",
      "anthropic/claude-fable-5":     "Claude Fable 5（Anthropic 限量模型）",
      "meta/muse-spark-1.2-contributor": "Muse Spark 1.2（Meta 开发者专属，限量）",
      "crof/kimi-k3-eco":            "Kimi K3 Eco（CROF 平衡型模型）",
      "openai/gpt-5.6-luna-es":      "GPT-5.6 Luna ES（实验性 Premium 模型）",
      "z-ai/glm-5.3-flash":          "GLM 5.3 Flash（智谱 AI 高速模型）",
      "stealth/ox-alpha":             "Ox Alpha（实验性模型）",
    };
    const mdLines = [
      `# Freebuff 可用模型（${beijingTime} 北京时间）`,
      "",
      `> 自动生成 · 来源：[CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff) main · 更新频率：每 6 小时`,
      "",
    ];
    // 按 pool 分组：premium 优先，然后 standard，最后 glm
    const sections = [
      { title: "会员（Premium）模型", ids: [...premium].sort() },
      { title: "标准（STANDARD）模型", ids: standard.sort() },
      { title: "独立池（GLM 推荐解锁）", ids: [...glm].sort() },
    ];
    for (const sec of sections) {
      mdLines.push(`## ${sec.title}`, "");
      for (const id of sec.ids) {
        const desc = knownNames[id] || id;
        mdLines.push(`- \`${id}\` —— ${desc}`);
      }
      mdLines.push("");
    }
    if (pausedInfo.found && pausedInfo.ids.size > 0) {
      mdLines.push("## 已暂停或下线模型", "", "> 以下模型仍可能出现在旧客户端缓存中，但当前不会出现在 `/v1/models`，也不应创建新 session。", "");
      for (const id of [...pausedInfo.ids].sort()) {
        const desc = knownNames[id] || id;
        mdLines.push(`- \`${id}\` —— ${desc}`);
      }
      mdLines.push("");
    }
    mdLines.push(`---`, `共 ${models.length} 个模型 · 上次更新：${beijingTime}`, "");
    writeFileSync(mdPath, mdLines.join("\n"));
    console.log(`✅ 生成 ${mdPath}`);
  } catch (e) {
    console.error("❌ 解析失败:", e.message);
    process.exit(1);
  }
}

main();
