# Calendar Shift

Automatically shifts your personal calendar events when you wake up late. Uses Oura Ring webhooks to detect actual wake time, compares to your scheduled "Sleep" event end time, and shifts all solo events by the difference.

Runs on Cloudflare Workers - no server required.

## How It Works

```
Expected wake (from calendar): 7:00 AM
Actual wake (from Oura Ring): 9:00 AM
Offset: +2 hours

Events shifted:
- 7:15 AM "Breakfast" → 9:15 AM ✓
- 8:00 AM "Commute" → 10:00 AM ✓
- 10:00 AM "Team standup" (3 attendees) → SKIPPED
- 12:00 PM "Lunch" → 2:00 PM ✓
```

## Architecture

```
Oura Ring → syncs → Oura Cloud → webhook → Cloudflare Worker → Google Calendar API
```

1. You sync your Oura Ring (open the app)
2. Oura sends a webhook to your Cloudflare Worker (~30 sec later)
3. Worker fetches your wake time from Oura API
4. Worker compares to "Sleep" event end time in your calendar
5. Worker shifts all solo events by the difference

## Setup

### 1. Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Google Calendar API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop app**
6. Download the JSON and save as `credentials.json`

### 2. Oura API Application

1. Go to [Oura API Applications](https://cloud.ouraring.com/oauth/applications)
2. Create a new application
3. Note your `client_id` and `client_secret`

### 3. Deploy Worker

```bash
cd worker
npm install -g wrangler
wrangler login

# Create KV namespace for tokens
wrangler kv namespace create TOKENS
# Update wrangler.toml with the namespace ID

# Add secrets
echo "YOUR_GOOGLE_CLIENT_ID" | wrangler secret put GOOGLE_CLIENT_ID
echo "YOUR_GOOGLE_CLIENT_SECRET" | wrangler secret put GOOGLE_CLIENT_SECRET
echo "YOUR_OURA_CLIENT_ID" | wrangler secret put OURA_CLIENT_ID
echo "YOUR_OURA_CLIENT_SECRET" | wrangler secret put OURA_CLIENT_SECRET

# Deploy
wrangler deploy
```

### 4. Configure DNS

Add a route in `wrangler.toml` pointing to your domain, or use a workers.dev subdomain.

### 5. Store OAuth Tokens

Upload your OAuth tokens to KV:

```bash
wrangler kv key put --namespace-id=YOUR_KV_ID --remote google_token '{"access_token":"...","refresh_token":"...","expiry_date":...}'
wrangler kv key put --namespace-id=YOUR_KV_ID --remote oura_token '{"access_token":"...","refresh_token":"...","expires_at":...}'
```

### 6. Create Oura Webhook

```bash
python setup_webhook.py --url https://your-worker.your-domain.com/webhook/oura
```

### 7. Calendar Setup

Create a **"Sleep"** event in your calendar that ends at your expected wake time. The worker uses this to calculate how late you woke up.

## Event Filtering

The worker only shifts events that are:
- **Solo events** (no other attendees)
- **Timed events** (not all-day)
- **Not the Sleep event itself**

Events with other attendees (meetings) are never shifted.

## Local Development

For testing locally:

```bash
# Run the Python script directly
python calendar_shift.py --dry-run

# Or test the worker locally
cd worker
wrangler dev
```

## Monitoring

View worker logs:

```bash
wrangler tail
```

Manually trigger a test:

```bash
curl -X POST https://your-worker.your-domain.com/trigger
```
