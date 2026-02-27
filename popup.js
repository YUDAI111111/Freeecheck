const statusEl = document.getElementById('status');

function setStatus(message) {
  statusEl.textContent = message || '';
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      if (!tabs || !tabs.length) {
        reject(new Error('Active tab not found'));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function sendToActiveTab(message) {
  return getActiveTab().then((tab) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  }));
}

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function normalizePairs(rows) {
  return rows.map((row) => {
    const desc = row.desc || row.description || row.wallet_txn_description || '';
    const attr = row.attr || row.file || row.receipts || row.attachment || '';
    return { desc, attr };
  }).filter((p) => p.desc && p.attr);
}

document.getElementById('open-dict').addEventListener('click', async () => {
  try {
    await sendToActiveTab({ type: 'openDictionary' });
    setStatus('辞書管理を開きました。');
  } catch (e) {
    setStatus('辞書管理を開けませんでした。');
  }
});

async function syncToggle() {
  try {
    const res = await sendToActiveTab({ type: 'getHideMatched' });
    const isOn = !!res?.hideMatched;
    const btn = document.getElementById('toggle-hide');
    if (btn) {
      btn.classList.toggle('is-on', isOn);
    }
  } catch (e) {
    setStatus('表示状態を取得できませんでした。');
  }
}

document.getElementById('toggle-hide').addEventListener('click', async () => {
  try {
    const res = await sendToActiveTab({ type: 'getHideMatched' });
    const next = !res?.hideMatched;
    await sendToActiveTab({ type: 'setHideMatched', value: next });
    const btn = document.getElementById('toggle-hide');
    if (btn) btn.classList.toggle('is-on', next);
    setStatus(next ? '不一致のみ表示: ON' : '不一致のみ表示: OFF');
  } catch (e) {
    setStatus('切り替えに失敗しました。');
  }
});

syncToggle();

document.getElementById('copy-debug').addEventListener('click', async () => {
  try {
    const res = await sendToActiveTab({ type: 'getDebugInfo' });
    const text = JSON.stringify(res?.debug || {}, null, 2);
    await navigator.clipboard.writeText(text);
    setStatus('デバッグ情報をコピーしました。');
  } catch (e) {
    setStatus('デバッグ情報を取得できませんでした。');
  }
});

document.getElementById('export-json').addEventListener('click', async () => {
  try {
    const res = await sendToActiveTab({ type: 'getPairings' });
    const data = res?.pairings || [];
    const name = `freee_pairings_${formatTimestamp()}.json`;
    downloadText(name, JSON.stringify(data, null, 2), 'application/json');
    setStatus('JSONをエクスポートしました。');
  } catch (e) {
    setStatus('JSONエクスポートに失敗しました。');
  }
});

document.getElementById('import-file').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let rows = [];
    if (file.name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(text);
      rows = Array.isArray(json) ? json : (json.pairings || []);
    } else {
      setStatus('JSONのみ対応しています。');
      return;
    }
    const pairs = normalizePairs(rows);
    if (!pairs.length) {
      setStatus('インポート対象が見つかりませんでした。');
      return;
    }
    const res = await sendToActiveTab({ type: 'importPairs', pairs });
    setStatus(`インポート完了: ${res?.added ?? 0}件`);
  } catch (err) {
    setStatus('インポートに失敗しました。');
  } finally {
    e.target.value = '';
  }
});
