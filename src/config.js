const crypto = require("crypto");

// Load a local .env file when there is one (for testing on your own computer).
// On Render there's no .env file; settings come from the Environment tab instead.
try {
	process.loadEnvFile();
} catch {
	// No .env file - that's fine.
}

const env = process.env;
const isProduction = env.NODE_ENV === "production";

function list(value) {
	return (value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

let sessionSecret = env.SESSION_SECRET || "";

if (sessionSecret.length < 16) {
	if (isProduction) {
		console.error(
			"SESSION_SECRET is missing or shorter than 16 characters. Add a long random string under Render's Environment tab, then redeploy."
		);
		process.exit(1);
	}

	sessionSecret = crypto.randomBytes(32).toString("hex");
	console.warn("SESSION_SECRET is not set - using a random one. You'll be logged out every time the server restarts.");
}

const siteName = env.SITE_NAME || "Nya";

// The site's own address (https://your-app.onrender.com), used in the loader script.
// It's worked out from DISCORD_REDIRECT_URI, or you can set PUBLIC_URL yourself.
function originOf(value) {
	try {
		return new URL(value).origin;
	} catch {
		return "";
	}
}

const publicUrl = originOf(env.PUBLIC_URL) || originOf(env.DISCORD_REDIRECT_URI);

const config = {
	isProduction,
	port: Number(env.PORT) || 3000,
	siteName,
	publicUrl,
	keyPrefix: (env.KEY_PREFIX || siteName).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "KEY",
	sessionSecret,
	adminIds: list(env.ADMIN_DISCORD_IDS),
	publicApiToken: env.PUBLIC_API_TOKEN || "",
	maxRobloxAccounts: Math.max(1, Math.floor(Number(env.MAX_ROBLOX_ACCOUNTS) || 3)),
	robloxRelinkCooldownHours: env.ROBLOX_RELINK_COOLDOWN_HOURS === undefined ? 168 : Number(env.ROBLOX_RELINK_COOLDOWN_HOURS),
	discord: {
		clientId: env.DISCORD_CLIENT_ID || "",
		clientSecret: env.DISCORD_CLIENT_SECRET || "",
		redirectUri: env.DISCORD_REDIRECT_URI || "",
	},
	database: {
		url: env.TURSO_DATABASE_URL || "",
		authToken: env.TURSO_AUTH_TOKEN || "",
	},
};

const missing = [];
if (!config.discord.clientId) missing.push("DISCORD_CLIENT_ID");
if (!config.discord.clientSecret) missing.push("DISCORD_CLIENT_SECRET");
if (!config.discord.redirectUri) missing.push("DISCORD_REDIRECT_URI");
if (!config.adminIds.length) missing.push("ADMIN_DISCORD_IDS");

if (missing.length) {
	console.warn(`Missing settings: ${missing.join(", ")}. Discord login won't work until they're set.`);
}

module.exports = config;
