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
	const { licenses, active, unusedKeys } = data.stats;
	$("summary").innerHTML =
		licenses === 0 && unusedKeys === 0
			? "No licenses yet. Make a key below and give it to someone."
			: `<strong>${active}</strong> of ${licenses} license${licenses === 1 ? "" : "s"} active, and <strong>${unusedKeys}</strong> unused key${
					unusedKeys === 1 ? "" : "s"
			  } waiting to be redeemed.`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTab(name) {
	const keys = name === "keys";
	$("tabKeys").setAttribute("aria-selected", String(keys));
	$("tabLicenses").setAttribute("aria-selected", String(!keys));
	$("keysTab").hidden = !keys;
	$("licensesTab").hidden = keys;
}

$("tabKeys").addEventListener("click", () => showTab("keys"));
$("tabLicenses").addEventListener("click", () => showTab("licenses"));

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
					<td data-label="Gives">${escapeHtml(durationLabel(key.durationDays))}</td>
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
		return [license.discordUsername, license.discordId, license.robloxUsername, license.robloxUserId, license.note]
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

			let robloxCell = '<span class="muted">Not linked</span>';
			if (license.robloxUserId) {
				robloxCell = `${escapeHtml(license.robloxUsername || "")}<span class="sub code">${escapeHtml(license.robloxUserId)}</span>`;
			} else if (license.pendingRobloxUsername) {
				robloxCell = `<span class="muted">Verifying ${escapeHtml(license.pendingRobloxUsername)}</span>`;
			}

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
							<button class="btn btn-quiet btn-small" data-action="time">Change time</button>
							<button class="btn btn-quiet btn-small" data-action="toggle" data-revoked="${license.revoked ? 1 : 0}">
								${license.revoked ? "Unrevoke" : "Revoke"}
							</button>
							${license.robloxUserId || license.pendingRobloxUsername ? '<button class="btn btn-quiet btn-small" data-action="reset">Reset Roblox</button>' : ""}
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
			if (!confirm("Unlink this Roblox account? They'll need to link one again before the script lets them in.")) return;
			await api("POST", `/api/admin/licenses/${id}/reset-roblox`);
			toast("Roblox account unlinked");
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
