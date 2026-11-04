/**
 * DART 재무 원수치의 정확도를 확인하기 위한 보조 자료 조회 계층.
 * - OpenDART 원천값은 그대로 보존하며 외부 출처 수치로 자동 덮어쓰지 않습니다.
 * - 네이버 금융을 1순위로 사용합니다. 기간·회계기준을 맞출 수 없는 자료는 계산 근거로 승격하지 않습니다.
 * - 비상장 기업은 DART 원문 주석을 우선 사용하며, 네이버 자료가 없다는 이유로 추정값을 만들지 않습니다.
 */
import type { FinancialMetric, Kind, Period } from "./engine";
import { METRIC_LABELS } from "./engine";

export type CrossValidationStatus = "MATCH" | "MISMATCH" | "PARTIAL" | "UNAVAILABLE" | "NOT_COMPARABLE";
export type ProviderName = "NAVER_FINANCE";
export type CrossValidationProviderResult = {
  source: ProviderName;
  sourceLabel: string;
  url: string | null;
  found: boolean;
  value: number | null;
  unit: string;
  period: string | null;
  basis: "CFS" | "OFS" | "UNKNOWN";
  status: "MATCH" | "MISMATCH" | "UNAVAILABLE" | "NOT_COMPARABLE";
  differencePct: number | null;
  message: string;
};
export type MetricCrossValidation = {
  metric: FinancialMetric;
  metricLabel: string;
  status: CrossValidationStatus;
  dartValue: number | null;
  unit: string;
  period: string;
  basis: "CFS" | "OFS";
  tolerancePct: number;
  providers: CrossValidationProviderResult[];
  checkedAt: string;
  message: string;
};

type ExternalKey =
  | "revenue" | "operatingProfit" | "netIncome" | "totalAssets" | "totalLiabilities" | "equity"
  | "currentAssets" | "currentLiabilities" | "receivables" | "inventory" | "operatingCashFlow" | "investmentCashFlow" | "financingCashFlow"
  | "capex" | "borrowings" | "borrowingsRatio" | "netDebt" | "payables" | "interestExpense" | "eps" | "ebitda" | "operatingMargin" | "netMargin"
  | "debtRatio" | "currentRatio" | "roe" | "roa" | "currentLeaseLiabilities" | "noncurrentLeaseLiabilities" | "leaseLiabilities";
type Observation = { key: ExternalKey; year: number; month: number; granularity: "annual" | "quarter"; value: number; rawLabel: string; estimated?: boolean };
type ProviderData = { source: ProviderName; ticker: string | null; url: string | null; basis: "CFS" | "OFS" | "UNKNOWN"; observations: Observation[]; message?: string };
type ParsedHtml = { text: string; observations: Observation[]; basis: "CFS" | "OFS" | "UNKNOWN" };

type PeriodTarget = Pick<Period, "year" | "kind" | "mode">;
type CompanyForCrossValidation = { name: string; stock?: string | null };

type CacheEntry = { expiresAt: number; naver: ProviderData };
const providerCache = new Map<string, CacheEntry>();
const providerInFlight = new Map<string, Promise<ProviderData>>();
const CACHE_TTL_MS = 20 * 60_000;
const REQUEST_TIMEOUT_MS = 7_000;

const NAVER_LABELS: Array<[RegExp, ExternalKey]> = [
  [/^(?:매출액|수익\(매출액\)|영업수익|매출)$/i, "revenue"],
  [/^영업이익(?:\(손실\))?$/, "operatingProfit"],
  [/^(?:당기순이익(?:\(손실\))?|당기순손익|순이익)$/, "netIncome"],
  [/^(?:자산총계|자산합계|총자산)$/, "totalAssets"],
  [/^(?:부채총계|부채합계|총부채)$/, "totalLiabilities"],
  [/^(?:자본총계|자본합계|총자본)$/, "equity"],
  [/^(?:유동자산|유동자산합계)$/, "currentAssets"],
  [/^(?:유동부채|유동부채합계)$/, "currentLiabilities"],
  [/^(?:매출채권(?:및기타채권)?|외상매출금)$/, "receivables"],
  [/^(?:재고자산|재고자산합계)$/, "inventory"],
  [/^(?:영업활동현금흐름|영업활동으로인한현금흐름|영업활동순현금흐름)$/, "operatingCashFlow"],
  [/^(?:유형자산의취득|유형자산취득|유형자산취득액|자본적지출|CAPEX)$/, "capex"],
  [/^(?:투자활동현금흐름|투자활동으로인한현금흐름|투자활동순현금흐름)$/, "investmentCashFlow"],
  [/^(?:재무활동현금흐름|재무활동으로인한현금흐름|재무활동순현금흐름)$/, "financingCashFlow"],
  [/^(?:유동리스부채|유동성리스부채|리스부채\(유동\))$/, "currentLeaseLiabilities"],
  [/^(?:비유동리스부채|장기리스부채|리스부채\(비유동\))$/, "noncurrentLeaseLiabilities"],
  [/^(?:리스부채합계|총리스부채|리스부채)$/, "leaseLiabilities"],
  [/^(?:총차입금|차입금총계|총차입부채|총이자부부채|이자부부채합계)$/, "borrowings"],
  [/^(?:차입금의존도|이자부채의존도)$/, "borrowingsRatio"],
  [/^(?:순차입금|순부채)$/, "netDebt"],
  [/^매입채무(?:및기타채무)?$/, "payables"],
  [/^(?:이자비용|이자비용\(금융원가\))$/, "interestExpense"],
  [/^(?:기본주당순이익|주당순이익|EPS)$/, "eps"],
  [/^EBITDA$/, "ebitda"],
  [/^(?:영업이익률|영업이익율|영업마진율)$/, "operatingMargin"],
  [/^(?:순이익률|순이익율)$/, "netMargin"],
  [/^(?:부채비율|레버리지비율)$/, "debtRatio"],
  [/^(?:유동비율)$/, "currentRatio"],
];

function normalizeLabel(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\s·ㆍ\u00a0]/g, "")
    .replace(/[※*]/g, "")
    .trim();
}
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
function parseNumber(input: string): number | null {
  let s = decodeEntities(input.replace(/<[^>]*>/g, " ")).replace(/[\s\u00a0]/g, "").trim();
  if (!s || /^(?:-|—|–|－|−|N\/A|NA|자료없음|적전|흑전|적지|흑지)$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);
  s = s.replace(/,/g, "").replace(/%$/, "").replace(/원$/, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const value = Number(s) * (negative ? -1 : 1);
  return Number.isFinite(value) ? value : null;
}

type MobileFinanceInfo = { trTitleList: any[]; rowList: any[]; [key: string]: any };

/** Naver mobile finance payload가 래퍼 객체 안쪽에 들어오는 여러 응답 형태를 지원합니다. */
function findMobileFinanceInfo(payload: unknown, depth = 0, seen = new Set<object>()): MobileFinanceInfo | null {
  if (!payload || typeof payload !== "object" || depth > 8 || seen.has(payload as object)) return null;
  seen.add(payload as object);
  const candidate = payload as Record<string, unknown>;
  if (Array.isArray(candidate.trTitleList) && Array.isArray(candidate.rowList)) {
    return candidate as MobileFinanceInfo;
  }
  for (const value of Object.values(candidate)) {
    const found = findMobileFinanceInfo(value, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

/** 재무표 응답에 연결/별도 기준이 명시된 경우에만 기준을 확정합니다. */
function inferNaverMobileBasis(payload: unknown, financeInfo: MobileFinanceInfo): "CFS" | "OFS" | "UNKNOWN" {
  const explicit = [
    financeInfo.fsDiv, financeInfo.fs_div, financeInfo.basis, financeInfo.basisType,
    financeInfo.accountingBasis, financeInfo.consolidated, financeInfo.isConsolidated,
  ].map((value) => String(value ?? "")).join(" ");
  const text = `${explicit} ${JSON.stringify(payload ?? {}).slice(0, 250_000)}`;
  const consolidated = /IFRS\s*연결|연결재무|연결기준|(?:^|[\"'\s:=])CFS(?:$|[\"'\s,}])|consolidated|isConsolidated\s*[:=]\s*true/i.test(text);
  const separate = /IFRS\s*별도|별도재무|별도기준|개별기준|(?:^|[\"'\s:=])OFS(?:$|[\"'\s,}])|separate|isConsolidated\s*[:=]\s*false/i.test(text);
  if (consolidated && !separate) return "CFS";
  if (separate && !consolidated) return "OFS";
  return "UNKNOWN";
}
function parseYearMonth(text: string): { year: number; month: number; estimated: boolean } | null {
  const s = decodeEntities(text).trim();
  const match = s.match(/(20\d{2})\s*[./년-]\s*(1[0-2]|0?[1-9])(?:\s*월)?(?!\d)/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), estimated: /\(E\)|예상|추정|E\)/i.test(s) };
}
function metricForNaverLabel(label: string): ExternalKey | null {
  const n = normalizeLabel(label);
  return NAVER_LABELS.find(([pattern]) => pattern.test(n))?.[1] ?? null;
}
function monthlyDateCells(html: string): Array<{ year: number; month: number; estimated: boolean }> {
  const out: Array<{ year: number; month: number; estimated: boolean }> = [];
  // Header dates are deliberately taken from TH cells, not from body values or footnotes.
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = row[1];
    if (!/<th\b/i.test(body)) continue;
    const cells = [...body.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => m[1]);
    const dates = cells.map(parseYearMonth).filter((v): v is { year: number; month: number; estimated: boolean } => Boolean(v));
    if (dates.length >= 2) {
      // The financial highlight header includes dates in TH cells. Some companies have only two actual periods.
      for (const date of dates) if (!out.some((x) => x.year === date.year && x.month === date.month && x.estimated === date.estimated)) out.push(date);
    }
  }
  return out;
}

/** Naver CompanyInfo Financial Highlight HTML parser, exported for fixture tests. */
export function parseNaverFinancialHighlight(html: string, basisRequested: "CFS" | "OFS" = "CFS", granularityRequested: "annual" | "quarter" = "annual"): ParsedHtml {
  const dateCells = monthlyDateCells(html);
  const observations: Observation[] = [];
  const tableMatches = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const candidateTables = tableMatches.filter((table) => /매출액|영업이익|당기순이익|자산총계|부채총계|자본총계|유동자산|유동부채|차입금|리스부채|EBITDA|영업활동현금흐름|유형자산의취득/.test(decodeEntities(table.replace(/<[^>]*>/g, " "))));
  for (const table of candidateTables) {
    const tableDates = monthlyDateCells(table);
    const dates = tableDates.length >= 2 ? tableDates : dateCells;
    if (!dates.length) continue;
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = rowMatch[1];
      const cells = [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((m) => m[1]);
      if (cells.length < 3) continue;
      const label = normalizeLabel(cells[0]);
      const key = metricForNaverLabel(label);
      if (!key) continue;
      // Blank cells must not shift later values left. Keep each body cell in its original column position.
      const parsedCells = cells.slice(1).map(parseNumber);
      if (!parsedCells.some((v) => v !== null)) continue;
      const maxDateCount = Math.min(dates.length, parsedCells.length);
      for (let i = 0; i < maxDateCount; i++) {
        const date = dates[i];
        const raw = parsedCells[i];
        if (raw === null || date.estimated) continue;
        const value = key === "capex" ? Math.abs(raw) : raw;
        observations.push({ key, year: date.year, month: date.month, granularity: granularityRequested, value, rawLabel: label });
      }
    }
  }
  const hasConsolidated = /IFRS\s*연결|연결\s*재무|연결기준/i.test(decodeEntities(html.replace(/<[^>]*>/g, " ")));
  const hasSeparate = /IFRS\s*별도|별도\s*재무|개별기준/i.test(decodeEntities(html.replace(/<[^>]*>/g, " ")));
  const detectedBasis = hasSeparate && !hasConsolidated ? "OFS" : hasConsolidated && !hasSeparate ? "CFS" : "UNKNOWN";
  // fin_typ=3/4 explicitly selects OFS/CFS; if labels are ambiguous, retain the requested type instead of guessing.
  return { text: html, observations: dedupeObservations(observations), basis: detectedBasis === "UNKNOWN" ? basisRequested : detectedBasis };
}
function dedupeObservations(items: Observation[]): Observation[] {
  const map = new Map<string, Observation>();
  for (const item of items) {
    const key = `${item.key}:${item.year}:${item.month}:${item.granularity}`;
    const previous = map.get(key);
    if (!previous || (!previous.estimated && item.estimated)) map.set(key, item);
  }
  return [...map.values()];
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DART-Navigator/1.0; financial-data-cross-check)",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        ...extraHeaders,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
async function readHtml(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  if (/charset\s*=\s*(?:euc-kr|ks_c_5601)/i.test(contentType)) {
    try { return new TextDecoder("euc-kr").decode(bytes); } catch { /* UTF-8 fallback */ }
  }
  if (/charset\s*=\s*utf-?8/i.test(contentType)) return bytes.toString("utf8");
  const utf8 = bytes.toString("utf8");
  let euc = "";
  try { euc = new TextDecoder("euc-kr").decode(bytes); } catch { /* UTF-8 fallback */ }
  // A raw count of Hangul characters is unsafe: UTF-8 bytes can also decode into plausible but wrong Hangul.
  const score = (text: string) => {
    const keyTerms = ["매출액", "영업이익", "당기순이익", "자산총계", "주요재무정보", "IFRS연결", "IFRS별도"];
    return keyTerms.reduce((total, term) => total + (text.split(term).length - 1) * 30, 0)
      - (text.match(/�/g) ?? []).length * 100
      - (text.match(/[-]/g) ?? []).length * 2;
  };
  return score(euc) > score(utf8) ? euc : utf8;
}

/** New Naver Pay Securities API parser. Values in financeInfo.rowList are stated in 억원. */
export function parseNaverMobileFinance(payload: any, basisRequested: "CFS" | "OFS" = "CFS", granularity: "annual" | "quarter" = "annual"): ParsedHtml {
  const financeInfo = findMobileFinanceInfo(payload);
  if (!financeInfo) return { text: JSON.stringify(payload ?? {}).slice(0, 1000), observations: [], basis: "UNKNOWN" };
  const basis = inferNaverMobileBasis(payload, financeInfo);
  const headers = (financeInfo.trTitleList as any[]).map((header) => {
    const key = String(header?.key ?? "");
    const match = key.match(/^(20\d{2})(\d{2})$/) ?? String(header?.title ?? "").match(/(20\d{2})[./년-](1[0-2]|0?\d)/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return { key: key || `${year}${String(month).padStart(2, "0")}`, year, month, estimated: String(header?.isConsensus ?? "N").toUpperCase() === "Y" || /예상|추정|\(E\)/i.test(String(header?.title ?? "")) };
  }).filter((item): item is { key: string; year: number; month: number; estimated: boolean } => Boolean(item));
  const observations: Observation[] = [];
  for (const row of financeInfo.rowList as any[]) {
    const label = normalizeLabel(String(row?.title ?? row?.name ?? row?.label ?? ""));
    const key = metricForNaverLabel(label);
    if (!key) continue;
    const columns = row?.columns ?? row?.values ?? {};
    for (const header of headers) {
      if (header.estimated) continue;
      const monthKey = String(header.month).padStart(2, "0");
      const cell = [header.key, `${header.year}${monthKey}`, `${header.year}.${monthKey}`, `${header.year}/${monthKey}`, `${header.year}-${monthKey}`].map((key) => columns?.[key]).find((value) => value !== undefined && value !== null);
      if (cell === undefined || cell === null) continue;
      const rawValue = typeof cell === "object" ? (cell.value ?? cell.amount ?? cell.text) : cell;
      if (typeof cell === "object" && String(cell.isConsensus ?? "N").toUpperCase() === "Y") continue;
      const value = parseNumber(String(rawValue ?? ""));
      if (value === null) continue;
      observations.push({ key, year: header.year, month: header.month, granularity, value, rawLabel: String(row?.title ?? row?.name ?? label), estimated: false });
    }
  }
  return { text: JSON.stringify(financeInfo).slice(0, 1000), observations: dedupeObservations(observations), basis };
}

async function fetchNaver(stock: string, basis: "CFS" | "OFS"): Promise<ProviderData> {
  const mobileAnnualUrl = `https://m.stock.naver.com/api/stock/${encodeURIComponent(stock)}/finance/annual`;
  const mobileQuarterUrl = `https://m.stock.naver.com/api/stock/${encodeURIComponent(stock)}/finance/quarter`;
  try {
    const [annualResponse, quarterResponse] = await Promise.all([
      fetchWithTimeout(mobileAnnualUrl, REQUEST_TIMEOUT_MS, { Accept: "application/json, text/plain, */*", Referer: `https://stock.naver.com/domestic/stock/${stock}/info/company` }),
      fetchWithTimeout(mobileQuarterUrl, REQUEST_TIMEOUT_MS, { Accept: "application/json, text/plain, */*", Referer: `https://stock.naver.com/domestic/stock/${stock}/info/company` }),
    ]);
    if (annualResponse.ok || quarterResponse.ok) {
      const [annualPayload, quarterPayload] = await Promise.all([
        annualResponse.ok ? annualResponse.json().catch(() => null) : null,
        quarterResponse.ok ? quarterResponse.json().catch(() => null) : null,
      ]);
      const annualParsed = annualPayload ? parseNaverMobileFinance(annualPayload, basis, "annual") : { observations: [], basis: "UNKNOWN" as const };
      const quarterParsed = quarterPayload ? parseNaverMobileFinance(quarterPayload, basis, "quarter") : { observations: [], basis: "UNKNOWN" as const };
      const allMobileObservations = dedupeObservations([...annualParsed.observations, ...quarterParsed.observations]);
      const basisMatchedObservations = dedupeObservations([
        ...(annualParsed.basis === basis ? annualParsed.observations : []),
        ...(quarterParsed.basis === basis ? quarterParsed.observations : []),
      ]);
      if (basisMatchedObservations.length) {
        // 모바일 API는 손익·자산총계는 제공하더라도 세부 차입금/리스부채 행을 빠뜨릴 수 있습니다.
        // 이런 경우에만 같은 네이버 금융의 Financial Highlight 표를 추가로 읽어 부족한 계정을 보완합니다.
        // 두 방식의 값이 서로 다르면 mobile API 값을 먼저 보존하고, 임의 합산하지 않습니다.
        const debtCoverage = new Set<ExternalKey>(["borrowings", "borrowingsRatio", "currentLeaseLiabilities", "noncurrentLeaseLiabilities", "leaseLiabilities"]);
        const mobileHasDebtCoverage = basisMatchedObservations.some((item) => debtCoverage.has(item.key));
        if (!mobileHasDebtCoverage) {
          const legacy = await fetchNaverLegacy(stock, basis).catch(() => null);
          const legacyMatched = legacy && legacy.basis === basis ? legacy.observations : [];
          if (legacyMatched.length) {
            return {
              source: "NAVER_FINANCE", ticker: stock, url: legacy?.url ?? (annualParsed.basis === basis && annualParsed.observations.length ? mobileAnnualUrl : mobileQuarterUrl),
              basis, observations: dedupeObservations([...basisMatchedObservations, ...legacyMatched]),
            };
          }
        }
        return { source: "NAVER_FINANCE", ticker: stock, url: annualParsed.basis === basis && annualParsed.observations.length ? mobileAnnualUrl : mobileQuarterUrl, basis, observations: basisMatchedObservations };
      }
      if (allMobileObservations.length) {
        const legacy = await fetchNaverLegacy(stock, basis);
        if (legacy.observations.length) return legacy;
        return { source: "NAVER_FINANCE", ticker: stock, url: annualParsed.observations.length ? mobileAnnualUrl : mobileQuarterUrl, basis: "UNKNOWN", observations: allMobileObservations, message: "네이버 모바일 재무표는 조회됐지만 연결·별도 기준을 확인할 수 없어 참고자료로만 보관했습니다." };
      }
    }
  } catch { /* legacy endpoint fallback below */ }
  return fetchNaverLegacy(stock, basis);
}

async function fetchNaverLegacy(stock: string, basis: "CFS" | "OFS"): Promise<ProviderData> {
  const basePage = `https://companyinfo.stock.naver.com/v1/company/c1010001.aspx?cmp_cd=${encodeURIComponent(stock)}&target=finsum_more`;
  const finType = basis === "CFS" ? "4" : "3"; // Naver Financial Highlight: 4=IFRS 연결, 3=IFRS 별도
  let encparam = "";
  let encid = "";
  const messages: string[] = [];
  try {
    const page = await fetchWithTimeout(basePage, REQUEST_TIMEOUT_MS, { Referer: `https://finance.naver.com/item/coinfo.naver?code=${stock}` });
    if (page.ok) {
      const pageHtml = await readHtml(page);
      encparam = pageHtml.match(/encparam\s*[:=]\s*['\"]([^'\"]+)['\"]/i)?.[1] ?? "";
      encid = pageHtml.match(/(?:^|[,{;\s])id\s*[:=]\s*['\"]([^'\"]+)['\"]/i)?.[1] ?? "";
      if (!encparam || !encid) messages.push("네이버 기업현황에서 AJAX 인증 파라미터를 찾지 못해 공개 URL도 함께 시도합니다.");
    } else messages.push(`기업현황 HTTP ${page.status}`);
  } catch (error) {
    messages.push(`기업현황 페이지 조회 실패: ${error instanceof Error ? error.message : "조회 실패"}`);
  }

  const fetchFrequency = async (frequency: "Y" | "Q") => {
    const baseUrl = `https://companyinfo.stock.naver.com/v1/company/ajax/cF1001.aspx?cmp_cd=${encodeURIComponent(stock)}&fin_typ=${finType}&freq_typ=${frequency}`;
    const candidates = [
      ...(encparam && encid ? [`${baseUrl}&encparam=${encodeURIComponent(encparam)}&id=${encodeURIComponent(encid)}`] : []),
      baseUrl,
    ];
    const localMessages: string[] = [];
    for (const url of candidates) {
      try {
        const response = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, {
          Referer: basePage,
          "X-Requested-With": "XMLHttpRequest",
          Accept: "text/html, */*; q=0.01",
        });
        if (!response.ok) { localMessages.push(`HTTP ${response.status}`); continue; }
        const html = await readHtml(response);
        const plainText = decodeEntities(html.replace(/<[^>]*>/g, " "));
        if (/해당 데이터가 존재하지 않습니다|접근이 제한|비정상적인 접근/i.test(plainText)) {
          localMessages.push("응답이 제한 또는 자료 없음 상태입니다.");
          continue;
        }
        const parsed = parseNaverFinancialHighlight(html, basis, frequency === "Q" ? "quarter" : "annual");
        if (parsed.observations.length) return { observations: parsed.observations, url, basis: parsed.basis, messages: localMessages };
        localMessages.push("Financial Highlight 표를 파싱하지 못했습니다.");
      } catch (error) {
        localMessages.push(error instanceof Error ? error.message : "조회 실패");
      }
    }
    return { observations: [] as Observation[], url: null as string | null, basis: "UNKNOWN" as const, messages: localMessages };
  };

  // Annual and quarterly data are independent requests. Run them in parallel so a slow period doesn't block the other.
  const [annual, quarterly] = await Promise.all([fetchFrequency("Y"), fetchFrequency("Q")]);
  messages.push(...annual.messages.map((message) => `연간: ${message}`), ...quarterly.messages.map((message) => `분기: ${message}`));
  const observations = [...annual.observations, ...quarterly.observations];
  const selected = annual.observations.length ? annual : quarterly;
  return {
    source: "NAVER_FINANCE", ticker: stock, url: selected.url ?? basePage,
    basis: observations.length ? selected.basis : "UNKNOWN", observations: dedupeObservations(observations),
    message: observations.length ? undefined : [...new Set(messages)].join(" / ") || "네이버 금융 수치를 확인하지 못했습니다.",
  };
}

async function providersForCompany(company: CompanyForCrossValidation, basis: "CFS" | "OFS"): Promise<ProviderData> {
  const stock = (company.stock ?? "").replace(/\D/g, "");
  const cacheKey = `${stock}:${basis}`;
  const cached = providerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.naver;
  const inFlight = providerInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  if (!/^\d{6}$/.test(stock)) {
    return { source: "NAVER_FINANCE", ticker: null, url: null, basis: "UNKNOWN", observations: [], message: `${company.name}은(는) 네이버 금융에 연결 가능한 상장 종목코드가 없습니다. 이 기업은 DART 공시 원문과 주석을 기준으로 처리합니다.` };
  }
  let pending!: Promise<ProviderData>;
  pending = fetchNaver(stock, basis).then((naver) => {
    providerCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, naver });
    return naver;
  }).catch((error) => ({
    source: "NAVER_FINANCE" as const, ticker: stock, url: `https://stock.naver.com/domestic/stock/${stock}/info/company`, basis: "UNKNOWN" as const, observations: [],
    message: error instanceof Error ? error.message : "네이버 금융 조회 실패",
  })).finally(() => {
    if (providerInFlight.get(cacheKey) === pending) providerInFlight.delete(cacheKey);
  });
  providerInFlight.set(cacheKey, pending);
  return pending;
}

export async function fetchNaverDebtFallback(company: { name: string; stock?: string | null }, period: Period, basis: "CFS" | "OFS") {
  const naver = await providersForCompany(company, basis);
  const month = targetMonth(period.kind);
  const granularity: "annual" | "quarter" = period.kind === "annual" ? "annual" : "quarter";
  const select = (key: ExternalKey) => {
    if (naver.basis !== basis) return null;
    const rows = naver.observations.filter((item) => item.key === key && item.year === period.year && item.month === month && item.granularity === granularity && !item.estimated);
    const values = [...new Set(rows.map((row) => row.value))];
    if (values.length !== 1) return null;
    return { value: values[0], unit: key === "borrowingsRatio" ? "%" : "억원", source: "NAVER_FINANCE" as const, url: naver.url ?? `https://finance.naver.com/item/main.naver?code=${company.stock ?? ""}`, basis: naver.basis, period: `${period.year}/${String(month).padStart(2, "0")}`, rawLabel: rows[0]?.rawLabel ?? key };
  };
  const current = select("currentLeaseLiabilities");
  const noncurrent = select("noncurrentLeaseLiabilities");
  const genericLease = select("leaseLiabilities");
  // 유동 또는 비유동 한쪽만 확인된 경우 나머지를 0으로 간주하지 않습니다.
  // 양쪽 구성 항목이 모두 있거나, 별도 총리스부채 행이 있을 때만 합계를 확정합니다.
  const totalLease = current && noncurrent
    ? current.value + noncurrent.value
    : genericLease?.value ?? null;
  return { current, noncurrent, totalLease, totalBorrowings: select("borrowings"), borrowingsRatio: select("borrowingsRatio"), url: naver.url ?? `https://finance.naver.com/item/main.naver?code=${company.stock ?? ""}`, basis: naver.basis };
}

const FLOW_METRICS = new Set<FinancialMetric>(["revenue", "operatingProfit", "netIncome", "operatingCashFlow", "investmentCashFlow", "financingCashFlow", "capex", "freeCashFlow", "ebitda", "eps"]);
const POINT_METRICS = new Set<FinancialMetric>(["netDebt", "borrowings", "borrowingsRatio", "workingCapital", "payables", "debtRatio", "currentRatio"]);
function targetMonth(kind: Kind): number { return kind === "q1" ? 3 : kind === "half" ? 6 : kind === "q3" ? 9 : 12; }
function getSeriesValue(data: ProviderData, key: ExternalKey, target: PeriodTarget, flow: boolean): number | null {
  const rows = data.observations.filter((item) => item.key === key && item.year <= target.year && !item.estimated);
  const byPeriod = (year: number, month: number, granularity: "annual" | "quarter") => rows.find((item) => item.year === year && item.month === month && item.granularity === granularity)?.value ?? null;
  if (target.kind === "annual") {
    // An annual figure must never fall back to the December quarter. Q4 is one quarter, not the full fiscal year.
    return byPeriod(target.year, 12, "annual");
  }
  const month = targetMonth(target.kind);
  if (!flow) return byPeriod(target.year, month, "quarter") ?? (month === 12 ? byPeriod(target.year, 12, "annual") : null);
  if (target.mode === "qtr") return byPeriod(target.year, month, "quarter");
  if (target.kind === "q1") return byPeriod(target.year, 3, "quarter");
  const months = target.kind === "half" ? [3, 6] : [3, 6, 9];
  const values = months.map((m) => byPeriod(target.year, m, "quarter"));
  if (values.some((v) => v === null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}
function providerMetricValue(data: ProviderData, metric: FinancialMetric, target: PeriodTarget): { value: number | null; unit: string; explanation: string } {
  const get = (key: ExternalKey, flow = true) => getSeriesValue(data, key, target, flow);
  const unit = METRIC_LABELS[metric] && ["operatingMargin", "netMargin", "borrowingsRatio", "debtRatio", "currentRatio", "roe", "roa"].includes(metric) ? "%" : metric === "eps" ? "원" : "억원";
  switch (metric) {
    case "revenue": return { value: get("revenue"), unit, explanation: "동일 기간의 매출액 행" };
    case "operatingProfit": return { value: get("operatingProfit"), unit, explanation: "동일 기간의 영업이익 행" };
    case "netIncome": return { value: get("netIncome"), unit, explanation: "동일 기간의 순이익 행" };
    case "operatingCashFlow": return { value: get("operatingCashFlow"), unit, explanation: "동일 기간의 영업활동현금흐름 행" };
    case "investmentCashFlow": return { value: get("investmentCashFlow"), unit, explanation: "동일 기간의 투자활동현금흐름 행" };
    case "financingCashFlow": return { value: get("financingCashFlow"), unit, explanation: "동일 기간의 재무활동현금흐름 행" };
    case "capex": return { value: get("capex"), unit, explanation: "동일 기간의 자본적지출 행(지출액 절대값)" };
    case "eps": {
      // EPS cannot reliably be summed across quarterly observations for a cumulative half-year/9M period.
      if (target.mode !== "qtr" && (target.kind === "half" || target.kind === "q3")) {
        return { value: null, unit, explanation: "주당순이익은 분기별 EPS 합산이 가중평균주식수 변동을 반영하지 못할 수 있어 누계 기간을 외부 분기값만으로 재구성하지 않습니다." };
      }
      return { value: get("eps"), unit, explanation: "동일 기간의 주당순이익 행" };
    }
    case "ebitda": return { value: get("ebitda"), unit, explanation: "출처가 EBITDA를 독립적으로 공시한 경우만 사용" };
    case "operatingMargin": {
      // Do not add quarterly percentages. For 6M/9M cumulative values, recalculate from cumulative profit/revenue.
      const singlePeriod = target.kind === "annual" || target.kind === "q1" || target.mode === "qtr";
      const direct = singlePeriod ? get("operatingMargin", false) : null;
      const rev = get("revenue"); const op = get("operatingProfit");
      return { value: direct ?? (rev !== null && rev !== 0 && op !== null ? op / rev * 100 : null), unit, explanation: direct !== null ? "출처 공시 동일 단일기간 영업이익률" : "외부 출처 동일기간 영업이익 ÷ 매출액 × 100 (누계기간에는 분기 비율을 더하지 않음)" };
    }
    case "netMargin": {
      // Same rule as operating margin: ratios cannot be summed over quarters.
      const singlePeriod = target.kind === "annual" || target.kind === "q1" || target.mode === "qtr";
      const direct = singlePeriod ? get("netMargin", false) : null;
      const rev = get("revenue"); const net = get("netIncome");
      return { value: direct ?? (rev !== null && rev !== 0 && net !== null ? net / rev * 100 : null), unit, explanation: direct !== null ? "출처 공시 동일 단일기간 순이익률" : "외부 출처 동일기간 순이익 ÷ 매출액 × 100 (누계기간에는 분기 비율을 더하지 않음)" };
    }
    case "debtRatio": {
      const liab = get("totalLiabilities", false); const equity = get("equity", false);
      return { value: liab !== null && equity !== null && equity !== 0 ? liab / equity * 100 : null, unit, explanation: "외부 출처 부채총계 ÷ 자본총계 × 100 (DART와 같은 구성 계정으로 재계산)" };
    }
    case "currentRatio": {
      const ca = get("currentAssets", false); const cl = get("currentLiabilities", false);
      return { value: ca !== null && cl !== null && cl !== 0 ? ca / cl * 100 : null, unit, explanation: "외부 출처 유동자산 ÷ 유동부채 × 100 (DART와 같은 구성 계정으로 재계산)" };
    }
    case "borrowings": {
      const direct = get("borrowings", false);
      // A same-named external figure is shown but its lease/debt composition is not assumed equivalent to DART.
      return { value: direct, unit, explanation: "네이버 금융의 차입금 관련 행입니다. 리스부채·사채·유동성장기부채 포함 범위가 DART 구성 계정과 일치하는지 주석 및 산식과 함께 확인해야 합니다." };
    }
    case "borrowingsRatio": {
      const direct = get("borrowingsRatio", false);
      return { value: direct, unit, explanation: "외부 출처의 차입금의존도 원수치입니다. 차입금 구성(특히 리스부채) 범위가 DART 산식과 일치하는지 확인할 수 없어 자동 일치 판정하지 않습니다." };
    }
    case "netDebt": {
      const direct = get("netDebt", false);
      return { value: direct, unit, explanation: "외부 출처에 순차입금이 직접 표시된 경우의 원수치입니다. 현금성자산·단기금융상품과 리스부채의 처리 범위가 DART 산식과 같은지 별도 확인이 필요합니다." };
    }
    case "workingCapital": {
      const receivables = get("receivables", false);
      const inventory = get("inventory", false);
      const payables = get("payables", false);
      return { value: receivables !== null && inventory !== null && payables !== null ? receivables + inventory - payables : null, unit,
        explanation: "운전자본 = 매출채권 + 재고자산 − 매입채무. 세 구성 계정이 모두 외부 출처에서 확인된 경우만 계산합니다." };
    }
    case "payables": return { value: get("payables", false), unit, explanation: "출처가 매입채무를 독립 계정으로 제공한 경우" };
    case "freeCashFlow": {
      const ocf = get("operatingCashFlow"); const capex = get("capex");
      return { value: ocf !== null && capex !== null ? ocf - Math.abs(capex) : null, unit, explanation: "외부 출처 영업활동현금흐름 − 자본적지출" };
    }
    case "interestCoverage": {
      const op = get("operatingProfit");
      const interest = get("interestExpense");
      return { value: op !== null && interest !== null && interest !== 0 ? op / Math.abs(interest) : null, unit,
        explanation: "이자보상배율 = 영업이익 ÷ 이자비용. 같은 기간의 두 구성 계정을 모두 확인한 경우만 계산합니다." };
    }
    case "roe": case "roa": {
      const direct = get(metric, false);
      if (direct !== null) return { value: direct, unit, explanation: `외부 출처의 ${METRIC_LABELS[metric]} 직접 공시값` };
      const profit = get("netIncome");
      const balanceKey = metric === "roe" ? "equity" : "totalAssets";
      const current = get(balanceKey, false);
      const previous = getSeriesValue(data, balanceKey, { year: target.year - 1, kind: "annual", mode: "cum" }, false);
      return { value: profit !== null && current !== null && previous !== null && current + previous !== 0 ? profit / ((current + previous) / 2) * 100 : null,
        unit, explanation: `${METRIC_LABELS[metric]} = 같은 기간 순이익 ÷ 기초·기말 평균 ${metric === "roe" ? "자본" : "자산"} × 100` };
    }
    case "per": case "pbr":
      return { value: null, unit, explanation: "시장가격 기반 지표는 DART 재무제표 금액과 직접 비교할 대상이 아님" };
    default: return { value: null, unit, explanation: "외부 출처에서 동일 정의의 비교 계정을 찾지 못함" };
  }
}
function unitForMetric(metric: FinancialMetric): string {
  if (["operatingMargin", "netMargin", "borrowingsRatio", "debtRatio", "currentRatio", "roe", "roa"].includes(metric)) return "%";
  if (metric === "eps") return "원";
  if (metric === "interestCoverage") return "배";
  return "억원";
}
function toleranceForMetric(metric: FinancialMetric): number {
  return ["operatingMargin", "netMargin", "borrowingsRatio", "debtRatio", "currentRatio", "roe", "roa"].includes(metric) ? 0.6 : metric === "eps" ? 3 : 1.25;
}
function withinTolerance(metric: FinancialMetric, dartValue: number, extValue: number): { matched: boolean; diffPct: number; tolerance: number } {
  const tolerance = toleranceForMetric(metric);
  const diffPct = Math.abs(extValue - dartValue) / Math.max(Math.abs(dartValue), Math.abs(extValue), 1e-8) * 100;
  const matched = metric === "operatingMargin" || metric === "netMargin" || metric === "borrowingsRatio" || metric === "debtRatio" || metric === "currentRatio" || metric === "roe" || metric === "roa"
    ? Math.abs(extValue - dartValue) <= tolerance
    : diffPct <= tolerance;
  return { matched, diffPct, tolerance };
}
function periodString(target: PeriodTarget): string {
  const periodName: Record<Kind, string> = { annual: "사업보고서 기말/연간", half: "반기", q1: "1분기", q3: "3분기" };
  return `${target.year}년 ${periodName[target.kind]}${target.mode === "qtr" ? "(당기 3개월)" : "(누계/기말)"}`;
}

function selectedObservationPeriods(data: ProviderData, metric: FinancialMetric, target: PeriodTarget): string[] {
  const keys: Array<{ key: ExternalKey; flow: boolean }> = [];
  const singlePeriod = target.kind === "annual" || target.kind === "q1" || target.mode === "qtr";
  switch (metric) {
    case "revenue": keys.push({ key: "revenue", flow: true }); break;
    case "operatingProfit": keys.push({ key: "operatingProfit", flow: true }); break;
    case "netIncome": keys.push({ key: "netIncome", flow: true }); break;
    case "operatingCashFlow": keys.push({ key: "operatingCashFlow", flow: true }); break;
    case "investmentCashFlow": keys.push({ key: "investmentCashFlow", flow: true }); break;
    case "financingCashFlow": keys.push({ key: "financingCashFlow", flow: true }); break;
    case "capex": keys.push({ key: "capex", flow: true }); break;
    case "eps": keys.push({ key: "eps", flow: true }); break;
    case "ebitda": keys.push({ key: "ebitda", flow: true }); break;
    case "operatingMargin": {
      const hasDirect = singlePeriod && getSeriesValue(data, "operatingMargin", target, false) !== null;
      keys.push(...(hasDirect ? [{ key: "operatingMargin" as ExternalKey, flow: false }] : [{ key: "operatingProfit" as ExternalKey, flow: true }, { key: "revenue" as ExternalKey, flow: true }]));
      break;
    }
    case "netMargin": {
      const hasDirect = singlePeriod && getSeriesValue(data, "netMargin", target, false) !== null;
      keys.push(...(hasDirect ? [{ key: "netMargin" as ExternalKey, flow: false }] : [{ key: "netIncome" as ExternalKey, flow: true }, { key: "revenue" as ExternalKey, flow: true }]));
      break;
    }
    case "debtRatio": keys.push({ key: "totalLiabilities", flow: false }, { key: "equity", flow: false }); break;
    case "currentRatio": keys.push({ key: "currentAssets", flow: false }, { key: "currentLiabilities", flow: false }); break;
    case "borrowings": keys.push({ key: "borrowings", flow: false }); break;
    case "borrowingsRatio": keys.push({ key: "borrowingsRatio", flow: false }); break;
    case "netDebt": keys.push({ key: "netDebt", flow: false }); break;
    case "workingCapital": keys.push({ key: "receivables", flow: false }, { key: "inventory", flow: false }, { key: "payables", flow: false }); break;
    case "payables": keys.push({ key: "payables", flow: false }); break;
    case "freeCashFlow": keys.push({ key: "operatingCashFlow", flow: true }, { key: "capex", flow: true }); break;
    case "interestCoverage": keys.push({ key: "operatingProfit", flow: true }, { key: "interestExpense", flow: true }); break;
    case "roe": keys.push({ key: "netIncome", flow: true }, { key: "equity", flow: false }); break;
    case "roa": keys.push({ key: "netIncome", flow: true }, { key: "totalAssets", flow: false }); break;
    case "per": case "pbr": return [];
  }
  const months = target.kind === "half" ? [3, 6] : target.kind === "q3" ? [3, 6, 9] : [targetMonth(target.kind)];
  const dates: string[] = [];
  for (const { key, flow } of keys) {
    const add = (year: number, month: number, granularity: "annual" | "quarter") => {
      if (data.observations.some((item) => item.key === key && item.year === year && item.month === month && item.granularity === granularity && !item.estimated)) {
        dates.push(`${year}/${String(month).padStart(2, "0")}`);
      }
    };
    if (target.kind === "annual") {
      // Report period must be annual; never describe a Q4-only point as a full year.
      add(target.year, 12, "annual");
    } else if (!flow) {
      const month = targetMonth(target.kind);
      add(target.year, month, month === 12 ? "annual" : "quarter");
    } else if (target.mode === "qtr" || target.kind === "q1") {
      add(target.year, targetMonth(target.kind), "quarter");
    } else {
      for (const month of months) add(target.year, month, "quarter");
    }
    if (metric === "roe" || metric === "roa") add(target.year - 1, 12, "annual");
  }
  return [...new Set(dates)];
}

export async function crossValidateMetric(args: {
  company: CompanyForCrossValidation;
  metric: FinancialMetric;
  dartValue: number | null;
  unit?: string;
  period: PeriodTarget;
  basis: "CFS" | "OFS";
}): Promise<MetricCrossValidation> {
  const checkedAt = new Date().toISOString();
  const period = periodString(args.period);
  const unit = args.unit ?? unitForMetric(args.metric);
  const hasDartValue = args.dartValue !== null && Number.isFinite(args.dartValue);
  const noValueMessage = "DART 원천 수치를 확인하지 못했습니다.";
  // When DART lacks a row, still query external providers and expose their numbers as unverified references.
  // These numbers must never be silently promoted to a DART value or marked as MATCH.
  const naver = await providersForCompany(args.company, args.basis);
  const sourceData = [naver];
  const results: CrossValidationProviderResult[] = sourceData.map((provider) => {
    const common = {
      source: provider.source,
      sourceLabel: "네이버 금융",
      url: provider.url,
      unit,
      period: null as string | null,
      basis: provider.basis,
      differencePct: null as number | null,
    };
    if (!provider.observations.length) {
      return { ...common, found: false, value: null, status: "UNAVAILABLE", message: provider.message ?? "네이버 금융 자료가 없습니다." };
    }
    // A source that does not explicitly state CFS/OFS cannot confirm the requested basis. OFS requests are extra strict.
    if (args.basis === "OFS" && provider.basis !== "OFS") {
      return { ...common, found: false, value: null, status: "NOT_COMPARABLE", message: "외부 출처가 별도 기준임을 확인하지 못해 연결/별도 혼용을 방지했습니다." };
    }
    if (provider.basis !== args.basis && provider.basis !== "UNKNOWN") {
      return { ...common, found: false, value: null, status: "NOT_COMPARABLE", message: `요청 기준(${args.basis})과 외부 출처 기준(${provider.basis})이 다릅니다.` };
    }
    const external = providerMetricValue(provider, args.metric, args.period);
    if (external.value === null || !Number.isFinite(external.value)) {
      return { ...common, found: false, value: null, status: "NOT_COMPARABLE", message: `동일 기간의 비교값을 확인하지 못했습니다. ${external.explanation}` };
    }
    if (!hasDartValue) {
      return { ...common, found: true, value: external.value, period: selectedObservationPeriods(provider, args.metric, args.period).join(" + ") || period, status: "NOT_COMPARABLE", message: `DART 본문에서 같은 지표의 수치를 확인하지 못해 외부 참고값으로만 표시합니다. DART 수치가 없어 일치 여부는 판정하지 않았습니다. ${external.explanation}` };
    }
    if (["borrowings", "borrowingsRatio", "netDebt"].includes(args.metric)) {
      return { ...common, found: true, value: external.value, period: selectedObservationPeriods(provider, args.metric, args.period).join(" + ") || period, status: "NOT_COMPARABLE", message: `${external.explanation} 외부 원수치는 표시하지만 정의·포함 계정 범위가 동일하다는 근거가 없어 DART와의 차이율 및 일치 판정은 제공하지 않습니다.` };
    }
    if (provider.basis === "UNKNOWN") {
      const diagnostic = withinTolerance(args.metric, args.dartValue!, external.value);
      return { ...common, found: true, value: external.value, period: selectedObservationPeriods(provider, args.metric, args.period).join(" + ") || period, status: "NOT_COMPARABLE", differencePct: diagnostic.diffPct,
        message: `외부 원수치와 DART의 수치 차이는 ${diagnostic.diffPct.toFixed(2)}%입니다. 하지만 이 출처는 연결/별도 기준을 독립 확인할 수 없어 이 차이를 일치·불일치 판정으로 쓰지 않습니다. ${external.explanation}` };
    }
    const toleranceResult = withinTolerance(args.metric, args.dartValue!, external.value);
    return {
      ...common,
      found: true,
      value: external.value,
      period: selectedObservationPeriods(provider, args.metric, args.period).join(" + ") || period,
      status: toleranceResult.matched ? "MATCH" : "MISMATCH",
      differencePct: toleranceResult.diffPct,
      message: `${external.explanation}. DART와 ${toleranceResult.matched ? "허용오차 이내" : "불일치"} (상대 차이 ${toleranceResult.diffPct.toFixed(2)}%, 허용 ${toleranceResult.tolerance}${unit === "%" ? "%p" : "%"}).`,
    };
  });
  if (!hasDartValue) {
    const hasExternalReference = results.some((provider) => provider.found && provider.value !== null);
    return {
      metric: args.metric, metricLabel: METRIC_LABELS[args.metric], status: hasExternalReference ? "NOT_COMPARABLE" : "UNAVAILABLE",
      dartValue: null, unit, period, basis: args.basis, tolerancePct: toleranceForMetric(args.metric), providers: results, checkedAt,
      message: hasExternalReference
        ? "DART 원천 행이 없어 네이버 금융 수치는 별도 보조 정보로만 제공합니다. DART 수치로 확정하거나 원천값을 대체하지 않았습니다."
        : `${noValueMessage} 네이버 금융에서도 같은 기간의 비교 가능한 수치를 확보하지 못했습니다.`,
    };
  }
  const comparable = results.filter((provider) => provider.found && provider.value !== null && (provider.status === "MATCH" || provider.status === "MISMATCH"));
  const passCount = comparable.filter((provider) => provider.status === "MATCH").length;
  const failCount = comparable.filter((provider) => provider.status === "MISMATCH").length;
  const hasNonComparable = results.some((provider) => provider.status === "NOT_COMPARABLE" || provider.status === "UNAVAILABLE");
  let status: CrossValidationStatus;
  let message: string;
  if (failCount > 0) {
    status = "MISMATCH";
    message = "네이버 금융 수치와 DART 수치가 다릅니다. 기간·기준·단위·계정 범위를 확인해야 하므로 DART 원천값을 유지합니다.";
  } else if (passCount === 1 && comparable.length === 1 && !hasNonComparable && results[0]?.basis === args.basis) {
    status = "MATCH";
    message = "네이버 금융의 같은 기간·같은 회계기준 수치가 DART 원천값과 허용오차 이내입니다. 표시값은 DART 원천값을 유지합니다.";
  } else if (passCount > 0 || comparable.length > 0) {
    status = "PARTIAL";
    message = "네이버 금융의 비교 가능한 수치가 일부 확인됐습니다. 기간·기준 또는 계정 범위가 다른 항목은 수치 대조를 보류했습니다.";
  } else {
    status = results.some((provider) => provider.status === "NOT_COMPARABLE") ? "NOT_COMPARABLE" : "UNAVAILABLE";
    message = "같은 기간·회계기준·계정 정의의 네이버 금융 수치를 찾지 못했습니다.";
  }
  return {
    metric: args.metric, metricLabel: METRIC_LABELS[args.metric], status, dartValue: args.dartValue, unit,
    period, basis: args.basis, tolerancePct: toleranceForMetric(args.metric), providers: results, checkedAt, message,
  };
}

export async function crossValidateMetrics(args: {
  company: CompanyForCrossValidation;
  values: Partial<Record<FinancialMetric, { value: number | null; unit?: string } | null>>;
  period: PeriodTarget;
  basis: "CFS" | "OFS";
}): Promise<Partial<Record<FinancialMetric, MetricCrossValidation>>> {
  const entries = Object.entries(args.values) as Array<[FinancialMetric, { value: number | null; unit?: string } | null]>;
  const results = await Promise.all(entries.map(async ([metric, item]) => {
    const validation = await crossValidateMetric({ company: args.company, metric, dartValue: item?.value ?? null, unit: item?.unit, period: args.period, basis: args.basis });
    return [metric, validation] as const;
  }));
  return Object.fromEntries(results);
}

export function clearCrossValidationCache() { providerCache.clear(); providerInFlight.clear(); }
