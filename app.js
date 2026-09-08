'use strict';

const TICK_MS = 200;
const MAX_SECONDS = 99 * 3600 + 59 * 60 + 59; // 入力欄が表せる上限 99:59:59
const THEME_KEY = 'timer-theme';
const IDLE_MS = 2500;      // 操作が途切れてから UI を隠すまで
const FIT_WIDTH = 0.92;    // 数字が使ってよい画面幅の割合
const FIT_HEIGHT = 0.72;   // 同 高さ

const el = {
  setupScreen: document.getElementById('setupScreen'),
  runScreen: document.getElementById('runScreen'),
  setup: document.getElementById('setup'),
  display: document.getElementById('display'),
  runStatus: document.getElementById('runStatus'),
  progress: document.getElementById('progress'),
  hours: document.getElementById('hours'),
  minutes: document.getElementById('minutes'),
  seconds: document.getElementById('seconds'),
  presets: document.getElementById('presets'),
  startBtn: document.getElementById('startBtn'),
  clearBtn: document.getElementById('clearBtn'),
  primaryBtn: document.getElementById('primaryBtn'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  runHintAction: document.getElementById('runHintAction'),
  backBtn: document.getElementById('backBtn'),
  setupHint: document.getElementById('setupHint'),
  notifyToggle: document.getElementById('notifyToggle'),
  themeSwitch: document.getElementById('themeSwitch'),
};

const state = {
  durationMs: 0,   // 開始時に確定した合計時間
  remainingMs: 0,  // 停止中の残り時間
  endAt: 0,        // 実行中の終了時刻 (epoch ms)
  running: false,
  finished: false,
};

let tickId = null;
let idleTimer = null;
let audioCtx = null;
let lastTextLength = -1;

// ---- 時間の整形 ----

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function currentRemaining() {
  return state.running ? Math.max(0, state.endAt - Date.now()) : state.remainingMs;
}

// ---- 描画 ----

// 数字を画面いっぱいに拡大する。基準 font-size に対する倍率を transform で与える
function fitDisplay() {
  if (el.runScreen.hidden) return;
  el.display.style.transform = 'scale(1)';
  const rect = el.display.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(
    (window.innerWidth * FIT_WIDTH) / rect.width,
    (window.innerHeight * FIT_HEIGHT) / rect.height
  );
  el.display.style.transform = `scale(${scale})`;
}

function render() {
  const remaining = currentRemaining();
  const text = formatTime(remaining);

  el.display.textContent = text;
  if (text.length !== lastTextLength) {
    lastTextLength = text.length;
    fitDisplay(); // 桁数が変わったときだけ測り直す
  }

  const ratio = state.durationMs > 0 ? remaining / state.durationMs : 0;
  el.progress.style.transform = `scaleX(${ratio})`;

  if (state.running) document.title = `${text} - タイマー`;
  else if (state.finished) document.title = '終了 - タイマー';
  else document.title = 'タイマー';
}

function setRunStatus(text) {
  el.runStatus.textContent = text;
}

// 主ボタンのラベルと Space キーの説明を揃える
function setPrimaryLabel(label) {
  el.primaryBtn.textContent = label;
  el.runHintAction.textContent = label;
}

// ---- 画面の切り替え ----

function showScreen(name) {
  const run = name === 'run';
  el.setupScreen.hidden = run;
  el.runScreen.hidden = !run;
  if (run) {
    lastTextLength = -1; // 表示直後は必ずフィットし直す
    render();
    revealControls();
  }
}

function revealControls() {
  el.runScreen.classList.remove('is-idle');
  clearTimeout(idleTimer);
  // 走っている間だけ隠す。一時停止中と終了後は出したままにする
  if (state.running) {
    idleTimer = setTimeout(() => el.runScreen.classList.add('is-idle'), IDLE_MS);
  }
}

// ---- 入力 ----

function clamp(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function inputMs() {
  return (
    clamp(el.hours.value, 0, 99) * 3600000 +
    clamp(el.minutes.value, 0, 59) * 60000 +
    clamp(el.seconds.value, 0, 59) * 1000
  );
}

// 大きな数字を構成する 3 つの入力欄。左から桁上位の順に並べる
const SEGMENTS = [
  { input: el.hours, max: 99 },
  { input: el.minutes, max: 59 },
  { input: el.seconds, max: 59 },
];

function setSegment(input, n) {
  input.value = String(n).padStart(2, '0');
}

function normalizeSegment({ input, max }) {
  setSegment(input, clamp(input.value, 0, max));
}

function addSeconds(delta) {
  fillInputs(Math.min(inputMs() / 1000 + delta, MAX_SECONDS));
}

function fillInputs(totalSeconds) {
  setSegment(el.hours, Math.floor(totalSeconds / 3600));
  setSegment(el.minutes, Math.floor((totalSeconds % 3600) / 60));
  setSegment(el.seconds, totalSeconds % 60);
}

// ---- テーマ ----

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null; // プライベートモードなどで localStorage が使えないことがある
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const btn of el.themeSwitch.querySelectorAll('[data-theme-value]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === theme));
  }
}

function selectTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 保存できなくても、このセッションの見た目は切り替わる
  }
}

// ---- 音と通知 ----

function ensureAudio() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioCtx) audioCtx = new AudioCtor();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playAlarm() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const at = start + i * 0.6;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.5);
  }
}

function notifyFinished() {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('タイマー終了', {
    body: `${formatTime(state.durationMs)} が経過しました。`,
    tag: 'timer',
  });
}

// ---- タイマー制御 ----

function startCounting() {
  state.endAt = Date.now() + state.remainingMs;
  state.running = true;
  state.finished = false;

  el.runScreen.classList.remove('is-paused', 'is-finished');
  setPrimaryLabel('一時停止');
  setRunStatus(''); // 通常進行中はラベルを出さず、数字だけを見せる

  clearInterval(tickId);
  tickId = setInterval(tick, TICK_MS);
  revealControls();
  render();
}

function resetSetupHint() {
  el.setupHint.innerHTML = '<kbd>Enter</kbd> で開始';
}

function clearInputs() {
  fillInputs(0);
  resetSetupHint();
}

function startFromSetup() {
  const ms = inputMs();
  if (ms <= 0) {
    el.setupHint.textContent = '1 秒以上を設定してください';
    return;
  }
  resetSetupHint();

  ensureAudio(); // ユーザー操作のタイミングで音声を解錠しておく
  state.durationMs = ms;
  state.remainingMs = ms;
  showScreen('run');
  startCounting();
}

function pause() {
  if (!state.running) return;
  state.remainingMs = currentRemaining();
  state.running = false;
  clearInterval(tickId);
  tickId = null;

  el.runScreen.classList.add('is-paused');
  setPrimaryLabel('再開');
  setRunStatus(''); // 一時停止はぼかしと再生アイコンで示す
  revealControls();
  render();
}

function restart() {
  state.remainingMs = state.durationMs;
  startCounting();
}

function finish() {
  state.running = false;
  state.finished = true;
  state.remainingMs = 0;
  clearInterval(tickId);
  tickId = null;

  el.runScreen.classList.remove('is-paused');
  el.runScreen.classList.add('is-finished');
  setPrimaryLabel('もう一度');
  setRunStatus('終了');
  revealControls();
  render();

  playAlarm();
  notifyFinished();
}

function backToSetup() {
  state.running = false;
  state.finished = false;
  state.remainingMs = state.durationMs;
  clearInterval(tickId);
  tickId = null;
  clearTimeout(idleTimer);

  el.runScreen.classList.remove('is-paused', 'is-finished', 'is-idle');
  showScreen('setup');
  render();
}

function tick() {
  if (!state.running) return;
  if (Date.now() >= state.endAt) {
    finish();
    return;
  }
  render();
}

function primaryAction() {
  if (state.running) pause();
  else if (state.finished) restart();
  else startCounting();
}

// ---- イベント ----

el.startBtn.addEventListener('click', startFromSetup);
el.clearBtn.addEventListener('click', clearInputs);
el.setup.addEventListener('submit', (event) => {
  event.preventDefault(); // 開始は keydown 側で拾う。ここではリロードを止めるだけ
});

el.primaryBtn.addEventListener('click', primaryAction);
el.pauseOverlay.addEventListener('click', primaryAction);

// 画面のどこを押しても一時停止 / 再開できる。
// ボタンは自前のハンドラを持っているので二重発火させない。終了後は誤操作を避けて無効にする。
el.runScreen.addEventListener('click', (event) => {
  if (state.finished) return;
  if (event.target.closest('button')) return;
  primaryAction();
});
el.backBtn.addEventListener('click', backToSetup);

el.presets.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  addSeconds(Number(chip.dataset.add));
});

SEGMENTS.forEach((seg, index) => {
  const { input, max } = seg;
  const next = SEGMENTS[index + 1];

  // クリックしただけで桁ごと選択され、そのまま上書き入力できる
  input.addEventListener('focus', () => input.select());
  input.addEventListener('pointerup', (event) => event.preventDefault());

  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 2);
    input.value = digits;
    if (digits.length < 2) return;
    if (Number(digits) > max) setSegment(input, max);
    if (next) next.input.focus(); // 2 桁埋まったら次の桁へ送る
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? 1 : -1;
    const wrap = max + 1;
    setSegment(input, (clamp(input.value, 0, max) + step + wrap) % wrap);
    input.select();
  });

  input.addEventListener('blur', () => {
    normalizeSegment(seg);
    input.setSelectionRange(0, 0); // 選択範囲が残るとフォーカスが 2 箇所あるように見える
  });
});

el.themeSwitch.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-theme-value]');
  if (btn) selectTheme(btn.dataset.themeValue);
});

// 自分で選ぶまでは OS 側の設定に追従する
darkQuery.addEventListener('change', () => {
  if (!storedTheme()) applyTheme(darkQuery.matches ? 'dark' : 'light');
});

el.notifyToggle.addEventListener('change', async () => {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window)) {
    el.notifyToggle.checked = false;
    el.setupHint.textContent = 'このブラウザは通知に対応していません';
    return;
  }
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') {
    el.notifyToggle.checked = false;
    el.setupHint.textContent = '通知が許可されませんでした';
  }
});

for (const type of ['mousemove', 'pointerdown']) {
  el.runScreen.addEventListener(type, revealControls);
}

window.addEventListener('resize', fitDisplay);

// バックグラウンドで setInterval が間引かれても、復帰時に正しい状態へ揃える
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (el.runScreen.hidden) {
    if (event.key === 'Enter') {
      event.preventDefault();
      startFromSetup();
    }
    return;
  }

  revealControls();

  if (event.code === 'Space') {
    // ボタンにフォーカスがある間はネイティブのクリックに任せる (二重発火の防止)
    if (target instanceof Element && target.matches('button')) return;
    event.preventDefault();
    primaryAction();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    backToSetup();
  }
});

applyTheme(storedTheme() || (darkQuery.matches ? 'dark' : 'light'));
SEGMENTS.forEach(normalizeSegment);
render();
