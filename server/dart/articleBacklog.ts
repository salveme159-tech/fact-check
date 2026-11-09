/** 수주상황 표의 수주잔고 금액 열과 합계 행을 교차해 읽습니다. 수량 열·품목별 일부 값을 사용하지 않습니다. */
export type BacklogSource = { value:number; excerpt:string; scope:string };
const plain=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const compact=(s:string)=>plain(s).replace(/\s/g,'');
function grid(markup:string): string[][] {
  const rows:string[][]=[];
  for(const [i,tr] of [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].entries()){
    rows[i]??=[];let col=0;
    for(const cell of tr[1].matchAll(/<(td|th|te)\b([^>]*)>([\s\S]*?)<\/\1>/gi)){
      while(rows[i][col]!==undefined)col++;
      const span=(name:string)=>Math.min(50,Math.max(1,Number(cell[2].match(new RegExp(name+'\\s*=\\s*["\x27]?(\\d+)','i'))?.[1]??1)));
      const text=plain(cell[3]),rs=span('rowspan'),cs=span('colspan');
      for(let a=0;a<rs;a++){rows[i+a]??=[];for(let b=0;b<cs;b++)rows[i+a][col+b]=text;}
      col+=cs;
    }
  }
  return rows;
}
export function parseBacklogDisclosure(entries:Array<{name:string;text:string}>,year:number,period:'annual'|'half'|'q1'|'q3',basis:'CFS'|'OFS'):BacklogSource|null {
  const candidates:BacklogSource[]=[];
  const month={annual:12,half:6,q1:3,q3:9}[period];
  for(const entry of entries)for(const table of entry.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)){
    const at=table.index!;
    const lead=plain(entry.text.slice(Math.max(0,at-900),at));
    const scopeText=lead.slice(-250)+' '+plain(table[0]).slice(0,200);
    const scope=[...scopeText.matchAll(/연결|별도|개별/g)].at(-1)?.[0];
    if(scope && (scope==='연결'?'CFS':'OFS')!==basis)continue;
    if(!/수주\s*(?:잔고|잔액)/.test(plain(table[0])))continue;
    const unitText=lead+' '+plain(table[0]).slice(0,180);
    const units=[...unitText.matchAll(/단위\s*[:：]?\s*(백만\s*원|천\s*원|억\s*원|원)/g)];
    const unit=units.at(-1)?.[1].replace(/\s/g,'');
    const scale=({백만원:0.01,천원:0.00001,억원:1,원:1e-8} as Record<string,number>)[unit??''];
    if(!scale)continue;
    const rows=grid(table[0]);
    const totals=rows.map((r,i)=>({r,i})).filter(({r})=>r.slice(0,3).some(c=>/^(?:총합계|총계|합계|합계\(.*\)|수주잔고|수주잔액)$/.test(compact(c??''))));
    for(const {r,i} of totals){
      const headers=rows.slice(0,i).filter(row=>row.some(c=>/수주\s*(?:잔고|잔액)|금액|당기|전기|수량|20\d{2}/.test(c??'')) && !row.some(c=>/^\d[\d,]*$/.test((c??'').replace(/\s/g,''))));
      const backlogRow=r.slice(0,3).some(c=>/^(?:수주잔고|수주잔액)$/.test(compact(c??'')));
      const columns=r.map((cell,col)=>{
        const heading=[...new Set(headers.map(h=>h[col]??''))].join(' ');
        const text=compact(cell??'');
        return {heading,col,value:/^\(?[\d,]+(?:\.\d+)?\)?$/.test(text)?Number(text.replace(/[,()]/g,''))*(text.startsWith('(')?-1:1)*scale:null};
      }).filter(c=>c.value!==null && (backlogRow || /수주\s*(?:잔고|잔액)/.test(c.heading)) && !/수량|물량|길이|전기말|전년도|전년말/.test(c.heading));
      let selected=columns.filter(c=>/금액/.test(c.heading) || backlogRow && /당기|당반기|당분기|20\d{2}/.test(c.heading));
      if(!selected.length && columns.length===1) selected=columns;
      // 복수 연도/기간 열이 있으면 목표 시점 또는 당기 열만 선택합니다.
      if(selected.length>1){
        const exact=selected.filter(c=>new RegExp(`${year}\\s*[.년/-]\\s*0?${month}(?!\\d)`).test(c.heading));
        selected=exact.length?exact:selected.filter(c=>/당기|당반기|당분기|현재/.test(c.heading));
      }
      if(selected.length!==1)continue;
      const c=selected[0];
      // 명시된 다른 연도의 열은 단일 열이어도 거부합니다.
      const years=[...c.heading.matchAll(/20\d{2}/g)].map(m=>Number(m[0]));
      if(years.length && !years.includes(year))continue;
      const dates=[...c.heading.matchAll(/(20\d{2})\s*[.년/-]\s*(\d{1,2})(?:\s*월)?/g)];
      if(dates.length && !dates.some(m=>Number(m[1])===year && Number(m[2])===month))continue;
      candidates.push({value:c.value!,excerpt:`${year}년 ${month}월 말 · ${c.heading} · ${r.join(' | ')} (단위: ${unit})`,scope:scope?`${scope} 수주상황`:'공시 사업내용 > 수주상황(표 범위)'});
    }
  }
  // 같은 값을 반복 기재한 표는 허용하지만 서로 다른 합계/범위는 임의로 선택하지 않습니다.
  const unique=[...new Map(candidates.map(c=>[c.value.toFixed(8),c])).values()];
  return unique.length===1?unique[0]:null;
}
