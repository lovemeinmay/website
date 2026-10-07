const { createClient } = require("@libsql/client");
const config = require("./config");

// Licenses are stored in Turso (a free hosted SQLite database), so they survive
// Render restarts. Without TURSO_DATABASE_URL it falls back to a local data.db
// file, which is fine on your own computer but gets wiped on Render's free plan.

if (!config.database.url) {
	console.warn("TURSO_DATABASE_URL is not set - using local data.db. Licenses will be lost when Render restarts.");
}

const client = createClient({
	url: config.database.url || "file:data.db",
	authToken: config.database.authToken || undefined,
});

// Turn a query result into plain objects keyed by column name.
function toObjects(result) {
	return result.rows.map((row) => {
		const obj = {};
		result.columns.forEach((column, index) => {
			obj[column] = row[index];
		});
		return obj;
	});
}

async function query(sql, args = []) {
	return toObjects(await client.execute({ sql, args }));
}

async function first(sql, args = []) {
	const rows = await query(sql, args);
	return rows[0] || null;
}

async function run(sql, args = []) {
	const result = await client.execute({ sql, args });
	return { changes: result.rowsAffected };
}

async function batch(statements) {
	await client.batch(statements, "write");
}

function isUniqueError(err) {
	return /UNIQUE constraint failed/i.test(String(err && err.message));
}

async function init() {
	await batch([
		{
			sql: `CREATE TABLE IF NOT EXISTS license_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL UNIQUE,
				duration_days INTEGER,
				note TEXT,
				created_at TEXT NOT NULL,
				created_by TEXT,
				redeemed_at TEXT,
				redeemed_by TEXT
			)`,
			args: [],
		},
		{
			sql: `CREATE TABLE IF NOT EXISTS licenses (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				discord_id TEXT NOT NULL UNIQUE,
				discord_username TEXT,
				-- No longer used: Roblox accounts are in roblox_accounts now.
				roblox_user_id INTEGER UNIQUE,
				roblox_username TEXT,
				roblox_linked_at TEXT,
				pending_roblox_user_id INTEGER,
				pending_roblox_username TEXT,
				pending_phrase TEXT,
				expires_at TEXT,
				revoked INTEGER NOT NULL DEFAULT 0,
				note TEXT,
				created_at TEXT NOT NULL
			)`,
			args: [],
		},
		{
			// Roblox accounts linked to a license (a license can have several).
			sql: `CREATE TABLE IF NOT EXISTS roblox_accounts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				license_id INTEGER NOT NULL,
				roblox_user_id INTEGER NOT NULL UNIQUE,
				roblox_username TEXT,
				linked_at TEXT NOT NULL
			)`,
			args: [],
		},
		{
			sql: "CREATE INDEX IF NOT EXISTS roblox_accounts_by_license ON roblox_accounts (license_id)",
			args: [],
		},
		{
			// Licenses used to hold one Roblox account in their own columns. Move any still
			// there into roblox_accounts. After the first run there's nothing left to move.
			sql: `INSERT OR IGNORE INTO roblox_accounts (license_id, roblox_user_id, roblox_username, linked_at)
				SELECT id, roblox_user_id, roblox_username, COALESCE(roblox_linked_at, created_at)
				FROM licenses WHERE roblox_user_id IS NOT NULL`,
			args: [],
		},
		{
			sql: "UPDATE licenses SET roblox_user_id = NULL, roblox_username = NULL, roblox_linked_at = NULL WHERE roblox_user_id IS NOT NULL",
			args: [],
		},
		{
			// Every time the script starts: who, on which account, in which game and server.
			sql: `CREATE TABLE IF NOT EXISTS executions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				license_id INTEGER,
				discord_username TEXT,
				roblox_user_id INTEGER NOT NULL,
				roblox_username TEXT,
				place_id INTEGER,
				game_name TEXT,
				job_id TEXT,
				executed_at TEXT NOT NULL
			)`,
			args: [],
		},
		{
			sql: "CREATE INDEX IF NOT EXISTS executions_by_time ON executions (executed_at)",
			args: [],
		},
		{
			// The script players load, split into pieces (see src/script.js).
			sql: `CREATE TABLE IF NOT EXISTS script_chunks (
				version INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY (version, idx)
			)`,
			args: [],
		},
		{
			sql: `CREATE TABLE IF NOT EXISTS script_info (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL,
				size INTEGER NOT NULL,
				sha256 TEXT NOT NULL,
				file_name TEXT,
				uploaded_at TEXT NOT NULL,
				uploaded_by TEXT
			)`,
			args: [],
		},
	]);
}

module.exports = { init, query, first, run, batch, isUniqueError };
