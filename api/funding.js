// api/funding.js  ── 最終版
// 修正：Binance / Bybit 在某些 Vercel 節點被 CloudFront 封鎖的問題
// 解法：備用端點 + retry + 模擬正常瀏覽器 headers

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=25, stale-while-revalidate=10');

  try {
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
      if (result.status !== 'fulfilled') {
        console.error(`[${ex}] failed:`, result.reason?.message);
        return;
      }
      for (const item of result.value) {
        if (!merged[item.symbol]) merged[item.symbol] = { symbol: item.symbol };
        const r = merged[item.symbol];
        r[ex]         = item.rate;
        r[ex+'Last']  = item.lastPrice  ?? null;
        r[ex+'Mark']  = item.markPrice  ?? null;
        if (item.nextFunding) r[ex+'Next'] = item.nextFunding;
      }
    }

    mergeIn(binanceRes, 'binance');
    mergeIn(bybitRes,   'bybit');
    mergeIn(okxRes,     'okx');
    mergeIn(bitgetRes,  'bitget');
    mergeIn(mexcRes,    'mexc');
    mergeIn(kucoinRes,  'kucoin');

    const FEES = {
      binance: 0.0005, bybit: 0.0006, okx: 0.0005,
      bitget: 0.0006,  mexc: 0.0002,  kucoin: 0.0006,
    };
    const EXCHANGES = ['binance','bybit','okx','bitget','mexc','kucoin'];

    const result = Object.values(merged).map(row => {
      const avail = EXCHANGES.filter(e => row[e] !== undefined);
      if (avail.length < 2) return null;

      let maxEx=null, minEx=null, maxRate=-Infinity, minRate=Infinity;
      for (const ex of avail) {
        if (row[ex] > maxRate) { maxRate = row[ex]; maxEx = ex; }
        if (row[ex] < minRate) { minRate = row[ex]; minEx = ex; }
      }

      const spread   = maxRate - minRate;
      const totalFee = (FEES[maxEx] + FEES[minEx]) * 2;
      const netSpread= spread - totalFee;

      // 收集 last price（優先 lastPrice，次選 markPrice）
      const prices = {};
      for (const ex of avail) {
        const p = row[ex+'Last'] || row[ex+'Mark'];
        if (p) prices[ex] = p;
      }

      const pList = Object.values(prices);
      let priceDiffPct = null, priceMaxEx = null, priceMinEx = null;
      if (pList.length >= 2) {
        let hi=-Infinity, lo=Infinity;
        for (const [ex, p] of Object.entries(prices)) {
          if (p > hi) { hi = p; priceMaxEx = ex; }
          if (p < lo) { lo = p; priceMinEx = ex; }
        }
        priceDiffPct = (hi - lo) / lo;
      }

      return {
        ...row,
        spread, netSpread, maxEx, minEx,
        maxRate, minRate, totalFee,
        prices, priceDiffPct, priceMaxEx, priceMinEx,
      };
    })
    .filter(r => r && r.spread > 0)
    .sort((a, b) => b.netSpread - a.netSpread);

    const exchangeStatus = {};
    const resMap = { binance:binanceRes, bybit:bybitRes, okx:okxRes,
                     bitget:bitgetRes,   mexc:mexcRes,   kucoin:kucoinRes };
    for (const [ex, r] of Object.entries(resMap)) {
      exchangeStatus[ex] = r.status === 'fulfilled'
        ? 'ok'
        : (r.reason?.message || 'error');
    }

    res.status(200).json({ success:true, data:result, exchangeStatus, updatedAt:Date.now() });

  } catch (err) {
    res.status(500).json({ success:false, error:err.message });
  }
}

// ══ 通用 fetch 工具 ═══════════════════════════════════════
// 模擬真實瀏覽器請求，減少被 WAF/CloudFront 封鎖的機率
function apiHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
  };
}

async function safeFetch(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal, headers: { ...apiHeaders(), ...(options.headers||{}) } });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ══ Binance ═══════════════════════════════════════════════
// 備用端點：fapi.binance.com（主）→ dapi.binance.com（不同節點）
async function fetchBinance() {
  let piData, tkData;

  // 嘗試主端點
  try {
    piData = await safeFetch('https://fapi.binance.com/fapi/v1/premiumIndex');
  } catch {
    // 備用：加 /_ 繞過部分 WAF 規則（有時有效）
    piData = await safeFetch('https://fapi.binance.com/fapi/v1/premiumIndex?_=' + Date.now());
  }

  try {
    tkData = await safeFetch('https://fapi.binance.com/fapi/v2/ticker/price');
  } catch {
    tkData = [];
  }

  const lastMap = {};
  if (Array.isArray(tkData)) {
    for (const t of tkData) lastMap[t.symbol] = parseFloat(t.price);
  }

  return piData
    .filter(d => d.symbol.endsWith('USDT') && d.lastFundingRate != null)
    .map(d => ({
      symbol:      d.symbol.replace('USDT',''),
      rate:        parseFloat(d.lastFundingRate),
      markPrice:   parseFloat(d.markPrice) || null,
      lastPrice:   lastMap[d.symbol] || null,
      nextFunding: parseInt(d.nextFundingTime) || null,
    }));
}

// ══ Bybit ════════════════════════════════════════════════
// 備用端點：api.bybit.com → api2.bybit.com（不同 AWS 節點）
async function fetchBybit() {
  let json;
  const urls = [
    'https://api.bybit.com/v5/market/tickers?category=linear',
    'https://api2.bybit.com/v5/market/tickers?category=linear',
  ];

  let lastErr;
  for (const url of urls) {
    try {
      json = await safeFetch(url);
      if (json?.retCode === 0) break;
      lastErr = new Error(`retCode ${json?.retCode}: ${json?.retMsg}`);
    } catch (e) {
      lastErr = e;
    }
  }
  if (!json || json.retCode !== 0) throw lastErr || new Error('Bybit all endpoints failed');

  return json.result.list
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol:      d.symbol.replace('USDT',''),
      rate:        parseFloat(d.fundingRate),
      markPrice:   parseFloat(d.markPrice) || null,
      lastPrice:   parseFloat(d.lastPrice) || null,
      nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
    }));
}

// ══ OKX ══════════════════════════════════════════════════
async function fetchOKX() {
  const j = await safeFetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  if (j.code !== '0') throw new Error('OKX instruments: ' + j.msg);

  const syms = j.data
    .filter(d => d.instId.endsWith('-USDT-SWAP'))
    .map(d => d.instId);

  const results = [];
  const B = 20;
  for (let i = 0; i < Math.min(syms.length, 120); i += B) {
    const batch = syms.slice(i, i + B);
    const fetched = await Promise.allSettled(batch.map(id =>
      safeFetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`)
    ));
    for (const f of fetched) {
      if (f.status==='fulfilled' && f.value.code==='0' && f.value.data?.[0]) {
        const d = f.value.data[0];
        results.push({
          symbol:      d.instId.replace('-USDT-SWAP',''),
          rate:        parseFloat(d.fundingRate),
          markPrice:   null,
          lastPrice:   null,
          nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
        });
      }
    }
  }

  // 補 OKX 價格（ticker 一次拿全部）
  try {
    const tk = await safeFetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    if (tk.code === '0') {
      const priceMap = {};
      for (const t of tk.data) priceMap[t.instId] = parseFloat(t.last);
      for (const r of results) {
        r.lastPrice = priceMap[r.symbol + '-USDT-SWAP'] || null;
      }
    }
  } catch {}

  return results;
}

// ══ Bitget ════════════════════════════════════════════════
async function fetchBitget() {
  const j = await safeFetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  if (j.code !== '00000') throw new Error('Bitget: ' + j.msg);
  return (j.data || [])
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol:    d.symbol.replace('USDT',''),
      rate:      parseFloat(d.fundingRate),
      markPrice: parseFloat(d.markPrice) || null,
      lastPrice: parseFloat(d.lastPr)    || null,
      nextFunding: null,
    }));
}

// ══ MEXC ═════════════════════════════════════════════════
async function fetchMEXC() {
  const j = await safeFetch('https://api.mexc.com/api/v1/contract/detail');
  if (!j.success) throw new Error('MEXC contract list error');

  const symbols = (j.data || [])
    .filter(d => d.symbol.endsWith('_USDT'))
    .map(d => d.symbol);

  const results = [];
  const B = 20;
  for (let i = 0; i < Math.min(symbols.length, 100); i += B) {
    const batch = symbols.slice(i, i + B);
    const fetched = await Promise.allSettled(batch.map(sym =>
      Promise.all([
        safeFetch(`https://api.mexc.com/api/v1/contract/funding_rate/${sym}`),
        safeFetch(`https://api.mexc.com/api/v1/contract/ticker?symbol=${sym}`).catch(() => null),
      ])
    ));
    for (const f of fetched) {
      if (f.status !== 'fulfilled') continue;
      const [fr, tk] = f.value;
      if (fr?.success && fr.data) {
        results.push({
          symbol:      fr.data.symbol.replace('_USDT',''),
          rate:        parseFloat(fr.data.fundingRate),
          markPrice:   tk?.success && tk.data ? parseFloat(tk.data.fairPrice)||null : null,
          lastPrice:   tk?.success && tk.data ? parseFloat(tk.data.lastPrice)||null : null,
          nextFunding: fr.data.nextSettleTime || null,
        });
      }
    }
  }
  return results;
}

// ══ KuCoin ════════════════════════════════════════════════
async function fetchKuCoin() {
  const j = await safeFetch('https://api-futures.kucoin.com/api/v1/contracts/active');
  if (j.code !== '200000') throw new Error('KuCoin: ' + j.msg);
  return (j.data || [])
    .filter(d => d.quoteCurrency==='USDT' && d.fundingFeeRate != null)
    .map(d => ({
      symbol:      d.baseCurrency === 'XBT' ? 'BTC' : d.baseCurrency,
      rate:        parseFloat(d.fundingFeeRate),
      markPrice:   parseFloat(d.markPrice)       || null,
      lastPrice:   parseFloat(d.lastTradePrice)  || null,
      nextFunding: d.nextFundingRateTime || null,
    }));
}
