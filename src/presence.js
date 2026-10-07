// Who's running the script right now, and kicks waiting to be delivered.
// While the script runs it checks in with the site every 15 seconds (see /api/check-key).
// This is kept in memory only: it's all short-lived, and a restart just clears it.

const ONLINE_MS = 60 * 1000; // checked in this recently = in a game now
const KICK_WAIT_MS = 2 * 60 * 1000; // how long a kick waits for their script to check in

const lastSeen = new Map(); // robloxUserId -> { time, placeId, gameName } from the last check-in
const kicks = new Map(); // robloxUserId -> { until, message }

function prune() {
	const now = Date.now();
	for (const [id, seen] of lastSeen) if (now - seen.time >= ONLINE_MS) lastSeen.delete(id);
	for (const [id, kick] of kicks) if (kick.until <= now) kicks.delete(id);
}

// game: { placeId, gameName } if the script sent it. Keeps the last known game otherwise.
function seen(robloxUserId, game = {}) {
	const id = Number(robloxUserId);
	const before = lastSeen.get(id) || {};

	// A check-in that names a place replaces the game; one that doesn't keeps the last one.
	const current = game.placeId ? game : before;

	lastSeen.set(id, {
		time: Date.now(),
		placeId: current.placeId || null,
		gameName: current.gameName || null,
	});

	if (lastSeen.size > 10000) prune();
}

function isOnline(robloxUserId) {
	const seen = lastSeen.get(Number(robloxUserId));
	return !!seen && Date.now() - seen.time < ONLINE_MS;
}

// The game they're in right now ({ placeId, gameName }), or null if they're not in one.
function currentGame(robloxUserId) {
	if (!isOnline(robloxUserId)) return null;
	const { placeId, gameName } = lastSeen.get(Number(robloxUserId));
	return placeId ? { placeId, gameName } : null;
}

function onlineCount() {
	prune();
	return lastSeen.size;
}

function requestKick(robloxUserId, message) {
	kicks.set(Number(robloxUserId), { until: Date.now() + KICK_WAIT_MS, message });
}

function hasKick(robloxUserId) {
	const kick = kicks.get(Number(robloxUserId));
	return !!kick && kick.until > Date.now();
}

// Hand over a waiting kick (once), and mark them as gone.
function takeKick(robloxUserId) {
	const id = Number(robloxUserId);
	const kick = kicks.get(id);
	if (!kick) return null;

	kicks.delete(id);
	if (kick.until <= Date.now()) return null;

	lastSeen.delete(id);
	return kick;
}

module.exports = { seen, isOnline, currentGame, onlineCount, requestKick, hasKick, takeKick, KICK_WAIT_MS };
