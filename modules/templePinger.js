// modules/templePinger.js
import { loadConfig, saveConfig } from "./storage.js";

const PREFIX = "$";
const CHECK_EVERY_MS = 30 * 1000;

// Per-guild runtime state
const cfgCache = new Map(); // guildId -> cfg
const lastPingedForDropISO = new Map(); // guildId -> dropISO
let schedulerStarted = false;

function fmtUTC(d) {
  return d.toUTCString();
}

function getCfg(guildId) {
  const cached = cfgCache.get(guildId);
  if (cached) return cached;
  const cfg = loadConfig(guildId);
  cfgCache.set(guildId, cfg);
  return cfg;
}

function persistCfg(guildId, cfg) {
  cfgCache.set(guildId, cfg);
  saveConfig(guildId, cfg);
}

function parseDateTimeWithTZ(dateStr, timeStr, tzStr) {
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, m] = timeStr.split(":").map(Number);
  if (!Y || !M || !D || Number.isNaN(h) || Number.isNaN(m)) return null;

  let offsetMinutes = 0;
  if (tzStr.toUpperCase() === "UTC") {
    offsetMinutes = 0;
  } else {
    const match = tzStr.match(/^([+-])(\d{2}):(\d{2})$/);
    if (!match) return null;
    const sign = match[1] === "-" ? -1 : 1;
    const oh = Number(match[2]);
    const om = Number(match[3]);
    offsetMinutes = sign * (oh * 60 + om);
  }

  const utcMs = Date.UTC(Y, M - 1, D, h, m) - offsetMinutes * 60 * 1000;
  const dObj = new Date(utcMs);
  if (Number.isNaN(dObj.getTime())) return null;
  return dObj;
}

function ensureFutureDrop(guildId, cfg) {
  if (!cfg?.nextShieldDropISO) return;

  let d = new Date(cfg.nextShieldDropISO);
  if (Number.isNaN(d.getTime())) {
    cfg.nextShieldDropISO = null;
    persistCfg(guildId, cfg);
    return;
  }

  while (d.getTime() <= Date.now()) {
    d = new Date(d.getTime() + cfg.cycleDays * 24 * 60 * 60 * 1000);
  }

  cfg.nextShieldDropISO = d.toISOString();
  persistCfg(guildId, cfg);
}

function computeTimes(cfg) {
  if (!cfg?.nextShieldDropISO) return null;

  const drop = new Date(cfg.nextShieldDropISO);
  if (Number.isNaN(drop.getTime())) return null;

  const pingAt = new Date(drop.getTime() - cfg.pingHoursBefore * 60 * 60 * 1000);
  const reshieldAt = new Date(drop.getTime() + cfg.unshieldedHours * 60 * 60 * 1000);

  return { drop, pingAt, reshieldAt };
}

async function sendPing(client, cfg) {
  const channel = await client.channels.fetch(cfg.targetChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error("Target channel not found or not text-based.");

  await channel.send({
    content: `<@&${cfg.pingRoleId}> Wake up! Throphyes time!`,
    allowedMentions: { roles: [cfg.pingRoleId] }
  });
}

function advanceOneCycle(guildId, cfg) {
  const d = new Date(cfg.nextShieldDropISO);
  const next = new Date(d.getTime() + cfg.cycleDays * 24 * 60 * 60 * 1000);
  cfg.nextShieldDropISO = next.toISOString();
  persistCfg(guildId, cfg);
}

async function tickSchedulerForGuild(client, guildId) {
  const cfg = getCfg(guildId);
  if (!cfg?.nextShieldDropISO) return;

  ensureFutureDrop(guildId, cfg);
  const t = computeTimes(cfg);
  if (!t) return;

  const { drop, pingAt } = t;
  const now = Date.now();

  if (now >= pingAt.getTime()) {
    const dropISO = drop.toISOString();
    if (lastPingedForDropISO.get(guildId) !== dropISO) {
      try {
        await sendPing(client, cfg);
        lastPingedForDropISO.set(guildId, dropISO);
        advanceOneCycle(guildId, cfg);
      } catch (e) {
        console.error("[TEMPLE][PING ERROR]", e);
      }
    }
  }
}

function statusText(guildId, cfg) {
  if (!cfg?.targetChannelId || !cfg?.pingRoleId) {
    return (
      `Temple pinger not configured yet.\n` +
      `Admin must run:\n` +
      `• \`${PREFIX}temple set channel #channel\`\n` +
      `• \`${PREFIX}temple set role @role\`\n` +
      `Then set the next drop with:\n` +
      `• \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\``
    );
  }

  if (!cfg?.nextShieldDropISO) {
    return (
      `No shield drop set.\n` +
      `Use: \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\`\n` +
      `Example: \`${PREFIX}setdrop 2026-02-13 18:31 +02:00\``
    );
  }

  ensureFutureDrop(guildId, cfg);
  const t = computeTimes(cfg);
  if (!t) return "Stored shield drop time is invalid. Please set it again.";

  const { drop, pingAt, reshieldAt } = t;
  const now = Date.now();

  const shieldedNow = now < drop.getTime();
  const unshieldedNow = now >= drop.getTime() && now < reshieldAt.getTime();

  const lines = [];
  lines.push("**Lost Temple Status**");
  lines.push(`• Channel: <#${cfg.targetChannelId}>`);
  lines.push(`• Role: <@&${cfg.pingRoleId}>`);
  lines.push(`• Allowed Role: ${cfg.allowedRoleId ? `<@&${cfg.allowedRoleId}>` : "**not set**"}`);
  lines.push(`• Cycle Days: **${cfg.cycleDays}**`);
  lines.push(`• Ping Before: **${cfg.pingHoursBefore}h**`);
  lines.push(`• Unshielded Duration: **${cfg.unshieldedHours}h**`);
  lines.push("");

  if (shieldedNow) lines.push("🟦 **Temple is SHIELDED now**");
  else if (unshieldedNow) lines.push("🔴 **Temple is UNSHIELDED now (contest phase)**");
  else lines.push("🟦 **Temple is SHIELDED now (between cycles)**");

  lines.push(`• Shield drops at (UTC): **${fmtUTC(drop)}**`);
  lines.push(`• Reshield at (UTC): **${fmtUTC(reshieldAt)}**`);
  lines.push(`• Next ping at (UTC): **${fmtUTC(pingAt)}**`);

  return lines.join("\n");
}

// Permissions
async function isGuildOwner(msg) {
  const ownerId = msg.guild.ownerId || (await msg.guild.fetchOwner().then(o => o.id).catch(() => null));
  return ownerId && msg.author.id === ownerId;
}

function isAdmin(msg) {
  return msg.member?.permissions?.has?.("ManageGuild");
}

async function canUseTemple(msg, cfg) {
  if (await isGuildOwner(msg)) return true;
  if (cfg?.allowedRoleId && msg.member?.roles?.cache?.has(cfg.allowedRoleId)) return true;
  return false;
}

export function setupTemplePinger(client) {
  console.log("[TEMPLE] module registered");

  // Commands
  client.on("messageCreate", async (msg) => {
    try {
      if (msg.author.bot) return;
      if (!msg.guild) return;
      if (!msg.content.startsWith(PREFIX)) return;

      const guildId = msg.guild.id;
      const cfg = getCfg(guildId);
      ensureFutureDrop(guildId, cfg);

      const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = (args.shift() ?? "").toLowerCase();

      // =========================
      // $temple ... (CONFIG + PERMISSIONS)
      // =========================
      if (cmd === "temple") {
        const sub = (args.shift() ?? "").toLowerCase();

        // $temple show
        if (sub === "show" || sub === "status") {
          return msg.reply({ content: statusText(guildId, cfg), allowedMentions: { roles: [] } });
        }

        // $temple set channel #channel  (Admin)
        if (sub === "set" && (args[0] ?? "").toLowerCase() === "channel") {
          if (!isAdmin(msg)) return msg.reply("❌ You need **Manage Server** to set the temple channel.");
          const ch = msg.mentions.channels.first();
          if (!ch) return msg.reply("Usage: `$temple set channel #channel`");

          cfg.targetChannelId = ch.id;
          persistCfg(guildId, cfg);
          return msg.reply(`✅ Temple channel set to ${ch}`);
        }

        // $temple set role @role (Admin)
        if (sub === "set" && (args[0] ?? "").toLowerCase() === "role") {
          if (!isAdmin(msg)) return msg.reply("❌ You need **Manage Server** to set the temple role.");
          const role = msg.mentions.roles.first();
          if (!role) return msg.reply("Usage: `$temple set role @role`");

          cfg.pingRoleId = role.id;
          persistCfg(guildId, cfg);
          return msg.reply(`✅ Temple ping role set to **${role.name}**`);
        }

        // $temple access ... (Owner only)
        if (sub === "access") {
          if (!(await isGuildOwner(msg))) return msg.reply("❌ Only the **Server Owner** can set Temple access role.");

          // $temple access clear
          if ((args[0] ?? "").toLowerCase() === "clear") {
            cfg.allowedRoleId = null;
            persistCfg(guildId, cfg);
            return msg.reply("✅ Temple access role cleared.");
          }

          // $temple access @Role
          const role = msg.mentions.roles.first();
          if (!role) return msg.reply("Usage: `$temple access @Role` OR `$temple access clear`");

          cfg.allowedRoleId = role.id;
          persistCfg(guildId, cfg);
          return msg.reply(`✅ Temple access role set to **${role.name}**`);
        }

        return msg.reply(
          "**Temple Setup Commands**\n" +
          "`$temple set channel #channel` *(Admin: Manage Server)*\n" +
          "`$temple set role @role` *(Admin: Manage Server)*\n" +
          "`$temple show`\n\n" +
          "**Temple Permission Commands**\n" +
          "`$temple access @Role` *(Owner only)*\n" +
          "`$temple access clear` *(Owner only)*"
        );
      }

      // =========================
      // RESTRICT ALL TEMPLE COMMANDS
      // =========================
      const templeCmds = ["help", "status", "info", "stat", "setdrop", "cycle", "pinghours", "pingtest"];
      if (templeCmds.includes(cmd)) {
        const ok = await canUseTemple(msg, cfg);
        if (!ok) {
          const req = cfg?.allowedRoleId ? `<@&${cfg.allowedRoleId}>` : "**Server Owner**";
          return msg.reply(`❌ No permission. Required: ${req}`);
        }
      }

      // =========================
      // TEMPLE COMMANDS
      // =========================
      if (cmd === "help") {
        return msg.reply({
          content:
            `**Temple Commands**\n` +
            `• \`${PREFIX}help\`\n` +
            `• \`${PREFIX}status\`\n` +
            `• \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\`\n` +
            `• \`${PREFIX}cycle <days>\`\n` +
            `• \`${PREFIX}pinghours <hours>\`\n` +
            `• \`${PREFIX}pingtest\`\n\n` +
            `**Setup**\n` +
            `• \`${PREFIX}temple set channel #channel\` (Admin)\n` +
            `• \`${PREFIX}temple set role @role\` (Admin)\n` +
            `• \`${PREFIX}temple access @Role\` (Owner)`,
          allowedMentions: { repliedUser: false }
        });
      }

      if (cmd === "status" || cmd === "info" || cmd === "stat") {
        return msg.reply({ content: statusText(guildId, cfg), allowedMentions: { roles: [] } });
      }

      if (cmd === "setdrop") {
        const [dateStr, timeStr, tzStr] = args;
        if (!dateStr || !timeStr || !tzStr) {
          return msg.reply(`Usage: \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\` (TZ = UTC or +02:00)`);
        }

        const d = parseDateTimeWithTZ(dateStr, timeStr, tzStr);
        if (!d) return msg.reply("Invalid format. Example: `$setdrop 2026-02-13 18:31 +02:00`");

        cfg.nextShieldDropISO = d.toISOString();
        persistCfg(guildId, cfg);
        lastPingedForDropISO.delete(guildId);

        return msg.reply(
          `✅ Next shield drop set to (UTC): **${fmtUTC(d)}**\n` +
          `I will ping <@&${cfg.pingRoleId}> in <#${cfg.targetChannelId}> **${cfg.pingHoursBefore}h before**, repeating every **${cfg.cycleDays} days**.`
        );
      }

      if (cmd === "cycle") {
        const days = Number(args[0]);
        if (!Number.isFinite(days) || days < 1 || days > 30) {
          return msg.reply(`Usage: \`${PREFIX}cycle 6\` or \`${PREFIX}cycle 7\``);
        }
        cfg.cycleDays = days;
        persistCfg(guildId, cfg);
        lastPingedForDropISO.delete(guildId);
        return msg.reply(`✅ Cycle updated: **${cfg.cycleDays} days**`);
      }

      if (cmd === "pinghours") {
        const hours = Number(args[0]);
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
          return msg.reply(`Usage: \`${PREFIX}pinghours 24\` (1–168)`);
        }
        cfg.pingHoursBefore = hours;
        persistCfg(guildId, cfg);
        lastPingedForDropISO.delete(guildId);
        return msg.reply(`✅ Ping offset updated: **${cfg.pingHoursBefore} hours before drop**`);
      }

      if (cmd === "pingtest") {
        try {
          if (!cfg?.targetChannelId || !cfg?.pingRoleId) {
            return msg.reply("❌ Not configured. Use `$temple set channel` and `$temple set role`.");
          }

          const channel = await client.channels.fetch(cfg.targetChannelId).catch(() => null);
          if (!channel || !channel.isTextBased()) return msg.reply("Target channel not found.");

          await channel.send({
            content: `<@&${cfg.pingRoleId}> Wake up! Throphyes time!`,
            allowedMentions: { roles: [cfg.pingRoleId] }
          });

          return msg.reply("✅ Test ping sent.");
        } catch (e) {
          console.error(e);
          return msg.reply("❌ Failed to send test ping. Check bot permissions + role mention perms.");
        }
      }

      return msg.reply(`Unknown command. Use \`${PREFIX}help\``);
    } catch (e) {
      console.error("[TEMPLE][MSG ERROR]", e);
    }
  });

  // Scheduler (runs for each guild)
  client.once("ready", () => {
    if (schedulerStarted) return;
    schedulerStarted = true;

    console.log("[TEMPLE] scheduler started");

    setInterval(async () => {
      try {
        for (const guildId of client.guilds.cache.keys()) {
          await tickSchedulerForGuild(client, guildId);
        }
      } catch (e) {
        console.error("[TEMPLE][SCHED ERROR]", e);
      }
    }, CHECK_EVERY_MS);
  });
}
