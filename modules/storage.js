// modules/storage.js
import fs from "node:fs";
import path from "node:path";

const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

const DEFAULTS = {
  targetChannelId: null,
  pingRoleId: null,
  allowedRoleId: null,

  cycleDays: Number(process.env.TEMPLE_CYCLE_DAYS ?? "7"),
  pingHoursBefore: Number(process.env.TEMPLE_PING_HOURS_BEFORE ?? "24"),
  unshieldedHours: Number(process.env.TEMPLE_UNSHIELDED_HOURS ?? "2"),

  nextShieldDropISO: null
};

// Ensure /data directory exists
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

function getPath(guildId) {
  return path.join(BASE_DIR, `temple_${guildId}.json`);
}

export function loadConfig(guildId) {
  const FILE = getPath(guildId);
  try {
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2), "utf8");
      return { ...DEFAULTS };
    }
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    console.error("[TEMPLE][CONFIG] load error:", e);
    return { ...DEFAULTS };
  }
}

export function saveConfig(guildId, cfg) {
  const FILE = getPath(guildId);
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[TEMPLE][CONFIG] save error:", e);
  }
}
