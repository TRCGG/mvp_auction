/* ══════════════════════════════════════════════════════
   랜랜내(랜덤랜덤내전): 라인마다 양쪽 챔피언을 슬롯머신처럼 무작위로 뽑습니다.

   결과는 전부 서버가 정합니다. 클라이언트는 셀에 적힌 시작·정지 시각(at·stops)에 맞춰
   슬롯을 돌리다 정해진 챔피언에서 멈추는 연출만 합니다. 그래서 진행자 화면과 관전 화면이
   같은 순간에 같은 챔피언에서 멈추고, 중간에 들어온 사람도 같은 위치를 봅니다.

   게임 상태 S.game
     n      몇 판째
     lane   다음에 돌릴 라인 순번(0~4, 5면 이번 판 끝)
     auto   '남은 라인 한 번에'를 3개 중 고르기에서 눌렀을 때: 고를 때마다 다음 라인을 이어서 돌림
     busy   이 시각까지는 슬롯이 돌고 있어 다른 조작을 받지 않음
     rl     [왼쪽, 오른쪽] 남은 리롤
     cells  { TOP: [왼쪽 칸, 오른쪽 칸], ... }
            칸 = { c: 확정 챔피언 키, cand: 3개 중 고르기 후보, at: 시작, stops: 슬롯별 정지 시각, v: 돌린 횟수 }
   ══════════════════════════════════════════════════════ */
import DATA from './randpick-data.json';

// 기본값: 배포에 들어 있는 데이터. 사이트가 2주마다(또는 관리자가) 새로 받은 데이터가 있으면
// Registry에 저장된 그것을 쓰고, 없거나 문제가 있으면 언제나 이 기본값으로 돌아갑니다.
export const RR_DEFAULT = DATA;
let CUR = DATA;   // 지금 처리 중인 요청이 쓰는 데이터(rrAction이 동기라 요청 사이에 섞이지 않습니다)
export const RR_LANES = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];
const RANGE = { base: 0.5, meta: 1.0 };   // 그 라인 픽률(%) 하한
const REROLL_MAX = 5;

// 연출 시간(ms). 화면(public/index.html)의 슬롯 감속 곡선이 이 길이를 그대로 씁니다.
const LEAD = 150;        // 누르고 나서 돌기 시작할 때까지
const SPIN = 2600;       // 왼쪽 첫 슬롯이 멈출 때까지
const REEL_GAP = 350;    // 3개 중 고르기: 같은 쪽 슬롯끼리 멈추는 간격
const SIDE_GAP = 700;    // 왼쪽이 다 멈춘 뒤 오른쪽이 멈출 때까지
const LANE_GAP = 500;    // '남은 라인 한 번에': 앞 라인이 다 멈춘 뒤 다음 라인 시작까지
const AUTO_GAP = 600;    // 3개 중 고르기 + 한 번에: 양쪽 다 고른 뒤 다음 라인 시작까지

/* 무작위는 crypto로 뽑습니다(Math.random은 예측 가능). 나머지 편향을 없애려 범위 밖 값은 다시 뽑습니다. */
function randInt(n) {
  const lim = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return a[0] % n;
}
function shuffle(xs) {
  for (let i = xs.length - 1; i > 0; i--) { const j = randInt(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs;
}

export function rrValidate(cfg) {
  const r = cfg.rr;
  if (!r || typeof r !== 'object') return '랜랜내 설정이 비어 있습니다';
  if (!Object.prototype.hasOwnProperty.call(RANGE, r.range)) return '챔피언 범위가 올바르지 않습니다';
  if (typeof r.dup !== 'boolean') return '중복 모드가 올바르지 않습니다';
  if (r.pick !== 'one' && r.pick !== 'three') return '뽑기 방식이 올바르지 않습니다';
  if (!Number.isInteger(r.rerolls) || r.rerolls < 0 || r.rerolls > REROLL_MAX) return `리롤은 0~${REROLL_MAX}회입니다`;
  if (typeof r.fearless !== 'boolean') return '피어리스 설정이 올바르지 않습니다';
  return null;
}
const pickCfg = r => ({ range: r.range, dup: r.dup, pick: r.pick, rerolls: r.rerolls, fearless: r.fearless });

const emptyCell = () => ({ c: null, cand: null, at: 0, stops: [], v: 0 });
function newGame(n, cfg) {
  return {
    n, lane: 0, auto: false, busy: 0, rl: [cfg.rerolls, cfg.rerolls],
    cells: Object.fromEntries(RR_LANES.map(l => [l, [emptyCell(), emptyCell()]]))
  };
}

/** 새 랜랜내 방의 상태. 경매용 필드(teams·pool·log)는 공용 코드가 읽어도 터지지 않게 빈 값으로 둡니다. */
export function rrInitState(code, cfg, title, group, data = DATA) {
  const rr = pickCfg(cfg.rr);
  return {
    code, mode: 'random', title, group, rr,
    game: newGame(1, rr), used: [],
    patch: data.patch,
    teams: [], pool: [], log: [],
    phase: 'ready', createdAt: Date.now()
  };
}

const cellsOf = g => RR_LANES.flatMap(l => g.cells[l]);
const untouched = g => cellsOf(g).every(c => !c.v);
const complete = g => cellsOf(g).every(c => c.c != null);
export const rrConfirmed = g => cellsOf(g).filter(c => c.c != null).length;

/** 이 칸에서 뽑을 수 없는 챔피언 */
function excluded(S, lane, side) {
  const g = S.game, out = new Set();
  const add = cell => { if (cell.c != null) out.add(cell.c); if (cell.cand && cell.c == null) cell.cand.forEach(k => out.add(k)); };
  // 같은 팀 안 중복은 언제나 불가
  for (const l of RR_LANES) if (l !== lane) add(g.cells[l][side]);
  // 중복 불가면 상대 쪽 전부(같은 라인 후보 포함)
  if (!S.rr.dup) for (const l of RR_LANES) add(g.cells[l][1 - side]);
  // 하드 피어리스: 지난 판들에 쓴 챔피언은 양쪽 모두 금지
  if (S.rr.fearless) for (const k of S.used) out.add(k);
  return out;
}
function draw(S, lane, side, count, extra = []) {
  const ban = excluded(S, lane, side);
  for (const k of extra) ban.add(k);
  const min = RANGE[S.rr.range];
  const avail = CUR.lanes[lane].filter(([k, p]) => p >= min && !ban.has(k)).map(([k]) => k);
  if (!avail.length) return null;
  return shuffle(avail).slice(0, count);
}
const LANE_KR = { TOP: '탑', JGL: '정글', MID: '미드', ADC: '원딜', SUP: '서폿' };
const emptyMsg = lane => `${LANE_KR[lane]}에서 더 뽑을 챔피언이 없습니다. 피어리스를 초기화하거나 챔피언 범위를 넓혀 주세요.`;

/** 한 칸을 돌립니다. 양쪽을 함께 돌릴 때는 왼쪽부터 정해야 중복 불가 규칙이 오른쪽에 반영됩니다. */
function spinCell(S, lane, side, t0, extra) {
  const three = S.rr.pick === 'three';
  const got = draw(S, lane, side, three ? 3 : 1, extra);
  if (!got) return emptyMsg(lane);
  const cell = S.game.cells[lane][side];
  const first = t0 + SPIN + (side ? SIDE_GAP + (three ? REEL_GAP * 2 : 0) : 0);
  cell.at = t0;
  cell.stops = got.map((_, i) => first + i * REEL_GAP);
  cell.v++;
  if (three) { cell.cand = got; cell.c = null; } else { cell.c = got[0]; cell.cand = null; }
  return null;
}
function spinLane(S, lane, t0) {
  return spinCell(S, lane, 0, t0) || spinCell(S, lane, 1, t0);
}
const lastStop = (S, lane) => Math.max(...S.game.cells[lane].flatMap(c => c.stops));

/**
 * 진행자 조작 하나를 처리합니다. 실패하면 상태를 건드리지 않습니다(복사본에서 계산 후 반영).
 * @returns {{error:string}|{event:object}}
 */
export function rrAction(S0, m, now, data = DATA) {
  CUR = data;
  const S = structuredClone(S0);
  const g = S.game;
  const three = S.rr.pick === 'three';
  const t0 = now + LEAD;
  const busy = () => now < g.busy;
  let event;

  switch (m.t) {
    case 'rrspin': {
      if (g.lane >= RR_LANES.length) return { error: '이번 판은 다 뽑았습니다. 새 판을 시작하세요' };
      if (busy()) return { error: '슬롯이 돌아가는 중입니다' };
      const lane = RR_LANES[g.lane];
      if (three && g.cells[lane].some(c => c.cand && c.c == null)) return { error: '먼저 후보 중에서 챔피언을 고르세요' };
      if (!three && m.all) {
        let t = t0;
        for (let i = g.lane; i < RR_LANES.length; i++) {
          const err = spinLane(S, RR_LANES[i], t);
          if (err) return { error: err };
          t = lastStop(S, RR_LANES[i]) + LANE_GAP;
        }
        g.lane = RR_LANES.length;
      } else {
        const err = spinLane(S, lane, t0);
        if (err) return { error: err };
        if (!three) g.lane++;
        if (three && m.all) g.auto = true;
      }
      g.busy = Math.max(...cellsOf(g).flatMap(c => c.stops), 0);
      S.phase = 'live';
      event = { kind: 'rrspin' };
      break;
    }
    case 'rrreroll': {
      const lane = m.lane, side = m.side;
      if (!RR_LANES.includes(lane) || (side !== 0 && side !== 1)) return { error: '잘못된 요청입니다' };
      if (busy()) return { error: '슬롯이 돌아가는 중입니다' };
      if (g.rl[side] <= 0) return { error: '리롤을 모두 썼습니다' };
      const cell = g.cells[lane][side];
      if (three) {
        if (!cell.cand || cell.c != null) return { error: '고르기 전 후보만 다시 뽑을 수 있습니다' };
      } else if (cell.c == null) return { error: '아직 뽑지 않은 칸입니다' };
      // 지금 나와 있는 챔피언은 다시 나오지 않게 합니다.
      const cur = three ? cell.cand.slice() : [cell.c];
      const keep = { c: cell.c, cand: cell.cand };
      cell.c = null; cell.cand = null;   // 자기 칸은 '같은 팀 중복' 검사에서 빼야 하므로 비웁니다
      const got = draw(S, lane, side, three ? 3 : 1, cur);
      if (!got) { Object.assign(cell, keep); return { error: emptyMsg(lane) + ' (리롤 횟수는 그대로입니다)' }; }
      cell.at = t0;
      cell.stops = got.map((_, i) => t0 + SPIN + i * REEL_GAP);
      cell.v++;
      if (three) cell.cand = got; else cell.c = got[0];
      g.rl[side]--;
      g.busy = Math.max(g.busy, ...cell.stops);
      event = { kind: 'rrreroll', lane, side };
      break;
    }
    case 'rrchoose': {
      const lane = m.lane, side = m.side, key = m.key;
      if (!three) return { error: '3개 중 고르기 방식이 아닙니다' };
      if (!RR_LANES.includes(lane) || (side !== 0 && side !== 1)) return { error: '잘못된 요청입니다' };
      const cell = g.cells[lane][side];
      if (!cell.cand || cell.c != null) return { error: '고를 후보가 없습니다' };
      if (!cell.cand.includes(key)) return { error: '후보에 없는 챔피언입니다' };
      if (now < Math.max(...cell.stops)) return { error: '슬롯이 멈춘 뒤에 고르세요' };
      cell.c = key;
      const li = RR_LANES.indexOf(lane);
      if (li === g.lane && g.cells[lane].every(c => c.c != null)) {
        g.lane++;
        if (g.auto && g.lane < RR_LANES.length) {
          const err = spinLane(S, RR_LANES[g.lane], now + AUTO_GAP);
          if (err) { g.auto = false; event = { kind: 'rrchoose', lane, side, warn: err }; break; }
          g.busy = Math.max(g.busy, lastStop(S, RR_LANES[g.lane]));
        }
        if (g.lane >= RR_LANES.length) g.auto = false;
      }
      event = { kind: 'rrchoose', lane, side };
      break;
    }
    case 'rrnew': {
      if (busy()) return { error: '슬롯이 돌아가는 중입니다' };
      // 끝까지 뽑은 판만 '한 판'으로 칩니다. 도중에 버린 판의 챔피언은 피어리스 금지에 넣지 않습니다.
      const done = complete(g);
      if (done && S.rr.fearless) {
        const set = new Set(S.used);
        cellsOf(g).forEach(c => set.add(c.c));
        S.used = [...set];
      }
      S.game = newGame(done ? g.n + 1 : g.n, S.rr);
      event = { kind: 'rrnew' };
      break;
    }
    case 'rrfreset': {
      S.used = [];
      g.n = 1;
      event = { kind: 'rrfreset' };
      break;
    }
    case 'rrcfg': {
      const err = rrValidate({ rr: m.rr });
      if (err) return { error: err };
      if (!untouched(g)) return { error: '이번 판을 돌리기 전에만 바꿀 수 있습니다. 새 판을 누른 뒤 바꾸세요' };
      S.rr = pickCfg(m.rr);
      g.rl = [S.rr.rerolls, S.rr.rerolls];
      event = { kind: 'rrcfg' };
      break;
    }
    default:
      return { error: '알 수 없는 요청입니다' };
  }
  // 바뀐 상태를 원본에 반영합니다(호출부가 this.S를 그대로 들고 있으므로 제자리 갱신).
  Object.assign(S0, S);
  return { event };
}
