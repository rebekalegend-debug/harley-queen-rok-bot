// modules/aoomgeevent.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

export function setupAooMgeEvent(client) {

/* ================== BASIC CONFIG ================== */

const PREFIX = "!";
const ICS_URL = process.env.ICS_URL;
const DATA_FILE = path.resolve("./modules/aooData.json");

/* ================== STORAGE ================== */

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE)); }
  catch { return {}; }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function guildDB(guildId) {
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

/* ================== HELPERS ================== */

function isOwner(msg) {
  return msg.guild.ownerId === msg.author.id;
}
function hasAooAccess(member, g) {
  return g.aooAccessRole && member.roles.cache.has(g.aooAccessRole);
}
function formatUTC(d) {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
function addHours(d, h) {
  return new Date(d.getTime() + h * 3600000);
}
async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter(e => e?.type === "VEVENT");
}
function getType(ev) {
  const t = [ev.summary, ev.description].join("\n");
  const m = t.match(/Type:\s*(\w+)/i);
  return m?.[1]?.toLowerCase();
}

/* ================== SCHEDULER ================== */

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
        const ch = await client.channels.fetch(s.channelId);
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

/* ================== READY ================== */

client.once("ready", () => {
  setInterval(runScheduler, 30_000);
});

/* ================== COMMANDS ================== */

client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const g = guildDB(msg.guild.id);
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
      `Channel: ${g.pingChannel}\nAOO role: ${g.aooRole}\nMGE role: ${g.mgeRole}\nAOO access: ${g.aooAccessRole}\nScheduled: ${g.scheduled.length}`
    );
  }

  /* ----- SCHEDULE INFO ----- */

  if (cmd === "next_ping") {
    const n = g.scheduled.sort((a,b)=>a.time-b.time)[0];
    return msg.reply(n ? `Next: ${formatUTC(new Date(n.time))}` : "None");
  }

  if (cmd === "scheduled") {
    return msg.reply(
      g.scheduled.map(s => formatUTC(new Date(s.time))).join("\n") || "None"
    );
  }

  /* ----- AOO DROPDOWN ----- */

  if (cmd === "aoo") {
    if (!hasAooAccess(msg.member, g) && !isOwner(msg))
      return msg.reply("❌ No access");

    const events = await fetchEvents();
    const aoo = events.find(e => getType(e) === "ark_battle");
    if (!aoo) return msg.reply("No AOO found");

    const start = new Date(aoo.start);
    const end = new Date(aoo.end);

    const options = [];
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
        h
      ));
      if (t >= start && t <= end) {
        options.push({ label: `${h}:00 UTC`, value: String(t.getTime()) });
      }
    }

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("aoo_time")
        .setPlaceholder("Pick AOO time")
        .addOptions(options)
    );

    return msg.reply({ content: "Pick AOO start time:", components: [row] });
  }

  if (cmd === "help") {
    return msg.reply("Commands: set_*, aoo, status, next_ping, scheduled");
  }
});

/* ================== DROPDOWN ================== */

client.on("interactionCreate", async i => {
  if (!i.isStringSelectMenu()) return;
  if (i.customId !== "aoo_time") return;

  const g = guildDB(i.guild.id);
  const startMs = Number(i.values[0]);

  schedule(g, startMs - 30*60*1000, g.pingChannel, "⏰ AOO starts in 30 min!");
  schedule(g, startMs - 10*60*1000, g.pingChannel, "⏰ AOO starts in 10 min!");

  saveDB(loadDB());
  await i.update({ content: "✅ AOO reminders scheduled", components: [] });
});

}
