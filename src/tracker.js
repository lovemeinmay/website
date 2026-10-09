const db = require("./db");
const roblox = require("./roblox");
const { HttpError } = require("./http");

// Keys for the Server Tracker. They're separate from license keys: a tracker key only
// unlocks the tracker, and a license key doesn't. A key works straight away (no sign-in)
// and locks to the first Roblox account that uses it. An admin can revoke a key, or
// unlink it so another account can use it.

const KEY_PATTERN = /^[A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12}){1,5}$/;
const MAX_IMPORT = 2000;

const PROBLEMS = {
	invalid_key: "That tracker key doesn't exist. Check it for typos.",
	revoked: "This tracker key has been turned off. Contact an admin.",
	locked: "This tracker key is already being used by a different Roblox account.",
	roblox_taken: "This Roblox account already has a tracker key. Use that one.",
};

function problem(reason) {
	return { allowed: false, reason, message: PROBLEMS[reason] };
}

function nowIso() {
	return new Date().toISOString();
}

function normalizeKey(key) {
	return String(key || "").trim().toUpperCase().replace(/\s+/g, "");
}

function view(row) {
	return {
		id: row.id,
		key: row.key,
		note: row.note,
		createdAt: row.created_at,
		robloxUserId: row.roblox_user_id,
		robloxUsername: row.roblox_username,
		claimedAt: row.claimed_at,
		lastUsedAt: row.last_used_at,
		revoked: !!row.revoked,
	};
}

async function listKeys() {
	const rows = await db.query("SELECT * FROM tracker_keys ORDER BY created_at DESC, id DESC");
	return rows.map(view);
}

// Add keys (one per line, or separated by spaces or commas). Keys already added are skipped.
async function importKeys({ keys, note, createdBy }) {
	const text = Array.isArray(keys) ? keys.join("\n") : String(keys || "");
	const unique = [...new Set(text.split(/[\s,;]+/).map(normalizeKey).filter(Boolean))];

	if (!unique.length) throw new HttpError(400, "Paste at least one key.");
	if (unique.length > MAX_IMPORT) throw new HttpError(400, `You can add up to ${MAX_IMPORT} keys at a time.`);

	const invalid = unique.filter((key) => !KEY_PATTERN.test(key));
	const valid = unique.filter((key) => KEY_PATTERN.test(key));

	const existing = new Set();
	for (let i = 0; i < valid.length; i += 300) {
		const chunk = valid.slice(i, i + 300);
		const rows = await db.query(`SELECT key FROM tracker_keys WHERE key IN (${chunk.map(() => "?").join(",")})`, chunk);
		rows.forEach((row) => existing.add(row.key));
	}

	const fresh = valid.filter((key) => !existing.has(key));
	const createdAt = nowIso();
	const noteText = note ? String(note).slice(0, 200) : null;

	for (let i = 0; i < fresh.length; i += 200) {
		await db.batch(
			fresh.slice(i, i + 200).map((key) => ({
				sql: "INSERT OR IGNORE INTO tracker_keys (key, note, created_at, created_by) VALUES (?, ?, ?, ?)",
				args: [key, noteText, createdAt, createdBy || null],
			}))
		);
	}

	return { added: fresh.length, alreadyAdded: existing.size, invalid };
}

// Check a tracker key for a Roblox account. The first account to use an unused key gets it.
async function checkKey(key, robloxUserId) {
	const normalized = normalizeKey(key);
	const robloxId = Number(robloxUserId);
	if (!normalized) return problem("invalid_key");

	let row = await db.first("SELECT * FROM tracker_keys WHERE key = ?", [normalized]);
	if (!row) return problem("invalid_key");
	if (row.revoked) return problem("revoked");

	if (row.roblox_user_id === null || row.roblox_user_id === undefined) {
		// One key per Roblox account, so nobody collects a pile of them.
		const other = await db.first(
			"SELECT id FROM tracker_keys WHERE roblox_user_id = ? AND revoked = 0 AND id != ?",
			[robloxId, row.id]
		);
		if (other) return problem("roblox_taken");

		const now = nowIso();
		const claim = await db.run(
			"UPDATE tracker_keys SET roblox_user_id = ?, claimed_at = ? WHERE id = ? AND roblox_user_id IS NULL",
			[robloxId, now, row.id]
		);

		if (claim.changes) {
			const username = await roblox.usernameFor(robloxId);
			if (username) await db.run("UPDATE tracker_keys SET roblox_username = ? WHERE id = ?", [username, row.id]);
		}

		// Someone else may have claimed it at the same moment: look again.
		row = await db.first("SELECT * FROM tracker_keys WHERE id = ?", [row.id]);
	}

	if (Number(row.roblox_user_id) !== robloxId) return problem("locked");

	await db.run("UPDATE tracker_keys SET last_used_at = ? WHERE id = ?", [nowIso(), row.id]);
	return { allowed: true };
}

async function requireKey(id) {
	const row = await db.first("SELECT * FROM tracker_keys WHERE id = ?", [Number(id)]);
	if (!row) throw new HttpError(404, "Tracker key not found.");
	return row;
}

// Admin actions on one key: revoke or turn back on, or unlink its Roblox account.
async function updateKey(id, { revoked, unlink }) {
	const row = await requireKey(id);

	if (typeof revoked === "boolean") {
		await db.run("UPDATE tracker_keys SET revoked = ? WHERE id = ?", [revoked ? 1 : 0, row.id]);
	}

	if (unlink) {
		await db.run(
			"UPDATE tracker_keys SET roblox_user_id = NULL, roblox_username = NULL, claimed_at = NULL WHERE id = ?",
			[row.id]
		);
	}

	return view(await requireKey(id));
}

async function deleteKey(id) {
	const result = await db.run("DELETE FROM tracker_keys WHERE id = ?", [Number(id)]);
	if (!result.changes) throw new HttpError(404, "Tracker key not found.");
}

module.exports = { listKeys, importKeys, checkKey, updateKey, deleteKey };
