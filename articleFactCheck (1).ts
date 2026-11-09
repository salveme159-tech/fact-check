export type FactCheckInput = {
  article: string;
  company?: string;
  year?: number;
  period?: "annual" | "half" | "q1" | "q3";
  mode?: "cum" | "qtr";
  basis?: "CFS" | "OFS";
  articleDate?: string;
  contractReceipt?: string;
};
export type ResolvedFactCheckInput = Required<Omit<FactCheckInput, "contractReceipt">> & { contractReceipt?: string; automatic: boolean; dateDetected: boolean };

/** 기사에 표기된 부호. 값(value)은 부호가 이미 반영돼 있고, 이 필드는 그 근거를 설명합니다. */
export type ClaimSign = "negative" | "positive" | "unsigned";
/** 기업이 어떻게 정해졌는지: 같은 문장에 직접 언급 / 앞 문장에서 이어받음(다기업 기사에서는 확인 권장) / 기사 내 단일 기업 */
export type CompanySource = "sentence" | "carried" | "single";
/** 불일치의 성격: 부호만 다름 / 부호·크기 모두 다름 / 10배수 자릿수(단위) 의심 / 증감 방향 반대 / 단순 수치 차이 */
export type MismatchKind = "SIGN" | "SIGN_VALUE" | "UNIT" | "DIRECTION" | "VALUE";

export type FactClaim = {
  id: number; start: number; end: number; text: string; sentence: string;
  company: string; label: string; value: number; unit: string;
  year: number; period: "annual" | "half" | "q1" | "q3"; mode: "cum" | "qtr"; basis: "CFS" | "OFS";
  comparison?: {year:number;period:"annual"|"half"|"q1"|"q3";mode:"cum"|"qtr"};
  metric?: string; growth?: "increase" | "decrease"; approximate: boolean; tolerance: number;
  status: "MATCH" | "MISMATCH" | "UNVERIFIED";
  actual: number | null; actualText: string; message: string;
  sourceUrl?: string; sourceLabel?: string; basisLabel?: string;
  /** 기사 수치를 부호 포함으로 표기한 문자열 (예: "−123억원", "+5.2%") */
  valueText?: string;
  sign?: ClaimSign; signEvidence?: string;
  companySource?: CompanySource;
  /** 기간이 어떤 문구에서 어떻게 해석됐는지 (예: ‘지난해’ → 2025년) */
  periodNote?: string;
  /** 연도·기간이 이 문장(또는 화면 입력)에서 확정됐는지. false면 앞 문맥에서 이어받은 값 */
  periodExplicit?: boolean;
  /** 판정 방식: DART 공시 대조 / 기사 안의 두 금액으로 증감률을 계산한 내부 검증 */
  checkType?: "dart" | "internal";
  /** 기사 내부 계산 근거(‘A→B 금액으로 계산한 증감률’) */
  internal?: { computed: number; from: number; to: number; ok: boolean; text: string };
  mismatchKind?: MismatchKind;
  /** 기사값 − 공시값 (같은 단위) */
  difference?: number;
};
/** 기사에서 찾은 날짜·기간 표현과 해석 결과. 수치 판정과는 별개로 원문에 표시됩니다. */
export type DateMention = { start: number; end: number; text: string; resolved: string };
export type CompanySummary = { name: string; total: number; matched: number; mismatched: number; unverified: number };
export type FactCheckResult = {
  article: string; claims: FactClaim[]; checkedAt: string;
  summary: { matched: number; mismatched: number; unverified: number; reference: number };
  companies: CompanySummary[];
  dates: DateMention[];
  contractCandidates: Array<{ company: string; reportName: string; rceptNo: string; receiptDate: string; url: string }>;
  warnings: string[];
};

/** 공시와 직접 대조할 수 없는 수치(지표 미식별, 구성비·변동액·퍼센트포인트)는 판정이 아니라 ‘참고 수치’로 분류합니다. */
export function isReferenceClaim(c: Pick<FactClaim, "metric" | "message" | "checkType">): boolean {
  if (c.checkType === "internal") return false;
  return !c.metric || /증감률·구성비의 기준|운전자금 변동액|증감액\(변동폭\)|퍼센트포인트 변동/.test(c.message);
}
