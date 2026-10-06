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
const { HttpError, createRouter, readJsonBody, sendJson, redirect, sendStatic } = require("./src/http");

const VIEWS = path.join(__dirname, "views");
const PUBLIC = path.join(__dirname, "public");
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
	return { stats, licenses: licenseList, keys };
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

router.post("/api/admin/licenses/:id/reset-roblox", async (ctx) => {
	requireAdmin(ctx);
	return { license: await licenses.resetRoblox(ctx.params.id) };
});

router.delete("/api/admin/licenses/:id", async (ctx) => {
	requireAdmin(ctx);
	await licenses.deleteLicense(ctx.params.id);
	return { ok: true };
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
	const robloxUserId = Number(ctx.query.get("robloxUserId"));
	if (!Number.isSafeInteger(robloxUserId) || robloxUserId <= 0) {
		throw new HttpError(400, "robloxUserId must be a Roblox user ID number.");
	}

	rateLimit(`check-key:${robloxUserId}`, 20, 60 * 1000);

	return licenses.checkKey(ctx.query.get("key"), robloxUserId);
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

		const ctx = {
			req,
			res,
			params: found.params,
			query: url.searchParams,
			session: session.read(req),
			body: isApi && changesData ? await readJsonBody(req) : {},
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
