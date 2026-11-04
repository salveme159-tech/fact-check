// Node 22.18+에서 추가 패키지 없이 실행: node --test scripts/test-article-claims.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractArticleClaims,koreanAmount,applyActual,parseContractAmount} from '../server/dart/articleClaims.ts';
const input=(article,overrides={})=>({article,company:'대한전선',year:2025,period:'annual',mode:'cum',basis:'CFS',articleDate:'2026-10-27',...overrides});
const extract=(article,overrides)=>extractArticleClaims(input(article,overrides),['대한전선','LS전선','LS']);
test('조·억·만·원과 음수 금액을 동일한 억원 단위로 변환',()=>{
 for(const [raw,expected] of [['3조 6,360억원',36360],['1조1,469억원',11469],['114,690,000,000원',1146.9],['2,500만원',.25],['-1억5,000만원',-1.5]]) assert.equal(koreanAmount(raw),expected);
 assert.equal(extract('대한전선 매출액은 114,690,000,000원이다.')[0].value,1146.9);
});
test('여러 지표를 분리하고 정확한 원문 위치를 유지',()=>{
 const article='대한전선의 2025년 연결 매출액은 3조 6,360억원, 영업이익은 1,286억원이다.';
 const c=extract(article); assert.deepEqual(c.map(x=>[x.metric,x.value]),[['revenue',36360],['operatingProfit',1286]]);
 for(const x of c)assert.equal(article.slice(x.start,x.end),x.text);
});
test('제목의 후행 수주 표현과 전압을 구분',()=>{
 const c=extract('대한전선, 독일에서 380kV 전력망 1조1,469억원 수주');
 assert.equal(c[0].unit,'kV'); assert.ok(c[0].message);assert.equal(c[1].metric,'contract');assert.equal(c[1].value,11469);
 applyActual(c[1],1146.9);assert.equal(c[1].status,'MISMATCH');assert.equal(c[1].actual,1146.9);
});
test('반올림 허용과 약 표기 허용, 실제 금액 유지',()=>{
 const a=extract('대한전선 영업이익은 1,286억원이다.')[0];applyActual(a,1286.4);assert.equal(a.status,'MATCH');
 const b=extract('대한전선 영업이익은 약 1,290억원이다.')[0];applyActual(b,1286.4);assert.equal(b.status,'MATCH');
 const c=extract('대한전선 영업이익률은 10.2%다.')[0];applyActual(c,10.26);assert.equal(c.status,'MISMATCH');
});
test('서로 다른 기업과 별도·연결 기준을 구별',()=>{
 const c=extract('대한전선의 연결 영업이익은 100억원이다.\nLS전선의 별도 영업이익은 200억원이다.');
 assert.deepEqual(c.map(x=>[x.company,x.basis]),[['대한전선','CFS'],['LS전선','OFS']]);
});
test('실적 기간·당분기·누계·상대 연도를 식별',()=>{
 const c=extract('대한전선은 올해 2분기 매출액 100억원, 영업이익 10억원이다.\n지난해 상반기 영업이익은 20억원이다.');
 assert.deepEqual(c.map(x=>[x.year,x.period,x.mode]),[[2026,'half','qtr'],[2026,'half','qtr'],[2025,'half','cum']]);
});
test('지원하지 않는 물리량·전망은 확인 필요',()=>{
 for(const article of ['대한전선 매출액은 100억원으로 예상된다.','대한전선 4분기 매출액은 100억원이다.','대한전선 케이블 길이는 86km다.']) {
  const c=extract(article)[0];assert.equal(c.status,'UNVERIFIED');assert.ok(c.message);
 }
});
test('증감률·퍼센트포인트·손실을 혼동하지 않음',()=>{
 const c=extract('대한전선 영업손실은 100억원이다.\n대한전선 영업이익은 전년 동기 대비 10% 감소했다.\n영업이익률은 1.5%p 상승했다.');
 assert.equal(c[0].value,-100);assert.equal(c[1].growth,'decrease');assert.ok(c[2].message);
});
test('소수점이 문장 분리와 수치 위치를 손상시키지 않음',()=>{
 const c=extract('대한전선 영업이익률은 5.25%다. 대한전선 매출은 100억원이다.');assert.equal(c.length,2);assert.equal(c[0].value,5.25);assert.equal(c[1].metric,'revenue');
});
test('단위가 명확한 계약금액을 추출하고 비율·정정 대비값을 거부',()=>{
 assert.equal(parseContractAmount('<table><tr><td>계약금액(원)</td><td>114,690,000,000</td></tr></table>').value,1146.9);
 for(const row of ['계약금액(백만원) 114,690','계약금액 114,690,000,000','계약금액(원) 114,690,000,000 120,000,000,000','계약금액 대비 비율(원) 114,690,000,000'])assert.equal(parseContractAmount(`<tr><td>${row}</td></tr>`),null);
});
test('각각 나열된 지표와 금액을 순서대로 대응',()=>{
 const c=extract('대한전선 매출액과 영업이익은 각각 1,000억원, 100억원이다.');
 assert.deepEqual(c.map(x=>[x.metric,x.value]),[['revenue',1000],['operatingProfit',100]]);
});
test('대비를 나타내는 지난해를 실적 사업연도로 오인하지 않음',()=>{
 const c=extract('대한전선 2026년 영업이익은 지난해 대비 10% 증가했다.');assert.equal(c[0].year,2026);
});
test('기사만 입력하면 발행일의 지난해·상반기·별도와 금액을 자동 인식',()=>{
 const c=extractArticleClaims({article:'입력 2026.10.27 09:00\n대한전선은 지난해 상반기 별도 매출액 1조2,345억원을 기록했다.'},['대한전선'])[0];
 assert.deepEqual([c.year,c.period,c.mode,c.basis,c.value],[2025,'half','cum','OFS',12345]);assert.equal(c.message,'');
});
test('수치 없는 제목에서 실적 기준을 이어받음',()=>{
 const c=extractArticleClaims({article:'대한전선 2025년 3분기 연결 실적\n매출액은 100억원, 영업이익은 10억원이다.'},['대한전선']);
 assert.ok(c.every(x=>x.year===2025&&x.period==='q3'&&x.mode==='qtr'&&x.basis==='CFS'&&!x.message));
});
test('발행일 없으면 한국 현재 날짜의 전년을 지난해로 인식',()=>{
 const c=extractArticleClaims({article:'대한전선은 지난해 연결 매출액 100억원을 기록했다.'},['대한전선'])[0];
 assert.equal(c.year,Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric'}).format(new Date()))-1);assert.equal(c.message,'');
});
test('기업·기간은 확인하되 연결은 기본 기준으로 적용',()=>{
 const c=extractArticleClaims({article:'매출액은 100억원이다.'},[])[0];
 assert.match(c.message,/기업명/);assert.match(c.message,/실적 기간/);assert.equal(c.basis,'CFS');
});
test('금액 뒤에 표시한 연결 기준을 인식',()=>{
 const c=extractArticleClaims({article:'대한전선의 2025년 매출액은 100억원(연결 기준)이다.'},['대한전선'])[0];
 assert.equal(c.basis,'CFS');assert.equal(c.message,'');
});
test('같은 기사에서 다른 기업도 공통 실적 기간과 기본 연결 기준 적용',()=>{
 const c=extractArticleClaims({article:'대한전선은 2025년 3분기 연결 매출액 100억원, LS전선은 매출액 200억원을 기록했다.'},['대한전선','LS전선']);
 assert.equal(c[0].message,'');assert.deepEqual(c.map(x=>[x.year,x.period,x.basis]),[[2025,'q3','CFS'],[2025,'q3','CFS']]);assert.equal(c[1].message,'');
});
test('기사 전체의 상반기 말·작년 말·지난해·올해를 각 금액에 대응',()=>{
 const article='입력 2026.10.27\n대한전선 올해 상반기 말 수주잔고는 4조629억원이다.\n작년 말에는 3조6633억원이었다.\n지난해 매출액은 3조6360억원이다.\n올해 2분기 영업이익은 608억원이다.';
 const c=extractArticleClaims({article},['대한전선']);
 assert.deepEqual(c.map(x=>[x.year,x.period,x.metric,x.basis]),[[2026,'half','backlog','CFS'],[2025,'annual','backlog','CFS'],[2025,'annual','revenue','CFS'],[2026,'half','operatingProfit','CFS']]);assert.ok(c.every(x=>!x.message));
});
test('제목에서 제시된 상반기 기간을 기업이 바뀌어도 공통 적용',()=>{
 const c=extractArticleClaims({article:'입력 2026.10.27\n올해 상반기 전선업계 실적\n대한전선 매출액은 100억원이다.\nLS전선 매출액은 200억원이다.'},['대한전선','LS전선']);
 assert.ok(c.every(x=>x.year===2026&&x.period==='half'&&x.basis==='CFS'&&!x.message));
});
test('과거 기사 올해·지난해는 현재 날짜보다 발행일을 우선',()=>{
 const c=extractArticleClaims({article:'입력 2024.08.01\n대한전선 올해 상반기 매출액은 100억원이다.\n지난해 영업이익은 10억원이다.'},['대한전선']);
 assert.deepEqual(c.map(x=>[x.year,x.period]),[[2024,'half'],[2023,'annual']]);
});
test('전망 지표와 같은 문장의 확정 실적을 각각 구분',()=>{
 const c=extractArticleClaims({article:'대한전선의 올해 3분기 영업이익은 100억원으로 예상되며, 지난해 매출액은 1000억원이다.'},['대한전선']);
 assert.match(c[0].message,/전망/);assert.equal(c[1].message,'');assert.equal(c[1].year,2025);
});
test('상반기 잔고와 지난해 말 잔고의 증감률은 서로 다른 기준일로 비교',()=>{
 const c=extractArticleClaims({article:'입력 2026.10.27\n대한전선의 올해 상반기 말 수주잔고는 4조629억원으로, 지난해 말 3조6633억원 대비 10.9% 증가했다.'},['대한전선']);
 assert.deepEqual(c.map(x=>[x.year,x.period]),[[2026,'half'],[2025,'annual'],[2026,'half']]);
 assert.deepEqual(c[2].comparison,{year:2025,period:'annual',mode:'cum'});assert.ok(c.every(x=>!x.message));
});
test('지표 앞의 예상·목표도 확정 실적으로 검증하지 않음',()=>{
 const c=extractArticleClaims({article:'대한전선 올해 3분기 예상 영업이익은 100억원이다.'},['대한전선']);assert.match(c[0].message,/전망/);
});
test('현금성자산·재고자산·매출채권을 별도 지표로 식별',()=>{
 const c=extractArticleClaims({article:'대한전선 올해 상반기 말 현금및현금성자산은 100억원, 재고자산은 200억원, 매출채권은 300억원이다.'},['대한전선']);
 assert.deepEqual(c.map(x=>x.metric),['현금및현금성자산','재고자산','매출채권']);assert.ok(c.every(x=>!x.message));
});

test('기사 수치의 연도 범위·순유출 부호·순차입금·운전자금 변동을 혼동하지 않음',()=>{
 const article='입력 2026.10.26\n대한전선 연결 기준 매출은 인수 연도인 2021년 1조9977억원에서 지난해 3조6360억원으로 늘었다. 같은 기간 영업이익은 395억원에서 1286억원으로 늘었다.\n올해 상반기 연결 영업활동현금흐름은 3180억원 순유출을 기록했다. 전년 같은 기간 유출액은 680억원이었다.\n상반기 재고자산 증가로 현금 2651억원이 소모됐고, 매입채무로 1309억원이 투입됐으며 매출채권은 622억원 늘었다.\n순차입금은 지난해 말 4666억원에서 지난 6월 말 7413억원으로 증가했다.';
 const c=extractArticleClaims({article},['대한전선']);
 const find=(text)=>c.find(x=>x.text===text);
 assert.deepEqual([find('395억원').year,find('1286억원').year],[2021,2025]);
 assert.deepEqual([find('3180억원').value,find('680억원').value],[-3180,-680]);
 assert.deepEqual([find('680억원').year,find('680억원').period],[2025,'half']);
 assert.deepEqual([find('4666억원').metric,find('7413억원').metric],['netDebt','netDebt']);
 assert.equal(find('1309억원').status,'UNVERIFIED');
 assert.match(find('2651억원').message,/운전자금 변동액/);
});
