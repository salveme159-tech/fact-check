import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBacklogDisclosure} from '../server/dart/articleBacklog.ts';
const entry=text=>[{name:'report.xml',text}];
const parse=(html,basis='CFS')=>parseBacklogDisclosure(entry(html),2026,'half',basis);
const table=(value='4,062,900',unit='백만원')=>`<P>연결 수주상황 (단위 : ${unit})</P><TABLE><TR><TD ROWSPAN="2">품목</TD><TD COLSPAN="2">수주잔고</TD></TR><TR><TD>수량</TD><TD>금액</TD></TR><TR><TD>합계</TD><TD>999</TD><TD>${value}</TD></TR></TABLE>`;
test('병합된 수주잔고 헤더의 수량 대신 금액 합계와 단위를 추출',()=>{
 const r=parse(table());assert.equal(r.value,40629);assert.match(r.excerpt,/백만원/);
});
test('천원·원·억원 단위를 억원으로 환산',()=>{
 for(const [v,u] of [['4,062,900,000','천원'],['4,062,900,000,000','원'],['40,629','억원']])assert.equal(parse(table(v,u)).value,40629);
});
test('수주총액·기납품액이 있어도 수주잔고 열만 읽음',()=>{
 const r=parse('<P>단위: 억원</P><TABLE><TR><TD>품목</TD><TD>수주총액 금액</TD><TD>기납품 금액</TD><TD>수주잔고 금액</TD></TR><TR><TD>합계</TD><TD>100</TD><TD>30</TD><TD>70</TD></TR></TABLE>');assert.equal(r.value,70);
});
test('확인되지 않은 단위·합계 없는 일부 품목을 전체 잔고로 간주하지 않음',()=>{
 assert.equal(parse(table().replace('단위 : 백만원','')),null);assert.equal(parse(table().replace('합계','전력선')),null);
});
test('서로 다른 범위의 잔고 합계가 있으면 한 값을 임의로 채택하지 않음',()=>{
 assert.equal(parse(table()+table('5,000,000')),null);
});
test('동일 값 중복 게재는 한 건으로 반환',()=>{
 assert.equal(parse(table()+table()).value,40629);
});
test('명시된 별도 표는 기본 연결 조회에 섞지 않음',()=>{
 const html=table().replace('연결','별도');assert.equal(parse(html),null);assert.equal(parse(html,'OFS').value,40629);
});
test('전기·당기 비교표에서 해당 연도와 월의 금액 열을 선택',()=>{
 const html='<P>단위: 억원</P><TABLE><TR><TD>구분</TD><TD>2025.12.31 수주잔고 금액</TD><TD>2026.06.30 수주잔고 금액</TD></TR><TR><TD>합계</TD><TD>36633</TD><TD>40629</TD></TR></TABLE>';
 assert.equal(parse(html).value,40629);
});
test('날짜 열과 수주잔고 행이 교차하는 세로 표도 지원',()=>{
 const html='<P>단위: 억원</P><TABLE><TR><TD>구분</TD><TD>2025.12.31</TD><TD>2026.06.30</TD></TR><TR><TE>수주잔고</TE><TD>36633</TD><TD>40629</TD></TR></TABLE>';
 assert.equal(parse(html).value,40629);
});
test('목표 시점과 다른 과거·연말 열은 사용하지 않음',()=>{
 const html='<P>단위: 억원</P><TABLE><TR><TD>구분</TD><TD>2026.12.31 수주잔고 금액</TD></TR><TR><TD>합계</TD><TD>40629</TD></TR></TABLE>';
 assert.equal(parse(html),null);
});
