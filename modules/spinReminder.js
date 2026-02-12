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
      pingRoleId: null, // if null => @everyone
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
  const day = now.getUTCDay(); // 0 Sun ... 5 Fri
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

  // if it's Friday and already at/after 00:00 UTC, schedule next week
  if (daysAhead === 0 && now >= target) target = new Date(target.getTime() + 7 * 86400000);

  // safety: ensure in future
  if (target <= now) target = new Date(target.getTime() + 7 * 86400000);

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

  const mention = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : "@everyone";

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
  const delay = Math.max(1000, target.getTime() - Date.now());

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
    for (const gid of Object.keys(db)) scheduleGuild(client, gid);
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

!spin status
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

    // !spin status
    if (sub === "status") {
      const cfg = getGuildConfig(msg.guild.id);
      const next = nextFridayMidnightUTC();
      const unix = Math.floor(next.getTime() / 1000);

      const ch = cfg.pingChannelId ? `<#${cfg.pingChannelId}>` : "**not set**";
      const role = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : "@everyone";

      await msg.reply(
        [
          "🎡 **Spin Status**",
          `• Channel: ${ch}`,
          `• Ping: ${role}`,
          `• Next ping: <t:${unix}:F> ( <t:${unix}:R> )`,
          `• Site: ${cfg.siteUrl}`,
          `• Button: **${cfg.buttonText}**`,
          `• Text: ${cfg.messageText}`,
        ].join("\n")
      );
      return;
    }

    // !spin show scheduled
    if (sub === "show" && (args[1] ?? "").toLowerCase() === "scheduled") {
      const dates = getNextNFridaysUTC(3);
      const lines = dates.map((d, i) => {
        const unix = Math.floor(d.getTime() / 1000);
        return `**${i + 1}.** <t:${unix}:F> (<t:${unix}:R>)`;
      });
      await msg.reply(lines.join("\n"));
      return;
    }

    // !spin test
    if (sub === "test") {
      if (!isAdmin(msg.member)) return;
      await sendSpinPing(client, msg.guild.id);
      return;
    }

    // Admin-only settings
    if (!isAdmin(msg.member)) return;

    // !spin set pingchannel #channel
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "pingchannel") {
      const channelId = parseChannelId(args[2]) ?? msg.channel.id;
      setGuildConfig(msg.guild.id, { pingChannelId: channelId });
      scheduleGuild(client, msg.guild.id);
      await msg.reply("✅ Ping channel set.");
      return;
    }

    // !spin set pingrole @role | everyone
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "pingrole") {
      const raw = (args[2] ?? "").trim();
      if (!raw) {
        await msg.reply("❌ Usage: `!spin set pingrole @Role` (or `everyone`)");
        return;
      }

      if (raw.toLowerCase() === "everyone") {
        setGuildConfig(msg.guild.id, { pingRoleId: null });
        await msg.reply("✅ Ping set to @everyone");
        return;
      }

      const roleId = parseRoleId(raw);
      if (!roleId) {
        await msg.reply("❌ Invalid role. Example: `!spin set pingrole @SpinPing`");
        return;
      }

      setGuildConfig(msg.guild.id, { pingRoleId: roleId });
      await msg.reply("✅ Ping role updated.");
      return;
    }

    // !spin site set <url>
    if (sub === "site" && (args[1] ?? "").toLowerCase() === "set") {
      const url = args[2];
      if (!looksLikeUrl(url)) {
        await msg.reply("❌ Invalid URL. Example: `!spin site set https://store.lilith.com/rok?tab=perks`");
        return;
      }
      setGuildConfig(msg.guild.id, { siteUrl: url });
      await msg.reply("✅ Site updated.");
      return;
    }

    // !spin ch text <text...>
    if (sub === "ch" && (args[1] ?? "").toLowerCase() === "text") {
      const text = args.slice(2).join(" ").trim();
      if (!text) {
        await msg.reply("❌ Usage: `!spin ch text <text>`");
        return;
      }
      setGuildConfig(msg.guild.id, { messageText: text });
      await msg.reply("✅ Text updated.");
      return;
    }

    // !spin change button text <text...>
    if (
      sub === "change" &&
      (args[1] ?? "").toLowerCase() === "button" &&
      (args[2] ?? "").toLowerCase() === "text"
    ) {
      const text = args.slice(3).join(" ").trim();
      if (!text) {
        await msg.reply("❌ Usage: `!spin change button text <text>`");
        return;
      }
      setGuildConfig(msg.guild.id, { buttonText: text });
      await msg.reply("✅ Button text updated.");
      return;
    }
  });
}
