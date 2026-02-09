// temple/templePinger.js
import { Partials } from "discord.js";
import { loadConfig, saveConfig } from "./storage.js"; // adjust path if needed

const PREFIX = "$";
const CHECK_EVERY_MS = 30 * 1000; // 30s checks

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
        console.error("[TEMPLE PING ERROR]", e);
      }
    }
  }
}

function statusText() {
  if (!cfg?.nextShieldDropISO) {
    return `No shield drop set.\nUse: \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\`\nExample: \`${PREFIX}setdrop 2026-02-13 18:31 +02:00\``;
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

/**
 * ✅ Call this ONCE from your main bot file after client is created.
 */
export function setupTemplePinger(client) {
  // Load config once
  cfg = loadConfig();
  ensureFutureDrop();

  // COMMANDS (keeps your same $ commands)
  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() ?? "").toLowerCase();

    if (cmd === "help") {
      return msg.reply({
        content:
          `**Commands**\n` +
          `• \`${PREFIX}help\`\n` +
          `• \`${PREFIX}status\` — shows shield/drop/reshield/ping times\n` +
          `• \`${PREFIX}setdrop YYYY-MM-DD HH:MM TZ\` — set next shield drop\n` +
          `   Example: \`${PREFIX}setdrop 2026-02-13 18:31 +02:00\`\n` +
          `• \`${PREFIX}cycle <days>\` — set repeat cycle (6/7/etc)\n` +
          `• \`${PREFIX}pinghours <hours>\` — set ping offset (default 24)\n` +
          `• \`${PREFIX}pingtest\` — sends a test ping in the channel`,
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

  // START SCHEDULER ONCE (even if you reload modules)
  client.once("ready", () => {
    if (schedulerStarted) return;
    schedulerStarted = true;

    cfg = loadConfig();
    ensureFutureDrop();

    console.log("[TEMPLE] module loaded");
    console.log(`[TEMPLE] channel=${cfg.targetChannelId} role=${cfg.pingRoleId} cycleDays=${cfg.cycleDays} pingHoursBefore=${cfg.pingHoursBefore}`);

    setInterval(() => {
      tickScheduler(client).catch((e) => console.error("[TEMPLE SCHED ERROR]", e));
    }, CHECK_EVERY_MS);
  });
}

