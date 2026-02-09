// index.js (ROOT)
import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// import modules
import { setupVerify } from "./modules/verify.js";
import { setupTemplePinger } from "./modules/templePinger.js";

// create ONE client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// attach modules
setupVerify(client);
setupTemplePinger(client);

// login ONCE
client.login(process.env.DISCORD_TOKEN);
