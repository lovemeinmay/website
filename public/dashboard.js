const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
	none: ["No license yet", "Redeem a key below to get started."],
	needs_roblox: ["Almost there", "Link your Roblox account so the script knows it's you."],
	active: ["Active", "The script will let your Roblox account in."],
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
		$("passRoblox").textContent = license.roblox ? license.roblox.username : "Not linked";

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
		$("scriptKeyText").textContent =
			license.status === "needs_roblox"
				? "Link your Roblox account below, then paste this into the script when it asks for a key."
				: "Paste this into the script when it asks for a key.";
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
	$("linkVerify").hidden = !pending;
	$("linkStart").hidden = !!pending || !!license.relinkAvailableAt;
	$("linkCooldown").hidden = !!pending || !license.relinkAvailableAt;

	if (license.roblox) {
		$("linkTitle").textContent = "Change Roblox account";
		$("linkText").textContent = `Linked to ${license.roblox.username}. To use a different account, enter it below.`;
	} else {
		$("linkTitle").textContent = "Link your Roblox account";
		$("linkText").textContent = "Enter the Roblox account you'll run the script on.";
	}

	if (license.relinkAvailableAt) {
		$("linkCooldown").textContent = `Linked to ${license.roblox.username}. You can switch to a different account on ${formatDate(
			license.relinkAvailableAt
		)}.`;
	}

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
