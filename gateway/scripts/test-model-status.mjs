#!/usr/bin/env node
// 动态模型状态回归测试：不访问真实账号，不创建真实 session。
// 通过 Release 快照 fixture 验证暂停过滤与 410 全局错误语义。

import assert from "node:assert/strict";

const snapshot = {
  generatedAt: "test",
  models: [
    { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base2-free-mimo", upstream: "mimo/mimo-v2.5" },
    { id: "deepseek/deepseek-v4-flash", session: "deepseek/deepseek-v4-flash", agent: "base2-free-deepseek-flash", upstream: "deepseek/deepseek-v4-flash" },
    { id: "minimax/minimax-m3", session: "minimax/minimax-m3", agent: "base2-free-minimax-m3", upstream: "minimax/minimax-m3" },
  ],
  pools: {
    premium: ["deepseek/deepseek-v4-flash"],
    standard: ["mimo/mimo-v2.5"],
    glm: [],
  },
  paused: ["minimax/minimax-m3"],
};

const calls = [];
let admissionFailureStatus = 410;
let chatGateUnavailable = false;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || "GET";
  calls.push({ url, method });

  // Force the Worker to use the deterministic Release fallback.
  if (url.includes("raw.githubusercontent.com") || url.includes("cdn.jsdelivr.net")) {
    throw new Error("offline test source");
  }
  if (url.includes("releases/download/models-cache/freebuff-models.json")) {
    return new Response(JSON.stringify(snapshot), { status: 200 });
  }

  // The first test only needs generic successful behavior for client metadata.
  if (url.endsWith("/api/v1/ads") || url.endsWith("/api/v1/usage") || url.includes("/streak")) {
    return new Response("{}", { status: 200 });
  }

  // Simulate a model withdrawal at session admission.
  if (url.endsWith("/api/v1/freebuff/session") && method === "POST") {
    if (admissionFailureStatus !== null) {
      return new Response(JSON.stringify({ status: "model_unavailable", error: { code: "model_unavailable", message: "withdrawn" } }), { status: admissionFailureStatus });
    }
    return new Response(JSON.stringify({
      status: "active",
      instanceId: "instance-test",
      model: "deepseek/deepseek-v4-flash",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }), { status: 200 });
  }
  if (url.endsWith("/api/v1/agent-runs") && method === "POST") {
    return new Response(JSON.stringify({ runId: `run-${calls.length}` }), { status: 200 });
  }
  if (url.endsWith("/api/v1/chat/completions") && method === "POST" && chatGateUnavailable) {
    return new Response(JSON.stringify({ error: { code: "model_unavailable", message: "withdrawn at chat gate" } }), { status: 410 });
  }
  return new Response("{}", { status: 200 });
};

const { default: worker } = await import(`../worker.js?model-status-test=${Date.now()}`);
const env = {
  FREEBUFF_API_KEY: "test-key",
  FREEBUFF_TOKEN: "token-one-123456789,token-two-123456789",
};
const headers = {
  Authorization: "Bearer test-key",
  "Content-Type": "application/json",
};

const modelsResponse = await worker.fetch(
  new Request("http://local/v1/models", { headers }),
  env,
);
assert.equal(modelsResponse.status, 200);
const models = await modelsResponse.json();
const ids = models.data.map((model) => model.id);
assert.ok(ids.includes("deepseek/deepseek-v4-flash"), "a recovered Flash must remain listed");
assert.ok(!ids.includes("minimax/minimax-m3"), "a paused M3 must be hidden");

// A legacy client may still name the paused model; reject locally without an
// upstream request.
const beforePaused = calls.length;
const pausedResponse = await worker.fetch(
  new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "minimax/minimax-m3",
      messages: [{ role: "user", content: "test" }],
    }),
  }),
  env,
);
assert.equal(pausedResponse.status, 400);
assert.equal((await pausedResponse.json()).error.type, "unsupported_model");
assert.equal(calls.length, beforePaused, "paused models must not reach upstream");

// A 410 is global model state, not account quota. Even with two tokens, only
// one admission attempt is allowed and the client receives unsupported_model.
const beforeAdmission = calls.length;
const withdrawnResponse = await worker.fetch(
  new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "test" }],
    }),
  }),
  env,
);
assert.equal(withdrawnResponse.status, 400);
assert.equal((await withdrawnResponse.json()).error.type, "unsupported_model");
const admissionPosts = calls
  .slice(beforeAdmission)
  .filter((call) => call.url.endsWith("/api/v1/freebuff/session") && call.method === "POST");
assert.equal(admissionPosts.length, 1, "410 must not rotate through the account pool");

// Older admission handlers used HTTP 409 with the same machine-readable code.
// It is still global model state and must stop before account rotation.
admissionFailureStatus = 409;
const beforeLegacyAdmission = calls.length;
const legacyWithdrawnResponse = await worker.fetch(
  new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "test" }],
    }),
  }),
  env,
);
assert.equal(legacyWithdrawnResponse.status, 400);
assert.equal((await legacyWithdrawnResponse.json()).error.type, "unsupported_model");
const legacyAdmissionPosts = calls
  .slice(beforeLegacyAdmission)
  .filter((call) => call.url.endsWith("/api/v1/freebuff/session") && call.method === "POST");
assert.equal(legacyAdmissionPosts.length, 1, "409/model_unavailable must not rotate accounts");

// The chat gate can also discover a withdrawal after admission. It has the
// same global semantics and must not consume a second account.
admissionFailureStatus = null;
chatGateUnavailable = true;
const beforeChatGate = calls.length;
const chatGateResponse = await worker.fetch(
  new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "test" }],
    }),
  }),
  env,
);
assert.equal(chatGateResponse.status, 400);
assert.equal((await chatGateResponse.json()).error.type, "unsupported_model");
const chatPosts = calls
  .slice(beforeChatGate)
  .filter((call) => call.url.endsWith("/api/v1/chat/completions") && call.method === "POST");
assert.equal(chatPosts.length, 1, "chat-gate 410 must not rotate accounts");

console.log("model status regression tests passed");
