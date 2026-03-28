// api/notify.js
// 定時檢查資金費率，發現 ≥ 閾值的套利機會就通知 Telegram
// Vercel Cron：每 10 分鐘執行一次

export const config = {
  maxDuration: 60,
};

// ── 設定 ──────────────────────────────────────────────
const THRESHOLD    = parseFloat(process.env.NOTIFY_THRESHOLD || '0.01');  // 預設 1%（年化）
const RAW_THRESHOLD = THRESHOLD / (3 * 365);  // 轉換成每次結算費率差
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID;

const FEES = {
  binance:.0005, bybit:.0006, okx:.0005,
  bitget:.0006,  mexc:.0002,  kucoin:.0006,
};
const EXL = {
  binance:'Binance', bybit:'Bybit', okx:'OKX',
  bitget:'Bitget',   mexc:'MEXC',   kucoin:'KuCoin',
};

export default async function handler(req, res) {
  // 驗證：只允許 Vercel Cron 或帶正確 secret 的手動呼叫
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Vercel Cron 會自動帶 CRON_SECRET，手動測試可以跳過
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    if (!isVercelCron) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    return res.status(500).json({
      error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables',
    });
  }

  try {
    // 1. 抓資金費率資料（直接呼叫同一台伺服器的 funding API）
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const r = await fetch(`${baseUrl}/api/funding?t=${Date.now()}`);
    const j = await r.json();

    if (!j.success || !j.data?.length) {
      return res.status(200).json({ sent: 0, message: 'No data' });
    }

    // 2. 篩出淨費差 ≥ 閾值的機會
    // 年化 1% = 每次結算 0.01 / (3*365) ≈ 0.0000091
    // 但實際更直觀：我們用「每次結算淨費差 ≥ 0.001（0.1%）」也就是年化約 109%
    // 所以實際用「年化費差」來判斷，門檻 = THRESHOLD（預設 1 = 100%年化）
    const annualThreshold = THRESHOLD; // 例如 1 = 100%，0.5 = 50%

    const opps = j.data.filter(row => {
      const annual = row.netSpread * 3 * 365;
      return annual >= annualThreshold;
    });

    if (!opps.length) {
      return res.status(200).json({ sent: 0, message: `No opportunity above ${(annualThreshold*100).toFixed(0)}% annual` });
    }

    // 3. 組通知訊息
    const lines = opps.slice(0, 5).map((row, i) => {
      const annual = (row.netSpread * 3 * 365 * 100).toFixed(1);
      const spread = (row.netSpread * 100).toFixed(4);
      const shortP = row.prices?.[row.maxEx] ? formatPrice(row.prices[row.maxEx]) : '—';
      const longP  = row.prices?.[row.minEx] ? formatPrice(row.prices[row.minEx]) : '—';
      const priceDiff = row.priceDiffPct ? `${(row.priceDiffPct*100).toFixed(3)}%` : '—';

      return [
        `${i+1}. 🪙 *${row.symbol}/USDT*`,
        `   做空 ${EXL[row.maxEx]} (${shortP}) | 做多 ${EXL[row.minEx]} (${longP})`,
        `   淨費差: *${spread}%* | 年化: *${annual}%*`,
        `   價格差: ${priceDiff}`,
      ].join('\n');
    });

    const now = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });

    const msg = [
      `📡 *資金費率套利警報*`,
      `🕐 ${now}（台北時間）`,
      `🎯 找到 *${opps.length}* 個年化 ≥ ${(annualThreshold*100).toFixed(0)}% 的機會`,
      ``,
      lines.join('\n\n'),
      ``,
      `💡 _每 1000 USDT 投入、持倉1天的估算：_`,
      ...opps.slice(0, 3).map(row => {
        const earn = (1000 * row.netSpread * 3 - 1000 * row.totalFee).toFixed(2);
        return `• ${row.symbol}: 約 *+${earn} USDT*/天`;
      }),
      ``,
      `⚠️ 僅供參考，不構成投資建議`,
    ].join('\n');

    // 4. 發送 Telegram 訊息
    await sendTelegram(msg);

    return res.status(200).json({
      sent: 1,
      opportunities: opps.length,
      top: opps[0]?.symbol,
    });

  } catch (err) {
    console.error('[notify] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram error: ${j.description}`);
  return j;
}

function formatPrice(p) {
  if (!p || isNaN(p)) return '—';
  return p >= 10000
    ? p.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : p >= 100
    ? p.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : p.toFixed(4);
}
