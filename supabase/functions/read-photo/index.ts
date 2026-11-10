// read-photo: 写真を Gemini で読み、JSON で返す(Supabase の Edge Function)
//   kind = "receipt"(既定): レシート → 店名・日付・合計・品名と値段
//   kind = "coffee"        : コーヒー豆の袋・ラベル・メニュー → 豆の情報(産地・焙煎度など)
// レシピ帳とカフェ帳の両方が、この1つを使う。
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

/* ---------- レシート ---------- */
const RECEIPT_SCHEMA = {
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

const RECEIPT_PROMPT = `日本のレシートの写真です。内容を読み取って、JSONで返してください。
- store: 店名(支店名があればつける)。レシートの上のほうにある店名・ロゴ・「〇〇店」の行を探す。読めなければ空文字。
- date: 買った日を YYYY-MM-DD で。和暦なら西暦に直す。読めなければ空文字。
- total: レシートの合計金額(円)。読めなければ0。
- items: 買った商品の行だけ。
  - name: 品名はレシートの表記のまま。読めない文字を推測で補わない。
  - price: その行の金額(円、整数)。同じ品を複数買って「単価×数量」の行なら、その行の合計金額。
  - 小計・合計・税・ポイント・クーポン・値引き・お預かり・お釣り・カードの行は items に入れない。
- 写真がレシートでない、または読めないときは items を空の配列にする。
JSON以外の文章は返さないでください。`;

/* ---------- コーヒー豆 ---------- */
const ROASTS = ["浅煎り", "中煎り", "中深煎り", "深煎り"];
const COFFEE_SCHEMA = {
  type: "object",
  properties: {
    beans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          roaster: { type: "string", description: "ロースター(焙煎所)・ブランド名" },
          name: { type: "string", description: "商品名・豆の名前" },
          origin: { type: "string", description: "産地(国と地域。例: エチオピア イルガチェフェ)" },
          producer: { type: "string", description: "生産者・農園・ウォッシングステーション" },
          variety: { type: "string", description: "品種(例: ゲイシャ、ブルボン)" },
          process: { type: "string", description: "精製方法(例: ウォッシュト、ナチュラル、ハニー)" },
          roast: { type: "string", description: "焙煎度。浅煎り・中煎り・中深煎り・深煎りのどれか、分からなければ空" },
          notes: { type: "array", items: { type: "string" }, description: "フレーバーの言葉(日本語)" },
          roast_date: { type: "string", description: "焙煎日。読めたときだけ" },
        },
      },
    },
  },
  required: ["beans"],
};

const COFFEE_PROMPT = `コーヒー豆の袋・ラベル・パッケージ・メニュー・黒板などの写真です。写っているコーヒー豆の情報を読み取って、JSONで返してください。
- beans: 豆ごとに1件(メニューに複数の豆が載っていれば、それぞれ。最大6件)。
  - roaster: ロースター(焙煎所)やブランド名。
  - name: 商品名・豆の名前。
  - origin: 産地。国と地域(例: エチオピア イルガチェフェ)。英語表記は日本語に直す。
  - producer: 生産者・農園・ウォッシングステーション。
  - variety: 品種。
  - process: 精製方法(ウォッシュト・ナチュラル・ハニーなど。日本語で)。
  - roast: 焙煎度。浅煎り・中煎り・中深煎り・深煎りのどれか。Light/Medium/Dark などの表記や、1〜8段階の目盛りは、近いものに直す。判断できなければ空文字。
  - notes: フレーバーの言葉(日本語。例: ["ベリー", "チョコレート"])。
  - roast_date: 焙煎日が読めたときだけ。
- 写っていない項目は空文字にする。推測で補わない(写っていない産地や品種を書かない)。
- 写真にコーヒー豆の情報が無いときは、beans を空の配列にする。
JSON以外の文章は返さないでください。`;

/* ---------- 共通 ---------- */
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

// 返ってきた文章の中から、{ <key>: [...] } の形のJSONを探す(返り方が変わっても拾えるように)
function findJson(node: unknown, key: string): Record<string, unknown> | null {
  if (typeof node === "string") {
    const t = node.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (t.startsWith("{")) {
      try {
        const o = JSON.parse(t);
        if (o && Array.isArray(o[key])) return o;
      } catch { /* 次へ */ }
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const x of node) { const r = findJson(x, key); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const r = findJson((node as Record<string, unknown>)[k], key);
      if (r) return r;
    }
  }
  return null;
}

async function askInteractions(prompt: string, schema: unknown, image: string, mime: string) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json", "Api-Revision": "2026-05-20" },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [{ type: "text", text: prompt }, { type: "image", data: image, mime_type: mime }],
      response_format: { type: "text", mime_type: "application/json", schema },
    }),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
async function askGenerateContent(prompt: string, schema: unknown, image: string, mime: string) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt + "\n形式:" + JSON.stringify(schema) }, { inline_data: { mime_type: mime, data: image } }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function cleanReceipt(o: Record<string, unknown>) {
  const items = (o.items as Array<Record<string, unknown>>)
    .map((i) => ({ name: str(i?.name, 60), price: Math.round(Number(i?.price)) }))
    .filter((i) => i.name && Number.isFinite(i.price) && i.price > 0 && i.price <= 1_000_000)
    .slice(0, 80);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date ?? "")) ? String(o.date) : "";
  const total = Number.isFinite(Number(o.total)) && Number(o.total) > 0 ? Math.round(Number(o.total)) : 0;
  return { store: str(o.store, 40), date, total, items };
}

function cleanCoffee(o: Record<string, unknown>) {
  const beans = (o.beans as Array<Record<string, unknown>>)
    .map((b) => ({
      roaster: str(b?.roaster, 40),
      name: str(b?.name, 60),
      origin: str(b?.origin, 60),
      producer: str(b?.producer, 60),
      variety: str(b?.variety, 40),
      process: str(b?.process, 40),
      roast: ROASTS.includes(str(b?.roast, 10)) ? str(b?.roast, 10) : "",
      notes: arr(b?.notes).map((n) => str(n, 20)).filter(Boolean).slice(0, 8),
      roast_date: str(b?.roast_date, 20),
    }))
    .filter((b) => b.name || b.origin || b.roaster)
    .slice(0, 6);
  return { beans };
}

const KINDS: Record<string, { prompt: string; schema: unknown; key: string; clean: (o: Record<string, unknown>) => unknown }> = {
  receipt: { prompt: RECEIPT_PROMPT, schema: RECEIPT_SCHEMA, key: "items", clean: cleanReceipt },
  coffee: { prompt: COFFEE_PROMPT, schema: COFFEE_SCHEMA, key: "beans", clean: cleanCoffee },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "POSTで呼んでください" });

  const email = await userEmail(req);
  if (!email) return json(req, 401, { error: "ログインが必要です" });
  if (!ALLOWED.includes(email)) return json(req, 403, { error: "このアカウントは使えません" });
  if (!GEMINI_API_KEY) return json(req, 500, { error: "Geminiのキーが設定されていません(Supabaseの Secrets)" });

  let body: { image?: string; mime?: string; kind?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "送られた内容が読めません" }); }
  const image = String(body.image ?? "");
  const mime = /^image\/(jpeg|png|webp)$/.test(String(body.mime)) ? String(body.mime) : "image/jpeg";
  const spec = KINDS[String(body.kind ?? "receipt")];
  if (!spec) return json(req, 400, { error: "kind が正しくありません" });
  if (!image) return json(req, 400, { error: "写真がありません" });
  if (image.length > MAX_BASE64) return json(req, 413, { error: "写真が大きすぎます" });

  // 新しい方式(Interactions API)→ だめなら従来の方式(generateContent)
  const tried: string[] = [];
  for (const ask of [askInteractions, askGenerateContent]) {
    try {
      const r = await ask(spec.prompt, spec.schema, image, mime);
      if (!r.ok) { tried.push(`${ask.name}:${r.status} ${r.text.slice(0, 160)}`); continue; }
      let parsed: unknown = null;
      try { parsed = JSON.parse(r.text); } catch { parsed = r.text; }
      const found = findJson(parsed, spec.key);
      if (found) return json(req, 200, spec.clean(found));
      tried.push(`${ask.name}:返事の中にJSONが見つかりません`);
    } catch (e) {
      tried.push(`${ask.name}:${String(e).slice(0, 120)}`);
    }
  }
  return json(req, 502, { error: "読み取りに失敗しました", detail: tried.join(" / ").slice(0, 500) });
});
