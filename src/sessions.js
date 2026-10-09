// One live run per license, so a key can't be used in two places at once.
// The script sends a unique ?session= id when it starts (start=1) and on every
// check-in (watch=1). The first session to claim a license holds it; while it's
// still checking in, any OTHER session on that license is turned away, so the
// NEWER person is the one who gets kicked. Kept in memory only, like presence:
// it's all short-lived and a restart just clears it (worst case, one extra claim).

// A session counts as "live" until it misses a couple of check-ins. The script
// checks in every 15s, so ~40s means two missed check-ins frees the slot. That's
// also how long someone must wait to run again after closing/hopping servers.
const LIVE_MS = 40 * 1000;

const active = new Map(); // licenseId -> { sessionId, robloxUserId, time }

function prune() {
	const now = Date.now();
	for (const [id, entry] of active) {
		if (now - entry.time >= LIVE_MS) active.delete(id);
	}
}

// Decide whether this run may continue, and remember who's holding the license.
// Returns { ok: true } to allow, or { ok: false, message } to kick/turn away.
// isStart is true when the script is starting (not a check-in from a run already going).
function check(licenseId, robloxUserId, sessionId, { isStart = false } = {}) {
	const id = Number(licenseId);
	const now = Date.now();
	const holder = active.get(id);
	const held = holder && now - holder.time < LIVE_MS;

	// Free (nobody holding it, or the previous holder stopped checking in): claim it.
	if (!held) {
		active.set(id, { sessionId, robloxUserId: Number(robloxUserId), time: now });
		if (active.size > 10000) prune();
		return { ok: true };
	}

	// The same run checking in again: keep it alive.
	if (holder.sessionId === sessionId) {
		holder.time = now;
		holder.robloxUserId = Number(robloxUserId);
		return { ok: true };
	}

	// The same Roblox account starting again (ran the script twice, rejoined, or hopped
	// servers before the old run timed out): that's not someone else, so the new run
	// takes over. One Roblox account can only be in one game at a time anyway. The old
	// run, if it's somehow still checking in, is the one turned away from now on.
	if (isStart && holder.robloxUserId === Number(robloxUserId)) {
		active.set(id, { sessionId, robloxUserId: Number(robloxUserId), time: now });
		return { ok: true };
	}

	// Someone else is already running on this key right now. Turn this (newer) one away.
	return {
		ok: false,
		message: "This key is already being used right now. Only one game at a time - close the other one and try again.",
	};
}

// Let go of a license when a run ends cleanly (optional; the slot also frees on its own).
function release(licenseId, sessionId) {
	const id = Number(licenseId);
	const holder = active.get(id);
	if (holder && holder.sessionId === sessionId) active.delete(id);
}

// How many licenses are being run right now (for the admin panel, if wanted).
function liveCount() {
	prune();
	return active.size;
}

module.exports = { check, release, liveCount, LIVE_MS };
