// api/funding.js  ── v6 最終修正版
// 修正 Binance/Bybit 被 WAF 封鎖問題：
//   Binance: 改用備用域名 fapi1.binance.com / fapi2.binance.com
//   Bybit:   自動嘗試 api.bybit.com → api2.bybit.com → api3.bybit.com

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=25, stale-while-revalidate=10');

  const [binanceRes, bybitRes, okxRes, bitgetRes, mexcRes, kucoinRes] =
    await Promise.allSettled([
      fetchBinance(),
      fetchBybit(),
      fetchOKX(),
      fetchBitget(),
      fetchMEXC(),
      fetchKuCoin(),
    ]);

  const merged = {};
  function mergeIn(result, ex) {
    if (result.status !== 'fulfilled') return;
    for (const item of result.value) {
      if (!merged[item.symbol]) merged[item.symbol] = { symbol: item.symbol };
      const r = merged[item.symbol];
      r[ex]        = item.rate;
      r[ex+'Last'] = item.lastPrice  ?? null;
      if (item.nextFunding) r[ex+'Next'] = item.nextFunding;
    }
  }
  mergeIn(binanceRes,'binance'); mergeIn(bybitRes,'bybit');
  mergeIn(okxRes,'okx');         mergeIn(bitgetRes,'bitget');
  mergeIn(mexcRes,'mexc');       mergeIn(kucoinRes,'kucoin');

  const FEES = { binance:.0005, bybit:.0006, okx:.0005, bitget:.0006, mexc:.0002, kucoin:.0006 };
  const EXS  = ['binance','bybit','okx','bitget','mexc','kucoin'];

  const result = Object.values(merged).map(row => {
    const avail = EXS.filter(e => row[e] !== undefined);
    if (avail.length < 2) return null;
    let maxEx=null,minEx=null,maxRate=-Infinity,minRate=Infinity;
    for (const e of avail) {
      if (row[e] > maxRate) { maxRate=row[e]; maxEx=e; }
      if (row[e] < minRate) { minRate=row[e]; minEx=e; }
    }
    const spread    = maxRate - minRate;
    const totalFee  = (FEES[maxEx]+FEES[minEx])*2;
    const netSpread = spread - totalFee;

    // 價格
    const prices = {};
    for (const e of avail) { if (row[e+'Last']) prices[e] = row[e+'Last']; }
    const pList = Object.values(prices);
    let priceDiffPct=null, priceMaxEx=null, priceMinEx=null;
    if (pList.length >= 2) {
      let hi=-Infinity,lo=Infinity;
      for (const [e,p] of Object.entries(prices)) {
        if (p>hi){hi=p;priceMaxEx=e;} if (p<lo){lo=p;priceMinEx=e;}
      }
      priceDiffPct = (hi-lo)/lo;
    }
    return { ...row, spread, netSpread, maxEx, minEx, maxRate, minRate,
             totalFee, prices, priceDiffPct, priceMaxEx, priceMinEx };
  }).filter(r=>r&&r.spread>0).sort((a,b)=>b.netSpread-a.netSpread);

  const exchangeStatus = {};
  const resMap = { binance:binanceRes,bybit:bybitRes,okx:okxRes,bitget:bitgetRes,mexc:mexcRes,kucoin:kucoinRes };
  for (const [e,r] of Object.entries(resMap))
    exchangeStatus[e] = r.status==='fulfilled' ? 'ok' : (r.reason?.message||'error');

  res.status(200).json({ success:true, data:result, exchangeStatus, updatedAt:Date.now() });
}

// ══ 通用請求工具 ══════════════════════════════════════
const HDRS = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'application/json,text/plain,*/*',
  'Accept-Language':'en-US,en;q=0.9',
  'Cache-Control':'no-cache',
};

async function get(url, ms=9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(()=>ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers:HDRS, signal:ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(tid); }
}

// 依序嘗試多個 URL，成功就回傳
async function tryUrls(urls, validate) {
  let lastErr;
  for (const url of urls) {
    try {
      const j = await get(url);
      if (validate(j)) return j;
      lastErr = new Error('validate failed');
    } catch(e) { lastErr = e; }
  }
  throw lastErr;
}

// ══ Binance ═══════════════════════════════════════════
// 官方有三個備用域名：fapi.binance.com / fapi1.binance.com / fapi2.binance.com
async function fetchBinance() {
  const piData = await tryUrls([
    'https://fapi.binance.com/fapi/v1/premiumIndex',
    'https://fapi1.binance.com/fapi/v1/premiumIndex',
    'https://fapi2.binance.com/fapi/v1/premiumIndex',
  ], j => Array.isArray(j) && j.length > 0);

  // 同樣備用抓價格
  let lastMap = {};
  try {
    const tkData = await tryUrls([
      'https://fapi.binance.com/fapi/v2/ticker/price',
      'https://fapi1.binance.com/fapi/v2/ticker/price',
      'https://fapi2.binance.com/fapi/v2/ticker/price',
    ], j => Array.isArray(j));
    for (const t of tkData) lastMap[t.symbol] = parseFloat(t.price);
  } catch {}

  return piData
    .filter(d => d.symbol.endsWith('USDT') && d.lastFundingRate != null)
    .map(d => ({
      symbol:      d.symbol.replace('USDT',''),
      rate:        parseFloat(d.lastFundingRate),
      lastPrice:   lastMap[d.symbol] || parseFloat(d.indexPrice) || null,
      nextFunding: parseInt(d.nextFundingTime)||null,
    }));
}

// ══ Bybit ═════════════════════════════════════════════
// 三個備用端點
async function fetchBybit() {
  const j = await tryUrls([
    'https://api.bybit.com/v5/market/tickers?category=linear',
    'https://api2.bybit.com/v5/market/tickers?category=linear',
    'https://api3.bybit.com/v5/market/tickers?category=linear',
  ], j => j?.retCode === 0);

  return j.result.list
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol:      d.symbol.replace('USDT',''),
      rate:        parseFloat(d.fundingRate),
      lastPrice:   parseFloat(d.lastPrice)||null,
      nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
    }));
}

// ══ OKX ═══════════════════════════════════════════════
async function fetchOKX() {
  const j = await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  if (j.code !== '0') throw new Error('OKX instruments: '+j.msg);

  const syms = j.data.filter(d=>d.instId.endsWith('-USDT-SWAP')).map(d=>d.instId);
  const results = [];
  for (let i=0; i<Math.min(syms.length,120); i+=20) {
    const batch = syms.slice(i,i+20);
    const fetched = await Promise.allSettled(batch.map(id=>
      get(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`)
    ));
    for (const f of fetched) {
      if (f.status==='fulfilled'&&f.value.code==='0'&&f.value.data?.[0]) {
        const d=f.value.data[0];
        results.push({ symbol:d.instId.replace('-USDT-SWAP',''),
          rate:parseFloat(d.fundingRate), lastPrice:null,
          nextFunding:d.nextFundingTime?parseInt(d.nextFundingTime):null });
      }
    }
  }
  // 補 OKX 價格
  try {
    const tk = await get('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    if (tk.code==='0') {
      const pm={};
      for (const t of tk.data) pm[t.instId]=parseFloat(t.last);
      for (const r of results) r.lastPrice=pm[r.symbol+'-USDT-SWAP']||null;
    }
  } catch {}
  return results;
}

// ══ Bitget ════════════════════════════════════════════
async function fetchBitget() {
  const j = await get('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if (j.code!=='00000') throw new Error('Bitget: '+j.msg);
  return (j.data||[]).filter(d=>d.symbol.endsWith('USDT')&&d.fundingRate).map(d=>({
    symbol:d.symbol.replace('USDT',''), rate:parseFloat(d.fundingRate),
    lastPrice:parseFloat(d.lastPr)||null, nextFunding:null,
  }));
}

// ══ MEXC ══════════════════════════════════════════════
async function fetchMEXC() {
  const j = await get('https://api.mexc.com/api/v1/contract/detail');
  if (!j.success) throw new Error('MEXC list error');
  const symbols = (j.data||[]).filter(d=>d.symbol.endsWith('_USDT')).map(d=>d.symbol);
  const results=[];
  for (let i=0; i<Math.min(symbols.length,100); i+=20) {
    const batch=symbols.slice(i,i+20);
    const fetched=await Promise.allSettled(batch.map(sym=>
      Promise.all([
        get(`https://api.mexc.com/api/v1/contract/funding_rate/${sym}`),
        get(`https://api.mexc.com/api/v1/contract/ticker?symbol=${sym}`).catch(()=>null),
      ])
    ));
    for (const f of fetched) {
      if (f.status!=='fulfilled') continue;
      const [fr,tk]=f.value;
      if (fr?.success&&fr.data) results.push({
        symbol:fr.data.symbol.replace('_USDT',''), rate:parseFloat(fr.data.fundingRate),
        lastPrice:tk?.success&&tk.data?parseFloat(tk.data.lastPrice)||null:null,
        nextFunding:fr.data.nextSettleTime||null,
      });
    }
  }
  return results;
}

// ══ KuCoin ════════════════════════════════════════════
async function fetchKuCoin() {
  const j = await get('https://api-futures.kucoin.com/api/v1/contracts/active');
  if (j.code!=='200000') throw new Error('KuCoin: '+j.msg);
  return (j.data||[]).filter(d=>d.quoteCurrency==='USDT'&&d.fundingFeeRate!=null).map(d=>({
    symbol:d.baseCurrency==='XBT'?'BTC':d.baseCurrency,
    rate:parseFloat(d.fundingFeeRate),
    lastPrice:parseFloat(d.lastTradePrice)||null,
    nextFunding:d.nextFundingRateTime||null,
  }));
}
