#!/usr/bin/env python3
"""응답 여부 판사(judgeAddressed) 정확도 평가 — app.js의 시스템 프롬프트를 그대로 써서
라벨된 발화 세트를 Haiku에 묻고 정답률을 낸다. (실행: python3 scripts/tests/judge_eval.py)"""
import json, os, re, ssl, sys, urllib.request, concurrent.futures
import certifi

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
src = open(os.path.join(REPO, "app.js"), encoding="utf-8").read()
m = re.search(r'system: "(당신은 상시 대기 중인 음성 비서 \'옴니\'의 판단 모듈이다\.[^\n]*?)",\n', src)
SYSTEM = json.loads('"' + m.group(1) + '"')
KEY = open(os.path.expanduser("~/.omni/anthropic.key")).read().strip()
CTX = ssl.create_default_context(cafile=certifi.where())

def judge(text, facts, last_omni="(없음)", last_user="(없음)"):
    body = json.dumps({"model": "claude-haiku-4-5-20251001", "max_tokens": 200, "system": SYSTEM,
        "messages": [{"role": "user", "content": f"[신호]\n{facts}\n\n[옴니의 직전 말] {last_omni}\n[건희의 직전 말] {last_user}\n\n[지금 들린 발화] {text}"}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        res = json.load(r)
    txt = "".join(b.get("text", "") for b in res["content"] if b.get("type") == "text")
    mm = re.search(r"\{[\s\S]*\}", txt)
    if mm:
        try:
            return json.loads(mm.group(0))
        except ValueError:
            pass
    r1 = re.search(r'"respond"\s*:\s*(true|false)', txt); k1 = re.search(r'"kind"\s*:\s*"([a-z_]+)"', txt)
    return {"respond": (r1.group(1) == "true") if r1 else None, "kind": k1.group(1) if k1 else "?", "why": "(잘림)"}

USER = "화자 판정: 건희 본인(확실)\n카메라: 얼굴 1명, 입 움직임과 음성 동기 0.72 (0.3 이상이면 화면 앞 사람이 말하는 중)\n목소리 유사도 0.86 (임계 0.7), 노트북 재생음 상관 0.05\n"
TWO = "화자 판정: 건희 본인(확실)\n카메라: 얼굴 2명 (다른 사람이 곁에 있음), 입 움직임과 음성 동기 0.66 (0.3 이상이면 화면 앞 사람이 말하는 중)\n목소리 유사도 0.84 (임계 0.7), 노트북 재생음 상관 0.02\n"
UNC = "화자 판정: 건희일 가능성 있음(불확실)\n카메라: 얼굴 미검출(자리 비움/가려짐)\n목소리 유사도 0.66 (임계 0.7), 노트북 재생음 상관 0.1\n"
def F(base, secs, sit="건희는 책상에서 작업 중"):
    return base + (f"옴니가 마지막으로 말을 마친 지 {secs}초" if secs is not None else "옴니가 이 세션에서 아직 말한 적 없음") + f"\n현재 상황 추정: {sit}"

CASES = [
    # (발화, 신호, 직전 옴니 말, 직전 건희 말, 기대 respond)
    ("노트 패널 좀 열어줘", F(USER, None), "(없음)", "(없음)", True),
    ("지금 몇 시야?", F(USER, None), "(없음)", "(없음)", True),
    ("내일 오후 3시에 치과 예약 잡아줘", F(USER, 400), "(없음)", "(없음)", True),
    ("아 배고프다 뭐 먹지", F(USER, None), "(없음)", "(없음)", False),
    ("어디 뒀더라 아 여기 있네", F(USER, None), "(없음)", "(없음)", False),
    ("그래서 어제 걔가 뭐라고 했냐면", F(TWO, None, "건희가 친구와 대화 중인 듯"), "(없음)", "(없음)", False),
    ("엄마 나 밥 먹고 갈게", F(TWO, None), "(없음)", "(없음)", False),
    ("응 알겠어 고마워", F(USER, 3), "내일 미술 수업은 오후 2시 20분에 끝납니다.", "미술 수업 언제 끝나?", True),
    ("그 다음 일정은?", F(USER, 6), "내일 미술 수업은 오후 2시 20분에 끝납니다.", "미술 수업 언제 끝나?", True),
    ("근데 거기 패널에서 아이디어라고 된 빈 파일은 그냥 지워줘", F(USER, 25), "노트 패널을 열었습니다.", "옴니야 노트 패널 열어줘", True),
    ("야 이거 봤어? 진짜 웃기더라", F(TWO, 5, "건희가 친구와 유튜브를 보는 중인 듯"), "노트 패널을 열었습니다.", "노트 패널 열어줘", False),
    ("토니는 자신이 저지른 일을 바로잡겠다는 마음으로", F(UNC, None, "건희는 유튜브로 어벤저스 영상을 보는 중"), "(없음)", "(없음)", False),
    ("오늘 날씨 어때", F(USER, None), "(없음)", "(없음)", True),
    ("달러 환율 얼마야", F(USER, 120), "(없음)", "(없음)", True),
    ("여보세요 네 접니다 아 네네", F(USER, None, "건희가 전화 통화 중인 듯"), "(없음)", "(없음)", False),
    ("음 그러니까 이걸 이렇게 하면 되나", F(USER, None), "(없음)", "(없음)", False),
    ("카톡 온 거 있어?", F(USER, None), "(없음)", "(없음)", True),
    ("아니 그거 말고 뉴스 말한 거야", F(USER, 4), "오늘 날씨는 맑고 29도입니다.", "오늘 뭐 있어?", True),
    ("하하 진짜 웃기다", F(USER, None, "건희는 유튜브 예능을 보는 중"), "(없음)", "(없음)", False),
    ("옴니 너는 어떻게 생각해?", F(USER, 30), "(없음)", "(없음)", True),
    ("계산 좀 해줘 삼십칠 곱하기 사십팔", F(USER, None), "(없음)", "(없음)", True),
    ("잠깐만 이따 다시 얘기하자", F(TWO, 2, "건희 옆에 친구가 있음"), "네, 뉴스 헤드라인을 읽어드릴까요?", "뉴스 뭐 있어", None),  # 애매 — 채점 제외
    ("이 영상 나중에 다시 봐야겠다", F(USER, None, "건희는 유튜브 강의를 보는 중"), "(없음)", "(없음)", False),
    ("그거 기억해둬 내일 회의 자료 준비해야 돼", F(USER, None), "(없음)", "(없음)", True),
    ("Subscribe and hit the bell icon", F(UNC, None, "건희는 유튜브를 보는 중"), "(없음)", "(없음)", False),
    ("어 잠깐 그거 맞나", F(USER, 8), "환율은 1달러에 1361원입니다.", "달러 환율", None),  # 애매 — 채점 제외
]

def run(c):
    text, facts, lo, lu, exp = c
    try:
        r = judge(text, facts, lo, lu)
    except Exception as e:
        r = {"respond": None, "kind": f"ERR {e}"}
    return c, r

ok = tot = 0
with concurrent.futures.ThreadPoolExecutor(6) as ex:
    for c, r in ex.map(run, CASES):
        text, facts, lo, lu, exp = c
        got = r.get("respond")
        mark = "  --  " if exp is None else ("PASS" if got == exp else "FAIL")
        if exp is not None:
            tot += 1; ok += (got == exp)
        print(f"{mark} {'응답' if got else '경청'} [{r.get('kind')}] {text[:34]:36s} {('' if exp is None else '(기대 ' + ('응답' if exp else '경청') + ')')}  {r.get('why','')[:40]}")
print(f"\n정확도 {ok}/{tot}")
