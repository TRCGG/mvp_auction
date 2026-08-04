# 다음 작업 (미구현 · 계획만)

정리일: 2026-08-04 · 배포 주소: https://live.lol-auction.workers.dev
아래 항목은 아직 **구현/배포 안 함**. 다음 세션에서 바로 실행할 수 있게 위치·방법을 적어둠.

## 구현 순서 (권장)

관련된 것끼리 묶어 한 번에 검토·배포:

**묶음 A — 명단/카드/정렬 손질 (한 번에, 서로 의존)**
1. **1번 등급 1~5** (먼저 — 5·6번이 등급 의미에 의존)
2. **6번 카드 색**(등급→티어 폴백 · tierColor 복원)
3. **2번 부포지션 표시** → **3번 부포 '전체/all'**
4. **5번 티어순·등급순 그룹핑** (등급 라벨이 1번에 의존)
→ A는 대부분 `public/index.html` 한 파일 + 서버 grade/sub 정규식 소폭. 로컬 검증 후 1회 배포.

**묶음 B — 모의경매 (별도, 큼)**
5. **4번 모의경매**(로컬 연습). 규모가 있어 A 배포 후 따로. 아래 4번의 확정 설계대로.

---

## 1. 등급 범위 0~4 → **1~5 (5.9까지)**

"1이 최상위" 로 바뀜. 색 5구간은 그대로(1.x=챌린저색 … 5.x=에메랄드색).

**바꿀 곳**
- `public/index.html:1184` `gnum` 정규식: `^([0-4](?:\.\d)?)` → `^([1-5](?:\.\d)?)`
- `src/index.js:558` 서버 grade 정규식: `^([0-4]...)` → `^([1-5]...)`
- `public/index.html:266` `gradeBand`: 색 인덱스가 0~4를 유지하도록 **floor-1** 로.
  현재 `Math.min(4,Math.max(0,Math.floor(n)))` → `Math.min(4,Math.max(0,Math.floor(n)-1))`
  (→ 등급 1.x→색0=챌린저, 5.x→색4=에메. `gradeBadge`는 숫자 `${g}`(1~5)를 그대로 표시하므로 OK)
- 안내/예시 문구:
  - `public/index.html:1116~1120` 직접입력 안내 "등급은 0~4…(0이 최상위)" → "1~5…(1이 최상위)", 예시 placeholder의 등급값(0.2·1.4)도 1~5로.
  - 엑셀 양식(`scratchpad/newtpl.py`): 상단 hint "등급은 0~4" → "1~5", 예시 2줄의 등급(0.2, 1.5) → 1~5 값으로. 재생성 후 `public/participant-template.xlsx` 복사.
  - 테스트 파일(`scratchpad/fill26new.py`): 26명 등급 0.0~4.5 → 1.0~5.9 범위로 재생성.
- (선택) `scratchpad/fixverify.cjs` 등급 케이스도 새 범위로.

**주의**: 유효 등급이 1~5라 0은 파서에서 거부됨. gradeBand의 "no grade" 가드는 그대로 두면 됨.

---

## 2. 남은 매물 카드에 **부포지션 표시**

현재 카드 아랫줄은 `주포 | 티어`. 여기에 부포지션을 붙임.

**바꿀 곳**
- `public/index.html` `poolPanel` 의 `chip()` 아랫줄(pc-bot, 약 560행):
  `<span class="pc-line">${p.line||'-'}…</span>` 에 부포지션을 이어 붙이기.
  예: `${p.line||'-'}${p.sub?`<span class="pc-sub">/${subLabel(p.sub)}</span>`:''}`
- CSS: `.pc-sub{color:var(--muted);font-weight:400;font-size:10px}` 추가(약 192행 pc-bot 근처).
- `subLabel(s)`: `s==='ALL' ? '전체' : s` (아래 3번과 연동).

---

## 3. 부포지션에 **'전체 / all'** 입력 허용

부포지션 칸에 `전체` 또는 `all` 을 넣으면 "모든 포지션 가능"(값 `ALL`)으로 인식. **표시용**(현재 경매 로직은 포지션 슬롯을 안 씀 → 정보 표시만. 나중에 A-1 포지션 슬롯 구현 시 의미 생김).

**바꿀 곳**
- `public/index.html:1172~1181` 포지션 정규화:
  - 메인 포지션(`line`)은 **5라인만** 유지(ALL 불가).
  - 부포지션 전용 `normSub(v)` 추가: `const t=String(v).trim(); if(/^(전체|all|올|올포|올라인)$/i.test(t)) return 'ALL'; return norm(v);`
  - `readSheet`(약 1220행) `sub:norm(at('sub'))` → `sub:normSub(at('sub'))`
  - `addText`(약 1269행) `sub:norm(p[4])` → `sub:normSub(p[4])`
- 서버 `src/index.js:554` sub 검증: `LINES.includes(p.sub) ? p.sub : ''`
  → `(LINES.includes(p.sub) || p.sub==='ALL') ? p.sub : ''`
- 표시:
  - 매물 카드(2번 subLabel에서 'ALL'→'전체')
  - 현재 경매 중 선수 카드 `src/index.html:456` `부 ${p.sub}` → `부 ${p.sub==='ALL'?'전체':p.sub}`
  - 설정 명단 미리보기(약 1287행 `${p.sub?p.sub+' · ':''}`)도 동일 처리
- 안내/양식: 부포지션 설명에 "'전체' 가능" 한 줄 추가(직접입력 안내 + 엑셀 hint).

---

## 4. 모의경매(연습) 기능

목적: 실전 전에 팀장·진행자가 흐름을 연습(자낳대 "감독 모의경매"). 결과는 안 남고 부담 없이.

### 확정 흐름 (사용자 요청)
설정 화면에서 **명단·팀장·규칙을 다 채운 뒤** →
1. **"모의경매 해보기"** 버튼(설정 화면, "경매방 만들기" 옆) 누름
2. 방금 입력한 데이터로 **브라우저 안에서** 경매를 연습(진행자로 직접 상정·입찰·낙찰·유찰·되돌리기·배정)
3. **"모의경매 끝내기"** 누르면 → **설정 화면으로 복귀**(입력한 명단·팀장·규칙 그대로 보존 → 이어서 진짜 방 생성 가능)

### 구현 방식: **클라이언트 로컬 시뮬** (서버·코드·비용 0, 남용 0)
서버 방을 만들지 않고 브라우저에서만 상태를 굴림. 실제 경매 화면(paint/stage/lotBody/poolPanel/teamCard/bidControls)을 **그대로 재사용**하되, `send()`가 서버로 안 가고 **로컬 규칙 엔진**으로 처리.

- **로컬 모드 플래그**: `let mock=null;`(로컬 S 보관). `send(t,extra)`를 분기 — `mock`이면 서버 WS 대신 `mockHandle(t,extra)` 호출 후 `paint()`.
- **mockHandle**: 서버 `webSocketMessage`의 핵심을 클라에 축약 복제 —
  상정(`lot`: 대기/유찰 중 택1, deadline 세팅), 입찰(`bid`), 즉시낙찰(`sell`)/유찰(`pass`)/자동낙찰(타이머), 일시정지/재개, 되돌리기(로컬 스냅샷 스택), 배정(`assign`).
  파생값(teams[].open/cap/live, minNext, now)도 서버 `view()`처럼 로컬에서 계산해 붙여야 기존 렌더가 동작.
- **혼자 입찰**: 로컬이라 진행자가 **아무 팀으로나 입찰**할 수 있게(팀 선택 후 금액) — 혼자서도 눈치싸움 흉내. (또는 옵션으로 봇 자동입찰)
- **초기 S 만들기**: 설정 화면의 `players`·`leaders`·규칙으로 서버 `init`과 동일한 S 구조를 로컬 생성(코드는 "MOCK" 등 더미).
- **끝내기**: `mock=null` → `renderSetup(setupMode)` 로 복귀(players/leaders 전역이 남아있으니 그대로 보임).
- **화면 표시**: topbar에 "모의경매" 배지 + "모의경매 끝내기" 버튼.

**바꿀 곳(개략)**
- `renderSetup`(설정 화면): "경매방 만들기" 옆에 **모의경매 해보기** 버튼 + 핸들러(로컬 S 만들고 `mock` 세팅 후 `paint()`).
- `send()`(약 335행): `if(mock){ mockHandle(t,extra); return; }` 분기.
- 신규 `mockHandle`·`mockInit`·`mockView`(서버 로직 축약 복제) + 로컬 타이머(자동 낙찰).
- topbar/끝내기 버튼: `mock`이면 표시.

**장점**: 서버 비용·남용 0, 즉시, 입력 데이터 그대로 연습. **단점/주의**: 서버 규칙을 클라에 **일부 복제**(유지보수 이중화) — 규칙 바뀌면 양쪽 손봐야 함. 완벽 동일할 필요는 없음(연습용). **결정 남은 것**: 봇 자동입찰 넣을지(없이 진행자 수동 입찰만으로도 충분).

(참고: "여러 명이 함께 실전 리허설"이 필요해지면 별도로 서버 practice 방(설정 토글+짧은 TTL+매니저 한도 제외)도 가능. 지금 요청은 혼자 로컬 연습이라 위로 충분.)

---

## 5. 남은 매물 정렬: 티어순·등급순을 **포지션처럼 그룹핑**

지금 `poolView`는 순서/포지션(그룹)/티어순(평평한 정렬). 요청:
- **티어순도 포지션처럼 그룹**(챌린저 / 그마 / 마스터 … 헤더로 묶어서)
- **등급순 추가**(등급 구간별 그룹: 1티어 / 2티어 … , 1번 항목의 1~5 반영)

**바꿀 곳** (`public/index.html` poolPanel, 약 571~592행)
- 그룹 렌더를 공용화: `const renderGroups=groups=>{ const shown=groups.filter(([,a])=>a.length); return shown.length?shown.map(([label,a])=>`<div class="pgroup">${label} · ${a.length}</div>${poolDiv(a)}`).join(''):'<span class="hint">남은 매물이 없습니다</span>'; };`
- **포지션**(기존): `renderGroups(LINES.map(l=>[l,rem.filter(p=>p.line===l)]).concat([['미지정',rem.filter(p=>!p.line)]]))`
- **티어순**(평평→그룹): TIERS 순서(상위→하위)로 묶기.
  ```
  const tierName=i=>TIERS[i].k[0];               // '챌린저','그랜드마스터','마스터'…
  const tgroups=TIERS.map((_,i)=>[tierName(i), rem.filter(p=>tierIdx(p.tier)===i)
                 .sort((a,b)=>tierRank(b.tier)-tierRank(a.tier))])   // 그룹 내 LP/단수 정렬
                 .concat([['미분류', rem.filter(p=>tierIdx(p.tier)<0)]]);
  body=renderGroups(tgroups);
  ```
- **등급순**(신규): `gradeBand`(1번에서 floor-1로 바뀜) 대신 실제 등급 정수(1~5)로 묶는 게 헤더가 자연스러움. 헬퍼 하나 두기: `const gInt=g=>{const n=Number(g);return (g==null||g===''||!Number.isFinite(n))?-1:Math.floor(n);};`
  ```
  const bands=[1,2,3,4,5];                        // (1번 반영 후. 현재는 0~4)
  const ggroups=bands.map(b=>[`${b}티어`, rem.filter(p=>gInt(p.grade)===b)
                 .sort((a,b)=>(a.grade??9)-(b.grade??9))])
                 .concat([['등급 미정', rem.filter(p=>gInt(p.grade)<0)]]);
  body=renderGroups(ggroups);
  ```
- **토글 버튼**(588~591행)에 `등급순` 추가: `<button id="pv-grade" data-pv="grade" …>등급순</button>` (wire의 `[data-pv]` 핸들러가 값 그대로 poolView에 넣으므로 추가 배선 불필요; focus 복원용 `id="pv-grade"`만 맞추면 됨).
- 드래그 배정은 chip 그대로라 그룹 뷰에서도 동작.

**주의**: 등급순 헤더 라벨(1~5티어)은 **1번(등급 1~5)** 을 먼저/함께 반영해야 자연스러움.

---

## 6. 카드 색: **등급 우선, 없으면 티어 색**

지금 남은 매물 카드 테두리는 `등급색 || 무채색`. 요청: 등급 있으면 등급색, **없으면 그 선수의 (솔랭) 티어 색**, 둘 다 없으면 무채색.

**주의**: 이전 리뷰 정리 때 `tierColor`와 TIERS의 `c:`(색)를 "죽은 코드"라며 **지웠음** → 되살려야 함.

**바꿀 곳** (`public/index.html`)
- TIERS(약 233~242행)에 색 `c:` 재추가(원래 값):
  챌 `#e6c14a` · 그마 `#e0554f` · 마스터 `#b06fe0` · 다이아 `#4aa3e0` · 에메 `#2fae5f` · 플래 `#3fb6a6` · 골드 `#e0b04a` · 실버 `#9fb0c0` · 브론즈 `#b07b4a` · 아이언 `#8a8f96`
- `tierColor` 헬퍼 재추가(약 249행): `const tierColor=t=>{ const i=tierIdx(t); return i<0?'':TIERS[i].c; };`
- 카드 테두리(chip의 `bst`, 약 562행): `border-color:${gradeColor(p.grade) || tierColor(p.tier) || 'var(--line)'}`
- (선택) 카드 `pc-gr`/`pc-tier` 텍스트 색도 같은 규칙으로 맞추면 일관. 최소는 테두리만.

**참고(의도된 겹침)**: 등급색 5개(챌~에메)와 상위 티어색이 같은 팔레트라, "등급 3=마스터색(보라)"과 "무등급 마스터 티어=보라"가 같은 색이 될 수 있음 — 사용자가 요청한 우선순위(등급>>티어)라 OK.

---

## 마무리 절차 (구현 후)
1. 로컬 유닛/파싱 검증 (`scratchpad`의 verify 스크립트 재활용) — 등급 1~5, 부포 ALL, 카드 렌더.
2. `node --check` 서버·클라 문법.
3. `npx wrangler deploy` → 전파 확인.
4. 엑셀 양식·26명 테스트 파일 재생성 확인.

## 참고: 관리자 비밀번호
워커 이름을 `live`로 바꾼 뒤 새 워커라, 관리자 로그인 전에 한 번:
`npx wrangler secret put ADMIN_PASSWORD`
