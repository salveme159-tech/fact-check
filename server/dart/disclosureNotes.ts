import type { Period } from "./engine";

export type LeaseLiabilityNoteValue = {
  current: number | null;
  noncurrent: number | null;
  total: number;
  unit: "억원";
  sourceFile: string;
  lines: string[];
};

type HtmlEntry = { name: string; text: string };
type Cell = { text: string; colspan: number; rowspan: number };

const decode = (value: string) => value
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));

const textOf = (html: string) => decode(html
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]*>/g, " "))
  .replace(/[\s\u00a0]+/g, " ").trim();
const normalize = (value: string) => textOf(value).replace(/[\s·ㆍ()（）:：]/g, "");

function parseAmount(raw: string, unit: string): number | null {
  let valueText = textOf(raw).replace(/[\s,\u00a0]/g, "").replace(/−/g, "-");
  if (!valueText || /^(?:-|—|–|－|N\/A|NA)$/i.test(valueText)) return null;
  const negParen = /^\(.*\)$/.test(valueText);
  if (negParen) valueText = valueText.slice(1, -1);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(valueText)) return null;
  let amount = Number(valueText) * (negParen ? -1 : 1);
  if (!Number.isFinite(amount)) return null;
  if (unit === "원") amount /= 100_000_000;
  else if (unit === "천원") amount /= 100_000;
  else if (unit === "백만원") amount /= 100;
  else if (unit !== "억원") return null;
  return amount;
}

function expandTableRows(tableHtml: string): string[][] {
  const grid: string[][] = [];
  const pending: Array<{ value: string; remaining: number }> = [];
  const rawRows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  rawRows.forEach((rowMatch, rowIndex) => {
    const row: string[] = [];
    for (let col = 0; col < pending.length; col++) {
      if (pending[col] && pending[col].remaining > 0) {
        row[col] = pending[col].value;
        pending[col].remaining -= 1;
        if (pending[col].remaining <= 0) pending[col] = undefined as any;
      }
    }
    const cells: Cell[] = [...rowMatch[1].matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => ({
      text: textOf(m[2]),
      colspan: Math.max(1, Math.min(16, Number(m[1].match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))),
      rowspan: Math.max(1, Math.min(16, Number(m[1].match(/rowspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1))),
    }));
    let cursor = 0;
    for (const cell of cells) {
      while (row[cursor] !== undefined) cursor += 1;
      for (let span = 0; span < cell.colspan; span++) {
        row[cursor + span] = cell.text;
        if (cell.rowspan > 1) pending[cursor + span] = { value: cell.text, remaining: cell.rowspan - 1 };
      }
      cursor += cell.colspan;
    }
    grid[rowIndex] = row.map((value) => value ?? "");
  });
  return grid;
}

function targetMonth(period: Period): number {
  return period.kind === "annual" ? 12 : period.kind === "half" ? 6 : period.kind === "q1" ? 3 : 9;
}
function isPriorHeader(value: string): boolean {
  return /전기|전년도|전반기|전분기|전년|기초|비교기간|previous|prior/i.test(value);
}
function isCurrentHeader(value: string, period: Period): boolean {
  if (isPriorHeader(value)) return false;
  const compact = normalize(value);
  const datePattern = new RegExp(`${period.year}\\s*[./년-]\\s*0?${targetMonth(period)}(?:\\s*월|\\s*일|\\b)`, "i");
  if (datePattern.test(value)) return true;
  if (period.kind === "annual") return /당기말|당기|당연도|기말|당해연도/.test(compact);
  if (period.kind === "half") return /당반기말|당반기|당기말|당기|반기말/.test(compact) && !/3개월/.test(compact);
  if (period.kind === "q1") return /당분기말|당분기|당기말|당기|분기말/.test(compact) && !/반기/.test(compact);
  return /당분기말|당분기|당기말|당기|분기말/.test(compact) && !/반기/.test(compact);
}

/** DART document.xml ZIP 안의 주석 표에서 당기말 유동·비유동 리스부채를 추출합니다. */
export function parseLeaseLiabilitiesFromDisclosure(entries: HtmlEntry[], period: Period): LeaseLiabilityNoteValue | null {
  const candidates: LeaseLiabilityNoteValue[] = [];
  for (const entry of entries) {
    const tableMatches = [...entry.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
    for (const tableMatch of tableMatches) {
      const tableHtml = tableMatch[0];
      // 주석 제목·단위 문구가 표의 바로 앞에 놓이지 않고 몇 단락 앞에 있을 수 있어
      // 직전 1,500자 전체와 표 자체를 문맥으로 사용합니다.
      const before = entry.text.slice(Math.max(0, (tableMatch.index ?? 0) - 2500), tableMatch.index ?? 0);
      const tablePlain = textOf(tableHtml);
      const fullContext = `${textOf(before)} ${tablePlain}`;
      // 만기분석·미할인 리스료는 부채 장부금액이 아니므로 합산 대상에서 제외합니다.
      if (/리스부채|lease liabilities/i.test(fullContext) === false) continue;
      const immediateContext = `${textOf(before.slice(-300))} ${tablePlain}`;
      if (/만기분석|만기분석표|미할인.*리스|리스료.*만기|계약상현금흐름/i.test(immediateContext)) continue;
      // 표 안에 단위가 있으면 그것을 우선하고, 없으면 표와 가까운 문맥의 마지막 단위 표기를 사용합니다.
      // 이전 주석 표의 단위까지 모두 모아 불필요하게 거절하지는 않습니다.
      const unitSearch = `${before.slice(-700)} ${tableHtml}`;
      const unitMatches = [...unitSearch.matchAll(/단위\s*[:：]?\s*(천원|백만원|억원|원)(?![가-힣])/gi)];
      const unit = unitMatches.at(-1)?.[1];
      if (!unit) continue;
      const rows = expandTableRows(tableHtml);
      if (rows.length < 2) continue;
      const width = Math.max(...rows.map((row) => row.length));
      const headers = Array.from({ length: width }, (_, column) => rows.slice(0, Math.min(8, rows.length)).map((row) => row[column] ?? "").join(" "));
      const targetColumns = headers.map((header, index) => ({ header, index })).filter(({ header, index }) => index > 0 && isCurrentHeader(header, period));
      if (!targetColumns.length) continue;
      const currentValues: number[] = [];
      const noncurrentValues: number[] = [];
      const totalValues: number[] = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const cells = rows[rowIndex];
        // 행 이름은 숫자 열과 분리합니다. 기존처럼 첫 2~3개 셀을 라벨로 붙이면
        // '리스부채 5,560 5,800' 전체가 계정명으로 오인되어 숫자를 못 찾을 수 있습니다.
        const labelParts: string[] = [];
        for (const rawCell of cells.slice(0, Math.min(4, cells.length))) {
          const cellText = textOf(rawCell);
          if (!cellText) continue;
          if (parseAmount(cellText, unit) !== null) break;
          if (/^\(?[+-]?[\d,.]+\)?$/.test(cellText.replace(/[\s,]/g, ""))) break;
          labelParts.push(cellText);
        }
        const rowLabel = normalize(labelParts.join(" "));
        if (!rowLabel) continue;
        const namesLease = /리스부채|리스료부채|leaseLiabilities/i.test(rowLabel);
        const currentRow = /유동.*리스|리스.*유동|^(?:유동|유동성)$/i.test(rowLabel) || (namesLease && /유동/.test(rowLabel) && !/비유동/.test(rowLabel));
        const noncurrentRow = /비유동.*리스|리스.*비유동|장기리스부채|^(?:비유동|비유동성)$/i.test(rowLabel);
        const totalRow = namesLease && !currentRow && !noncurrentRow && /합계|총계|장부금액|기말금액|리스부채$|리스부채합계/.test(rowLabel);
        // 행 자체가 '리스부채'이고 열 제목에 유동/비유동이 있는 구조를 지원합니다.
        for (const { header, index } of targetColumns) {
          const value = parseAmount(cells[index] ?? "", unit);
          if (value === null || value < 0) continue;
          const headerCompact = normalize(header);
          if (noncurrentRow || (/비유동/.test(headerCompact) && !/유동성/.test(headerCompact))) noncurrentValues.push(value);
          else if (currentRow || /(?:^|[^비])유동/.test(headerCompact)) currentValues.push(value);
          else if (totalRow || (namesLease && !/유동|비유동/.test(headerCompact))) totalValues.push(value);
        }
      }
      const unique = (items: number[]) => [...new Set(items.map((value) => Number(value.toFixed(6))))];
      const currents = unique(currentValues);
      const noncurrents = unique(noncurrentValues);
      const totals = unique(totalValues);
      // 같은 표 안에서 기간·유동성 분류를 확인할 수 있고, 중복 계정 후보가 하나로 결정될 때만 사용합니다.
      if (currents.length > 1 || noncurrents.length > 1 || totals.length > 1) continue;
      const current = currents.length === 1 ? currents[0] : null;
      const noncurrent = noncurrents.length === 1 ? noncurrents[0] : null;
      const explicitTotal = totals.length === 1 ? totals[0] : null;
      let total: number | null = explicitTotal;
      if (current !== null && noncurrent !== null) {
        const componentsTotal = current + noncurrent;
        if (explicitTotal !== null && Math.abs(explicitTotal - componentsTotal) > Math.max(0.5, componentsTotal * 0.01)) continue;
        total = explicitTotal ?? componentsTotal;
      } else if (total === null && (current !== null || noncurrent !== null)) {
        // 유동 또는 비유동 중 하나만 발견된 경우 합계를 만들면 과소계산될 수 있어 거절합니다.
        continue;
      }
      if (total === null || !Number.isFinite(total) || total < 0) continue;
      candidates.push({
        current, noncurrent, total, unit: "억원", sourceFile: entry.name,
        lines: [
          ...(current !== null ? [`DART 원문 주석 유동 리스부채 ${current.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`] : []),
          ...(noncurrent !== null ? [`DART 원문 주석 비유동 리스부채 ${noncurrent.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`] : []),
          `DART 원문 주석 리스부채 합계 ${total.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`,
        ],
      });
    }
  }
  if (!candidates.length) return null;
  const distinctTotals = [...new Set(candidates.map((candidate) => candidate.total.toFixed(6)))];
  if (distinctTotals.length !== 1) return null;
  // 서로 다른 주석 표가 같은 값을 반복하는 경우 중복을 합산하지 않습니다.
  const selected = candidates[0];
  return { ...selected };
}


export type DepreciationNoteValue = {
  value: number;
  unit: "억원";
  sourceFile: string;
  lines: string[];
};

function depreciationPeriodScore(header: string, period: Period): number {
  const h = textOf(header).replace(/[\s·ㆍ]/g, "");
  if (!h) return 0;
  if (/전기|전반기|전분기|전년도|전년동기|비교기간|previous|prior/i.test(h)) return 0;
  const month = targetMonth(period);
  const hasTargetDate = new RegExp(`${period.year}\\s*[./년-]\\s*0?${month}(?:\\s*월|\\s*일|\\b)`, "i").test(h);
  const threeMonth = /3개월|당분기|당기분기|3month/i.test(h);
  const cumulative = /당반기.*(?:누적|합계)?|상반기.*누적|당기누적|누적|6개월|9개월|9month|6month/i.test(h) && !threeMonth;

  if (period.kind === "annual") {
    if (/(?:당기|당해|당연도|제\d+기)/.test(h) && !/3개월|반기|분기|누적|9개월|6개월/.test(h)) return 100;
    return hasTargetDate && month === 12 && !/3개월|반기|분기/.test(h) ? 70 : 0;
  }
  if (period.kind === "half") {
    if (period.mode === "qtr") {
      if (/당반기.*3개월|당분기|당기분기|3개월|3month/i.test(h)) return 100;
      if (hasTargetDate && /04\s*[./월-]?\s*0?1|4월0?1일/.test(h)) return 85;
      return hasTargetDate ? 40 : 0;
    }
    if (cumulative) return 100;
    if (hasTargetDate && !threeMonth) return 75;
    if (/당반기|상반기/.test(h) && !threeMonth) return 65;
    return 0;
  }
  if (period.kind === "q1") {
    if (/당분기|당기분기|1분기|3개월/.test(h)) return 100;
    return hasTargetDate ? 70 : 0;
  }
  if (period.kind === "q3") {
    if (period.mode === "qtr") {
      if (/당분기|당기분기|3개월/.test(h)) return 100;
      return hasTargetDate ? 65 : 0;
    }
    if (/당기누적|누적|9개월|당기.*누적/.test(h) && !threeMonth) return 100;
    if (hasTargetDate && !threeMonth) return 75;
    return 0;
  }
  return hasTargetDate ? 60 : 0;
}

/** DART 원문 주석 표에서 EBITDA에 필요한 감가상각·상각비를 기간·단위 확인 후 추출합니다. */
export function parseDepreciationFromDisclosure(entries: HtmlEntry[], period: Period): DepreciationNoteValue | null {
  const avoidPrior = /전기|전반기|전분기|전년도|전년|비교|기초/;
  const parseAmountForUnit = (raw: string, unit: string): number | null => {
    let valueText = textOf(raw).replace(/[\s,\u00a0]/g, "").replace(/−/g, "-");
    if (/^(?:-|—|–|－|−)$/.test(valueText)) return 0;
    const negativeParen = /^\(.*\)$/.test(valueText);
    if (negativeParen) valueText = valueText.slice(1, -1);
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(valueText)) return null;
    let value = Number(valueText) * (negativeParen ? -1 : 1);
    if (!Number.isFinite(value)) return null;
    if (unit === "원") value /= 100_000_000;
    else if (unit === "천원") value /= 100_000;
    else if (unit === "백만원") value /= 100;
    else if (unit !== "억원") return null;
    return value;
  };
  const foundAggregates: Array<{ value: number; label: string; sourceFile: string }> = [];
  const foundPairs: Array<{ value: number; lines: string[]; sourceFile: string }> = [];

  for (const entry of entries) {
    const tables = [...entry.text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
    for (const tableMatch of tables) {
      const tableHtml = tableMatch[0];
      const tableStart = tableMatch.index ?? 0;
      const before = entry.text.slice(Math.max(0, tableStart - 1400), tableStart);
      const plainTable = textOf(tableHtml);
      if (!/(감가상각비|무형자산상각비|감가상각.*상각비|상각비.*감가상각)/i.test(`${textOf(before)} ${plainTable}`)) continue;
      if (/상각누계액|감가상각누계액|손상차손누계액/.test(plainTable)) continue;
      const unitSearch = `${before.slice(-1000)} ${tableHtml}`;
      const unitMatches = [...unitSearch.matchAll(/단위\s*[:：]?\s*(천원|백만원|억원|원)(?![가-힣])/gi)];
      const unit = unitMatches.at(-1)?.[1];
      if (!unit) continue;

      const rawRows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
        const cells = [...m[1].matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi)].flatMap((cell) => {
          const text = textOf(cell[2]);
          const colspan = Math.max(1, Math.min(16, Number(cell[1].match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1)));
          return Array.from({ length: colspan }, () => text);
        });
        return { html: m[1], cells };
      }).filter((row) => row.cells.length);
      if (!rawRows.length) continue;
      const width = Math.max(...rawRows.slice(0, 8).map((row) => row.cells.length));
      const headers = Array.from({ length: width }, (_, index) => rawRows.slice(0, Math.min(5, rawRows.length)).map((row) => row.cells[index] ?? "").join(" "));
      const scoredColumns = headers.map((header, index) => ({ index, score: depreciationPeriodScore(header, period) })).filter((candidate) => candidate.index > 0 && candidate.score > 0).sort((a, b) => b.score - a.score);
      let amountCol = scoredColumns[0]?.index ?? -1;
      if (amountCol < 0) {
        // 헤더가 비표준인 경우에도 표 안에 기간 표시가 있고 각 데이터 행에 숫자 열이 하나일 때만 사용합니다.
        const visible = textOf(tableHtml);
        if (!/당기|당반기|당분기|당해|누적|20\d{2}\s*[./년-]\s*0?\d{1,2}/.test(visible) || avoidPrior.test(visible)) continue;
      }
      const numeric = (raw: string) => parseAmountForUnit(raw, unit);
      const rows = rawRows.map((row) => {
        let labelCells: string[] = [];
        if (amountCol >= 0) labelCells = row.cells.slice(0, amountCol);
        else {
          for (const cell of row.cells) {
            if (numeric(cell) !== null) break;
            labelCells.push(cell);
          }
        }
        const label = normalize(labelCells.join(" "));
        let value: number | null = null;
        if (amountCol >= 0) value = numeric(row.cells[amountCol] ?? "");
        else {
          const values = row.cells.map(numeric).filter((v): v is number => v !== null);
          if (values.length === 1) value = values[0];
        }
        return { label, value };
      }).filter((row) => row.label && row.value !== null && Number.isFinite(row.value));

      const aggregates = rows.filter((row) => /(?:유형자산및무형자산|유무형자산|감가상각비및무형자산상각비|감가상각및상각비|감가상각비와무형자산상각비|감가상각비및상각비|감가상각비와상각비|감가상각및무형자산상각비)/.test(row.label));
      if (aggregates.length === 1) {
        foundAggregates.push({ value: Math.abs(aggregates[0].value!), label: aggregates[0].label, sourceFile: entry.name });
        continue;
      }
      if (aggregates.length > 1) continue;
      const depreciation = rows.filter((row) => /감가상각비/.test(row.label) && !/누계액|감가상각누계|무형자산/.test(row.label));
      const amortization = rows.filter((row) => /무형자산상각비|무형자산상각/.test(row.label) && !/누계액/.test(row.label));
      if (depreciation.length === 1 && amortization.length === 1) {
        const dep = Math.abs(depreciation[0].value!);
        const amort = Math.abs(amortization[0].value!);
        foundPairs.push({ value: dep + amort, sourceFile: entry.name, lines: [`주석 원문 ${depreciation[0].label}: ${dep.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`, `주석 원문 ${amortization[0].label}: ${amort.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`] });
      }
    }
  }

  if (foundAggregates.length) {
    const distinct = [...new Set(foundAggregates.map((item) => item.value.toFixed(6)))];
    if (distinct.length !== 1) return null;
    const selected = foundAggregates[0];
    return { value: selected.value, unit: "억원", sourceFile: selected.sourceFile, lines: [`DART 원문 주석에 공시된 감가상각·상각 합계 ${selected.label}: ${selected.value.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}억원`] };
  }
  if (foundPairs.length) {
    const distinct = [...new Set(foundPairs.map((item) => item.value.toFixed(6)))];
    if (distinct.length !== 1) return null;
    const selected = foundPairs[0];
    return { value: selected.value, unit: "억원", sourceFile: selected.sourceFile, lines: selected.lines };
  }
  return null;
}
