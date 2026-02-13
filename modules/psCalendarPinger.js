// modules/psCalendarPinger.js
import fs from "fs";
import path from "path";
import {
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";

/* ================= PERSISTENT PATH (RAILWAY) ================= */

const DATA_DIR = fs.existsSync("/data") ? "/data" : path.resolve("./data");
const DATA_FILE = path.join(DATA_DIR, "psCalendarPinger.config.json");

/* ================= CONFIG ================= */

const PREFIX = "!";
const POLL_MS = 60_000;           // check every 60s
const START_GRACE_MS = 3 * 60_000; // consider "start" within last 3 minutes

/* ================= DB ================= */

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDB(db) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("[ps] ❌ Failed to save DB:", e?.message ?? e);
  }
}

function ensureGuild(db, guildId) {
  db[guildId] ??= {
    enabled: false,
    pingChannelId: null,
    pingRoleId: null,
    text: "**{event}** started!", // text AFTER role mention; supports {event}
    pinged: {}, // eventId -> pingTimestampMs
  };
}

function getGuildConfig(guildId) {
  const db = loadDB();
  ensureGuild(db, guildId);
  saveDB(db);
  return db[guildId];
}

function setGuildConfig(guildId, patch) {
  const db = loadDB();
  ensureGuild(db, guildId);
  db[guildId] = { ...db[guildId], ...patch };
  saveDB(db);
  return db[guildId];
}

function markPinged(guildId, eventId) {
  const db = loadDB();
  ensureGuild(db, guildId);
  db[guildId].pinged ??= {};
  db[guildId].pinged[eventId] = Date.now();
  saveDB(db);
}

function prunePinged(guildId, maxAgeDays = 14) {
  const db = loadDB();
  ensureGuild(db, guildId);
  const pinged = db[guildId].pinged ?? {};
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const [eid, ts] of Object.entries(pinged)) {
    if (!Number.isFinite(ts) || ts < cutoff) delete pinged[eid];
  }
  db[guildId].pinged = pinged;
  saveDB(db);
}

/* ================= HELPERS ================= */

function isGuildOwner(msg) {
  return msg.guild?.ownerId && msg.author?.id === msg.guild.ownerId;
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

function renderText(template, eventName) {
  return (template ?? "").replaceAll("{event}", eventName);
}

async function safeFetchChannel(client, channelId) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return null;
    return ch;
  } catch {
    return null;
  }
}

/* ================= CORE: FETCH + PING ================= */

async function fetchUpcomingEvents(guild) {
  // In discord.js v14: guild.scheduledEvents.fetch()
  const col = await guild.scheduledEvents.fetch();
  const events = [...col.values()];

  // Prefer only "SCHEDULED" events (not active/completed/canceled)
  // Status constants exist, but we keep it simple and rely on start time.
  const now = Date.now();
  return events
    .filter((e) => e.scheduledStartTimestamp && e.scheduledStartTimestamp > now - 7 * 86400000)
    .sort((a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0));
}

async function maybePingStarts(client, guildId) {
  const cfg = getGuildConfig(guildId);
  if (!cfg.enabled) return;
  if (!cfg.pingChannelId || !cfg.pingRoleId) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  prunePinged(guildId, 21);

  let events;
  try {
    events = await fetchUpcomingEvents(guild);
  } catch (e) {
    // missing intents or perms will show up here
    return;
  }

  const now = Date.now();

  for (const ev of events) {
    const startMs = ev.scheduledStartTimestamp;
    if (!startMs) continue;

    // "Start window": started within last grace period
    if (startMs <= now && now - startMs <= START_GRACE_MS) {
      const already = cfg.pinged?.[ev.id];
      if (already) continue;

      const channel = await safeFetchChannel(client, cfg.pingChannelId);
      if (!channel) continue;

      const mention = `<@&${cfg.pingRoleId}>`;
      const text = renderText(cfg.text, ev.name);

      await channel.send({
        content: `${mention} ${text}`,
        allowedMentions: { roles: [cfg.pingRoleId] },
      });

      markPinged(guildId, ev.id);
    }
  }
}

/* ================= MODULE ENTRY ================= */

export function setupPsCalendarPinger(client) {
  // Start polling loop
  client.once("ready", () => {
    console.log("[ps] ready | data file:", DATA_FILE);

    // Ensure defaults for current guilds
    const db = loadDB();
    for (const [gid] of client.guilds.cache) {
      ensureGuild(db, gid);
    }
    saveDB(db);

    setInterval(async () => {
      const db2 = loadDB();
      const guildIds = Object.keys(db2);

      for (const gid of guildIds) {
        // only check enabled guilds
        if (db2[gid]?.enabled) {
          try {
            await maybePingStarts(client, gid);
          } catch {
            // ignore to keep loop alive
          }
        }
      }
    }, POLL_MS);
  });

  // Commands
  client.on("messageCreate", async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content?.startsWith(`${PREFIX}ps`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1);
    const sub = (args[0] ?? "").toLowerCase();

    const help = [
      "**📅 PS Calendar Pinger Commands (Owner only)**",
      "",
      "`!ps enable`",
      "`!ps disable`",
      "`!ps ping channel #channel`",
      "`!ps ping role @role`",
      "`!ps set text <text>` (supports `{event}`)",
      "`!ps status`",
      "`!ps test ping`",
      "",
      "**Example text:** `!ps set text **{event}** started!`",
    ].join("\n");

    if (!sub || sub === "help") {
      await msg.reply(help);
      return;
    }

    // owner-only
    if (!isGuildOwner(msg)) {
      await msg.reply("Only the **server owner** can use `!ps` commands.");
      return;
    }

    // !ps enable
    if (sub === "enable") {
      const cfg = setGuildConfig(msg.guild.id, { enabled: true });
      await msg.reply(`✅ Enabled. (Channel: ${cfg.pingChannelId ? `<#${cfg.pingChannelId}>` : "not set"}, Role: ${cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : "not set"})`);
      return;
    }

    // !ps disable
    if (sub === "disable") {
      setGuildConfig(msg.guild.id, { enabled: false });
      await msg.reply("✅ Disabled. I will not check calendar events or ping.");
      return;
    }

    // !ps ping channel #channel
    if (sub === "ping" && (args[1] ?? "").toLowerCase() === "channel") {
      const channelId = parseChannelId(args[2]) ?? msg.channel.id;
      setGuildConfig(msg.guild.id, { pingChannelId: channelId });
      await msg.reply(`✅ Ping channel set to <#${channelId}>`);
      return;
    }

    // !ps ping role @role
    if (sub === "ping" && (args[1] ?? "").toLowerCase() === "role") {
      const roleId = parseRoleId(args[2]);
      if (!roleId) {
        await msg.reply("Usage: `!ps ping role @role`");
        return;
      }
      setGuildConfig(msg.guild.id, { pingRoleId: roleId });
      await msg.reply(`✅ Ping role set to <@&${roleId}>`);
      return;
    }

    // !ps set text <text...>
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "text") {
      const text = args.slice(2).join(" ").trim();
      if (!text) {
        await msg.reply("Usage: `!ps set text <text>` (supports `{event}`)");
        return;
      }
      setGuildConfig(msg.guild.id, { text });
      await msg.reply("✅ Text updated.");
      return;
    }

    // !ps status
    if (sub === "status") {
      const cfg = getGuildConfig(msg.guild.id);

      let nextLines = ["(no upcoming events found)"];
      try {
        const events = await fetchUpcomingEvents(msg.guild);
        const now = Date.now();
        const upcoming = events
          .filter((e) => e.scheduledStartTimestamp && e.scheduledStartTimestamp > now)
          .slice(0, 4);

        if (upcoming.length) {
          nextLines = upcoming.map((e, i) => {
            const unix = Math.floor((e.scheduledStartTimestamp ?? 0) / 1000);
            return `**${i + 1}.** ${e.name} — <t:${unix}:F> ( <t:${unix}:R> )`;
          });
        }
      } catch {
        nextLines = ["(cannot read scheduled events — check intents/permissions)"];
      }

      await msg.reply(
        [
          "**📅 PS Status**",
          `• Enabled: **${cfg.enabled ? "YES" : "NO"}**`,
          `• Channel: ${cfg.pingChannelId ? `<#${cfg.pingChannelId}>` : "**not set**"}`,
          `• Role: ${cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : "**not set**"}`,
          `• Text: ${cfg.text}`,
          "",
          "**Next 4 event starts:**",
          ...nextLines,
        ].join("\n")
      );
      return;
    }

    // !ps test ping
    if (sub === "test" && (args[1] ?? "").toLowerCase() === "ping") {
      const cfg = getGuildConfig(msg.guild.id);
      if (!cfg.pingChannelId || !cfg.pingRoleId) {
        await msg.reply("Set channel + role first: `!ps ping channel ...` and `!ps ping role ...`");
        return;
      }

      let events;
      try {
        events = await fetchUpcomingEvents(msg.guild);
      } catch {
        await msg.reply("Cannot read scheduled events. Check intents.");
        return;
      }

      const now = Date.now();
      const next = events.find((e) => (e.scheduledStartTimestamp ?? 0) > now);
      if (!next) {
        await msg.reply("No upcoming scheduled events found to test.");
        return;
      }

      const channel = await safeFetchChannel(client, cfg.pingChannelId);
      if (!channel) {
        await msg.reply("Cannot access ping channel.");
        return;
      }

      const mention = `<@&${cfg.pingRoleId}>`;
      const text = renderText(cfg.text, next.name);

      await channel.send({
        content: `${mention} ${text}  *(test ping for upcoming event)*`,
        allowedMentions: { roles: [cfg.pingRoleId] },
      });

      await msg.reply(`✅ Test ping sent for: **${next.name}**`);
      return;
    }

    await msg.reply(help);
  });
}
