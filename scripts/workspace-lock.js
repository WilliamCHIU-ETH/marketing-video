/**
 * 共享工作區的互斥鎖。
 *
 * 為什麼需要：解析器把輸出寫進**全域固定路徑**（src/*.generated.json、public/），
 * 那是整個 app checkout 共用的。兩個 session 同時跑就會互相蓋，而且是**靜默**蓋掉 ——
 * 沒有錯誤、沒有警告，只有第二支影片拿到第一支的配圖計畫。
 * parse-institution-script.js 的註解「一次只跑一個 template，互不衝突」正是這個假設，
 * 而使用者常態同時開 3–4 個 session，那個假設早就不成立了。
 *
 * run.js 已經有同一把鎖（run.js:1201，`openSync(file, 'wx')`），但只在走完整產線時取。
 * agent 從 bash 直接呼叫解析器就完全繞過去 —— 2026-08-25 的日報產線就是這樣跑的。
 * 這支模組把同一把鎖延伸到腳本層，用**同一個檔案**、同一個原語，兩邊互相擋得住。
 *
 * 注意這只解決「靜默互蓋」，不解決「不能同時跑」。要真正並行，
 * 得把輸出改成每次執行一個目錄（觸及 31 個非測試檔，四個產品線一起動）。
 * 那是另一件事，不在這裡。
 *
 *   const { acquire } = require('./workspace-lock');
 *   acquire('parse-script');   // 取不到就印出佔用者並 exit 1
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(APP_ROOT, '.run.lock');
// run.js 取鎖後設成 '1'，讓它 spawn 的子行程知道鎖已經在自己這條 process 樹上。
const INHERIT_ENV = 'MV_WORKSPACE_LOCK_HELD';

function describeHolder() {
  let raw;
  try { raw = fs.readFileSync(LOCK_FILE, 'utf8'); } catch { return '（讀不到 lock 內容）'; }
  let owner;
  try { owner = JSON.parse(raw); } catch { return `（lock 內容無法解析：${raw.slice(0, 80)}）`; }
  const bits = [];
  if (owner.pid) {
    let alive = null;
    try { process.kill(owner.pid, 0); alive = true; }
    catch (e) { alive = e.code === 'EPERM'; }
    bits.push(`pid ${owner.pid}${alive ? '（仍在執行）' : '（已不存在 —— 可能是上次沒清乾淨）'}`);
  }
  if (owner.label) bits.push(`來源 ${owner.label}`);
  if (owner.startedAt) bits.push(`開始於 ${owner.startedAt}`);
  return bits.join('、') || '（lock 沒有記錄擁有者）';
}

/**
 * 取得工作區鎖。取不到就直接結束行程 —— 不等待、不重試、不強制刪除。
 * 回傳一個 release 函式；正常情況不需要自己呼叫，process exit 時會自動清。
 *
 * @param {string} label 誰在用，會寫進 lock 供下一個人看
 * @returns {() => void}
 */
function acquire(label) {
  if (!label) throw new Error('acquire 需要 label');

  // 可重入：run.js 取到鎖之後才會去 spawn 這些解析器（run.js:1399/1406/1415/1430），
  // 子行程再搶一次同一把鎖必然 EEXIST，整條產線會死在自己手上。
  // run.js 取鎖後設這個環境變數，execSync 預設繼承 process.env，所以子行程認得出
  // 「鎖已經在我這條 process 樹上」。外面的人直接跑腳本時沒有這個變數，照常搶鎖。
  if (process.env[INHERIT_ENV] === '1') {
    return () => {};   // 鎖是父行程的，不能由子行程釋放
  }

  let fd;
  try {
    // 'wx' 才是真正的互斥。existsSync 之後再 writeFileSync 會讓兩支同時執行的都成功。
    fd = fs.openSync(LOCK_FILE, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.error(`❌ 工作區被佔用中，${label} 不執行。`);
    console.error(`   佔用者：${describeHolder()}`);
    console.error(`   ${path.relative(process.cwd(), LOCK_FILE) || LOCK_FILE}`);
    console.error('   同時跑會靜默蓋掉對方的 src/*.generated.json 與 public/，所以這裡直接擋下。');
    console.error('   確認佔用者真的死了再手動刪 lock —— 不要在不確定的情況下強制刪除。');
    process.exit(1);
  }

  const ownership = { pid: process.pid, startedAt: new Date().toISOString(), label };
  try { fs.writeFileSync(fd, JSON.stringify(ownership)); }
  finally { fs.closeSync(fd); }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(LOCK_FILE); } catch { /* 已經被清掉就算了 */ }
  };
  process.on('exit', release);
  // 關終端機／Ctrl+C／kill 也要清，不然下一次會卡在一個沒有主人的 lock 上。
  for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.on(sig, () => { release(); process.exit(1); });
  }
  return release;
}

module.exports = { acquire, LOCK_FILE, INHERIT_ENV };
