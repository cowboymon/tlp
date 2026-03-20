# Notion → Sprout Social Webhook

A Vercel serverless function that listens for Notion database changes and automatically creates draft posts in Sprout Social.

## How it works

1. A Notion automation fires a webhook when a page's **Status** is set to **"Push to Sprout"**
2. The function fetches the page, extracts the post copy, publish date, and image
3. The image is downloaded from Notion and re-uploaded to Sprout Social
4. A draft post is created in Sprout Social with the scheduled time and media
5. The Notion page's Status is updated to **"Sent to Sprout"** (or **"Error"** on failure)

---

## 1. Find real Sprout profile IDs

The `PROFILE_MAP` constant in `api/webhook.js` maps network names to Sprout `customer_profile_ids`. The placeholder values must be replaced with your real IDs.

**To find your IDs**, call:

```bash
curl -X GET "https://api.sproutsocial.com/v1/{SPROUT_CUSTOMER_ID}/metadata/customer" \
  -H "Authorization: Bearer {SPROUT_API_TOKEN}"
```

In the response, look for `customer_profiles` — each entry has an `id` (the `customer_profile_id`) and a `network_type` (e.g. `"instagram"`, `"facebook"`, `"linkedin"`).

Update `PROFILE_MAP` in `api/webhook.js`:

```js
const PROFILE_MAP = {
  Instagram: 98765,  // ← your real Instagram customer_profile_id
  Facebook: 43210,   // ← your real Facebook customer_profile_id
  LinkedIn: 11223,   // ← your real LinkedIn customer_profile_id
};
```

---

## 2. Set environment variables in Vercel

Go to your Vercel project → **Settings → Environment Variables** and add each variable from `.env.example`:

| Variable | Description |
|---|---|
| `NOTION_TOKEN` | Notion Internal Integration token (`secret_...`) |
| `SPROUT_API_TOKEN` | Sprout Social API token |
| `SPROUT_CUSTOMER_ID` | Sprout customer ID (number) |
| `SPROUT_GROUP_ID` | Sprout group ID (number) |
| `WEBHOOK_SECRET` | Shared secret for webhook header validation |

---

## 3. Create the Notion automation

In Notion, open the database and click **Automate → + New automation**:

1. **Trigger**: _When a page is updated_ (or "When a property is edited")
   - Filter: **Status** equals **"Push to Sprout"**
2. **Action**: _Send a webhook_
   - Method: `POST`
   - URL: `https://your-project.vercel.app/api/webhook`
   - Headers: add `x-webhook-secret` = your `WEBHOOK_SECRET` value
   - Body: leave as default (Notion sends `{ "data": { "id": "<page-id>" } }`)

> **Note:** Your Notion integration must be shared with the database. Go to the database → **...** menu → **Add connections** → select your integration.

---

## 4. Test locally with curl

### Setup

```bash
# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env.local
# Edit .env.local with real values

# Start local dev server
npx vercel dev
```

### Sample curl request

Replace `<notion-page-id>` with the ID of a real Notion page in your database that has Status = "Push to Sprout".

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your_webhook_secret_here" \
  -d '{"data": {"id": "<notion-page-id>"}}'
```

**Expected responses:**

| Scenario | Response |
|---|---|
| Success | `{"status":"ok"}` |
| Status not "Push to Sprout" | `{"status":"no-op","reason":"status is \"Draft\""}` |
| Invalid secret | `401 {"error":"Unauthorized"}` |
| Any error | `{"status":"error","message":"..."}` + Notion page set to "Error" |

### Finding a page ID

Open the Notion page → copy the URL. The page ID is the last 32-character hex string:
`https://notion.so/My-Page-**3457a32b9003414dac5d86ca8c6e7b67**`

---

## 5. Deploy to production

```bash
vercel --prod
```

After deploying, copy the production URL and update your Notion automation's webhook URL.

---

## Notion database fields reference

| Field name | Notion type | Usage |
|---|---|---|
| Status | Status | Trigger (`Push to Sprout`) / Success (`Sent to Sprout`) / Error (`Error`) |
| Post Copy | Rich text | Post body text |
| Publish Date | Date | Scheduled publish time (UTC) |
| Social Asset | Files & media | Image to attach to the post |
| Network | Select or Multi-select | Target networks (optional; defaults to all in PROFILE_MAP) |
