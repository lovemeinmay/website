const crypto = require("crypto");
const { HttpError } = require("./http");

const USERS_API = "https://users.roblox.com/v1";

// Plain, everyday words, so Roblox's text filter doesn't hide any of them in a profile.
const WORDS = [
	"apple", "banana", "cherry", "grape", "lemon", "mango", "melon", "peach", "pear", "plum",
	"river", "ocean", "forest", "meadow", "valley", "island", "desert", "canyon", "glacier", "harbor",
	"maple", "cedar", "willow", "acorn", "clover", "daisy", "tulip", "lotus", "fern", "moss",
	"tiger", "panda", "otter", "falcon", "rabbit", "turtle", "dolphin", "koala", "badger", "penguin",
	"amber", "silver", "golden", "violet", "crimson", "indigo", "coral", "ivory", "jade", "copper",
	"candle", "lantern", "pillow", "blanket", "teapot", "button", "ribbon", "pencil", "rocket", "anchor",
	"sunny", "cloudy", "windy", "frosty", "breezy", "misty",
];

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

// Fetch a Roblox account's profile, including its About/description text.
async function getUser(userId) {
	const response = await robloxFetch(`${USERS_API}/users/${Number(userId)}`);

	if (response.status === 404) return null;
	if (!response.ok) throw new HttpError(502, "Roblox lookup failed. Try again in a moment.");

	const user = await response.json();
	return { id: Number(user.id), name: user.name, description: user.description || "" };
}

function makePhrase() {
	const picked = [];
	while (picked.length < 6) {
		const word = WORDS[crypto.randomInt(WORDS.length)];
		if (!picked.includes(word)) picked.push(word);
	}
	return picked.join(" ");
}

// Loose match: ignores capitals, punctuation and extra spaces/new lines.
function containsPhrase(description, phrase) {
	const normalize = (text) => ` ${String(text).toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
	return normalize(description).includes(normalize(phrase));
}

module.exports = { findByUsername, getUser, makePhrase, containsPhrase };
