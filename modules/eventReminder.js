// modules/eventReminder.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from "discord.js";

/* ================= PERSISTENT PATH (RAILWAY) ================= */

const DATA_DIR = fs.existsSync("/data") ? "/data" : path.resolve("./data");
const DATA_FILE = path.join(DATA_DIR, "eventReminder.config.json");

const PREFIX = "!";
const WIZARD_TTL_MS = 10 * 60 * 1000; // 10 min to finish wizard

// guildId -> { reminderId -> { t60, t10 } }
const timers = new Map();
// wizardKey = `${guildId}:${userId}` -> session
const wizards = new Map();

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
    console.error("[eventReminder] ❌ Failed to save DB at:", DATA_FILE);
    console.error("[eventReminder] ❌ Error:", e?.message ?? e);
  }
}

function ensureGuild(db, guildId) {
  db[guildId] ??= {
    pingChannelId: null,
    pingRoleId: null,
    adminRoleId: null, // role that can manage module (besides owner)
    ch1Text: "{event} in 1 hour!",
    ch10Text: "{event} in 10 min! Be ready!",
    events: [
      "Silk road",
      "Shadow Legion",
      "Alliance Mobilization",
      "Karuak Boss",
    ],
    reminders: [], // { id, eventName, timeUtcIso, createdBy, createdAtIso }
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

function addReminder(guildId, reminder) {
  const db = loadDB();
  ensureGuild(db, guildId);
  db[guildId].reminders.push(reminder);
  saveDB(db);
}

function removeReminder(guildId, reminderId) {
  const db = loadDB();
  ensureGuild(db, guildId);
  db[guildId].reminders = db[guildId].reminders.filter((r) => r.id !== reminderId);
  saveDB(db);
}

/* ================= PERMS ================= */

function isGuildOwner(msg) {
  return msg.guild?.ownerId && msg.author?.id === msg.guild.ownerId;
}

function hasAdminAccess(msg) {
  const cfg = getGuildConfig(msg.guild.id);
  if (isGuildOwner(msg)) return true;
  if (!cfg.adminRoleId) return false;
  return msg.member?.roles?.cache?.has(cfg.adminRoleId) ?? false;
}

/* ================= TIME HELPERS (UTC) ================= */

// Build YYYY-MM-DD list: today + 13 days
function getNext14DatesUTC() {
  const out = [];
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  for (let i = 0; i < 14; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

function buildUtcIso(dateYYYYMMDD, hour00to23) {
  // date at HH:00:00 UTC
  return `${dateYYYYMMDD}T${String(hour00to23).padStart(2, "0")}:00:00.000Z`;
}

function toUnixSeconds(dateObj) {
  return Math.floor(dateObj.getTime() / 1000);
}

function renderTemplate(template, eventName) {
  return (template ?? "").replaceAll("{event}", eventName);
}

/* ================= SCHEDULING ================= */

async function sendReminderPing(client, guildId, reminder, which) {
  const cfg = getGuildConfig(guildId);
  if (!cfg.pingChannelId || !cfg.pingRoleId) return;

  let channel;
  try {
    channel = await client.channels.fetch(cfg.pingChannelId);
  } catch {
    return;
  }
  if (!channel?.isTextBased()) return;

  const mention = `<@&${cfg.pingRoleId}>`;
  const text =
    which === "60"
      ? renderTemplate(cfg.ch1Text, reminder.eventName)
      : renderTemplate(cfg.ch10Text, reminder.eventName);

  await channel.send({
    content: `${mention} ${text}`,
    allowedMentions: { roles: [cfg.pingRoleId] },
  });
}

function clearReminderTimers(guildId, reminderId) {
  const g = timers.get(guildId);
  if (!g) return;
  const entry = g.get(reminderId);
  if (!entry) return;
  if (entry.t60) clearTimeout(entry.t60);
  if (entry.t10) clearTimeout(entry.t10);
  g.delete(reminderId);
}

function scheduleReminder(client, guildId, reminder) {
  // clear any existing timers for this reminder
  if (!timers.has(guildId)) timers.set(guildId, new Map());
  clearReminderTimers(guildId, reminder.id);

  const eventTime = new Date(reminder.timeUtcIso);
  if (Number.isNaN(eventTime.getTime())) return;

  const now = Date.now();

  const t60At = eventTime.getTime() - 60 * 60 * 1000;
  const t10At = eventTime.getTime() - 10 * 60 * 1000;

  const g = timers.get(guildId);

  const entry = { t60: null, t10: null };
  g.set(reminder.id, entry);

  // schedule 60m ping if in future
  if (t60At > now) {
    entry.t60 = setTimeout(async () => {
      try {
        await sendReminderPing(client, guildId, reminder, "60");
      } catch (e) {
        console.error("[eventReminder] 60m ping failed:", e?.message ?? e);
      }
    }, t60At - now);
  }

  // schedule 10m ping if in future
  if (t10At > now) {
    entry.t10 = setTimeout(async () => {
      try {
        await sendReminderPing(client, guildId, reminder, "10");
      } catch (e) {
        console.error("[eventReminder] 10m ping failed:", e?.message ?? e);
      } finally {
        // delete after 10m ping
        removeReminder(guildId, reminder.id);
        clearReminderTimers(guildId, reminder.id);
      }
    }, t10At - now);
  } else {
    // if 10m already passed, delete immediately
    removeReminder(guildId, reminder.id);
    clearReminderTimers(guildId, reminder.id);
  }
}

function scheduleAllFromDB(client) {
  const db = loadDB();
  for (const guildId of Object.keys(db)) {
    ensureGuild(db, guildId);
    for (const r of db[guildId].reminders ?? []) {
      scheduleReminder(client, guildId, r);
    }
  }
}

/* ================= WIZARD UI ================= */

function wizardKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function startWizard(guildId, userId) {
  const key = wizardKey(guildId, userId);
  const expiresAt = Date.now() + WIZARD_TTL_MS;
  wizards.set(key, {
    guildId,
    userId,
    step: "date",
    date: null,
    hour: null,
    eventName: null,
    expiresAt,
  });
  setTimeout(() => {
    const cur = wizards.get(key);
    if (cur && cur.expiresAt <= Date.now()) wizards.delete(key);
  }, WIZARD_TTL_MS + 1000);
  return wizards.get(key);
}

function getWizard(guildId, userId) {
  const key = wizardKey(guildId, userId);
  const w = wizards.get(key);
  if (!w) return null;
  if (w.expiresAt <= Date.now()) {
    wizards.delete(key);
    return null;
  }
  return w;
}

function makeDateMenu(guildId, userId) {
  const dates = getNext14DatesUTC();
  const options = dates.map((d) => ({ label: d, value: d }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`eventwiz:date:${guildId}:${userId}`)
      .setPlaceholder("Select date (UTC)")
      .addOptions(options)
  );
}

function makeHourMenu(guildId, userId) {
  const options = Array.from({ length: 24 }, (_, i) => {
    const hh = String(i).padStart(2, "0");
    return { label: `${hh}:00 UTC`, value: String(i) };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`eventwiz:hour:${guildId}:${userId}`)
      .setPlaceholder("Select hour (UTC)")
      .addOptions(options)
  );
}

function makeEventMenu(guildId, userId, events) {
  const safe = (events ?? []).slice(0, 25); // discord max options 25
  const options = safe.map((name) => ({ label: name, value: name }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`eventwiz:event:${guildId}:${userId}`)
      .setPlaceholder("Select event")
      .addOptions(options)
  );
}

/* ================= COMMANDS ================= */

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

/* ================= MODULE ENTRY ================= */

export function setupEventReminder(client) {
  client.once("ready", () => {
    console.log("[eventReminder] data file:", DATA_FILE);
    scheduleAllFromDB(client);
    console.log("[eventReminder] ready");
  });

  // Handle dropdown interactions
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isStringSelectMenu()) return;

      const id = interaction.customId ?? "";
      if (!id.startsWith("eventwiz:")) return;

      // customId = eventwiz:<step>:<guildId>:<userId>
      const parts = id.split(":");
      const step = parts[1];
      const guildId = parts[2];
      const userId = parts[3];

      if (!interaction.guildId || interaction.guildId !== guildId) {
        await interaction.reply({ content: "Wrong server.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: "This menu is not for you.", ephemeral: true });
        return;
      }

      // Permission gate (same as command gate)
      const fakeMsg = { guild: interaction.guild, author: interaction.user, member: interaction.member };
      if (!hasAdminAccess(fakeMsg)) {
        await interaction.reply({ content: "Only the server owner / event admin role can do this.", ephemeral: true });
        return;
      }

      const w = getWizard(guildId, userId);
      if (!w) {
        await interaction.reply({ content: "Wizard expired. Run `!event set reminder` again.", ephemeral: true });
        return;
      }

      const value = interaction.values?.[0];

      if (step === "date") {
        w.date = value;
        w.step = "hour";
        const row = makeHourMenu(guildId, userId);
        await interaction.update({
          content: `✅ Date selected: **${w.date}** (UTC)\nNow pick the **hour (UTC)**:`,
          components: [row],
        });
        return;
      }

      if (step === "hour") {
        w.hour = Number(value);
        w.step = "event";
        const cfg = getGuildConfig(guildId);
        const row = makeEventMenu(guildId, userId, cfg.events);
        await interaction.update({
          content: `✅ Date: **${w.date}**\n✅ Hour: **${String(w.hour).padStart(2, "0")}:00 UTC**\nNow pick the **event**:`,
          components: [row],
        });
        return;
      }

      if (step === "event") {
        w.eventName = value;

        const iso = buildUtcIso(w.date, w.hour);
        const reminder = {
          id: crypto.randomUUID(),
          eventName: w.eventName,
          timeUtcIso: iso,
          createdBy: userId,
          createdAtIso: new Date().toISOString(),
        };

        addReminder(guildId, reminder);
        scheduleReminder(client, guildId, reminder);

        // close wizard
        wizards.delete(wizardKey(guildId, userId));

        const eventTime = new Date(iso);
        const tUnix = toUnixSeconds(eventTime);
        const t60Unix = Math.floor((eventTime.getTime() - 60 * 60 * 1000) / 1000);
        const t10Unix = Math.floor((eventTime.getTime() - 10 * 60 * 1000) / 1000);

        await interaction.update({
          content:
            `🏆 **Reminder set!**\n` +
            `• Event: **${reminder.eventName}**\n` +
            `• Event time: <t:${tUnix}:F>\n` +
            `• 1 hour ping: <t:${t60Unix}:F>\n` +
            `• 10 min ping: <t:${t10Unix}:F>`,
          components: [],
        });
        return;
      }
    } catch (e) {
      console.error("[eventReminder] interaction error:", e?.message ?? e);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: "Something went wrong.", ephemeral: true });
        } catch {}
      }
    }
  });

  // Prefix commands
  client.on("messageCreate", async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content?.startsWith(`${PREFIX}event`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1);
    const sub = (args[0] ?? "").toLowerCase();

    const help = [
      "**📅 Event Reminder Commands**",
      "",
      "`!event help`",
      "`!event set reminder` (dropdown wizard)",
      "`!event scheduled` (or `!event sheduled`)",
      "`!event testping`",
      "`!event set role @role`",
      "`!event set channel #channel`",
      "`!event ch1 text <text>` (use {event})",
      "`!event ch10 text <text>` (use {event})",
      "`!event set admin role @role`",
      "`!event add <event name>`",
      "",
      "**Defaults:**",
      "- ch1: `{event} in 1 hour!`",
      "- ch10: `{event} in 10 min! Be ready!`",
    ].join("\n");

    if (!sub || sub === "help") {
      await msg.reply(help);
      return;
    }

    // permissions: owner or admin role
    if (!hasAdminAccess(msg)) {
      await msg.reply("Only the **server owner** (or the configured **event admin role**) can use these commands.");
      return;
    }

    // !event set reminder
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "reminder") {
      const cfg = getGuildConfig(msg.guild.id);
      if (!cfg.pingChannelId) {
        await msg.reply("Set a channel first: `!event set channel #channel`");
        return;
      }
      if (!cfg.pingRoleId) {
        await msg.reply("Set a role first: `!event set role @role`");
        return;
      }

      startWizard(msg.guild.id, msg.author.id);
      const row = makeDateMenu(msg.guild.id, msg.author.id);

      await msg.reply({
        content: "Select the **date (UTC)** for the reminder:",
        components: [row],
      });
      return;
    }

    // !event scheduled / sheduled
    if (sub === "scheduled" || sub === "sheduled") {
      const cfg = getGuildConfig(msg.guild.id);
      const list = cfg.reminders ?? [];

      if (list.length === 0) {
        await msg.reply("No reminders set.");
        return;
      }

      // sort by event time
      const sorted = [...list].sort((a, b) => new Date(a.timeUtcIso) - new Date(b.timeUtcIso));

      const lines = sorted.map((r) => {
        const eventTime = new Date(r.timeUtcIso);
        const tUnix = toUnixSeconds(eventTime);
        const t60Unix = Math.floor((eventTime.getTime() - 60 * 60 * 1000) / 1000);
        const t10Unix = Math.floor((eventTime.getTime() - 10 * 60 * 1000) / 1000);
        return `• **${r.eventName}** — Event: <t:${tUnix}:F> | 1h: <t:${t60Unix}:F> | 10m: <t:${t10Unix}:F>`;
      });

      const header = `📌 **Scheduled reminders (${lines.length})**`;
      await msg.reply([header, ...lines].join("\n"));
      return;
    }

    // !event set role @role
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "role") {
      const roleId = parseRoleId(args[2]);
      if (!roleId) {
        await msg.reply("Usage: `!event set role @role`");
        return;
      }
      setGuildConfig(msg.guild.id, { pingRoleId: roleId });
      await msg.reply("✅ Ping role set.");
      return;
    }

    // !event set channel #channel
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "channel") {
      const channelId = parseChannelId(args[2]) ?? msg.channel.id;
      setGuildConfig(msg.guild.id, { pingChannelId: channelId });
      await msg.reply("✅ Ping channel set.");
      return;
    }

    // !event set admin role @role
    if (sub === "set" && (args[1] ?? "").toLowerCase() === "admin" && (args[2] ?? "").toLowerCase() === "role") {
      // only owner can set admin role
      if (!isGuildOwner(msg)) {
        await msg.reply("Only the **server owner** can set the admin role.");
        return;
      }
      const roleId = parseRoleId(args[3]);
      if (!roleId) {
        await msg.reply("Usage: `!event set admin role @role`");
        return;
      }
      setGuildConfig(msg.guild.id, { adminRoleId: roleId });
      await msg.reply("✅ Event admin role set.");
      return;
    }

    // !event add <event name>
    if (sub === "add") {
      const name = args.slice(1).join(" ").trim();
      if (!name) {
        await msg.reply("Usage: `!event add <event name>`");
        return;
      }
      const cfg = getGuildConfig(msg.guild.id);
      if (cfg.events.includes(name)) {
        await msg.reply("That event already exists.");
        return;
      }
      cfg.events.push(name);
      setGuildConfig(msg.guild.id, { events: cfg.events });
      await msg.reply(`✅ Added event: **${name}**`);
      return;
    }

    // !event ch1 text <text>
    if (sub === "ch1" && (args[1] ?? "").toLowerCase() === "text") {
      const text = args.slice(2).join(" ").trim();
      if (!text) {
        await msg.reply("Usage: `!event ch1 text <text>` (use `{event}` placeholder)");
        return;
      }
      setGuildConfig(msg.guild.id, { ch1Text: text });
      await msg.reply("✅ 1-hour text updated.");
      return;
    }

    // !event ch10 text <text>
    if (sub === "ch10" && (args[1] ?? "").toLowerCase() === "text") {
      const text = args.slice(2).join(" ").trim();
      if (!text) {
        await msg.reply("Usage: `!event ch10 text <text>` (use `{event}` placeholder)");
        return;
      }
      setGuildConfig(msg.guild.id, { ch10Text: text });
      await msg.reply("✅ 10-min text updated.");
      return;
    }

    // !event testping (sends two pings: 30m + 10m style)
    if (sub === "testping") {
      const cfg = getGuildConfig(msg.guild.id);
      if (!cfg.pingChannelId || !cfg.pingRoleId) {
        await msg.reply("Set channel + role first: `!event set channel ...` and `!event set role ...`");
        return;
      }

      let channel;
      try {
        channel = await msg.client.channels.fetch(cfg.pingChannelId);
      } catch {
        await msg.reply("Cannot access ping channel.");
        return;
      }
      if (!channel?.isTextBased()) {
        await msg.reply("Ping channel is not text-based.");
        return;
      }

      const mention = `<@&${cfg.pingRoleId}>`;

      // 30 min test message (does not create reminder, does not delete anything)
      const thirtyText = renderTemplate("{event} in 30 min!", "TEST EVENT");
      const tenText = renderTemplate(cfg.ch10Text, "TEST EVENT");

      await channel.send({
        content: `${mention} ${thirtyText}`,
        allowedMentions: { roles: [cfg.pingRoleId] },
      });
      await channel.send({
        content: `${mention} ${tenText}`,
        allowedMentions: { roles: [cfg.pingRoleId] },
      });

      await msg.reply("✅ Test ping sent (30 min + 10 min style).");
      return;
    }

    await msg.reply(help);
  });
}
