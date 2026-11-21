/* Portable local saves. Imports use a new database so an active engine can
   never overwrite the restored data; switching profiles is one storage write. */
(() => {
  'use strict';
  const ACTIVE_KEY = 'catsActiveSave.v1';
  const FORMAT = 'cats-browser-save';
  const MAX_FILE = 128 * 1024 * 1024, MAX_DATA = 80 * 1024 * 1024;
  const identity = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  let legacyId = localStorage.getItem('catsBrowserDeviceId');
  if (!identity(legacyId)) { legacyId = token(); localStorage.setItem('catsBrowserDeviceId', legacyId); }
  let profile = {deviceId:legacyId, databaseName:'cats-port-' + legacyId, preferencesKey:'catsPrefs:' + legacyId};
  const validProfile = value => value && identity(value.deviceId) && /^cats-port-(?:[a-f0-9]{16}|import-[a-f0-9]{16})$/.test(value.databaseName) && /^catsPrefs:[a-z0-9-]+$/.test(value.preferencesKey);
  try {
    const selected = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
    if (selected?.version === 1 && validProfile(selected)) profile = selected;
  } catch (error) { console.error('Could not read save selection', error); }
  profile = Object.freeze(profile);
  let preferences = localStorage.getItem(profile.preferencesKey), paused = false;
  const liveFiles = new Map(), pending = new Set(), databases = new Map(), backupHooks = new Set();
  const pathIsSave = path => typeof path === 'string' && path.length <= 1024 && path.startsWith('/assets/') && !/[\\\0]/.test(path) && !path.split('/').slice(1).some(p => !p || p === '.' || p === '..') && !path.includes('/zf_auto_scaled_textures/') && !/\.(?:wasm|js|html|so)$/i.test(path);
  function database(name = profile.databaseName) {
    if (!databases.has(name)) databases.set(name, new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', {keyPath:'path'});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('Browser save storage is unavailable.'));
      request.onblocked = () => reject(Error('Close other game tabs and try again.'));
    }));
    return databases.get(name);
  }
  async function readFiles(name = profile.databaseName) {
    const db = await database(name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly'), request = tx.objectStore('files').getAll();
      let files;
      request.onsuccess = () => { files = request.result; };
      tx.oncomplete = () => resolve(files);
      tx.onabort = tx.onerror = () => reject(Error('Could not read saved progress.'));
    });
  }
  async function writeFiles(name, files) {
    const db = await database(name);
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files');
      for (const file of files) store.put(file);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(Error('Could not store the save. Check available browser storage.'));
    });
  }
  function saveFile(path, bytes) {
    if (paused || path.includes('zf_auto_scaled_textures')) return;
    const file = {path, bytes:new Uint8Array(bytes)};
    liveFiles.set(path, file);
    const task = writeFiles(profile.databaseName, [file]);
    task.catch(error => {
      console.error('Could not save game progress', error);
      message('Browser saving failed. Export a backup to keep your progress.', true);
    });
    pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function savePreferences(text) {
    if (paused) return;
    preferences = text;
    try { localStorage.setItem(profile.preferencesKey, text); }
    catch (error) { console.error('Could not save game settings', error); message('Browser saving failed. Export a backup to keep your progress.', true); }
  }
  function base64(bytes) {
    let text = '';
    for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768));
    return btoa(text);
  }
  async function checksum(payload) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function makeBackup(previous = false) {
    const selected = previous ? profile.previous : profile;
    if (!validProfile(selected)) throw Error('No previous save is available.');
    if (!previous) { if(typeof FS !== 'undefined'){try{savePreferences(FS.readFile('/assets/prefs.txt',{encoding:'utf8'}));}catch(error){if(error?.code!=='ENOENT'&&error?.errno!==44)throw error;}} for (const hook of backupHooks) await hook(); await Promise.allSettled([...pending]); }
    const files = new Map((await readFiles(selected.databaseName)).map(file => [file.path, file]));
    if (!previous) for (const [path, file] of liveFiles) files.set(path, file);
    const records = [];
    let total = 0;
    for (const file of [...files.values()].sort((a,b) => a.path.localeCompare(b.path))) {
      if (!pathIsSave(file.path)) throw Error('This save contains an unsupported file path. Your progress has not been changed.');
      const bytes = new Uint8Array(file.bytes);
      total += bytes.length;
      if (total > MAX_DATA) throw Error('This save is too large to export.');
      records.push({path:file.path, size:bytes.length, data:base64(bytes)});
    }
    const payload = {deviceId:selected.deviceId, preferences:previous ? selected.preferences : preferences, files:records};
    return {format:FORMAT, version:1, exportedAt:new Date().toISOString(), payload, checksum:await checksum(payload)};
  }
  async function validateBackup(text) {
    if (typeof text !== 'string' || text.length > MAX_FILE) throw Error('The save file is too large.');
    let backup;
    try { backup = JSON.parse(text); } catch { throw Error('This is not a valid C.A.T.S. save file.'); }
    if (backup?.format !== FORMAT || backup.version !== 1) throw Error('Choose a supported C.A.T.S. save export.');
    const p = backup.payload;
    if (!p || !identity(p.deviceId) || !(p.preferences === null || typeof p.preferences === 'string') || (p.preferences?.length || 0) > 8 * 1024 * 1024 || !Array.isArray(p.files) || p.files.length > 10000) throw Error('The save file is incomplete or invalid.');
    const paths = new Set(), files = []; let total = 0;
    for (const file of p.files) {
      if (!file || !pathIsSave(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_DATA || typeof file.data !== 'string' || file.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw Error('The save contains invalid or duplicate files.');
      paths.add(file.path); total += file.size;
      if (total > MAX_DATA || file.data.length !== 4 * Math.ceil(file.size / 3)) throw Error('The save contains an invalid file size.');
      let raw;
      try { raw = atob(file.data); } catch { throw Error('The save contains damaged file data.'); }
      if (raw.length !== file.size) throw Error('The save contains damaged file data.');
      files.push({path:file.path, bytes:Uint8Array.from(raw, c => c.charCodeAt(0))});
    }
    if (typeof backup.checksum !== 'string' || backup.checksum !== await checksum(p)) throw Error('The save integrity check failed. Your current progress is unchanged.');
    return {backup, files};
  }
  async function importSave(text) {
    // Validation precedes every write. A fresh namespace preserves the old save.
    const checked = await validateBackup(text), slot = token();
    const databaseName = 'cats-port-import-' + slot, preferencesKey = 'catsPrefs:import-' + slot;
    await writeFiles(databaseName, checked.files);
    await Promise.allSettled([...pending]);
    if (liveFiles.size) await writeFiles(profile.databaseName, [...liveFiles.values()]);
    const selected = {version:1, deviceId:checked.backup.payload.deviceId, databaseName, preferencesKey,
      previous:{deviceId:profile.deviceId, databaseName:profile.databaseName, preferencesKey:profile.preferencesKey, preferences, savedAt:new Date().toISOString()}};
    try {
      const importedPreferences = checked.backup.payload.preferences;
      if (importedPreferences !== null) localStorage.setItem(preferencesKey, importedPreferences);
      paused = true;
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(selected));
    } catch {
      paused = false;
      throw Error('Import could not be saved. Your current save is still selected and has not been replaced.');
    }
    return selected;
  }
  const style = document.createElement('style');
  style.textContent = `#save-button{position:fixed;right:14px;top:12px;z-index:12;min-height:36px;padding:6px 13px;border:1px solid #ffffff45;border-radius:6px;background:#151b22df;color:#fff;font:600 14px system-ui;cursor:pointer}#save-button:hover{background:#303943}#save-button:focus-visible{outline:2px solid white;outline-offset:3px}#save-dialog{width:min(400px,calc(100vw - 32px))}#save-dialog .save-actions{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:18px}#save-dialog .save-note{font-size:12px;margin-top:16px;margin-bottom:0}#save-dialog .save-error{color:#efacac}#save-dialog input[type=file]{display:none}#save-dialog #save-review{padding:12px;background:#101418;border-radius:5px;white-space:pre-line}#save-dialog #save-message{margin:0 0 16px;overflow-wrap:anywhere}#save-dialog [hidden]{display:none!important}#save-dialog .save-footer{display:flex;justify-content:flex-end;gap:8px}`;
  document.head.append(style);
  const button = document.createElement('button');button.id='save-button';button.type='button';button.textContent='Save';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','save-dialog');document.body.append(button);
  const dialog = document.createElement('dialog');dialog.id='save-dialog';dialog.setAttribute('aria-labelledby','save-heading');
  dialog.innerHTML = `<h2 id="save-heading">Save progress</h2><p>Download a backup or bring your save to this browser.</p><div class="save-actions"><button type="button" id="save-export">Export save</button><button type="button" id="save-import">Import save</button><button type="button" id="save-previous" hidden>Export previous save</button></div><input id="save-file" type="file" accept=".json,.cats-save,application/json" aria-label="Choose a C.A.T.S. save file"><p id="save-message" role="status" aria-live="polite"></p><p id="save-review" hidden></p><div class="save-footer"><button type="button" id="save-cancel-import" hidden>Cancel import</button><button type="button" id="save-restore" hidden>Import &amp; restart</button><button type="button" id="save-close">Close</button></div><p class="save-note">Exports include progress already saved by the game. Keep a backup outside your browser. Importing restarts the game and keeps your previous local save.</p>`;
  document.body.append(dialog);
  const find = id => dialog.querySelector('#'+id);
  let selectedText = null, busy = false;
  function message(text, error = false) { const target=find('save-message');target.textContent=text;target.classList.toggle('save-error',error); }
  function review(clear = true) { if (clear) selectedText=null;for(const id of ['save-review','save-restore','save-cancel-import'])find(id).hidden=!selectedText; }
  function setBusy(value) { busy=value;for(const control of dialog.querySelectorAll('button'))control.disabled=value; }
  async function action(fn) { if(busy)return;setBusy(true);try{await fn();}catch(error){message(error.message,true);}finally{setBusy(false);} }
  async function download(previous) {
    const backup = await makeBackup(previous), blob = new Blob([JSON.stringify(backup)],{type:'application/json'});
    const url = URL.createObjectURL(blob), anchor=document.createElement('a');anchor.href=url;anchor.download='CATS-save-'+backup.payload.deviceId+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);message(previous?'Previous save exported.':'Save exported. Keep this file somewhere safe.');
  }
  button.onclick=()=>{find('save-previous').hidden=!validProfile(profile.previous);dialog.showModal();};
  find('save-close').onclick=()=>{dialog.close();document.querySelector('#canvas')?.focus();};
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  find('save-export').onclick=()=>action(()=>download(false));
  find('save-previous').onclick=()=>action(()=>download(true));
  find('save-import').onclick=()=>{if(!busy){find('save-file').value='';find('save-file').click();}};
  find('save-file').onchange=()=>action(async()=>{
    review();const file=find('save-file').files[0];if(!file)return;
    if(file.size>MAX_FILE)throw Error('The save file is too large.');
    const text=await file.text(), checked=await validateBackup(text);selectedText=text;
    const date=new Date(checked.backup.exportedAt);find('save-review').textContent=`${checked.files.length.toLocaleString()} saved files${Number.isNaN(date.getTime())?'':' · '+date.toLocaleString()}\nThe game will restart with this save. Your current save will remain available as “Export previous save.”${!checked.backup.payload.preferences?.includes('legacy.PREFS_USER_ID ')?'\nThis older backup has no account sign-in details. Its local files can be restored, but they may not reopen the same connected profile.':''}`;review(false);message('Save checked. Ready to import.');
  });
  find('save-cancel-import').onclick=()=>{review();message('Import cancelled. Your current save is unchanged.');};
  find('save-restore').onclick=()=>action(async()=>{if(!selectedText)return;await importSave(selectedText);message('Save imported. Restarting…');allowNavigation = true; location.reload();});
  // Fullscreen includes the toolbar, dialogs, and the game canvas together.
  const toolbar = document.createElement('div');toolbar.id='game-toolbar';
  button.before(toolbar);toolbar.append(button);
  const fullscreen = document.createElement('button');fullscreen.id='fullscreen-button';fullscreen.type='button';fullscreen.textContent='Fullscreen';toolbar.append(fullscreen);
  const extraStyle = document.createElement('style');extraStyle.textContent=`#game-toolbar{position:fixed;right:14px;top:12px;z-index:12;display:flex;gap:8px}#game-toolbar #save-button{position:static}#fullscreen-button{min-height:36px;padding:6px 13px;border:1px solid #ffffff45;border-radius:6px;background:#151b22df;color:white;font:600 14px system-ui;cursor:pointer}#fullscreen-button:hover{background:#303943}#fullscreen-button:focus-visible{outline:2px solid white;outline-offset:3px}#fullscreen-button:disabled{opacity:.5;cursor:default}`;document.head.append(extraStyle);
  fullscreen.disabled = !document.fullscreenEnabled;
  fullscreen.title = fullscreen.disabled ? 'Fullscreen is unavailable in this browser.' : 'Toggle fullscreen';
  fullscreen.onclick = async () => {
    try {
      if(document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch(error) { message('Could not enter fullscreen: '+error.message,true);dialog.showModal(); }
  };
  document.addEventListener('fullscreenchange',()=>{fullscreen.textContent=document.fullscreenElement?'Exit fullscreen':'Fullscreen';fullscreen.setAttribute('aria-pressed',String(!!document.fullscreenElement));});
  fullscreen.setAttribute('aria-pressed','false');
  let allowNavigation = false;
  window.addEventListener('beforeunload',event=>{
    if(allowNavigation)return;
    event.preventDefault();
    event.returnValue='Did you export your save?'; // Browsers display their own confirmation text.
  });
  window.CatsSaves = Object.freeze({beforeBackup:hook=>{backupHooks.add(hook);return ()=>backupHooks.delete(hook);},profile,database,readFiles,saveFile,savePreferences,makeBackup,validateBackup,importSave,get paused(){return paused;}});
})();
