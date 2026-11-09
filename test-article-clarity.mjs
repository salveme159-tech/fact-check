// 기업·날짜·수치·부호 구분 회귀 테스트. Node 22.18+ : node --experimental-strip-types --test scripts/test-article-clarity.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractArticleClaims,applyActual,extractDateMentions,detectSign,signedText} from '../server/dart/articleClaims.ts';
const base={company:'대한전선',year:2025,period:'annual',mode:'cum',basis:'CFS',articleDate:'2026-10-27'};
const names=['대한전선','LS전선','가온전선'];
const run=(article,overrides={},list=names)=>extractArticleClaims({article,...base,...overrides},list);

test('부호 표기(-, −, △)와 영업손실·적자 표현을 음수로 구분',()=>{
  for(const [text,expect] of [['대한전선 영업이익은 -123억원이다.',-123],['대한전선 영업이익은 −123억원이다.',-123],['대한전선 영업이익은 △123억원이다.',-123],['대한전선 영업손실은 123억원이다.',-123],['대한전선 영업이익은 123억원 적자다.',-123],['대한전선 영업이익은 123억원이다.',123],['대한전선 영업이익은 +123억원이다.',123]]){
    const c=run(text)[0];assert.equal(c.value,expect,text);
    assert.equal(c.sign,expect<0?'negative':text.includes('+')?'positive':'unsigned',text);
  }
  assert.equal(run('대한전선 영업손실은 123억원이다.')[0].valueText,'−123억원');
});
test('손실에서 흑자로 바뀐 문장도 수치별 부호를 분리',()=>{
  const c=run('대한전선은 지난해 영업손실 100억원에서 올해 흑자 200억원으로 돌아섰다.');
  assert.deepEqual(c.map(x=>[x.text,x.value,x.sign]),[['100억원',-100,'negative'],['200억원',200,'positive']]);
});
test('숫자 사이의 하이픈은 음수 부호가 아님',()=>{
  const c=run('대한전선 영업이익률은 3-4%다.');
  assert.ok(c.every(x=>x.value>0));
});
test('공시값과 부호만 다르면 SIGN, 크기까지 다르면 SIGN_VALUE',()=>{
  const a=run('대한전선 영업손실은 123억원이다.')[0];applyActual(a,123);
  assert.equal(a.status,'MISMATCH');assert.equal(a.mismatchKind,'SIGN');assert.match(a.message,/부호가 반대/);assert.equal(a.actualText,'123억원');
  const b=run('대한전선 영업손실은 123억원이다.')[0];applyActual(b,500);
  assert.equal(b.mismatchKind,'SIGN_VALUE');
  const c=run('대한전선 영업손실은 123억원이다.')[0];applyActual(c,-123);
  assert.equal(c.status,'MATCH');assert.equal(c.actualText,'−123억원');
});
test('10의 거듭제곱 차이는 UNIT, 그 외는 VALUE',()=>{
  const a=run('대한전선 매출액은 3조 6,360억원이다.')[0];applyActual(a,3636);
  assert.equal(a.mismatchKind,'UNIT');
  const b=run('대한전선 매출액은 3조 6,360억원이다.')[0];applyActual(b,3000);
  assert.equal(b.mismatchKind,'VALUE');
});
test('증감 방향이 반대인 경우를 크기 차이와 구분',()=>{
  const a=run('대한전선 영업이익은 전년 대비 20% 감소했다.')[0];
  assert.equal(a.growth,'decrease');
  applyActual(a,-20); // 서버 계산: 실제로는 +20% 증가 → 기사 방향 기준 -20
  assert.equal(a.mismatchKind,'DIRECTION');assert.match(a.actualText,/증가\(\+\)/);
  const b=run('대한전선 영업이익은 전년 대비 20% 감소했다.')[0];applyActual(b,20);
  assert.equal(b.status,'MATCH');assert.match(b.actualText,/감소\(−\)/);
});
test('여러 회사: 문장마다 기업을 분리하고 수치가 다른 회사로 새지 않음',()=>{
  const c=run('대한전선은 2025년 매출액 3조 6,360억원을 기록했다. LS전선은 매출액 5조원을 기록했다. 가온전선의 영업이익은 300억원이다.',{company:undefined,year:undefined,period:undefined,basis:undefined});
  assert.deepEqual(c.map(x=>[x.company,x.metric,x.value,x.companySource]),[['대한전선','revenue',36360,'sentence'],['LS전선','revenue',50000,'sentence'],['가온전선','operatingProfit',300,'sentence']]);
});
test('앞 문장에서 이어받은 기업은 carried로 표시',()=>{
  const c=run('LS전선은 2025년 매출액 5조원을 기록했다. 영업이익은 1,000억원이다.',{company:undefined,year:undefined,period:undefined,basis:undefined});
  assert.equal(c[1].company,'LS전선');assert.equal(c[1].companySource,'carried');
});
test('A와 B의 지표를 ‘각각’ 나열하면 기업 순서대로 대응',()=>{
  const c=run('대한전선과 LS전선의 2025년 영업이익은 각각 1,286억원, 2,000억원이다.');
  assert.deepEqual(c.map(x=>[x.company,x.value,x.message]),[['대한전선',1286,''],['LS전선',2000,'']]);
});
test('기업과 지표가 모두 여러 개인 ‘각각’ 문장은 확정하지 않음',()=>{
  const c=run('대한전선과 LS전선의 매출액과 영업이익은 각각 3조원, 1,286억원, 5조원, 2,000억원이다.');
  assert.ok(c.every(x=>/대응/.test(x.message)));
});
test('비교 대상 기업은 수치의 소유 기업이 아님',()=>{
  const c=run('대한전선의 2025년 매출액은 3조원으로 LS전선(2조원)보다 많았다.');
  assert.deepEqual(c.map(x=>[x.company,x.value]),[['대한전선',30000],['LS전선',20000]]);
  const d=run('대한전선의 영업이익은 LS전선 대비 20% 증가했다.')[0];
  assert.equal(d.company,'대한전선');
});
test('날짜·기간 표현을 찾아 기준일로 해석',()=>{
  const m=extractDateMentions('지난해 3분기 누적, 2025년 상반기, 지난 6월 말, 10월 27일 공시, 2026-10-27, 12일 공시했다.','2026-10-27');
  const by=Object.fromEntries(m.map(x=>[x.text,x.resolved]));
  assert.equal(by['지난해'],'2025년');assert.match(by['3분기'],/7~9월/);assert.match(by['2025년 상반기'],/1~6월/);
  assert.match(by['지난 6월 말'],/2026년 6월 말/);assert.match(by['10월 27일'],/2026-10-27/);assert.equal(by['2026-10-27'],'2026-10-27');assert.match(by['12일'],/2026-10-12/);
});
test('claim에 기간 해석 근거(periodNote)를 남김',()=>{
  const c=run('대한전선은 지난해 매출액 3조원을 기록했다.',{company:undefined,year:undefined,period:undefined,basis:undefined})[0];
  assert.equal(c.year,2025);assert.match(c.periodNote,/지난해.*2025년/);
});
test('detectSign은 퍼센트포인트·물리량에는 부호를 붙이지 않음',()=>{
  assert.equal(detectSign({raw:'380kV',value:380,money:false,paragraph:'380kV',pos:0,windowStart:0,windowEnd:5}).sign,'unsigned');
  assert.equal(signedText(-5.2,'%'),'−5.2%');
});
test('금액 뒤에 증감이 붙은 변동액은 잔액과 비교하지 않음',()=>{
  const c=run('대한전선 순차입금이 2,000억원 감소했다.');
  assert.match(c[0].message,/변동액/);assert.equal(c[0].status,'UNVERIFIED');
  const d=run('대한전선 영업이익은 1,286억원으로 늘었다.');
  assert.equal(d[0].message,'');
});
test('6개월 같은 기간 표현은 수치로 잡지 않음',()=>{
  assert.equal(run('대한전선은 6개월 만에 재고를 줄였다.').length,0);
  assert.equal(run('대한전선 전체 직원 12개월 근속자는 6개 팀이다.').filter(x=>x.text==='12개월').length,0);
});
test('기간·기업을 문장에서 확정하지 못한 불일치는 확인 필요로 낮춤',()=>{
  const c=run('대한전선은 2025년 매출액 3조원을 기록했다. 영업이익은 100억원이다.',{company:undefined,year:undefined,period:undefined,basis:undefined})[1];
  assert.equal(c.periodExplicit,false);applyActual(c,500);
  assert.equal(c.status,'UNVERIFIED');assert.match(c.message,/기간 표현이 없어/);assert.equal(c.mismatchKind,'VALUE');
  const d=run('대한전선 2025년 영업이익은 100억원이다.',{company:undefined,year:undefined,period:undefined,basis:undefined})[0];
  assert.equal(d.periodExplicit,true);applyActual(d,500);assert.equal(d.status,'MISMATCH');
});

// ── 실제 기사(에너지경제 ‘호황 청구서’, 2026-08-20) 회귀 케이스 ──
const NEWS={company:undefined,year:undefined,period:undefined,basis:undefined,articleDate:'2026-08-20'};
const news=(t)=>extractArticleClaims({article:'입력 2026.08.20\n'+t,...NEWS},['LS전선','대한전선']);
const brief=(c)=>c.map(x=>[x.company,x.metric,x.value,x.year,x.period,x.comparison?`${x.comparison.year}${x.comparison.period}`:'']);
test('기사: 증가율을 영업이익 같은 엉뚱한 지표에 붙이지 않음(전기동 가격)',()=>{
  const c=news('LS전선은 올해 상반기 연결기준 매출 4조5232억원과 영업이익 2384억원을 올렸다.\n\nLS전선에 따르면, 올 2분기 말 기준 전기동 매입(수입)가격은 톤(t)당 2000만원으로 전년 동기 대비 45.2% 증가했다.');
  assert.ok(!c.some(x=>x.value===45.2&&x.metric));
});
test('기사: 전년동기·지난해 말 라벨이 수치와 증가율의 비교 기간을 정함',()=>{
  const c=news('대한전선도 재고자산이 크게 늘었다. 2분기말 연결기준 재고자산은 1조1400억원으로 각각 전년동기(7156억원)·지난해 말(8563억원) 대비 59.3%·33.1% 증가했다.');
  assert.deepEqual(brief(c),[['대한전선','재고자산',11400,2026,'half',''],['대한전선','재고자산',7156,2025,'half',''],['대한전선','재고자산',8563,2025,'annual',''],['대한전선','재고자산',59.3,2026,'half','2025half'],['대한전선','재고자산',33.1,2026,'half','2025annual']]);
});
test('기사: 급증도 증가율, 지난해 같은 기간은 전년 같은 기간',()=>{
  const c=news('LS전선의 올 2분기 말 재고자산은 총 2조1149억원으로 지난해 같은 기간 1조3463억원 대비 57.1% 급증했다. 전년 말(1조4566억원)과 비교해도 45.2% 증가한 수치로, 올 상반기 들어 증가폭이 가팔라졌다.');
  assert.deepEqual(brief(c),[['LS전선','재고자산',21149,2026,'half',''],['LS전선','재고자산',13463,2025,'half',''],['LS전선','재고자산',57.1,2026,'half','2025half'],['LS전선','재고자산',14566,2025,'annual',''],['LS전선','재고자산',45.2,2026,'half','2025annual']]);
  assert.equal(c[2].growth,'increase');
});
test('기사: 각각 영업·투자활동 현금흐름과 순유출/유입 전환 부호',()=>{
  const c=news('LS전선은 상반기 각각 영업활동현금흐름과 투자활동현금흐름에서 7042억원·1524억원 규모 순유출을 기록한 반면, 재무활동현금흐름은 전년 동기 순유출(387억원)에서 9080억원 규모로 유입 전환됐다.');
  assert.deepEqual(c.map(x=>[x.metric,x.value,x.year]),[['operatingCashFlow',-7042,2026],['investmentCashFlow',-1524,2026],['financingCashFlow',-387,2025],['financingCashFlow',9080,2026]]);
});
test('기사: 영업·투자활동현금흐름이 함께 순유출(A·B)이면 순서대로 대응, 유입은 양수',()=>{
  const c=news('대한전선도 올 상반기 영업·투자활동현금흐름이 모두 순유출(3180억원·182억원)을 기록한 가운데, 재무활동현금흐름에서 3203억원이 유입돼 전년 동기 대비 현금유입 규모를 102.6% 늘렸다.');
  assert.deepEqual(c.slice(0,3).map(x=>[x.metric,x.value]),[['operatingCashFlow',-3180],['investmentCashFlow',-182],['financingCashFlow',3203]]);
  assert.equal(c[3].growth,'increase');assert.equal(c[3].comparison.period,'half');
});
test('기사: 순유출 규모가 A에서 B로 확대되면 B도 순유출, ‘올해’ 기간은 앞의 상반기를 따름',()=>{
  const c=news('이에 영업활동현금흐름 순유출 규모도 지난해 상반기 680억원에서 올해 3180억원으로 확대됐다.');
  assert.deepEqual(c.map(x=>[x.value,x.year,x.period]),[[-680,2025,'half'],[-3180,2026,'half']]);
});
test('기사: 전년 동기 순유입 라벨은 바로 앞 해로 해석',()=>{
  const c=news('LS전선의 올 상반기 영업활동현금흐름은 7042억원 규모 순유출을 기록했다. 전년 동기 영업활동현금흐름이 2982억원 규모로 순유입을 기록한 것과 대조적이다.');
  assert.deepEqual(c.map(x=>[x.value,x.year]),[[-7042,2026],[2982,2025]]);
});
test('기사: 현금유출 요인으로 쓰인 재고자산·매출채권 금액과 비중은 참고 수치',async()=>{
  const {isReferenceClaim}=await import('../shared/articleFactCheck.ts');
  const c=news('대한전선도 상반기 재고자산과 매출채권 증가가 각각 2651억원(63.0%)·622억원(14.8%) 규모의 현금 유출 요인으로 작용했다.');
  assert.ok(c.length>0&&c.every(x=>isReferenceClaim(x)));
});
