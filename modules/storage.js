// modules/storage.js
import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "templeConfig.json");

const DEFAULTS = {
  targetChannelId: process.env.TEMPLE_CHANNEL_ID ?? null,
  pingRoleId: process.env.TEMPLE_PING_ROLE_ID ?? null,
  allowedRoleId: null,
  // scheduling behavior
  cycleDays: Number(process.env.TEMPLE_CYCLE_DAYS ?? "7"),
  pingHoursBefore: Number(process.env.TEMPLE_PING_HOURS_BEFORE ?? "24"),
  unshieldedHours: Number(process.env.TEMPLE_UNSHIELDED_HOURS ?? "2"),

  // next event time (UTC ISO)
  nextShieldDropISO: null
};

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf8");
      return { ...DEFAULTS };
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);

    // merge defaults so new fields appear automatically
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    console.error("[TEMPLE][CONFIG] load error:", e);
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[TEMPLE][CONFIG] save error:", e);
  }
}
