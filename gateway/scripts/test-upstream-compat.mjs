#!/usr/bin/env node

import assert from "node:assert/strict";

const SDK_UA = "ai-sdk/openai-compatible/1.0.25/codebuff";
const DESKTOP_UA = "Freebuff-CLI/0.0.138";
const calls = [];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || "GET";
  const headers = new Headers(init.headers || {});
  calls.push({ url, method, headers, body: init.body ? JSON.parse(init.body) : null });

  if (url.includes("raw.githubusercontent.com") || url.includes("cdn.jsdelivr.net")) {
    throw new Error("offline test source");
  }
  if (url.includes("releases/download/models-cache/freebuff-models.json")) {
    return json({
      generatedAt: "test",
      models: [
        { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base2-free-mimo", upstream: "mimo/mimo-v2.5" },
      ],
      pools: { premium: [], standard: ["mimo/mimo-v2.5"], glm: [] },
      paused: [],
    });
  }
  if (url.endsWith("/api/v1/ads")) {
    assert.equal(headers.get("user-agent"), DESKTOP_UA, "ads must keep the desktop User-Agent");
    assert.equal(calls.at(-1).body.userAgent, DESKTOP_UA, "ads body must keep the desktop User-Agent");
    return json({ ads: [{ impUrl: "https://example.invalid/impression" }] });
  }
  if (url.endsWith("/api/v1/ads/impression")) {
    assert.equal(headers.get("user-agent"), DESKTOP_UA, "ad impressions must keep the desktop User-Agent");
    return json({});
  }
  if (url.endsWith("/api/v1/usage")) {
    assert.equal(headers.get("user-agent"), SDK_UA, "ordinary upstream requests must use the SDK User-Agent");
    return json({});
  }
  if (url.endsWith("/api/v1/freebuff/session") && method === "GET") {
    assert.equal(headers.get("user-agent"), SDK_UA, "session requests must use the SDK User-Agent");
    return json({ status: "none" });
  }
  if (url.endsWith("/api/v1/freebuff/session") && method === "POST") {
    assert.equal(headers.get("user-agent"), SDK_UA, "session admission must use the SDK User-Agent");
    return json({
      status: "active",
      instanceId: "instance-upstream-compat",
      model: "mimo/mimo-v2.5",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }
  if (url.endsWith("/api/v1/agent-runs")) {
    assert.equal(headers.get("user-agent"), SDK_UA, "agent-run requests must use the SDK User-Agent");
    return json({ runId: `run-${calls.length}` });
  }
  if (url.endsWith("/api/v1/chat/completions")) {
    assert.equal(headers.get("user-agent"), SDK_UA, "chat requests must use the SDK User-Agent");
    return sse([
      {
        id: "chatcmpl-tool-test",
        model: "mimo/mimo-v2.5",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_second", type: "function", function: { name: "second_tool", arguments: "{\"b\":" } }] }, finish_reason: null }],
      },
      {
        id: "chatcmpl-tool-test",
        model: "mimo/mimo-v2.5",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_first", type: "function", function: { name: "first_tool", arguments: "{\"a\":" } }] }, finish_reason: null }],
      },
      {
        id: "chatcmpl-tool-test",
        model: "mimo/mimo-v2.5",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "2}" } }, { index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ]);
  }
  throw new Error(`unexpected upstream call: ${method} ${url}`);
};

const { default: worker } = await import(`../worker.js?upstream-compat-test=${Date.now()}`);
const response = await worker.fetch(new Request("http://local/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "mimo/mimo-v2.5",
    messages: [{ role: "user", content: "call both tools" }],
    tools: [
      { type: "function", function: { name: "first_tool", parameters: { type: "object" } } },
      { type: "function", function: { name: "second_tool", parameters: { type: "object" } } },
    ],
    stream: false,
  }),
}), {
  FREEBUFF_API_KEY: "test-key",
  FREEBUFF_TOKEN: "test-token-upstream-compat",
});

assert.equal(response.status, 200);
const body = await response.json();
assert.equal(body.choices[0].finish_reason, "tool_calls");
assert.deepEqual(body.choices[0].message.tool_calls, [
  {
    id: "call_first",
    type: "function",
    function: { name: "first_tool", arguments: "{\"a\":1}" },
  },
  {
    id: "call_second",
    type: "function",
    function: { name: "second_tool", arguments: "{\"b\":2}" },
  },
]);
assert.equal(body.usage.total_tokens, 14);

console.log("upstream compatibility regression tests passed");
