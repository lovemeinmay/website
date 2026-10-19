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
				redeemed_by TEXT,
				-- 1 for keys added with "Add your own keys": they work straight away in the
				-- game and lock to the first Roblox account that uses them.
				claim_in_game INTEGER NOT NULL DEFAULT 0
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
			// A Roblox account is on one license for players; admins can put one account on
			// several licenses. It can't be on the same license twice.
			sql: `CREATE TABLE IF NOT EXISTS roblox_accounts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				license_id INTEGER NOT NULL,
				roblox_user_id INTEGER NOT NULL,
				roblox_username TEXT,
				linked_at TEXT NOT NULL,
				UNIQUE (license_id, roblox_user_id)
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
		{
			// The Server Tracker script, stored the same way as the main script.
			sql: `CREATE TABLE IF NOT EXISTS tracker_chunks (
				version INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY (version, idx)
			)`,
			args: [],
		},
		{
			sql: `CREATE TABLE IF NOT EXISTS tracker_info (
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
		{
			// Keys for the Server Tracker. Separate from license keys: a tracker key only
			// unlocks the tracker. It locks to the first Roblox account that uses it.
			sql: `CREATE TABLE IF NOT EXISTS tracker_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL UNIQUE,
				note TEXT,
				created_at TEXT NOT NULL,
				created_by TEXT,
				roblox_user_id INTEGER,
				roblox_username TEXT,
				claimed_at TEXT,
				last_used_at TEXT,
				revoked INTEGER NOT NULL DEFAULT 0
			)`,
			args: [],
		},
		{
			sql: "CREATE INDEX IF NOT EXISTS tracker_keys_by_roblox ON tracker_keys (roblox_user_id)",
			args: [],
		},
		{
			// Scripts for games other than Deepwoken, one per Roblox game (universe). Same Nya key.
			sql: `CREATE TABLE IF NOT EXISTS game_scripts (
				game_id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				place_id INTEGER,
				version INTEGER NOT NULL,
				size INTEGER NOT NULL,
				sha256 TEXT NOT NULL,
				file_name TEXT,
				uploaded_at TEXT NOT NULL,
				uploaded_by TEXT
			)`,
			args: [],
		},
		{
			sql: `CREATE TABLE IF NOT EXISTS game_script_chunks (
				game_id INTEGER NOT NULL,
				version INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY (game_id, version, idx)
			)`,
			args: [],
		},
	]);

	// Databases made when a Roblox account could only be on one license: rebuild the table
	// without that rule (keeping every row), so admins can share an account across licenses.
	const accountsTable = await first("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roblox_accounts'");
	if (accountsTable && /roblox_user_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i.test(String(accountsTable.sql))) {
		await batch([
			{
				sql: `CREATE TABLE roblox_accounts_new (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					license_id INTEGER NOT NULL,
					roblox_user_id INTEGER NOT NULL,
					roblox_username TEXT,
					linked_at TEXT NOT NULL,
					UNIQUE (license_id, roblox_user_id)
				)`,
				args: [],
			},
			{
				sql: `INSERT INTO roblox_accounts_new (id, license_id, roblox_user_id, roblox_username, linked_at)
					SELECT id, license_id, roblox_user_id, roblox_username, linked_at FROM roblox_accounts`,
				args: [],
			},
			{ sql: "DROP TABLE roblox_accounts", args: [] },
			{ sql: "ALTER TABLE roblox_accounts_new RENAME TO roblox_accounts", args: [] },
			{ sql: "CREATE INDEX IF NOT EXISTS roblox_accounts_by_license ON roblox_accounts (license_id)", args: [] },
		]);
	}

	await run("CREATE INDEX IF NOT EXISTS roblox_accounts_by_roblox ON roblox_accounts (roblox_user_id)");

	// Databases made before claim_in_game existed get the column added here.
	try {
		await run("ALTER TABLE license_keys ADD COLUMN claim_in_game INTEGER NOT NULL DEFAULT 0");
	} catch (err) {
		if (!/duplicate column/i.test(String(err && err.message))) throw err;
	}
}

module.exports = { init, query, first, run, batch, isUniqueError };
