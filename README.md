# RAIN License Server

A website that controls who can use your Roblox script.

- **You** make license keys in the admin panel and hand them out.
- **Users** sign in with Discord, redeem a key, and link the Roblox account they'll play on (just the username).
- **Players** run a one-line loader. It asks for their key, and the site only sends them the real script if the key works on their Roblox account.
- A key only works in **one game at a time** - if it's already running somewhere, the newer login is turned away.
- **You** upload the script in the admin panel. It's kept in your database, never in this (public) repo.

Licenses are tied to one Discord account, and up to 3 Roblox accounts (set `MAX_ROBLOX_ACCOUNTS` to change that). Admins have no limit on their own license, and no wait before removing an account. Each Roblox account can only be on one license.

## How it fits together

| Page | Who uses it | What it's for |
|---|---|---|
| `/` | Everyone | Landing page with "Sign in with Discord" |
| `/dashboard` | Users | Redeem a key, link and remove Roblox accounts, see when their license ends |
| `/admin` | You (and co-admins) | Make keys, manage every license, upload the script |
| `/loader.lua` | Players' executors | The loader: asks for the key, then downloads and runs the script |
| `/api/script?key=...&robloxUserId=123` | The loader | The script itself, only for a key that works on that Roblox account |
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
| `PUBLIC_URL` | your site's address, used inside the loader (worked out from `DISCORD_REDIRECT_URI` if you leave it out) |
| `MAX_ROBLOX_ACCOUNTS` | how many Roblox accounts one license can link (default `3`) |
| `ROBLOX_RELINK_COOLDOWN_HOURS` | how long after linking an account a user must wait before they can remove it (default `168`, one week; `0` turns it off). Stops one license being passed around. Admins can unlink any time |

Prefer clicking less? This repo includes `render.yaml`, so **New > Blueprint** sets up the service and asks you for each value.

### 4. Finish the Discord redirect

Once Render shows your URL (like `https://rain-license.onrender.com`):

1. Make sure `DISCORD_REDIRECT_URI` in Render is `https://YOUR-URL/auth/discord/callback`.
2. In the Discord app, open **OAuth2 > Redirects** and add the exact same URL.

When it's working, Render's logs end with `RAIN license server listening on port ...`, and you can sign in at `/admin`.

## Using it

**Making keys:** open `/admin`, choose how many keys and how much time each gives (lifetime or a number of days), and click **Make keys**. Copy them and send them to people.

**Adding your own keys:** already have keys (any format, like `XXXX-XXXX-XXXX-XXXX`)? Paste them into **Add your own keys** on the Keys tab, one per line, and press **Add keys**. They work straight away in the loader with no Discord sign-in: the first Roblox account to use one gets it, and after that it only works on that account (anyone else is told it's in use by a different account). A Roblox account that already has a license can't take a second key. Unused ones can still be redeemed on the website instead, like any other key. Keys used this way show up under **Licenses** as "(in game)".

**Redeeming:** the user signs in at your site, pastes their key, then links the Roblox account they'll play on by typing its username (and up to 2 more the same way, if they play on alts). The key locks to the accounts linked here, so it only works when run on one of them.

**One game at a time:** a key can only be running in one place at once. While someone's playing with it, anyone else who starts it on that key is turned away ("already being used right now"), and the script shuts down. A session frees up about 40 seconds after it stops checking in, so after closing the game or hopping servers there's a short wait before it can run again.

**Timed keys stack:** redeeming a 30-day key on a license with 10 days left gives 40 days. Redeeming after it expires starts from today.

**Script key:** once a key is redeemed, the dashboard shows it under **Your script key** with a Copy button. The script asks for this key the first time it runs and remembers it after that. A key only works on the Roblox account linked to its license, so a shared key is useless to anyone else. Licenses you give out directly (without a key) get a script key made for them the first time the user opens their dashboard.

**In the admin panel** you can:

- add or remove time, or make a license lifetime
- see who's in a game with the script right now (**In game**), and which game
- see every time the script was started, by whom, on which account, in which game and server (**Activity** tab, or **Activity** on a license for just theirs; kept 90 days)
- link a Roblox account to any license straight away with **Add account** (just the username: no profile phrase, no limit)
- unlink one Roblox account (the **×** next to it) or all of them (**Unlink all**)
- **Kick** someone out of their game (you can give a reason they'll see). It kicks every account on their license that's in a game. Their license isn't touched, so they can rejoin
- revoke a license (blocked, but kept on record) and unrevoke it
- give someone a license directly, without a key
- delete unused keys or whole licenses

## The loader

Players paste this into their executor (it's on their license page with a Copy button, and in the admin panel's **Script** tab):

```
loadstring(game:HttpGet("https://YOUR-URL/loader.lua"))()
```

1. The loader shows a key box. **Get Key** copies your site's address; **Check Key** checks the key with `/api/check-key`.
2. With a good key, it downloads the script from `/api/script` and runs it, passing the key in.
3. It saves the key, so next time it goes straight through.
4. When the script starts, it tells the site which game and server it's in (`placeId`, `jobId`, `game`, with `start=1`). That's what the Activity tab lists.
5. While the script runs, it checks in every 15 seconds (`/api/check-key` with `watch=1`). If the license has been revoked, deleted, expired or unlinked, or you pressed **Kick**, it turns itself off and kicks the player. If your site can't be reached, it keeps running.

A kick waits up to 2 minutes for the player's script to check in. Who's in a game and waiting kicks are kept in memory, so a restart clears them.

**Uploading the script:** open `/admin`, go to **Script**, choose your `.lua` file and press **Upload**. It replaces the script for everyone straight away, and **Download** gets back what's live. Files up to 15 MB work. The script is sent zipped to executors that can unzip it, which is most of them.

The loader itself is `roblox/Loader.lua`. The site fills in its own address when it sends it, so you don't need to edit it.

## The Roblox script (server-side check)

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
GET https://YOUR-URL/api/check-key?key=RAIN-XXXXX-XXXXX-XXXXX&robloxUserId=123456&session=SOME-ID&start=1
```

```json
{ "allowed": false, "reason": "wrong_account", "message": "This key is linked to a different Roblox account." }
```

`reason` is one of `invalid_key`, `not_redeemed`, `no_license`, `revoked`, `expired`, `needs_roblox`, `wrong_account`, or `in_use` (the key is already running somewhere else right now). This route doesn't need `PUBLIC_API_TOKEN`, because the key itself is the secret.

The script sends a unique `session` id (and `start=1` when it loads, `watch=1` on each check-in afterwards). That's how one key is held to one game at a time: while a session keeps checking in, a different session on the same key gets `in_use` and shuts down. The `session` is optional - a request without it (like the loader's first check) is never turned away for being in use.

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
