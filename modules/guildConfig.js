// modules/guildConfig.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ================= PATH / FILE ================= */

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer persistent storage (Railway Volume). Fallback to ./data
const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(BASE_DIR, "guilds.json");

// Ensure directory exists (important for /data)
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

console.log("📦 guildConfig storage:", FILE);

/* ================= CORE ================= */

function load() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ guildConfig load error:", e);
    return {};
  }
}

function save(db) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("❌ guildConfig save error:", e);
  }
}

function isObj(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function deepMerge(a, b) {
  if (!isObj(a)) return b;
  if (!isObj(b)) return b;

  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = deepMerge(a[k], b[k]);
  }
  return out;
}

/* ================= PUBLIC API ================= */

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

/* ================= AOO HELPERS ================= */
/**
 * Keeps your original return shape exactly:
 * { accessRoleId, channelId, pingRoleId, startAtUtc }
 */
export function getGuildAoo(guildId) {
  const g = getGuild(guildId);
  return {
    accessRoleId: g.aoo?.accessRoleId ?? null,
    channelId: g.aoo?.channelId ?? null,
    pingRoleId: g.aoo?.pingRoleId ?? null,
    startAtUtc: g.aoo?.startAtUtc ?? null,
  };
}

/**
 * Optional helper if you want to set AOO config through guildConfig.js
 * Example: setGuildAoo(guildId, { channelId: "...", pingRoleId: "..." })
 */
export function setGuildAoo(guildId, patch) {
  return setGuild(guildId, { aoo: patch });
}

/* ================= TEMPLE HELPERS ================= */
/**
 * Temple defaults match your old storage.js defaults (env overrides kept)
 */
export function getGuildTemple(guildId) {
  const g = getGuild(guildId);

  return {
    targetChannelId: g.temple?.targetChannelId ?? null,
    pingRoleId: g.temple?.pingRoleId ?? null,
    allowedRoleId: g.temple?.allowedRoleId ?? null,

    cycleDays: Number(g.temple?.cycleDays ?? process.env.TEMPLE_CYCLE_DAYS ?? "7"),
    pingHoursBefore: Number(
      g.temple?.pingHoursBefore ?? process.env.TEMPLE_PING_HOURS_BEFORE ?? "24"
    ),
    unshieldedHours: Number(
      g.temple?.unshieldedHours ?? process.env.TEMPLE_UNSHIELDED_HOURS ?? "2"
    ),

    nextShieldDropISO: g.temple?.nextShieldDropISO ?? null,
  };
}

export function setGuildTemple(guildId, patch) {
  return setGuild(guildId, { temple: patch });
}
