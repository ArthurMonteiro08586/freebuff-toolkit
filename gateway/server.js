import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountAwareFetch, parseProxyUrl, redactProxyUrl } from './local-proxy.js';
import { createManagementApi, isLocalHost } from './management-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;

// === Build env from config ===

// Read tokens from credentials/ directory
const credDir = resolve(__dirname, 'credentials');
let tokenLines = [];
const tokenProxyMap = new Map();
function loadCredentials() {
  tokenLines = [];
  tokenProxyMap.clear();
  if (!existsSync(credDir)) return;
  for (const f of readdirSync(credDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(resolve(credDir, f), 'utf-8');
      const obj = JSON.parse(raw);
      // 单账号格式：顶层 authToken（credentials/<name>.json）
      if (obj.authToken) {
        const token = obj.authToken.trim();
        if (token) {
          tokenLines.push(token);
          tokenProxyMap.set(token, String(obj.proxy || '').trim());
        }
      }
      // 多账号聚合格式（freebuff_credentials.json）：accounts.<key>.authToken
      if (obj.accounts && typeof obj.accounts === 'object') {
        for (const acct of Object.values(obj.accounts)) {
          if (acct && acct.authToken) {
            const token = acct.authToken.trim();
            if (token) {
              tokenLines.push(token);
              tokenProxyMap.set(token, String(acct.proxy || '').trim());
            }
          }
        }
      }
    } catch (err) {
      console.error(`[server] skip bad credential ${f}: ${err.name || 'parse error'}`);
    }
  }
}
loadCredentials();

// Also allow FREEBUFF_TOKEN env var for non-credential token sources
const envToken = process.env.FREEBUFF_TOKEN || '';
function appendEnvironmentTokens() {
  if (!envToken) return;
  for (const tok of envToken.split(/[\n,]/)) {
    const t = tok.trim();
    if (t && !tokenLines.includes(t)) tokenLines.push(t);
  }
}
appendEnvironmentTokens();

const env = {
  FREEBUFF_TOKEN: tokenLines.join(','),
  FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
  RELAY_KEY: process.env.RELAY_KEY || '',
  FREE_PROXY_ACCOUNTS: process.env.FREE_PROXY_ACCOUNTS || '0',
};

const perAccountProxyEnabled = env.FREE_PROXY_ACCOUNTS === '1';
const originalFetch = globalThis.fetch.bind(globalThis);
if (perAccountProxyEnabled) {
  for (const [token, value] of tokenProxyMap) {
    if (!value) continue;
    try {
      parseProxyUrl(value);
    } catch (error) {
      console.error(`[server] ignored invalid per-account proxy (${redactProxyUrl(value)}): ${error.name || 'configuration error'}`);
      tokenProxyMap.set(token, '');
    }
  }
  globalThis.fetch = createAccountAwareFetch({
    baseFetch: originalFetch,
    resolveProxy: (token) => token ? tokenProxyMap.get(token) || '' : '',
    debug: ({ url, tokenPresent, proxy }) => {
      if (env.FREEBUFF_DEBUG === 'true') {
        console.error(`[proxy] ${url} account=${tokenPresent ? 'selected' : 'none'} route=${proxy}`);
      }
    },
  });
}

console.log(`[server] start: ${tokenLines.length} tokens, apiKey=configured, debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log(`[server] CODEBUFF_API=${env.CODEBUFF_API}`);
if (env.RELAY_KEY) console.log(`[server] RELAY_KEY set`);
if (perAccountProxyEnabled) console.log(`[server] per-account proxy enabled for ${[...tokenProxyMap.values()].filter(Boolean).length} account(s)`);

// === HTTP server ===
const port = parseInt(process.env.PORT || '8877', 10);
const host = process.env.HOST || '127.0.0.1';
const managementRequested = process.env.FREEBUFF_MANAGEMENT_API === '1';
const managementToken = process.env.FREEBUFF_MANAGEMENT_TOKEN || '';
let managementApi = null;
if (managementRequested) {
  if (!isLocalHost(host)) {
    throw new Error('FREEBUFF_MANAGEMENT_API 只能在 HOST=127.0.0.1/localhost/::1 时启用');
  }
  managementApi = createManagementApi({
    credentialDirectory: credDir,
    token: managementToken,
    reload: () => {
      loadCredentials();
      appendEnvironmentTokens();
      env.FREEBUFF_TOKEN = tokenLines.join(',');
    },
  });
}

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const nodeUrl = new URL(nodeReq.url || '/', `http://${nodeReq.headers.host || 'localhost'}`);
    if (managementApi && await managementApi(nodeReq, nodeRes, nodeUrl)) return;
    // Build array of raw bytes from Node request
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build a CF-compatible Request
    const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
    });

    // Call the worker's fetch handler
    const response = await handler.fetch(request, env);

    // Write response back to Node socket
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch (err) {
        // Stream errors are expected on client disconnect
        if (!nodeRes.writableEnded) nodeRes.end();
        return;
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (err) {
    console.error('[server] request error:', err.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`[server] listening on ${host}:${port}`);
});
