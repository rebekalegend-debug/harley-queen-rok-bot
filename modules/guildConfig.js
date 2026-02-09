// modules/guildConfig.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer persistent storage (Railway Volume). Fallback to local folder.
const BASE_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(BASE_DIR, "guilds.json");

// Ensure directory exists (important for /data)
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

console.log("📦 guildConfig storage:", FILE);

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

function deepMerge(a, b) {
  if (typeof a !== "object" || !a) return b;
  if (typeof b !== "object" || !b) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = deepMerge(a[k], b[k]);
  }
  return out;
}

export function getGuild(guildId) {
  const db = load();
  return db[guildId] ?? {};
}

export function setGuild(guildId, patch) {
  const db = load();
  db[guildId] = deepMerge(db[guildId] ?? {}, patch);
  save(db);
  return db[guildId];
}

