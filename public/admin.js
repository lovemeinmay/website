const $ = (id) => document.getElementById(id);

let data = { stats: {}, licenses: [], keys: [] };

const STATUS_LABEL = {
	active: "Active",
	needs_roblox: "No Roblox yet",
	expired: "Expired",
	revoked: "Revoked",
};

// ---------------------------------------------------------------------------
// Loading + summary
// ---------------------------------------------------------------------------

async function load() {
	data = await api("GET", "/api/admin/overview");
	renderSummary();
	renderKeys();
	renderLicenses();
}

function renderSummary() {
	const { licenses, active, unusedKeys, online } = data.stats;
	$("summary").innerHTML =
		licenses === 0 && unusedKeys === 0
			? "No licenses yet. Make a key below and give it to someone."
			: `<strong>${active}</strong> of ${licenses} license${licenses === 1 ? "" : "s"} active, <strong>${unusedKeys}</strong> unused key${
					unusedKeys === 1 ? "" : "s"
			  } waiting to be redeemed, and <strong>${online || 0}</strong> in a game right now.`;
}

// Keep "In game" up to date while the Licenses tab is open.
setInterval(() => {
	if (document.hidden) return;
	if (!$("licensesTab").hidden) load().catch(() => {});
	if (!$("activityTab").hidden) loadActivity().catch(() => {});
}, 15000);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = {
	keys: ["tabKeys", "keysTab"],
	licenses: ["tabLicenses", "licensesTab"],
	activity: ["tabActivity", "activityTab"],
	script: ["tabScript", "scriptTab"],
	tracker: ["tabTracker", "trackerTab"],
};

function showTab(name) {
	for (const [tab, [button, panel]] of Object.entries(TABS)) {
		$(button).setAttribute("aria-selected", String(tab === name));
		$(panel).hidden = tab !== name;
	}

	if (name === "activity") loadActivity().catch((err) => toast(err.message, true));

	if (name === "script") {
		loadScript().catch((err) => {
			$("scriptState").textContent = "Couldn't load";
			$("scriptMeta").textContent = err.message;
		});
	}

	if (name === "tracker") {
		loadTracker().catch((err) => {
			$("trackerState").textContent = "Couldn't load";
			$("trackerMeta").textContent = err.message;
		});
	}
}

$("tabKeys").addEventListener("click", () => showTab("keys"));
$("tabLicenses").addEventListener("click", () => showTab("licenses"));
$("tabActivity").addEventListener("click", () => {
	activityLicense = null;
	showTab("activity");
});
$("tabScript").addEventListener("click", () => showTab("script"));
$("tabTracker").addEventListener("click", () => showTab("tracker"));

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

let executions = [];
let activityLicense = null; // { id, name } when showing one license's runs

// "just now", "4 min ago", "3 hours ago", "2 days ago"
function timeAgo(iso) {
	const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

	return `${Math.floor(hours / 24)} days ago`;
}

function gameLink(placeId, gameName) {
	const name = escapeHtml(gameName || (placeId ? `Place ${placeId}` : "Unknown game"));
	return placeId
		? `<a href="https://www.roblox.com/games/${encodeURIComponent(placeId)}" target="_blank" rel="noopener">${name}</a>`
		: name;
}

function renderActivity() {
	const search = $("activitySearch").value.trim().toLowerCase();

	$("activityFilter").hidden = !activityLicense;
	if (activityLicense) $("activityFilterText").textContent = `Showing ${activityLicense.name}'s runs only.`;

	const rows = executions.filter(
		(run) =>
			!search ||
			[run.discordUsername, run.robloxUsername, run.robloxUserId, run.gameName, run.placeId, run.jobId]
				.join(" ")
				.toLowerCase()
				.includes(search)
	);

	if (!rows.length) {
		$("activityRows").innerHTML = `<tr><td colspan="5" class="empty">${
			executions.length ? "No runs match." : "Nobody has run the script yet. Runs show up here as soon as someone starts it."
		}</td></tr>`;
		return;
	}

	$("activityRows").innerHTML = rows
		.map(
			(run) => `
			<tr>
				<td data-label="When">${escapeHtml(formatDate(run.executedAt))}<span class="sub">${escapeHtml(timeAgo(run.executedAt))}</span></td>
				<td data-label="Discord">${escapeHtml(run.discordUsername || "Unknown")}</td>
				<td data-label="Roblox">${escapeHtml(run.robloxUsername || "")}<span class="sub code">${escapeHtml(run.robloxUserId)}</span></td>
				<td data-label="Game">${gameLink(run.placeId, run.gameName)}${
					run.placeId ? `<span class="sub code">${escapeHtml(run.placeId)}</span>` : ""
				}</td>
				<td data-label="Server">${
					run.jobId ? `<span class="code" title="${escapeHtml(run.jobId)}">${escapeHtml(run.jobId.slice(0, 8))}</span>` : '<span class="muted">-</span>'
				}</td>
			</tr>`
		)
		.join("");
}

async function loadActivity() {
	const query = activityLicense ? `?licenseId=${encodeURIComponent(activityLicense.id)}` : "";
	executions = (await api("GET", `/api/admin/activity${query}`)).executions;
	renderActivity();
}

$("activitySearch").addEventListener("input", renderActivity);
$("activityShowAll").addEventListener("click", () => {
	activityLicense = null;
	loadActivity().catch((err) => toast(err.message, true));
});

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

const MAX_SCRIPT_BYTES = 15 * 1024 * 1024;

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

function renderScript(script) {
	$("scriptCard").dataset.state = script ? "live" : "empty";
	$("scriptDownload").hidden = !script;

	if (!script) {
		$("scriptState").textContent = "No script uploaded yet";
		$("scriptMeta").textContent = "Players can enter their key, but there's nothing to load until you upload one.";
		return;
	}

	$("scriptState").textContent = script.fileName || "Script";
	$("scriptMeta").textContent = `Live · ${formatBytes(script.size)} · uploaded ${formatDate(script.uploadedAt)}${
		script.uploadedBy ? ` by ${script.uploadedBy}` : ""
	}`;
}

async function loadScript() {
	const result = await api("GET", "/api/admin/script");
	renderScript(result.script);
	$("loaderLine").textContent = `loadstring(game:HttpGet("${result.loaderUrl}"))()`;
}

// Read a file as base64 (without the "data:...;base64," part).
function readAsBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
		reader.onerror = () => reject(new Error("Couldn't read that file."));
		reader.readAsDataURL(file);
	});
}

$("scriptForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("scriptError").textContent = "";

	const file = $("scriptFile").files[0];
	if (!file) {
		$("scriptError").textContent = "Choose a .lua file first.";
		return;
	}

	if (file.size > MAX_SCRIPT_BYTES) {
		$("scriptError").textContent = "That file is bigger than 15 MB.";
		return;
	}

	busy($("scriptBtn"), async () => {
		const label = $("scriptBtn").textContent;
		$("scriptBtn").textContent = "Uploading...";

		try {
			const result = await api("POST", "/api/admin/script", { base64: await readAsBase64(file), fileName: file.name });
			renderScript(result.script);
			$("scriptFile").value = "";
			toast("Script uploaded. Players get it on their next load.");
		} catch (err) {
			$("scriptError").textContent = err.message;
		} finally {
			$("scriptBtn").textContent = label;
		}
	});
});

$("copyLoader").addEventListener("click", () => copyText($("loaderLine").textContent, $("copyLoader")));

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function renderKeys() {
	const filter = $("keyFilter").value;
	const search = $("keySearch").value.trim().toLowerCase();

	const rows = data.keys.filter((key) => {
		if (filter === "unused" && key.redeemedAt) return false;
		if (filter === "used" && !key.redeemedAt) return false;
		if (search && !`${key.key} ${key.note || ""} ${key.redeemedByUsername || ""}`.toLowerCase().includes(search)) return false;
		return true;
	});

	if (!rows.length) {
		$("keyRows").innerHTML = `<tr><td colspan="6" class="empty">${
			data.keys.length ? "No keys match." : "No keys yet. Make some above."
		}</td></tr>`;
		return;
	}

	$("keyRows").innerHTML = rows
		.map((key) => {
			const status = key.redeemedAt
				? `<span class="pill pill-used">Used</span><span class="sub">by ${escapeHtml(key.redeemedByUsername || key.redeemedBy)}, ${escapeHtml(
						formatDay(key.redeemedAt)
				  )}</span>`
				: '<span class="pill pill-unused">Unused</span>';

			return `
				<tr data-id="${key.id}" data-key="${escapeHtml(key.key)}">
					<td data-label="Key"><span class="code">${escapeHtml(key.key)}</span></td>
					<td data-label="Gives">${escapeHtml(durationLabel(key.durationDays))}${
						key.inGame ? '<span class="sub">Works in game</span>' : ""
					}</td>
					<td data-label="Note">${escapeHtml(key.note || "")}</td>
					<td data-label="Status">${status}</td>
					<td data-label="Created" class="muted">${escapeHtml(formatDay(key.createdAt))}</td>
					<td data-label="">
						<div class="row-actions">
							<button class="btn btn-quiet btn-small" data-action="copy-key">Copy</button>
							${key.redeemedAt ? "" : '<button class="btn btn-danger btn-small" data-action="delete-key">Delete</button>'}
						</div>
					</td>
				</tr>`;
		})
		.join("");
}

$("keyFilter").addEventListener("change", renderKeys);
$("keySearch").addEventListener("input", renderKeys);

$("keyForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("keyError").textContent = "";

	busy($("keyBtn"), async () => {
		try {
			const result = await api("POST", "/api/admin/keys", {
				count: Number($("keyCount").value),
				duration: $("keyDuration").value,
				note: $("keyNote").value.trim(),
			});

			$("newKeysTitle").textContent = `${result.keys.length} new key${result.keys.length === 1 ? "" : "s"}`;
			$("newKeysList").textContent = result.keys.join("\n");
			$("newKeys").hidden = false;
			$("keyNote").value = "";
			await load();
		} catch (err) {
			$("keyError").textContent = err.message;
		}
	});
});

$("copyNewKeys").addEventListener("click", () => copyText($("newKeysList").textContent, $("copyNewKeys")));

$("importForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("importError").textContent = "";
	$("importResult").textContent = "";

	const keys = $("importKeys").value.trim();
	if (!keys) {
		$("importError").textContent = "Paste some keys first.";
		return;
	}

	busy($("importBtn"), async () => {
		try {
			const result = await api("POST", "/api/admin/keys/import", {
				keys,
				duration: $("importDuration").value,
				note: $("importNote").value.trim(),
			});

			const parts = [`Added ${result.added} key${result.added === 1 ? "" : "s"}.`];
			if (result.alreadyAdded) parts.push(`${result.alreadyAdded} were already on the site.`);
			$("importResult").textContent = parts.join(" ");

			if (result.invalid.length) {
				const shown = result.invalid.slice(0, 5).join(", ");
				$("importError").textContent = `Skipped ${result.invalid.length} that don't look like keys: ${shown}${
					result.invalid.length > 5 ? ", ..." : ""
				}`;
			}

			$("importKeys").value = "";
			$("importNote").value = "";
			await load();
		} catch (err) {
			$("importError").textContent = err.message;
		}
	});
});

$("keyRows").addEventListener("click", async (event) => {
	const button = event.target.closest("button[data-action]");
	if (!button) return;

	const row = button.closest("tr");

	if (button.dataset.action === "copy-key") {
		copyText(row.dataset.key, button);
	}

	if (button.dataset.action === "delete-key") {
		if (!confirm(`Delete key ${row.dataset.key}? Nobody will be able to redeem it.`)) return;

		try {
			await api("DELETE", `/api/admin/keys/${row.dataset.id}`);
			toast("Key deleted");
			await load();
		} catch (err) {
			toast(err.message, true);
		}
	}
});

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

function renderLicenses() {
	const search = $("licenseSearch").value.trim().toLowerCase();

	const rows = data.licenses.filter((license) => {
		if (!search) return true;
		return [
			license.discordUsername,
			license.discordId,
			license.note,
			...license.accounts.flatMap((account) => [account.username, account.id, account.game && account.game.gameName]),
		]
			.join(" ")
			.toLowerCase()
			.includes(search);
	});

	if (!rows.length) {
		$("licenseRows").innerHTML = `<tr><td colspan="6" class="empty">${
			data.licenses.length ? "No licenses match." : "No licenses yet. They appear here when someone redeems a key."
		}</td></tr>`;
		return;
	}

	$("licenseRows").innerHTML = rows
		.map((license) => {
			const discord = `${escapeHtml(license.discordUsername || "Unknown")}<span class="sub code">${escapeHtml(license.discordId)}</span>`;

			let robloxCell = license.accounts
				.map(
					(account) => `
					<div class="account-cell">
						<div class="account-name">
							${escapeHtml(account.username || "")}
							<button class="unlink" type="button" data-action="unlink" data-roblox="${account.id}" data-name="${escapeHtml(
								account.username || account.id
							)}" title="Unlink this account" aria-label="Unlink ${escapeHtml(account.username || account.id)}">&times;</button>
						</div>
						<span class="sub code">${escapeHtml(account.id)}</span>
						${
							account.online
								? `<span class="in-game"><span class="pill pill-online">In game</span> ${
										account.game ? gameLink(account.game.placeId, account.game.gameName) : ""
								  }</span>`
								: ""
						}
					</div>`
				)
				.join("");

			if (!robloxCell) robloxCell = '<span class="muted">Not linked</span>';

			const expires = license.expiresAt
				? `${escapeHtml(formatDay(license.expiresAt))}<span class="sub">${escapeHtml(fromNow(license.expiresAt))}</span>`
				: "Never";

			return `
				<tr data-id="${license.id}">
					<td data-label="Discord">${discord}</td>
					<td data-label="Roblox">${robloxCell}</td>
					<td data-label="Status"><span class="pill pill-${license.status}">${STATUS_LABEL[license.status]}</span></td>
					<td data-label="Expires">${expires}</td>
					<td data-label="Note">${escapeHtml(license.note || "")}</td>
					<td data-label="">
						<div class="row-actions">
							${
								license.status === "active"
									? `<button class="btn btn-danger btn-small" data-action="kick"${license.kickPending ? " disabled" : ""}>${
											license.kickPending ? "Kicking..." : "Kick"
									  }</button>`
									: ""
							}
							${license.status !== "revoked" ? '<button class="btn btn-quiet btn-small" data-action="add-account">Add account</button>' : ""}
							<button class="btn btn-quiet btn-small" data-action="activity">Activity</button>
							<button class="btn btn-quiet btn-small" data-action="time">Change time</button>
							<button class="btn btn-quiet btn-small" data-action="toggle" data-revoked="${license.revoked ? 1 : 0}">
								${license.revoked ? "Unrevoke" : "Revoke"}
							</button>
							${
								license.accounts.length > 1
									? '<button class="btn btn-quiet btn-small" data-action="reset">Unlink all</button>'
									: ""
							}
							<button class="btn btn-danger btn-small" data-action="delete">Delete</button>
						</div>
					</td>
				</tr>`;
		})
		.join("");
}

$("licenseSearch").addEventListener("input", renderLicenses);

$("grantForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("grantError").textContent = "";

	busy($("grantBtn"), async () => {
		try {
			await api("POST", "/api/admin/licenses", {
				discordId: $("grantDiscordId").value.trim(),
				discordUsername: $("grantDiscordName").value.trim(),
				robloxUsername: $("grantRoblox").value.trim(),
				duration: $("grantDuration").value,
				note: $("grantNote").value.trim(),
			});

			$("grantForm").reset();
			toast("License given");
			await load();
		} catch (err) {
			$("grantError").textContent = err.message;
		}
	});
});

$("licenseRows").addEventListener("click", async (event) => {
	const button = event.target.closest("button[data-action]");
	if (!button) return;

	const id = button.closest("tr").dataset.id;
	const license = data.licenses.find((item) => String(item.id) === id);

	try {
		if (button.dataset.action === "activity") {
			activityLicense = { id: license.id, name: license.discordUsername || license.discordId };
			showTab("activity");
			return;
		}

		if (button.dataset.action === "add-account") {
			const name = license.discordUsername || license.discordId;
			const username = prompt(
				`Roblox username to link to ${name}'s license?\n\nIt's linked straight away: no profile phrase, and no account limit. If it's on another license, it moves here.`,
				""
			);
			if (!username || !username.trim()) return;

			const result = await api("POST", `/api/admin/licenses/${id}/roblox`, { username: username.trim() });
			toast(
				result.license && result.license.movedFrom
					? `${username.trim()} linked (moved from ${result.license.movedFrom}'s license)`
					: `${username.trim()} linked`
			);
		}

		if (button.dataset.action === "unlink") {
			if (!confirm(`Unlink ${button.dataset.name} from this license? The script stops working on it straight away.`)) return;
			await api("DELETE", `/api/admin/licenses/${id}/roblox/${button.dataset.roblox}`);
			toast("Account unlinked");
		}

		if (button.dataset.action === "kick") {
			const name = license.discordUsername || license.discordId;
			const reason = prompt(`Kick ${name} out of the game? Their license stays as it is.\n\nReason they'll see (optional):`, "");
			if (reason === null) return;

			const result = await api("POST", `/api/admin/licenses/${id}/kick`, { reason });
			toast(
				result.online.length
					? `Kicking ${result.online.join(", ")}. They'll be out within 15 seconds.`
					: `${name} isn't in a game right now. If they start the script in the next 2 minutes, they'll be kicked.`
			);
		}

		if (button.dataset.action === "time") {
			const answer = prompt(
				"How many days to add? Use a minus number to take days away, or type lifetime to make it never expire.",
				"30"
			);
			if (answer === null) return;

			const trimmed = answer.trim().toLowerCase();
			const body = trimmed === "lifetime" ? { lifetime: true } : { addDays: Number(trimmed) };

			if (!body.lifetime && !Number.isInteger(body.addDays)) {
				toast("Type a whole number of days, or lifetime.", true);
				return;
			}

			if (!body.lifetime && !license.expiresAt) {
				toast("This license is lifetime already, so it never runs out.", true);
				return;
			}

			await api("PATCH", `/api/admin/licenses/${id}`, body);
			toast("Time updated");
		}

		if (button.dataset.action === "toggle") {
			const revoke = button.dataset.revoked !== "1";
			await api("PATCH", `/api/admin/licenses/${id}`, { revoked: revoke });
			toast(revoke ? "License revoked" : "License unrevoked");
		}

		if (button.dataset.action === "reset") {
			if (!confirm("Unlink all of this license's Roblox accounts? They'll need to link one again before the script lets them in.")) return;
			await api("POST", `/api/admin/licenses/${id}/reset-roblox`);
			toast("Roblox accounts unlinked");
		}

		if (button.dataset.action === "delete") {
			const name = license.discordUsername || license.discordId;
			if (!confirm(`Delete ${name}'s license? This can't be undone.`)) return;
			await api("DELETE", `/api/admin/licenses/${id}`);
			toast("License deleted");
		}

		await load();
	} catch (err) {
		toast(err.message, true);
	}
});

// ---------------------------------------------------------------------------
// Server Tracker
// ---------------------------------------------------------------------------

let trackerKeys = [];

function renderTrackerScript(script) {
	$("trackerCard").dataset.state = script ? "live" : "empty";
	$("trackerDownload").hidden = !script;

	if (!script) {
		$("trackerState").textContent = "No tracker uploaded yet";
		$("trackerMeta").textContent = "Players can enter a tracker key, but there's nothing to load until you upload one.";
		return;
	}

	$("trackerState").textContent = script.fileName || "Server Tracker";
	$("trackerMeta").textContent = `Live · ${formatBytes(script.size)} · uploaded ${formatDate(script.uploadedAt)}${
		script.uploadedBy ? ` by ${script.uploadedBy}` : ""
	}`;
}

function renderTrackerKeys() {
	const filter = $("trackerFilter").value;
	const search = $("trackerSearch").value.trim().toLowerCase();
	const used = trackerKeys.filter((key) => key.robloxUserId && !key.revoked).length;

	$("trackerKeysTitle").textContent = `Tracker keys (${trackerKeys.length}, ${used} in use)`;

	const rows = trackerKeys.filter((key) => {
		if (filter === "unused" && (key.robloxUserId || key.revoked)) return false;
		if (filter === "used" && (!key.robloxUserId || key.revoked)) return false;
		if (filter === "revoked" && !key.revoked) return false;
		if (search && !`${key.key} ${key.note || ""} ${key.robloxUsername || ""} ${key.robloxUserId || ""}`.toLowerCase().includes(search)) {
			return false;
		}
		return true;
	});

	if (!rows.length) {
		$("trackerRows").innerHTML = `<tr><td colspan="6" class="empty">${
			trackerKeys.length ? "No tracker keys match." : "No tracker keys yet. Add some above."
		}</td></tr>`;
		return;
	}

	$("trackerRows").innerHTML = rows
		.map((key) => {
			const account = key.robloxUserId
				? `${escapeHtml(key.robloxUsername || "Roblox user")}<span class="sub code">${escapeHtml(String(key.robloxUserId))}</span>`
				: '<span class="muted">Nobody yet</span>';

			const status = key.revoked
				? '<span class="pill pill-revoked">Off</span>'
				: key.robloxUserId
				  ? '<span class="pill pill-used">In use</span>'
				  : '<span class="pill pill-unused">Unused</span>';

			return `
				<tr data-id="${key.id}" data-key="${escapeHtml(key.key)}">
					<td data-label="Key"><span class="code">${escapeHtml(key.key)}</span></td>
					<td data-label="Roblox">${account}</td>
					<td data-label="Note">${escapeHtml(key.note || "")}</td>
					<td data-label="Status">${status}</td>
					<td data-label="Last used" class="muted">${key.lastUsedAt ? escapeHtml(formatDate(key.lastUsedAt)) : ""}</td>
					<td data-label="">
						<div class="row-actions">
							<button class="btn btn-quiet btn-small" data-action="copy">Copy</button>
							${key.robloxUserId ? '<button class="btn btn-quiet btn-small" data-action="unlink">Unlink</button>' : ""}
							${
								key.revoked
									? '<button class="btn btn-quiet btn-small" data-action="on">Turn on</button>'
									: '<button class="btn btn-quiet btn-small" data-action="off">Turn off</button>'
							}
							<button class="btn btn-danger btn-small" data-action="delete">Delete</button>
						</div>
					</td>
				</tr>`;
		})
		.join("");
}

async function loadTracker() {
	const result = await api("GET", "/api/admin/tracker");
	trackerKeys = result.keys;
	renderTrackerScript(result.script);
	renderTrackerKeys();
	$("trackerLoaderLine").textContent = `loadstring(game:HttpGet("${result.loaderUrl}"))()`;
}

$("trackerFilter").addEventListener("change", renderTrackerKeys);
$("trackerSearch").addEventListener("input", renderTrackerKeys);
$("copyTrackerLoader").addEventListener("click", () => copyText($("trackerLoaderLine").textContent, $("copyTrackerLoader")));

$("trackerScriptForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("trackerScriptError").textContent = "";

	const file = $("trackerFile").files[0];
	if (!file) {
		$("trackerScriptError").textContent = "Choose a .lua file first.";
		return;
	}
	if (file.size > MAX_SCRIPT_BYTES) {
		$("trackerScriptError").textContent = "That file is bigger than 15 MB.";
		return;
	}

	busy($("trackerScriptBtn"), async () => {
		const label = $("trackerScriptBtn").textContent;
		$("trackerScriptBtn").textContent = "Uploading...";

		try {
			const result = await api("POST", "/api/admin/tracker/script", { base64: await readAsBase64(file), fileName: file.name });
			renderTrackerScript(result.script);
			$("trackerFile").value = "";
			toast("Tracker uploaded. Players get it on their next load.");
		} catch (err) {
			$("trackerScriptError").textContent = err.message;
		} finally {
			$("trackerScriptBtn").textContent = label;
		}
	});
});

$("trackerImportForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("trackerImportError").textContent = "";
	$("trackerImportResult").textContent = "";

	const keys = $("trackerKeys").value.trim();
	if (!keys) {
		$("trackerImportError").textContent = "Paste some keys first.";
		return;
	}

	busy($("trackerImportBtn"), async () => {
		try {
			const result = await api("POST", "/api/admin/tracker/keys/import", { keys, note: $("trackerNote").value.trim() });

			const parts = [`Added ${result.added} tracker key${result.added === 1 ? "" : "s"}.`];
			if (result.alreadyAdded) parts.push(`${result.alreadyAdded} were already added.`);
			$("trackerImportResult").textContent = parts.join(" ");

			if (result.invalid.length) {
				const shown = result.invalid.slice(0, 5).join(", ");
				$("trackerImportError").textContent = `Skipped ${result.invalid.length} that don't look like keys: ${shown}${
					result.invalid.length > 5 ? ", ..." : ""
				}`;
			}

			$("trackerKeys").value = "";
			$("trackerNote").value = "";
			await loadTracker();
		} catch (err) {
			$("trackerImportError").textContent = err.message;
		}
	});
});

$("trackerRows").addEventListener("click", async (event) => {
	const button = event.target.closest("button[data-action]");
	if (!button) return;

	const row = button.closest("tr");
	const action = button.dataset.action;

	if (action === "copy") return copyText(row.dataset.key, button);

	if (action === "delete" && !confirm(`Delete tracker key ${row.dataset.key}? It stops working straight away.`)) return;
	if (action === "unlink" && !confirm(`Unlink ${row.dataset.key} from its Roblox account? The next account to use it gets it.`)) return;

	try {
		if (action === "delete") {
			await api("DELETE", `/api/admin/tracker/keys/${row.dataset.id}`);
			toast("Tracker key deleted");
		} else {
			const body = action === "unlink" ? { unlink: true } : { revoked: action === "off" };
			await api("POST", `/api/admin/tracker/keys/${row.dataset.id}`, body);
			toast(action === "unlink" ? "Key unlinked" : action === "off" ? "Key turned off" : "Key turned on");
		}

		await loadTracker();
	} catch (err) {
		toast(err.message, true);
	}
});

// ---------------------------------------------------------------------------
// Script URLs
// ---------------------------------------------------------------------------

$("checkUrl").textContent = `${location.origin}/api/check?robloxUserId=`;
$("listUrl").textContent = `${location.origin}/api/allowlist`;
$("copyCheck").addEventListener("click", () => copyText($("checkUrl").textContent, $("copyCheck")));
$("copyList").addEventListener("click", () => copyText($("listUrl").textContent, $("copyList")));

api("GET", "/api/me")
	.then((me) => renderWho(me.user, me.isAdmin))
	.catch(() => {});

load().catch((err) => {
	$("summary").textContent = `Couldn't load: ${err.message}`;
});
