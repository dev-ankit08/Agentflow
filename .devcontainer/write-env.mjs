// Writes the repo-root .env for a Codespaces trial from .env.example: keeps secrets already generated, fills new
// ones, and points every URL at this Codespace's public addresses. Safe to run on every start.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const parse = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );

const current = existsSync(".env") ? parse(readFileSync(".env", "utf8")) : {};
const secret = () => randomBytes(32).toString("base64");
const keep = (key, make) => (current[key] && !current[key].startsWith("change-me") ? current[key] : make());
// Easy to read out and type: no 0/O or 1/l.
const code = () => Array.from(randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

const name = process.env.CODESPACE_NAME;
const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? "app.github.dev";
const host = (port) => (name ? `${name}-${port}.${domain}` : null);
const url = (port) => (name ? `https://${host(port)}` : `http://localhost:${port}`);

const values = {
  AUTH_SECRET: keep("AUTH_SECRET", secret),
  API_JWT_SECRET: keep("API_JWT_SECRET", secret),
  SECRETS_MASTER_KEY: keep("SECRETS_MASTER_KEY", secret),
  // A Codespaces secret named TRIAL_ACCESS_CODE wins, so the code can be chosen and kept across codespaces.
  TRIAL_ACCESS_CODE: process.env.TRIAL_ACCESS_CODE || keep("TRIAL_ACCESS_CODE", code),
  AUTH_URL: url(3100),
  PUBLIC_API_URL: url(4000),
  API_URL: "http://localhost:4000",
  // The Codespaces proxy sends Origin: localhost:3100 with x-forwarded-host set to the public address, so server
  // actions must accept both.
  SERVER_ACTIONS_ALLOWED_ORIGINS: name ? `${host(3100)},localhost:3100` : "",
  AUTH_DEV_LOGIN: "false",
  // The bundled demo model and orders server run on localhost inside the codespace; every workspace gets them
  // until it adds its own model key or connector, so templates run straight away.
  ALLOW_PRIVATE_HTTP: "true",
  TRIAL_DEMO_MODEL_URL: "http://localhost:4010/v1",
  TRIAL_DEMO_MCP_URL: "http://localhost:4020/mcp",
};

const lines = readFileSync(".env.example", "utf8")
  .split("\n")
  .map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (!key) return line;
    const value = values[key] ?? current[key];
    return value === undefined ? line : `${key}=${value}`;
  });
writeFileSync(".env", lines.join("\n"));
console.log(`.env ready for ${url(3100)}`);
