// modules/storage.js
import fs from "node:fs";
import path from "node:path";

const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// Temple defaults (same as your old file)
const TEMPLE_DEFAULTS = {
  targetChannelId: null,
  pingRoleId: null,
  allowedRoleId: null,

  cycleDays: Number(process.env.TEMPLE_CYCLE_DAYS ?? "7"),
  pingHoursBefore: Number(process.env.TEMPLE_PING_HOURS_BEFORE ?? "24"),
  unshieldedHours: Number(process.env.TEMPLE_UNSHIELDED_HOURS ?? "2"),

  nextShieldDropISO: null,
};

// Ensure directory exists
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

console.log("📦 storage BASE_DIR:", BASE_DIR);

function getPath(prefix, guildId) {
  return path.join(BASE_DIR, `${prefix}_${guildId}.json`);
}

/**
 * BACKWARD COMPATIBLE:
 * Old Temple usage: loadConfig(guildId)
 * New usage: loadConfig(prefix, guildId, defaults)
 */
export function loadConfig(a, b, c) {
  const isNew = typeof a === "string" && typeof b === "string";
  const prefix = isNew ? a : "temple";
  const guildId = isNew ? b : a;
  const defaults = isNew ? (c ?? {}) : TEMPLE_DEFAULTS;

  const FILE = getPath(prefix, guildId);

  try {
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify(defaults, null, 2), "utf8");
      return { ...defaults };
    }
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (e) {
    console.error(`[${prefix.toUpperCase()}][CONFIG] load error:`, e);
    return { ...defaults };
  }
}

/**
 * BACKWARD COMPATIBLE:
 * Old Temple usage: saveConfig(guildId, cfg)
 * New usage: saveConfig(prefix, guildId, cfg)
 */
export function saveConfig(a, b, c) {
  const isNew = typeof a === "string" && typeof b === "string";
  const prefix = isNew ? a : "temple";
  const guildId = isNew ? b : a;
  const cfg = isNew ? c : b;

  const FILE = getPath(prefix, guildId);

  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error(`[${prefix.toUpperCase()}][CONFIG] save error:`, e);
  }
}
