#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import {
  createAccountAwareFetch,
  parseProxyUrl,
  redactProxyUrl,
} from "../local-proxy.js";

assert.equal(parseProxyUrl("127.0.0.1:8080").protocol, "http:");
assert.equal(parseProxyUrl("socks5://user:pass@[::1]:1080").hostname, "::1");
assert.throws(() => parseProxyUrl("ftp://127.0.0.1:21"), /仅支持/);
assert.equal(redactProxyUrl("http://alice:secret@127.0.0.1:8080"), "http://***@127.0.0.1:8080");
assert.ok(!redactProxyUrl("http://alice:secret@127.0.0.1:8080").includes("secret"));

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICyDCCAbCgAwIBAgIIcbaLlLfadXAwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UE
AxMJbG9jYWxob3N0MB4XDTIwMDEwMTAwMDAwMFoXDTQwMDEwMTAwMDAwMFowFDES
MBAGA1UEAxMJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEA5bHQh8NXsYzKeCuIPcNqhLVHSHT8uaTcZyJ9JV+8sTpFVCIAal1/309IaG6N
ycMPOZQOixCG70RoqHx3X7UBMavv/OdJ3cBmoXllsp8q18xbjLZdj0aFn9yjDpKa
7GLlW7KB4uq+AFbIxm5fo1u7K8zQJZcTzWWFrwfT+wrlzD0o65HGVjAlFv5nAYQR
+FLQ0aBnzT5bNWTJD9ePV5JkRdwI2NMzz08oFH0Z7zenKytz1Qd65M0DR/WHGdoM
af+7O+DNeHa0yFSbFJryFmFq5GOPTmQXi7w+TszUgdwUuP/j2Kimy0t5H+uyE1mx
ved9gG7DC3pOwodifIwuX4YS8QIDAQABox4wHDAaBgNVHREEEzARgglsb2NhbGhv
c3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAIt/MQWTDusZBYLZrGVz0NcdRSGT
UfaZY7pK6LEIepF0c6tYdPCjxxCwVlOXbsHwaffdZX9TbE8ZEJxXcXQRBq/2mGoD
VrAL+YerUAA8rDv3gCI2wnVS+72JwIY0N+XpP4TLo1wGb5yhAfX56RjVT3HeZu94
/RZCmeySfAkTOaP19MJB59AzoNtcgJ9AkWZC9wXohMATWebCAEN0ZDot+fN01Pqy
6biGcHswxZpUthlnls2mTGNU0efX9Rp+rzRzNjXHkAmm7euFoPrBxUkBbWL2H4GW
lmFwQR+YEc28unUcD1+hQK4J+X+eVL5YSB+QzGZ/z9VCx4c72wncYYirCFk=
-----END CERTIFICATE-----`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDlsdCHw1exjMp4
K4g9w2qEtUdIdPy5pNxnIn0lX7yxOkVUIgBqXX/fT0hobo3Jww85lA6LEIbvRGio
fHdftQExq+/850ndwGaheWWynyrXzFuMtl2PRoWf3KMOkprsYuVbsoHi6r4AVsjG
bl+jW7srzNAllxPNZYWvB9P7CuXMPSjrkcZWMCUW/mcBhBH4UtDRoGfNPls1ZMkP
149XkmRF3AjY0zPPTygUfRnvN6crK3PVB3rkzQNH9YcZ2gxp/7s74M14drTIVJsU
mvIWYWrkY49OZBeLvD5OzNSB3BS4/+PYqKbLS3kf67ITWbG9532AbsMLek7Ch2J8
jC5fhhLxAgMBAAECggEBAKKzP3jLP9S+W7SfcVP+lfcGyUVjyJhfVNehMHBGzkvj
cLRVmWG+dRNi/3Epzjl6d9BbNan/vPTCyjd+YrhiaEQc/FNyKXpwDMKYURcjc5+E
W9ziWIdidshz6vQpmJ+Utc4sNaDcklV/I5ybFheKpJwz6cSWrSoynW0L6HXMlFYE
LOtvsH7OjQa03kfKgD98TqI6DSQiSrFSnh3H2wYyGPcnFxe7/Jza5FsMNusnhYN/
0Tfpm/cJGdPelXo44XizsnuCt9M9CoYuech40pt/fkc+FvJ92d9mOCMyQoIANe1K
wyKcr2+pJ4Nto9KaTpRF4zh04V3ompeV5v7c6SOIQpkCgYEA8NR9OyxQqTmqoS/8
cYHGmvTjNQ7kZOVTloenSmWt4R9ZMtawG8i5pN2tOlIKBL7/l4/pFpNjtJfwjMIN
gX2pfT8m0zus5bSjuGb+/I3pR1ehX3nk6gkZm4dJMvxB3BNBkDinDlo+iRq+Uh4g
JwkNy5G/0FyDIVUPBKVpSbIhcF8CgYEA9CnCrICURrrOZsw+Eo+PGXKtj+2/S1yI
tqYzBa5Jw/Zj4CDvkwTxgwyLdY9meb20CN+wa3vE0seTXoGWPH8YwjAuroLGcj97
jFYAIcI09f619FAhXGZYQdMMcH7TlbcLaGKyEwTRNSuhQJbhPC+dSmYbiwEOckg+
ZMM0+zJU/q8CgYEA4a+/y/wzeuK3rGYzxItBe2WSpt5V2teuBZsKgwXWdOnTxXi7
gM4SaxXyiHzpNplnHLmYTbfB8DOTEdWoonkIpH7R+5Io7PrjkqOywSqcOmc8qySo
CUqN3NpjFoyfi4XgIy90Hlcj04hkYsAokWxCqUrk3nZTzKDReiEpEg8ElzECgYAx
KLNMXfr8nqHt6pNY01ShcAhn4RtRxgi0lZPSQfwSG2qSdq8lr6ock4sEmWGtgzdb
TgZMLbg8I/iU34xrE7/dYSwU8LmZyRRL9gjCw0I8gRMLZJLC8sw0PJTVlYNuMlN2
qeBmmeKxTN6DjZ09q+yETTigbQ8GjWsaiH8DUGfyewKBgFa3Ng/FGRmzQLvoe94W
A0q4rocO1hWXcAvp6R85Gn2CL0ZmGQbVwPI7+HYMaq2V+Eg7h9EaSb4Gu5IXpMvQ
PKNqmCs+JiseU2y5vZ0ZdkdokDmJZ/mw/KjdehQnXo/lhctLXOiqwj+3vk3xS5in
LKUfEAapE6NJCInadxfrT1km
-----END PRIVATE KEY-----`;

const target = createHttpServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    path: req.url,
    account: req.headers["x-test-account"] || "",
    body: Buffer.concat(chunks).toString("utf8"),
  }));
});
await listen(target);
const targetPort = target.address().port;

const httpProxyHits = [];
const httpProxy = createHttpServer((req, res) => {
  httpProxyHits.push(req.url);
  const upstream = new URL(req.url);
  const client = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers: req.headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  req.pipe(client);
});
let connectAuthorization = "";
httpProxy.on("connect", (req, clientSocket, head) => {
  connectAuthorization = req.headers["proxy-authorization"] || "";
  const [host, rawPort] = String(req.url).split(":");
  const upstream = net.connect({ host, port: Number(rawPort) }, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  upstream.once("error", () => clientSocket.destroy());
});
await listen(httpProxy);
const httpProxyPort = httpProxy.address().port;

const fetchByAccount = createAccountAwareFetch({
  resolveProxy: (token) => token === "token-a" ? `http://127.0.0.1:${httpProxyPort}` : "",
});

const accountA = await fetchByAccount(`http://127.0.0.1:${targetPort}/account-a`, {
  method: "POST",
  headers: { Authorization: "Bearer token-a", "x-test-account": "a" },
  body: "hello",
});
assert.deepEqual(await accountA.json(), { path: "/account-a", account: "a", body: "hello" });
const accountB = await fetchByAccount(`http://127.0.0.1:${targetPort}/account-b`, {
  headers: { Authorization: "Bearer token-b", "x-test-account": "b" },
});
assert.equal((await accountB.json()).account, "b");
assert.equal(httpProxyHits.length, 1, "account routes must not leak into each other");
if (process.env.PROXY_TEST_TRACE) console.error("plain routes passed");

const secureTarget = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`secure:${req.url}`);
});
await listen(secureTarget);
const secureFetch = createAccountAwareFetch({
  resolveProxy: () => `http://proxy-user:proxy-pass@127.0.0.1:${httpProxyPort}`,
  tlsOptions: { ca: TEST_CERT },
});
const secureResponse = await secureFetch(`https://localhost:${secureTarget.address().port}/connect`, {
  headers: { Authorization: "Bearer token-secure" },
});
assert.equal(await secureResponse.text(), "secure:/connect");
assert.equal(connectAuthorization, `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);
if (process.env.PROXY_TEST_TRACE) console.error("CONNECT route passed");

const httpsProxyHits = [];
const httpsProxy = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
  httpsProxyHits.push(req.url);
  const upstream = new URL(req.url);
  const client = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers: req.headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  req.pipe(client);
});
await listen(httpsProxy);
const httpsProxyFetch = createAccountAwareFetch({
  resolveProxy: () => `https://127.0.0.1:${httpsProxy.address().port}`,
  // The fixture proxy is self-signed. Production defaults remain strict.
  tlsOptions: { rejectUnauthorized: false },
});
const httpsProxyResponse = await httpsProxyFetch(`http://127.0.0.1:${targetPort}/https-proxy`, {
  headers: { Authorization: "Bearer token-https-proxy" },
});
assert.equal((await httpsProxyResponse.json()).path, "/https-proxy");
assert.equal(httpsProxyHits.length, 1);
if (process.env.PROXY_TEST_TRACE) console.error("HTTPS proxy passed");

const socksProxy = net.createServer((socket) => handleSocksConnection(socket, { username: "sock-user", password: "sock-pass" }));
await listen(socksProxy);
const socksFetch = createAccountAwareFetch({
  resolveProxy: () => `socks5://sock-user:sock-pass@127.0.0.1:${socksProxy.address().port}`,
  tlsOptions: { ca: TEST_CERT },
});
const socksResponse = await socksFetch(`http://localhost:${targetPort}/socks`, {
  headers: { Authorization: "Bearer token-socks" },
});
assert.equal((await socksResponse.json()).path, "/socks");
const secureSocksResponse = await socksFetch(`https://localhost:${secureTarget.address().port}/socks-secure`, {
  headers: { Authorization: "Bearer token-socks-secure" },
});
assert.equal(await secureSocksResponse.text(), "secure:/socks-secure");
if (process.env.PROXY_TEST_TRACE) console.error("SOCKS route passed");

const timeoutFetch = createAccountAwareFetch({
  resolveProxy: () => "socks5://127.0.0.1:9",
  timeoutMs: 150,
});
await assert.rejects(
  timeoutFetch(`http://127.0.0.1:${targetPort}/timeout`, { headers: { Authorization: "Bearer token-timeout" } }),
  /ECONNREFUSED|超时|closed|关闭/i,
);
if (process.env.PROXY_TEST_TRACE) console.error("timeout route passed");

await close(socksProxy);
if (process.env.PROXY_TEST_TRACE) console.error("socks closed");
await close(httpsProxy);
if (process.env.PROXY_TEST_TRACE) console.error("https proxy closed");
await close(secureTarget);
if (process.env.PROXY_TEST_TRACE) console.error("secure target closed");
await close(httpProxy);
if (process.env.PROXY_TEST_TRACE) console.error("http proxy closed");
await close(target);
console.log("local proxy regression tests passed");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.__testSockets = new Set();
    server.on("connection", (socket) => {
      server.__testSockets.add(socket);
      socket.once("close", () => server.__testSockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  for (const socket of server.__testSockets || []) socket.destroy();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function handleSocksConnection(socket, credentials = null) {
  let buffer = Buffer.alloc(0);
  let state = "greeting";
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (state === "greeting") {
      if (buffer.length < 2) return;
      const length = 2 + buffer[1];
      if (buffer.length < length) return;
      buffer = buffer.subarray(length);
      socket.write(Buffer.from([0x05, credentials ? 0x02 : 0x00]));
      state = credentials ? "auth" : "request";
    }
    if (state === "auth") {
      if (buffer.length < 2) return;
      const userLength = buffer[1];
      if (buffer.length < 3 + userLength) return;
      const passwordLength = buffer[2 + userLength];
      if (buffer.length < 3 + userLength + passwordLength) return;
      const username = buffer.subarray(2, 2 + userLength).toString("utf8");
      const password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString("utf8");
      buffer = buffer.subarray(3 + userLength + passwordLength);
      if (username !== credentials.username || password !== credentials.password) {
        socket.write(Buffer.from([0x01, 0x01]));
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([0x01, 0x00]));
      state = "request";
    }
    if (state !== "request" || buffer.length < 5) return;
    const type = buffer[3];
    let host;
    let offset;
    if (type === 0x01) {
      if (buffer.length < 10) return;
      host = [...buffer.subarray(4, 8)].join(".");
      offset = 8;
    } else if (type === 0x03) {
      const length = buffer[4];
      if (buffer.length < 7 + length) return;
      host = buffer.subarray(5, 5 + length).toString("utf8");
      offset = 5 + length;
    } else {
      socket.destroy();
      return;
    }
    const port = buffer.readUInt16BE(offset);
    buffer = buffer.subarray(offset + 2);
    state = "proxy";
    const upstream = net.connect({ host, port }, () => {
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      if (buffer.length) upstream.write(buffer);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
  });
}
