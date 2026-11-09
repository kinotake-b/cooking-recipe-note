/* sync.js — Supabase で、レシピ帳とカフェ帳の記録を端末のあいだで同期する
   ※ このファイルは cafe-app/ と recipe-app/ に「同じ内容」で置く。直したら両方に反映すること。

   考え方
   - 記録は1件ずつ、クラウドの表に入れる(user_id + id が1行)。
   - 同じ記録が両方にあれば「あとから変えたほう」が勝つ(最終更新の時刻で決める)。
   - 消した記録は deleted=true の印を付けて残し(中身は消さない)、別の端末にも「消した」を伝える。
   - どの記録が変わったかは、中身の指紋(ハッシュ)を前回と比べて見つける。
     だから、アプリ側の編集処理は直さず、保存のあとで Sync.changed() を呼ぶだけでよい。
   - ログインは「メール+パスワード」。メールのリンク方式は、iPhoneのホーム画面アプリだと
     リンクがSafariで開いてしまい、アプリに戻ってこられないため使わない。 */
(function () {
  'use strict';

  /* ★ Supabase の「Project Settings → API」にある2つの値を、ここに入れる。
     anon キーは「公開してよい鍵」で、記録を守っているのは表ごとの行の制限(RLS)。 */
  var SUPABASE_URL = 'https://rolzxkweqhoqgrheybpl.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_c2OeVNgE3y_WolKC61fFrQ_g7h8CAMm';   // 公開用のキー(sb_publishable_…)。sb_secret_… や service_role は絶対に入れない

  var AUTH_KEY = 'kinotake-sync-auth';       // ログイン情報。レシピ帳とカフェ帳で共有する(同じサイトなので)
  var CONF_KEY = 'kinotake-sync-config';     // テスト用: {url,key} を入れると上の値より優先する

  var cfg = null, st = null, SKEY = '';
  var running = false, again = false, applying = false, pulled = false, timer = null;
  var listeners = [], status = { kind: 'idle', text: '' }, form = { email: '', pw: '', msg: '', err: false, busy: false };

  /* ---------- 小さな道具 ---------- */
  function conf() {
    var url = SUPABASE_URL, key = SUPABASE_KEY;
    try { var o = JSON.parse(localStorage.getItem(CONF_KEY)); if (o && o.url && o.key) { url = o.url; key = o.key; } } catch (e) { /* 何もしない */ }
    return { url: String(url).replace(/\/+$/, ''), key: key };
  }
  function configured() { var c = conf(); return !!(c.url && c.key); }
  function canon(v) {                          // キーの順番に左右されない文字列(指紋用)
    if (v === undefined || v === null) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  function hash(s) {                           // cyrb53(53bitの指紋)
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57, i, ch;
    for (i = 0; i < s.length; i++) { ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function chunks(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
  function seq(list, fn) { return list.reduce(function (p, x) { return p.then(function () { return fn(x); }); }, Promise.resolve()); }
  function hhmm(t) { var d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  /* ---------- 状態(端末の中に保存) ---------- */
  function loadState() {
    try { var s = JSON.parse(localStorage.getItem(SKEY)); if (s && s.u) return s; } catch (e) { /* 何もしない */ }
    return { u: {}, h: {}, del: {}, known: [], mu: 0, mh: null, last: 0 };
  }
  function saveState() { try { localStorage.setItem(SKEY, JSON.stringify(st)); } catch (e) { /* 何もしない */ } }
  function setStatus(kind, text) { status = { kind: kind, text: text }; listeners.forEach(function (f) { try { f(); } catch (e) { /* 何もしない */ } }); }

  /* ---------- ログイン ---------- */
  function getAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (e) { return null; } }
  function setAuth(a) { try { if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); else localStorage.removeItem(AUTH_KEY); } catch (e) { /* 何もしない */ } }
  function toSession(r) {
    return { access_token: r.access_token, refresh_token: r.refresh_token,
      expires_at: r.expires_at || (Math.floor(Date.now() / 1000) + (r.expires_in || 3600)),
      user: { id: r.user && r.user.id, email: r.user && r.user.email } };
  }
  function jaErr(j, code) {
    var m = String((j && (j.error_description || j.msg || j.message || j.error)) || '');
    if (/invalid login/i.test(m)) return 'メールアドレスかパスワードが違います';
    if (/already registered|already been registered/i.test(m)) return 'このメールアドレスはすでに登録されています。ログインしてください';
    if (/at least 6|weak|password should/i.test(m)) return 'パスワードは6文字以上にしてください';
    if (/rate limit|too many|security purposes/i.test(m)) return '短い間に試しすぎです。少し待ってからやり直してください';
    if (/not confirmed/i.test(m)) return 'メールの確認がまだです。届いた確認メールのリンクを開いてください';
    if (/valid email|invalid format|unable to validate email/i.test(m)) return 'メールアドレスの形式が正しくありません';
    if (/signups? not allowed|disabled/i.test(m)) return '新規登録が止まっています(Supabaseの設定)';
    return m || ('サーバーのエラー(' + code + ')');
  }
  function authFetch(path, body) {
    var c = conf();
    return fetch(c.url + '/auth/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.key }, body: JSON.stringify(body) })
      .catch(function () { var e = new Error('通信できませんでした'); e.net = true; throw e; })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(jaErr(j, r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  var refreshing = null;
  function token() {
    var a = getAuth();
    if (!a) return Promise.reject(new Error('NOAUTH'));
    if (a.expires_at - 60 > Date.now() / 1000) return Promise.resolve(a);
    if (refreshing) return refreshing;
    refreshing = authFetch('token?grant_type=refresh_token', { refresh_token: a.refresh_token })
      .then(function (j) { var s = toSession(j); setAuth(s); refreshing = null; return s; })
      .catch(function (e) {
        refreshing = null;
        var cur = getAuth();                                   // 同じサイトのもう一方のアプリが先に更新していたら、それを使う
        if (cur && cur.refresh_token !== a.refresh_token && cur.expires_at - 60 > Date.now() / 1000) return cur;
        if (!e.net) { setAuth(null); var x = new Error('ログインの有効期限が切れました。もう一度ログインしてください'); x.expired = true; throw x; }
        throw e;
      });
    return refreshing;
  }
  function rest(method, path, body, headers) {
    var c = conf();
    return token().then(function (a) {
      var h = { apikey: c.key, Authorization: 'Bearer ' + a.access_token };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      for (var k in headers) if (headers.hasOwnProperty(k)) h[k] = headers[k];
      return fetch(c.url + '/rest/v1/' + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
        .catch(function () { var e = new Error('通信できませんでした'); e.net = true; throw e; });
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var e = new Error(r.status === 401 ? 'ログインの有効期限が切れました。もう一度ログインしてください' : (/42P01|does not exist|schema cache/i.test(t) ? '表がまだ作られていません(SQLを実行してください)' : 'サーバーのエラー(' + r.status + ')'));
          e.status = r.status; if (r.status === 401) { setAuth(null); e.expired = true; } throw e;
        });
      }
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }

  /* ---------- 変わった記録を見つける ---------- */
  function stamp() {
    var items = cfg.getItems(), now = Date.now(), ids = {}, i;
    items.forEach(function (it) {
      ids[it.id] = 1;
      var h = hash(canon(it));
      if (st.h[it.id] !== h) { st.h[it.id] = h; st.u[it.id] = now; delete st.del[it.id]; }
    });
    for (i = 0; i < st.known.length; i++) {
      var id = st.known[i];
      if (!ids[id]) { st.del[id] = now; delete st.u[id]; delete st.h[id]; }   // 消えた記録
    }
    st.known = Object.keys(ids);
    var mh = hash(canon(cfg.getMeta()));
    if (st.mh === null) { st.mh = mh; st.mu = 0; }                             // 初めて見た: 時刻は付けない(クラウドの値を先に見る)
    else if (st.mh !== mh) { st.mh = mh; st.mu = now; }
    saveState();
  }

  /* ---------- 同期の本体 ---------- */
  function pullItems(ids, remote) {
    if (!ids.length) return Promise.resolve();
    var del = [], get = [], fetched = {};
    ids.forEach(function (id) { (remote[id].del ? del : get).push(id); });
    return seq(chunks(get, 20), function (ch) {
      var list = ch.map(function (id) { return encodeURIComponent('"' + id.replace(/"/g, '') + '"'); }).join(',');
      return rest('GET', cfg.items + '?select=id,data&id=in.(' + list + ')').then(function (rows) { (rows || []).forEach(function (r) { fetched[r.id] = r.data; }); });
    }).then(function () {
      var items = cfg.getItems().slice(), idx = {};
      items.forEach(function (it, i) { idx[it.id] = i; });
      del.forEach(function (id) { if (id in idx) items[idx[id]] = null; });
      get.forEach(function (id) { var d = fetched[id]; if (!d) return; if (id in idx) items[idx[id]] = d; else items.push(d); });
      applying = true;
      try { cfg.setItems(items.filter(Boolean)); } finally { applying = false; }
      var now = cfg.getItems(), have = {};
      now.forEach(function (it) { have[it.id] = it; });
      get.forEach(function (id) { if (have[id]) { st.u[id] = remote[id].t; st.h[id] = hash(canon(have[id])); delete st.del[id]; } });
      del.forEach(function (id) { st.del[id] = remote[id].t; delete st.u[id]; delete st.h[id]; });
      st.known = now.map(function (it) { return it.id; });
      pulled = true;
    });
  }
  function pushItems(ids, uid) {
    if (!ids.length) return Promise.resolve();
    var have = {}, rows = [], gone = [];
    cfg.getItems().forEach(function (it) { have[it.id] = it; });
    ids.forEach(function (id) {
      if (have[id] && st.u[id]) rows.push({ user_id: uid, id: id, data: have[id], updated_at: new Date(st.u[id]).toISOString(), deleted: false });
      else if (st.del[id]) gone.push(id);
    });
    return seq(chunks(rows, 8), function (batch) {
      return rest('POST', cfg.items + '?on_conflict=user_id,id', batch, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }).then(function () {
      // 消した記録: クラウドの「中身」はそのまま残し、「削除済み」の印と時刻だけを書き換える
      return seq(gone, function (id) {
        return rest('PATCH', cfg.items + '?id=eq.' + encodeURIComponent(id), { deleted: true, updated_at: new Date(st.del[id]).toISOString() }, { Prefer: 'return=minimal' });
      });
    });
  }
  function syncMeta(uid) {
    if (!cfg.meta) return Promise.resolve();
    return rest('GET', cfg.meta + '?select=data,updated_at').then(function (rows) {
      var r = rows && rows[0], rt = r ? Date.parse(r.updated_at) : 0, local = cfg.getMeta();
      var pushIt = false;
      if (!r) pushIt = !!(st.mu || (cfg.metaScore && cfg.metaScore(local) > 0));
      else if (st.mu === 0) pushIt = !!(cfg.metaScore && cfg.metaScore(local) > cfg.metaScore(r.data));   // 初回: 中身が多いほうを残す
      else pushIt = st.mu > rt;
      if (r && !pushIt && (rt > st.mu || st.mu === 0)) {
        applying = true;
        try { cfg.setMeta(r.data); } finally { applying = false; }
        st.mh = hash(canon(cfg.getMeta())); st.mu = rt; pulled = true;
      } else if (pushIt) {
        if (!st.mu) st.mu = Date.now();
        return rest('POST', cfg.meta + '?on_conflict=user_id', { user_id: uid, data: local, updated_at: new Date(st.mu).toISOString() }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      }
    });
  }
  function run() {
    if (!cfg || !configured() || !getAuth()) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    running = true; pulled = false; setStatus('busy', '同期中…');
    var uid = getAuth().user.id;
    return Promise.resolve().then(function () {
      stamp();
      return rest('GET', cfg.items + '?select=id,updated_at,deleted');
    }).then(function (rows) {
      var remote = {}, pull = [], push = [];
      (rows || []).forEach(function (r) { remote[r.id] = { t: Date.parse(r.updated_at), del: !!r.deleted }; });
      Object.keys(remote).forEach(function (id) {
        var lt = Math.max(st.u[id] || 0, st.del[id] || 0);
        if (remote[id].t > lt) pull.push(id); else if (remote[id].t < lt) push.push(id);
      });
      Object.keys(st.u).forEach(function (id) { if (!remote[id]) push.push(id); });
      return pullItems(pull, remote).then(function () { return pushItems(push, uid); });
    }).then(function () { return syncMeta(uid); })
      .then(function () {
        st.last = Date.now(); saveState();
        setStatus('ok', '同期済み ' + hhmm(st.last));
        if (pulled && cfg.onApplied) { try { cfg.onApplied(); } catch (e) { /* 何もしない */ } }
      })
      .catch(function (e) {
        saveState();
        if (e && e.message === 'NOAUTH') setStatus('idle', '');
        else setStatus('error', (e && e.net) ? '通信できませんでした。あとで自動でやり直します' : (e && e.message) || '同期できませんでした');
      })
      .then(function () { running = false; if (again) { again = false; return run(); } });
  }

  /* ---------- アプリから呼ぶもの ---------- */
  function changed() {
    if (!cfg || applying) return;
    try { stamp(); } catch (e) { return; }
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  }
  function init(c) {
    cfg = c; SKEY = 'kinotake-sync-state-' + c.name; st = loadState();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') run(); });
    window.addEventListener('online', run);
    setInterval(function () { if (document.visibilityState === 'visible') run(); }, 60000);
    setTimeout(run, 800);
  }

  function signIn(kind) {
    if (!form.email.trim() || !form.pw) { form.msg = 'メールアドレスとパスワードを入れてください'; form.err = true; return redraw(); }
    form.busy = true; form.msg = ''; redraw();
    var path = kind === 'up' ? 'signup' : 'token?grant_type=password';
    authFetch(path, { email: form.email.trim(), password: form.pw }).then(function (j) {
      form.busy = false;
      if (j.access_token) { setAuth(toSession(j)); form.pw = ''; form.msg = ''; setStatus('idle', ''); run(); }
      else { form.msg = '確認メールを送りました。メールのリンクを開いたあと、ここでログインしてください'; form.err = false; }
      redraw();
    }).catch(function (e) { form.busy = false; form.msg = e.message; form.err = true; redraw(); });
  }
  function signOut() { setAuth(null); setStatus('idle', ''); redraw(); }
  function redraw() { listeners.forEach(function (f) { try { f(); } catch (e) { /* 何もしない */ } }); }

  /* ---------- 画面(同期の欄) ---------- */
  function mk(tag, text, props) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    for (var k in props) if (props.hasOwnProperty(k)) { if (k === 'style') el.style.cssText = props[k]; else if (k === 'class') el.className = props[k]; else el.setAttribute(k, props[k]); }
    return el;
  }
  function mountUI(el) {
    function draw() {
      el.textContent = '';
      el.appendChild(mk('h2', 'クラウド同期', { class: 'sec' }));
      if (!configured()) { el.appendChild(mk('p', '同期の設定がまだ入っていません。', { class: 'sm' })); return; }
      var a = getAuth();
      if (a) {
        el.appendChild(mk('p', 'ログイン中: ' + (a.user.email || ''), { style: 'margin:0 0 4px;font-weight:600' }));
        var sm = mk('p', status.text || (st && st.last ? '前回の同期 ' + hhmm(st.last) : ''), { class: 'sm', style: 'margin:0' });
        if (status.kind === 'error') sm.style.color = '#b3261e';
        el.appendChild(sm);
        var row = mk('div', '', { class: 'row' });
        var b1 = mk('button', '今すぐ同期', { class: 'btn line', type: 'button' });
        b1.disabled = status.kind === 'busy'; b1.addEventListener('click', function () { run(); });
        var b2 = mk('button', 'ログアウト', { class: 'btn', type: 'button' });
        b2.addEventListener('click', function () { if (confirm('ログアウトします。この端末の記録はそのまま残ります。')) signOut(); });
        row.appendChild(b1); row.appendChild(b2); el.appendChild(row);
        el.appendChild(mk('p', 'レシピ帳とカフェ帳の記録が、同じアカウントで同期されます。', { class: 'sm' }));
      } else {
        el.appendChild(mk('p', 'ログインすると、iPhoneでもパソコンでも、記録が同じになります。同じメールアドレスで、レシピ帳とカフェ帳のどちらからでもログインできます。', { class: 'sm', style: 'margin-top:0' }));
        var em = mk('input', '', { type: 'email', autocomplete: 'email', placeholder: 'メールアドレス', 'aria-label': 'メールアドレス', style: 'margin-bottom:8px' });
        em.value = form.email; em.addEventListener('input', function () { form.email = em.value; });
        var pw = mk('input', '', { type: 'password', autocomplete: 'current-password', placeholder: 'パスワード(6文字以上)', 'aria-label': 'パスワード' });
        pw.value = form.pw; pw.addEventListener('input', function () { form.pw = pw.value; });
        el.appendChild(em); el.appendChild(pw);
        if (form.msg) el.appendChild(mk('p', form.msg, { class: 'sm', style: 'margin:8px 0 0;color:' + (form.err ? '#b3261e' : 'inherit') }));
        var r2 = mk('div', '', { class: 'row' });
        var l1 = mk('button', 'ログイン', { class: 'btn primary', type: 'button' }); l1.disabled = form.busy;
        l1.addEventListener('click', function () { signIn('in'); });
        var l2 = mk('button', '新規登録', { class: 'btn', type: 'button' }); l2.disabled = form.busy;
        l2.addEventListener('click', function () { signIn('up'); });
        r2.appendChild(l1); r2.appendChild(l2); el.appendChild(r2);
      }
    }
    listeners.push(draw); draw();
  }

  window.Sync = { init: init, changed: changed, run: run, mountUI: mountUI };
})();
