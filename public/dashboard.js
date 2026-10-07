const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
	none: ["No license yet", "Redeem a key below to get started."],
	needs_roblox: ["Almost there", "Link a Roblox account so the script knows it's you."],
	active: ["Active", "The script works on the Roblox accounts linked below."],
	expired: ["Expired", "Your time ran out. Redeem a new key to add more."],
	revoked: ["Revoked", "An admin revoked this license. Contact them if you think it's a mistake."],
};

let me = null;

function render() {
	const license = me.license;
	const status = license ? license.status : "none";
	const [title, hint] = STATUS_TEXT[status];

	// The pass
	$("pass").dataset.status = status;
	$("passStatus").textContent = title;
	$("passHint").textContent = hint;

	$("passGrid").hidden = !license;
	if (license) {
		$("passDiscord").textContent = me.user.username;
		$("passRoblox").textContent = license.accounts.length
			? license.accounts.map((account) => account.username).join(", ")
			: "Not linked";

		if (!license.expiresAt) {
			$("passExpires").textContent = "Never (lifetime)";
		} else {
			const past = new Date(license.expiresAt) <= new Date();
			$("passExpires").textContent = `${formatDate(license.expiresAt)} (${past ? "ended" : "ends"} ${fromNow(license.expiresAt)})`;
		}
	}

	// Script key: what the player pastes into the script.
	const showKey = !!me.scriptKey && !!license && license.status !== "revoked";
	$("scriptKeyPanel").hidden = !showKey;

	if (showKey) {
		$("scriptKey").textContent = me.scriptKey;
		$("loaderLine").textContent = `loadstring(game:HttpGet("${location.origin}/loader.lua"))()`;
		$("scriptKeyText").textContent =
			license.status === "needs_roblox"
				? "Link your Roblox account below first. Then it's two steps, and the script remembers your key after the first time."
				: "Two steps, and the script remembers your key after the first time.";
	}

	// Redeem panel: for new users, and for timed licenses that can take more time.
	const canRedeem = !license || (license.status !== "revoked" && license.expiresAt);
	$("redeemPanel").hidden = !canRedeem;

	if (license && license.expiresAt) {
		$("redeemTitle").textContent = "Add time with another key";
		$("redeemText").textContent = "Redeeming another key adds its time to your license.";
	} else {
		$("redeemTitle").textContent = "Redeem a key";
		$("redeemText").textContent = "Paste the license key you were given.";
	}

	// Roblox panel
	const showLink = license && license.status !== "revoked";
	$("linkPanel").hidden = !showLink;
	if (!showLink) return;

	const pending = license.pending;
	const accounts = license.accounts;
	const full = accounts.length >= license.maxAccounts;

	$("linkVerify").hidden = !pending;
	$("linkStart").hidden = !!pending || full;
	$("linkFull").hidden = !!pending || !full;

	$("linkTitle").textContent = accounts.length
		? `Your Roblox accounts (${accounts.length} of ${license.maxAccounts})`
		: "Link your Roblox account";

	$("linkText").textContent = accounts.length
		? `You can link up to ${license.maxAccounts} accounts, and the script works on all of them. Add another below.`
		: "Enter the Roblox account you'll run the script on. You can add more later.";

	$("linkFull").textContent = "That's the most accounts a license can have. Remove one to add another.";

	$("accountList").hidden = !accounts.length;
	$("accountList").innerHTML = accounts
		.map(
			(account) => `
			<li>
				<div>
					<strong>${escapeHtml(account.username)}</strong>
					<span class="sub">Linked ${escapeHtml(formatDay(account.linkedAt))}</span>
				</div>
				${
					account.removableAt
						? `<span class="muted small">Can remove on ${escapeHtml(formatDay(account.removableAt))}</span>`
						: `<button class="btn btn-quiet btn-small" type="button" data-remove="${account.id}" data-name="${escapeHtml(
								account.username
						  )}">Remove</button>`
				}
			</li>`
		)
		.join("");

	if (pending) {
		$("pendingName").textContent = pending.username;
		$("phrase").textContent = pending.phrase;
	}
}

async function load() {
	me = await api("GET", "/api/me");

	if (!me.user) {
		location.href = "/login?next=/dashboard";
		return;
	}

	renderWho(me.user, me.isAdmin);
	render();
}

$("redeemForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("redeemError").textContent = "";

	const key = $("keyInput").value.trim();
	if (!key) {
		$("redeemError").textContent = "Paste your license key first.";
		return;
	}

	busy($("redeemBtn"), async () => {
		try {
			const data = await api("POST", "/api/redeem", { key });
			me.license = data.license;
			me.scriptKey = data.scriptKey;
			$("keyInput").value = "";
			render();
			toast("Key redeemed");
		} catch (err) {
			$("redeemError").textContent = err.message;
		}
	});
});

$("linkForm").addEventListener("submit", (event) => {
	event.preventDefault();
	$("linkError").textContent = "";

	const username = $("robloxInput").value.trim();
	if (!username) {
		$("linkError").textContent = "Enter your Roblox username.";
		return;
	}

	busy($("linkBtn"), async () => {
		try {
			const data = await api("POST", "/api/roblox/start", { username });
			me.license = data.license;
			$("robloxInput").value = "";
			render();
		} catch (err) {
			$("linkError").textContent = err.message;
		}
	});
});

$("copyPhrase").addEventListener("click", () => copyText($("phrase").textContent, $("copyPhrase")));
$("copyScriptKey").addEventListener("click", () => copyText($("scriptKey").textContent, $("copyScriptKey")));
$("copyLoader").addEventListener("click", () => copyText($("loaderLine").textContent, $("copyLoader")));

$("verifyBtn").addEventListener("click", () => {
	$("verifyError").textContent = "";

	busy($("verifyBtn"), async () => {
		try {
			const data = await api("POST", "/api/roblox/verify");
			me.license = data.license;
			render();
			toast("Roblox account linked");
		} catch (err) {
			$("verifyError").textContent = err.message;
		}
	});
});

$("accountList").addEventListener("click", (event) => {
	const button = event.target.closest("button[data-remove]");
	if (!button) return;

	if (!confirm(`Remove ${button.dataset.name}? The script won't work on it until you link it again.`)) return;

	busy(button, async () => {
		try {
			const data = await api("POST", "/api/roblox/remove", { robloxUserId: Number(button.dataset.remove) });
			me.license = data.license;
			render();
			toast("Account removed");
		} catch (err) {
			toast(err.message, true);
		}
	});
});

$("cancelBtn").addEventListener("click", () => {
	busy($("cancelBtn"), async () => {
		try {
			const data = await api("POST", "/api/roblox/cancel");
			me.license = data.license;
			$("verifyError").textContent = "";
			render();
		} catch (err) {
			toast(err.message, true);
		}
	});
});

load().catch((err) => {
	$("passStatus").textContent = "Couldn't load";
	$("passHint").textContent = `${err.message} Refresh the page to try again.`;
});
