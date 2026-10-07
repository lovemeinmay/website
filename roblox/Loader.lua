--[[
	Rain loader
	Players run this with:
		loadstring(game:HttpGet("{{SITE_URL}}/loader.lua"))()

	It asks for their key, checks it with the license site, then downloads the real
	script from the site and runs it. The real script never leaves the site unless
	the key is good for that player's Roblox account.
	Players get their key from the site: sign in with Discord, redeem a key,
	link their Roblox account, then copy the key under "Your script key".
]]

-- Settings. The site fills in SITE_URL when it sends this file.
local SITE_URL = "{{SITE_URL}}"
local KEY_FOLDER = "Rain"
local KEY_FILE = KEY_FOLDER .. "/key.txt"

-- Render's free plan sleeps when nobody has visited for a while, and the first
-- request after that can take up to a minute. Try a few times before giving up.
local MAX_ATTEMPTS = 4

-- Services.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

-- Same colors as the menu.
local COLORS = {
	Font = Color3.fromRGB(255, 255, 255),
	Muted = Color3.fromRGB(165, 165, 182),
	Main = Color3.fromRGB(22, 22, 28),
	Background = Color3.fromRGB(15, 15, 20),
	Accent = Color3.fromRGB(255, 105, 180),
	Outline = Color3.fromRGB(46, 46, 58),
	Error = Color3.fromRGB(255, 95, 95),
	Success = Color3.fromRGB(120, 230, 150),
}

---Keys look like RAIN-XXXXX-XXXXX-XXXXX. Drop spaces and anything else that isn't part of one.
---@param text string?
---@return string
local function normalize(text)
	local cleaned = string.upper(tostring(text or "")):gsub("[^%w%-]", "")
	return cleaned
end

---Make a GET request with whatever HTTP function the executor has.
---@param url string
---@return number? statusCode
---@return string? body
local function httpGet(url)
	local requestFn = (syn and syn.request) or (http and http.request) or http_request or (fluxus and fluxus.request) or request

	if requestFn then
		local ok, response = pcall(requestFn, { Url = url, Method = "GET" })

		if not ok or type(response) ~= "table" then
			return nil, tostring(response)
		end

		return response.StatusCode, response.Body
	end

	-- No request function, so fall back to HttpGet (it errors on anything that isn't a success).
	local ok, body = pcall(game.HttpGet, game, url)

	if not ok then
		return nil, tostring(body)
	end

	return 200, body
end

---Ask the license site whether this key works for this Roblox account.
---@param key string
---@param onStatus fun(text: string)?
---@return boolean? allowed true = good key, false = bad key, nil = couldn't check
---@return string message
local function checkKey(key, onStatus)
	local url = string.format(
		"%s/api/check-key?key=%s&robloxUserId=%d",
		SITE_URL,
		HttpService:UrlEncode(key),
		Players.LocalPlayer.UserId
	)

	for attempt = 1, MAX_ATTEMPTS do
		local status, body = httpGet(url)

		if status == 200 then
			local ok, data = pcall(HttpService.JSONDecode, HttpService, body)

			if ok and type(data) == "table" then
				if data.allowed == true then
					return true, "Key accepted."
				end

				return false, tostring(data.message or "That key isn't valid.")
			end
		elseif status == 429 then
			return nil, "Too many tries. Wait a minute, then try again."
		end

		if attempt < MAX_ATTEMPTS then
			if onStatus then
				onStatus(string.format("Waking up the license server... (try %d of %d)", attempt + 1, MAX_ATTEMPTS))
			end

			task.wait(attempt * 5)
		end
	end

	return nil, "Couldn't reach the license server. Try again in a minute."
end

---Download the real script. Only works for a key that's good for this Roblox account.
---@param key string
---@return string? source
---@return string? problem
local function downloadScript(key)
	local url = string.format(
		"%s/api/script?key=%s&robloxUserId=%d",
		SITE_URL,
		HttpService:UrlEncode(key),
		Players.LocalPlayer.UserId
	)

	local status, body = httpGet(url)

	if status ~= 200 or type(body) ~= "string" or body == "" then
		local ok, data = pcall(HttpService.JSONDecode, HttpService, body or "")
		local message = ok and type(data) == "table" and data.error

		return nil, message and tostring(message) or ("Couldn't download the script (" .. tostring(status or body) .. ").")
	end

	-- Some executors ask for a zipped download but can't unzip it.
	if string.sub(body, 1, 2) == "\31\139" then
		return nil, "Your executor couldn't unzip the download. Try a different executor."
	end

	return body, nil
end

---@return string?
local function loadSavedKey()
	if not (isfile and readfile) then
		return nil
	end

	local ok, contents = pcall(function()
		return isfile(KEY_FILE) and readfile(KEY_FILE) or nil
	end)

	local key = ok and normalize(contents) or ""
	return key ~= "" and key or nil
end

---@param key string
local function saveKey(key)
	if not (writefile and isfolder and makefolder) then
		return
	end

	pcall(function()
		if not isfolder(KEY_FOLDER) then
			makefolder(KEY_FOLDER)
		end

		writefile(KEY_FILE, key)
	end)
end

local function forgetKey()
	if not (isfile and delfile) then
		return
	end

	pcall(function()
		if isfile(KEY_FILE) then
			delfile(KEY_FILE)
		end
	end)
end

---Where to put the prompt so the game can't see or delete it.
---@param screenGui ScreenGui
local function parentGui(screenGui)
	if syn and syn.protect_gui then
		pcall(syn.protect_gui, screenGui)
	end

	if gethui then
		local ok, hui = pcall(gethui)

		if ok and hui and pcall(function()
			screenGui.Parent = hui
		end) then
			return
		end
	end

	if pcall(function()
		screenGui.Parent = game:GetService("CoreGui")
	end) then
		return
	end

	screenGui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")
end

---@param className string
---@param props table
---@return Instance
local function make(className, props)
	local instance = Instance.new(className)

	for name, value in next, props do
		if name ~= "Parent" then
			instance[name] = value
		end
	end

	instance.Parent = props.Parent
	return instance
end

local function corner(parent, radius)
	return make("UICorner", { CornerRadius = UDim.new(0, radius or 6), Parent = parent })
end

local function stroke(parent, color)
	return make("UIStroke", {
		Color = color or COLORS.Outline,
		Thickness = 1,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
		Parent = parent,
	})
end

---Build the prompt and wait until the player gets in or closes it.
---@param savedKey string?
---@return string? source
---@return string? key
local function prompt(savedKey)
	local result = nil
	local source, goodKey = nil, nil

	local screenGui = make("ScreenGui", {
		Name = HttpService:GenerateGUID(false),
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
		DisplayOrder = 999999,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	})

	local window = make("Frame", {
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromOffset(360, 222),
		BackgroundColor3 = COLORS.Main,
		BorderSizePixel = 0,
		Active = true,
		Parent = screenGui,
	})
	corner(window, 8)
	stroke(window)

	-- Pink strip along the top, like the menu.
	make("Frame", {
		Position = UDim2.fromOffset(10, 0),
		Size = UDim2.new(1, -20, 0, 2),
		BackgroundColor3 = COLORS.Accent,
		BorderSizePixel = 0,
		Parent = window,
	})

	make("TextLabel", {
		Position = UDim2.fromOffset(18, 16),
		Size = UDim2.new(1, -60, 0, 24),
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamBold,
		Text = "Rain",
		TextSize = 20,
		TextColor3 = COLORS.Font,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = window,
	})

	make("TextLabel", {
		Position = UDim2.fromOffset(18, 40),
		Size = UDim2.new(1, -36, 0, 18),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "Enter your key to continue.",
		TextSize = 13,
		TextColor3 = COLORS.Muted,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = window,
	})

	local closeButton = make("TextButton", {
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -10, 0, 12),
		Size = UDim2.fromOffset(28, 28),
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamBold,
		Text = "X",
		TextSize = 14,
		TextColor3 = COLORS.Muted,
		AutoButtonColor = false,
		Parent = window,
	})

	local keyBox = make("TextBox", {
		Position = UDim2.fromOffset(18, 70),
		Size = UDim2.new(1, -36, 0, 36),
		BackgroundColor3 = COLORS.Background,
		BorderSizePixel = 0,
		ClearTextOnFocus = false,
		Font = Enum.Font.Code,
		PlaceholderText = "RAIN-XXXXX-XXXXX-XXXXX",
		PlaceholderColor3 = Color3.fromRGB(95, 95, 110),
		Text = savedKey or "",
		TextSize = 15,
		TextColor3 = COLORS.Font,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = window,
	})
	corner(keyBox, 6)
	local keyStroke = stroke(keyBox)
	make("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10), Parent = keyBox })

	local statusLabel = make("TextLabel", {
		Position = UDim2.fromOffset(18, 112),
		Size = UDim2.new(1, -36, 0, 34),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "",
		TextSize = 13,
		TextColor3 = COLORS.Muted,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
		Parent = window,
	})

	local getKeyButton = make("TextButton", {
		Position = UDim2.fromOffset(18, 162),
		Size = UDim2.new(0.5, -23, 0, 40),
		BackgroundColor3 = COLORS.Background,
		BorderSizePixel = 0,
		Font = Enum.Font.GothamBold,
		Text = "Get Key",
		TextSize = 14,
		TextColor3 = COLORS.Font,
		AutoButtonColor = false,
		Parent = window,
	})
	corner(getKeyButton, 6)
	stroke(getKeyButton)

	local checkButton = make("TextButton", {
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -18, 0, 162),
		Size = UDim2.new(0.5, -23, 0, 40),
		BackgroundColor3 = COLORS.Accent,
		BorderSizePixel = 0,
		Font = Enum.Font.GothamBold,
		Text = "Check Key",
		TextSize = 14,
		TextColor3 = COLORS.Background,
		AutoButtonColor = false,
		Parent = window,
	})
	corner(checkButton, 6)

	parentGui(screenGui)

	local busy = false

	local function setStatus(text, color)
		statusLabel.Text = text
		statusLabel.TextColor3 = color or COLORS.Muted
	end

	local function setBusy(isBusy)
		busy = isBusy
		checkButton.Text = isBusy and "Checking..." or "Check Key"
		checkButton.BackgroundTransparency = isBusy and 0.35 or 0
		keyBox.TextEditable = not isBusy
	end

	local function finish(value)
		if result ~= nil then
			return
		end

		result = value

		local fade = TweenInfo.new(0.2)
		TweenService:Create(window, fade, { BackgroundTransparency = 1 }):Play()

		for _, descendant in next, window:GetDescendants() do
			if descendant:IsA("TextLabel") or descendant:IsA("TextButton") or descendant:IsA("TextBox") then
				TweenService:Create(descendant, fade, { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
			elseif descendant:IsA("UIStroke") then
				TweenService:Create(descendant, fade, { Transparency = 1 }):Play()
			elseif descendant:IsA("Frame") then
				TweenService:Create(descendant, fade, { BackgroundTransparency = 1 }):Play()
			end
		end

		task.delay(0.25, function()
			screenGui:Destroy()
		end)
	end

	local function submit()
		if busy or result ~= nil then
			return
		end

		local key = normalize(keyBox.Text)
		keyBox.Text = key

		if key == "" then
			return setStatus("Paste your key first. Press Get Key if you don't have one.", COLORS.Error)
		end

		setBusy(true)
		setStatus("Checking your key...", COLORS.Muted)

		local allowed, message = checkKey(key, function(text)
			setStatus(text, COLORS.Muted)
		end)

		if allowed then
			saveKey(key)
			setStatus("Key accepted. Downloading the script...", COLORS.Success)

			local downloaded, problem = downloadScript(key)

			if downloaded then
				source, goodKey = downloaded, key
				setStatus("Starting...", COLORS.Success)
				task.wait(0.3)
				return finish(true)
			end

			setBusy(false)
			return setStatus(problem, COLORS.Error)
		end

		if allowed == false then
			forgetKey()
		end

		setBusy(false)
		setStatus(message, COLORS.Error)
	end

	-- Hover and focus effects.
	keyBox.Focused:Connect(function()
		keyStroke.Color = COLORS.Accent
	end)

	keyBox.FocusLost:Connect(function(enterPressed)
		keyStroke.Color = COLORS.Outline

		if enterPressed then
			submit()
		end
	end)

	getKeyButton.MouseEnter:Connect(function()
		getKeyButton.TextColor3 = COLORS.Accent
	end)

	getKeyButton.MouseLeave:Connect(function()
		getKeyButton.TextColor3 = COLORS.Font
	end)

	closeButton.MouseEnter:Connect(function()
		closeButton.TextColor3 = COLORS.Accent
	end)

	closeButton.MouseLeave:Connect(function()
		closeButton.TextColor3 = COLORS.Muted
	end)

	-- Buttons.
	checkButton.MouseButton1Click:Connect(submit)

	getKeyButton.MouseButton1Click:Connect(function()
		if setclipboard and pcall(setclipboard, SITE_URL) then
			setStatus("Link copied. Open it in your browser, sign in, and copy your script key.", COLORS.Accent)
		else
			setStatus("Get your key at " .. SITE_URL, COLORS.Accent)
		end
	end)

	closeButton.MouseButton1Click:Connect(function()
		finish(false)
	end)

	-- Check a key saved from last time straight away.
	if savedKey then
		task.spawn(submit)
	else
		setStatus("Don't have a key? Press Get Key.", COLORS.Muted)
	end

	repeat
		task.wait()
	until result ~= nil

	return source, goodKey
end

-- Wait for the game and the player, then ask for the key.
if not game:IsLoaded() then
	game.Loaded:Wait()
end

while not Players.LocalPlayer do
	task.wait()
end

local source, key = prompt(loadSavedKey())

if not source then
	return warn("No valid key, so the script didn't load.")
end

local run, compileError = loadstring(source)

if not run then
	return warn("The script downloaded but couldn't start: " .. tostring(compileError))
end

-- Pass the key along so the script can check it again by itself.
return run(key)
