require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits,
  EmbedBuilder
} = require('discord.js');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

// ==========================================
// 1. CONFIGURATION & MODULAR SETTINGS
// ==========================================
const config = {
  colors: {
    primary: 0x5865F2, // Blurple
    success: 0x57F287, // Green
    error: 0xED4245,   // Red
    warning: 0xFEE75C  // Yellow
  },
  emojis: {
    points: '',
    gems: ''
  },
  economy: {
    dailyReward: 50,
    dailyCooldownHours: 24
  },
  roles: {
    managerId: process.env.MANAGER_ROLE_ID // Defined in your environment variables
  }
};

// ==========================================
// 2. DATABASE SETUP (RAILWAY VOLUMES)
// ==========================================
// Railway persistent volumes should be mapped to a folder like /data
// If DATA_PATH is set in Railway, use it. Otherwise, default to local directory.
const dbFolder = process.env.DATA_PATH || __dirname;
const dbFile = path.join(dbFolder, 'db.json');

const adapter = new FileSync(dbFile);
const db = low(adapter);

// Set default DB schema
db.defaults({ users: [] }).write();

// Helper functions for DB access
function getUser(userId) {
  let user = db.get('users').find({ id: userId }).value();
  if (!user) {
    user = { id: userId, points: 0, gems: 0, lastDaily: null };
    db.get('users').push(user).write();
  }
  return user;
}

function updateBalance(userId, pointsDelta = 0, gemsDelta = 0) {
  const user = getUser(userId);
  const newPoints = Math.max(0, user.points + pointsDelta);
  const newGems = Math.max(0, user.gems + gemsDelta);
  
  db.get('users')
    .find({ id: userId })
    .assign({ points: newPoints, gems: newGems })
    .write();

  return { points: newPoints, gems: newGems };
}

function getTopUsers(limit = 5) {
  return db.get('users')
    .orderBy('points', 'desc')
    .take(limit)
    .value();
}

// ==========================================
// 3. EMBED UTILITIES
// ==========================================
const embeds = {
  success: (desc) => new EmbedBuilder().setColor(config.colors.success).setDescription(`${desc}`),
  error: (desc) => new EmbedBuilder().setColor(config.colors.error).setDescription(`${desc}`),
  info: (title, desc) => new EmbedBuilder().setColor(config.colors.primary).setTitle(title).setDescription(desc || null),
};

// ==========================================
// 4. COMMAND DEFINITIONS & LOGIC
// ==========================================
const commandList = [
  {
    data: new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Check your current points and gems balance')
      .addUserOption(opt => opt.setName('target').setDescription("Check another user's balance")),
    async execute(interaction) {
      const targetUser = interaction.options.getUser('target') || interaction.user;
      const balance = getUser(targetUser.id);

      const embed = embeds.info(`${targetUser.username}'s Balance`)
        .addFields(
          { name: 'Points', value: `${config.emojis.points} ${balance.points}`, inline: true },
          { name: 'Gems', value: `${config.emojis.gems} ${balance.gems}`, inline: true }
        )
        .setThumbnail(targetUser.displayAvatarURL());

      return interaction.reply({ embeds: [embed] });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('daily')
      .setDescription('Claim your daily points!'),
    async execute(interaction) {
      const user = getUser(interaction.user.id);
      const now = Date.now();
      const cooldownMs = config.economy.dailyCooldownHours * 60 * 60 * 1000;

      if (user.lastDaily && (now - user.lastDaily) < cooldownMs) {
        const remainingHours = ((cooldownMs - (now - user.lastDaily)) / (1000 * 60 * 60)).toFixed(1);
        return interaction.reply({ 
          embeds: [embeds.error(`You have already claimed your daily reward. Come back in **${remainingHours} hours**.`)], 
          ephemeral: true 
        });
      }

      updateBalance(interaction.user.id, config.economy.dailyReward, 0);
      db.get('users').find({ id: interaction.user.id }).assign({ lastDaily: now }).write();

      return interaction.reply({ 
        embeds: [embeds.success(`You claimed your daily reward of **${config.economy.dailyReward} ${config.emojis.points}**!`)] 
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('pay')
      .setDescription('Give points to another user')
      .addUserOption(opt => opt.setName('user').setDescription('User to pay').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Amount to pay').setRequired(true)),
    async execute(interaction) {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const senderData = getUser(interaction.user.id);

      if (target.id === interaction.user.id) return interaction.reply({ embeds: [embeds.error("You can't pay yourself!")], ephemeral: true });
      if (amount <= 0) return interaction.reply({ embeds: [embeds.error("Amount must be greater than 0.")], ephemeral: true });
      if (senderData.points < amount) return interaction.reply({ embeds: [embeds.error("You don't have enough points!")], ephemeral: true });

      updateBalance(interaction.user.id, -amount, 0);
      updateBalance(target.id, amount, 0);

      return interaction.reply({ 
        embeds: [embeds.success(`Successfully sent **${amount} ${config.emojis.points}** to ${target}.`)] 
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the top 5 richest users'),
    async execute(interaction) {
      const topUsers = getTopUsers(5);
      if (topUsers.length === 0) return interaction.reply({ embeds: [embeds.info("Leaderboard", "No users found in the database yet.")] });

      let description = '';
      for (let i = 0; i < topUsers.length; i++) {
        description += `**${i + 1}.** <@${topUsers[i].id}> - ${topUsers[i].points} ${config.emojis.points}\n`;
      }

      return interaction.reply({ embeds: [embeds.info('Points Leaderboard', description)] });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('store')
      .setDescription('Get the website link to purchase Gems'),
    async execute(interaction) {
      const websiteUrl = process.env.WEBSITE_URL || 'https://your-domain.railway.app';
      return interaction.reply({
        embeds: [embeds.info('Store', `[Click here to visit our web shop to purchase Gems](${websiteUrl}?user_id=${interaction.user.id})`)],
        ephemeral: true
      });
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('points')
      .setDescription('Manager command: Add or remove points from a user')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(sub => sub.setName('add').setDescription('Add points').addUserOption(opt => opt.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove points').addUserOption(opt => opt.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true))),
    async execute(interaction) {
      const hasRole = interaction.member.roles.cache.has(config.roles.managerId);
      if (!hasRole && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ embeds: [embeds.error('You lack the required Manager role.')], ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (amount <= 0) return interaction.reply({ embeds: [embeds.error('Amount must be greater than 0.')], ephemeral: true });

      if (sub === 'add') {
        const updated = updateBalance(target.id, amount, 0);
        return interaction.reply({ embeds: [embeds.success(`Added **${amount} ${config.emojis.points}** to ${target}. New balance: **${updated.points}**.`)] });
      } else if (sub === 'remove') {
        const updated = updateBalance(target.id, -amount, 0);
        return interaction.reply({ embeds: [embeds.success(`Removed **${amount} ${config.emojis.points}** from ${target}. New balance: **${updated.points}**.`)] });
      }
    }
  }
];

// ==========================================
// 5. DISCORD CLIENT SETUP
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commandsMap = new Map(commandList.map(c => [c.data.name, c]));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commandList.map(c => c.data.toJSON()) }
    );
    console.log('Slash commands registered successfully!');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const errEmbed = embeds.error('There was an error while executing this command!');
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errEmbed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

// ==========================================
// 6. EXPRESS SERVER & XSOLLA WEBHOOK
// ==========================================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  const userId = req.query.user_id || 'Not specified';
  res.send(`
    <html>
      <head><title>Gem Store</title></head>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1>💎 Buy Gems</h1>
        <p>Discord User ID: <strong>${userId}</strong></p>
        <p><em>Xsolla PayStation Checkout embed/button goes here.</em></p>
      </body>
    </html>
  `);
});

app.post('/webhook/xsolla', (req, res) => {
  const xsollaSignature = req.headers['authorization'];
  const webhookPayload = JSON.stringify(req.body);

  const expectedSignature = 'Signature ' + crypto
    .createHash('sha1')
    .update(webhookPayload + process.env.XSOLLA_SECRET_KEY)
    .digest('hex');

  if (xsollaSignature !== expectedSignature) {
    console.warn('Xsolla Webhook verification failed.');
    return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature mismatch' } });
  }

  const { notification_type, user, purchase } = req.body;

  if (notification_type === 'user_validation') {
    return res.status(200).end();
  }

  if (notification_type === 'payment') {
    const discordUserId = user ? user.id : null;
    const gemsPurchased = purchase && purchase.virtual_currency ? purchase.virtual_currency.quantity : 100;

    if (discordUserId) {
      updateBalance(discordUserId, 0, gemsPurchased);
      console.log(`[Xsolla] Credited ${gemsPurchased} gems to Discord user ${discordUserId}`);
      
      client.users.fetch(discordUserId).then(userObj => {
        const receiptEmbed = embeds.success(`Payment successful! **${gemsPurchased} ${config.emojis.gems}** have been credited to your account.`)
          .setTitle('Transaction Complete');
        userObj.send({ embeds: [receiptEmbed] }).catch(() => {});
      }).catch(() => {});
    }
  }

  return res.status(200).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Express Server running on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
