// modules/spinReminder.js
import fs from "fs";
import path from "path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";

/* ================= CONFIG STORAGE ================= */

const PREFIX = "!";
const DATA_FILE = path.resolve("./modules/spinReminder.config.json");

// guildId -> timeout
const timers = new Map();

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function ensureDefaults(guildId, db) {
  db[guildId] ??= {
    pingChannelId: null,
    siteUrl: "https://store.lilith.com/rok",
    messageText: "Prize draws refreshed!🎡➡️🎁",
    buttonText: "Spin now!",
  };
}

function getGuildConfig(guildId) {
  const db = loadDB();
  ensureDefaults(guildId, db);
  saveDB(db);
  return db[guildId];
}

function setGuildConfig(guildId, patch) {
  const db = loadDB();
  ensureDefaults(guildId, db);
  db[guildId] = { ...db[guildId], ...patch };
  saveDB(db);
  return db[guildId];
}

/* ================= SCHEDULING (FRI 00:00 UTC) ================= */

function nextFridayMidnightUTC(fromDate = new Date()) {
  const now = new Date(fromDate);
  const day = now.getUTCDay(); // 0=Sun ... 5=Fri
  const targetDay = 5; // Friday

  const todayMidnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );

  let daysAhead = (targetDay - day + 7) % 7;
  let target = new Date(todayMidnightUTC.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  // if today is Friday and we've already reached/passed 00:00 UTC, schedule next week
  if (daysAhead === 0 && now.getTime() >= target.getTime()) {
    target = new Date(target.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  return target;
}

function getNextNFridaysUTC(n = 3) {
  const results = [];
  let base = new Date();

  for (let i = 0; i < n; i++) {
    const next = nextFridayMidnightUTC(base);
    results.push(next);
    base = new Date(next.getTime() + 1000); // +1s so next call moves forward
  }

  return results;
}

async function sendSpinPing(client, guildId, reason = "scheduled") {
  const cfg = getGuildConfig(guildId);
  if (!cfg.pingChannelId) return;

  let channel = null;
  try {
    channel = await client.channels.fetch(cfg.pingChannelId);
  } catch {
    return;
  }
  if (!channel || !channel.isTextBased()) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(cfg.buttonText || "Spin now!")
      .setURL(cfg.siteUrl || "https://store.lilith.com/rok")
  );

  const text = (cfg.messageText ?? "Prize draws refreshed!🎡➡️🎁").trim();
  const content = `@everyone ${text}`;

  await channel.send({
    content,
    components: [row],
    allowedMentions: { parse: ["everyone"] }, // real @everyone ping
  });
}

function scheduleGuild(client, guildId) {
  const old = timers.get(guildId);
  if (old) clearTimeout(old);

  const cfg = getGuildConfig(guildId);
  if (!cfg.pingChannelId) {
    timers.delete(guildId);
    return;
  }

  const target = nextFridayMidnightUTC(new Date());
  const delay = Math.max(1_000, target.getTime() - Date.now());

  const t = setTimeout(async () => {
    try {
      await sendSpinPing(client, guildId, "scheduled");
    } catch (e) {
      console.error(`[spinReminder] send failed for guild ${guildId}:`, e?.message ?? e);
    } finally {
      scheduleGuild(client, guildId); // reschedule next week
    }
  }, delay);

  timers.set(guildId, t);
}

/* ================= COMMAND HELPERS ================= */

function isAdminOrManageGuild(member) {
  return (
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

function parseChannelId(token) {
  if (!token) return null;
  const m = token.match(/^<#(\d+)>$/);
  if (m) return m[1];
  if (/^\d{16,20}$/.test(token)) return token;
  return null;
}

function looksLikeUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/* ================= MODULE ENTRY ================= */

export function setupSpinReminder(client) {
  client.once("ready", async () => {
    // schedule for all stored guilds
    const db = loadDB();
    for (const gid of Object.keys(db)) scheduleGuild(client, gid);

    // ensure defaults for current guilds
    for (const [gid] of client.guilds.cache) getGuildConfig(gid);

    console.log("[spinReminder] module ready");
  });

  client.on("guildCreate", (guild) => {
    getGuildConfig(guild.id);
  });

  client.on("messageCreate", async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content?.startsWith(`${PREFIX}spin`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1); // after "!spin"
    const sub = (args[0] ?? "").toLowerCase();

    const helpText = [
      "**🎡 Spin Reminder Commands**",
      "",
      "`!spin help`",
      "`!spin show scheduled`  → shows next 3 scheduled pings`",
      "`!spin test`  → sends a REAL @everyone ping + button`",
      "`!spin set pingchannel #channel`",
      "`!spin site set <url>`",
      "`!spin ch text <text...>`",
      "`!spin change button text <text...>`",
      "",
      "**Defaults**",
      "- Site: https://store.lilith.com/rok",
      "- Text: Prize draws refreshed!🎡➡️🎁",
      "- Button: Spin now!",
      "",
      "**Schedule:** every Friday 00:00 (UTC+0)",
    ].join("\n");

    if (!sub || sub === "help") {
      await msg.reply(helpText);
      return;
    }

    // !spin show scheduled
    if (sub === "show" && (args[1] ?? "").toLowerCase() === "scheduled") {
      const nextDates = getNextNFridaysUTC(3);
      const lines = nextDates.map((d, i) => {
        const unix = Math.floor(d.getTime() / 1000);
        return `**${i + 1}.** <t:${unix}:F>  ( <t:${unix}:R> )`;
      });

      await msg.reply(
        ["🎡 **Next Spin Refreshes (UTC+0)**", "", ...lines].join("\n")
      );
      return;
    }

    // !spin test
    if (sub === "test") {
      if (!isAdminOrManageGuild(msg.member)) {
        await msg.reply("You need **Manage Server** (or Admin) to use `!spin test`.");
        return;
      }
      const cfg = getGuildConfig(msg.guild.id);
      if (!cfg.pingChannelId) {
        await msg.reply("Set a ping channel first: `!spin set pingchannel #channel`");
        return;
      }
      try {
        await sendSpinPing(client, msg.guild.id, "test");
        await msg.reply("✅ Sent the spin ping (real @everyone).");
      } catch {
        await msg.reply("❌ Failed to send. Check bot permissions in the ping channel.");
      }
      return;
    }

    // Settings (admin only)
    if (!isAdminOrManageGuild(msg.member)) {
      await msg.reply("You need **Manage Server** (or Admin) to change spin settings.");
      return;
    }

    // !spin set pingchannel #channel
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "pingchannel") {
      const channelId = parseChannelId(args[2]) ?? msg.channel.id; // fallback current channel
      const cfg = setGuildConfig(msg.guild.id, { pingChannelId: channelId });
      scheduleGuild(client, msg.guild.id);
      await msg.reply(
        `✅ Ping channel set to <#${cfg.pingChannelId}>.\nScheduled for **Friday 00:00 UTC**.`
      );
      return;
    }

    // !spin site set <url>
    if (sub === "site" && (args[1] ?? "").toLowerCase() === "set") {
      const url = args[2];
      if (!url || !looksLikeUrl(url)) {
        await msg.reply(
