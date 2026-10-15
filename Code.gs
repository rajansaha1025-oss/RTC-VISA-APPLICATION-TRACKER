/**
 * RTC VISA — Google Drive আপলোড সার্ভার (Google Apps Script)
 * ------------------------------------------------------------
 * কাজ: অ্যাপ থেকে আসা ফাইল (PDF, JPG, যেকোনো ধরন) Drive এ রাখা, ওপেন করার জন্য ফেরত দেওয়া, রিনেম ও ডিলিট করা।
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
const VERSION = 'v16-passport-pic-folder';
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
      case 'dedupe': if (!isAdmin) return out_({ ok: false, error: 'ADMIN_ONLY' }); return out_(dedupe_(refsFromLists_(req.refFolders, req.refFiles, req.refNames), 200));   // ডুপ্লিকেট ফোল্ডার পরিষ্কার
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
  for (let depth = 0; depth < 8 && level.length; depth++) {
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
// কোন স্ট্যাটাস ফোল্ডারের ভেতরে SMS অ্যাপ অনুযায়ী সাব-ফোল্ডার হবে (Running/Rtcsms/মেইন-ব্যক্তির-ফোল্ডার)
// অন্য স্ট্যাটাসেও চাইলে এখানে যোগ করুন, যেমন: { Running: true, Expired: true }
const SMS_STATUSES = { Running: true };
function cleanSms_(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Rtcsms'; }
function cleanType_(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Other'; }
function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return parent.createFolder(name);
}
// স্ট্রাকচার: RTC VISA Files / Running / <SMS অ্যাপ> / <ভিসা টাইপ: Medical, Tourist, Double Entry...> / <মেইন ফাইল ফোল্ডার>
function targetFolder_(root, status, sms, visaType) {
  const key = STATUS_FOLDERS[status] ? status : 'Running';
  const sf = statusFolder_(root, key);
  if (!SMS_STATUSES[key]) return sf;
  return subFolder_(subFolder_(sf, cleanSms_(sms)), cleanType_(visaType));
}
// ফাইলের মাইম টাইপ: অ্যাপ থেকে আসা mime, না থাকলে এক্সটেনশন দেখে, তাও না পেলে octet-stream (যেকোনো ফাইলই নেওয়া যায়)
const MIME_BY_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', txt: 'text/plain', json: 'application/json', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' };
function mimeOf_(r) {
  const m = String(r.mime || '').trim();
  if (/^[\w.+-]+\/[\w.+-]+$/.test(m)) return m;
  const ext = String(r.fileName || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
// সেট ফোল্ডারের ভেতরের আলাদা সাব-ফোল্ডার (যেমন 'passport and pic')
function cleanSub_(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim(); }
// ছবি/পাসপোর্ট আলাদা জায়গায়: RTC VISA Files / Passport Pic / NAME (PHOTO).jpg ও NAME (PASSPORT).pdf (কোনো সাব-ফোল্ডার নেই)
const PASSPORT_ROOT_NAME = 'Passport Pic';
function passportRoot_(root) { return subFolder_(root, PASSPORT_ROOT_NAME); }
function inFolder_(item, folder) {
  const ps = item.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) return true; }
  return false;
}

// ====== ডুপ্লিকেট ফোল্ডার ঠেকানোর ব্যবস্থা ======
// ১) লক: একসাথে দুটো রিকোয়েস্ট এলে একটার পর একটা চলে, তাই দুজন মিলে দুটো ফোল্ডার বানাতে পারে না
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(100000); } catch (e) { throw new Error('SERVER_BUSY'); }
  try { return fn(); } finally { lock.releaseLock(); }
}
// ২) ফোল্ডার খোঁজা: শুধু "সত্যিই নেই" হলে null দেয়। Drive এ সাময়িক সমস্যা হলে এরর দেয়, যাতে ভুল করে নতুন ফোল্ডার না বানায়
function folderResolve_(id, root) {
  let f;
  try { f = DriveApp.getFolderById(id); }
  catch (e) {
    const m = String((e && e.message) || e);
    if (/No item with the given ID|not found|does not exist/i.test(m)) return null;
    throw new Error('DRIVE_TEMP_ERROR: ' + m);
  }
  if (f.isTrashed()) return null;
  return inTree_(f, root) ? f : null;
}
// ৩) সেট-কী: প্রতিটি ফোল্ডারের description এ 'set:<সেট আইডি>' লেখা থাকে। ফোল্ডারের আইডি ফেরত না এলেও একই সেটের আপলোড একই ফোল্ডারে যায়
function setTag_(key) { return key ? 'set:' + key : ''; }
function findOrCreateSetFolder_(parent, name, key) {
  const tag = setTag_(key);
  if (tag) {
    // ট্যাগ + (সাদামাটা) নাম মিললেই একই ফোল্ডার ধরা হয়; পরে ফোল্ডারের নামে [EXPIRED ...] যোগ হলেও খুঁজে পায়
    const want = normFolderName_(name);
    const it = parent.getFolders();
    while (it.hasNext()) {
      const f = it.next();
      if (!f.isTrashed() && f.getDescription() === tag && normFolderName_(f.getName()) === want) return f;
    }
  }
  const nf = parent.createFolder(name);
  if (tag) nf.setDescription(tag);
  return nf;
}
// একই reqId দুইবার এলে (নেটওয়ার্ক রিট্রাই) আবার ফাইল বানায় না, আগের ফলাফলই ফেরত দেয়
function reqCacheGet_(id) { if (!id) return null; const v = CacheService.getScriptCache().get('req_' + id); return v ? JSON.parse(v) : null; }
function reqCachePut_(id, obj) { if (id) CacheService.getScriptCache().put('req_' + id, JSON.stringify(obj), 21600); }

// ====== ৪) অ্যাকশনগুলো ======
function upload_(r) {
  return withLock_(function () {
    const again = reqCacheGet_(r.reqId); if (again) return again;   // আগেই হয়ে গেছে (রিট্রাই)
    let step = 'start';
    try {
      step = 'root'; const root = getRoot_();
      const person = String(r.personFolder || '').trim();   // ছবি/পাসপোর্ট: মেইন সেট ফোল্ডার ছোঁয়া হয় না
      step = 'folder'; let folder = person ? passportRoot_(root) : (r.folderId ? folderResolve_(r.folderId, root) : null);
      if (!folder) folder = findOrCreateSetFolder_(targetFolder_(root, r.status, r.sms, r.visaType), r.folderName || 'Unnamed', r.setKey);
      step = 'place'; if (!person && r.status && (!SMS_STATUSES[STATUS_FOLDERS[r.status] ? r.status : 'Running'] || String(r.visaType || '').trim())) { const tgt = targetFolder_(root, r.status, r.sms, r.visaType); if (!inFolder_(folder, tgt)) folder.moveTo(tgt); }   // আপলোডের সময়ই ফোল্ডার সঠিক জায়গায় (Expired -> Running, Other -> সঠিক টাইপ)
      step = 'decode'; if (!r.data) throw new Error('ফাইলের data খালি এসেছে');
      const bytes = Utilities.base64Decode(r.data);
      step = 'blob'; const blob = Utilities.newBlob(bytes, mimeOf_(r), r.fileName || 'BGD.pdf');
      step = 'create'; const sub = person ? '' : cleanSub_(r.subFolder); const dest = sub ? subFolder_(folder, sub) : folder; const file = dest.createFile(blob);
      // নতুন ফাইল সফলভাবে তৈরি হওয়ার পরই পুরনোটা মোছা হয় (মাঝপথে ব্যর্থ হলে পুরনোটা হারায় না)
      step = 'replace'; if (r.replaceFileId) { const old = fileOk_(r.replaceFileId, root); if (old) old.setTrashed(true); }
      // আগের আপলোড সার্ভারে হয়ে গিয়েছিল কিন্তু অ্যাপ জানতে পারেনি (ট্যাব বন্ধ/রিফ্রেশ): একই নামের আগের কপি ট্র্যাশে (৩০ দিন ফেরত আনা যায়)
      step = 'samename'; try {
        const nm = file.getName(), newId = file.getId(); const sib = dest.getFilesByName(nm);
        while (sib.hasNext()) { const x = sib.next(); if (x.getId() !== newId && !x.isTrashed()) x.setTrashed(true); }
      } catch (e2) { }
      const res = { ok: true, folderId: folder.getId(), folderName: folder.getName(), fileId: file.getId() };
      reqCachePut_(r.reqId, res);
      return res;
    } catch (e) {
      throw new Error('upload@' + step + ': ' + ((e && e.message) ? e.message : e));
    }
  });
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
  (r.files || []).forEach(function (x) {
    const f = fileOk_(x.fileId, root); if (!f) return;
    f.setName(x.name);
  });
  return { ok: true };
}

// ট্রান্সফার: ফাইলটা অন্য ফোল্ডারে সরায় (ফোল্ডার না থাকলে বানায়); আগের ফোল্ডার খালি ও দরকার হলে ট্র্যাশে
function moveFile_(r) {
  return withLock_(function () {
    const root = getRoot_();
    const file = fileOk_(r.fileId, root); if (!file) return { ok: false, error: 'FILE_NOT_FOUND' };
    let to = r.toFolderId ? folderResolve_(r.toFolderId, root) : null;
    if (!to) to = findOrCreateSetFolder_(targetFolder_(root, r.status, r.sms, r.visaType), r.toFolderName || 'Unnamed', r.setKey);
    const subM = cleanSub_(r.subFolder); file.moveTo(subM ? subFolder_(to, subM) : to);
    if (r.trashFromIfEmpty && r.fromFolderId) { const from = folderOk_(r.fromFolderId, root); if (from && isEmpty_(from)) from.setTrashed(true); }
    return { ok: true, folderId: to.getId(), folderName: to.getName() };
  });
}

// স্ট্যাটাস বদলালে ফোল্ডারটা সংশ্লিষ্ট স্ট্যাটাস ফোল্ডারে সরায়
function setStatus_(r) {
  return withLock_(function () {
    const root = getRoot_(); const fo = folderOk_(r.folderId, root);
    if (!fo) return { ok: false, error: 'FOLDER_NOT_FOUND' };
    const target = targetFolder_(root, r.status, r.sms, r.visaType);
    if (!inFolder_(fo, target)) fo.moveTo(target);
    return { ok: true, layout: 2 };
  });
}
// পুরনো ফোল্ডারগুলো একবারে সাজানো: items = [{folderId, status}]
function organize_(r) {
  return withLock_(function () {
    const root = getRoot_(); const done = [], missing = [];
    (r.items || []).forEach(function (it) {
      const fo = folderOk_(it.folderId, root);
      if (!fo) { missing.push(it.folderId); return; }
      const target = targetFolder_(root, it.status, it.sms, it.visaType);
      if (!inFolder_(fo, target)) fo.moveTo(target);
      done.push(it.folderId);
    });
    return { ok: true, done: done, missing: missing, layout: 2 };
  });
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

// খালি = কোনো ফাইল নেই এবং সব সাব-ফোল্ডারও খালি (খালি 'passport and pic' থাকলেও সেট ফোল্ডার খালি ধরা হয়)
function isEmpty_(folder) {
  if (folder.getFiles().hasNext()) return false;
  const it = folder.getFolders();
  while (it.hasNext()) { const s = it.next(); if (!s.isTrashed() && !isEmpty_(s)) return false; }
  return true;
}

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
  // ব্যাকআপ হয়ে গেলে ডুপ্লিকেট ফোল্ডার নিজে নিজে পরিষ্কার (এরর হলেও ব্যাকআপ নিরাপদ)
  try { Logger.log('dedupe: ' + JSON.stringify(dedupe_(collectRefs_(files), 240))); } catch (e) { Logger.log('dedupe failed: ' + e); }
}

// একবার চালালেই হবে: প্রতিদিন বাংলাদেশ সময় রাত ২টায় dailyBackup চলবে
function setupDailyBackup_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(2).inTimezone('Asia/Dhaka').create();
  Logger.log('Daily backup trigger set (02:00 Asia/Dhaka)');
}


// ====== ৬) ডুপ্লিকেট ফোল্ডার অটো-পরিষ্কার ======
// কোন ফোল্ডার "আসল" তা অ্যাপের কার্ড থেকে জানা যায় (কার্ডে driveFolderId ও ফাইলের আইডি থাকে)।
// ডুপ্লিকেট = কোনো কার্ডেই নেই + আসল ফোল্ডারের সমান নাম + ২ ঘণ্টার বেশি পুরনো (চলমান আপলোড যেন না ছোঁয়)।
// ⚠️ শর্ত: ওই নামে ঠিক ১টা কার্ড থাকতে হবে। একই মেইন নামে ২টা কার্ড থাকলে (আলাদা ফাইল হতে পারে) কিছুই মোছা/সরানো হয় না।
// ডুপ্লিকেটের ভেতরের ফাইল: কার্ডে লিংক করা থাকলে বা আসল ফোল্ডারে একই নামের ফাইল না থাকলে আসল ফোল্ডারে সরানো হয়;
// নইলে (একই ফাইলের কপি) ট্র্যাশে যায়, Drive এর ট্র্যাশ থেকে ৩০ দিন ফেরত আনা যায়। কিছুই চিরতরে মোছা হয় না।
const DUP_MIN_AGE_MS = 2 * 3600 * 1000;

// তুলনার জন্য নাম সাদামাটা করা: শেষের [EXPIRED - ...] এবং কপির (1) (2) বাদ যায়
function normFolderName_(n) { return String(n || '').replace(/\s*\[EXPIRED[^\]]*\]\s*$/i, '').replace(/\s*\(\d{1,2}\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function safeName_(x) { return String(x || 'Unnamed').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unnamed'; }
// কার্ডের মেইন নাম গুনে রাখে: নাম → কয়টা কার্ড (রিসাইকেল বিনের কার্ডসহ)
function countNames_(list) {
  const m = {};
  (list || []).forEach(function (n) { const k = normFolderName_(safeName_(n)); m[k] = (m[k] || 0) + 1; });
  return m;
}
function refsFromLists_(folderIds, fileIds, names) {
  const o = { folders: {}, files: {}, names: names ? countNames_(names) : null };
  (folderIds || []).forEach(function (x) { if (x) o.folders[x] = true; });
  (fileIds || []).forEach(function (x) { if (x) o.files[x] = true; });
  return o;
}
// কার্ডের তালিকা থেকে সব driveFolderId এবং ...FileId (driveFileId, invoiceFileId, invitationFileId ...) ও মেইন নাম বের করে
function collectRefs_(cards) {
  const o = { folders: {}, files: {}, names: null };
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    Object.keys(x).forEach(function (k) {
      const v = x[k];
      if (typeof v === 'string' && v) {
        if (k === 'driveFolderId') o.folders[v] = true;
        else if (/FileId$/.test(k)) o.files[v] = true;
      } else if (v && typeof v === 'object') walk(v);
    });
  })(cards);
  o.names = countNames_((Array.isArray(cards) ? cards : []).map(function (c) { return c && c.applicants && c.applicants[0] && c.applicants[0].name; }));
  return o;
}

// root এর নিচের সব "সেট ফোল্ডার": Running/<SMS>/<টাইপ>/<সেট>, Delivered/<সেট>, ... এবং পুরনো স্টাইলে root/<সেট>
function listSetFolders_(root, deadline) {
  const out = []; let partial = false;
  function add(f, parentId) { out.push({ f: f, id: f.getId(), name: f.getName(), parent: parentId }); }
  const top = root.getFolders();
  outer:
  while (top.hasNext()) {
    const t = top.next(); const tn = t.getName();
    if (tn === BACKUP_FOLDER_NAME || tn === PASSPORT_ROOT_NAME) continue;
    if (STATUS_FOLDERS[tn] !== tn) { add(t, root.getId()); continue; }   // পুরনো স্টাইল
    const levels = SMS_STATUSES[tn] ? 3 : 1;
    let parents = [t];
    for (let d = 1; d < levels; d++) {
      const next = [];
      parents.forEach(function (p) { const it = p.getFolders(); while (it.hasNext()) next.push(it.next()); });
      parents = next;
    }
    for (let i = 0; i < parents.length; i++) {
      const it = parents[i].getFolders();
      while (it.hasNext()) {
        if (Date.now() > deadline) { partial = true; break outer; }
        add(it.next(), parents[i].getId());
      }
    }
  }
  return { list: out, partial: partial };
}

// একটা ডুপ্লিকেট ফোল্ডারের ফাইল আসল ফোল্ডারে মিলিয়ে ফোল্ডারটা ট্র্যাশে পাঠায়
function mergeOrphan_(o, target, refs, res) {
  const f = o.f;
  if (f.isTrashed()) return;
  if (Date.now() - f.getDateCreated().getTime() < DUP_MIN_AGE_MS) return;   // নতুন; আপলোড চলতে পারে
  if (f.getFolders().hasNext()) { res.ambiguous++; return; }                // ভেতরে সাব-ফোল্ডার থাকলে ছোঁয়া হয় না
  const tf = target.f; const names = {};
  const tit = tf.getFiles(); while (tit.hasNext()) { const x = tit.next(); if (!x.isTrashed()) names[x.getName()] = true; }
  const items = []; const it = f.getFiles(); while (it.hasNext()) { const x = it.next(); if (!x.isTrashed()) items.push(x); }
  items.forEach(function (x) {
    const nm = x.getName();
    if (refs.files[x.getId()] || !names[nm]) { x.moveTo(tf); names[nm] = true; res.filesMoved++; }
    else { x.setTrashed(true); res.filesTrashed++; }
  });
  f.setTrashed(true);
  res.foldersTrashed++;
}

function dedupe_(refs, maxSeconds) {
  const deadline = Date.now() + (maxSeconds || 200) * 1000;
  const empty = { ok: true, scanned: 0, foldersTrashed: 0, filesMoved: 0, filesTrashed: 0, ambiguous: 0, sameNameSkipped: 0, skippedBusy: 0, partial: false };
  if (!refs.names) return { ok: false, error: 'NO_NAMES' };   // কার্ডের নাম ছাড়া নিরাপদে বোঝা যায় না
  if (!Object.keys(refs.folders).length) return Object.assign(empty, { note: 'NO_REFS' });
  const root = getRoot_();
  const scan = listSetFolders_(root, deadline);
  const groups = {};
  scan.list.forEach(function (x) {
    const k = normFolderName_(x.name); if (!k) return;
    const g = groups[k] || (groups[k] = { kept: [], orphans: [] });
    (refs.folders[x.id] ? g.kept : g.orphans).push(x);
  });
  const res = Object.assign(empty, { scanned: scan.list.length, partial: scan.partial });
  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    if (!g.kept.length || !g.orphans.length) return;
    // একই নামে ২টা (বা বেশি) কার্ড থাকলে কোনটার ফোল্ডার তা আন্দাজ করা যায় না, তাই কিছুই ছোঁয়া হয় না
    if (refs.names[k] !== 1 || g.kept.length !== 1) { res.sameNameSkipped += g.orphans.length; return; }
    g.orphans.forEach(function (o) {
      if (Date.now() > deadline) { res.partial = true; return; }
      try { withLock_(function () { mergeOrphan_(o, g.kept[0], refs, res); }); }
      catch (e) { if (/SERVER_BUSY/.test(String(e && e.message))) res.skippedBusy++; else throw e; }
    });
  });
  return res;
}


// ====== ৭) একবারের কাজ: ছবি/পাসপোর্ট সব 'Passport Pic' ফোল্ডারে একসাথে আনা ======
// Apps Script এডিটরে migratePassportPics সিলেক্ট করে একবার Run করুন। ফাইলের আইডি বদলায় না, ফাইল মোছা হয় না, শুধু সরানো হয়।
// ১) সেট ফোল্ডারের ভেতরের 'passport and pic' সাব-ফোল্ডারের ফাইল  ২) Passport Pic এর ভেতরের নামের সাব-ফোল্ডারের ফাইল -> সরাসরি Passport Pic এ
function migratePassportPics() {
  const deadline = Date.now() + 300 * 1000;
  const root = getRoot_(); const pr = passportRoot_(root);
  let moved = 0, removed = 0;
  function pull(sub) {
    const files = sub.getFiles();
    while (files.hasNext()) { const x = files.next(); if (x.isTrashed()) continue; if (/\((PHOTO|PASSPORT)\)\.[A-Za-z0-9]+$/.test(x.getName())) { x.moveTo(pr); moved++; } }
    if (isEmpty_(sub)) { sub.setTrashed(true); removed++; }
  }
  const scan = listSetFolders_(root, deadline);
  scan.list.forEach(function (o) {
    if (Date.now() > deadline) return;
    const it = o.f.getFoldersByName('passport and pic');
    while (it.hasNext()) { const sub = it.next(); if (!sub.isTrashed()) pull(sub); }
  });
  const subs = pr.getFolders();
  while (subs.hasNext()) { const sub = subs.next(); if (!sub.isTrashed()) pull(sub); }
  Logger.log('Passport Pic migration: moved=' + moved + ', emptyFoldersTrashed=' + removed + (scan.partial ? ' | সময় শেষ, আবার Run করুন' : ''));
}
