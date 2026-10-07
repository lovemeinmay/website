// Who's running the script right now, and kicks waiting to be delivered.
// While the script runs it checks in with the site every 15 seconds (see /api/check-key).
// This is kept in memory only: it's all short-lived, and a restart just clears it.

const ONLINE_MS = 60 * 1000; // checked in this recently = in a game now
const KICK_WAIT_MS = 2 * 60 * 1000; // how long a kick waits for their script to check in

const lastSeen = new Map(); // robloxUserId -> time of last check-in
const kicks = new Map(); // robloxUserId -> { until, message }

function prune() {
	const now = Date.now();
	for (const [id, time] of lastSeen) if (now - time >= ONLINE_MS) lastSeen.delete(id);
	for (const [id, kick] of kicks) if (kick.until <= now) kicks.delete(id);
}

function seen(robloxUserId) {
	lastSeen.set(Number(robloxUserId), Date.now());
	if (lastSeen.size > 10000) prune();
}

function isOnline(robloxUserId) {
	const time = lastSeen.get(Number(robloxUserId));
	return !!time && Date.now() - time < ONLINE_MS;
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

module.exports = { seen, isOnline, onlineCount, requestKick, hasKick, takeKick, KICK_WAIT_MS };
