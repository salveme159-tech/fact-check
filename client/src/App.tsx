import { useState } from "react";
import ArticleFactCheckPanel from "./components/ArticleFactCheckPanel";
import { apiUrl, apiBaseUrl } from "./lib/apiBase";

const KEY_STORAGE = "DART_API_KEY_V6";

function loadKey() {
  try { return localStorage.getItem(KEY_STORAGE)?.trim() ?? ""; } catch { return ""; }
}

export default function App() {
  const [apiKey, setApiKey] = useState(loadKey);
  const [draft, setDraft] = useState(loadKey);
  const [keyMessage, setKeyMessage] = useState("");
  const [checking, setChecking] = useState(false);

  const saveKey = async () => {
    const trimmed = draft.trim();
    if (!/^[A-Za-z0-9]{40}$/.test(trimmed)) { setKeyMessage("OpenDART 인증키는 영문·숫자 40자리입니다."); return; }
    setChecking(true); setKeyMessage("");
    try {
      const response = await fetch(apiUrl("/api/trpc/dart.validateKey"), { headers: { "X-OpenDART-Key": trimmed }, credentials: apiBaseUrl ? "omit" : "same-origin", cache: "no-store" });
      const payload = await response.json();
      const data = payload?.result?.data?.json ?? payload?.result?.data;
      if (!data?.valid) { setKeyMessage(data?.message ?? "인증키를 확인하지 못했습니다."); return; }
      try { localStorage.setItem(KEY_STORAGE, trimmed); } catch { /* 저장소를 쓸 수 없으면 이번 세션에서만 사용 */ }
      setApiKey(trimmed); setKeyMessage("인증키를 확인했습니다. 이 브라우저에만 저장되며 서버에는 조회할 때만 전달됩니다.");
    } catch { setKeyMessage("서버에 연결하지 못했습니다. 서버 주소와 네트워크를 확인하세요."); }
    finally { setChecking(false); }
  };
  const clearKey = () => { try { localStorage.removeItem(KEY_STORAGE); } catch { /* noop */ } setApiKey(""); setDraft(""); setKeyMessage(""); };

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight">DART 기사 팩트 체크</h1>
        <p className="mt-2 text-sm text-slate-500">기사 속 기업명·기간·수치·부호를 하나씩 분리해 DART 공시값과 대조합니다.</p>
      </header>
      <section className="rounded-2xl border bg-white p-5">
        <label className="text-sm font-bold" htmlFor="dart-key">OpenDART 인증키</label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input id="dart-key" type="password" autoComplete="off" value={draft} onChange={e => setDraft(e.target.value)} placeholder="opendart.fss.or.kr에서 발급받은 40자리 키" className="min-w-[260px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <button type="button" disabled={checking} onClick={() => void saveKey()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">{checking ? "확인 중…" : apiKey ? "키 다시 확인" : "키 등록"}</button>
          {apiKey && <button type="button" onClick={clearKey} className="rounded-lg border px-4 py-2 text-sm">키 삭제</button>}
        </div>
        {keyMessage && <p role="status" className="mt-2 text-xs text-slate-600">{keyMessage}</p>}
      </section>
      <ArticleFactCheckPanel apiKey={apiKey} />
    </main>
  );
}
