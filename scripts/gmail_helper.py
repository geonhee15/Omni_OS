#!/usr/bin/env python3
"""Gmail IMAP 리더 — NOTIFICATIONS 패널의 GMAIL 섹션용.

macOS 알림에 의존하지 않고 받은편지함을 직접 읽는다 (읽기 전용 —
SELECT readonly라 읽음 표시 등 어떤 변경도 만들지 않음).

인증: ~/.omni/gmail.key (0600) — 계정당 한 줄 "이메일 앱비밀번호"
(구버전 2행 형식 — 1행 이메일 / 2행 비밀번호 — 도 인식)
사용: gmail_helper.py <creds_path> <hours>
출력: JSON 한 줄 {ok, items:[{ts, from, subject, unread, account}]} 또는 {ok:false, error}
"""
import email
import email.header
import email.utils
import imaplib
import json
import sys
import time


def decode_header(raw):
    if raw is None:
        return ""
    parts = email.header.decode_header(raw)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", "replace"))
            except LookupError:
                out.append(text.decode("utf-8", "replace"))
        else:
            out.append(text)
    return "".join(out).strip()


def parse_accounts(creds_path):
    with open(creds_path) as f:
        lines = [l.strip() for l in f.read().splitlines() if l.strip()]
    accounts = []
    # 구버전 2행 형식: 1행에 공백 없는 이메일, 2행 비밀번호
    if len(lines) == 2 and " " not in lines[0] and "@" in lines[0] and "@" not in lines[1]:
        accounts.append((lines[0], lines[1].replace(" ", "")))
        return accounts
    for line in lines:
        parts = line.split(None, 1)
        if len(parts) == 2 and "@" in parts[0]:
            accounts.append((parts[0], parts[1].replace(" ", "")))
    return accounts


def fetch_account(addr, app_pw, hours):
    imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    imap.login(addr, app_pw)
    imap.select("INBOX", readonly=True)  # 읽기 전용 — 플래그 변경 없음
    since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - hours * 3600))
    ok, data = imap.search(None, f"(SINCE {since})")
    ids = data[0].split() if ok == "OK" else []
    items = []
    label = addr.split("@")[0]
    for mid in ids[-50:][::-1]:  # 최신 50개, 최신 먼저
        ok, msg_data = imap.fetch(
            mid, "(FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if ok != "OK" or not msg_data or msg_data[0] is None:
            continue
        meta = b""
        header_bytes = b""
        for part in msg_data:
            if isinstance(part, tuple):
                meta = part[0]
                header_bytes = part[1]
            elif isinstance(part, bytes):
                meta += part
        msg = email.message_from_bytes(header_bytes)
        frm = decode_header(msg.get("From"))
        name, mail_addr = email.utils.parseaddr(frm)
        subject = decode_header(msg.get("Subject")) or "(제목 없음)"
        try:
            ts = email.utils.mktime_tz(email.utils.parsedate_tz(msg.get("Date")))
        except Exception:
            ts = time.time()
        items.append({
            "ts": ts,
            "from": name or mail_addr or frm,
            "subject": subject,
            "unread": b"\\Seen" not in meta,
            "account": label,
        })
    imap.logout()
    return items


def main():
    creds_path, hours = sys.argv[1], float(sys.argv[2])
    try:
        accounts = parse_accounts(creds_path)
    except Exception:
        accounts = []
    if not accounts:
        print(json.dumps({"ok": False, "error": "NEED_SETUP"}))
        return

    items = []
    errors = []
    for addr, app_pw in accounts:
        try:
            items.extend(fetch_account(addr, app_pw, hours))
        except imaplib.IMAP4.error as e:
            msg = str(e)
            errors.append(f"{addr.split('@')[0]}: "
                          + ("AUTH_FAILED" if "AUTHENTICATIONFAILED" in msg.upper()
                             else msg[:80]))
        except Exception as e:
            errors.append(f"{addr.split('@')[0]}: {str(e)[:80]}")

    if not items and errors:
        err = errors[0]
        if "AUTH_FAILED" in err and len(errors) == len(accounts):
            err = "AUTH_FAILED"
        print(json.dumps({"ok": False, "error": err}))
        return
    items.sort(key=lambda x: -x["ts"])
    print(json.dumps({"ok": True, "items": items[:80],
                      "warnings": errors}))


if __name__ == "__main__":
    main()
