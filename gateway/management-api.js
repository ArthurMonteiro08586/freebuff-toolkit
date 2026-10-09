// Optional, authenticated localhost-only management API.
// The Windows launcher writes credentials directly and does not need this
// endpoint.  It exists for advanced local automation and is disabled unless
// both FREEBUFF_MANAGEMENT_API=1 and a random management token are configured.

import { timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, readdirSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parseProxyUrl, redactProxyUrl } from "./local-proxy.js";

export function createManagementApi({ credentialDirectory, token, reload = () => {} }) {
  const expected = Buffer.from(String(token || ""), "utf8");
  if (expected.length < 24) throw new Error("management token must contain at least 24 bytes");

  return async function managementApi(req, res, url) {
    if (url.pathname !== "/_freebuff/accounts") return false;
    if (!isAuthorized(req.headers["x-freebuff-management-token"], expected)) {
      send(res, 401, { error: "unauthorized" });
      return true;
    }
    if (!isLocalRequest(req.socket?.remoteAddress)) {
      send(res, 403, { error: "localhost_only" });
      return true;
    }
    if (req.method === "GET") {
      send(res, 200, { accounts: readSafeAccounts(credentialDirectory) });
      return true;
    }
    if (req.method === "POST") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
      } catch {
        send(res, 400, { error: "invalid_json" });
        return true;
      }
      const key = String(body.key || "");
      const proxy = String(body.proxy || "").trim();
      if (!key) {
        send(res, 400, { error: "missing_key" });
        return true;
      }
      try {
        if (proxy) parseProxyUrl(proxy);
      } catch (error) {
        send(res, 400, { error: "invalid_proxy", message: error.message });
        return true;
      }
      const updated = updateAccountProxy(credentialDirectory, key, proxy);
      if (!updated) {
        send(res, 404, { error: "account_not_found" });
        return true;
      }
      reload();
      send(res, 200, { ok: true, key, proxy: redactProxyUrl(proxy) });
      return true;
    }
    send(res, 405, { error: "method_not_allowed" });
    return true;
  };
}

export function createManagementToken() {
  return randomBytes(32).toString("base64url");
}

export function isLocalHost(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

export function isLocalRequest(address) {
  const value = String(address || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function isAuthorized(received, expected) {
  const actual = Buffer.from(Array.isArray(received) ? received[0] || "" : String(received || ""), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readSafeAccounts(directory) {
  const accounts = [];
  for (const file of credentialFiles(directory)) {
    try {
      const root = JSON.parse(readFileSync(file, "utf8"));
      if (root.accounts && typeof root.accounts === "object") {
        for (const [key, account] of Object.entries(root.accounts)) {
          if (!account?.authToken) continue;
          accounts.push({ key, name: String(account.name || ""), email: maskEmail(account.email), proxy: redactProxyUrl(account.proxy || "") });
        }
      } else if (root.authToken) {
        accounts.push({ key: "default", name: String(root.name || ""), email: maskEmail(root.email), proxy: redactProxyUrl(root.proxy || "") });
      }
    } catch {}
  }
  return accounts;
}

function updateAccountProxy(directory, key, proxy) {
  for (const file of credentialFiles(directory)) {
    let root;
    try { root = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (!root.accounts || typeof root.accounts !== "object" || !root.accounts[key]) continue;
    if (proxy) root.accounts[key].proxy = proxy;
    else delete root.accounts[key].proxy;
    writeJsonAtomically(file, root);
    return true;
  }
  for (const file of credentialFiles(directory)) {
    let root;
    try { root = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (key !== "default" || !root.authToken) continue;
    if (proxy) root.proxy = proxy;
    else delete root.proxy;
    writeJsonAtomically(file, root);
    return true;
  }
  return false;
}

function credentialFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => resolve(directory, file));
}

function writeJsonAtomically(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${path}.bak`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    const handle = openSync(temporary, "r+");
    try {
      try { fsyncSync(handle); } catch (error) {
        // Some Windows filesystems reject fsync on read-only handles. The
        // writeFileSync call is complete and rename remains atomic.
        if (error?.code !== "EPERM" && error?.code !== "EINVAL") throw error;
      }
    } finally { closeSync(handle); }
    if (existsSync(path)) copyFileSync(path, backup);
    renameSync(temporary, path);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
  }
}

async function readBody(req, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function maskEmail(value) {
  const email = String(value || "");
  const at = email.indexOf("@");
  if (at <= 1) return email ? "***" : "";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
