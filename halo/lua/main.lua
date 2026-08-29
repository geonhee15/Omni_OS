-- OMNI for Halo - thin client app
-- Mic 16k PCM -> BLE to host bridge. Host sends: 0x01/0x02 caption,
-- 0x03 status, 0x10 speaker audio. Tap sends 0xF0 (toggle) to host.

local status = "BOOT"
local caption = ""
local spk_on = false

local function render()
  frame.display.clear()
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

frame.bluetooth.receive_callback(function(data)
  local tag = string.byte(data, 1)
  local payload = string.sub(data, 2)
  if tag == 0x01 or tag == 0x02 then
    caption = payload
    render()
  elseif tag == 0x03 then
    status = payload
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
