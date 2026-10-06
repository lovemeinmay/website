# RAIN License Server

A small site with two parts:

- **`/api/allowlist`** - a public endpoint that returns the list of licensed Roblox user IDs. This is what the Lua script reads.
- **`/admin`** - a dashboard, behind Discord login, where you add, revoke, and delete licenses.

Only you (or whoever you add to `ADMIN_DISCORD_IDS`) can open `/admin`. The public endpoint never exposes Discord info, only Roblox IDs.

## 1. Create a Discord application

1. Go to <https://discord.com/developers/applications> and create a new application.
2. Under **OAuth2 > General**, copy the **Client ID** and **Client Secret**.
3. Under **OAuth2 > Redirects**, add `https://YOUR-DOMAIN/auth/discord/callback` (you'll know your domain once you've deployed - step 3 below). For local testing, add `http://localhost:3000/auth/discord/callback`.
4. Get your own Discord user ID: in Discord, go to **Settings > Advanced** and turn on **Developer Mode**. Then right-click your name anywhere and choose **Copy User ID**.

## 2. Configure

```
cp .env.example .env
```

Fill in `.env`:

- `SESSION_SECRET` - any long random string.
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` - from step 1.
- `DISCORD_REDIRECT_URI` - must exactly match what you added in the Discord app settings.
- `ADMIN_DISCORD_IDS` - your Discord user ID (comma-separate more if you want co-admins).
- `PUBLIC_API_TOKEN` - optional. Leave blank unless you want to require a shared secret to read `/api/allowlist` (see "Locking down the public endpoint" below).
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` - where licenses are stored (see "Data storage" below). Leave blank when testing locally to use a local `data.db` file instead.

## 3. Run it

### Locally, to try it out

```
npm install
npm start
```

Then open <http://localhost:3000/admin> and log in with Discord.

### Deploying (the easy way: Render.com)

Render has a free tier and needs no server management.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a new **Web Service** from that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add every variable from `.env.example` under the service's **Environment** tab, including `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Without those two, licenses are wiped every time Render restarts the service.
5. Once it deploys, you'll get a URL like `https://rain-license.onrender.com`. Go back and:
   - Update `DISCORD_REDIRECT_URI` in Render's env vars to `https://rain-license.onrender.com/auth/discord/callback`.
   - Add that same URL as a redirect in the Discord app's OAuth2 settings.
   - Redeploy (Render does this automatically when env vars change).

Render's free tier sleeps after inactivity; the first request after it's been idle takes a few seconds to wake up. That's fine for this use case, since the script only checks once at startup and every 5 minutes after. If that matters to you, Render, Railway, and most small VPS hosts all work the same way with this app - it's just a plain Node server.

### Deploying on your own VPS

```
npm install
npm start
```

Put it behind a reverse proxy (nginx, Caddy) with HTTPS, and run it with something like `pm2` so it restarts if it crashes or the server reboots:

```
npm install -g pm2
pm2 start server.js --name rain-license
pm2 save
```

## 4. Point the script at it

In the Lua file, find:

```lua
local LICENSE_URL = "https://your-server.example.com/api/allowlist"
```

Replace it with your real URL, e.g. `https://rain-license.onrender.com/api/allowlist`.

## 5. Add licenses

Open `/admin`, log in with Discord, type a Roblox username and click **Look up** to fill in the user ID automatically (or type the ID yourself), then **Add license**. Use **Revoke** to block someone without deleting their record, or **Delete** to remove it entirely.

## Locking down the public endpoint

By default `/api/allowlist` is open to anyone who finds the URL, but it only ever returns Roblox IDs and usernames, nothing sensitive. If you'd rather require a shared secret:

1. Set `PUBLIC_API_TOKEN` in `.env` to a random string.
2. In the Lua script's `fetchAllowList` function, add a `Headers` table to the request:
   ```lua
   local ok, response = pcall(send, {
       Url = LICENSE_URL,
       Method = "GET",
       Headers = { ["X-License-Token"] = "the-same-random-string" },
   })
   ```

## Data storage

Licenses are stored in [Turso](https://turso.tech), a free hosted SQLite database, so they survive Render restarts and redeploys. To set it up:

1. Sign up at <https://turso.tech> (free, no card needed).
2. Create a database (any name, e.g. `rain-licenses`).
3. On the database's page, copy its URL (starts with `libsql://`) into `TURSO_DATABASE_URL`.
4. Create a token for that database and copy it into `TURSO_AUTH_TOKEN`.

The server creates the `licenses` table itself on first start.

If `TURSO_DATABASE_URL` isn't set, the server falls back to a local `data.db` file. That's handy for testing on your own computer, but don't rely on it on Render's free plan: Render wipes local files on every restart, redeploy, and sleep.
