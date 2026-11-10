// read-receipt: レシートの写真を Gemini で読み、店名・日付・品名・値段を JSON で返す(Supabase の Edge Function)
//
// なぜ中継が要るか: Gemini のキーをアプリ(公開ページ)に入れると、誰でも盗んで使えてしまう。
//   キーは Supabase の「Secrets」にだけ置き、アプリは「ログイン中の本人」としてこの関数を呼ぶ。
//
// 必要な Secrets(Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY  … Google AI Studio で作ったキー
//   ALLOWED_EMAILS  … 使ってよい人のメールアドレス(カンマ区切り)。ここに無い人は呼べない
//   GEMINI_MODEL    … (任意)モデル名。無ければ下の既定値。古くなったらここだけ変える
//
// 関数の設定: 「Verify JWT」はオフにする(この関数の中で、ログイン中の本人かを自分で確かめるため)

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
const ALLOWED = (Deno.env.get("ALLOWED_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const MAX_BASE64 = 6_000_000; // 写真(base64)の最大の長さ。約4.5MBの写真

const SCHEMA = {
  type: "object",
  properties: {
    store: { type: "string", description: "店名(支店名つき)" },
    date: { type: "string", description: "買った日 YYYY-MM-DD。分からなければ空" },
    total: { type: "integer", description: "レシートの合計金額(円)。分からなければ0" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "品名。レシートの表記どおり" },
          price: { type: "integer", description: "その行の金額(円)" },
        },
        required: ["name", "price"],
      },
    },
  },
  required: ["items"],
};

const PROMPT = `日本のレシートの写真です。内容を読み取って、JSONで返してください。
- store: 店名(支店名があればつける)。
- date: 買った日を YYYY-MM-DD で。和暦なら西暦に直す。読めなければ空文字。
- total: レシートの合計金額(円)。読めなければ0。
- items: 買った商品の行だけ。
  - name: 品名はレシートの表記のまま。読めない文字を推測で補わない。
  - price: その行の金額(円、整数)。同じ品を複数買って「単価×数量」の行なら、その行の合計金額。
  - 小計・合計・税・ポイント・クーポン・値引き・お預かり・お釣り・カードの行は items に入れない。
- 写真がレシートでない、または読めないときは items を空の配列にする。
JSON以外の文章は返さないでください。`;

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  const ok = /^https:\/\/kinotake-b\.github\.io$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : "https://kinotake-b.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

// ログイン中の本人かを Supabase に確かめ、メールアドレスを返す
async function userEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!auth.startsWith("Bearer ") || !SUPABASE_URL) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!r.ok) return null;
  const u = await r.json();
  return String(u.email ?? "").toLowerCase() || null;
}

// 返ってきた文章の中から、{ items: [...] } の形のJSONを探す(返り方が変わっても拾えるように)
function findJson(node: unknown): { items: unknown[] } | null {
  if (typeof node === "string") {
    const t = node.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (t.startsWith("{")) {
      try {
        const o = JSON.parse(t);
        if (o && Array.isArray(o.items)) return o;
      } catch { /* 次へ */ }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const x of node) { const r = findJson(x); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const r = findJson((node as Record<string, unknown>)[k]);
      if (r) return r;
    }
  }
  return null;
}

async function askInteractions(image: string, mime: string) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json", "Api-Revision": "2026-05-20" },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [{ type: "text", text: PROMPT }, { type: "image", data: image, mime_type: mime }],
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    }),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}
async function askGenerateContent(image: string, mime: string) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT + "\n形式:" + JSON.stringify(SCHEMA) }, { inline_data: { mime_type: mime, data: image } }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

function clean(o: { items: unknown[]; store?: unknown; date?: unknown; total?: unknown }) {
  const items = (o.items as Array<Record<string, unknown>>)
    .map((i) => ({ name: String(i?.name ?? "").trim().slice(0, 60), price: Math.round(Number(i?.price)) }))
    .filter((i) => i.name && Number.isFinite(i.price) && i.price > 0 && i.price <= 1_000_000)
    .slice(0, 80);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date ?? "")) ? String(o.date) : "";
  const total = Number.isFinite(Number(o.total)) && Number(o.total) > 0 ? Math.round(Number(o.total)) : 0;
  return { store: String(o.store ?? "").trim().slice(0, 40), date, total, items };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "POSTで呼んでください" });

  const email = await userEmail(req);
  if (!email) return json(req, 401, { error: "ログインが必要です" });
  if (!ALLOWED.includes(email)) return json(req, 403, { error: "このアカウントは使えません" });
  if (!GEMINI_API_KEY) return json(req, 500, { error: "Geminiのキーが設定されていません(Supabaseの Secrets)" });

  let body: { image?: string; mime?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "送られた内容が読めません" }); }
  const image = String(body.image ?? "");
  const mime = /^image\/(jpeg|png|webp)$/.test(String(body.mime)) ? String(body.mime) : "image/jpeg";
  if (!image) return json(req, 400, { error: "写真がありません" });
  if (image.length > MAX_BASE64) return json(req, 413, { error: "写真が大きすぎます" });

  // 新しい方式(Interactions API)→ だめなら従来の方式(generateContent)
  const tried: string[] = [];
  for (const ask of [askInteractions, askGenerateContent]) {
    try {
      const r = await ask(image, mime);
      if (!r.ok) { tried.push(`${ask.name}:${r.status} ${r.text.slice(0, 160)}`); continue; }
      let parsed: unknown = null;
      try { parsed = JSON.parse(r.text); } catch { parsed = r.text; }
      const found = findJson(parsed);
      if (found) return json(req, 200, clean(found));
      tried.push(`${ask.name}:返事の中にJSONが見つかりません`);
    } catch (e) {
      tried.push(`${ask.name}:${String(e).slice(0, 120)}`);
    }
  }
  return json(req, 502, { error: "読み取りに失敗しました", detail: tried.join(" / ").slice(0, 500) });
});
