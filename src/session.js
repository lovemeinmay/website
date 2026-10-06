const crypto = require("crypto");
const config = require("./config");

// Sessions live in a signed cookie, so logins survive server restarts and
// Render's free-tier sleep. The signature stops anyone from editing the cookie
// to pretend to be someone else.

const COOKIE_NAME = "session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 1 week.

function sign(value) {
	return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

function parseCookies(header) {
	const cookies = {};

	for (const part of (header || "").split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;

		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();

		try {
			cookies[name] = decodeURIComponent(value);
		} catch {
			// Ignore malformed cookies.
		}
	}

	return cookies;
}

function read(req) {
	const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
	if (!raw) return {};

	const [payload, signature] = raw.split(".");
	if (!payload || !signature) return {};

	const expected = Buffer.from(sign(payload));
	const given = Buffer.from(signature);

	if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
		return {};
	}

	try {
		const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

		if (!data || typeof data !== "object" || (data.exp && data.exp < Date.now())) {
			return {};
		}

		delete data.exp;
		return data;
	} catch {
		return {};
	}
}

function cookieAttributes(maxAge) {
	const parts = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAge}`];
	if (config.isProduction) parts.push("Secure");
	return parts.join("; ");
}

function write(res, data) {
	const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + MAX_AGE_SECONDS * 1000 })).toString("base64url");
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=${payload}.${sign(payload)}; ${cookieAttributes(MAX_AGE_SECONDS)}`);
}

function clear(res) {
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

module.exports = { read, write, clear };
