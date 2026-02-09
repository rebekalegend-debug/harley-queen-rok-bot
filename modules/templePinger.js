// modules/templePinger.js
import { loadConfig, saveConfig } from "./storage.js";

const PREFIX = "$";
const CHECK_EVERY_MS = 30 * 1000;

let cfg = null;
let lastPingedForDropISO = null;
let schedulerStarted = false;

function fmtUTC(d) {
  return d.toUTCString();
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

function ensureFutureDrop() {
  if (!cfg?.nextShieldDropISO) return;

  let d = new Date(cfg.nextShieldDropISO);
  if (Number.isNaN(d.getTime())) {
    cfg.nextShieldDropISO = null;
    saveConfig(cfg);
    return;
  }

  while (d.getTime() <= Date.now()) {
    d = new Date(d.getTime() + cfg.cycleDays * 24 * 60 * 60 * 1000);
  }

  cfg.nextShieldDropISO = d.toISOString();
  saveConfig(cfg);
}

function computeTimes() {
  if (!cfg?.nextShieldDropISO) return null;

  const drop = new Date(cfg.nextShieldDropISO);
  if (Number.isNaN(drop.getTime())) return null;

  const pingAt = new Date(drop.getTime() - cfg.pingHoursBefore * 60 * 60 * 1000);
  const reshieldAt = new Date(drop.getTime() + cfg.unshieldedHours * 60 * 60 * 1000);

  return { drop, pingAt, reshieldAt };
}

async function sendPing(client, dropDate) {
  const channel = await client.channels.fetch(cfg.targetChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error("Target channel not found or not text-based.");

  await channel.send({
    content: `<@&${cfg.pingRoleId}> Wake up! Throphyes time!`,
    allowedMentions: { roles: [cfg.pingRoleId] }
  });

  lastPingedForDropISO = dropDate.toISOString();
}

function advanceOneCycle() {
  const d = new Date(cfg.nextShieldDropISO);
  const next = new Date(d.getTime() + cfg.cycleDays * 24 * 60 * 60 * 1000);
  cfg.nextShieldDropISO = next.toISOString();
  saveConfig(cfg);
}

async function tickScheduler(client) {
  if (!cfg?.nextShieldDropISO) return;

  ensureFutureDrop();
  const t = computeTimes();
  if (!t) return;

  const { drop, pingAt } = t;
  const now = Date.now();

  if (now >= pingAt.getTime()) {
    if (lastPingedForDropISO !== drop.toISOString()) {
      try {
        await sendPing(client, drop);
        advanceOneCycle();
      } catch (e) {
        console.error("[TEMPLE][PING ERROR]", e);
      }
    }
  }
}

function statusText() {
  if (!cfg?.targetChannelId || !cfg?.pingRoleId) {
    return (
      `Temple pinger not configured.\n` +
      `Set env vars: TEMPLE_CHANNEL_ID and TEMPLE_PING_ROLE_ID\n` +
      `Then restart bot.`
    );
  }

  if (!cfg?.nextShieldDropISO) {
    return (
      `No shield drop set.\n` +
      `Use: \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\`\n` +
      `Example: \`${PREFIX}setdrop 2026-02-13 18:31 +02:00\``
    );
  }

  ensureFutureDrop();
  const t = computeTimes();
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

// -------- Permission model (RESTRICTED ONLY) --------
async function isGuildOwner(msg) {
  if (!msg.guild) return false;
  const ownerId = msg.guild.ownerId || (await msg.guild.fetchOwner().then(o => o.id).catch(() => null));
  return ownerId && msg.author.id === ownerId;
}

async function canUseTemple(msg) {
  // server owner always allowed
  if (await isGuildOwner(msg)) return true;

  // allowed role
  if (cfg?.allowedRoleId && msg.member?.roles?.cache?.has(cfg.allowedRoleId)) return true;

  return false;
}

export function setupTemplePinger(client) {
  cfg = loadConfig();
  ensureFutureDrop();

  console.log("[TEMPLE] module registered");

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() ?? "").toLowerCase();
    // =========================
    // $temple ... (CONFIG COMMANDS)
    // - set channel / set role: Admin-only (Manage Server)
    // - access role: Server Owner only
    // =========================
    if (cmd === "temple") {
      if (!msg.guild) return;

      const sub = (args.shift() ?? "").toLowerCase();

      // --- helper checks ---
      const isAdmin = msg.member?.permissions?.has?.("ManageGuild");
      const isOwner = msg.author.id === msg.guild.ownerId;

      // $temple show
      if (sub === "show" || sub === "status") {
        return msg.reply({ content: statusText(), allowedMentions: { roles: [] } });
      }

      // $temple set channel #channel  (Admin)
      if (sub === "set" && (args[0] ?? "").toLowerCase() === "channel") {
        if (!isAdmin) return msg.reply("❌ You need **Manage Server** to set the temple channel.");
        const ch = msg.mentions.channels.first();
        if (!ch) return msg.reply("Usage: `$temple set channel #channel`");

        cfg.targetChannelId = ch.id;
        saveConfig(cfg);
        return msg.reply(`✅ Temple channel set to ${ch}`);
      }

      // $temple set role @role (Admin)
      if (sub === "set" && (args[0] ?? "").toLowerCase() === "role") {
        if (!isAdmin) return msg.reply("❌ You need **Manage Server** to set the temple role.");
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply("Usage: `$temple set role @role`");

        cfg.pingRoleId = role.id;
        saveConfig(cfg);
        return msg.reply(`✅ Temple ping role set to **${role.name}**`);
      }

      // $temple access @Role (Owner)
      if (sub === "access") {
        if (!isOwner) return msg.reply("❌ Only the **Server Owner** can set Temple access role.");

        // $temple access clear
        if ((args[0] ?? "").toLowerCase() === "clear") {
          cfg.allowedRoleId = null;
          saveConfig(cfg);
          return msg.reply("✅ Temple access role cleared.");
        }

        // $temple access @Role
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply("Usage: `$temple access @Role` OR `$temple access clear`");

        cfg.allowedRoleId = role.id;
        saveConfig(cfg);
        return msg.reply(`✅ Temple access role set to **${role.name}**`);
      }

      return msg.reply(
        "**Temple Setup Commands**\n" +
        "`$temple set channel #channel` *(Admin: Manage Server)*\n" +
        "`$temple set role @role` *(Admin: Manage Server)*\n" +
        "`$temple show` *(shows status)*\n\n" +
        "**Temple Permission Commands**\n" +
        "`$temple access @Role` *(Owner only)*\n" +
        "`$temple access clear` *(Owner only)*"
      );
    }

    // =========================
    // OWNER-ONLY: set/remove allowed role
    // =========================
    if (cmd === "temple") {
      if (!(await isGuildOwner(msg))) {
        return msg.reply("❌ Only the **Server Owner** can change Temple permissions.");
      }

      const sub = (args.shift() ?? "").toLowerCase();

      // $temple access @Role
      if (sub === "access") {
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply("Usage: `$temple access @Role` or `$temple access clear`");

        cfg.allowedRoleId = role.id;
        saveConfig(cfg);
        return msg.reply(`✅ Temple access role set to **${role.name}**`);
      }

      // $temple access clear
      if (sub === "access" && (args[0] ?? "").toLowerCase() === "clear") {
        cfg.allowedRoleId = null;
        saveConfig(cfg);
        return msg.reply("✅ Temple access role cleared. Only Server Owner can use Temple commands now.");
      }

      // allow: $temple show (owner can always see)
      if (sub === "show" || sub === "status") {
        return msg.reply({ content: statusText(), allowedMentions: { roles: [] } });
      }

      return msg.reply(
        "**Temple Owner Commands**\n" +
        "`$temple access @Role` — allow that role to use temple commands\n" +
        "`$temple access clear` — remove allowed role\n" +
        "`$temple show` — show temple config/status"
      );
    }

    // =========================
    // RESTRICT all temple commands
    // =========================
    const templeCmds = ["help", "status", "info", "stat", "setdrop", "cycle", "pinghours", "pingtest"];
    if (templeCmds.includes(cmd)) {
      const ok = await canUseTemple(msg);
      if (!ok) {
        const req = cfg?.allowedRoleId ? `<@&${cfg.allowedRoleId}>` : "**Server Owner**";
        return msg.reply(`❌ No permission. Required: ${req}`);
      }
    }

    // ----- existing commands -----
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
          `**Owner Permissions**\n` +
          `• \`${PREFIX}temple access @Role\`\n` +
          `• \`${PREFIX}temple access clear\``,
        allowedMentions: { repliedUser: false }
      });
    }

    if (cmd === "status" || cmd === "info" || cmd === "stat") {
      return msg.reply({ content: statusText(), allowedMentions: { roles: [] } });
    }

    if (cmd === "setdrop") {
      const [dateStr, timeStr, tzStr] = args;
      if (!dateStr || !timeStr || !tzStr) {
        return msg.reply(`Usage: \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\` (TZ = UTC or +02:00)`);
      }

      const d = parseDateTimeWithTZ(dateStr, timeStr, tzStr);
      if (!d) return msg.reply("Invalid format. Example: `$setdrop 2026-02-13 18:31 +02:00`");

      cfg.nextShieldDropISO = d.toISOString();
      saveConfig(cfg);
      lastPingedForDropISO = null;

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
      saveConfig(cfg);
      lastPingedForDropISO = null;
      return msg.reply(`✅ Cycle updated: **${cfg.cycleDays} days**`);
    }

    if (cmd === "pinghours") {
      const hours = Number(args[0]);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        return msg.reply(`Usage: \`${PREFIX}pinghours 24\` (1–168)`);
      }
      cfg.pingHoursBefore = hours;
      saveConfig(cfg);
      lastPingedForDropISO = null;
      return msg.reply(`✅ Ping offset updated: **${cfg.pingHoursBefore} hours before drop**`);
    }

    if (cmd === "pingtest") {
      try {
        if (!cfg?.targetChannelId || !cfg?.pingRoleId) {
          return msg.reply("❌ Missing TEMPLE_CHANNEL_ID / TEMPLE_PING_ROLE_ID config.");
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
  });

  client.once("ready", () => {
    if (schedulerStarted) return;
    schedulerStarted = true;

    cfg = loadConfig();
    ensureFutureDrop();

    console.log("[TEMPLE] scheduler started");
    console.log(
      `[TEMPLE] channel=${cfg.targetChannelId} role=${cfg.pingRoleId} allowedRole=${cfg.allowedRoleId ?? "none"} cycleDays=${cfg.cycleDays} pingHoursBefore=${cfg.pingHoursBefore}`
    );

    setInterval(() => {
      tickScheduler(client).catch((e) => console.error("[TEMPLE][SCHED ERROR]", e));
    }, CHECK_EVERY_MS);
  });
}
