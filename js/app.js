'use strict';

/*
 * くじ引きアプリ（オフライン動作 / 外部ライブラリなし）
 *
 * データの考え方:
 *   - 各賞の「その日に用意する数」(counts[0] = 1日目, counts[1] = 2日目) と
 *     「抽選履歴」(history) だけを保存する。
 *   - 残り数は常に「その日の用意数 − その日に出た数」で計算する。
 *   - 2日目に切り替えると、2日目の用意数から数え直しになる（1日目の記録は残る）。
 *   - 抽選は「箱からくじを1枚引く」方式（残っている本数に比例した確率）なので、
 *     用意した数より多く当たりが出ることはない。
 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toInt = v => Math.min(1e6, Math.max(0, Math.floor(Number(v)) || 0)); // 本数・残り数用（上限は異常値よけ）
  const clone = v => JSON.parse(JSON.stringify(v));
  const pad2 = n => String(n).padStart(2, '0');
  const fmtTime = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ======================================================================
  // 状態・保存
  // ======================================================================
  const STORAGE_KEY = 'kuji-app/v1';
  const EFFECTS = {
    jackpot: '超ハデ（大当たり）',
    big: 'ハデ',
    normal: 'ふつう',
    lose: 'ハズレ扱い',
  };
  const FX_MODES = {
    dopamine: 'ドーパミン全開（連打ゲージ・予告カットイン・カプセル演出）',
    simple: 'シンプル（すぐ結果が出る・混雑時向け）',
  };
  const TIER = { lose: 0, normal: 1, big: 2, jackpot: 3 };

  function defaultState() {
    return {
      version: 1,
      title: 'ガラポン くじ引き',
      day: 1,
      pin: '0000',
      sound: true,
      spinSeconds: 3.5,
      fxMode: 'dopamine', // 'dopamine' = 連打・予告・カプセル演出あり / 'simple' = すぐ結果
      // 1日あたりの本数（[...]は [1日目, 2日目]）。A賞3 + B賞27 + C賞120 + D賞150 = 300本/日
      prizes: [
        { id: 'A', name: 'A賞', item: '', color: '#e53935', counts: [3, 3], showRemaining: true, effect: 'jackpot' },
        { id: 'B', name: 'B賞', item: '', color: '#fb8c00', counts: [27, 27], showRemaining: true, effect: 'big' },
        { id: 'C', name: 'C賞', item: '', color: '#43a047', counts: [120, 120], showRemaining: false, effect: 'normal' },
        { id: 'D', name: 'D賞', item: '', color: '#1e88e5', counts: [150, 150], showRemaining: false, effect: 'normal' },
        // { id: 'Z', name: 'ハズレ', item: '', color: '#9e9e9e', counts: [0, 0], showRemaining: false, effect: 'lose' },
      ],
      history: [], // { id: 賞ID, day: 1|2, t: 時刻(ms) }
    };
  }

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    // 残り数は id 単位で数えるため、id が空・重複している賞には新しい id を振る（履歴側も付け替える）
    const usedIds = new Set();
    const idRemap = new Map();   // 旧ID → 新ID（どの賞にも引き継がれなかったIDだけ）
    const prizes = Array.isArray(s.prizes) && s.prizes.length
      ? s.prizes.map(p => {
          const oldId = String(p.id ?? '');
          let id = oldId;
          if (!id || usedIds.has(id)) id = newId();
          while (usedIds.has(id)) id = newId();
          usedIds.add(id);
          if (oldId !== id && !idRemap.has(oldId)) idRemap.set(oldId, id);
          return {
            id,
            name: String(p.name ?? ''),
            item: String(p.item ?? ''),
            color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#999999',
            counts: [toInt(p.counts?.[0]), toInt(p.counts?.[1])],
            showRemaining: !!p.showRemaining,
            effect: Object.hasOwn(EFFECTS, p.effect) ? p.effect : 'normal',
          };
        })
      : d.prizes;
    prizes.forEach(p => idRemap.delete(p.id)); // 残った賞が使っているIDは付け替えない
    return {
      version: 1,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : d.title,
      day: s.day === 2 ? 2 : 1,
      pin: typeof s.pin === 'string' ? s.pin : d.pin,
      sound: s.sound !== false,
      spinSeconds: clamp(Number(s.spinSeconds) || d.spinSeconds, 1, 8),
      fxMode: Object.hasOwn(FX_MODES, s.fxMode) ? s.fxMode : d.fxMode,
      prizes,
      history: Array.isArray(s.history)
        ? s.history.filter(h => h && h.id != null).map(h => ({ id: idRemap.get(String(h.id)) ?? String(h.id), day: h.day === 2 ? 2 : 1, t: Number(h.t) || 0 }))
        : [],
    };
  }

  let storeSnapshot = null;   // 最後に読み書きした保存内容（他ウィンドウの更新検出用）
  let saveBroken = false;     // 保存に失敗した（localStorage が使えない）

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { storeSnapshot = raw; return normalize(JSON.parse(raw)); }
    } catch (e) {
      console.warn('保存データの読み込みに失敗しました', e);
    }
    return defaultState();
  }

  let state = loadState();

  function save() {
    try {
      const raw = JSON.stringify(state);
      localStorage.setItem(STORAGE_KEY, raw);
      storeSnapshot = raw;
      saveBroken = false;
    } catch (e) {
      saveBroken = true;
      alert('データの保存に失敗しました: ' + e.message);
    }
  }

  // 他ウィンドウの保存内容が変わっていたら取り込む（古い内容で上書きしないため）。取り込んだら true
  function syncFromStore() {
    if (saveBroken) return false;
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (raw === storeSnapshot) return false;
    state = loadState();
    prevShown.clear();
    return true;
  }

  const prizeById = id => state.prizes.find(p => p.id === id);
  const nameOf = id => prizeById(id)?.name ?? '（削除された賞）';
  const isLose = p => p.effect === 'lose';
  const drawnCount = (id, day = state.day) => state.history.reduce((n, h) => n + (h.day === day && h.id === id ? 1 : 0), 0);
  const remaining = (p, day = state.day) => Math.max(0, (p.counts[day - 1] || 0) - drawnCount(p.id, day));
  const totalRemaining = () => state.prizes.reduce((n, p) => n + remaining(p), 0);
  const lastToday = () => {
    for (let i = state.history.length - 1; i >= 0; i--) if (state.history[i].day === state.day) return state.history[i];
    return null;
  };

  // 偏りのない乱数 (0 <= r < n)
  function randomInt(n) {
    if (!(n > 0)) return 0;
    if (n > 0x100000000) n = 0x100000000; // 極端な本数でも棄却ループから抜けられるように
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let v;
    do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % n;
  }

  // 残っているくじの中から1枚引く
  function drawPrize() {
    const pool = state.prizes.map(p => ({ p, n: remaining(p) })).filter(x => x.n > 0);
    const total = pool.reduce((s, x) => s + x.n, 0);
    if (!total) return null;
    let r = randomInt(total);
    for (const x of pool) {
      if (r < x.n) return x.p;
      r -= x.n;
    }
    return null;
  }

  // ======================================================================
  // 効果音（WebAudio で合成。音声ファイル不要）
  // ======================================================================
  const Sound = (() => {
    let ctx = null, master = null, noiseBuf = null;

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.7;
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    const ok = () => state.sound && ensure();
    const midi = n => 440 * Math.pow(2, (n - 69) / 12);

    function tone(freq, at, dur, { type = 'square', vol = 0.1, slide = 0 } = {}) {
      const t = ctx.currentTime + at;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.setValueAtTime(vol, t + Math.max(0.02, dur * 0.6));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    function noise(at, dur, { vol = 0.2, freq = 2000, q = 2 } = {}) {
      const t = ctx.currentTime + at;
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(master);
      s.start(t, Math.random() * 0.4);
      s.stop(t + dur + 0.02);
    }

    const notes = (list, opts) => list.forEach(([n, at, dur]) => tone(midi(n), at, dur, opts));

    return {
      unlock: ensure,
      rattle() { if (ok()) noise(0, 0.05, { vol: 0.35, freq: 1500 + Math.random() * 2500, q: 5 }); },
      pop() { if (ok()) tone(260, 0, 0.2, { type: 'sine', vol: 0.3, slide: 2.6 }); },
      bounce() { if (ok()) { noise(0, 0.07, { vol: 0.3, freq: 900, q: 1 }); tone(170, 0, 0.1, { type: 'sine', vol: 0.25 }); } },
      fanfare() {
        if (!ok()) return;
        const mel = [[72, 0, .14], [72, .16, .14], [72, .32, .14], [77, .48, .55], [76, 1.06, .15], [77, 1.23, .15], [81, 1.4, 1.1]];
        notes(mel, { type: 'square', vol: 0.09 });
        notes(mel.map(([n, a, d]) => [n - 12, a, d]), { type: 'triangle', vol: 0.16 });
        notes([[65, .48, .55], [69, 1.4, 1.1]], { type: 'sawtooth', vol: 0.05 });
        notes([[41, .48, .5], [41, 1.4, 1.1]], { type: 'triangle', vol: 0.25 });
        for (let i = 0; i < 12; i++) tone(midi(84 + (i % 4) * 4), 2.5 + i * 0.07, 0.25, { type: 'sine', vol: 0.08 });
        noise(0, 0.25, { vol: 0.4, freq: 5000, q: 0.5 });
        noise(1.4, 0.8, { vol: 0.3, freq: 6000, q: 0.5 });
      },
      win() {
        if (!ok()) return;
        const mel = [[72, 0, .12], [76, .12, .12], [79, .24, .12], [84, .36, .6]];
        notes(mel, { type: 'square', vol: 0.08 });
        notes(mel.map(([n, a, d]) => [n - 12, a, d]), { type: 'triangle', vol: 0.14 });
      },
      chime() {
        if (!ok()) return;
        notes([[84, 0, .5], [88, .12, .6], [91, .24, .8]], { type: 'triangle', vol: 0.18 });
      },
      lose() {
        if (!ok()) return;
        notes([[67, 0, .35], [66, .4, .35], [65, .8, .35]], { type: 'triangle', vol: 0.2 });
        tone(midi(64), 1.2, 1.0, { type: 'triangle', vol: 0.2, slide: 0.94 });
      },
      // ---- ドーパミン演出用 ----
      mash(n) { if (ok()) tone(midi(60 + Math.min(n, 36)), 0, 0.07, { type: 'square', vol: 0.07 }); },
      chance() {
        if (!ok()) return;
        notes([[84, 0, .1], [88, .07, .1], [91, .14, .1], [96, .21, .35]], { type: 'square', vol: 0.07 });
        noise(0, 0.3, { vol: 0.2, freq: 5000, q: 0.7 });
      },
      hot() { // キュイン！
        if (!ok()) return;
        tone(400, 0, 0.45, { type: 'sawtooth', vol: 0.07, slide: 6 });
        tone(800, 0, 0.45, { type: 'sine', vol: 0.14, slide: 4 });
        tone(midi(96), 0.45, 0.5, { type: 'sine', vol: 0.1 });
        noise(0, 0.45, { vol: 0.25, freq: 4000, q: 1 });
      },
      blackout() { if (ok()) { tone(70, 0, 0.3, { type: 'square', vol: 0.2, slide: 0.5 }); noise(0, 0.12, { vol: 0.4, freq: 300, q: 1 }); } },
      rainbow() { // ギュイーン → キラキラ
        if (!ok()) return;
        tone(150, 0, 1.0, { type: 'sawtooth', vol: 0.08, slide: 14 });
        tone(300, 0, 1.0, { type: 'sine', vol: 0.12, slide: 8 });
        for (let i = 0; i < 16; i++) tone(midi(84 + [0, 4, 7, 12][i % 4] + (i >= 8 ? 12 : 0)), 0.5 + i * 0.05, 0.25, { type: 'sine', vol: 0.08 });
        noise(0, 1.0, { vol: 0.2, freq: 7000, q: 0.6 });
      },
      // 回転中のドラムロール＋だんだん上がるうなり音（sec 秒かけて盛り上がる）
      riser(sec) {
        if (!ok()) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(440, t + sec);
        f.type = 'lowpass';
        f.Q.value = 6;
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(3200, t + sec);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + sec * 0.9);
        g.gain.exponentialRampToValueAtTime(0.0001, t + sec + 0.1);
        o.connect(f).connect(g).connect(master);
        o.start(t);
        o.stop(t + sec + 0.15);
        for (let at = 0, gap = 0.18; at < sec; at += gap, gap = Math.max(0.045, gap * 0.93)) {
          noise(at, 0.05, { vol: 0.1 + 0.2 * at / sec, freq: 1800, q: 0.8 });
        }
      },
      thump() { if (ok()) { tone(110, 0, 0.25, { type: 'sine', vol: 0.5, slide: 0.45 }); noise(0, 0.08, { vol: 0.25, freq: 400, q: 1 }); } },
      upgrade(step) {
        if (!ok()) return;
        const b = 72 + step * 5;
        notes([[b, 0, .1], [b + 4, .07, .1], [b + 7, .14, .1], [b + 12, .21, .45]], { type: 'triangle', vol: 0.2 });
        notes([[b + 12, .21, .45]], { type: 'square', vol: 0.05 });
        noise(0, 0.35, { vol: 0.3, freq: 6500, q: 0.7 });
      },
      burst() {
        if (!ok()) return;
        noise(0, 0.6, { vol: 0.55, freq: 1200, q: 0.3 });
        tone(80, 0, 0.5, { type: 'sine', vol: 0.5, slide: 0.4 });
      },
    };
  })();

  // ======================================================================
  // ガラポン（SVG）
  // ======================================================================
  const Garapon = (() => {
    const svg = $('#garapon');
    const CX = 300, CY = 230, R = 175, W = 118, BALL_R = 12, BALL_N = 26;
    const rad = d => d * Math.PI / 180;
    const pt = (r, deg) => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))];
    const f = n => n.toFixed(1);
    let angle = 0;
    let boost = 0, boostShown = 0; // 連打で上乗せされる回転（boostShown がなめらかに追いかける）
    let balls = [];
    let drum, ballLayer, ballOut;

    function build() {
      const verts = Array.from({ length: 8 }, (_, i) => 22.5 + i * 45);
      const facets = verts.map((a, i) => {
        const b = a + 45;
        const [ox1, oy1] = pt(R, a), [ox2, oy2] = pt(R, b), [ix2, iy2] = pt(W, b), [ix1, iy1] = pt(W, a);
        const fill = i % 2 ? '#ffc93c' : '#e8412f';
        return `<path d="M${f(ox1)} ${f(oy1)} L${f(ox2)} ${f(oy2)} L${f(ix2)} ${f(iy2)} A${W} ${W} 0 0 0 ${f(ix1)} ${f(iy1)} Z" fill="${fill}"/>`;
      }).join('');
      const octagon = verts.map(a => pt(R, a).map(f).join(',')).join(' ');
      const rivets = verts.map(a => { const [x, y] = pt((R + W) / 2 + 12, a + 22.5); return `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="#fff" opacity=".85"/>`; }).join('');

      svg.innerHTML = `
        <defs>
          <linearGradient id="gLeg" x1="0" x2="1"><stop offset="0" stop-color="#c07d3e"/><stop offset="1" stop-color="#85501f"/></linearGradient>
          <linearGradient id="gWood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2a560"/><stop offset="1" stop-color="#9c5d24"/></linearGradient>
          <radialGradient id="gWin" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#fff6e0" stop-opacity=".9"/><stop offset="1" stop-color="#c9a36b" stop-opacity=".95"/></radialGradient>
          <radialGradient id="gHub" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#cfcfcf"/><stop offset="1" stop-color="#6b6b6b"/></radialGradient>
          <radialGradient id="gKnob" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ff9a8a"/><stop offset=".5" stop-color="#e53935"/><stop offset="1" stop-color="#8e1a12"/></radialGradient>
          <radialGradient id="gBallShade" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>
          <clipPath id="cWin"><circle cx="${CX}" cy="${CY}" r="${W}"/></clipPath>
          <filter id="fGlow" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur stdDeviation="7" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="fShadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="6" flood-opacity=".3"/></filter>
        </defs>

        <ellipse cx="322" cy="526" rx="250" ry="12" fill="rgba(0,0,0,.18)"/>
        <g>
          <polygon points="288,250 312,250 196,505 166,505" fill="url(#gLeg)" stroke="#6d3f14" stroke-width="3"/>
          <polygon points="288,250 312,250 434,505 404,505" fill="url(#gLeg)" stroke="#6d3f14" stroke-width="3"/>
          <rect x="110" y="500" width="424" height="22" rx="8" fill="url(#gWood)" stroke="#6d3f14" stroke-width="3"/>
        </g>

        <circle cx="${CX}" cy="${CY}" r="${W}" fill="url(#gWin)"/>
        <g id="balls" clip-path="url(#cWin)"></g>
        <path d="M 212 180 A 100 100 0 0 1 320 132" stroke="rgba(255,255,255,.7)" stroke-width="9" fill="none" stroke-linecap="round"/>

        <g filter="url(#fShadow)">
          <g id="drum">
            ${facets}
            <polygon points="${octagon}" fill="none" stroke="#6d1f14" stroke-width="6" stroke-linejoin="round"/>
            ${verts.map(a => { const [x1, y1] = pt(W, a), [x2, y2] = pt(R, a); return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#6d1f14" stroke-width="3" opacity=".6"/>`; }).join('')}
            ${rivets}
            <circle cx="${CX}" cy="${CY}" r="${W + 2}" fill="none" stroke="#f3e2c0" stroke-width="9"/>
            <circle cx="${CX}" cy="${CY}" r="${W + 7}" fill="none" stroke="#6d1f14" stroke-width="2.5"/>
            <rect x="${CX}" y="${CY - 9}" width="215" height="18" rx="9" fill="url(#gHub)" stroke="#555" stroke-width="2"/>
            <circle cx="${CX + 215}" cy="${CY}" r="22" fill="url(#gKnob)" stroke="#6d1f14" stroke-width="2.5"/>
            <circle cx="${CX}" cy="${CY}" r="30" fill="url(#gHub)" stroke="#555" stroke-width="2.5"/>
            <circle cx="${CX}" cy="${CY}" r="8" fill="#777"/>
          </g>
        </g>

        <path d="M238 468 L502 468 L496 500 L244 500 Z" fill="#6b3b12"/>
        <g id="ballOut" opacity="0"></g>
        <path d="M226 480 L514 480 L502 506 L238 506 Z" fill="url(#gWood)" stroke="#6d3f14" stroke-width="3"/>
        <text x="370" y="499" text-anchor="middle" font-size="15" font-weight="900" fill="#fff5dd" letter-spacing="4">★ くじ ★</text>
      `;
      drum = $('#drum', svg);
      ballLayer = $('#balls', svg);
      ballOut = $('#ballOut', svg);
      refreshBalls();
    }

    // 窓の中のカラーボール（飾り）
    function refreshBalls() {
      const colors = state.prizes.map(p => isLose(p) ? '#f5f5f5' : p.color);
      if (!colors.length) colors.push('#fff');
      // 下に積もった位置
      const piles = [];
      for (let row = 0; piles.length < BALL_N && row < 12; row++) {
        const y = CY + W - BALL_R - 2 - row * (BALL_R * 1.75);
        const half = Math.sqrt(Math.max(0, (W - BALL_R - 2) ** 2 - (y - CY) ** 2));
        for (let x = CX - half + (row % 2 ? BALL_R : 0); x <= CX + half && piles.length < BALL_N; x += BALL_R * 2.05) piles.push([x, y]);
      }
      balls = piles.map(([px, py], i) => ({
        px, py,
        color: colors[i % colors.length],
        phase: Math.random() * Math.PI * 2,
        orbit: 25 + Math.random() * (W - BALL_R - 30),
        sf: 0.6 + Math.random() * 0.8,
        wob: Math.random() * Math.PI * 2,
      }));
      ballLayer.innerHTML = balls.map(b => `<g><circle r="${BALL_R}" fill="${b.color}" stroke="rgba(0,0,0,.25)"/><circle r="${BALL_R}" fill="url(#gBallShade)"/></g>`).join('');
      balls.forEach((b, i) => { b.el = ballLayer.children[i]; });
      updateBalls(0, 0);
    }

    // intensity: 0 = 積もっている / 1 = 激しく回っている
    function updateBalls(intensity, time) {
      const s = intensity * intensity * (3 - 2 * intensity);
      for (const b of balls) {
        const a = b.phase + rad(angle) * b.sf;
        const cx = CX + b.orbit * Math.cos(a);
        const cy = CY + b.orbit * Math.sin(a) + Math.sin(time / 90 + b.wob) * 6;
        const x = b.px + (cx - b.px) * s;
        const y = b.py + (cy - b.py) * s;
        b.el.setAttribute('transform', `translate(${f(x)} ${f(y)})`);
      }
    }

    // 待機中にときどき「ガタッ」と揺れて呼び込み
    let spinning = false;
    function wiggle() {
      if (spinning) return;
      const t0 = performance.now(), dur = 800;
      const frame = now => {
        if (spinning) return;
        const u = Math.min(1, (now - t0) / dur);
        const damp = 1 - u;
        drum.style.transform = `rotate(${angle + Math.sin(u * Math.PI * 5) * 7 * damp}deg)`;
        updateBalls(0.18 * Math.sin(u * Math.PI), now);
        if (u < 1) requestAnimationFrame(frame);
        else { drum.style.transform = `rotate(${angle}deg)`; updateBalls(0, now); }
      };
      requestAnimationFrame(frame);
    }

    function spin(ms) {
      spinning = true;
      return new Promise(resolve => {
        const start = angle;
        const total = 360 * (2 + ms / 1000 * 0.75);
        const t0 = performance.now();
        let lastTick = Math.floor(angle / 55);
        const frame = now => {
          const u = Math.min(1, (now - t0) / ms);
          // easeInOutCubic とその微分（速さ）
          const e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
          const v = (u < 0.5 ? 12 * u ** 2 : 3 * (-2 * u + 2) ** 2) / 3;
          const lag = boost - boostShown;
          boostShown += lag * 0.2;
          angle = start + total * e + boostShown;
          drum.style.transform = `rotate(${angle}deg)`;
          updateBalls(Math.min(1, v + lag / 60), now);
          const tick = Math.floor(angle / 55);
          if (tick !== lastTick) { lastTick = tick; Sound.rattle(); }
          if (u < 1) requestAnimationFrame(frame);
          else { angle %= 360; boost = boostShown = 0; spinning = false; updateBalls(0, now); resolve(); }
        };
        requestAnimationFrame(frame);
      });
    }

    // 連打1回ごとにガラポンをグイッと回す（見た目だけ）
    function nudge() { boost += 28; }

    // 光り方は強いほうを優先（虹 > 激アツ > 連打MAX の金）
    const GLOW_RANK = { gold: 1, hot: 2, rainbow: 3 };
    let glow = null;
    function setGlow(kind) {
      if (kind && glow && GLOW_RANK[kind] < GLOW_RANK[glow]) return;
      glow = kind;
      for (const k of Object.keys(GLOW_RANK)) svg.classList.toggle(`glow-${k}`, kind === k);
    }
    const center = () => {
      const r = svg.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.42 };
    };

    // mystery = true のときは中身がわからない「？」玉
    async function dropBall(color, shine, mystery = false) {
      ballOut.innerHTML = mystery
        ? `<circle r="20" fill="#f5f5f5" stroke="rgba(0,0,0,.3)" stroke-width="1.5"/><circle r="20" fill="url(#gBallShade)"/><text y="9" text-anchor="middle" font-size="26" font-weight="900" fill="#e53935">?</text>`
        : `<circle r="20" fill="${color}" stroke="rgba(0,0,0,.3)" stroke-width="1.5"/><circle r="20" fill="url(#gBallShade)"/>`;
      ballOut.classList.toggle('glow', shine);
      ballOut.setAttribute('opacity', '1');
      Sound.pop();
      const anim = ballOut.animate([
        { transform: 'translate(300px, 392px) scale(.2)', opacity: 0, offset: 0 },
        { transform: 'translate(300px, 398px) scale(1)', opacity: 1, offset: 0.12, easing: 'cubic-bezier(.5,0,1,1)' },
        { transform: 'translate(306px, 460px) scale(1)', offset: 0.4, easing: 'cubic-bezier(0,0,.5,1)' },
        { transform: 'translate(324px, 432px) scale(1)', offset: 0.56, easing: 'cubic-bezier(.5,0,1,1)' },
        { transform: 'translate(342px, 460px) scale(1)', offset: 0.72, easing: 'cubic-bezier(0,0,.4,1)' },
        { transform: 'translate(410px, 460px) scale(1)', opacity: 1, offset: 1 },
      ], { duration: 1200, fill: 'forwards' });
      setTimeout(() => Sound.bounce(), 480);
      setTimeout(() => Sound.bounce(), 860);
      // clearBall() でキャンセルされた場合は reject するので、演出を止めずに先へ進む
      await anim.finished.catch(() => {});
    }

    function clearBall() {
      ballOut.getAnimations().forEach(a => a.cancel());
      ballOut.setAttribute('opacity', '0');
      ballOut.classList.remove('glow');
    }

    return { build, refreshBalls, spin, dropBall, clearBall, nudge, setGlow, wiggle, center };
  })();

  // ======================================================================
  // 紙吹雪・花火（canvas）
  // ======================================================================
  const FX = (() => {
    const cv = $('#fx');
    const g = cv.getContext('2d');
    const COLORS = ['#ff3b3b', '#ffd400', '#2ecc71', '#3fa9ff', '#ff66cc', '#ff8c1a', '#ffffff', '#b388ff'];
    const MAX = 1200;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    let W = 0, H = 0, k = 1, parts = [], raf = 0, timers = [];

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      W = innerWidth; H = innerHeight; k = H / 900;
      cv.width = W * dpr; cv.height = H * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    addEventListener('resize', resize);
    resize();

    function confetti(x, y, vx, vy) {
      if (parts.length >= MAX) return;
      parts.push({ t: 'c', x, y, vx, vy, w: rnd(7, 13) * k, h: rnd(10, 18) * k, a: rnd(0, 6.3), va: rnd(-.2, .2), fl: rnd(0, 6.3), vf: rnd(.08, .2), c: pick(COLORS) });
    }
    function rain(n) { for (let i = 0; i < n; i++) confetti(rnd(0, W), rnd(-H * .6, -20), rnd(-1, 1), rnd(1, 4) * k); kick(); }
    function cannon(side, n) {
      for (let i = 0; i < n; i++) {
        const ang = rad(side < 0 ? rnd(-78, -48) : rnd(-132, -102));
        const spd = rnd(16, 30) * k;
        confetti(side < 0 ? 0 : W, H, Math.cos(ang) * spd, Math.sin(ang) * spd);
      }
      kick();
    }
    function firework(x, y, n = 80) {
      const c = pick(COLORS), c2 = pick(COLORS);
      for (let i = 0; i < n && parts.length < MAX; i++) {
        const ang = i / n * Math.PI * 2, spd = rnd(2, 7.5) * k;
        parts.push({ t: 'f', x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, c: i % 3 ? c : c2, life: 1, decay: rnd(.01, .018), r: rnd(2, 3.8) * k });
      }
      kick();
    }
    const rad = d => d * Math.PI / 180;

    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    function loop() {
      g.clearRect(0, 0, W, H);
      const next = [];
      for (const p of parts) {
        if (p.t === 'c') {
          p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.16 * k;
          p.x += p.vx + Math.sin(p.fl) * 0.8; p.y += p.vy;
          p.a += p.va; p.fl += p.vf;
          if (p.y > H + 40) continue;
          g.save();
          g.translate(p.x, p.y);
          g.rotate(p.a);
          g.scale(1, Math.cos(p.fl));
          g.fillStyle = p.c;
          g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          g.restore();
        } else {
          p.vx *= 0.965; p.vy = p.vy * 0.965 + 0.04 * k;
          p.x += p.vx; p.y += p.vy; p.life -= p.decay;
          if (p.life <= 0) continue;
          g.globalAlpha = p.life;
          g.fillStyle = p.c;
          g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
          g.globalAlpha = 1;
        }
        next.push(p);
      }
      parts = next;
      raf = parts.length ? requestAnimationFrame(loop) : 0;
      if (!parts.length) g.clearRect(0, 0, W, H);
    }

    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    function stop() { timers.forEach(clearTimeout); timers = []; }

    function spark(x, y, n = 14) {
      for (let i = 0; i < n && parts.length < MAX; i++) {
        const ang = Math.random() * Math.PI * 2, spd = rnd(2, 8) * k;
        parts.push({ t: 'f', x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, c: pick(['#fff', '#ffea00', '#ff9100', '#ff4081']), life: 1, decay: rnd(.03, .06), r: rnd(1.5, 3.2) * k });
      }
      kick();
    }

    return {
      spark,
      burst(n = 140) { firework(W / 2, H / 2, n); spark(W / 2, H / 2, 60); },
      jackpot() {
        stop();
        cannon(-1, 140); cannon(1, 140); rain(160);
        // 結果を閉じるまで（最大15秒）花火を打ち上げ続ける
        let n = 0;
        const shoot = () => { firework(rnd(W * .1, W * .9), rnd(H * .1, H * .5), 90); if (++n < 40) later(380, shoot); };
        later(250, shoot);
        for (let i = 1; i <= 8; i++) later(i * 900, () => { rain(60); cannon(-1, 35); cannon(1, 35); });
      },
      big() {
        stop();
        cannon(-1, 100); cannon(1, 100); rain(80);
        for (let i = 0; i < 4; i++) later(200 + i * 450, () => firework(rnd(W * .2, W * .8), rnd(H * .15, H * .45), 70));
      },
      normal() { stop(); cannon(-1, 60); cannon(1, 60); },
      stop,
    };
  })();

  // ======================================================================
  // ドーパミン演出（連打ゲージ・予告カットイン・ガチャ風カプセル）
  //   ※ すべて見た目だけ。当選結果はボタンを押した瞬間に決まっている。
  // ======================================================================
  const Hype = (() => {
    const mashEl = $('#mash'), gaugeFill = $('#gaugeFill'), mashCount = $('#mashCount');
    const speedLines = $('#speedLines'), blackout = $('#blackout');
    const cutin = $('#cutin'), cutinText = $('#cutinText');
    const stage = $('#capsule'), capWrap = $('#capWrap'), capBall = $('#capBall'), capLabel = $('#capLabel'), capFlash = $('#capFlash');
    const MASH_MAX = 20;
    const RARITY = ['white', 'blue', 'gold', 'rainbow'];
    const RARITY_LABEL = { white: '', blue: 'レア!', gold: '激レア!!', rainbow: '超激レア!!!' };
    let mashing = false, presses = 0;
    let capsuleOpen = false, tapWaiter = null;
    let holdMs = 150, holdTimer = 0;   // 押しっぱなしの自動加算（タッチモニター向け）

    const restart = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

    /*
     * 演出の台本を決める。
     *   level  : 回転中の予告（0 なし / 1 チャンス / 2 激アツ / 3 虹確定）
     *   stages : カプセルの光り方（白 → 青 → 金 → 虹）
     * 虹は A賞（超ハデ）のときだけ出るので「確定」はウソにならない。
     * それ以外はたまにガセ予告・ガセ昇格が入る。
     */
    function plan(prize) {
      const tier = TIER[prize.effect];
      const r = Math.random();
      let level;
      if (tier === 3) level = r < 0.75 ? 3 : 2;
      else if (tier === 2) level = r < 0.6 ? 2 : 1;
      else if (tier === 1) level = r < 0.08 ? 2 : r < 0.45 ? 1 : 0;
      else level = r < 0.05 ? 2 : r < 0.3 ? 1 : 0;
      const stages = RARITY.slice(0, tier + 1);
      const fake = tier === 0 && Math.random() < 0.25; // ガセ昇格（青く光るけど…）
      if (fake) stages.push('blue');
      return { level, stages, fake };
    }

    // ---- 連打ゲージ ----
    const mashLabel = $('#mashLabel');
    const MILESTONES = { 5: ['いいぞ!', '#2979ff', 0], 10: ['すごい!!', '#ff6d00', 1], 15: ['ヤバい!!!', '#d50000', 2] };

    // 画面に飛び出す文字（1秒で消える）
    function popText(text, color, x, y) {
      $$('.pop-text').forEach(old => old.remove()); // 重ならないように前の文字は消す
      const el = document.createElement('div');
      el.className = 'pop-text';
      el.textContent = text;
      el.style.cssText = `left:${x}px;top:${y}px;--c:${color}`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }

    function startMash(ms) {
      mashing = true;
      presses = 0;
      // 押しっぱなしでも MAX に届く間隔（タッチモニターでも指を置くだけでためられる）
      holdMs = clamp(ms * 0.85 / MASH_MAX, 45, 150);
      gaugeFill.style.width = '0%';
      mashCount.textContent = '0';
      mashLabel.innerHTML = '連打でパワーをためろ!!<small>タップ連打でも 押しっぱなしでも OK</small>';
      mashLabel.classList.remove('max');
      mashEl.classList.remove('hidden', 'max');
      speedLines.classList.remove('hidden');
      Sound.riser(ms / 1000);
    }
    // x, y: タッチした位置（キーボードのときは省略）
    function mash(x, y) {
      if (!mashing) return;
      presses++;
      gaugeFill.style.width = `${Math.min(1, presses / MASH_MAX) * 100}%`;
      mashCount.textContent = presses >= MASH_MAX ? 'MAX!!' : String(presses);
      restart(mashCount, 'pop');
      Sound.mash(presses);
      Garapon.nudge();
      const r = gaugeFill.getBoundingClientRect();
      FX.spark(r.right, r.top + r.height / 2, presses >= MASH_MAX ? 24 : 10);
      if (x != null) FX.spark(x, y, 12);

      const c = Garapon.center();
      if (MILESTONES[presses]) {
        const [text, color, step] = MILESTONES[presses];
        popText(text, color, c.x + (Math.random() - 0.5) * 120, c.y);
        Sound.upgrade(step);
      }
      if (presses === MASH_MAX) {
        mashEl.classList.add('max');
        mashLabel.textContent = 'パワーMAX!!';
        mashLabel.classList.add('max');
        popText('MAX!!', '#aa00ff', c.x, c.y);
        const flash = document.createElement('div');
        flash.className = 'max-flash';
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 700);
        Garapon.setGlow('gold');
        FX.spark(c.x, c.y, 80);
        Sound.upgrade(3);
      }
    }

    // ---- 押しっぱなし対応（タッチモニター向け）----
    // 触った瞬間は +1、そのまま押し続けると holdMs 間隔で自動的に +1 される。
    // 連打すればその間隔より速くカウントされるので、連打の気持ちよさはそのまま。
    const held = new Set();
    function holdStart(x, y, id) {
      if (!mashing || held.has(id)) return;   // 同じ指・同じキーの押しっぱなしは1回だけ開始する
      held.add(id);
      mash(x, y);
      if (!holdTimer) holdTimer = setInterval(() => mash(), holdMs);
    }
    function holdEnd(id) {
      if (id == null) held.clear(); else held.delete(id);
      if (!held.size && holdTimer) { clearInterval(holdTimer); holdTimer = 0; }
    }
    function endMash() {
      mashing = false;
      holdEnd();
      mashEl.classList.add('hidden');
      speedLines.classList.add('hidden');
    }

    // ---- 予告カットイン ----
    const CUTINS = {
      1: { cls: 'chance', text: 'チャンス!', sound: 'chance' },
      2: { cls: 'hot', text: '激アツ!!', sound: 'hot', glow: 'hot' },
      3: { cls: 'rainbow', text: '🌈 確定演出 🌈', sound: 'rainbow', glow: 'rainbow' },
    };
    async function showCutin(level) {
      const c = CUTINS[level];
      if (level === 3) {
        blackout.classList.remove('hidden');
        restart(blackout, 'blackout');
        Sound.blackout();
        await sleep(300);
      }
      cutin.className = `cutin ${c.cls}`;
      cutinText.textContent = c.text;
      Sound[c.sound]();
      if (c.glow) Garapon.setGlow(c.glow);
      if (level >= 2) { app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake'); }
      await sleep(1050);
      if (cutin.classList.contains(c.cls)) cutin.classList.add('hidden');
      if (level === 3) blackout.classList.add('hidden');
    }
    // 回転時間に合わせて段階的に予告を出す（チャンス → 激アツ → 虹）
    async function runCutins(level, ms) {
      const at = [0.22, 0.46, 0.7];
      let t = 0;
      for (let i = 1; i <= level; i++) {
        await sleep(at[i - 1] * ms - t);
        t = at[i - 1] * ms;
        showCutin(i);
      }
    }
    function clearCutins() {
      cutin.classList.add('hidden');
      blackout.classList.add('hidden');
      Garapon.setGlow(null);
      app.classList.remove('shake');
    }

    // ---- ガチャ風カプセル ----
    // 一定時間待つか、タップ（スペースキー）されたら先へ進む
    function waitTap(ms) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); tapWaiter = null; resolve(); };
        const timer = setTimeout(done, ms);
        setTimeout(() => { tapWaiter = done; }, 200); // 連打の勢いで一瞬で飛ばないように少し待つ
      });
    }
    function tap() { tapWaiter?.(); }

    const capRays = $('#capRays');
    async function capsule({ stages, fake }) {
      capsuleOpen = true;
      capBall.className = 'capsule r-white';
      capRays.className = 'cap-rays';
      capLabel.textContent = '';
      capLabel.className = 'capsule-label';
      capWrap.className = 'capsule-wrap';
      stage.classList.remove('hidden');
      restart(capWrap, 'capsule-wrap');
      await sleep(500);
      for (let i = 0; i < stages.length; i++) {
        if (i > 0) {
          const s = stages[i];
          capBall.className = `capsule r-${s}`;
          capRays.className = `cap-rays r-${s}`;
          capLabel.textContent = fake && i === stages.length - 1 ? '…!?' : RARITY_LABEL[s];
          capLabel.className = `capsule-label l-${s}`;
          restart(capLabel, 'pop');
          restart(capFlash, 'on');
          Sound.upgrade(i);
          FX.spark(innerWidth / 2, innerHeight / 2, 30 + i * 20);
          await waitTap(450);
        }
        capWrap.classList.remove('shake'); void capWrap.offsetWidth; capWrap.classList.add('shake');
        Sound.thump();
        await waitTap(i === stages.length - 1 ? 800 : 650);
      }
      capWrap.classList.remove('shake'); void capWrap.offsetWidth; capWrap.classList.add('burst');
      restart(capFlash, 'on');
      Sound.burst();
      FX.burst();
      await sleep(380);
      stage.classList.add('hidden');
      capsuleOpen = false;
    }

    // 演出が途中で失敗したときの後始末（当選は確定済みなので結果表示へ進む）
    function cancel() {
      endMash();
      clearCutins();
      capsuleOpen = false;
      tapWaiter = null;
      stage.classList.add('hidden');
    }

    return {
      plan, startMash, mash, endMash, runCutins, clearCutins, capsule, tap, cancel, holdStart, holdEnd,
      isMashing: () => mashing,
      isCapsuleOpen: () => capsuleOpen,
    };
  })();

  // ======================================================================
  // メイン画面
  // ======================================================================
  const startBtn = $('#startBtn');
  const resultEl = $('#result');
  const app = $('#app');
  let busy = false;          // 抽選〜結果を閉じるまで true
  let resultOpen = false;
  let resultShownAt = 0;
  let lastClosedAt = 0;
  const prevShown = new Map(); // 賞ID → 前回表示した残数（数字が減ったときのアニメ用）
  const soldOut = new Map();   // 「完売!!」ハンコを表示中の賞ID → 押した時刻
  const SOLD_OUT_MS = 2800;    // ハンコを出してから一覧から消えるまで

  function renderHeader() {
    $('#title').textContent = state.title;
    document.title = state.title;
    $('#dayBadge').textContent = `${state.day}日目`;
    $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
  }

  // 当たり景品リスト：残っている当たりだけを表示し、0 個になったら消す
  function renderRemain() {
    const now = performance.now();
    // 「完売!!」ハンコの表示時間が過ぎた賞を先に片付ける
    for (const [id, at] of soldOut) if (now - at >= SOLD_OUT_MS) soldOut.delete(id);
    // さっきまで残っていて 0 個になった賞は「完売!!」ハンコを押してから消す
    for (const [id, was] of prevShown) {
      const p = prizeById(id);
      if (p && was > 0 && remaining(p) === 0 && !soldOut.has(id)) {
        soldOut.set(id, now);
        // 抽選中に描き直すと次の結果がバレるので、抽選中は結果を閉じたときに任せる
        setTimeout(() => { soldOut.delete(id); if (!busy) renderRemain(); }, SOLD_OUT_MS);
      }
    }
    const list = state.prizes.filter(p => !isLose(p) && (remaining(p) > 0 || soldOut.has(p.id)));
    $('#remainList').innerHTML = list.map(p => {
      const r = remaining(p);
      const bump = prevShown.has(p.id) && prevShown.get(p.id) !== r ? 'bump' : '';
      // 完売の行は、再描画でスタンプを押し直さないように残り時間でフェードを張り直す
      const elapsed = r === 0 ? now - (soldOut.get(p.id) ?? now) : 0;
      const cls = r === 0 ? (elapsed < 400 ? 'soldout' : 'soldout done') : '';
      const style = r === 0 ? `--c:${p.color};--fade:${Math.max(0, SOLD_OUT_MS - elapsed - 600)}ms` : `--c:${p.color}`;
      return `<li style="${style}" class="${cls}">
          <span class="ball"></span>
          <div class="info">
            <div class="pname">${esc(p.name)}</div>
            ${p.item ? `<div class="pitem">${esc(p.item)}</div>` : ''}
            ${p.showRemaining && r === 1 ? '<span class="hurry last">🔥 ラスト1!! 🔥</span>' : p.showRemaining && r > 1 && r <= 3 ? '<span class="hurry">残りわずか!!</span>' : ''}
          </div>
          ${p.showRemaining ? `<div class="left">あと<b class="${bump}">${r}</b>個</div>` : ''}
        </li>`;
    }).join('');
    prevShown.clear();
    list.forEach(p => { if (remaining(p) > 0) prevShown.set(p.id, remaining(p)); });
    const emptyEl = $('#remainEmpty');
    emptyEl.classList.toggle('hidden', list.length > 0);
    // ハズレくじが残っているときは「まだ引ける」ことが分かるようにする
    emptyEl.innerHTML = totalRemaining() > 0
      ? '当たりはすべて出ました！<br>ハズレくじは まだ引けます'
      : '当たりはすべて出ました！<br>ありがとうございました！';
    renderTicker();
  }

  // ---------- 電光掲示板の煽り文 ----------
  // 直近に使った文は避けて、そのときの状況に合う候補から選ぶ
  let hypeRecent = [];
  function pickHype(list, n) {
    const fresh = list.filter(s => !hypeRecent.includes(s));
    const pool = fresh.length >= n ? fresh.slice() : list.slice();
    const picked = [];
    while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    hypeRecent = [...picked, ...hypeRecent].slice(0, 3);
    return picked;
  }

  // いまの状況に合わせた煽り文の候補（内容が薄い日でも文が尽きないように常時出せるものも入れておく）
  function hypeCandidates() {
    const rest = totalRemaining();
    const eff = id => prizeById(id)?.effect ?? 'lose';
    const today = state.history.filter(h => h.day === state.day);
    const n = today.length;
    let loseStreak = 0, winStreak = 0;
    for (let i = n - 1; i >= 0 && eff(today[i].id) === 'lose'; i--) loseStreak++;
    for (let i = n - 1; i >= 0 && eff(today[i].id) !== 'lose'; i--) winStreak++;
    const winOnly = state.prizes.filter(p => !isLose(p));
    const gone = winOnly.filter(p => p.counts[state.day - 1] > 0 && remaining(p) === 0);
    const out = [`🍟 ${state.title} 🍗`, '🎪 何が出るかな!? お楽しみ!!', `🎁 景品は全 ${winOnly.length} 種類!!`];
    if (state.fxMode === 'simple') out.push('⚡ サクサク進みます!!');
    else out.push('⚡ 連打でパワーをためろ!! ⚡', '🌈 虹が出たら…!? 🌈');
    if (n && n % 10 === 0) out.push(`🎉 本日 ${n} 人目 到達!!`);
    else if (n) out.push(`🙌 挑戦者 ${n} 人目!!`);
    if (loseStreak >= 2) out.push(`😱 ハズレ ${loseStreak} 連続…次は当たる!!`);
    if (winStreak >= 2) out.push(`🔥 当たり ${winStreak} 連続!! 好調!!`);
    if (winOnly.some(p => remaining(p) === 1)) out.push('⚠️ 残りわずか!! お早めにどうぞ!!');
    // 完売の告知は「直近に尽きた賞」を名指しする（一覧の並び順で先頭固定にしない）
    const goneIds = new Set(gone.map(p => p.id));
    const lastGone = [...today].reverse().find(h => goneIds.has(h.id));
    if (lastGone) out.push(`😢 ${nameOf(lastGone.id)} は完売しました…`);
    if (rest > 0 && rest <= 5) out.push(`⏳ 本日のこり ${rest} 本!!`);
    return out;
  }

  // 下の電光掲示板（「あと○個」表示の賞は 0 個になると消える）
  function renderTicker() {
    const rest = totalRemaining();
    const counts = state.prizes
      .filter(p => !isLose(p) && p.showRemaining && remaining(p) > 0)
      .map(p => remaining(p) === 1 ? `🚨 ${p.name} ラスト1個!! 🚨` : `🔥 ${p.name} のこり ${remaining(p)}個!!`);
    // 直近 5 回以内に B賞 以上が出ていたら煽る（完売後は終了メッセージだけにする）
    const recent = state.history.filter(h => h.day === state.day).slice(-5).reverse()
      .map(h => prizeById(h.id)).find(p => p && TIER[p.effect] >= 2);
    if (recent && rest > 0) {
      counts.unshift(pickHype([
        `🎉 さっき ${recent.name} が出たよ!! 🎉`,
        `🎊 たった今 ${recent.name} が出ました!!`,
        `✨ ${recent.name} おめでとう!! ✨`,
      ], 1)[0]);
    }
    const hype = rest > 0 ? pickHype(hypeCandidates(), 3) : ['本日のくじは終了しました。ありがとうございました!!'];
    const msg = [...counts, ...hype].join('　　　');
    const track = $('#ticker');
    track.innerHTML = `<span>${esc(msg)}</span><span>${esc(msg)}</span>`;
    track.style.animationDuration = `${Math.max(12, msg.length * 0.28)}s`;
  }

  function updateStartBtn() {
    const empty = totalRemaining() === 0;
    const mashing = Hype.isMashing();
    startBtn.disabled = (busy && !mashing) || empty;
    startBtn.classList.toggle('sold-out', empty && !busy);
    startBtn.classList.toggle('mashing', mashing);
    startBtn.textContent = mashing ? '連打!! 押しっぱなしOK!!' : busy ? '抽選中…' : empty ? '本日のくじは終了しました' : 'くじスタート！';
  }

  function refreshMain() {
    renderHeader();
    renderRemain();
    updateStartBtn();
    Garapon.refreshBalls();
  }

  // 背景をふわふわ流れる絵文字
  function buildFloaters() {
    const EMOJI = ['🍟', '🍗', '⭐', '✨', '🎉', '💎', '🔥', '🍀'];
    $('#floaters').innerHTML = Array.from({ length: 16 }, (_, i) => {
      const d = 14 + Math.random() * 14;
      return `<span class="floater" style="left:${(i / 16) * 100 + Math.random() * 5}%;--s:${3 + Math.random() * 4}vh;--d:${d}s;--delay:${-Math.random() * d}s">${EMOJI[i % EMOJI.length]}</span>`;
    }).join('');
  }

  async function startDraw() {
    if (busy || resultOpen || Admin.isOpen() || performance.now() - lastClosedAt < 400) return;
    // 他ウィンドウで引かれた記録を取りこぼさない（保存内容が変わっていたら先に取り込む）
    if (syncFromStore()) refreshMain();
    const prize = drawPrize();
    if (!prize) { updateStartBtn(); return; }

    // 先に結果を確定・保存しておく（演出中に電源が落ちても数がずれない）
    busy = true;
    state.history.push({ id: prize.id, day: state.day, t: Date.now() });
    save();

    // 演出中に例外が出ても busy を立てたままにしない（当選は保存済みなので結果は必ず出す）
    try {
      Sound.unlock();
      requestWakeLock();
      Garapon.clearBall();
      const ms = state.spinSeconds * 1000;
      if (state.fxMode === 'simple') {
        updateStartBtn();
        await Garapon.spin(ms);
        await Garapon.dropBall(prize.color, prize.effect === 'jackpot');
        await sleep(prize.effect === 'jackpot' ? 700 : 300);
      } else {
        // ドーパミン全開モード：連打 → 予告 → ？玉 → カプセル → 結果
        const plan = Hype.plan(prize);
        Hype.startMash(ms);
        updateStartBtn();
        await Promise.all([Garapon.spin(ms), Hype.runCutins(plan.level, ms)]);
        Hype.endMash();
        updateStartBtn();
        await Garapon.dropBall(prize.color, plan.level >= 2, true);
        Hype.clearCutins();
        await Hype.capsule(plan);
      }
    } catch (err) {
      console.error('演出中にエラーが発生しました', err);
      Hype.cancel();
      Garapon.clearBall();
    }
    // 結果表示も守る（ここで例外が出ても「抽選中…」のまま操作不能にしない）
    try {
      showResult(prize);
    } catch (err) {
      console.error('結果表示に失敗しました', err);
      busy = false;
      resultOpen = false;
      resultEl.classList.add('hidden');
      updateStartBtn();
    }
  }

  const RESULT_RANK = { jackpot: '✦ 超激レア ✦', big: '激レア', normal: 'レア', lose: '' };
  const RESULT_TEXT = {
    jackpot: ['🎉 大当たり！！ 🎉', 'おめでとうございます！！'],
    big: ['✨ あたり！ ✨', 'おめでとうございます！'],
    normal: ['あたり！', 'おめでとうございます！'],
    lose: ['ざんねん…', '次は当たるかも!? また挑戦してね！'],
  };

  function showResult(prize) {
    const [sub, msg] = RESULT_TEXT[prize.effect];
    resultEl.className = `overlay effect-${prize.effect}`;
    resultEl.style.setProperty('--pc', prize.color);
    $('#resultRank').textContent = state.fxMode === 'dopamine' ? RESULT_RANK[prize.effect] : '';
    $('#resultSub').textContent = sub;
    $('#resultName').innerHTML = [...prize.name].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`).join('');
    $('#resultItem').textContent = prize.item;
    $('#resultMsg').textContent = msg;
    const no = state.history.filter(h => h.day === state.day).length;
    $('#resultNo').innerHTML = `本日 <b>${no}</b> 人目のチャレンジャー`;
    resultOpen = true;
    resultShownAt = performance.now();

    switch (prize.effect) {
      case 'jackpot':
        FX.jackpot(); Sound.fanfare();
        app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
        break;
      case 'big':
        FX.big(); Sound.win();
        app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
        break;
      case 'normal': FX.normal(); Sound.chime(); break;
      default: Sound.lose();
    }
  }

  function closeResult() {
    if (!resultOpen || performance.now() - resultShownAt < 800) return;
    resultOpen = false;
    busy = false;
    lastClosedAt = performance.now();
    resultEl.classList.add('hidden');
    app.classList.remove('shake');
    // 演出中に他ウィンドウで引かれた分をここで取り込む（古い内容で上書きしないため）
    if (syncFromStore()) { renderHeader(); Garapon.refreshBalls(); }
    FX.stop();
    Garapon.clearBall();
    renderRemain(); // 結果を見せてから残り数を減らす（裏でネタバレしない）
    updateStartBtn();
  }

  // スクリーンセーバー・画面オフを防ぐ（対応ブラウザのみ）
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* 非対応なら何もしない */ }
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ======================================================================
  // パスワード
  // ======================================================================
  const Pin = (() => {
    const dlg = $('#pinDialog'), input = $('#pinInput'), err = $('#pinError');
    let onOk = null;
    function ask(cb) {
      if (!state.pin) { cb(); return; }
      onOk = cb;
      input.value = '';
      err.textContent = '';
      dlg.classList.remove('hidden');
      setTimeout(() => input.focus(), 50);
    }
    function close() { dlg.classList.add('hidden'); onOk = null; }
    $('#pinForm').addEventListener('submit', e => {
      e.preventDefault();
      if (input.value === state.pin) { const cb = onOk; close(); cb?.(); }
      else { err.textContent = 'パスワードが違います'; input.value = ''; input.focus(); }
    });
    $('#pinCancel').addEventListener('click', close);
    $('#keypad').addEventListener('click', e => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === 'clear') input.value = '';
      else if (k === 'back') input.value = input.value.slice(0, -1);
      else input.value += k;
    });
    return { ask, close, isOpen: () => !dlg.classList.contains('hidden') };
  })();

  // ======================================================================
  // 管理メニュー
  // ======================================================================
  const Admin = (() => {
    const modal = $('#admin'), body = $('#adminBody');
    let tab = 'status';
    let draft = null;   // 景品設定の編集中データ
    let dirty = false;

    const isOpen = () => !modal.classList.contains('hidden');

    function open() {
      tab = 'status'; draft = null; dirty = false;
      modal.classList.remove('hidden');
      render();
    }
    function close() {
      if (dirty && !confirm('景品設定の変更がまだ保存されていません。保存せずに閉じますか？')) return;
      draft = null; dirty = false;
      modal.classList.add('hidden');
      refreshMain();
    }
    function switchTab(t) {
      if (t === tab) return;
      if (dirty && !confirm('景品設定の変更がまだ保存されていません。保存せずに移動しますか？')) return;
      if (tab === 'prizes') { draft = null; dirty = false; }
      tab = t;
      render();
    }
    function render() {
      $$('#adminTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      body.innerHTML = VIEWS[tab]();
    }
    // 別ウィンドウの変更を管理メニューにも反映する（編集中なら確認してから捨てる）
    function syncFromStorage() {
      if (!isOpen()) return;
      if (dirty && !confirm('別のウィンドウで設定が変更されました。編集中の内容を破棄して最新の内容を読み直しますか？')) return;
      draft = null; dirty = false;
      render();
    }
    function changed() { save(); render(); refreshMain(); }

    // ---- 各タブの表示 ----
    const VIEWS = {
      status() {
        const day = state.day;
        let sumSet = 0, sumDrawn = 0, sumRem = 0;
        const rows = state.prizes.map(p => {
          const set = p.counts[day - 1], d = drawnCount(p.id, day), r = remaining(p);
          sumSet += set; sumDrawn += d; sumRem += r;
          const id = esc(p.id);
          return `<tr>
            <td class="nowrap"><span class="dot" style="background:${p.color}"></span><b>${esc(p.name)}</b></td>
            <td class="muted">${esc(p.item)}</td>
            <td class="num">${set}</td>
            <td class="num">${d}</td>
            <td class="num strong ${r === 0 ? 'zero' : ''}">${r}</td>
            <td class="adj">
              <button class="btn sm" data-act="adj" data-id="${id}" data-d="-1">−1</button><input type="number" min="0" class="rem-input" data-act="setrem" data-id="${id}" value="${r}"><button class="btn sm" data-act="adj" data-id="${id}" data-d="1">+1</button>
            </td>
          </tr>`;
        }).join('');
        const last = lastToday();
        return `
          <p class="lead">現在 <b>${day}日目</b> です。残りのくじ：<b>${sumRem}</b> 本</p>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>賞</th><th>景品</th><th class="num">${day}日目の用意数</th><th class="num">出た数</th><th class="num">残り</th><th>残りを調整</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td colspan="2">合計</td><td class="num">${sumSet}</td><td class="num">${sumDrawn}</td><td class="num">${sumRem}</td><td></td></tr></tfoot>
          </table></div>
          <div class="actions">
            <button class="btn warn" data-act="undo" ${last ? '' : 'disabled'}>直前の1回を取り消す${last ? `（${esc(nameOf(last.id))} ${fmtTime(last.t)}）` : ''}</button>
          </div>
          <p class="note">
            ・残りの数を変えると、その日の「用意数」が自動で調整されます（景品を追加・撤去したときなどに使ってください）。<br>
            ・「直前の1回を取り消す」は、間違えてくじを引いてしまったときに使います。
          </p>`;
      },

      prizes() {
        if (!draft) { draft = clone(state.prizes); dirty = false; }
        const opts = sel => Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
        const rows = draft.map((p, i) => `<tr>
            <td><input type="color" data-field="color" data-i="${i}" value="${p.color}"></td>
            <td><input type="text" class="w-name" data-field="name" data-i="${i}" value="${esc(p.name)}"></td>
            <td><input type="text" class="w-item" data-field="item" data-i="${i}" value="${esc(p.item)}" placeholder="例：景品A 1個無料"></td>
            <td><input type="number" min="0" class="w-num" data-field="c0" data-i="${i}" value="${p.counts[0]}"></td>
            <td><input type="number" min="0" class="w-num" data-field="c1" data-i="${i}" value="${p.counts[1]}"></td>
            <td class="center"><input type="checkbox" data-field="showRemaining" data-i="${i}" ${p.showRemaining ? 'checked' : ''}></td>
            <td><select data-field="effect" data-i="${i}">${opts(p.effect)}</select></td>
            <td class="nowrap">
              <button class="btn sm" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
              <button class="btn sm" data-act="down" data-i="${i}" ${i === draft.length - 1 ? 'disabled' : ''}>▼</button>
              <button class="btn sm danger" data-act="del" data-i="${i}">削除</button>
            </td>
          </tr>`).join('');
        return `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>色</th><th>賞の名前</th><th>景品</th><th>1日目の数</th><th>2日目の数</th><th>あと○個<br>を表示</th><th>演出</th><th>並び替え・削除</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div class="actions">
            <button class="btn" data-act="add">＋ 賞を追加</button>
            <span class="spacer"></span>
            <button class="btn" data-act="revert" ${dirty ? '' : 'disabled'}>変更を取り消す</button>
            <button class="btn primary big" data-act="savePrizes">保存する</button>
          </div>
          <p class="note">
            ・「1日目の数」「2日目の数」はその日に箱に入れるくじの本数です。くじは残っている本数から公平に1本ずつ引かれます。<br>
            ・「ハズレ」の数を増やすと当たりが出にくくなります。来場者数の見込みに合わせて調整してください（0 なら必ず何か当たります）。<br>
            ・「あと○個を表示」にチェックした賞は、メイン画面に残り数が出ます。0 個になると表示が消えます。<br>
            ・演出「超ハデ」は花火・ファンファーレ付き、「ハズレ扱い」は当たり一覧に表示されません。<br>
            ・今日すでに出た数より少なくすると、その賞の残りは 0 になります。
          </p>`;
      },

      day() {
        const d = state.day;
        return `
          <div class="day-now">現在：<b>${d}日目</b></div>
          <div class="actions">
            <button class="btn big ${d === 1 ? 'primary' : ''}" data-act="setDay" data-day="1">1日目にする</button>
            <button class="btn big ${d === 2 ? 'primary' : ''}" data-act="setDay" data-day="2">2日目にする</button>
          </div>
          <p class="note">2日目に切り替えると、残りの数は「2日目の数」から数え直しになります。1日目の記録は消えません（1日目に戻すこともできます）。</p>
          <hr>
          <h3>やり直し（テスト用）</h3>
          <button class="btn warn" data-act="resetToday">${d}日目の抽選結果をすべて消す</button>
          <p class="note">開店前に試しに引いたくじを消して、${d}日目の残り数を用意数に戻します。</p>
          <h3>全データ初期化</h3>
          <button class="btn danger" data-act="resetAll">すべて初期状態に戻す</button>
          <p class="note">景品設定・履歴・パスワードなど、すべてのデータが初期状態に戻ります。</p>`;
      },

      history() {
        const rows = state.prizes.map(p => `<tr>
            <td class="nowrap"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</td>
            <td class="num">${drawnCount(p.id, 1)} / ${p.counts[0]}</td>
            <td class="num">${drawnCount(p.id, 2)} / ${p.counts[1]}</td>
            <td class="num"><b>${drawnCount(p.id, 1) + drawnCount(p.id, 2)}</b></td>
          </tr>`).join('');
        const today = state.history.map((h, i) => ({ ...h, n: i })).filter(h => h.day === state.day);
        const list = today.slice(-200).reverse().map((h, i) => {
          const p = prizeById(h.id);
          return `<li><span class="dot" style="background:${p?.color ?? '#ccc'}"></span>${today.length - i}回目　${fmtTime(h.t)}　<b>${esc(nameOf(h.id))}</b></li>`;
        }).join('');
        const c1 = state.history.filter(h => h.day === 1).length, c2 = state.history.filter(h => h.day === 2).length;
        return `
          <h3 style="margin-top:0">集計（出た数 / 用意数）</h3>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>賞</th><th class="num">1日目</th><th class="num">2日目</th><th class="num">合計</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td>くじを引いた回数</td><td class="num">${c1}</td><td class="num">${c2}</td><td class="num">${c1 + c2}</td></tr></tfoot>
          </table></div>
          <h3>${state.day}日目の履歴（新しい順）</h3>
          ${list ? `<ul class="hist-list">${list}</ul>` : '<p class="note">まだくじは引かれていません。</p>'}
          <div class="actions"><button class="btn" data-act="exportCsv">履歴を CSV で保存（Excel 用）</button></div>`;
      },

      settings() {
        return `
          <div class="form">
            <label for="setTitle">タイトル</label>
            <input type="text" id="setTitle" value="${esc(state.title)}">
            <label for="setFxMode">演出モード</label>
            <select id="setFxMode">${Object.entries(FX_MODES).map(([k, v]) => `<option value="${k}" ${k === state.fxMode ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <label for="setSpin">ガラポンの回転時間</label>
            <div><input type="number" id="setSpin" min="1" max="8" step="0.5" value="${state.spinSeconds}"> 秒</div>
            <label for="setSound">効果音</label>
            <div><input type="checkbox" id="setSound" ${state.sound ? 'checked' : ''}> 鳴らす</div>
            <label for="setPin">管理者パスワード</label>
            <div><input type="text" id="setPin" value="${esc(state.pin)}" inputmode="numeric"> <span class="note">空欄にするとパスワードなし</span></div>
          </div>
          <div class="actions"><button class="btn primary" data-act="saveSettings">設定を保存</button></div>
          <hr>
          <h3>バックアップ</h3>
          <p class="note">設定と履歴をファイルに保存・復元できます。別の PC に移すときや、念のための控えに使ってください。</p>
          <div class="actions">
            <button class="btn" data-act="exportJson">バックアップを保存</button>
            <button class="btn" data-act="importJson">バックアップから復元</button>
          </div>`;
      },
    };

    // ---- 操作 ----
    function setRemaining(id, value) {
      const p = prizeById(id);
      if (!p) return;
      p.counts[state.day - 1] = drawnCount(id) + Math.max(0, value);
      changed();
    }

    const ACTIONS = {
      adj: el => { const p = prizeById(el.dataset.id); if (p) setRemaining(p.id, remaining(p) + Number(el.dataset.d)); },
      undo: () => {
        const last = lastToday();
        if (!last || !confirm(`直前の結果（${nameOf(last.id)}・${fmtTime(last.t)}）を取り消しますか？`)) return;
        state.history.splice(state.history.lastIndexOf(last), 1);
        changed();
        toast(`${nameOf(last.id)} の結果を取り消しました`);
      },

      add: () => {
        draft.push({ id: newId(), name: `${String.fromCharCode(65 + draft.filter(p => !isLose(p)).length)}賞`, item: '', color: '#8e24aa', counts: [0, 0], showRemaining: false, effect: 'normal' });
        dirty = true; render();
      },
      del: el => {
        const i = Number(el.dataset.i);
        if (!confirm(`「${draft[i].name}」を削除しますか？`)) return;
        draft.splice(i, 1); dirty = true; render();
      },
      up: el => { const i = Number(el.dataset.i); [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; dirty = true; render(); },
      down: el => { const i = Number(el.dataset.i); [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; dirty = true; render(); },
      revert: () => { draft = null; dirty = false; render(); },
      savePrizes: () => {
        if (!draft.length) { alert('賞を1つ以上登録してください。'); return; }
        if (draft.some(p => !p.name.trim())) { alert('賞の名前が空欄のものがあります。'); return; }
        state.prizes = draft.map(p => ({ ...p, name: p.name.trim(), item: p.item.trim() }));
        draft = null; dirty = false;
        changed();
        toast('景品設定を保存しました');
      },

      setDay: el => {
        const d = Number(el.dataset.day);
        if (d === state.day) return;
        const msg = d === 2
          ? '2日目を開始しますか？\n残りの数が「2日目の数」から数え直しになります。\n（1日目の記録は残ります）'
          : '1日目に戻しますか？';
        if (!confirm(msg)) return;
        state.day = d;
        prevShown.clear();
        changed();
        toast(`${d}日目に切り替えました`);
      },
      resetToday: () => {
        const n = state.history.filter(h => h.day === state.day).length;
        if (!confirm(`${state.day}日目の抽選結果 ${n} 件をすべて消して、残り数を用意数に戻しますか？\n（元に戻せません）`)) return;
        state.history = state.history.filter(h => h.day !== state.day);
        prevShown.clear();
        changed();
        toast(`${state.day}日目の結果をリセットしました`);
      },
      resetAll: () => {
        if (!confirm('すべてのデータを初期状態に戻しますか？\n景品設定・履歴・パスワードがすべて消えます。')) return;
        if (!confirm('本当によろしいですか？（元に戻せません）')) return;
        state = defaultState();
        prevShown.clear();
        changed();
        toast('初期化しました');
      },

      exportCsv: () => {
        const lines = [['日', '時刻', '賞', '景品']];
        state.history.forEach(h => {
          const d = new Date(h.t);
          lines.push([`${h.day}日目`, `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${fmtTime(h.t)}`, nameOf(h.id), prizeById(h.id)?.item ?? '']);
        });
        const csv = lines.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        download(`くじ履歴_${stamp()}.csv`, '\uFEFF' + csv, 'text/csv');
      },
      saveSettings: () => {
        const title = $('#setTitle').value.trim();
        if (!title) { alert('タイトルを入力してください。'); return; }
        state.title = title;
        state.fxMode = FX_MODES[$('#setFxMode').value] ? $('#setFxMode').value : 'dopamine';
        state.spinSeconds = clamp(Number($('#setSpin').value) || 3.5, 1, 8);
        state.sound = $('#setSound').checked;
        state.pin = $('#setPin').value.trim();
        changed();
        toast('設定を保存しました');
      },
      exportJson: () => download(`くじバックアップ_${stamp()}.json`, JSON.stringify(state, null, 2), 'application/json'),
      importJson: () => $('#importFile').click(),
    };

    function stamp() {
      const d = new Date();
      return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    }

    $('#importFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = normalize(JSON.parse(await file.text()));
        if (!confirm(`バックアップから復元しますか？\n（賞 ${data.prizes.length} 種類・履歴 ${data.history.length} 件）\n今のデータは上書きされます。`)) return;
        state = data;
        prevShown.clear();
        changed();
        toast('復元しました');
      } catch (err) {
        alert('ファイルを読み込めませんでした: ' + err.message);
      }
    });

    body.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (el && el.tagName === 'BUTTON' && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
    });
    body.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.act === 'setrem') setRemaining(el.dataset.id, toInt(el.value));
    });
    body.addEventListener('input', e => {
      const el = e.target, field = el.dataset.field;
      if (!field || !draft) return;
      const p = draft[Number(el.dataset.i)];
      if (field === 'c0') p.counts[0] = toInt(el.value);
      else if (field === 'c1') p.counts[1] = toInt(el.value);
      else if (field === 'showRemaining') p.showRemaining = el.checked;
      else p[field] = el.value;
      if (!dirty) { dirty = true; const rv = $('[data-act="revert"]', body); if (rv) rv.disabled = false; }
    });
    $('#adminTabs').addEventListener('click', e => { if (e.target.dataset.tab) switchTab(e.target.dataset.tab); });
    $('#adminClose').addEventListener('click', close);

    return { open, close, isOpen, syncFromStorage };
  })();

  // ======================================================================
  // イベント
  // ======================================================================
  startBtn.addEventListener('click', () => { startBtn.blur(); if (!busy) startDraw(); });
  resultEl.addEventListener('click', closeResult);
  // 回転中は画面のどこをタッチしても連打としてカウント（タッチパネル対応）
  // 触った瞬間に +1、押しっぱなしなら holdMs 間隔で自動的に +1（タッチモニターでも指を置くだけでOK）
  document.addEventListener('pointerdown', e => { if (Hype.isMashing()) Hype.holdStart(e.clientX, e.clientY, e.pointerId); });
  document.addEventListener('pointerup', e => Hype.holdEnd(e.pointerId));
  document.addEventListener('pointercancel', e => Hype.holdEnd(e.pointerId));
  addEventListener('blur', () => Hype.holdEnd());
  // タッチモニターの長押しは右クリック扱いになるため、押しっぱなしを邪魔しないように抑止する
  document.addEventListener('contextmenu', e => e.preventDefault());

  // 待機中は 6 秒ごとにガラポンが「ガタッ」と揺れて呼び込み
  setInterval(() => { if (!busy && !Admin.isOpen() && totalRemaining() > 0) Garapon.wiggle(); }, 6000);
  $('#capsule').addEventListener('pointerdown', () => Hype.tap());

  $('#adminBtn').addEventListener('click', e => { e.currentTarget.blur(); if (!busy) Pin.ask(Admin.open); });
  $('#soundBtn').addEventListener('click', e => {
    e.currentTarget.blur();
    const next = !state.sound;
    syncFromStore(); // 抽選中に他ウィンドウで引かれた記録を消さないよう、保存の前に取り込む
    state.sound = next;
    save();
    renderHeader();
    if (state.sound) Sound.chime();
  });
  $('#fullscreenBtn').addEventListener('click', e => {
    e.currentTarget.blur();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  document.addEventListener('keydown', e => {
    if (Pin.isOpen()) { if (e.key === 'Escape') Pin.close(); return; }
    if (Admin.isOpen()) { if (e.key === 'Escape') Admin.close(); return; }
    if (e.code === 'Space' || e.key === 'Enter') {
      // 画面に出ているボタンにフォーカスがあるときは、そのボタンの操作（Space/Enterでの押下）を優先する
      const el = document.activeElement;
      if (el && el !== startBtn && el.tagName === 'BUTTON' && el.getClientRects().length) return;
      e.preventDefault();
      // 押しっぱなし（キーの自動リピート）でもゲージをためられるようにする
      if (e.repeat) { if (Hype.isMashing()) Hype.holdStart(null, null, e.code); return; }
      if (resultOpen) closeResult();
      else if (Hype.isMashing()) Hype.holdStart(null, null, e.code);
      else if (Hype.isCapsuleOpen()) Hype.tap();
      else startDraw();
    }
  });
  document.addEventListener('keyup', e => { if (e.code === 'Space' || e.key === 'Enter') Hype.holdEnd(e.code); });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && busy) requestWakeLock(); });

  // 別タブ・別ウィンドウで同じアプリを開いていた場合も表示をそろえる
  addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return;
    // 抽選中に描き直すと次の結果がバレるので、閉じたとき（closeResult）に任せる
    if (busy) return;
    if (!syncFromStore()) return;
    Admin.syncFromStorage();
    refreshMain();
  });

  buildFloaters();
  Garapon.build();
  refreshMain();
})();
