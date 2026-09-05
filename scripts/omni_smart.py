#!/usr/bin/env python3
"""옴니 스마트 제어 사이드카 — Tapo(TP-Link) 플러그·전구를 집 안 네트워크에서 직접 제어한다.

앱(네이티브 NSTask)이 한 번에 한 명령씩 부른다:
  omni_smart.py discover                 같은 LAN의 Tapo/Kasa 기기 검색 → 캐시(~/.omni/smart_devices.json)
  omni_smart.py states                   캐시된 기기 전부 현재 상태
  omni_smart.py state  '{"target":…}'    한 기기 상태
  omni_smart.py on|off|toggle '{"target":…}'
  omni_smart.py set    '{"target":…,"brightness":0-100,"color_temp":K,"hsv":[h,s,v]}'
  omni_smart.py forget                   캐시 삭제
target = 호스트(IP) / 기기 이름(부분 일치, 대소문자 무시) / 모델명
계정: ~/.omni/tapo.json {"username":…,"password":…} — 앱 패널에서 사용자가 직접 저장.
출력: JSON 한 줄 {"ok":bool, "devices":[…] | "device":{…}, "error":…, "hint":…}
"""
import asyncio
import json
import os
import sys
import time

SMART_DIR = os.environ.get("OMNI_SMART_DIR", os.path.expanduser("~/.omni"))   # 테스트 격리용
CREDS_PATH = os.path.join(SMART_DIR, "tapo.json")
CACHE_PATH = os.path.join(SMART_DIR, "smart_devices.json")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_creds():
    try:
        with open(CREDS_PATH) as f:
            d = json.load(f)
        if d.get("username") and d.get("password"):
            return d["username"], d["password"]
    except (OSError, ValueError):
        pass
    return None, None


def load_cache():
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cache(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    tmp = CACHE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, CACHE_PATH)


async def describe(dev):
    """Device → 패널/옴니가 쓰는 평평한 dict (상태 포함)."""
    from kasa import Module
    info = {
        "host": dev.host, "alias": dev.alias or "", "model": dev.model or "",
        "type": getattr(dev.device_type, "value", str(dev.device_type)),
        "on": bool(dev.is_on), "mac": dev.mac or "", "rssi": dev.rssi,
        "id": dev.device_id or "",
    }
    light = dev.modules.get(Module.Light)
    if light is not None:
        try:
            if light.has_feature("brightness"):
                info["brightness"] = light.brightness
        except Exception:
            pass
        try:
            if light.has_feature("color_temp"):
                info["color_temp"] = light.color_temp
                rng = light.valid_temperature_range
                info["color_temp_range"] = [rng.min, rng.max]
        except Exception:
            pass
        try:
            if light.has_feature("hsv"):
                h = light.hsv
                info["hsv"] = [h.hue, h.saturation, h.value]
        except Exception:
            pass
    energy = dev.modules.get(Module.Energy)
    if energy is not None:
        try:
            info["power_w"] = energy.current_consumption
            info["today_kwh"] = energy.consumption_today
        except Exception:
            pass
    return info


async def connect(entry, creds):
    from kasa import Device, DeviceConfig, Credentials
    cfg = DeviceConfig.from_dict(entry["config"])
    cfg.credentials = Credentials(*creds)
    cfg.timeout = 8
    dev = await Device.connect(config=cfg)
    await dev.update()
    return dev


def find_entry(cache, target):
    t = str(target or "").strip().lower()
    if not t:
        return None
    if t in cache:
        return cache[t]
    for host, e in cache.items():
        if (e.get("alias") or "").lower() == t:
            return e
    for host, e in cache.items():
        if t in (e.get("alias") or "").lower() or t in (e.get("model") or "").lower() or t == host:
            return e
    return None


TPAP_HINT = ("이 기기의 새 펌웨어는 새 암호화(TPAP)만 열어 두어 아직 로컬 접속이 안 됩니다 — "
             "Tapo 앱 > 나(Me) > Tapo Lab > 서드파티 호환(Third-Party Compatibility)을 켜면 예전 방식 접속이 허용됩니다. 켠 뒤 다시 SCAN")


def local_subnet_hosts():
    """기본 인터페이스의 /24 호스트 목록 (자기 IP 제외)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        ip = s.getsockname()[0]
    except OSError:
        return None, []
    finally:
        s.close()
    base = ip.rsplit(".", 1)[0]
    return ip, [f"{base}.{i}" for i in range(1, 255) if f"{base}.{i}" != ip]


def unsupported_info(host, e):
    dr = getattr(e, "discovery_result", None) or {}
    if hasattr(dr, "to_dict"):
        try:
            dr = dr.to_dict()
        except Exception:
            dr = {}
    if not isinstance(dr, dict):
        dr = {}
    enc = (dr.get("mgt_encrypt_schm") or {}).get("encrypt_type") or ""
    return {"host": host, "model": dr.get("device_model") or "", "type": dr.get("device_type") or "",
            "error": "UNSUPPORTED_TPAP" if "TPAP" in (enc + str(e)) else "UNSUPPORTED",
            "detail": str(e)[:160]}


async def probe_one(ip, creds, sem, discovery_timeout=2):
    """한 IP에 유니캐스트 검색 → (Device | None, 오류 dict | None)."""
    from kasa import Discover, Credentials
    from kasa.exceptions import UnsupportedDeviceError
    async with sem:
        try:
            dev = await Discover.discover_single(ip, credentials=Credentials(*creds),
                                                 discovery_timeout=discovery_timeout, timeout=8)
            return dev, None
        except UnsupportedDeviceError as e:
            return None, unsupported_info(ip, e)
        except Exception:
            return None, None


async def collect(dev, cache, devices, errors):
    from kasa.exceptions import AuthenticationError
    host = dev.host
    try:
        await dev.update()
        info = await describe(dev)
        cache[host] = {"host": host, "alias": info["alias"], "model": info["model"], "type": info["type"],
                       "id": info["id"], "config": dev.config.to_dict(), "seen": time.time()}
        devices.append(info)
    except AuthenticationError:
        errors.append({"host": host, "model": getattr(dev, "model", "") or "", "error": "AUTH_FAILED"})
    except Exception as e:
        errors.append({"host": host, "model": getattr(dev, "model", "") or "", "error": f"{type(e).__name__}: {e}"[:160]})
    finally:
        try:
            await dev.disconnect()
        except Exception:
            pass


def finish_discover(devices, errors, swept):
    res = {"ok": True, "devices": devices, "errors": errors, "swept": swept}
    if any(e["error"] == "UNSUPPORTED_TPAP" for e in errors):
        res["hint"] = TPAP_HINT
    elif any(e["error"] == "AUTH_FAILED" for e in errors):
        res["hint"] = ("기기는 보이는데 인증 실패 — Tapo 계정 이메일·비밀번호가 Tapo 앱 로그인과 같은지 확인. "
                       "그래도 안 되면 Tapo 앱 > 나 > Tapo Lab > 서드파티 호환 켜기")
    elif not devices and not errors:
        res["hint"] = ("기기를 찾지 못했습니다 — 플러그가 이 맥과 같은 공유기(와이파이)에 연결돼 있는지, "
                       "맥의 로컬 네트워크 권한(시스템 설정 > 개인정보 보호 및 보안 > 로컬 네트워크 > Omni OS)이 켜져 있는지 확인. "
                       "IP를 알면 SETUP의 'IP로 추가'로 직접 추가")
    return res


async def cmd_discover(creds):
    """브로드캐스트 검색 + 같은 /24 전체 유니캐스트 훑기(브로드캐스트에 응답 안 하는 기기 대비)."""
    from kasa import Discover, Credentials
    from kasa.exceptions import UnsupportedDeviceError
    cache = load_cache()
    devices, errors, seen = [], [], set()
    unsupported = []

    async def on_unsupported(e):          # 라이브러리가 코루틴을 요구
        unsupported.append(e)
    try:
        found = await Discover.discover(credentials=Credentials(*creds), discovery_timeout=5, timeout=8,
                                        on_unsupported=on_unsupported)
    except Exception:
        found = {}
    for host, dev in found.items():
        seen.add(host)
        await collect(dev, cache, devices, errors)
    for e in unsupported:
        info = unsupported_info(getattr(e, "host", "") or "", e)
        if info["host"]:
            seen.add(info["host"])
        errors.append(info)
    # 유니캐스트 훑기
    my_ip, hosts = local_subnet_hosts()
    swept = 0
    if hosts:
        sem = asyncio.Semaphore(64)
        results = await asyncio.gather(*(probe_one(ip, creds, sem) for ip in hosts if ip not in seen))
        swept = len(results)
        for dev, err in results:
            if dev is not None:
                await collect(dev, cache, devices, errors)
            elif err is not None and err["host"] not in seen:
                errors.append(err)
    save_cache(cache)
    return finish_discover(devices, errors, swept)


async def cmd_add(args, creds):
    """IP로 직접 추가 (브로드캐스트·훑기에 안 잡히는 경우)."""
    host = str(args.get("host") or "").strip()
    if not host:
        return {"ok": False, "error": "NO_HOST", "hint": "IP 주소가 필요합니다"}
    cache = load_cache()
    devices, errors = [], []
    dev, err = await probe_one(host, creds, asyncio.Semaphore(1), discovery_timeout=4)
    if dev is not None:
        await collect(dev, cache, devices, errors)
    elif err is not None:
        errors.append(err)
    else:
        errors.append({"host": host, "model": "", "error": "NO_RESPONSE"})
    save_cache(cache)
    res = finish_discover(devices, errors, 1)
    if not devices and not res.get("hint"):
        res["hint"] = f"{host}에서 Tapo 응답이 없습니다 — IP가 맞는지(Tapo 앱 > 기기 > 설정 > 기기 정보) 확인"
    return res


async def cmd_states(creds):
    cache = load_cache()
    if not cache:
        return {"ok": True, "devices": [], "hint": "캐시된 기기 없음 — SCAN 먼저"}

    async def one(entry):
        try:
            dev = await connect(entry, creds)
            try:
                return await describe(dev)
            finally:
                await dev.disconnect()
        except Exception as e:
            return {"host": entry["host"], "alias": entry.get("alias", ""), "model": entry.get("model", ""),
                    "type": entry.get("type", ""), "offline": True, "error": f"{type(e).__name__}"[:60]}
    devices = await asyncio.gather(*(one(e) for e in cache.values()))
    return {"ok": True, "devices": list(devices)}


async def cmd_device(cmd, args, creds):
    from kasa import Module
    cache = load_cache()
    entry = find_entry(cache, args.get("target"))
    if entry is None:
        return {"ok": False, "error": "NOT_FOUND", "hint": f"기기를 찾지 못함: {args.get('target')} — SCAN 후 이름(또는 IP)으로 지정",
                "known": [f"{e.get('alias')} ({e.get('model')}, {h})" for h, e in cache.items()]}
    dev = await connect(entry, creds)
    try:
        if cmd == "on":
            await dev.turn_on()
        elif cmd == "off":
            await dev.turn_off()
        elif cmd == "toggle":
            await (dev.turn_off() if dev.is_on else dev.turn_on())
        elif cmd == "set":
            light = dev.modules.get(Module.Light)
            if light is None:
                return {"ok": False, "error": "NOT_A_LIGHT", "hint": "밝기·색은 전구에서만 됩니다 (플러그는 켜기/끄기만)"}
            if args.get("brightness") is not None:
                await light.set_brightness(max(1, min(100, int(args["brightness"]))))
            if args.get("color_temp") is not None:
                await light.set_color_temp(int(args["color_temp"]))
            if args.get("hsv") is not None:
                h, s, v = args["hsv"]
                await light.set_hsv(int(h), int(s), int(v))
        if cmd != "state":
            await asyncio.sleep(0.3)
            await dev.update()
        return {"ok": True, "device": await describe(dev)}
    finally:
        await dev.disconnect()


async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "states"
    try:
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    except ValueError:
        args = {}
    if cmd == "forget":
        try:
            os.remove(CACHE_PATH)
        except OSError:
            pass
        return out({"ok": True})
    creds = load_creds()
    if creds[0] is None:
        return out({"ok": False, "error": "NO_CREDS",
                    "hint": "Tapo 계정(이메일·비밀번호)이 아직 저장되지 않았습니다 — SMART CONTROL 패널 SETUP에서 입력"})
    try:
        if cmd == "discover":
            out(await cmd_discover(creds))
        elif cmd == "add":
            out(await cmd_add(args, creds))
        elif cmd == "states":
            out(await cmd_states(creds))
        elif cmd in ("state", "on", "off", "toggle", "set"):
            out(await cmd_device(cmd, args, creds))
        else:
            out({"ok": False, "error": "UNKNOWN_CMD"})
    except Exception as e:
        name = type(e).__name__
        hint = ""
        if "Authentication" in name:
            hint = "Tapo 계정 이메일·비밀번호 확인 (Tapo 앱 로그인과 동일). 안 되면 Tapo 앱 > 나 > Tapo Lab > 서드파티 호환 켜기"
        elif "Timeout" in name or "Connection" in name:
            hint = "기기에 연결할 수 없음 — 같은 와이파이인지, 플러그 전원이 켜져 있는지 확인"
        out({"ok": False, "error": f"{name}: {e}"[:200], "hint": hint})


if __name__ == "__main__":
    asyncio.run(main())
