import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "config.json");
const DEFAULTS_PATH = path.join(process.cwd(), "config.defaults.json");

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const defaults = readJsonSafe(DEFAULTS_PATH) ?? {};
  const saved = readJsonSafe(CONFIG_PATH) ?? {};

  // ENV overrides (persistent on Railway)
  const env = process.env;

  const cfg = {
    ...defaults,
    ...saved,
    targetChannelId: env.TARGET_CHANNEL_ID ?? saved.targetChannelId ?? defaults.targetChannelId,
    pingRoleId: env.PING_ROLE_ID ?? saved.pingRoleId ?? defaults.pingRoleId,
    cycleDays: Number(env.CYCLE_DAYS ?? saved.cycleDays ?? defaults.cycleDays),
    pingHoursBefore: Number(env.PING_HOURS_BEFORE ?? saved.pingHoursBefore ?? defaults.pingHoursBefore),
    unshieldedHours: Number(env.UNSHIELDED_HOURS ?? saved.unshieldedHours ?? defaults.unshieldedHours),
    nextShieldDropISO: env.NEXT_SHIELD_DROP_ISO ?? saved.nextShieldDropISO ?? defaults.nextShieldDropISO
  };

  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
