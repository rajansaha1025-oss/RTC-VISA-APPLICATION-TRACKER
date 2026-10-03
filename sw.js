/* RTC VISA — Service Worker
 * - HTML: আগে নেটওয়ার্ক (সবসময় লেটেস্ট ভার্শন), নেট না থাকলে সেভ করা কপি
 * - আইকন/লোগো ও CDN লাইব্রেরি: ক্যাশ থেকে দ্রুত লোড
 * - Firebase / Google Drive / Apps Script এর ডাটা রিকোয়েস্ট কখনোই ক্যাশ হয় না
 * নতুন ভার্শন দিলে শুধু নিচের VERSION বদলালেই পুরনো ক্যাশ মুছে যাবে।
 */
const VERSION = 'rtc-visa-v2';
const SHELL = ['./', './index.html', './manifest.json', './logo.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];
const NEVER_CACHE = ['firebaseio.com', 'googleapis.com', 'script.google.com', 'script.googleusercontent.com', 'drive.google.com', 'identitytoolkit', 'securetoken'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ডাটা/এপিআই কল সরাসরি নেটওয়ার্কে যাবে
  if (NEVER_CACHE.some((h) => url.hostname.includes(h) && !url.hostname.includes('fonts.'))) return;

  // পেজ নিজে (HTML): network-first
  if (req.mode === 'navigate' || (url.origin === location.origin && (url.pathname.endsWith('/') || url.pathname.endsWith('.html')))) {
    e.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // নিজের স্ট্যাটিক ফাইল (আইকন, লোগো, manifest): cache-first, পেছনে আপডেট
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // CDN লাইব্রেরি/ফন্ট: stale-while-revalidate
  if (CDN_HOSTS.some((h) => url.hostname === h)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
