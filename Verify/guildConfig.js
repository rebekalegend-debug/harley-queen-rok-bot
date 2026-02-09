
const fs = require("fs");
const path = require("path");

const FILE = path.join(harley-queen-rok-bot/Verify.json, "guilds.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
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
