/* חיבור ישיר לשרת Supabase, בלי ספרייה חיצונית.
   מממש רק את מה שהאפליקציה צריכה: כניסה, טבלת docs ותיקיית קבלות. */
(function () {
  'use strict';
  var SKEY = 'pinkas-session-v1';

  function createClient(url, key) {
    url = String(url).replace(/\/+$/, '');
    var session = null;
    try { session = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) {}

    function save(s) {
      session = s;
      try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) {}
    }
    function fromToken(t) {
      return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in || 3600), user: t.user };
    }
    async function authPost(path, body, token) {
      var h = { apikey: key, 'Content-Type': 'application/json' };
      if (token) h.Authorization = 'Bearer ' + token;
      var r = await fetch(url + '/auth/v1/' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
      var j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) { var m = (j && (j.error_description || j.msg || j.message || j.error)) || ('HTTP ' + r.status); var er = new Error(m); er.status = r.status; throw er; }
      return j;
    }
    var refreshing = null;
    async function refresh() {
      if (!session || !session.refresh_token) throw new Error('not signed in');
      if (!refreshing) refreshing = authPost('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
        .then(function (t) { save(fromToken(t)); }).finally(function () { refreshing = null; });
      return refreshing;
    }
    async function token() {
      if (!session) throw new Error('not signed in');
      if (session.expires_at - 60 < Date.now() / 1000) await refresh();
      return session.access_token;
    }
    async function call(method, path, opts) {
      opts = opts || {};
      for (var attempt = 0; attempt < 2; attempt++) {
        var h = Object.assign({ apikey: key, Authorization: 'Bearer ' + (await token()) }, opts.headers || {});
        var r = await fetch(url + path, { method: method, headers: h, body: opts.body });
        if (r.status === 401 && attempt === 0) { try { await refresh(); continue; } catch (e) {} }
        return r;
      }
    }
    async function asResult(r, wantJson) {
      if (!r.ok) { var t = ''; try { t = await r.text(); } catch (e) {} var m = t; try { var j = JSON.parse(t); m = j.message || j.error || t; } catch (e) {} return { data: null, error: { message: m || ('HTTP ' + r.status), status: r.status } }; }
      if (!wantJson) return { data: null, error: null };
      var txt = await r.text();
      return { data: txt ? JSON.parse(txt) : null, error: null };
    }
    function enc(v) { return encodeURIComponent(String(v)); }

    /* ---------- tables ---------- */
    function from(table) {
      var q = { filters: [], order: null, range: null, select: '*', single: false, op: 'select', body: null };
      var api = {
        select: function (cols) { if (cols) q.select = cols; return api; },
        eq: function (c, v) { q.filters.push(enc(c) + '=eq.' + enc(v)); return api; },
        in: function (c, arr) { q.filters.push(enc(c) + '=in.(' + arr.map(function (v) { return '"' + String(v).replace(/"/g, '') + '"'; }).map(enc).join(',') + ')'); return api; },
        order: function (c) { q.order = c; return api; },
        range: function (a, b) { q.range = [a, b]; return api; },
        maybeSingle: function () { q.single = true; return api; },
        upsert: function (row) { q.op = 'upsert'; q.body = row; return api; },
        update: function (row) { q.op = 'update'; q.body = row; return api; },
        delete: function () { q.op = 'delete'; return api; },
        then: function (ok, no) { return run().then(ok, no); }
      };
      async function run() {
        try {
          var path = '/rest/v1/' + table, qs = q.filters.slice(), r;
          if (q.op === 'select') {
            qs.unshift('select=' + enc(q.select));
            if (q.order) qs.push('order=' + enc(q.order));
            if (q.range) { qs.push('offset=' + q.range[0]); qs.push('limit=' + (q.range[1] - q.range[0] + 1)); }
            if (q.single) qs.push('limit=1');
            r = await call('GET', path + '?' + qs.join('&'));
            var res = await asResult(r, true);
            if (!res.error && q.single) res.data = (res.data && res.data[0]) || null;
            return res;
          }
          if (q.op === 'upsert') {
            r = await call('POST', path, { headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(q.body) });
            return asResult(r, false);
          }
          if (q.op === 'update') {
            r = await call('PATCH', path + '?' + qs.join('&'), { headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(q.body) });
            return asResult(r, false);
          }
          r = await call('DELETE', path + '?' + qs.join('&'), { headers: { Prefer: 'return=minimal' } });
          return asResult(r, false);
        } catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
      }
      return api;
    }

    /* ---------- files ---------- */
    var storage = {
      from: function (bucket) {
        return {
          upload: async function (path, blob, opt) {
            try {
              var r = await call('POST', '/storage/v1/object/' + bucket + '/' + path, { headers: { 'Content-Type': (opt && opt.contentType) || blob.type || 'application/octet-stream', 'x-upsert': 'false' }, body: blob });
              return asResult(r, false);
            } catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
          },
          download: async function (path) {
            try {
              var r = await call('GET', '/storage/v1/object/authenticated/' + bucket + '/' + path);
              if (!r.ok) return asResult(r, false);
              return { data: await r.blob(), error: null };
            } catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
          },
          remove: async function (paths) {
            try {
              var r = await call('DELETE', '/storage/v1/object/' + bucket, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
              return asResult(r, false);
            } catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
          }
        };
      }
    };

    /* ---------- sign in ---------- */
    var auth = {
      getSession: async function () {
        if (!session) return { data: { session: null } };
        try { if (session.expires_at - 60 < Date.now() / 1000) await refresh(); }
        catch (e) { if (e.status === 400 || e.status === 401) { save(null); return { data: { session: null } }; } throw e; }
        return { data: { session: session } };
      },
      signInWithPassword: async function (cred) {
        try { var t = await authPost('token?grant_type=password', { email: cred.email, password: cred.password }); save(fromToken(t)); return { data: { session: session }, error: null }; }
        catch (e) { return { data: {}, error: e }; }
      },
      signOut: async function () {
        try { if (session) await authPost('logout', {}, session.access_token); } catch (e) {}
        save(null);
      }
    };

    /* עדכון חי מוחלף בבדיקה תקופתית (מתבצעת ב-backend.js) */
    function channel() { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; }

    return { from: from, storage: storage, auth: auth, channel: channel };
  }

  window.supabase = { createClient: createClient };
})();
