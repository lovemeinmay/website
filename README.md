# RAIN License Server

A website that controls who can use your Roblox script.

- **You** make license keys in the admin panel and hand them out.
- **Users** sign in with Discord, redeem a key, and verify their Roblox account by putting a short phrase in their Roblox profile.
- **Your Roblox script** asks the site whether a player's Roblox account has an active license.

Licenses are tied to both accounts: one Discord account per license, one Roblox account per license.

## How it fits together

| Page | Who uses it | What it's for |
|---|---|---|
| `/` | Everyone | Landing page with "Sign in with Discord" |
| `/dashboard` | Users | Redeem a key, link or change their Roblox account, see when their license ends |
| `/admin` | You (and co-admins) | Make keys, see and manage every license |
| `/api/check-key?key=...&robloxUserId=123` | The script's key prompt | Answers `{ "allowed": true }`, or `{ "allowed": false, "message": "..." }` saying what's wrong |
| `/api/check?robloxUserId=123` | Your Roblox script | Answers `{ "allowed": true }` or `{ "allowed": false }` |
| `/api/allowlist` | Older scripts | The full list, in the same format as before |

A license is **active** when it has a linked Roblox account, hasn't expired, and hasn't been revoked.

## Setup

You need three free accounts: Discord (developer app), Turso (database) and Render (hosting).

### 1. Discord app

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Open **OAuth2**. Copy the **Client ID**, then click **Reset Secret** and copy the **Client Secret**.
3. You'll add a redirect in step 4, once you know your site's URL.
4. Get your own Discord user ID: in Discord, open **Settings > Advanced**, turn on **Developer Mode**, then right-click your name and choose **Copy User ID**.

### 2. Turso database

1. Sign up at <https://turso.tech> (free, no card).
2. Create a database (any name, e.g. `rain-licenses`).
3. Copy its URL (it starts with `libsql://`).
4. Create a token for the database and copy it.

The site creates its tables by itself the first time it starts.

### 3. Render

In Render, click **New > Web Service** (not Static Site) and pick this repo.

| Setting | Value |
|---|---|
| Language | Node |
| Root Directory | leave blank |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance type | Free |

Under **Environment**, add:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | any long random string (at least 16 characters) |
| `DISCORD_CLIENT_ID` | from step 1 |
| `DISCORD_CLIENT_SECRET` | from step 1 |
| `DISCORD_REDIRECT_URI` | `https://YOUR-APP.onrender.com/auth/discord/callback` |
| `ADMIN_DISCORD_IDS` | your Discord user ID (separate several with commas) |
| `TURSO_DATABASE_URL` | from step 2 |
| `TURSO_AUTH_TOKEN` | from step 2 |

Optional:

| Key | Value |
|---|---|
| `SITE_NAME` | the name shown on the site and at the start of every key (default `RAIN`) |
| `PUBLIC_API_TOKEN` | a random string your script must send to read `/api/check` and `/api/allowlist` |
| `ROBLOX_RELINK_COOLDOWN_HOURS` | how long users wait before switching Roblox accounts (default `168`, one week; `0` turns it off) |

Prefer clicking less? This repo includes `render.yaml`, so **New > Blueprint** sets up the service and asks you for each value.

### 4. Finish the Discord redirect

Once Render shows your URL (like `https://rain-license.onrender.com`):

1. Make sure `DISCORD_REDIRECT_URI` in Render is `https://YOUR-URL/auth/discord/callback`.
2. In the Discord app, open **OAuth2 > Redirects** and add the exact same URL.

When it's working, Render's logs end with `RAIN license server listening on port ...`, and you can sign in at `/admin`.

## Using it

**Making keys:** open `/admin`, choose how many keys and how much time each gives (lifetime or a number of days), and click **Make keys**. Copy them and send them to people.

**Redeeming:** the user signs in at your site, pastes their key, then links their Roblox account:

1. They type their Roblox username.
2. The site shows a short phrase like `maple otter river candle sunny jade`.
3. They paste it into their Roblox profile's About section and press **Verify account**.

This proves the Roblox account is theirs. They can delete the phrase afterwards.

**Timed keys stack:** redeeming a 30-day key on a license with 10 days left gives 40 days. Redeeming after it expires starts from today.

**Script key:** once a key is redeemed, the dashboard shows it under **Your script key** with a Copy button. The script asks for this key the first time it runs and remembers it after that. A key only works on the Roblox account linked to its license, so a shared key is useless to anyone else. Licenses you give out directly (without a key) get a script key made for them the first time the user opens their dashboard.

**In the admin panel** you can:

- add or remove time, or make a license lifetime
- revoke a license (blocked, but kept on record) and unrevoke it
- unlink someone's Roblox account so they can link a new one right away
- give someone a license directly, without a key
- delete unused keys or whole licenses

## The Roblox script

`roblox/LicenseCheck.server.lua` is a ready-made check. Put it in a **Script** inside **ServerScriptService**, set `SITE_URL`, and turn on **Game Settings > Security > Allow HTTP Requests**. It kicks anyone without an active license.

To check a player yourself:

```
GET https://YOUR-URL/api/check?robloxUserId=123456
```

```json
{ "allowed": true, "expiresAt": "2026-11-05T22:10:00.000Z" }
```

`expiresAt` is `null` for lifetime licenses. If you set `PUBLIC_API_TOKEN`, send it in an `X-License-Token` header (or add `&token=...` to the URL).

To check a key (this is what the script's key prompt does):

```
GET https://YOUR-URL/api/check-key?key=RAIN-XXXXX-XXXXX-XXXXX&robloxUserId=123456
```

```json
{ "allowed": false, "reason": "wrong_account", "message": "This key is linked to a different Roblox account." }
```

`reason` is one of `invalid_key`, `not_redeemed`, `no_license`, `revoked`, `expired`, `needs_roblox` or `wrong_account`. This route doesn't need `PUBLIC_API_TOKEN`, because the key itself is the secret.

`/api/allowlist` still returns the old format, so a script that already reads it keeps working:

```json
[{ "robloxUserId": 123456, "robloxUsername": "Builderman", "revoked": false }]
```

`revoked` is `true` for anyone who isn't currently allowed, including expired licenses.

Render's free plan sleeps after 15 minutes without visitors, and the first request after that can take up to a minute. The Lua check retries for that reason.

## Testing on your own computer

1. Copy `.env.example` to `.env` and fill it in. Leave `NODE_ENV` and the Turso values out; it will use a local `data.db` file.
2. In the Discord app, add `http://localhost:3000/auth/discord/callback` as a redirect.
3. Run:

```
npm install
npm start
```

Then open <http://localhost:3000>.
