const DISCORD_API = "https://discord.com/api";

/**
 * Build the URL that sends the browser to Discord's login/consent screen.
 */
function getAuthorizeUrl() {
	const params = new URLSearchParams({
		client_id: process.env.DISCORD_CLIENT_ID,
		redirect_uri: process.env.DISCORD_REDIRECT_URI,
		response_type: "code",
		scope: "identify",
	});

	return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange the ?code=... Discord redirected back with for an access token.
 */
async function exchangeCode(code) {
	const body = new URLSearchParams({
		client_id: process.env.DISCORD_CLIENT_ID,
		client_secret: process.env.DISCORD_CLIENT_SECRET,
		grant_type: "authorization_code",
		code,
		redirect_uri: process.env.DISCORD_REDIRECT_URI,
	});

	const response = await fetch(`${DISCORD_API}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	if (!response.ok) {
		throw new Error(`Discord token exchange failed: ${response.status}`);
	}

	return response.json();
}

/**
 * Fetch the logged-in Discord user's profile (id, username, ...).
 */
async function fetchDiscordUser(accessToken) {
	const response = await fetch(`${DISCORD_API}/users/@me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		throw new Error(`Discord user fetch failed: ${response.status}`);
	}

	return response.json();
}

module.exports = { getAuthorizeUrl, exchangeCode, fetchDiscordUser };
