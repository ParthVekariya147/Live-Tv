# Deploy Your Own API — Step by Step

## Why This Exists

Your frontend was breaking every month because it depended on YouTube's
internal HTML format (which changes), and on community Piped servers (which
can go down). 

Now: your frontend only calls YOUR API. When anything breaks, you fix
ONE file on the backend (`lib/youtube.js`) — the frontend never changes.

---

## Deploy to Vercel (Free, 5 minutes)

### Step 1 — Install Vercel CLI

Open terminal and run:
```
npm install -g vercel
```

### Step 2 — Deploy

```
cd live-tv-api
vercel
```

Vercel will ask a few questions:
- "Set up and deploy?" → **Y**
- "Which scope?" → select your account
- "Link to existing project?" → **N**
- "Project name?" → type `live-tv-api` (or anything)
- "In which directory is your code?" → press **Enter** (current folder)
- "Override settings?" → **N**

After ~30 seconds, Vercel gives you a URL like:
```
https://live-tv-api-abc123.vercel.app
```

### Step 3 — Test your API

Open these URLs in your browser to confirm they work:
```
https://live-tv-api-abc123.vercel.app/api/live
https://live-tv-api-abc123.vercel.app/api/videos
```

You should see JSON like:
```json
{
  "success": true,
  "source": "piped",
  "live": [...],
  "upcoming": [...],
  "updatedAt": "2026-06-10T..."
}
```

### Step 4 — Update your frontend

Open `monitor-live.js` and change line 10:
```js
// BEFORE
const API_BASE_URL = "https://live-tv-api.vercel.app";

// AFTER — use your actual URL from step 2
const API_BASE_URL = "https://live-tv-api-abc123.vercel.app";
```

That's it. The monitors will now use your own API.

---

## When Something Breaks in the Future

**Old workflow:** Edit frontend code every time YouTube changes → test → redeploy

**New workflow:**
1. Open `live-tv-api/lib/youtube.js`
2. Fix the data parsing (just that one file)
3. Run `vercel --prod` to redeploy
4. Frontend is fixed in 30 seconds, no frontend changes needed

---

## Cost

| Resource | Free Tier Limit | Your Usage |
|---|---|---|
| Vercel Functions | 100,000 calls/day | ~720/day (poll every 2 min) |
| Vercel Bandwidth | 100 GB/month | <1 MB/month |
| Vercel Deployments | Unlimited | — |

**Total cost: $0/month, no credit card needed.**

---

## Add a Custom Domain (Optional)

If you want `api.smktv.com` instead of `live-tv-api-abc123.vercel.app`:

```
vercel domains add api.smktv.com
```

Then update `API_BASE_URL` in `monitor-live.js`.

---

## File Structure

```
live-tv-api/
├── api/
│   ├── live.js        ← GET /api/live   (live + upcoming streams)
│   └── videos.js      ← GET /api/videos (recent videos for Katha)
├── lib/
│   └── youtube.js     ← THE ONLY FILE YOU EVER EDIT WHEN YOUTUBE BREAKS
├── package.json
├── vercel.json        ← CORS headers, caching config
└── DEPLOY.md          ← this file
```

## API Response Format (permanent — never changes)

### GET /api/live
```json
{
  "success": true,
  "source": "piped",
  "live": [
    {
      "videoId": "ABC123",
      "title": "Live Katha - Day 3",
      "thumbnail": "https://i.ytimg.com/vi/ABC123/hqdefault.jpg",
      "channelName": "Swaminarayan Bhagwan",
      "channelId": "UC7HQ3mzdsyvLU0Y7a2t3N7A",
      "channelUrl": "https://www.youtube.com/channel/UC7HQ3mzdsyvLU0Y7a2t3N7A",
      "isLive": true,
      "upcoming": false,
      "scheduledStart": null,
      "duration": -1,
      "publishedAt": "2026-06-10T12:00:00.000Z",
      "source": "piped"
    }
  ],
  "upcoming": [...],
  "updatedAt": "2026-06-10T12:30:00.000Z"
}
```

### GET /api/videos
```json
{
  "success": true,
  "source": "piped",
  "data": [
    {
      "videoId": "XYZ789",
      "title": "Katha - Bhagvat Saptah",
      "thumbnail": "https://i.ytimg.com/vi/XYZ789/hqdefault.jpg",
      "channelName": "Swaminarayan Bhagwan",
      "isLive": false,
      "upcoming": false,
      "duration": 5400,
      "publishedAt": "2026-06-09T08:00:00.000Z",
      "source": "piped"
    }
  ],
  "updatedAt": "2026-06-10T12:30:00.000Z"
}
```
