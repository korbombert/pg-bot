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

// Simple file-based database (JSON)
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json');
const db = low(adapter);

// Set default DB schema
db.defaults({ users: [] }).write();

// Helper functions for DB access
function getUser(userId) {
  let user = db.get('users').find({ id: userId }).value();
  if (!user) {
    user = { id: userId, points: 0, gems: 0 };
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

// Initialize Discord Client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your current points and gems balance')
    .addUserOption(option => 
      option.setName('target')
            .setDescription('Check another user\'s balance')
            .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Manager command: Add or remove points from a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // Fallback Discord permission
    .addSubcommand(sub =>
      sub.setName('add')
         .setDescription('Add points to a user')
         .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
         .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of points').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
         .setDescription('Remove points from a user')
         .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
         .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of points').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('store')
    .setDescription('Get the website link to purchase Gems via Xsolla')
];

// Register Slash Commands with Discord
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully!');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
}

// Bot Interaction Listener
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 1. /balance
  if (commandName === 'balance') {
    const targetUser = interaction.options.getUser('target') || interaction.user;
    const balance = getUser(targetUser.id);

    const embed = new EmbedBuilder()
      .setTitle(`Balance for ${targetUser.username}`)
      .setColor(0x5865F2)
      .addFields(
        { name: 'Points', value: `⭐ ${balance.points}`, inline: true },
        { name: 'Gems', value: `💎 ${balance.gems}`, inline: true }
      )
      .setThumbnail(targetUser.displayAvatarURL());

    return interaction.reply({ embeds: [embed] });
  }

  // 2. /points (Manager only)
  if (commandName === 'points') {
    // Role check: Ensure user has the manager role
    const managerRoleId = process.env.MANAGER_ROLE_ID;
    const hasRole = interaction.member.roles.cache.has(managerRoleId);

    if (!hasRole && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ 
        content: '❌ You do not have the required Point Manager role to execute this command.', 
        ephemeral: true 
      });
    }

    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (amount <= 0) {
      return interaction.reply({ content: 'Amount must be greater than 0.', ephemeral: true });
    }

    if (sub === 'add') {
      const updated = updateBalance(target.id, amount, 0);
      return interaction.reply(`✅ Added **${amount} points** to ${target}. New balance: **${updated.points} points**.`);
    } else if (sub === 'remove') {
      const updated = updateBalance(target.id, -amount, 0);
      return interaction.reply(`✅ Removed **${amount} points** from ${target}. New balance: **${updated.points} points**.`);
    }
  }

  // 3. /store
  if (commandName === 'store') {
    const websiteUrl = process.env.WEBSITE_URL || 'https://your-domain.railway.app';
    return interaction.reply({
      content: `💎 Visit our web shop to purchase Gems: ${websiteUrl}?user_id=${interaction.user.id}`,
      ephemeral: true
    });
  }
});

// Initialize Express App
const app = express();
app.use(express.json());

// Basic Home Page Route
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

// Xsolla Webhook Handler
app.post('/webhook/xsolla', (req, res) => {
  const xsollaSignature = req.headers['authorization'];
  const webhookPayload = JSON.stringify(req.body);

  // Xsolla SHA-1 Signature Verification: SHA1(JSON Payload + Secret Key)
  const expectedSignature = 'Signature ' + crypto
    .createHash('sha1')
    .update(webhookPayload + process.env.XSOLLA_SECRET_KEY)
    .digest('hex');

  // Verify signature (Disable during initial sandbox testing if signature fails)
  if (xsollaSignature !== expectedSignature) {
    console.warn('Xsolla Webhook verification failed.');
    return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature mismatch' } });
  }

  const { notification_type, user, purchase } = req.body;

  // Handle user validation webhook from Xsolla
  if (notification_type === 'user_validation') {
    return res.status(200).end();
  }

  // Handle successful payment webhook
  if (notification_type === 'payment') {
    const discordUserId = user ? user.id : null;
    
    // Amount of gems passed via custom purchase payload or SKU multiplier
    const gemsPurchased = purchase && purchase.virtual_currency ? purchase.virtual_currency.quantity : 100;

    if (discordUserId) {
      updateBalance(discordUserId, 0, gemsPurchased);
      console.log(`[Xsolla] Successfully credited ${gemsPurchased} gems to Discord user ${discordUserId}`);
      
      // Optional: Send a direct message to user on Discord
      client.users.fetch(discordUserId).then(userObj => {
        userObj.send(`🎉 Payment successful! **${gemsPurchased} Gems** have been credited to your account.`).catch(() => {});
      }).catch(() => {});
    }

    return res.status(200).end();
  }

  return res.status(200).end();
});

// Start Server & Client
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(process.env.DISCORD_TOKEN);