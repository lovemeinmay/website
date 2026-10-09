--[[
	Nya loader
	Players run this with:
		loadstring(game:HttpGet("{{SITE_URL}}/loader.lua"))()

	It asks for their key, checks it with the license site, then downloads the real
	script from the site and runs it. The real script never leaves the site unless
	the key is good for that player's Roblox account.
	Players get their key from the site (sign in with Discord, redeem a key, link
	their Roblox account), or use a key you added with "Add your own keys".
	The key window only has Check Key. A custom logo shows if there's an image at
	Nya/logo.png in the executor's workspace, or getgenv().NyaLogo is set.
]]

-- Settings. The site fills in SITE_URL when it sends this file.
local SITE_URL = "{{SITE_URL}}"
local KEY_FOLDER = "Nya"
local KEY_FILE = KEY_FOLDER .. "/key.txt"

-- Where keys were saved under the old name, so nobody has to type theirs again.
local OLD_KEY_FILE = "Rain/key.txt"

-- Render's free plan sleeps when nobody has visited for a while, and the first
-- request after that can take up to a minute. Try a few times before giving up.
local MAX_ATTEMPTS = 4

-- Services.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

-- Same colors as the menu.
local COLORS = {
	Font = Color3.fromRGB(255, 255, 255),
	Muted = Color3.fromRGB(165, 165, 182),
	Main = Color3.fromRGB(22, 22, 28),
	Background = Color3.fromRGB(15, 15, 20),
	Faint = Color3.fromRGB(95, 95, 110),
	Accent = Color3.fromRGB(255, 105, 180),
	AccentLight = Color3.fromRGB(255, 140, 200),
	AccentDark = Color3.fromRGB(205, 70, 140),
	Outline = Color3.fromRGB(46, 46, 58),
	Error = Color3.fromRGB(255, 95, 95),
	Success = Color3.fromRGB(120, 230, 150),
}

---Upper-case the key and drop spaces and anything else that isn't part of one.
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
		if isfile(KEY_FILE) then
			return readfile(KEY_FILE)
		end

		return isfile(OLD_KEY_FILE) and readfile(OLD_KEY_FILE) or nil
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

		if isfile(OLD_KEY_FILE) then
			delfile(OLD_KEY_FILE)
		end
	end)
end

---Find a custom logo image: getgenv().NyaLogo (an rbxassetid, or a workspace file path), or a
---file at Nya/logo.png (or .jpg) in the executor's workspace. Returns nil if there isn't one.
---@return string?
local function resolveNyaLogo()
	local getAsset = getcustomasset or getsynasset

	local function fromFile(path)
		if not (getAsset and isfile) then
			return nil
		end

		local ok, exists = pcall(isfile, path)
		if not (ok and exists) then
			return nil
		end

		local ok2, id = pcall(getAsset, path)
		return (ok2 and type(id) == "string" and id ~= "") and id or nil
	end

	local custom = (getgenv and getgenv().NyaLogo) or shared.NyaLogo

	if type(custom) == "number" then
		return "rbxassetid://" .. custom
	end

	if type(custom) == "string" and custom ~= "" then
		if string.find(custom, "^rbxasset") then
			return custom
		end

		local id = fromFile(custom)
		if id then
			return id
		end
	end

	return fromFile("Nya/logo.png") or fromFile("Nya/logo.jpg")
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

local function stroke(parent, color, transparency)
	return make("UIStroke", {
		Color = color or COLORS.Outline,
		Thickness = 1,
		Transparency = transparency or 0,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
		Parent = parent,
	})
end

local function tween(instance, seconds, props, style, direction)
	local info = TweenInfo.new(seconds, style or Enum.EasingStyle.Quad, direction or Enum.EasingDirection.Out)
	local object = TweenService:Create(instance, info, props)
	object:Play()
	return object
end

---Build the key window and wait until the player gets in or closes it.
---@param savedKey string?
---@return string? source
---@return string? key
local function prompt(savedKey)
	-- Only ever one key window. If one is already open (the script was run twice), close it.
	if type(shared.NyaKeyPromptClose) == "function" then
		pcall(shared.NyaKeyPromptClose)
	end

	local result = nil
	local source, goodKey = nil, nil

	local screenGui = make("ScreenGui", {
		Name = HttpService:GenerateGUID(false),
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
		DisplayOrder = 999999,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	})

	-- Dim the game behind the window.
	local dim = make("Frame", {
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = Color3.new(0, 0, 0),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Parent = screenGui,
	})

	local holder = make("Frame", {
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromOffset(400, 292),
		BackgroundTransparency = 1,
		Parent = screenGui,
	})

	local scale = make("UIScale", { Scale = 0.9, Parent = holder })

	-- Soft shadow.
	local shadow = make("ImageLabel", {
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.new(1, 60, 1, 60),
		BackgroundTransparency = 1,
		Image = "rbxassetid://6014261993",
		ImageColor3 = Color3.new(0, 0, 0),
		ImageTransparency = 1,
		ScaleType = Enum.ScaleType.Slice,
		SliceCenter = Rect.new(49, 49, 450, 450),
		Parent = holder,
	})

	local window = make("CanvasGroup", {
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = COLORS.Main,
		BorderSizePixel = 0,
		GroupTransparency = 1,
		Active = true,
		Parent = holder,
	})
	corner(window, 12)

	-- Outline on its own layer, so the fading window doesn't clip it.
	local border = make("Frame", {
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		ZIndex = 5,
		Parent = holder,
	})
	corner(border, 12)
	local windowStroke = stroke(border, COLORS.Accent, 1)

	-- Pink glow along the top edge.
	local glow = make("Frame", {
		Size = UDim2.new(1, 0, 0, 90),
		BackgroundColor3 = COLORS.Accent,
		BackgroundTransparency = 0.88,
		BorderSizePixel = 0,
		Parent = window,
	})
	make("UIGradient", {
		Rotation = 90,
		Transparency = NumberSequence.new({
			NumberSequenceKeypoint.new(0, 0),
			NumberSequenceKeypoint.new(1, 1),
		}),
		Parent = glow,
	})

	-- Header: logo, title, subtitle, close button.
	local header = make("Frame", {
		Size = UDim2.new(1, 0, 0, 72),
		BackgroundTransparency = 1,
		Active = true,
		Parent = window,
	})

	-- Logo: a custom image if there is one, otherwise a pink "N" tile.
	local logoImage = resolveNyaLogo()

	local logo = make(logoImage and "ImageLabel" or "Frame", {
		Position = UDim2.fromOffset(22, 18),
		Size = UDim2.fromOffset(38, 38),
		BackgroundColor3 = Color3.new(1, 1, 1),
		BorderSizePixel = 0,
		Parent = header,
	})
	corner(logo, 10)

	if logoImage then
		logo.Image = logoImage
		logo.ScaleType = Enum.ScaleType.Fit
	else
		make("UIGradient", {
			Rotation = 45,
			Color = ColorSequence.new(COLORS.AccentLight, COLORS.AccentDark),
			Parent = logo,
		})
		make("TextLabel", {
			Size = UDim2.fromScale(1, 1),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBlack,
			Text = "N",
			TextSize = 20,
			TextColor3 = COLORS.Background,
			Parent = logo,
		})
	end

	make("TextLabel", {
		Position = UDim2.fromOffset(72, 17),
		Size = UDim2.new(1, -130, 0, 22),
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamBold,
		Text = "Nya",
		TextSize = 20,
		TextColor3 = COLORS.Font,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = header,
	})

	make("TextLabel", {
		Position = UDim2.fromOffset(72, 39),
		Size = UDim2.new(1, -130, 0, 16),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "Key System",
		TextSize = 12,
		TextColor3 = COLORS.Muted,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = header,
	})

	local closeButton = make("TextButton", {
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -16, 0, 20),
		Size = UDim2.fromOffset(30, 30),
		BackgroundColor3 = COLORS.Background,
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Font = Enum.Font.GothamBold,
		Text = "X",
		TextSize = 13,
		TextColor3 = COLORS.Muted,
		AutoButtonColor = false,
		Parent = header,
	})
	corner(closeButton, 8)

	-- Divider that fades out at both ends.
	local divider = make("Frame", {
		Position = UDim2.fromOffset(22, 72),
		Size = UDim2.new(1, -44, 0, 1),
		BackgroundColor3 = COLORS.Accent,
		BorderSizePixel = 0,
		Parent = window,
	})
	make("UIGradient", {
		Transparency = NumberSequence.new({
			NumberSequenceKeypoint.new(0, 1),
			NumberSequenceKeypoint.new(0.5, 0.35),
			NumberSequenceKeypoint.new(1, 1),
		}),
		Parent = divider,
	})

	-- Key box.
	make("TextLabel", {
		Position = UDim2.fromOffset(22, 90),
		Size = UDim2.new(1, -44, 0, 14),
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamBold,
		Text = "LICENSE KEY",
		TextSize = 11,
		TextColor3 = COLORS.Muted,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = window,
	})

	local keyBox = make("TextBox", {
		Position = UDim2.fromOffset(22, 110),
		Size = UDim2.new(1, -44, 0, 44),
		BackgroundColor3 = COLORS.Background,
		BorderSizePixel = 0,
		ClearTextOnFocus = false,
		Font = Enum.Font.RobotoMono,
		PlaceholderText = "XXXX-XXXX-XXXX-XXXX",
		PlaceholderColor3 = COLORS.Faint,
		Text = savedKey or "",
		TextSize = 15,
		TextColor3 = COLORS.Font,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = window,
	})
	corner(keyBox, 8)
	local keyStroke = stroke(keyBox)
	make("UIPadding", { PaddingLeft = UDim.new(0, 14), PaddingRight = UDim.new(0, 14), Parent = keyBox })

	-- Status line with a colored dot.
	local statusDot = make("Frame", {
		Position = UDim2.fromOffset(24, 169),
		Size = UDim2.fromOffset(7, 7),
		BackgroundColor3 = COLORS.Muted,
		BorderSizePixel = 0,
		Parent = window,
	})
	corner(statusDot, 4)

	local statusLabel = make("TextLabel", {
		Position = UDim2.fromOffset(38, 164),
		Size = UDim2.new(1, -60, 0, 32),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "",
		TextSize = 12,
		TextColor3 = COLORS.Muted,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
		Parent = window,
	})

	-- Check Key button.
	local checkButton = make("TextButton", {
		Position = UDim2.fromOffset(22, 204),
		Size = UDim2.new(1, -44, 0, 46),
		BackgroundColor3 = Color3.new(1, 1, 1),
		BorderSizePixel = 0,
		Font = Enum.Font.GothamBold,
		Text = "Check Key",
		TextSize = 15,
		TextColor3 = COLORS.Background,
		AutoButtonColor = false,
		Parent = window,
	})
	corner(checkButton, 8)
	local buttonGradient = make("UIGradient", {
		Rotation = 0,
		Color = ColorSequence.new(COLORS.AccentLight, COLORS.AccentDark),
		Parent = checkButton,
	})
	local buttonScale = make("UIScale", { Parent = checkButton })

	make("TextLabel", {
		Position = UDim2.new(0, 22, 1, -32),
		Size = UDim2.new(1, -44, 0, 18),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "Your key is remembered once it's accepted.",
		TextSize = 11,
		TextColor3 = COLORS.Faint,
		Parent = window,
	})

	parentGui(screenGui)

	-- Open animation.
	tween(dim, 0.3, { BackgroundTransparency = 0.45 })
	tween(shadow, 0.3, { ImageTransparency = 0.45 })
	tween(window, 0.3, { GroupTransparency = 0 })
	tween(windowStroke, 0.3, { Transparency = 0.5 })
	tween(scale, 0.35, { Scale = 1 }, Enum.EasingStyle.Back)

	local busy = false
	local connections = {}
	local closeSelf = nil

	local function setStatus(text, color)
		statusLabel.Text = text
		statusLabel.TextColor3 = color or COLORS.Muted
		statusDot.BackgroundColor3 = color or COLORS.Muted
	end

	local function setBusy(isBusy)
		busy = isBusy
		checkButton.Text = isBusy and "Checking..." or "Check Key"
		tween(checkButton, 0.15, { BackgroundTransparency = isBusy and 0.35 or 0 })
		keyBox.TextEditable = not isBusy
	end

	local function shake()
		local x = holder.Position.X.Offset

		for _, offset in next, { -8, 7, -5, 4, -2, 0 } do
			tween(holder, 0.04, { Position = UDim2.new(0.5, x + offset, 0.5, holder.Position.Y.Offset) }).Completed:Wait()
		end
	end

	local function finish(value)
		if result ~= nil then
			return
		end

		result = value

		if shared.NyaKeyPromptClose == closeSelf then
			shared.NyaKeyPromptClose = nil
		end

		for _, connection in next, connections do
			connection:Disconnect()
		end

		tween(dim, 0.2, { BackgroundTransparency = 1 })
		tween(shadow, 0.2, { ImageTransparency = 1 })
		tween(window, 0.2, { GroupTransparency = 1 })
		tween(windowStroke, 0.2, { Transparency = 1 })
		tween(scale, 0.2, { Scale = 0.92 }, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

		task.delay(0.25, function()
			screenGui:Destroy()
		end)
	end

	closeSelf = function()
		finish(false)
	end
	shared.NyaKeyPromptClose = closeSelf

	local function submit()
		if busy or result ~= nil then
			return
		end

		local key = normalize(keyBox.Text)
		keyBox.Text = key

		if key == "" then
			setStatus("Paste your key first.", COLORS.Error)
			task.spawn(shake)
			return
		end

		setBusy(true)
		setStatus("Checking your key...", COLORS.Muted)

		local allowed, message = checkKey(key, function(text)
			setStatus(text, COLORS.Muted)
		end)

		if result ~= nil then
			return
		end

		if allowed then
			saveKey(key)
			keyStroke.Color = COLORS.Success
			checkButton.Text = "Loading..."
			setStatus("Key accepted. Downloading Nya...", COLORS.Success)

			local downloaded, problem = downloadScript(key)

			if result ~= nil then
				return
			end

			if downloaded then
				source, goodKey = downloaded, key
				windowStroke.Color = COLORS.Success
				setStatus("Starting Nya...", COLORS.Success)
				task.wait(0.4)
				return finish(true)
			end

			setBusy(false)
			setStatus(problem, COLORS.Error)
			keyStroke.Color = COLORS.Error
			task.spawn(shake)
			return
		end

		if allowed == false then
			forgetKey()
		end

		setBusy(false)
		setStatus(message, COLORS.Error)
		keyStroke.Color = COLORS.Error
		task.spawn(shake)
	end

	-- Key box focus.
	keyBox.Focused:Connect(function()
		tween(keyStroke, 0.15, { Color = COLORS.Accent })
	end)

	keyBox.FocusLost:Connect(function(enterPressed)
		tween(keyStroke, 0.15, { Color = COLORS.Outline })

		if enterPressed then
			submit()
		end
	end)

	-- Button hover and press.
	checkButton.MouseEnter:Connect(function()
		if not busy then
			tween(buttonGradient, 0.2, { Offset = Vector2.new(0.15, 0) })
			tween(buttonScale, 0.15, { Scale = 1.02 })
		end
	end)

	checkButton.MouseLeave:Connect(function()
		tween(buttonGradient, 0.2, { Offset = Vector2.new(0, 0) })
		tween(buttonScale, 0.15, { Scale = 1 })
	end)

	checkButton.MouseButton1Down:Connect(function()
		tween(buttonScale, 0.08, { Scale = 0.97 })
	end)

	checkButton.MouseButton1Up:Connect(function()
		tween(buttonScale, 0.12, { Scale = 1 })
	end)

	closeButton.MouseEnter:Connect(function()
		tween(closeButton, 0.15, { BackgroundTransparency = 0, TextColor3 = COLORS.Accent })
	end)

	closeButton.MouseLeave:Connect(function()
		tween(closeButton, 0.15, { BackgroundTransparency = 1, TextColor3 = COLORS.Muted })
	end)

	checkButton.MouseButton1Click:Connect(submit)

	closeButton.MouseButton1Click:Connect(function()
		finish(false)
	end)

	-- Drag the window by its header.
	local dragging, dragStart, startPos = false, nil, nil

	header.InputBegan:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = true
			dragStart = input.Position
			startPos = holder.Position
		end
	end)

	connections[#connections + 1] = UserInputService.InputChanged:Connect(function(input)
		if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
			local delta = input.Position - dragStart
			holder.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X, startPos.Y.Scale, startPos.Y.Offset + delta.Y)
		end
	end)

	connections[#connections + 1] = UserInputService.InputEnded:Connect(function(input)
		if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
			dragging = false
		end
	end)

	if savedKey then
		task.spawn(submit)
	else
		setStatus("Enter your key and press Check Key.", COLORS.Muted)
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
