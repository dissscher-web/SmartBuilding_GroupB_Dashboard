
'use strict';
// SmartBuilding Group B — final dashboard (public settings only).
// Never put DASHBOARD_ACCESS_B, device tokens, or service_role keys here.
const API_URL = 'https://izbtxfmkfmkfledrqtpu.supabase.co/functions/v1/read-group-data';
const DEVICE_ID = 'ENV_GROUP_B_01';
const INTERVAL_MS = 30000;
const TIMEOUT_MS = 15000;
const MAX_POINTS = 60;

const FIELDS = [
  ['Temperature','temperature_c','°C'],
  ['Relative humidity','humidity_rh','%'],
  ['Illuminance','illuminance_lux','lux'],
  ['PIR motion','motion_detected','bool'],
  ['Radar OUT presence','radar_out_presence','bool'],
  ['Radar UART presence','radar_uart_presence','bool'],
  ['Moving target','radar_moving_detected','bool'],
  ['Stationary target','radar_stationary_detected','bool'],
  ['Moving distance','radar_moving_distance_cm','cm'],
  ['Stationary distance','radar_stationary_distance_cm','cm'],
  ['Moving energy','radar_moving_energy','%'],
  ['Stationary energy','radar_stationary_energy','%'],
  ['Device uptime','device_uptime_ms','ms']
];

const CHARTS = [
  {title:'1. Temperature & relative humidity',note:'Separate scales: °C (left), % RH (right)',series:[{key:'temperature_c',name:'Temperature °C',color:'#d75c40'},{key:'humidity_rh',name:'Humidity %',color:'#1689ad',axis:1}]},
  {title:'2. Illuminance',note:'BH1750 · lux',series:[{key:'illuminance_lux',name:'Illuminance',color:'#b18b22'}]},
  {title:'3. Occupancy signals',note:'0 = no detection · 1 = detection',binary:true,series:[{key:'motion_detected',name:'PIR',color:'#d75c40'},{key:'radar_out_presence',name:'Radar OUT',color:'#1689ad'},{key:'radar_uart_presence',name:'Radar UART',color:'#6d55b4'}]},
  {title:'4. Radar target types',note:'Moving vs stationary · binary',binary:true,series:[{key:'radar_moving_detected',name:'Moving',color:'#d75c40'},{key:'radar_stationary_detected',name:'Stationary',color:'#1689ad'}]},
  {title:'5. Radar target distances',note:'Centimeters · missing values are not zero',series:[{key:'radar_moving_distance_cm',name:'Moving cm',color:'#d75c40'},{key:'radar_stationary_distance_cm',name:'Stationary cm',color:'#1689ad'}]},
  {title:'6. Radar target energy',note:'Moving and stationary energy · 0–100',series:[{key:'radar_moving_energy',name:'Moving',color:'#d75c40'},{key:'radar_stationary_energy',name:'Stationary',color:'#1689ad'}]},
  {title:'7. Occupancy signal agreement',note:'1 = agree · 0 = disagree · gaps = unknown',binary:true,series:[{key:'_pir_agreement',name:'PIR vs UART',color:'#d75c40'},{key:'_out_agreement',name:'OUT vs UART',color:'#1689ad'}]}
];

const $ = id => document.getElementById(id);
let accessKey = '';
let inFlight = false;
let connecting = false;
let timer = null;
let rows = [];
let sessionId = 0;
let activeController = null;

const state = v => typeof v === 'boolean' ? (v ? 'Detected' : 'Not detected') : 'Unknown';
const agree = (a,b) => typeof a === 'boolean' && typeof b === 'boolean' ? (a === b ? 'Agree' : 'Disagree') : 'Unknown';
const agreementNumber = (a,b) => typeof a === 'boolean' && typeof b === 'boolean' ? Number(a === b) : null;
const target = (a,b) => typeof a !== 'boolean' || typeof b !== 'boolean' ? 'Unknown' : a && b ? 'Moving + Stationary' : a ? 'Moving' : b ? 'Stationary' : 'None';
const format = (v,u) => u === 'bool' ? state(v) : typeof v === 'number' && Number.isFinite(v) ? (u === 'ms' ? Math.round(v).toLocaleString() : Number(v.toFixed(1)).toLocaleString()) + (u ? ' ' + u : '') : '—';

function init() {
  for (const [label,key] of FIELDS) {
    const el = document.createElement('article');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = label;
    const val = document.createElement('strong');
    val.id = 'field-' + key;
    val.textContent = '—';
    el.append(h,val);
    $('cards').append(el);
  }

  for (const [label,id] of [
    ['Radar target state','target'],
    ['PIR–UART agreement','agree-pir'],
    ['OUT–UART agreement','agree-out']
  ]) {
    const el = document.createElement('article');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = label;
    const val = document.createElement('strong');
    val.id = id;
    val.textContent = 'Unknown';
    el.append(h,val);
    $('cards').append(el);
  }

  CHARTS.forEach((cfg,i) => {
    const el = document.createElement('article');
    el.className = 'chart-card';
    const h = document.createElement('h3');
    h.textContent = cfg.title;
    const p = document.createElement('p');
    p.textContent = cfg.note;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-' + i;
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label',cfg.title);
    wrap.append(canvas);
    const legend = document.createElement('div');
    legend.className = 'legend';
    cfg.series.forEach(s => {
      const item = document.createElement('span');
      item.style.setProperty('--legend',s.color);
      item.textContent = s.name;
      legend.append(item);
    });
    el.append(h,p,wrap,legend);
    $('chart-grid').append(el);
  });

  $('connect').addEventListener('click',connect);
  $('disconnect').addEventListener('click',disconnect);
  $('key').addEventListener('keydown',e => {
    if (e.key === 'Enter') connect();
  });
  window.addEventListener('resize',renderCharts);
  clearReadings();
  $('disconnect').disabled = true;
  $('status').textContent = 'Disconnected';
  renderCharts();
}

function clearReadings() {
  for (const [,key] of FIELDS) {
    $('field-' + key).textContent = '—';
  }
  $('target').textContent = 'Unknown';
  $('agree-pir').textContent = 'Unknown';
  $('agree-out').textContent = 'Unknown';
  $('updated').textContent = 'Last sample: —';
  $('freshness').textContent = 'Freshness: Unknown';
  $('history').textContent = 'History: 0 / 60 records';
}

function stopRequests() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (activeController) activeController.abort();
  activeController = null;
}

function disconnect() {
  sessionId++;
  stopRequests();
  accessKey = '';
  rows = [];
  inFlight = false;
  connecting = false;
  $('key').value = '';
  $('key').disabled = false;
  $('connect').disabled = false;
  $('disconnect').disabled = true;
  $('status').textContent = 'Disconnected';
  $('error').textContent = '';
  clearReadings();
  renderCharts();
}

function updateLatest(row) {
  if (!row) {
    clearReadings();
    return;
  }

  for (const [,key,u] of FIELDS) {
    $('field-' + key).textContent = format(row[key],u);
  }

  $('target').textContent = target(
    row.radar_moving_detected,
    row.radar_stationary_detected
  );
  $('agree-pir').textContent = agree(
    row.motion_detected,
    row.radar_uart_presence
  );
  $('agree-out').textContent = agree(
    row.radar_out_presence,
    row.radar_uart_presence
  );

  const ts = Date.parse(row.recorded_at);
  $('updated').textContent =
    'Last sample: ' +
    (Number.isFinite(ts) ? new Date(ts).toLocaleString() : 'Unknown');

  const age = Date.now() - ts;
  $('freshness').textContent = 'Freshness: ' + (
    !Number.isFinite(ts) ? 'Unknown' :
    age < -60000 ? 'Clock mismatch' :
    age <= 90000 ? 'Fresh' :
    age <= 180000 ? 'Delayed' : 'Stale'
  );
}

async function request(action,key,signal) {
  const response = await fetch(API_URL, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-dashboard-key':key
    },
    body:JSON.stringify({
      action,
      device_id:DEVICE_ID
    }),
    cache:'no-store',
    signal
  });

  if (!response.ok) {
    const message =
      response.status === 401
        ? 'Invalid dashboard access code (401)'
        : response.status === 403
          ? 'Access forbidden (403): check code, Origin and server settings'
          : response.status === 503
            ? 'Read service unavailable (503)'
            : 'Read API HTTP ' + response.status;
    throw new Error(message);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Invalid JSON from read API');
  }

  if (!data || typeof data !== 'object' ||
      data.device_id !== DEVICE_ID) {
    throw new Error('Unexpected device response');
  }
  if (action === 'recent' && !Array.isArray(data.rows)) {
    throw new Error('Invalid recent-data response');
  }
  if (action === 'latest' &&
      !Object.prototype.hasOwnProperty.call(data,'latest')) {
    throw new Error('Invalid latest-data response');
  }
  return data;
}

async function loadData(session,key) {
  if (inFlight) return false;
  inFlight = true;
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const [latest,recent] = await Promise.all([
      request('latest',key,controller.signal),
      request('recent',key,controller.signal)
    ]);

    if (session !== sessionId || key !== accessKey) {
      return false;
    }

    rows = recent.rows
      .filter(r =>
        r &&
        typeof r === 'object' &&
        Number.isFinite(Date.parse(r.recorded_at))
      )
      .sort((a,b) =>
        Date.parse(a.recorded_at) -
        Date.parse(b.recorded_at)
      )
      .slice(-MAX_POINTS);

    // Latest endpoint is authoritative for cards.
    updateLatest(latest.latest || null);

    $('history').textContent =
      'History: ' + rows.length + ' / ' +
      MAX_POINTS + ' records';

    $('status').textContent = 'Connected';
    $('error').textContent =
      latest.latest || rows.length
        ? ''
        : 'No records available';

    renderCharts();
    return true;

  } catch (err) {
    if (session === sessionId && key === accessKey) {
      $('status').textContent = 'Connection error';
      $('error').textContent =
        err.name === 'AbortError'
          ? 'Request timed out'
          : (err.message || 'Unable to fetch data');
    }
    return false;

  } finally {
    clearTimeout(timeout);
    if (activeController === controller) {
      activeController = null;
    }
    // Stale requests must not unlock newer sessions.
    if (session === sessionId) {
      inFlight = false;
    }
  }
}

async function connect() {
  if (connecting || accessKey) return;

  const key = $('key').value.trim();
  if (!key) {
    $('error').textContent =
      'Enter the dashboard access code.';
    return;
  }

  connecting = true;
  accessKey = key;
  const session = ++sessionId;

  $('connect').disabled = true;
  $('status').textContent = 'Connecting…';
  $('error').textContent = '';

  const ok = await loadData(session,key);
  if (session !== sessionId) return;

  connecting = false;

  if (!ok) {
    accessKey = '';
    rows = [];
    clearReadings();
    renderCharts();
    $('status').textContent = 'Not connected';
    $('connect').disabled = false;
    $('disconnect').disabled = true;
    return;
  }

  $('key').value = '';
  $('key').disabled = true;
  $('disconnect').disabled = false;
  timer = setInterval(refresh,INTERVAL_MS);
}

async function refresh() {
  if (!accessKey || connecting || inFlight) return;
  await loadData(sessionId,accessKey);
}

function valueOf(row,key) {
  if (key === '_pir_agreement') {
    return agreementNumber(
      row.motion_detected,
      row.radar_uart_presence
    );
  }
  if (key === '_out_agreement') {
    return agreementNumber(
      row.radar_out_presence,
      row.radar_uart_presence
    );
  }
  const v = row[key];
  if (typeof v === 'boolean') return Number(v);
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : null;
}

function renderCharts() {
  CHARTS.forEach((cfg,i) =>
    drawChart($('chart-' + i),cfg)
  );
}

function drawChart(canvas,cfg) {
  if (!canvas) return;

  const bounds = canvas.getBoundingClientRect();
  const w = Math.max(240,Math.floor(bounds.width));
  const h = Math.max(180,Math.floor(bounds.height));
  const dpr = Math.min(window.devicePixelRatio || 1,2);

  canvas.width = Math.round(w*dpr);
  canvas.height = Math.round(h*dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  const left = 48;
  const right = cfg.series.some(s => s.axis === 1)
    ? 45 : 16;
  const top = 14;
  const bottom = 34;
  const plotW = w-left-right;
  const plotH = h-top-bottom;

  ctx.font = '11px system-ui';
  ctx.fillStyle = '#718394';

  if (!rows.length) {
    ctx.fillText(
      'No recent records available',
      left+10,
      top+plotH/2
    );
    return;
  }

  const times = rows.map(r =>
    Date.parse(r.recorded_at)
  );
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const tSpan = Math.max(1,maxT-minT);

  const x = t => left + (
    maxT === minT
      ? plotW/2
      : ((t-minT)/tSpan)*plotW
  );

  const axes = [0,1].map(axis => {
    if (cfg.binary) return {min:-0.1,max:1.1};

    const values = cfg.series
      .filter(s => (s.axis || 0) === axis)
      .flatMap(s =>
        rows.map(r => valueOf(r,s.key))
          .filter(v => v !== null)
      );

    if (!values.length) return {min:0,max:1};

    let min = Math.min(...values);
    let max = Math.max(...values);
    const pad = min === max
      ? Math.max(1,Math.abs(min)*0.1)
      : (max-min)*0.1;

    return {min:min-pad,max:max+pad};
  });

  const y = (v,axis) =>
    top + plotH -
    (v-axes[axis].min) /
    (axes[axis].max-axes[axis].min)*plotH;

  ctx.strokeStyle = '#e5edf2';
  ctx.lineWidth = 1;

  for (let j=0;j<=4;j++) {
    const yy = top+j*plotH/4;
    ctx.beginPath();
    ctx.moveTo(left,yy);
    ctx.lineTo(w-right,yy);
    ctx.stroke();

    ctx.fillStyle = '#718394';
    ctx.textAlign = 'right';
    const v = axes[0].max -
      (axes[0].max-axes[0].min)*j/4;

    ctx.fillText(
      Number(v.toFixed(cfg.binary ? 2 : 1)).toString(),
      left-7,
      yy+4
    );

    if (right > 16) {
      ctx.textAlign = 'left';
      const vv = axes[1].max -
        (axes[1].max-axes[1].min)*j/4;
      ctx.fillText(
        Number(vv.toFixed(1)).toString(),
        w-right+6,
        yy+4
      );
    }
  }

  ctx.fillStyle = '#718394';
  ctx.textAlign = 'left';
  ctx.fillText(
    new Date(minT).toLocaleTimeString([], {
      hour:'2-digit',
      minute:'2-digit'
    }),
    left,
    h-8
  );

  ctx.textAlign = 'right';
  ctx.fillText(
    new Date(maxT).toLocaleTimeString([], {
      hour:'2-digit',
      minute:'2-digit'
    }),
    w-right,
    h-8
  );

  cfg.series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 2;

    const axis = s.axis || 0;
    let segment = [];

    const flush = () => {
      if (!segment.length) return;

      if (segment.length > 1) {
        ctx.beginPath();
        segment.forEach((p,i) => {
          if (i) ctx.lineTo(p.x,p.y);
          else ctx.moveTo(p.x,p.y);
        });
        ctx.stroke();
      }

      // Show isolated valid points in long histories too.
      if (segment.length === 1 || rows.length <= 30) {
        for (const p of segment) {
          ctx.beginPath();
          ctx.arc(p.x,p.y,2.8,0,Math.PI*2);
          ctx.fill();
        }
      }
      segment = [];
    };

    rows.forEach((r,i) => {
      const v = valueOf(r,s.key);
      if (v === null) {
        flush();
        return;
      }
      segment.push({
        x:x(times[i]),
        y:y(v,axis)
      });
    });
    flush();
  });
}

init();
