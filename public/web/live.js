/*
 * Live mode: when the server reports a connected database (GET /api/health -> database: "connected"),
 * the app signs in through POST /api/auth/login (HttpOnly session cookie), the student scan is verified by the
 * server, and meal history / attendance / student lists come from the database instead of localStorage.
 * Without a database (or with ?demo=1) nothing here activates and the original browser-only demo runs.
 * Student/staff data is never written to localStorage in live mode.
 */
(function () {
  'use strict';
  var cfg = window.SMART_MESS_CONFIG || {};
  var live = false, demoDb = false, C = null, me = null, windows = [], synced = 0, scanning = null;
  var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

  // Server errors are {error: "text"}; proxies/platforms may send {error: {message}} or non-JSON. Always return readable text.
  function errMsg(b, r) {
    var e = b && b.error;
    if (typeof e === 'string' && e) return e;
    if (e && typeof e.message === 'string' && e.message) return e.message;
    if (b && typeof b.message === 'string' && b.message) return b.message;
    return 'Request failed (HTTP ' + r.status + '). Please try again, or check the server logs.';
  }
  function api(path, o) {
    o = o || {};
    var init = { method: o.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (o.body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) { var e = new Error(errMsg(b, r)); e.status = r.status; throw e; }
        return b;
      });
    });
  }
  function messQ() { return 'mess=' + encodeURIComponent(C.S.mess); }

  // --- never persist live (personal) data in the browser ------------------------------------------------
  function guardStorage() {
    var orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (live && k === 'sm_db') return; return orig.call(this, k, v); };
    try { localStorage.removeItem('sm_db'); } catch (e) { /* ignore */ }
  }

  // --- data sync -----------------------------------------------------------------------------------------
  function applyWindows(list) {
    windows = list;
    var M = C.M, WIN = C.WIN, WT = C.WT;
    M.length = 0; Object.keys(WIN).forEach(function (k) { delete WIN[k]; delete WT[k]; });
    list.forEach(function (w) {
      var a = w.start.split(':'), b = w.end.split(':');
      M.push(w.meal); WIN[w.meal] = [+a[0] * 60 + +a[1], +b[0] * 60 + +b[1]];
      var f = function (t) { var h = +t.split(':')[0], m = t.split(':')[1]; return ((h + 11) % 12 + 1) + ':' + m + (h < 12 ? ' AM' : ' PM'); };
      WT[w.meal] = f(w.start) + '–' + f(w.end);
    });
  }
  function sync(force) {
    if (!force && Date.now() - synced < 8000) return Promise.resolve();
    var DB = C.getDB(), S = C.S, p;
    if (me.ui_role === 'student') {
      p = Promise.all([api('/api/meals/history?limit=300'), api('/api/meal-windows')]).then(function (r) {
        applyWindows(r[1].windows);
        DB.att = r[0].history.map(function (h) {
          return { id: me.student_id, name: me.name, meal: h.meal_type ? cap(h.meal_type) : '—', mess: h.mess || S.mess,
            st: h.result === 'success' ? 'ok' : 'rej', t: Date.parse(h.scanned_at) };
        }).reverse();
        DB.stu = [[me.student_id, me.name, '—']];
      });
    } else {
      p = Promise.all([api('/api/meal-windows?' + messQ()), api('/api/meals/attendance?days=7&' + messQ()), api('/api/students?' + messQ())]).then(function (r) {
        applyWindows(r[0].windows);
        DB.att = r[1].attendance.map(function (a) {
          return { id: a.student_id, name: a.name, meal: a.meal_type ? cap(a.meal_type) : '—', mess: C.S.mess, st: a.result === 'success' ? 'ok' : 'rej', t: Date.parse(a.scanned_at) };
        }).reverse();
        DB.stu = r[2].students.map(function (s) { return [s.student_id, s.name, '—']; });
      });
    }
    return p.then(function () { synced = Date.now(); });
  }

  // --- auth ----------------------------------------------------------------------------------------------
  function enter(user) {
    me = user; var S = C.S;
    S.role = user.ui_role === 'student' ? 'student' : 'chief';
    S.uid = user.student_id;
    if (S.role === 'student' && user.mess) S.mess = user.mess;
    else if (!/^(North|South) Mess$/.test(S.mess)) S.mess = 'South Mess';
    S.page = 'dash'; C.persist();
    return sync(true).then(function () {
      if (S.role === 'student') { var m = document.getElementById('msel'); if (m) { m.value = S.mess; m.disabled = true; } }
      C.start();
    });
  }
  function doLogin() {
    var err = document.getElementById('lerr'), id = document.getElementById('uid').value.trim(), pw = document.getElementById('pw').value;
    if (!id || !pw) { err.textContent = 'Enter your ID and password.'; return; }
    err.textContent = '';
    api('/api/auth/login', { method: 'POST', body: { student_id: id, password: pw } }).then(function (r) {
      if (r.user.ui_role === 'warden') throw new Error('Wardens use the existing Warden app.');
      var want = C.getRole();
      if ((want === 'student') !== (r.user.ui_role === 'student')) {
        return api('/api/auth/logout', { method: 'POST', body: {} }).then(function () { throw new Error(want === 'student' ? 'This is a staff account. Choose "Mess Chief".' : 'This is a student account. Choose "Hostel Student".'); });
      }
      document.getElementById('pw').value = '';
      return enter(r.user);
    }).catch(function (e) { err.textContent = e.message; });
  }
  function logout() {
    api('/api/auth/logout', { method: 'POST', body: {} }).catch(function () {}).then(function () { C.S.role = null; C.persist(); location.reload(); });
  }

  // --- student scan --------------------------------------------------------------------------------------
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function showResult(r) {
    var ok = r.valid, box = document.getElementById('sr');
    var photo = r.student && r.student.photo_url ? '<img alt="" src="' + C.esc(r.student.photo_url) + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin:8px auto;display:block">' : '';
    box.innerHTML = '<div class="res ' + (ok ? 'ok' : 'bad') + '" role="status"><div style="font-size:48px">' + (ok ? '✓' : '✕') + '</div>' + photo +
      '<b>' + C.esc(r.message) + '</b><div>' + C.esc(r.student.name) + ' · ' + C.esc(r.student.student_id) + '</div><div>' +
      C.esc(r.meal_type || '—') + ' · ' + C.esc(r.mess ? r.mess.name : '—') + ' · ' + new Date(r.scanned_at).toLocaleTimeString() + '</div></div>';
    synced = 0; sync(true).catch(function () {});
  }
  function submitQr(text) {
    var box = document.getElementById('sr'); box.innerHTML = '<p class="mut">Verifying…</p>';
    var body = { qr: text, event_id: eventId() };
    var hint = document.getElementById('lmeal'); if (hint && hint.value) body.meal_type = hint.value.toLowerCase();
    return api('/api/meals/scan', { method: 'POST', body: body }).then(showResult).catch(function (e) {
      box.innerHTML = '<div class="res bad" role="alert"><div style="font-size:48px">✕</div><b>' + C.esc(e.status === 401 ? 'Session expired. Please sign in again.' : e.message) + '</b></div>';
    });
  }
  var evCounter = 0;
  function eventId() {                                              // unique per scan attempt; the server treats a repeated id as a retry
    var c = window.crypto;
    if (c && c.randomUUID) return 'web-' + c.randomUUID();
    if (c && c.getRandomValues) { var a = new Uint8Array(10); c.getRandomValues(a); return 'web-' + Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
    return 'web-' + Date.now().toString(36) + '-' + (++evCounter);
  }
  function stopCamera() { if (scanning) { scanning.stop(); scanning = null; } }
  function startCamera() {
    var v = document.getElementById('lv'), cv = document.createElement('canvas'), box = document.getElementById('sr');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { box.innerHTML = '<p class="err">Camera is not available here (needs HTTPS). Paste the code below.</p>'; return; }
    var decode = null, timer = null, stream = null;
    var ready = ('BarcodeDetector' in window) ? Promise.resolve(function () {
      var d = new BarcodeDetector({ formats: ['qr_code'] });
      return d.detect(v).then(function (c) { return c[0] ? c[0].rawValue : null; });
    }) : loadScript('https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js').then(function () {
      return function () {
        cv.width = v.videoWidth; cv.height = v.videoHeight; var g = cv.getContext('2d'); g.drawImage(v, 0, 0);
        var c = window.jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
        return Promise.resolve(c ? c.data : null);
      };
    });
    Promise.all([ready, navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })]).then(function (r) {
      decode = r[0]; stream = r[1]; v.srcObject = stream; v.style.display = 'block'; return v.play();
    }).then(function () {
      scanning = { stop: function () { clearInterval(timer); if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); v.style.display = 'none'; } };
      var busy = false;
      timer = setInterval(function () {
        if (busy || v.readyState < 2) return; busy = true;
        Promise.resolve(decode()).then(function (txt) { if (txt) { stopCamera(); submitQr(txt); } }).catch(function () {}).then(function () { busy = false; });
      }, 250);
    }).catch(function () { box.innerHTML = '<p class="err">Could not open the camera. Allow camera access, or paste the code below.</p>'; });
  }
  function scanPage() {
    return '<h1>Scan QR</h1><p class="mut">' + C.esc(C.S.mess) + '</p>' +
      '<div class="card" style="max-width:480px"><p class="mut">Scan the QR code shown at the mess counter. The server decides the meal from the time of day; the mess staff only look at your green or red screen.</p>' +
      (demoDb ? '<p class="demo">Demo database: meal windows are not enforced. Pick the meal you are scanning for.</p><label for="lmeal">Meal</label><select id="lmeal">' + windows.map(function (w) { return '<option value="' + C.esc(w.meal_type) + '">' + C.esc(w.meal) + '</option>'; }).join('') + '</select>' : '') +
      '<video id="lv" playsinline muted style="display:none;width:100%;border-radius:12px;background:#000"></video>' +
      '<div class="row mt"><button class="btn g" id="lstart" style="width:auto">Open camera</button></div>' +
      '<label for="lq">Or paste the code</label><input id="lq" placeholder="SMARTMESS:v1:…" autocomplete="off" style="width:100%">' +
      '<div class="row mt"><button class="btn" id="lgo" style="width:auto">Verify code</button></div>' +
      '<div id="sr" aria-live="polite"></div></div>';
  }
  function scanSetup() {
    document.getElementById('lstart').onclick = startCamera;
    document.getElementById('lgo').onclick = function () { var t = document.getElementById('lq').value.trim(); if (t) submitQr(t); };
  }

  // --- manager pages -------------------------------------------------------------------------------------
  function qrPage() {
    return '<h1>Counter QR</h1><p class="mut">' + C.esc(C.S.mess) + '. Display or print this code at the counter. Students scan it with their own phones; staff never scan.</p>' +
      '<div class="card" style="max-width:360px;text-align:center"><div id="qrbox" style="display:inline-block;background:#fff;padding:12px;border-radius:8px"></div><p class="mut" id="qrtxt" style="word-break:break-all;font-size:12px"></p></div>';
  }
  function qrSetup() {
    api('/api/mess/qr?' + messQ()).then(function (r) {
      document.getElementById('qrtxt').textContent = r.payload;
      return loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js').then(function () {
        var box = document.getElementById('qrbox'); box.innerHTML = '';
        new window.QRCode(box, { text: r.payload, width: 256, height: 256, correctLevel: window.QRCode.CorrectLevel.M });
      });
    }).catch(function (e) { var t = document.getElementById('qrtxt'); if (t) t.textContent = 'Could not show the QR: ' + e.message; });
  }
  function prepPage() {
    var opts = windows.map(function (w) { return '<option value="' + C.esc(w.meal_type) + '">' + C.esc(w.meal) + '</option>'; }).join('');
    var d = new Date(), iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return '<h1>Prepared &amp; Actuals</h1><p class="mut">' + C.esc(C.S.mess) + '. Record how much was cooked, then close each meal to store the verified served count. This feeds waste metrics and the forecast model.</p>' +
      '<div class="card mt" style="max-width:520px"><label for="pm">Meal</label><select id="pm">' + opts + '</select>' +
      '<label for="pd">Date</label><input id="pd" type="date" value="' + iso + '">' +
      '<label for="pc">Meals prepared</label><input id="pc" type="number" min="0" step="1" inputmode="numeric">' +
      '<div class="row mt"><button class="btn" id="psave" style="width:auto">Save prepared count</button><button class="btn o" id="pclose" style="width:auto">Close meal (record served)</button></div>' +
      '<p id="pmsg" class="mut" role="status"></p></div><h2 class="mt">Recent records</h2><div class="card" id="plist"><p class="mut">Loading…</p></div>';
  }
  function prepSetup() {
    var msg = function (t, bad) { var m = document.getElementById('pmsg'); m.className = bad ? 'err' : 'mut'; m.textContent = t; };
    var payload = function () { return { mess: C.S.mess, meal_type: document.getElementById('pm').value, date: document.getElementById('pd').value }; };
    var list = function () {
      api('/api/mess-usage?' + messQ()).then(function (r) {
        var rows = r.rows.slice(0, 18).map(function (x) {
          return '<tr><td>' + C.esc(x.date) + '</td><td>' + C.esc(cap(x.meal_type)) + '</td><td>' + (x.prepared_count === null ? '—' : x.prepared_count) + '</td><td>' + (x.served_count === null ? '—' : x.served_count) + '</td><td>' + (x.waste_count === null ? '—' : x.waste_count) + '</td></tr>';
        }).join('');
        document.getElementById('plist').innerHTML = rows ? '<div class="tw"><table><thead><tr><th>Date</th><th>Meal</th><th>Prepared</th><th>Served</th><th>Waste</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="mut">No records yet.</p>';
      }).catch(function (e) { document.getElementById('plist').innerHTML = '<p class="err">' + C.esc(e.message) + '</p>'; });
    };
    document.getElementById('psave').onclick = function () {
      var v = document.getElementById('pc').value; if (v === '' || +v < 0) return msg('Enter the number of meals prepared.', true);
      var b = payload(); b.prepared_count = parseInt(v, 10);
      api('/api/mess-usage/prepared', { method: 'POST', body: b }).then(function (r) { msg('Saved: ' + r.prepared_count + ' prepared.'); list(); }).catch(function (e) { msg(e.message, true); });
    };
    document.getElementById('pclose').onclick = function () {
      api('/api/mess-usage/actual', { method: 'POST', body: payload() }).then(function (r) { msg('Closed: ' + r.served_count + ' served' + (r.waste_count === null ? '' : ', ' + r.waste_count + ' wasted') + '.'); list(); }).catch(function (e) { msg(e.message, true); });
    };
    list();
  }

  // --- boot ----------------------------------------------------------------------------------------------
  function init(ctx) {
    C = ctx;
    if (cfg.demo) return Promise.resolve(false);
    return fetch('/api/health', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }).then(function (h) {
      if (h.database !== 'connected') return false;
      live = true; demoDb = h.dataSource === 'synthetic_demo'; guardStorage();
      C.setDemo(function () { return ''; });                       // no "Demo:" notices for data that is now real
      window.doLogin = doLogin; window.logout = logout;
      var hint = document.querySelector('#login p.mut.mt');
      if (hint) hint.textContent = h.schema === 'missing' ? 'Database connected but not set up yet. Run: npm run db:migrate, then npm run db:seed.'
        : h.seeded === false ? 'Database has no users yet. Run: npm run db:seed (demo data) or add real users.'
        : h.dataSource === 'synthetic_demo' ? 'Demo database: all data is SYNTHETIC. Ask the team for the demo password.' : 'Sign in with your college ID and password.';
      var NAV = C.NAV.chief;
      if (!NAV.some(function (n) { return n[0] === 'prep'; })) NAV.splice(1, 0, ['prep', 'Prepared & Actuals'], ['qr', 'Counter QR']);
      C.P.student.scan = scanPage; C.A.scan = scanSetup;
      C.P.chief.prep = prepPage; C.A.prep = prepSetup; C.P.chief.qr = qrPage; C.A.qr = qrSetup;
      var go0 = window.go;                                           // keep lists fresh before pages that use them render
      window.go = function (p) {
        stopCamera();
        var needs = ['dash', 'hist', 'att', 'stu', 'prep'].indexOf(p) >= 0 && me;
        if (!needs) return go0(p);
        sync(false).catch(function () {}).then(function () { go0(p); });
      };
      var ms = document.getElementById('msel');
      if (ms) ms.addEventListener('change', function () { synced = 0; });
      return api('/api/auth/me').then(function (r) {
        me = r.user;
        var S = C.S; S.role = me.ui_role === 'student' ? 'student' : 'chief'; S.uid = me.student_id;
        if (S.role === 'student' && me.mess) S.mess = me.mess;
        return sync(true).then(function () { if (S.role === 'student') { var m = document.getElementById('msel'); if (m) { m.value = S.mess; m.disabled = true; } } C.start(); return true; });
      }).catch(function () { C.S.role = null; C.persist(); return true; });   // not signed in -> login screen (already visible)
    });
  }

  window.SmartMessLive = { init: init };
})();
