const { createClient } = require("@libsql/client");

// On Render, set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN so licenses live in Turso
// and survive restarts. Without them, it falls back to a local data.db file, which
// is fine for testing on your own computer but gets wiped on Render's free plan.
const url = process.env.TURSO_DATABASE_URL || "file:data.db";

if (!process.env.TURSO_DATABASE_URL) {
	console.warn("TURSO_DATABASE_URL is not set - using local data.db. Licenses will be lost on Render restarts.");
}

const client = createClient({
	url,
	authToken: process.env.TURSO_AUTH_TOKEN,
});

/**
 * Turn a query result into plain objects keyed by column name.
 */
function toObjects(result) {
	return result.rows.map((row) => {
		const obj = {};
		result.columns.forEach((column, index) => {
			obj[column] = row[index];
		});
		return obj;
	});
}

/**
 * Create the licenses table if it doesn't exist yet. Call once before the server starts.
 */
async function init() {
	await client.execute(`
		CREATE TABLE IF NOT EXISTS licenses (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			roblox_user_id INTEGER NOT NULL UNIQUE,
			roblox_username TEXT,
			discord_id TEXT,
			discord_username TEXT,
			note TEXT,
			revoked INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
}

/**
 * List every license, newest first.
 */
async function listLicenses() {
	const result = await client.execute("SELECT * FROM licenses ORDER BY created_at DESC, id DESC");
	return toObjects(result);
}

/**
 * Add a new license entry. roblox_user_id must be unique.
 */
async function addLicense({ robloxUserId, robloxUsername, discordId, discordUsername, note }) {
	try {
		await client.execute({
			sql: `
				INSERT INTO licenses (roblox_user_id, roblox_username, discord_id, discord_username, note)
				VALUES (?, ?, ?, ?, ?)
			`,
			args: [
				robloxUserId,
				robloxUsername || null,
				discordId || null,
				discordUsername || null,
				note || null,
			],
		});
	} catch (err) {
		if (String(err.message).includes("UNIQUE")) {
			throw new Error("That Roblox user already has a license.");
		}

		throw err;
	}
}

/**
 * Flip the revoked flag on a license.
 */
async function setRevoked(id, revoked) {
	await client.execute({
		sql: "UPDATE licenses SET revoked = ? WHERE id = ?",
		args: [revoked ? 1 : 0, Number(id)],
	});
}

/**
 * Delete a license entirely.
 */
async function deleteLicense(id) {
	await client.execute({
		sql: "DELETE FROM licenses WHERE id = ?",
		args: [Number(id)],
	});
}

/**
 * The slice of data the public /api/allowlist endpoint returns.
 * No Discord info leaves this server.
 */
async function publicList() {
	const result = await client.execute(
		"SELECT roblox_user_id AS robloxUserId, roblox_username AS robloxUsername, revoked FROM licenses"
	);

	return toObjects(result).map((row) => ({ ...row, revoked: !!row.revoked }));
}

module.exports = { init, listLicenses, addLicense, setRevoked, deleteLicense, publicList };
