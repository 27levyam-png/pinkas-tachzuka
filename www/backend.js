/* פנקס תחזוקה – חיבור ל-Supabase.
   הקובץ מספק לאפליקציה את אותם כלים שהיו לה בגרסה הקודמת:
   מאגר נתונים משותף, העלאת קבלות, זיהוי משתמש ושמירת קבצים. */
(function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  var TABLE = 'docs', BUCKET = 'receipts';
  var ready = false, sb = null, session = null;
  var readyResolve; var readyPromise = new Promise(function (r) { readyResolve = r; });

  function projectRef() {
    try { return new URL(cfg.SUPABASE_URL).hostname.split('.')[0]; } catch (e) { return ''; }
  }
  var DASHBOARD = 'https://supabase.com/dashboard/project/' + projectRef();

  function configured() {
    return cfg.SUPABASE_URL && cfg.SUPABASE_KEY && cfg.SUPABASE_URL.indexOf('YOUR-') < 0 && cfg.SUPABASE_KEY.indexOf('YOUR-') < 0;
  }

  /* ---------- connection status (shown by the app) ---------- */
  var lastOk = true;
  function reportOk() { if (!lastOk) { lastOk = true; window.dispatchEvent(new CustomEvent('backend-status', { detail: { ok: true } })); } }
  function reportFail(e) {
    lastOk = false;
    window.dispatchEvent(new CustomEvent('backend-status', { detail: { ok: false, message: (e && e.message) || String(e) } }));
  }

  /* ---------- documents ---------- */
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function snapDoc(id, data) {
    var d = data ? JSON.parse(JSON.stringify(data)) : undefined;
    return { id: id, exists: !!data, data: function () { return d; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  async function fetchAll(col) {
    var out = [], from = 0, step = 1000;
    for (;;) {
      var res = await sb.from(TABLE).select('id,data').eq('collection', col).order('id').range(from, from + step - 1);
      if (res.error) throw res.error;
      out = out.concat(res.data);
      if (res.data.length < step) break;
      from += step;
    }
    return out;
  }
  async function fetchOne(col, id) {
    var res = await sb.from(TABLE).select('data').eq('collection', col).eq('id', id).maybeSingle();
    if (res.error) throw res.error;
    return res.data ? res.data.data : null;
  }

  var listeners = [];
  function notify(col) { listeners.forEach(function (l) { if (!col || l.col === col) l.schedule(); }); }

  function listen(col, docId, next, onError) {
    var l = { col: col, timer: null, dead: false, failed: false };
    async function run() {
      if (l.dead) return;
      try {
        if (docId) next(snapDoc(docId, await fetchOne(col, docId)));
        else {
          var rows = await fetchAll(col);
          var docs = rows.map(function (r) { return snapDoc(r.id, r.data); });
          next({ docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: function () { return []; } });
        }
        reportOk();
      } catch (e) {
        reportFail(e);
        if (!l.failed && onError) { l.failed = true; try { onError({ code: 'unavailable', message: e.message || String(e) }); } catch (x) {} }
      }
    }
    l.schedule = function () { clearTimeout(l.timer); l.timer = setTimeout(run, 200); };
    listeners.push(l);
    run();
    return function () { l.dead = true; listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function merge(a, b) {
    var out = Object.assign({}, a);
    Object.keys(b).forEach(function (k) { out[k] = isObj(out[k]) && isObj(b[k]) ? merge(out[k], b[k]) : b[k]; });
    return out;
  }

  function docRef(col, id) {
    return {
      id: id, path: col + '/' + id,
      get: async function () { return snapDoc(id, await fetchOne(col, id)); },
      set: async function (data) {
        var res = await sb.from(TABLE).upsert({ collection: col, id: id, data: data, updated_at: new Date().toISOString() });
        if (res.error) { reportFail(res.error); throw { code: 'unavailable', message: res.error.message }; }
        notify(col);
      },
      update: async function (data) {
        var cur = await fetchOne(col, id);
        if (!cur) throw { code: 'invalid_argument', message: 'document does not exist' };
        var res = await sb.from(TABLE).update({ data: merge(cur, data), updated_at: new Date().toISOString() }).eq('collection', col).eq('id', id);
        if (res.error) { reportFail(res.error); throw { code: 'unavailable', message: res.error.message }; }
        notify(col);
      },
      delete: async function () {
        var res = await sb.from(TABLE).delete().eq('collection', col).eq('id', id);
        if (res.error) { reportFail(res.error); throw { code: 'unavailable', message: res.error.message }; }
        notify(col);
      },
      onSnapshot: function (next, err) { return listen(col, id, next, err); }
    };
  }
  function colRef(col) {
    return {
      path: col,
      doc: function (id) { return docRef(col, id || newId()); },
      add: async function (data) { var r = docRef(col, newId()); await r.set(data); return r; },
      get: async function () { var rows = await fetchAll(col); var docs = rows.map(function (r) { return snapDoc(r.id, r.data); }); return { docs: docs, size: docs.length, empty: !docs.length }; },
      onSnapshot: function (next, err) { return listen(col, null, next, err); }
    };
  }
  function split(path) {
    var p = String(path).split('/');
    if (p.length !== 2) throw new TypeError('path must be collection/doc');
    return p;
  }
  var db = {
    doc: function (path) { var p = split(path); return docRef(p[0], p[1]); },
    collection: function (path) { return colRef(path); }
  };

  /* ---------- receipts (files) ---------- */
  var urlCache = {};
  var EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
  var assets = {
    upload: async function (blob, opts) {
      var type = (opts && opts.type) || blob.type || 'application/octet-stream';
      var id = newId() + '.' + (EXT[type] || 'bin');
      var res = await sb.storage.from(BUCKET).upload(id, blob, { contentType: type, upsert: false });
      if (res.error) throw { code: /size|large/i.test(res.error.message) ? 'too_large' : 'upstream_error', message: res.error.message };
      return { id: id, url: '', sizeBytes: blob.size, contentType: type };
    },
    delete: async function (id) {
      var res = await sb.storage.from(BUCKET).remove([id]);
      if (res.error) throw { code: 'upstream_error', message: res.error.message };
      return { deleted: true };
    },
    fetchBlob: async function (id) {
      var res = await sb.storage.from(BUCKET).download(id);
      if (res.error) throw res.error;
      return res.data;
    },
    objectUrl: async function (id) {
      if (!urlCache[id]) urlCache[id] = assets.fetchBlob(id).then(function (b) { return URL.createObjectURL(b); });
      return urlCache[id];
    }
  };

  /* ---------- users ---------- */
  var names = {};
  function displayName(u) { return (u && u.user_metadata && u.user_metadata.name) || (u && u.email) || ''; }
  var user = {
    id: async function () { return session ? session.user.id : null; },
    me: async function () { return { id: session.user.id, name: displayName(session.user), email: session.user.email }; },
    can: async function () { return true; },
    canEdit: function () { return true; },
    isOwner: function () { return false; },
    profiles: async function (ids) {
      var missing = ids.filter(function (i) { return !(i in names); });
      if (missing.length) {
        var res = await sb.from(TABLE).select('id,data').eq('collection', 'users').in('id', missing);
        if (!res.error) res.data.forEach(function (r) { names[r.id] = (r.data && r.data.name) || ''; });
        missing.forEach(function (i) { if (!(i in names)) names[i] = ''; });
      }
      var out = {}; ids.forEach(function (i) { out[i] = { id: i, name: names[i] || '' }; }); return out;
    }
  };

  /* ---------- saving files ---------- */
  function isNative() { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  function toBlob(data, filename) {
    if (data instanceof Blob) return data;
    var type = /\.html$/.test(filename) ? 'text/html' : /\.csv$/.test(filename) ? 'text/csv' : 'application/octet-stream';
    return new Blob([data], { type: type + (typeof data === 'string' ? ';charset=utf-8' : '') });
  }
  function blobToBase64(blob) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1]); };
      r.onerror = no; r.readAsDataURL(blob);
    });
  }
  var downloads = {
    save: async function (req) {
      var blob = toBlob(req.data, req.filename), name = req.filename;
      if (isNative()) {
        var P = window.Capacitor.Plugins, FS = P.Filesystem, SH = P.Share;
        var b64 = await blobToBase64(blob), uri = null, where = '';
        try {
          var w = await FS.writeFile({ path: 'פנקס תחזוקה/' + name, data: b64, directory: 'DOCUMENTS', recursive: true });
          uri = w.uri; where = 'נשמר בטלפון בתיקייה Documents/פנקס תחזוקה';
        } catch (e) {
          var c = await FS.writeFile({ path: name, data: b64, directory: 'CACHE', recursive: true });
          uri = c.uri;
        }
        // דוח להדפסה, או אם לא הצלחנו לשמור בתיקייה – פותחים חלון שיתוף (שמירה ל-Drive, וואטסאפ, פתיחה בכרום להדפסה)
        if (/\.html$/.test(name) || !where) {
          try { await SH.share({ title: name, url: uri, dialogTitle: name }); } catch (e) { if (!where) throw { code: 'declined' }; }
        }
        return { status: 'saved', where: where };
      }
      var url = URL.createObjectURL(blob);
      if (/\.html$/.test(name)) {
        var w2 = window.open(url, '_blank');
        if (w2) return { status: 'saved', where: 'הדוח נפתח בלשונית חדשה' };
      }
      var a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return { status: 'saved', where: '' };
    }
  };

  /* ---------- the same entry point the app already uses ---------- */
  var caps = { db: db, user: user, assets: assets, downloads: downloads };
  window.claude = { use: async function (name) { await readyPromise; return caps[name] || null; } };

  /* ---------- login ---------- */
  function $(s) { return document.querySelector(s); }
  function showLogin(msg) {
    var box = $('#login'); if (!box) return;
    box.hidden = false;
    $('#lg-err').hidden = !msg; $('#lg-err').textContent = msg || '';
  }
  async function afterLogin(s) {
    session = s;
    $('#login').hidden = true;
    try {
      await sb.from(TABLE).upsert({ collection: 'users', id: s.user.id, data: { name: displayName(s.user), email: s.user.email }, updated_at: new Date().toISOString() });
    } catch (e) {}
    try { sb.channel('docs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, function (p) {
        var col = (p.new && p.new.collection) || (p.old && p.old.collection);
        notify(col || null);
      })
      .subscribe(); } catch (e) {}
    if (!ready) { ready = true; readyResolve(); }
  }

  window.Backend = {
    dashboardUrl: DASHBOARD,
    signOut: async function () { try { await sb.auth.signOut(); } catch (e) {} location.reload(); },
    email: function () { return session ? session.user.email : ''; }
  };

  document.addEventListener('visibilitychange', function () { if (!document.hidden && ready) notify(null); });
  setInterval(function () { if (ready && !document.hidden) notify(null); }, 60000);

  document.addEventListener('DOMContentLoaded', async function () {
    if (!configured()) { showLogin('האפליקציה עדיין לא מחוברת לשרת. יש למלא את הקובץ config.js.'); $('#lg-form').hidden = true; return; }
    if (!window.supabase) { showLogin('לא ניתן לטעון את רכיבי האפליקציה. בדקו חיבור לאינטרנט ונסו שוב.'); return; }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    $('#lg-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = $('#lg-btn'); btn.disabled = true; btn.textContent = 'מתחבר…';
      try {
        var r = await sb.auth.signInWithPassword({ email: $('#lg-email').value.trim(), password: $('#lg-pass').value });
        if (r.error) throw r.error;
        await afterLogin(r.data.session);
      } catch (e) {
        var m = String((e && e.message) || '');
        showLogin(/invalid/i.test(m) ? 'המייל או הסיסמה שגויים.' : /fetch|network|Failed/i.test(m) ? 'אין חיבור לשרת. בדקו אינטרנט, או שהשרת מושהה (ראו קישור למטה).' : 'ההתחברות נכשלה: ' + m);
      }
      btn.disabled = false; btn.textContent = 'כניסה';
    });
    $('#lg-dash').href = DASHBOARD;
    try {
      var g = await sb.auth.getSession();
      if (g.data && g.data.session) await afterLogin(g.data.session);
      else showLogin('');
    } catch (e) { showLogin('אין חיבור לשרת כרגע.'); }
  });
})();
