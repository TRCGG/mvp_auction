/* 랜랜내 챔피언 데이터 만들기 — 갱신 스크립트(scripts/update-randpick.mjs)와
   사이트 서버(Registry의 2주 자동 갱신·관리자 '지금 갱신')가 같이 씁니다.

   라인별 픽률: lol.ps 티어 리스트(한국 서버, 에메랄드 이상, 최신 패치).
     lol.ps는 그 라인 픽률 0.5% 이상인 챔피언만 목록에 올리므로 받은 그대로가 '기본(0.5%)' 범위입니다.
     '메타픽(1.0%)'은 같은 숫자에서 걸러 씁니다(src/randpick.js).
   챔피언 이름·그림: 라이엇 공식 Data Dragon(ko_KR).

   lol.ps는 공개 API가 없어 페이지에 실려 오는 데이터를 읽습니다. 사이트 구조가 바뀌면
   아래 검사에서 이유와 함께 실패하고, 사이트는 직전 데이터를 계속 씁니다. */

export const DATA_LANES = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];   // lol.ps laneId 0~4 순서
const LANE_MIN = 20;          // 라인마다 이보다 적게 읽히면 잘못 읽은 것으로 봅니다
const UA = { 'user-agent': 'Mozilla/5.0 (lol-auction randpick updater)' };

export async function buildRandpickData(fetchFn = fetch) {
  let res;
  try { res = await fetchFn('https://lol.ps/statistics?region=0&tier=2', { headers: UA }); }
  catch { throw new Error('lol.ps에 연결하지 못했습니다'); }
  if (!res.ok) throw new Error(`lol.ps가 요청을 거절했습니다 (HTTP ${res.status})`);
  const html = await res.text();
  const start = html.indexOf('tierlist:[');
  if (start < 0) throw new Error('lol.ps 페이지에서 티어 리스트를 찾지 못했습니다 (사이트 구조가 바뀌었을 수 있습니다)');

  // 기준 확인: 한국 · 에메랄드+가 선택된 화면인지
  const selected = [...html.matchAll(/<option[^>]*value="\d+"[^>]*selected[^>]*>([^<]*)/g)].map(m => m[1].trim());
  if (!selected.some(s => /에메랄드/.test(s)) || !selected.some(s => /한국/.test(s))) {
    throw new Error('lol.ps 기준이 한국·에메랄드 이상이 아닙니다: ' + selected.join(', '));
  }
  const patch = (selected.find(s => /패치/.test(s)) || '').replace(/\s*패치/, '');

  const rows = [];
  for (const m of html.slice(start).matchAll(/\{count:\d+,pickRate:"([\d.]+)".*?championId:(\d+),laneId:([0-4])/g)) {
    rows.push({ pick: +m[1], key: m[2], lane: DATA_LANES[+m[3]] });
  }

  let ver, dd;
  try {
    ver = (await (await fetchFn('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    dd = (await (await fetchFn(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/ko_KR/champion.json`)).json()).data;
  } catch { throw new Error('라이엇 Data Dragon에서 챔피언 목록을 받지 못했습니다'); }

  // 이름표는 전 챔피언을 담습니다. 픽률이 떨어져 목록에서 빠진 챔피언도
  // 이미 진행 중인 방·피어리스 기록에서 이름이 보여야 하기 때문입니다.
  const champs = {};
  for (const c of Object.values(dd)) champs[c.key] = { id: c.id, name: c.name };
  const lanes = Object.fromEntries(DATA_LANES.map(l => [l, []]));
  const seen = new Set();
  for (const r of rows) {
    const id = r.lane + ':' + r.key;
    if (seen.has(id) || !champs[r.key]) continue;   // 중복 줄·Data Dragon에 아직 없는 신챔프는 건너뜀
    seen.add(id);
    lanes[r.lane].push([+r.key, r.pick]);
  }
  for (const l of DATA_LANES) lanes[l].sort((a, b) => b[1] - a[1]);

  const data = {
    patch, ddragon: ver,
    source: 'lol.ps 한국 서버 · 에메랄드 이상',
    updated: new Date().toISOString().slice(0, 10),
    champs, lanes
  };
  const err = checkRandpickData(data);
  if (err) throw new Error(err);
  return data;
}

/** 데이터 모양 검사. 자동 갱신·파일 올리기 모두 이 검사를 통과해야 바뀝니다. */
export function checkRandpickData(d) {
  if (!d || typeof d !== 'object') return '데이터가 비어 있습니다';
  if (typeof d.patch !== 'string' || !d.patch) return '패치 정보가 없습니다';
  if (typeof d.ddragon !== 'string' || !/^\d+\.\d+\.\d+$/.test(d.ddragon)) return 'Data Dragon 버전이 올바르지 않습니다';
  if (!d.champs || typeof d.champs !== 'object') return '챔피언 이름표가 없습니다';
  for (const [k, c] of Object.entries(d.champs)) {
    if (!/^\d+$/.test(k) || !c || typeof c.id !== 'string' || !/^[A-Za-z0-9]+$/.test(c.id) || typeof c.name !== 'string') {
      return '챔피언 이름표 형식이 올바르지 않습니다';
    }
  }
  if (!d.lanes || typeof d.lanes !== 'object') return '라인별 목록이 없습니다';
  for (const l of DATA_LANES) {
    const xs = d.lanes[l];
    if (!Array.isArray(xs)) return `${l} 목록이 없습니다`;
    if (!xs.every(x => Array.isArray(x) && Number.isInteger(x[0]) && typeof x[1] === 'number' && d.champs[x[0]])) {
      return `${l} 목록 형식이 올바르지 않습니다`;
    }
    if (new Set(xs.map(x => x[0])).size !== xs.length) return `${l} 목록에 같은 챔피언이 두 번 있습니다`;
    if (xs.filter(x => x[1] >= 0.5).length < LANE_MIN) return `${l}에서 읽은 챔피언이 너무 적습니다 (${xs.length}명)`;
  }
  return null;
}
