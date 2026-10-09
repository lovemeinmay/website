const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const { HttpError } = require("./http");
const roblox = require("./roblox");

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

// license.accounts is filled in by withAccounts(): [{ roblox_user_id, roblox_username, linked_at }]
function statusOf(license, now = nowIso()) {
	if (license.revoked) return "revoked";
	if (license.expires_at && license.expires_at <= now) return "expired";
	if (!license.accounts || !license.accounts.length) return "needs_roblox";
	return "active";
}

function isAllowed(license) {
	return statusOf(license) === "active";
}

// Players can't unlink an account until it's been linked this long, so one license
// can't be passed around between lots of people. Admins can unlink any time.
function removableAt(account) {
	const hours = config.robloxRelinkCooldownHours;
	if (!(hours > 0) || !account.linked_at) return null;

	const at = new Date(new Date(account.linked_at).getTime() + hours * 60 * 60 * 1000).toISOString();
	return at > nowIso() ? at : null;
}

// Admins can link as many accounts as they like, and remove them without waiting.
function accountLimit(admin) {
	return admin ? Infinity : config.maxRobloxAccounts;
}

// What a user sees about their own license. maxAccounts is null when there's no limit (admins).
function forUser(license, { admin = false } = {}) {
	if (!license) return null;

	return {
		status: statusOf(license),
		expiresAt: license.expires_at,
		createdAt: license.created_at,
		accounts: license.accounts.map((account) => ({
			id: account.roblox_user_id,
			username: account.roblox_username,
			linkedAt: account.linked_at,
			removableAt: admin ? null : removableAt(account),
		})),
		maxAccounts: admin ? null : config.maxRobloxAccounts,
	};
}

// What the admin panel sees.
function forAdmin(license) {
	return {
		id: license.id,
		discordId: license.discord_id,
		discordUsername: license.discord_username,
		accounts: license.accounts.map((account) => ({ id: account.roblox_user_id, username: account.roblox_username })),
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
		inGame: !!row.claim_in_game,
	}));
}

// Keys you already have (in any format like XXXX-XXXX-XXXX-XXXX) can be added in bulk.
// They work straight away in the game: the first Roblox account to use one gets it,
// and from then on it only works on that account. They can still be redeemed on the
// website instead, like any other key, if nobody has used them in a game yet.
const IMPORT_KEY_PATTERN = /^[A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12}){1,5}$/;
const MAX_IMPORT = 2000;

async function importKeys({ keys, duration, note, createdBy }) {
	const text = Array.isArray(keys) ? keys.join("\n") : String(keys || "");
	const unique = [...new Set(text.split(/[\s,;]+/).map(normalizeKey).filter(Boolean))];

	if (!unique.length) throw new HttpError(400, "Paste at least one key.");
	if (unique.length > MAX_IMPORT) throw new HttpError(400, `You can add up to ${MAX_IMPORT} keys at a time.`);

	const invalid = unique.filter((key) => !IMPORT_KEY_PATTERN.test(key));
	const valid = unique.filter((key) => IMPORT_KEY_PATTERN.test(key));
	const durationDays = parseDuration(duration);

	// Skip keys that are already on the site.
	const existing = new Set();
	for (let i = 0; i < valid.length; i += 300) {
		const chunk = valid.slice(i, i + 300);
		const rows = await db.query(`SELECT key FROM license_keys WHERE key IN (${chunk.map(() => "?").join(",")})`, chunk);
		rows.forEach((row) => existing.add(row.key));
	}

	const fresh = valid.filter((key) => !existing.has(key));
	const createdAt = nowIso();
	const noteText = note ? String(note).slice(0, 200) : null;

	for (let i = 0; i < fresh.length; i += 200) {
		await db.batch(
			fresh.slice(i, i + 200).map((key) => ({
				sql: `INSERT OR IGNORE INTO license_keys (key, duration_days, note, created_at, created_by, claim_in_game)
					VALUES (?, ?, ?, ?, ?, 1)`,
				args: [key, durationDays, noteText, createdAt, createdBy || null],
			}))
		);
	}

	return { added: fresh.length, alreadyAdded: existing.size, invalid };
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

// Fill in license.accounts for one license or a list of them.
async function withAccounts(licenses) {
	const list = Array.isArray(licenses) ? licenses : [licenses];
	const real = list.filter(Boolean);
	if (!real.length) return licenses;

	const ids = real.map((license) => license.id);
	const rows = await db.query(
		`SELECT * FROM roblox_accounts WHERE license_id IN (${ids.map(() => "?").join(", ")}) ORDER BY linked_at, id`,
		ids
	);

	for (const license of real) {
		license.accounts = rows.filter((row) => row.license_id === license.id);
	}

	return licenses;
}

async function getByDiscord(discordId) {
	return withAccounts(await db.first("SELECT * FROM licenses WHERE discord_id = ?", [String(discordId)]));
}

async function getById(id) {
	return withAccounts(await db.first("SELECT * FROM licenses WHERE id = ?", [Number(id)]));
}

async function getByRoblox(robloxUserId) {
	return withAccounts(
		await db.first(
			"SELECT l.* FROM licenses l JOIN roblox_accounts a ON a.license_id = l.id WHERE a.roblox_user_id = ?",
			[Number(robloxUserId)]
		)
	);
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

// Link a Roblox account to the user's own license by username. No ownership proof:
// the key just locks to whatever account is linked here.
// Link a Roblox account to a license, moving it off any other license it's on.
// Only admins get to do this. Both steps happen together, so the account is never
// left on two licenses or on none. Gives back the name of the license it came from.
async function linkMovingFromOtherLicense(license, robloxUser) {
	const previous = await getByRoblox(robloxUser.id);
	const movedFrom = previous && previous.id !== license.id ? previous.discord_username || previous.discord_id : null;

	await db.batch([
		{
			sql: "DELETE FROM roblox_accounts WHERE roblox_user_id = ? AND license_id != ?",
			args: [robloxUser.id, license.id],
		},
		{
			sql: "INSERT INTO roblox_accounts (license_id, roblox_user_id, roblox_username, linked_at) VALUES (?, ?, ?, ?)",
			args: [license.id, robloxUser.id, robloxUser.name, nowIso()],
		},
	]);

	return movedFrom;
}

async function linkRobloxAccount(discordId, robloxUser, { admin = false } = {}) {
	const license = await getByDiscord(discordId);
	if (!license) throw new HttpError(400, "Redeem a license key first.");
	if (license.revoked) throw new HttpError(403, "Your license has been revoked. Contact an admin.");

	if (license.accounts.some((account) => account.roblox_user_id === robloxUser.id)) {
		throw new HttpError(400, "That Roblox account is already linked to your license.");
	}

	if (license.accounts.length >= accountLimit(admin)) {
		throw new HttpError(
			400,
			`You've linked ${config.maxRobloxAccounts} accounts, which is the most a license can have. Remove one to add another.`
		);
	}

	// Admins can link an account that's on someone else's license: it moves to theirs.
	if (admin) {
		await linkMovingFromOtherLicense(license, robloxUser);
		return getByDiscord(discordId);
	}

	const owner = await getByRoblox(robloxUser.id);
	if (owner && owner.discord_id !== String(discordId)) {
		throw new HttpError(409, "That Roblox account is already linked to someone else's license.");
	}

	try {
		await db.run("INSERT INTO roblox_accounts (license_id, roblox_user_id, roblox_username, linked_at) VALUES (?, ?, ?, ?)", [
			license.id,
			robloxUser.id,
			robloxUser.name,
			nowIso(),
		]);
	} catch (err) {
		if (db.isUniqueError(err)) {
			throw new HttpError(409, "That Roblox account is already linked to someone else's license.");
		}
		throw err;
	}

	return getByDiscord(discordId);
}

// A player unlinking one of their own accounts.
async function removeRobloxAccount(discordId, robloxUserId, { admin = false } = {}) {
	const license = await getByDiscord(discordId);
	const account = license && license.accounts.find((item) => item.roblox_user_id === Number(robloxUserId));
	if (!account) throw new HttpError(404, "That Roblox account isn't linked to your license.");

	const waitUntil = admin ? null : removableAt(account);
	if (waitUntil) {
		throw new HttpError(429, `You can remove ${account.roblox_username} after ${new Date(waitUntil).toUTCString()}.`);
	}

	await db.run("DELETE FROM roblox_accounts WHERE id = ?", [account.id]);
	return getByDiscord(discordId);
}

async function listLicenses() {
	const rows = await withAccounts(await db.query("SELECT * FROM licenses ORDER BY created_at DESC, id DESC"));
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

	const statements = [
		{
			sql: `INSERT INTO licenses (discord_id, discord_username, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?)`,
			args: [
				id,
				discordUsername ? String(discordUsername).slice(0, 64) : null,
				durationDays ? addDays(now, durationDays) : null,
				note ? String(note).slice(0, 200) : null,
				now,
			],
		},
	];

	if (robloxUser) {
		statements.push({
			sql: `INSERT INTO roblox_accounts (license_id, roblox_user_id, roblox_username, linked_at)
				VALUES ((SELECT id FROM licenses WHERE discord_id = ?), ?, ?, ?)`,
			args: [id, robloxUser.id, robloxUser.name, now],
		});
	}

	// Both or neither: no license is left behind if the Roblox account is taken.
	try {
		await db.batch(statements);
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

// Unlink every Roblox account from a license (admin).
async function resetRoblox(id) {
	const license = await requireById(id);

	await db.batch([
		{ sql: "DELETE FROM roblox_accounts WHERE license_id = ?", args: [license.id] },
		{
			sql: "UPDATE licenses SET pending_roblox_user_id = NULL, pending_roblox_username = NULL, pending_phrase = NULL WHERE id = ?",
			args: [license.id],
		},
	]);

	return forAdmin(await getById(license.id));
}

// Link a Roblox account to any license straight away (admin): no profile phrase, no limit.
async function addAccount(id, robloxUser) {
	const license = await requireById(id);

	if (license.accounts.some((account) => account.roblox_user_id === robloxUser.id)) {
		throw new HttpError(400, `${robloxUser.name} is already linked to this license.`);
	}

	// Already on another license? Move it here (admins only reach this).
	const movedFrom = await linkMovingFromOtherLicense(license, robloxUser);

	return { ...forAdmin(await getById(license.id)), movedFrom };
}

// Unlink one Roblox account from a license (admin, no waiting).
async function unlinkAccount(id, robloxUserId) {
	const license = await requireById(id);
	const result = await db.run("DELETE FROM roblox_accounts WHERE license_id = ? AND roblox_user_id = ?", [
		license.id,
		Number(robloxUserId),
	]);

	if (!result.changes) throw new HttpError(404, "That Roblox account isn't linked to this license.");
	return forAdmin(await getById(license.id));
}

async function deleteLicense(id) {
	const license = await requireById(id);

	await db.batch([
		{ sql: "DELETE FROM roblox_accounts WHERE license_id = ?", args: [license.id] },
		{ sql: "DELETE FROM licenses WHERE id = ?", args: [license.id] },
	]);
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
	wrong_account: "This Roblox account isn't linked to your license. Add it on the website.",
	locked: "This key is already being used by a different Roblox account.",
	roblox_taken: "This Roblox account already has a license, so it can't take a new key. Use your existing key.",
};

// Licenses made by using a key in the game (no Discord) are owned by "key:<the key>".
const IN_GAME_OWNER = "key:";

// First use of an "Add your own keys" key in the game: make it a license locked to this Roblox account.
// Gives back { owner } when the key now belongs to someone, or { problem } when it can't be claimed.
async function claimInGame(keyRow, key, robloxUserId) {
	const robloxId = Number(robloxUserId);
	if (!Number.isSafeInteger(robloxId) || robloxId <= 0) return { problem: "invalid_key" };

	if (await getByRoblox(robloxId)) return { problem: "roblox_taken" };

	const owner = IN_GAME_OWNER + key;
	const now = nowIso();

	// Same trick as redeeming: only one claim can win.
	const claim = await db.run(
		"UPDATE license_keys SET redeemed_at = ?, redeemed_by = ? WHERE id = ? AND redeemed_at IS NULL",
		[now, owner, keyRow.id]
	);

	if (!claim.changes) {
		const row = await db.first("SELECT redeemed_by FROM license_keys WHERE id = ?", [keyRow.id]);
		return { owner: row && row.redeemed_by };
	}

	const username = await roblox.usernameFor(robloxId);

	try {
		await db.batch([
			{
				sql: "INSERT INTO licenses (discord_id, discord_username, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?)",
				args: [
					owner,
					username ? `${username} (in game)` : "In game",
					keyRow.duration_days ? addDays(now, keyRow.duration_days) : null,
					keyRow.note || "Key used in game",
					now,
				],
			},
			{
				sql: `INSERT INTO roblox_accounts (license_id, roblox_user_id, roblox_username, linked_at)
					VALUES ((SELECT id FROM licenses WHERE discord_id = ?), ?, ?, ?)`,
				args: [owner, robloxId, username, now],
			},
		]);
	} catch (err) {
		// Give the key back so it can be tried again.
		await db.run("UPDATE license_keys SET redeemed_at = NULL, redeemed_by = NULL WHERE id = ?", [keyRow.id]);
		if (db.isUniqueError(err)) return { problem: "roblox_taken" };
		throw err;
	}

	return { owner };
}

function keyProblem(reason) {
	return { allowed: false, reason, message: KEY_PROBLEMS[reason] };
}

// A key works in the script once it's redeemed, and only on the Roblox
// account linked to that license.
// Check a key for a Roblox account. Gives back what the script sees (`result`), plus the
// license and account it matched, for the site's own use (logging, kicks).
async function verifyKey(key, robloxUserId) {
	const normalized = normalizeKey(key);
	if (!normalized) return { result: keyProblem("invalid_key") };

	const keyRow = await db.first(
		"SELECT id, redeemed_by, duration_days, note, claim_in_game FROM license_keys WHERE key = ?",
		[normalized]
	);
	if (!keyRow) return { result: keyProblem("invalid_key") };

	let owner = keyRow.redeemed_by;

	if (!owner) {
		if (!keyRow.claim_in_game) return { result: keyProblem("not_redeemed") };

		const claimed = await claimInGame(keyRow, normalized, robloxUserId);
		if (claimed.problem) return { result: keyProblem(claimed.problem) };
		owner = claimed.owner;
	}

	const license = await getByDiscord(owner);
	if (!license) return { result: keyProblem("no_license") };

	const status = statusOf(license);
	if (status !== "active") return { result: keyProblem(status), license };

	const account = license.accounts.find((item) => item.roblox_user_id === Number(robloxUserId));
	if (!account) {
		const inGame = String(license.discord_id).startsWith(IN_GAME_OWNER);
		return { result: keyProblem(inGame ? "locked" : "wrong_account"), license };
	}

	return { result: { allowed: true, expiresAt: license.expires_at }, license, account };
}

// A key works in the script once it's redeemed, and only on Roblox accounts linked to that license.
async function checkKey(key, robloxUserId) {
	return (await verifyKey(key, robloxUserId)).result;
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
	const rows = await withAccounts(await db.query("SELECT * FROM licenses"));

	return rows.flatMap((license) =>
		license.accounts.map((account) => ({
			robloxUserId: account.roblox_user_id,
			robloxUsername: account.roblox_username,
			revoked: !isAllowed(license),
		}))
	);
}

// ---------------------------------------------------------------------------
// Executions - every time the script starts, and in which game
// ---------------------------------------------------------------------------

const KEEP_EXECUTIONS_DAYS = 90;

async function logExecution({ license, account, placeId, gameName, jobId }) {
	const now = nowIso();

	await db.run(
		`INSERT INTO executions (license_id, discord_username, roblox_user_id, roblox_username, place_id, game_name, job_id, executed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[license.id, license.discord_username, account.roblox_user_id, account.roblox_username, placeId, gameName, jobId, now]
	);

	// Now and then, clear out old history so the table doesn't grow forever.
	if (crypto.randomInt(50) === 0) {
		await db.run("DELETE FROM executions WHERE executed_at < ?", [addDays(now, -KEEP_EXECUTIONS_DAYS)]);
	}
}

async function listExecutions({ licenseId, limit } = {}) {
	const count = Math.min(Math.max(Number(limit) || 200, 1), 1000);
	const rows = licenseId
		? await db.query("SELECT * FROM executions WHERE license_id = ? ORDER BY id DESC LIMIT ?", [Number(licenseId), count])
		: await db.query("SELECT * FROM executions ORDER BY id DESC LIMIT ?", [count]);

	return rows.map((row) => ({
		id: row.id,
		licenseId: row.license_id,
		discordUsername: row.discord_username,
		robloxUserId: row.roblox_user_id,
		robloxUsername: row.roblox_username,
		placeId: row.place_id,
		gameName: row.game_name,
		jobId: row.job_id,
		executedAt: row.executed_at,
	}));
}

async function stats() {
	const now = nowIso();
	const [licenseCounts, keyCounts] = await Promise.all([
		db.first(
			`SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
					AND EXISTS (SELECT 1 FROM roblox_accounts a WHERE a.license_id = licenses.id) THEN 1 ELSE 0 END) AS active
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
	importKeys,
	listKeys,
	deleteUnusedKey,
	getByDiscord,
	redeemKey,
	linkRobloxAccount,
	listLicenses,
	grantLicense,
	updateLicense,
	getForAdmin,
	resetRoblox,
	deleteLicense,
	check,
	checkKey,
	verifyKey,
	removeRobloxAccount,
	addAccount,
	unlinkAccount,
	logExecution,
	listExecutions,
	scriptKeyFor,
	publicList,
	stats,
};
