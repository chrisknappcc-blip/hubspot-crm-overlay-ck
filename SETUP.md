# CarePathIQ CRM — Complete Setup Guide

Work through these phases in order. Each phase builds on the last.
Estimated total time: 2–3 hours on first setup.

---

## Project overview

What you're building:
- A custom sales intelligence web app for your team (3–4 users to start)
- HubSpot as the data backbone — contacts, deals, signals, activity
- Hosted on Netlify (same as Market Mapper) with Azure Blob for token storage
- Clerk for user login (each rep gets their own account)
- Bot-filtered email signal scoring so your team only acts on real intent

File structure when done:
```
carepathiq-crm/
  netlify/
    functions/
      utils/
        auth.js          ← Clerk JWT verification
        tokenStore.js    ← Azure Blob token read/write
      hubspot.js         ← All HubSpot API routes
  netlify.toml           ← Netlify build + redirect config
  package.json           ← Dependencies
  SETUP.md               ← This file
```

---

## Phase 1 — GitHub repo (5 minutes)

1. Go to https://github.com and create a new repository
   - Name: `carepathiq-crm`
   - Visibility: Private
   - Do NOT initialize with README (you'll push files directly)

2. On your local machine, create the project folder and initialize git:
```bash
mkdir carepathiq-crm
cd carepathiq-crm
git init
git remote add origin https://github.com/YOUR_USERNAME/carepathiq-crm.git
```

3. Copy all the files from this package into that folder (maintaining the folder structure shown above), then push:
```bash
git add .
git commit -m "Initial backend setup"
git branch -M main
git push -u origin main
```

---

## Phase 2 — Netlify site (10 minutes)

1. Go to https://app.netlify.com and log in

2. Click **Add new site → Import an existing project**

3. Connect to GitHub and select your `carepathiq-crm` repo

4. Build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`

5. Click **Deploy site** — it will fail (no env vars yet) but that's fine. You need the site URL first.

6. Note your Netlify site URL: `https://YOUR-SITE-NAME.netlify.app`
   You can customize this under **Site settings → Domain management**

---

## Phase 3 — Azure Blob container (10 minutes)

You already have the `carepathiqdata` storage account from Market Mapper.
You just need to add a new container for CRM tokens.

1. Go to https://portal.azure.com

2. Navigate to **Storage accounts → carepathiqdata → Containers**

3. Click **+ Container**
   - Name: `crm-tokens`
   - Public access level: **Private (no anonymous access)**
   - Click Create

4. Check your existing SAS token (the one used in Market Mapper).
   It needs **Read, Write, and List** permissions on blobs.
   - If it already has those, you can reuse it
   - If not, go to **Shared access signature** and generate a new one with:
     - Allowed services: Blob
     - Allowed resource types: Container + Object
     - Allowed permissions: Read, Write, List, Create
     - Expiry: set to 2027 or later
     - Click **Generate SAS and connection string**
     - Copy the **SAS token** (starts with `?sv=`)

---

## Phase 4 — Clerk setup (15 minutes)

1. Go to https://clerk.com and sign up for a free account

2. Click **Create application**
   - Name: `CarePathIQ CRM`
   - Sign-in options: enable **Email address** + **Password**
   - Click Create

3. From the Clerk dashboard left sidebar, click **API Keys**
   Copy both:
   - **Publishable key** (starts with `pk_test_...`) — used by the frontend
   - **Secret key** (starts with `sk_test_...`) — used by the backend

4. (Optional for now, easy to add later) To enable Microsoft/Outlook SSO:
   - Go to **User & Authentication → Social connections**
   - Enable Microsoft
   - You'll need an Azure AD app registration — skip this for the pilot and use email/password

5. Under **Users**, you can manually create accounts for each pilot user now,
   or they can sign up themselves once the app is live.

---

## Phase 5 — HubSpot private app (15 minutes)

This creates an OAuth app that your CRM tool connects through.
Each user will authorize this app with their own HubSpot credentials.

1. In HubSpot, go to:
   **Settings (gear icon) → Integrations → Private Apps**

2. Click **Create a private app**

3. Basic info tab:
   - Name: `CarePathIQ CRM`
   - Description: Internal sales intelligence tool

4. Scopes tab — enable ALL of the following:
   ```
   crm.objects.contacts.read
   crm.objects.contacts.write
   crm.objects.deals.read
   timeline
   sales-email-read
   crm.lists.read
   automation
   oauth
   ```

5. Click **Create app**

6. On the next screen, copy:
   - **Client ID**
   - **Client secret** (click Show)

7. Under **Auth → Redirect URLs**, add:
   ```
   https://YOUR-SITE-NAME.netlify.app/api/hubspot/auth/callback
   ```
   Replace `YOUR-SITE-NAME` with your actual Netlify URL.

---

## Phase 6 — Environment variables in Netlify (10 minutes)

This is where everything gets wired together.

1. In Netlify, go to **Site settings → Environment variables**

2. Add each of the following (click **Add a variable** for each):

| Variable name | Where to get it | Example format |
|---|---|---|
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys | `sk_test_abc123...` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys | `pk_test_abc123...` |
| `HUBSPOT_CLIENT_ID` | HubSpot private app → Auth | `abc123-def456-...` |
| `HUBSPOT_CLIENT_SECRET` | HubSpot private app → Auth | `abc123def456...` |
| `HUBSPOT_REDIRECT_URI` | You define this | `https://YOUR-SITE.netlify.app/api/hubspot/auth/callback` |
| `AZURE_STORAGE_ACCOUNT_NAME` | Azure portal | `carepathiqdata` |
| `AZURE_STORAGE_SAS_TOKEN` | Azure portal (Phase 3) | `?sv=2022-...` |
| `APP_URL` | Your Netlify URL | `https://YOUR-SITE.netlify.app` |

3. After adding all variables, go to **Deploys** and click **Trigger deploy → Deploy site**

---

## Phase 7 — Install dependencies and test locally (15 minutes)

Before testing live, verify everything works locally.

1. In your project folder:
```bash
npm install
npm install -g netlify-cli
netlify login
netlify link   # link to your Netlify site
```

2. Create a `.env` file in your project root for local dev
   (this file is gitignored — never commit it):
```
CLERK_SECRET_KEY=sk_test_your_key
VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_key
HUBSPOT_CLIENT_ID=your_client_id
HUBSPOT_CLIENT_SECRET=your_client_secret
HUBSPOT_REDIRECT_URI=http://localhost:8888/api/hubspot/auth/callback
AZURE_STORAGE_ACCOUNT_NAME=carepathiqdata
AZURE_STORAGE_SAS_TOKEN=?sv=your_sas_token
APP_URL=http://localhost:8888
```

3. Run locally:
```bash
netlify dev
```
This starts the dev server at `http://localhost:8888`

---

## Phase 8 — Test the API endpoints (15 minutes)

Use a tool like [Insomnia](https://insomnia.rest) (free) or curl to test each endpoint.
You'll need a Clerk JWT to test authenticated routes — see note below.

### Getting a test JWT from Clerk
In the Clerk dashboard → **Users** → click a user → **Sessions** → copy the session token.
Use it as: `Authorization: Bearer YOUR_TOKEN`

### Test sequence (run in this order):

**1. Check connection status** — should return `{ hubspot: false }`
```
GET http://localhost:8888/api/hubspot/status
Authorization: Bearer YOUR_CLERK_TOKEN
```

**2. Connect HubSpot** — opens HubSpot OAuth in browser
```
GET http://localhost:8888/api/hubspot/auth/connect
Authorization: Bearer YOUR_CLERK_TOKEN
```
→ Complete the OAuth flow in your browser
→ Should redirect back to your app with `?connected=hubspot`

**3. Check status again** — should now return `{ hubspot: true }`
```
GET http://localhost:8888/api/hubspot/status
Authorization: Bearer YOUR_CLERK_TOKEN
```

**4. Pull contacts**
```
GET http://localhost:8888/api/hubspot/contacts
Authorization: Bearer YOUR_CLERK_TOKEN
```

**5. Pull signals (bot-filtered)**
```
GET http://localhost:8888/api/hubspot/signals
Authorization: Bearer YOUR_CLERK_TOKEN
```
Check the `meta.suspectedBotCount` field — this tells you how many opens were filtered.

**6. Pull signals including bot detail**
```
GET http://localhost:8888/api/hubspot/signals?showBots=true
Authorization: Bearer YOUR_CLERK_TOKEN
```

**7. Pull full activity feed for a contact**
(use a contact ID from step 4)
```
GET http://localhost:8888/api/hubspot/feed/CONTACT_ID
Authorization: Bearer YOUR_CLERK_TOKEN
```

**8. Log a note to a contact**
```
POST http://localhost:8888/api/hubspot/activity
Authorization: Bearer YOUR_CLERK_TOKEN
Content-Type: application/json

{ "contactId": "CONTACT_ID", "note": "Test note from CarePathIQ CRM" }
```
→ Check in HubSpot that the note appears on the contact record

---

## Phase 9 — Deploy to production

Once local tests pass:

```bash
git add .
git commit -m "Backend verified and working"
git push
```

Netlify auto-deploys on push to main.

Repeat the test sequence from Phase 8 against your live Netlify URL.

---

## What's built vs what's next

### Currently built (this package):
- ✅ Clerk auth middleware — every request verified before touching data
- ✅ Per-user Azure Blob token storage — HubSpot tokens isolated per rep
- ✅ HubSpot OAuth connect flow — each user authorizes independently
- ✅ Contacts list + single contact detail
- ✅ Full merged activity feed (engagements + timeline + sequences + lifecycle)
- ✅ Bot-filtered email signals with confidence scoring
- ✅ Team activity feed
- ✅ Activity logging back to HubSpot

### Next to build (future sessions):
- ⬜ `outlook.js` — Microsoft Graph OAuth, email send, open/click tracking
- ⬜ `enrich.js` — ZoomInfo lookup + Claude web search per contact
- ⬜ `ai.js` — Persona-aware talking point generation
- ⬜ React frontend — the daily command center UI

---

## Troubleshooting

**Deploy fails with "Cannot find module @clerk/backend"**
→ Run `npm install` locally, commit the `package-lock.json`, and push again.

**401 on every request**
→ Your Clerk secret key is wrong or not set in Netlify env vars. Double-check spelling.

**403 "HubSpot not connected"**
→ The user hasn't completed the OAuth flow yet. Hit `/api/hubspot/auth/connect`.

**Blob write failed: 403**
→ Your SAS token doesn't have write permission, or it's expired.
   Regenerate in Azure portal with Read + Write + List + Create permissions.

**HubSpot OAuth callback fails**
→ The redirect URI in Netlify env vars must exactly match what's registered
   in HubSpot private app → Auth → Redirect URLs (including https, no trailing slash).

**Signals returns empty array**
→ Normal if no emails were sent in the last 48 hours. Try `?hours=168` for 7 days.
