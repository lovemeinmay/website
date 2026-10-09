const { HttpError } = require("./http");

const USERS_API = "https://users.roblox.com/v1";

async function robloxFetch(url, options = {}) {
	let response;

	try {
		response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
	} catch {
		throw new HttpError(502, "Couldn't reach Roblox. Try again in a moment.");
	}

	if (response.status === 429) {
		throw new HttpError(429, "Roblox is rate-limiting us. Wait a minute and try again.");
	}

	return response;
}

// Find a Roblox account by username. Returns { id, name, displayName } or null.
async function findByUsername(username) {
	const clean = String(username || "").trim();
	if (!/^[A-Za-z0-9_]{3,20}$/.test(clean)) {
		throw new HttpError(400, "That doesn't look like a Roblox username (3-20 letters, numbers or underscores).");
	}

	const response = await robloxFetch(`${USERS_API}/usernames/users`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ usernames: [clean], excludeBannedUsers: true }),
	});

	if (!response.ok) throw new HttpError(502, "Roblox lookup failed. Try again in a moment.");

	const data = await response.json();
	const match = data && data.data && data.data[0];

	return match ? { id: Number(match.id), name: match.name, displayName: match.displayName } : null;
}

// Look up a Roblox username from a user ID. Best effort: gives back null if Roblox can't be reached.
async function usernameFor(userId) {
	try {
		const response = await fetch(`${USERS_API}/users/${Number(userId)}`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) return null;

		const data = await response.json();
		return data && typeof data.name === "string" ? data.name : null;
	} catch {
		return null;
	}
}

module.exports = { findByUsername, usernameFor };
