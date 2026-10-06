const fs = require("fs");
const path = require("path");

// A tiny router built on Node's own http module, so the site needs no web framework.

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function createRouter() {
	const routes = [];

	function add(method, pattern, handler) {
		const parts = pattern.split("/").filter(Boolean);
		routes.push({ method, parts, handler });
	}

	function match(method, pathname) {
		const parts = pathname.split("/").filter(Boolean);

		for (const route of routes) {
			if (route.method !== method || route.parts.length !== parts.length) continue;

			const params = {};
			let ok = true;

			for (let i = 0; i < parts.length; i++) {
				const expected = route.parts[i];

				if (expected.startsWith(":")) {
					try {
						params[expected.slice(1)] = decodeURIComponent(parts[i]);
					} catch {
						ok = false;
						break;
					}
				} else if (expected !== parts[i]) {
					ok = false;
					break;
				}
			}

			if (ok) return { handler: route.handler, params };
		}

		return null;
	}

	return {
		get: (pattern, handler) => add("GET", pattern, handler),
		post: (pattern, handler) => add("POST", pattern, handler),
		patch: (pattern, handler) => add("PATCH", pattern, handler),
		delete: (pattern, handler) => add("DELETE", pattern, handler),
		match,
	};
}

const MAX_BODY_BYTES = 16 * 1024;

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		let tooLarge = false;
		const chunks = [];

		req.on("data", (chunk) => {
			if (tooLarge) return; // Keep reading so we can still send a proper reply.

			size += chunk.length;

			if (size > MAX_BODY_BYTES) {
				tooLarge = true;
				chunks.length = 0;
				reject(new HttpError(413, "Request body is too large."));
				return;
			}

			chunks.push(chunk);
		});

		req.on("end", () => {
			if (tooLarge) return;
			if (!chunks.length) return resolve({});

			try {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(body && typeof body === "object" ? body : {});
			} catch {
				reject(new HttpError(400, "Request body must be JSON."));
			}
		});

		req.on("error", reject);
	});
}

function sendJson(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function redirect(res, location) {
	res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
	res.end();
}

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".lua": "text/plain; charset=utf-8",
};

function sendFile(res, filePath, status = 200) {
	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}

		res.writeHead(status, {
			"Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
			"Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=300",
		});
		res.end(data);
	});
}

// Serve a file from `root`, refusing anything that tries to climb out of it (../../server.js).
function sendStatic(res, root, relativePath) {
	const resolved = path.resolve(root, "." + path.posix.normalize("/" + relativePath));

	if (!resolved.startsWith(path.resolve(root) + path.sep)) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
		return;
	}

	sendFile(res, resolved);
}

module.exports = { HttpError, createRouter, readJsonBody, sendJson, redirect, sendFile, sendStatic };
