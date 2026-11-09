import React, { useMemo, useRef, useState } from "react";
import { apiUrl, apiBaseUrl } from "@/lib/apiBase";
import { isReferenceClaim } from "../../../shared/articleFactCheck";
import type { FactClaim, FactCheckInput, FactCheckResult, MismatchKind } from "../../../shared/articleFactCheck";

const STATUS_LABEL = { MATCH: "일치", MISMATCH: "불일치", UNVERIFIED: "확인 필요" } as const;
const STATUS_COLOR = {
  MATCH: "bg-emerald-100 text-emerald-900",
  MISMATCH: "bg-rose-100 text-rose-900",
  UNVERIFIED: "bg-amber-100 text-amber-900",
} as const;
const KIND_LABEL: Record<MismatchKind, string> = {
  SIGN: "부호 반대",
  SIGN_VALUE: "부호·크기 모두 다름",
  UNIT: "자릿수(단위) 오류 의심",
  DIRECTION: "증감 방향 반대",
  VALUE: "수치 차이",
};
// 기업마다 고정된 색을 줘서, 원문 표시·표·카드에서 같은 기업이 항상 같은 색으로 보이게 합니다.
const COMPANY_COLORS = [
  { chip: "bg-sky-100 text-sky-900 border-sky-300", bar: "border-sky-500", text: "text-sky-700" },
  { chip: "bg-violet-100 text-violet-900 border-violet-300", bar: "border-violet-500", text: "text-violet-700" },
  { chip: "bg-orange-100 text-orange-900 border-orange-300", bar: "border-orange-500", text: "text-orange-700" },
  { chip: "bg-teal-100 text-teal-900 border-teal-300", bar: "border-teal-500", text: "text-teal-700" },
  { chip: "bg-pink-100 text-pink-900 border-pink-300", bar: "border-pink-500", text: "text-pink-700" },
  { chip: "bg-lime-100 text-lime-900 border-lime-300", bar: "border-lime-600", text: "text-lime-700" },
  { chip: "bg-indigo-100 text-indigo-900 border-indigo-300", bar: "border-indigo-500", text: "text-indigo-700" },
  { chip: "bg-stone-200 text-stone-900 border-stone-400", bar: "border-stone-500", text: "text-stone-700" },
];
const PERIOD_NAME = { annual: "연간", half: "상반기", q1: "1분기", q3: "3분기" } as const;

type Filter = "ALL" | "MISMATCH" | "UNVERIFIED" | "MATCH";

function basisText(c: FactClaim) {
  return `${c.year}년 ${PERIOD_NAME[c.period]} · ${c.mode === "qtr" ? "당분기" : "누계/기말"} · ${c.basis === "CFS" ? "연결" : "별도"}`;
}

/** 부호를 한눈에 구분하는 배지: 음수는 빨강(−), 양수는 파랑(+), 증감률은 방향 표시 */
function SignBadge({ claim }: { claim: FactClaim }) {
  if (claim.growth) {
    const down = claim.growth === "decrease";
    return <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${down ? "bg-rose-100 text-rose-800" : "bg-blue-100 text-blue-800"}`}>{down ? "감소(−)" : "증가(+)"}</span>;
  }
  if (claim.unit !== "억원" && claim.unit !== "%") return null;
  const negative = claim.value < 0;
  const evidence = claim.signEvidence ? ` · ${claim.signEvidence}` : claim.sign === "unsigned" ? " · 부호 표기 없음" : "";
  return <span title={evidence.replace(" · ", "")} className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${negative ? "bg-rose-100 text-rose-800" : "bg-blue-100 text-blue-800"}`}>{negative ? "음수(−)" : "양수(+)"}{evidence}</span>;
}

export default function ArticleFactCheckPanel({ apiKey }: { apiKey: string }) {
  const [article, setArticle] = useState("");
  const [receipt, setReceipt] = useState("");
  const [result, setResult] = useState<FactCheckResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [companyFilter, setCompanyFilter] = useState("ALL");
  const lock = useRef(false);
  const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
  const invalidate = () => { setResult(null); setReceipt(""); setFilter("ALL"); setCompanyFilter("ALL"); };

  const check = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const input: FactCheckInput = { article, ...(receipt ? { contractReceipt: receipt } : {}) };
      const response = await fetch(apiUrl("/api/trpc/dart.articleFactCheck"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenDART-Key": apiKey },
        credentials: apiBaseUrl ? "omit" : "same-origin",
        body: JSON.stringify({ json: input }),
        signal: AbortSignal.timeout(180_000),
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload?.error?.json?.message ?? payload?.error?.message ?? "기사 확인에 실패했습니다.");
      const data = payload?.result?.data?.json ?? payload?.result?.data;
      if (!data || !Array.isArray(data.claims)) throw new Error("올바른 확인 결과를 받지 못했습니다.");
      setResult(data as FactCheckResult); setFilter("ALL"); setCompanyFilter("ALL");
    } catch (e) {
      setResult(null); setError(e instanceof Error ? e.message : "확인에 실패했습니다.");
    } finally { lock.current = false; setBusy(false); }
  };

  const colorOf = useMemo(() => {
    const names = result ? result.companies.map(c => c.name) : [];
    return (name: string) => COMPANY_COLORS[Math.max(0, names.indexOf(name)) % COMPANY_COLORS.length];
  }, [result]);

  const visibleClaims = useMemo(() => (result?.claims ?? []).filter(c => !isReferenceClaim(c)).filter(c =>
    (filter === "ALL" || c.status === filter) && (companyFilter === "ALL" || (c.company || "기업 미확인") === companyFilter)), [result, filter, companyFilter]);

  const circled = (id: number) => `[${id}]`;
  // 재무 지표를 식별하지 못한 수치(인원·비중·기타)는 검증 대상이 아니므로 판정 집계에서 빼고 따로 모읍니다.
  const referenceClaims = (result?.claims ?? []).filter(isReferenceClaim);
  const checkedCount = (result?.claims ?? []).length - referenceClaims.length;

  // 원문: 수치는 상태색 + 기업색 밑줄, 날짜·기간은 파란 점선으로 서로 다르게 표시합니다.
  const highlights = () => {
    if (!result) return null;
    type Seg = { start: number; end: number; node: (text: string) => React.ReactNode };
    const segs: Seg[] = result.claims.map(c => ({
      start: c.start, end: c.end,
      node: text => isReferenceClaim(c) ? (
        <span key={`c${c.id}`} title={`참고 수치(검증 대상 아님): ${c.message}`} className="rounded border-b border-dotted border-slate-400 bg-slate-100 px-0.5 text-slate-600">{text}</span>
      ) : (
        <a key={`c${c.id}`} href={`#fact-${c.id}`} title={`${c.company} · ${c.label} · ${STATUS_LABEL[c.status]} · 기사 ${c.valueText ?? c.text} → 공시 ${c.actualText}`}
          className={`rounded border-b-4 px-0.5 font-semibold no-underline ${STATUS_COLOR[c.status]} ${colorOf(c.company || "기업 미확인").bar}`}>
          {text}<sup className="ml-0.5 text-[10px] font-bold text-slate-600">{circled(c.id)}</sup>
        </a>
      ),
    }));
    for (const d of result.dates) {
      if (result.claims.some(c => d.start < c.end && d.end > c.start)) continue;
      segs.push({ start: d.start, end: d.end, node: text => <span key={`d${d.start}`} title={`날짜·기간 해석: ${d.resolved}`} className="rounded border-b-2 border-dotted border-blue-500 bg-blue-50 px-0.5 text-blue-900">{text}</span> });
    }
    // 회사명은 굵게 색을 입혀 문장 안에서 어느 기업의 수치인지 바로 보이게 합니다.
    for (const company of result.companies) {
      const escaped = company.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const m of result.article.matchAll(new RegExp(escaped, "g"))) {
        const start = m.index!, end = start + m[0].length;
        if (segs.some(s => start < s.end && end > s.start)) continue;
        segs.push({ start, end, node: text => <span key={`n${start}`} className={`rounded border px-1 font-bold ${colorOf(company.name).chip}`}>{text}</span> });
      }
    }
    segs.sort((a, b) => a.start - b.start);
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const s of segs) {
      if (s.start < cursor) continue;
      nodes.push(result.article.slice(cursor, s.start));
      nodes.push(s.node(result.article.slice(s.start, s.end)));
      cursor = s.end;
    }
    nodes.push(result.article.slice(cursor));
    return nodes;
  };

  const sentenceWithFigure = (c: FactClaim) => {
    const idx = c.sentence.indexOf(c.text);
    if (idx < 0) return c.sentence;
    return <>{c.sentence.slice(0, idx)}<strong className={`rounded px-0.5 ${STATUS_COLOR[c.status]}`}>{c.text}</strong>{c.sentence.slice(idx + c.text.length)}</>;
  };

  const companyNames = result ? result.companies.map(c => c.name) : [];
  const grouped = companyNames.map(name => ({ name, claims: visibleClaims.filter(c => (c.company || "기업 미확인") === name) }))
    .concat(result && visibleClaims.some(c => !c.company) ? [{ name: "기업 미확인", claims: visibleClaims.filter(c => !c.company) }] : [])
    .filter(g => g.claims.length);

  return (
    <section className="space-y-5">
      <div className="space-y-4 rounded-2xl border bg-white p-5">
        <p className="text-xs leading-5 text-slate-500">
          기사 전체에서 <b>기업명·날짜/기간·금액·퍼센트·부호</b>를 수치마다 따로 인식합니다. 연결 기준이 기본이며 ‘별도’가 명시되면 별도로 확인합니다.
          ‘올해·지난해’는 기사 발행일 기준, 발행일이 없으면 한국 현재 날짜 기준으로 해석하고 그 결과를 원문에 표시합니다.
        </p>
        <textarea aria-label="기사 원문" value={article} maxLength={30000} disabled={busy}
          onChange={e => { setArticle(e.target.value); invalidate(); }} rows={11}
          placeholder="제목과 기사 원문을 입력하세요. 예: 대한전선의 2025년 연결 매출액은 3조 6,360억원, 영업이익은 1,286억원이다."
          className="w-full rounded-xl border border-slate-200 p-4 text-sm leading-7" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">{article.length.toLocaleString()} / 30,000자 · 최대 100개 수치</span>
          <button type="button" disabled={busy || !apiKey || article.trim().length < 10} onClick={() => void check()}
            className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white disabled:opacity-40">{busy ? "API·공시 원문 대조 중…" : "기사 팩트 체크"}</button>
        </div>
        {!apiKey && <p className="text-xs text-amber-700">위에서 OpenDART 인증키를 먼저 등록하세요.</p>}
        {busy && <p role="status" className="text-xs text-slate-500">여러 기간·계약 원문을 확인하면 시간이 걸릴 수 있습니다.</p>}
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      </div>

      {result && <>
        <div role="status" className="flex flex-wrap gap-3 text-sm font-bold">
          <span className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700">불일치 {result.summary.mismatched}건</span>
          <span className="rounded-xl bg-emerald-50 px-4 py-3 text-emerald-700">일치 {result.summary.matched}건</span>
          <span className="rounded-xl bg-amber-50 px-4 py-3 text-amber-800">확인 필요 {result.summary.unverified}건</span>
          <span className="self-center text-xs font-normal text-slate-500">{new Date(result.checkedAt).toLocaleString("ko-KR")} 확인</span>
        </div>

        {result.contractCandidates.length > 0 && (
          <div className="rounded-2xl border bg-white p-4">
            <label className="text-sm font-bold">계약 공시 선택
              <select aria-label="계약 공시 선택" value={receipt} disabled={busy} onChange={e => setReceipt(e.target.value)} className={inputClass}>
                <option value="">자동 식별(지역·전압이 유일하게 일치할 때)</option>
                {result.contractCandidates.map(c => <option key={c.rceptNo} value={c.rceptNo}>{c.company} · {c.receiptDate} · {c.reportName} · {c.rceptNo}</option>)}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-500">사업이 여러 개라면 해당 공시를 선택하고 ‘기사 팩트 체크’를 다시 실행하세요. 기준일 이전 90일 공시를 조회합니다.</p>
          </div>
        )}
        {result.warnings.map((w, i) => <p key={i} className="text-xs text-amber-800">{w}</p>)}

        {/* 기업별 요약: 기업을 눌러 해당 기업의 수치만 볼 수 있습니다. */}
        <div className="rounded-2xl border bg-white p-5">
          <h2 className="mb-3 font-bold">기사에 나온 기업 ({result.companies.length})</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setCompanyFilter("ALL")} className={`rounded-lg border px-3 py-2 text-xs font-bold ${companyFilter === "ALL" ? "bg-slate-900 text-white" : "bg-white"}`}>전체 {checkedCount}건</button>
            {result.companies.map(c => (
              <button key={c.name} type="button" onClick={() => setCompanyFilter(c.name)} className={`rounded-lg border px-3 py-2 text-left text-xs ${colorOf(c.name).chip} ${companyFilter === c.name ? "ring-2 ring-slate-900" : ""}`}>
                <b>{c.name}</b> · 수치 {c.total}건<br />
                <span className="text-rose-700">불일치 {c.mismatched}</span> · <span className="text-emerald-700">일치 {c.matched}</span> · <span className="text-amber-800">확인 필요 {c.unverified}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <h2 className="mb-2 font-bold">원문 표시</h2>
          <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <span><span className="rounded bg-emerald-100 px-1">일치</span> <span className="rounded bg-rose-100 px-1">불일치</span> <span className="rounded bg-amber-100 px-1">확인 필요</span> 수치 (밑줄 색 = 기업)</span>
            <span><span className="rounded border-b-2 border-dotted border-blue-500 bg-blue-50 px-1 text-blue-900">날짜·기간</span> 해석 결과는 마우스를 올리면 표시</span>
            <span><span className="rounded border border-sky-300 bg-sky-100 px-1 font-bold text-sky-900">기업명</span> 기업별 고유 색</span>
          </p>
          <p className="whitespace-pre-wrap text-sm leading-9">{highlights()}</p>
        </div>

        {!checkedCount && <p className="text-sm text-slate-500">공시와 대조할 수 있는 재무 수치를 찾지 못했습니다.{referenceClaims.length ? ` 참고 수치 ${referenceClaims.length}건은 아래에서 볼 수 있습니다.` : ""}</p>}

        {checkedCount > 0 && <>
          {/* 한눈에 보는 비교표: 기업·지표·기간·부호가 열로 분리돼 있어 서로 섞이지 않습니다. */}
          <div className="rounded-2xl border bg-white p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">수치별 대조표</h2>
              <div className="flex gap-1 text-xs">
                {(["ALL", "MISMATCH", "UNVERIFIED", "MATCH"] as Filter[]).map(f => (
                  <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-lg border px-3 py-1.5 font-bold ${filter === f ? "bg-slate-900 text-white" : "bg-white"}`}>{f === "ALL" ? "전체" : STATUS_LABEL[f]}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-xs">
                <thead className="border-b text-slate-500">
                  <tr><th className="p-2">#</th><th className="p-2">기업</th><th className="p-2">지표</th><th className="p-2">기간·기준</th><th className="p-2">기사 수치 (부호)</th><th className="p-2">공시값 (부호)</th><th className="p-2">판정</th><th className="p-2">사유</th></tr>
                </thead>
                <tbody>
                  {visibleClaims.map(c => (
                    <tr key={c.id} className="border-b align-top last:border-0">
                      <td className="p-2"><a href={`#fact-${c.id}`} className="font-bold text-slate-700 underline">{c.id}</a></td>
                      <td className="p-2"><span className={`rounded border px-1.5 py-0.5 font-bold ${colorOf(c.company || "기업 미확인").chip}`}>{c.company || "기업 미확인"}</span>{c.companySource === "carried" && <div className="mt-1 text-[10px] text-amber-700">앞 문장에서 이어받음</div>}</td>
                      <td className="p-2">{c.label}</td>
                      <td className="p-2 text-slate-600">{c.basisLabel?.includes("확인 필요") ? <span className="text-amber-700">기사 기준 확인 필요</span> : basisText(c)}</td>
                      <td className="p-2"><b className={c.value < 0 ? "text-rose-700" : ""}>{c.valueText ?? c.text}</b> <SignBadge claim={c} /></td>
                      <td className="p-2"><b className={c.actual !== null && c.actual < 0 && !c.growth ? "text-rose-700" : ""}>{c.actualText}</b></td>
                      <td className="p-2"><span className={`rounded px-2 py-1 font-bold ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>{c.mismatchKind && <div className="mt-1 text-[10px] font-bold text-rose-700">{KIND_LABEL[c.mismatchKind]}</div>}</td>
                      <td className="max-w-[320px] p-2 text-[11px] leading-5 text-slate-600">{c.status === "MATCH" ? "" : c.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-6">
            {grouped.map(group => (
              <div key={group.name} className="space-y-3">
                <h2 className="flex items-center gap-2 text-base font-extrabold"><span className={`rounded border px-2 py-1 ${colorOf(group.name).chip}`}>{group.name}</span><span className="text-xs font-normal text-slate-500">{group.claims.length}건</span></h2>
                {group.claims.map(c => (
                  <article key={c.id} id={`fact-${c.id}`} className={`scroll-mt-6 space-y-3 rounded-2xl border-l-8 border bg-white p-5 ${colorOf(c.company || "기업 미확인").bar}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-2 py-1 text-xs font-bold ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                      {c.mismatchKind && <span className="rounded bg-rose-600 px-2 py-1 text-xs font-bold text-white">{KIND_LABEL[c.mismatchKind]}</span>}
                      <h3 className="text-sm font-bold">{c.id}. {c.company || "기업 미확인"} · {c.label}</h3>
                      {c.companySource === "carried" && <span className="rounded bg-amber-100 px-2 py-1 text-[11px] font-bold text-amber-900">기업: 앞 문장에서 이어받음 — 원문에서 확인</span>}
                    </div>
                    <p className="rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-700">{sentenceWithFigure(c)}</p>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <div className="rounded-xl border p-3">
                        <dt className="text-[11px] font-bold text-slate-500">기사 수치</dt>
                        <dd className="mt-1 flex flex-wrap items-center gap-2"><strong className={`text-lg ${c.value < 0 ? "text-rose-700" : ""}`}>{c.valueText ?? c.text}</strong><SignBadge claim={c} /></dd>
                        <dd className="mt-1 text-[11px] text-slate-500">원문 표기: {c.text}{c.approximate ? " (‘약’ 등 근사 표기)" : ""}</dd>
                      </div>
                      <div className="rounded-xl border p-3">
                        <dt className="text-[11px] font-bold text-slate-500">DART 공시값</dt>
                        <dd className="mt-1"><strong className={`text-lg ${c.actual !== null && c.actual < 0 && !c.growth ? "text-rose-700" : ""}`}>{c.actualText}</strong></dd>
                        {c.difference !== undefined && c.status === "MISMATCH" && <dd className="mt-1 text-[11px] text-slate-500">차이(기사−공시): {c.difference.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}{c.unit}</dd>}
                      </div>
                    </dl>
                    <dl className="grid gap-1 text-xs text-slate-600">
                      <div><dt className="inline font-bold">비교 기준 </dt><dd className="inline">{c.basisLabel?.includes("확인 필요") ? "기사에서 확정할 수 없음" : basisText(c)}</dd></div>
                      {c.periodNote && <div><dt className="inline font-bold">기간 해석 </dt><dd className="inline">{c.periodNote}</dd></div>}
                      {c.comparison && <div><dt className="inline font-bold">증감 비교 기간 </dt><dd className="inline">{c.comparison.year}년 {PERIOD_NAME[c.comparison.period]}</dd></div>}
                    </dl>
                    <p className="text-xs leading-5 text-slate-700">{c.message}</p>
                    {c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="block break-words text-xs leading-5 text-emerald-700 underline">{c.sourceLabel} · 공시 원문 ↗</a>}
                  </article>
                ))}
              </div>
            ))}
          </div>
        </>}

        {referenceClaims.length > 0 && (
          <details className="rounded-2xl border bg-white p-5">
            <summary className="cursor-pointer text-sm font-bold">참고 수치 {referenceClaims.length}건 <span className="font-normal text-slate-500">— 재무 지표를 식별하지 못했거나(인원·비중·부분 금액 등) 공시 검증 대상이 아니어서 판정에서 제외</span></summary>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
              {referenceClaims.map(c => (
                <li key={c.id} id={`fact-${c.id}`} className="rounded-lg bg-slate-50 p-3">
                  <span className="font-bold text-slate-800">[{c.id}] {c.valueText ?? c.text}</span>
                  {c.company && <span className={`ml-2 rounded border px-1.5 py-0.5 font-bold ${colorOf(c.company).chip}`}>{c.company}</span>}
                  <div className="mt-1">{sentenceWithFigure(c)}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </>}
    </section>
  );
}
