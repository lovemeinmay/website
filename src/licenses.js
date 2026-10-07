const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const { HttpError } = require("./http");

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // No 0/O, 1/I/L - easy to read and type.

function nowIso() {
	return new Date().toISOString();
}

function addDays(fromIso, days) {
	return new Date(new Date(fromIso).getTime() + days * DAY_MS).toISOString();
}

function randomGroup(length) {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
	}
	return out;
}

function newKey() {
	return `${config.keyPrefix}-${randomGroup(5)}-${randomGroup(5)}-${randomGroup(5)}`;
}

function normalizeKey(key) {
	return String(key || "").trim().toUpperCase().replace(/\s+/g, "");
}

function parseDuration(value) {
	if (value === null || value === undefined || value === "" || value === "lifetime") return null;

	const days = Number(value);
	if (!Number.isInteger(days) || days < 1 || days > 3650) {
		throw new HttpError(400, "Duration must be a whole number of days from 1 to 3650, or lifetime.");
	}

	return days;
}

// ---------------------------------------------------------------------------
// License status
// ---------------------------------------------------------------------------

function statusOf(license, now = nowIso()) {
	if (license.revoked) return "revoked";
	if (license.expires_at && license.expires_at <= now) return "expired";
	if (!license.roblox_user_id) return "needs_roblox";
	return "active";
}

function isAllowed(license) {
	return statusOf(license) === "active";
}

function relinkAvailableAt(license) {
	const hours = config.robloxRelinkCooldownHours;
	if (!license.roblox_user_id || !license.roblox_linked_at || !(hours > 0)) return null;

	const at = new Date(new Date(license.roblox_linked_at).getTime() + hours * 60 * 60 * 1000).toISOString();
	return at > nowIso() ? at : null;
}

// What a user sees about their own license.
function forUser(license) {
	if (!license) return null;

	return {
		status: statusOf(license),
		expiresAt: license.expires_at,
		createdAt: license.created_at,
		roblox: license.roblox_user_id ? { id: license.roblox_user_id, username: license.roblox_username } : null,
		pending: license.pending_roblox_user_id
			? { id: license.pending_roblox_user_id, username: license.pending_roblox_username, phrase: license.pending_phrase }
			: null,
		relinkAvailableAt: relinkAvailableAt(license),
	};
}

// What the admin panel sees.
function forAdmin(license) {
	return {
		id: license.id,
		discordId: license.discord_id,
		discordUsername: license.discord_username,
		robloxUserId: license.roblox_user_id,
		robloxUsername: license.roblox_username,
		pendingRobloxUsername: license.pending_roblox_username,
		expiresAt: license.expires_at,
		revoked: !!license.revoked,
		note: license.note,
		createdAt: license.created_at,
		status: statusOf(license),
	};
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

async function createKeys({ count, duration, note, createdBy }) {
	const amount = Number(count);
	if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
		throw new HttpError(400, "You can make 1 to 100 keys at a time.");
	}

	const durationDays = parseDuration(duration);
	const createdAt = nowIso();
	const keys = [];

	for (let i = 0; i < amount; i++) keys.push(newKey());

	await db.batch(
		keys.map((key) => ({
			sql: "INSERT INTO license_keys (key, duration_days, note, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
			args: [key, durationDays, note ? String(note).slice(0, 200) : null, createdAt, createdBy || null],
		}))
	);

	return keys;
}

async function listKeys() {
	const rows = await db.query(`
		SELECT k.*, l.discord_username AS redeemed_by_username
		FROM license_keys k
		LEFT JOIN licenses l ON l.discord_id = k.redeemed_by
		ORDER BY k.created_at DESC, k.id DESC
	`);

	return rows.map((row) => ({
		id: row.id,
		key: row.key,
		durationDays: row.duration_days,
		note: row.note,
		createdAt: row.created_at,
		redeemedAt: row.redeemed_at,
		redeemedBy: row.redeemed_by,
		redeemedByUsername: row.redeemed_by_username,
	}));
}

async function deleteUnusedKey(id) {
	const result = await db.run("DELETE FROM license_keys WHERE id = ? AND redeemed_at IS NULL", [Number(id)]);

	if (!result.changes) {
		throw new HttpError(400, "Only unused keys can be deleted.");
	}
}

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

function getByDiscord(discordId) {
	return db.first("SELECT * FROM licenses WHERE discord_id = ?", [String(discordId)]);
}

function getById(id) {
	return db.first("SELECT * FROM licenses WHERE id = ?", [Number(id)]);
}

function getByRoblox(robloxUserId) {
	return db.first("SELECT * FROM licenses WHERE roblox_user_id = ?", [Number(robloxUserId)]);
}

async function requireById(id) {
	const license = await getById(id);
	if (!license) throw new HttpError(404, "License not found.");
	return license;
}

async function redeemKey({ key, discordId, discordUsername }) {
	const normalized = normalizeKey(key);
	if (!normalized) throw new HttpError(400, "Enter a license key.");

	const keyRow = await db.first("SELECT * FROM license_keys WHERE key = ?", [normalized]);
	if (!keyRow) throw new HttpError(400, "That key doesn't exist. Check it for typos.");
	if (keyRow.redeemed_at) throw new HttpError(400, "That key has already been used.");

	const existing = await getByDiscord(discordId);

	if (existing && existing.revoked) {
		throw new HttpError(403, "Your license has been revoked. Contact an admin.");
	}

	if (existing && !existing.expires_at) {
		throw new HttpError(400, "You already have a lifetime license, so you don't need another key.");
	}

	// Claim the key first. The "redeemed_at IS NULL" check means two people
	// can't use the same key at once - only one claim can succeed.
	const now = nowIso();
	const claim = await db.run(
		"UPDATE license_keys SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL",
		[now, String(discordId), keyRow.id]
	);

	if (!claim.changes) throw new HttpError(400, "That key has already been used.");

	try {
		let expiresAt = null;

		if (keyRow.duration_days) {
			// Stack time onto a license that hasn't run out yet; otherwise start from now.
			const base = existing && existing.expires_at && existing.expires_at > now ? existing.expires_at : now;
			expiresAt = addDays(base, keyRow.duration_days);
		}

		if (existing) {
			await db.run("UPDATE licenses SET expires_at = ?, discord_username = ? WHERE id = ?", [
				expiresAt,
				discordUsername || existing.discord_username,
				existing.id,
			]);
		} else {
			await db.run(
				"INSERT INTO licenses (discord_id, discord_username, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?)",
				[String(discordId), discordUsername || null, expiresAt, keyRow.note, now]
			);
		}
	} catch (err) {
		// Give the key back if the license couldn't be saved.
		await db.run("UPDATE license_keys SET redeemed_at = NULL, redeemed_by = NULL WHERE id = ?", [keyRow.id]);
		throw err;
	}

	return getByDiscord(discordId);
}

async function startRobloxLink(discordId, robloxUser, phrase) {
	const license = await getByDiscord(discordId);
	if (!license) throw new HttpError(400, "Redeem a license key first.");
	if (license.revoked) throw new HttpError(403, "Your license has been revoked. Contact an admin.");

	if (license.roblox_user_id === robloxUser.id) {
		throw new HttpError(400, "That Roblox account is already linked to your license.");
	}

	const waitUntil = relinkAvailableAt(license);
	if (waitUntil) {
		throw new HttpError(429, `You can change your Roblox account again after ${new Date(waitUntil).toUTCString()}.`);
	}

	const owner = await getByRoblox(robloxUser.id);
	if (owner && owner.discord_id !== String(discordId)) {
		throw new HttpError(409, "That Roblox account is already linked to someone else's license.");
	}

	// Starting again for the same account keeps the same phrase, in case it's already in their profile.
	const finalPhrase =
		license.pending_roblox_user_id === robloxUser.id && license.pending_phrase ? license.pending_phrase : phrase;

	await db.run(
		"UPDATE licenses SET pending_roblox_user_id = ?, pending_roblox_username = ?, pending_phrase = ? WHERE id = ?",
		[robloxUser.id, robloxUser.name, finalPhrase, license.id]
	);

	return getById(license.id);
}

async function completeRobloxLink(discordId, robloxUser) {
	try {
		await db.run(
			`UPDATE licenses
			SET roblox_user_id = ?, roblox_username = ?, roblox_linked_at = ?,
				pending_roblox_user_id = NULL, pending_roblox_username = NULL, pending_phrase = NULL
			WHERE discord_id = ?`,
			[robloxUser.id, robloxUser.name, nowIso(), String(discordId)]
		);
	} catch (err) {
		if (db.isUniqueError(err)) {
			throw new HttpError(409, "That Roblox account is already linked to someone else's license.");
		}
		throw err;
	}

	return getByDiscord(discordId);
}

async function cancelRobloxLink(discordId) {
	await db.run(
		"UPDATE licenses SET pending_roblox_user_id = NULL, pending_roblox_username = NULL, pending_phrase = NULL WHERE discord_id = ?",
		[String(discordId)]
	);
}

async function listLicenses() {
	const rows = await db.query("SELECT * FROM licenses ORDER BY created_at DESC, id DESC");
	return rows.map(forAdmin);
}

async function grantLicense({ discordId, discordUsername, robloxUser, duration, note }) {
	const id = String(discordId || "").trim();
	if (!/^\d{15,22}$/.test(id)) {
		throw new HttpError(400, "Enter a Discord user ID (the long number you get from Copy User ID).");
	}

	if (await getByDiscord(id)) {
		throw new HttpError(409, "That Discord user already has a license. Add time to it instead.");
	}

	const durationDays = parseDuration(duration);
	const now = nowIso();

	try {
		await db.run(
			`INSERT INTO licenses (discord_id, discord_username, roblox_user_id, roblox_username, roblox_linked_at, expires_at, note, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				discordUsername ? String(discordUsername).slice(0, 64) : null,
				robloxUser ? robloxUser.id : null,
				robloxUser ? robloxUser.name : null,
				robloxUser ? now : null,
				durationDays ? addDays(now, durationDays) : null,
				note ? String(note).slice(0, 200) : null,
				now,
			]
		);
	} catch (err) {
		if (db.isUniqueError(err)) {
			throw new HttpError(409, "That Roblox account is already linked to another license.");
		}
		throw err;
	}

	return forAdmin(await getByDiscord(id));
}

async function updateLicense(id, { revoked, addDays: days, lifetime, note }) {
	const license = await requireById(id);

	if (revoked !== undefined) {
		await db.run("UPDATE licenses SET revoked = ? WHERE id = ?", [revoked ? 1 : 0, license.id]);
	}

	if (lifetime) {
		await db.run("UPDATE licenses SET expires_at = NULL WHERE id = ?", [license.id]);
	} else if (days !== undefined) {
		const amount = Number(days);
		if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 3650) {
			throw new HttpError(400, "Days must be a whole number between -3650 and 3650 (not 0).");
		}

		if (license.expires_at) {
			const now = nowIso();
			// Adding time to an expired license counts from today, not from when it ran out.
			const base = amount > 0 && license.expires_at < now ? now : license.expires_at;
			await db.run("UPDATE licenses SET expires_at = ? WHERE id = ?", [addDays(base, amount), license.id]);
		}
		// Lifetime licenses ignore added days - they never expire anyway.
	}

	if (note !== undefined) {
		await db.run("UPDATE licenses SET note = ? WHERE id = ?", [note ? String(note).slice(0, 200) : null, license.id]);
	}

	return forAdmin(await getById(license.id));
}

async function getForAdmin(id) {
	return forAdmin(await requireById(id));
}

async function resetRoblox(id) {
	const license = await requireById(id);

	await db.run(
		`UPDATE licenses
		SET roblox_user_id = NULL, roblox_username = NULL, roblox_linked_at = NULL,
			pending_roblox_user_id = NULL, pending_roblox_username = NULL, pending_phrase = NULL
		WHERE id = ?`,
		[license.id]
	);

	return forAdmin(await getById(license.id));
}

async function deleteLicense(id) {
	const license = await requireById(id);
	await db.run("DELETE FROM licenses WHERE id = ?", [license.id]);
}

// ---------------------------------------------------------------------------
// What the Roblox script reads
// ---------------------------------------------------------------------------

async function check(robloxUserId) {
	const license = await getByRoblox(robloxUserId);

	if (!license || !isAllowed(license)) {
		return { allowed: false };
	}

	return { allowed: true, expiresAt: license.expires_at };
}

// ---------------------------------------------------------------------------
// Script keys - the key the script asks for when it starts
// ---------------------------------------------------------------------------

// Why a key was turned down. The script shows `message` to the player.
const KEY_PROBLEMS = {
	invalid_key: "That key doesn't exist. Check it for typos.",
	not_redeemed: "Redeem this key on the website first.",
	no_license: "This key's license no longer exists. Contact an admin.",
	revoked: "This license has been revoked. Contact an admin.",
	expired: "This license has expired. Redeem a new key on the website.",
	needs_roblox: "Link your Roblox account on the website first.",
	wrong_account: "This key is linked to a different Roblox account.",
};

function keyProblem(reason) {
	return { allowed: false, reason, message: KEY_PROBLEMS[reason] };
}

// A key works in the script once it's redeemed, and only on the Roblox
// account linked to that license.
async function checkKey(key, robloxUserId) {
	const normalized = normalizeKey(key);
	if (!normalized) return keyProblem("invalid_key");

	const keyRow = await db.first("SELECT redeemed_by FROM license_keys WHERE key = ?", [normalized]);
	if (!keyRow) return keyProblem("invalid_key");
	if (!keyRow.redeemed_by) return keyProblem("not_redeemed");

	const license = await getByDiscord(keyRow.redeemed_by);
	if (!license) return keyProblem("no_license");

	const status = statusOf(license);
	if (status !== "active") return keyProblem(status);

	if (Number(license.roblox_user_id) !== Number(robloxUserId)) {
		return keyProblem("wrong_account");
	}

	return { allowed: true, expiresAt: license.expires_at };
}

// The key a user pastes into the script: the newest one they redeemed.
// Licenses an admin granted directly never had a key, so they get one here
// the first time they need it.
async function scriptKeyFor(discordId) {
	const id = String(discordId);

	const row = await db.first(
		"SELECT key FROM license_keys WHERE redeemed_by = ? ORDER BY redeemed_at DESC, id DESC LIMIT 1",
		[id]
	);
	if (row) return row.key;

	if (!(await getByDiscord(id))) return null;

	const now = nowIso();

	for (let attempt = 0; attempt < 3; attempt++) {
		const key = newKey();

		try {
			await db.run(
				`INSERT INTO license_keys (key, duration_days, note, created_at, created_by, redeemed_at, redeemed_by)
				VALUES (?, NULL, ?, ?, NULL, ?, ?)`,
				[key, "Script key for a license given without a key", now, now, id]
			);
			return key;
		} catch (err) {
			if (!db.isUniqueError(err)) throw err;
		}
	}

	return null;
}

// Same shape as the old /api/allowlist, so scripts that already read it keep working.
// "revoked" is true for anyone who isn't currently allowed (revoked or expired).
async function publicList() {
	const rows = await db.query("SELECT * FROM licenses WHERE roblox_user_id IS NOT NULL");

	return rows.map((license) => ({
		robloxUserId: license.roblox_user_id,
		robloxUsername: license.roblox_username,
		revoked: !isAllowed(license),
	}));
}

async function stats() {
	const now = nowIso();
	const [licenseCounts, keyCounts] = await Promise.all([
		db.first(
			`SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN revoked = 0 AND roblox_user_id IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active
			FROM licenses`,
			[now]
		),
		db.first("SELECT SUM(CASE WHEN redeemed_at IS NULL THEN 1 ELSE 0 END) AS unused FROM license_keys"),
	]);

	return {
		licenses: Number(licenseCounts.total) || 0,
		active: Number(licenseCounts.active) || 0,
		unusedKeys: Number(keyCounts.unused) || 0,
	};
}

module.exports = {
	forUser,
	createKeys,
	listKeys,
	deleteUnusedKey,
	getByDiscord,
	redeemKey,
	startRobloxLink,
	completeRobloxLink,
	cancelRobloxLink,
	listLicenses,
	grantLicense,
	updateLicense,
	getForAdmin,
	resetRoblox,
	deleteLicense,
	check,
	checkKey,
	scriptKeyFor,
	publicList,
	stats,
};
