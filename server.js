require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");

const db = require("./src/db");
const discord = require("./src/discord");

const app = express();

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
	session({
		secret: process.env.SESSION_SECRET || "change-me",
		resave: false,
		saveUninitialized: false,
		cookie: {
			httpOnly: true,
			sameSite: "lax",
			secure: process.env.NODE_ENV === "production",
			maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week.
		},
	})
);

app.use("/assets", express.static(path.join(__dirname, "public")));

const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || "")
	.split(",")
	.map((id) => id.trim())
	.filter(Boolean);

function requireAdmin(req, res, next) {
	if (req.session.user && ADMIN_IDS.includes(req.session.user.id)) {
		return next();
	}

	return res.redirect("/login");
}

// Database calls are async now, so catch their errors instead of letting them crash the server.
function asyncRoute(handler) {
	return (req, res, next) => {
		Promise.resolve(handler(req, res, next)).catch((err) => {
			console.error(err);

			if (!res.headersSent) {
				res.status(500).json({ error: "Database error. Check the server logs." });
			}
		});
	};
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

app.get("/login", (req, res) => {
	res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/auth/discord", (req, res) => {
	res.redirect(discord.getAuthorizeUrl());
});

app.get("/auth/discord/callback", async (req, res) => {
	const { code } = req.query;

	if (!code) {
		return res.redirect("/login");
	}

	try {
		const token = await discord.exchangeCode(code);
		const user = await discord.fetchDiscordUser(token.access_token);

		if (!ADMIN_IDS.includes(user.id)) {
			return res.status(403).sendFile(path.join(__dirname, "views", "denied.html"));
		}

		req.session.user = { id: user.id, username: user.username };
		res.redirect("/admin");
	} catch (err) {
		console.error(err);
		res.status(500).send("Discord login failed. Check the server logs.");
	}
});

app.post("/logout", (req, res) => {
	req.session.destroy(() => res.redirect("/login"));
});

// ---------------------------------------------------------------------------
// Admin page + admin API (Discord login required)
// ---------------------------------------------------------------------------

app.get("/admin", requireAdmin, (req, res) => {
	res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/admin/api/me", requireAdmin, (req, res) => {
	res.json({ user: req.session.user });
});

app.get(
	"/admin/api/licenses",
	requireAdmin,
	asyncRoute(async (req, res) => {
		res.json(await db.listLicenses());
	})
);

app.post("/admin/api/licenses", requireAdmin, async (req, res) => {
	const { robloxUserId, robloxUsername, discordId, discordUsername, note } = req.body;

	if (!robloxUserId) {
		return res.status(400).json({ error: "robloxUserId is required" });
	}

	try {
		await db.addLicense({
			robloxUserId: Number(robloxUserId),
			robloxUsername,
			discordId,
			discordUsername,
			note,
		});

		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: err.message });
	}
});

app.patch(
	"/admin/api/licenses/:id",
	requireAdmin,
	asyncRoute(async (req, res) => {
		await db.setRevoked(req.params.id, !!req.body.revoked);
		res.json({ ok: true });
	})
);

app.delete(
	"/admin/api/licenses/:id",
	requireAdmin,
	asyncRoute(async (req, res) => {
		await db.deleteLicense(req.params.id);
		res.json({ ok: true });
	})
);

// Look up a Roblox username's user id, so the admin page can fill it in automatically.
app.get("/admin/api/resolve-roblox", requireAdmin, async (req, res) => {
	const username = req.query.username;

	if (!username) {
		return res.status(400).json({ error: "username is required" });
	}

	try {
		const response = await fetch("https://users.roblox.com/v1/usernames/users", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
		});

		const data = await response.json();
		const match = data.data && data.data[0];

		if (!match) {
			return res.status(404).json({ error: "Roblox user not found" });
		}

		res.json({ id: match.id, name: match.name });
	} catch (err) {
		res.status(500).json({ error: "Roblox lookup failed" });
	}
});

// ---------------------------------------------------------------------------
// Public API the Lua script reads. Only Roblox IDs ever leave this endpoint.
// ---------------------------------------------------------------------------

const PUBLIC_API_TOKEN = process.env.PUBLIC_API_TOKEN || "";

app.get(
	"/api/allowlist",
	asyncRoute(async (req, res) => {
		if (PUBLIC_API_TOKEN) {
			const sent = req.header("X-License-Token") || req.query.token;

			if (sent !== PUBLIC_API_TOKEN) {
				return res.status(403).json({ error: "forbidden" });
			}
		}

		res.json(await db.publicList());
	})
);

app.get("/", (req, res) => {
	res.send("RAIN license server is running. Admin panel: /admin");
});

const PORT = process.env.PORT || 3000;

db.init()
	.then(() => {
		app.listen(PORT, () => {
			console.log(`License server listening on port ${PORT}`);
		});
	})
	.catch((err) => {
		console.error("Could not connect to the database:", err);
		process.exit(1);
	});
