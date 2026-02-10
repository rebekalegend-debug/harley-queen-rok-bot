// modules/aoomge.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events,
} from "discord.js";
import ical from "node-ical";

/* ================= CONFIG ================= */

const PREFIX = "!";
const ICS_URL =
  "https://calendar.google.com/calendar/ical/5589780017d3612c518e01669b77b70f667a6cee4798c961dbfb9cf1119811f3%40group.calendar.google.com/public/basic.ics";

/* ================= STATE ================= */

let scheduledTimeout = null;
let scheduledDate = null;

/* ================= HELPERS ================= */

async function getNextArkBattles() {
  const data = await ical.async.fromURL(ICS_URL);
  const now = new Date();

  const arkEvents = Object.values(data)
    .filter((e) => {
      if (e.type !== "VEVENT") return false;
      if (!e.summary || !e.start) return false;

      const name = e.summary.toLowerCase();

      // ✅ REAL Ark detection
      const isArk =
        name.includes("ark of osiris") ||
        name.includes("ark") && name.includes("battle");

      return isArk && e.start > now;
    })
    .sort((a, b) => a.start - b.start)
    .slice(0, 2);

  return arkEvents;
}


function scheduleReminder(channel, date) {
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
    scheduledTimeout = null;
  }

  const delay = date.getTime() - Date.now();
  if (delay <= 0) return;

  scheduledDate = date;

  scheduledTimeout = setTimeout(async () => {
    await channel.send(
      `@everyone ⏰ **ARK OF OSIRIS STARTING NOW!**\n🗓️ ${date.toUTCString()}`
    );
    scheduledTimeout = null;
    scheduledDate = null;
  }, delay);
}

/* ================= MAIN EXPORT ================= */

export function setupAooMge(client) {
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (msg.content !== `${PREFIX}aoo`) return;

    const events = await getNextArkBattles();

    if (events.length === 0) {
      await msg.reply("❌ No upcoming Ark Battles found.");
      return;
    }

    const options = events.map((e) => ({
      label: e.start.toUTCString(),
      description: "Ark Battle (UTC)",
      value: String(e.start.getTime()),
    }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId("aoo_select")
      .setPlaceholder("Select Ark Battle date (UTC)")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);

    await msg.reply({
      content: "🛡️ **Select the Ark of Osiris start date:**",
      components: [row],
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "aoo_select") return;

    const timestamp = Number(interaction.values[0]);
    const date = new Date(timestamp);

    scheduleReminder(interaction.channel, date);

    await interaction.update({
      content: `✅ **AOO reminder set!**\n🗓️ ${date.toUTCString()}\n⚠️ Previous reminder (if any) was overwritten.`,
      components: [],
    });
  });
}
