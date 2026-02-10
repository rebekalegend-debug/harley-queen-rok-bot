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

const STATE_DIR = process.env.STATE_DIR ?? "/data";
const STATE_FILE = path.join(STATE_DIR, "aoomge_state.json");

/* ================= STATE ================= */

ensureDir();
const state = loadState();
state.scheduled ??= [];

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

/* ================= ANNOUNCEMENT TEXT ================= */

const aooOpenMsg = () =>
  "AOO registration is opened, reach out to leadership for registration!";
const aooWarnMsg = () =>
  "AOO registration will close soon, be sure you are registered!";
const aooClosedMsg = () =>
  "AOO registration closed";

const mgeOpenMsg = () =>
  "MGE registration is open, check the MGE channel and apply!";
const mgeWarnMsg = () =>
  "MGE registration closes in 24 hours, don’t forget to apply!";
const mgeClosedMsg = () =>
  "MGE registration is closed";

/* ================= SCHEDULED PINGS ================= */

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
  let changed = false;

  for (const s of state.scheduled) {
    if (s.sent || now < s.runAtMs) continue;

    const ch = await client.channels.fetch(s.channelId).catch(() => null);
    if (ch?.isTextBased()) await ch.send(s.message);

    s.sent = true;
    changed = true;
  }

  if (changed) {
    state.scheduled = state.scheduled.filter(x => !x.sent);
    saveState();
  }
}

/* ================= ANNOUNCEMENT LOGIC (AOO + MGE) ================= */

async function runCheck(client) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return;

  const now = new Date();
  const events = await fetchEvents();

  for (const ev of events) {
    const type = getEventType(ev);
    if (!type) continue;

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    /* ===== AOO REGISTRATION ===== */
    if (type === "ark_registration") {
      const openKey = makeKey("AOO", ev, "open");
      const warnKey = makeKey("AOO", ev, "warn");
      const closeKey = makeKey("AOO", ev, "close");

      const warnTime = addHours(end, -6);

      if (!state[openKey] && now >= start) {
        await channel.send(`${PING}\n${aooOpenMsg()}`);
        state[openKey] = true;
        saveState();
      }

      if (!state[warnKey] && now >= warnTime && now < end) {
        await channel.send(`${PING}\n${aooWarnMsg()}`);
        state[warnKey] = true;
        saveState();
      }

      if (!state[closeKey] && now >= end) {
        await channel.send(`${PING}\n${aooClosedMsg()}`);
        state[closeKey] = true;
        saveState();
      }
    }

    /* ===== MGE ===== */
    if (type === "mge") {
      const openKey = makeKey("MGE", ev, "open");
      const warnKey = makeKey("MGE", ev, "warn");
      const closeKey = makeKey("MGE", ev, "close");

      const openTime = addHours(end, 24);
      const warnTime = addHours(start, -48);
      const closeTime = addHours(start, -24);

      if (!state[openKey] && now >= openTime) {
        await channel.send(`${PING}\n${mgeOpenMsg()}`);
        state[openKey] = true;
        saveState();
      }

      if (!state[warnKey] && now >= warnTime && now < closeTime) {
        await channel.send(`${PING}\n${mgeWarnMsg()}`);
        state[warnKey] = true;
        saveState();
      }

      if (!state[closeKey] && now >= closeTime && now < start) {
        await channel.send(`${PING}\n${mgeClosedMsg()}`);
        state[closeKey] = true;
        saveState();
      }
    }
  }
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

/* ================= MODULE EXPORT ================= */

export function setupAooMge(client) {
  client.once("ready", async () => {
    await runCheck(client);
    await processScheduled(client);

    setInterval(() => runCheck(client).catch(console.error),
      CHECK_EVERY_MINUTES * 60 * 1000
    );

    setInterval(() => processScheduled(client).catch(console.error), 30_000);
  });

  client.on("messageCreate", async msg => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;
    if (!isAdmin(msg.member)) return msg.reply("❌ Admin only.");

    if (msg.content === `${PREFIX}aoo`) {
      const aoo = await getNextAooEvent();
      if (!aoo) return msg.reply("No upcoming AOO found.");

      const dates = listUtcDates(aoo.start, aoo.end);
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`aoo_date|${aoo.start.getTime()}|${aoo.end.getTime()}`)
          .setPlaceholder("Select AOO date (UTC)")
          .addOptions(dates.slice(0, 25).map(d => ({
            label: isoDateUTC(d),
            value: isoDateUTC(d),
          })))
      );

      await msg.reply({
        content: `AOO window:\n${formatUTC(aoo.start)} → ${formatUTC(aoo.end)}`,
        components: [row],
      });
    }
  });
}
