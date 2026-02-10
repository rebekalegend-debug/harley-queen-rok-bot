// modules/aoomge.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events,
  ChannelType,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ================= CONFIG ================= */

const PREFIX = "!";
const ICS_URL =
  "https://calendar.google.com/calendar/ical/5589780017d3612c518e01669b77b70f667a6cee4798c961dbfb9cf1119811f3%40group.calendar.google.com/public/basic.ics";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, "aoomge.config.json");

/* ================= STORAGE ================= */

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function getGuildCfg(guildId) {
  const cfg = loadConfig();
  cfg[guildId] ??= {
    pingChannelId: null,
    adminRoleId: null,
  };
  saveConfig(cfg);
  return cfg[guildId];
}
function setGuildCfg(guildId, patch) {
  const cfg = loadConfig();
  cfg[guildId] ??= { pingChannelId: null, adminRoleId: null };
  cfg[guildId] = { ...cfg[guildId], ...patch };
  saveConfig(cfg);
  return cfg[guildId];
}

/* ================= STATE ================= */

// schedulesByGuild: guildId -> { items: [{ startMs, oneHourMs, tenMinMs }], timeouts: [Timeout,...] }
const schedulesByGuild = new Map();

// selectionByUser: `${guildId}:${userId}` -> selectedDayMs
const selectionByUser = new Map();

/* ================= HELPERS ================= */

function isOwnerOrAdmin(msgOrInteraction) {
  const guild = msgOrInteraction.guild;
  const member = msgOrInteraction.member;
  if (!guild || !member) return false;

  // Owner bypass
  if (guild.ownerId && member.id === guild.ownerId) return true;

  const g = getGuildCfg(guild.id);
  if (!g.adminRoleId) return false;

  return member.roles?.cache?.has?.(g.adminRoleId) ?? false;
}

function formatUTC(ms) {
  return new Date(ms).toUTCString();
}

async function resolvePingChannel(client, guildId) {
  const g = getGuildCfg(guildId);
  if (!g.pingChannelId) return null;

  const ch = await client.channels.fetch(g.pingChannelId).catch(() => null);
  if (!ch) return null;
  if (!ch.isTextBased?.()) return null;
  return ch;
}

async function getNextArkBattleDays() {
  const data = await ical.async.fromURL(ICS_URL);
  const now = new Date();

  const arkEvent = Object.values(data)
    .filter((e) => {
      if (e?.type !== "VEVENT") return false;
      if (!e.summary || !e.start) return false;

      const name = String(e.summary).toLowerCase();
      const isArk =
        name.includes("ark of osiris") ||
        (name.includes("ark") && name.includes("battle"));

      return isArk && e.start > now;
    })
    .sort((a, b) => a.start - b.start)[0]; // ONLY NEXT ARK

  if (!arkEvent) return null;

  const day1 = new Date(arkEvent.start);
  const day2 = new Date(arkEvent.start.getTime() + 24 * 60 * 60 * 1000);

  return [day1, day2];
}

function clearGuildSchedules(guildId) {
  const s = schedulesByGuild.get(guildId);
  if (!s) return;

  for (const t of s.timeouts) clearTimeout(t);
  schedulesByGuild.delete(guildId);
}

function ensureGuildSchedule(guildId) {
  if (!schedulesByGuild.has(guildId)) {
    schedulesByGuild.set(guildId, { items: [], timeouts: [] });
  }
  return schedulesByGuild.get(guildId);
}

function scheduleTwoReminders(guildId, channel, startMs) {
  // overwrite all AOO schedules (your previous behavior)
  clearGuildSchedules(guildId);

  const oneHourMs = startMs - 60 * 60 * 1000;
  const tenMinMs = startMs - 10 * 60 * 1000;

  const s = ensureGuildSchedule(guildId);

  function setReminder(atMs, text) {
    const delay = atMs - Date.now();
    if (delay <= 0) return null;

    // Node timers get weird beyond ~24.8 days; this is a simple guard.
    // If you schedule very far ahead, re-run !aoo closer to the event.
    const MAX_DELAY = 2_147_483_647; // ~24.8 days
    if (delay > MAX_DELAY) return null;

    const to = setTimeout(async () => {
      await channel.send(text).catch(() => {});
    }, delay);

    s.timeouts.push(to);
    return to;
  }

  setReminder(
    oneHourMs,
    `@everyone ⏰ **ARK OF OSIRIS STARTING!**\n🕐 Starts in **1 hour**\n🗓️ ${formatUTC(startMs)}`
  );
  setReminder(
    tenMinMs,
    `@everyone ⏰ **ARK OF OSIRIS STARTING!**\n🕙 Starts in **10 minutes**\n🗓️ ${formatUTC(startMs)}`
  );

  s.items.push({ startMs, oneHourMs, tenMinMs });
}

function buildHelp() {
  return (
    "**🛡️ AOO Commands**\n" +
    `\`${PREFIX}aoo\` → open AOO dropdown (admin/owner only)\n` +
    `\`${PREFIX}aoo set channel #channel\` → set ping channel\n` +
    `\`${PREFIX}aoo set admin @role\` → set admin role for ALL commands\n` +
    `\`${PREFIX}aoo scheduled\` → show scheduled AOO pings\n` +
    `\`${PREFIX}aoo test\` → test ping now in ping channel\n` +
    `\`${PREFIX}aoo clear\` → clear all scheduled AOO pings\n` +
    `\`${PREFIX}aoo help\` → show this help`
  );
}

/* ================= MAIN ================= */

export function setupAooMge(client) {
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content.startsWith(`${PREFIX}aoo`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1);

    // Restrict ALL commands to owner/admin (except we still allow help text to show, but action blocked)
    const authed = isOwnerOrAdmin(msg);

    // !aoo help
    if (args[0] === "help") {
      await msg.reply(buildHelp());
      return;
    }

    if (!authed) {
      await msg.reply("❌ You don’t have access to AOO commands (admin role / server owner only).");
      return;
    }

    // !aoo set channel #channel
    if (args[0] === "set" && args[1] === "channel") {
      const ch = msg.mentions.channels.first();
      if (!ch) {
        await msg.reply(`❌ Usage: \`${PREFIX}aoo set channel #channel\``);
        return;
      }
      if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
        await msg.reply("❌ Please pick a text channel.");
        return;
      }
      setGuildCfg(msg.guild.id, { pingChannelId: ch.id });
      await msg.reply(`✅ Ping channel set to <#${ch.id}>`);
      return;
    }

    // !aoo set admin @role
    if (args[0] === "set" && args[1] === "admin") {
      const role = msg.mentions.roles.first();
      if (!role) {
        await msg.reply(`❌ Usage: \`${PREFIX}aoo set admin @role\``);
        return;
      }
      setGuildCfg(msg.guild.id, { adminRoleId: role.id });
      await msg.reply(`✅ Admin role set to <@&${role.id}> (can use ALL AOO commands).`);
      return;
    }

    // !aoo scheduled
    if (args[0] === "scheduled") {
      const s = schedulesByGuild.get(msg.guild.id);
      if (!s || s.items.length === 0) {
        await msg.reply("📭 No AOO pings scheduled.");
        return;
      }

      const lines = s.items.flatMap((it, idx) => [
        `**#${idx + 1}** Start: ${formatUTC(it.startMs)}`,
        `• 1 hour ping: ${formatUTC(it.oneHourMs)}`,
        `• 10 min ping: ${formatUTC(it.tenMinMs)}`,
      ]);

      await msg.reply(`🗓️ **Scheduled AOO Pings**\n${lines.join("\n")}`);
      return;
    }

    // !aoo clear
    if (args[0] === "clear") {
      clearGuildSchedules(msg.guild.id);
      await msg.reply("✅ Cleared all scheduled AOO pings.");
      return;
    }

    // !aoo test
    if (args[0] === "test") {
      const pingCh = await resolvePingChannel(client, msg.guild.id);
      if (!pingCh) {
        await msg.reply(`❌ Ping channel not set. Use: \`${PREFIX}aoo set channel #channel\``);
        return;
      }
      await pingCh.send("@everyone ✅ **AOO test ping** (this is a test).").catch(() => {});
      await msg.reply("✅ Test ping sent.");
      return;
    }

    // Plain !aoo → dropdown flow
    const pingCh = await resolvePingChannel(client, msg.guild.id);
    if (!pingCh) {
      await msg.reply(`❌ Ping channel not set. Use: \`${PREFIX}aoo set channel #channel\``);
      return;
    }

    const days = await getNextArkBattleDays();
    if (!days) {
      await msg.reply("❌ No upcoming Ark Battle found.");
      return;
    }

    const options = days.map((d, i) => ({
      label: `Ark Battle – Day ${i + 1}`,
      description: d.toUTCString(),
      value: String(d.getTime()),
    }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId("aoo_day")
      .setPlaceholder("Select Ark Battle day (UTC)")
      .addOptions(options);

    await msg.reply({
      content: "🛡️ **Select Ark Battle day:**",
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.inGuild()) return;
    if (!interaction.isStringSelectMenu()) return;

    const authed = isOwnerOrAdmin(interaction);
    if (!authed) {
      await interaction.reply({
        content: "❌ You don’t have access to AOO commands (admin role / server owner only).",
        ephemeral: true,
      });
      return;
    }

    // Always schedule in configured ping channel (not wherever they clicked)
    const pingCh = await resolvePingChannel(interaction.client, interaction.guild.id);
    if (!pingCh) {
      await interaction.reply({
        content: `❌ Ping channel not set. Use: \`${PREFIX}aoo set channel #channel\``,
        ephemeral: true,
      });
      return;
    }

    /* ===== DAY SELECTION ===== */
    if (interaction.customId === "aoo_day") {
      const selectedDayMs = Number(interaction.values[0]);
      selectionByUser.set(`${interaction.guild.id}:${interaction.user.id}`, selectedDayMs);

      const hourOptions = [];
      for (let h = 0; h < 24; h++) {
        hourOptions.push({
          label: `${String(h).padStart(2, "0")}:00 UTC`,
          value: String(h),
        });
      }

      const hourMenu = new StringSelectMenuBuilder()
        .setCustomId("aoo_hour")
        .setPlaceholder("Select hour (UTC)")
        .addOptions(hourOptions);

      const dayDate = new Date(selectedDayMs);

      await interaction.update({
        content: `🕒 **Select hour for ${dayDate.toUTCString().slice(0, 16)} UTC**`,
        components: [new ActionRowBuilder().addComponents(hourMenu)],
      });
      return;
    }

    /* ===== HOUR SELECTION ===== */
    if (interaction.customId === "aoo_hour") {
      const hour = Number(interaction.values[0]);
      const key = `${interaction.guild.id}:${interaction.user.id}`;
      const selectedDayMs = selectionByUser.get(key);

      if (!selectedDayMs) {
        await interaction.reply({
          content: `❌ Selection expired. Run \`${PREFIX}aoo\` again.`,
          ephemeral: true,
        });
        return;
      }

      const finalDate = new Date(selectedDayMs);
      finalDate.setUTCHours(hour, 0, 0, 0);

      const startMs = finalDate.getTime();
      scheduleTwoReminders(interaction.guild.id, pingCh, startMs);

      await interaction.update({
        content:
          `✅ **AOO reminders set!**\n` +
          `🗓️ Start time: **${finalDate.toUTCString()}**\n` +
          `📣 Pings will be sent at **1 hour before** and **10 minutes before**.\n` +
          `⚠️ Any previous AOO schedule was overwritten.`,
        components: [],
      });

      selectionByUser.delete(key);
      return;
    }
  });
}
