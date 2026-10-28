/*
 * Dermaa site analytics — first-party, cookieless, no third parties.
 *
 * Sends page views, time on page, scroll depth, clicks, FAQ opens and which
 * sections were seen to Dermaa's own server (the `site-track` function), and
 * handles the "Notify me at launch" form. What is collected is described at
 * dermaa.app/privacy.html#website — change one, change the other.
 *
 * Browsers that send Do Not Track or Global Privacy Control get no stored id
 * at all: their visits are counted, but nothing is kept on their device.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://ilaxstywqahhbvcjbrzv.supabase.co/functions/v1/site-track';
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  // Browsers driven by automation tools (Selenium, Puppeteer, Playwright —
  // most scanners and crawlers) say so here. They are not visitors.
  if (navigator.webdriver === true) return;

  var optOut =
    navigator.doNotTrack === '1' ||
    window.doNotTrack === '1' ||
    navigator.globalPrivacyControl === true;

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  function storage() {
    if (optOut) return null;
    try {
      localStorage.setItem('__dt', '1');
      localStorage.removeItem('__dt');
      return localStorage;
    } catch (e) {
      return null; // private mode, blocked storage
    }
  }

  function readJson(store, key) {
    try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; }
  }

  var store = storage();
  var now = Date.now();

  // Visitor: a random id, created once.
  var visitorId = null;
  var isNewVisitor = false;
  if (store) {
    visitorId = store.getItem('dermaa_vid');
    if (!visitorId) {
      visitorId = newId();
      store.setItem('dermaa_vid', visitorId);
      isNewVisitor = true;
    }
  }

  // Session: ends after 30 minutes without activity.
  var session = store ? readJson(store, 'dermaa_sess') : null;
  var newSession = !session || now - session.last > SESSION_IDLE_MS;
  if (newSession) session = { id: newId(), last: now, isNew: isNewVisitor };
  session.last = now;
  function touchSession() {
    if (!store) return;
    session.last = Date.now();
    try { store.setItem('dermaa_sess', JSON.stringify(session)); } catch (e) {}
  }
  touchSession();

  var path = location.pathname === '/index.html' ? '/' : location.pathname;
  var params = new URLSearchParams(location.search);
  var utm = {
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
    term: params.get('utm_term'),
    content: params.get('utm_content'),
  };
  var referrer = '';
  try {
    if (document.referrer && new URL(document.referrer).host !== location.host) {
      referrer = document.referrer;
    }
  } catch (e) {}

  // First touch: how this visitor first arrived, credited to any later sign-up.
  var firstTouch = store ? readJson(store, 'dermaa_ft') : null;
  if (store && !firstTouch) {
    firstTouch = { path: path, ref: referrer, utm: utm };
    try { store.setItem('dermaa_ft', JSON.stringify(firstTouch)); } catch (e) {}
  }

  var ctx = {
    path: path,
    ref: referrer,
    utm: utm,
    sw: window.screen ? screen.width : null,
    lang: navigator.language || null,
    tz: (function () {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; }
    })(),
  };

  function payload(events) {
    return JSON.stringify({
      v: visitorId,
      s: session.id,
      n: session.isNew === true,
      ctx: ctx,
      events: events,
    });
  }

  // text/plain keeps this a CORS "simple" request: no preflight round trip.
  function send(events, useBeacon) {
    var body = payload(events);
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
        return;
      }
      fetch(ENDPOINT, {
        method: 'POST',
        body: body,
        keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Page view ──
  send([{ e: 'pageview', p: path }]);

  // ── Time on page + scroll depth, sent when the page is hidden ──
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  var engagedMs = 0;
  var maxScroll = 0;

  function measureScroll() {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    var pct = scrollable <= 0 ? 100 : Math.round((window.scrollY / scrollable) * 100);
    if (pct > maxScroll) maxScroll = Math.min(100, pct);
  }
  var scrollQueued = false;
  window.addEventListener('scroll', function () {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () { scrollQueued = false; measureScroll(); });
  }, { passive: true });
  measureScroll();

  function flushEngagement() {
    if (visibleSince !== null) {
      engagedMs += Date.now() - visibleSince;
      visibleSince = null;
    }
    var seconds = Math.round(engagedMs / 1000);
    if (seconds > 0) {
      send([{ e: 'engagement', p: path, val: seconds, sp: maxScroll }], true);
      engagedMs = 0;
    }
    touchSession();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushEngagement();
    else visibleSince = Date.now();
  });
  window.addEventListener('pagehide', flushEngagement);

  // ── Clicks: anything marked data-track, plus outbound and in-page links ──
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-track], a[href], button') : null;
    if (!el) return;
    var label = el.getAttribute('data-track');
    if (!label && el.tagName === 'A') {
      try {
        var url = new URL(el.href, location.href);
        if (url.host !== location.host) label = 'outbound:' + url.hostname.replace(/^www\./, '');
        else if (url.hash && url.pathname === location.pathname) label = 'link:' + url.hash;
        else label = 'link:' + url.pathname;
      } catch (e) {}
    }
    if (!label) return;
    touchSession();
    send([{ e: 'click', p: path, l: label.slice(0, 120) }]);
  }, true);

  // ── FAQ: which questions get opened ('toggle' does not bubble) ──
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    var s = d.querySelector('summary');
    if (s) send([{ e: 'faq_open', p: path, l: s.textContent.trim().slice(0, 120) }]);
  }, true);

  // ── Which sections were actually seen ──
  if ('IntersectionObserver' in window) {
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var id = entry.target.id;
        if (!entry.isIntersecting || seen[id]) return;
        seen[id] = true;
        send([{ e: 'section_view', p: path, l: id }]);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.35 });
    document.querySelectorAll('section[id]').forEach(function (s) { io.observe(s); });
  }

  // ── "Notify me at launch" ──
  document.querySelectorAll('form[data-lead-form]').forEach(function (form) {
    var status = form.querySelector('[data-lead-status]');
    var button = form.querySelector('button[type="submit"]');
    function say(msg, ok) {
      if (!status) return;
      status.textContent = msg;
      status.className = 'lead-status ' + (ok ? 'ok' : 'err');
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = (form.elements.email && form.elements.email.value || '').trim();
      var hp = form.elements.company ? form.elements.company.value : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        say('Please enter a valid email address.', false);
        return;
      }
      if (button) button.disabled = true;
      say('Saving…', true);
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          v: visitorId,
          s: session.id,
          ctx: ctx,
          ft: firstTouch,
          lead: { email: email, hp: hp },
        }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) throw new Error(data.error || 'Could not save. Please try again.');
          });
        })
        .then(function () {
          form.reset();
          say("You're on the list — we'll email you once, the day Dermaa launches.", true);
        })
        .catch(function (err) {
          say(err.message || 'Could not save. Please try again.', false);
        })
        .then(function () {
          if (button) button.disabled = false;
        });
    });
  });
})();
