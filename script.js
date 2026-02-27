// freee Transaction Matcher v1.0
const STORAGE_KEY_DICTIONARY = 'freee_matcher_dict';
const STORAGE_KEY_HIDE_MATCHED = 'freee_matcher_hide_matched';

console.log('%c[FreeeMatcher] Script active (v1.0)', 'color: #facc15; font-weight: bold; font-size: 1.2em;');

// デバッグ用
let lastDebugInfo = {
    version: "1.0",
    timestamp: null,
    totalRows: 0,
    foundDescCells: 0,
    foundFileCells: 0,
    pairingSuccess: 0,
    results: []
};

// --- 正規化 ---
function normalize(str) {
    if (!str) return "";
    return str.trim().toLowerCase()
        .replace(/[！-～]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
        .replace(/[\s\u3000]+/g, '')
        .replace(/[-ーｰ・.（）()]/g, '')
        .replace(/(株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\))/g, '');
}

async function getDictionary() {
    try {
        if (!chrome.runtime?.id) return {};
        const result = await chrome.storage.local.get(STORAGE_KEY_DICTIONARY);
        return result[STORAGE_KEY_DICTIONARY] || {};
    } catch (e) { return {}; }
}

async function addToDictionary(desc, attr) {
    const dict = await getDictionary();
    const key = `${normalize(desc)}|${normalize(attr)}`;
    dict[key] = { desc, attr, date: new Date().toISOString() };
    await chrome.storage.local.set({ [STORAGE_KEY_DICTIONARY]: dict });
    processRows();
}

async function addManyToDictionary(pairs) {
    if (!pairs || !pairs.length) return 0;
    const dict = await getDictionary();
    let added = 0;
    pairs.forEach((p) => {
        const desc = (p.desc || '').trim();
        const attr = (p.attr || '').trim();
        if (!desc || !attr) return;
        const key = `${normalize(desc)}|${normalize(attr)}`;
        if (!dict[key]) {
            dict[key] = { desc, attr, date: new Date().toISOString() };
            added++;
        }
    });
    await chrome.storage.local.set({ [STORAGE_KEY_DICTIONARY]: dict });
    processRows();
    return added;
}

async function removeFromDictionary(key) {
    const dict = await getDictionary();
    delete dict[key];
    await chrome.storage.local.set({ [STORAGE_KEY_DICTIONARY]: dict });
    processRows();
}

function isMatched(desc, attr, dict) {
    const nD = normalize(desc);
    const nA = normalize(attr);
    if (!nD || !nA) return true;
    if (nD === nA) return true;
    return !!dict[`${nD}|${nA}`];
}

async function checkMatch(desc, attr, dict) {
    return isMatched(desc, attr, dict);
}

// --- テキスト抽出 ---
function extractPureText(element) {
    if (!element) return "";
    const textSpan = element.querySelector('.vb-text, [class*="Text"], [class*="Label"]');
    if (textSpan) return textSpan.innerText.trim();

    // SVGを除外してテキストを結合
    let text = "";
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walk.nextNode()) {
        if (node.parentElement.tagName === 'SVG' || node.parentElement.closest('svg')) continue;
        text += node.textContent;
    }
    return text.trim();
}

function getRowKeyFromAttr(value) {
    if (!value) return null;
    const m = value.match(/__([0-9]+(?:-[0-9]+)?)(?:__|$)/);
    if (!m) return null;
    const tableMatch = value.match(/(tb-id_\d+)/);
    const tableId = tableMatch ? tableMatch[1] : 'tb';
    return `${tableId}:${m[1]}`;
}

function getRowElement(cell) {
    if (!cell) return null;
    return cell.closest('tr, [role="row"]');
}

// --- メインロジック ---
let hideMatched = false;

async function processRows() {
    if (!chrome.runtime?.id) return;
    const dict = await getDictionary();
    const storageObj = await chrome.storage.local.get(STORAGE_KEY_HIDE_MATCHED);
    hideMatched = storageObj[STORAGE_KEY_HIDE_MATCHED] || false;

    // 繝・ヰ繝・げ諠・ｱ
    lastDebugInfo.timestamp = new Date().toLocaleTimeString();
    lastDebugInfo.results = [];

    const descTargets = Array.from(document.querySelectorAll(
        '[headers*="wallet_txn_description"], [id*="wallet_txn_description"], svg[aria-label="明細の内容"]'
    ));
    const fileTargets = Array.from(document.querySelectorAll(
        '[headers*="receipts"], [id*="receipts"], svg[aria-label="発行元"]'
    ));

    const groups = new Map();
    let fallbackId = 0;

    const getRowKey = (cell) => {
        const keyFromId = getRowKeyFromAttr(cell.getAttribute('id'));
        if (keyFromId) return keyFromId;
        const keyFromAria = getRowKeyFromAttr(cell.getAttribute('aria-labelledby'));
        if (keyFromAria) return keyFromAria;
        const keyFromHeaders = getRowKeyFromAttr(cell.getAttribute('headers'));
        if (keyFromHeaders) return keyFromHeaders;

        const row = getRowElement(cell);
        if (row) {
            if (!row.dataset.freeeMatcherRowkey) {
                row.dataset.freeeMatcherRowkey = `row-${fallbackId++}`;
            }
            return row.dataset.freeeMatcherRowkey;
        }
        return `cell-${fallbackId++}`;
    };

    const addToGroup = (cell, type) => {
        const row = getRowElement(cell);
        const key = getRowKey(cell);
        const group = groups.get(key) || { rows: new Set(), descCell: null, fileCell: null, descText: "", fileText: "" };
        if (row) group.rows.add(row);
        if (type === 'desc') {
            group.descCell = cell;
            group.descText = extractPureText(cell);
        } else if (type === 'file') {
            group.fileCell = cell;
            group.fileText = extractPureText(cell);
        }
        groups.set(key, group);
    };

    const descCells = new Set();
    const fileCells = new Set();

    descTargets.forEach(el => {
        const cell = el.closest('td, [role="gridcell"]');
        if (!cell) return;
        descCells.add(cell);
        addToGroup(cell, 'desc');
    });

    fileTargets.forEach(el => {
        const cell = el.closest('td, [role="gridcell"]');
        if (!cell) return;
        fileCells.add(cell);
        addToGroup(cell, 'file');
    });

    lastDebugInfo.foundDescCells = descCells.size;
    lastDebugInfo.foundFileCells = fileCells.size;

    let pairings = 0;
    groups.forEach(group => {
        const rows = Array.from(group.rows);
        const entry = {
            key: null,
            desc: group.descText || "",
            file: group.fileText || "",
            matched: false,
            rowCount: rows.length
        };
        if (group.descCell || group.fileCell) {
            const keySource = (group.descCell && (group.descCell.getAttribute('id') || group.descCell.getAttribute('aria-labelledby') || group.descCell.getAttribute('headers'))) ||
                (group.fileCell && (group.fileCell.getAttribute('id') || group.fileCell.getAttribute('aria-labelledby') || group.fileCell.getAttribute('headers'))) || "";
            entry.key = getRowKeyFromAttr(keySource);
        }
        if (group.descCell && group.fileCell) {
            pairings++;
            entry.matched = isMatched(group.descText, group.fileText, dict);
            applyUI(rows, group.descCell, group.fileCell, group.descText, group.fileText, dict);
        } else {
            rows.forEach(row => {
                row.classList.remove('freee-matcher-row-mismatch');
                row.classList.remove('freee-matcher-row-mismatch-top');
                row.classList.remove('freee-matcher-row-mismatch-bottom-unused');
                row.classList.remove('freee-matcher-hidden-row');
                row.removeAttribute('data-is-matched');
                row.querySelectorAll('.freee-matcher-btn').forEach(btn => btn.remove());
            });
        }
        lastDebugInfo.results.push(entry);
    });

    lastDebugInfo.pairingSuccess = pairings;
    lastDebugInfo.totalRows = groups.size;
}

function applyUI(rows, descCell, fileCell, desc, attr, dict) {
    const rowList = Array.isArray(rows) ? rows : [rows].filter(Boolean);
    checkMatch(desc, attr, dict).then(matched => {
        rowList.forEach(row => {
            row.classList.remove('freee-matcher-row-mismatch');
            row.classList.remove('freee-matcher-row-mismatch-top');
            row.classList.remove('freee-matcher-row-mismatch-bottom-unused');
            row.classList.remove('freee-matcher-hidden-row');
        });

        rowList.forEach(row => {
            row.querySelectorAll('.freee-matcher-btn').forEach(btn => btn.remove());
        });

        if (!matched) {
            const sorted = rowList.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            const firstRow = sorted[0];
            const lastRow = sorted[sorted.length - 1];
            rowList.forEach(row => {
                row.classList.add('freee-matcher-row-mismatch');
                if (row === firstRow) row.classList.add('freee-matcher-row-mismatch-top');
                if (row === lastRow) row.classList.add('freee-matcher-row-mismatch-bottom-unused');
                row.setAttribute('data-is-matched', 'false');
            });

            const btn = document.createElement('button');
            btn.className = 'freee-matcher-btn';
            btn.innerText = '一致登録';
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm(`「${desc}」と「${attr}」を一致として登録しますか？`)) {
                    addToDictionary(desc, attr);
                }
            };
            fileCell.style.position = 'relative';
            fileCell.appendChild(btn);
        } else {
            rowList.forEach(row => row.setAttribute('data-is-matched', 'true'));
            if (hideMatched) {
                rowList.forEach(row => row.classList.add('freee-matcher-hidden-row'));
            }
        }
    });
}

// --- UI コンポーネント ---
function injectToolbar() {
    // UIは拡張ポップアップへ移動
}

async function showDictionary() {
    const dict = await getDictionary();
    const overlay = document.createElement('div');
    overlay.className = 'freee-matcher-overlay';
    overlay.onclick = () => overlay.remove();

    const modal = document.createElement('div');
    modal.className = 'freee-matcher-modal';
    modal.onclick = (e) => e.stopPropagation();

    modal.innerHTML = `
        <h3>一致登録済みリスト (v1.0)</h3>
        <div class="freee-matcher-manual-form">
            <strong>手動登録:</strong>
            <input type="text" id="fm-desc" placeholder="明細側の文字列">
            <input type="text" id="fm-attr" placeholder="添付ファイル側の文字列">
            <button class="freee-matcher-btn-manual" id="fm-add">追加</button>
        </div>
        <div id="fm-list"></div>
        <button class="freee-matcher-dict-btn" style="width:100%; margin-top:20px; height: 40px;" onclick="document.querySelector('.freee-matcher-overlay').remove()">閉じる</button>
    `;

    const list = modal.querySelector('#fm-list');
    Object.keys(dict).forEach(key => {
        const item = document.createElement('div');
        item.className = 'freee-matcher-dict-item';
        item.innerHTML = `
            <span>${dict[key].desc} ↔ ${dict[key].attr}</span>
            <span class="freee-matcher-del-btn">×</span>
        `;
        item.querySelector('.freee-matcher-del-btn').onclick = () => {
            if (confirm('削除しますか？')) {
                removeFromDictionary(key);
                overlay.remove();
                showDictionary();
            }
        };
        list.appendChild(item);
    });

    modal.querySelector('#fm-add').onclick = async () => {
        const d = modal.querySelector('#fm-desc').value.trim();
        const a = modal.querySelector('#fm-attr').value.trim();
        if (d && a) {
            await addToDictionary(d, a);
            overlay.remove();
            showDictionary();
        }
    };

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

// --- 初期化 ---
let throttleTimer;
const observer = new MutationObserver(() => {
    if (!chrome.runtime?.id) return;
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
        processRows();
        throttleTimer = null;
    }, 1500);
});

(async () => {
    try {
        const storageObj = await chrome.storage.local.get(STORAGE_KEY_HIDE_MATCHED);
        hideMatched = storageObj[STORAGE_KEY_HIDE_MATCHED] || false;
        observer.observe(document.body, { childList: true, subtree: true });
        processRows();
    } catch (e) { }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'getHideMatched') {
        sendResponse({ hideMatched });
        return;
    }
    if (message.type === 'setHideMatched') {
        hideMatched = !!message.value;
        chrome.storage.local.set({ [STORAGE_KEY_HIDE_MATCHED]: hideMatched }).then(() => {
            processRows();
            sendResponse({ ok: true });
        });
        return true;
    }
    if (message.type === 'getDebugInfo') {
        sendResponse({ debug: lastDebugInfo });
        return;
    }
    if (message.type === 'getPairings') {
        sendResponse({ pairings: lastDebugInfo.results || [] });
        return;
    }
    if (message.type === 'openDictionary') {
        showDictionary();
        sendResponse({ ok: true });
        return;
    }
    if (message.type === 'importPairs') {
        const pairs = Array.isArray(message.pairs) ? message.pairs : [];
        addManyToDictionary(pairs).then((added) => {
            sendResponse({ ok: true, added });
        });
        return true;
    }
});
