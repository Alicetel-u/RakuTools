export const formatSize = bytes => {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / 1024 ** i).toLocaleString('ja-JP', { maximumFractionDigits: i ? 1 : 0 }) + ' ' + units[i];
};
export function validateFiles(files, limits) {
  if (!files.length) return 'ファイルを選んでください。';
  if (files.length > limits.maxFiles) return `一度に選べるファイルは${limits.maxFiles}個までです。`;
  for (const file of files) {
    if (!file.name.trim() || file.name.length > 255 || /[\u0000-\u001f\u007f]/.test(file.name)) return 'ファイル名を短くし、制御文字を除いて選び直してください。';
    if (file.size > limits.maxFileSize) return `「${file.name}」は上限の${formatSize(limits.maxFileSize)}を超えています。`;
  }
  if (files.reduce((n, f) => n + f.size, 0) > limits.maxTotalSize) return `合計サイズは${formatSize(limits.maxTotalSize)}までです。`;
  return '';
}
export async function requestJSON(api, path, data, signal) {
  const response = await fetch(api + path, {
    method: data ? 'POST' : 'GET', signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined,
  });
  let value;
  try { value = await response.json(); } catch { throw Error('サーバーの応答を確認できません。'); }
  if (!response.ok) throw Error(value.error || `通信エラー (${response.status})`);
  return value;
}
export function sendChunk(url, token, bytes, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const aborted = () => xhr.abort();
    if (signal.aborted) { reject(new DOMException('中止しました', 'AbortError')); return; }
    xhr.open('POST', url); xhr.timeout = 180000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw Error(data.error || `通信エラー (${xhr.status})`);
        resolve(data);
      } catch (e) { reject(e instanceof SyntaxError ? Error('送信結果を確認できません。') : e); }
    };
    xhr.onerror = () => reject(Error('通信が途切れました。ネットワークの接続をご確認ください。'));
    xhr.ontimeout = () => reject(Error('通信に時間がかかりすぎたため停止しました。'));
    xhr.onabort = () => reject(new DOMException('中止しました', 'AbortError'));
    xhr.onloadend = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true }); xhr.send(bytes);
  });
}
export async function uploadFiles({ api, files, session, signal, onProgress, onResult, send = sendChunk }) {
  if (!Number.isSafeInteger(session.chunkSize) || session.chunkSize < 1 || session.chunkSize > 8 * 1024 * 1024) throw Error('送信設定が無効です。');
  const total = files.reduce((n, f) => n + Math.max(1, f.size), 0); let confirmed = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]; const chunks = Math.max(1, Math.ceil(file.size / session.chunkSize));
    for (let index = 0; index < chunks; index++) {
      signal.throwIfAborted();
      const start = index * session.chunkSize, end = Math.min(file.size, start + session.chunkSize);
      const update = loaded => onProgress({ file, fileIndex, percent: Math.min(99, Math.floor((confirmed + loaded) / total * 100)) });
      update(0);
      const url = api + `/api/chunk?session=${encodeURIComponent(session.session)}&file=${fileIndex}&chunk=${index}`;
      const result = await send(url, session.token, file.slice(start, end), signal, update);
      confirmed += Math.max(end - start, file.size === 0 ? 1 : 0);
      if (index === chunks - 1) {
        let link;
        try { link = new URL(result.url); } catch { throw Error('共有リンクを確認できませんでした。'); }
        if (result.complete !== true || link.protocol !== 'https:' || !/^\d+\.gigafile\.nu$/.test(link.host) || link.username || link.password || link.search || link.hash || !/^\/\d{4}-[a-zA-Z0-9]+$/.test(link.pathname) || !/^[a-zA-Z0-9]{4}$/.test(result.deleteKey || '')) throw Error('共有リンクの形式が無効です。');
        onResult({ file, url: link.href, deleteKey: result.deleteKey });
      } else if (result.complete !== false) throw Error('送信先の応答が想定と異なります。');
    }
  }
}
