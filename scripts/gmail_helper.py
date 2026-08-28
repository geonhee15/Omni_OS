#!/usr/bin/env python3
"""Gmail IMAP 리더 — NOTIFICATIONS 패널의 GMAIL 섹션용.

macOS 알림에 의존하지 않고 받은편지함을 직접 읽는다 (읽기 전용 —
SELECT readonly라 읽음 표시 등 어떤 변경도 만들지 않음).

인증: ~/.omni/gmail.key (1행 이메일, 2행 Google 앱 비밀번호, 0600)
사용: gmail_helper.py <creds_path> <hours>
출력: JSON 한 줄 {ok, items:[{ts, from, subject, unread}]} 또는 {ok:false, error}
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


def main():
    creds_path, hours = sys.argv[1], float(sys.argv[2])
    try:
        with open(creds_path) as f:
            lines = [l.strip() for l in f.read().splitlines() if l.strip()]
        addr, app_pw = lines[0], lines[1]
    except Exception:
        print(json.dumps({"ok": False, "error": "NEED_SETUP"}))
        return

    try:
        imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        imap.login(addr, app_pw)
        imap.select("INBOX", readonly=True)  # 읽기 전용 — 플래그 변경 없음
        since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - hours * 3600))
        ok, data = imap.search(None, f"(SINCE {since})")
        ids = data[0].split() if ok == "OK" else []
        items = []
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
            date_hdr = msg.get("Date")
            try:
                ts = email.utils.mktime_tz(email.utils.parsedate_tz(date_hdr))
            except Exception:
                ts = time.time()
            unread = b"\\Seen" not in meta
            items.append({
                "ts": ts,
                "from": name or mail_addr or frm,
                "subject": subject,
                "unread": unread,
            })
        imap.logout()
        print(json.dumps({"ok": True, "items": items}))
    except imaplib.IMAP4.error as e:
        msg = str(e)
        err = "AUTH_FAILED" if "AUTHENTICATIONFAILED" in msg.upper() else msg[:150]
        print(json.dumps({"ok": False, "error": err}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:150]}))


if __name__ == "__main__":
    main()
