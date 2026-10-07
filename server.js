const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const config = require("./src/config");
const db = require("./src/db");
const session = require("./src/session");
const discord = require("./src/discord");
const roblox = require("./src/roblox");
const licenses = require("./src/licenses");
const scripts = require("./src/script");
const presence = require("./src/presence");
const { HttpError, createRouter, readJsonBody, sendJson, redirect, sendStatic } = require("./src/http");

const VIEWS = path.join(__dirname, "views");
const PUBLIC = path.join(__dirname, "public");
const LOADER_FILE = path.join(__dirname, "roblox", "Loader.lua");

// Script uploads go through the JSON body as base64, which is about 4/3 the file size.
const UPLOAD_PATH = "/api/admin/script";
const MAX_UPLOAD_BODY = Math.ceil((scripts.MAX_SCRIPT_BYTES * 4) / 3) + 64 * 1024;
const router = createRouter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdmin(user) {
	return !!user && config.adminIds.includes(user.id);
}

function requireUser(ctx) {
	if (!ctx.session.user) throw new HttpError(401, "Log in with Discord first.");
	return ctx.session.user;
}

function requireAdmin(ctx) {
	const user = requireUser(ctx);
	if (!isAdmin(user)) throw new HttpError(403, "Only admins can do that.");
	return user;
}

// Only allow redirects back to our own pages (never to another site).
function safeReturnPath(value, fallback) {
	return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
		? value
		: fallback;
}

// Small in-memory limiter so nobody can spam key guesses or Roblox lookups.
const hits = new Map();

function rateLimit(key, max, windowMs) {
	const now = Date.now();
	const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);

	if (recent.length >= max) {
		throw new HttpError(429, "Slow down a little and try again in a minute.");
	}

	recent.push(now);
	hits.set(key, recent);

	if (hits.size > 5000) hits.clear();
}

// The site's own address, for links inside the loader.
function siteUrl(ctx) {
	return config.publicUrl || `https://${ctx.req.headers.host}`;
}

function parseRobloxUserId(value) {
	const robloxUserId = Number(value);
	if (!Number.isSafeInteger(robloxUserId) || robloxUserId <= 0) {
		throw new HttpError(400, "robloxUserId must be a Roblox user ID number.");
	}
	return robloxUserId;
}

// The game the script is running in, as it reports it: ?placeId=...&jobId=...&game=...
function gameFromQuery(query) {
	const placeId = Number(query.get("placeId"));

	return {
		placeId: Number.isSafeInteger(placeId) && placeId > 0 ? placeId : null,
		jobId: String(query.get("jobId") || "").replace(/[^\w-]/g, "").slice(0, 64) || null,
		gameName:
			String(query.get("game") || "")
				.replace(/[\u0000-\u001f\u007f]/g, "")
				.trim()
				.slice(0, 100) || null,
	};
}

function checkApiToken(ctx) {
	if (!config.publicApiToken) return;

	const sent = Buffer.from(String(ctx.req.headers["x-license-token"] || ctx.query.get("token") || ""));
	const expected = Buffer.from(config.publicApiToken);

	if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
		throw new HttpError(403, "forbidden");
	}
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// Read a page from views/ (once) and fill in the site name.
const viewCache = new Map();

function sendView(res, name, status = 200) {
	if (!viewCache.has(name)) {
		const siteName = config.siteName.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
		viewCache.set(name, fs.readFileSync(path.join(VIEWS, name), "utf8").replaceAll("{{SITE_NAME}}", siteName));
	}

	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(viewCache.get(name));
}

router.get("/", (ctx) => sendView(ctx.res, "index.html"));

router.get("/dashboard", (ctx) => {
	if (!ctx.session.user) return redirect(ctx.res, "/login?next=/dashboard");
	sendView(ctx.res, "dashboard.html");
});

router.get("/admin", (ctx) => {
	if (!ctx.session.user) return redirect(ctx.res, "/login?next=/admin");
	if (!isAdmin(ctx.session.user)) return sendView(ctx.res, "denied.html", 403);
	sendView(ctx.res, "admin.html");
});

router.get("/health", () => ({ ok: true }));

// The loader players paste into their executor:
//   loadstring(game:HttpGet("https://YOUR-URL/loader.lua"))()
// It asks for their key, then downloads the real script from /api/script.
let loaderSource = null;

router.get("/loader.lua", (ctx) => {
	if (!loaderSource) loaderSource = fs.readFileSync(LOADER_FILE, "utf8");

	ctx.res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
	ctx.res.end(loaderSource.replaceAll("{{SITE_URL}}", siteUrl(ctx)));
});

// ---------------------------------------------------------------------------
// Discord login
// ---------------------------------------------------------------------------

router.get("/login", (ctx) => {
	if (!config.discord.clientId || !config.discord.redirectUri) {
		throw new HttpError(503, "Discord login isn't set up yet. Add DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI.");
	}

	const state = crypto.randomBytes(16).toString("hex");
	session.write(ctx.res, { oauthState: state, returnTo: safeReturnPath(ctx.query.get("next"), "/dashboard") });
	redirect(ctx.res, discord.getAuthorizeUrl(state));
});

router.get("/auth/discord/callback", async (ctx) => {
	const code = ctx.query.get("code");
	const state = ctx.query.get("state");

	// They clicked Cancel on Discord's screen, or the state doesn't match the one we set.
	if (!code || !state || state !== ctx.session.oauthState) {
		return redirect(ctx.res, "/?login=failed");
	}

	let user;

	try {
		user = await discord.getUserFromCode(code);
	} catch (err) {
		console.error(err.message);
		return redirect(ctx.res, "/?login=failed");
	}

	session.write(ctx.res, { user });
	redirect(ctx.res, safeReturnPath(ctx.session.returnTo, "/dashboard"));
});

router.post("/logout", (ctx) => {
	session.clear(ctx.res);
	redirect(ctx.res, "/");
});

// ---------------------------------------------------------------------------
// User API (Discord login required)
// ---------------------------------------------------------------------------

router.get("/api/me", async (ctx) => {
	const user = ctx.session.user;
	if (!user) return { user: null };

	const license = await licenses.getByDiscord(user.id);

	return {
		user,
		isAdmin: isAdmin(user),
		siteName: config.siteName,
		license: licenses.forUser(license),
		scriptKey: license ? await licenses.scriptKeyFor(user.id) : null,
	};
});

router.post("/api/redeem", async (ctx) => {
	const user = requireUser(ctx);
	rateLimit(`redeem:${user.id}`, 10, 60 * 1000);

	const license = await licenses.redeemKey({
		key: ctx.body.key,
		discordId: user.id,
		discordUsername: user.username,
	});

	return { license: licenses.forUser(license), scriptKey: await licenses.scriptKeyFor(user.id) };
});

router.post("/api/roblox/start", async (ctx) => {
	const user = requireUser(ctx);
	rateLimit(`roblox:${user.id}`, 15, 60 * 1000);

	const robloxUser = await roblox.findByUsername(ctx.body.username);
	if (!robloxUser) throw new HttpError(404, "No Roblox account has that username.");

	const license = await licenses.startRobloxLink(user.id, robloxUser, roblox.makePhrase());
	return { license: licenses.forUser(license) };
});

router.post("/api/roblox/verify", async (ctx) => {
	const user = requireUser(ctx);
	rateLimit(`roblox:${user.id}`, 15, 60 * 1000);

	const license = await licenses.getByDiscord(user.id);
	if (!license || !license.pending_roblox_user_id) {
		throw new HttpError(400, "Start linking a Roblox account first.");
	}

	const profile = await roblox.getUser(license.pending_roblox_user_id);
	if (!profile) throw new HttpError(404, "That Roblox account doesn't exist anymore.");

	if (!roblox.containsPhrase(profile.description, license.pending_phrase)) {
		throw new HttpError(
			400,
			"The phrase isn't in that account's About section yet. Save it on Roblox, wait a few seconds, then try again."
		);
	}

	const updated = await licenses.completeRobloxLink(user.id, { id: profile.id, name: profile.name });
	return { license: licenses.forUser(updated) };
});

router.post("/api/roblox/remove", async (ctx) => {
	const user = requireUser(ctx);
	const license = await licenses.removeRobloxAccount(user.id, ctx.body.robloxUserId);
	return { license: licenses.forUser(license) };
});

router.post("/api/roblox/cancel", async (ctx) => {
	const user = requireUser(ctx);
	await licenses.cancelRobloxLink(user.id);
	return { license: licenses.forUser(await licenses.getByDiscord(user.id)) };
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

router.get("/api/admin/overview", async (ctx) => {
	requireAdmin(ctx);

	const [stats, licenseList, keys] = await Promise.all([licenses.stats(), licenses.listLicenses(), licenses.listKeys()]);

	return {
		stats: { ...stats, online: presence.onlineCount() },
		licenses: licenseList.map((license) => {
			const accounts = license.accounts.map((account) => ({
				...account,
				online: presence.isOnline(account.id),
				game: presence.currentGame(account.id),
				kickPending: presence.hasKick(account.id),
			}));

			return {
				...license,
				accounts,
				online: accounts.some((account) => account.online),
				kickPending: accounts.some((account) => account.kickPending),
			};
		}),
		keys,
	};
});

router.post("/api/admin/keys", async (ctx) => {
	const admin = requireAdmin(ctx);

	const keys = await licenses.createKeys({
		count: ctx.body.count,
		duration: ctx.body.duration,
		note: ctx.body.note,
		createdBy: admin.id,
	});

	return { keys };
});

router.delete("/api/admin/keys/:id", async (ctx) => {
	requireAdmin(ctx);
	await licenses.deleteUnusedKey(ctx.params.id);
	return { ok: true };
});

router.post("/api/admin/licenses", async (ctx) => {
	requireAdmin(ctx);

	let robloxUser = null;

	if (ctx.body.robloxUsername) {
		robloxUser = await roblox.findByUsername(ctx.body.robloxUsername);
		if (!robloxUser) throw new HttpError(404, "No Roblox account has that username.");
	}

	const license = await licenses.grantLicense({
		discordId: ctx.body.discordId,
		discordUsername: ctx.body.discordUsername,
		robloxUser,
		duration: ctx.body.duration,
		note: ctx.body.note,
	});

	return { license };
});

router.patch("/api/admin/licenses/:id", async (ctx) => {
	requireAdmin(ctx);

	const { revoked, addDays, lifetime, note } = ctx.body;
	return { license: await licenses.updateLicense(ctx.params.id, { revoked, addDays, lifetime, note }) };
});

router.delete("/api/admin/licenses/:id/roblox/:robloxUserId", async (ctx) => {
	requireAdmin(ctx);
	return { license: await licenses.unlinkAccount(ctx.params.id, ctx.params.robloxUserId) };
});

// Every time the script started: who, which account, which game. Newest first.
router.get("/api/admin/activity", async (ctx) => {
	requireAdmin(ctx);
	return { executions: await licenses.listExecutions({ licenseId: ctx.query.get("licenseId"), limit: ctx.query.get("limit") }) };
});

router.post("/api/admin/licenses/:id/reset-roblox", async (ctx) => {
	requireAdmin(ctx);
	return { license: await licenses.resetRoblox(ctx.params.id) };
});

router.delete("/api/admin/licenses/:id", async (ctx) => {
	requireAdmin(ctx);
	await licenses.deleteLicense(ctx.params.id);
	return { ok: true };
});

// Kick a player out of the game. Their license isn't touched, so they can rejoin.
// The kick reaches them the next time their script checks in (every 15 seconds).
router.post("/api/admin/licenses/:id/kick", async (ctx) => {
	requireAdmin(ctx);

	const license = await licenses.getForAdmin(ctx.params.id);
	if (!license.accounts.length) {
		throw new HttpError(400, "This license has no Roblox account linked, so there's nobody to kick.");
	}

	const reason = typeof ctx.body.reason === "string" ? ctx.body.reason.trim().slice(0, 200) : "";
	const message = reason ? `You were kicked: ${reason}` : "You were kicked by an admin.";
	const online = license.accounts.filter((account) => presence.isOnline(account.id)).map((account) => account.username);

	// Kick every account on the license, in case they're on an alt.
	for (const account of license.accounts) presence.requestKick(account.id, message);

	return { ok: true, online };
});

router.get("/api/admin/script", async (ctx) => {
	requireAdmin(ctx);
	return { script: await scripts.info(), loaderUrl: `${siteUrl(ctx)}/loader.lua` };
});

router.post(UPLOAD_PATH, async (ctx) => {
	const admin = requireAdmin(ctx);

	const script = await scripts.upload({
		base64: ctx.body.base64,
		fileName: ctx.body.fileName,
		uploadedBy: admin.username,
	});

	return { script };
});

router.get("/api/admin/script/download", async (ctx) => {
	requireAdmin(ctx);

	const script = await scripts.current();
	if (!script) throw new HttpError(404, "No script has been uploaded yet.");

	const fileName = (script.info.fileName || "script.lua").replace(/[^\w.\- ]/g, "_");

	ctx.res.writeHead(200, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Disposition": `attachment; filename="${fileName}"`,
		"Cache-Control": "no-store",
	});
	ctx.res.end(script.source);
});

// ---------------------------------------------------------------------------
// Public API - what the Roblox script calls
// ---------------------------------------------------------------------------

// GET /api/check?robloxUserId=123  ->  { "allowed": true, "expiresAt": null }
router.get("/api/check", async (ctx) => {
	checkApiToken(ctx);

	const robloxUserId = Number(ctx.query.get("robloxUserId"));
	if (!Number.isSafeInteger(robloxUserId) || robloxUserId <= 0) {
		throw new HttpError(400, "robloxUserId must be a Roblox user ID number.");
	}

	return licenses.check(robloxUserId);
});

// GET /api/check-key?key=RAIN-XXXXX-XXXXX-XXXXX&robloxUserId=123
//   ->  { "allowed": true, "expiresAt": null }
//   ->  { "allowed": false, "reason": "wrong_account", "message": "This key is linked to a different Roblox account." }
// The key is the secret here, so this doesn't need PUBLIC_API_TOKEN
// (a token written into a script you hand out isn't secret anyway).
router.get("/api/check-key", async (ctx) => {
	const robloxUserId = parseRobloxUserId(ctx.query.get("robloxUserId"));

	rateLimit(`check-key:${robloxUserId}`, 20, 60 * 1000);

	const { result, license, account } = await licenses.verifyKey(ctx.query.get("key"), robloxUserId);
	if (!result.allowed) return result;

	const game = gameFromQuery(ctx.query);
	presence.seen(robloxUserId, game);

	// The script says start=1 once, when it starts. That's what the Activity tab lists.
	if (ctx.query.get("start") === "1") {
		await licenses.logExecution({ license, account, ...game });
	}

	// While it runs, it checks in with watch=1 every 15 seconds. That's when a kick reaches it:
	//   ->  { "allowed": true, "kick": true, "message": "You were kicked by an admin." }
	if (ctx.query.get("watch") === "1") {
		const kick = presence.takeKick(robloxUserId);
		if (kick) return { ...result, kick: true, message: kick.message };
	}

	return result;
});

// GET /api/script?key=RAIN-XXXXX-XXXXX-XXXXX&robloxUserId=123
//   ->  the script itself, but only for a key that works on that Roblox account
//   ->  403 { "error": "This key is linked to a different Roblox account.", "reason": "wrong_account" }
router.get("/api/script", async (ctx) => {
	const robloxUserId = parseRobloxUserId(ctx.query.get("robloxUserId"));
	rateLimit(`script:${robloxUserId}`, 10, 60 * 1000);

	const result = await licenses.checkKey(ctx.query.get("key"), robloxUserId);
	if (!result.allowed) {
		return sendJson(ctx.res, 403, { error: result.message, reason: result.reason });
	}

	const script = await scripts.current();
	if (!script) throw new HttpError(503, "The script hasn't been uploaded yet. Try again later.");

	presence.seen(robloxUserId);

	// Compress it when the executor says it can unzip (most can), which makes it about 5x smaller.
	const gzip = /\bgzip\b/.test(String(ctx.req.headers["accept-encoding"] || ""));

	ctx.res.writeHead(200, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
		Vary: "Accept-Encoding",
		...(gzip ? { "Content-Encoding": "gzip" } : {}),
	});
	ctx.res.end(gzip ? script.gzipped : script.source);
});

// GET /api/allowlist  ->  [ { "robloxUserId": 123, "robloxUsername": "...", "revoked": false } ]
router.get("/api/allowlist", async (ctx) => {
	checkApiToken(ctx);
	return licenses.publicList();
});

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handle(req, res) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Referrer-Policy", "same-origin");

	const url = new URL(req.url, "http://localhost");
	const isApi = url.pathname.startsWith("/api/");

	try {
		if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
			return sendStatic(res, PUBLIC, url.pathname.slice("/assets/".length));
		}

		const found = router.match(req.method, url.pathname);
		if (!found) throw new HttpError(404, "Not found");

		const changesData = ["POST", "PATCH", "DELETE"].includes(req.method);

		// Our pages always send JSON. Requiring it blocks other websites from
		// submitting forms to these endpoints with a logged-in visitor's cookie.
		if (isApi && changesData && !String(req.headers["content-type"] || "").startsWith("application/json")) {
			throw new HttpError(415, "Send requests as JSON.");
		}

		const sessionData = session.read(req);
		let maxBody;

		// Script uploads are big, so only read one from an admin.
		if (req.method === "POST" && url.pathname === UPLOAD_PATH) {
			if (!isAdmin(sessionData.user)) {
				throw new HttpError(sessionData.user ? 403 : 401, "Only admins can do that.");
			}
			maxBody = MAX_UPLOAD_BODY;
		}

		const ctx = {
			req,
			res,
			params: found.params,
			query: url.searchParams,
			session: sessionData,
			body: isApi && changesData ? await readJsonBody(req, maxBody) : {},
		};

		const result = await found.handler(ctx);

		if (result !== undefined && !res.headersSent) {
			sendJson(res, 200, result);
		}
	} catch (err) {
		if (res.headersSent) return;

		const status = err instanceof HttpError ? err.status : 500;

		if (status === 500) {
			console.error(err);
		}

		const message = status === 500 ? "Something went wrong on the server. Check the logs." : err.message;

		if (isApi) {
			sendJson(res, status, { error: message });
		} else {
			res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(message);
		}
	}
}

db.init()
	.then(() => {
		http.createServer(handle).listen(config.port, () => {
			console.log(`${config.siteName} license server listening on port ${config.port}`);
		});
	})
	.catch((err) => {
		console.error("Could not connect to the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
		console.error(err);
		process.exit(1);
	});
