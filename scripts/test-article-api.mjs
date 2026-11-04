// 실제 API 대신 고정된 OpenDART 형식의 응답을 주입하여 전체 검증 경로를 실행합니다.
// Node 22.18+ : node --test scripts/test-article-api.mjs
import {test,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
const hooks=registerHooks({
 resolve(specifier,context,next){
   if(specifier==='@trpc/server')return {url:'mock:trpc',shortCircuit:true};
   try{return next(specifier,context);}catch(e){if(specifier.startsWith('.')&&context.parentURL){const u=new URL(specifier+'.ts',context.parentURL);if(existsSync(u))return next(u.href,context);}throw e;}
 },
 load(url,context,next){if(url==='mock:trpc')return {source:'export class TRPCError extends Error {constructor(o){super(o.message);this.code=o.code;}}',format:'module',shortCircuit:true};return next(url,context);}
});
const {factCheckArticle}=await import('../server/dart/articleFactCheck.ts');
const {clearDartCaches,recentFilingsDart}=await import('../server/dart/client.ts');
const originalFetch=globalThis.fetch;
let fail=false,missingCfs=false,backlog=false,calls=[];
const receipt='20261027000001';
const baseInput={company:'대한전선',year:2025,period:'annual',mode:'cum',basis:'CFS',articleDate:'2026-10-27'};
const fakeKey='a'.repeat(40);
beforeEach(()=>{
 clearDartCaches();fail=false;missingCfs=false;backlog=false;calls=[];
 globalThis.fetch=async (url,init)=>{
  const u=new URL(url);calls.push({u,init});
  if(fail)throw new Error('simulated timeout');
  if(u.pathname.endsWith('corpCode.xml'))return new Response(readFileSync(new URL('./fixtures/corps.zip',import.meta.url)));
  if(u.pathname.endsWith('document.xml'))return new Response(readFileSync(new URL(backlog?'./fixtures/backlog.zip':'./fixtures/contract.zip',import.meta.url)));
  if(u.pathname.endsWith('list.json')&&backlog)return Response.json({status:'000',total_page:1,list:[{corp_name:'대한전선',corp_code:'00111111',rcept_no:receipt,rcept_dt:'20260814',report_nm:'반기보고서 (2026.06)'}]});
  if(u.pathname.endsWith('list.json'))return Response.json({status:'000',total_page:1,list:[{corp_name:'대한전선',corp_code:'00111111',rcept_no:receipt,rcept_dt:'20261027',report_nm:'단일판매ㆍ공급계약체결'}]});
  if(u.pathname.endsWith('fnlttSinglAcntAll.json')){
   if(missingCfs&&u.searchParams.get('fs_div')==='CFS')return Response.json({status:'013'});
   const y=Number(u.searchParams.get('bsns_year'));
   return Response.json({status:'000',list:[
    {rcept_no:receipt,sj_div:'IS',account_nm:'매출액',account_id:'ifrs-full_Revenue',thstrm_amount:String((y===2025?1000:800)*1e8),thstrm_add_amount:String((y===2025?2000:1600)*1e8)},
    {rcept_no:receipt,sj_div:'IS',account_nm:'영업이익',account_id:'dart_OperatingIncomeLoss',thstrm_amount:String((y===2025?100:80)*1e8),thstrm_add_amount:String((y===2025?200:160)*1e8)},
    {rcept_no:receipt,sj_div:'BS',account_nm:'현금및현금성자산',account_id:'ifrs-full_CashAndCashEquivalents',thstrm_amount:String(150*1e8)},
   ]});
  }
  throw new Error('unexpected network request: '+u.pathname);
 };
});
after(()=>{globalThis.fetch=originalFetch;hooks.deregister();});
test('실제 DART 클라이언트 경로에서 복수 지표 불일치와 공시값 반환',async()=>{
 const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 연결 매출액은 2,000억원, 영업이익은 999억원이다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.summary.mismatched,1);assert.equal(r.claims[1].actual,200);assert.ok(r.claims[1].sourceUrl.endsWith(receipt));
});
test('당분기 설정은 누계 수치와 구분',async()=>{
 const r=await factCheckArticle({...baseInput,period:'half',mode:'qtr',article:'대한전선 2025년 2분기 매출액은 1,000억원이다.'},fakeKey);
 assert.equal(r.claims[0].actual,1000);assert.equal(r.summary.matched,1);
});
test('연결 데이터 부재 시 별도로 바꾸어 오류 판정하지 않음',async()=>{
 missingCfs=true;
 const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 연결 매출액은 2,000억원이다.'},fakeKey);
 assert.equal(r.summary.unverified,1);assert.equal(r.claims[0].actual,null);
 assert.equal(calls.some(c=>c.u.searchParams.get('fs_div')==='OFS'),false);
});
test('전년 동기 증감률을 양쪽 공시로 산출',async()=>{
 const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 영업이익은 전년 동기 대비 25% 증가했다.'},fakeKey);
 assert.equal(r.claims[0].actual,25);assert.equal(r.summary.matched,1);
});
test('독일 수주 기사 10배 금액 오류를 실제 원문 ZIP에서 확인',async()=>{
 const r=await factCheckArticle({...baseInput,article:'대한전선, 독일 380kV 전력망 1조1,469억원 수주'},fakeKey);
 assert.equal(r.summary.mismatched,1);const c=r.claims.find(c=>c.metric==='contract');assert.equal(c.actual,1146.9);assert.equal(c.status,'MISMATCH');assert.equal(r.contractCandidates.length,1);
});
test('특정할 수 없는 계약을 금액 유사성으로 잘못 연결하지 않음',async()=>{
 const r=await factCheckArticle({...baseInput,article:'대한전선은 1,146억원 규모의 수주를 확보했다.'},fakeKey);
 assert.equal(r.summary.unverified,1);assert.equal(r.claims[0].actual,null);assert.equal(r.contractCandidates.length,1);
});
test('사용자가 선택한 동일 기업 공시로 계약금액 확인',async()=>{
 const r=await factCheckArticle({...baseInput,article:'대한전선은 1,146.9억원 규모의 수주를 확보했다.',contractReceipt:receipt},fakeKey);
 assert.equal(r.summary.matched,1);
});
test('공시 목록 연속 조회는 캐시를 우회해 매번 원천 요청',async()=>{
 await recentFilingsDart(['대한전선'],'20261027',fakeKey);await recentFilingsDart(['대한전선'],'20261027',fakeKey);
 const listCalls=calls.filter(c=>c.u.pathname.endsWith('list.json'));assert.equal(listCalls.length,2);assert.ok(listCalls.every(c=>c.init.cache==='no-store'));
});
test('API 장애는 틀린 금액으로 단정하지 않고 확인 필요',async()=>{
 // 기업 코드만 먼저 성공한 뒤 재무 API 오류를 주입
 const old=globalThis.fetch;globalThis.fetch=async(u,init)=>new URL(u).pathname.endsWith('corpCode.xml')?old(u,init):Promise.reject(new Error('offline'));
 const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 영업이익은 100억원이다.'},fakeKey);
 assert.equal(r.summary.unverified,1);assert.equal(r.summary.mismatched,0);
});
test('설정 없이 기사만으로 기업·실적 연도·연결 기준과 공시값 대조',async()=>{
 const r=await factCheckArticle({article:'입력 2026-10-27\n대한전선은 지난해 연결 매출액 2,000억원, 영업이익 999억원을 기록했다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.summary.mismatched,1);assert.equal(r.claims[0].year,2025);
});
test('기사만으로 2분기 별도 당분기 실적 자동 대조',async()=>{
 const r=await factCheckArticle({article:'대한전선 2025년 2분기 별도 매출액은 1,000억원이다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.claims[0].basis,'OFS');assert.equal(r.claims[0].mode,'qtr');
});
test('날짜가 포함된 수주 기사의 계약 원문과 금액 자동 대조',async()=>{
 const r=await factCheckArticle({article:'입력 2026.10.27\n대한전선, 독일 380kV 전력망 1조1,469억원 수주'},fakeKey);
 assert.equal(r.summary.mismatched,1);assert.equal(r.claims.find(x=>x.metric==='contract').actual,1146.9);
});
test('발행일 없는 지난해는 한국 현재 연도의 전년으로 조회',async()=>{
 const r=await factCheckArticle({article:'대한전선은 지난해 연결 매출액 100억원을 기록했다.'},fakeKey);
 assert.equal(r.summary.unverified,0);assert.equal(Number(calls.find(x=>x.u.pathname.endsWith('fnlttSinglAcntAll.json')).u.searchParams.get('bsns_year')),Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',year:'numeric'}).format(new Date()))-1);
});
test('회계 기준 없는 기사도 기본 연결 기준으로 공시값 대조',async()=>{
 const r=await factCheckArticle({article:'대한전선의 2025년 매출액은 999억원이다.'},fakeKey);
 assert.equal(r.summary.mismatched,1);assert.equal(r.claims[0].basis,'CFS');assert.equal(r.claims[0].actual,2000);
});

test('올해 상반기 말 수주잔고를 고정 보고서 ZIP의 합계 금액 열로 대조',async()=>{
 backlog=true;
 const r=await factCheckArticle({article:'입력 2026.10.27\n대한전선의 올해 상반기 말 수주잔고는 4조629억원이다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.claims[0].actual,40629);assert.match(r.claims[0].sourceLabel,/수주상황/);assert.ok(r.claims[0].sourceUrl.endsWith(receipt));
 const list=calls.find(x=>x.u.pathname.endsWith('list.json'));assert.equal(list.u.searchParams.get('bgn_de'),'20260101');
});
test('수주잔고 10배 오기는 확인 필요가 아니라 공시값과 불일치',async()=>{
 backlog=true;
 const r=await factCheckArticle({article:'입력 2026.10.27\n대한전선 올해 상반기 말 수주잔고는 40조6290억원이다.'},fakeKey);
 assert.equal(r.summary.mismatched,1);assert.equal(r.claims[0].actual,40629);
});

test('비상장 LS전선도 기사에서 자동 인식하고 기업코드로 조회',async()=>{
 const r=await factCheckArticle({article:'LS전선은 2025년 매출액 2000억원을 기록했다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.claims[0].company,'LS전선');
 assert.equal(calls.find(x=>x.u.pathname.endsWith('fnlttSinglAcntAll.json')).u.searchParams.get('corp_code'),'00222222');
});
test('상반기 말 현금성자산은 표준 재무상태표의 해당 계정으로 확인',async()=>{
 const r=await factCheckArticle({article:'대한전선의 2026년 상반기 말 현금및현금성자산은 150억원이다.'},fakeKey);
 assert.equal(r.summary.matched,1);assert.equal(r.claims[0].actual,150);
});
test('상반기와 전년 연간 금액을 나란히 쓴 증감률은 각 보고서로 대조',async()=>{
 const r=await factCheckArticle({article:'입력 2026.10.27\n대한전선 올해 상반기 영업이익은 160억원으로, 지난해 연간 영업이익 200억원 대비 20% 감소했다.'},fakeKey);
 assert.equal(r.summary.matched,3);assert.ok(Math.abs(r.claims[2].actual-20)<1e-9);
 const q=calls.filter(x=>x.u.pathname.endsWith('fnlttSinglAcntAll.json')).map(x=>[x.u.searchParams.get('bsns_year'),x.u.searchParams.get('reprt_code')]);
 assert.deepEqual(q,[['2026','11012'],['2025','11011']]);
});
test('영업손실로 쓴 기사와 영업이익 공시는 부호 불일치로 구분',async()=>{
  const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 연결 영업손실은 200억원이다.'},fakeKey);
  const c=r.claims[0];assert.equal(c.status,'MISMATCH');assert.equal(c.mismatchKind,'SIGN');assert.equal(c.valueText,'−200억원');assert.equal(c.actualText,'200억원');
});
test('결과에 기업별 요약과 날짜 해석이 포함',async()=>{
  const r=await factCheckArticle({...baseInput,article:'대한전선 2025년 연결 매출액은 2,000억원, 영업이익은 999억원이다. 지난해 기준이다.'},fakeKey);
  assert.deepEqual(r.companies.map(x=>[x.name,x.total,x.matched,x.mismatched]),[['대한전선',2,1,1]]);
  assert.ok(r.dates.some(d=>d.text==='2025년'&&d.resolved==='2025년'));assert.ok(r.dates.some(d=>d.text==='지난해'&&d.resolved==='2025년'));
  assert.equal(r.claims[0].companySource,'sentence');
});
