/**
 * RTC VISA — Google Drive আপলোড সার্ভার (Google Apps Script)
 * ------------------------------------------------------------
 * কাজ: অ্যাপ থেকে আসা PDF Drive এ রাখা, ওপেন করার জন্য ফেরত দেওয়া, রিনেম ও ডিলিট করা।
 * সুরক্ষা: প্রতিটি রিকোয়েস্টে Firebase লগইন টোকেন চেক হয়; শুধু Firebase এর রেজিস্টার্ড ইউজার কাজ করতে পারে।
 */

// ====== ১) সেটিংস (এখানে ইমেইল লোয়ারকেসে লিখুন) ======
const FIREBASE_API_KEY = 'AIzaSyCHSXIS5eCX-pQ9N-L2u5W1jSS7VoTRP1w';
const ROOT_FOLDER_NAME = 'RTC VISA Files';
// নতুন ইউজার Firebase এ যোগ করলেই কাজ করবে (ইমেইল লিস্ট লাগে না)। Firebase এ sign-up বন্ধ রাখতে ভুলবেন না!
const ADMINS = ['rajan@gmail.com', 'mitul@gmail.com'];   // শুধু এরা চিরতরে ডিলিট করতে পারবে

// ====== ২) একবার চালিয়ে পারমিশন দিন (Run > authorize_) ======
function authorize_() {
  DriveApp.getRootFolder();
  UrlFetchApp.fetch('https://www.google.com');
  ScriptApp.getProjectTriggers();
  PropertiesService.getScriptProperties();
  Logger.log('Authorized OK');
}

// ====== ৩) মূল ফাংশন ======
const VERSION = 'v9-backup';
// ব্রাউজারে Web App URL খুললে এটা দেখাবে: নতুন ভার্শন ডিপ্লয় হয়েছে কিনা বোঝার জন্য
function doGet() { return out_({ ok: true, version: VERSION, msg: 'RTC VISA Drive script চালু আছে' }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const email = verifyUser_(req.idToken);
    const isAdmin = ADMINS.indexOf(email) >= 0;
    switch (req.action) {
      case 'upload': return out_(upload_(req));
      case 'get': return out_(get_(req));
      case 'rename': return out_(rename_(req));
      case 'syncSet': return out_(syncSet_(req));                            // ফোল্ডার ও ফাইলের নাম আপডেট
      case 'moveFile': return out_(moveFile_(req));
      case 'setStatus': return out_(setStatus_(req));                        // একটা ফোল্ডার Running/Delivered/Returned এ সরানো
      case 'organize': return out_(organize_(req));                          // অনেকগুলো ফোল্ডার একসাথে সাজানো
      case 'deleteFiles': return out_(deleteFiles_(req));                    // শুধু ট্র্যাশে (ফেরত আনা যায়)
      case 'deleteSet': if (!isAdmin) return out_({ ok: false, error: 'ADMIN_ONLY' }); return out_(deleteSet_(req));
      // ---- ব্যাকআপ ----
      case 'backupStatus': return out_(backupStatus_());                                              // সর্বশেষ ব্যাকআপ কখন (সবাই)
      case 'backupSave': return out_(backupSave_(req, email));                                        // অ্যাপ থেকে ব্যাকআপ (সবাই)
      case 'backupList': if (!isAdmin) return out_({ ok: false, error: 'ADMIN_ONLY' }); return out_(backupList_());
      case 'backupGet': if (!isAdmin) return out_({ ok: false, error: 'ADMIN_ONLY' }); return out_(backupGet_(req));
      default: return out_({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    return out_({ ok: false, error: msg || 'UNKNOWN_SERVER_ERROR' });
  }
}

function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function verifyUser_(idToken) {
  if (!idToken) throw new Error('NO_TOKEN');
  // একই টোকেন ৫ মিনিট মনে রাখে, প্রতিবার Firebase কে জিজ্ঞেস করতে হয় না (দ্রুত হয়)
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  const hit = cache.get(key); if (hit) return hit;
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('BAD_TOKEN');
  const users = JSON.parse(r.getContentText()).users;
  if (!users || !users.length) throw new Error('BAD_TOKEN');
  const email = String(users[0].email || '').toLowerCase();
  cache.put(key, email, 300);
  return email;
}

function getRoot_() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return DriveApp.createFolder(ROOT_FOLDER_NAME);
}
// item (ফাইল/ফোল্ডার) root এর নিচে যেকোনো গভীরতায় আছে কিনা (Running/Delivered/Returned সাব-ফোল্ডারসহ)
function inTree_(item, root) {
  let level = [item];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next = [];
    for (let i = 0; i < level.length; i++) {
      const ps = level[i].getParents();
      while (ps.hasNext()) { const p = ps.next(); if (p.getId() === root.getId()) return true; next.push(p); }
    }
    level = next;
  }
  return false;
}
function folderOk_(id, root) {
  try { const f = DriveApp.getFolderById(id); if (!f.isTrashed() && inTree_(f, root)) return f; } catch (e) { }
  return null;
}
function fileOk_(id, root) {
  try { const f = DriveApp.getFileById(id); if (!f.isTrashed() && inTree_(f, root)) return f; } catch (e) { }
  return null;
}

// স্ট্যাটাস অনুযায়ী ফোল্ডার: Running (চলমান), Expired (মেয়াদ শেষ/নতুন BGD লাগবে), Delivered (ডেলিভারি), Returned (ফেরত)
const STATUS_FOLDERS = { Running: 'Running', Expired: 'Expired', Delivered: 'Delivered', Returned: 'Returned' };
function statusFolder_(root, status) {
  const name = STATUS_FOLDERS[status] || 'Running';
  const it = root.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return root.createFolder(name);
}
function inFolder_(item, folder) {
  const ps = item.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) return true; }
  return false;
}

// ====== ৪) অ্যাকশনগুলো ======
function upload_(r) {
  let step = 'start';
  try {
    step = 'root'; const root = getRoot_();
    step = 'folder'; let folder = r.folderId ? folderOk_(r.folderId, root) : null;
    if (!folder) folder = statusFolder_(root, r.status).createFolder(r.folderName || 'Unnamed');
    step = 'decode'; if (!r.data) throw new Error('PDF data খালি এসেছে');
    const bytes = Utilities.base64Decode(r.data);
    step = 'blob'; const blob = Utilities.newBlob(bytes, 'application/pdf', r.fileName || 'BGD.pdf');
    step = 'create'; const file = folder.createFile(blob);
    // নতুন ফাইল সফলভাবে তৈরি হওয়ার পরই পুরনোটা মোছা হয় (মাঝপথে ব্যর্থ হলে পুরনোটা হারায় না)
    step = 'replace'; if (r.replaceFileId) { const old = fileOk_(r.replaceFileId, root); if (old) old.setTrashed(true); }
    return { ok: true, folderId: folder.getId(), folderName: folder.getName(), fileId: file.getId() };
  } catch (e) {
    throw new Error('upload@' + step + ': ' + ((e && e.message) ? e.message : e));
  }
}

function get_(r) {
  const f = fileOk_(r.fileId, getRoot_());
  if (!f) return { ok: false, error: 'FILE_NOT_FOUND' };
  return { ok: true, name: f.getName(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function rename_(r) {
  const folder = folderOk_(r.folderId, getRoot_());
  if (!folder) return { ok: false, error: 'FOLDER_NOT_FOUND' };
  folder.setName(r.folderName || 'Unnamed');
  return { ok: true };
}

// মেইন বদল / নাম বদলালে: ফোল্ডার ও ফাইলগুলোর নাম একসাথে ঠিক করে
function syncSet_(r) {
  const root = getRoot_();
  if (r.folderId) { const fo = folderOk_(r.folderId, root); if (fo) fo.setName(r.folderName || 'Unnamed'); }
  (r.files || []).forEach(function (x) { const f = fileOk_(x.fileId, root); if (f) f.setName(x.name); });
  return { ok: true };
}

// ট্রান্সফার: ফাইলটা অন্য ফোল্ডারে সরায় (ফোল্ডার না থাকলে বানায়); আগের ফোল্ডার খালি ও দরকার হলে ট্র্যাশে
function moveFile_(r) {
  const root = getRoot_();
  const file = fileOk_(r.fileId, root); if (!file) return { ok: false, error: 'FILE_NOT_FOUND' };
  let to = r.toFolderId ? folderOk_(r.toFolderId, root) : null;
  if (!to) to = statusFolder_(root, r.status).createFolder(r.toFolderName || 'Unnamed');
  file.moveTo(to);
  if (r.trashFromIfEmpty && r.fromFolderId) { const from = folderOk_(r.fromFolderId, root); if (from && isEmpty_(from)) from.setTrashed(true); }
  return { ok: true, folderId: to.getId(), folderName: to.getName() };
}

// স্ট্যাটাস বদলালে ফোল্ডারটা সংশ্লিষ্ট স্ট্যাটাস ফোল্ডারে সরায়
function setStatus_(r) {
  const root = getRoot_(); const fo = folderOk_(r.folderId, root);
  if (!fo) return { ok: false, error: 'FOLDER_NOT_FOUND' };
  const target = statusFolder_(root, r.status);
  if (!inFolder_(fo, target)) fo.moveTo(target);
  return { ok: true };
}
// পুরনো ফোল্ডারগুলো একবারে সাজানো: items = [{folderId, status}]
function organize_(r) {
  const root = getRoot_(); const done = [], missing = [];
  (r.items || []).forEach(function (it) {
    const fo = folderOk_(it.folderId, root);
    if (!fo) { missing.push(it.folderId); return; }
    const target = statusFolder_(root, it.status);
    if (!inFolder_(fo, target)) fo.moveTo(target);
    done.push(it.folderId);
  });
  return { ok: true, done: done, missing: missing };
}

// সাধারণ ডিলিট: শুধু ট্র্যাশে পাঠায় (Drive এর ট্র্যাশ থেকে ৩০ দিন ফেরত আনা যায়)
function deleteFiles_(r) {
  const root = getRoot_();
  (r.fileIds || []).forEach(function (id) { const f = fileOk_(id, root); if (f) f.setTrashed(true); });
  if (r.folderIdIfEmpty) { const fo = folderOk_(r.folderIdIfEmpty, root); if (fo && isEmpty_(fo)) fo.setTrashed(true); }
  return { ok: true };
}

// চিরতরে ডিলিট (শুধু অ্যাডমিন): ফাইলগুলো + ফোল্ডার খালি হলে ফোল্ডারও
function deleteSet_(r) {
  const root = getRoot_(); let trashedOnly = 0;
  (r.fileIds || []).forEach(function (id) {
    const f = fileOk_(id, root); if (!f) return;
    if (!permDelete_(id)) trashedOnly++;
  });
  if (r.folderId) {
    // এই সেটের নিজস্ব ফোল্ডার: ভেতরে পুরনো (OLD) BGD থাকলেও সব একসাথে মুছে যায়
    const fo = folderOk_(r.folderId, root);
    if (fo) { if (!permDelete_(r.folderId)) trashedOnly++; }
  }
  return { ok: true, trashedOnly: trashedOnly };
}

function isEmpty_(folder) { return !folder.getFiles().hasNext() && !folder.getFolders().hasNext(); }

// স্থায়ীভাবে মোছা। Drive API সার্ভিস অন না থাকলে ট্র্যাশে পাঠায় (false ফেরত দেয়)
function permDelete_(id) {
  try { Drive.Files.remove(id); return true; }
  catch (e) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) { try { DriveApp.getFolderById(id).setTrashed(true); } catch (e3) { } }
    return false;
  }
}


// ====== ৫) অটো ব্যাকআপ (Firebase ডাটার কপি Drive এ) ======
// Drive এ: RTC VISA Files / _Backups / backup_2026-10-04_02-00_auto.json
const DB_URL = 'https://rtcvisa-fdbb5-default-rtdb.firebaseio.com';
const BACKUP_FOLDER_NAME = '_Backups';
const BACKUP_KEEP = 60;   // সর্বশেষ কতগুলো ব্যাকআপ রাখবে (পুরনোগুলো ট্র্যাশে যায়, ৩০ দিন ফেরত আনা যায়)

function bdNow_(fmt) { return Utilities.formatDate(new Date(), 'Asia/Dhaka', fmt); }

function backupFolder_() {
  const root = getRoot_();
  const it = root.getFoldersByName(BACKUP_FOLDER_NAME);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return root.createFolder(BACKUP_FOLDER_NAME);
}

// সব ব্যাকআপ ফাইল, নতুন আগে
function backupFiles_(folder) {
  const list = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    const m = f.getName().match(/^backup_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
    if (!m) continue;
    let meta = {}; try { meta = JSON.parse(f.getDescription() || '{}'); } catch (e) { }
    list.push({ file: f, id: f.getId(), name: f.getName(), key: m[1] + '_' + m[2], at: f.getDateCreated().getTime(), count: meta.count || 0, by: meta.by || '', kind: meta.kind || '', low: /_LOW\.json$/.test(f.getName()) });
  }
  list.sort(function (a, b) { return a.key < b.key ? 1 : (a.key > b.key ? -1 : 0); });
  return list;
}

function saveBackup_(files, by, kind, activity) {
  if (!Array.isArray(files) || !files.length) throw new Error('EMPTY_DATA');
  const folder = backupFolder_();
  const good = backupFiles_(folder).filter(function (x) { return !x.low; });
  // আগের ব্যাকআপের অর্ধেকের কম ফাইল থাকলে সন্দেহজনক ধরে আলাদা নামে রাখা হয় (ভালো ব্যাকআপ ছাঁটাই হয় না)
  const low = !!(good.length && files.length < good[0].count * 0.5);
  const name = 'backup_' + bdNow_('yyyy-MM-dd_HH-mm') + '_' + kind + (low ? '_LOW' : '') + '.json';
  const payload = { app: 'RTC VISA', savedAt: new Date().toISOString(), savedAtBD: bdNow_('yyyy-MM-dd HH:mm'), by: by, kind: kind, count: files.length, files: files };
  if (activity) payload.activity = activity;
  const file = folder.createFile(name, JSON.stringify(payload), 'application/json');
  file.setDescription(JSON.stringify({ count: files.length, by: by, kind: kind }));
  if (!low) good.slice(BACKUP_KEEP - 1).forEach(function (x) { x.file.setTrashed(true); });
  return { ok: true, name: name, count: files.length, low: low, id: file.getId() };
}

function backupStatus_() {
  const good = backupFiles_(backupFolder_()).filter(function (x) { return !x.low; });
  if (!good.length) return { ok: true, last: null };
  const x = good[0];
  return { ok: true, last: { name: x.name, at: x.at, count: x.count, by: x.by, kind: x.kind } };
}

function backupSave_(r, email) {
  const by = String(email || '').split('@')[0].toUpperCase();
  return saveBackup_(r.files, by, r.kind === 'manual' ? 'manual' : 'auto', null);
}

function backupList_() {
  const all = backupFiles_(backupFolder_()).slice(0, 20);
  return { ok: true, items: all.map(function (x) { return { id: x.id, name: x.name, at: x.at, count: x.count, by: x.by, kind: x.kind, low: x.low }; }) };
}

function backupGet_(r) {
  const f = fileOk_(r.fileId, getRoot_());
  if (!f) return { ok: false, error: 'FILE_NOT_FOUND' };
  return { ok: true, name: f.getName(), text: f.getBlob().getDataAsString() };
}

// ---- সার্ভার-সাইড দৈনিক ব্যাকআপ (কেউ অ্যাপ না খুললেও চলে) ----
// সেটআপ: Project Settings > Script Properties এ দুটো প্রপার্টি দিন:
//   BACKUP_EMAIL    = Firebase এ বানানো একটা আলাদা ইউজারের ইমেইল (যেমন backup@rtcvisa.com)
//   BACKUP_PASSWORD = ওই ইউজারের পাসওয়ার্ড
// তারপর authorize_ একবার চালান, তারপর setupDailyBackup_ একবার চালান।
function dailyBackup() {
  const props = PropertiesService.getScriptProperties();
  const em = props.getProperty('BACKUP_EMAIL'), pw = props.getProperty('BACKUP_PASSWORD');
  if (!em || !pw) throw new Error('Script Properties এ BACKUP_EMAIL ও BACKUP_PASSWORD দিন');
  const s = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ email: em, password: pw, returnSecureToken: true }), muteHttpExceptions: true });
  if (s.getResponseCode() !== 200) throw new Error('BACKUP_LOGIN_FAILED: ' + s.getContentText().slice(0, 200));
  const token = JSON.parse(s.getContentText()).idToken;
  const r = UrlFetchApp.fetch(DB_URL + '/rtc_visa_files.json?auth=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('BACKUP_READ_FAILED: ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150));
  const raw = JSON.parse(r.getContentText());
  const files = Array.isArray(raw) ? raw.filter(Boolean) : Object.keys(raw || {}).map(function (k) { return raw[k]; }).filter(Boolean);
  let activity = null;
  try {
    const a = UrlFetchApp.fetch(DB_URL + '/rtc_activity_log.json?orderBy=%22%24key%22&limitToLast=5000&auth=' + encodeURIComponent(token), { muteHttpExceptions: true });
    if (a.getResponseCode() === 200) activity = JSON.parse(a.getContentText());
  } catch (e) { }
  // ডাটা খালি হলে এখানে এরর হয় এবং Apps Script আপনাকে ইমেইলে ফেইলিওর নোটিফিকেশন পাঠায় (ডাটা হারানোর আগাম সতর্কতা)
  saveBackup_(files, 'AUTO-SERVER', 'auto', activity);
}

// একবার চালালেই হবে: প্রতিদিন বাংলাদেশ সময় রাত ২টায় dailyBackup চলবে
function setupDailyBackup_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(2).inTimezone('Asia/Dhaka').create();
  Logger.log('Daily backup trigger set (02:00 Asia/Dhaka)');
}
