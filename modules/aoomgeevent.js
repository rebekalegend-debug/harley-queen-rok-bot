// modules/aoomgeevent.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

export function setupAooMgeEvent(client) {

/* ================= CONFIG ================= */

const PREFIX = "!";
const ICS_URL = process.env.ICS_URL;
const DATA_FILE = path.resolve("./modules/aooData.json");

/* ================= STORAGE ================= */

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return {}; }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function getGuild(guildId) {
  const db = loadDB();
  db[guildId] ??= {
    pingChannel: null,
    aooRole: null,
    mgeRole: null,
    aooAccessRole: null,
    scheduled: []
  };
  saveDB(db);
  return db[guildId];
}

/* ================= HELPERS ================= */

function clearAooSchedules(g) {
  g.scheduled = g.scheduled.filter(
    s =>
      !s.text.includes("AOO starts in **30 minutes**") &&
      !s.text.includes("AOO starts in **10 minutes**")
  );
}
  
function isOwner(msg) {
  if (!msg?.guild || !msg?.member) return false;
  return msg.guild.ownerId === msg.member.id;
}

function hasAccess(member, g) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  return g.aooAccessRole && member.roles.cache.has(g.aooAccessRole);
}


const formatUTC = d =>
  d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

const addHours = (d, h) => new Date(d.getTime() + h * 3600000);

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter(e => e?.type === "VEVENT");
}

function getType(ev) {
  const t = [ev.summary, ev.description, ev.location].join("\n");
  const m = t.match(/Type:\s*(\w+)/i);
  return m?.[1]?.toLowerCase();
}

/* ================= SCHEDULER ================= */

function schedule(g, time, channelId, text) {
  g.scheduled.push({ time, channelId, text, sent: false });
}

async function runScheduler() {
  const db = loadDB();
  const now = Date.now();

  for (const gid in db) {
    const g = db[gid];
    for (const s of g.scheduled) {
      if (!s.sent && now >= s.time) {
        const ch = await client.channels.fetch(s.channelId).catch(() => null);
        if (ch?.isTextBased()) {
          const msg = await ch.send(s.text);
          await msg.react("🏆").catch(() => {});
        }
        s.sent = true;
      }
    }
    g.scheduled = g.scheduled.filter(x => !x.sent);
  }
  saveDB(db);
}

client.once("ready", () => {
  setInterval(runScheduler, 30_000);
});

/* ================= COMMANDS ================= */

client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const g = getGuild(msg.guild.id);
  const [cmd] = msg.content.slice(1).split(" ");

  /* ----- OWNER CONFIG ----- */

  if (cmd === "set_ping_channel" && isOwner(msg)) {
    g.pingChannel = msg.mentions.channels.first()?.id;
    saveDB(loadDB());
    return msg.reply("✅ Ping channel set");
  }

  if (cmd === "set_aoo_role" && isOwner(msg)) {
    g.aooRole = msg.mentions.roles.first()?.id;
    saveDB(loadDB());
    return msg.reply("✅ AOO role set");
  }

  if (cmd === "set_mge_role" && isOwner(msg)) {
    g.mgeRole = msg.mentions.roles.first()?.id;
    saveDB(loadDB());
    return msg.reply("✅ MGE role set");
  }

  if (cmd === "set_aoo_access" && isOwner(msg)) {
    g.aooAccessRole = msg.mentions.roles.first()?.id;
    saveDB(loadDB());
    return msg.reply("✅ AOO access role set");
  }

  /* ----- STATUS ----- */

  if (cmd === "status") {
    return msg.reply(
      `Channel: ${g.pingChannel}
AOO role: ${g.aooRole}
MGE role: ${g.mgeRole}
AOO access: ${g.aooAccessRole}
Scheduled: ${g.scheduled.length}`
    );
  }

  /* ----- SCHEDULE INFO ----- */

  if (cmd === "next_ping") {
    const n = g.scheduled.sort((a,b)=>a.time-b.time)[0];
    return msg.reply(n ? `Next ping: ${formatUTC(new Date(n.time))}` : "No scheduled pings");
  }

  if (cmd === "scheduled_30d") {
    const now = Date.now();
    const limit = now + 30*24*60*60*1000;
    const list = g.scheduled
      .filter(s => s.time <= limit)
      .sort((a,b)=>a.time-b.time);

    return msg.reply(
      list.length
        ? list.map(s => formatUTC(new Date(s.time))).join("\n")
        : "No scheduled pings in next 30 days"
    );
  }

  /* ----- CALENDAR INFO ----- */

  if (cmd === "next_mge") {
    const events = await fetchEvents();
    const ev = events
      .filter(e => getType(e) === "mge")
      .map(e => new Date(e.start))
      .find(d => d > new Date());

    return msg.reply(
      ev ? `Next MGE: **${formatUTC(ev)}**` : "No upcoming MGE"
    );
  }

  if (cmd === "calendar_week") {
    const now = new Date();
    const end = new Date(now.getTime() + 7*24*60*60*1000);
    const events = await fetchEvents();

    const list = events
      .map(e => ({ d: new Date(e.start), t: getType(e) }))
      .filter(e => e.d >= now && e.d <= end)
      .slice(0, 10);

    return msg.reply(
      list.length
        ? list.map(e => `${formatUTC(e.d)} — ${e.t}`).join("\n")
        : "No events in next 7 days"
    );
  }

  /* ----- AOO DATE + HOUR DROPDOWN ----- */

  if (cmd === "aoo") {
    if (!hasAccess(msg.member, g)) return msg.reply("❌ No access");

    const events = await fetchEvents();
const now = new Date();

const aooEvents = events
  .filter(e => getType(e) === "ark_battle")
  .map(e => ({
    ...e,
    start: new Date(e.start),
    end: new Date(e.end)
  }))
  .filter(e => e.end > now)          // ⛔ ignore finished AOOs
  .sort((a, b) => a.start - b.start); // ⏳ nearest first

const ev = aooEvents[0];
    if (!ev) return msg.reply("No upcoming AOO found");

    const start = new Date(ev.start);
    const end = new Date(ev.end);

    const days = [];
    const d = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate()
    ));

    while (d <= end) {
      days.push(new Date(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("aoo_day")
        .setPlaceholder("Select AOO date (UTC)")
        .addOptions(
          days.map(x => ({
            label: x.toISOString().slice(0,10),
            value: x.toISOString().slice(0,10)
          }))
        )
    );

    return msg.reply({ content: "Select AOO date:", components: [row] });
  }

  if (cmd === "help") {
    return msg.reply(
      `Commands:
!aoo
!next_ping
!scheduled_30d
!next_mge
!calendar_week
!status`
    );
  }
});

/* ================= DROPDOWNS ================= */

client.on("interactionCreate", async i => {
  if (!i.isStringSelectMenu()) return;
  const g = getGuild(i.guild.id);

  /* ----- DATE PICK ----- */
  if (i.customId === "aoo_day") {
    const date = i.values[0];
    const options = [];

    for (let h=0; h<24; h++) {
      options.push({
        label: `${h}:00 UTC`,
        value: `${date}|${h}`
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("aoo_hour")
        .setPlaceholder("Select hour (UTC)")
        .addOptions(options)
    );

    return i.update({ content: `Date selected: **${date}**`, components: [row] });
  }

  /* ----- HOUR PICK ----- */
  if (i.customId === "aoo_hour") {
    const [date, hour] = i.values[0].split("|");
    const startMs = Date.parse(`${date}T${hour.padStart(2,"0")}:00:00Z`);

    // ❗ overwrite previous AOO reminders
clearAooSchedules(g);

// schedule new ones
schedule(g, startMs - 30*60*1000, g.pingChannel, "🏆 AOO starts in **30 minutes**!");
schedule(g, startMs - 10*60*1000, g.pingChannel, "🏆 AOO starts in **10 minutes**!");

saveDB(loadDB());
return i.update({
  content: "✅ AOO reminders updated (old ones removed)",
  components: []
});
  }
});

}
