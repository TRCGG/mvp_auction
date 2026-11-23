// 랜랜내 챔피언 데이터 기본값(src/randpick-data.json)을 새로 만듭니다.
//   node scripts/update-randpick.mjs
//
// 사이트는 2주마다 스스로 갱신하고, 관리자 화면에서 '지금 갱신'도 할 수 있으므로
// 평소에는 실행할 필요가 없습니다. 쓰임새는 두 가지입니다.
//   1) 기본값(배포에 들어가는 데이터)을 최신으로 바꿀 때
//   2) 사이트의 자동 갱신이 lol.ps에 막혔을 때 — 만든 파일을 관리자 화면 '데이터 파일 올리기'로 올림
import { writeFileSync } from 'node:fs';
import { buildRandpickData, DATA_LANES } from '../src/randpick-fetch.js';

const OUT = new URL('../src/randpick-data.json', import.meta.url);
const data = await buildRandpickData();
writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`패치 ${data.patch} · Data Dragon ${data.ddragon} · 이름표 ${Object.keys(data.champs).length}명`);
for (const l of DATA_LANES) {
  const xs = data.lanes[l];
  console.log(`  ${l}: 0.5% 이상 ${xs.length}명 · 1.0% 이상 ${xs.filter(x => x[1] >= 1).length}명`);
}
console.log('→ ' + OUT.pathname);
