import type { FinancialMetric, Kind, Period } from "./engine";

type ExternalFinancialValue = {
  value: number;
  unit: string;
  source: "FNGUIDE";
  url: string;
  basis: "CFS" | "OFS" | "UNKNOWN";
  period: string;
  rawLabel: string;
};

type Cell = { html: string; text: string };
type TableRow = { cells: Cell[]; context: string; unit: string; basis: "CFS" | "OFS" | "UNKNOWN"; granularity: "annual" | "quarter"; dates: Array<{ year: number; month: number; index: number; estimated: boolean }> };

const normalize = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/[\s·ㆍ\u00a0]/g, "").replace(/[※*]/g, "").trim();
function decodeEntities(s: string): string {
  return s.replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}
function htmlText(s: string): string { return decodeEntities(s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function parseNumber(s: string): number | null {
  let text = htmlText(s).replace(/[\s,\u00a0]/g, "").replace(/%$/, "");
  if (!text || /^(?:-|—|–|−|N\/A|NA)$/i.test(text)) return null;
  const neg = /^\(.*\)$/.test(text);
  if (neg) text = text.slice(1, -1);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = Number(text) * (neg ? -1 : 1);
  return Number.isFinite(value) ? value : null;
}
function dateFromCell(s: string): { year: number; month: number; estimated: boolean } | null {
  const text = htmlText(s);
  const m = text.match(/(20\d{2})\s*[./년-]\s*(1[0-2]|0?[1-9])(?:\s*월)?(?!\d)/);
  return m ? { year: Number(m[1]), month: Number(m[2]), estimated: /\(E\)|예상|추정/i.test(text) } : null;
}
function basisFromText(s: string): "CFS" | "OFS" | "UNKNOWN" {
  const cfsMatches = [...s.matchAll(/IFRS\s*\(?\s*연결|연결\s*(?:재무제표|기준)/gi)];
  const ofsMatches = [...s.matchAll(/IFRS\s*\(?\s*별도|별도\s*(?:재무제표|기준)|개별\s*기준/gi)];
  const cfsAt = cfsMatches.length ? (cfsMatches[cfsMatches.length - 1].index ?? -1) : -1;
  const ofsAt = ofsMatches.length ? (ofsMatches[ofsMatches.length - 1].index ?? -1) : -1;
  if (cfsAt < 0 && ofsAt < 0) return "UNKNOWN";
  return cfsAt > ofsAt ? "CFS" : "OFS";
}
function parseTables(html: string): TableRow[] {
  const output: TableRow[] = [];
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  for (const match of tables) {
    const tableHtml = match[0];
    const start = match.index ?? 0;
    const context = html.slice(Math.max(0, start - 1800), start);
    const nearby = `${context} ${tableHtml.slice(0, 1200)}`;
    const basis = basisFromText(nearby);
    const unitMatch = `${context} ${tableHtml}`.match(/단위\s*[:：]?\s*(천원|백만원|억원|원)/i);
    const unit = unitMatch?.[1] ?? "억원";
    const rawRows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
      const cells = [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => ({ html: cell[1], text: htmlText(cell[1]) }));
      return cells;
    }).filter((cells) => cells.length >= 2);
    const dateHeaders: Array<{ year: number; month: number; index: number; estimated: boolean }> = [];
    for (const cells of rawRows.slice(0, 12)) {
      cells.forEach((cell, index) => {
        const date = dateFromCell(cell.text);
        if (date && !dateHeaders.some((x) => x.year === date.year && x.month === date.month && x.index === index)) dateHeaders.push({ ...date, index });
      });
    }
    if (!dateHeaders.length) continue;
    const granularity: "annual" | "quarter" = dateHeaders.some((date) => [3, 6, 9].includes(date.month)) ? "quarter" : "annual";
    for (const cells of rawRows) output.push({ cells, context: nearby, unit, basis, granularity, dates: dateHeaders });
  }
  return output;
}
function toEok(value: number, unit: string): number {
  if (unit === "원") return value / 100_000_000;
  if (unit === "천원") return value / 100_000;
  if (unit === "백만원") return value / 100;
  return value;
}
function metricLabels(metric: FinancialMetric): RegExp[] {
  const map: Partial<Record<FinancialMetric, RegExp[]>> = {
    revenue: [/^(?:매출액|매출액\(수익\)|수익\(매출액\)|영업수익)$/],
    operatingProfit: [/^영업이익(?:\(손실\))?$/],
    netIncome: [/^(?:당기순이익(?:\(손실\))?|당기순손익|순이익)$/],
    borrowings: [/^(?:총차입금|차입금|이자부부채)$/],
    borrowingsRatio: [/^(?:차입금의존도|이자부채의존도)$/],
    debtRatio: [/^부채비율$/], currentRatio: [/^유동비율$/],
    operatingCashFlow: [/^(?:영업활동현금흐름|영업활동으로인한현금흐름|영업활동순현금흐름)$/],
    investmentCashFlow: [/^(?:투자활동현금흐름|투자활동으로인한현금흐름|투자활동순현금흐름)$/],
    financingCashFlow: [/^(?:재무활동현금흐름|재무활동으로인한현금흐름|재무활동순현금흐름)$/],
    capex: [/^(?:유형자산의취득|유형자산취득|자본적지출|CAPEX)$/i],
    payables: [/^(?:매입채무|매입채무및기타채무)$/],
    eps: [/^(?:기본주당순이익|주당순이익|EPS)$/i],
    netDebt: [/^(?:순차입금|순부채)$/],
    ebitda: [/^EBITDA$/i, /^상각전영업이익$/],
  };
  return map[metric] ?? [];
}
function targetMonth(period: Period): number { return period.kind === "annual" ? 12 : period.kind === "half" ? 6 : period.kind === "q1" ? 3 : 9; }
function metricIsFlow(metric: FinancialMetric): boolean { return ["revenue", "operatingProfit", "netIncome", "operatingCashFlow", "investmentCashFlow", "financingCashFlow", "capex", "freeCashFlow", "ebitda", "eps"].includes(metric); }
function metricOutputUnit(metric: FinancialMetric): string {
  if (["borrowingsRatio", "debtRatio", "currentRatio", "operatingMargin", "netMargin", "roe", "roa"].includes(metric)) return "%";
  if (metric === "eps") return "원";
  if (["interestCoverage", "per", "pbr"].includes(metric)) return "배";
  return "억원";
}
function metricNeedsEokConversion(metric: FinancialMetric): boolean {
  return !["borrowingsRatio", "debtRatio", "currentRatio", "operatingMargin", "netMargin", "roe", "roa", "eps", "interestCoverage", "per", "pbr"].includes(metric);
}
function observationValue(rows: TableRow[], metric: FinancialMetric, period: Period, basis: "CFS" | "OFS"): ExternalFinancialValue | null {
  const labels = metricLabels(metric);
  if (!labels.length) return null;
  const target = targetMonth(period);
  const flow = metricIsFlow(metric);
  const targetMonths = flow && period.mode === "cum" && period.kind === "half" ? [3, 6]
    : flow && period.mode === "cum" && period.kind === "q3" ? [3, 6, 9]
      : [target];
  const candidates: Array<{ value: number; rawLabel: string; unit: string; basis: "CFS" | "OFS" | "UNKNOWN"; month: number; estimated: boolean; dates: number[] }> = [];
  for (const row of rows) {
    const label = normalize(row.cells[0]?.text ?? "");
    if (!labels.some((re) => re.test(label))) continue;
    if (row.basis !== basis) continue;
    // 연간 누계와 단독 분기 값을 섞지 않도록 표의 기간 열 구성을 기준으로 구분합니다.
    const wantedGranularity: "annual" | "quarter" = period.kind === "annual" ? "annual" : "quarter";
    if (row.granularity !== wantedGranularity) continue;
    const valuesByMonth = new Map<number, number>();
    for (const date of row.dates) {
      if (date.year !== period.year || date.estimated || !targetMonths.includes(date.month)) continue;
      const value = parseNumber(row.cells[date.index]?.text ?? "");
      if (value !== null) valuesByMonth.set(date.month, metricNeedsEokConversion(metric) ? toEok(value, row.unit) : value);
    }
    if (targetMonths.length > 1) {
      if (targetMonths.every((month) => valuesByMonth.has(month))) {
        candidates.push({ value: targetMonths.reduce((sum, month) => sum + valuesByMonth.get(month)!, 0), rawLabel: row.cells[0]?.text ?? label, unit: metricOutputUnit(metric), basis: row.basis, month: target, estimated: false, dates: targetMonths });
      }
    } else if (valuesByMonth.has(target)) {
      candidates.push({ value: valuesByMonth.get(target)!, rawLabel: row.cells[0]?.text ?? label, unit: metricOutputUnit(metric), basis: row.basis, month: target, estimated: false, dates: [target] });
    }
  }
  const unique = [...new Map(candidates.map((x) => [`${x.value}:${x.month}:${x.rawLabel}:${x.dates.join(",")}`, x])).values()];
  if (unique.length !== 1) return null;
  const selected = unique[0];
  return { value: selected.value, unit: selected.unit, source: "FNGUIDE", url: "", basis: selected.basis, period: `${period.year}/${String(target).padStart(2, "0")}`, rawLabel: selected.rawLabel };
}

const fnGuideHtmlCache = new Map<string, { at: number; html: string }>();
async function fetchHtml(url: string): Promise<string> {
  const cached = fnGuideHtmlCache.get(url);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.html;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; DARTNavigator/1.0)", "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7" }, signal: controller.signal });
    if (!response.ok) return "";
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    if (/charset\s*=\s*(?:euc-kr|ks_c_5601)/i.test(type)) { try { const html = new TextDecoder("euc-kr").decode(bytes); fnGuideHtmlCache.set(url, { at: Date.now(), html }); return html; } catch { /* continue */ } }
    const utf8 = bytes.toString("utf8");
    if ((utf8.match(/�/g) ?? []).length < 3) { fnGuideHtmlCache.set(url, { at: Date.now(), html: utf8 }); return utf8; }
    try { const html = new TextDecoder("euc-kr").decode(bytes); fnGuideHtmlCache.set(url, { at: Date.now(), html }); return html; } catch { fnGuideHtmlCache.set(url, { at: Date.now(), html: utf8 }); return utf8; }
  } finally { clearTimeout(timer); }
}

export async function fetchFnGuideFallback(args: { stockCode: string; period: Period; basis: "CFS" | "OFS"; metric: FinancialMetric }): Promise<ExternalFinancialValue | null> {
  const stock = args.stockCode.replace(/\D/g, "");
  if (!/^\d{6}$/.test(stock)) return null;
  const financeUrl = `https://comp.fnguide.com/SVO2/ASP/SVD_Finance.asp?pGB=1&gicode=A${stock}&cID=&MenuYn=Y&ReportGB=&NewMenuID=103&stkGb=701`;
  const mainUrl = `https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A${stock}&cID=&MenuYn=Y&ReportGB=&NewMenuID=101&stkGb=701`;
  const urls = args.metric === "ebitda" ? [mainUrl, financeUrl] : [financeUrl];
  for (const url of urls) {
    const html = await fetchHtml(url).catch(() => "");
    if (!html) continue;
    const value = observationValue(parseTables(html), args.metric, args.period, args.basis);
    if (value) return { ...value, url };
  }
  return null;
}

function leaseValuesFromRows(rows: TableRow[], period: Period, basis: "CFS" | "OFS", url: string) {
  const findLease = (regex: RegExp): ExternalFinancialValue | null => {
    const target = targetMonth(period);
    const matches: ExternalFinancialValue[] = [];
    for (const row of rows) {
      if (row.basis !== basis) continue;
      const wantedGranularity: "annual" | "quarter" = period.kind === "annual" ? "annual" : "quarter";
      if (row.granularity !== wantedGranularity) continue;
      const label = normalize(row.cells[0]?.text ?? "");
      if (!regex.test(label)) continue;
      for (const date of row.dates) {
        if (date.year !== period.year || date.month !== target || date.estimated) continue;
        const value = parseNumber(row.cells[date.index]?.text ?? "");
        if (value === null) continue;
        matches.push({ value: toEok(value, row.unit), unit: "억원", source: "FNGUIDE", url, basis: row.basis, period: `${date.year}/${String(date.month).padStart(2, "0")}`, rawLabel: row.cells[0]?.text ?? label });
      }
    }
    const distinct = [...new Map(matches.map((m) => [`${m.value.toFixed(6)}:${m.period}:${m.rawLabel}`, m])).values()];
    return distinct.length === 1 ? distinct[0] : null;
  };
  const current = findLease(/^(?:유동리스부채|유동성리스부채|리스부채\(유동\)|유동성리스부채합계)$/);
  const noncurrent = findLease(/^(?:비유동리스부채|장기리스부채|리스부채\(비유동\)|비유동리스부채합계)$/);
  const generic = !current && !noncurrent ? findLease(/^리스부채(?:합계|총계)?$/) : null;
  const total = current || noncurrent ? (current?.value ?? 0) + (noncurrent?.value ?? 0) : generic?.value ?? null;
  return { current, noncurrent, total, url };
}

export async function fetchFnGuideLeaseLiabilities(args: { stockCode: string; period: Period; basis: "CFS" | "OFS" }): Promise<{ current: ExternalFinancialValue | null; noncurrent: ExternalFinancialValue | null; total: number | null; url: string }> {
  const stock = args.stockCode.replace(/\D/g, "");
  if (!/^\d{6}$/.test(stock)) return { current: null, noncurrent: null, total: null, url: "" };
  const url = `https://comp.fnguide.com/SVO2/ASP/SVD_Finance.asp?pGB=1&gicode=A${stock}&cID=&MenuYn=Y&ReportGB=&NewMenuID=103&stkGb=701`;
  const html = await fetchHtml(url).catch(() => "");
  if (!html) return { current: null, noncurrent: null, total: null, url };
  return leaseValuesFromRows(parseTables(html), args.period, args.basis, url);
}

export function extractFnGuideLeaseFixture(html: string, period: Period, basis: "CFS" | "OFS" = "CFS") {
  return leaseValuesFromRows(parseTables(html), period, basis, "https://fixture.invalid/fnguide");
}

export function parseFnGuideFallbackFixture(html: string): TableRow[] { return parseTables(html); }
export function extractFnGuideMetricFixture(html: string, metric: FinancialMetric, period: Period, basis: "CFS" | "OFS"): ExternalFinancialValue | null {
  return observationValue(parseTables(html), metric, period, basis);
}
