const rowsBody = document.getElementById("licenseRows");
const addForm = document.getElementById("addForm");
const addError = document.getElementById("addError");
const resolveBtn = document.getElementById("resolveBtn");
const apiUrlEl = document.getElementById("apiUrl");
const copyApiUrlBtn = document.getElementById("copyApiUrl");
const whoamiEl = document.getElementById("whoami");

apiUrlEl.textContent = `${window.location.origin}/api/allowlist`;

copyApiUrlBtn.addEventListener("click", () => {
	navigator.clipboard.writeText(apiUrlEl.textContent).then(() => {
		copyApiUrlBtn.textContent = "Copied!";
		setTimeout(() => (copyApiUrlBtn.textContent = "Copy"), 1200);
	});
});

async function loadMe() {
	const response = await fetch("/admin/api/me");
	const data = await response.json();

	if (data.user) {
		whoamiEl.textContent = `Logged in as ${data.user.username}`;
	}
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = value == null ? "" : String(value);
	return div.innerHTML;
}

async function loadLicenses() {
	const response = await fetch("/admin/api/licenses");
	const licenses = await response.json();

	if (!licenses.length) {
		rowsBody.innerHTML = '<tr><td colspan="6" class="muted">No licenses yet. Add one above.</td></tr>';
		return;
	}

	rowsBody.innerHTML = licenses
		.map((license) => {
			const robloxLine = `${escapeHtml(license.roblox_username || "(unknown)")}<br><span class="muted">${license.roblox_user_id}</span>`;
			const discordLine = license.discord_username || license.discord_id
				? `${escapeHtml(license.discord_username || "")}<br><span class="muted">${escapeHtml(license.discord_id || "")}</span>`
				: '<span class="muted">-</span>';
			const statusPill = license.revoked
				? '<span class="pill pill-bad">Revoked</span>'
				: '<span class="pill pill-good">Active</span>';
			const toggleLabel = license.revoked ? "Unrevoke" : "Revoke";

			return `
				<tr data-id="${license.id}">
					<td>${robloxLine}</td>
					<td>${discordLine}</td>
					<td>${escapeHtml(license.note || "")}</td>
					<td class="muted">${escapeHtml(license.created_at)}</td>
					<td>${statusPill}</td>
					<td>
						<div class="row-actions">
							<button class="btn btn-ghost toggle-btn" data-revoked="${license.revoked ? 1 : 0}">${toggleLabel}</button>
							<button class="btn btn-ghost delete-btn">Delete</button>
						</div>
					</td>
				</tr>
			`;
		})
		.join("");
}

rowsBody.addEventListener("click", async (event) => {
	const row = event.target.closest("tr[data-id]");
	if (!row) return;

	const id = row.dataset.id;

	if (event.target.classList.contains("toggle-btn")) {
		const currentlyRevoked = event.target.dataset.revoked === "1";

		await fetch(`/admin/api/licenses/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ revoked: !currentlyRevoked }),
		});

		loadLicenses();
	}

	if (event.target.classList.contains("delete-btn")) {
		if (!confirm("Delete this license? This can't be undone.")) return;

		await fetch(`/admin/api/licenses/${id}`, { method: "DELETE" });
		loadLicenses();
	}
});

resolveBtn.addEventListener("click", async () => {
	const username = document.getElementById("robloxUsername").value.trim();
	if (!username) return;

	resolveBtn.textContent = "Looking up...";

	try {
		const response = await fetch(`/admin/api/resolve-roblox?username=${encodeURIComponent(username)}`);
		const data = await response.json();

		if (!response.ok) {
			addError.textContent = data.error || "Could not resolve that username.";
			return;
		}

		document.getElementById("robloxUserId").value = data.id;
		document.getElementById("robloxUsername").value = data.name;
		addError.textContent = "";
	} catch (err) {
		addError.textContent = "Lookup failed.";
	} finally {
		resolveBtn.textContent = "Look up";
	}
});

addForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	addError.textContent = "";

	const payload = {
		robloxUserId: document.getElementById("robloxUserId").value.trim(),
		robloxUsername: document.getElementById("robloxUsername").value.trim(),
		discordUsername: document.getElementById("discordUsername").value.trim(),
		discordId: document.getElementById("discordId").value.trim(),
		note: document.getElementById("note").value.trim(),
	};

	const response = await fetch("/admin/api/licenses", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	const data = await response.json();

	if (!response.ok) {
		addError.textContent = data.error || "Could not add that license.";
		return;
	}

	addForm.reset();
	loadLicenses();
});

loadMe();
loadLicenses();
