/**
 * 실시간 경매 서버
 *
 * 방 하나 = Durable Object 하나. DO는 단일 스레드로 동작하므로
 * 동시 입찰이 들어와도 순서대로 처리되어 경합이 생기지 않습니다.
 * WebSocket은 Hibernation API를 쓰므로 아무도 입찰하지 않는 동안에는
 * 지속시간 과금이 발생하지 않습니다.
 */

const LINES = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];
const UNDO_MAX = 8;   // 되돌리기 보관 개수
const ROOM_TTL = 14 * 86400e3;    // 경매방(사진 포함) 보관 기간
const INVITE_TTL = 30 * 86400e3;  // 방 생성 코드 유효 기간
const MANAGER_MAX = 10;           // 매니저 코드 하나로 만들 수 있는 동시 경매방 수
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외

// 실력 등급 파싱: '1'~'5.9' → 숫자, 아니면 null. (드래프트 티어 판정·매물 등급 공용)
const parseGrade = v => {
  const m = String(v ?? '').trim().match(/^([1-5](?:\.\d)?)\s*(?:티어|t)?$/i);
  return m ? Math.round(parseFloat(m[1]) * 10) / 10 : null;
};
// 티어 밴드 0~4 (1티어→0 … 5티어→4), 등급 없으면 -1. 소수는 같은 티어(정수부)로 본다.
const gradeBand = g => { const n = Number(g); return (g == null || !Number.isFinite(n) || n < 1) ? -1 : Math.min(4, Math.floor(n) - 1); };

// 점수 드래프트용 점수: 0~999 정수. 등급과 달리 높을수록 강하다.
// 소수를 받지 않는 이유 — 총점 합산에 부동소수 오차가 끼면 동점 타이브레이크가 조용히 깨진다.
// (소수를 넣으려면 총점 계산 전체를 십분위 정수로 바꾼 뒤에만 가능. SCORE_DRAFT_PLAN.md 참조)
const parseScore = v => {
  const m = String(v ?? '').trim().match(/^(\d{1,3})\s*(?:점|p)?$/i);
  return m ? +m[1] : null;
};
// 팀 총점 = 팀장 점수 + 그 팀이 지명한 매물 점수 합. pool을 기준으로 읽는다(teamBands와 동일).
// 정렬 비교자 안에서 팀마다 pool을 훑지 않도록 한 번에 id→총점 맵을 만든다.
const scoreTotals = (teams, pool) => {
  const tot = new Map(teams.map(t => [t.id, t.score || 0]));
  for (const p of pool) if (tot.has(p.teamId)) tot.set(p.teamId, tot.get(p.teamId) + (p.score || 0));
  return tot;
};
// 점수 드래프트 한 라운드의 지명 순서: 총점 오름차순, 동점이면 baseOrder(동점 우선순위).
const scoreOrder = (teams, pool, baseOrder) => {
  const tot = scoreTotals(teams, pool);
  const rank = new Map(baseOrder.map((id, i) => [id, i]));
  return teams.slice()
    .sort((a, b) => tot.get(a.id) - tot.get(b.id) || rank.get(a.id) - rank.get(b.id))
    .map(t => t.id);
};
// 총점이 같은 팀 묶음(2팀 이상)만 골라냅니다. 순서 안에서 baseOrder대로 정렬해 둡니다.
// 이 묶음이 있으면 진행자가 주사위 또는 수동으로 우선순위를 정해야 라운드가 시작됩니다.
const tieGroups = (teams, pool, baseOrder) => {
  const tot = scoreTotals(teams, pool);
  const rank = new Map(baseOrder.map((id, i) => [id, i]));
  const by = new Map();
  for (const t of teams) {
    const k = tot.get(t.id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t.id);
  }
  return [...by.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => a[0] - b[0])                       // 총점 낮은 묶음부터
    .map(([total, ids]) => ({ total, ids: ids.slice().sort((x, y) => rank.get(x) - rank.get(y)) }));
};
// baseOrder에서 주어진 팀들의 자리만 새 순서로 바꿉니다(다른 팀의 상대 우선순위는 유지).
const reprioritize = (baseOrder, ids, ordered) => {
  const slots = baseOrder.map((id, i) => ids.includes(id) ? i : -1).filter(i => i >= 0);
  const out = baseOrder.slice();
  slots.forEach((slot, k) => { out[slot] = ordered[k]; });
  return out;
};
const shuffled = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)))
  .map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const token = () => crypto.randomUUID().replace(/-/g, '');
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/* ── 관리자 인증 (ADMIN_PASSWORD 시크릿 기반 HMAC 토큰) ── */
const enc = new TextEncoder();
const TOKEN_HOURS = 12;

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** 길이가 달라도 시간이 새지 않도록 고정 횟수로 비교합니다 */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % a.length || 0) || 0) ^ (b.charCodeAt(i % b.length || 0) || 0);
  }
  return diff === 0;
}
async function issueToken(secret) {
  const exp = Date.now() + TOKEN_HOURS * 3600e3;
  return `${exp}.${await hmac(secret, String(exp))}`;
}
async function checkAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return 'nosecret';
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig || !(Date.now() < +exp)) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, exp));
}
// Response는 전역에서 만들 수 없습니다(Workers 런타임 제약). 호출 시점에 생성합니다.
const noSecret = () => json({
  error: 'ADMIN_PASSWORD가 설정되지 않았습니다. 터미널에서 `npx wrangler secret put ADMIN_PASSWORD` 를 실행하세요.'
}, 503);

const registry = env => env.REGISTRY.get(env.REGISTRY.idFromName('index'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    /* ── 관리자 ── */
    if (path === '/api/admin/login' && req.method === 'POST') {
      if (!env.ADMIN_PASSWORD) return noSecret();
      let body; try { body = await req.json(); } catch { return json({ error: '잘못된 요청입니다' }, 400); }
      // 미인증 엔드포인트라 입력을 먼저 좁힙니다: 객체·문자열·길이 상한.
      if (!body || typeof body !== 'object' || typeof body.password !== 'string' || body.password.length > 256) {
        return json({ error: '잘못된 요청입니다' }, 400);
      }
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const gate = await (await registry(env).fetch('https://do/login-try', {
        method: 'POST', body: JSON.stringify({ ip })
      })).json();
      if (gate.locked) {
        return json({ error: `시도가 너무 많습니다. ${gate.wait}초 뒤에 다시 해주세요.` }, 429);
      }
      await new Promise(r => setTimeout(r, 300)); // 무차별 대입 완화 (잠긴 IP는 대기 없이 반환)
      if (!safeEqual(body.password, env.ADMIN_PASSWORD)) {
        return json({ error: '비밀번호가 맞지 않습니다' }, 401);
      }
      await registry(env).fetch('https://do/login-ok', { method: 'POST', body: JSON.stringify({ ip }) });
      return json({ token: await issueToken(env.ADMIN_PASSWORD), hours: TOKEN_HOURS });
    }

    if (path.startsWith('/api/admin/')) {
      const ok = await checkAdmin(req, env);
      if (ok === 'nosecret') return noSecret();
      if (!ok) return json({ error: '관리자 인증이 필요합니다' }, 401);

      if (path === '/api/admin/rooms' && req.method === 'GET') {
        const list = await (await registry(env).fetch('https://do/list')).json();
        // 서브요청 상한(요청당 50)을 지키려 방 조회는 최신 40개로 제한하고,
        // 개별 DO 실패가 전체 500으로 번지지 않도록 각각 감쌉니다.
        const capped = list.slice(0, 40);
        const rooms = await Promise.all(capped.map(async r => {
          try {
            const res = await env.ROOM.get(env.ROOM.idFromName(r.code)).fetch('https://do/admin');
            return res.ok ? { ...r, ...(await res.json()) } : { ...r, missing: true };
          } catch { return { ...r, missing: true }; }
        }));
        return json({ rooms, total: list.length, shown: capped.length });
      }

      /* 방 생성 코드 발급/관리 */
      if (path === '/api/admin/invites' && req.method === 'GET') {
        return registry(env).fetch('https://do/invite-list');
      }
      if (path === '/api/admin/invite' && req.method === 'POST') {
        let body; try { body = await req.json(); } catch { body = {}; }
        if (!body || typeof body !== 'object') body = {};
        // kind: 'once'(운영자·1회용) | 'manager'(매니저·다회용, 최대 10개)
        const kind = body.kind === 'manager' ? 'manager' : 'once';
        const invite = {
          code: rand(8),
          note: String(body.note || '').trim().slice(0, 20),
          createdAt: Date.now(), kind,
          ...(kind === 'once' ? { used: false } : {})
        };
        await registry(env).fetch('https://do/invite-add', { method: 'POST', body: JSON.stringify(invite) });
        return json({ invite });
      }
      const im = path.match(/^\/api\/admin\/invite\/([A-Z0-9]{8})$/);
      if (im && req.method === 'DELETE') {
        await registry(env).fetch('https://do/invite-remove', { method: 'POST', body: JSON.stringify({ code: im[1] }) });
        return json({ ok: true });
      }

      const m = path.match(/^\/api\/admin\/room\/([A-Z0-9]{6})$/);
      if (m) {
        const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
        if (req.method === 'DELETE') {
          try { await stub.fetch('https://do/destroy', { method: 'POST' }); } catch { /* 이미 비어있음 */ }
          await registry(env).fetch('https://do/remove', { method: 'POST', body: JSON.stringify({ code: m[1] }) });
          return json({ ok: true });
        }
        return stub.fetch('https://do/admin');
      }
      return json({ error: '없는 경로입니다' }, 404);
    }

    // 생성 코드 확인 (운영자가 코드를 입력할 때 — 소모하지는 않습니다)
    const ic = path.match(/^\/api\/invite\/([A-Z0-9]{8})$/);
    if (ic && req.method === 'GET') {
      const r = await registry(env).fetch('https://do/invite-check', { method: 'POST', body: JSON.stringify({ code: ic[1] }) });
      const info = await r.json();
      if (!r.ok) return json(info, r.status);          // 없는 코드(404)·만료(410) 그대로 전달
      if (info.manager) return json({ manager: true, note: info.note || '' });  // 매니저 → 대시보드로
      if (info.valid) return json({ valid: true });      // 미사용 → 설정 화면으로
      // 이미 방을 만든 코드 → 그 방의 링크를 다시 보여줍니다(코드 = 운영자의 방 열쇠).
      if (info.used) {
        if (!info.roomCode) return json({ error: '이미 사용된 코드인데 연결된 방을 찾을 수 없습니다' }, 410);
        const res = await env.ROOM.get(env.ROOM.idFromName(info.roomCode)).fetch('https://do/admin');
        if (!res.ok) return json({ error: '이 코드로 만든 방이 삭제되었거나 보관 기간이 지났습니다' }, 410);
        const a = await res.json();
        return json({ used: true, room: { code: a.code, title: a.title, hostKey: a.hostKey, viewKey: a.viewKey, links: a.links } });
      }
      return json(info);
    }

    // 매니저 코드: 자기가 만든 방 목록/관리 (코드가 곧 열쇠)
    const mgr = path.match(/^\/api\/manager\/([A-Z0-9]{8})\/rooms$/);
    if (mgr && req.method === 'GET') {
      const code = mgr[1];
      const chk = await registry(env).fetch('https://do/invite-check', { method: 'POST', body: JSON.stringify({ code }) });
      const info = await chk.json();
      if (!chk.ok || !info.manager) return json({ error: '매니저 코드가 아닙니다' }, 403);
      const list = await (await registry(env).fetch('https://do/list')).json();
      const all = list.filter(x => x.via === code);
      const mine = all.slice(0, 40);
      const rooms = await Promise.all(mine.map(async r => {
        try {
          const res = await env.ROOM.get(env.ROOM.idFromName(r.code)).fetch('https://do/admin');
          return res.ok ? { ...r, ...(await res.json()) } : { ...r, missing: true };
        } catch { return { ...r, missing: true }; }
      }));
      return json({ rooms, count: all.length, max: MANAGER_MAX });
    }
    const mgrDel = path.match(/^\/api\/manager\/([A-Z0-9]{8})\/room\/([A-Z0-9]{6})$/);
    if (mgrDel && req.method === 'DELETE') {
      const code = mgrDel[1], rc = mgrDel[2];
      const chk = await registry(env).fetch('https://do/invite-check', { method: 'POST', body: JSON.stringify({ code }) });
      const info = await chk.json();
      if (!chk.ok || !info.manager) return json({ error: '매니저 코드가 아닙니다' }, 403);
      const list = await (await registry(env).fetch('https://do/list')).json();
      const target = list.find(x => x.code === rc);
      if (!target || target.via !== code) return json({ error: '이 코드로 만든 방이 아닙니다' }, 403);
      // destroy가 실패해도 목록에서는 반드시 제거해 슬롯이 물리지 않게 합니다.
      try { await env.ROOM.get(env.ROOM.idFromName(rc)).fetch('https://do/destroy', { method: 'POST' }); } catch { /* 이미 비어있음 */ }
      await registry(env).fetch('https://do/remove', { method: 'POST', body: JSON.stringify({ code: rc }) });
      return json({ ok: true });
    }

    // 방 생성 — 관리자 토큰 또는 생성 코드(1회용/매니저)
    if (path === '/api/room' && req.method === 'POST') {
      let cfg;
      try { cfg = await req.json(); } catch { return json({ error: '잘못된 요청입니다' }, 400); }
      const err = validate(cfg);
      if (err) return json({ error: err }, 400);

      const invite = String(cfg.inviteCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      let onceConsumed = false;   // 1회용 코드를 소모했는지(실패 시 되살리기용)
      let manager = false;        // 매니저 코드로 만드는지(개수 제한은 /add에서 원자적으로)
      if (invite) {
        const chk = await registry(env).fetch('https://do/invite-check', { method: 'POST', body: JSON.stringify({ code: invite }) });
        const info = await chk.json();
        if (!chk.ok) return json(info, chk.status);   // 없는 코드·만료 그대로 전달
        if (info.manager) {
          // 매니저 코드는 소모하지 않습니다. 개수 제한(최대 N개)은 /add에서 원자적으로 강제하고,
          // 여기서는 빠른 사전 확인으로 흔한 초과 케이스에 방 DO를 만들지 않게만 합니다.
          manager = true;
          const list = await (await registry(env).fetch('https://do/list')).json();
          if (list.filter(x => x.via === invite).length >= MANAGER_MAX) {
            return json({ error: `경매방이 이미 ${MANAGER_MAX}개예요. 기존 방을 정리(삭제)한 뒤 다시 만들어주세요.` }, 409);
          }
        } else if (info.used) {
          return json({ error: '이미 사용된 코드입니다' }, 403);
        } else {
          // 1회용 미사용 코드 → 먼저 소모를 확정(동시 생성 방지).
          const u = await (await registry(env).fetch('https://do/invite-use', {
            method: 'POST', body: JSON.stringify({ code: invite })
          })).json();
          if (!u.ok) return json({ error: u.error || '유효하지 않은 생성 코드입니다' }, 403);
          onceConsumed = true;
        }
      } else {
        const ok = await checkAdmin(req, env);
        if (ok === 'nosecret') return noSecret();
        if (!ok) return json({ error: '경매방을 만들려면 생성 코드가 필요합니다' }, 401);
      }

      // init이 예외를 던져도 소모한 1회용 코드를 반드시 되살립니다(매니저 코드는 소모 안 하므로 무관).
      const restoreInvite = () => onceConsumed
        ? registry(env).fetch('https://do/invite-restore', { method: 'POST', body: JSON.stringify({ code: invite }) })
        : Promise.resolve();
      let code, stub, res;
      try {
        // 아주 드물지만 코드가 겹칠 수 있어 몇 번 다시 뽑습니다.
        for (let i = 0; i < 5; i++) {
          code = rand(6);
          stub = env.ROOM.get(env.ROOM.idFromName(code));
          res = await stub.fetch('https://do/init', { method: 'POST', body: JSON.stringify({ code, cfg }) });
          if (res.status !== 409) break;
        }
      } catch (e) {
        await restoreInvite();
        return json({ error: '방을 만들지 못했습니다. 잠시 후 다시 시도해주세요.' }, 503);
      }
      if (!res.ok) {
        await restoreInvite();
        const body = await res.text();
        return new Response(body, { status: res.status, headers: res.headers });
      }
      const added = await (await registry(env).fetch('https://do/add', {
        method: 'POST',
        body: JSON.stringify({
          code, title: cfg.title || '경매', createdAt: Date.now(), via: invite || '',
          // 매니저면 개수 제한을 /add에서 원자적으로 확인(경합 방지). 초과면 방을 롤백합니다.
          ...(manager ? { limitVia: invite, limitMax: MANAGER_MAX } : {})
        })
      })).json();
      if (manager && added && added.full) {
        try { await stub.fetch('https://do/destroy', { method: 'POST' }); } catch { /* 롤백 */ }
        return json({ error: `경매방이 이미 ${MANAGER_MAX}개예요. 기존 방을 정리(삭제)한 뒤 다시 만들어주세요.` }, 409);
      }
      // 1회용 코드만 방과 1:1로 묶어 재진입에 씁니다(매니저는 방이 여러 개라 묶지 않음).
      if (onceConsumed) await registry(env).fetch('https://do/invite-bind', {
        method: 'POST', body: JSON.stringify({ code: invite, roomCode: code })
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    }

    // 방 존재 확인 (코드로 참가할 때)
    const peek = path.match(/^\/api\/room\/([A-Z0-9]{6})$/);
    if (peek && req.method === 'GET') {
      const stub = env.ROOM.get(env.ROOM.idFromName(peek[1]));
      return stub.fetch('https://do/peek');
    }

    // 진행자 전용: 방 안에서 접속 링크 다시 보기 (hostKey 검증은 DO에서)
    const linksM = path.match(/^\/api\/room\/([A-Z0-9]{6})\/links$/);
    if (linksM && req.method === 'GET') {
      const stub = env.ROOM.get(env.ROOM.idFromName(linksM[1]));
      return stub.fetch(`https://do/links?k=${encodeURIComponent(url.searchParams.get('k') || '')}`);
    }

    // 매물 사진 — 진행자가 올리고 방에 접속한 모두가 봅니다
    const img = path.match(/^\/api\/room\/([A-Z0-9]{6})\/img\/(p\d{1,3})$/);
    if (img) {
      const stub = env.ROOM.get(env.ROOM.idFromName(img[1]));
      const qs = `pid=${img[2]}&k=${encodeURIComponent(url.searchParams.get('k') || '')}`;
      if (req.method === 'GET') return stub.fetch(`https://do/img-get?${qs}`);
      if (req.method === 'DELETE') return stub.fetch(`https://do/img-del?${qs}`, { method: 'POST' });
      if (req.method === 'POST') {
        // 본문을 읽기 전에 먼저 거릅니다:
        //   1) 진행자 키가 아예 없으면 인증 실패 — 미인증 대용량 업로드를 막습니다.
        //   2) Content-Length가 한도를 넘으면 본문을 버퍼링하지 않고 즉시 거부.
        if (!url.searchParams.get('k')) return json({ error: '진행자만 사진을 관리할 수 있습니다' }, 403);
        if (+(req.headers.get('content-length') || 0) > 100 * 1024) {
          return json({ error: '사진이 너무 큽니다 (최대 100KB)' }, 413);
        }
        // 스트림을 그대로 넘기면 DO가 읽지 않고 응답할 때 미처리 예외가 생기므로 여기서 읽습니다.
        const body = await req.arrayBuffer();
        if (body.byteLength > 100 * 1024) return json({ error: '사진이 너무 큽니다 (최대 100KB)' }, 413);
        return stub.fetch(`https://do/img-put?${qs}`, {
          method: 'POST',
          headers: { 'content-type': req.headers.get('content-type') || '' },
          body
        });
      }
    }

    // WebSocket 접속
    const ws = path.match(/^\/api\/room\/([A-Z0-9]{6})\/ws$/);
    if (ws) {
      const stub = env.ROOM.get(env.ROOM.idFromName(ws[1]));
      return stub.fetch(new Request('https://do/ws' + url.search, req));
    }

    return json({ error: '없는 경로입니다' }, 404);
  }
};

function validate(cfg) {
  if (!cfg || typeof cfg !== 'object') return '설정이 비어 있습니다';
  if (!Array.isArray(cfg.leaders) || cfg.leaders.length < 2) return '팀장을 2명 이상 입력하세요';
  if (cfg.leaders.length > 12) return '팀장은 최대 12명까지입니다';
  // 원소 형태까지 검증해야 init에서 null 참조로 터지지 않습니다.
  if (!cfg.leaders.every(l => l && typeof l === 'object' && String(l.name || '').trim())) {
    return '팀장 이름이 비어 있거나 형식이 올바르지 않습니다';
  }
  if (!Array.isArray(cfg.pool) || !cfg.pool.length) return '선수 명단이 비어 있습니다';
  if (cfg.pool.length > 200) return '선수는 최대 200명까지입니다';
  if (!cfg.pool.every(p => p && typeof p === 'object' && String(p.name || '').trim())) return '닉네임이 빈 참가자가 있습니다';
  if (!(cfg.size >= 2 && cfg.size <= 6)) return '팀 인원은 2~6명이어야 합니다';
  if (!(cfg.minBid >= 1 && cfg.minBid <= 100000)) return '최소 입찰 단위는 1~100000이어야 합니다';
  if (!(cfg.base >= 1 && cfg.base <= 100000000)) return '기본 시작 포인트는 1 이상이어야 합니다';
  if (!(cfg.clock >= 5 && cfg.clock <= 300)) return '제한 시간은 5~300초여야 합니다';
  if (cfg.order != null && cfg.order !== 'random' && cfg.order !== 'draw') return '매물 순서 옵션이 올바르지 않습니다';
  return null;
}

/* ══════════════════════════════════════════════════════ */

export class AuctionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 클라이언트의 핑을 하이버네이션에서 깨우지 않고 런타임이 직접 응답합니다.
    // 이것이 없으면 25초마다 DO가 깨어나 무료 플랜 지속시간을 소모합니다.
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' }))
      );
    } catch { /* 구버전 런타임 호환 */ }
  }

  async load() {
    if (!this.loaded) {
      this.loaded = true;
      const [S, auth, um] = await Promise.all([
        this.ctx.storage.get('S'),
        this.ctx.storage.get('auth'),
        this.ctx.storage.get('um')
      ]);
      this.S = S || null;
      this.auth = auth || null;
      this.um = um || { top: 0, count: 0 };
      // 만료 도입 전에 만든 방은 지금부터 14일을 셉니다.
      if (this.S && !this.S.createdAt) {
        this.S.createdAt = Date.now();
        await this.save();
        await this.armExpiry();
      }
    }
  }
  save() {
    return this.ctx.storage.put('S', this.S);
  }

  /* ── 보관 기간(14일) ── */
  expireAt() { return (this.S.createdAt || 0) + ROOM_TTL; }
  /** 경매 타이머가 없을 때는 알람을 만료 시각에 걸어둡니다 */
  async armExpiry() {
    if (this.S) await this.ctx.storage.setAlarm(this.expireAt());
    else await this.ctx.storage.deleteAlarm();
  }
  async selfDestruct() {
    const code = this.S && this.S.code;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, '보관 기간(14일)이 끝나 방이 삭제되었습니다'); } catch { /* 이미 닫힘 */ }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.S = null; this.auth = null; this.um = { top: 0, count: 0 };
    if (code) {
      try {
        await registry(this.env).fetch('https://do/remove', {
          method: 'POST', body: JSON.stringify({ code })
        });
      } catch { /* 목록 정리는 실패해도 치명적이지 않습니다 */ }
    }
  }

  /* 되돌리기 기록은 한 칸씩 따로 저장합니다.
     한 덩어리로 두면 매물을 올릴 때마다 스택 전체를 다시 써야 해서
     참가자가 많을수록 쓰기 비용이 급격히 커집니다. */
  async snapshot() {
    await this.ctx.storage.put('u:' + (this.um.top % UNDO_MAX), JSON.stringify(this.S));
    this.um = { top: this.um.top + 1, count: Math.min(this.um.count + 1, UNDO_MAX) };
    await this.ctx.storage.put('um', this.um);
  }
  async popSnapshot() {
    if (this.um.count <= 0) return null;
    const top = this.um.top - 1, slot = 'u:' + (top % UNDO_MAX);
    const raw = await this.ctx.storage.get(slot);
    this.um = { top, count: this.um.count - 1 };
    await this.ctx.storage.put('um', this.um);
    await this.ctx.storage.delete(slot);
    return raw || null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    await this.load();
    if (this.S && Date.now() >= this.expireAt()) await this.selfDestruct();

    if (url.pathname === '/init') return this.init(req);

    if (url.pathname === '/peek') {
      if (!this.S) return json({ error: '없는 방 코드입니다' }, 404);
      // 코드만 아는 사람에게 참가 구성을 알려주지 않습니다.
      return json({ code: this.S.code, title: this.S.title });
    }

    if (url.pathname === '/admin') {
      if (!this.S) return json({ error: '없는 방입니다' }, 404);
      const sold = this.S.pool.filter(p => p.status === 'sold').length;
      return json({
        code: this.S.code, title: this.S.title,
        mode: this.S.mode || 'auction',
        draftBalance: this.S.draft ? this.S.draft.balance : null,
        phase: this.S.phase, current: this.S.current,
        teams: this.S.teams.length, players: this.S.pool.length, sold,
        filled: this.S.teams.every(t => this.openSlots(t) <= 0),
        online: this.ctx.getWebSockets().length,
        hostKey: this.auth.hostKey, viewKey: this.auth.viewKey,
        links: Object.entries(this.auth.teams).map(([tk, id]) => ({
          id, name: (this.team(id) || {}).name || id, token: tk
        }))
      });
    }

    // 진행자 전용: 방 안에서 링크를 다시 볼 수 있게 hostKey로만 링크를 내려줍니다.
    if (url.pathname === '/links') {
      if (!this.S) return json({ error: '없는 방입니다' }, 404);
      if (!safeEqual(url.searchParams.get('k') || '', this.auth.hostKey)) return json({ error: '진행자만 볼 수 있습니다' }, 403);
      return json({
        code: this.S.code, hostKey: this.auth.hostKey, viewKey: this.auth.viewKey,
        links: Object.entries(this.auth.teams).map(([tk, id]) => ({ id, name: (this.team(id) || {}).name || id, token: tk }))
      });
    }

    /* 매물 사진. SQLite 백엔드 DO는 값 한도가 2MB지만 100KB로 넉넉히 제한합니다. */
    if (url.pathname === '/img-get') {
      if (!this.S) return json({ error: '없는 방입니다' }, 404);
      const rec = await this.ctx.storage.get('img:' + url.searchParams.get('pid'));
      if (!rec) return json({ error: '사진이 없습니다' }, 404);
      return new Response(rec.buf, {
        headers: { 'content-type': rec.type, 'cache-control': 'public, max-age=31536000, immutable' }
      });
    }
    if (url.pathname === '/img-put' || url.pathname === '/img-del') {
      if (!this.S) return json({ error: '없는 방입니다' }, 404);
      if (!safeEqual(url.searchParams.get('k') || '', this.auth.hostKey)) {
        return json({ error: '진행자만 사진을 관리할 수 있습니다' }, 403);
      }
      const pid = url.searchParams.get('pid');
      const p = this.S.pool.find(x => x.id === pid);

      if (url.pathname === '/img-del') {
        await this.ctx.storage.delete('img:' + pid);
        if (p && p.imgV) { delete p.imgV; await this.save(); this.broadcast(); }
        return json({ ok: true });
      }

      if (!p) return json({ error: '없는 참가자입니다' }, 404);
      const type = req.headers.get('content-type') || '';
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'JPEG·PNG·WebP만 올릴 수 있습니다' }, 415);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: '빈 파일입니다' }, 400);
      if (buf.byteLength > 100 * 1024) return json({ error: '사진이 너무 큽니다 (최대 100KB)' }, 413);
      await this.ctx.storage.put('img:' + pid, { type, buf });
      // 방 전체 단조 카운터로 버전을 매깁니다. 되돌리기(undo)로도 되감기지 않아
      // 캐시된 옛 사진 주소가 재사용되는 문제를 막습니다.
      const seq = ((await this.ctx.storage.get('imgSeq')) || 0) + 1;
      await this.ctx.storage.put('imgSeq', seq);
      p.imgV = seq;
      await this.save();
      this.broadcast();
      return json({ ok: true, v: seq });
    }

    if (url.pathname === '/destroy') {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1000, '방이 삭제되었습니다'); } catch { /* 이미 닫힘 */ }
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.S = null; this.auth = null; this.um = { top: 0, count: 0 }; this.loaded = true;
      return json({ ok: true });
    }

    if (url.pathname === '/ws') {
      if (!this.S) return json({ error: '없는 방 코드입니다' }, 404);
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket 전용입니다' }, 426);

      const who = this.identify(url.searchParams);
      if (!who) return json({ error: '링크가 올바르지 않습니다' }, 403);

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`r:${who.role}`, `t:${who.teamId || '-'}`]);
      pair[1].send(JSON.stringify({ t: 'hello', you: who, S: this.view() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json({ error: 'not found' }, 404);
  }

  identify(qs) {
    if (!this.auth) return null;
    const k = qs.get('k'), tk = qs.get('t'), v = qs.get('v');
    if (k && safeEqual(k, this.auth.hostKey)) return { role: 'host', teamId: null };
    // hasOwnProperty로 검사해야 'toString' 같은 상속 속성으로 인증을 우회할 수 없습니다.
    if (tk && Object.prototype.hasOwnProperty.call(this.auth.teams, tk)) {
      return { role: 'team', teamId: this.auth.teams[tk] };
    }
    if (v && safeEqual(v, this.auth.viewKey)) return { role: 'view', teamId: null };
    return null;
  }

  async init(req) {
    if (this.S) return json({ error: '이미 사용 중인 코드입니다' }, 409);
    const { code, cfg } = await req.json();

    const base = Math.max(0, cfg.base | 0);
    const teams = cfg.leaders.map((l, i) => {
      const start = Math.max(0, l.points == null ? base : l.points | 0);
      return {
        id: 't' + i,
        name: String(l.name).trim().slice(0, 20) + ' 팀',
        leader: String(l.name).trim().slice(0, 20),
        leaderLine: LINES.includes(l.line) ? l.line : '',
        grade: parseGrade(l.grade),   // 티어 균형 드래프트에서 팀장이 채우는 티어
        score: parseScore(l.score),   // 점수 드래프트에서 팀 총점의 시작값
        start, points: start, players: []
      };
    });

    this.auth = { hostKey: token(), viewKey: token(), teams: {} };
    const links = teams.map(t => {
      const tk = token();
      this.auth.teams[tk] = t.id;
      return { id: t.id, name: t.name, token: tk };
    });

    const pool = cfg.pool.slice(0, 200).map((p, i) => ({
      id: 'p' + i,
      name: String(p.name || '').trim().slice(0, 24),
      tag: String(p.tag || '').trim().replace(/^#/, '').slice(0, 12),
      line: LINES.includes(p.line) ? p.line : '',
      sub: (LINES.includes(p.sub) || p.sub === 'ALL') ? p.sub : '',   // 부포지션: 5라인 또는 전체(ALL)
      tier: String(p.tier || '').trim().slice(0, 20),
      // 주최측 실력 등급. 1이 최상위, 1~5 + 소수점 첫째자리(예 1.2·3.4). 없으면 null.
      // 셀 전체가 1~5 숫자일 때만 인정합니다(티어 텍스트 오독 방지).
      grade: parseGrade(p.grade),
      // 클랜 자체 점수(0~999 정수). 점수 드래프트에서 지명 순서를 정하는 값. 등급과 별개.
      score: parseScore(p.score),
      champs: (Array.isArray(p.champs) ? p.champs : [])
        .slice(0, 3).map(c => String(c || '').trim().slice(0, 20)).filter(Boolean),
      status: 'wait', teamId: null, price: 0
    })).filter(p => p.name);

    // 매물 순서: 'draw'면 시작 전에 추첨해 확정·공개, 'random'이면 진행자가 매번 랜덤으로.
    const orderMode = cfg.order === 'draw' ? 'draw' : 'random';
    const order = pool.map(p => p.id);
    if (orderMode === 'draw') {
      for (let i = order.length - 1; i > 0; i--) {           // Fisher-Yates (암호학적 난수)
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }

    // ── 진행 방식: 경매(auction) 또는 드래프트(draft) ──
    const mode = cfg.mode === 'draft' ? 'draft' : 'auction';
    let draft = null;
    if (mode === 'draft') {
      const balance = cfg.draftBalance === 'tier' ? 'tier'
        : cfg.draftBalance === 'score' ? 'score' : 'free';
      const size = cfg.size | 0;
      const picksPerTeam = balance === 'tier' ? 4 : size - 1;
      if (picksPerTeam < 1) return json({ error: '팀 인원이 너무 적어 드래프트를 만들 수 없습니다' }, 400);
      // 자유·티어 공통: 지명해야 할 총 인원만큼 매물이 있어야 멈추지 않고 끝납니다.
      if (pool.length < teams.length * picksPerTeam) return json({ error: `드래프트 매물이 부족합니다 (필요 ${teams.length * picksPerTeam}명, 현재 ${pool.length}명)` }, 400);
      if (balance === 'tier') {
        // 티어 균형: 팀 인원 5(팀장+4), 모든 팀장 등급, 각 티어 매물이 필요 수만큼 있어야 함.
        if (size !== 5) return json({ error: '티어 균형 드래프트는 팀 인원 5명(팀장 포함)이어야 합니다' }, 400);
        const noGrade = teams.filter(t => gradeBand(t.grade) < 0);
        if (noGrade.length) return json({ error: `팀장 등급(1~5)을 입력해야 합니다: ${noGrade.map(t => t.leader).join(', ')}` }, 400);
        for (let b = 0; b < 5; b++) {
          const need = teams.filter(t => gradeBand(t.grade) !== b).length; // 그 티어를 지명해야 하는 팀 수
          const have = pool.filter(p => gradeBand(p.grade) === b).length;
          if (have < need) return json({ error: `${b + 1}티어 매물이 부족합니다 (필요 ${need}명, 현재 ${have}명)` }, 400);
        }
      }
      if (balance === 'score') {
        // 점수 드래프트: 팀장·매물 전원에게 점수가 있어야 순서를 정할 수 있습니다.
        const noS = teams.filter(t => t.score == null);
        if (noS.length) return json({ error: `팀장 점수(0~999)를 입력해야 합니다: ${noS.map(t => t.leader).join(', ')}` }, 400);
        const noPS = pool.filter(p => p.score == null).length;
        if (noPS) return json({ error: `참가자 점수(0~999)가 없는 사람이 ${noPS}명 있습니다` }, 400);
      }
      // 첫 라운드 순서는 진행자가 시작할 때 정합니다(기본값은 팀 등록 순서).
      // seq는 this.S 배정 뒤 resetSeq()로 채웁니다(순서 생성 규칙을 한 곳에만 두기 위해).
      draft = { balance, baseOrder: teams.map(t => t.id), seq: [], ptr: 0, picksPerTeam };
    }

    this.S = {
      code, mode, draft,
      title: String(cfg.title || '경매').slice(0, 40),
      base, size: cfg.size | 0, minBid: cfg.minBid | 0, clock: cfg.clock | 0,
      teams, pool, orderMode, order,
      current: null, bid: null, deadline: null, pausedLeft: null,
      log: [], phase: 'ready', createdAt: Date.now()
    };
    if (draft) this.resetSeq();   // draft는 this.S 안의 같은 객체입니다
    this.um = { top: 0, count: 0 };
    await this.ctx.storage.put({ S: this.S, auth: this.auth, um: this.um });
    await this.armExpiry();

    return json({ code, hostKey: this.auth.hostKey, viewKey: this.auth.viewKey, links });
  }

  /* ── 파생 계산 ── */
  team(id) { return this.S.teams.find(t => t.id === id); }
  // 팀이 이미 채운 티어 밴드 집합(팀장 등급 + 지명한 선수들). 티어 균형 드래프트 판정용.
  teamBands(t) {
    const s = new Set();
    const lb = gradeBand(t.grade); if (lb >= 0) s.add(lb);
    for (const p of this.S.pool) if (p.teamId === t.id) { const b = gradeBand(p.grade); if (b >= 0) s.add(b); }
    return s;
  }
  openSlots(t) { return this.S.size - 1 - t.players.length; }
  maxBid(t) {
    const n = this.openSlots(t);
    if (n <= 0) return 0;
    return Math.max(0, t.points - (n - 1) * this.S.minBid);
  }
  minNext() {
    return this.S.bid ? this.S.bid.amount + this.S.minBid : this.S.minBid;
  }
  canBid(t) { return this.openSlots(t) > 0 && this.maxBid(t) >= this.minNext(); }
  allFull() { return this.S.teams.every(t => this.openSlots(t) <= 0); }
  remaining() { return this.S.pool.filter(p => p.status !== 'sold'); }

  /** 드래프트 전체 지명 수. seq.length는 점수 모드에서 '지금까지 정해진 라운드'까지만이라
   *  총 지명 수로 쓸 수 없습니다. */
  totalPicks() {
    const d = this.S.draft;
    return d ? this.S.teams.length * d.picksPerTeam : 0;
  }
  /** 점수 모드의 다음 라운드 지명 순서(현재 총점 기준). */
  nextRoundOrder() {
    const d = this.S.draft;
    return scoreOrder(this.S.teams, this.S.pool, d.baseOrder);
  }
  /** 점수 모드 라운드 시작. 총점 동점이 있으면 seq를 늘리지 않고 d.tie에 올려
   *  진행자가 주사위/수동으로 우선순위를 정할 때까지 기다립니다.
   *  @returns 동점으로 멈췄으면 true */
  openScoreRound() {
    const d = this.S.draft;
    const groups = tieGroups(this.S.teams, this.S.pool, d.baseOrder);
    if (groups.length) {
      d.tie = { round: d.seq.length / this.S.teams.length + 1, groups };
      this.S.deadline = null;      // 정리하는 동안 픽 시계를 멈춥니다
      return true;
    }
    d.tie = null;
    d.seq.push(...this.nextRoundOrder());
    return false;
  }
  /** 드래프트 순서를 처음부터 다시 만듭니다(생성·초기화·추첨·시작 공용).
   *  스네이크는 전량, 점수 모드는 1라운드만 — 첫 라운드부터 동점이면 d.tie를 세우고 멈춥니다. */
  resetSeq() {
    const d = this.S.draft;
    d.ptr = 0; d.tie = null; d.seq = [];
    if (d.balance === 'score') { this.openScoreRound(); return; }
    for (let r = 0; r < d.picksPerTeam; r++) {
      d.seq.push(...(r % 2 === 0 ? d.baseOrder : d.baseOrder.slice().reverse()));
    }
  }

  /** 클라이언트에 내려보내는 형태 (한도를 미리 계산해 붙임) */
  view() {
    const v = {
      ...this.S,
      teams: this.S.teams.map(t => ({
        ...t, open: this.openSlots(t), cap: this.maxBid(t), live: this.canBid(t)
      })),
      minNext: this.minNext(),
      now: Date.now()
    };
    // 추첨 모드가 아니면 순서 배열은 클라가 쓰지 않으므로 브로드캐스트에서 뺍니다.
    if (v.orderMode !== 'draw') delete v.order;
    return v;
  }

  broadcast(extra = {}) {
    const msg = JSON.stringify({ t: 'state', S: this.view(), ...extra });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* 끊긴 소켓은 무시 */ }
    }
  }

  /* ── 메시지 처리 ── */
  async webSocketMessage(ws, raw) {
    // 과도한 크기의 메시지는 파싱조차 하지 않습니다.
    if (typeof raw === 'string' ? raw.length > 4096 : raw.byteLength > 4096) {
      return ws.send(JSON.stringify({ t: 'error', msg: '메시지가 너무 큽니다' }));
    }
    await this.load();
    // destroy/selfDestruct 직후 인플라이트 메시지가 도착하면 S가 null이라 터집니다.
    if (!this.S) { try { ws.close(1000, '방이 존재하지 않습니다'); } catch {} return; }
    const tags = this.ctx.getTags(ws);
    const role = (tags.find(x => x.startsWith('r:')) || '').slice(2);
    const teamId = (tags.find(x => x.startsWith('t:')) || '').slice(2);

    let m;
    try { m = JSON.parse(raw); } catch { return; }

    const deny = msg => ws.send(JSON.stringify({ t: 'error', msg }));

    // 같은 소켓에서 2초에 12건까지만 받습니다. 연타나 스크립트 폭주를 막습니다.
    if (m.t !== 'ping') {
      this.rate = this.rate || new Map();
      const now = Date.now();
      const key = role + ':' + teamId;
      const win = this.rate.get(key);
      if (!win || now - win.at > 2000) this.rate.set(key, { at: now, n: 1 });
      else if (++win.n > 12) return deny('잠시 후 다시 시도해주세요');
    }
    const hostOnly = () => {
      if (role !== 'host') { deny('진행자만 할 수 있습니다'); return true; }
      return false;
    };

    switch (m.t) {
      case 'ping':
        return ws.send(JSON.stringify({ t: 'pong', now: Date.now() }));

      case 'bid': {
        if (this.S.mode === 'draft') return deny('드래프트 방에서는 입찰할 수 없습니다');
        if (role !== 'team') return deny('팀장만 입찰할 수 있습니다');
        if (!this.S.current) return deny('경매 중인 매물이 없습니다');
        if (this.S.pausedLeft != null) return deny('경매가 일시정지 상태입니다');
        const t = this.team(teamId);
        if (!t) return deny('팀을 찾을 수 없습니다');
        if (this.openSlots(t) <= 0) return deny('로스터가 이미 찼습니다');
        if (this.S.bid && this.S.bid.teamId === teamId) return deny('이미 최고 입찰 중입니다');

        const amount = Math.floor(Number(m.amount));
        if (!Number.isFinite(amount)) return deny('금액이 올바르지 않습니다');
        if (amount < this.minNext()) return deny(`${this.minNext()}P 이상 불러야 합니다`);
        if (amount > this.maxBid(t)) return deny(`한도는 ${this.maxBid(t)}P입니다`);

        this.S.bid = { teamId, amount };
        this.S.deadline = Date.now() + this.S.clock * 1000;
        await this.ctx.storage.setAlarm(this.S.deadline);
        await this.save();
        return this.broadcast({ event: { kind: 'bid', team: t.name, amount } });
      }

      case 'lot': {
        if (hostOnly()) return;
        if (this.S.mode === 'draft') return deny('드래프트 방에서는 경매를 진행할 수 없습니다');
        // 진행 중인 매물이 있으면 먼저 처리하도록 막습니다. 그러지 않으면
        // 두 진행자(또는 풀 오클릭)가 최고 입찰을 흔적 없이 날려버립니다.
        if (this.S.current) return deny('먼저 낙찰 또는 유찰로 현재 매물을 마무리하세요');
        // 이미 낙찰됐거나 없는 매물을 지정하면(오래된 화면·중복 클릭) 거부합니다.
        if (m.id && !this.S.pool.some(p => p.id === m.id && p.status !== 'sold')) {
          return deny('이미 낙찰됐거나 없는 매물입니다');
        }
        return this.openLot(m.id);
      }
      case 'assign': {
        // 유찰/대기 선수를 팀에 0P로 수동 배정(드래그&드롭). 되돌리기 지원.
        if (hostOnly()) return;
        if (this.S.mode === 'draft') return deny('드래프트 방에서는 지명으로 선수를 넣습니다');
        if (this.S.current) return deny('진행 중인 매물을 먼저 마무리하세요');
        const p = this.S.pool.find(x => x.id === m.playerId);
        if (!p) return deny('없는 선수입니다');
        if (p.status === 'sold') return deny('이미 배정된 선수입니다');
        const t = this.team(m.teamId);
        if (!t) return deny('팀을 찾을 수 없습니다');
        if (this.openSlots(t) <= 0) return deny(`${t.name}은 자리가 찼습니다`);
        await this.snapshot();
        p.status = 'sold'; p.teamId = t.id; p.price = 0;
        t.players.push({ name: p.name, line: p.line, price: 0 });
        this.S.log.unshift({ kind: 'assign', player: p.name, team: t.name });
        this.S.log = this.S.log.slice(0, 60);
        if (this.allFull() || !this.remaining().length) this.S.phase = 'done';
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'assign', player: p.name, team: t.name } });
      }
      case 'sell': {
        if (hostOnly()) return;
        if (!this.S.bid) return deny('입찰이 없습니다');
        return this.finalize();
      }
      case 'pass': {
        if (hostOnly()) return;
        if (!this.S.current) return deny('경매 중인 매물이 없습니다');
        return this.finalize(true);
      }
      case 'pause': {
        if (hostOnly()) return;
        if (!this.S.deadline || this.S.pausedLeft != null) return;
        this.S.pausedLeft = Math.max(0, this.S.deadline - Date.now());
        this.S.deadline = null;
        await this.armExpiry();
        await this.save();
        return this.broadcast();
      }
      case 'resume': {
        if (hostOnly()) return;
        if (this.S.pausedLeft == null) return;
        this.S.deadline = Date.now() + this.S.pausedLeft;
        this.S.pausedLeft = null;
        await this.ctx.storage.setAlarm(this.S.deadline);
        await this.save();
        return this.broadcast();
      }
      case 'setclock': {
        if (hostOnly()) return;
        const n = Math.floor(Number(m.clock));
        if (!Number.isFinite(n) || n < 5 || n > 300) return deny('제한 시간은 5~300초여야 합니다');
        const old = this.S.clock;
        this.S.clock = n;
        // 진행 중인(정지 아닌) 매물이면 남은 시간을 차이만큼만 늘리거나 줄입니다.
        // (+5는 5초 추가, −5는 5초 단축 — "−5"가 오히려 시간을 늘리는 혼란을 없앰)
        if (this.S.current && this.S.deadline && this.S.pausedLeft == null) {
          this.S.deadline = Math.max(Date.now() + 1000, this.S.deadline + (n - old) * 1000);
          await this.ctx.storage.setAlarm(this.S.deadline);
        }
        await this.save();
        return this.broadcast({ event: { kind: 'clock', clock: n } });
      }
      case 'undo': {
        if (hostOnly()) return;
        const prev = await this.popSnapshot();
        if (!prev) return deny('되돌릴 기록이 없습니다');
        // 사진 버전은 되돌리기 대상이 아닙니다. 실제 사진 상태(스냅샷 밖)와
        // 어긋나면 캐시가 옛 사진을 보여주거나 깨진 이미지가 되므로, 복원 후
        // 현재 imgV를 다시 씌워 실제 사진 상태와 일치시킵니다.
        const curImg = {};
        for (const p of this.S.pool) if (p.imgV) curImg[p.id] = p.imgV;
        const curClock = this.S.clock;   // 제한 시간 변경도 되돌리기 대상이 아닙니다.
        this.S = JSON.parse(prev);
        for (const p of this.S.pool) { if (curImg[p.id]) p.imgV = curImg[p.id]; else delete p.imgV; }
        this.S.clock = curClock;
        this.S.current = null; this.S.bid = null;
        this.S.deadline = null; this.S.pausedLeft = null;
        // 드래프트 진행 중 되돌리기면 픽 타이머를 다시 채웁니다(0/"시간 초과"로 보이지 않게).
        if (this.S.mode === 'draft' && this.S.phase === 'live') this.S.deadline = Date.now() + this.S.clock * 1000;
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'undo' } });
      }
      case 'reset': {
        // 경매를 처음(대기) 상태로 되돌립니다. 매물 구성·팀·사진·링크는 그대로 두고
        // 낙찰/유찰/입찰/기록만 지웁니다. 실수로 눌러도 '되돌리기'로 복구되게 스냅샷을 남깁니다.
        if (hostOnly()) return;
        // lot/assign과 같은 규칙: 진행 중 매물이 있으면 먼저 마무리해야 최고 입찰이 흔적 없이 사라지지 않습니다.
        if (this.S.current) return deny('먼저 낙찰 또는 유찰로 현재 매물을 마무리하세요');
        await this.snapshot();
        for (const p of this.S.pool) { p.status = 'wait'; p.teamId = null; p.price = 0; }
        for (const t of this.S.teams) { t.players = []; t.points = t.start; }
        // 추첨 순서면 새로 섞어 완전히 새 판으로 시작합니다.
        if (this.S.orderMode === 'draw') {
          const order = this.S.pool.map(p => p.id);
          for (let i = order.length - 1; i > 0; i--) {
            const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
            [order[i], order[j]] = [order[j], order[i]];
          }
          this.S.order = order;
        }
        this.S.current = null; this.S.bid = null;
        this.S.deadline = null; this.S.pausedLeft = null;
        this.S.log = [];
        this.S.phase = 'ready';
        // 드래프트면 순서를 다시 만들고 포인터를 처음으로.
        // 우선순위(baseOrder)는 유지합니다 — 준비 화면에서 진행자가 다시 정할 수 있습니다.
        if (this.S.mode === 'draft' && this.S.draft) this.resetSeq();
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'reset' } });
      }
      case 'startdraft': {
        if (hostOnly()) return;
        if (this.S.mode !== 'draft') return deny('드래프트 방이 아닙니다');
        if (this.S.phase !== 'ready') return deny('이미 시작했습니다');
        {
          // 진행자가 정한 첫 라운드 순서(팀 id 순열)를 적용. 없거나 잘못되면 등록 순서를 씁니다.
          const d = this.S.draft;
          const ids = this.S.teams.map(t => t.id);
          let order = Array.isArray(m.order) ? m.order.filter(x => ids.includes(x)) : [];
          if (order.length !== ids.length || new Set(order).size !== ids.length) order = ids;
          d.baseOrder = order;
          this.resetSeq();
        }
        await this.snapshot();   // 시작 직후 '되돌리기'로 준비 상태로 돌아갈 수 있게.
        this.S.phase = 'live';
        // 픽 제한시간은 화면 표시용입니다. 시간이 지나도 자동 지명하지 않고 진행자가 대신 지명합니다.
        // 첫 라운드부터 총점 동점이면 순서가 아직 없으므로 시계를 띄우지 않습니다.
        this.S.deadline = this.S.draft.tie ? null : Date.now() + this.S.clock * 1000;
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'draftstart' } });
      }
      case 'draworder': {
        // 공개 추첨: 진행자가 누르면 순서를 섞어 전원 화면에 반영합니다(시작 전에만).
        if (hostOnly()) return;
        if (this.S.mode !== 'draft') return deny('드래프트 방이 아닙니다');
        if (this.S.phase !== 'ready') return deny('시작 전에만 추첨할 수 있습니다');
        const d = this.S.draft;
        d.baseOrder = shuffled(d.baseOrder);
        this.resetSeq();
        await this.save();
        return this.broadcast({ event: { kind: 'draworder' } });
      }
      case 'pick': {
        // 드래프트 지명. 현재 차례 팀장 또는 진행자가 선수를 지명. 되돌리기 지원.
        if (this.S.mode !== 'draft') return deny('드래프트 방이 아닙니다');
        if (this.S.phase !== 'live') return deny('드래프트가 진행 중이 아닙니다');
        if (this.S.pausedLeft != null) return deny('일시정지 상태입니다');
        const d = this.S.draft;
        if (d.tie) return deny('총점 동점을 정리하는 중입니다. 진행자가 우선순위를 정해야 합니다');
        const curId = d.seq[d.ptr];
        // 화면이 아직 갱신되지 않은 채로 연타하면 다음 차례 팀에 잘못 지명될 수 있어, 클라가 보낸 순번과 대조합니다.
        if (typeof m.ptr === 'number' && m.ptr !== d.ptr) return deny('화면이 막 갱신되었습니다. 다시 지명해주세요');
        if (role !== 'host' && teamId !== curId) return deny('지금은 당신 차례가 아닙니다');
        const p = this.S.pool.find(x => x.id === m.playerId);
        if (!p) return deny('없는 선수입니다');
        if (p.status === 'sold') return deny('이미 지명된 선수입니다');
        const t = this.team(curId);
        if (!t) return deny('팀을 찾을 수 없습니다');
        if (this.openSlots(t) <= 0) return deny('로스터가 이미 찼습니다');
        if (d.balance === 'tier') {
          const b = gradeBand(p.grade);
          if (b < 0) return deny('등급이 없는 선수는 티어 드래프트에서 지명할 수 없습니다');
          if (this.teamBands(t).has(b)) return deny(`${t.name}은 이미 ${b + 1}티어를 채웠습니다`);
        }
        await this.snapshot();
        p.status = 'sold'; p.teamId = t.id; p.price = 0;
        t.players.push({ name: p.name, line: p.line, price: 0, grade: p.grade });   // grade: 팀 명단에 티어 표기용
        this.S.log.unshift({ kind: 'pick', player: p.name, team: t.name });
        this.S.log = this.S.log.slice(0, 60);
        d.ptr++;
        // 점수 드래프트: 한 라운드가 끝나면 바뀐 총점으로 다음 라운드를 엽니다.
        // 동점이 있으면 seq를 늘리지 않고 d.tie를 세워 진행자 정리를 기다립니다.
        let tie = false;
        if (d.balance === 'score' && d.ptr === d.seq.length && d.seq.length < this.totalPicks()) {
          tie = this.openScoreRound();
        }
        if (d.ptr >= this.totalPicks() || this.allFull() || !this.remaining().length) { this.S.phase = 'done'; this.S.deadline = null; }
        else if (!tie) { this.S.deadline = Date.now() + this.S.clock * 1000; }
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'pick', player: p.name, team: t.name } });
      }
      case 'tiebreak': {
        // 총점 동점 정리. 진행자가 주사위를 굴리거나(mode:'roll') 우선순위를 직접 지정합니다(order).
        if (hostOnly()) return;
        if (this.S.mode !== 'draft') return deny('드래프트 방이 아닙니다');
        const d = this.S.draft;
        if (!d || !d.tie) return deny('정리할 동점이 없습니다');
        await this.snapshot();   // 주사위 결과도 되돌릴 수 있게
        // m.order는 '먼저 뽑게 할 팀'을 앞에서부터 적은 목록(일부만 적어도 됩니다).
        // 지정된 팀을 앞에 두고, 남은 팀은 주사위로 정합니다 → 항상 순서가 확정됩니다.
        const pref = Array.isArray(m.order) ? m.order : [];
        let base = d.baseOrder.slice(), rolled = false;
        for (const g of d.tie.groups) {
          const head = [...new Set(pref.filter(x => g.ids.includes(x)))];
          const rest = g.ids.filter(x => !head.includes(x));
          if (rest.length > 1) rolled = true;
          base = reprioritize(base, g.ids, head.concat(rest.length > 1 ? shuffled(rest) : rest));
        }
        d.baseOrder = base;
        d.tie = null;
        d.seq.push(...this.nextRoundOrder());
        this.S.deadline = Date.now() + this.S.clock * 1000;
        await this.armExpiry();
        await this.save();
        return this.broadcast({ event: { kind: 'tiebreak', rolled, order: d.baseOrder } });
      }
    }
  }

  /** 다음 매물 후보 목록(현재 순서 규칙대로). 진행자 지정(id)이 없을 때 사용. */
  upcoming() {
    const byId = new Map(this.S.pool.map(p => [p.id, p]));
    const waiting = st => (this.S.order || this.S.pool.map(p => p.id))
      .map(id => byId.get(id)).filter(p => p && p.status === st);
    // 'wait'가 남아 있으면 그것들, 아니면 유찰('pass') 재상정.
    return waiting('wait').length ? waiting('wait') : waiting('pass');
  }

  async openLot(id) {
    if (this.allFull()) return this.broadcast({ event: { kind: 'done' } });
    let pick;
    if (id) {
      pick = this.S.pool.find(p => p.id === id && p.status !== 'sold');
    } else {
      const box = this.upcoming();
      // 추첨 순서면 목록의 맨 앞(확정 순서), 무작위면 그 중 임의.
      pick = this.S.orderMode === 'draw'
        ? box[0]
        : box[Math.floor(Math.random() * box.length)];
    }
    if (!pick) return this.broadcast({ event: { kind: 'done' } });

    await this.snapshot();
    this.S.current = pick.id;
    this.S.bid = null;
    this.S.pausedLeft = null;
    this.S.phase = 'live';
    this.S.deadline = Date.now() + this.S.clock * 1000;
    await this.ctx.storage.setAlarm(this.S.deadline);
    await this.save();
    this.broadcast({ event: { kind: 'lot', player: pick.name } });
  }

  /** 낙찰 또는 유찰 확정 */
  async finalize(forcePass = false) {
    const p = this.S.pool.find(x => x.id === this.S.current);
    if (!p) {
      // 방어적 처리: current가 가리키는 선수가 없어도 알람은 다시 무장해야
      // 14일 자동 삭제가 유실되지 않습니다.
      this.S.current = null; this.S.bid = null;
      this.S.deadline = null; this.S.pausedLeft = null;
      await this.armExpiry();
      await this.save();
      return;
    }
    let event;

    if (!forcePass && this.S.bid) {
      const t = this.team(this.S.bid.teamId);
      const amount = this.S.bid.amount;
      t.points -= amount;
      t.players.push({ name: p.name, line: p.line, price: amount });
      p.status = 'sold'; p.teamId = t.id; p.price = amount;
      this.S.log.unshift({ kind: 'sold', player: p.name, team: t.name, price: amount });
      event = { kind: 'sold', player: p.name, team: t.name, price: amount };
    } else {
      p.status = 'pass';
      this.S.log.unshift({ kind: 'pass', player: p.name });
      event = { kind: 'pass', player: p.name };
    }

    this.S.log = this.S.log.slice(0, 60);
    this.S.current = null;
    this.S.bid = null;
    this.S.deadline = null;
    this.S.pausedLeft = null;
    if (this.allFull() || !this.remaining().length) this.S.phase = 'done';
    await this.armExpiry();
    await this.save();
    this.broadcast({ event });
  }

  /** 알람은 두 가지 몫을 겸합니다: 입찰 제한 시간 만료와 방 보관 기간(14일) 만료 */
  async alarm() {
    await this.load();
    if (!this.S) return;
    if (Date.now() >= this.expireAt()) return this.selfDestruct();
    if (!this.S.current) return this.armExpiry();
    if (this.S.deadline && Date.now() < this.S.deadline - 500) {
      return this.ctx.storage.setAlarm(this.S.deadline); // 입찰로 연장된 경우
    }
    await this.finalize();
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch { /* 이미 닫힘 */ }
  }
  async webSocketError(ws) { /* Hibernation이 정리합니다 */ }
}


/* ══════════════════════════════════════════════════════
   경매방 목록. Durable Object는 이름으로만 접근할 수 있고
   목록 조회 API가 없어서, 만든 방을 여기에 따로 적어둡니다.
   ══════════════════════════════════════════════════════ */
export class Registry {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === '/list') {
      const rooms = (await this.ctx.storage.get('rooms')) || [];
      // 14일이 지난 방은 DO가 스스로 삭제하므로 목록에서도 걷어냅니다.
      const live = rooms.filter(r => Date.now() - r.createdAt < ROOM_TTL);
      if (live.length !== rooms.length) await this.ctx.storage.put('rooms', live);
      return json(live.slice().sort((a, b) => b.createdAt - a.createdAt));
    }
    if (path === '/add') {
      const rooms = (await this.ctx.storage.get('rooms')) || [];
      const r = await req.json();
      // 매니저 개수 제한: 카운트와 등록을 한 번에 처리해 경합을 없앱니다.
      if (r.limitVia) {
        const live = rooms.filter(x => x.via === r.limitVia && Date.now() - x.createdAt < ROOM_TTL);
        if (live.length >= (r.limitMax || MANAGER_MAX)) return json({ ok: false, full: true });
      }
      const rec = { code: r.code, title: r.title, createdAt: r.createdAt, via: r.via || '' };
      const next = [rec, ...rooms.filter(x => x.code !== r.code)].slice(0, 200);
      await this.ctx.storage.put('rooms', next);
      return json({ ok: true });
    }
    /* 로그인 시도 제한: 10분 안에 8회 실패하면 10분 잠급니다. */
    if (path === '/login-try' || path === '/login-ok') {
      const { ip } = await req.json();
      const key = 'ip:' + ip;
      const now = Date.now();

      if (path === '/login-ok') { await this.ctx.storage.delete(key); return json({ ok: true }); }

      const rec = (await this.ctx.storage.get(key)) || { fails: 0, until: 0, at: 0 };
      if (rec.until > now) return json({ locked: true, wait: Math.ceil((rec.until - now) / 1000) });
      const fails = (now - (rec.at || 0) > 600e3 ? 0 : rec.fails) + 1;
      const until = fails >= 8 ? now + 600e3 : 0;
      await this.ctx.storage.put(key, { fails, at: now, until });

      // 오래된 실패 기록을 청소해 무한 누적을 막습니다. 로그인은 드물어 비용은 무시할 수준.
      const all = await this.ctx.storage.list({ prefix: 'ip:' });
      const dead = [];
      for (const [k, v] of all) {
        if (k !== key && v && v.until <= now && now - (v.at || 0) > 600e3) dead.push(k);
      }
      if (dead.length) await this.ctx.storage.delete(dead);
      return json({ locked: false, fails });
    }

    if (path === '/remove') {
      const rooms = (await this.ctx.storage.get('rooms')) || [];
      const { code } = await req.json();
      await this.ctx.storage.put('rooms', rooms.filter(x => x.code !== code));
      return json({ ok: true });
    }

    /* 방 생성 코드. Registry는 단일 스레드라 use(소모)가 경합 없이 처리됩니다. */
    if (path.startsWith('/invite-')) {
      const stored = (await this.ctx.storage.get('invites')) || [];
      const save = v => this.ctx.storage.put('invites', v);
      // 1회용 코드는 발급 후 30일이 지나면 걷어냅니다. 매니저 코드는 지속형이라 만료 없음.
      const invites = stored.filter(x => x.kind === 'manager' || Date.now() - x.createdAt < INVITE_TTL);
      if (invites.length !== stored.length) await save(invites);
      const expired = code => stored.some(x => x.code === code) && !invites.some(x => x.code === code);

      if (path === '/invite-list') {
        return json(invites.slice().sort((a, b) => b.createdAt - a.createdAt));
      }
      const body = await req.json();
      if (path === '/invite-add') {
        // 200개 상한에서 지속형 매니저 코드는 밀려나지 않도록 보존하고, 1회용만 잘라냅니다.
        const merged = [body, ...invites.filter(x => x.code !== body.code)];
        const managers = merged.filter(x => x.kind === 'manager');
        const onces = merged.filter(x => x.kind !== 'manager');
        await save([...managers, ...onces.slice(0, Math.max(0, 200 - managers.length))]);
        return json({ ok: true });
      }
      if (path === '/invite-remove') {
        await save(invites.filter(x => x.code !== body.code));
        return json({ ok: true });
      }

      const inv = invites.find(x => x.code === body.code);
      if (path === '/invite-check') {
        if (expired(body.code)) return json({ error: '기한(30일)이 지난 코드입니다' }, 410);
        if (!inv) return json({ error: '없는 생성 코드입니다' }, 404);
        if (inv.kind === 'manager') return json({ manager: true, note: inv.note || '' });
        // 이미 방을 만든 코드는 그 방으로 재진입할 수 있게 방 번호를 알려줍니다.
        if (inv.used) return json({ used: true, roomCode: inv.roomCode || null });
        return json({ valid: true });
      }
      if (path === '/invite-use') {
        if (expired(body.code)) return json({ ok: false, error: '기한(30일)이 지난 코드입니다' });
        if (!inv) return json({ ok: false, error: '없는 생성 코드입니다' });
        if (inv.kind === 'manager') return json({ ok: false, error: '매니저 코드는 소모 대상이 아닙니다' });
        if (inv.used) return json({ ok: false, error: '이미 사용된 코드입니다' });
        inv.used = true; inv.usedAt = Date.now();
        await save(invites);
        return json({ ok: true });
      }
      if (path === '/invite-bind') {
        if (inv) { inv.roomCode = body.roomCode; await save(invites); }
        return json({ ok: true });
      }
      if (path === '/invite-restore') {
        if (inv && inv.kind !== 'manager') { inv.used = false; delete inv.usedAt; await save(invites); }
        return json({ ok: true });
      }
    }
    return json({ error: 'not found' }, 404);
  }
}
