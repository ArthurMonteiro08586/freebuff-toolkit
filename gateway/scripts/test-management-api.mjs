#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createManagementApi, isLocalHost } from "../management-api.js";

assert.equal(isLocalHost("127.0.0.1"), true);
assert.equal(isLocalHost("localhost"), true);
assert.equal(isLocalHost("0.0.0.0"), false);
assert.throws(() => createManagementApi({ credentialDirectory: ".", token: "short" }), /24 bytes/);

const directory = mkdtempSync(join(tmpdir(), "freebuff-management-test-"));
const credentialPath = join(directory, "freebuff_credentials.json");
const secretToken = "test-management-token-123456789";
const original = {
  accounts: {
    account1: {
      id: "account1",
      name: "Test Account",
      email: "hello@example.com",
      authToken: "not-a-real-token-value",
      proxy: "http://alice:secret@127.0.0.1:8080",
    },
  },
};
writeFileSync(credentialPath, JSON.stringify(original, null, 2) + "\n");

let reloadCount = 0;
const api = createManagementApi({ credentialDirectory: directory, token: secretToken, reload: () => reloadCount++ });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (!await api(req, res, url)) {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const unauthorized = await fetch(base + "/_freebuff/accounts");
assert.equal(unauthorized.status, 401);
const wrongToken = await fetch(base + "/_freebuff/accounts", { headers: { "x-freebuff-management-token": "x".repeat(secretToken.length) } });
assert.equal(wrongToken.status, 401);

const list = await fetch(base + "/_freebuff/accounts", { headers: { "x-freebuff-management-token": secretToken } });
assert.equal(list.status, 200);
const payload = await list.json();
assert.equal(payload.accounts[0].email, "he***@example.com");
assert.equal(payload.accounts[0].proxy, "http://***@127.0.0.1:8080");
assert.ok(!JSON.stringify(payload).includes("not-a-real-token-value"));
assert.ok(!JSON.stringify(payload).includes("secret"));

const invalid = await fetch(base + "/_freebuff/accounts", {
  method: "POST",
  headers: { "content-type": "application/json", "x-freebuff-management-token": secretToken },
  body: JSON.stringify({ key: "account1", proxy: "ftp://127.0.0.1" }),
});
assert.equal(invalid.status, 400);

const saved = await fetch(base + "/_freebuff/accounts", {
  method: "POST",
  headers: { "content-type": "application/json", "x-freebuff-management-token": secretToken },
  body: JSON.stringify({ key: "account1", proxy: "socks5://user:password@127.0.0.1:1080" }),
});
assert.equal(saved.status, 200);
assert.equal(reloadCount, 1);
const written = JSON.parse(readFileSync(credentialPath, "utf8"));
assert.equal(written.accounts.account1.proxy, "socks5://user:password@127.0.0.1:1080");
assert.equal(JSON.parse(readFileSync(credentialPath + ".bak", "utf8")).accounts.account1.proxy, original.accounts.account1.proxy);

await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
rmSync(directory, { recursive: true, force: true });
console.log("management API regression tests passed");
