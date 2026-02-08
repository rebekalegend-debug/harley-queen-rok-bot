const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} = require("discord.js");

const TOKEN = process.env.TOKEN;

// REQUIRED: set these in Railway Variables
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID; // e.g. "123..."
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;         // role id

// Simple safety: in-game name length and allowed chars (adjust as you want)
function sanitizeName(raw) {
  const name = raw.trim();
  if (name.length < 2 || name.length > 32) return null; // Discord nickname limit is 32
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  if (!ok) return null;
  return name;
}

// Track who has already uploaded a screenshot (per runtime)
const screenshotDone = new Map(); // userId -> true

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // REQUIRED to read message attachments reliably in many setups
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    // reset state for safety
    screenshotDone.delete(member.id);

    await channel.send({
      content:
`👋 Welcome ${member}!

Please upload a screenshot of your **Rise of Kingdoms profile** here. After you’re done, the bot will detect it and let you continue to unlock the server.`
    });
  } catch (e) {
    console.error("GuildMemberAdd error:", e);
  }
});

// Detect screenshot upload (any image)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (message.channel.id !== WELCOME_CHANNEL_ID) return;

    // Must be an image attachment
    const hasImage = message.attachments.some((att) => {
      // contentType can be null sometimes; also fallback to file extension
      if (att.contentType?.startsWith("image/")) return true;
      const name = (att.name || "").toLowerCase();
      return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp") || name.endsWith(".gif");
    });

    if (!hasImage) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    // If already verified, ignore
    if (member.roles.cache.has(MEMBER_ROLE_ID)) return;

    // Only do this once per user (per runtime)
    if (screenshotDone.get(message.author.id)) return;

    screenshotDone.set(message.author.id, true);

    const button = new ButtonBuilder()
      .setCustomId(`verify_ingame:${message.author.id}`)
      .setLabel("Enter In-Game Name")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await message.reply({
      content:
`Great! Click the button below to enter your **exact in-game name** to get a role and unlock the server.`,
      components: [row]
    });
  } catch (e) {
    console.error("MessageCreate error:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button -> show modal
    if (interaction.isButton()) {
      const [key, targetId] = interaction.customId.split(":");
      if (key !== "verify_ingame") return;

      // Only the correct user can use their button
      if (interaction.user.id !== targetId) {
        return interaction.reply({ content: "This button isn’t for you.", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ingame_modal:${interaction.user.id}`)
        .setTitle("Rise of Kingdoms Verification");

      const input = new TextInputBuilder()
        .setCustomId("ingame_name")
        .setLabel("Your RoK in-game name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Modal submit -> rename + role + remove button
    if (interaction.isModalSubmit()) {
      const [key, userId] = interaction.customId.split(":");
      if (key !== "ingame_modal") return;

      if (interaction.user.id !== userId) {
        return interaction.reply({ content: "This form isn’t for you.", ephemeral: true });
      }

      const member = interaction.member; // GuildMember
      if (!member) {
        return interaction.reply({ content: "❌ Could not find your server member record.", ephemeral: true });
      }

      // Stop if already verified
      if (member.roles.cache.has(MEMBER_ROLE_ID)) {
        // Remove the button if present
        if (interaction.message) {
          await interaction.message.edit({ components: [] }).catch(() => {});
        }
        return interaction.reply({ content: "✅ You are already verified.", ephemeral: true });
      }

      const raw = interaction.fields.getTextInputValue("ingame_name");
      const name = sanitizeName(raw);
      if (!name) {
        return interaction.reply({
          content: "❌ Invalid name. Use 2–32 chars (letters/numbers/spaces and basic symbols). Try again.",
          ephemeral: true
        });
      }

      // Check permissions
      const me = await member.guild.members.fetchMe();
      if (
        !me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({
          content: "❌ I’m missing permissions (Manage Nicknames / Manage Roles). Ask an admin to fix my permissions.",
          ephemeral: true
        });
      }

      // Rename
      await member.setNickname(name).catch(() => {
        throw new Error("Failed to set nickname. Ensure my role is above the member and I have Manage Nicknames.");
      });

      // Add role
      await member.roles.add(MEMBER_ROLE_ID).catch(() => {
        throw new Error("Failed to add role. Ensure my role is above the target role and I have Manage Roles.");
      });

      // ✅ Hide the button (remove components from the button message)
      if (interaction.message) {
        await interaction.message.edit({ components: [] }).catch(() => {});
      }

      return interaction.reply({
        content: `✅ All set, ${interaction.user}! Your role is added. Enjoy the server!`,
        ephemeral: true
      });
    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "❌ Something went wrong. Ask an admin to check bot permissions/role order.",
          ephemeral: true
        });
      } catch {}
    }
  }
});

client.login(TOKEN);
