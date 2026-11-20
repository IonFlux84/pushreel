/* Pushreel Studio. Vanilla JS, one file, no build step, no network beyond this machine.
   Markup, styles and behaviour come from the approved prototype; the data is real:
   /api/state (shot list, stills, run state, files, cost) and /api/events (server-sent events). */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var tc = function (s) { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var k = function (n) { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 || n % 1000 === 0 ? 0 : 1) + 'k' : String(n); };
  var size = function (b) { return b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB'; };
  var dur = function (s) { s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s' : s + ' s'; };
  var secs = function (n) { return (Math.round(n * 10) / 10) + ' s'; };
  var list = function (a) { return a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : String(a[0] == null ? '' : a[0]); };
  var short = function (u) { return String(u || '').replace(/^https?:\/\//, ''); };

  /* Generic glyphs drawn for the prototype. Not platform logos. */
  var GLYPH = {
    short: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="2" width="10" height="16" rx="3"/><path d="M8.6 7.6v4.8l3.8-2.4z" fill="currentColor" stroke-width="1"/></svg>',
    reel: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="2.5" width="15" height="15" rx="3.5"/><path d="M2.5 7.5h15M7 2.8l2.4 4.4M12 2.8l2.4 4.4" stroke-width="1.6"/></svg>',
    tiktok: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="14.5" r="2.8" fill="currentColor" stroke="none"/><path d="M9.8 14.5V3.2c.6 2.2 2.2 3.6 4.6 3.9"/></svg>'
  };
  var PLAY = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9.5-5.5z" fill="currentColor"/></svg>';
  var PAUSE = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 1.5h3v11h-3zM8.5 1.5h3v11h-3z" fill="currentColor"/></svg>';
  var CURSOR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 2l13 6.2-5.6 1.7L8.2 16z" fill="#fff" stroke="#0e0a1f" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  /* ---------- server ---------- */
  var json = function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); };
  var api = {
    state: function () { return fetch('/api/state').then(json); },
    save: function (sl) { return fetch('/api/shotlist', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sl) }).then(json); },
    post: function (path, body) { return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(json); },
    log: function () { return fetch('/api/log').then(json); }
  };
  function subscribe(fn) {
    var es = new EventSource('/api/events');
    es.addEventListener('state', function (e) { fn(JSON.parse(e.data)); });
    return es;
  }
  var RUNNING = ['recording', 'cutting', 'exporting'];
  var isRunning = function (st) { return !!(st.run && st.run.alive && RUNNING.indexOf(st.run.status) >= 0); };
  /* The shot list as it is saved: without the defaults the server filled in for display. */
  function rawShotlist(s) {
    var o = JSON.parse(JSON.stringify(s));
    o.scenes.forEach(function (sc) { if (sc.include === true) delete sc.include; if (sc.requiresLogin === false) delete sc.requiresLogin; });
    if (o.cursor === true) delete o.cursor;
    return o;
  }

  /* Burned-in caption: the longest word is the stressed one and gets the volt box. Same rule as src/render.js. */
  function capHTML(text) {
    if (!text) return '';
    var words = text.split(/(\s+)/), best = -1, len = 3;
    words.forEach(function (w, i) { var n = w.replace(/[^\p{L}\p{N}]/gu, '').length; if (n > len) { len = n; best = i; } });
    return '<span>' + words.map(function (w, i) {
      if (i !== best) return esc(w);
      var m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
      return esc(m[1]) + '<mark>' + esc(m[2]) + '</mark>' + esc(m[3]);
    }).join('') + '</span>';
  }
  function inkOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#ffffff';
    var c = [0, 2, 4].map(function (i) { var v = parseInt(m[1].slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.4 ? '#0e0a1f' : '#ffffff';
  }
  /* A quick sketch of the end card for the timeline preview; the Style screen shows the real one. */
  function endCardHTML(app, look) {
    var e = look && look.endCard, bg = e && /^#[0-9a-f]{6}/i.test(e.background) ? e.background.slice(0, 7) : /^#[0-9a-f]{6}$/i.test(app.brandColor || '') ? app.brandColor : '#0e0a1f';
    var ink = e && /^#/.test(e.color) ? e.color.slice(0, 7) : inkOn(bg), acc = e && /^#/.test(e.accent) ? e.accent.slice(0, 7) : ink, pill = [acc, inkOn(acc)];
    var text = (e && e.text) || app.name, cta = e && e.cta != null ? e.cta : app.address;
    return '<div class="endcard" style="background:' + bg + ';color:' + ink + '"><b>' + esc(text) + '</b>' + (cta ? '<span style="background:' + pill[0] + ';color:' + pill[1] + '">' + esc(cta) + '</span>' : '') + (app.tagline && (!e || e.tagline) ? '<small>' + esc(app.tagline) + '</small>' : '') + '</div>';
  }
  function introHTML(app, look) {
    var it = look.intro, bg = /^#[0-9a-f]{6}/i.test(it.background) ? it.background.slice(0, 7) : '#0e0a1f', ink = /^#/.test(it.color) ? it.color.slice(0, 7) : inkOn(bg);
    return '<div class="endcard" style="background:' + bg + ';color:' + ink + '"><b>' + esc(it.text || app.name) + '</b></div>';
  }

  /* Overlays shared by all previews: click marks, safe area, caption. Positions come from the platform preset. */
  var OVERLAYS = '<div class="fx" aria-hidden="true"><div class="fx-zoom"><span></span></div><div class="fx-ring"></div><div class="fx-cursor">' + CURSOR + '</div></div>' +
    '<div class="safe" aria-hidden="true"><i class="t"></i><i class="b"></i><i class="r"></i><i class="l"></i><span class="t"></span><span class="b"></span></div><div class="cap"></div>';
  function setSafe(screen, st, platform, on) {
    var P = st.platforms[platform], s = P.safe, W = st.frame.width, H = st.frame.height, m = 24;
    screen.dataset.platform = platform; screen.dataset.align = P.caption.align;
    var set = function (n, v) { screen.style.setProperty(n, v); };
    set('--st', s.top / H * 100 + '%'); set('--sb', s.bottom / H * 100 + '%'); set('--sr', s.right / W * 100 + '%'); set('--sl', s.left / W * 100 + '%');
    set('--cl', (s.left + m) / W * 100 + '%'); set('--cw', (W - s.left - s.right - 2 * m) / W * 100 + '%'); set('--cb', (s.bottom + m) / H * 100 + '%'); set('--ct', (s.top + m) / H * 100 + '%');
    var safe = $('.safe', screen); if (!safe) return;
    safe.classList.toggle('on', on);
    $('span.t', safe).textContent = 'safe area · top ' + s.top + ' px';
    $('span.b', safe).textContent = 'safe area · bottom ' + s.bottom + ' px';
  }

  /* Same rule as placeBand() in src/place.js: the caption sits on the bottom edge of the safe area. It moves up,
     to the nearest free band, when it would cover the element that is clicked (never), or a large heading or
     a fixed bar of the page (if it can be avoided). One position per scene. */
  function anchorCap(screen, cap, clicks, zoom, st, platform, layout) {
    cap.classList.remove('top'); cap.style.bottom = ''; cap.style.top = '';
    var box = cap.firstElementChild, sr = screen.getBoundingClientRect();
    layout = layout || [];
    if (!box || (!clicks.length && !layout.length) || !sr.width) return;
    var W = st.frame.width, H = st.frame.height, f = W / sr.width, b = box.getBoundingClientRect(), s = st.platforms[platform].safe;
    var size = { x: (b.left - sr.left) * f, w: b.width * f, h: b.height * f }, avoid = [];
    clicks.forEach(function (c) {
      (zoom > 1 ? [1, zoom] : [1]).forEach(function (z) {
        var ox = clamp(c.x * W * z - W / 2, 0, W * z - W), oy = clamp(c.y * H * z - H / 2, 0, H * z - H), w = (c.w || 0.1) * W * z, h = (c.h || 0.05) * H * z;
        avoid.push({ x: c.x * W * z - ox - w / 2, y: c.y * H * z - oy - h / 2, w: w, h: h });
      });
    });
    var soft = [];
    layout.forEach(function (snap) { (snap.headings || []).concat(snap.bars || []).forEach(function (r) { soft.push({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H, weight: 1 / layout.length }); }); });
    var over = function (list, y) {
      return list.reduce(function (n, a) { return n + (a.weight || 1) * Math.max(0, Math.min(size.x + size.w, a.x + a.w) - Math.max(size.x, a.x)) * Math.max(0, Math.min(y + size.h, a.y + a.h) - Math.max(y, a.y)); }, 0) / Math.max(1, size.w * size.h);
    };
    var home = H - s.bottom - 24 - size.h, minY = s.top + 24, best = null;
    for (var y = home; y >= minY; y -= 48) {
      var hd = over(avoid, y), sf = over(soft, y), c = { y: y, hard: hd < 0.005 ? 0 : hd, soft: sf < 0.02 ? 0 : Math.round(sf / 0.04) * 0.04, dist: home - y };
      if (!best || c.hard < best.hard || (c.hard === best.hard && (c.soft < best.soft || (c.soft === best.soft && c.dist < best.dist)))) best = c;
    }
    if (best && best.y !== home) { cap.style.bottom = 'auto'; cap.style.top = best.y / H * 100 + '%'; }
  }

  function copyText(text) {
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* no clipboard at all */ }
      ta.remove(); return ok;
    };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    return Promise.resolve(fallback());
  }
  function flash(btn, label) {
    var old = btn.dataset.label || btn.textContent; btn.dataset.label = old; btn.textContent = label;
    clearTimeout(btn._t); btn._t = setTimeout(function () { btn.textContent = old; }, 1600);
  }
  function wireCopy(root) {
    $$('[data-copy]', root).forEach(function (b) {
      if (b._wired) return; b._wired = true;
      b.addEventListener('click', function () { copyText(b.dataset.copy).then(function (ok) { flash(b, ok ? 'Copied' : 'Copy blocked'); }); });
    });
  }
  function wireSwitch(btn, fn) {
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(on)); fn(on);
    });
  }
  function wireArrows(group, pick) {
    group.addEventListener('keydown', function (e) {
      var d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
      var b = $$('button', group), i = b.indexOf(document.activeElement); if (i < 0) return;
      e.preventDefault(); var n = b[(i + d + b.length) % b.length]; n.focus(); pick(n);
    });
  }
  function header(st) {
    var c = $('#crumb'); if (c) c.textContent = st.shotlist ? st.shotlist.app.slug : st.project.name;
    var nav = $('#nav-recovery'); if (nav && document.body.dataset.page !== 'recovery') nav.hidden = !(st.run && st.run.status === 'paused');
    document.title = 'Pushreel · ' + (st.shotlist ? st.shotlist.app.name : st.project.name);
  }
  function costLine(st) {
    var c = st.cost;
    if (c && c.measured && c.total.in) return k(c.total.in + c.total.out) + ' tokens · $' + c.total.usd.toFixed(2);
    return c && c.measured ? '0 tokens · $0.00' : 'not measured';
  }
  var modelName = function (st) { return st.cost && st.cost.models && st.cost.models.length ? st.cost.models.join(', ') : ''; };

  /* ================= studio ================= */
  function initStudio(first) {
    var ST = first, SL = first.shotlist;
    var S = { platform: 'short', safe: false, t: 0, peek: null, playing: false, dirty: false, saving: null, sawRun: false, view: 'setup', runStart: 0, lastErrors: [] };
    var el = {
      list: $('#shot-list'), meta: $('#shot-meta'), screen: $('#screen'), segs: $('#segs'), ticks: $('#ticks'), ruler: $('#ruler'), head: $('#head'), scrub: $('#scrub'),
      play: $('#play'), played: $('#played'), note: $('#stage-note'), tc: $('#tc'), tlMeta: $('#tl-meta'), info: $('#stage-info'), skip: $('#stage-skip'), targets: $('#targets'), notice: $('#notice'),
      est: $('#est-run'), sum: $('#go-sum'), go: $('#go'), views: { setup: $('#view-setup'), run: $('#view-run'), done: $('#view-done') }, railTitle: $('#rail-title'), railSlate: $('#rail-slate')
    };
    var PK = ST.platformKeys, P = ST.platforms, END = ST.endCardSeconds, INTRO = (ST.style && ST.style.introSeconds) || 0, LOOK = ST.style && ST.style.look;
    var mountKey = null, video = null;

    if (!SL) {
      $('main').innerHTML = '<div class="hub"><p class="slate"><span class="tag ink">Studio</span>' + esc(ST.project.name) + '</p><h1>No shot list <span class="mk">yet</span></h1>' +
        '<p class="lead">Run <code>/pushreel</code> in Claude Code in this project. The agent explores your app and proposes a shot list; this page shows it as soon as it is saved. ' +
        'Or write <code>.pushreel/shotlist.json</code> by hand and run <code>pushreel validate-shotlist</code>.</p></div>';
      document.body.classList.remove('fixed');
      subscribe(function (st) { if (st.shotlist) location.reload(); });
      return;
    }

    var videoMode = function () { return !S.dirty && ST.run && ST.run.status === 'done' && ST.run.video && ST.files.some(function (f) { return f.target === S.platform; }); };
    var skipped = function () { return (ST.run && ST.run.status !== 'done' && ST.run.skip) || []; };
    var inc = function () { return SL.scenes.filter(function (s) { return s.include; }); };
    var endLen = function () { return SL.cut.endCard && inc().length ? END : 0; };
    var segments = function () {
      if (videoMode()) {
        var v = ST.run.video, out0 = v.scenes.map(function (g) { var s = SL.scenes.filter(function (x) { return x.id === g.id; })[0]; return { s: s, id: g.id, start: g.start, dur: g.length }; });
        if (v.intro) out0.unshift({ s: null, id: -2, start: 0, dur: v.intro.length });
        if (v.endCard) out0.push({ s: null, id: -1, start: v.endCard.start, dur: v.endCard.length });
        return out0;
      }
      var t = inc().length ? INTRO : 0, out = inc().map(function (s) { var g = { s: s, id: s.id, start: t, dur: s.duration }; t += s.duration; return g; });
      if (endLen()) out.push({ s: null, id: -1, start: t, dur: END });
      if (t && INTRO && inc().length) out.unshift({ s: null, id: -2, start: 0, dur: INTRO });
      return out;
    };
    var total = function () { var g = segments(); return g.length ? g[g.length - 1].start + g[g.length - 1].dur : 0; };
    var locate = function () {
      var segs = segments(), g = segs[segs.length - 1];
      for (var i = 0; i < segs.length; i++) if (S.t < segs[i].start + segs[i].dur) { g = segs[i]; break; }
      return g;
    };
    var selId = function () { if (S.peek !== null) return S.peek; var g = locate(); return g ? g.id : -1; };
    var limit = function () {
      var on = PK.filter(function (p) { return SL.targets.indexOf(p) >= 0; });
      return Math.min.apply(null, (on.length ? on : PK).map(function (p) { return P[p].caption.softChars; }));
    };
    var clicksOf = function (id) { var r = ST.recorded[id], s = ST.stills[id]; return (r && r.clicks && r.clicks.length ? r.clicks : s && s.clicks) || []; };
    var needRecord = function () { return inc().filter(function (s) { return !ST.recorded[s.id] || S.stepsChanged; }); };

    /* --- saving: every edit goes to .pushreel/shotlist.json (debounced) --- */
    function changed() {
      S.dirty = true; clearTimeout(S.saving);
      S.saving = setTimeout(save, 450);
    }
    function save() {
      clearTimeout(S.saving); S.saving = null;
      return api.save(rawShotlist(SL)).then(function (r) {
        S.lastErrors = r.ok ? [] : r.errors;
        if (r.ok) { ST = r.state; S.dirtySaved = true; }
        syncRail(); return r.ok;
      });
    }

    /* --- shot list --- */
    function buildShots() {
      el.list.innerHTML = SL.scenes.map(function (s, i) {
        var n = s.id;
        return '<li class="shot" data-id="' + n + '">' +
          '<button type="button" class="shot-pick" data-act="pick" aria-label="Select scene ' + n + ', ' + esc(s.title) + '"><span class="shot-nr">' + String(n).padStart(2, '0') + '</span><span><b title="' + esc(s.title) + '">' + esc(s.title) + '</b><small>' + esc(s.url) + '</small></span></button>' +
          '<span class="step" role="group" aria-label="Length of scene ' + n + '"><button type="button" data-act="dec" aria-label="Shorten scene ' + n + ' by one second">−</button><output aria-live="off"></output><button type="button" data-act="inc" aria-label="Lengthen scene ' + n + ' by one second">+</button></span>' +
          '<button type="button" class="switch" role="switch" data-act="tog" aria-label="Include scene ' + n + ' in the video"></button>' +
          '<span class="cap-row"><label class="vh" for="cap' + i + '">Caption for scene ' + n + '</label><textarea class="cap-in" id="cap' + i + '" rows="1" autocomplete="off" spellcheck="true" placeholder="Caption shown during this scene">' + esc(s.caption) + '</textarea><span class="cap-n" aria-live="polite"></span></span></li>';
      }).join('');
    }
    var sceneOf = function (node) { var id = +node.closest('.shot').dataset.id; return SL.scenes.filter(function (s) { return s.id === id; })[0]; };
    function syncShots() {
      var sel = selId(), lim = limit();
      $$('.shot', el.list).forEach(function (li) {
        var s = sceneOf(li);
        li.classList.toggle('sel', s.id === sel); li.classList.toggle('off', !s.include);
        $('.shot-pick', li).setAttribute('aria-pressed', String(s.id === sel));
        $('output', li).textContent = s.duration + ' s';
        $('[data-act="dec"]', li).disabled = s.duration <= 2; $('[data-act="inc"]', li).disabled = s.duration >= 30;
        $('.switch', li).setAttribute('aria-checked', String(s.include));
        var c = $('.cap-n', li); c.textContent = s.caption.length + '/' + lim; c.classList.toggle('over', s.caption.length > lim);
      });
      el.meta.textContent = inc().length + ' of ' + SL.scenes.length + ' scenes · ' + tc(total());
    }
    el.list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var s = sceneOf(b), a = b.dataset.act;
      if (a === 'dec') { s.duration = clamp(s.duration - 1, 2, 30); changed(); }
      if (a === 'inc') { s.duration = clamp(s.duration + 1, 2, 30); changed(); }
      if (a === 'tog') { s.include = !s.include; changed(); }
      pause(); select(s.id); structure();
    });
    el.list.addEventListener('focusin', function (e) {
      if (e.target.classList.contains('cap-in')) { var s = sceneOf(e.target); if (s.id !== selId()) { pause(); select(s.id); frame(); syncShots(); buildTimeline(); } }
    });
    el.list.addEventListener('input', function (e) {
      if (!e.target.classList.contains('cap-in')) return;
      sceneOf(e.target).caption = e.target.value; changed();
      mountKey = null; frame(); syncShots(); syncRail();
    });

    /* Park the playhead just after the first click of the scene so ring and zoom frame are visible. */
    function select(id) {
      var s = SL.scenes.filter(function (x) { return x.id === id; })[0];
      var g = segments().filter(function (x) { return x.id === id; })[0];
      if (!s || !g) { S.peek = id; return; }
      S.peek = null;
      S.t = g.start + Math.min(g.dur - 0.2, g.dur * 0.45);
    }

    /* --- preview --- */
    function frame() {
      var peek = S.peek !== null ? SL.scenes.filter(function (x) { return x.id === S.peek; })[0] : null;
      var g = peek ? { s: peek, id: peek.id, start: 0, dur: peek.duration, peek: true } : locate();
      if (!g) { el.screen.innerHTML = ''; mountKey = null; return; }
      var vm = videoMode() && !g.peek;
      var key = vm ? 'video:' + S.platform : g.s ? 'still:' + g.id : g.id === -2 ? 'intro' : 'end';
      if (key !== mountKey) {
        mountKey = key; video = null;
        if (vm) {
          var f = ST.files.filter(function (x) { return x.target === S.platform; })[0];
          el.screen.innerHTML = '<video class="clip" muted playsinline preload="auto" src="' + esc(f.src) + '"></video>' + OVERLAYS;
          video = $('video', el.screen);
        } else if (g.s) {
          var st = ST.stills[g.id];
          el.screen.innerHTML = (st ? '<img class="still" alt="" src="' + st.src + '">' : '<div class="nostill"><div><b>' + esc(g.s.title) + '</b>' + (ST.recorded[g.id] ? 'Recorded. The video shows after the next export.' : 'No still yet. Stills are taken while the agent explores.') + '</div></div>') + OVERLAYS;
        } else el.screen.innerHTML = (g.id === -2 && LOOK ? introHTML(SL.app, LOOK) : endCardHTML(SL.app, LOOK)) + OVERLAYS;
        setSafe(el.screen, ST, S.platform, S.safe);
      }
      var cap = $('.cap', el.screen), ring = $('.fx-ring', el.screen), zoom = $('.fx-zoom', el.screen), cur = $('.fx-cursor', el.screen);
      if (vm) {
        if (video && Math.abs(video.currentTime - S.t) > 0.12 && !S.playing) { try { video.currentTime = S.t; } catch (e) { /* not ready */ } }
        cap.innerHTML = ''; ring.classList.remove('on'); zoom.classList.remove('on'); cur.hidden = true;
      } else if (g.s) {
        var c = clicksOf(g.id)[0];
        cap.innerHTML = SL.cut.captions ? capHTML(g.s.caption) : '';
        anchorCap(el.screen, cap, clicksOf(g.id), SL.cut.zoom, ST, S.platform, (ST.recorded[g.id] && ST.recorded[g.id].layout) || []);
        cur.hidden = !c; ring.classList.toggle('on', !!c); zoom.classList.toggle('on', !!c && SL.cut.zoom > 1);
        if (c) {
          ring.style.left = c.x * 100 + '%'; ring.style.top = c.y * 100 + '%';
          cur.style.left = c.x * 100 + '%'; cur.style.top = c.y * 100 + '%';
          var w = (c.w || 0.2) * 100, h = (c.h || 0.08) * 100, pad = 1.6;
          zoom.style.left = c.x * 100 - w / 2 - pad + '%'; zoom.style.top = c.y * 100 - h / 2 - pad * 0.56 + '%'; zoom.style.width = w + pad * 2 + '%'; zoom.style.height = h + pad * 1.12 + '%';
          $('span', zoom).textContent = 'zoom ' + SL.cut.zoom + '×';
        }
      } else { cap.innerHTML = ''; cur.hidden = true; ring.classList.remove('on'); zoom.classList.remove('on'); }
      el.skip.hidden = !g.peek;
      var n = g.s ? String(g.id).padStart(2, '0') : '';
      el.info.innerHTML = g.s
        ? '<span class="slate"><span class="dot' + (S.playing || S.view === 'run' ? ' live' : '') + '"></span><b>Scene ' + n + '</b></span><span class="slate">' + esc(g.s.url) + ' · ' + secs(g.dur) + '</span><span class="slate">' +
          (g.peek ? 'not in the video' : tc(g.start) + ' to ' + tc(g.start + g.dur)) + '</span>'
        : '<span class="slate"><span class="dot"></span><b>' + (g.id === -2 ? 'Intro card' : 'End card') + '</b></span><span class="slate">' + esc(SL.app.address || SL.app.name) + ' · ' + (g.id === -2 ? INTRO : END) + ' s</span>';
      el.note.textContent = S.view === 'run' ? 'Recording now: fixed code replays shotlist.json.' : vm ? 'The exported ' + P[S.platform].name + '. Captions are burned in.' : g.s && ST.stills[g.id] ? 'Still from exploring. Video exists after recording.' : 'Preview of the plan. Video exists after recording.';
      var T = total();
      el.tc.innerHTML = tc(S.t) + ' <span>/ ' + tc(T) + '</span>';
      el.head.style.left = (T ? S.t / T * 100 : 0) + '%';
      el.played.style.width = (T ? S.t / T * 100 : 0) + '%';
      el.scrub.value = S.t;
      el.scrub.setAttribute('aria-valuetext', tc(S.t) + ' of ' + tc(T));
    }

    /* --- timeline --- */
    function buildTimeline() {
      var segs = segments(), T = total(), sel = selId();
      el.segs.innerHTML = segs.map(function (g) {
        return g.s
          ? '<button type="button" data-id="' + g.id + '" class="' + (g.id === sel ? 'sel' : '') + '" style="flex:' + g.dur + ' 1 0" title="' + esc(g.s.title) + '" aria-label="Scene ' + g.id + ', ' + esc(g.s.title) + ', ' + secs(g.dur) + '"><b>' + String(g.id).padStart(2, '0') + ' ' + esc(g.s.title) + '</b><small>' + secs(g.dur) + '</small></button>'
          : '<button type="button" class="end" tabindex="-1" style="flex:' + g.dur + ' 1 0" aria-label="' + (g.id === -2 ? 'Intro card' : 'End card') + ', ' + g.dur + ' seconds"><small>' + (g.id === -2 ? 'Intro' : 'End') + '</small></button>';
      }).join('');
      var nclicks = 0;
      el.ticks.innerHTML = segs.filter(function (g) { return g.s; }).map(function (g) {
        var n = (g.s.steps || []).filter(function (x) { return x.do === 'click'; }).length; nclicks += n;
        return n ? '<i style="left:' + (g.start + g.dur * 0.45) / T * 100 + '%"></i>' : '';
      }).join('');
      var step = T > 45 ? 10 : 5, r = '';
      for (var t = 0; t < T; t += step) if (t / T <= 0.88) r += '<span style="left:' + t / T * 100 + '%">' + tc(t) + '</span>'; /* a label in the last 12 % would stick out of the track on a phone */
      el.ruler.innerHTML = r;
      el.scrub.max = T; el.scrub.disabled = !T;
      var stats = ST.run && ST.run.status === 'done' && !S.dirty ? ST.run.stats : null;
      el.tlMeta.textContent = !T ? 'nothing to play' : (stats && stats.rawSeconds
        ? 'raw ' + tc(stats.rawSeconds) + ' to final ' + tc(T) + ' · ' + stats.waitsRemoved + (stats.waitsRemoved === 1 ? ' wait' : ' waits') + ' removed'
        : (SL.cut.removeWaitsOver > 0 ? 'waits over ' + SL.cut.removeWaitsOver + ' s are removed' : 'waits kept') + ' · final ' + tc(T)) + ' · ' + nclicks + (nclicks === 1 ? ' click' : ' clicks');
      el.play.disabled = !T;
    }
    el.segs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      pause(); select(+b.dataset.id); frame(); syncShots(); buildTimeline();
    });
    el.scrub.addEventListener('input', function () { pause(); S.peek = null; S.t = clamp(+el.scrub.value, 0, Math.max(0, total() - 0.01)); frame(); syncShots(); markSeg(); });
    function markSeg() { var sel = selId(); $$('button[data-id]', el.segs).forEach(function (b) { b.classList.toggle('sel', +b.dataset.id === sel); }); }

    /* --- transport --- */
    var raf = 0, last = 0, lastSel = -2;
    function tick(now) {
      if (!S.playing) return;
      if (video && videoMode()) S.t = video.currentTime; else S.t += Math.min(0.1, (now - last) / 1000);
      last = now;
      if (S.t >= total() - 0.02 || (video && video.ended)) { S.t = Math.max(0, total() - 0.02); pause(); frame(); return; }
      frame();
      var sel = selId(); if (sel !== lastSel) { lastSel = sel; syncShots(); markSeg(); }
      raf = requestAnimationFrame(tick);
    }
    function play() {
      if (!total()) return;
      S.peek = null; if (S.t >= total() - 0.1) S.t = 0;
      frame();
      if (video && videoMode()) { try { video.currentTime = S.t; } catch (e) { /* not ready */ } video.play().catch(function () {}); }
      S.playing = true; last = performance.now(); lastSel = -2; raf = requestAnimationFrame(tick); syncPlay();
    }
    function pause() { if (!S.playing) return; S.playing = false; cancelAnimationFrame(raf); if (video) video.pause(); syncPlay(); frame(); }
    function syncPlay() { el.play.innerHTML = S.playing ? PAUSE : PLAY; el.play.setAttribute('aria-label', S.playing ? 'Pause preview' : 'Play preview'); }
    el.play.addEventListener('click', function () { S.playing ? pause() : play(); });

    /* --- platform, safe area --- */
    var plat = $('#platforms');
    function setPlatform(p) {
      pause(); S.platform = p;
      $$('button', plat).forEach(function (b) { var on = b.dataset.p === p; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      $('#plat-hint').textContent = P[p].hint;
      mountKey = null; frame();
    }
    plat.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setPlatform(b.dataset.p); });
    wireArrows(plat, function (b) { setPlatform(b.dataset.p); });
    wireSwitch($('#safe'), function (on) { S.safe = on; setSafe(el.screen, ST, S.platform, S.safe); });

    /* --- export rail --- */
    function buildRail() {
      el.targets.innerHTML = PK.map(function (p) {
        return '<li class="target" data-p="' + p + '"><span class="disc" data-o="' + p + '"></span><span class="t-name">' + P[p].name + '</span>' +
          '<button type="button" class="switch" role="switch" aria-checked="' + (SL.targets.indexOf(p) >= 0) + '" aria-label="Export ' + P[p].name + '"></button><span class="t-file">' + esc(SL.app.slug) + '-' + P[p].suffix + '.mp4</span><span class="t-meta"></span></li>';
      }).join('');
      $$('.target .switch', el.targets).forEach(function (b) {
        wireSwitch(b, function (on) {
          var p = b.closest('.target').dataset.p;
          SL.targets = PK.filter(function (x) { return x === p ? on : SL.targets.indexOf(x) >= 0; });
          changed(); syncRail(); syncShots();
        });
      });
      var c = $('#cuts');
      var box = function (n) { return $('input[name="' + n + '"]', c); };
      box('zoom').checked = SL.cut.zoom > 1; box('waits').checked = SL.cut.removeWaitsOver > 0; box('caps').checked = !!SL.cut.captions; box('end').checked = !!SL.cut.endCard;
      $$('input', c).forEach(function (i) {
        if (i._wired) return; i._wired = true;
        i.addEventListener('change', function () {
          if (i.name === 'zoom') SL.cut.zoom = i.checked ? (S.zoomWas || 1.4) : (S.zoomWas = SL.cut.zoom, 1);
          if (i.name === 'waits') SL.cut.removeWaitsOver = i.checked ? (S.waitWas || 0.6) : (S.waitWas = SL.cut.removeWaitsOver, 0);
          if (i.name === 'caps') SL.cut.captions = i.checked;
          if (i.name === 'end') SL.cut.endCard = i.checked;
          changed(); S.t = clamp(S.t, 0, Math.max(0, total() - 0.01)); mountKey = null; structure();
        });
      });
      $('label:nth-child(4)', c).lastChild.textContent = 'End card, ' + END + ' s';
    }
    function syncRail() {
      var T = Math.round(total() * 10) / 10, n = inc().length, nt = 0;
      $$('.target', el.targets).forEach(function (li) {
        var p = li.dataset.p, on = SL.targets.indexOf(p) >= 0; if (on) nt++;
        li.classList.toggle('off', !on);
        var over = inc().filter(function (s) { return s.caption.length > P[p].caption.softChars; })[0];
        var capMsg = !SL.cut.captions ? '<span>Captions off</span>' : over
          ? '<span class="bad">Scene ' + over.id + ' caption: ' + over.caption.length + ' of ' + P[p].caption.softChars + ' characters</span>'
          : '<span class="good">Captions fit</span>';
        $('.t-meta', li).innerHTML = on
          ? '<span class="mono' + (T > P[p].maxSeconds ? ' bad' : '') + '">' + T + ' s of ' + P[p].maxSeconds + ' s</span>' + capMsg
          : '<span>Off. This file is skipped.</span>';
      });
      var msg = '', err = true, overT = PK.filter(function (p) { return SL.targets.indexOf(p) >= 0 && T > P[p].maxSeconds; })[0];
      if (!ST.licence.valid) msg = ST.licence.revoked ? 'This licence is no longer valid on this machine. Run: pushreel licence' : 'Pushreel is not activated on this machine. Run: pushreel activate <your-licence-key>';
      else if (!n) msg = 'Include at least one scene.';
      else if (!nt) msg = 'Turn on at least one target.';
      else if (overT) msg = 'This is ' + Math.round((T - P[overT].maxSeconds) * 10) / 10 + ' s over the limit for ' + P[overT].name + '. Shorten a scene or turn that target off.';
      else if (S.lastErrors.length) msg = S.lastErrors[0];
      else if (S.stopNote) { msg = S.stopNote; err = false; }
      else if (T > 60) { msg = 'This video runs ' + T + ' s. The presets are tuned for 20 to 40 s. Longer works, and you may want to skip a scene.'; err = false; }
      el.notice.hidden = !msg; el.notice.textContent = msg; el.notice.classList.toggle('err', err && !!msg);
      el.go.disabled = !n || !nt || !!overT || !ST.licence.valid;
      var need = needRecord().length;
      el.go.textContent = !need ? 'Render again' : need < n ? 'Record ' + need + (need === 1 ? ' scene' : ' scenes') + ' and export' : 'Record and export';
      $('#go-note').textContent = !need ? 'No new recording needed: all ' + n + ' scenes are on disk. Cutting and exporting only. Nothing is uploaded.'
        : 'The browser runs in the background. ' + (ST.app.running ? 'Your app at ' + short(ST.app.url) + ' is used as it is.' : 'Pushreel starts your app' + (ST.app.command ? ' with "' + ST.app.command + '"' : '') + ' and stops it after the run.') + ' Nothing is uploaded.';
      el.est.textContent = '0 tokens · $0.00';
      $('#est-used').textContent = costLine(ST);
      $('#cost-model').textContent = modelName(ST) || 'your session model';
      el.sum.innerHTML = '<span>' + tc(T) + ' · ' + nt + (nt === 1 ? ' file' : ' files') + '</span><small>1080×1920 · no watermark</small>';
    }
    function structure() { buildTimeline(); frame(); syncShots(); syncRail(); }

    /* --- header: app chip, model chip --- */
    function syncHeader() {
      header(ST);
      var a = ST.app, up = a.running;
      $('#app-dot').className = 'dot ' + (up ? 'ok' : 'off'); $('#app-dot2').className = 'dot ' + (up ? 'ok' : 'off');
      $('#app-addr').textContent = a.url ? short(a.url) : 'not found';
      var state = up ? (a.startedByPushreel ? 'started by Pushreel' : 'already running') : (ST.run && ST.run.appStopped ? 'stopped after the run' : 'not running');
      $('#app-state').textContent = '· ' + state;
      $('#app-title').textContent = up ? 'Running at ' + short(a.url) + (a.startedByPushreel ? ', started by Pushreel' : '. Pushreel leaves it running.') : a.url ? 'Not running. The next run starts it' + (a.command ? ' with "' + a.command + '".' : '.') : 'No app found in this project yet.';
      $('#app-btn').setAttribute('aria-label', 'App: ' + (a.url ? short(a.url) : 'not found') + ', ' + state + '. Show details');
      $('#app-cmd').innerHTML = a.command ? ', here <code>' + esc(a.command) + '</code>' : '';
      $('#app-case-running').classList.toggle('cur', !!up && !a.startedByPushreel);
      $('#app-case-start').classList.toggle('cur', !up || a.startedByPushreel);
      syncModel();
      $('#page-h1').textContent = 'Review the shot list for ' + SL.app.name;
    }

    /* --- model chip and popover: the note of the last /pushreel run (pushreel model-check), with real prices --- */
    var modelSaid = '';
    function syncModel() {
      var m = ST.model, est = (ST.prices && ST.prices.estimates) || [], rec = est.filter(function (e) { return e.recommended; })[0] || { name: ST.prices.recommended, usd: 0 };
      var used = m ? m.name : modelName(ST);
      $('#model-name').textContent = used ? used.replace(/^Claude /, '') : 'from your session';
      $('#model-title').textContent = m ? 'This session runs ' + m.name : used ? 'This run used ' + used : 'Pushreel uses the model of your Claude Code session';
      var warn = !!m && (m.kind === 'pricier' || m.kind === 'haiku');
      $('#model-btn').classList.toggle('warn', warn && !m.dontAsk && !modelSaid);
      $('#model-note').hidden = !warn;
      if (warn) {
        $('#model-note-text').textContent = m.note || ('A run costs about ' + times(m.ratio) + ' what it costs on ' + rec.name + '. Switch with /model, or continue.');
        $('#model-dontask-row').hidden = !!m.dontAsk;
        var said = modelSaid || (m.dontAsk ? 'You chose not to be asked again for this model. Ask again: pushreel config reset' : '');
        $('#model-said').hidden = !said; $('#model-said').textContent = said;
      }
      $('#model-list').innerHTML = est.map(function (e) {
        var cur = m ? m.id === e.id : used === e.name;
        var tag = e.recommended ? '<span class="tag volt">' + (cur ? 'In use · ' : '') + 'Recommended</span>' : cur ? '<span class="tag ink">In use</span>' : e.haiku ? '<span class="tag warn">Works in part</span>' : '<span class="tag ok">Works</span>';
        var cost = (e.low !== undefined ? '$' + e.low.toFixed(2) + ' to $' + e.high.toFixed(2) : '≈ $' + Math.max(0.01, e.usd).toFixed(2)) + ' per run' + (e.ratio > 1.15 ? ' · ' + times(e.ratio) + ' ' + rec.name.replace(/^Claude /, '') : '');
        var why = e.recommended ? 'Best balance of speed, cost and scene choice.' : e.haiku ? 'For re-renders and caption edits. The first shot list may be weak.' : e.ratio > 1.15 ? 'Costs more per run.' : '';
        return '<li' + (cur ? ' class="cur"' : '') + '><b>' + esc(e.name) + '</b>' + tag + '<p><span class="mono">' + cost + '</span>' + (why ? ' · ' + why : '') + '</p></li>';
      }).join('') + '<li class="no"><b>Not supported</b><span class="tag">No</span><p>Other coding agents, local models behind a proxy, older Claude models.</p></li>';
      $('#model-foot2').textContent = 'Estimates: a range, ' + (ST.prices.contextTokens ? 'from the context your last /pushreel session carried (about ' + k(Math.round(ST.prices.contextTokens / 1000) * 1000) + ' tokens per turn)' : 'for a small session (nothing was measured here yet)') + ', times the turn profile of our first runs, at API list prices checked ' + ST.prices.lastChecked + '. A large CLAUDE.md, many plugins and MCP servers raise it. On a Claude subscription this counts against your plan limits, no extra charge.';
    }
    function times(r) { return (r >= 10 ? String(Math.round(r)) : String(Math.round(r * 10) / 10)) + '×'; }
    $('#model-continue').addEventListener('click', function () {
      var m = ST.model; if (!m) return;
      var done = function () { modelSaid = 'Continuing with ' + m.name + '.' + ($('#model-dontask').checked ? ' Pushreel will not ask again for this model. Undo: pushreel config reset' : ''); syncModel(); };
      if ($('#model-dontask').checked && !m.dontAsk) api.post('/api/model/remember', { id: m.id }).then(function (r) { if (r.ok) { ST = r.state; } done(); });
      else done();
    });
    $('#model-switch').addEventListener('click', function () {
      copyText('/model').then(function (ok) { modelSaid = (ok ? 'Copied /model. Paste' : 'Type /model') + ' in Claude Code, pick a model, then run /pushreel again. Nothing is recorded until then.'; syncModel(); });
    });

    /* --- run: the server does the work, this view follows run.json --- */
    function view(v) {
      S.view = v;
      Object.keys(el.views).forEach(function (n) { el.views[n].hidden = n !== v; });
      el.railTitle.textContent = { setup: 'Export', run: 'Recording', done: 'Done' }[v];
      el.railSlate.innerHTML = v === 'run' ? '<span class="dot live"></span>On air' : v === 'done' && ST.run ? dur(ST.run.elapsed) : ST.frame.width + '×' + ST.frame.height;
      $$('.shots, .tline').forEach(function (p) { p.inert = v === 'run'; p.style.opacity = v === 'run' ? .55 : ''; });
    }
    var clock = 0;
    function syncRun() {
      var run = ST.run, steps = (run && run.steps) || [];
      $('#run-title').textContent = (run.status === 'recording' ? 'Recording ' : run.status === 'cutting' ? 'Cutting ' : 'Exporting ') + SL.app.name;
      $('#steps').innerHTML = steps.map(function (s) {
        var cls = { waiting: 'wait', running: 'now', done: 'ok', failed: 'bad' }[s.status] || 'wait';
        return '<li class="' + cls + '"><i></i><b>' + esc(s.label) + '</b><span>0 tokens</span><small>' + esc(s.note || (s.status === 'waiting' ? 'Waiting' : s.status === 'running' ? 'Working' : '')) + '</small></li>';
      }).join('');
      var done = steps.filter(function (s) { return s.status === 'done'; }).length, now = steps.filter(function (s) { return s.status === 'running'; })[0];
      var p = steps.length ? (done + (now ? 0.5 : 0)) / steps.length : 0;
      $('#run-prog i').style.width = p * 100 + '%'; $('#run-prog').setAttribute('aria-valuenow', Math.round(p * 100));
      $('#run-live').textContent = now ? now.label : '';
      var c = ST.cost && ST.cost.measured ? ST.cost.total : { in: 0, out: 0, usd: 0, eur: 0 };
      $('#run-in').innerHTML = k(c.in) + ' in<small>' + k(c.out) + ' out</small>';
      $('#run-cost').innerHTML = '$' + c.usd.toFixed(2) + '<small>€' + c.eur.toFixed(2) + '</small>';
      var rec = run.scenes.filter(function (s) { return s.status === 'recording'; })[0];
      if (rec && rec.id !== selId()) { select(rec.id); mountKey = null; frame(); syncShots(); markSeg(); }
    }
    function syncDone() {
      var run = ST.run;
      $('#done-title').textContent = 'Done in ' + dur(run.elapsed);
      $('#done-dir').textContent = ST.outDir;
      $('#done-files').innerHTML = ST.files.filter(function (f) { return f.kind !== 'shotlist' && f.kind !== 'log'; }).map(function (f) {
        return '<li><b>' + esc(f.name) + '</b><span>' + (f.seconds ? esc(f.seconds) + ' s · ' : '') + size(f.bytes) + '</span></li>';
      }).join('');
      var c = ST.cost && ST.cost.measured ? ST.cost.total : null;
      $('#done-tok').textContent = c ? k(c.in) + ' in / ' + k(c.out) + ' out' : 'not measured';
      $('#done-cost').textContent = c ? '≈ $' + c.usd.toFixed(2) + ' · €' + c.eur.toFixed(2) : 'started outside Claude Code';
      $('#done-model').textContent = modelName(ST);
      $('#done-app').textContent = run.appStopped ? 'Pushreel stopped the dev server it started.' : 'Your app was already running and is left running.';
    }
    el.go.addEventListener('click', function () {
      pause(); el.go.disabled = true; S.stopNote = '';
      var go = function () {
        var mode = Object.keys(ST.recorded).some(function (id) { return ST.recorded[id]; }) ? 'rerender' : 'run';
        api.post('/api/run', { mode: mode }).then(function (r) {
          if (!r.ok) { S.lastErrors = [r.error]; syncRail(); return; }
          S.sawRun = true; S.dirty = false; S.runStart = performance.now();
          clearInterval(clock); clock = setInterval(function () { $('#run-elapsed').textContent = tc((performance.now() - S.runStart) / 1000) + ' elapsed'; }, 250);
          view('run'); $('#steps').innerHTML = ''; $('#stop').focus();
        });
      };
      (S.saving ? save() : Promise.resolve(true)).then(function (ok) { if (ok) go(); else el.go.disabled = false; });
    });
    $('#stop').addEventListener('click', function () { $('#stop').disabled = true; $('#stop').textContent = 'Stopping after this scene'; api.post('/api/stop'); });
    $('#again').addEventListener('click', function () { view('setup'); el.go.focus(); });

    /* --- server pushes --- */
    function onState(st) {
      var wasRunning = isRunning(ST), wasStatus = ST.run && ST.run.status;
      ST = st;
      var sig = JSON.stringify(rawShotlist(st.shotlist || {}));
      if (!S.saving && st.shotlist && sig !== JSON.stringify(rawShotlist(SL)) && !document.activeElement.classList.contains('cap-in')) { SL = st.shotlist; buildShots(); buildRail(); mountKey = null; }
      syncHeader();
      if (isRunning(st)) {
        if (S.view !== 'run') { S.sawRun = true; S.runStart = performance.now(); clearInterval(clock); clock = setInterval(function () { $('#run-elapsed').textContent = tc((performance.now() - S.runStart) / 1000) + ' elapsed'; }, 250); view('run'); }
        syncRun(); frame(); return;
      }
      clearInterval(clock); $('#stop').disabled = false; $('#stop').textContent = 'Stop';
      if (S.view === 'run' || (wasRunning && !isRunning(st))) {
        if (st.run && st.run.status === 'done') { S.dirty = false; syncDone(); view('done'); S.t = 0; mountKey = null; structure(); $('#to-result').focus(); return; }
        if (st.run && st.run.status === 'paused' && st.run.error && st.run.error.code !== 'stopped') { location.href = '/recovery'; return; }
        S.stopNote = st.run && st.run.status === 'paused' ? 'Stopped. Recorded scenes are kept. ' + (st.app.running && st.app.startedByPushreel ? 'Your app is still running. ' : '') + 'Press the button to continue.' : st.run && st.run.error ? st.run.error.title + '. ' + (st.run.error.text || '') : '';
        view('setup');
      }
      if (S.view !== 'done') structure();
      void wasStatus;
    }

    /* --- header popovers: one open at a time, Esc closes and returns focus --- */
    var pops = $$('.pop-wrap').map(function (w) { return { btn: $('button[aria-controls]', w), pop: $('.pop', w) }; });
    function openPop(p, open) {
      if (open) pops.forEach(function (o) { if (o !== p) openPop(o, false); });
      if (open) document.documentElement.style.setProperty('--pop-top', Math.round(p.btn.getBoundingClientRect().bottom + 10) + 'px');
      p.pop.hidden = !open; p.btn.setAttribute('aria-expanded', String(open));
      if (open) p.pop.focus();
    }
    pops.forEach(function (p) { p.btn.addEventListener('click', function () { openPop(p, p.pop.hidden); }); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      pops.forEach(function (p) { if (!p.pop.hidden) { openPop(p, false); p.btn.focus(); } });
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.pop-wrap')) pops.forEach(function (p) { if (!p.pop.hidden) openPop(p, false); }); });

    buildShots(); buildRail(); syncPlay(); syncHeader();
    var firstScene = inc()[0]; if (firstScene) select(firstScene.id);
    setPlatform(SL.targets[0] || 'short'); view('setup'); structure();
    if (ST.run && ST.run.status === 'paused' && ST.run.error && ST.run.error.code !== 'stopped') {
      S.stopNote = 'The last run paused: ' + ST.run.error.title + '. Open Recovery in the top bar.'; syncRail();
    }
    subscribe(onState);
  }


  /* ================= style ================= */
  /* The Style screen edits a draft of pushreel.style.json. Every change asks the server for the renderer's own
     pages (caption, end card, cover, intro) drawn with the draft, on a real frame of this project. */
  var GROUP_NAMES = { captions: 'Captions', endCard: 'End card', cover: 'Cover', motion: 'Motion', watermark: 'Corner logo', intro: 'Intro card' };
  function initStyle(ST) {
    header(ST);
    var SS = null, draft = {}, dirty = false, platform = 'short', timer = 0, seq = 0;
    var el = { groups: $('#sty-groups'), base: $('#sty-base'), line: $('#sty-line'), phones: $('#sty-phones'), msgs: $('#sty-msgs'), dirty: $('#sty-dirty'), text: $('#sty-text') };
    var get = function (o, k) { return k.split('.').reduce(function (a, x) { return a && typeof a === 'object' ? a[x] : undefined; }, o); };
    var set = function (o, k, v) { var ks = k.split('.'); var a = o; ks.slice(0, -1).forEach(function (x) { if (!a[x] || typeof a[x] !== 'object') a[x] = {}; a = a[x]; }); a[ks[ks.length - 1]] = v; };
    var unset = function (o, k) { var ks = k.split('.'); var g = o[ks[0]]; if (!g) return; delete g[ks[1]]; if (!Object.keys(g).length) delete o[ks[0]]; };
    function mark(d) { dirty = d; el.dirty.textContent = d ? 'not saved yet' : 'saved'; }
    function msgs(list) { el.msgs.innerHTML = list.map(function (m) { return '<li class="' + (m[0] || '') + '">' + esc(m[1]) + '</li>'; }).join(''); }

    function field(key, spec) {
      var v = get(SS.style, key), own = get(draft, key) !== undefined, id = 'f-' + key.replace('.', '-'), ctl;
      var name = key.split('.')[1];
      switch (spec.type) {
        case 'bool': ctl = '<button type="button" class="switch" role="switch" id="' + id + '" aria-checked="' + (v === true) + '" aria-label="' + esc(key) + '"></button>'; break;
        case 'enum': ctl = '<select id="' + id + '">' + spec.values.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>'; break;
        case 'font': ctl = '<input type="text" id="' + id + '" list="sty-fonts" value="' + esc(v) + '" spellcheck="false">'; break;
        case 'int': case 'number': case 'scene': ctl = '<input type="number" id="' + id + '" value="' + (v == null ? '' : v) + '"' + (spec.min != null ? ' min="' + spec.min + '"' : '') + (spec.max != null ? ' max="' + spec.max + '"' : '') + ' step="' + (spec.type === 'number' ? '0.05' : '1') + '"' + (spec.type === 'scene' ? ' placeholder="first"' : '') + '>'; break;
        case 'color': case 'colorOrNone': case 'colorOrAuto':
          var hex = /^#[0-9a-f]{6}/i.test(v || '') ? v.slice(0, 7) : '#000000';
          ctl = '<input type="color" value="' + hex + '" data-for="' + id + '" aria-label="Pick ' + esc(key) + '"' + (/^#/.test(v || '') ? '' : ' disabled') + '><input type="text" id="' + id + '" value="' + esc(v) + '" spellcheck="false">'; break;
        default: ctl = '<input type="text" id="' + id + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + (spec.type === 'image' ? 'none (a .png or .svg in the project)' : 'from the shot list') + '" spellcheck="false">';
      }
      var src = own ? '<span class="sty-src own">this file · <button type="button" data-reset="' + key + '">reset</button></span>' : '<span class="sty-src">' + esc((SS.sources[key] || '').replace(/^built-in style /, '')) + '</span>';
      return '<label class="sty-field" data-key="' + key + '" title="' + esc(spec.doc) + '"><span>' + esc(name) + '</span><span class="ctl">' + ctl + '</span>' + src + '</label>';
    }
    function build() {
      var open = $$('.sty-group[open]', el.groups).map(function (d) { return d.dataset.g; });
      var groups = {};
      Object.keys(SS.spec).forEach(function (k) { var g = k.split('.')[0]; (groups[g] = groups[g] || []).push(k); });
      el.groups.innerHTML = '<datalist id="sty-fonts">' + SS.fonts.map(function (f) { return '<option value="' + esc(f) + '">'; }).join('') + '</datalist>' +
        Object.keys(groups).map(function (g, i) {
          var isOpen = open.length ? open.indexOf(g) >= 0 : i === 0;
          return '<details class="sty-group" data-g="' + g + '"' + (isOpen ? ' open' : '') + '><summary>' + (GROUP_NAMES[g] || g) + '</summary><div class="sty-fields">' + groups[g].map(function (k) { return field(k, SS.spec[k]); }).join('') + '</div></details>';
        }).join('');
      var bases = SS.builtins.concat(SS.library.filter(function (n) { return SS.builtins.indexOf(n) < 0; }));
      el.base.innerHTML = bases.map(function (n) { return '<option value="' + esc(n) + '"' + (n === (draft.extends || 'bold') ? ' selected' : '') + '>' + esc(n) + (SS.builtins.indexOf(n) >= 0 ? ' (built-in)' : ' (your library)') + '</option>'; }).join('');
      el.line.textContent = 'A run here uses: ' + SS.line + '.';
    }
    function value(key, spec, input) {
      var t = input.value.trim();
      if (spec.type === 'bool') return input.getAttribute('aria-checked') === 'true';
      if (spec.type === 'int' || spec.type === 'number') return t === '' ? undefined : Number(t);
      if (spec.type === 'scene') return t === '' ? null : Number(t);
      if (spec.type === 'image' || spec.type === 'text') return t === '' ? null : t;
      return t;
    }
    function changed(key, v) {
      if (v === undefined) unset(draft, key); else set(draft, key, v);
      mark(true); clearTimeout(timer); timer = setTimeout(preview, 250);
    }
    el.groups.addEventListener('input', function (e) {
      var f = e.target.closest('.sty-field'); if (!f) return;
      var key = f.dataset.key, spec = SS.spec[key];
      if (e.target.type === 'color') { var txt = $('#' + e.target.dataset.for); txt.value = e.target.value; changed(key, e.target.value); return; }
      changed(key, value(key, spec, e.target));
    });
    el.groups.addEventListener('change', function (e) { var f = e.target.closest('.sty-field'); if (f && e.target.tagName === 'SELECT') changed(f.dataset.key, e.target.value); });
    el.groups.addEventListener('click', function (e) {
      var r = e.target.closest('[data-reset]'); if (r) { e.preventDefault(); unset(draft, r.dataset.reset); mark(true); preview(true); return; }
      var sw = e.target.closest('.switch'); if (sw) { e.preventDefault(); sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')); changed(sw.closest('.sty-field').dataset.key, sw.getAttribute('aria-checked') === 'true'); }
    });
    el.base.addEventListener('change', function () { if (el.base.value === 'bold') delete draft.extends; else draft.extends = el.base.value; mark(true); preview(true); });
    el.text.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(preview, 300); });
    var plat = $('#sty-platforms');
    plat.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; platform = b.dataset.p; $$('button', plat).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); preview(); });
    wireArrows(plat, function (b) { b.click(); });

    function fit() { $$('.sty-shot', el.phones).forEach(function (w) { var f = $('iframe', w); if (f) f.style.transform = 'scale(' + (w.clientWidth / 1080) + ')'; }); }
    window.addEventListener('resize', fit);
    function preview(rebuild) {
      var n = ++seq;
      return api.post('/api/style/preview', { project: draft, platform: platform, text: el.text.value }).then(function (r) {
        if (n !== seq) return;
        SS = Object.assign(SS || {}, r);
        var m = (r.errors || []).map(function (x) { return ['err', x]; }).concat((r.warnings || []).map(function (x) { return ['', x]; }));
        msgs(m);
        $$('.sty-field', el.groups).forEach(function (f) { f.classList.toggle('bad', (r.errors || []).some(function (x) { return x.indexOf('"' + f.dataset.key + '"') >= 0; })); });
        if (rebuild) build(); else $$('.sty-field', el.groups).forEach(function (f) { var src = $('.sty-src', f), own = get(draft, f.dataset.key) !== undefined; if (src && !own) src.textContent = (SS.sources[f.dataset.key] || '').replace(/^built-in style /, ''); });
        el.line.textContent = 'A run here uses: ' + (r.line || '') + (dirty ? ' (with your unsaved changes).' : '.');
        $('#sty-frame-note').textContent = r.frame ? 'on a real frame of this project' : 'no recording yet: plain background';
        if (!r.ok) return;
        var labels = { caption: 'Caption · ' + ({ short: 'Short', reel: 'Reel', tiktok: 'TikTok' })[platform], endCard: 'End card', cover: 'Cover', intro: 'Intro card' };
        var keys = Object.keys(r.pages);
        if ($$('.sty-phone', el.phones).map(function (x) { return x.dataset.k; }).join() !== keys.join()) {
          el.phones.innerHTML = keys.map(function (k) { return '<figure class="sty-phone" data-k="' + k + '"><div class="sty-shot"><iframe sandbox="allow-same-origin" title="' + esc(labels[k]) + ' preview" tabindex="-1"></iframe></div><b></b></figure>'; }).join('');
        }
        keys.forEach(function (k) { var fig = $('.sty-phone[data-k="' + k + '"]', el.phones); $('b', fig).textContent = labels[k]; $('iframe', fig).srcdoc = r.pages[k]; });
        fit();
      });
    }
    function save() {
      return fetch('/api/style', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ $schema: 'https://raw.githubusercontent.com/IonFlux84/pushreel/main/docs/style.schema.json' }, draft)) }).then(json).then(function (r) {
        if (!r.ok) { msgs((r.errors || []).map(function (x) { return ['err', x]; })); return false; }
        mark(false); SS = Object.assign(SS, r); build(); msgs([['ok', 'Saved to pushreel.style.json.']].concat((r.warnings || []).map(function (x) { return ['', x]; }))); return true;
      });
    }
    $('#sty-save').addEventListener('click', save);
    $('#sty-render').addEventListener('click', function () {
      var b = $('#sty-render'); b.disabled = true;
      save().then(function (ok) {
        if (!ok) { b.disabled = false; return; }
        var recorded = ST.recorded && Object.keys(ST.recorded).some(function (id) { return ST.recorded[id]; });
        if (!recorded) { msgs([['ok', 'Saved. There is no recording in this project yet: run /pushreel, or press Record and export in the Studio.']]); b.disabled = false; return; }
        api.post('/api/run', { mode: 'rerender' }).then(function (r) {
          b.disabled = false;
          if (!r.ok) { msgs([['err', r.error]]); return; }
          msgs([['ok', 'Saved. Re-rendering now (fixed code, 0 tokens). Follow it in the Studio; the result opens when it is done.']]);
          subscribe(function (s2) { if (s2.run && s2.run.status === 'done' && !s2.run.alive) location.href = '/result'; });
        });
      });
    });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    fetch('/api/style').then(json).then(function (r) {
      SS = r; draft = JSON.parse(JSON.stringify(r.project || {})); delete draft.$schema;
      if (r.projectError) msgs([['err', 'pushreel.style.json: ' + r.projectError + '. Saving here replaces it.']]);
      $('#sty-file').textContent = r.project ? 'pushreel.style.json' : 'no pushreel.style.json yet';
      build(); preview();
    });
  }

  /* ================= result ================= */
  function initResult(ST) {
    header(ST);
    var run = ST.run, SL = ST.shotlist, P = ST.platforms;
    if (!run || run.status !== 'done' || !SL) {
      $('#res-body').hidden = true; var e = $('#empty'); e.hidden = false;
      e.innerHTML = run && run.status === 'paused' ? 'The run is paused: ' + esc(run.error.title) + '. <a href="/recovery">Open Recovery</a>.' : isRunning(ST) ? 'A run is working right now. <a href="/">Follow it in the Studio</a>.' : 'There is no finished run yet. <a href="/">Go to the shot list</a> and press Record and export.';
      subscribe(function (st) { if (st.run && st.run.status === 'done') location.reload(); });
      return;
    }
    var vids = ST.files.filter(function (f) { return f.kind === 'video'; });
    var cost = ST.cost && ST.cost.measured ? ST.cost : null;
    $('#crumb-date').textContent = '/ ' + (run.finishedAt || '').slice(0, 10);
    var loc = $('.loc'); if (loc) loc.textContent = location.host + '/result';
    $('#res-h1').innerHTML = '<span class="mk">' + ['No', 'One', 'Two', 'Three'][vids.length] + '</span> ' + (vids.length === 1 ? 'video' : 'videos') + ', ready to upload';
    $('#out-dir').textContent = ST.outDir;
    $('#app-note').textContent = run.appStopped ? 'The dev server Pushreel started is stopped.' : 'Your app was already running and is left running.';
    $('#copy-dir').dataset.copy = ST.project.dir + '/' + run.outDir + '/';

    var cover = ST.files.filter(function (f) { return f.kind === 'cover'; })[0];
    $('#vids').innerHTML = vids.map(function (f) {
      var p = f.target;
      return '<article class="vid" data-o="' + p + '"><div class="phone"><div class="screen" id="screen-' + p + '" data-platform="' + p + '">' +
        '<video class="clip" src="' + esc(f.src) + '"' + (cover ? ' poster="' + esc(cover.src) + '"' : '') + ' muted playsinline loop preload="none" controls aria-label="' + P[p].name + ', ' + esc(f.seconds) + ' seconds"></video>' +
        '<div class="safe" aria-hidden="true"><i class="t"></i><i class="b"></i><i class="r"></i><i class="l"></i><span class="t"></span><span class="b"></span></div></div></div>' +
        '<div class="vid-meta"><h3><span class="disc" data-o="' + p + '"></span>' + P[p].name + ' <span class="tag ok">Ready</span></h3><p class="f">' + esc(f.name) + '</p>' +
        '<p class="m">' + esc(f.seconds) + ' s · ' + ST.frame.width + '×' + ST.frame.height + ' · ' + size(f.bytes) + '</p>' +
        '<p><button type="button" class="btn s" data-copy="' + esc(ST.project.dir + '/' + run.outDir + '/' + f.name) + '" aria-label="Copy path of ' + esc(f.name) + '">Copy path</button></p></div></article>';
    }).join('');
    var screens = vids.map(function (f) { return { p: f.target, sc: $('#screen-' + f.target) }; });
    screens.forEach(function (x) { setSafe(x.sc, ST, x.p, false); }); /* the preview is the cover: the same picture for all three, nothing to load */
    wireSwitch($('#safe'), function (on) { screens.forEach(function (x) { setSafe(x.sc, ST, x.p, on); $('video', x.sc).controls = !on; }); });

    /* cost: USD / EUR */
    var rows = cost ? cost.rows : [];
    $('#cost-rows').innerHTML = cost ? rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td>' + k(r.in) + '</td><td>' + k(r.out) + '</td><td data-usd="' + r.usd + '"></td></tr>'; }).join('')
      : '<tr><td>Record, retry, cut, export</td><td>0</td><td>0</td><td data-usd="0"></td></tr>';
    $('#cost-total').innerHTML = '<tr><td>Total</td><td>' + (cost ? k(cost.total.in) : '0') + '</td><td>' + (cost ? k(cost.total.out) : '0') + '</td><td data-usd="' + (cost ? cost.total.usd : 0) + '" data-pre="≈ "></td></tr>';
    $('#run-line').innerHTML = 'Run took ' + dur(run.elapsed) + (cost ? ' · ' + k(cost.total.in) + ' tokens in · <span data-usd="' + cost.total.usd + '" data-pre="≈ "></span>' : ' · fixed code, 0 tokens');
    var cur = $('#currency'), rate = ST.prices.usdToEur;
    function setCur(c) {
      $$('button', cur).forEach(function (b) { var on = b.dataset.c === c; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      $$('[data-usd]').forEach(function (td) { var usd = +td.dataset.usd, pre = td.dataset.pre || ''; td.textContent = pre + (c === 'eur' ? '€' + (usd * rate).toFixed(2) : '$' + usd.toFixed(2)); });
      var who = cost && cost.models.length ? ' for ' + cost.models.join(', ') : '';
      $('#cost-note').textContent = !cost ? 'This run was started outside Claude Code, so no model was used and nothing was measured. In Claude Code the table shows tokens per step, read from the session transcript.'
        : 'Estimate at API list prices' + who + ' (checked ' + ST.prices.lastChecked + ')' + (c === 'eur' ? ', converted at 1 USD = ' + rate + ' EUR.' : ', in US dollars.') + ' "In" includes cached tokens. Steps are split by markers, so the split is approximate.';
    }
    cur.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setCur(b.dataset.c); });
    wireArrows(cur, function (b) { setCur(b.dataset.c); });
    setCur('usd');

    /* post texts: from shotlist.posts, editable, saved back (captions.md is rewritten by the server) */
    var posts = SL.posts || {}, FIELDS = { 'short-title': ['short', 'title'], 'short-desc': ['short', 'description'], 'reel-text': ['reel', 'caption'], 'tiktok-text': ['tiktok', 'caption'] };
    var written = Object.keys(posts).some(function (p) { return posts[p] && Object.keys(posts[p]).some(function (f) { return posts[p][f]; }); });
    $('#caps-state').textContent = written ? 'captions.md · drafts' : 'captions.md · not written yet';
    if (!written) $('#caps-help').textContent = 'No post texts were written for this run (it ran without the agent). Type your own here; they are saved to captions.md.';
    var tabs = $$('#cap-tabs [role="tab"]');
    tabs.forEach(function (t) { var p = t.id.replace('tab-', ''); t.hidden = SL.targets.indexOf(p) < 0; });
    function pick(tab) {
      tabs.forEach(function (t) { var on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; $('#' + t.getAttribute('aria-controls')).hidden = !on; });
      $('#copy-status').textContent = '';
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { pick(t); }); });
    wireArrows($('#cap-tabs'), pick);
    pick(tabs.filter(function (t) { return !t.hidden; })[0] || tabs[0]);
    var saveT = 0;
    Object.keys(FIELDS).forEach(function (id) {
      var f = $('#' + id), path = FIELDS[id], out = $('#' + id + '-n');
      f.value = (posts[path[0]] && posts[path[0]][path[1]]) || '';
      var upd = function () { out.textContent = f.value.length + ' / ' + f.dataset.max; out.style.color = f.value.length > +f.dataset.max ? 'var(--err)' : ''; };
      f.addEventListener('input', function () {
        upd(); SL.posts = SL.posts || {}; SL.posts[path[0]] = SL.posts[path[0]] || {}; SL.posts[path[0]][path[1]] = f.value;
        clearTimeout(saveT); saveT = setTimeout(function () {
          api.save(rawShotlist(SL)).then(function (r) { var st = $('#copy-status'); st.classList.toggle('bad', !r.ok); st.textContent = r.ok ? 'Saved to captions.md.' : r.errors[0]; });
        }, 600);
      });
      upd();
    });
    $('#copy-cap').addEventListener('click', function () {
      var tab = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0];
      var text = $$('input, textarea', $('#' + tab.getAttribute('aria-controls'))).map(function (f) { return f.value.trim(); }).filter(Boolean).join('\n\n');
      copyText(text).then(function (ok) {
        var st = $('#copy-status'); st.classList.toggle('bad', !ok);
        st.textContent = ok ? 'Copied the ' + tab.textContent.trim() + ' text, ' + text.length + ' characters.' : 'Copy is blocked in this browser. Select the text and copy it by hand.';
      });
    });

    var others = ST.files.filter(function (f) { return f.kind !== 'video'; });
    var about = { cover: 'Cover image', texts: 'One post text per platform, ready to paste', shotlist: 'Address, clicks and waits per scene. Recording replays exactly this.', log: 'What happened, step by step' };
    $('#files-n').textContent = others.length + ' files';
    $('#flist').innerHTML = others.map(function (f) {
      var meta = f.kind === 'shotlist' ? SL.scenes.length + ' scenes' : f.kind === 'log' ? (run.stats.retries || 0) + (run.stats.retries === 1 ? ' retry' : ' retries') : f.kind === 'cover' ? '1080×1920' : f.note || size(f.bytes);
      return '<li><b>' + esc(f.name) + '</b><span>' + esc(meta) + '</span><p>' + about[f.kind] + (f.kind === 'cover' && f.note ? ', ' + esc(f.note.replace(/^1080×1920, /, '')) : '') + '</p></li>';
    }).join('');
    wireCopy(document);
  }

  /* ================= recovery ================= */
  function initRecovery(ST) {
    header(ST);
    var run = ST.run;
    if (!run || run.status !== 'paused' || !run.error) {
      $('#rec-body').hidden = true; var e = $('#empty'); e.hidden = false;
      e.innerHTML = run && run.status === 'done' ? 'Nothing to recover: the last run finished. <a href="/result">View the result</a>.' : run && run.status === 'cancelled' ? 'The last run was cancelled. Recorded scenes and the shot list are kept. <a href="/">Back to the shot list</a>.' : 'No run is paused. <a href="/">Go to the shot list</a>.';
      return;
    }
    var err = run.error, SL = ST.shotlist, failed = run.scenes.filter(function (s) { return s.status === 'failed'; })[0];
    var rec = run.scenes.filter(function (s) { return s.status === 'recorded'; }), inRun = run.scenes.filter(function (s) { return s.status !== 'off' && s.status !== 'skipped'; });
    var waiting = run.scenes.filter(function (s) { return s.status === 'waiting'; });
    var at = new Date(err.at).toLocaleTimeString(), isLogin = err.code === 'login_wall' || err.code === 'login_failed';
    $('#al-slate').innerHTML = '<b>Run paused' + (failed ? ' at scene ' + esc(failed.id) : '') + '</b> · ' + new Date(err.at).toLocaleTimeString() + ' · ' + rec.length + ' of ' + inRun.length + ' recorded';
    $('#al-title').textContent = err.title;
    $('#al-text').textContent = err.text + ' ' + (rec.length ? 'Scene' + (rec.length > 1 ? 's ' : ' ') + list(rec.map(function (s) { return s.id; })) + (rec.length > 1 ? ' are' : ' is') + ' recorded and saved. Nothing is lost.' : 'Nothing is lost.');
    var appUp = ST.app.running;
    $('#app-line .dot').className = 'dot ' + (appUp ? 'ok' : 'off');
    $('#app-text').textContent = appUp ? 'Your app is still running at ' + short(ST.app.url) + '. ' + (ST.app.startedByPushreel ? 'Pushreel started it and stops it after you resume or cancel.' : 'Pushreel did not start it and leaves it running.') : 'Your app is not running right now. Resume starts it again.';
    $('#sl-n').textContent = rec.length + ' of ' + inRun.length + ' recorded';
    var tag = { recorded: '<span class="tag ok">Recorded</span>', waiting: '<span class="tag">Waiting</span>', skipped: '<span class="tag warn">Skipped</span>', off: '<span class="tag">Off</span>' };
    $('#sc-list').innerHTML = run.scenes.map(function (s) {
      var f = s.status === 'failed';
      return '<li' + (f ? ' class="fail"' : '') + '><span class="n">' + esc(String(s.id).padStart(2, '0')) + '</span><span><b>' + esc(s.title) + '</b><small>' + esc(s.url) + (f && err.sawUrl && err.sawUrl !== s.url ? ' to ' + esc(err.sawUrl.split('?')[0]) : ' · ' + esc(s.duration) + ' s') + '</small></span>' +
        (f ? '<span class="tag err">Failed: ' + esc(err.code.replace(/_/g, ' ')) + '</span>' : tag[s.status] || '') + '</li>';
    }).join('') + (SL && SL.cut.endCard ? '<li><span class="n">' + String(run.scenes.length + 1).padStart(2, '0') + '</span><span><b>End card</b><small>' + ST.endCardSeconds + ' s · added in the cut</small></span><span class="tag">Waiting</span></li>' : '');
    $('#tok-used').textContent = costLine(ST); $('#tok-model').textContent = modelName(ST) || 'fixed code';
    $('#tok-resume').textContent = 'Resume, ' + (failed ? 'scene' + (waiting.length ? 's ' : ' ') + list([failed.id].concat(waiting.map(function (s) { return s.id; }))) : 'remaining scenes');
    if (err.screenshot && failed) {
      $('#fail-screen').insertAdjacentHTML('afterbegin', '<img alt="" src="/media/failed/scene-' + encodeURIComponent(failed.id) + '.png?v=' + encodeURIComponent(err.at) + '">');
      $('#fail-cap').innerHTML = 'What the browser saw at ' + esc(at) + ' · ' + esc((err.sawUrl || '').split('?')[0]) + '<br>' + esc(err.screenshot);
    } else { $('.shot-frame').hidden = true; }
    $('#term-dir').textContent = ST.project.dir.replace(/^\/Users\/[^/]+/, '~');
    var skipIds = failed ? [failed.id].concat(waiting.filter(function (s) { var sc = SL.scenes.filter(function (x) { return x.id === s.id; })[0]; return isLogin && sc && sc.requiresLogin; }).map(function (s) { return s.id; })) : [];
    var skipCmd = 'pushreel resume --skip ' + skipIds.join(',');
    $('#term-body').innerHTML = '<div>' + run.scenes.filter(function (s) { return s.status === 'recorded' || s.status === 'failed'; }).map(function (s) {
      return s.status === 'failed' ? '<div class="bad">✗ Scene ' + esc(s.id) + '  ' + esc(s.url) + '   stopped: ' + esc(err.code.replace(/_/g, ' ')) + '</div>' : '<div><span class="ok">✓</span> Scene ' + esc(s.id) + '  ' + esc(s.url) + '   ' + (s.rawSeconds ? s.rawSeconds.toFixed(1) + ' s' : '') + '</div>';
    }).join('') + '</div><div><div class="dim">To continue:</div>' + (isLogin ? '<div class="w">/pushreel login</div><div class="dim">(or, for a password form: export PUSHREEL_LOGIN="email:password")</div>' : '') + '<div class="w">/pushreel resume</div></div>' +
      (skipIds.length ? '<div><div class="dim">Or export without ' + (skipIds.length > 1 ? 'those scenes' : 'that scene') + ':</div><div class="w">/pushreel resume --skip ' + skipIds.join(',') + '</div></div>' : '') +
      '<div><div class="dim">Or end this run' + (ST.app.startedByPushreel ? ' and stop the dev server' : '') + ':</div><div class="w">/pushreel cancel</div></div>';
    $('#saved').innerHTML = rec.map(function (s) { return '<li><b>raw/scene-' + esc(s.id) + '.mp4</b><span>' + (s.rawSeconds ? s.rawSeconds.toFixed(1) + ' s' : 'recorded') + '</span></li>'; }).join('') +
      (err.screenshot && failed ? '<li><b>failed/scene-' + esc(failed.id) + '.png</b><span>screenshot</span></li>' : '') + '<li><b>../shotlist.json</b><span>' + (SL ? SL.scenes.length : 0) + ' scenes</span></li><li><b>run.log</b><span>1 stop</span></li>';

    /* fix cards: A resume, B skip, C the 2FA limit (login failures only) */
    var btn = $('#resume'), st = $('#resume-status'), sk = $('#skip'), ss = $('#skip-status');
    btn.textContent = failed ? 'Resume from scene ' + failed.id : 'Resume';
    if (!isLogin) {
      $('#fix-a').textContent = err.code === 'stopped' ? 'Continue the run' : 'Fix it and resume';
      $('#card-a ol').innerHTML = (err.next || []).filter(function (n) { return !/--skip|cancel/.test(n); }).map(function (n) { return '<li><span>' + esc(n.replace(/, then: pushreel resume.*$/, '.')) + '</span></li>'; }).join('') + '<li><span>Press Resume, or run <code>/pushreel resume</code> in the chat.</span></li>';
      $('#card-a .small').textContent = 'Recorded scenes are not recorded again. Resume is fixed code: 0 tokens.';
      $('#card-c').hidden = err.code !== 'verification';
      $('#fix-n').textContent = 'your options';
    }
    $('#card-b').hidden = !skipIds.length || rec.length + waiting.length - (skipIds.length - 1) < 1;
    var keep = inRun.filter(function (s) { return skipIds.indexOf(s.id) < 0; }), keepLen = keep.reduce(function (a, s) { return a + s.duration; }, 0) + (SL && SL.cut.endCard ? ST.endCardSeconds : 0);
    $('#skip-text').textContent = 'Skip scene' + (skipIds.length > 1 ? 's ' : ' ') + list(skipIds) + ' and export a ' + keepLen + ' s video from scene' + (keep.length > 1 ? 's ' : ' ') + list(keep.map(function (s) { return s.id; })) + (SL && SL.cut.endCard ? ' plus the end card' : '') + '. You can add the other scenes later.';
    $('#skip-cmd').textContent = '/' + skipCmd; $('#skip-copy').dataset.copy = '/' + skipCmd;
    sk.textContent = 'Skip ' + list(skipIds) + ', then export';
    wireCopy(document);

    var busy = false;
    var follow = function (el2, what) {
      busy = true; el2.hidden = false; el2.className = 'status'; el2.innerHTML = '<span class="dot live"></span><span>' + what + '</span>';
      [btn, sk, $('#cancel')].forEach(function (b) { b.disabled = true; });
      subscribe(function (s2) {
        if (isRunning(s2)) { var now = (s2.run.steps || []).filter(function (x) { return x.status === 'running'; })[0]; el2.innerHTML = '<span class="dot live"></span><span>' + esc(now ? now.label + (now.note ? ': ' + now.note : '') : 'Working') + '</span>'; return; }
        if (s2.run && s2.run.status === 'done') { location.href = '/result'; return; }
        if (s2.run && s2.run.status === 'paused' && s2.run.error && s2.run.error.at !== err.at) location.reload();
      });
    };
    btn.addEventListener('click', function () {
      if (busy) return;
      st.hidden = false; st.className = 'status'; st.innerHTML = '<span class="dot live"></span><span>' + (isLogin ? 'Looking for a saved session (.pushreel/auth.json) or PUSHREEL_LOGIN' : 'Starting') + '</span>';
      api.state().then(function (s2) {
        if (isLogin && !s2.loginSet) {
          st.className = 'status err';
          st.innerHTML = '<span>There is no saved session and PUSHREEL_LOGIN is not set. Run /pushreel login (or add PUSHREEL_LOGIN to .env.local), then press Resume again. ' + (rec.length ? 'Scene' + (rec.length > 1 ? 's ' : ' ') + list(rec.map(function (s) { return s.id; })) + ' stay saved' : 'Nothing is lost') + (appUp ? ' and your app keeps running.' : '.') + '</span>';
          return;
        }
        api.post('/api/run', { mode: 'resume' }).then(function (r) { if (r.ok) follow(st, isLogin ? 'Found the test account. Resuming.' : 'Resuming.'); else { st.className = 'status err'; st.innerHTML = '<span>' + esc(r.error) + '</span>'; } });
      });
    });
    sk.addEventListener('click', function () {
      if (busy) return;
      api.post('/api/run', { mode: 'resume', skip: skipIds }).then(function (r) { if (r.ok) follow(ss, 'Skipping ' + list(skipIds) + '. No new tokens.'); else { ss.hidden = false; ss.className = 'status err'; ss.innerHTML = '<span>' + esc(r.error) + '</span>'; } });
    });

    /* Cancel run: secondary action with a confirm step. */
    var cn = $('#cancel'), cf = $('#cancel-confirm'), cs = $('#cancel-status');
    $('#cancel-q').textContent = ST.app.startedByPushreel && appUp ? 'Cancel the run and stop the app at ' + short(ST.app.url) + '?' : 'Cancel the run? Your app was not started by Pushreel and keeps running.';
    cn.addEventListener('click', function () { cf.hidden = false; cn.hidden = true; $('#cancel-no').focus(); });
    $('#cancel-no').addEventListener('click', function () { cf.hidden = true; cn.hidden = false; cn.focus(); });
    $('#cancel-yes').addEventListener('click', function () {
      $('#cancel-yes').disabled = true;
      api.post('/api/cancel').then(function (r) {
        cf.hidden = true; cs.hidden = false; cs.tabIndex = -1;
        if (!r.ok) { cs.className = 'status err'; cs.innerHTML = '<span>' + esc(r.error || 'Cancel failed.') + '</span>'; return; }
        cs.className = 'status ok';
        var kept = r.kept.length ? 'The ' + (r.kept.length === 1 ? 'recorded scene ' + r.kept[0] : r.kept.length + ' recorded scenes') + ' and shotlist.json are kept in .pushreel/.' : 'shotlist.json is kept in .pushreel/.';
        cs.innerHTML = '<span>Run cancelled. ' + (r.stopped.stopped ? 'Pushreel stopped the app it started, ' + short(r.stopped.url) + ' is free again. ' : 'Pushreel had not started your app, so it keeps running. ') + kept + ' Start again any time with /pushreel rerender.</span>';
        $('#app-line').innerHTML = '<span class="dot off"></span><span>Run cancelled. ' + (r.stopped.stopped ? 'The app Pushreel started is stopped. ' : '') + kept + '</span>';
        [btn, sk].forEach(function (b) { b.disabled = true; });
        st.hidden = true; ss.hidden = true; cs.focus();
      });
    });
  }

  function boot() {
    var page = document.body.dataset.page;
    $$('[data-glyph]').forEach(function (g) { g.innerHTML = GLYPH[g.dataset.glyph]; g.setAttribute('aria-hidden', 'true'); });
    api.state().then(function (st) {
      ({ studio: initStudio, style: initStyle, result: initResult, recovery: initRecovery }[page] || function () {})(st);
      $$('[data-glyph]').forEach(function (g) { if (!g.innerHTML) { g.innerHTML = GLYPH[g.dataset.glyph]; g.setAttribute('aria-hidden', 'true'); } });
    }).catch(function (e) {
      var m = $('main'); if (m) m.insertAdjacentHTML('afterbegin', '<p class="notice err" style="margin:16px">The Studio lost its connection to the local server. Start it again with: pushreel studio. (' + esc(e.message) + ')</p>');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  void RM;
})();
