-- OMNI for Halo - thin client app
-- Mic 16k PCM -> BLE to host bridge. Host sends:
--   0x01/0x02 caption text, 0x03 status text (legacy fallback)
--   0x10 speaker audio
--   0x11 1bpp caption bitmap (legacy)
--   0x12 [pal 48B][4bpp 256x256] background art
--   0x13/0x14/0x15 [x][y][w][4bpp] status / caption / banner sprite
-- Tap sends 0xF0 to host.

local status = "BOOT"
local caption = ""
local cap_bmp = nil
local pal = nil
local bg = nil
local st_bmp = nil
local cap4 = nil
local ban_bmp = nil
local spk_on = false

local function draw_sprite(s)
  if not s then return end
  pcall(function()
    if pal then
      frame.display.bitmap(s.x, s.y, s.w, 16, 0, s.data, {palette_data = pal})
    else
      frame.display.bitmap(s.x, s.y, s.w, 16, 0, s.data)
    end
  end)
end

local function render()
  frame.display.clear()
  if bg then
    pcall(function()
      frame.display.bitmap(1, 1, 256, 16, 0, bg, {palette_data = pal})
    end)
  else
    -- legacy fallback HUD (host without hud.py)
    pcall(function() frame.display.circle(128, 128, 122) end)
    frame.display.text("O M N I", 88, 44)
    frame.display.text(status, 92, 78)
    local y = 140
    for line in string.gmatch(caption, "[^\n]+") do
      frame.display.text(line, 24, y)
      y = y + 24
      if y > 220 then break end
    end
  end
  draw_sprite(st_bmp)
  draw_sprite(ban_bmp)
  draw_sprite(cap4)
  if cap_bmp then
    pcall(function()
      frame.display.bitmap(16, cap_bmp.y, cap_bmp.w, 2, 0, cap_bmp.data)
    end)
  end
end

frame.bluetooth.receive_callback(function(data)
  local tag = string.byte(data, 1)
  local payload = string.sub(data, 2)
  if tag == 0x01 or tag == 0x02 then
    caption = payload
    render()
  elseif tag == 0x03 then
    status = payload
    render()
  elseif tag == 0x11 then
    cap_bmp = {
      y = string.byte(data, 2),
      w = string.byte(data, 3) * 8,
      data = string.sub(data, 4),
    }
    caption = ""
    render()
  elseif tag == 0x12 then
    pal = string.sub(data, 2, 49)
    bg = string.sub(data, 50)
    render()
  elseif tag == 0x13 or tag == 0x14 or tag == 0x15 then
    local s = {
      x = string.byte(data, 2),
      y = string.byte(data, 3),
      w = string.byte(data, 4),
      data = string.sub(data, 5),
    }
    if tag == 0x13 then
      st_bmp = s
    elseif tag == 0x15 then
      ban_bmp = s
    else
      cap4 = s
      cap_bmp = nil
      caption = ""
    end
    render()
  elseif tag == 0x10 then
    if not spk_on then
      pcall(function() frame.speaker.start{sample_rate=16000, bit_depth=16} end)
      spk_on = true
    end
    pcall(function() frame.speaker.play(payload) end)
  end
end)

pcall(function()
  frame.imu.tap_callback(function() frame.bluetooth.send("\xF0") end)
end)

frame.microphone.start{sample_rate=16000, bit_depth=16}
status = "LISTENING"
render()

while true do
  local d = frame.microphone.read(1600) -- 50ms @16k pcm16
  if d and #d > 0 then
    frame.bluetooth.send("\x20" .. d)
  end
  frame.sleep(0.02)
end
