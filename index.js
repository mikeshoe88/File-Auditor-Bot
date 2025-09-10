// 🐟 Catfish Slack Bot – PDF uploader + ✅ reaction → Pipedrive note (Socket Mode)
// Requirements (add in Slack app):
//  Scopes: reactions:read, channels:history, groups:history, channels:read, groups:read, files:read, chat:write, users:read
//  Events: reaction_added, file_shared (some workspaces also send message.subtype=file_share; we handle that too)
//  Env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN, PIPEDRIVE_API_TOKEN
//  Optional Env: DISPATCHER_BOT_USER_ID (to only ignore PDFs uploaded by Dispatcher)

const { App } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const https = require('https');
const path = require('path');

// ---- Config ---------------------------------------------------------------
const DISPATCHER_BOT_USER_ID = process.env.DISPATCHER_BOT_USER_ID || null;
const REACTION_UPLOAD_FILES = (process.env.REACTION_UPLOAD_FILES || 'true').toLowerCase() !== 'false';

// Narrow ignore: only skip Dispatcher-generated WOs, not human "Work Order" PDFs
const IGNORE_FILE_REGEX = /^(WO_|Completed Work Order)/i; // <— narrower
const IGNORE_COMMENT_REGEX = /(Completed Work Order|AID:\d+)/i;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

// ---- Utils ----------------------------------------------------------------
function extractDealIdFromChannelName(name = '') {
  const m = String(name).match(/deal(\d+)/i);
  return m ? m[1] : null;
}

async function downloadFile(fileUrl, token) {
  const filePath = `/tmp/${Date.now()}-${path.basename(fileUrl.split('?')[0])}`;
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

async function uploadFileToPipedrive(dealId, filePath, fileName) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), fileName);
  form.append('deal_id', dealId);
  const { data } = await axios.post(
    `https://api.pipedrive.com/v1/files?api_token=${process.env.PIPEDRIVE_API_TOKEN}`,
    form,
    { headers: form.getHeaders() }
  );
  return data;
}

async function postNoteToPipedrive(dealId, content) {
  const { data } = await axios.post(
    `https://api.pipedrive.com/v1/notes?api_token=${process.env.PIPEDRIVE_API_TOKEN}`,
    { content, deal_id: dealId },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return data;
}

function buildNoteFromSlack({ channelName, reactorName, authorName, ts, permalink, text, attachmentsList }) {
  const when = new Date(Number(String(ts).split('.')[0]) * 1000).toLocaleString();
  const bodyLines = [];
  if (text && text.trim()) bodyLines.push(text.trim());
  if (attachmentsList && attachmentsList.length) {
    bodyLines.push('', 'Attachments:', ...attachmentsList.map(s => `• ${s}`));
  }
  const body = bodyLines.join('\n');
  return (
`Slack note (via ✅ by ${reactorName})
Channel: #${channelName}
Author: ${authorName}
When: ${when}
Link: ${permalink}

${body}`.trim()
  );
}

// ---- PDF Upload on file share --------------------------------------------
async function handleFileShared({ fileId, channelId, client, botUserId, botToken }) {
  const fileInfo = await client.files.info({ file: fileId });
  const file = fileInfo.file;

  if (!file) return;

  // Only skip if the uploader is Dispatcher AND it matches our ignore patterns
  const uploadedByDispatcher = DISPATCHER_BOT_USER_ID && file.user === DISPATCHER_BOT_USER_ID;
  if (uploadedByDispatcher) {
    if (IGNORE_FILE_REGEX.test(file.name) || IGNORE_FILE_REGEX.test(file.title)) {
      console.log(`⏭️ Skipping Dispatcher WO PDF: ${file.name}`);
      return;
    }
    if (file.initial_comment && IGNORE_COMMENT_REGEX.test(file.initial_comment)) {
      console.log(`⏭️ Skipping based on Dispatcher comment: ${file.initial_comment}`);
      return;
    }
  }

  if (file.filetype !== 'pdf') {
    console.log(`⏭️ Skipping non-PDF: ${file.name}`);
    return;
  }

  const channelInfo = await client.conversations.info({ channel: channelId });
  const channelName = channelInfo.channel?.name;
  const dealId = extractDealIdFromChannelName(channelName);
  if (!dealId) {
    console.log(`❌ No deal number in channel name: ${channelName}`);
    await client.chat.postMessage({
      channel: channelId,
      text: `❌ Could not find a deal number in channel name "${channelName}". Make sure it includes "dealXX".`
    });
    return;
  }

  const tmpPath = await downloadFile(file.url_private_download, botToken);
  const renamed = `Scope - ${channelName.replace(/-/g, ' ')}.pdf`;

  await uploadFileToPipedrive(dealId, tmpPath, renamed);
  console.log(`✅ Uploaded ${renamed} to PD deal ${dealId}`);

  await client.chat.postMessage({ channel: channelId, text: `✅ Uploaded *${renamed}* to Pipedrive deal #${dealId}` });

  try { fs.unlinkSync(tmpPath); } catch {}
}

// Some workspaces only emit message.subtype=file_share; cover both
app.event('file_shared', async ({ event, client, context }) => {
  try {
    console.log('📁 file_shared:', JSON.stringify(event));
    const channelId = event.channel_id || (event.item && event.item.channel) || null;
    const fileId = event.file_id;
    if (!fileId) return;
    await handleFileShared({ fileId, channelId, client, botUserId: context.botUserId, botToken: context.botToken });
  } catch (err) {
    console.error('❌ file_shared handler error:', err);
  }
});

app.event('message', async ({ event, client, context }) => {
  try {
    if (event.subtype !== 'file_share' || !event.files?.length) return;
    const channelId = event.channel;
    for (const f of event.files) {
      await handleFileShared({ fileId: f.id, channelId, client, botUserId: context.botUserId, botToken: context.botToken });
    }
  } catch (err) {
    console.error('❌ message.file_share handler error:', err);
  }
});

// ---- ✅ Reaction → Pipedrive note ----------------------------------------
const PD_NOTE_REACTIONS = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check']);
const noteDedupe = new Map(); // key: channel:ts → ts
function recentlyNoted(key, ms = 5 * 60 * 1000) {
  const t = noteDedupe.get(key);
  return t && (Date.now() - t < ms);
}

app.event('reaction_added', async ({ event, client, context }) => {
  try {
    if (!PD_NOTE_REACTIONS.has(event.reaction)) return;

    const channelId = event.item?.channel;
    const ts = event.item?.ts;
    if (!channelId || !ts) return;

    const cacheKey = `${channelId}:${ts}`;
    if (recentlyNoted(cacheKey)) return;

    const ch = await client.conversations.info({ channel: channelId });
    const channelName = ch.channel?.name || '';
    const dealId = extractDealIdFromChannelName(channelName);
    if (!dealId) {
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `⚠️ Channel name must include “deal123”.` });
      return;
    }

    const hist = await client.conversations.history({ channel: channelId, latest: ts, inclusive: true, limit: 1 });
    const msg = hist.messages?.[0];
    if (!msg) return;

    const [authorInfo, reactorInfo, linkRes] = await Promise.all([
      msg.user ? client.users.info({ user: msg.user }).catch(() => null) : null,
      client.users.info({ user: event.user }).catch(() => null),
      client.chat.getPermalink({ channel: channelId, message_ts: ts }).catch(() => null)
    ]);
    const authorName = authorInfo?.user?.real_name || authorInfo?.user?.profile?.display_name || (msg.user ? `<@${msg.user}>` : 'unknown');
    const reactorName = reactorInfo?.user?.real_name || reactorInfo?.user?.profile?.display_name || `<@${event.user}>`;
    const permalink = linkRes?.permalink;

    // Collect attachment names, optionally upload them too
    const attachmentsList = [];
    if (Array.isArray(msg.files) && msg.files.length) {
      for (const f of msg.files) attachmentsList.push(`${f.name} (${f.filetype})`);

      if (REACTION_UPLOAD_FILES) {
        for (const f of msg.files) {
          try {
            const tmp = await downloadFile(f.url_private_download, context.botToken);
            await uploadFileToPipedrive(dealId, tmp, f.name);
            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) {
            console.warn('⚠️ failed to upload attachment from reaction:', f.name, e?.message || e);
          }
        }
      }
    }

    const content = buildNoteFromSlack({
      channelName,
      reactorName,
      authorName,
      ts,
      permalink,
      text: msg.text || '',
      attachmentsList
    });

    // Optional: dedupe by checking recent notes for the permalink (simple, best-effort)
    try {
      const { data: recent } = await axios.get(`https://api.pipedrive.com/v1/notes?deal_id=${dealId}&limit=20&start=0&api_token=${process.env.PIPEDRIVE_API_TOKEN}`);
      if (recent?.data?.some(n => (n.content || '').includes(permalink))) {
        await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `ℹ️ Already added to Pipedrive.` });
        return;
      }
    } catch {}

    const noteRes = await postNoteToPipedrive(dealId, content);
    if (noteRes?.success) {
      noteDedupe.set(cacheKey, Date.now());
      await client.reactions.add({ channel: channelId, name: 'white_check_mark', timestamp: ts }).catch(() => {});
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `✅ Sent to Pipedrive deal *${dealId}*.` });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: ts, text: `⚠️ Failed to send to Pipedrive: ${noteRes?.error || 'unknown error'}` });
    }
  } catch (err) {
    console.error('❌ reaction_added handler error:', err);
  }
});

// ---- Start ---------------------------------------------------------------
(async () => {
  await app.start();
  console.log('⚡️ Catfish Slack Bot is running.');
})();
