const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const id = 'G-5D1F8G3H6J';
const htmlFiles = [
  'index.html',
  'about.html',
  'contact.html',
  'faq.html',
  'guides.html',
  'privacy.html',
  'terms.html',
];
const failures = [];

function checkHtml(base, label) {
  for (const file of htmlFiles) {
    const full = path.join(base, file);
    if (!fs.existsSync(full)) {
      failures.push(label + '/' + file + ': missing');
      continue;
    }
    const html = fs.readFileSync(full, 'utf8');
    if (!html.includes('/analytics-consent.js')) failures.push(label + '/' + file + ': missing consent loader');
    if (html.includes('googletagmanager.com/gtag/js')) failures.push(label + '/' + file + ': direct GA4 load bypasses consent');
  }
}

checkHtml(root, 'source');
const template = fs.readFileSync(path.join(root, 'src/template/index.html'), 'utf8');
if (!template.includes('/analytics-consent.js')) failures.push('src/template/index.html: missing consent loader');

const scriptPath = path.join(root, 'analytics-consent.js');
if (!fs.existsSync(scriptPath)) failures.push('analytics-consent.js: missing source asset');
else {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const checks = [
    ['correct ImageForge Measurement ID', /G-5D1F8G3H6J/],
    ['site-scoped consent key', /imageforge\.ga4-consent\.v1/],
    ['analytics denied by default', /analytics_storage:\s*'denied'/],
    ['explicit accept/reject choices', /Accept Google Analytics[\\s\\S]*Reject Google Analytics/],
    ['query string excluded', /location\.origin \+ location\.pathname/],
    ['noindex page view blocked', /isNoindexPage\(\)/],
    ['automatic page_view disabled', /send_page_view:\s*false/],
    ['cross-subdomain linker configured', /linker:\s*\{ domains: \['digdevbox\.com'\] \}/],
    ['SPA duplicate suppression', /path === lastPage/],
  ];
  for (const [name, pattern] of checks) if (!pattern.test(script)) failures.push('analytics-consent.js: ' + name);
}

const headers = fs.readFileSync(path.join(root, 'deploy/cloudflare/_headers'), 'utf8');
if (!/script-src[^\n]*www\.googletagmanager\.com/.test(headers)) failures.push('Cloudflare CSP: googletagmanager.com missing from script-src');
if (!/connect-src[^\n]*https:/.test(headers)) failures.push('Cloudflare CSP: HTTPS analytics endpoint missing from connect-src');

const privacy = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');
for (const term of ['Google Analytics 4 (optional)', 'Accept Google Analytics', 'no GA4 request is sent', 'image files', 'canvas pixels', 'cross-subdomain']) {
  if (!privacy.toLowerCase().includes(term.toLowerCase())) failures.push('privacy.html: missing disclosure ' + term);
}

const packagedScript = path.join(root, 'build', 'analytics-consent.js');
if (fs.existsSync(path.join(root, 'build')) && !fs.existsSync(packagedScript)) failures.push('build/analytics-consent.js: not included in Cloudflare package');
if (fs.existsSync(path.join(root, 'build'))) checkHtml(path.join(root, 'build'), 'build');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[GA4 consent] PASS: public pages, package allowlist, correct stream ID, opt-in, safe URL and privacy disclosure');
