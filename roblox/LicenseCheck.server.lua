--[[
	LicenseCheck
	Put this in a Script inside ServerScriptService.
	It kicks anyone whose Roblox account doesn't have an active license.

	Before it works:
	  1. Game Settings > Security > turn on "Allow HTTP Requests".
	  2. Set SITE_URL below to your Render URL (no slash at the end).
	  3. If you set PUBLIC_API_TOKEN on Render, paste the same value into LICENSE_TOKEN.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local SITE_URL = "https://YOUR-APP.onrender.com"
local LICENSE_TOKEN = "" -- leave empty if you didn't set PUBLIC_API_TOKEN

-- Render's free plan sleeps when idle and can take up to a minute to wake up,
-- so try a few times before giving up.
local MAX_ATTEMPTS = 4

-- Returns true/false once the server answers.
-- Returns nil plus a reason if the server couldn't be reached.
local function checkLicense(userId: number): (boolean?, string?)
	local headers = {}
	if LICENSE_TOKEN ~= "" then
		headers["X-License-Token"] = LICENSE_TOKEN
	end

	for attempt = 1, MAX_ATTEMPTS do
		local ok, response = pcall(function()
			return HttpService:RequestAsync({
				Url = SITE_URL .. "/api/check?robloxUserId=" .. tostring(userId),
				Method = "GET",
				Headers = headers,
			})
		end)

		if ok and response.Success then
			local decoded, data = pcall(function()
				return HttpService:JSONDecode(response.Body)
			end)

			if decoded and type(data) == "table" then
				return data.allowed == true, nil
			end

			return nil, "the server sent something that isn't JSON"
		end

		if ok and response.StatusCode == 403 then
			return nil, "LICENSE_TOKEN doesn't match PUBLIC_API_TOKEN"
		end

		local reason = if ok then ("HTTP " .. response.StatusCode) else tostring(response)
		warn(("License check attempt %d/%d failed: %s"):format(attempt, MAX_ATTEMPTS, reason))

		if attempt < MAX_ATTEMPTS then
			task.wait(attempt * 5)
		end
	end

	return nil, "couldn't reach the license server"
end

local function onPlayerAdded(player: Player)
	local allowed, problem = checkLicense(player.UserId)

	if allowed then
		return
	end

	if not player.Parent then
		return -- They already left while we were checking.
	end

	if allowed == false then
		player:Kick("You don't have an active license. Redeem a key and link this Roblox account at " .. SITE_URL)
	else
		warn("License check failed for " .. player.Name .. ": " .. tostring(problem))
		player:Kick("Couldn't check your license right now. Rejoin in a minute.")
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)

-- Also check anyone who joined before this script started (helps in Studio).
for _, player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end
