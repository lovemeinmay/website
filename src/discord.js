const config = require("./config");

const DISCORD_API = "https://discord.com/api";

// The URL that sends someone to Discord's "Authorize" screen.
// `state` is a random value we check when they come back, so nobody can trick
// a browser into logging in with someone else's Discord code.
function getAuthorizeUrl(state) {
	const params = new URLSearchParams({
		client_id: config.discord.clientId,
		redirect_uri: config.discord.redirectUri,
		response_type: "code",
		scope: "identify",
		state,
	});

	return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

// Swap the ?code=... Discord sends back for the user's id and name.
async function getUserFromCode(code) {
	const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.discord.clientId,
			client_secret: config.discord.clientSecret,
			grant_type: "authorization_code",
			code,
			redirect_uri: config.discord.redirectUri,
		}),
		signal: AbortSignal.timeout(10000),
	});

	if (!tokenResponse.ok) {
		throw new Error(`Discord token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
	}

	const token = await tokenResponse.json();

	const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
		headers: { Authorization: `Bearer ${token.access_token}` },
		signal: AbortSignal.timeout(10000),
	});

	if (!userResponse.ok) {
		throw new Error(`Discord user fetch failed: ${userResponse.status}`);
	}

	const user = await userResponse.json();

	return {
		id: String(user.id),
		username: user.username,
		displayName: user.global_name || user.username,
		avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
	};
}

module.exports = { getAuthorizeUrl, getUserFromCode };
