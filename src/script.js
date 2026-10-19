const crypto = require("crypto");
const zlib = require("zlib");
const db = require("./db");
const { HttpError } = require("./http");

// The Roblox scripts live in the database (not in this repo, which is public).
// Each one is split into chunks so no single database request gets too big, and the
// newest version is kept in memory so most loads don't touch the database.
// There are two: the main script (script_chunks / script_info) and the Server Tracker
// (tracker_chunks / tracker_info). Both work the same way.

const CHUNK_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 15 * 1024 * 1024;

function nowIso() {
	return new Date().toISOString();
}

function describe(info) {
	if (!info) return null;

	return {
		version: info.version,
		size: info.size,
		sha256: info.sha256,
		fileName: info.file_name,
		uploadedAt: info.uploaded_at,
		uploadedBy: info.uploaded_by,
	};
}

// Table names come from the code below, never from a request.
function createStore({ chunksTable, infoTable }) {
	let cache = null; // { version, source: Buffer, gzipped: Buffer }

	function getInfo() {
		return db.first(`SELECT * FROM ${infoTable} WHERE id = 1`);
	}

	async function info() {
		return describe(await getInfo());
	}

	// The current script as { info, source, gzipped }, or null if none has been uploaded.
	async function current() {
		const row = await getInfo();
		if (!row) return null;

		if (!cache || cache.version !== row.version) {
			const chunks = await db.query(`SELECT data FROM ${chunksTable} WHERE version = ? ORDER BY idx`, [row.version]);
			const source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data)));

			if (source.length !== row.size) {
				throw new Error(`Stored script is ${source.length} bytes but should be ${row.size}. Upload it again.`);
			}

			cache = { version: row.version, source, gzipped: zlib.gzipSync(source) };
		}

		return { info: describe(row), source: cache.source, gzipped: cache.gzipped };
	}

	async function upload({ base64, fileName, uploadedBy }) {
		if (typeof base64 !== "string" || !base64) {
			throw new HttpError(400, "Choose a .lua file to upload.");
		}

		const source = Buffer.from(base64, "base64");

		if (!source.length) throw new HttpError(400, "That file is empty.");
		if (source.length > MAX_SCRIPT_BYTES) throw new HttpError(413, "That file is bigger than 15 MB.");

		const version = Date.now();
		const now = nowIso();

		try {
			// Write the new version's chunks first, one request each...
			for (let offset = 0, idx = 0; offset < source.length; offset += CHUNK_BYTES, idx++) {
				await db.run(`INSERT INTO ${chunksTable} (version, idx, data) VALUES (?, ?, ?)`, [
					version,
					idx,
					source.subarray(offset, offset + CHUNK_BYTES),
				]);
			}

			// ...then switch to it in one step, so players never get half a script.
			await db.run(
				`INSERT OR REPLACE INTO ${infoTable} (id, version, size, sha256, file_name, uploaded_at, uploaded_by)
				VALUES (1, ?, ?, ?, ?, ?, ?)`,
				[
					version,
					source.length,
					crypto.createHash("sha256").update(source).digest("hex"),
					fileName ? String(fileName).slice(0, 120) : null,
					now,
					uploadedBy ? String(uploadedBy).slice(0, 64) : null,
				]
			);
		} catch (err) {
			await db.run(`DELETE FROM ${chunksTable} WHERE version = ?`, [version]).catch(() => {});
			throw err;
		}

		// Old versions aren't needed any more.
		await db.run(`DELETE FROM ${chunksTable} WHERE version != ?`, [version]);

		cache = null;
		return info();
	}

	return { info, current, upload };
}

// Scripts for other games (one per Roblox game id), unlocked by the same Nya key.
function describeGame(row) {
	if (!row) return null;

	return {
		gameId: Number(row.game_id),
		name: row.name,
		placeId: row.place_id == null ? null : Number(row.place_id),
		version: row.version,
		size: row.size,
		sha256: row.sha256,
		fileName: row.file_name,
		uploadedAt: row.uploaded_at,
		uploadedBy: row.uploaded_by,
	};
}

function createGameStore() {
	const cache = new Map(); // gameId -> { version, source, gzipped }

	async function list() {
		const rows = await db.query("SELECT * FROM game_scripts ORDER BY name COLLATE NOCASE");
		return rows.map(describeGame);
	}

	function getRow(gameId) {
		return db.first("SELECT * FROM game_scripts WHERE game_id = ?", [Number(gameId)]);
	}

	// { info, source, gzipped } for this game, or null if it has no script.
	async function current(gameId) {
		const row = await getRow(gameId);
		if (!row) return null;

		const cached = cache.get(Number(row.game_id));
		if (cached && cached.version === row.version) {
			return { info: describeGame(row), source: cached.source, gzipped: cached.gzipped };
		}

		const chunks = await db.query("SELECT data FROM game_script_chunks WHERE game_id = ? AND version = ? ORDER BY idx", [
			row.game_id,
			row.version,
		]);
		const source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data)));

		if (source.length !== row.size) {
			throw new Error(`Stored script for game ${row.game_id} is ${source.length} bytes but should be ${row.size}. Upload it again.`);
		}

		const entry = { version: row.version, source, gzipped: zlib.gzipSync(source) };
		cache.set(Number(row.game_id), entry);

		return { info: describeGame(row), source, gzipped: entry.gzipped };
	}

	async function upload({ gameId, placeId, name, base64, fileName, uploadedBy }) {
		gameId = Number(gameId);
		if (!Number.isSafeInteger(gameId) || gameId <= 0) throw new HttpError(400, "Missing the game.");

		const cleanName = String(name || "").trim().slice(0, 80);
		if (!cleanName) throw new HttpError(400, "Give the game a name.");

		if (typeof base64 !== "string" || !base64) throw new HttpError(400, "Choose a .lua file to upload.");

		const source = Buffer.from(base64, "base64");
		if (!source.length) throw new HttpError(400, "That file is empty.");
		if (source.length > MAX_SCRIPT_BYTES) throw new HttpError(413, "That file is bigger than 15 MB.");

		const version = Date.now();

		try {
			for (let offset = 0, idx = 0; offset < source.length; offset += CHUNK_BYTES, idx++) {
				await db.run("INSERT INTO game_script_chunks (game_id, version, idx, data) VALUES (?, ?, ?, ?)", [
					gameId,
					version,
					idx,
					source.subarray(offset, offset + CHUNK_BYTES),
				]);
			}

			await db.run(
				`INSERT OR REPLACE INTO game_scripts
					(game_id, name, place_id, version, size, sha256, file_name, uploaded_at, uploaded_by)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					gameId,
					cleanName,
					placeId ? Number(placeId) : null,
					version,
					source.length,
					crypto.createHash("sha256").update(source).digest("hex"),
					fileName ? String(fileName).slice(0, 120) : null,
					nowIso(),
					uploadedBy ? String(uploadedBy).slice(0, 64) : null,
				]
			);
		} catch (err) {
			await db.run("DELETE FROM game_script_chunks WHERE game_id = ? AND version = ?", [gameId, version]).catch(() => {});
			throw err;
		}

		await db.run("DELETE FROM game_script_chunks WHERE game_id = ? AND version != ?", [gameId, version]);

		cache.delete(gameId);
		return describeGame(await getRow(gameId));
	}

	async function remove(gameId) {
		gameId = Number(gameId);
		const row = await getRow(gameId);
		if (!row) throw new HttpError(404, "That game has no script.");

		await db.run("DELETE FROM game_scripts WHERE game_id = ?", [gameId]);
		await db.run("DELETE FROM game_script_chunks WHERE game_id = ?", [gameId]);
		cache.delete(gameId);
	}

	return { list, current, upload, remove };
}

const main = createStore({ chunksTable: "script_chunks", infoTable: "script_info" });
const tracker = createStore({ chunksTable: "tracker_chunks", infoTable: "tracker_info" });

const games = createGameStore();

module.exports = { ...main, tracker, games, MAX_SCRIPT_BYTES };
