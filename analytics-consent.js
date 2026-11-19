/* DigDevBox shared GA4 consent gate.
 * Loads GA4 only after explicit analytics opt-in. Sends page views only;
 * never reads form values, tool inputs, file names, query strings, or DOM text.
 * Consent is scoped to this site origin. Rejecting analytics prevents GA requests.
 */
(function () {
  'use strict';
  var MEASUREMENT_ID = 'G-5D1F8G3H6J';
  var CONSENT_KEY = 'imageforge.ga4-consent.v1';
  var loaded = false;
  var lastPage = '';

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (_) { return null; }
  }
  function pagePath() { return location.origin + location.pathname; }
  function isNoindexPage() {
    var meta = document.querySelector('meta[name="robots"]');
    return !!meta && /\bnoindex\b/i.test(meta.getAttribute('content') || '');
  }

  function pageView() {
    if (!loaded || !window.gtag || readConsent() !== 'accepted' || isNoindexPage()) return;
    var path = pagePath();
    if (path === lastPage) return;
    lastPage = path;
    window.gtag('event', 'page_view', {
      page_location: path,
      page_title: document.title,
      page_referrer: document.referrer ? (new URL(document.referrer)).origin : ''
    });
  }
  function clearAnalyticsCookies() {
    document.cookie.split(';').forEach(function (part) {
      var name = part.split('=')[0].trim();
      if (!/^_ga(?:_|$)/.test(name)) return;
      document.cookie = name + '=; Max-Age=0; path=/; SameSite=Lax; Secure';
      var labels = location.hostname.split('.');
      if (labels.length > 2) {
        document.cookie = name + '=; Max-Age=0; path=/; domain=.' + labels.slice(-2).join('.') + '; SameSite=Lax; Secure';
      }
    });
  }
  function loadAnalytics() {
    if (loaded) {
      if (window.gtag) {
        window.gtag('consent', 'update', { analytics_storage: 'granted' });
        pageView();
      }
      return;
    }
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'denied', ad_storage: 'denied',
      ad_user_data: 'denied', ad_personalization: 'denied',
      functionality_storage: 'granted', security_storage: 'granted'
    });
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    script.onload = function () {
      window.gtag('js', new Date());
      window.gtag('config', MEASUREMENT_ID, {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        linker: { domains: ['digdevbox.com'] }
      });
      pageView();
    };
    document.head.appendChild(script);
  }
  function saveConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (_) {}
    if (value === 'accepted') loadAnalytics();
    else {
      if (window.gtag) window.gtag('consent', 'update', { analytics_storage: 'denied' });
      clearAnalyticsCookies();
    }
    render();
  }
  function render() {
    var old = document.getElementById('digdevbox-analytics-consent');
    if (old) old.remove();
    var current = readConsent();
    var root = document.createElement('section');
    root.id = 'digdevbox-analytics-consent';
    root.setAttribute('aria-label', 'Analytics privacy choices');
    if (current === 'accepted' || current === 'rejected') {
      var manage = document.createElement('button');
      manage.type = 'button';
      manage.textContent = 'Privacy choices';
      manage.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147482999;border:1px solid #4b7773;border-radius:999px;padding:8px 12px;background:#102a2a;color:#fff;font:12px system-ui,sans-serif;cursor:pointer';
      manage.addEventListener('click', function () { renderPrompt(); });
      root.appendChild(manage);
      document.body.appendChild(root);
      return;
    }
    renderPrompt(root);
  }
  function renderPrompt(existing) {
    var root = existing || document.getElementById('digdevbox-analytics-consent');
    if (!root) {
      root = document.createElement('section');
      root.id = 'digdevbox-analytics-consent';
      root.setAttribute('aria-label', 'Analytics privacy choices');
    }
    root.style.cssText = 'position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;max-width:720px;margin:0 auto;padding:16px 18px;background:#102a2a;color:#fff;border:1px solid #4b7773;border-radius:12px;box-shadow:0 8px 32px #0004;font:14px/1.5 system-ui,sans-serif';
    if (!root.isConnected) document.body.appendChild(root);
    root.replaceChildren();
    var message = document.createElement('p');
    message.textContent = 'Optional Google Analytics measures page views only after you agree. We never send image files, filenames, canvas pixels, layers, or URL query parameters. Rejecting Google Analytics does not affect editing.';
    message.style.cssText = 'margin:0 0 12px';
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    [['Accept Google Analytics','accepted'],['Reject Google Analytics','rejected']].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = item[0];
      button.style.cssText = 'border:1px solid #9bc5bf;border-radius:7px;padding:8px 12px;background:transparent;color:#fff;font:inherit;cursor:pointer';
      button.addEventListener('click', function () { saveConsent(item[1]); });
      actions.appendChild(button);
    });
    root.appendChild(message);
    root.appendChild(actions);
    if (!root.isConnected) document.body.appendChild(root);
  }
  function trackRoute() { window.setTimeout(pageView, 0); }
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    history[method] = function () { var result = original.apply(this, arguments); trackRoute(); return result; };
  });
  window.addEventListener('popstate', trackRoute);
  window.addEventListener('hashchange', trackRoute);
  function init() {
    if (readConsent() === 'accepted') loadAnalytics();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
