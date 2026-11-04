// DART 재무 데이터 처리 핵심 로직. 네트워크와 분리해 단위 테스트할 수 있도록 구성합니다.
import { inflateRawSync } from "node:zlib";

export const DISCLAIMER = "※ 본 순차입금 계산은 리스부채를 제외하고, 단기금융상품을 포함한 보수적 기준을 적용하였습니다.";

export const ALIASES: Record<string, string> = {
  삼전: "삼성전자",
  현차: "현대자동차",
  하닉: "SK하이닉스",
  엘지: "LG",
  네이버: "NAVER",
};

export function normalizeQuestion(q: string): string {
  let s = q.replace(/\(주\)|㈜|주식회사/g, "");
  for (const [k, v] of Object.entries(ALIASES)) s = s.split(k).join(v);
  return s;
}

export type Corp = { code: string; stock: string };

export function parseCorps(xml: string): Map<string, Corp> {
  const out = new Map<string, Corp>();
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const t = (tag: string) => m[1].match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? "";
    const name = t("corp_name");
    const stock = t("stock_code");
    const prev = out.get(name);
    if (!name || !t("corp_code")) continue;
    if (prev?.stock && !stock) continue;
    out.set(name, { code: t("corp_code"), stock });
  }
  return out;
}

export function findCorp(q: string, corps: Map<string, Corp>) {
  const s = normalizeQuestion(q);
  let best = "";
  for (const [n, c] of corps) {
    if (n.length < (c.stock ? 2 : 3)) continue;
    if (s.includes(n) && n.length > best.length) best = n;
  }
  return best ? { name: best, ...corps.get(best)! } : null;
}

export function searchCorps(query: string, corps: Map<string, Corp>, limit = 12) {
  const q = normalizeQuestion(query).trim().toLowerCase();
  if (!q) return [];
  return [...corps.entries()]
    .filter(([name, corp]) => {
      const hay = `${name} ${corp.stock}`.toLowerCase();
      return hay.includes(q);
    })
    .sort(([a, ac], [b, bc]) => {
      const rank = (name: string, corp: Corp) => (name.toLowerCase() === q ? 0 : name.toLowerCase().startsWith(q) ? 1 : corp.stock === q ? 2 : 3);
      return rank(a, ac) - rank(b, bc) || a.localeCompare(b, "ko");
    })
    .slice(0, limit)
    .map(([name, corp]) => ({ name, code: corp.code, stock: corp.stock }));
}

export function unzipFirst(buf: Buffer): string {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("ZIP 형식이 아닙니다(키 오류 가능): " + buf.toString("utf8", 0, 200));
  const cd = buf.readUInt32LE(e + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
}

/** OpenDART document.xml 응답 ZIP에서 모든 문서 엔트리를 읽습니다. */
export function unzipAll(buf: Buffer): Array<{ name: string; text: string }> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("DART 원문 파일이 유효한 ZIP이 아닙니다.");
  const total = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; text: string }> = [];
  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      try {
        const data = method === 8 ? inflateRawSync(compressed) : method === 0 ? compressed : null;
        if (data) {
          // DART 첨부 원문 ZIP 안의 HTML/XML은 UTF-8이 아닌 EUC-KR로 내려오는 경우가 있습니다.
          // UTF-8 고정 디코딩은 한글 주석의 계정명·기간 머리글을 깨뜨려 EBITDA 계정 탐색을 실패시킵니다.
          let utf8 = "";
          let isValidUtf8 = false;
          try { utf8 = new TextDecoder("utf-8", { fatal: true }).decode(data); isValidUtf8 = true; } catch { utf8 = data.toString("utf8"); }
          let euc = "";
          if (!isValidUtf8) {
            try { euc = new TextDecoder("euc-kr").decode(data); } catch { /* 런타임에 EUC-KR 디코더가 없으면 UTF-8 대체 */ }
          }
          const text = !isValidUtf8 && euc ? euc : utf8;
          out.push({ name, text });
        }
      } catch { /* 손상된 엔트리는 다른 원문 파일을 읽는 데 영향을 주지 않도록 건너뜁니다. */ }
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export const fsDivFor = (q: string): "CFS" | "OFS" => (/별도|개별/.test(q) ? "OFS" : "CFS");
export const fsLabel = (fs: "CFS" | "OFS") => (fs === "CFS" ? "연결 기준" : "별도 기준");
export const parseYear = (q: string): number | null => {
  const m = q.match(/20\d\d/);
  return m ? Number(m[0]) : null;
};

export type Row = {
  sj_div?: string;
  sj_nm?: string;
  account_id?: string;
  unit?: string;
  thstrm_nm?: string;
  account_nm?: string;
  thstrm_amount?: string;
  thstrm_add_amount?: string;
  frmtrm_amount?: string;
  bfefrmtrm_amount?: string;
  rcept_no?: string;
};

const N = (s?: string) => (s ?? "").replace(/[\s·ㆍ]/g, "");
const AMT = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"] as const;

export function amountOf(r: Row, idx = 0, cum = false): number | null {
  const raw = ((cum && idx === 0 && r.thstrm_add_amount ? r.thstrm_add_amount : r[AMT[idx]]) ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  // DART 원문에서 명시적으로 0을 뜻하는 대시와 괄호 음수를 표준화합니다.
  if (/^(?:-|—|–|－|−)$/.test(raw)) return 0;
  const negativeParentheses = /^\(.*\)$/.test(raw);
  const n = Number(negativeParentheses ? `-${raw.slice(1, -1)}` : raw);
  return Number.isFinite(n) ? n / 1e8 : null;
}

export const findRow = (rows: Row[], sj: string[], names: string[]) => {
  const target = names.map(N);
  return rows.find((r) => sj.includes(r.sj_div ?? "") && target.includes(N(r.account_nm)) && !N(r.account_nm).includes("리스"));
};

/**
 * 매출은 회사·연도에 따라 계정명이 "매출액", "영업수익", "수익(매출액)" 또는
 * IFRS 표준계정코드로 반환될 수 있습니다. 재무제표 API의 account_id를 우선
 * 활용하되, 매출원가·매출채권·기타수익을 매출로 오인하지 않습니다.
 */
export const findRevenueRow = (rows: Row[], sj: string[] = ["CIS", "IS"]) => {
  const normalize = (value?: string) => N(value).replace(/[()（）,，:：]/g, "").toLowerCase();
  const exactNames = [
    "매출액", "수익(매출액)", "영업수익", "매출", "매출(수익)", "수익",
    "고객과의계약에서생기는수익", "고객과의계약에서생기는수익(매출액)", "고객과의계약에서발생하는수익",
  ].map(normalize);
  const idPattern = /^(?:ifrs-full_Revenue|dart_OperatingRevenue|ifrs-full_RevenueFromContractsWithCustomers|ifrs-full_RevenueFromContractsWithCustomersIncludingAmountsCollectedOnBehalfOfThirdParties)$/i;
  const exclude = /매출채권|매출원가|매출총이익|매출할인|매출에누리|매출환입|기타수익|금융수익|지분법수익|영업외수익|법인세수익/;
  const candidates = rows.flatMap((row) => {
    if (!sj.includes(row.sj_div ?? "")) return [];
    const rawName = N(row.account_nm);
    const name = normalize(row.account_nm);
    const accountId = String(row.account_id ?? "");
    if (exclude.test(rawName)) return [];
    const idMatch = idPattern.test(accountId);
    const exactIndex = exactNames.indexOf(name);
    const prefixMatch = ["매출액", "수익매출액", "영업수익", "매출수익", "고객과의계약에서생기는수익", "고객과의계약에서발생하는수익"].some((alias) => name.startsWith(normalize(alias)));
    if (!idMatch && exactIndex < 0 && !prefixMatch) return [];
    // 값이 있는 행을 우선하고, 표준 계정코드/정확한 계정명/접두어 순으로 선택합니다.
    const raw = row.thstrm_add_amount || row.thstrm_amount || "";
    const hasAmount = raw.trim() !== "";
    const rank = idMatch ? 0 : exactIndex >= 0 ? 1 + exactIndex : 20;
    return [{ row, score: (hasAmount ? 0 : 100) + rank }];
  });
  candidates.sort((a, b) => {
    const statementRank = (row: Row) => sj.indexOf(row.sj_div ?? "");
    return a.score - b.score || statementRank(a.row) - statementRank(b.row) || N(a.row.account_nm).length - N(b.row.account_nm).length;
  });
  return candidates[0]?.row;
};

export const findRowLike = (rows: Row[], sj: string[], names: string[]) => {
  const target = names.map(N);
  const candidates = rows.filter((r) => {
    const account = N(r.account_nm);
    // 부분 문자열 포함만으로 선택하면 '기타수익', '매출채권' 등 인접 계정이 잘못 잡힐 수 있습니다.
    return sj.includes(r.sj_div ?? "") && target.some((n) => account === n || (n.length >= 3 && account.startsWith(n) && !(/^(매출채권|매출원가|매출총이익)/.test(account) && n === "매출"))) && !account.includes("리스");
  });
  // 핵심: 요청한 재무제표 종류 우선순위(CIS→IS 등)를 계정명 점수보다 먼저 반영합니다.
  // CFS 응답 안에 IS와 CIS의 동명 계정이 함께 있을 때 별도 손익 숫자를 고르는 오류를 방지합니다.
  const statementRank = (row: Row) => {
    const rank = sj.indexOf(row.sj_div ?? "");
    return rank < 0 ? 999 : rank;
  };
  const accountRank = (account: string) => {
    const exact = target.findIndex((n) => account === n);
    if (exact >= 0) return exact * 10;
    const prefix = target.findIndex((n) => account.startsWith(n));
    return prefix >= 0 ? prefix * 10 + 1 : 999;
  };
  return candidates.sort((a, b) =>
    statementRank(a) - statementRank(b) ||
    accountRank(N(a.account_nm)) - accountRank(N(b.account_nm)) ||
    N(a.account_nm).length - N(b.account_nm).length
  )[0];
};

type Groups = [string, string[]][];
const DEBT: Groups = [
  ["단기차입금", ["단기차입금", "단기차입부채", "단기금융기관차입금", "단기은행차입금", "단기차입금및사채", "유동차입금", "유동성금융기관차입금"]],
  ["유동성장기부채", ["유동성장기부채", "유동성장기차입금", "유동성장기차입부채", "유동성차입부채", "유동성차입금", "유동성사채", "유동성장기사채", "유동성전환사채", "유동성신주인수권부사채", "유동성교환사채", "비유동차입금의유동성대체부분"]],
  ["장기차입금", ["장기차입금", "장기차입부채", "장기금융기관차입금", "비유동차입금", "비유동차입부채"]],
  ["사채", ["사채", "회사채", "전환사채", "신주인수권부사채", "교환사채", "단기사채"]],
];
const LIQ: Groups = [["현금및현금성자산", ["현금및현금성자산"]], ["단기금융상품", ["단기금융상품", "단기금융자산", "단기예치금"]]];

// 재무상태표에서 계정에 명시된 대시(-/—)는 해당 시점의 공시상 0으로 해석합니다.
// 빈 문자열, 계정 행 자체의 부재, 파싱 불가 값은 0으로 바꾸지 않습니다.
function debtAmountOf(row: Row, idx = 0): number | null {
  const amountFields = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"] as const;
  const raw = (row[amountFields[idx]] ?? "").replace(/,/g, "").trim();
  if (/^(?:-|—|–|－|−)$/.test(raw)) return 0;
  return amountOf(row, idx);
}

export type Item = { group: string; account: string; amount: number; sign: "+" | "−" };

function findDebtRow(rows: Row[], names: string[], group: string, idx = 0): Row | undefined {
  const aliases = names.map(N);
  const accountIds: Record<string, RegExp> = {
    "단기차입금": /ShorttermBorrowings|ShortTermBorrowings|ShorttermLoansAndBorrowings|ShortTermLoansAndBorrowings|CurrentBorrowings|BorrowingsCurrent|CurrentLoansAndBorrowings|LoansAndBorrowingsCurrent|CurrentFinancialInstitutionBorrowings/i,
    "유동성장기부채": /CurrentPortionOfLongtermBorrowings|CurrentPortionOfLongTermBorrowings|CurrentPortionOfLongtermLoans|CurrentPortionOfLongTermLoans|CurrentPortionOfLongtermDebt|CurrentPortionOfLongTermDebt|CurrentPortionOfLongtermLiabilities|CurrentPortionOfLongTermLiabilities|CurrentMaturitiesOfLongtermBorrowings|CurrentMaturitiesOfLongTermBorrowings/i,
    "장기차입금": /LongtermBorrowings|LongTermBorrowings|LongtermLoansAndBorrowings|LongTermLoansAndBorrowings|LongtermDebtNoncurrent|BorrowingsNoncurrent|NoncurrentBorrowings|NoncurrentLoansAndBorrowings/i,
    "사채": /BondsIssued|ConvertibleBondsIssued|DebenturesIssued|BondsPayable/i,
  };
  const idPattern = accountIds[group];
  const candidates = rows.filter((row) => {
    if (row.sj_div !== "BS") return false;
    const account = N(row.account_nm);
    const accountId = row.account_id ?? "";
    if ((!account && !(idPattern && idPattern.test(accountId))) || account.includes("리스")) return false;
    // 할인발행차금·장부가액 조정 등 차입금의 원금 잔액이 아닌 contra 계정은 총차입금에서 제외합니다.
    if (/사채할인발행차금|차입금할인발행차금|미상각할인차금|할인발행차금|상환할증금|사채발행비/.test(account)) return false;
    // 총차입금·차입금및사채 등 포괄 합계행은 구성 계정 그룹에 중복 포함하지 않습니다.
    if (/^(총차입금|차입금총계|차입금합계|총차입부채|차입금및사채|차입금및회사채|차입금과사채)$/.test(account)) return false;
    // 유동성 사채는 유동성장기부채 그룹에서 한 번만 집계합니다.
    if (group === "사채" && account.startsWith("유동성")) return false;
    if (group === "장기차입금" && (account.startsWith("유동성") || /CurrentPortion/i.test(accountId))) return false;
    // '단기차입금 및 사채'는 단기 그룹에서 이미 집계될 수 있으므로 사채 그룹에서 중복 합산하지 않습니다.
    if (group === "사채" && /^(단기차입금및사채|단기사채및차입금)/.test(account)) return false;
    // '장기차입금(사채 포함)'은 사채 금액을 이미 포함합니다.
    if (group === "사채" && /장기차입금.*사채포함|장기차입금포함.*사채/.test(account)) return false;
    const nameMatch = aliases.some((alias) => account === alias || account.startsWith(alias) || account.includes(alias));
    return nameMatch || Boolean(idPattern?.test(accountId));
  });
  const rank = (account: string, accountId: string) => {
    if (aliases.some((alias) => account === alias)) return 0;
    if (aliases.some((alias) => account.startsWith(alias))) return 1;
    if (idPattern?.test(accountId)) return 2;
    return 3;
  };
  // 같은 계정의 주석/표기 행이 복수면, 우선 실제 당기 금액을 읽을 수 있는 행을 선택합니다.
  return candidates.sort((a, b) => {
    const aa = N(a.account_nm), bb = N(b.account_nm);
    const av = debtAmountOf(a, idx), bv = debtAmountOf(b, idx);
    const unavailableA = av === null || !Number.isFinite(av) ? 1 : 0;
    const unavailableB = bv === null || !Number.isFinite(bv) ? 1 : 0;
    return unavailableA - unavailableB || rank(aa, a.account_id ?? "") - rank(bb, b.account_id ?? "") || aa.length - bb.length;
  })[0];
}

export function netDebt(rows: Row[], idx = 0) {
  const items: Item[] = [];
  const missing: string[] = [];
  const debtMissing: string[] = [];
  const liquidMissing: string[] = [];
  const collect = (groups: Groups, sign: "+" | "−", missingGroup: string[]) => {
    let sum = 0;
    for (const [group, names] of groups) {
      // If a long-term row explicitly states that bonds are included, the bond group is already covered.
      const longTermIncludesBonds = group === "사채" && rows.some((row) => row.sj_div === "BS" && /(?:장기차입금|비유동차입(?:금|부채)).*사채.*포함|(?:장기차입금|비유동차입(?:금|부채)).*포함.*사채/.test((row.account_nm ?? "").replace(/[\s·ㆍ]/g, "")) && debtAmountOf(row, idx) !== null);
      if (longTermIncludesBonds) continue;
      const row = findDebtRow(rows, names, group, idx);
      const amount = row ? debtAmountOf(row, idx) : null;
      if (row && amount !== null && Number.isFinite(amount)) {
        items.push({ group, account: (row.account_nm ?? "").trim(), amount, sign });
        sum += amount;
      } else {
        missingGroup.push(group);
        missing.push(group);
      }
    }
    return sum;
  };
  const totalDebt = collect(DEBT, "+", debtMissing);
  const liquid = collect(LIQ, "−", liquidMissing);
  const allDebtKnown = debtMissing.length === 0;
  const allLiquidKnown = liquidMissing.length === 0;
  if (!allDebtKnown || !allLiquidKnown) {
    return {
      ok: false as const,
      debtKnown: allDebtKnown,
      liquidKnown: allLiquidKnown,
      debtMissing,
      liquidMissing,
      reason: `구성 계정이 모두 확인되지 않아 계산하지 않았습니다: ${missing.join(", ")}`,
      items, missing, totalDebt, liquid,
    };
  }
  return {
    ok: true as const,
    debtKnown: true as const,
    liquidKnown: true as const,
    debtMissing: [] as string[],
    liquidMissing: [] as string[],
    value: totalDebt - liquid,
    totalDebt,
    liquid,
    items,
    missing,
    formula: "순차입금 = (단기차입금 + 유동성장기부채 + 장기차입금 + 사채) − (현금및현금성자산 + 단기금융상품)",
    disclaimer: DISCLAIMER,
  };
}

export const dartUrl = (rcept: string) => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept}`;
export const citation = (label: string, heading: string, rcept: string) => `📄 출처: [${label}] > [${heading}] (${dartUrl(rcept)})`;
export function chunkByHeading(text: string): { heading: string; body: string }[] {
  const chunks: { heading: string; body: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\d+\.\s.*/.test(line.trim())) chunks.push({ heading: line.trim(), body: "" });
    else if (chunks.length) chunks[chunks.length - 1].body += line + "\n";
  }
  return chunks;
}

export const SYSTEM_PROMPT = `너는 DART 공시 재무 팩트체커다.\n1) 사용자가 쓴 기업명은 약어·(주) 표기를 제거해 DART 공식 명칭으로 정규화한 뒤 도구에 전달하라.\n2) 순차입금 등 계산이 필요한 지표는 반드시 내장 함수 결과를 그대로 사용하라.\n3) 도구가 반환하지 않은 수치는 만들지 말고 "해당 자료를 찾을 수 없습니다"라고 답하라.\n4) 모든 수치에 연결/별도 기준, 계산식(계산 지표인 경우), 출처 링크를 함께 표시하라.`;

export const DEFAULT_COMPANY = "대한전선";
const VOCAB = /순차입금|순부채|차입금의존도|총차입금|차입금|영업활동현금흐름|영업현금흐름|영업현금|투자현금흐름|재무현금흐름|현금흐름|영업이익[률율]?|영업익|당기순이익|당기순익|순이익[률율]?|순익|매출원가|매출총이익|매출채권|매출액|매출|운전자본|FCF|잉여현금흐름|자유현금흐름|capex|설비투자|자본적지출|유형자산|취득|부채비율|유동비율|영업마진|연도|개년|연간|상반기|하반기|반기|분기|사업보고서|연결|별도|개별|기준|재무제표|올해|금년|작년|지난해|전년도|최근|지난|직전|알려줘|알려주세요|알려|얼마야|얼마|보여줘|조회|궁금|추이|증가|감소|비교|차이|전년|20\d\d|[0-9]+|년|월|도/gi;
const PARTICLE = /^(은|는|이|가|을|를|의|도|만|좀|해줘|줘|야|요|해|주세요|인가요|뭐야|어때|입니까)+$/;
// Direct account names must not be mistaken for unknown company names. Keep longest
// terms first so a shorter alias does not leave a misleading suffix behind.
const KNOWN_FINANCIAL_TERMS = [
  "비유동차입금의유동성대체부분", "현금및현금성자산", "유동성장기부채", "유동성장기차입금", "유동성장기사채",
  "유동성금융기관차입금", "유동당기손익-공정가치측정금융자산", "비유동당기손익-공정가치측정금융자산",
  "비유동상각후원가측정금융자산", "기타포괄손익-공정가치측정금융자산", "지배기업의소유주에게귀속되는자본",
  "매출채권및기타채권", "영업활동으로인한현금흐름", "투자활동으로인한현금흐름", "재무활동으로인한현금흐름",
  "수익(매출액)", "당기순이익(손실)", "유동매출채권", "비유동매출채권", "현금흐름", "총차입금", "순차입금",
  "유동재고자산", "유동매입채무", "기타유동금융자산", "기타비유동금융자산", "기타유동금융부채",
  "기타비유동금융부채", "기타유동자산", "기타비유동자산", "기타유동부채", "기타비유동부채",
  "영업이익률", "영업이익율", "순이익률", "순이익율", "차입금의존도", "매출총이익", "판매비와관리비",
  "법인세차감전순손익", "지배기업소유주귀속반기순손익", "기본주당순손익", "희석주당순손익",
  "영업활동현금흐름", "투자활동현금흐름", "재무활동현금흐름", "영업현금흐름", "투자현금흐름", "재무현금흐름",
  "단기금융상품", "단기금융자산", "단기대여금", "당기법인세자산", "당기법인세부채", "유동충당부채",
  "비유동충당부채", "이연법인세자산", "이연법인세부채", "자산총계", "부채총계", "자본총계", "자본과부채총계",
  "유동자산", "비유동자산", "유동부채", "비유동부채", "매출채권", "매입채무", "재고자산", "유형자산",
  "무형자산", "투자부동산", "장기차입금", "단기차입금", "유동성전환사채", "유동성사채", "사채", "전환사채",
  "자본금", "기타불입자본", "기타포괄손익누계액", "이익잉여금", "비지배지분", "영업외손익", "기타이익", "기타손실",
  "금융수익", "금융원가", "법인세비용", "반기순손익", "분기순손익", "당기순이익", "당기순손익", "기타포괄손익",
  "총포괄손익", "매출원가", "영업수익", "매출액", "운전자본", "순부채", "차입금", "부채비율", "유동비율",
  "이자보상배율", "자기자본이익률", "총자산이익률", "자산회전율", "ROE", "ROA", "EPS", "EBITDA", "PER", "PBR", "CAPEX", "FCF",
].sort((a, b) => b.length - a.length);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const looksLikeCompany = (q: string) => {
  let residue = q.replace(VOCAB, " ");
  for (const term of KNOWN_FINANCIAL_TERMS) residue = residue.replace(new RegExp(escapeRegExp(term), "gi"), " ");
  return residue
    .split(/[^가-힣A-Za-z&]+/)
    .some((t) => t.length >= 2 && !PARTICLE.test(t));
};

const CODE = { annual: "11011", half: "11012", q1: "11013", q3: "11014" } as const;
export type Kind = keyof typeof CODE;
export type Period = { year: number; kind: Kind; code: string; mode: "cum" | "qtr" };
export const P = (year: number, kind: Kind, mode: "cum" | "qtr" = "cum"): Period => ({ year, kind, code: CODE[kind], mode });

export function periodCandidates(q: string, now = new Date()): Period[] {
  const y = parseYear(q);
  const cur = now.getFullYear();
  const year = y ?? cur;
  const asksCurrentYear = /올해|금년|당해연도/.test(q);
  const asksPreviousYear = /작년|지난해|전년도/.test(q);
  // DART는 별도 "하반기보고서"를 제공하지 않습니다. 연간 값을 하반기 값으로 오인하지 않도록 거부합니다.
  if (/하반기/.test(q)) return [];
  if (/상반기|반기/.test(q)) return [P(year, "half")];
  if (/2\s*분기/.test(q)) return [P(year, "half", "qtr")];
  if (/1\s*분기/.test(q)) return [P(year, "q1")];
  if (/3\s*분기/.test(q)) return [P(year, "q3")];
  if (/사업보고서|연간|연도별|연간실적/.test(q) || (asksPreviousYear && !asksCurrentYear)) {
    return [P(y ?? cur - 1, "annual")];
  }
  if (y && y < cur) return [P(y, "annual")];
  // 정기보고서 제출기한을 고려해 아직 제출되지 않았을 가능성이 높은 보고서를 첫 호출로 두지 않습니다.
  // 예: 10월에는 3분기보고서보다 이미 공개된 반기보고서를 먼저 조회해 기업 등록 대기를 줄입니다.
  const month = now.getMonth() + 1;
  const latest: Period[] = month >= 11
    ? [P(year, "q3"), P(year, "half"), P(year, "q1"), P(year - 1, "annual")]
    : month >= 8
      ? [P(year, "half"), P(year, "q1"), P(year - 1, "annual")]
      : month >= 5
        ? [P(year, "q1"), P(year - 1, "annual")]
        : [P(year - 1, "annual"), P(year - 1, "q3"), P(year - 1, "half")];
  return latest;
}

export const periodFromFilters = (year: number | undefined, period: Kind | "latest", now = new Date()): Period[] => {
  if (period === "latest") return periodCandidates("", now);
  return [P(year ?? now.getFullYear(), period)];
};

const KO = { annual: "사업보고서", half: "반기보고서", q1: "1분기보고서", q3: "3분기보고서" } as const;
export const periodLabel = (p: Period) => `${p.year} ${KO[p.kind]}`;
export const baseDate = (p: Period) => `${p.year}.${{ annual: "12.31", half: "06.30", q1: "03.31", q3: "09.30" }[p.kind]}`;
export const modeLabel = (p: Period) =>
  p.kind === "annual" ? "연간" : p.mode === "qtr" ? "해당 분기(3개월)" : p.kind === "half" ? "상반기 누적(1~6월)" : p.kind === "q1" ? "1분기(1~3월)" : "3분기 누적(1~9월)";

export type FinancialMetric = "revenue" | "operatingProfit" | "netIncome" | "operatingMargin" | "netMargin" | "operatingCashFlow" | "investmentCashFlow" | "financingCashFlow" | "capex" | "freeCashFlow" | "netDebt" | "borrowings" | "borrowingsRatio" | "workingCapital" | "payables" | "debtRatio" | "currentRatio" | "interestCoverage" | "roe" | "roa" | "eps" | "ebitda" | "per" | "pbr";

export type QueryAnalysis = "single" | "comparison" | "trend" | "cause";
export type QueryOutput = "value" | "table" | "trend" | "comparison";
export type ParsedDartQuery = {
  years: number[];
  yearStart: number | null;
  yearEnd: number | null;
  recentYears: number | null;
  kind: Kind | "latest" | null;
  mode: "cum" | "qtr" | null;
  basis: "CFS" | "OFS";
  metrics: FinancialMetric[];
  directAccount: string | null;
  analysis: QueryAnalysis;
  output: QueryOutput;
  hasCauseIntent: boolean;
  explicitPeriod: boolean;
};

const UNIQUE_METRICS = (items: FinancialMetric[]) => [...new Set(items)];

export function parseDartQuery(question: string, now = new Date()): ParsedDartQuery {
  const q = question.replace(/[？?]/g, "").trim();
  const years = [...new Set((q.match(/20\d{2}/g) ?? []).map(Number))];
  const range = q.match(/(20\d{2})\s*(?:~|〜|-|–|—|부터|에서)\s*(20\d{2})/);
  const yearStart = range ? Number(range[1]) : null;
  const yearEnd = range ? Number(range[2]) : null;
  const recent = q.match(/(?<!\d)(\d{1,2})\s*(?:개년치|개년|년치|년|연도)/);
  const recentYears = recent ? Math.max(2, Math.min(12, Number(recent[1]))) : null;

  let kind: ParsedDartQuery["kind"] = null;
  let mode: "cum" | "qtr" | null = null;
  if (/하반기/.test(q)) kind = null;
  else if (/2\s*분기/.test(q)) { kind = "half"; mode = "qtr"; }
  else if (/상반기|반기/.test(q)) kind = "half";
  else if (/1\s*분기/.test(q)) kind = "q1";
  else if (/3\s*분기/.test(q)) kind = "q3";
  else if (/사업보고서|연간|연도별|연간실적/.test(q)) kind = "annual";
  else if (/최신|최근 공시|가장 최근/.test(q)) kind = "latest";

  const metricHits: Array<[RegExp, FinancialMetric]> = [
    [/(?:영업이익\s*[률율]|영업마진(?:율)?|OPM)/i, "operatingMargin"],
    [/(?:당기)?순이익\s*[률율]|순이익률|순이익율|NPM/i, "netMargin"],
    [/(?:영업이익|영업익)(?!\s*[률율])/i, "operatingProfit"],
    [/(?:당기순이익|순이익|순익|당기순익|반기순손익|분기순손익|당기순손익|반기순이익|분기순이익)(?![률율])/i, "netIncome"],
    [/투자활동현금흐름|투자현금흐름|투자활동.*현금/i, "investmentCashFlow"],
    [/재무활동현금흐름|재무현금흐름|재무활동.*현금/i, "financingCashFlow"],
    [/영업활동현금흐름|영업현금흐름|영업현금|영업활동.*현금/i, "operatingCashFlow"],
    [/capex|설비투자|자본적지출|유형자산.?취득/i, "capex"],
    [/EBITDA|에비타|감가상각전영업이익/i, "ebitda"],
    [/FCF|잉여현금흐름|자유현금흐름/i, "freeCashFlow"],
    [/순차입금|순부채/i, "netDebt"],
    [/차입금\s*의존도|차입금의존도/i, "borrowingsRatio"],
    [/(?:^|[\s,])(?:총)?차입금(?!(?:의존도|의존율))(?=(?:은|이|을|의|만|[\s,?.!]|$))/i, "borrowings"],
    [/순?운전자본|운전자본/i, "workingCapital"],
    [/매입채무|매입채무및기타채무/i, "payables"],
    [/부채비율/i, "debtRatio"],
    [/유동비율/i, "currentRatio"],
    [/이자보상배율/i, "interestCoverage"],
    [/ROE|자기자본이익률/i, "roe"],
    [/ROA|총자산이익률/i, "roa"],
    [/EPS|주당순이익|기본주당순손익|희석주당순손익/i, "eps"],
    [/EBITDA|에비타/i, "ebitda"],
    [/PER/i, "per"],
    [/PBR/i, "pbr"],
    [/(?:매출액|매출실적|수익\s*\(\s*매출액\s*\)|영업수익|매출(?=(?:이|은|을|의|과|및|[\s,.:!?]|$)))/i, "revenue"],
  ];
  const metrics = UNIQUE_METRICS(metricHits.filter(([re]) => re.test(q)).map(([, metric]) => metric));
  const ACCOUNT_ALIASES: Array<[string, string[]]> = [
    ["유동자산", ["유동자산"]], ["현금및현금성자산", ["현금및현금성자산"]], ["단기금융상품", ["단기금융상품", "단기금융자산"]],
    ["유동당기손익-공정가치측정금융자산", ["유동당기손익-공정가치측정금융자산"]], ["유동매출채권", ["유동매출채권"]],
    ["단기대여금", ["단기대여금"]], ["기타유동금융자산", ["기타유동금융자산"]], ["유동재고자산", ["유동재고자산", "재고자산"]],
    ["당기법인세자산", ["당기법인세자산"]], ["기타유동자산", ["기타유동자산"]], ["비유동자산", ["비유동자산"]],
    ["비유동당기손익-공정가치측정금융자산", ["비유동당기손익-공정가치측정금융자산"]], ["비유동상각후원가측정금융자산", ["비유동상각후원가측정금융자산"]],
    ["기타포괄손익-공정가치측정금융자산", ["기타포괄손익-공정가치측정금융자산"]], ["지분법적용투자지분", ["지분법적용투자지분"]],
    ["비유동매출채권", ["비유동매출채권"]], ["장기대여금", ["장기대여금"]], ["기타비유동금융자산", ["기타비유동금융자산"]],
    ["사용권자산을포함하는유형자산", ["사용권자산을포함하는유형자산", "유형자산"]], ["무형자산", ["무형자산"]], ["투자부동산", ["투자부동산"]],
    ["비유동순확정급여자산", ["비유동순확정급여자산"]], ["이연법인세자산", ["이연법인세자산"]], ["기타비유동자산", ["기타비유동자산"]],
    ["자산총계", ["자산총계"]], ["유동부채", ["유동부채"]], ["유동매입채무", ["유동매입채무", "매입채무"]],
    ["유동성금융기관차입금", ["유동성금융기관차입금"]], ["비유동차입금의유동성대체부분", ["비유동차입금의유동성대체부분"]],
    ["유동성전환사채", ["유동성전환사채"]], ["기타유동금융부채", ["기타유동금융부채"]], ["당기법인세부채", ["당기법인세부채"]],
    ["유동충당부채", ["유동충당부채"]], ["기타유동부채", ["기타유동부채"]], ["비유동부채", ["비유동부채"]],
    ["장기차입금", ["장기차입금"]], ["기타비유동금융부채", ["기타비유동금융부채"]], ["순확정급여부채", ["순확정급여부채"]],
    ["기타비유동부채", ["기타비유동부채"]], ["비유동충당부채", ["비유동충당부채"]], ["이연법인세부채", ["이연법인세부채"]], ["부채총계", ["부채총계"]],
    ["지배기업의소유주에게귀속되는자본", ["지배기업의소유주에게귀속되는자본"]], ["자본금", ["자본금"]], ["기타불입자본", ["기타불입자본"]],
    ["기타포괄손익누계액", ["기타포괄손익누계액"]], ["이익잉여금", ["이익잉여금", "이익잉여금(결손금)"]], ["비지배지분", ["비지배지분"]], ["자본총계", ["자본총계"]],
    ["자본과부채총계", ["자본과부채총계"]], ["유동성장기부채", ["유동성장기부채", "유동성장기차입금", "유동성사채", "유동성장기사채", "비유동차입금의유동성대체부분"]],
    ["수익", ["수익", "영업수익"]], ["매출원가", ["매출원가"]], ["매출총이익", ["매출총이익"]], ["판매비와관리비", ["판매비와관리비"]],
    ["영업외손익", ["영업외손익"]], ["기타이익", ["기타이익"]], ["기타손실", ["기타손실"]], ["금융수익", ["금융수익"]], ["금융원가", ["금융원가"]],
    ["법인세차감전순손익", ["법인세차감전순손익"]], ["법인세비용", ["법인세비용"]], ["반기순손익", ["반기순손익", "당기순이익", "분기순손익"]],
    ["기타포괄손익", ["기타포괄손익"]], ["총포괄손익", ["총포괄손익"]], ["지배기업소유주귀속반기순손익", ["지배기업의소유주에게귀속되는반기순손익"]],
    ["기본주당순손익", ["기본주당순손익"]], ["희석주당순손익", ["희석주당순손익"]],
    ["영업활동현금흐름", ["영업활동으로인한현금흐름", "영업활동현금흐름", "영업활동순현금흐름"]],
    ["투자활동현금흐름", ["투자활동으로인한현금흐름", "투자활동현금흐름", "투자활동순현금흐름"]],
    ["재무활동현금흐름", ["재무활동으로인한현금흐름", "재무활동현금흐름", "재무활동순현금흐름"]],
  ];
  const nq = N(q);
  const directAccount = [...ACCOUNT_ALIASES].sort((a, b) => Math.max(...b[1].map((x) => N(x).length)) - Math.max(...a[1].map((x) => N(x).length))).find(([, aliases]) => aliases.some((a) => nq.includes(N(a))) )?.[0] ?? null;

  const hasCauseIntent = /증가원인|감소원인|증가\s*이유|감소\s*이유|왜\s*(?:증가|감소|늘|줄)|원인|이유|왜/.test(q);
  const hasComparison = /비교|차이|대비|전년|전년대비|vs|증감|늘었|줄었|증가|감소|높아|낮아|차이가|보다/.test(q) || years.length >= 2 || !!range;
  const hasTrend = /추이|트렌드|추세|연도별|기간별|변화(?:추이)?|흐름\s*(?:추이|변화)/.test(q) || !!recentYears;
  const analysis: QueryAnalysis = hasCauseIntent ? "cause" : hasTrend && !hasComparison ? "trend" : hasComparison ? "comparison" : "single";

  let output: QueryOutput = "value";
  if (hasTrend || recentYears || (range && (Number(range[2]) - Number(range[1]) >= 2))) output = "trend";
  if (metrics.length >= 2 || years.length >= 2 || !!range || /비교|대비|vs|차이/.test(q)) output = "comparison";
  if (/표|테이블|정리해|목록으로/.test(q)) output = "table";

  const explicitPeriod = !!kind && kind !== "latest";
  const resolvedYears = range && yearEnd! >= yearStart! && yearEnd! - yearStart! <= 10
    ? Array.from({ length: yearEnd! - yearStart! + 1 }, (_, i) => yearStart! + i)
    : years;

  return {
    years: resolvedYears,
    yearStart,
    yearEnd,
    recentYears,
    kind,
    mode,
    basis: fsDivFor(q),
    metrics,
    directAccount,
    analysis,
    output,
    hasCauseIntent,
    explicitPeriod,
  };
}

export const METRIC_LABELS: Record<FinancialMetric, string> = {
  revenue: "매출액",
  operatingProfit: "영업이익",
  netIncome: "순이익",
  operatingMargin: "영업이익률",
  netMargin: "순이익률",
  operatingCashFlow: "영업활동현금흐름",
  investmentCashFlow: "투자활동현금흐름",
  financingCashFlow: "재무활동현금흐름",
  capex: "CAPEX",
  freeCashFlow: "FCF(잉여현금흐름)",
  netDebt: "순차입금",
  borrowings: "총차입금",
  borrowingsRatio: "차입금의존도",
  workingCapital: "운전자본",
  payables: "매입채무",
  debtRatio: "부채비율",
  currentRatio: "유동비율",
  interestCoverage: "이자보상배율",
  roe: "ROE",
  roa: "ROA",
  eps: "EPS",
  ebitda: "EBITDA",
  per: "PER",
  pbr: "PBR",
};

export const metricConfig: Record<FinancialMetric, { sj: string[]; names: string[] }> = {
  revenue: { sj: ["CIS", "IS"], names: ["매출액", "수익(매출액)", "영업수익", "매출", "수익", "고객과의계약에서생기는수익", "고객과의계약에서발생하는수익"] },
  operatingProfit: { sj: ["CIS", "IS"], names: ["영업이익", "영업이익(손실)"] },
  netIncome: { sj: ["CIS", "IS"], names: ["반기순손익", "분기순손익", "당기순손익", "반기순이익", "분기순이익", "당기순이익", "당기순이익(손실)", "반기순이익(손실)", "분기순이익(손실)", "연결당기순이익", "연결당기순이익(손실)", "지배기업의소유주에게귀속되는당기순이익", "지배기업소유주지분당기순이익"] },
  operatingMargin: { sj: ["CIS", "IS"], names: [] },
  netMargin: { sj: ["CIS", "IS"], names: [] },
  operatingCashFlow: { sj: ["CF"], names: ["영업활동으로인한현금흐름", "영업활동현금흐름", "영업활동순현금흐름"] },
  investmentCashFlow: { sj: ["CF"], names: ["투자활동으로인한현금흐름", "투자활동현금흐름", "투자활동순현금흐름"] },
  financingCashFlow: { sj: ["CF"], names: ["재무활동으로인한현금흐름", "재무활동현금흐름", "재무활동순현금흐름"] },
  capex: { sj: ["CF"], names: ["유형자산의취득", "유형자산취득"] },
  freeCashFlow: { sj: ["CF"], names: [] },
  netDebt: { sj: ["BS"], names: [] },
  borrowings: { sj: ["BS"], names: [] },
  borrowingsRatio: { sj: ["BS"], names: [] },
  workingCapital: { sj: ["BS"], names: [] },
  payables: { sj: ["BS"], names: ["매입채무", "매입채무및기타채무", "유동매입채무"] },
  debtRatio: { sj: ["BS"], names: ["부채비율"] },
  currentRatio: { sj: ["BS"], names: ["유동비율"] },
  interestCoverage: { sj: ["CIS", "IS"], names: [] },
  roe: { sj: ["BS", "IS", "CIS"], names: [] },
  roa: { sj: ["BS", "IS", "CIS"], names: [] },
  eps: { sj: ["CIS", "IS"], names: ["기본주당순손익", "기본주당순이익", "희석주당순손익"] },
  ebitda: { sj: ["CIS", "IS"], names: [] },
  per: { sj: [], names: [] },
  pbr: { sj: [], names: [] },
};
