import type { FactCheckInput, ResolvedFactCheckInput, FactClaim, ClaimSign, CompanySource, DateMention, MismatchKind } from '../../shared/articleFactCheck';

const metrics: Array<[RegExp, string, string]> = [
  [/순차입금/g, 'netDebt', '순차입금'], [/총차입금|(?<!순)차입금(?!의존도)/g, 'borrowings', '차입금'],
  [/차입금\s*의존도/g, 'borrowingsRatio', '차입금의존도'], [/영업이익률|영업마진/g, 'operatingMargin', '영업이익률'],
  [/순이익률/g, 'netMargin', '순이익률'], [/영업이익(?!률)|영업익|영업손실|영업적자/g, 'operatingProfit', '영업이익'],
  [/당기순이익(?!률)|순이익(?!률)|순익|당기순손실|순손실|순적자/g, 'netIncome', '순이익'],
  [/매출액|매출(?!채권|원가|총이익|비중|성장|대비)/g, 'revenue', '매출액'],
  [/부채비율/g, 'debtRatio', '부채비율'], [/유동비율/g, 'currentRatio', '유동비율'],
  [/영업(?:활동)?\s*현금흐름/g, 'operatingCashFlow', '영업현금흐름'], [/잉여현금흐름|FCF/gi, 'freeCashFlow', 'FCF'],
  [/설비투자|CAPEX/gi, 'capex', 'CAPEX'], [/EBITDA/gi, 'ebitda', 'EBITDA'],
  [/현금\s*(?:및|과)\s*현금성자산|현금성자산/g, '현금및현금성자산', '현금및현금성자산'],
  [/매출채권/g,'매출채권','매출채권'], [/재고자산/g,'재고자산','재고자산'],
  [/비유동자산/g,'비유동자산','비유동자산'], [/유동자산/g,'유동자산','유동자산'],
  [/비유동부채/g,'비유동부채','비유동부채'], [/유동부채/g,'유동부채','유동부채'],
  [/자산총계|총자산/g, '자산총계', '자산총계'], [/부채총계|총부채/g, '부채총계', '부채총계'],
  [/자본총계|총자본/g, '자본총계', '자본총계'], [/수주\s*잔고|수주\s*잔액/g, 'backlog', '수주잔고'],
  [/수주(?:액|고|금액|규모)?|계약(?:금액|규모)|자재\s*공급(?:액|금액|규모)?/g, 'contract', '계약금액'],
];
const number = '(?:(?<![\\d.])[+\\-−△])?[\\d,]+(?:\\.\\d+)?';
const numericPattern = new RegExp(`(?=[+\\-−△]?\\d)(?:${number}\\s*조\\s*)?(?:${number}\\s*억\\s*)?(?:${number}\\s*만\\s*)?(?:${number}\\s*천\\s*)?(?:${number}\\s*)?원|${number}\\s*(?:%p|%|퍼센트|kV|km|GW|MW|명|척|개)`, 'gi');
export function koreanAmount(text: string): number | null {
  if (!/원\s*$/.test(text)) return null;
  const clean = text.replace(/,/g, '').replace(/\s/g, '').replace(/[−△]/g, '-');
  const unsigned = clean.replace(/^[+-]/, "");
  let value = 0;
  for (const m of unsigned.matchAll(/([+-]?\d+(?:\.\d+)?)(조|억|만|천|원)/g)) {
    value += Number(m[1]) * ({조: 1e12, 억: 1e8, 만: 1e4, 천: 1e3, 원: 1}[m[2]] ?? 1);
  }
  return Number.isFinite(value) ? (/^-/.test(clean) ? -Math.abs(value) : value) / 1e8 : null;
}
const periodNames = { annual: '연간', half: '상반기', q1: '1분기', q3: '3분기' };
export function claimBasis(c: Pick<FactClaim, 'company'|'year'|'period'|'mode'|'basis'>) {
  return `${c.company} · ${c.year}년 ${periodNames[c.period]} · ${c.mode === 'qtr' ? '당분기' : '누계/기말'} · ${c.basis === 'CFS' ? '연결' : '별도'}`;
}
/** 발행일이 있으면 발행일, 없으면 한국 현재 날짜를 상대 날짜의 기준으로 사용합니다. */
export function resolveArticleInput(input: FactCheckInput): ResolvedFactCheckInput {
  const pattern = /(?<!\d)(20\d{2})\s*(?:[.\/-]|년)\s*(\d{1,2})\s*(?:[.\/-]|월)\s*(\d{1,2})(?:\s*일)?(?!\d)/g;
  const dates = [...input.article.matchAll(pattern)].flatMap(m => {
    const date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    const stamp = Date.parse(date);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === date ? [{date, at:m.index!, marked:/입력|등록|발행|수정|송고/.test(input.article.slice(Math.max(0,m.index!-12),m.index!))}] : [];
  });
  // 발행일 표시를 우선 사용합니다. 표지가 없는 복수 날짜는 기준일로 단정하지 않습니다.
  const marked=dates.filter(d=>d.marked);
  const date=input.articleDate || (marked.length ? marked[0].date : new Set(dates.map(d=>d.date)).size===1 ? dates[0]?.date : undefined);
  const referenceDate=date??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return {...input, company:input.company??'',year:input.year??Number(referenceDate.slice(0,4)),period:input.period??'annual',mode:input.mode??'cum',basis:input.basis??'CFS',articleDate:referenceDate,automatic:input.year===undefined && input.period===undefined && input.basis===undefined,dateDetected:!!date};
}

const PROFIT_LIKE = new Set(['operatingProfit','netIncome','ebitda','freeCashFlow','operatingCashFlow']);
const JOSA = '(?:은|는|이|가|을|를|의|로|인|만|도)?';
/** 기사에 적힌 부호(−, △, 적자·손실·순유출 / 흑자·순유입)를 값에 반영하고 그 근거를 반환합니다. 부호를 추정하지 않고 명시된 표현만 사용합니다. */
export function detectSign(a:{raw:string;value:number;money:boolean;growth?:string;hitText?:string;metric?:string;paragraph:string;pos:number;windowStart:number;windowEnd:number}): {value:number;sign:ClaimSign;evidence?:string} {
  const {raw,paragraph,pos}=a;
  const isPercent=/%|퍼센트/.test(raw);
  if (a.growth || (!a.money && !isPercent)) return {value:a.value,sign:'unsigned'};
  const explicit=raw.match(/^[+\-−△]/)?.[0];
  if (explicit) return explicit==='+' ? {value:Math.abs(a.value),sign:'positive',evidence:'‘+’ 표기'} : {value:-Math.abs(a.value),sign:'negative',evidence:`‘${explicit}’ 표기`};
  const profitLike=!!a.metric && PROFIT_LIKE.has(a.metric);
  const hitNeg=!!a.hitText && /손실|적자/.test(a.hitText);
  if (!profitLike && !hitNeg) return {value:a.value,sign:'unsigned'};
  const before=paragraph.slice(Math.max(a.windowStart,pos-20),pos);
  const after=paragraph.slice(pos+raw.length,Math.min(a.windowEnd,pos+raw.length+8));
  const posWord=before.match(new RegExp(`(흑자|순유입|현금\\s*유입)\\s*(?:규모|폭|액)?\\s*${JOSA}\\s*(?:약|총)?\\s*$`))?.[1] ?? after.match(/^\s*(?:의\s*)?(흑자|순유입)/)?.[1];
  if (posWord) return {value:Math.abs(a.value),sign:'positive',evidence:`‘${posWord}’ 표현`};
  const negWord=before.match(new RegExp(`(적자|손실|마이너스|순유출|유출액|현금\\s*유출)\\s*(?:규모|폭|액)?\\s*${JOSA}\\s*(?:약|총)?\\s*$`))?.[1] ?? after.match(/^\s*(?:의\s*)?(적자|손실|마이너스|순유출)/)?.[1] ?? (hitNeg ? a.hitText!.match(/손실|적자/)![0] : undefined);
  if (negWord) return {value:-Math.abs(a.value),sign:'negative',evidence:`‘${negWord}’ 표현`};
  return {value:a.value,sign:'unsigned'};
}
/** 부호를 명시한 표기. 음수는 −, 증감률은 방향을 함께 적습니다. */
export function signedText(value:number, unit:string, growth?:'increase'|'decrease'): string {
  const digits=Math.abs(value).toLocaleString('ko-KR',{maximumFractionDigits:4});
  if (growth) return `${digits}${unit} ${growth==='decrease'?'감소(−)':'증가(+)'}`;
  return `${value<0?'−':''}${digits}${unit}`;
}
const MONTH_RANGE: Record<string,string> = {'상반기':'1~6월','하반기':'7~12월','1분기':'1~3월','2분기':'4~6월','3분기':'7~9월','4분기':'10~12월'};
/** 기사의 날짜·기간 표현을 찾아 해석 결과와 함께 돌려줍니다(원문에서 수치와 구분해 표시하기 위한 용도). */
export function extractDateMentions(article:string, articleDate:string): DateMention[] {
  const ay=Number(articleDate.slice(0,4)), am=articleDate.slice(5,7);
  const re=/(?<!\d)(20\d{2})\s*(?:[.\/-]|년)\s*(\d{1,2})\s*(?:[.\/-]|월)\s*(\d{1,2})\s*일?(?!\d)|(?<!\d)(20\d{2})\s*년\s*(\d{1,2})\s*월(?:\s*말)?|(?<!\d)(20\d{2})\s*년\s*(상반기|하반기|[1-4]\s*분기)|(?<!\d)(20\d{2})\s*년(?!\s*\d)|지난\s*(\d{1,2})\s*월\s*말|(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일|(?<!\d)(\d{1,2})\s*월\s*말|지난\s*(\d{1,2})\s*일|(?<!\d)(\d{1,2})\s*일(?=\s*(?:공시|체결|발표|계약|밝혔|수주))|재작년|지난해|작년|올해|내년|전년\s*(?:동기|같은\s*기간)|지난해\s*(?:동기|같은\s*기간)|(상반기|하반기|[1-4]\s*분기|[1-4]Q)/g;
  const pad=(n:string)=>n.padStart(2,'0');
  const out:DateMention[]=[];
  for (const m of article.matchAll(re)) {
    const t=m[0]; let resolved='';
    if (m[1]) resolved=`${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    else if (m[4]) resolved=/말/.test(t)?`${m[4]}년 ${m[5]}월 말`:`${m[4]}년 ${m[5]}월`;
    else if (m[6]) { const k=m[7].replace(/\s/g,''); resolved=`${m[6]}년 ${k} (${MONTH_RANGE[k]})`; }
    else if (m[8]) resolved=`${m[8]}년`;
    else if (m[9]) resolved=`${ay}년 ${m[9]}월 말 (기사 기준일 연도 기준)`;
    else if (m[10]) resolved=`${ay}-${pad(m[10])}-${pad(m[11])} (기사 기준일 연도 가정)`;
    else if (m[12]) resolved=`${ay}년 ${m[12]}월 말 (기사 기준일 연도 가정)`;
    else if (m[13]||m[14]) resolved=`${ay}-${am}-${pad(m[13]||m[14])} (기사 기준월 가정)`;
    else if (m[15]) { const k=m[15].replace(/\s/g,'').replace(/^([1-4])Q$/i,'$1분기'); resolved=MONTH_RANGE[k]?`${k} (${MONTH_RANGE[k]})`:k; }
    else if (/재작년/.test(t)) resolved=`${ay-2}년`;
    else if (/^(?:지난해|작년)$/.test(t)) resolved=`${ay-1}년`;
    else if (t==='올해') resolved=`${ay}년`;
    else if (t==='내년') resolved=`${ay+1}년`;
    else resolved='비교 기준 기간의 1년 전';
    out.push({start:m.index!,end:m.index!+t.length,text:t,resolved:/^20\d{2}-\d{2}-\d{2}$/.test(resolved)||/기준|가정|\(/.test(resolved)||/^\d{4}년/.test(resolved)||resolved.startsWith('비교')?resolved:resolved});
  }
  return out;
}

export function extractArticleClaims(rawInput: FactCheckInput, companyNames: string[]): FactClaim[] {
  const input = resolveArticleInput(rawInput);
  const claims: FactClaim[] = [];
  // 첫 수치 앞의 제목·도입부를 기사 공통 실적 기준으로 삼고, 각 수치의 명시 기준을 우선합니다.
  const lead=input.article.slice(0,[...input.article.matchAll(numericPattern)][0]?.index??input.article.length);
  const topicPeriod=[...lead.matchAll(/연간|상반기|반기|[1234]\s*분기|[13]Q|[369]\s*월\s*말/gi)].at(-1)?.[0].replace(/\s/g,'');
  const topicYear=[...lead.matchAll(/(20\d{2})\s*년(?!\s*\d{1,2}\s*월)|지난해(?!\s*(?:동기|대비))|작년(?!\s*(?:동기|대비))|전년(?!\s*(?:대비|동기))|올해|지난\s*[369]\s*월\s*말/g)].at(-1);
  const baseYear=topicYear ? topicYear[1]?Number(topicYear[1]):Number(input.articleDate.slice(0,4))-(/지난해|작년/.test(topicYear[0])?1:0) : input.year;
  const basePeriod: FactClaim['period']=topicPeriod?/상반기|^반기$|2분기|6월말/.test(topicPeriod)?'half':/1분기|1Q|3월말/i.test(topicPeriod)?'q1':/3분기|3Q|9월말/i.test(topicPeriod)?'q3':'annual':input.period;
  const baseMode=/누적|누계/.test(lead)?'cum':/2분기|3분기|3Q/i.test(topicPeriod??'')?'qtr':input.mode;
  const baseBasis: 'CFS'|'OFS'=/별도|개별/.test(lead)?'OFS':input.basis;
  if(input.automatic){input.year=baseYear;input.period=basePeriod;input.mode=baseMode;input.basis=baseBasis;}
  let lastMetric: {metric:string;label:string;text:string;at:number;end:number;year?:number;period?:FactClaim['period'];mode?:FactClaim['mode'];basis?:FactClaim['basis']}|undefined;
  let comparisonRangeYears: [number,number] | undefined;
  let inheritedCompany = input.company, inheritedYear = input.year, inheritedPeriod = input.period, inheritedMode = input.mode, inheritedBasis = input.basis;
  let knownYear = input.year > 0, knownPeriod = !input.automatic || !!topicPeriod || !!topicYear, knownBasis = true;
  // 문장 경계에서 소수점과 천 단위 쉼표를 보존합니다.
  const segments = input.article.matchAll(/[^\n!?。]+?(?:[!?。]|\n|(?<=[다요])\.(?=\s|$)|$)/g);
  for (const segment of segments) {
    const paragraph = segment[0];
    const base = segment.index!;
    const companyHits = companyNames.flatMap(name => [...paragraph.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'))].map(m => ({at:m.index!, name})))
      .filter(hit => !companyNames.some(other => other.length > hit.name.length && paragraph.slice(hit.at).startsWith(other))).sort((a,b)=>a.at-b.at);
    // 비교 대상(‘LS전선보다’, ‘LS전선 대비’)은 문장의 주어가 아니므로 수치의 소유 기업에서 제외합니다.
    const isComparator=(h:{at:number;name:string})=>/^(?:\s*\([^)]{0,40}\))?\s*(?:보다|대비|와\s*비교|과\s*비교|에\s*비해|를\s*제치|을\s*제치)/.test(paragraph.slice(h.at+h.name.length,h.at+h.name.length+50));
    // ‘LS전선(2조원)’처럼 기업명 바로 뒤 괄호 안의 수치는 그 기업의 수치입니다.
    const parenOwner=(p:number)=>companyHits.find(h=>{const m=paragraph.slice(h.at+h.name.length).match(/^\s*\(([^)]{0,40})\)/);return !!m && p>h.at+h.name.length && p<h.at+h.name.length+m[0].length;});
    const ownerAt=(p:number)=>parenOwner(p)??companyHits.filter(h=>h.at<=p && !isComparator(h)).at(-1);
    if (input.automatic && companyHits.length && companyHits[0].name !== inheritedCompany) {
      inheritedYear=input.year; inheritedPeriod=input.period; inheritedMode=input.mode; inheritedBasis=input.basis;
      knownYear=true; knownPeriod=!!topicPeriod || !!topicYear; knownBasis=true;
    }
    // 제목이나 앞 문장에서 제시한 기준도 다음 수치에 적용합니다.
    const updateContext = (text:string) => {
      const y=[...text.matchAll(/(20\d{2})\s*년(?!\s*\d{1,2}\s*월)|지난해(?!\s*(?:동기|대비))|작년(?!\s*(?:동기|대비))|전년(?!\s*(?:대비|동기))|올해|지난\s*[369]\s*월\s*말/g)].at(-1);
      if(y){ inheritedYear=y[1]?Number(y[1]):Number(input.articleDate.slice(0,4))-(/지난해|작년/.test(y[0])?1:0); knownYear=inheritedYear>0; if(!knownPeriod || /(?:지난해|작년|올해|20\d{2}\s*년)\s*(?:말|연말|전체|연간)/.test(text)){inheritedPeriod='annual';inheritedMode='cum';knownPeriod=true;} }
      const p=[...text.matchAll(/연간|상반기|반기|[1234]\s*분기|[13]Q|하반기|[369]\s*월\s*말/gi)].filter(m=>!y||m.index!>=y.index!).at(-1)?.[0].replace(/\s/g,'');
      if(y&&!p){inheritedPeriod='annual';inheritedMode='cum';knownPeriod=true;}
      if(p){ inheritedPeriod=/연간/.test(p)?'annual':/상반기|^반기$|2분기|6월말/.test(p)?'half':/1분기|1Q|3월말/i.test(p)?'q1':/3분기|3Q|9월말/i.test(p)?'q3':'annual'; inheritedMode=/누적|누계/.test(text)?'cum':/2분기|3분기|3Q/i.test(p)?'qtr':'cum'; knownPeriod=!/4분기|하반기/.test(p); }
      const b=[...text.matchAll(/연결|별도|개별/g)].at(-1)?.[0];
      if(b){inheritedBasis=b==='연결'?'CFS':'OFS';knownBasis=true;}
    };
    const metricHits = metrics.flatMap(([pattern, metric, label]) => [...paragraph.matchAll(new RegExp(pattern))].map(m => ({at:m.index!, end:m.index!+m[0].length, metric, label, text:m[0]})))
      .filter(hit => !metrics.some(([pattern]) => [...paragraph.matchAll(new RegExp(pattern))].some(m => m.index! <= hit.at && m.index!+m[0].length > hit.end)))
      .sort((a,b)=>a.at-b.at);
    const nums = [...paragraph.matchAll(numericPattern)];
    for (const m of nums) {
      const pos = m.index!, raw = m[0];
      // 계약·매출 금액, 비율, 물리량을 모두 보존하되 지원하지 않는 항목은 확인 필요로 남깁니다.
      const lastClause=[...paragraph.slice(0,pos).matchAll(/,(?!\d)|또한|그리고|반면|한편|그러나/g)].at(-1);
      const clauseStart=lastClause ? lastClause.index!+lastClause[0].length : 0;
      let hit = metricHits.filter(h => h.end <= pos && h.at >= clauseStart).at(-1);
      if (!hit) hit = metricHits.find(h => {
        if (h.at < pos + raw.length || nums.some(n => n.index! > pos && n.index! < h.at)) return false;
        const between=paragraph.slice(pos+raw.length,h.at).trim();
        return /^(?:의|인|규모의|수준의|가량의|에 달하는|정도의)?$/.test(between) || (h.metric==='contract' && between.length<=3);
      });
      if(!hit && lastMetric && !/원$/.test(raw) && /이는|전년|지난해|작년|올해|동기/.test(paragraph)) hit=lastMetric;
      if(!hit && lastMetric?.metric==='operatingCashFlow' && /유출액|순유출|현금 유출/.test(paragraph.slice(0,pos+raw.length))) hit=lastMetric;
      if(!hit && lastMetric?.metric==='backlog' && /(?:작년|지난해|전년)\s*말/.test(paragraph)) hit=lastMetric;
      if(!hit && lastMetric?.metric==='borrowings' && /빌리고|차입이 늘|갚는/.test(paragraph.slice(0,pos+raw.length))) hit=lastMetric;
      const respectively = paragraph.indexOf('각각');
      let ambiguousParallel = false;
      let parallelCompany: string | undefined;
      if (respectively >= 0 && pos > respectively) {
        const ordered = metricHits.filter(h=>h.end<=respectively);
        const sameUnit = nums.filter(n=>n.index!>respectively && (/원$/.test(n[0]) === /원$/.test(raw)));
        // ‘영업이익은 각각 X, Y’처럼 지표가 하나면 쉼표 뒤 수치에도 같은 지표를 적용합니다.
        if (ordered.length === 1 && !hit) hit=ordered[0];
        if (ordered.length > 1) {
          if (ordered.length === sameUnit.length) hit=ordered[sameUnit.indexOf(m)];
          else ambiguousParallel=true;
        }
        // ‘A와 B의 영업이익은 각각 X, Y’: 기업 순서대로 수치를 대응시킵니다. 지표도 여러 개면 대응을 확정하지 않습니다.
        const compBefore=companyHits.filter(h=>h.at<respectively && !isComparator(h));
        const distinctCompanies=compBefore.filter((h,i)=>i===0||h.name!==compBefore[i-1].name);
        if (distinctCompanies.length > 1) {
          if (ordered.length<=1 && sameUnit.length===distinctCompanies.length) parallelCompany=distinctCompanies[sameUnit.indexOf(m)].name;
          else ambiguousParallel=true;
        }
      }
      const currentCompanyHit=ownerAt(pos);
      const effectiveCompany=parallelCompany??currentCompanyHit?.name;
      const contextStart=!parallelCompany && input.automatic && currentCompanyHit && companyHits.findIndex(h=>h===currentCompanyHit)>0 ? currentCompanyHit.at : 0;
      if(input.automatic) {
        if(effectiveCompany && effectiveCompany!==inheritedCompany){
          inheritedCompany=effectiveCompany; inheritedYear=input.year; inheritedPeriod=input.period; inheritedMode=input.mode; inheritedBasis=input.basis;
          knownYear=true; knownPeriod=!!topicPeriod || !!topicYear; knownBasis=true;
        }
        updateContext(paragraph.slice(contextStart,pos));
        // 금액 뒤의 "연결 기준"도 인식하되 다른 지표·수치·기업까지 넘지 않습니다.
        const nextBoundary=Math.min(...[...nums.filter(n=>n.index!>pos).map(n=>n.index!),...metricHits.filter(h=>h.at>pos).map(h=>h.at),...companyHits.filter(h=>h.at>pos).map(h=>h.at),paragraph.length]);
        const suffix=paragraph.slice(pos+raw.length,nextBoundary);
        const trailingBasis=suffix.match(/(연결|별도|개별)\s*기준/);
        if(trailingBasis){inheritedBasis=trailingBasis[1]==='연결'?'CFS':'OFS';knownBasis=true;}
      }
      const prefix = paragraph.slice(0, pos);
      const localStart = contextStart;
      const clauseBoundary=[...paragraph.slice(0,hit?.at??pos).matchAll(/,(?!\d)|;|반면|한편|그러나/g)].at(-1);
      const local = paragraph.slice(Math.max(localStart,clauseBoundary?clauseBoundary.index!+clauseBoundary[0].length:localStart), metricHits.find(h=>h.at>pos)?.at??paragraph.length);
      const before = paragraph.slice(localStart, pos);
      const years = [...before.matchAll(/(20\d{2})\s*년(?!\s*\d{1,2}\s*월)|지난해(?!\s*(?:동기|대비))|작년(?!\s*(?:동기|대비))|전년(?!\s*(?:대비|동기))|올해|지난\s*[369]\s*월\s*말/g)];
      const yearMatch = years.at(-1);
      const articleYear = Number(input.articleDate.slice(0,4));
      let year = yearMatch ? yearMatch[1] ? Number(yearMatch[1]) : /지난해|작년|전년/.test(yearMatch[0]) ? articleYear-1 : articleYear : inheritedYear;
      if(input.automatic && !yearMatch && /상반기|반기|올해/.test(before) && !/지난해|작년|전년/.test(before)) year=articleYear;
      if (/같은 기간/.test(before) && comparisonRangeYears && metricHits.some(h=>['revenue','operatingProfit','netIncome','backlog'].includes(h.metric))) {
        const moneyNums=[...paragraph.matchAll(numericPattern)].filter(n=>/원$/.test(n[0]));
        const idx=moneyNums.findIndex(n=>n.index===pos);
        if(idx===0) year=comparisonRangeYears[0]; else if(idx===1) year=comparisonRangeYears[1];
      }
      const periods = [...before.matchAll(/연간|상반기|반기|[1234]\s*분기|[13]Q|하반기|[369]\s*월\s*말/gi)].filter(m=>!yearMatch||m.index!>=yearMatch.index!);
      const p = periods.at(-1)?.[0].replace(/\s/g,'');
      let period: FactClaim['period'] = p ? /연간/.test(p) ? 'annual' : /상반기|^반기$|2분기|6월말/.test(p) ? 'half' : /1분기|1Q|3월말/i.test(p) ? 'q1' : /3분기|3Q|9월말/i.test(p) ? 'q3' : inheritedPeriod : inheritedPeriod;
      if(/전년\s*(?:같은 기간|동기)|지난해\s*(?:같은 기간|동기)/.test(before) && lastMetric?.period) period=lastMetric.period;
      let mode: FactClaim['mode'] = /누적|누계/.test(before + paragraph.slice(pos+raw.length,pos+raw.length+12)) ? 'cum' : /2분기|3분기|3Q/i.test(p ?? '') ? 'qtr' : p ? 'cum' : inheritedMode;
      if(/전년\s*(?:같은 기간|동기)|지난해\s*(?:같은 기간|동기)/.test(before) && lastMetric?.mode) mode=lastMetric.mode;
      const basisHits = [...before.matchAll(/연결|별도|개별/g)];
      const basis = basisHits.length ? basisHits.at(-1)![0] === '연결' ? 'CFS' : 'OFS' : inheritedBasis;
      const company = effectiveCompany ?? inheritedCompany;
      const companySource: CompanySource = effectiveCompany ? 'sentence' : companyNames.length>1 ? 'carried' : 'single';
      const money = /원$/.test(raw), percent = /%|퍼센트/.test(raw);
      const value = money ? koreanAmount(raw)! : Number(raw.replace(/[−△]/g,'-').match(/[+-]?[\d,]+(?:\.\d+)?/)![0].replace(/,/g,''));
      const unit = money ? '억원' : percent ? /%p/i.test(raw) ? '%p' : '%' : raw.replace(/[\d,.+\-−△\s]/g,'');
      const tail = paragraph.slice(pos+raw.length, pos+raw.length+25);
      const approximate = /(?:약|가량|대략)\s*$/.test(prefix) || /^(?:\s*)(?:가량|정도|안팎)/.test(tail);
      const growth = percent && /증가|감소|늘|줄|상승|하락|성장/.test(tail) && !/%p/i.test(raw) ? /감소|줄|하락/.test(tail) ? 'decrease' : 'increase' : undefined;
      const lastUnit = money ? [...raw.matchAll(/([\d,.]+)\s*(조|억|만|천|원)/g)].at(-1) : null;
      const digits = (money ? lastUnit?.[1] : raw.match(/[\d,.]+/)?.[0])?.split('.')[1]?.length ?? 0;
      const scale = money ? ({조:1e4,억:1,만:1e-4,천:1e-5,원:1e-8}[lastUnit?.[2] ?? '원'] ?? 1) : 1;
      let reason = !hit ? '비교할 재무 지표를 식별하지 못했습니다.' : '';
      if (!money && !percent) reason = '전압·거리·인원 등은 재무 API의 검증 대상이 아닙니다.';
      if (/%p/i.test(raw)) reason = '퍼센트포인트 변동은 확인이 필요합니다.';
      if (/[→➝➡]/.test(paragraph) && !/(20\d{2}|지난해|작년|올해|말|상반기|반기|분기)/.test(paragraph.slice(Math.max(0,pos-18),Math.min(paragraph.length,pos+raw.length+18)))) reason='비교 수치의 기준일이 해당 문구에 없어 본문에서 기간별 근거를 확인해야 합니다.';
      if (['재고자산','매출채권','매입채무'].includes(hit?.metric ?? '') && /증가|늘었|감소|줄었|현금.*(?:소모|투입|유입|유출)/.test(paragraph.slice(Math.max(0,pos-35),Math.min(paragraph.length,pos+raw.length+40)))) reason='운전자금 변동액은 기말 재무상태표 잔액과 직접 비교할 수 없어 현금흐름 관련 공시를 별도로 확인해야 합니다.';
      // ‘순차입금이 2,000억원 감소’처럼 금액 뒤에 증감이 바로 붙으면 잔액이 아니라 변동액입니다.
      if (money && hit && /^\s*(?:이나\s*)?(?:가량\s*)?(?:증가|감소|늘|줄|확대|축소|개선|악화|상승|하락|뛰|불어|급증|급감)/.test(paragraph.slice(pos+raw.length,pos+raw.length+12))) reason='증감액(변동폭)은 기말·기간 공시값과 직접 비교할 수 없어 전기 대비 변동액을 별도로 확인해야 합니다.';
      if (/전망|예상|추정|목표|컨센서스/.test(local)) reason = '전망·목표는 확정 공시 실적과 직접 비교할 수 없습니다.';
      if (/하반기|4분기/.test(p ?? '')) reason = '하반기·4분기는 연간 및 누계 공시의 별도 대조가 필요합니다.';

      if (hit?.metric === 'contract' && /총수주|누적|잔고|전체|총사업|신규\s*수주고/.test(before)) reason = '총사업비·누적 수주액은 개별 계약 공시와 범위가 다를 수 있습니다.';
      if (hit?.metric === 'contract' && percent) reason = '계약 관련 비율은 재무비율과 별도로 확인해야 합니다.';
      if (hit?.metric && money && /Margin|Ratio/.test(hit.metric)) reason = '지표와 금액 단위의 연결을 확인해 주세요.';
      if (ambiguousParallel) reason = '각각 나열된 지표와 수치의 대응을 확정하지 못했습니다.';
      if (hit?.metric && percent && !growth && !/Margin|Ratio/.test(hit.metric)) reason = '증감률·구성비의 기준을 확인해 주세요.';
      if(input.automatic && hit?.metric!=='contract' && (money || percent)) {
        const missing=[!company && '기업명',(!knownYear || !year) && '실적 연도',!knownPeriod && '실적 기간',!knownBasis && '연결·별도 기준'].filter(Boolean);
        if(missing.length) reason=`기사에서 ${missing.join('·')}을 확정할 수 없어 확인이 필요합니다.`;
      }

      const periodNote = yearMatch
        ? (yearMatch[1] && Number(yearMatch[1])===year ? `기사 표기 ${yearMatch[0]}` : `‘${yearMatch[0]}’ → ${year}년 (기사 기준일 ${input.articleDate})`) + (p ? ` · ${p}` : '')
        : p ? `기사 표기 ${p} · ${year}년은 앞 문맥에서 이어받음` : `연도·기간을 앞 문맥 또는 화면 기본값에서 이어받음 (${year}년)`;
      const claim: FactClaim = {id:claims.length+1,start:base+pos,end:base+pos+raw.length,text:raw,sentence:paragraph.trim(),company,label:hit?.label ?? '기타 수치',metric:hit?.metric,value,unit,year,period,mode,basis,growth,approximate,tolerance:scale*Math.pow(10,-digits)/2,status:'UNVERIFIED',actual:null,actualText:'확인 필요',message:reason,companySource,periodNote};
      if(growth){
        const priorAmounts=claims.filter(x=>x.company===company&&x.metric===hit?.metric&&x.unit==='억원'&&x.start>=base);
        if(priorAmounts.length>=2 && /대비/.test(before)){
          const target=priorAmounts.at(-2)!,reference=priorAmounts.at(-1)!;
          if(target.year!==reference.year || target.period!==reference.period){
            claim.year=target.year;claim.period=target.period;claim.mode=target.mode;claim.basis=target.basis;
            claim.comparison={year:reference.year,period:reference.period,mode:reference.mode};
          }
        }
        if(!claim.comparison && /전년\s*말|지난해\s*말|작년\s*말/.test(before)){
          const target=priorAmounts.at(-1);
          if(target){claim.year=target.year;claim.period=target.period;claim.mode=target.mode;}
          claim.comparison={year:articleYear-1,period:'annual',mode:'cum'};
        }
      }
      {
        const prevNum=nums.filter(n=>n.index!+n[0].length<=pos).at(-1);
        const nextNum=nums.find(n=>n.index!>=pos+raw.length);
        const signed=detectSign({raw,value:claim.value,money,growth,hitText:hit?.text,metric:hit?.metric,paragraph,pos,windowStart:prevNum?prevNum.index!+prevNum[0].length:0,windowEnd:nextNum?nextNum.index!:paragraph.length});
        claim.value=signed.value; claim.sign=signed.sign; claim.signEvidence=signed.evidence;
      }
      if (hit?.metric === 'operatingCashFlow' && money && /순유출|현금\s*유출|유출액|유출을 기록/.test(paragraph.slice(Math.max(0,pos-40),Math.min(paragraph.length,pos+raw.length+35)))) claim.value = -Math.abs(value);
      if (hit?.metric === 'operatingCashFlow' && money && /순유입|현금\s*유입|유입을 기록/.test(paragraph.slice(Math.max(0,pos-40),Math.min(paragraph.length,pos+raw.length+35)))) claim.value = Math.abs(value);
      if (claim.value<0 && claim.sign!=='negative') { claim.sign='negative'; claim.signEvidence??='현금 유출 표현'; }
      if (claim.value>0 && claim.sign==='unsigned' && hit?.metric==='operatingCashFlow' && /순유입|현금\s*유입|유입을 기록/.test(paragraph.slice(Math.max(0,pos-40),Math.min(paragraph.length,pos+raw.length+35)))) { claim.sign='positive'; claim.signEvidence??='현금 유입 표현'; }
      claim.valueText = signedText(claim.value, unit, growth);
      claim.basisLabel = input.automatic && reason.includes('기사에서') ? `${company || '기업 미확인'} · 기사 기준 확인 필요` : claimBasis(claim);
      claims.push(claim);
      if(hit) lastMetric={...hit,at:0,end:0,year:claim.year,period:claim.period,mode:claim.mode,basis:claim.basis};
    }
    if(input.automatic && !nums.length) updateContext(paragraph);
    const rangeYearMatches=[...paragraph.matchAll(/(20\d{2})\s*년/g)];
    if(rangeYearMatches.length && /(?:지난해|작년|올해)/.test(paragraph) && /에서/.test(paragraph) && nums.filter(n=>/원$/.test(n[0])).length>=2) {
      const first=Number(rangeYearMatches[0][1]);
      const relative=[...paragraph.matchAll(/지난해|작년|올해/g)].at(-1)?.[0];
      const second=relative && /지난해|작년/.test(relative) ? Number(input.articleDate.slice(0,4))-1 : Number(input.articleDate.slice(0,4));
      if(first>0 && second>0) comparisonRangeYears=[first,second];
    }
    inheritedCompany = companyHits.filter(h=>!isComparator(h)).at(-1)?.name ?? inheritedCompany;
    const last = claims.at(-1);
    if (last && last.start >= base) { inheritedYear=last.year; inheritedPeriod=last.period; inheritedMode=last.mode; inheritedBasis=last.basis; }
  }
  return claims;
}
export function applyActual(claim: FactClaim, actual: number) {
  claim.actual = actual;
  // 증감률 주장은 actual이 ‘기사가 말한 방향 기준’ 변동률입니다(기사 방향과 같으면 +). 표시용 실제 변동률로 되돌립니다.
  const realRate = claim.growth ? actual * (claim.growth === 'decrease' ? -1 : 1) : undefined;
  claim.actualText = claim.growth
    ? `${Math.abs(realRate!).toLocaleString('ko-KR',{maximumFractionDigits:2})}${claim.unit} ${realRate! < 0 ? '감소(−)' : '증가(+)'}`
    : signedText(Number(actual.toFixed(4)), claim.unit);
  const allowance = claim.approximate ? Math.max(claim.tolerance, Math.abs(actual)*0.005) : claim.tolerance;
  const claimed = claim.growth ? claim.value : claim.value;
  claim.difference = Number((claimed - actual).toFixed(6));
  claim.status = Math.abs(claimed-actual) <= allowance + 1e-9 ? 'MATCH' : 'MISMATCH';
  if (claim.status === 'MATCH') {
    claim.mismatchKind = undefined;
    claim.message = claim.approximate ? '공시값과 일치합니다(약 표기: 반올림 또는 0.5% 오차 이내).' : '표기 자릿수의 반올림 범위에서 공시값과 일치합니다.';
    return;
  }
  const diffText = `${claim.difference!.toLocaleString('ko-KR',{maximumFractionDigits:4})}${claim.unit}`;
  if (claim.growth) {
    // 방향이 반대인 경우(기사: 감소 ↔ 공시: 증가)를 크기 차이와 구분합니다.
    if (actual < 0) {
      claim.mismatchKind = 'DIRECTION';
      claim.message = `증감 방향이 반대입니다. 기사는 ${claim.growth==='decrease'?'감소':'증가'}라고 했지만 공시 기준 변동률은 ${claim.actualText}입니다.`;
    } else {
      claim.mismatchKind = 'VALUE';
      claim.message = `증감 방향은 같지만 크기가 다릅니다. 기사 ${claim.valueText} vs 공시 ${claim.actualText} (차이 ${diffText}).`;
    }
    return;
  }
  const signsDiffer = claimed !== 0 && actual !== 0 && Math.sign(claimed) !== Math.sign(actual);
  const sameMagnitude = Math.abs(Math.abs(claimed) - Math.abs(actual)) <= allowance + 1e-9;
  const ratio = actual !== 0 ? Math.abs(claimed / actual) : NaN;
  const unitSlip = Number.isFinite(ratio) && [10,100,1000,10000].some(k => Math.abs(ratio / k - 1) < 0.01 || Math.abs(ratio * k - 1) < 0.01);
  if (signsDiffer && sameMagnitude) {
    claim.mismatchKind = 'SIGN';
    claim.message = `크기는 같지만 부호가 반대입니다. 기사 ${claim.valueText} vs 공시 ${claim.actualText}. 이익↔손실(흑자↔적자)·유입↔유출이 뒤바뀌었는지 확인하세요.`;
  } else if (signsDiffer) {
    claim.mismatchKind = 'SIGN_VALUE';
    claim.message = `부호와 크기가 모두 다릅니다. 기사 ${claim.valueText} vs 공시 ${claim.actualText} (차이 ${diffText}).`;
  } else if (unitSlip) {
    claim.mismatchKind = 'UNIT';
    claim.message = `자릿수(단위)가 10의 거듭제곱 배로 다릅니다. 기사 ${claim.valueText} vs 공시 ${claim.actualText}. 조·억·만 단위 오기 가능성을 확인하세요.`;
  } else {
    claim.mismatchKind = 'VALUE';
    claim.message = `기사 수치와 공시값이 다릅니다. 기사 ${claim.valueText} vs 공시 ${claim.actualText} (차이 ${diffText}).`;
  }
}

/** 단일판매·공급계약 표의 확정/총 계약금액 행만 사용합니다. 원 단위가 명시된 행이어야 합니다. */
export function parseContractAmount(markup: string): {value:number; excerpt:string} | null {
  const strip = (s:string) => s.replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
  const rows = [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>strip(m[1]));
  for (const label of [/확정\s*계약금액/, /계약금액/, /계약\s*금액/]) {
    const candidates = rows.filter(row=>label.test(row) && !/조건부|최근\s*매출|비율|정정\s*전|변경\s*전/.test(row));
    for (const row of candidates) {
      // 단위가 없는 숫자, 백만원 표기, 정정 대비표 복수 금액은 추정하지 않습니다.
      if (!/\(\s*원\s*\)|금액\s*원/.test(row)) continue;
      const values = [...row.matchAll(/(?<![\d,.])\d{1,3}(?:,\d{3}){2,}(?![\d,.])|(?<![\d,.])\d{7,}(?![\d,.])/g)].map(m=>Number(m[0].replace(/,/g,'')));
      if (values.length === 1) return { value:values[0]/1e8, excerpt:row };
    }
  }
  return null;
}
