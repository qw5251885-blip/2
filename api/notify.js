// api/notify.js  ── 修正版
// 直接抓各交易所資料，不依賴內部 API 呼叫

export const config = { maxDuration: 60 };

const THRESHOLD = parseFloat(process.env.NOTIFY_THRESHOLD || '1'); // 年化倍數，1=100%
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const FEES = { binance:.0005,bybit:.0006,okx:.0005,bitget:.0006,mexc:.0002,kucoin:.0006 };
const EXL  = { binance:'Binance',bybit:'Bybit',okx:'OKX',bitget:'Bitget',mexc:'MEXC',kucoin:'KuCoin' };
const EX_ALL = ['binance','bybit','okx','bitget','mexc','kucoin'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');

  if (!BOT_TOKEN || !CHAT_ID) {
    return res.status(500).json({ error:'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' });
  }

  try {
    // ── 1. 抓所有交易所資料 ──────────────────────────
    const [binanceRes,bybitRes,okxRes,bitgetRes,mexcRes,kucoinRes] =
      await Promise.allSettled([
        fetchBinance(), fetchBybit(), fetchOKX(),
        fetchBitget(),  fetchMEXC(),  fetchKuCoin(),
      ]);

    const merged = {};
    function mergeIn(result, ex) {
      if (result.status !== 'fulfilled') return;
      for (const item of result.value) {
        if (!merged[item.symbol]) merged[item.symbol] = { symbol: item.symbol };
        merged[item.symbol][ex]         = item.rate;
        merged[item.symbol][ex+'Last']  = item.lastPrice ?? null;
        if (item.nextFunding) merged[item.symbol][ex+'Next'] = item.nextFunding;
      }
    }
    mergeIn(binanceRes,'binance'); mergeIn(bybitRes,'bybit');
    mergeIn(okxRes,'okx');         mergeIn(bitgetRes,'bitget');
    mergeIn(mexcRes,'mexc');       mergeIn(kucoinRes,'kucoin');

    // ── 2. 計算套利機會 ──────────────────────────────
    const opps = Object.values(merged).map(row => {
      const avail = EX_ALL.filter(e => row[e] !== undefined);
      if (avail.length < 2) return null;
      let maxEx=null,minEx=null,maxRate=-Infinity,minRate=Infinity;
      for (const e of avail) {
        if (row[e]>maxRate){maxRate=row[e];maxEx=e;}
        if (row[e]<minRate){minRate=row[e];minEx=e;}
      }
      const spread    = maxRate - minRate;
      const totalFee  = (FEES[maxEx]+FEES[minEx])*2;
      const netSpread = spread - totalFee;
      const annual    = netSpread * 3 * 365;
      return { ...row, spread, netSpread, totalFee, maxEx, minEx, annual };
    })
    .filter(r => r && r.annual >= THRESHOLD)
    .sort((a,b) => b.annual - a.annual);

    if (!opps.length) {
      return res.status(200).json({
        sent: 0,
        message: `目前無年化 >= ${(THRESHOLD*100).toFixed(0)}% 的機會`,
      });
    }

    // ── 3. 組 Telegram 訊息 ──────────────────────────
    const now = new Date().toLocaleString('zh-TW', {
      timeZone:'Asia/Taipei',
      month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',
    });

    const topLines = opps.slice(0,5).map((row,i) => {
      const annual  = (row.annual*100).toFixed(1);
      const net     = (row.netSpread*100).toFixed(4);
      const earn1k  = (1000*row.netSpread*3 - 1000*row.totalFee).toFixed(2);
      const sp      = row[row.maxEx+'Last'] ? fP(row[row.maxEx+'Last']) : '-';
      const lp      = row[row.minEx+'Last'] ? fP(row[row.minEx+'Last']) : '-';
      return [
        `${i+1}. *${row.symbol}/USDT*`,
        `   做空 ${EXL[row.maxEx]} (${sp}) | 做多 ${EXL[row.minEx]} (${lp})`,
        `   淨費差 *${net}%* | 年化 *${annual}%*`,
        `   1000U/天估算：*+${earn1k} USDT*`,
      ].join('\n');
    }).join('\n\n');

    const msg = [
      `📡 *資金費率套利警報*`,
      `🕐 ${now} 台北時間`,
      `🎯 找到 *${opps.length}* 個年化 >= ${(THRESHOLD*100).toFixed(0)}% 的機會`,
      ``,
      topLines,
      ``,
      `⚠️ 僅供參考，不構成投資建議`,
    ].join('\n');

    await sendTG(msg);

    return res.status(200).json({
      sent: 1,
      opportunities: opps.length,
      top: opps[0].symbol,
      annual: (opps[0].annual*100).toFixed(1)+'%',
    });

  } catch(err) {
    console.error('[notify]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Telegram 發送 ────────────────────────────────────
async function sendTG(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description}`);
}

function fP(p) {
  if(!p||isNaN(p))return'-';
  return p>=10000?p.toLocaleString('en-US',{maximumFractionDigits:0}):
         p>=100  ?p.toLocaleString('en-US',{maximumFractionDigits:2}):p.toFixed(4);
}

// ══ 各交易所抓取 ══════════════════════════════════════

const HDRS = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'application/json,text/plain,*/*',
  'Accept-Language':'en-US,en;q=0.9',
  'Cache-Control':'no-cache',
};

async function get(url, ms=8000) {
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),ms);
  try {
    const r=await fetch(url,{headers:HDRS,signal:ctrl.signal});
    clearTimeout(tid);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tid); }
}

async function tryUrls(urls, validate) {
  let lastErr;
  for (const url of urls) {
    try { const j=await get(url); if(validate(j))return j; } catch(e){ lastErr=e; }
  }
  throw lastErr;
}

async function fetchBinance() {
  const pi=await tryUrls([
    'https://fapi.binance.com/fapi/v1/premiumIndex',
    'https://fapi1.binance.com/fapi/v1/premiumIndex',
    'https://fapi2.binance.com/fapi/v1/premiumIndex',
  ],j=>Array.isArray(j)&&j.length>0);
  let lastMap={};
  try{const tk=await tryUrls(['https://fapi.binance.com/fapi/v2/ticker/price','https://fapi1.binance.com/fapi/v2/ticker/price'],j=>Array.isArray(j));for(const t of tk)lastMap[t.symbol]=parseFloat(t.price);}catch{}
  return pi.filter(d=>d.symbol.endsWith('USDT')&&d.lastFundingRate!=null).map(d=>({
    symbol:d.symbol.replace('USDT',''),rate:parseFloat(d.lastFundingRate),
    lastPrice:lastMap[d.symbol]||parseFloat(d.indexPrice)||null,
    nextFunding:parseInt(d.nextFundingTime)||null,
  }));
}

async function fetchBybit() {
  const j=await tryUrls([
    'https://api.bybit.com/v5/market/tickers?category=linear',
    'https://api2.bybit.com/v5/market/tickers?category=linear',
    'https://api3.bybit.com/v5/market/tickers?category=linear',
  ],j=>j?.retCode===0);
  return j.result.list.filter(d=>d.symbol.endsWith('USDT')&&d.fundingRate).map(d=>({
    symbol:d.symbol.replace('USDT',''),rate:parseFloat(d.fundingRate),
    lastPrice:parseFloat(d.lastPrice)||null,
    nextFunding:d.nextFundingTime?parseInt(d.nextFundingTime):null,
  }));
}

async function fetchOKX() {
  const j=await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  if(j.code!=='0') throw new Error('OKX: '+j.msg);
  const syms=j.data.filter(d=>d.instId.endsWith('-USDT-SWAP')).map(d=>d.instId);
  const results=[];
  for(let i=0;i<Math.min(syms.length,120);i+=20){
    const batch=syms.slice(i,i+20);
    const fetched=await Promise.allSettled(batch.map(id=>get(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`)));
    for(const f of fetched){
      if(f.status==='fulfilled'&&f.value.code==='0'&&f.value.data?.[0]){
        const d=f.value.data[0];
        results.push({symbol:d.instId.replace('-USDT-SWAP',''),rate:parseFloat(d.fundingRate),lastPrice:null,nextFunding:d.nextFundingTime?parseInt(d.nextFundingTime):null});
      }
    }
  }
  try{const tk=await get('https://www.okx.com/api/v5/market/tickers?instType=SWAP');if(tk.code==='0'){const pm={};for(const t of tk.data)pm[t.instId]=parseFloat(t.last);for(const r of results)r.lastPrice=pm[r.symbol+'-USDT-SWAP']||null;}}catch{}
  return results;
}

async function fetchBitget() {
  const j=await get('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if(j.code!=='00000') throw new Error('Bitget: '+j.msg);
  return(j.data||[]).filter(d=>d.symbol.endsWith('USDT')&&d.fundingRate).map(d=>({
    symbol:d.symbol.replace('USDT',''),rate:parseFloat(d.fundingRate),
    lastPrice:parseFloat(d.lastPr)||null,nextFunding:null,
  }));
}

async function fetchMEXC() {
  const tk=await get('https://api.mexc.com/api/v1/contract/ticker');
  if(!tk.success) throw new Error('MEXC ticker error');
  const tickerMap={};
  for(const t of(tk.data||[])){if(t.symbol&&t.symbol.endsWith('_USDT'))tickerMap[t.symbol]=t;}
  const symbols=Object.keys(tickerMap);
  if(!symbols.length) throw new Error('MEXC no symbols');
  const results=[];
  for(let i=0;i<Math.min(symbols.length,100);i+=25){
    const batch=symbols.slice(i,i+25);
    const fetched=await Promise.allSettled(batch.map(sym=>get('https://api.mexc.com/api/v1/contract/funding_rate/'+sym)));
    for(let k=0;k<batch.length;k++){
      const sym=batch[k],fr=fetched[k],t=tickerMap[sym];
      if(fr.status==='fulfilled'&&fr.value&&fr.value.success&&fr.value.data){
        const d=fr.value.data;
        results.push({symbol:sym.replace('_USDT',''),rate:parseFloat(d.fundingRate),lastPrice:t?parseFloat(t.lastPrice)||null:null,nextFunding:d.nextSettleTime||null});
      } else if(t&&t.fundingRate!=null){
        results.push({symbol:sym.replace('_USDT',''),rate:parseFloat(t.fundingRate),lastPrice:parseFloat(t.lastPrice)||null,nextFunding:null});
      }
    }
  }
  return results;
}

async function fetchKuCoin() {
  const j=await get('https://api-futures.kucoin.com/api/v1/contracts/active');
  if(j.code!=='200000') throw new Error('KuCoin: '+j.msg);
  return(j.data||[]).filter(d=>d.quoteCurrency==='USDT'&&d.fundingFeeRate!=null).map(d=>({
    symbol:d.baseCurrency==='XBT'?'BTC':d.baseCurrency,
    rate:parseFloat(d.fundingFeeRate),
    lastPrice:parseFloat(d.lastTradePrice)||null,
    nextFunding:d.nextFundingRateTime||null,
  }));
}
