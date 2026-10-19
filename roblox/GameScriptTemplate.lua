--[[
	Nya game script template

	Upload a script like this in the admin panel (Script tab -> Other games) for any game that
	isn't Deepwoken. Players run the normal Nya loader: it checks their key, sees which game
	they're in, and runs that game's script. The same Nya key works in every game.

	The loader passes the player's key in as the first argument, in case the script wants it.
]]

local NYA_KEY = ...

local Players = game:GetService("Players")
local StarterGui = game:GetService("StarterGui")

local player = Players.LocalPlayer

-- Stop an older copy of this script if it's run twice.
if shared.NyaGame and shared.NyaGame.unload then
	pcall(shared.NyaGame.unload)
end

local NyaGame = { connections = {} }
shared.NyaGame = NyaGame

function NyaGame.unload()
	for _, connection in next, NyaGame.connections do
		pcall(function()
			connection:Disconnect()
		end)
	end
	NyaGame.connections = {}
end

pcall(function()
	StarterGui:SetCore("SendNotification", {
		Title = "Nya",
		Text = "Loaded for this game. Hi " .. player.DisplayName .. "!",
		Duration = 5,
	})
end)

-- Your game's features go below. Keep anything that runs every frame in NyaGame.connections
-- so unload() can stop it.

_ = NYA_KEY
