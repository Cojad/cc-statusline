#!/usr/bin/env node
// Combined statusline renderer + PreCompact hook.
// Mode is selected by stdin payload: hook_event_name === 'PreCompact' → bump
// the compact counter and pass stdin through; otherwise render the statusline.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
};

let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let i = {};
  try { i = JSON.parse(raw); } catch (e) {}
  const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

  // ── PreCompact hook mode ──
  if (i.hook_event_name === 'PreCompact') {
    const f = path.join(os.tmpdir(), `claude-compacts-${sid}.json`);
    let s = { count: 0, last: null };
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
    s.count++;
    s.last = Date.now();
    atomicWrite(f, JSON.stringify(s));
    process.stdout.write(raw);
    return;
  }

  // ── Statusline render mode ──
  try {
    const R = '\x1b[0m', DIM = '\x1b[2m';
    const CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', ORANGE = '\x1b[38;5;208m';
    const pctColor = p => p >= 80 ? RED : p >= 50 ? YELLOW : GREEN;
    const fmtTok = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n|0);
    const fmtDur = s => {
      if (s <= 0) return '—';
      const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), sec = s%60;
      if (d) return h ? `${d}d${h}h` : `${d}d`;
      if (h) return m ? `${h}h${m}m` : `${h}h`;
      if (m) return sec ? `${m}m${sec}s` : `${m}m`;
      return `${sec}s`;
    };

    const model = (i.model?.display_name || '?').replace(/^Claude /, '');
    const dir = (i.workspace?.current_dir || '.').replace(/\\/g, '/');
    const pct = Math.floor(i.context_window?.used_percentage ?? 0);

    // Context bar
    const barColor = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
    const filled = Math.floor(pct / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // Cumulative cost / duration / tokens (compatible with statusline.js cum format)
    const curTok = (i.context_window?.total_input_tokens ?? 0) + (i.context_window?.total_output_tokens ?? 0);
    const curCost = i.cost?.total_cost_usd ?? 0;
    const curDur = i.cost?.total_duration_ms ?? 0;
    const cumFile = path.join(os.tmpdir(), `claude-cum-${sid}.json`);
    let cum = {};
    try { cum = JSON.parse(fs.readFileSync(cumFile, 'utf8')); } catch (e) {}
    const step = (key, cur) => {
      const p = cum[key] = cum[key] || { total: 0, base: 0 };
      if (cur >= p.base) { p.total += (cur - p.base); p.base = cur; }
      else { p.base = cur; }
    };
    step('tok', curTok); step('cost', curCost); step('dur', curDur);
    cum.add = cum.add || { total: 0, base: 0 };
    cum.rm  = cum.rm  || { total: 0, base: 0 };
    atomicWrite(cumFile, JSON.stringify(cum));

    const tokFmt = fmtTok(cum.tok.total);
    const ctxTokFmt = fmtTok(curTok);
    const costFmt = '$' + cum.cost.total.toFixed(2);
    const durSec = Math.floor(cum.dur.total / 1000);
    const durFmt = durSec > 0 ? fmtDur(durSec) : '0s';

    // Compact count
    let compact = 0;
    try { compact = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-compacts-${sid}.json`), 'utf8')).count || 0; } catch (e) {}

    // 5h / 7d quota — cross-session aggregation via shared snapshot file
    const snapFile = path.join(os.homedir(), '.claude', 'rate-limit-snapshots.json');
    const now = Math.floor(Date.now() / 1000);
    let snaps = {};
    try { snaps = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch (e) {}
    for (const k of Object.keys(snaps)) {
      if (!snaps[k]?.t || (now - snaps[k].t) >= 300) delete snaps[k];
    }
    snaps[sid] = {
      t: now,
      five_hour: i.rate_limits?.five_hour || null,
      seven_day: i.rate_limits?.seven_day || null,
    };
    atomicWrite(snapFile, JSON.stringify(snaps));

    const MAX_FUTURE = 8 * 86400;
    const agg = field => {
      const live = Object.values(snaps).map(s => s?.[field]).filter(s =>
        s && s.resets_at && s.resets_at > now && (s.resets_at - now) <= MAX_FUTURE
      );
      if (!live.length) return [0, 0];
      const latest = Math.max(...live.map(s => s.resets_at));
      const max = Math.max(...live.filter(s => s.resets_at === latest).map(s => s.used_percentage || 0));
      return [Math.floor(max), latest];
    };
    const [r5h, r5hReset] = agg('five_hour');
    const [r7d, r7dReset] = agg('seven_day');
    const r5hLeft = fmtDur(r5hReset > 0 ? r5hReset - now : 0);
    const r7dLeft = fmtDur(r7dReset > 0 ? r7dReset - now : 0);

    // Effort
    let effort = 'default';
    try {
      effort = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel || 'default';
    } catch (e) {}
    const effortColor = ({ low: GREEN, default: GREEN, medium: GREEN, high: YELLOW, xhigh: ORANGE, max: RED })[effort] || GREEN;

    // Git branch
    let branch = '';
    try {
      const b = (spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      if (b) branch = ` 🌿 ${b}`;
    } catch (e) {}

    // Path display: $HOME → ~
    const home = os.homedir();
    const dirDisp = dir === home ? '~' : (dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir);

    const sep = `${DIM}│${R}`;
    process.stdout.write(
      `${barColor}${bar}${R} ${pct}% ${DIM}(${ctxTokFmt})${R} ${CYAN}[${model}:${effortColor}${effort}${CYAN}]${R} 📁 ${dirDisp}${branch} ${sep} ${YELLOW}${costFmt}${R} ${sep} 🪙 ${tokFmt} ${sep} ♻️ ${compact}× ${sep} ${pctColor(r5h)}5h ${r5h}%${R} ${DIM}${r5hLeft}${R} · ${pctColor(r7d)}7d ${r7d}%${R} ${DIM}${r7dLeft}${R} ${sep} ⌛ ${durFmt}\n`
    );
  } catch (e) {
    process.stdout.write('statusline error: ' + e.message);
  }
});
