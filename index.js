// 🐟 Catfish Slack Bot – PDF to Pipedrive Uploader

const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');

// ExpressReceiver lets us share a single web server with Bolt + Express
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events'
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: false
});

// --- Slack Events URL verification handler
receiver.app.post('/slack/events', express.json(), (req, res) => {
  if (req.body && req.body.type === 'url_verification') {
    return res.send({ challenge: req.body.challenge });
  }
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
    const channelId = file?.channels?.[0] || event.channel_id;
    console.log("📺 Channel ID:", channelId);
    if (!channelId) return;

    const channelInfo = await client.conversations.info({ channel: channelId });
    const channelName = channelInfo.channel.name;
    console.log("📛 Channel Name:", channelName);

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
    console.log("🔢 Matched Deal ID:", dealId);

    const filePath = await downloadFile(file.url_private_download, context.botToken);
    const renamedFileName = `Scope - ${channelName.replace(/-/g, ' ')}.pdf`;
    console.log("📂 Downloaded and renamed:", renamedFileName);

    await uploadToPipedrive(dealId, filePath, renamedFileName);
    console.log("✅ Uploaded to Pipedrive");

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

// --- Add homepage route
receiver.app.get('/', (req, res) => {
  res.send('Catfish Slack Bot is alive! 🐟');
});

// --- Custom domain route for Railway health check
receiver.app.get('/health', (req, res) => {
  res.send('Healthy on file-auditor-bot-production.up.railway.app ✅');
});

// --- Start Express server (only this one!)
const PORT = process.env.PORT || 3000;
receiver.app.listen(PORT, () => {
  console.log(`⚡️ Catfish Slack Bot is running on port ${PORT}`);
});
