// Trello → Sprout Social Webhook Handler
// Triggered when a Trello card is moved to the "Push to Sprout" list.
// Reads the card's custom fields and attachments, then creates a draft
// post in Sprout Social.

const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');

// Tell Vercel NOT to parse the body automatically.
// We need the raw bytes to verify Trello's HMAC-SHA1 signature.
module.exports.config = {
  api: { bodyParser: false },
};

// ---------------------------------------------------------------------------
// HARDCODED CONFIG (field names — do not move to env vars)
// ---------------------------------------------------------------------------
const TRELLO_FIELDS = {
  postCopy:      'Post Copy',
  scheduledDate: 'Scheduled Date',
  channel:       'Channel',
};

const TRIGGER_LIST_NAME = 'Push to Sprout';

// PROFILE_MAP: maps Trello "Channel" option labels to Sprout customer_profile_ids.
// Option labels must exactly match what is configured in the Trello custom field.
// To find profile IDs:
//   GET https://api.sproutsocial.com/v1/<SPROUT_CUSTOMER_ID>/metadata/customer
const PROFILE_MAP = {
  // Instagram
  'Instagram':           7480412, // @thelocalproject (fb_instagram_account)

  // Facebook
  'Facebook':            7480411, // The Local Project
  'Facebook Production': 7443935, // The Local Production

  // LinkedIn
  'LinkedIn':            7471923, // The Local Project
  'LinkedIn Production': 7471922, // The Local Production

  // Other platforms
  'Pinterest':           7471920, // @thelocalproject
  'TikTok':              7471921, // @thelocalproject
  'YouTube':             7471924, // The Local Project
};

// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES (never hardcode these)
// ---------------------------------------------------------------------------
const TRELLO_API_KEY             = process.env.TRELLO_API_KEY;
const TRELLO_API_TOKEN           = process.env.TRELLO_API_TOKEN;
const TRELLO_API_SECRET          = process.env.TRELLO_API_SECRET;
const TRELLO_WEBHOOK_CALLBACK_URL = process.env.TRELLO_WEBHOOK_CALLBACK_URL;
const SPROUT_API_TOKEN           = process.env.SPROUT_API_TOKEN;
const SPROUT_CUSTOMER_ID         = process.env.SPROUT_CUSTOMER_ID;
const SPROUT_GROUP_ID            = process.env.SPROUT_GROUP_ID;

// ---------------------------------------------------------------------------
// HELPER: Validate Trello HMAC-SHA1 webhook signature
// Trello signs requests as base64(HMAC-SHA1(apiSecret, rawBody + callbackUrl))
// and sends the result in the X-Trello-Webhook header.
// ---------------------------------------------------------------------------
function validateTrelloSignature(rawBody, signature) {
  const content = rawBody + TRELLO_WEBHOOK_CALLBACK_URL;
  const hash = crypto.createHmac('sha1', TRELLO_API_SECRET).update(content).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false; // Lengths differ — definitely invalid
  }
}

// ---------------------------------------------------------------------------
// HELPER: Trello REST API GET with key/token auth
// ---------------------------------------------------------------------------
async function trelloGet(path) {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set('key', TRELLO_API_KEY);
  url.searchParams.set('token', TRELLO_API_TOKEN);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Trello API error (${res.status}) for ${path}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// HELPER: Download a Trello attachment (private boards require OAuth header)
// ---------------------------------------------------------------------------
async function downloadTrelloAttachment(attachmentUrl) {
  const res = await fetch(attachmentUrl, {
    headers: {
      Authorization: `OAuth oauth_consumer_key="${TRELLO_API_KEY}", oauth_token="${TRELLO_API_TOKEN}"`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attachment download failed (${res.status}): ${body}`);
  }
  return res.buffer();
}

// ---------------------------------------------------------------------------
// HELPER: Upload image bytes to Sprout Social and return media_id
// ---------------------------------------------------------------------------
async function uploadImageToSprout(imageBuffer, filename) {
  const form = new FormData();
  form.append('media', imageBuffer, { filename: filename || 'image.jpg' });

  const res = await fetch(
    `https://api.sproutsocial.com/v1/${SPROUT_CUSTOMER_ID}/media/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SPROUT_API_TOKEN}`,
        ...form.getHeaders(),
      },
      body: form,
    }
  );

  if (res.status === 429) {
    const body = await res.text();
    throw new Error(`Sprout rate limit (429) on media upload: ${body}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sprout media upload failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  // Response shape: { data: [{ media_id: "<uuid>", expiration_time: "..." }] }
  const mediaId = json?.data?.[0]?.media_id;
  if (!mediaId) {
    throw new Error(`Sprout media upload returned no media ID: ${JSON.stringify(json)}`);
  }
  return mediaId;
}

// ---------------------------------------------------------------------------
// HELPER: Detect Sprout media type from filename extension
// ---------------------------------------------------------------------------
function getSproutMediaType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'VIDEO';
  if (ext === 'gif') return 'GIF';
  return 'PHOTO';
}

// ---------------------------------------------------------------------------
// HELPER: Create a draft post in Sprout Social
// ---------------------------------------------------------------------------
async function createSproutPost(text, scheduledTime, uploadedMedia, profileIds) {
  const payload = {
    is_draft: true,
    text,
    customer_profile_ids: profileIds,
    group_id: Number(SPROUT_GROUP_ID),
  };

  // Only schedule if a valid future time was provided
  if (scheduledTime) {
    payload.scheduled_send_time = scheduledTime;
  }

  // Only attach media if assets were uploaded
  if (uploadedMedia && uploadedMedia.length > 0) {
    payload.media = uploadedMedia.map(({ mediaId, filename }) => ({
      media_id: mediaId,
      media_type: getSproutMediaType(filename),
    }));
  }

  const res = await fetch(
    `https://api.sproutsocial.com/v1/${SPROUT_CUSTOMER_ID}/publishing/posts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SPROUT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  if (res.status === 429) {
    const body = await res.text();
    throw new Error(`Sprout rate limit (429) on post creation: ${body}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sprout post creation failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
async function handler(req, res) {
  // Trello sends HEAD to verify the endpoint is reachable during webhook registration
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // STEP 1: Read raw body and validate Trello HMAC-SHA1 signature
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const signature = req.headers['x-trello-webhook'];
    if (!signature) {
      console.warn('STEP 1: Missing x-trello-webhook signature header');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!validateTrelloSignature(rawBody, signature)) {
      console.warn('STEP 1: Invalid Trello webhook signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log('STEP 1: Trello webhook signature validated');

    const body = JSON.parse(rawBody);

    // STEP 2: Check this is a card moved to the trigger list
    const action = body?.action;
    const listAfterName = action?.data?.listAfter?.name;
    if (action?.type !== 'updateCard' || listAfterName !== TRIGGER_LIST_NAME) {
      console.log(`STEP 2: Not a "${TRIGGER_LIST_NAME}" move — skipping (type=${action?.type}, listAfter="${listAfterName}")`);
      return res.status(200).json({ status: 'no-op' });
    }

    const cardId  = action.data.card.id;
    const boardId = action.data.board.id;
    console.log(`STEP 2: Card ${cardId} moved to "${TRIGGER_LIST_NAME}" on board ${boardId}`);

    // STEP 3: Fetch board custom field definitions (names, types, and dropdown options)
    console.log('STEP 3: Fetching board custom fields...');
    const boardCustomFields = await trelloGet(`/boards/${boardId}/customFields`);

    // Build fieldDefs: { fieldId → { name, type, options: { optionId → label } } }
    const fieldDefs = {};
    for (const cf of boardCustomFields) {
      const options = {};
      if (cf.type === 'list' && Array.isArray(cf.options)) {
        for (const opt of cf.options) {
          options[opt.id] = opt.value?.text ?? '';
        }
      }
      fieldDefs[cf.id] = { name: cf.name, type: cf.type, options };
    }
    console.log(`STEP 3: Found ${Object.keys(fieldDefs).length} custom field(s): ${Object.values(fieldDefs).map((d) => d.name).join(', ')}`);

    // STEP 4: Fetch card custom field values
    console.log('STEP 4: Fetching card custom field items...');
    const customFieldItems = await trelloGet(`/cards/${cardId}/customFieldItems`);

    // Resolve each item's value and build a name → value map
    const fields = {};
    for (const item of customFieldItems) {
      const def = fieldDefs[item.idCustomField];
      if (!def) continue;

      let value = null;
      switch (def.type) {
        case 'text':     value = item.value?.text    ?? null; break;
        case 'date':     value = item.value?.date    ?? null; break;
        case 'number':   value = item.value?.number  ?? null; break;
        case 'checkbox': value = item.value?.checked ?? null; break;
        case 'list':     value = def.options[item.idValue] ?? null; break;
      }
      fields[def.name] = value;
    }

    // STEP 5: Extract and validate field values
    console.log('STEP 5: Extracting fields...');

    const postText = fields[TRELLO_FIELDS.postCopy] ?? '';

    // "Scheduled Date" — create unscheduled draft if missing or in the past
    const rawDate = fields[TRELLO_FIELDS.scheduledDate] ?? null;
    let scheduledTime = null;
    if (rawDate) {
      const scheduled = new Date(rawDate);
      if (isNaN(scheduled.getTime())) {
        console.warn(`STEP 5: "Scheduled Date" could not be parsed: ${rawDate}`);
      } else if (scheduled <= new Date()) {
        console.warn(`STEP 5: "Scheduled Date" is in the past (${rawDate}) — creating unscheduled draft`);
      } else {
        scheduledTime = scheduled.toISOString();
      }
    } else {
      console.warn('STEP 5: "Scheduled Date" is empty — creating unscheduled draft');
    }

    // "Channel" — map single dropdown value to Sprout profile ID(s)
    let profileIds = Object.values(PROFILE_MAP); // default: all profiles
    const channelValue = fields[TRELLO_FIELDS.channel];
    if (channelValue) {
      const profileId = PROFILE_MAP[channelValue];
      if (profileId !== undefined) {
        profileIds = [profileId];
      } else {
        console.warn(`STEP 5: Channel "${channelValue}" not found in PROFILE_MAP — using all profiles`);
      }
    }

    console.log(`STEP 5: postText="${postText.substring(0, 80)}...", scheduledTime=${scheduledTime}, channel="${channelValue}", profileIds=${JSON.stringify(profileIds)}`);

    // STEP 6: Fetch card attachments and upload images to Sprout
    console.log('STEP 6: Fetching card attachments...');
    const attachments = await trelloGet(`/cards/${cardId}/attachments`);
    // Only process files uploaded directly to Trello (skip external URL links)
    const imageAttachments = attachments.filter((a) => a.isUpload);

    const uploadedMedia = [];
    if (imageAttachments.length > 0) {
      console.log(`STEP 6: Uploading ${imageAttachments.length} attachment(s) to Sprout...`);
      for (const attachment of imageAttachments) {
        const filename = attachment.name || 'image.jpg';
        const imageBuffer = await downloadTrelloAttachment(attachment.url);
        console.log(`STEP 6: Downloaded "${filename}" (${imageBuffer.length} bytes). Uploading...`);
        const mediaId = await uploadImageToSprout(imageBuffer, filename);
        console.log(`STEP 6: Uploaded "${filename}" → media_id=${mediaId}`);
        uploadedMedia.push({ mediaId, filename });
      }
    } else {
      console.log('STEP 6: No uploaded attachments — skipping image upload');
    }

    // STEP 7/8: Create draft post in Sprout Social
    console.log('STEP 7/8: Creating Sprout draft post...');
    const sproutResult = await createSproutPost(postText, scheduledTime, uploadedMedia, profileIds);
    console.log(`STEP 8: Sprout post created: ${JSON.stringify(sproutResult)}`);

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('ERROR:', err.message);
    // Always return 200 to prevent Trello from retrying the webhook
    return res.status(200).json({ status: 'error', message: err.message });
  }
}

module.exports = handler;
