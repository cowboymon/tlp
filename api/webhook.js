// Notion → Sprout Social Webhook Handler
// Receives Notion automation webhooks and creates draft posts in Sprout Social.

const fetch = require('node-fetch');
const FormData = require('form-data');

// ---------------------------------------------------------------------------
// HARDCODED CONFIG (database IDs and field names — do not move to env vars)
// ---------------------------------------------------------------------------
const NOTION_DATABASE_ID = '3457a32b9003414dac5d86ca8c6e7b67';

const NOTION_FIELDS = {
  status: 'Status',
  postCopy: 'Post Copy',
  publishDate: 'Publish Date',
  socialAsset: 'Social Asset',
  network: 'Network', // optional select/multi_select field
};

const NOTION_STATUS = {
  trigger: 'Push to Sprout',
  success: 'Sent to Sprout',
  error: 'Error',
};

// PROFILE_MAP: maps network names to Sprout customer_profile_ids.
// To find your real IDs, call:
//   GET https://api.sproutsocial.com/v1/{SPROUT_CUSTOMER_ID}/metadata/customer
// and look for `customer_profiles[].id` for each network.
const PROFILE_MAP = {
  Instagram: 11111, // replace with real customer_profile_id
  Facebook: 22222,  // replace with real customer_profile_id
  LinkedIn: 33333,  // replace with real customer_profile_id
};

// ---------------------------------------------------------------------------
// ENVIRONMENT VARIABLES (never hardcode these)
// ---------------------------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const SPROUT_API_TOKEN = process.env.SPROUT_API_TOKEN;
const SPROUT_CUSTOMER_ID = process.env.SPROUT_CUSTOMER_ID;
const SPROUT_GROUP_ID = process.env.SPROUT_GROUP_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// HELPER: Fetch a Notion page by ID
// ---------------------------------------------------------------------------
async function fetchNotionPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion fetchPage failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// HELPER: Update a Notion page's Status property
// ---------------------------------------------------------------------------
async function updateNotionStatus(pageId, statusName) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        [NOTION_FIELDS.status]: {
          status: { name: statusName },
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion updateStatus failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// HELPER: Download an image from a URL into a Buffer
// ---------------------------------------------------------------------------
async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Image download failed (${res.status}): ${body}`);
  }
  return res.buffer(); // node-fetch v2 returns Buffer via .buffer()
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
  // Expected response shape: { data: { id: <media_id> } }
  const mediaId = json?.data?.id;
  if (!mediaId) {
    throw new Error(`Sprout media upload returned no media ID: ${JSON.stringify(json)}`);
  }
  return mediaId;
}

// ---------------------------------------------------------------------------
// HELPER: Create a draft post in Sprout Social
// ---------------------------------------------------------------------------
async function createSproutPost(text, scheduledTime, mediaId, profileIds) {
  const payload = {
    post_type: 'draft',
    content: { text },
    customer_profile_ids: profileIds,
    group_id: Number(SPROUT_GROUP_ID),
  };

  // Only include scheduled_times if a valid future time was provided
  if (scheduledTime) {
    payload.delivery = { scheduled_times: [scheduledTime] };
  }

  // Only include media_attachments if an image was uploaded
  if (mediaId) {
    payload.media_attachments = [{ id: mediaId }];
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
module.exports = async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // We'll need the page ID for error status updates later
  let pageId = null;

  try {
    // STEP 1: Validate webhook secret
    const incomingSecret = req.headers['x-webhook-secret'];
    if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
      console.warn('STEP 1: Invalid or missing webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log('STEP 1: Webhook secret validated');

    // STEP 2: Extract Notion page ID from webhook payload
    // Notion automation webhooks send: { data: { id: "<page-id>" } }
    // The ID may include dashes (UUID format) or be undashed — both are accepted by the API.
    const body = req.body;
    pageId = body?.data?.id;
    if (!pageId) {
      console.error('STEP 2: No page ID found in payload:', JSON.stringify(body));
      return res.status(200).json({ status: 'no-op', reason: 'missing page ID' });
    }
    console.log(`STEP 2: Page ID extracted: ${pageId}`);

    // STEP 3: Fetch full page properties from Notion API
    console.log('STEP 3: Fetching Notion page...');
    const page = await fetchNotionPage(pageId);
    const props = page.properties;

    // STEP 4: Check Status === "Push to Sprout"
    const statusValue = props?.[NOTION_FIELDS.status]?.status?.name;
    console.log(`STEP 4: Page status is "${statusValue}"`);
    if (statusValue !== NOTION_STATUS.trigger) {
      console.log(`STEP 4: Status is not "${NOTION_STATUS.trigger}" — skipping`);
      return res.status(200).json({ status: 'no-op', reason: `status is "${statusValue}"` });
    }

    // STEP 5: Extract fields from page properties
    console.log('STEP 5: Extracting fields...');

    // "Post Copy" — rich_text array; concatenate all text segments
    const richTextBlocks = props?.[NOTION_FIELDS.postCopy]?.rich_text ?? [];
    const postText = richTextBlocks.map((b) => b.plain_text).join('');

    // "Publish Date" — date property
    const rawDate = props?.[NOTION_FIELDS.publishDate]?.date?.start ?? null;
    let scheduledTime = null;
    if (rawDate) {
      const scheduled = new Date(rawDate);
      if (isNaN(scheduled.getTime())) {
        console.warn(`STEP 5: "Publish Date" could not be parsed: ${rawDate}`);
      } else if (scheduled <= new Date()) {
        console.warn(`STEP 5: "Publish Date" is in the past (${rawDate}) — creating unscheduled draft`);
      } else {
        scheduledTime = scheduled.toISOString(); // UTC ISO 8601
      }
    } else {
      console.warn('STEP 5: "Publish Date" is empty — creating unscheduled draft');
    }

    // "Social Asset" — files property; grab the first file's URL
    const files = props?.[NOTION_FIELDS.socialAsset]?.files ?? [];
    // Notion files can be type "file" (signed URL) or "external"
    const firstFile = files[0] ?? null;
    const assetUrl = firstFile?.file?.url ?? firstFile?.external?.url ?? null;
    const assetFilename = firstFile?.name ?? 'image.jpg';

    // "Network" — optional select or multi_select; default to all if absent
    let profileIds = Object.values(PROFILE_MAP);
    const networkProp = props?.[NOTION_FIELDS.network];
    if (networkProp) {
      // Handle both select and multi_select property types
      let selectedNetworks = [];
      if (networkProp.type === 'select' && networkProp.select?.name) {
        selectedNetworks = [networkProp.select.name];
      } else if (networkProp.type === 'multi_select') {
        selectedNetworks = (networkProp.multi_select ?? []).map((o) => o.name);
      }
      if (selectedNetworks.length > 0) {
        const mapped = selectedNetworks
          .map((n) => PROFILE_MAP[n])
          .filter((id) => id !== undefined);
        if (mapped.length > 0) {
          profileIds = mapped;
        } else {
          console.warn(`STEP 5: Network values ${JSON.stringify(selectedNetworks)} not found in PROFILE_MAP — using all profiles`);
        }
      }
    }

    console.log(`STEP 5: postText="${postText.substring(0, 80)}...", scheduledTime=${scheduledTime}, assetUrl=${assetUrl ? '[present]' : '[none]'}, profileIds=${JSON.stringify(profileIds)}`);

    // STEP 6: Download and upload image (if present)
    let mediaId = null;
    if (assetUrl) {
      console.log('STEP 6: Downloading image from Notion signed URL...');
      const imageBuffer = await downloadImage(assetUrl);
      console.log(`STEP 6: Image downloaded (${imageBuffer.length} bytes). Uploading to Sprout...`);
      mediaId = await uploadImageToSprout(imageBuffer, assetFilename);
      console.log(`STEP 6: Image uploaded to Sprout. media_id=${mediaId}`);
    } else {
      console.log('STEP 6: No "Social Asset" — skipping image upload');
    }

    // STEP 7 + 8: Create draft post in Sprout Social
    console.log('STEP 7/8: Creating Sprout draft post...');
    const sproutResult = await createSproutPost(postText, scheduledTime, mediaId, profileIds);
    console.log(`STEP 8: Sprout post created: ${JSON.stringify(sproutResult)}`);

    // STEP 9: Update Notion page status to "Sent to Sprout"
    console.log('STEP 9: Updating Notion status to "Sent to Sprout"...');
    await updateNotionStatus(pageId, NOTION_STATUS.success);
    console.log('STEP 9: Notion status updated successfully');

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    // STEP 10: Handle any error — log, mark Notion page as Error, return 200
    console.error('ERROR:', err.message);

    if (pageId) {
      try {
        console.log('STEP 10: Updating Notion status to "Error"...');
        await updateNotionStatus(pageId, NOTION_STATUS.error);
        console.log('STEP 10: Notion status set to "Error"');
      } catch (statusErr) {
        console.error('STEP 10: Failed to update Notion error status:', statusErr.message);
      }
    }

    // Always return 200 so Notion does not retry the webhook
    return res.status(200).json({ status: 'error', message: err.message });
  }
};
