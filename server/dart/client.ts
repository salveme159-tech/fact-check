import { TRPCError } from "@trpc/server";
import { ENV } from "../_core/env";
import { clearCrossValidationCache, fetchNaverDebtFallback } from "./crossValidation";
import { fetchFnGuideFallback, fetchFnGuideLeaseLiabilities } from "./fnGuideFallback";
import { parseDepreciationFromDisclosure, parseLeaseLiabilitiesFromDisclosure } from "./disclosureNotes";
import {
  METRIC_LABELS,
  amountOf,
  citation,
  findCorp,
  findRevenueRow,
  findRowLike,
  fsLabel,
  metricConfig,
  modeLabel,
  netDebt,
  parseCorps,
  periodLabel,
  P,
  unzipFirst,
  unzipAll,
  type Corp,
  type FinancialMetric,
  type Kind,
  type Period,
  type Row,
} from "./engine";

const BASE = "https://opendart.fss.or.kr/api";

const won = (v: number) => !Number.isFinite(v) ? "자료 없음" : `${v.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억원`;

let corpCache: { at: number; map: Map<string, Corp> } | null = null;

const stmtCache = new Map<string, { at: number; rows: Row[] | null }>();

const filingCache = new Map<string, { at: number; filing: { rceptNo: string; reportName: string; receiptDate: string } | null }>();

const documentEntriesCache = new Map<string, { at: number; entries: Array<{ name: string; text: string }> }>();

const filingInFlight = new Map<string, Promise<{ rceptNo: string; reportName: string; receiptDate: string } | null>>();

async function dartFetch(input: string | URL, init: RequestInit = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** DART 본문 응답의 charset을 존중해 목차 제목이 깨져 링크 추출에 실패하지 않도록 합니다. */

type DartFiling = { corp_code: string; corp_name: string; report_nm: string; rcept_no: string; rcept_dt: string };

function key(requestKey?: string) {
  const candidate = requestKey?.trim();
  // 요청에 키가 전달되었으면 유효하지 않은/데모용 문자열로 서버 키에 우회하지 않습니다.
  if (candidate) {
    if (!/^[A-Za-z0-9]{40}$/.test(candidate) || /^(DEMO|VERIFIED)/i.test(candidate)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "실제 OpenDART 인증키 40자리가 필요합니다. 데모 키로 우회 조회하지 않습니다." });
    }
    return candidate;
  }
  if (!ENV.opendartApiKey) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "OpenDART 인증키가 없습니다. 화면에서 발급받은 인증키를 저장하거나 서버 .env에 OPENDART_API_KEY를 설정하세요." });
  }
  return ENV.opendartApiKey;
}

async function corps(force = false, requestKey?: string) {
  if (!force && corpCache && Date.now() - corpCache.at < 864e5) return corpCache.map;
  const res = await dartFetch(`${BASE}/corpCode.xml?crtfc_key=${encodeURIComponent(key(requestKey))}`, {}, 15_000);
  if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `DART 기업코드 조회 실패: HTTP ${res.status}` });
  const map = parseCorps(unzipFirst(Buffer.from(await res.arrayBuffer())));
  corpCache = { at: Date.now(), map };
  return map;
}

function expectedReportPattern(year: number, reprt: string): RegExp {
  const month = reprt === "11011" ? "12" : reprt === "11012" ? "06" : reprt === "11013" ? "03" : "09";
  const type = reprt === "11011" ? "사업보고서" : reprt === "11012" ? "반기보고서" : "분기보고서";
  return new RegExp(`${type}.*${year}[.\-/]?${month}`);
}

async function lookupFilingForPeriod(code: string, year: number, reprt: string, requestKey?: string) {
  const cacheKey = `${code}-${year}-${reprt}`;
  const cached = filingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.filing;
  const nowYear = new Date().getFullYear();
  // 해당 회계기간에 맞는 공시 접수연도만 검색합니다. 여러 해를 한꺼번에 검색해
  // 최신 100건에 밀려 과거 분기 접수번호를 놓치는 일을 줄입니다.
  const startYear = reprt === "11011" ? year + 1 : year;
  if (startYear > nowYear) { filingCache.set(cacheKey, { at: Date.now(), filing: null }); return null; }
  const endYear = Math.min(nowYear, startYear);
  const params = new URLSearchParams({
    crtfc_key: key(requestKey), corp_code: code,
    bgn_de: `${startYear}0101`, end_de: `${Math.max(startYear, endYear)}1231`,
    last_reprt_at: "Y", pblntf_ty: "A", page_no: "1", page_count: "100",
    sort: "date", sort_mth: "desc",
  });
  const response = await dartFetch(`${BASE}/list.json?${params}`, { cache: "no-store", headers: { "Cache-Control": "no-cache" } }, 8_000);
  if (!response.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `DART 공시목록 조회 실패: HTTP ${response.status}` });
  const json = await response.json() as { status: string; message?: string; list?: DartFiling[] };
  if (json.status !== "000" && json.status !== "013") {
    throw new TRPCError({ code: "BAD_GATEWAY", message: `DART 공시목록 ${json.status}: ${json.message ?? "조회 실패"}` });
  }
  const pattern = expectedReportPattern(year, reprt);
  const typeOnly = reprt === "11011" ? /사업보고서/ : reprt === "11012" ? /반기보고서/ : /분기보고서/;
  const matching = (json.list ?? []).filter((item) => {
    if (!/^\d{14}$/.test(item.rcept_no ?? "")) return false;
    if (!typeOnly.test(item.report_nm ?? "")) return false;
    return pattern.test(item.report_nm ?? "");
  }).sort((a, b) => (b.rcept_dt ?? "").localeCompare(a.rcept_dt ?? ""));
  const filing = matching[0] ? { rceptNo: matching[0].rcept_no, reportName: matching[0].report_nm, receiptDate: matching[0].rcept_dt } : null;
  filingCache.set(cacheKey, { at: Date.now(), filing });
  return filing;
}

async function filingForPeriod(code: string, year: number, reprt: string, requestKey?: string) {
  const cacheKey = `${code}-${year}-${reprt}`;
  const cached = filingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.filing;
  const inflight = filingInFlight.get(cacheKey);
  if (inflight) return inflight;
  const pending = lookupFilingForPeriod(code, year, reprt, requestKey);
  filingInFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (filingInFlight.get(cacheKey) === pending) filingInFlight.delete(cacheKey);
  }
}

async function statements(code: string, year: number, reprt: string, fs: "CFS" | "OFS", force = false, requestKey?: string): Promise<Row[] | null> {
  const k = `${code}-${year}-${reprt}-${fs}`;
  const hit = stmtCache.get(k);
  if (!force && hit && Date.now() - hit.at < 36e5) return hit.rows;
  const currentKey = key(requestKey);
  const url = `${BASE}/fnlttSinglAcntAll.json?crtfc_key=${encodeURIComponent(currentKey)}&corp_code=${encodeURIComponent(code)}&bsns_year=${year}&reprt_code=${reprt}&fs_div=${fs}`;
  // 재무제표와 접수번호를 병렬 조회합니다. 과거 4개년 시계열에서 각 요청을 순차 대기하면
  // 40건 이상이 연쇄 대기해 화면이 장시간 로딩 상태에 머물 수 있습니다.
  const [response, filingResult] = await Promise.all([
    dartFetch(url, {}, 8_000),
    // 목록 API가 일시적으로 실패해도 재무제표 API에 실접수번호가 있으면 해당 응답을 보존합니다.
    filingForPeriod(code, year, reprt, requestKey).then((filing) => ({ filing })).catch(() => ({ filing: null })),
  ]);
  const filing = filingResult.filing;
  if (!response.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `DART 재무제표 조회 실패: HTTP ${response.status}` });
  const json = await response.json() as { status: string; message?: string; list?: Row[] };
  if (json.status !== "000" && json.status !== "013") {
    throw new TRPCError({ code: "BAD_GATEWAY", message: `DART ${json.status}: ${json.message ?? "조회 실패"}` });
  }
  if (json.status === "013" || !(json.list?.length)) {
    stmtCache.set(k, { at: Date.now(), rows: null });
    return null;
  }
  // 재무제표 API도 실제 접수번호(rcept_no)를 제공합니다. 목록 API에서 보고서 제목 매칭이 실패하더라도
  // 재무제표 응답에 포함된 14자리 실접수번호를 사용하고, 가짜 번호는 절대 만들지 않습니다.
  const statementReceiptNo = (json.list ?? []).find((row) => /^\d{14}$/.test(row.rcept_no ?? ""))?.rcept_no;
  const receiptNo = statementReceiptNo ?? filing?.rceptNo;
  if (!receiptNo || !/^\d{14}$/.test(receiptNo)) {
    stmtCache.set(k, { at: Date.now(), rows: null });
    return null;
  }
  const rows = (json.list ?? []).map((row) => ({
    ...row,
    rcept_no: /^\d{14}$/.test(row.rcept_no ?? "") ? row.rcept_no : receiptNo,
  }));
  stmtCache.set(k, { at: Date.now(), rows });
  return rows;
}

function normAccount(s: string) { return s.replace(/[\s·ㆍ]/g, ""); }

const DIRECT_ACCOUNT_SPECS: Record<string, { sj: string[]; names: string[]; ids?: RegExp[]; exclude?: RegExp[] }> = {
  매출액: { sj: ["CIS", "IS"], names: ["매출액", "수익(매출액)", "영업수익", "매출", "수익", "고객과의계약에서생기는수익", "고객과의계약에서발생하는수익"], ids: [/^(?:ifrs-full_Revenue|dart_OperatingRevenue|ifrs-full_RevenueFromContractsWithCustomers)$/i], exclude: [/매출채권|매출원가|매출총이익|매출할인|매출에누리|매출환입|기타수익|금융수익|지분법수익|영업외수익|법인세수익/] },
  자산총계: { sj: ["BS"], names: ["자산총계", "총자산", "자산총액", "자산합계", "자산계"], ids: [/^ifrs-full_Assets$/i, /^(?:dart_)?TotalAssets$/i] },
  부채총계: { sj: ["BS"], names: ["부채총계", "총부채", "부채총액", "부채합계", "부채계"], ids: [/^ifrs-full_Liabilities$/i, /^(?:dart_)?TotalLiabilities$/i] },
  자본총계: { sj: ["BS"], names: ["자본총계", "총자본", "자본총액", "자본합계", "자본계", "자본총계(지배기업의소유주에게귀속되는자본포함)"], ids: [/^ifrs-full_Equity$/i, /^(?:dart_)?TotalEquity$/i], exclude: [/지배기업소유주에게귀속되는자본$/] },
  유동자산: { sj: ["BS"], names: ["유동자산", "유동자산합계"], ids: [/^ifrs-full_CurrentAssets$/i] },
  유동부채: { sj: ["BS"], names: ["유동부채", "유동부채합계"], ids: [/^ifrs-full_CurrentLiabilities$/i] },
  현금및현금성자산: { sj: ["BS"], names: ["현금및현금성자산", "현금과현금성자산", "현금및현금성자산합계"], ids: [/^ifrs-full_CashAndCashEquivalents$/i] },
  단기금융상품: { sj: ["BS"], names: ["단기금융상품", "단기투자자산", "단기예치금", "단기금융자산"], ids: [/ShortTermDepositsNotClassifiedAsCashEquivalents/i] },
  매출채권: { sj: ["BS"], names: ["매출채권", "매출채권및기타채권", "매출채권및기타유동채권", "유동매출채권"], ids: [/TradeAndOtherCurrentReceivables/i], exclude: [/대손충당금|손상차손누계|기대신용손실충당금/] },
  재고자산: { sj: ["BS"], names: ["재고자산", "유동재고자산", "재고자산합계"], ids: [/^ifrs-full_Inventories$/i] },
  매입채무: { sj: ["BS"], names: ["매입채무", "매입채무및기타채무", "매입채무및기타유동채무", "유동매입채무", "매입채무합계"], ids: [/TradeAndOtherCurrentPayables/i], exclude: [/미지급금|충당부채|리스부채/] },
  단기차입금: { sj: ["BS"], names: ["단기차입금", "단기차입금및회사채", "단기대출금", "단기금융부채"], ids: [/ShorttermBorrowings|CurrentFinancialInstitutionBorrowings/i], exclude: [/리스부채/] },
  유동성장기부채: { sj: ["BS"], names: ["유동성장기부채", "유동성장기차입금", "유동성사채", "유동성장기사채", "비유동차입금의유동성대체부분", "유동성장기부채및사채"], ids: [/CurrentPortionOfLongtermBorrowings|CurrentPortionOfLongtermFinancialLiabilities/i], exclude: [/리스부채/] },
  사채: { sj: ["BS"], names: ["사채", "회사채", "비유동사채"], ids: [/^ifrs-full_BondsIssued$/i], exclude: [/유동성|리스|할인발행차금/] },
  장기차입금: { sj: ["BS"], names: ["장기차입금", "장기대출금", "비유동차입금", "장기차입부채"], ids: [/LongtermBorrowings|LongTermBorrowings|LongtermLoansAndBorrowings|LongTermLoansAndBorrowings|NoncurrentBorrowings|NoncurrentLoansAndBorrowings/i], exclude: [/리스부채|유동성|사채할인발행차금|차입금할인발행차금/] },
  금융원가: { sj: ["IS", "CIS"], names: ["금융원가", "금융비용", "이자비용"], ids: [/^ifrs-full_FinanceCosts$/i], exclude: [/금융수익/] },
};

export function pickDirectAccount(rows: Row[], period: Period, term: string) {
  const legacyAliases: Record<string, string[]> = {
    유동성장기부채: ["유동성장기부채", "유동성장기차입금", "유동성사채", "유동성장기사채", "비유동차입금의유동성대체부분", "유동성장기부채및사채"],
    유동매출채권: ["유동매출채권"], 비유동매출채권: ["비유동매출채권"],
    이익잉여금: ["이익잉여금", "이익잉여금(결손금)"],
    투자활동현금흐름: ["투자활동으로인한현금흐름", "투자활동현금흐름", "투자활동순현금흐름"],
    재무활동현금흐름: ["재무활동으로인한현금흐름", "재무활동현금흐름", "재무활동순현금흐름"],
    영업현금흐름: ["영업활동으로인한현금흐름", "영업활동현금흐름", "영업활동순현금흐름"],
    매출액: ["매출액", "수익(매출액)", "영업수익"],
    영업이익: ["영업이익", "영업손익"],
    순이익: ["당기순이익", "당기순이익(손실)", "당기순손익", "반기순이익", "분기순이익"],
  };
  const spec = DIRECT_ACCOUNT_SPECS[term];
  const targetNames = (spec?.names ?? legacyAliases[term] ?? [term]).map(normAccount);
  const eligible = rows.filter((row) => {
    if (spec && !spec.sj.includes(row.sj_div ?? "")) return false;
    if (!spec && term === "영업현금흐름" && row.sj_div !== "CF") return false;
    if (!spec && term === "투자활동현금흐름" && row.sj_div !== "CF") return false;
    if (!spec && term === "재무활동현금흐름" && row.sj_div !== "CF") return false;
    if (!spec && (term === "매출액" || term === "영업이익" || term === "순이익") && !["IS", "CIS"].includes(row.sj_div ?? "")) return false;
    const name = normAccount(row.account_nm ?? "");
    const id = row.account_id ?? "";
    if (spec?.exclude?.some((pattern) => pattern.test(name))) return false;
    return targetNames.some((target) => name === target || name.startsWith(target)) || Boolean(spec?.ids?.some((pattern) => pattern.test(id)));
  });
  const ranked = eligible.map((row) => {
    const name = normAccount(row.account_nm ?? "");
    const id = row.account_id ?? "";
    const exact = targetNames.some((target) => name === target);
    const idMatch = Boolean(spec?.ids?.some((pattern) => pattern.test(id)));
    const prefix = targetNames.some((target) => name.startsWith(target));
    const score = exact ? 0 : idMatch ? 1 : prefix ? 2 : 3;
    const isFlow = ["IS", "CIS", "CF"].includes(row.sj_div ?? "");
    const raw = isFlow && period.mode === "cum" ? (row.thstrm_add_amount || row.thstrm_amount || "") : (row.thstrm_amount || row.thstrm_add_amount || "");
    const cleaned = raw.replace(/,/g, "").trim();
    let value: number | null = null;
    if (/^(?:-|—|–|－|−)$/.test(cleaned)) value = 0; // 원문에 명시된 대시만 0
    else if (cleaned) {
      const parenthesized = /^\(.*\)$/.test(cleaned);
      const numeric = Number(parenthesized ? `-${cleaned.slice(1, -1)}` : cleaned);
      if (Number.isFinite(numeric)) value = numeric / 1e8;
    }
    return { row, score, value };
  }).sort((a, b) => a.score - b.score || normAccount(a.row.account_nm ?? "").length - normAccount(b.row.account_nm ?? "").length);
  const selected = ranked.find((item) => item.value !== null && Number.isFinite(item.value));
  if (!selected) return null;
  const { row, value } = selected;
  return {
    value: value!, unit: "억원",
    lines: [`원천 계정: ${row.account_nm}`, `계정코드: ${row.account_id || "DART 응답에 계정코드 없음"}`, `회계기준: ${row.sj_div === "BS" ? "재무상태표 기말 잔액" : row.sj_div === "CF" ? "현금흐름표" : "손익계산서"}`, `공시 금액: ${row.thstrm_add_amount || row.thstrm_amount || "공시 금액 미기재"}원`],
    formula: null, disclaimer: null,
    sourceHeading: `${row.sj_div === "BS" ? "재무상태표" : row.sj_div === "CF" ? "현금흐름표" : "손익계산서"} > ${row.account_nm}`,
  };
}

type ResolvedBalanceTotal = { value: number; label: string; sourceLabel: string; derived: boolean; lines: string[] };

/**
 * 재무상태표 합계 계정은 DART 계정명 변형과 IFRS 계정코드를 함께 확인합니다.
 * 자산총계 행을 끝내 찾지 못한 경우에만 회계항등식(부채총계 + 자본총계)으로 보완하고,
 * 산식에 그 사실을 명시해 직접 공시값과 계산값이 혼동되지 않게 합니다.
 */

/**
 * 재무상태표 합계 계정은 DART 계정명 변형과 IFRS 계정코드를 함께 확인합니다.
 * 자산총계 행을 끝내 찾지 못한 경우에만 회계항등식(부채총계 + 자본총계)으로 보완하고,
 * 산식에 그 사실을 명시해 직접 공시값과 계산값이 혼동되지 않게 합니다.
 */
function resolveBalanceTotal(rows: Row[], period: Period, label: "자산총계" | "부채총계" | "자본총계"): ResolvedBalanceTotal | null {
  const aliases: Record<typeof label, string[]> = {
    자산총계: ["자산총계", "총자산", "자산총액", "자산합계", "자산계"],
    부채총계: ["부채총계", "총부채", "부채총액", "부채합계", "부채계"],
    자본총계: ["자본총계", "총자본", "자본총액", "자본합계", "자본계"],
  };
  const direct = pickDirectAccount(rows, period, label);
  if (direct && Number.isFinite(direct.value)) {
    const accountLine = direct.lines.find((line) => line.startsWith("원천 계정:")) ?? `원천 계정: ${label}`;
    return { value: direct.value, label, sourceLabel: accountLine.replace("원천 계정: ", ""), derived: false, lines: [accountLine] };
  }

  const row = findRowLike(rows, ["BS"], aliases[label]);
  const raw = row ? (row.thstrm_amount || row.thstrm_add_amount || "").replace(/,/g, "").trim() : "";
  let value: number | null = null;
  if (raw) {
    if (/^(?:-|—|–|－|−)$/.test(raw)) value = 0;
    else {
      const parenthesized = /^\(.*\)$/.test(raw);
      const numeric = Number(parenthesized ? `-${raw.slice(1, -1)}` : raw);
      if (Number.isFinite(numeric)) value = numeric / 1e8;
    }
  }
  if (row && value !== null && Number.isFinite(value)) {
    return { value, label, sourceLabel: row.account_nm ?? label, derived: false, lines: [`원천 계정: ${row.account_nm ?? label}`] };
  }

  if (label === "자산총계") {
    const liabilities = resolveBalanceTotal(rows, period, "부채총계");
    const equity = resolveBalanceTotal(rows, period, "자본총계");
    if (liabilities && equity && Number.isFinite(liabilities.value) && Number.isFinite(equity.value)) {
      const assets = liabilities.value + equity.value;
      if (Number.isFinite(assets) && assets > 0) {
        return {
          value: assets, label, sourceLabel: "부채총계 + 자본총계", derived: true,
          lines: [`자산총계 대체 산식: 부채총계 ${won(liabilities.value)} + 자본총계 ${won(equity.value)} = ${won(assets)}`],
        };
      }
    }
  }
  return null;
}

type GrossBorrowingComponent = { group: string; account: string; value: number; row: Row };

/**
 * 총차입금/차입금의존도용 차입성 부채 집계.
 * 순차입금(netDebt)의 기존 정책(리스부채 제외)은 이 함수에 영향을 받지 않습니다.
 * 완전한 BS 응답에서 확인된 구성 계정만 합산하고, 애매한 '차입금및사채' 단일 행은 총계로 간주하지 않습니다.
 */

/**
 * 총차입금/차입금의존도용 차입성 부채 집계.
 * 순차입금(netDebt)의 기존 정책(리스부채 제외)은 이 함수에 영향을 받지 않습니다.
 * 완전한 BS 응답에서 확인된 구성 계정만 합산하고, 애매한 '차입금및사채' 단일 행은 총계로 간주하지 않습니다.
 */
function grossBorrowingComponents(rows: Row[]): { items: GrossBorrowingComponent[]; coreFound: number; coreComplete: boolean; fullBalanceSheet: boolean; total: number; missing: string[]; combinedRow: Row | null } {
  const bsRows = rows.filter((row) => row.sj_div === "BS");
  const normalize = (value?: string) => (value ?? "").replace(/[\s·ㆍ]/g, "");
  const excluded = /사채할인발행차금|차입금할인발행차금|미상각할인차금|할인발행차금|상환할증금|사채발행비|총차입금|차입금총계|차입금합계|총차입부채|차입금및사채|차입금및회사채|차입금과사채/;
  const groups: Array<{ group: string; aliases: string[]; ids: RegExp[]; lease?: boolean; preferAggregate?: string[]; preferSingle?: string[] }> = [
    { group: "단기차입금", aliases: ["단기차입금", "단기차입부채", "단기금융기관차입금", "단기은행차입금", "단기대출금", "유동차입금", "유동성금융기관차입금"], ids: [/ShorttermBorrowings|ShortTermBorrowings|ShorttermLoansAndBorrowings|ShortTermLoansAndBorrowings|CurrentBorrowings|BorrowingsCurrent|CurrentLoansAndBorrowings|LoansAndBorrowingsCurrent|CurrentFinancialInstitutionBorrowings/i], preferSingle: ["단기차입금", "단기차입부채"] },
    { group: "유동성장기부채", aliases: ["유동성장기부채", "유동성장기차입금", "유동성장기차입부채", "유동성장기금융부채", "유동성차입부채", "유동성차입금", "비유동차입금의유동성대체부분", "유동성장기부채및사채", "유동성사채", "유동성장기사채", "유동성전환사채", "유동성신주인수권부사채", "유동성교환사채"], ids: [/CurrentPortionOfLongtermBorrowings|CurrentPortionOfLongTermBorrowings|CurrentPortionOfLongtermFinancialLiabilities|CurrentMaturitiesOfLongtermBorrowings/i], preferAggregate: ["유동성장기부채", "유동성장기부채및사채"] },
    { group: "장기차입금", aliases: ["장기차입금", "장기차입부채", "장기금융기관차입금", "장기금융부채", "장기대출금", "비유동차입금", "비유동차입부채"], ids: [/LongtermBorrowings|LongTermBorrowings|LongtermLoansAndBorrowings|LongTermLoansAndBorrowings|NoncurrentBorrowings|NoncurrentLoansAndBorrowings|LongTermDebtNoncurrent/i], preferAggregate: ["장기차입금", "장기차입부채", "장기금융부채", "비유동차입금", "비유동차입부채"] },
    { group: "사채", aliases: ["사채", "회사채", "비유동사채", "전환사채", "신주인수권부사채", "교환사채", "단기사채"], ids: [/^ifrs-full_BondsIssued$|ConvertibleBondsIssued|DebenturesIssued|BondsPayable/i], preferSingle: ["사채", "회사채"] },
    { group: "유동리스부채", aliases: ["유동리스부채", "유동성리스부채", "유동리스부채합계", "유동성리스부채합계"], ids: [/CurrentLeaseLiabilities|LeaseLiabilitiesCurrent/i], lease: true, preferSingle: ["유동리스부채", "유동성리스부채"] },
    { group: "비유동리스부채", aliases: ["비유동리스부채", "장기리스부채", "비유동리스부채합계"], ids: [/NoncurrentLeaseLiabilities|LeaseLiabilitiesNoncurrent/i], lease: true, preferSingle: ["비유동리스부채", "장기리스부채"] },
  ];
  const candidatesFor = (spec: typeof groups[number]) => bsRows.flatMap((row) => {
    const account = normalize(row.account_nm);
    const id = row.account_id ?? "";
    if (!account && !spec.ids.some((pattern) => pattern.test(id))) return [];
    if (!spec.lease && account.includes("리스")) return [];
    if (excluded.test(account)) return [];
    if (spec.group === "사채" && account.startsWith("유동성")) return [];
    if (spec.group === "장기차입금" && (account.startsWith("유동성") || /CurrentPortion/i.test(id))) return [];
    if (spec.lease && !/리스/i.test(account) && !spec.ids.some((pattern) => pattern.test(id))) return [];
    const aliasIndex = spec.aliases.findIndex((alias) => account === alias || account.startsWith(alias));
    const idMatch = spec.ids.some((pattern) => pattern.test(id));
    if (aliasIndex < 0 && !idMatch) return [];
    const raw = (row.thstrm_amount ?? "").replace(/,/g, "").trim();
    const value = /^[-—–－−]$/.test(raw) ? 0 : amountOf(row);
    if (value === null || !Number.isFinite(value)) return [];
    return [{ row, value, account, aliasIndex, idMatch, accountLength: account.length }];
  }).sort((a, b) => a.aliasIndex - b.aliasIndex || a.accountLength - b.accountLength);

  const selectGroupRows = (spec: typeof groups[number]) => {
    const candidates = candidatesFor(spec);
    if (!candidates.length) return [] as typeof candidates;
    // 공시가 범용 합계 행을 주면 그것을 사용하고 세부 계정을 더하지 않아 중복 합산을 막습니다.
    if (spec.preferAggregate?.length) {
      for (const alias of spec.preferAggregate) {
        const found = candidates.filter((item) => item.account === alias || item.account.startsWith(alias)).sort((a, b) => a.accountLength - b.accountLength)[0];
        if (found) return [found];
      }
    }
    // 이름이 같은 계정코드 변형이 여러 개 있으면 하나만 고르되, 상이한 세부 계정은 함께 합산합니다.
    if (spec.preferSingle?.length) {
      for (const alias of spec.preferSingle) {
        const found = candidates.filter((item) => item.account === alias || item.account.startsWith(alias)).sort((a, b) => a.accountLength - b.accountLength)[0];
        if (found) {
          if (spec.group === "사채" || spec.lease || (spec.group === "단기차입금" && ["단기차입금", "단기차입부채"].includes(alias))) return [found];
          // 유동성 금융기관 차입금(사채 제외)과 유동성 사채처럼 별도 계정인 항목은 같이 집계합니다.
          if (spec.group === "단기차입금") return [found, ...candidates.filter((item) => item.row !== found.row && !["단기차입금", "단기차입부채"].includes(item.account))];
        }
      }
    }
    const uniqueRows = new Set<Row>();
    return candidates.filter((item) => {
      if (uniqueRows.has(item.row)) return false;
      uniqueRows.add(item.row);
      return true;
    });
  };

  const coreSpecs = groups.filter((spec) => !spec.lease);
  const selectedCore = coreSpecs.map((spec) => ({ spec, selected: selectGroupRows(spec) }));
  const coreItems: GrossBorrowingComponent[] = selectedCore.flatMap(({ spec, selected }) => selected.map((found) => ({ group: spec.group, account: (found.row.account_nm ?? spec.group).trim(), value: found.value, row: found.row })));
  // 장기차입금 계정에 사채가 포함됐다고 명시되면 별도 사채 계정을 중복으로 더하지 않습니다.
  const longTermIncludesBonds = coreItems.some((item) => item.group === "장기차입금" && /(?:장기차입금|비유동차입금|장기차입부채).*사채.*포함|(?:장기차입금|비유동차입금|장기차입부채).*포함.*사채/.test(normalize(item.account)));
  const filteredCore = longTermIncludesBonds ? coreItems.filter((item) => item.group !== "사채") : coreItems;

  const leaseSpecs = groups.filter((spec) => spec.lease);
  let leaseItems: GrossBorrowingComponent[] = leaseSpecs.flatMap((spec) => selectGroupRows(spec).map((found) => ({ group: spec.group, account: (found.row.account_nm ?? spec.group).trim(), value: found.value, row: found.row })));
  // '리스부채'만 단독 계정으로 제공하는 공시도 지원하되 구성 행이 있으면 합계 행을 더하지 않습니다.
  if (!leaseItems.length) {
    const genericLease = bsRows.flatMap((row) => {
      const name = normalize(row.account_nm);
      if (!/^(?:리스부채|리스부채합계|리스부채총계)$/.test(name)) return [];
      const value = amountOf(row);
      return value === null || !Number.isFinite(value) ? [] : [{ group: "리스부채", account: (row.account_nm ?? "리스부채").trim(), value, row }];
    })[0];
    if (genericLease) leaseItems = [genericLease];
  }
  const usedRows = new Set<Row>();
  const items = [...filteredCore, ...leaseItems].filter((item) => {
    if (usedRows.has(item.row)) return false;
    usedRows.add(item.row);
    return true;
  });
  const normalizeTotals = (value?: string) => normalize(value);
  const hasTotal = (names: string[]) => bsRows.some((row) => names.includes(normalizeTotals(row.account_nm)) && amountOf(row) !== null);
  const fullBalanceSheet = hasTotal(["자산총계", "총자산"]) && hasTotal(["부채총계", "총부채"]) && hasTotal(["자본총계", "총자본", "자본과부채총계"]) && bsRows.length >= 6;
  const coreFound = selectedCore.filter((item) => item.selected.length > 0).length;
  // '차입금및사채'처럼 차입금과 사채를 한 줄로 묶어 공시하는 계정(구성 계정이 따로 없을 때만 합계로 사용).
  const combinedRow = bsRows.find((row) => /^(?:차입금및사채|차입금및회사채|차입금과사채|차입금및사채합계)$/.test(normalize(row.account_nm)) && (() => { const v = amountOf(row); return v !== null && Number.isFinite(v); })()) ?? null;
  return {
    items, coreFound, coreComplete: selectedCore.every((item) => item.selected.length > 0), fullBalanceSheet,
    total: items.reduce((sum, item) => sum + item.value, 0),
    missing: selectedCore.filter((item) => item.selected.length === 0).map((item) => item.spec.group),
    combinedRow,
  };
}

function pickGrossBorrowingMetric(rows: Row[], period: Period, metric: "borrowings" | "borrowingsRatio"): PickedMetric | null {
  const bsRows = rows.filter((row) => row.sj_div === "BS");
  const normalize = (value?: string) => (value ?? "").replace(/[\s·ㆍ]/g, "");
  const aggregateNames = new Set(["총차입금", "차입금총계", "차입금합계", "총차입부채", "총이자부부채", "이자부부채합계", "차입금및사채", "차입금및회사채", "차입금과사채"]);
  const aggregateRow = bsRows.find((row) => aggregateNames.has(normalize(row.account_nm)) && !normalize(row.account_nm).includes("리스"));
  const aggregateValue = aggregateRow ? amountOf(aggregateRow) : null;
  const components = grossBorrowingComponents(rows);
  let totalBorrowings = Number.NaN;
  let lines: string[] = [];
  let formula = "총차입금 = 공시된 차입성 부채 계정 합계(유동·비유동 리스부채 포함)";
  let disclaimer: string | null = null;
  let sourceHeading = "재무상태표 > 차입금 구성 계정";

  if (aggregateRow && aggregateValue !== null && Number.isFinite(aggregateValue) && aggregateValue >= 0) {
    // DART의 총차입금 합계가 리스부채를 제외하는지, 이미 포함하는지 구성 계정과 대조해 판별합니다.
    const leaseItems = components.items.filter((item) => /리스/.test(item.group) || /리스부채/.test(item.account));
    const coreItems = components.items.filter((item) => !leaseItems.includes(item));
    const coreTotal = coreItems.reduce((sum, item) => sum + item.value, 0);
    const leaseTotal = leaseItems.reduce((sum, item) => sum + item.value, 0);
    // 합계와 구성 계정의 차이 허용치는 반올림 수준으로 제한합니다. 1% 허용치는
    // 1조 원대 차입금에서 리스부채 규모까지 오차로 흡수해 리스를 중복 가산할 수 있습니다.
    const tolerance = Math.max(0.5, Math.abs(aggregateValue) * 0.0001);
    const matchesCoreOnly = components.coreFound > 0 && Math.abs(coreTotal - aggregateValue) <= tolerance;
    const matchesLeaseIncluded = leaseItems.length > 0 && Math.abs(components.total - aggregateValue) <= tolerance;
    const combinedBorrowingAndBonds = /^(?:차입금및사채|차입금및회사채|차입금과사채)$/.test(normalize(aggregateRow.account_nm));
    // 별도 구성 계정이 없고 원천 계정명이 '차입금및사채'인 경우, 그 이름은 차입성 부채·사채를 뜻하므로
    // 별도 항목인 리스부채는 한 번 추가합니다. 총차입금 합계와 구성 계정이 있을 때는 아래 대조 규칙이 우선합니다.
    const addLeaseToCombinedLine = combinedBorrowingAndBonds && components.coreFound === 0 && leaseTotal > 0 && !matchesLeaseIncluded;
    totalBorrowings = (matchesCoreOnly && leaseTotal > 0) || addLeaseToCombinedLine ? aggregateValue + leaseTotal : aggregateValue;
    lines = [`분자 · DART 공시 합계 계정 ${aggregateRow.account_nm}: ${won(aggregateValue)}`];
    sourceHeading = `재무상태표 > ${aggregateRow.account_nm}`;
    if (addLeaseToCombinedLine) {
      lines.push(`DART 원문 구성 리스부채 추가: ${won(leaseTotal)}`, `리스 포함 총차입금: ${won(totalBorrowings)}`);
      sourceHeading = `재무상태표 > ${aggregateRow.account_nm} + 리스부채 구성 계정`;
    } else if (matchesCoreOnly && leaseTotal > 0) {
      lines.push(`DART 구성 계정에서 확인한 유동·비유동 리스부채 추가: ${won(leaseTotal)}`, `리스 포함 총차입금: ${won(totalBorrowings)}`);
      sourceHeading = `재무상태표 > ${aggregateRow.account_nm} + 리스부채 구성 계정`;
    } else if (matchesLeaseIncluded) {
      lines.push(`구성 계정 합계(리스부채 포함): ${won(components.total)}`, `차이: ${won(Math.abs(components.total - aggregateValue))}`);
    } else if (components.coreFound > 0) {
      lines.push(`구성 계정 합계(현재 확인 범위): ${won(components.total)}`, `차이: ${won(Math.abs(components.total - aggregateValue))}`);
      if (Math.abs(components.total - aggregateValue) > tolerance) disclaimer = "공시 합계와 구성 계정 범위가 일치하지 않습니다. 주석에서 리스부채 포함 여부를 확인해야 합니다.";
    }
  } else if (components.coreFound > 0) {
    // 확인된 차입금 계정들을 그대로 합산합니다. 확인되지 않은 계정은 0으로 넣지 않고 합계에서 제외하며 안내만 남깁니다.
    totalBorrowings = components.total;
    lines = components.items.map((item) => `구성 · ${item.account}: ${won(item.value)}`);
    lines.push(`분자 · 확인된 차입성 부채 합계(리스부채 포함): ${won(totalBorrowings)}`);
    if (components.missing.length) {
      lines.push(`공시에서 별도 행이 확인되지 않은 계정(합계에서 제외): ${components.missing.join(", ")}`);
      disclaimer = `공시에 별도 행이 없거나 누락된 계정(${components.missing.join(", ")})은 합계에서 제외했습니다. 확인된 계정만 합산한 값입니다.`;
    }
    if (components.combinedRow) lines.push(`참고 · '${components.combinedRow.account_nm}' 행은 구성 계정과의 중복 합산을 막기 위해 제외`);
    sourceHeading = "재무상태표 > 차입금·사채·리스부채 구성 계정";
  } else if (components.combinedRow) {
    const combined = amountOf(components.combinedRow) as number;
    totalBorrowings = combined;
    lines = [`분자 · 공시 계정 ${components.combinedRow.account_nm}: ${won(combined)}`];
    disclaimer = `별도 구성 계정이 없어 '${components.combinedRow.account_nm}' 행 전체를 총차입금으로 사용했습니다. 리스부채는 포함되지 않았을 수 있습니다.`;
    sourceHeading = `재무상태표 > ${components.combinedRow.account_nm}`;
  } else {
    const missing = components.missing.join(", ") || "차입금 구성 계정";
    return {
      value: Number.NaN, unit: metric === "borrowingsRatio" ? "%" : "억원",
      lines: ["재무상태표에서 차입금·사채 계정을 찾지 못했습니다.", `누락 계정: ${missing}`],
      formula: metric === "borrowingsRatio" ? "차입금의존도 = 총차입금 ÷ 자산총계 × 100" : formula,
      disclaimer: `재무상태표에서 차입금 관련 계정이 확인되지 않아(누락: ${missing}) 계산하지 않았습니다. 임의로 0원 처리하지 않았습니다.`,
      sourceHeading,
    };
  }

  if (metric === "borrowings") return { value: totalBorrowings, unit: "억원", lines, formula, disclaimer, sourceHeading };
  const resolvedAssets = resolveBalanceTotal(rows, period, "자산총계");
  const assets = resolvedAssets?.value ?? null;
  if (!resolvedAssets || assets === null || !Number.isFinite(assets) || assets <= 0 || !Number.isFinite(totalBorrowings)) {
    return { value: Number.NaN, unit: "%", lines: [...lines, "분모 · 자산총계 확인 실패"], formula: "차입금의존도 = 총차입성 부채(리스 포함) ÷ 자산총계 × 100", disclaimer: "자산총계 행과 부채총계+자본총계 대체 산식을 모두 확인하지 못해 차입금 의존도를 계산하지 않았습니다.", sourceHeading };
  }
  const ratio = totalBorrowings / assets * 100;
  lines.push(...resolvedAssets.lines, `분모 · 자산총계${resolvedAssets.derived ? "(부채총계 + 자본총계로 계산)" : ""}: ${won(assets)}`, `계산 · 총차입성 부채(리스 포함) ${won(totalBorrowings)} ÷ ${won(assets)} × 100 = ${ratio.toFixed(2)}%`);
  return { value: ratio, unit: "%", lines, formula: "차입금의존도 = (차입금 + 사채 + 유동·비유동 리스부채) ÷ 자산총계 × 100", disclaimer, sourceHeading: `${sourceHeading}·자산총계` };
}

type PickedMetric = { value: number; unit: string; lines: string[]; formula: string | null; disclaimer: string | null; sourceHeading: string };

export function pickMetric(rows: Row[], period: Period, metric: FinancialMetric): PickedMetric | null {
  if (metric === "borrowings" || metric === "borrowingsRatio") {
    return pickGrossBorrowingMetric(rows, period, metric);
  }

  if (metric === "netDebt") {
    const result = netDebt(rows);
    if (!result.ok) return {
      value: Number.NaN,
      unit: "억원",
      lines: [`확인된 계정: ${result.items.map((item) => `${item.sign} ${item.account} ${won(item.amount)}`).join(" · ") || "없음"}`, `누락 계정: ${result.missing.join(", ")}`],
      formula: "순차입금 = 총차입금(리스부채 제외) − 현금성 자산·단기금융상품",
      disclaimer: `순차입금 계산에 필요한 계정이 누락되었습니다: ${result.missing.join(", ")}. 누락값을 0으로 간주하지 않습니다.`,
      sourceHeading: "재무상태표 > 차입금·현금 계정",
    };
    return {
      value: result.value, unit: "억원",
      lines: result.items.map((item) => `${item.sign} ${item.account} ${won(item.amount)}`),
      formula: result.formula, disclaimer: result.disclaimer, sourceHeading: "재무상태표 > 차입금·현금 계정",
    };
  }

  if (metric === "workingCapital") {
    const receivable = findRowLike(rows, ["BS"], ["매출채권", "매출채권및기타채권", "유동매출채권"]);
    const inventory = findRowLike(rows, ["BS"], ["재고자산", "유동재고자산"]);
    const payable = findRowLike(rows, ["BS"], ["매입채무", "매입채무및기타채무", "유동매입채무"]);
    const receivablesValue = receivable ? amountOf(receivable) : null;
    const inventoryValue = inventory ? amountOf(inventory) : null;
    const payableValue = payable ? amountOf(payable) : null;
    if (receivablesValue === null || inventoryValue === null || payableValue === null) return null;
    return {
      value: receivablesValue + inventoryValue - payableValue,
      unit: "억원",
      lines: [`매출채권 ${won(receivablesValue)} + 재고자산 ${won(inventoryValue)} − 매입채무 ${won(payableValue)}`],
      formula: "운전자본 = 매출채권 + 재고자산 − 매입채무",
      disclaimer: "기업별 계정 분류에 따라 구성 계정이 달라질 수 있으며, 본 화면은 프로젝트에 정의된 운전자본 공식을 적용합니다.",
      sourceHeading: "재무상태표 > 매출채권·재고자산·매입채무",
    };
  }

  if (metric === "payables") {
    const row = findRowLike(rows, ["BS"], ["매입채무", "매입채무및기타채무", "유동매입채무"]);
    const value = row ? amountOf(row) : null;
    if (value === null || !row) return null;
    return { value, unit: "억원", lines: [`원천 계정: ${row.account_nm} ${won(value)}`], formula: null, disclaimer: null, sourceHeading: `재무상태표 > ${row.account_nm}` };
  }

  if (metric === "capex") {
    const row = findRowLike(rows, ["CF"], metricConfig.capex.names);
    const rawValue = row ? amountOf(row, 0, period.mode === "cum") : null;
    if (!row || rawValue === null || !Number.isFinite(rawValue)) return null;
    // 현금흐름표의 유형자산 취득은 일반적으로 현금 유출(음수)입니다. CAPEX는 지출 규모로 양수화하여 FCF 계산과 맞춥니다.
    const value = Math.abs(rawValue);
    return { value, unit: "억원", lines: [`원천 계정: ${row.account_nm} ${won(rawValue)}`, `CAPEX 지출 규모: ${won(value)}`], formula: "CAPEX = 현금흐름표의 유형자산 취득 현금유출 절댓값", disclaimer: null, sourceHeading: "현금흐름표 > 유형자산 취득" };
  }

  if (metric === "freeCashFlow") {
    const cashFlow = pickMetric(rows, period, "operatingCashFlow");
    const capex = pickMetric(rows, period, "capex");
    if (!cashFlow || !capex) return null;
    return {
      value: cashFlow.value - capex.value,
      unit: "억원",
      lines: [`영업활동현금흐름 ${won(cashFlow.value)} − CAPEX ${won(capex.value)}`],
      formula: "FCF = 영업활동현금흐름 − CAPEX",
      disclaimer: null,
      sourceHeading: "현금흐름표 > 영업활동현금흐름·유형자산 취득",
    };
  }

  if (metric === "debtRatio") {
    const liabilities = resolveBalanceTotal(rows, period, "부채총계");
    const equity = resolveBalanceTotal(rows, period, "자본총계");
    if (!liabilities || !equity || !Number.isFinite(liabilities.value) || !Number.isFinite(equity.value) || equity.value <= 0) {
      const missing = [!liabilities ? "부채총계" : "", !equity ? "자본총계" : ""].filter(Boolean).join(", ") || "자본총계(0 이하 또는 숫자 아님)";
      return {
        value: Number.NaN, unit: "%", lines: [liabilities ? `부채총계: ${won(liabilities.value)}` : "부채총계 확인 실패", equity ? `자본총계: ${won(equity.value)}` : "자본총계 확인 실패"],
        formula: "부채비율 = 부채총계 ÷ 자본총계 × 100",
        disclaimer: `부채비율을 계산할 원천 계정이 부족합니다: ${missing}. 누락값을 임의로 채우지 않았습니다.`, sourceHeading: "재무상태표 > 부채총계·자본총계",
      };
    }
    const ratio = liabilities.value / equity.value * 100;
    return {
      value: ratio, unit: "%",
      lines: [...liabilities.lines, `분자 · 부채총계: ${won(liabilities.value)}`, ...equity.lines, `분모 · 자본총계: ${won(equity.value)}`, `계산 · ${won(liabilities.value)} ÷ ${won(equity.value)} × 100 = ${ratio.toFixed(2)}%`],
      formula: `부채비율 = 부채총계 ${won(liabilities.value)} ÷ 자본총계 ${won(equity.value)} × 100 = ${ratio.toFixed(2)}%`,
      disclaimer: null, sourceHeading: "재무상태표 > 부채총계·자본총계(직접 계산)",
    };
  }

  if (metric === "currentRatio") {
    const numerator = findRowLike(rows, ["BS"], ["유동자산"]);
    const denominator = findRowLike(rows, ["BS"], ["유동부채"]);
    const top = numerator ? amountOf(numerator) : null;
    const bottom = denominator ? amountOf(denominator) : null;
    if (top === null || bottom === null || bottom === 0) return null;
    return { value: top / bottom * 100, unit: "%", lines: [`유동자산 ${won(top)} ÷ 유동부채 ${won(bottom)} × 100`], formula: "유동비율 = 유동자산 ÷ 유동부채 × 100", disclaimer: null, sourceHeading: "재무상태표 > 유동자산·유동부채" };
  }

  if (metric === "operatingMargin" || metric === "netMargin") {
    const revenue = findRevenueRow(rows, ["CIS", "IS"]);
    const profitNames = metric === "operatingMargin"
      ? metricConfig.operatingProfit.names
      : metricConfig.netIncome.names;
    const profit = findRowLike(rows, ["CIS", "IS"], profitNames);
    const rev = revenue ? amountOf(revenue, 0, period.mode === "cum") : null;
    const profitValue = profit ? amountOf(profit, 0, period.mode === "cum") : null;
    if (rev === null || profitValue === null || rev === 0) return null;
    const label = METRIC_LABELS[metric];
    const profitLabel = metric === "operatingMargin" ? "영업이익" : "순이익";
    return {
      value: (profitValue / rev) * 100,
      unit: "%",
      lines: [`${profitLabel} ${won(profitValue)} / 매출액 ${won(rev)}`],
      formula: `${label} = ${profitLabel} ÷ 매출액 × 100`,
      disclaimer: null,
      sourceHeading: `손익계산서 > 매출액·${profitLabel}`,
    };
  }


  if (metric === "interestCoverage") {
    const op = findRowLike(rows, ["CIS", "IS"], metricConfig.operatingProfit.names);
    const interest = findRowLike(rows, ["CIS", "IS"], ["이자비용", "이자비용(금융원가)", "금융원가"]);
    const ov = op ? amountOf(op, 0, period.mode === "cum") : null; const iv = interest ? amountOf(interest, 0, period.mode === "cum") : null;
    if (ov === null || iv === null || iv === 0) return null;
    return { value: ov / Math.abs(iv), unit: "배", lines: [`영업이익 ${won(ov)} / ${interest!.account_nm} ${won(iv)}`], formula: "이자보상배율 = 영업이익 ÷ 이자비용", disclaimer: null, sourceHeading: "손익계산서 > 영업이익·이자비용" };
  }

  if (metric === "roe" || metric === "roa") {
    const profitRow = findRowLike(rows, ["CIS", "IS"], metricConfig.netIncome.names);
    const baseName = metric === "roe" ? "자본총계" : "자산총계";
    const baseRow = findRowLike(rows, ["BS"], [baseName]);
    const profit = profitRow ? amountOf(profitRow, 0, period.mode === "cum") : null;
    const cur = baseRow ? amountOf(baseRow, 0) : null; const prev = baseRow ? amountOf(baseRow, 1) : null;
    if (profit === null || cur === null || prev === null || (cur + prev) === 0) return null;
    const avg = (cur + prev) / 2;
    return { value: profit / avg * 100, unit: "%", lines: [`순이익 ${won(profit)} / 평균${metric === "roe" ? "자본총계" : "자산총계"} ${won(avg)}`], formula: metric === "roe" ? "ROE = 당기순이익 ÷ 평균자기자본 × 100" : "ROA = 당기순이익 ÷ 평균총자산 × 100", disclaimer: null, sourceHeading: `재무제표 > ${metric.toUpperCase()} 원천 계정` };
  }

  if (metric === "eps") {
    const row = findRowLike(rows, ["CIS", "IS"], metricConfig.eps.names);
    const raw = row ? (row.thstrm_amount ?? "").replace(/,/g, "").trim() : "";
    const value = raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
    if (value === null) return null;
    return { value, unit: "원", lines: [`원천 계정: ${row!.account_nm}`], formula: "EPS = 주당순이익 공시값", disclaimer: null, sourceHeading: `손익계산서 > ${row!.account_nm}` };
  }

  if (metric === "ebitda") {
    const op = findRowLike(rows, ["CIS", "IS"], metricConfig.operatingProfit.names);
    const ov = op ? amountOf(op, 0, period.mode === "cum") : null;
    if (ov === null || !Number.isFinite(ov)) return null;

    const statementPriority = ["CF", "CIS", "IS"] as const;
    const normalize = (value: string) => value.replace(/[\s·ㆍ()（）]/g, "").toLowerCase();
    const expenseAmountOf = (row: Row) => {
      const raw = ((period.mode === "cum" && row.thstrm_add_amount) ? row.thstrm_add_amount : row.thstrm_amount ?? "").replace(/,/g, "").trim();
      // 재무제표에 명시적으로 기재된 대시만 0으로 인정하며, 공란은 미확인으로 유지합니다.
      if (/^(?:-|—|–|－|−)$/.test(raw)) return 0;
      const parenthesized = /^\(.*\)$/.test(raw);
      if (parenthesized) {
        const numeric = Number(`-${raw.slice(1, -1).replace(/,/g, "")}`);
        return Number.isFinite(numeric) ? numeric / 1e8 : null;
      }
      return amountOf(row, 0, period.mode === "cum");
    };
    const aggregateName = /(감가상각비.*무형자산상각비|무형자산상각비.*감가상각비|유무형자산.*상각|유형자산.*상각비.*무형자산.*상각|감가상각및상각비|감가상각비와상각비|감가상각비및무형자산상각비|감가상각비와무형자산상각비|감가상각및무형자산상각비|유형자산감가상각비및무형자산상각비|유형자산및무형자산상각비|감가상각비및상각비|감가상각및무형자산상각)/;
    const aggregateId = /DepreciationDepletionAndAmortisationExpense|DepreciationDepletionAndAmortizationExpense|DepreciationAndAmortisationExpense|DepreciationAmortisationExpense|DepreciationAndAmortizationExpense|DepreciationAmortizationExpense|AdjustmentsForDepreciationAndAmortisationExpense|AdjustmentsForDepreciationAndAmortizationExpense/i;
    const aggregateRows = rows.filter((row) => {
      if (!statementPriority.includes(row.sj_div as any)) return false;
      if (!(aggregateName.test(normalize(row.account_nm ?? "")) || aggregateId.test(row.account_id ?? ""))) return false;
      const value = expenseAmountOf(row);
      return value !== null && Number.isFinite(value);
    });
    // 공시가 유형·무형 상각비 합계를 하나의 계정으로 제공하면 이를 우선 사용합니다.
    const aggregate = aggregateRows.sort((a, b) => statementPriority.indexOf(a.sj_div as any) - statementPriority.indexOf(b.sj_div as any))[0];
    if (aggregate) {
      const da = expenseAmountOf(aggregate);
      if (da !== null && Number.isFinite(da)) {
        return {
          value: ov + Math.abs(da), unit: "억원",
          lines: [`영업이익 ${won(ov)}`, `${aggregate.account_nm} ${won(Math.abs(da))}`],
          formula: "EBITDA = 영업이익 + 공시된 유형·무형자산 감가상각/상각비 합계",
          disclaimer: null, sourceHeading: "손익계산서·현금흐름표 > EBITDA 원천 계정",
        };
      }
    }

    const daName = /(감가상각비|상각비)/;
    const normalizedName = (row: Row) => normalize(row.account_nm ?? "");
    const sumRows = (items: Row[]) => {
      const unique = new Map<string, Row>();
      for (const row of items) unique.set(row.account_id || `${row.sj_div}:${row.account_nm}`, row);
      const vals = [...unique.values()].map((row) => ({ row, value: expenseAmountOf(row) }));
      return vals.length && vals.every((item) => item.value !== null && Number.isFinite(item.value))
        ? { value: vals.reduce((sum, item) => sum + Math.abs(item.value!), 0), rows: vals }
        : null;
    };
    const sectionComponents = (section: string) => {
      const candidates = rows.filter((row) => {
        if (row.sj_div !== section || /상각누계액|감가상각누계액/.test(normalizedName(row))) return false;
        const id = row.account_id ?? "";
        const isDaTaxonomy = /AdjustmentsForDepreciationExpense|DepreciationExpense|DepreciationOfPropertyPlantAndEquipment|DepreciationOfInvestmentProperty|DepreciationOfRightOfUseAsset/i.test(id) && !/AccumulatedDepreciation|DepreciationAccumulated/i.test(id);
        const isAmortTaxonomy = /AdjustmentsForAmortisationExpense|AdjustmentsForAmortizationExpense|AmortisationExpense|AmortizationExpense|AmortisationOfIntangibleAssets|AmortizationOfIntangibleAssets/i.test(id) && !/AccumulatedAmort/i.test(id);
        return daName.test(row.account_nm ?? "") || isDaTaxonomy || isAmortTaxonomy;
      });
      const names = candidates.map((row) => ({
        row,
        name: normalizedName(row),
        id: row.account_id ?? "",
      }));
      const depreciationSpecific = names.filter(({ name, id }) =>
        /유형자산.*(?:감가)?상각(?:비)?|(?:감가)?상각(?:비)?.*유형자산|사용권자산.*(?:감가)?상각(?:비)?|(?:감가)?상각(?:비)?.*사용권자산|투자부동산.*(?:감가)?상각(?:비)?|(?:감가)?상각(?:비)?.*투자부동산/.test(name) || /AdjustmentsForDepreciationExpense|DepreciationExpense|DepreciationOfPropertyPlantAndEquipment|DepreciationOfInvestmentProperty|DepreciationOfRightOfUseAsset/i.test(id) && !/AccumulatedDepreciation|DepreciationAccumulated/i.test(id)
      ).map(({ row }) => row);
      const depreciationGeneric = names.filter(({ name }) => /^감가상각비$/.test(name)).map(({ row }) => row);
      const amortizationSpecific = names.filter(({ name, id }) =>
        /무형자산.*상각(?:비)?|상각(?:비)?.*무형자산|개발비상각비|소프트웨어상각비/.test(name) || /AdjustmentsForAmortisationExpense|AdjustmentsForAmortizationExpense|AmortisationExpense|AmortizationExpense|AmortisationOfIntangibleAssets|AmortizationOfIntangibleAssets/i.test(id) && !/AccumulatedAmort/i.test(id)
      ).map(({ row }) => row);
      const amortizationGeneric = names.filter(({ name }) => /^(무형자산상각비|무형자산상각|상각비)$/.test(name)).map(({ row }) => row);
      // 상세 계정이 있으면 같은 비용을 포함할 수 있는 포괄 계정 '감가상각비'와 중복 합산하지 않습니다.
      return {
        dep: sumRows(depreciationSpecific.length ? depreciationSpecific : depreciationGeneric),
        amort: sumRows(amortizationSpecific.length ? amortizationSpecific : amortizationGeneric),
      };
    };
    const bySection = statementPriority.map((section) => ({ section, ...sectionComponents(section) }));
    const complete = bySection.find((item) => item.dep && item.amort);
    // 일부 공시는 유형자산 감가상각비와 무형자산 상각비를 다른 표에 제공합니다.
    // 이 경우 각 구성요소를 우선순위가 가장 높은 표에서 각각 1회만 가져옵니다.
    const dep = complete?.dep ?? bySection.find((item) => item.dep)?.dep ?? null;
    const amort = complete?.amort ?? bySection.find((item) => item.amort)?.amort ?? null;
    if (!dep || !amort) {
      return {
        value: Number.NaN, unit: "억원",
        lines: [
          `영업이익 ${won(ov)}`,
          ...(dep?.rows ?? []).map((item) => `${item.row.account_nm} ${won(Math.abs(item.value!))}`),
          ...(amort?.rows ?? []).map((item) => `${item.row.account_nm} ${won(Math.abs(item.value!))}`),
          "공시 본문 미기재 (주석 확인 필요)",
        ],
        formula: "EBITDA = 영업이익 + 유형자산 감가상각비 + 무형자산 상각비",
        disclaimer: `EBITDA는 영업이익 ${won(ov)}에 공시된 감가상각비를 더해 계산합니다. ${!dep ? "유형자산 감가상각비" : "무형자산 상각비"}를 재무제표 본문에서 확인하지 못했습니다. 미공시 항목을 0 또는 CAPEX 비율로 추정하지 않았습니다. 해당 보고서 주석 확인이 필요합니다.`,
        sourceHeading: "현금흐름표·손익계산서 > 감가상각비·상각비",
      };
    }
    const da = dep.value + amort.value;
    const parts = [...dep.rows, ...amort.rows].map((item) => `${item.row.account_nm} ${won(Math.abs(item.value!))}`);
    return {
      value: ov + da, unit: "억원", lines: [`영업이익 ${won(ov)}`, ...parts],
      formula: "EBITDA = 영업이익 + 유형자산 감가상각비 + 무형자산 상각비",
      disclaimer: null, sourceHeading: "손익계산서·현금흐름표 > EBITDA 원천 계정",
    };
  }

  const config = metricConfig[metric];
  const row = metric === "revenue"
    ? findRevenueRow(rows, config.sj)
    : metric === "netIncome"
      ? (findRowLike(rows, ["CIS", "IS"], ["반기순손익", "분기순손익", "당기순이익", "당기순이익(손실)", "연결당기순이익"]) ?? findRowLike(rows, config.sj, config.names))
      : findRowLike(rows, config.sj, config.names);
  const isFlowStatement = config.sj.some((statement) => ["IS", "CIS", "CF"].includes(statement));
  const value = row ? amountOf(row, 0, isFlowStatement && period.mode === "cum") : null;
  if (!row || value === null) return null;
  const lines = [`원천 계정: ${row.account_nm}`];
  if (isFlowStatement && period.kind !== "annual" && row.thstrm_add_amount) lines.push(`당기 3개월: ${won(amountOf(row, 0, false) ?? 0)} / 누적: ${won(amountOf(row, 0, true) ?? 0)}`);
  return { value, unit: "억원", lines, formula: null, disclaimer: null, sourceHeading: `${config.sj.includes("CF") ? "현금흐름표" : "손익계산서"} > ${METRIC_LABELS[metric]}` };
}

async function withDartLeaseFallback(args: {
  corp: { name?: string; code?: string; stock?: string };
  rows: Row[];
  period: Period;
  basis: "CFS" | "OFS";
  metric: "borrowings" | "borrowingsRatio";
  picked: PickedMetric | null;
  rceptNo: string;
  requestKey?: string;
}): Promise<{ picked: PickedMetric | null; url: string | null }> {
  const { corp, rows, period, basis, metric, rceptNo, requestKey } = args;
  const picked = args.picked;
  const stockCode = /^\d{6}$/.test(corp.stock ?? "") ? corp.stock! : null;
  const isLeaseRow = (row: Row) => row.sj_div === "BS" && (/리스부채|리스료부채/.test(row.account_nm ?? "") || /CurrentLeaseLiabilities|NoncurrentLeaseLiabilities|LeaseLiabilitiesCurrent|LeaseLiabilitiesNoncurrent/i.test(row.account_id ?? ""));
  const leaseRows = rows.filter(isLeaseRow);
  const hasLeaseRow = leaseRows.length > 0;
  const hasCurrentLeaseRow = leaseRows.some((row) => {
    const label = (row.account_nm ?? "").replace(/\s/g, "");
    return (/유동/.test(label) && !/비유동/.test(label)) || /CurrentLeaseLiabilities|LeaseLiabilitiesCurrent/i.test(row.account_id ?? "");
  });
  const hasNoncurrentLeaseRow = leaseRows.some((row) => /비유동|장기/.test((row.account_nm ?? "").replace(/\s/g, "")) || /NoncurrentLeaseLiabilities|LeaseLiabilitiesNoncurrent/i.test(row.account_id ?? ""));
  const leaseRowHasUsableAmount = (row: Row) => amountOf(row) !== null;
  const hasCurrentLeaseValue = leaseRows.some((row) => {
    const label = (row.account_nm ?? "").replace(/\s/g, "");
    const current = ((/유동/.test(label) && !/비유동/.test(label)) || /CurrentLeaseLiabilities|LeaseLiabilitiesCurrent/i.test(row.account_id ?? ""));
    return current && leaseRowHasUsableAmount(row);
  });
  const hasNoncurrentLeaseValue = leaseRows.some((row) => {
    const noncurrent = /비유동|장기/.test((row.account_nm ?? "").replace(/\s/g, "")) || /NoncurrentLeaseLiabilities|LeaseLiabilitiesNoncurrent/i.test(row.account_id ?? "");
    return noncurrent && leaseRowHasUsableAmount(row);
  });
  const hasCompleteLeaseRows = hasCurrentLeaseRow && hasNoncurrentLeaseRow;
  const hasCompleteLeaseValues = hasCompleteLeaseRows && hasCurrentLeaseValue && hasNoncurrentLeaseValue;
  const components = grossBorrowingComponents(rows);
  const pickedAlreadyIncludesLease = (value: PickedMetric | null) => Boolean(value?.lines.some((line) => /리스부채 포함|리스 포함 총차입금|유동·비유동 리스부채 추가|리스부채 추가/.test(line)));
  // 본문에 유동·비유동 리스부채 금액이 모두 있고, 계산 결과에도 이미 반영된 경우만 조기 반환합니다.
  // 총계행만 사용해 리스가 빠진 경우에는 계속 진행해 구성 계정·주석과 대조합니다.
  if (hasCompleteLeaseValues && picked && Number.isFinite(picked.value) && pickedAlreadyIncludesLease(picked)) return { picked, url: null };

  let naverDebtPromise: Promise<Awaited<ReturnType<typeof fetchNaverDebtFallback>> | null> | null = null;
  let naverDebt: Awaited<ReturnType<typeof fetchNaverDebtFallback>> | null | undefined;
  const getNaverDebt = async () => {
    // DART 원문 주석에서 먼저 찾고 실패했을 때만 네이버 금융을 요청합니다.
    if (!stockCode) return null;
    if (!naverDebtPromise) naverDebtPromise = fetchNaverDebtFallback({ name: corp.name ?? "", stock: stockCode }, period, basis).catch(() => null);
    if (naverDebt === undefined) naverDebt = await naverDebtPromise;
    return naverDebt;
  };

  const externalTotalFallback = async (urlHint: string | null = null) => {
    // 네이버 금융을 먼저 조회하고, 같은 기간·기준 총차입금이 없을 때만 FnGuide를 보조 사용합니다.
    let externalTotal: { value: number; unit: string; url: string; period?: string; source?: string } | null = null;
    let sourceLabel = "네이버 금융";
    const naver = await getNaverDebt();
    if (naver?.totalBorrowings && Number.isFinite(naver.totalBorrowings.value)) {
      externalTotal = naver.totalBorrowings;
    }
    if (!externalTotal && stockCode) {
      const fn = await fetchFnGuideFallback({ stockCode, period, basis, metric: "borrowings" }).catch(() => null);
      if (fn && Number.isFinite(fn.value)) {
        externalTotal = { value: fn.value, unit: fn.unit, url: fn.url, period: fn.period };
        sourceLabel = "FnGuide";
      }
    }
    if (!externalTotal || !Number.isFinite(externalTotal.value) || externalTotal.value < 0) {
      if (metric === "borrowingsRatio" && naver?.borrowingsRatio && Number.isFinite(naver.borrowingsRatio.value)) {
        return { picked: { value: naver.borrowingsRatio.value, unit: "%", lines: [...(picked?.lines ?? []), `네이버 금융 차입금 의존도: ${naver.borrowingsRatio.value.toFixed(2)}%`, `기간: ${naver.borrowingsRatio.period}`], formula: "네이버 금융이 동일 기간에 표시한 차입금 의존도", disclaimer: "DART 원문 주석에서 리스부채를 명확하게 확인하지 못해 네이버 금융 수치를 보조 표시했습니다. 표시 기준을 확인하세요.", sourceHeading: "네이버 금융 재무정보 > 차입금 의존도" }, url: naver.borrowingsRatio.url };
      }
      return { picked: picked ? { ...picked, disclaimer: "DART 원문 주석에서 리스부채를 확인하지 못했고, 네이버 금융·FnGuide에서도 같은 기간의 총차입금 자료를 확보하지 못했습니다. 확인된 DART 원수치를 임의로 보정하지 않았습니다." } : null, url: urlHint ?? naver?.url ?? null };
    }
    const externalLines = [
      ...(picked?.lines ?? []),
      ...(picked && Number.isFinite(picked.value) ? [`DART 계산값: ${formatMetricValue(picked.value, picked.unit)}`] : []),
      `${sourceLabel} 총차입금 원수치: ${won(externalTotal.value)}`,
      `자료 기간: ${externalTotal.period ?? periodLabel(period)} · 기준: ${basis === "CFS" ? "연결" : "별도"}`,
    ];
    if (metric === "borrowings") return {
      picked: { value: externalTotal.value, unit: "억원", lines: externalLines, formula: `${sourceLabel}가 표시한 동일 기간 총차입금`, disclaimer: `DART 본문과 원문 주석에서 총차입금 구성 범위를 완전히 확인하지 못해 ${sourceLabel} 수치를 보조 표시했습니다.`, sourceHeading: `${sourceLabel} 재무정보 > 총차입금` },
      url: externalTotal.url,
    };
    const resolvedAssets = resolveBalanceTotal(rows, period, "자산총계");
    const assets = resolvedAssets?.value ?? null;
    if (!resolvedAssets || assets === null || !Number.isFinite(assets) || assets <= 0) return { picked: picked ? { ...picked, disclaimer: `${sourceLabel} 총차입금은 확인했지만 DART 자산총계와 부채총계+자본총계 대체 산식을 확인하지 못해 차입금 의존도를 계산하지 않았습니다.` } : null, url: externalTotal.url };
    const ratio = externalTotal.value / assets * 100;
    return { picked: { value: ratio, unit: "%", lines: [...externalLines, ...resolvedAssets.lines, `DART 자산총계${resolvedAssets.derived ? "(부채총계 + 자본총계로 계산)" : ""}: ${won(assets)}`, `차입금 의존도: ${won(externalTotal.value)} ÷ ${won(assets)} × 100 = ${ratio.toFixed(2)}%`], formula: `차입금 의존도 = ${sourceLabel} 총차입금 ÷ DART 자산총계 × 100`, disclaimer: `분자는 ${sourceLabel} 수치, 분모는 DART 자산총계입니다. 외부 자료의 차입금 포함 범위는 원문 주석과 함께 확인해야 합니다.`, sourceHeading: `${sourceLabel} 총차입금 + DART 자산총계` }, url: externalTotal.url };
  };

  // 1순위: 실제 DART 접수번호의 원문 ZIP/XML/HTML 주석에서 같은 보고기간의 리스부채를 추출합니다.
  // 비상장기업도 DART 원문을 내려받을 수 있으므로 종목코드 여부와 관계없이 먼저 확인합니다.
  let leaseCurrent: number | null = null;
  let leaseNoncurrent: number | null = null;
  let leaseTotal: number | null = null;
  let leaseSource = "DART 원문 주석";
  let leaseUrl: string | null = /^\d{14}$/.test(rceptNo) ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}` : null;

  // 본문에 유동·비유동 금액이 모두 있으면 그 두 값을 우선 사용합니다.
  // 본문에서 하나라도 빠졌을 때만 DART 원문 ZIP/XML·HTML 주석을 조회합니다.
  const bodyCurrentLease = components.items.find((item) => /유동리스부채/.test(item.group));
  const bodyNoncurrentLease = components.items.find((item) => /비유동리스부채/.test(item.group));
  if (hasCompleteLeaseValues && bodyCurrentLease && bodyNoncurrentLease) {
    leaseCurrent = bodyCurrentLease.value;
    leaseNoncurrent = bodyNoncurrentLease.value;
    leaseTotal = leaseCurrent + leaseNoncurrent;
    leaseSource = "DART 재무상태표 본문";
    leaseUrl = null;
  } else {
    const entries = /^\d{14}$/.test(rceptNo) ? await disclosureEntries(rceptNo, requestKey).catch(() => []) : [];
    const dartLease = parseLeaseLiabilitiesFromDisclosure(entries, period);
    if (dartLease) {
      leaseCurrent = dartLease.current;
      leaseNoncurrent = dartLease.noncurrent;
      leaseTotal = dartLease.total;
      leaseSource = `DART 원문 주석 (${dartLease.sourceFile})`;
    }
  }

  // 2순위: 네이버 금융의 Financial Highlight / 재무 API에서 동일 기간·기준 리스부채를 찾습니다.
  // DART 원문에서 금액을 확정하지 못한 때에만 사용합니다.
  if (leaseTotal === null && stockCode) {
    const naver = await getNaverDebt();
    if (naver?.totalLease !== null && naver?.totalLease !== undefined && Number.isFinite(naver.totalLease)) {
      leaseCurrent = naver.current?.value ?? null;
      leaseNoncurrent = naver.noncurrent?.value ?? null;
      leaseTotal = naver.totalLease;
      leaseSource = "네이버 금융";
      leaseUrl = naver.url ?? leaseUrl;
    }
  }
  // 3순위: 네이버 금융에 같은 기간 행이 없을 때만 FnGuide를 보조 사용합니다.
  if (leaseTotal === null && stockCode) {
    const fnGuideLease = await fetchFnGuideLeaseLiabilities({ stockCode, period, basis }).catch(() => null);
    if (fnGuideLease?.total !== null && fnGuideLease?.total !== undefined && Number.isFinite(fnGuideLease.total)) {
      leaseCurrent = fnGuideLease.current?.value ?? null;
      leaseNoncurrent = fnGuideLease.noncurrent?.value ?? null;
      leaseTotal = fnGuideLease.total;
      leaseSource = "FnGuide";
      leaseUrl = fnGuideLease.url ?? leaseUrl;
    }
  }
  if (leaseTotal === null || !Number.isFinite(leaseTotal) || leaseTotal < 0) return externalTotalFallback(leaseUrl);

  const normalize = (value?: string) => (value ?? "").replace(/[\s·ㆍ]/g, "");
  const aggregateNames = new Set(["총차입금", "차입금총계", "차입금합계", "총차입부채", "총이자부부채", "이자부부채합계", "차입금및사채", "차입금및회사채", "차입금과사채"]);
  const aggregateRow = rows.find((row) => row.sj_div === "BS" && aggregateNames.has(normalize(row.account_nm)));
  const aggregateValue = aggregateRow ? amountOf(aggregateRow) : null;
  const coreItems = components.items.filter((item) => !/리스/.test(item.group) && !/리스부채/.test(item.account));
  const coreTotal = coreItems.reduce((sum, item) => sum + item.value, 0);
  // 1%는 리스부채 자체를 차이로 오인할 수 있을 만큼 큽니다. 합계 대조는 반올림 허용치만 둡니다.
  const tolerance = Math.max(0.5, Math.abs(coreTotal) * 0.0001);
  const near = (a: number | null, b: number) => a !== null && Number.isFinite(a) && Math.abs(a - b) <= tolerance;
  let baseDebt: number | null = null;
  let addLease = true;
  let reconciliationMessage = "";

  if (metric === "borrowings" && hasCompleteLeaseValues && picked && Number.isFinite(picked.value) && pickedAlreadyIncludesLease(picked)) return { picked, url: leaseUrl };
  if (aggregateRow && aggregateValue !== null && Number.isFinite(aggregateValue)) {
    if (near(aggregateValue, coreTotal)) {
      baseDebt = aggregateValue;
      addLease = true;
    } else if (near(aggregateValue, coreTotal + leaseTotal)) {
      // 공시 합계가 이미 원문 주석의 리스부채를 포함하면 한 번만 반영합니다.
      baseDebt = aggregateValue;
      addLease = false;
      reconciliationMessage = "DART 총차입금 합계가 구성 계정과 원문 주석의 리스부채 합산값에 일치해 추가 합산하지 않았습니다.";
    } else if (components.coreComplete && coreItems.length > 0 && Number.isFinite(coreTotal)) {
      // 구성 계정 전체가 채워졌으나 합계 행과 다르면, 확인된 구성 계정으로 재산출합니다.
      baseDebt = coreTotal;
      addLease = true;
      reconciliationMessage = `DART 총차입금 합계 행(${won(aggregateValue)})이 구성 계정 합계(${won(coreTotal)})와 일치하지 않아, 확인된 구성 계정 및 리스부채 주석으로 다시 산출했습니다.`;
    } else if (components.coreFound === 0 && /^(?:차입금및사채|차입금및회사채|차입금과사채)$/.test(normalize(aggregateRow.account_nm))) {
      // 구성 계정이 별도로 없는 공시의 '차입금및사채'는 명칭 범위에 맞춰 비리스 차입성 부채 기준값으로 사용하고,
      // 별도 주석에서 확인한 리스부채를 더합니다. 계산식에 출처 행을 그대로 남깁니다.
      baseDebt = aggregateValue;
      addLease = true;
      reconciliationMessage = `DART 공시 '${aggregateRow.account_nm}' 행을 차입금·사채 기준값으로 사용하고, 별도 주석에서 확인한 리스부채를 더했습니다.`;
    } else {
      return { picked: picked ? { ...picked, disclaimer: "DART의 총차입금 합계와 구성 계정이 일치하지 않아 리스부채를 임의로 더하지 않았습니다. 원문 주석과 계정 범위를 추가 확인해야 합니다." } : null, url: leaseUrl };
    }
  } else {
    // 본문에 유동/비유동 리스부채 중 일부만 있으면 그 값을 포함한 rawDebt에 전체 리스부채를 더해 중복 계산하지 않습니다.
    // 확인된 비리스 차입금 구성 계정이 완전한 경우 그 합계를 기준으로 원문 주석의 전체 리스부채를 한 번만 추가합니다.
    if (hasLeaseRow) {
      // 리스 행이 일부만 본문에 있는 상황에서 pickMetric(rows) 값을 쓰면
      // 확인된 리스 한쪽 금액을 전체 리스부채에 다시 더해 중복 계산할 수 있습니다.
      // 따라서 리스 행을 제외한 구성 계정/합계만으로 기준 차입금을 구성합니다.
      const nonLeaseRows = rows.filter((row) => !isLeaseRow(row));
      const nonLeaseComponents = grossBorrowingComponents(nonLeaseRows);
      if (nonLeaseComponents.coreComplete && nonLeaseComponents.items.length > 0 && Number.isFinite(nonLeaseComponents.total)) {
        baseDebt = nonLeaseComponents.total;
      } else {
        const nonLeaseRawDebt = pickMetric(nonLeaseRows, period, "borrowings");
        if (nonLeaseRawDebt && Number.isFinite(nonLeaseRawDebt.value)) baseDebt = nonLeaseRawDebt.value;
      }
    } else {
      const rawDebt = pickMetric(rows, period, "borrowings");
      if (rawDebt && Number.isFinite(rawDebt.value)) baseDebt = rawDebt.value;
      else if (components.coreComplete && coreItems.length > 0 && Number.isFinite(coreTotal)) baseDebt = coreTotal;
    }
  }
  if (baseDebt === null || !Number.isFinite(baseDebt) || baseDebt < 0) return externalTotalFallback(leaseUrl);
  const correctedDebt = baseDebt + (addLease ? leaseTotal : 0);
  // 이 프로젝트의 차입금 의존도 기준은 리스부채를 포함한 총차입성 부채 ÷ 자산총계입니다.
  // 리스부채 포함 합계를 별도로 표시하면서 비율에서는 제외하던 이전 로직을 일치시킵니다.
  const ratioDebt = correctedDebt;
  const lines = [
    ...(picked?.lines ?? []),
    `DART 원문 주석 유동 리스부채: ${leaseCurrent === null ? "별도 행 미확인" : won(leaseCurrent)}`,
    `DART 원문 주석 비유동 리스부채: ${leaseNoncurrent === null ? "별도 행 미확인" : won(leaseNoncurrent)}`,
    `${leaseSource} 리스부채 합계: ${won(leaseTotal)}`,
    reconciliationMessage,
    addLease ? `총차입금(리스 포함 참고값): ${won(baseDebt)} + ${won(leaseTotal)} = ${won(correctedDebt)}` : `총차입금(리스 포함 참고값): ${won(correctedDebt)} (리스부채 이미 포함)`,
  ].filter(Boolean);
  const detailFormula = addLease
    ? `총차입금(리스 포함) = 비리스 차입금·사채 ${won(baseDebt)} + 리스부채 ${won(leaseTotal)} = ${won(correctedDebt)}`
    : `총차입금(리스 포함) = 공시 합계 ${won(baseDebt)} (리스부채 ${won(leaseTotal)} 포함 확인)`;
  if (metric === "borrowings") return {
    picked: { value: correctedDebt, unit: "억원", lines, formula: detailFormula, disclaimer: reconciliationMessage || null, sourceHeading: `${leaseSource} + DART 재무상태표 구성 계정` }, url: leaseUrl,
  };
  const resolvedAssets = resolveBalanceTotal(rows, period, "자산총계");
  const assets = resolvedAssets?.value ?? null;
  if (!resolvedAssets || assets === null || !Number.isFinite(assets) || assets <= 0) return { picked: picked ? { ...picked, disclaimer: "리스부채는 확인했지만 DART 자산총계와 부채총계+자본총계 대체 산식을 확인하지 못해 차입금 의존도를 계산하지 않았습니다." } : null, url: leaseUrl };
  const ratio = ratioDebt / assets * 100;
  const leaseInclusionNote = `리스부채 ${won(leaseTotal)}은 총차입성 부채 분자에 포함했습니다.`;
  return {
    picked: { value: ratio, unit: "%", lines: [...lines, `차입금 의존도 계산용 총차입성 부채(리스 포함): ${won(ratioDebt)}`, leaseInclusionNote, ...resolvedAssets.lines, `DART 자산총계${resolvedAssets.derived ? "(부채총계 + 자본총계로 계산)" : ""}: ${won(assets)}`, `차입금 의존도: ${won(ratioDebt)} ÷ ${won(assets)} × 100 = ${ratio.toFixed(2)}%`], formula: `차입금 의존도 = 총차입성 부채(리스 포함) ${won(ratioDebt)} ÷ 자산총계 ${won(assets)} × 100 = ${ratio.toFixed(2)}%`, disclaimer: leaseInclusionNote, sourceHeading: `${leaseSource} 리스부채 포함 + DART 재무상태표·자산총계` }, url: leaseUrl,
  };
}

export async function validateDartKey(requestKey?: string) {
  if (!requestKey || !/^[A-Za-z0-9]{40}$/.test(requestKey.trim()) || /^(DEMO|VERIFIED)/i.test(requestKey.trim())) {
    return { valid: false as const, companyCount: 0, message: "실제 40자리 OpenDART 인증키를 입력하세요." };
  }
  try {
    const map = await corps(true, requestKey);
    if (!map.size) return { valid: false as const, companyCount: 0, message: "DART 기업목록을 받지 못했습니다. 인증키를 확인하세요." };
    return { valid: true as const, companyCount: map.size, message: "OpenDART 인증키 검증 성공" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenDART 인증키 검증 실패";
    return { valid: false as const, companyCount: 0, message: `인증키 검증 실패: ${message}` };
  }
}

async function disclosureEntries(rceptNo: string, requestKey?: string): Promise<Array<{ name: string; text: string }>> {
  const cached = documentEntriesCache.get(rceptNo);
  if (cached && Date.now() - cached.at < (cached.entries.length ? 24 * 3600_000 : 60_000)) return cached.entries;
  let response: Response;
  try {
    response = await dartFetch(`${BASE}/document.xml?crtfc_key=${encodeURIComponent(key(requestKey))}&rcept_no=${encodeURIComponent(rceptNo)}`, {}, 10_000);
  } catch {
    documentEntriesCache.set(rceptNo, { at: Date.now(), entries: [] });
    return [];
  }
  if (!response.ok) {
    // 일시 실패가 반복될 때 매 화면 갱신마다 10초씩 대기하지 않도록 짧게 음성 캐시합니다.
    documentEntriesCache.set(rceptNo, { at: Date.now(), entries: [] });
    return [];
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const entries = unzipAll(bytes).filter((entry) => /\.(xml|html?|xhtml)$/i.test(entry.name));
  documentEntriesCache.set(rceptNo, { at: Date.now(), entries });
  return entries;
}

/**
 * 본문 API에 감가상각·무형자산상각 계정이 없을 때 공시 원문 첨부의 표를 확인합니다.
 * 당기/누계 열과 표 단위가 확인되는 동일 표 안에서 합계 계정 또는 감가상각+무형자산상각을
 * 모두 찾은 경우에만 결과를 반환합니다. 열·단위가 모호하거나 서로 다른 표의 값만 존재하면 추정하지 않습니다.
 */
async function depreciationFromDisclosure(rceptNo: string, period: Period, requestKey?: string): Promise<{ value: number; lines: string[] } | null> {
  const entries = await disclosureEntries(rceptNo, requestKey).catch(() => []);
  const parsed = parseDepreciationFromDisclosure(entries, period);
  return parsed ? { value: parsed.value, lines: parsed.lines } : null;
}

/**
 * 홈·질문하기·연도별 조회·비교분석이 같은 지표 계산 경로를 사용하도록 하는 표준 추출기.
 * 총차입금/의존도는 DART 원문 주석의 리스부채 보정을 적용하고, EBITDA 본문 값이 없을 때는
 * 같은 접수번호의 주석에서 상각비를 확인해 계산합니다. 미확인 값을 0으로 대체하지 않습니다.
 */

/**
 * 홈·질문하기·연도별 조회·비교분석이 같은 지표 계산 경로를 사용하도록 하는 표준 추출기.
 * 총차입금/의존도는 DART 원문 주석의 리스부채 보정을 적용하고, EBITDA 본문 값이 없을 때는
 * 같은 접수번호의 주석에서 상각비를 확인해 계산합니다. 미확인 값을 0으로 대체하지 않습니다.
 */
async function pickMetricWithOriginalFallback(args: {
  corp: Corp & { name: string };
  rows: Row[];
  period: Period;
  basis: "CFS" | "OFS";
  metric: FinancialMetric;
  requestKey?: string;
}): Promise<{ picked: PickedMetric | null; url: string | null }> {
  const { corp, rows, period, basis, metric, requestKey } = args;
  let picked = pickMetric(rows, period, metric);
  let url: string | null = null;
  const rceptNo = rows.find((row) => row.rcept_no)?.rcept_no ?? "";

  if (metric === "borrowings" || metric === "borrowingsRatio") {
    const corrected = await withDartLeaseFallback({ corp, rows, period, basis, metric, picked, rceptNo, requestKey });
    picked = corrected.picked ?? picked;
    url = corrected.url;
  }

  if (metric === "ebitda" && (!picked || !Number.isFinite(picked.value))) {
    const operatingProfit = pickMetric(rows, period, "operatingProfit");
    if (operatingProfit && Number.isFinite(operatingProfit.value) && /^\d{14}$/.test(rceptNo)) {
      const depreciation = await depreciationFromDisclosure(rceptNo, period, requestKey);
      if (depreciation && Number.isFinite(depreciation.value)) {
        const value = operatingProfit.value + depreciation.value;
        picked = {
          value,
          unit: "억원",
          lines: [`영업이익 ${won(operatingProfit.value)}`, ...depreciation.lines, `EBITDA ${won(value)}`],
          formula: `EBITDA = 영업이익 ${won(operatingProfit.value)} + DART 원문 주석 감가상각·상각비 ${won(depreciation.value)} = ${won(value)}`,
          disclaimer: null,
          sourceHeading: "DART 원문 주석 > 감가상각·상각비",
        };
      }
    }
  }

  return { picked, url };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 등록 기업의 신규 공시 확인. DART list.json의 실제 접수번호만 반환합니다. */
export async function recentFilingsDart(companyNames: string[], fromDate: string, requestKey?: string, requestedEndDate?: string) {
  if (!/^\d{8}$/.test(fromDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "조회 시작일은 YYYYMMDD 형식이어야 합니다." });
  const endDate = requestedEndDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const map = await corps(false, requestKey);
  const names = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  const results = await mapWithConcurrency(names, 3, async (requested) => {
    const corp = findCorp(requested, map);
    if (!corp) return { rows: [] as Array<{ company: string; reportName: string; receiptDate: string; rceptNo: string; url: string }>, warning: `${requested}: DART 기업코드 미확인` };
    const params = new URLSearchParams({ crtfc_key: key(requestKey), corp_code: corp.code, bgn_de: fromDate, end_de: endDate, page_no: "1", page_count: "100", sort: "date", sort_mth: "desc" });
    try {
      const response = await dartFetch(`${BASE}/list.json?${params}`, { cache: "no-store", headers: { "Cache-Control": "no-cache" } }, 8_000);
      if (!response.ok) return { rows: [], warning: `${corp.name}: DART HTTP ${response.status}` };
      const json = await response.json() as { status: string; message?: string; list?: DartFiling[] };
      if (json.status === "013") return { rows: [], warning: null };
      if (json.status !== "000") return { rows: [], warning: `${corp.name}: DART 상태 ${json.status} ${json.message ?? "공시 조회 실패"}` };
      const rows = (json.list ?? []).filter((item) => /^\d{14}$/.test(item.rcept_no ?? "") && (item.rcept_dt ?? "") >= fromDate && (item.rcept_dt ?? "") <= endDate)
        .map((item) => ({ company: corp.name, reportName: item.report_nm, receiptDate: item.rcept_dt, rceptNo: item.rcept_no, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}` }));
      return { rows, warning: null };
    } catch (error) {
      return { rows: [], warning: `${corp.name}: ${error instanceof Error ? error.message : "네트워크 조회 실패"}` };
    }
  });
  return {
    rows: results.flatMap((result) => result.rows).sort((a, b) => b.receiptDate.localeCompare(a.receiptDate) || b.rceptNo.localeCompare(a.rceptNo)),
    warnings: results.map((result) => result.warning).filter((warning): warning is string => Boolean(warning)),
    fromDate,
    endDate,
    checkedCompanies: names.length,
  };
}

function formatMetricValue(value: number, unit: string) {
  if (!Number.isFinite(value)) return "자료 없음";
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "원") return `${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${unit}`;
  // 억원 값은 소수점 첫째 자리까지 보존합니다. 정확한 원 단위 금액은 DART 원문 표에 별도로 남습니다.
  return `${value.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unit}`;
}


/** 기사 검증은 기간·회계기준을 바꾸거나 외부 추정값으로 대체하지 않습니다. */

/** 기사 검증은 기간·회계기준을 바꾸거나 외부 추정값으로 대체하지 않습니다. */
export async function financialFactSource(input: {company:string;year:number;kind:Kind;mode:"cum"|"qtr";basis:"CFS"|"OFS";metric:FinancialMetric|string}, requestKey?:string) {
  const corp = findCorp(input.company, await corps(false,requestKey));
  if (!corp || corp.name !== input.company) return null;
  const period=P(input.year,input.kind,input.mode);
  const rows=await statements(corp.code,input.year,period.code,input.basis,false,requestKey);
  if (!rows) return null;
  const direct=["자산총계","부채총계","자본총계","현금및현금성자산","매출채권","재고자산","유동자산","비유동자산","유동부채","비유동부채"].includes(input.metric);
  const picked=direct ? pickDirectAccount(rows,period,input.metric) : (await pickMetricWithOriginalFallback({corp,rows,period,basis:input.basis,metric:input.metric as FinancialMetric,requestKey})).picked;
  if (!picked || !Number.isFinite(picked.value)) return null;
  const receipt=rows.find(r=>/^\d{14}$/.test(r.rcept_no??""))?.rcept_no;
  if (!receipt) return null;
  return {value:picked.value,unit:picked.unit,url:`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`,citation: citation(`${periodLabel(period)} · ${modeLabel(period)} · ${fsLabel(input.basis)}`,picked.sourceHeading,receipt)};
}

export async function articleCompanyNames(article:string, fallback:string, requestKey?:string) {
  const map=await corps(false,requestKey);
  const exact=fallback ? findCorp(fallback,map) : undefined;
  if (fallback && !exact) throw new TRPCError({code:"NOT_FOUND",message:"기준 기업명을 DART 기업목록에서 찾지 못했습니다. 정확한 법인명을 입력해 주세요."});
  // 비상장 공시법인(예: LS전선)도 인식하되 짧은 일반 상호가 본문과 우연히 겹치는 경우는 제외합니다.
  return [...new Set([...(exact?[exact.name]:[]),...[...map].filter(([name,corp])=>((name.length>=4 && article.includes(name)) || (corp.stock && name.length>=2 && new RegExp('(?<![A-Za-z0-9가-힣])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9가-힣])').test(article)))).map(([name])=>name)])];
}

export const articleDisclosureEntries=disclosureEntries;

/** 표준 재무계정에 없는 수주잔고를 같은 사업기간의 정기보고서 원문에서 확인합니다. */

/** 표준 재무계정에 없는 수주잔고를 같은 사업기간의 정기보고서 원문에서 확인합니다. */
export async function articlePeriodDisclosure(input:{company:string;year:number;kind:Kind;basis:"CFS"|"OFS"},requestKey?:string){
  const corp=findCorp(input.company,await corps(false,requestKey));
  if(!corp)return null;
  const period=P(input.year,input.kind,"cum");
  const filing=await filingForPeriod(corp.code,input.year,period.code,requestKey);
  if(!filing)return null;
  const entries=await disclosureEntries(filing.rceptNo,requestKey);
  return {entries,url:`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${filing.rceptNo}`,citation:`${input.company} · ${input.year}년 ${input.kind==='annual'?'사업보고서':input.kind==='half'?'반기보고서':input.kind==='q1'?'1분기 보고서':'3분기 보고서'} · ${filing.reportName}`};
}

/** 캐시를 비웁니다(테스트·수동 새로고침용). */
export async function clearDartCaches() {
  corpCache = null;
  stmtCache.clear();
  filingCache.clear();
  documentEntriesCache.clear();
  clearCrossValidationCache();
  return { ok: true as const, refreshedAt: new Date().toISOString() };
}
