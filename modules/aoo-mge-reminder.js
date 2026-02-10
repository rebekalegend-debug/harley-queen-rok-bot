
// modules/aoo-mge-reminder.js
// AOO registration + MGE registration reminders (auto-scheduled from Google Calendar ICS)
//
// Calendar must contain events with summary including:
// - "ark_registration"  -> treated as AOO registration window (uses event start/end)
// - "mge"               -> treated as MGE event (uses event start/end)
//
// Messages:
// AOO:
//  - At START: "AOO registration is opened..." + bot auto-reacts 🏆 on its own message
//  - 6h BEFORE END: "AOO registration will close soon..."
//  - At END: "AOO registration closed"
//
// MGE:
//  - 24h AFTER END: "MGE registration is open..."
//  - 48h BEFORE START: "MGE registration closes in 24 hours..."
//  - 24h BEFORE START: "MGE registration is closed"
//
// Commands (prefix !):
//  !aoomge set aooteam @role
//  !aoomge set mgeteam @role
//  !aoomge set pingchannel #channel
//  !aoomge set mgechannel #channel
//  !aoomge scheduled          (all scheduled pings next 14 days)
//  !aoomge next3              (next 3 upcoming pings)
//  !aoomge next mge           (next MGE start date)
//  !aoomge next mtg           (alias of mge)
//  !aoomge next aoo           (next AOO reg start date)
//  !aoomge refresh            (rebuild schedules now)

import { Events, ChannelType } from "discord.js";
import ical from "node-ical";
import { loadConfig, saveConfig } from "./storage.js";

/* ================= CONFIG ================= */

const PREFIX = "!";
const ICS_URL =
  "https://calendar.google.com/calendar/ical/5589780017d3612c518e01669b77b70f667a6cee4798c961dbfb9cf1119811f3%40group.calendar.google.com/public/basic.ics";

const STORE_PREFIX = "aoomge";
const LOOKAHEAD_DAYS = 28;
const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000; // refresh schedules every 6 hours
const MAX_DELAY = 2_147_483_647; // ~24.8 days, safe for 14-day lookahead

const DEFAULTS = {
  pingChannelId: null,          // ✅ where bot posts ALL AOO/MGE messages
  mgeRegisterChannelId: null,   // ✅ channel to mention in MGE text
  aooTeamRoleId: null,
  mgeTeamRoleId: null,
};

/* ================= STATE ================= */

// guildId -> { items: ScheduleItem[], timeouts: Timeout[] }
const runtime = new Map();

/**
 * ScheduleItem:
 * { whenMs, label, channelId, message, addTrophyReaction?: boolean }
 */
function getState(guildId) {
  if (!runtime.has(guildId)) runtime.set(guildId, { items: [], timeouts: [] });
  return runtime.get(guildId);
}

/* ================= STORAGE ================= */

function getCfg(guildId) {
  // storage.js is backward compatible; we use the "new" form
  return loadConfig(STORE_PREFIX, guildId, DEFAULTS);
}
function setCfg(guildId, patch) {
  const cfg = getCfg(guildId);
  const next = { ...cfg, ...patch };
  saveConfig(STORE_PREFIX, guildId, next);
  return next;
}

/* ================= UTIL ================= */


function mentionOrNone(kind, id) {
  if (!id) return "**not set**";
  if (kind === "channel") return `<#${id}>`;
  if (kind === "role") return `<@&${id}>`;
  return String(id);
}

async function sendAooTest(client, guildId) {
  const cfg = getCfg(guildId);
  const ch = await safeFetchTextChannel(client, cfg.pingChannelId);
  if (!ch) return { ok: false, err: "AOO ping channel not set or not accessible." };

  const aooMention = cfg.aooTeamRoleId ? `<@&${cfg.aooTeamRoleId}>` : "@aooteamrole";
  const fakeStart = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

  const msg = await ch.send(
    `📢 **AOO registration is OPEN!**\n` +
      `Reach out to ${aooMention} for registration!\n` +
      `Or react with **🏆** to get registered automatically!\n` +
      `🧪 **TEST MESSAGE**\n` +
      `🗓️ Example start (UTC): ${fakeStart.toUTCString()}`
  ).catch(() => null);

  if (!msg) return { ok: false, err: "Failed to send message (missing permissions?)." };

  await msg.react("🏆").catch(() => {});
  return { ok: true };
}

async function sendMgeTest(client, guildId) {
  const cfg = getCfg(guildId);
  const ch = await safeFetchTextChannel(client, cfg.mgeChannelId);
  if (!ch) return { ok: false, err: "MGE channel not set or not accessible." };

  const mgeMention = cfg.mgeTeamRoleId ? `<@&${cfg.mgeTeamRoleId}>` : "@mgeteamrole";
  const fakeStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const msg = await ch.send(
    `📢 **MGE registration is OPEN!**\n` +
      `Register in **#mechannel**, or reach out to ${mgeMention}!\n` +
      `🧪 **TEST MESSAGE**\n` +
      `🗓️ Example MGE starts (UTC): ${fakeStart.toUTCString()}`
  ).catch(() => null);

  if (!msg) return { ok: false, err: "Failed to send message (missing permissions?)." };
  return { ok: true };
}

function isManagerOrOwner(msg) {
  const guild = msg.guild;
  const member = msg.member;
  if (!guild || !member) return false;
  if (guild.ownerId && member.id === guild.ownerId) return true;
  return member.permissions?.has?.("ManageGuild") ?? false;
}

function fmtUTC(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  return d.toUTCString();
}

function inWindow(ms, now, end) {
  return ms >= now && ms <= end;
}

async function safeFetchTextChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (!ch) return null;
  if (!ch.isTextBased?.()) return null;
  return ch;
}

async function fetchCalendaaoomges() {
  const data = await ical.async.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT" && e?.start && e?.end);
}

function normText(e) {
  const sum = String(e.summary ?? "").toLowerCase();
  const desc = String(e.description ?? "").toLowerCase();
  return { sum, desc };
}

function hasType(e, type) {
  const { sum, desc } = normText(e);
  const t = String(type).toLowerCase();

  // Primary: DESCRIPTION contains "Type: mge" etc
  // Support both "\n" and literal "\n" sequences that sometimes appear
  const descClean = desc.replace(/\\n/g, "\n");
  const re = new RegExp(`\\btype\\s*:\\s*${t}\\b`, "i");
  if (re.test(descClean)) return true;

  // Fallbacks: sometimes the type is in summary
  if (sum.includes(t)) return true;

  return false;
}

function isAooRegEvent(e) {
  return hasType(e, "ark_registration");
}

function isMgeEvent(e) {
  return hasType(e, "mge");
}

function isMtgEvent(e) {
  return hasType(e, "mtg"); // "More Than Gems"
}


/* ================= SCHEDULING ================= */

function clearGuildTimers(guildId) {
  const st = runtime.get(guildId);
  if (!st) return;
  for (const t of st.timeouts) clearTimeout(t);
  st.timeouts = [];
  st.items = [];
}

function armItem(guildId, client, item) {
  const delay = item.whenMs - Date.now();
  if (delay <= 0) return;
  if (delay > MAX_DELAY) return; // should not happen for 14 days

  const st = getState(guildId);
  const to = setTimeout(async () => {
    const ch = await safeFetchTextChannel(client, item.channelId);
    if (!ch) return;

    const sent = await ch.send(item.message).catch(() => null);
    if (sent && item.addTrophyReaction) {
      await sent.react("🏆").catch(() => {});
    }
  }, delay);

  st.timeouts.push(to);
}

async function rebuildGuildSchedule(client, guildId) {
  clearGuildTimers(guildId);

  const cfg = getCfg(guildId);
  const pingChId = cfg.pingChannelId;
  const mgeChId = cfg.mgeChannelId;

  // If not configured, don't schedule anything.
  if (!pingChId && !mgeChId) return;

  const now = Date.now();
  const end = now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  const events = await fetchCalendaaoomges();

  const st = getState(guildId);
  const items = [];

  // AOO Registration events
  for (const e of events.filter(isAooRegEvent)) {
    const startMs = new Date(e.start).getTime();
    const endMs = new Date(e.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    // Use ping channel for AOO
    if (!pingChId) continue;

    const aooMention = cfg.aooTeamRoleId ? `<@&${cfg.aooTeamRoleId}>` : "@aooteamrole";

    const atStart = startMs;
    const beforeEnd6h = endMs - 6 * 60 * 60 * 1000;
    const atEnd = endMs;

    if (inWindow(atStart, now, end)) {
      items.push({
        whenMs: atStart,
        label: `AOO registration OPEN (${fmtUTC(atStart)})`,
        channelId: pingChId,
        message:
          `📢 **AOO registration is OPEN!**\n` +
          `Reach out to ${aooMention} for registration!\n` +
          `Or react with **🏆** to get registered automatically!\n` +
          `🗓️ Window: ${fmtUTC(startMs)} → ${fmtUTC(endMs)} (UTC)`,
        addTrophyReaction: true,
      });
    }

    if (inWindow(beforeEnd6h, now, end)) {
      items.push({
        whenMs: beforeEnd6h,
        label: `AOO registration closing soon (${fmtUTC(beforeEnd6h)})`,
        channelId: pingChId,
        message:
          `⏳ **AOO registration will close soon!**\n` +
          `Be sure you are registered.\n` +
          `🗓️ Ends at: **${fmtUTC(endMs)}** (UTC)`,
      });
    }

    if (inWindow(atEnd, now, end)) {
      items.push({
        whenMs: atEnd,
        label: `AOO registration CLOSED (${fmtUTC(atEnd)})`,
        channelId: pingChId,
        message: `✅ **AOO registration closed.**`,
      });
    }
  }

  // MGE events
  for (const e of events.filter(isMgeEvent)) {
    const startMs = new Date(e.start).getTime();
    const endMs = new Date(e.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    // Use mge channel for MGE
    if (!pingChId) continue;

    const mgeMention = cfg.mgeTeamRoleId ? `<@&${cfg.mgeTeamRoleId}>` : "@mgeteamrole";

    const open24hAfterEnd = endMs + 24 * 60 * 60 * 1000;
    const closeWarn48hBeforeStart = startMs - 48 * 60 * 60 * 1000;
    const closed24hBeforeStart = startMs - 24 * 60 * 60 * 1000;

    if (inWindow(open24hAfterEnd, now, end)) {
      items.push({
        whenMs: open24hAfterEnd,
        label: `MGE registration OPEN (${fmtUTC(open24hAfterEnd)})`,
        channelId: pingChId,
        message:
          `📢 **MGE registration is OPEN!**\n` +
          const regChMention = cfg.mgeRegisterChannelId
  ? `<#${cfg.mgeRegisterChannelId}>`
  : "**#mechannel**";

`Register in ${regChMention}, or reach out to ${mgeMention}!\n`
 +
          `🗓️ Next MGE starts: **${fmtUTC(startMs)}** (UTC)`,
      });
    }

    if (inWindow(closeWarn48hBeforeStart, now, end)) {
      items.push({
        whenMs: closeWarn48hBeforeStart,
        label: `MGE registration closing soon (${fmtUTC(closeWarn48hBeforeStart)})`,
        channelId: pingChId,
        message:
          `⚠️ **MGE registration closes in 24 hours!**\n` +
          `Don’t forget to apply.\n` +
          `🗓️ MGE starts: **${fmtUTC(startMs)}** (UTC)`,
      });
    }

    if (inWindow(closed24hBeforeStart, now, end)) {
      items.push({
        whenMs: closed24hBeforeStart,
        label: `MGE registration CLOSED (${fmtUTC(closed24hBeforeStart)})`,
        channelId: pingChId,
        message: `🔒 **MGE registration is closed.**`,
      });
    }
  }

  // sort + keep
  items.sort((a, b) => a.whenMs - b.whenMs);
  st.items = items;

  // arm timers
  for (const it of items) armItem(guildId, client, it);
}

async function rebuildAllSchedules(client) {
  for (const guildId of client.guilds.cache.keys()) {
    await rebuildGuildSchedule(client, guildId).catch(() => {});
  }
}

/* ================= COMMANDS ================= */

function buildHelp() {
  return (
    "**🗓️ Event Reminder Commands**\n" +
    `\`${PREFIX}revent status\` → show configured channels/roles\n` +
    `\`${PREFIX}revent pingtest aoo\` → send AOO-style test message (+🏆 reaction)\n` +
    `\`${PREFIX}revent pingtest mge\` → send MGE-style test message\n` +
    `\`${PREFIX}revent set aooteam @role\` → set AOO team role\n` +
    `\`${PREFIX}revent set mgeteam @role\` → set MGE team role\n` +
    `\`${PREFIX}revent set pingchannel #channel\` → set ping channel\n` +
    `\`${PREFIX}revent set mgechannel #channel\` → set MGE channel\n` +
    `\`${PREFIX}revent scheduled\` → all scheduled pings next ${LOOKAHEAD_DAYS} days\n` +
    `\`${PREFIX}revent next3\` → next 3 upcoming pings\n` +
    `\`${PREFIX}revent next mge\` / \`${PREFIX}revent next mtg\` → next event start date\n` +
    `\`${PREFIX}revent next aoo\` → next AOO registration start date\n` +
    `\`${PREFIX}revent refresh\` → rebuild schedules now`
  );
}


async function nextMgeStartUTC() {
  const events = await fetchCalendaaoomges();
  const now = Date.now();

  const next = events
    .filter(isMgeEvent)
    .map((e) => new Date(e.start).getTime())
    .filter((ms) => ms > now)
    .sort((a, b) => a - b)[0];

  return next ?? null;
}

async function nextAooRegStartUTC() {
  const events = await fetchCalendaaoomges();
  const now = Date.now();

  const next = events
    .filter(isAooRegEvent)
    .map((e) => new Date(e.start).getTime())
    .filter((ms) => ms > now)
    .sort((a, b) => a - b)[0];

  return next ?? null;
}

/* ================= MAIN ================= */

export function setupAooMgeReminder(client) {
  console.log("[AOO/MGE] reminder module registered");

  client.once(Events.ClientReady, async () => {
    await rebuildAllSchedules(client).catch(() => {});
    setInterval(() => {
      rebuildAllSchedules(client).catch(() => {});
    }, REFRESH_EVERY_MS);
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content.startsWith(`${PREFIX}revent`)) return;

    const args = msg.content.trim().split(/\s+/).slice(1);

    if (args[0] === "help" || args.length === 0) {
      await msg.reply(buildHelp());
      return;
    }

    // Restrict setup/management to Manage Server or Owner
    const admin = isManagerOrOwner(msg);

// !revent status
if (args[0] === "status") {
  const cfg = getCfg(msg.guild.id);

  const lines = [];
  lines.push("**🧾 Revent Status**");
  lines.push(`• AOO ping channel: ${mentionOrNone("channel", cfg.pingChannelId)}`);
  lines.push(`• MGE channel: ${mentionOrNone("channel", cfg.mgeChannelId)}`);
  lines.push(`• AOO team role: ${mentionOrNone("role", cfg.aooTeamRoleId)}`);
  lines.push(`• MGE team role: ${mentionOrNone("role", cfg.mgeTeamRoleId)}`);
  lines.push("");
  lines.push(`• Lookahead window: **${LOOKAHEAD_DAYS} days**`);
  lines.push("• Calendar: **Google ICS**");

  await msg.reply({ content: lines.join("\n"), allowedMentions: { roles: [] } });
  return;
}

// !revent pingtest aoo|mge
if (args[0] === "pingtest") {
  if (!admin) {
    await msg.reply("❌ You need **Manage Server** (or be server owner) to use this.");
    return;
  }

  const which = (args[1] ?? "").toLowerCase();
  if (which !== "aoo" && which !== "mge") {
    await msg.reply(`Usage: \`${PREFIX}revent pingtest aoo\` or \`${PREFIX}revent pingtest mge\``);
    return;
  }

  if (which === "aoo") {
    const res = await sendAooTest(client, msg.guild.id);
    if (!res.ok) return msg.reply(`❌ ${res.err}`);
    await msg.reply("✅ Sent AOO test message (with 🏆 reaction).");
    return;
  }

  if (which === "mge") {
    const res = await sendMgeTest(client, msg.guild.id);
    if (!res.ok) return msg.reply(`❌ ${res.err}`);
    await msg.reply("✅ Sent MGE test message.");
    return;
  }
}
    
    // !aoomge set ...
    if (args[0] === "set") {
      if (!admin) {
        await msg.reply("❌ You need **Manage Server** (or be server owner) to use this.");
        return;
      }

      const key = (args[1] ?? "").toLowerCase();

      if (key === "aooteam") {
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply(`Usage: \`${PREFIX}revent set aooteam @role\``);
        setCfg(msg.guild.id, { aooTeamRoleId: role.id });
        await msg.reply(`✅ AOO team role set to <@&${role.id}>`);
        await rebuildGuildSchedule(client, msg.guild.id).catch(() => {});
        return;
      }

      if (key === "mgeteam") {
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply(`Usage: \`${PREFIX}revent set mgeteam @role\``);
        setCfg(msg.guild.id, { mgeTeamRoleId: role.id });
        await msg.reply(`✅ MGE team role set to <@&${role.id}>`);
        await rebuildGuildSchedule(client, msg.guild.id).catch(() => {});
        return;
      }

      if (key === "pingchannel") {
        const ch = msg.mentions.channels.first();
        if (!ch) return msg.reply(`Usage: \`${PREFIX}revent set pingchannel #channel\``);
        if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
          return msg.reply("❌ Please pick a text/announcement channel.");
        }
        setCfg(msg.guild.id, { pingChannelId: ch.id });
        await msg.reply(`✅ AOO ping channel set to <#${ch.id}>`);
        await rebuildGuildSchedule(client, msg.guild.id).catch(() => {});
        return;
      }

      if (key === "mgechannel") {
  const ch = msg.mentions.channels.first();
  if (!ch) return msg.reply(`Usage: \`${PREFIX}revent set mgechannel #channel\``);
  if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
    return msg.reply("❌ Please pick a text/announcement channel.");
  }
  setCfg(msg.guild.id, { mgeRegisterChannelId: ch.id });
  await msg.reply(`✅ MGE register channel (mentioned in pings) set to <#${ch.id}>`);
  await rebuildGuildSchedule(client, msg.guild.id).catch(() => {});
  return;
}


      await msg.reply(buildHelp());
      return;
    }

    // !aoomge refresh
    if (args[0] === "refresh") {
      if (!admin) {
        await msg.reply("❌ You need **Manage Server** (or be server owner) to use this.");
        return;
      }
      await rebuildGuildSchedule(client, msg.guild.id).catch(() => {});
      await msg.reply("✅ Rebuilt schedules from calendar.");
      return;
    }

    // !aoomge scheduled
    if (args[0] === "scheduled") {
      const st = getState(msg.guild.id);
      if (!st.items.length) {
        await msg.reply("📭 No scheduled pings (or channels not configured). Use `!revent refresh` after setup.");
        return;
      }
      const lines = st.items.map(
        (it, i) => `**${i + 1}.** ${fmtUTC(it.whenMs)} — ${it.label}`
      );
      await msg.reply(`🗓️ **Scheduled pings (next ${LOOKAHEAD_DAYS} days)**\n${lines.join("\n")}`);
      return;
    }

    // !aoomge next3
    if (args[0] === "next3") {
      const st = getState(msg.guild.id);
      const now = Date.now();
      const upcoming = st.items.filter((x) => x.whenMs > now).slice(0, 3);
      if (!upcoming.length) {
        await msg.reply("📭 No upcoming pings (or channels not configured).");
        return;
      }
      const lines = upcoming.map((it, i) => `**${i + 1}.** ${fmtUTC(it.whenMs)} — ${it.label}`);
      await msg.reply(`⏭️ **Next 3 pings**\n${lines.join("\n")}`);
      return;
    }

    // !aoomge next ...
    if (args[0] === "next") {
      const what = (args[1] ?? "").toLowerCase();

      if (what === "mge" || what === "mtg") {
        const ms = await nextMgeStartUTC();
        if (!ms) return msg.reply("❌ No upcoming MGE found in calendar.");
        return msg.reply(`📅 **Next MGE starts (UTC):** ${fmtUTC(ms)}`);
      }

      if (what === "aoo") {
        const ms = await nextAooRegStartUTC();
        if (!ms) return msg.reply("❌ No upcoming AOO registration found in calendar.");
        return msg.reply(`📅 **Next AOO registration starts (UTC):** ${fmtUTC(ms)}`);
      }

      await msg.reply(`Usage: \`${PREFIX}revent next mge\` | \`${PREFIX}revent next aoo\``);
      return;
    }

    await msg.reply(buildHelp());
  });
}
