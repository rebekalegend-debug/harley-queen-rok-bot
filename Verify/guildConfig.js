const fs = require("fs");
const path = require("path");

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
  // you can keep or remove this log
  // console.log("💾 Saved guilds.json:", FILE);
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

function getGuild(guildId) {
  const db = load();
  return db[guildId] ?? {};
}

function setGuild(guildId, patch) {
  const db = load();
  db[guildId] = deepMerge(db[guildId] ?? {}, patch);
  save(db);
  return db[guildId];
}

module.exports = { getGuild, setGuild };
