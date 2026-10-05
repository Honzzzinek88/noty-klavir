/* Noty → Klavír : hudební engine (bez DOM)
 * Převede přečtené noty (JSON) na "výkon" klavíristy:
 * opakování a volty, dynamika, vidlice, frázování, agogika, ritardando,
 * fermaty, artikulace a volitelný doprovod levé ruky.
 */
(function (root) {
  'use strict';

  const DYN = { ppp: .16, pp: .24, p: .34, mp: .46, mf: .58, f: .72, ff: .85, fff: .95 };

  // pořadí je důležité (konkrétnější výrazy dřív)
  const TEMPO_WORDS = [
    [/grave/i, 40], [/larghetto/i, 60], [/largo/i, 50], [/lento/i, 56], [/adagio/i, 66],
    [/andantino/i, 84], [/andante\s+con\s+moto/i, 88], [/andante/i, 76],
    [/moderato\s+cantabile/i, 92], [/allegretto/i, 112], [/moderato/i, 100],
    [/vivace|vivo/i, 150], [/allegro/i, 132], [/presto/i, 176]
  ];

  function bpmFromText(t) {
    if (!t) return null;
    for (const [re, v] of TEMPO_WORDS) if (re.test(t)) return v;
    return null;
  }

  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
  function toMidi(p) {
    if (p == null) return null;
    const s = String(p).trim();
    if (/^(r|rest|pauza|-)$/i.test(s)) return null;
    const m = s.match(/^([A-Ha-h])([#♯x]{0,2}|[b♭]{0,2})(-?\d)$/);
    if (!m) return null;
    let v = STEP[m[1].toUpperCase()];
    for (const c of m[2]) v += (c === '#' || c === '♯') ? 1 : c === 'x' ? 2 : -1;
    return v + (parseInt(m[3], 10) + 1) * 12;
  }

  // jednoduchý deterministický náhodný generátor (stejná píseň = stejný přednes)
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); };
  }

  /* ---------- normalizace dat z AI ---------- */
  function normalize(raw) {
    const song = {
      title: raw.title || 'Bez názvu',
      tempoText: raw.tempoText || raw.tempo || '',
      timeSig: Array.isArray(raw.timeSig) ? raw.timeSig.map(Number) : [4, 4],
      keyFifths: Number(raw.keyFifths) || 0,
      mode: raw.mode === 'minor' ? 'minor' : 'major',
      verses: Math.max(1, Math.min(12, parseInt(raw.verses, 10) || 1)),
      measures: []
    };
    song.bpm = Number(raw.bpm) || bpmFromText(song.tempoText) || 96;
    let ts = song.timeSig;
    for (const m of raw.measures || []) {
      if (Array.isArray(m.timeSig)) ts = m.timeSig.map(Number);
      const notes = [];
      for (const n of m.notes || []) {
        const dur = Number(n.dur);
        if (!(dur > 0)) continue;
        notes.push({
          midi: toMidi(n.pitch),
          dur,
          tie: !!n.tie,
          dynamic: n.dynamic && DYN[String(n.dynamic).toLowerCase()] != null ? String(n.dynamic).toLowerCase() : null,
          hairpin: n.hairpin === 'cresc' || n.hairpin === 'dim' ? n.hairpin : null,
          hairpinEnd: !!n.hairpinEnd,
          art: n.articulation || null,
          fermata: !!n.fermata,
          rit: !!n.rit,
          breath: !!n.breath
        });
      }
      song.measures.push({
        timeSig: ts,
        repeatStart: !!m.repeatStart,
        repeatEnd: !!m.repeatEnd,
        ending: parseInt(m.ending, 10) || 0,
        notes
      });
    }
    return song;
  }

  /* ---------- opakování a volty ---------- */
  function expandRepeats(measures) {
    const out = [];
    const done = new Set();
    let i = 0, start = 0, pass = 1, guard = 0;
    while (i < measures.length && guard++ < 2000) {
      const ms = measures[i];
      if (ms.repeatStart && i !== start) { start = i; pass = 1; }
      if (ms.ending === 1 && pass === 2) { i++; continue; }
      if (ms.ending >= 2 && pass === 1 && !ms.repeatEnd) {
        // volta 2 při prvním průchodu nehrajeme (pokud chybí znak repetice u volty 1)
        const hasRepeatBefore = measures.slice(start, i).some(x => x.repeatEnd);
        if (!hasRepeatBefore) { i++; continue; }
      }
      out.push(ms);
      if (ms.repeatEnd && !done.has(i)) { done.add(i); i = start; pass = 2; continue; }
      if (ms.repeatEnd) { pass = 1; start = i + 1; }
      i++;
    }
    return out;
  }

  const mLen = ts => ts[0] * 4 / ts[1]; // délka taktu ve čtvrťových dobách

  /* ---------- hlavní výpočet přednesu ---------- */
  function perform(song, opts = {}) {
    const tempoScale = opts.tempoScale || 1;
    const verses = Math.max(1, opts.verses || 1);
    const accomp = opts.accompaniment !== false;
    const rand = rng(hash(song.title + song.measures.length));

    // 1) lineární sled taktů (repetice × sloky)
    const once = expandRepeats(song.measures);
    const seq = [];
    for (let v = 0; v < verses; v++) once.forEach((m, k) => seq.push({ m, verse: v, first: k === 0, last: k === once.length - 1 }));

    // 2) zploštění not s pozicí v dobách
    const notes = [];
    let beat = 0;
    seq.forEach((s, mi) => {
      const ts = s.m.timeSig, len = mLen(ts);
      const real = s.m.notes.reduce((a, n) => a + n.dur, 0);
      const pickup = s.first && real < len - 0.01;
      let pos = pickup ? len - real : 0; // předtakt: noty patří na konec taktu
      for (const n of s.m.notes) {
        notes.push(Object.assign({}, n, { beat, pos, mi, ts, verse: s.verse }));
        beat += n.dur; pos += n.dur;
      }
      if (s.last && s.verse < verses - 1) {
        // krátký nádech mezi slokami
        notes.push({ midi: null, dur: 1, beat, pos: 0, mi, ts, verse: s.verse, gap: true });
        beat += 1;
      }
    });

    // 3) ligatury – spojit stejné tóny
    for (let i = 0; i < notes.length - 1; i++) {
      const a = notes[i];
      if (!a.tie || a.midi == null) continue;
      let j = i + 1;
      while (j < notes.length && notes[j].midi === a.midi) {
        a.dur += notes[j].dur; a.fermata = a.fermata || notes[j].fermata;
        const t = notes[j].tie; notes[j].absorbed = true; j++;
        if (!t) break;
      }
      a.tie = false;
    }
    const ev = notes.filter(n => !n.absorbed);

    // 4) dynamika + vidlice
    let level = DYN.mf;
    const firstDyn = ev.find(n => n.dynamic);
    if (firstDyn) level = DYN[firstDyn.dynamic];
    ev.forEach(n => { if (n.dynamic) level = DYN[n.dynamic]; n.lvl = level; });
    for (let s = 0; s < ev.length; s++) {
      const hp = ev[s].hairpin; if (!hp) continue;
      let e = -1;
      for (let j = s; j < Math.min(ev.length, s + 24); j++) if (ev[j].hairpinEnd) { e = j; break; }
      if (e < 0) e = Math.min(ev.length - 1, s + 6);
      let target = null;
      for (let j = e + 1; j <= Math.min(ev.length - 1, e + 3); j++) if (ev[j].dynamic) { target = DYN[ev[j].dynamic]; break; }
      const base = ev[s].lvl;
      if (target == null || (hp === 'cresc' && target <= base) || (hp === 'dim' && target >= base)) target = base + (hp === 'cresc' ? .14 : -.14);
      const span = Math.max(1, e - s);
      for (let k = s; k <= e; k++) ev[k].lvl = base + (target - base) * (k - s) / span;
      // po vidlici pokračuje dosažená hladina, dokud nepřijde nové znaménko
      for (let k = e + 1; k < ev.length && !ev[k].dynamic && !ev[k].hairpin; k++) ev[k].lvl = target;
    }

    // 5) fráze
    const phraseEnd = new Array(ev.length).fill(false);
    for (let i = 0; i < ev.length; i++) {
      const n = ev[i], nx = ev[i + 1];
      if (n.midi == null) continue;
      const half = mLen(n.ts) / 2;
      if (!nx || nx.midi == null || n.breath || n.fermata ||
          (n.dur >= Math.max(1, half) && Math.abs((n.pos + n.dur) - mLen(n.ts)) < .01)) phraseEnd[i] = true;
    }
    const sounding = ev.filter(n => n.midi != null);
    const mean = sounding.reduce((a, n) => a + n.midi, 0) / Math.max(1, sounding.length);

    let pStart = 0;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].midi == null) { pStart = i + 1; continue; }
      if (!phraseEnd[i]) continue;
      const len = i - pStart + 1;
      for (let k = pStart; k <= i; k++) {
        const t = len > 1 ? (k - pStart) / (len - 1) : .5;
        ev[k].shape = .055 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - (k === i && len > 1 ? .05 : 0);
        ev[k].agogic = k === i ? 1.07 : k === i - 1 ? 1.03 : 1;
      }
      ev[i].phraseEnd = true;
      pStart = i + 1;
    }

    // 6) hlasitost jednotlivých tónů
    for (const n of ev) {
      if (n.midi == null) continue;
      const bl = n.ts[1] === 8 ? 1.5 : 1; // doba v čtvrťových
      const onBeat = Math.abs(n.pos / bl - Math.round(n.pos / bl)) < .01;
      const beatIdx = Math.round(n.pos / bl);
      let metric = onBeat ? (beatIdx === 0 ? .05 : (n.ts[0] === 4 && beatIdx === 2 ? .025 : 0)) : -.025;
      let v = n.lvl + metric + (n.shape || 0) + .004 * (n.midi - mean);
      if (n.art === 'accent') v += .12;
      if (n.art === 'tenuto') v += .04;
      if (n.art === 'staccato') v += .02;
      v += (rand() - .5) * .05;
      n.vel = Math.max(.08, Math.min(1, v));
    }

    // 7) časování (tempo, rit., fermaty, závěrečné zpomalení)
    const spb = 60 / (song.bpm * tempoScale);
    const total = ev.length ? ev[ev.length - 1].beat + ev[ev.length - 1].dur : 0;
    // rit.: od značky do konce dané fráze/taktu+1 zpomalení až na 1.35×
    const ritF = new Array(ev.length).fill(1);
    for (let s = 0; s < ev.length; s++) {
      if (!ev[s].rit) continue;
      let e = s; while (e < ev.length - 1 && !ev[e].phraseEnd && ev[e].mi <= ev[s].mi + 1) e++;
      for (let k = s; k <= e; k++) ritF[k] = Math.max(ritF[k], 1 + .35 * (k - s + 1) / (e - s + 1));
    }
    // přirozené zpomalení na úplném konci skladby
    const lastBeats = Math.min(3, total);
    ev.forEach((n, k) => { if (n.beat >= total - lastBeats) ritF[k] = Math.max(ritF[k], 1 + .22 * (n.beat - (total - lastBeats) + n.dur) / lastBeats); });

    let t = 0.15;
    const map = []; // [beat, time] pro doprovod
    const out = [];
    ev.forEach((n, k) => {
      let d = n.dur * spb * ritF[k] * (n.agogic || 1);
      if (n.fermata) d *= 1.9;
      map.push([n.beat, t]);
      if (n.midi != null) {
        let len;
        if (n.art === 'staccato') len = d * .42;
        else if (n.phraseEnd || n.breath) len = d * .9;
        else len = d * 1.02 + .03; // legato – mírný přesah
        const jitter = (rand() - .5) * .012;
        out.push({ time: Math.max(0, t + jitter), midi: n.midi, dur: len, vel: n.vel, hand: 'R' });
      }
      t += d;
      if (n.fermata) t += .12;
    });
    map.push([total, t]);
    const end = t;

    const beatToTime = b => {
      for (let i = 1; i < map.length; i++) {
        if (b <= map[i][0] + 1e-6) {
          const [b0, t0] = map[i - 1], [b1, t1] = map[i];
          return b1 > b0 ? t0 + (t1 - t0) * (b - b0) / (b1 - b0) : t0;
        }
      }
      return end;
    };
    const lvlAt = b => { let l = DYN.mf; for (const n of ev) { if (n.beat > b) break; if (n.lvl != null) l = n.lvl; } return l; };

    // 8) doprovod levé ruky
    if (accomp && sounding.length) out.push(...accompany(song, seq, ev, beatToTime, lvlAt, rand));

    out.sort((a, b) => a.time - b.time);
    return { events: out, duration: end + 1.8, measures: seq.length };
  }

  /* ---------- harmonizace a doprovod ---------- */
  function accompany(song, seq, ev, beatToTime, lvlAt, rand) {
    const tonic = (((song.keyFifths * 7) % 12) + 12) % 12 + (song.mode === 'minor' ? 9 : 0);
    const T = tonic % 12;
    const chords = song.mode === 'minor'
      ? [['i', 0, [0, 3, 7], .3], ['iv', 5, [5, 8, 0], .2], ['V', 7, [7, 11, 2], .25], ['III', 3, [3, 7, 10], .08], ['VI', 8, [8, 0, 3], .08]]
      : [['I', 0, [0, 4, 7], .3], ['IV', 5, [5, 9, 0], .2], ['V', 7, [7, 11, 2], .25], ['vi', 9, [9, 0, 4], .06], ['ii', 2, [2, 5, 9], .05]];

    // segmenty (takt, ve 4/4 půltakty)
    const segs = [];
    let beat = 0;
    seq.forEach((s, mi) => {
      const ts = s.m.timeSig, len = mLen(ts);
      const real = s.m.notes.reduce((a, n) => a + n.dur, 0);
      const pickup = s.first && real < len - .01;
      if (!pickup) {
        const parts = (ts[0] === 4 && ts[1] === 4) || (ts[0] === 6 && ts[1] === 8) ? 2 : 1;
        const sl = real / parts;
        for (let p = 0; p < parts; p++) segs.push({ b0: beat + p * sl, b1: beat + (p + 1) * sl, ts, last: s.last, verse: s.verse, mi });
      }
      beat += real;
      if (s.last && s.verse < seq[seq.length - 1].verse) beat += 1;
    });

    const prog = [];
    segs.forEach((g, i) => {
      let best = null, bestS = -1e9;
      for (const c of chords) {
        let sc = c[3];
        for (const n of ev) {
          if (n.midi == null || n.beat + n.dur <= g.b0 || n.beat >= g.b1) continue;
          const ov = Math.min(n.beat + n.dur, g.b1) - Math.max(n.beat, g.b0);
          const strong = Math.abs(n.beat - g.b0) < .01 ? 1.7 : 1;
          const pc = ((n.midi - T) % 12 + 12) % 12;
          sc += c[2].includes(pc) ? ov * strong : -.7 * ov * strong;
        }
        if (prog.length && prog[prog.length - 1][0] === c[0]) sc += .15;
        const isLastSeg = g.last && (i === segs.length - 1 || segs[i + 1].verse !== g.verse);
        const isPenult = !isLastSeg && segs[i + 1] && segs[i + 1].last && (i + 1 === segs.length - 1 || segs[i + 2].verse !== g.verse);
        if (isLastSeg) sc += c[1] === 0 ? 5 : -5;
        if (isPenult && c[1] === 7) sc += .5;
        if (i === 0 && c[1] === 0) sc += .6;
        if (sc > bestS) { bestS = sc; best = c; }
      }
      prog.push(best);
    });

    const out = [];
    let prevVoicing = [55, 59, 62];
    const slow = song.bpm < 80;
    segs.forEach((g, i) => {
      const c = prog[i];
      const rootPc = (T + c[1]) % 12;
      let bass = 36 + rootPc; while (bass < 40) bass += 12; while (bass > 51) bass -= 12;
      const pcs = c[2].map(x => (T + x) % 12);
      // nejbližší obrat (vedení hlasů)
      let bestV = null, bestD = 1e9;
      for (let inv = 0; inv < 3; inv++) {
        const order = pcs.slice(inv).concat(pcs.slice(0, inv));
        for (let base = 50; base <= 60; base++) {
          if (base % 12 !== order[0]) continue;
          const v = [base]; for (let k = 1; k < 3; k++) { let x = order[k]; while (x <= v[k - 1]) x += 12; v.push(x); }
          if (v[2] > 69) continue;
          const d = v.reduce((a, x, k) => a + Math.abs(x - prevVoicing[k]), 0);
          if (d < bestD) { bestD = d; bestV = v; }
        }
      }
      prevVoicing = bestV;
      const L = lvlAt(g.b0);
      const bl = g.ts[1] === 8 ? 1.5 : 1;
      const beats = Math.max(1, Math.round((g.b1 - g.b0) / bl));
      const add = (b, midi, lenBeats, vel) => {
        const t0 = beatToTime(b), t1 = beatToTime(Math.min(g.b1, b + lenBeats));
        out.push({ time: t0 + (rand() - .5) * .01, midi, dur: Math.max(.08, t1 - t0) * 1.05 + .05, vel: Math.max(.06, Math.min(.9, vel)), hand: 'L' });
      };
      const segEnd = (g.b1 - g.b0);
      const isFinal = i === segs.length - 1;
      if (isFinal) {
        add(g.b0, bass, segEnd + 2, L * .62);
        bestV.forEach(x => add(g.b0 + .02, x, segEnd + 2, L * .42));
      } else if (slow) {
        // rozložené akordy v osminách, basa držená pedálem
        const pat = [bass, bass + 7, bestV[1], bestV[2]];
        add(g.b0, bass, segEnd, L * .6);
        let k = 1;
        for (let b = g.b0 + .5; b < g.b1 - .01; b += .5, k++) add(b, pat[k % pat.length], g.b1 - b, L * .36);
      } else {
        add(g.b0, bass, Math.min(segEnd, bl * 1.6), L * .62);
        for (let k = 1; k < beats; k++) bestV.forEach(x => add(g.b0 + k * bl, x, bl * .8, L * (k === 2 && beats === 4 ? .44 : .38)));
        if (beats === 1) bestV.forEach(x => add(g.b0 + bl * .5, x, bl * .45, L * .36));
      }
    });
    return out;
  }

  function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  const KEYS_MAJ = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B', 'F', 'C', 'G', 'D', 'A', 'E', 'H', 'F♯', 'C♯'];
  const KEYS_MIN = ['a♭', 'e♭', 'b', 'f', 'c', 'g', 'd', 'a', 'e', 'h', 'f♯', 'c♯', 'g♯', 'd♯', 'a♯'];
  function keyName(song) {
    const i = Math.max(0, Math.min(14, song.keyFifths + 7));
    return song.mode === 'minor' ? KEYS_MIN[i] + ' moll' : KEYS_MAJ[i] + ' dur';
  }

  root.NotyEngine = { normalize, expandRepeats, perform, keyName, toMidi, bpmFromText };
  if (typeof module !== 'undefined') module.exports = root.NotyEngine;
})(typeof window !== 'undefined' ? window : globalThis);
