// index.js (ROOT)
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// import modules
import { setupVerify } from "./modules/verify.js";
import { setupTemplePinger } from "./modules/templePinger.js";
import { setupRuinsPinger } from "./modules/ruinsPinger.js";
import { setupAooMge } from "./modules/aoomge.js";
import { setupAooMgeReminder } from "./modules/aoo-mge-reminder.js";

// create ONE client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// attach modules
setupVerify(client);
setupTemplePinger(client);
setupRuinsPinger(client);
setupAooMge(client);
setupAooMgeReminder(client);

// ✅ set bot custom status (ONE place)
client.once("ready", () => {
  console.log(`✅ ROOT ready as ${client.user.tag}`);
  client.user.setPresence({
    status: "online",
    activities: [{ type: 4, state: "Verifying governors 🛡️" }],
  });
});

// login ONCE
client.login(process.env.DISCORD_TOKEN);
