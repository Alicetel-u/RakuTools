import { formatSize, validateFiles, requestJSON, uploadFiles } from './upload.js';
const $ = id => document.getElementById(id);
const input = $('filesInput'), status = $('status'), upload = $('upload');
const unavailable = '外部サービスとの連携条件を確認しています。現在、ファイルは送信されません。';
let api = '', available = false, busy = false, selection = [], controller, challengeId, challengeToken = '';
let limits = { maxFiles: 20, maxFileSize: 10 * 1024 ** 3, maxTotalSize: 10 * 1024 ** 3 };
function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function step(index) {
  document.querySelectorAll('.steps li').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    if (i === index) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
}
function updateButton() {
  upload.disabled = busy || !available || Boolean(validateFiles(selection, limits)) || !$('consent').checked || !challengeToken;
  upload.textContent = busy ? 'アップロード中…' : !available ? '現在アップロードは準備中です' : 'アップロードする';
}
function setBusy(value) {
  busy = value;
  for (const id of ['pick', 'filesInput', 'lifetime', 'consent', 'clear', 'reset']) $(id).disabled = value;
  $('fileList').querySelectorAll('button').forEach(b => b.disabled = value);
  $('drop').setAttribute('aria-disabled', String(value)); updateButton();
}
function render() {
  $('selection').hidden = !selection.length; $('fileList').replaceChildren();
  $('fileCount').textContent = `${selection.length}個のファイルを選択中`;
  selection.forEach((file, index) => {
    const li = document.createElement('li'), name = document.createElement('span'), size = document.createElement('span'), remove = document.createElement('button');
    name.className = 'file-name'; name.textContent = file.name;
    size.className = 'file-size'; size.textContent = formatSize(file.size);
    remove.className = 'remove'; remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `${file.name}を外す`);
    remove.onclick = () => { if (!busy) { selection.splice(index, 1); render(); } };
    li.append(name, size, remove); $('fileList').append(li);
  });
  $('fileTotal').textContent = `合計 ${formatSize(selection.reduce((n, f) => n + f.size, 0))}`;
  if (selection.length) {
    const error = validateFiles(selection, limits);
    message(error || (available ? '内容を確認して、アップロードしてください。' : 'ファイルを選択しました。公開準備中のため、送信はできません。'), Boolean(error));
  } else message('');
  updateButton();
}
function choose(files) {
  if (busy) return;
  const next = Array.from(files || []);
  const error = next.length ? validateFiles(next, limits) : '';
  if (error) { message(error, true); return; }
  selection = next; render(); input.value = '';
}
$('pick').onclick = () => input.click(); input.onchange = () => choose(input.files);
for (const event of ['dragenter', 'dragover']) $('drop').addEventListener(event, e => { e.preventDefault(); if (!busy) $('drop').classList.add('drag'); });
for (const event of ['drop', 'dragleave']) $('drop').addEventListener(event, e => { e.preventDefault(); $('drop').classList.remove('drag'); });
$('drop').addEventListener('drop', e => { if (e.dataTransfer?.files?.length) choose(e.dataTransfer.files); });
// Avoid the browser navigating away when a file is dropped outside the target.
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('clear').onclick = () => { if (!busy) { selection = []; input.value = ''; render(); } };
$('consent').onchange = updateButton;
$('cancel').onclick = () => controller?.abort();
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
$('reset').onclick = () => {
  selection = []; input.value = ''; $('results').hidden = true; $('resultList').replaceChildren();
  $('progressBox').hidden = true; $('progressBar').value = 0; $('consent').checked = false;
  step(0); render(); $('pick').focus();
};
function addResult({ file, url, deleteKey }) {
  const wrap = document.createElement('article'); wrap.className = 'result-card';
  const title = document.createElement('h3'); title.textContent = file.name;
  const row = document.createElement('div'); row.className = 'link-row';
  const field = document.createElement('input'); field.readOnly = true; field.value = url; field.setAttribute('aria-label', `${file.name}の共有URL`);
  field.onclick = () => field.select();
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button primary'; copy.textContent = 'URLをコピー';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); copy.textContent = 'コピーしました ✓'; message('URLをコピーしました。相手に貼り付けて送ってください。'); }
    catch { field.focus(); field.select(); message('URLを選択しました。長押し、またはCtrl+Cでコピーしてください。'); }
  };
  const detail = document.createElement('details'), label = document.createElement('summary'), hint = document.createElement('p');
  label.textContent = '保存期間・削除キーを確認';
  hint.className = 'small'; hint.textContent = `保存期間：${$('lifetime').value}日間（送信先の期限が基準） / 削除キー：${deleteKey}。削除キーは共有相手に送らず控えてください。`;
  detail.append(label, hint); row.append(field, copy); wrap.append(title, row, detail); $('resultList').append(wrap);
  $('results').hidden = false;
}
upload.onclick = async () => {
  if (upload.disabled || busy) return;
  controller = new AbortController(); const files = selection.slice(), lifetime = Number($('lifetime').value); let completed = 0;
  setBusy(true); step(1); $('results').hidden = true; $('resultList').replaceChildren();
  $('progressBox').hidden = false; $('progressBar').value = 0; $('progressText').textContent = '送信を準備しています'; message('安全確認を行っています…');
  try {
    const session = await requestJSON(api, '/api/session', { files: files.map(f => ({ name: f.name, size: f.size })), lifetime, token: challengeToken }, controller.signal);
    await uploadFiles({ api, files, session, signal: controller.signal,
      onProgress: ({ file, fileIndex, percent }) => { $('progressBar').value = percent; $('progressText').textContent = `${fileIndex + 1} / ${files.length}個 · ${percent}%`; message(`「${file.name}」を送信中…`); },
      onResult: value => { completed++; addResult(value); },
    });
    $('progressBar').value = 100; $('progressText').textContent = 'すべてのアップロードが完了しました';
    $('resultTitle').textContent = '送信完了！リンクを共有しよう';
    $('resultDescription').textContent = `${completed}個のファイルを送信しました。URLをコピーして相手に送ってください。`;
    selection = []; input.value = ''; step(2); message('アップロードが完了しました。'); $('resultTitle').focus();
  } catch (e) {
    selection = files.slice(completed);
    $('progressText').textContent = e.name === 'AbortError' ? 'アップロードを中止しました' : 'アップロードを停止しました';
    message(`${e.name === 'AbortError' ? '中止しました。' : e.message} 完了済み：${completed} / ${files.length}個。送信中のファイルは結果を確認できません。自動再送は行いません。`, true);
    if (completed) { $('resultTitle').textContent = `${completed}個の共有リンクを取得しました`; $('resultDescription').textContent = '成功したファイルのURLは、この下からコピーできます。'; step(2); }
    else step(0);
  } finally {
    const outcome = status.textContent, isError = status.classList.contains('error');
    setBusy(false); render(); message(outcome, isError);
    challengeToken = ''; if (challengeId !== undefined) window.turnstile?.reset(challengeId); updateButton();
  }
};
async function initialize() {
  try {
    const configured = window.RAKUTOOLS_CONFIG?.apiBase;
    if (!configured) { $('serviceMessage').textContent = unavailable; return; }
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('設定が無効です。');
    api = url.origin;
    const h = await requestJSON(api, '/api/health', undefined, AbortSignal.timeout(15000));
    if (h.available !== true) { $('serviceMessage').textContent = h.message || unavailable; return; }
    for (const k of ['maxFiles', 'maxFileSize', 'maxTotalSize']) if (!Number.isSafeInteger(h[k]) || h[k] < 1) throw Error('送信設定が無効です。');
    if (typeof h.siteKey !== 'string' || !h.siteKey) throw Error('安全確認の設定が無効です。');
    limits = h;
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
    challengeId = window.turnstile.render('#challenge', {
      sitekey: h.siteKey, action: 'upload', language: 'ja',
      callback: token => { challengeToken = token; updateButton(); },
      'expired-callback': () => { challengeToken = ''; updateButton(); },
      'error-callback': () => { challengeToken = ''; message('安全確認に失敗しました。接続を確認して再読み込みしてください。', true); updateButton(); },
    });
    available = true; $('serviceNotice').hidden = true;
    $('limits').textContent = `一度に${h.maxFiles}個・合計${formatSize(h.maxTotalSize)}まで`;
    render();
  } catch { $('serviceTitle').textContent = '現在、送信サーバーに接続できません'; $('serviceMessage').textContent = 'ファイルは送信されません。時間をおいて再読み込みしてください。'; }
  finally { updateButton(); }
}
render(); initialize();
