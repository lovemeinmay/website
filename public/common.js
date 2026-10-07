// Small helpers shared by the dashboard and admin pages.

async function api(method, url, body) {
	const options = { method, headers: {} };

	if (method !== "GET") {
		options.headers["Content-Type"] = "application/json";
		options.body = JSON.stringify(body || {});
	}

	const response = await fetch(url, options);

	if (response.status === 401) {
		location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
		throw new Error("Log in with Discord first.");
	}

	let data = {};
	try {
		data = await response.json();
	} catch {
		// Not JSON (e.g. the server is waking up).
	}

	if (!response.ok) {
		throw new Error(data.error || "Something went wrong. Try again.");
	}

	return data;
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = value == null ? "" : String(value);
	return div.innerHTML;
}

function formatDate(iso) {
	if (!iso) return "";
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatDay(iso) {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// "in 12 days", "3 days ago", "in 5 hours"
function fromNow(iso) {
	const diff = new Date(iso).getTime() - Date.now();
	const hours = Math.round(Math.abs(diff) / 36e5);
	const amount = hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 2 ? `${hours} hours` : "an hour";
	return diff >= 0 ? `in ${amount}` : `${amount} ago`;
}

function durationLabel(days) {
	if (!days) return "Lifetime";
	return days === 1 ? "1 day" : `${days} days`;
}

let toastTimer;

function toast(message, isError = false) {
	let el = document.getElementById("toast");

	if (!el) {
		el = document.createElement("div");
		el.id = "toast";
		el.className = "toast";
		el.setAttribute("role", "status");
		document.body.appendChild(el);
	}

	el.textContent = message;
	el.classList.toggle("error", isError);
	el.classList.add("show");

	clearTimeout(toastTimer);
	// Longer messages stay up longer, so there's time to read them.
	toastTimer = setTimeout(() => el.classList.remove("show"), Math.max(isError ? 5000 : 2600, message.length * 50));
}

async function copyText(text, button) {
	try {
		await navigator.clipboard.writeText(text);
		const original = button.textContent;
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = original), 1200);
	} catch {
		toast("Couldn't copy. Select the text and copy it yourself.", true);
	}
}

// Disable a button while its action runs, so double-clicks don't send twice.
async function busy(button, work) {
	button.disabled = true;
	try {
		return await work();
	} finally {
		button.disabled = false;
	}
}

function renderWho(user, isAdmin) {
	const el = document.getElementById("who");
	if (!el || !user) return;

	el.innerHTML = `
		${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : ""}
		<span class="who-name">${escapeHtml(user.displayName || user.username)}</span>
		${isAdmin && location.pathname !== "/admin" ? '<a class="btn btn-quiet btn-small" href="/admin">Admin</a>' : ""}
		${location.pathname === "/admin" ? '<a class="btn btn-quiet btn-small" href="/dashboard">My license</a>' : ""}
		<form action="/logout" method="post"><button class="btn btn-quiet btn-small" type="submit">Log out</button></form>
	`;
}
