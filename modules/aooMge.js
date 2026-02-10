import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

/* ================= CONFIG ================= */

const CHANNEL_ID = process.env.CHANNEL_ID;
const ICS_URL = process.env.ICS_URL;

const PING = process.env.PING_TEXT ?? "@everyone";
const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES ?? "10");
const PREFIX = process.env.PREFIX ?? "!";

// persistent state
const STATE_DIR = process.env.STATE_DIR ?? "/data";
const stateFile = path.resolve(STATE_DIR, "aoomge_state.json");

/* ================= STATE ================= */

ensureStateDir();
const state = loadState();
state.scheduled ??= [];

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/* ================= HELPERS ================= */

function isAdmin(member) {
  return member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function getEventType(evOrText = "") {
  const text =
    typeof evOrText === "string"
      ? evOrText
      : [evOrText?.description, evOrText?.summary, evOrText?.location]
          .filter(Boolean)
          .join("\n");

  const m = text.match(/Type:\s*([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function formatUTC(d) {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function addHours(d, h) {
  return new Date(d.getTime() + h * 3600000);
}

function addMonthsUTC(d, m) {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter(e => e?.type === "VEVENT");
}

function makeKey(prefix, ev, suffix) {
  return `${prefix}_${ev.uid}_${isoDateUTC(new Date(ev.start))}_${suffix}`;
}

/* ================= SCHEDULER ================= */

function schedulePing({ channelId, runAtMs, message }) {
  state.scheduled.push({
    id: Math.random().toString(16).slice(2),
    channelId,
    runAtMs,
    message,
    sent: false,
  });
  saveState();
}

async function processScheduled(client) {
  const now = Date.now();

  for (const s of state.scheduled) {
    if (s.sent || now < s.runAtMs) continue;

    const ch = await client.channels.fetch(s.channelId).catch(() => null);
    if (ch?.isTextBased()) await ch.send(s.message);

    s.sent = true;
  }

  state.scheduled = state.scheduled.filter(x => !x.sent);
  saveState();
}

/* ================= AOO DROPDOWN ================= */

const AOO_TYPES = new Set(["ark_battle", "aoo"]);

async function getNextAooEvent() {
  const now = new Date();
  const events = await fetchEvents();

  return events
    .filter(e => AOO_TYPES.has(getEventType(e)))
    .map(e => ({ start: new Date(e.start), end: new Date(e.end) }))
    .filter(e => e.end > now)
    .sort((a, b) => a.start - b.start)[0];
}

function listUtcDates(start, end) {
  const out = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d < end) {
    out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dateSelect(startMs, endMs, dates) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_date|${startMs}|${endMs}`)
      .setPlaceholder("Select date (UTC)")
      .addOptions(dates.slice(0, 25).map(d => ({
        label: isoDateUTC(d),
        value: isoDateUTC(d),
      })))
  );
}

function hourSelect(startMs, endMs, dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const opts = [];

  for (let h = 0; h < 24; h++) {
    const t = Date.UTC(y, m - 1, d, h);
    if (t >= startMs && t < endMs) {
      opts.push({ label: `${String(h).padStart(2, "0")}:00 UTC`, value: String(h) });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_hour|${startMs}|${endMs}|${dateISO}`)
      .setPlaceholder("Select hour (UTC)")
      .addOptions(opts.length ? opts : [{ label: "No valid hours", value: "none" }])
  );
}

/* ================= MODULE EXPORT ================= */

export function setupAooMge(client) {
  client.once("ready", async () => {
    setInterval(() => processScheduled(client), 30_000);
  });

  client.on("interactionCreate", async i => {
    if (!i.isStringSelectMenu()) return;
    if (!isAdmin(i.member)) {
      return i.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const id = i.customId;

    if (id.startsWith("aoo_date|")) {
      const [, s, e] = id.split("|");
      const dateISO = i.values[0];
      return i.update({
        content: `Selected **${dateISO}** – now choose hour`,
        components: [hourSelect(+s, +e, dateISO)],
      });
    }

    if (id.startsWith("aoo_hour|")) {
      const [, s, e, dateISO] = id.split("|");
      const hour = Number(i.values[0]);
      const [y, m, d] = dateISO.split("-").map(Number);
      const startMs = Date.UTC(y, m - 1, d, hour);

      schedulePing({
        channelId: i.channelId,
        runAtMs: startMs - 30 * 60_000,
        message: `${PING}\nAOO starts in **30 minutes**`,
      });

      schedulePing({
        channelId: i.channelId,
        runAtMs: startMs - 10 * 60_000,
        message: `${PING}\nAOO starts in **10 minutes**`,
      });

      return i.update({
        content: `✅ AOO reminders scheduled for **${formatUTC(new Date(startMs))}**`,
        components: [],
      });
    }
  });

  client.on("messageCreate", async msg => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;
    if (!isAdmin(msg.member)) return msg.reply("❌ Admin only.");

    if (msg.content === `${PREFIX}aoo`) {
      const aoo = await getNextAooEvent();
      if (!aoo) return msg.reply("No upcoming AOO found.");

      const dates = listUtcDates(aoo.start, aoo.end);
      return msg.reply({
        content: `AOO window: **${formatUTC(aoo.start)} → ${formatUTC(aoo.end)}**`,
        components: [dateSelect(aoo.start.getTime(), aoo.end.getTime(), dates)],
      });
    }
  });
}
