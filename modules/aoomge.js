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
let selectedDayDate = null;

/* ================= HELPERS ================= */

async function getNextArkBattleDays() {
  const data = await ical.async.fromURL(ICS_URL);
  const now = new Date();

  const arkEvent = Object.values(data)
    .filter((e) => {
      if (e.type !== "VEVENT") return false;
      if (!e.summary || !e.start) return false;

      const name = e.summary.toLowerCase();
      const isArk =
        name.includes("ark of osiris") ||
        (name.includes("ark") && name.includes("battle"));

      return isArk && e.start > now;
    })
    .sort((a, b) => a.start - b.start)[0]; // ✅ ONLY NEXT ARK

  if (!arkEvent) return null;

  const day1 = new Date(arkEvent.start);
  const day2 = new Date(arkEvent.start.getTime() + 24 * 60 * 60 * 1000);

  return [day1, day2];
}

function scheduleReminder(channel, date) {
  if (scheduledTimeout) {
    clearTimeout(scheduledTimeout);
    scheduledTimeout = null;
  }

  const delay = date.getTime() - Date.now();
  if (delay <= 0) return;

  scheduledTimeout = setTimeout(async () => {
    await channel.send(
      `@everyone ⏰ **ARK OF OSIRIS STARTING!**\n🗓️ ${date.toUTCString()}`
    );
    scheduledTimeout = null;
  }, delay);
}

/* ================= MAIN ================= */

export function setupAooMge(client) {
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (msg.content !== `${PREFIX}aoo`) return;

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
    if (!interaction.isStringSelectMenu()) return;

    /* ===== DAY SELECTION ===== */
    if (interaction.customId === "aoo_day") {
      selectedDayDate = new Date(Number(interaction.values[0]));

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

      await interaction.update({
        content: `🕒 **Select hour for ${selectedDayDate.toUTCString().slice(0, 16)} UTC**`,
        components: [new ActionRowBuilder().addComponents(hourMenu)],
      });
    }

    /* ===== HOUR SELECTION ===== */
    if (interaction.customId === "aoo_hour") {
      const hour = Number(interaction.values[0]);

      const finalDate = new Date(selectedDayDate);
      finalDate.setUTCHours(hour, 0, 0, 0);

      scheduleReminder(interaction.channel, finalDate);

      await interaction.update({
        content:
          `✅ **AOO reminder set!**\n` +
          `🗓️ ${finalDate.toUTCString()}\n` +
          `⚠️ Previous reminder (if any) was overwritten.`,
        components: [],
      });
    }
  });
}
