// 🐟 Catfish Slack Bot – PDF to Pipedrive Uploader (Socket Mode Version)

const { App } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const https = require('https');
const path = require('path');

// Regex to ignore Dispatcher-generated work orders
const IGNORE_FILE_REGEX = /(WO_|Work Order|Completed Work Order)/i;
const IGNORE_COMMENT_REGEX = /(Completed Work Order|AID:\d+)/i;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

// --- Utility: Download file from Slack
async function downloadFile(fileUrl, token) {
  const filePath = `/tmp/${Date.now()}-${path.basename(fileUrl)}`;
  const writer = fs.createWriteStream(filePath);
  const response = await axios({
    url: fileUrl,
    method: 'GET',
    responseType: 'stream',
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filePath));
    writer.on('error', reject);
  });
}

// --- Utility: Upload to Pipedrive
async function uploadToPipedrive(dealId, filePath, fileName) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), fileName);
  form.append('deal_id', dealId);
  const response = await axios.post(
    `https://api.pipedrive.com/v1/files?api_token=${process.env.PIPEDRIVE_API_TOKEN}`,
    form,
    { headers: form.getHeaders() }
  );
  return response.data;
}

// --- Handle file uploads
app.event('file_shared', async ({ event, client, context }) => {
  console.log("📁 Received file_shared event:", JSON.stringify(event, null, 2));
  try {
    const fileInfo = await client.files.info({ file: event.file_id });
    console.log("ℹ️ File Info:", JSON.stringify(fileInfo, null, 2));
    const file = fileInfo.file;

    // 🛑 Skip non-PDFs
    if (file.filetype !== 'pdf') {
      console.log(`Skipping non-PDF file: ${file.name}`);
      return;
    }

    // 🛑 Skip files uploaded by Catfish itself
    if (file.user === context.botUserId) {
      console.log("Skipping own uploaded file.");
      return;
    }

    // 🛑 Skip Dispatcher-generated work orders
    if (IGNORE_FILE_REGEX.test(file.name) || IGNORE_FILE_REGEX.test(file.title)) {
      console.log(`Skipping Dispatcher WO PDF: ${file.name}`);
      return;
    }
    if (file.initial_comment && IGNORE_COMMENT_REGEX.test(file.initial_comment)) {
      console.log(`Skipping based on comment: ${file.initial_comment}`);
      return;
    }

    const channelId = file?.channels?.[0] || event.channel_id;
    if (!channelId) return;

    const channelInfo = await client.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel.name;

    const dealMatch = channelName.match(/deal(\d+)/i);
    if (!dealMatch) {
      console.log(`❌ No deal number in channel name: ${channelName}`);
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Could not find a deal number in channel name "${channelName}". Make sure it includes "dealXX".`
      });
      return;
    }

    const dealId = dealMatch[1];
    const filePath = await downloadFile(file.url_private_download, context.botToken);
    const renamedFileName = `Scope - ${channelName.replace(/-/g, ' ')}.pdf`;

    await uploadToPipedrive(dealId, filePath, renamedFileName);
    console.log("✅ Uploaded scope to Pipedrive");

    await client.chat.postMessage({
      channel: channelId,
      text: `✅ Uploaded *${renamedFileName}* to Pipedrive deal #${dealId}`
    });

    fs.unlinkSync(filePath);
    console.log("🧹 Cleaned up temp file");
  } catch (err) {
    console.error('❌ Error handling file_shared:', err);
  }
});

// --- Start the bot
(async () => {
  await app.start();
  console.log('⚡️ Catfish Slack Bot is running.');
})();
