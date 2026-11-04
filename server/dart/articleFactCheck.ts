import { TRPCError } from '@trpc/server';
import type { FactCheckInput, FactCheckResult } from '../../shared/articleFactCheck';
import { extractArticleClaims, applyActual, parseContractAmount, resolveArticleInput, extractDateMentions } from './articleClaims';
import { financialFactSource, articleCompanyNames, recentFilingsDart, articleDisclosureEntries, articlePeriodDisclosure } from './client';
import { parseBacklogDisclosure } from './articleBacklog';
import type { FinancialMetric } from './engine';

export async function factCheckArticle(input: FactCheckInput, requestKey?: string): Promise<FactCheckResult> {
  const rawInput = input;
  const resolved = resolveArticleInput(input);
  const names = await articleCompanyNames(input.article, input.company ?? "", requestKey);
  const claims = extractArticleClaims({...rawInput,company:names.length===1?names[0]:input.company},names);
  if (claims.length > 100) throw new TRPCError({code:'BAD_REQUEST', message:'수치가 100개를 넘습니다. 기사를 나누어 확인해 주세요.'});
  const warnings: string[] = [];
  if(resolved.automatic && !resolved.dateDetected) warnings.push(`기사 발행일이 없어 한국 날짜 ${resolved.articleDate}을 기준으로 올해·지난해를 해석했습니다.`);
  if(!names.length) warnings.push('기사에서 DART 상장 기업명을 식별하지 못했습니다. 정확한 기업명이 포함된 원문을 넣어 주세요.');
  if(names.length>1) warnings.push(`기사에서 ${names.length}개 기업(${names.join(', ')})이 확인되어 수치마다 해당 기업을 따로 지정해 대조했습니다. ‘앞 문장에서 이어받음’으로 표시된 기업은 원문에서 확인하세요.`);
  const sources = new Map<string,ReturnType<typeof financialFactSource>>();
  // 같은 회사·기간·회계 기준의 재무제표는 한 번만 조회합니다. 동시 호출은 최대 3개입니다.
  const jobs = claims.filter(c=>!c.message && c.metric && c.metric !== 'contract');
  const backlogSources = new Map<string,Promise<null|{value:number;unit:string;url:string;citation:string}>>();
  for (let i=0; i<jobs.length; i+=3) await Promise.all(jobs.slice(i,i+3).map(async c=>{
    const fetchSource = (year:number,period=c.period,mode=c.mode) => {
      const cacheKey = `${c.company}:${year}:${period}:${mode}:${c.basis}:${c.metric}`;
      if (!sources.has(cacheKey)) sources.set(cacheKey, financialFactSource({company:c.company,year,kind:period,mode,basis:c.basis,metric:c.metric as FinancialMetric},requestKey));
      return sources.get(cacheKey)!;
    };
    try {
      const sourceFor = (year:number,period=c.period,mode=c.mode) => {
        if(c.metric!=='backlog')return fetchSource(year,period,mode);
        const cacheKey=`${c.company}:${year}:${period}:${c.basis}`;
        if(!backlogSources.has(cacheKey))backlogSources.set(cacheKey,articlePeriodDisclosure({company:c.company,year,kind:period,basis:c.basis},requestKey).then(report=>{
          if(!report)return null;
          const parsed=parseBacklogDisclosure(report.entries,year,period,c.basis);
          return parsed?{value:parsed.value,unit:'억원',url:report.url,citation:`${report.citation} · ${parsed.scope} · ${parsed.excerpt}`}:null;
        }));
        return backlogSources.get(cacheKey)!;
      };
      const source = await sourceFor(c.year);
      if (!source || source.value === null || !Number.isFinite(source.value)) { c.message=c.metric==='backlog'?'해당 기간 보고서의 수주상황에서 단위·금액 열·합계가 명확한 수주잔고를 확인하지 못했습니다.':'동일 기간·회계 기준의 DART 원천 계정을 확인하지 못했습니다.'; return; }
      let actual = source.value;
      c.sourceUrl=source.url; c.sourceLabel=source.citation;
      if (c.growth) {
        const prior=await sourceFor(c.comparison?.year??c.year-1,c.comparison?.period??c.period,c.comparison?.mode??c.mode);
        if (!prior || prior.value === null || prior.value <= 0) { c.message='전년 동기 공시값이 없거나 0 이하이므로 증감률을 자동 판정하지 않았습니다.'; return; }
        if (!c.comparison && !/전년|작년|지난해|동기/.test(c.sentence)) { c.message='증감률의 비교 기준(전년 동기 등)을 확인해 주세요.'; return; }
        actual=(actual/prior.value-1)*100*(c.growth==='decrease'?-1:1);
        c.sourceLabel+=` / 전년 동기 ${prior.citation}`;
      } else if (source.unit !== c.unit) { c.message=`기사 단위(${c.unit})와 공시 단위(${source.unit})가 달라 비교를 보류했습니다.`; return; }
      applyActual(c,actual);
    } catch { c.message='DART 조회에 실패했습니다. 인증키·호출 한도·네트워크를 확인해 주세요.'; }
  }));
  const contractClaims=claims.filter(c=>c.metric==='contract' && !c.message);
  let contractCandidates: FactCheckResult['contractCandidates']=[];
  if (contractClaims.length) {
    try {
      const end=new Date(`${resolved.articleDate}T00:00:00+09:00`);
      const from=new Date(end.getTime()-90*86400_000).toISOString().slice(0,10).replace(/-/g,'');
      const list=await recentFilingsDart([...new Set(contractClaims.map(c=>c.company))],from,requestKey,resolved.articleDate.replace(/-/g,''));
      warnings.push(...list.warnings);
      contractCandidates=list.rows.filter(r=>/단일판매|공급계약/.test(r.reportName)).slice(0,30);
      // 근거 공시는 금액의 유사성으로 선택하지 않습니다. 사용자가 고르거나 지역·전압이 유일하게 일치해야 합니다.
      const documents=new Map<string,Promise<{text:string;amount:ReturnType<typeof parseContractAmount>}>>();
      const document=(receipt:string)=>{
        if (!documents.has(receipt)) documents.set(receipt,articleDisclosureEntries(receipt,requestKey).then(entries=>({text:entries.map(e=>e.text.replace(/<[^>]+>/g,' ')).join(' '),amount:entries.map(e=>parseContractAmount(e.text)).find(Boolean)??null})));
        return documents.get(receipt)!;
      };
      for (const c of contractClaims) {
        const candidates=contractCandidates.filter(r=>r.company===c.company);
        let selected=candidates.find(r=>r.rceptNo===input.contractReceipt);
        if (!selected && !input.contractReceipt) {
          const anchors=[...new Set(c.sentence.match(/독일|덴마크|영국|싱가포르|미국|캐나다|호주|네덜란드|프랑스|\d{2,3}\s*kV/gi)??[])];
          const matches=[];
          if (anchors.length) for (const candidate of candidates.slice(0,5)) {
            const doc=await document(candidate.rceptNo);
            if (anchors.every(a=>doc.text.replace(/\s/g,'').toLowerCase().includes(a.replace(/\s/g,'').toLowerCase()))) matches.push(candidate);
          }
          // 후보가 잘렸다면 유일성 판단을 하지 않습니다.
          if (matches.length===1 && candidates.length<=5 && contractCandidates.length<30) selected=matches[0];
        }
        if (!selected) { c.message='동일 사업의 계약 공시를 특정하지 못했습니다. 아래 후보에서 해당 공시를 선택해 다시 확인해 주세요.'; continue; }
        const doc=await document(selected.rceptNo);
        const scopeAnchors=[...new Set(c.sentence.match(/독일|덴마크|영국|싱가포르|미국|캐나다|호주|네덜란드|프랑스|\d{2,3}\s*kV/gi)??[])];
        if(scopeAnchors.some(a=>!doc.text.replace(/\s/g,'').toLowerCase().includes(a.replace(/\s/g,'').toLowerCase()))) {c.message='기사의 사업 지역·전압과 선택한 계약 원문이 일치하지 않습니다. 해당 사업 공시를 선택해 주세요.';continue;}
        c.sourceUrl=selected.url; c.sourceLabel=`${selected.company} · ${selected.receiptDate} · ${selected.reportName}`;
        if (!doc.amount) { c.message='선택한 계약 원문에서 단위와 확정 금액이 명확한 행을 추출하지 못했습니다. 원문을 확인해 주세요.'; continue; }
        if (/전체|총사업|누적|잔고/.test(c.sentence)) { c.message='기사 금액과 개별 공시 계약금액의 범위가 같은지 확인이 필요합니다.'; continue; }
        c.basisLabel=`${selected.company} · 개별 계약 공시 · ${selected.receiptDate}`;
        applyActual(c,doc.amount.value);
        c.sourceLabel+=` · ${doc.amount.excerpt}`;
      }
    } catch { warnings.push('계약 공시 조회에 실패했습니다. 인증키·호출 한도·네트워크를 확인해 주세요.'); contractClaims.forEach(c=>{if(!c.message)c.message='계약 공시 원문을 확인하지 못했습니다.';}); }
  }
  const companyMap=new Map<string,{name:string;total:number;matched:number;mismatched:number;unverified:number}>();
  for(const c of claims){const key=c.company||'기업 미확인';const row=companyMap.get(key)??{name:key,total:0,matched:0,mismatched:0,unverified:0};row.total++;if(c.status==='MATCH')row.matched++;else if(c.status==='MISMATCH')row.mismatched++;else row.unverified++;companyMap.set(key,row);}
  // 기사에 등장했지만 수치가 없는 기업도 목록에 남겨 누락을 눈으로 확인할 수 있게 합니다.
  for(const n of names)if(!companyMap.has(n))companyMap.set(n,{name:n,total:0,matched:0,mismatched:0,unverified:0});
  return {article:input.article,claims,companies:[...companyMap.values()],dates:extractDateMentions(input.article,resolved.articleDate),checkedAt:new Date().toISOString(),summary:{matched:claims.filter(c=>c.status==='MATCH').length,mismatched:claims.filter(c=>c.status==='MISMATCH').length,unverified:claims.filter(c=>c.status==='UNVERIFIED').length},contractCandidates,warnings};
}
