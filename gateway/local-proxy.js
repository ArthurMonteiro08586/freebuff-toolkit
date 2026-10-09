// Node-only egress helpers for the optional per-account proxy feature.
//
// This file is intentionally not imported by worker.js.  Keeping the proxy
// implementation at the Node adapter boundary means the same worker module
// remains deployable on Cloudflare, where Node sockets are unavailable.

import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";

const DEFAULT_PORTS = {
  "http:": 80,
  "https:": 443,
  "socks5:": 1080,
  "socks5h:": 1080,
};

const PROXY_PROTOCOLS = new Set(Object.keys(DEFAULT_PORTS));
const DEFAULT_TIMEOUT_MS = 20_000;

export class ProxyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxyConfigurationError";
  }
}

export function parseProxyUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new ProxyConfigurationError("代理地址格式不正确");
  }

  const protocol = url.protocol.toLowerCase();
  if (!PROXY_PROTOCOLS.has(protocol)) {
    throw new ProxyConfigurationError("仅支持 http、https、socks5 和 socks5h 代理");
  }
  if (!url.hostname) throw new ProxyConfigurationError("代理地址缺少主机名");
  if (url.search || url.hash) throw new ProxyConfigurationError("代理地址不能包含查询参数或片段");

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[protocol];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyConfigurationError("代理端口不正确");
  }

  let username = "";
  let password = "";
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new ProxyConfigurationError("代理用户名或密码编码不正确");
  }

  return {
    raw,
    protocol,
    hostname: url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname,
    port,
    username,
    password,
    hasCredentials: Boolean(url.username || url.password),
  };
}

export function redactProxyUrl(value) {
  if (!String(value ?? "").trim()) return "直连";
  try {
    const proxy = parseProxyUrl(value);
    const auth = proxy.hasCredentials ? "***@" : "";
    const host = proxy.hostname.includes(":") ? `[${proxy.hostname}]` : proxy.hostname;
    return `${proxy.protocol}//${auth}${host}:${proxy.port}`;
  } catch {
    return "无效代理";
  }
}

export function createAccountAwareFetch({
  baseFetch = globalThis.fetch.bind(globalThis),
  resolveProxy = () => "",
  debug = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tlsOptions = {},
} = {}) {
  return async function accountAwareFetch(input, init = {}) {
    const metadata = await normalizeFetchInput(input, init);
    const proxyValue = await resolveProxy(metadata.token, metadata.url, metadata.headers);
    if (!proxyValue) {
      const fallbackInit = { ...init };
      if (metadata.token) fallbackInit.dispatcher = undefined;
      return baseFetch(input, fallbackInit);
    }

    const proxy = parseProxyUrl(proxyValue);
    debug({
      url: metadata.url.origin + metadata.url.pathname,
      tokenPresent: Boolean(metadata.token),
      proxy: redactProxyUrl(proxyValue),
    });
    return requestThroughProxy(metadata, proxy, timeoutMs, tlsOptions);
  };
}

async function normalizeFetchInput(input, init) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const headers = new Headers(request ? request.headers : undefined);
  if (init && init.headers) {
    const override = new Headers(init.headers);
    for (const [key, value] of override) headers.set(key, value);
  }

  let body;
  if (init && init.body !== undefined && init.body !== null) {
    body = await bodyToBuffer(init.body);
  } else if (request && request.body) {
    body = Buffer.from(await request.clone().arrayBuffer());
  }

  const method = String(init?.method || request?.method || (body ? "POST" : "GET")).toUpperCase();
  const auth = headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));

  return {
    input,
    init,
    request,
    url,
    headers,
    body,
    method,
    token: match ? match[1] : "",
    signal: init?.signal || request?.signal || null,
  };
}

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ReadableStream) return Buffer.from(await new Response(body).arrayBuffer());
  return Buffer.from(String(body));
}

async function requestThroughProxy(meta, proxy, timeoutMs, tlsOptions) {
  if (meta.signal?.aborted) throw abortError(meta.signal.reason);
  if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
    return requestViaSocks(meta, proxy, timeoutMs, tlsOptions);
  }
  return requestViaHttpProxy(meta, proxy, timeoutMs, tlsOptions);
}

async function requestViaHttpProxy(meta, proxy, timeoutMs, tlsOptions) {
  const targetIsTls = meta.url.protocol === "https:";
  const targetHostname = socketHostname(meta.url.hostname);
  if (targetIsTls) {
    const proxySocket = await openProxySocket(proxy, meta.signal, timeoutMs, tlsOptions);
    const tunnel = await establishHttpConnect(proxySocket, meta.url, proxy, meta.signal, timeoutMs);
    const targetSocket = await establishTls(tunnel, targetHostname, meta.signal, timeoutMs, tlsOptions);
    return issueRequest(meta, httpRequest, {
      protocol: "http:",
      hostname: targetHostname,
      port: Number(meta.url.port || 443),
      path: originForm(meta.url),
      headers: targetHeaders(meta.headers, meta.url),
      agent: false,
      createConnection: () => targetSocket,
    }, targetSocket, timeoutMs);
  }

  const headers = targetHeaders(meta.headers, meta.url);
  const proxyAuthorization = proxyAuthHeader(proxy);
  if (proxyAuthorization) headers["proxy-authorization"] = proxyAuthorization;
  if (proxy.protocol === "https:") {
    const proxySocket = await openProxySocket(proxy, meta.signal, timeoutMs, tlsOptions);
    return issueRequest(meta, httpRequest, {
      protocol: "http:", hostname: proxy.hostname, port: proxy.port,
      path: meta.url.href, headers, agent: false,
      createConnection: () => proxySocket,
    }, proxySocket, timeoutMs);
  }
  // For a plain HTTP proxy, let node:http create the connection.  Supplying a
  // pre-opened socket can race with the request writer and leaves keep-alive
  // sockets hanging on some proxy implementations.
  return issueRequest(meta, httpRequest, {
    protocol: "http:", hostname: proxy.hostname, port: proxy.port,
    path: meta.url.href, headers, agent: false,
  }, null, timeoutMs);
}

async function requestViaSocks(meta, proxy, timeoutMs, tlsOptions) {
  const targetHostname = socketHostname(meta.url.hostname);
  const tunnel = await establishSocks5(proxy, targetHostname, Number(meta.url.port || (meta.url.protocol === "https:" ? 443 : 80)), meta.signal, timeoutMs, tlsOptions);
  const targetIsTls = meta.url.protocol === "https:";
  const socket = targetIsTls
    ? await establishTls(tunnel, targetHostname, meta.signal, timeoutMs, tlsOptions)
    : tunnel;
  return issueRequest(meta, httpRequest, {
    protocol: "http:",
    hostname: targetHostname,
    port: Number(meta.url.port || (targetIsTls ? 443 : 80)),
    path: originForm(meta.url),
    headers: targetHeaders(meta.headers, meta.url),
    agent: false,
    createConnection: () => socket,
  }, socket, timeoutMs);
}

function targetHeaders(headers, url) {
  const result = {};
  for (const [key, value] of headers) {
    if (key.toLowerCase() === "proxy-authorization" || key.toLowerCase() === "proxy-connection") continue;
    result[key] = value;
  }
  result.host = url.host;
  return result;
}

function originForm(url) {
  return `${url.pathname || "/"}${url.search || ""}`;
}

function socketHostname(value) {
  const hostname = String(value || "");
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function authorityHostname(value) {
  const hostname = socketHostname(value);
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function proxyAuthHeader(proxy) {
  if (!proxy.hasCredentials) return "";
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
}

function openProxySocket(proxy, signal, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) {
        try { socket?.destroy(); } catch {}
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onAbort = () => finish(abortError(signal.reason));
    const timer = setTimeout(() => finish(new Error("代理连接超时")), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    if (proxy.protocol === "https:") {
      socket = tlsConnect({
        host: proxy.hostname,
        port: proxy.port,
        rejectUnauthorized: true,
        ...tlsOptions,
        servername: tlsOptions.servername ?? (isIP(proxy.hostname) ? undefined : proxy.hostname),
      });
      socket.once("secureConnect", () => finish(null, socket));
    } else {
      socket = netConnect({ host: proxy.hostname, port: proxy.port });
      socket.once("connect", () => finish(null, socket));
    }
    socket.once("error", (error) => finish(error));
  });
}

async function establishHttpConnect(socket, target, proxy, signal, timeoutMs) {
  const auth = proxyAuthHeader(proxy);
  const authority = `${authorityHostname(target.hostname)}:${Number(target.port || 443)}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Connection: keep-alive",
  ];
  if (auth) lines.push(`Proxy-Authorization: ${auth}`);
  lines.push("", "");
  socket.write(lines.join("\r\n"));
  const response = await readHttpHead(socket, signal, timeoutMs);
  if (response.status < 200 || response.status >= 300) {
    socket.destroy();
    throw new Error(`代理 CONNECT 失败（HTTP ${response.status}）`);
  }
  if (response.rest.length) socket.unshift(response.rest);
  return socket;
}

function establishTls(socket, hostname, signal, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("代理 TLS 握手超时")), timeoutMs);
    const onAbort = () => finish(abortError(signal.reason));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        try { value?.destroy(); socket?.destroy(); } catch {}
        reject(error);
      } else resolve(value);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const tlsSocket = tlsConnect({
      socket,
      rejectUnauthorized: true,
      ...tlsOptions,
      servername: tlsOptions.servername ?? (isIP(hostname) ? undefined : hostname),
    });
    tlsSocket.once("secureConnect", () => finish(null, tlsSocket));
    tlsSocket.once("error", (error) => finish(error));
  });
}

async function establishSocks5(proxy, hostname, port, signal, timeoutMs, tlsOptions) {
  const socket = await openProxySocket({ ...proxy, protocol: "socks5:" }, signal, timeoutMs, tlsOptions);
  const reader = new SocketReader(socket, signal, timeoutMs);
  try {
    const methods = proxy.hasCredentials ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) throw new Error("SOCKS5 代理拒绝认证方式");
    if (greeting[1] !== 0x00 && greeting[1] !== 0x02) throw new Error("SOCKS5 代理返回了不支持的认证方式");
    if (greeting[1] === 0x02) {
      const user = Buffer.from(proxy.username, "utf8");
      const pass = Buffer.from(proxy.password, "utf8");
      if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 用户名或密码过长");
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await reader.read(2);
      if (auth[1] !== 0x00) throw new Error("SOCKS5 代理认证失败");
    }

    const host = Buffer.from(hostname, "utf8");
    if (host.length > 255) throw new Error("目标主机名过长");
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const header = await reader.read(4);
    if (header[0] !== 0x05 || header[1] !== 0x00) throw new Error(`SOCKS5 连接失败（代码 ${header[1] ?? "?"}）`);
    if (header[3] !== 0x01 && header[3] !== 0x03 && header[3] !== 0x04) throw new Error("SOCKS5 代理返回了无效地址类型");
    const addressLength = header[3] === 0x01 ? 4 : header[3] === 0x04 ? 16 : (await reader.read(1))[0];
    await reader.read(addressLength + 2);
    reader.detach();
    return socket;
  } catch (error) {
    reader.fail(error);
    try { socket.destroy(); } catch {}
    throw error;
  }
}

class SocketReader {
  constructor(socket, signal, timeoutMs) {
    this.socket = socket;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error("代理连接意外关闭"));
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  read(length) {
    if (this.buffer.length >= length) {
      const result = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("SOCKS5 握手超时"));
        try { this.socket.destroy(); } catch {}
      }, this.timeoutMs);
      this.waiters.push({ length, resolve, reject });
      this.waiters[this.waiters.length - 1].timer = timer;
      this.flush();
    });
  }

  flush() {
    while (this.waiters.length && this.buffer.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      const result = this.buffer.subarray(0, waiter.length);
      this.buffer = this.buffer.subarray(waiter.length);
      waiter.resolve(result);
    }
  }

  fail(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}

function readHttpHead(socket, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("代理响应超时")), timeoutMs);
    const onAbort = () => finish(abortError(signal.reason));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      const firstLine = head.split("\r\n", 1)[0] || "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(firstLine);
      if (!match) return finish(new Error("代理返回了无效的 HTTP 响应"));
      finish(null, { status: Number(match[1]), rest: buffer.subarray(end + 4) });
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("代理连接意外关闭"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function issueRequest(meta, transport, options, socket, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    options.headers = { ...(options.headers || {}), connection: "close" };
    let oneShotAgent = null;
    if (socket) {
      oneShotAgent = new HttpAgent({ keepAlive: false });
      let consumed = false;
      oneShotAgent.createConnection = (_options, callback) => {
        if (consumed) {
          const error = new Error("代理连接不能被重复使用");
          callback?.(error);
          throw error;
        }
        consumed = true;
        callback?.(null, socket);
        return socket;
      };
      options.agent = oneShotAgent;
      delete options.createConnection;
    }
    let settled = false;
    const req = transport(options, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, value);
      }
      const body = Readable.toWeb(response);
      response.once("end", () => {
        try { socket?.destroy(); } catch {}
        try { oneShotAgent?.destroy(); } catch {}
      });
      response.once("aborted", () => {
        try { socket?.destroy(); } catch {}
        try { oneShotAgent?.destroy(); } catch {}
      });
      response.once("error", () => {
        try { socket?.destroy(); } catch {}
        try { oneShotAgent?.destroy(); } catch {}
      });
      settled = true;
      req.setTimeout(0);
      resolve(new Response(body, { status: response.statusCode || 502, statusText: response.statusMessage || "", headers }));
    });
    const onAbort = () => {
      try { req.destroy(abortError(meta.signal.reason)); } catch {}
      if (!settled) reject(abortError(meta.signal.reason));
    };
    if (meta.signal?.aborted) return onAbort();
    meta.signal?.addEventListener("abort", onAbort, { once: true });
    req.once("error", (error) => {
      meta.signal?.removeEventListener("abort", onAbort);
      try { oneShotAgent?.destroy(); } catch {}
      if (!settled) reject(error);
    });
    req.once("close", () => meta.signal?.removeEventListener("abort", onAbort));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("代理请求超时")));
    if (meta.body?.length) req.write(meta.body);
    req.end();
  }).catch((error) => {
    try { socket?.destroy(); } catch {}
    throw error;
  });
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}
