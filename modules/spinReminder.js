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

function ensureDefaults(db, guildId) {
  if (!db[guildId]) {
    db[guildId] = {
      pingChannelId: null,
      pingRoleId: null, // ✅ NEW
      siteUrl: "https://store.lilith.com/rok",
      messageText: "Prize draws refreshed!🎡➡️🎁",
      buttonText: "Spin now!",
    };
  }
}

function getGuildConfig(guildId) {
  const db = loadDB();
  ensureDefaults(db, guildId);
  saveDB(db);
  return db[guildId];
}

function setGuildConfig(guildId, patch) {
  const db = loadDB();
  ensureDefaults(db, guildId);
  db[guildId] = { ...db[guildId], ...patch };
  saveDB(db);
  return db[guildId];
}

/* ================= SCHEDULING ================= */

function nextFridayMidnightUTC(fromDate = new Date()) {
  const now = new Date(fromDate);
  const day = now.getUTCDay();
  const targetDay = 5;

  const todayMidnightUTC = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  let daysAhead = (targetDay - day + 7) % 7;
  let target = new Date(todayMidnightUTC.getTime() + daysAhead * 86400000);

  if (daysAhead === 0 && now >= target) {
    target = new Date(target.getTime() + 7 * 86400000);
  }

  if (target <= now) {
    target = new Date(target.getTime() + 7 * 86400000);
  }

  return target;
}

function getNextNFridaysUTC(n = 3) {
  const out = [];
  let base = new Date();

  for (let i = 0; i < n; i++) {
    const next = nextFridayMidnightUTC(base);
    out.push(next);
    base = new Date(next.getTime() + 1000);
  }

  return out;
}

async function sendSpinPing(client, guildId) {
  const cfg = getGuildConfig(guildId);
  if (!cfg.pingChannelId) return;

  let channel;
  try {
    channel = await client.channels.fetch(cfg.pingChannelId);
  } catch {
    return;
  }
  if (!channel?.isTextBased()) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(cfg.buttonText)
      .setURL(cfg.siteUrl)
  );

  const mention = cfg.pingRoleId
    ? `<@&${cfg.pingRoleId}>`
    : "@everyone";

  await channel.send({
    content: `${mention} ${cfg.messageText}`,
    components: [row],
    allowedMentions: cfg.pingRoleId
      ? { roles: [cfg.pingRoleId] }
      : { parse: ["everyone"] },
  });
}

function scheduleGuild(client, guildId) {
  const old = timers.get(guildId);
  if (old) clearTimeout(old);

  const cfg = getGuildConfig(guildId);
  if (!cfg.pingChannelId) return;

  const target = nextFridayMidnightUTC();
  const delay = Math.max(1000, target - Date.now());

  const t = setTimeout(async () => {
    try {
      await sendSpinPing(client, guildId);
    } finally {
      scheduleGuild(client, guildId);
    }
  }, delay);

  timers.set(guildId, t);
}

/* ================= HELPERS ================= */

function isAdmin(member) {
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

function parseRoleId(token) {
  if (!token) return null;
  const m = token.match(/^<@&(\d+)>$/);
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

/* ================= MODULE ================= */

export function setupSpinReminder(client) {
  client.once("ready", () => {
    const db = loadDB();
    for (const gid of Object.keys(db)) {
      scheduleGuild(client, gid);
    }
    console.log("[spinReminder] ready");
  });

  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(`${PREFIX}spin`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1);
    const sub = (args[0] ?? "").toLowerCase();

    if (!sub || sub === "help") {
      await msg.reply(
`🎡 Spin Commands

!spin show scheduled
!spin test
!spin set pingchannel #channel
!spin set pingrole @role
!spin site set <url>
!spin ch text <text>
!spin change button text <text>`
      );
      return;
    }

    if (sub === "show" && args[1] === "scheduled") {
      const dates = getNextNFridaysUTC(3);
      const lines = dates.map((d, i) => {
        const unix = Math.floor(d / 1000);
        return `**${i + 1}.** <t:${unix}:F> (<t:${unix}:R>)`;
      });
      await msg.reply(lines.join("\n"));
      return;
    }

    if (sub === "test") {
      if (!isAdmin(msg.member)) return;
      await sendSpinPing(client, msg.guild.id);
      return;
    }

    if (!isAdmin(msg.member)) return;

    if (sub === "set" && args[1] === "pingchannel") {
      const channelId = parseChannelId(args[2]) ?? msg.channel.id;
      setGuildConfig(msg.guild.id, { pingChannelId: channelId });
      scheduleGuild(client, msg.guild.id);
      await msg.reply("✅ Ping channel set.");
      return;
    }

    if (sub === "set" && args[1] === "pingrole") {
      const raw = args[2];
      if (!raw) return;

      if (raw.toLowerCase() === "everyone") {
        setGuildConfig(msg.guild.id, { pingRoleId: null });
        await msg.reply("✅ Ping set to @everyone");
        return;
      }

      const roleId = parseRoleId(raw);
      if (!roleId) return;

      setGuildConfig(msg.guild.id, { pingRoleId: roleId });
      await msg.reply("✅ Ping role updated.");
      return;
    }

    if (sub === "site" && args[1] === "set") {
      const url = args[2];
      if (!looksLikeUrl(url)) return;
      setGuildConfig(msg.guild.id, { siteUrl: url });
      await msg.reply("✅ Site updated.");
      return;
    }

    if (sub === "ch" && args[1] === "text") {
      const text = args.slice(2).join(" ");
      if (!text) return;
      setGuildConfig(msg.guild.id, { messageText: text });
      await msg.reply("✅ Text updated.");
      return;
    }

    if (sub === "change" && args[1] === "button" && args[2] === "text") {
      const text = args.slice(3).join(" ");
      if (!text) return;
      setGuildConfig(msg.guild.id, { buttonText: text });
      await msg.reply("✅ Button text updated.");
      return;
    }
  });
}
