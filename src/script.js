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

const main = createStore({ chunksTable: "script_chunks", infoTable: "script_info" });
const tracker = createStore({ chunksTable: "tracker_chunks", infoTable: "tracker_info" });

module.exports = { ...main, tracker, MAX_SCRIPT_BYTES };
