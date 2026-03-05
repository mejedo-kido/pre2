/* game.js — 完全置換版（BattleEngine 統合 / 転生修正 / possession 修正 / fortress を閾値×2 に変更）
   - BattleEngine を内部実装して、既存の UI ヘルパーと互換性を保ちながら統合
   - 新スキル: overheat, pumpUp, possession, split を実装
   - 転生 (reincarnation) は「破壊 → attemptedValue % maxFinger で復活（0 なら破壊のまま）」に確実に変更
   - 超耐久 (fortress): 閾値 ×2
   - possession は装備確定（commitEquips）時に確実に発動
*/

/* ---------- constants & util ---------- */
const STORAGE_KEY = 'fd_unlocked_skills_v2';
const BEST_KEY = 'fd_best_stage_v1';
const EQUIP_SLOTS = 3;
const MAX_SKILL_LEVEL = 3;
const SKILL_LEVEL_CAP = { power: 2, possession: 1, split: 1 };
const HARD_CAP = 99;

/* tiny utils */
const rand = (min,max) => Math.floor(Math.random()*(max-min+1))+min;
function toNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function safeDecrease(cur, amount){
  cur = toNum(cur);
  if(cur === 0) return 0;
  let newVal = cur - amount;
  if(newVal < 1) newVal = 1;
  return newVal;
}

/* ---------- SKILL POOL ---------- */
const SKILL_POOL = [
  { id:'power',     type:'passive', baseDesc:'攻撃 +1 / level',                  name:'💥 パワーアップ', rarity:'rare'  },
  { id:'guard',     type:'passive', baseDesc:'敵攻撃 -1 / level',                 name:'🛡 ガード',       rarity:'common'},
  { id:'berserk',   type:'passive', baseDesc:'自分の手が4のとき攻撃 +level (×2)', name:'⚡ バーサーク',   rarity:'common'},
  { id:'regen',     type:'turn',    baseDesc:'敵ターン後に自分のランダムな手 -1 ×level', name:'💚 リジェネ', rarity:'common'},
  { id:'double',    type:'active',  baseDesc:'次の攻撃が (1 + level) 倍',          name:'⛏ ダブルストライク', rarity:'epic'},
  { id:'heal',      type:'active',  baseDesc:'自分の手を - (1 + level)',          name:'✨ ヒール（自傷）', rarity:'rare'  },
  { id:'pierce',    type:'passive', baseDesc:'破壊閾値を -level（最小2）',        name:'🔩 ピアス',       rarity:'epic'  },
  { id:'chain',     type:'combo',   baseDesc:'敵手を破壊した次の攻撃 +level',    name:'🔗 チェイン',     rarity:'common'},
  { id:'fortify',   type:'turn',    baseDesc:'自分の防御+1 for 2 turns ×level',  name:'🏰 フォーティファイ', rarity:'rare'},
  { id:'revenge',   type:'event',   baseDesc:'自分の手が0になったら即ヒール +level', name:'🔥 リベンジ', rarity:'rare'},
  { id:'disrupt',   type:'active',  baseDesc:'敵の手を -(1+level)（直接減少、最小1）', name:'🪓 ディスラプト', rarity:'common'},
  { id:'teamPower', type:'turn',    baseDesc:'味方全体の攻撃 +level（2*levelターン）', name:'🌟 チームパワー', rarity:'rare'},
  { id:'counter',   type:'event',   baseDesc:'攻撃を受けた時、相手の手を +level して反撃', name:'↺ カウンター', rarity:'common'},

  // 新規スキル
  { id:'overheat',  type:'active',  baseDesc:'自身の手 +3、さらにシールド +level', name:'🔥 オーバーヒート', rarity:'rare'},
  { id:'pumpUp',    type:'active',  baseDesc:'自身の手 +level',                  name:'💪 パンプアップ', rarity:'common'},
  { id:'possession',type:'passive', baseDesc:'バトル開始時: 左手0。閾値/基礎攻防を×2（バトル中）', name:'🕯 ポゼッション', rarity:'epic'},
  { id:'split',     type:'active',  baseDesc:'片手のみ生存かつ値≥2の時、その手を半分に分割して両手にする', name:'✂ 分割', rarity:'common'}
];

/* ---------- DOM references (existing HTML) ---------- */
const titleScreen = document.getElementById('titleScreen');
const ruleScreen = document.getElementById('ruleScreen');
const startButton = document.getElementById('startButton');
const resetButton = document.getElementById('resetButton');
const ruleNextButton = document.getElementById('ruleNextButton');
const ruleBackButton = document.getElementById('ruleBackButton');
const bestStageValue = document.getElementById('bestStageValue');

const stageInfo = document.getElementById('stageInfo');
const skillInfo = document.getElementById('skillInfo') || (() => { const el=document.createElement('div'); el.id='skillInfo'; document.querySelector('.container').prepend(el); return el; })();
const thresholdInfo = document.getElementById('thresholdInfo');
const messageArea = document.getElementById('message');
const skillSelectArea = document.getElementById('skillSelectArea');
const equippedList = document.getElementById('equippedList');
const unlockedList = document.getElementById('unlockedList');
const flashLayer = document.getElementById('flashLayer');

const enemySkillArea = document.getElementById('enemySkillArea');
const bossAbilityArea = document.getElementById('bossAbilityArea');

const hands = {
  playerLeft: document.getElementById('player-left'),
  playerRight: document.getElementById('player-right'),
  enemyLeft: document.getElementById('enemy-left'),
  enemyRight: document.getElementById('enemy-right'),
  enemyThird: document.getElementById('enemy-third')
};

const bars = {
  playerLeft: document.getElementById('player-left-bar'),
  playerRight: document.getElementById('player-right-bar'),
  enemyLeft: document.getElementById('enemy-left-bar'),
  enemyRight: document.getElementById('enemy-right-bar'),
  enemyThird: document.getElementById('enemy-third-bar')
};

/* ---------- SE (if available) ---------- */
const SE = {
  click: typeof Audio !== 'undefined' ? new Audio('assets/sounds/click.mp3') : null,
  attack: typeof Audio !== 'undefined' ? new Audio('assets/sounds/attack.mp3') : null,
  destroy: typeof Audio !== 'undefined' ? new Audio('assets/sounds/destroy.mp3') : null,
  skill: typeof Audio !== 'undefined' ? new Audio('assets/sounds/skill.mp3') : null,
  victory: typeof Audio !== 'undefined' ? new Audio('assets/sounds/victory.mp3') : null,
  lose: typeof Audio !== 'undefined' ? new Audio('assets/sounds/lose.mp3') : null
};
function playSE(name, volume = 0.6){
  const s = SE[name];
  if(!s) return;
  try {
    const snd = s.cloneNode();
    snd.volume = volume;
    const p = snd.play();
    if(p && typeof p.catch === 'function') p.catch(()=>{});
  } catch(e){}
}

/* ---------- showPopupText / FX (compatible with existing HTML) ---------- */
function flashScreen(duration = 0.18){
  if(!flashLayer) return;
  flashLayer.classList.add('flash');
  setTimeout(()=> flashLayer.classList.remove('flash'), Math.max(80, duration*1000));
}
function showDamage(targetEl, val, color='#ff6b6b'){
  if(!targetEl) return;
  const d = document.createElement('div');
  d.className = 'damage';
  d.textContent = (val >= 0 ? `+${val}` : `${val}`);
  d.style.color = color;
  targetEl.appendChild(d);
  setTimeout(()=> d.remove(), 820);
}
function showPopupText(targetEl, text, color='#fff'){
  if(!targetEl) return;
  const d = document.createElement('div');
  d.className = 'damage';
  d.textContent = text;
  d.style.color = color;
  targetEl.appendChild(d);
  setTimeout(()=> d.remove(), 820);
}
function animateAttack(attackerEl, targetEl){
  if(attackerEl) attackerEl.classList.add('attack');
  if(targetEl) targetEl.classList.add('hit');
  setTimeout(()=>{ if(attackerEl) attackerEl.classList.remove('attack'); if(targetEl) targetEl.classList.remove('hit'); }, 320);
}
function animateDestroy(targetEl){
  if(!targetEl) return;
  targetEl.classList.add('destroy');
  setTimeout(()=> targetEl.classList.remove('destroy'), 500);
}

/* ---------- Persistence ---------- */
function saveUnlocked(){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState.unlockedSkills)); } catch(e){} }
function loadUnlocked(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)){
      if(parsed.length === 0) return [];
      if(typeof parsed[0] === 'string') return parsed.map(id=>({ id, level:1 }));
      if(typeof parsed[0] === 'object' && parsed[0].id) return parsed.map(o=>({ id:o.id, level:o.level||1 })); 
    }
  } catch(e){}
  return null;
}
function loadBest(){ try { const b = Number(localStorage.getItem(BEST_KEY)); return Number.isFinite(b) && b > 0 ? b : 1; } catch(e){ return 1; } }
function saveBest(){ try { localStorage.setItem(BEST_KEY, String(gameState.bestStage)); } catch(e){} }

/* ---------- game state ---------- */
const gameState = {
  stage: 1,
  isBoss: false,
  floor: 1,
  player: { left: 1, right: 1 },
  enemy: { left: 1, right: 1 },
  playerTurn: true,
  unlockedSkills: [],
  equippedSkills: [],
  pendingActiveUse: null,
  doubleMultiplier: 1,
  turnBuffs: [],
  enemySkills: [],
  enemyDoubleMultiplier: 1,
  enemyTurnBuffs: [],
  bestStage: 1,
  inTitle: true,
  combo: 0,
  baseStats: {
    playerThreshold: 5,
    enemyThreshold: 5,
    baseAttack: 0,
    baseDefense: 0,
    maxFinger: 5
  },
  inBossReward: false,
  bossAbility: null,
  bossTurnCount: 0,
  enemyHasThirdHand: false,
  // boss 用閾値倍率（初期1）
  bossEnemyThresholdMultiplier: 1,

  // プレイヤー戦闘修飾（possession 等）
  playerBattleModifiers: {
    thresholdMultiplier: 1,
    attackMultiplier: 1,
    defenseMultiplier: 1
  },

  // プレイヤーシールド（overheat）
  playerShield: 0,

  awaitingEquip: false
};

/* ---------- BattleEngine (integrated) ---------- */
class BattleEngine {
  constructor(state, opts = {}) {
    this.state = state;
    this.opts = opts;
    this.uiUpdate = opts.updateUI || (typeof updateUI === 'function' ? updateUI : ()=>{});
    this.popup = opts.showPopupText || (typeof showPopupText === 'function' ? showPopupText : ()=>{});
    this.playSE = opts.playSE || (typeof playSE === 'function' ? playSE : ()=>{});
    this.flash = opts.flashScreen || (typeof flashScreen === 'function' ? flashScreen : ()=>{});
    this._events = {};
    this._reentrancyGuard = false;
    this._eventLoopCount = 0;
    this._maxEventLoop = 2000;
    this.bossRegistry = {};
    this.appliedBossAbilities = [];
    this._installDefaultBossAbilities();
  }
  on(name, fn){ if(!this._events[name]) this._events[name]=[]; this._events[name].push(fn); }
  off(name, fn){ if(!this._events[name]) return; this._events[name]=this._events[name].filter(f=>f!==fn); }
  emit(name, ...args){
    this._eventLoopCount++;
    if(this._eventLoopCount > this._maxEventLoop){
      console.warn('BattleEngine: event loop exceeded max, aborting further emits');
      return;
    }
    const handlers = (this._events[name] || []).slice();
    for(const h of handlers){
      try { h(...args); } catch(e){ console.error('event handler error', e); }
    }
  }
  _resetEventLoopCount(){ this._eventLoopCount = 0; }

  _enterCritical(){
    if(this._reentrancyGuard) throw new Error('BattleEngine reentrancy detected');
    this._reentrancyGuard = true;
  }
  _exitCritical(){
    this._reentrancyGuard = false;
  }
  clampHandVal(v){
    const mx = (this.state.baseStats && Number.isFinite(Number(this.state.baseStats.maxFinger))) ? Number(this.state.baseStats.maxFinger) : 5;
    if(!Number.isFinite(Number(v))) return 0;
    return Math.max(0, Math.min(v, Math.max(mx, v)));
  }
  getMaxFinger(){ return (this.state.baseStats && Number.isFinite(Number(this.state.baseStats.maxFinger))) ? Number(this.state.baseStats.maxFinger) : 5; }

  registerBossAbility(id, handlerObj){
    this.bossRegistry[id] = handlerObj;
  }
  assignBossAbility(id){
    const h = this.bossRegistry[id];
    if(!h) return;
    try {
      if(typeof h.apply === 'function') h.apply(this, this.state);
      this.appliedBossAbilities.push(id);
      this.emit('bossAbilityAssigned', id);
    } catch(e){ console.error('assignBossAbility error', e); }
  }
  clearBossAbilities(){
    this.appliedBossAbilities = [];
    this.state.bossEnemyThresholdMultiplier = 1;
    this.state.enemyHasThirdHand = false;
    this.state.bossTurnCount = 0;
    this.emit('bossAbilitiesCleared');
  }
  _callBossHook(hook, ...args){
    for(const id of this.appliedBossAbilities.slice()){
      const h = this.bossRegistry[id];
      if(h && typeof h[hook] === 'function'){
        try { h[hook](this, ...args); } catch(e){ console.error('boss hook error', e); }
      }
    }
  }

  _installDefaultBossAbilities(){
    // reincarnation: onHandDestroyed -> revive to attemptedValue % maxFinger
    this.registerBossAbility('reincarnation', {
      name:'reincarnation',
      desc:'破壊後に (attempted % maxFinger) で復活（0なら破壊）',
      onHandDestroyed: (engine, side, attemptedValue) => {
        try {
          const maxFinger = engine.getMaxFinger();
          const mod = attemptedValue % maxFinger;
          if(mod !== 0){
            engine.state.enemy[side] = mod;
            const el = (side === 'left' ? hands.enemyLeft : (side === 'right' ? hands.enemyRight : hands.enemyThird));
            try { showPopupText(el, `復活 ${mod}`, '#ffd166'); } catch(e){}
            try { engine.playSE && engine.playSE('skill'); } catch(e){}
            engine.emit('reincarnation', side, mod);
          }
        } catch(e){ console.error('reincarnation handler error', e); }
      }
    });

    // thirdHand
    this.registerBossAbility('thirdHand', {
      name:'thirdHand',
      desc:'戦闘開始時に第三の手を出現',
      apply: (engine) => {
        engine.state.enemyHasThirdHand = true;
        if(typeof engine.state.enemy.third === 'undefined') engine.state.enemy.third = 1;
      }
    });

    // fortress: multiply enemy threshold
    this.registerBossAbility('fortress', {
      name:'fortress',
      desc:'敵の閾値を×2（戦闘中のみ）',
      apply: (engine) => {
        engine.state.bossEnemyThresholdMultiplier = (engine.state.bossEnemyThresholdMultiplier || 1) * 2;
      }
    });

    // split (boss)
    this.registerBossAbility('split', {
      name:'split',
      desc:'片手のみ生存の時敵が分裂',
      onEnemyTurnStart: (engine) => {
        const keys = engine.state.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
        const alive = keys.filter(k => engine.clampHandVal(engine.state.enemy[k]) > 0);
        if(alive.length === 1){
          const side = alive[0];
          const val = engine.clampHandVal(engine.state.enemy[side]);
          if(val >= 2){
            const half1 = Math.floor(val/2);
            const half2 = Math.ceil(val/2);
            engine.state.enemy.left = half1;
            engine.state.enemy.right = half2;
            if(engine.state.enemyHasThirdHand) engine.state.enemy.third = 0;
            engine.flash && engine.flash(.12);
            engine.emit('enemySplit', side, val, half1, half2);
          }
        }
      }
    });
  }

  getDestroyThreshold(attackerIsPlayer = true){
    let thresholdRaw = attackerIsPlayer
      ? (Number.isFinite(Number(this.state.baseStats.enemyThreshold)) ? Number(this.state.baseStats.enemyThreshold) : 5)
      : (Number.isFinite(Number(this.state.baseStats.playerThreshold)) ? Number(this.state.baseStats.playerThreshold) : 5);

    if(attackerIsPlayer){
      thresholdRaw = thresholdRaw * (this.state.bossEnemyThresholdMultiplier || 1);
    } else {
      thresholdRaw = thresholdRaw * (this.state.playerBattleModifiers && this.state.playerBattleModifiers.thresholdMultiplier ? this.state.playerBattleModifiers.thresholdMultiplier : 1);
    }

    if(attackerIsPlayer){
      (this.state.equippedSkills || []).forEach(s => { if(s.id === 'pierce') thresholdRaw = Math.max(2, thresholdRaw - (s.level||1)); });
    } else {
      (this.state.enemySkills || []).forEach(s => { if(s.id === 'pierce') thresholdRaw = Math.max(2, thresholdRaw - (s.level||1)); });
    }

    const res = Math.max(2, Number.isFinite(Number(thresholdRaw)) ? Math.round(thresholdRaw) : 5);
    return res;
  }

  startBattle({ stage = 1, isBoss = false } = {}){
    this._enterCritical();
    try {
      this._resetEventLoopCount();
      this.state.bossEnemyThresholdMultiplier = 1;
      this.state.bossAbility = null;
      this.state.bossTurnCount = 0;
      this.state.enemyHasThirdHand = false;
      this.state.playerBattleModifiers = this.state.playerBattleModifiers || { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
      this.state.playerShield = this.state.playerShield || 0;
      this.appliedBossAbilities = [];

      this.state.player.left = this.clampHandVal(this.state.player.left || 1);
      this.state.player.right = this.clampHandVal(this.state.player.right || 1);
      this.state.enemy.left = this.clampHandVal(this.state.enemy.left || 1);
      this.state.enemy.right = this.clampHandVal(this.state.enemy.right || 1);

      if(isBoss && this.state.bossAbility && typeof this.state.bossAbility === 'string'){
        this.assignBossAbility(this.state.bossAbility);
      }

      this.emit('battleStart', { stage, isBoss });
      this._resetEventLoopCount();
      this.uiUpdate();
    } finally {
      this._exitCritical();
    }
  }

  playerAttack(attackerSide, targetSide){
    return this._attack(true, attackerSide, targetSide);
  }
  enemyAttack(attackerSide, targetSide){
    return this._attack(false, attackerSide, targetSide);
  }

  _attack(attackerIsPlayer, attackerSide, targetSide){
    if(this._reentrancyGuard) { console.warn('attack attempted during critical section'); return; }
    this._enterCritical();
    try {
      const actor = attackerIsPlayer ? this.state.player : this.state.enemy;
      const target = attackerIsPlayer ? this.state.enemy : this.state.player;

      const attackerVal = this.clampHandVal(actor[attackerSide] || 0);
      if(attackerVal <= 0){
        this._exitCritical();
        return;
      }

      let baseAtk = attackerVal;
      if(attackerIsPlayer){
        baseAtk += this._computePlayerAttackBonus(attackerSide);
      } else {
        baseAtk += this._computeEnemyAttackBonus(attackerSide);
      }

      let multiplier = attackerIsPlayer ? (this.state.doubleMultiplier || 1) : (this.state.enemyDoubleMultiplier || 1);
      if(attackerIsPlayer) this.state.doubleMultiplier = 1;
      else this.state.enemyDoubleMultiplier = 1;

      let rawAdded = baseAtk * multiplier;

      const defense = this._computeDefenseForTarget(attackerIsPlayer ? true : false);
      const added = Math.max(0, rawAdded - defense);

      try { this.playSE && this.playSE('attack'); } catch(e){}
      this.emit('beforeAttack', {attackerIsPlayer, attackerSide, targetSide, attackerVal, baseAtk, multiplier, defense, added});

      const curTarget = this.clampHandVal(target[targetSide] || 0);
      const attemptedValue = curTarget + added;

      const destroyThreshold = this.getDestroyThreshold(attackerIsPlayer);
      let destroyed = false;
      if(Number(attemptedValue) >= Number(destroyThreshold)){
        target[targetSide] = 0;
        destroyed = true;
        // call boss hooks & emit destroyed
        this._callBossHook('onHandDestroyed', targetSide, attemptedValue);
        this.emit('fingerDestroyed', { side: targetSide, attemptedValue, ownerIsEnemy: !attackerIsPlayer });
      } else {
        target[targetSide] = Math.min(attemptedValue, HARD_CAP);
      }

      this._handleCounter(attackerIsPlayer, attackerSide, !attackerIsPlayer, targetSide);

      if(destroyed && attackerIsPlayer && this._hasEquipped('chain')){
        const lvl = this._getEquippedLevel('chain');
        this._applyTurnBuff('chainBoost', lvl, 1);
        this.emit('chainApplied', lvl);
      }

      this.emit('afterAttack', { attackerIsPlayer, attackerSide, targetSide, destroyed, attemptedValue });
      this.uiUpdate();
      return { destroyed, attemptedValue, newValue: target[targetSide] };
    } finally {
      this._exitCritical();
      this._resetEventLoopCount();
    }
  }

  enemyTurn(){
    if(this._reentrancyGuard) { console.warn('enemyTurn attempted during critical section'); return; }
    this._enterCritical();
    try {
      this._callBossHook('onEnemyTurnStart');

      (this.state.enemySkills || []).forEach(skill => {
        try{
          if(skill.remainingCooldown && skill.remainingCooldown > 0) return;
          if(skill.id === 'heal'){
            const candidates = (this.state.enemyHasThirdHand ? ['left','right','third'] : ['left','right']).filter(k => this.clampHandVal(this.state.enemy[k]) > 0);
            if(candidates.length > 0 && Math.random() < 0.6){
              const r = candidates[rand(0, candidates.length-1)];
              const amount = 1 + skill.level;
              this.state.enemy[r] = this.clampHandVal(safeDecrease(this.state.enemy[r], amount));
              skill.remainingCooldown = 2;
              this.emit('enemyUsedSkill', skill.id, r);
            }
          }
          if(skill.id === 'double'){
            if(Math.random() < 0.35){
              this.state.enemyDoubleMultiplier = 1 + skill.level;
              skill.remainingCooldown = 2;
            }
          }
          if(skill.id === 'regen'){
            this._applyRegenToUnit(true, skill.level);
          }
          if(skill.id === 'fortify' && Math.random() < 0.25){
            this._applyEnemyTurnBuff('fortify', skill.level, 2*skill.level);
            skill.remainingCooldown = 3;
          }
          if(skill.id === 'chain' && Math.random() < 0.25){
            this._applyEnemyTurnBuff('chain', skill.level, 1);
            skill.remainingCooldown = 2;
          }
          if(skill.id === 'disrupt' && Math.random() < 0.35){
            const candidates = ['left','right'].filter(k => this.clampHandVal(this.state.player[k]) > 0);
            if(candidates.length > 0){
              const target = candidates[rand(0, candidates.length-1)];
              const amount = 1 + skill.level;
              this.state.player[target] = this.clampHandVal(safeDecrease(this.state.player[target], amount));
              skill.remainingCooldown = 2;
            }
          }
          if(skill.id === 'teamPower' && Math.random() < 0.2){
            this._applyEnemyTurnBuff('teamPower', skill.level, 2*skill.level);
            skill.remainingCooldown = 3;
          }
        }catch(e){ console.error('enemy skill error', e); }
      });

      const enemyKeys = this.state.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
      const aliveEnemy = enemyKeys.filter(k => this.clampHandVal(this.state.enemy[k]) > 0);
      const alivePlayer = ['left','right'].filter(k => this.clampHandVal(this.state.player[k]) > 0);

      if(aliveEnemy.length === 0 || alivePlayer.length === 0){
        this._exitCritical();
        return;
      }

      const from = aliveEnemy[rand(0, aliveEnemy.length - 1)];
      const to = alivePlayer[rand(0, alivePlayer.length - 1)];

      this._attack(false, from, to);

      this._tickTurnBuffs();
      this._tickEnemyTurnBuffs();

      this.emit('enemyTurnEnd');
      this.uiUpdate();
    } finally {
      this._exitCritical();
    }
  }

  _applyTurnBuff(skillId, level, duration){
    let payload = {};
    if(skillId === 'fortify') payload = { type:'guardBoost', value: level };
    else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
    else payload = { type: skillId, value: level };
    this.state.turnBuffs = this.state.turnBuffs || [];
    this.state.turnBuffs.push({ skillId, remainingTurns: duration, payload });
  }
  _tickTurnBuffs(){
    (this.state.turnBuffs || []).forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
    this.state.turnBuffs = (this.state.turnBuffs || []).filter(tb => tb.remainingTurns > 0);
    (this.state.equippedSkills || []).forEach(s => { if(s.remainingTurns > 0) s.remainingTurns = Math.max(0, s.remainingTurns - 1); });
  }
  _applyEnemyTurnBuff(skillId, level, duration){
    let payload = {};
    if(skillId === 'fortify') payload = { type:'enemyGuardBoost', value: level };
    else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
    else payload = { type: skillId, value: level };
    this.state.enemyTurnBuffs = this.state.enemyTurnBuffs || [];
    this.state.enemyTurnBuffs.push({ skillId, remainingTurns: duration, payload });
  }
  _tickEnemyTurnBuffs(){
    (this.state.enemyTurnBuffs || []).forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
    this.state.enemyTurnBuffs = (this.state.enemyTurnBuffs || []).filter(tb => tb.remainingTurns > 0);
    (this.state.enemySkills || []).forEach(s => { if(s.remainingCooldown && s.remainingCooldown > 0) s.remainingCooldown = Math.max(0, s.remainingCooldown - 1); });
  }
  _applyRegenToUnit(isEnemy, level){
    const targetObj = isEnemy ? this.state.enemy : this.state.player;
    let sides = ['left','right'];
    if(isEnemy && this.state.enemyHasThirdHand) sides.push('third');
    sides = sides.filter(k => this.clampHandVal(targetObj[k]) > 0);
    if(sides.length === 0) return;
    for(let i=0;i<level;i++){
      const r = sides[rand(0, sides.length - 1)];
      const cur = this.clampHandVal(targetObj[r]);
      const newVal = safeDecrease(cur, 1);
      targetObj[r] = newVal;
      const el = isEnemy ? (r === 'left' ? hands.enemyLeft : (r === 'right' ? hands.enemyRight : hands.enemyThird)) : (r === 'left' ? hands.playerLeft : hands.playerRight);
      try{ if(typeof showPopupText === 'function') showPopupText(el, `-${1}`, '#ff9e9e'); }catch(e){}
    }
  }
  _handleCounter(attackerIsEnemy, attackerSide, targetIsEnemy, targetSide){
    const counterLevel = this._getSkillLevelOnUnit(targetIsEnemy, 'counter');
    if(!counterLevel || counterLevel <= 0) return;
    if(attackerIsEnemy){
      const cur = this.clampHandVal(this.state.enemy[attackerSide]);
      this.state.enemy[attackerSide] = Math.min(HARD_CAP, cur + counterLevel);
      const el = (attackerSide === 'left' ? hands.enemyLeft : (attackerSide === 'right' ? hands.enemyRight : hands.enemyThird));
      try{ if(typeof showPopupText === 'function') showPopupText(el, `+${counterLevel}`, '#ffd166'); }catch(e){}
    } else {
      const cur = this.clampHandVal(this.state.player[attackerSide]);
      this.state.player[attackerSide] = Math.min(HARD_CAP, cur + counterLevel);
      const el = (attackerSide === 'left' ? hands.playerLeft : hands.playerRight);
      try{ if(typeof showPopupText === 'function') showPopupText(el, `+${counterLevel}`, '#ffd166'); }catch(e){}
    }
  }
  _computePlayerAttackBonus(handKey){
    let bonus = 0;
    (this.state.equippedSkills || []).forEach(s => {
      if(s.type !== 'passive') return;
      if(s.id === 'power') bonus += s.level;
      if(s.id === 'berserk' && this.clampHandVal(this.state.player[handKey]) === 4) bonus += s.level * 2;
    });
    (this.state.turnBuffs || []).forEach(tb => {
      if(tb.payload){
        if(tb.payload.type === 'chainBoost') bonus += tb.payload.value;
        if(tb.payload.type === 'teamPower') bonus += tb.payload.value;
      }
    });
    const baseAtk = (this.state.baseStats && this.state.baseStats.baseAttack) ? Number(this.state.baseStats.baseAttack) : 0;
    const atkMul = (this.state.playerBattleModifiers && this.state.playerBattleModifiers.attackMultiplier) ? this.state.playerBattleModifiers.attackMultiplier : 1;
    bonus += baseAtk * atkMul;
    return bonus;
  }
  _computeEnemyAttackBonus(attackerHandKey){
    let bonus = 0;
    (this.state.enemySkills || []).forEach(s => {
      if(s.type !== 'passive') return;
      if(s.id === 'power') bonus += s.level;
      if(s.id === 'berserk' && this.clampHandVal(this.state.enemy[attackerHandKey]) === 4) bonus += s.level * 2;
    });
    (this.state.enemyTurnBuffs || []).forEach(tb => {
      if(tb.payload && tb.payload.type === 'chainBoost') bonus += tb.payload.value;
      if(tb.payload && tb.payload.type === 'teamPower') bonus += tb.payload.value;
    });
    return bonus;
  }
  _computeDefenseForTarget(targetIsEnemy){
    let reduction = 0;
    if(targetIsEnemy){
      (this.state.enemySkills || []).forEach(s => { if(s.id === 'guard') reduction += s.level; });
      (this.state.enemyTurnBuffs || []).forEach(tb => {
        if(tb.payload && (tb.payload.type === 'enemyGuardBoost' || tb.payload.type === 'guardBoost')) reduction += tb.payload.value;
      });
    } else {
      (this.state.equippedSkills || []).forEach(s => { if(s.id === 'guard') reduction += s.level; });
      (this.state.turnBuffs || []).forEach(tb => { if(tb.payload && tb.payload.type === 'guardBoost') reduction += tb.payload.value; });
    }
    const baseDef = (this.state.baseStats && this.state.baseStats.baseDefense) ? Number(this.state.baseStats.baseDefense) : 0;
    const defMul = (this.state.playerBattleModifiers && this.state.playerBattleModifiers.defenseMultiplier) ? this.state.playerBattleModifiers.defenseMultiplier : 1;
    if(!targetIsEnemy) reduction += baseDef * defMul;
    return reduction;
  }
  _getSkillLevelOnUnit(isEnemy, skillId){
    if(isEnemy){
      if(!this.state.enemySkills) return 0;
      const s = this.state.enemySkills.find(x=>x.id===skillId);
      return s ? (s.level||1) : 0;
    } else {
      const s = (this.state.equippedSkills || []).find(x=>x.id===skillId);
      return s ? (s.level||1) : 0;
    }
  }
  _getEquippedLevel(id){ const s = (this.state.equippedSkills || []).find(x=>x.id===id); return s ? s.level : 0; }
  _hasEquipped(id){ return (this.state.equippedSkills || []).some(s=>s.id===id); }
  _getSkillLevel(id){ const s = (this.state.unlockedSkills || []).find(u=>u.id===id); return s ? s.level : 0; }

  debugState(){ return JSON.parse(JSON.stringify(this.state)); }
}

/* ---------- engine init ---------- */
const engine = new BattleEngine(gameState, { updateUI, showPopupText, playSE, flashScreen });

/* ---------- convenience wrappers to keep previous code structure ---------- */
function getMaxFingerForEnemy(){ return engine.getMaxFinger(); }
function getDestroyThreshold(attackerIsPlayer = true){ return engine.getDestroyThreshold(attackerIsPlayer); }

/* ---------- seeding & reset ---------- */
function seedInitialUnlocks(){
  gameState.unlockedSkills = [{ id:'power', level:1 }, { id:'guard', level:1 }];
  saveUnlocked();
}
function resetGame(){
  if(!confirm('スキルのアンロックを初期状態にリセットします。\nよろしいですか？')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch(e){}
  seedInitialUnlocks();

  gameState.stage = 1;
  gameState.isBoss = false;
  gameState.player = { left:1, right:1 };
  gameState.enemy = { left:1, right:1 };
  gameState.playerTurn = true;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.turnBuffs = [];
  gameState.equippedSkills = [];
  gameState.enemySkills = [];
  gameState.enemyDoubleMultiplier = 1;
  gameState.enemyTurnBuffs = [];
  gameState.baseStats = { playerThreshold:5, enemyThreshold:5, baseAttack:0, baseDefense:0, maxFinger:5 };
  gameState.inBossReward = false;
  gameState.bossAbility = null;
  gameState.bossTurnCount = 0;
  gameState.enemyHasThirdHand = false;
  gameState.bossEnemyThresholdMultiplier = 1;

  gameState.playerBattleModifiers = { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
  gameState.playerShield = 0;
  gameState.awaitingEquip = false;

  selectedHand = null;
  equipTemp = [];
  removeOverlay();

  if(unlockedList) unlockedList.style.display = 'none';

  if(equippedList) equippedList.innerHTML = '';
  messageArea.textContent = 'スキルをリセットしました（初期スキルに戻しました）';
  showTitle();
}

/* ---------- init & title handling ---------- */
let selectedHand = null;
let equipTemp = [];
let _overlayEl = null;

function initGame(){
  const loaded = loadUnlocked();
  if(loaded && loaded.length>0) gameState.unlockedSkills = loaded;
  else seedInitialUnlocks();

  gameState.bestStage = loadBest();
  if(bestStageValue) bestStageValue.textContent = gameState.bestStage;

  if(titleScreen) titleScreen.style.display = 'flex';
  if(ruleScreen) ruleScreen.style.display = 'none';
  if(skillSelectArea) skillSelectArea.innerHTML = '';
  if(enemySkillArea) enemySkillArea.innerHTML = '敵スキル: —';
  messageArea.textContent = '';

  if(unlockedList) unlockedList.style.display = 'none';

  startButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'flex'; };
  resetButton.onclick = () => { playSE('click', 0.5); resetGame(); };
  if(ruleNextButton) ruleNextButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'none'; startGame(); };
  if(ruleBackButton) ruleBackButton.onclick = () => { playSE('click', 0.5); if(ruleScreen) ruleScreen.style.display = 'none'; if(titleScreen) titleScreen.style.display = 'flex'; };

  if(hands.playerLeft) hands.playerLeft.onclick = () => selectHand('left');
  if(hands.playerRight) hands.playerRight.onclick = () => selectHand('right');
  if(hands.enemyLeft) hands.enemyLeft.onclick = () => clickEnemyHand('left');
  if(hands.enemyRight) hands.enemyRight.onclick = () => clickEnemyHand('right');
  if(hands.enemyThird) hands.enemyThird.onclick = () => clickEnemyHand('third');

  setupHoverHandlers();

  // engine event bindings for UI / FX consistency
  engine.on('fingerDestroyed', ({ side, attemptedValue, ownerIsEnemy }) => {
    // play destroy SE + animate
    const targetEl = ownerIsEnemy ? (side === 'left' ? hands.enemyLeft : (side === 'right' ? hands.enemyRight : hands.enemyThird))
                                 : (side === 'left' ? hands.playerLeft : hands.playerRight);
    animateDestroy(targetEl);
    try { playSE('destroy', 0.9); } catch(e){}
    messageArea.textContent = '手が破壊されました';
    updateUI();
  });

  engine.on('reincarnation', (side, mod) => {
    // message already handled in engine, but ensure UI updated
    messageArea.textContent = `転生：手が ${mod} に復活`;
    updateUI();
  });

  engine.on('bossAbilityAssigned', (id) => {
    const h = engine.bossRegistry[id];
    messageArea.textContent = `BOSS 能力: ${h && h.name ? h.name : id} が付与されました`;
    updateUI();
  });

  engine.on('battleStart', ({stage, isBoss}) => {
    // no-op by default; UI updated elsewhere
  });
}

function showTitle(){ gameState.inTitle = true; if(titleScreen) titleScreen.style.display = 'flex'; if(bestStageValue) bestStageValue.textContent = gameState.bestStage; }
function hideTitle(){ gameState.inTitle = false; if(titleScreen) titleScreen.style.display = 'none'; }

/* ---------- start / stage flow ---------- */
function startGame(){
  gameState.baseStats = { playerThreshold:5, enemyThreshold:5, baseAttack:0, baseDefense:0, maxFinger:5 };
  gameState.inBossReward = false;

  gameState.stage = 1;
  gameState.playerTurn = true;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.turnBuffs = [];
  gameState.enemyTurnBuffs = [];
  gameState.enemySkills = [];
  gameState.enemyDoubleMultiplier = 1;
  gameState.equippedSkills = [];
  gameState.combo = 0;

  gameState.playerBattleModifiers = { thresholdMultiplier:1, attackMultiplier:1, defenseMultiplier:1 };
  gameState.playerShield = 0;
  gameState.awaitingEquip = false;

  selectedHand = null;
  equipTemp = [];

  if(titleScreen) titleScreen.style.display = 'none';
  if(ruleScreen) ruleScreen.style.display = 'none';

  if(skillSelectArea) skillSelectArea.innerHTML = '';
  if(messageArea) messageArea.textContent = '';
  if(enemySkillArea) enemySkillArea.innerHTML = '敵スキル: —';

  if(!gameState.unlockedSkills || gameState.unlockedSkills.length === 0) seedInitialUnlocks();

  startBattle();
}

function startBattle(){
  if(gameState.inBossReward) return;

  // reset temp
  gameState.bossEnemyThresholdMultiplier = 1;
  gameState.bossAbility = null;
  gameState.bossTurnCount = 0;
  gameState.enemyHasThirdHand = false;

  equipTemp = [];
  selectedHand = null;
  gameState.pendingActiveUse = null;
  gameState.doubleMultiplier = 1;
  gameState.equippedSkills = [];
  gameState.turnBuffs = [];
  gameState.playerTurn = true;
  gameState.combo = 0;

  gameState.player.left = 1;
  gameState.player.right = 1;

  gameState.isBoss = (gameState.stage % 3 === 0);
  document.body.classList.toggle('boss', gameState.isBoss);

  gameState.enemy.left = toNum(rand(1,2));
  gameState.enemy.right = toNum(rand(1,2));

  gameState.enemyDoubleMultiplier = 1;
  gameState.enemyTurnBuffs = [];

  if(gameState.isBoss){
    // choose a random boss ability id from engine's registry
    const keys = Object.keys(engine.bossRegistry);
    const pickId = keys[rand(0, keys.length-1)];
    gameState.bossAbility = pickId; // store chosen ability id
    engine.assignBossAbility(pickId);
  }

  assignEnemySkills();

  // await equip selection (commitEquips will apply possession etc.)
  gameState.awaitingEquip = true;

  updateUI();
  showEquipSelection();
}

/* ---------- assign enemy skills ---------- */
function assignEnemySkills(){
  const possible = SKILL_POOL.slice().filter(s => s.id !== 'revenge');
  const skillCount = Math.min(3, 1 + Math.floor(gameState.stage / 4));
  const chosen = [];
  let pool = possible.slice();
  while(chosen.length < skillCount && pool.length > 0){
    const idx = rand(0, pool.length - 1);
    const s = pool.splice(idx, 1)[0];
    const level = Math.min(MAX_SKILL_LEVEL, 1 + Math.floor(gameState.stage / 6));
    chosen.push({ id: s.id, level, type: s.type, name: s.name, remainingCooldown: 0 });
  }
  gameState.enemySkills = chosen;
  updateEnemySkillUI();
}

/* ---------- equip / reward UI ---------- */
function showEquipSelection(){
  skillSelectArea.innerHTML = '';
  messageArea.textContent = `装備スキルを最大${EQUIP_SLOTS}つ選んで「確定」してください`;

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  gameState.unlockedSkills.forEach(us => {
    const def = SKILL_POOL.find(s=>s.id===us.id);
    if(!def) return;
    const btn = document.createElement('button');
    btn.className = 'skill-btn';
    btn.classList.add('rarity-' + (def.rarity || 'common'));
    btn.dataset.id = us.id;
    btn.innerHTML = `<div style="font-weight:700">${def.name} Lv${us.level}</div><small style="opacity:.9">${def.baseDesc}</small><div style="font-size:11px;opacity:.85;margin-top:4px">${(def.rarity||'common').toUpperCase()}</div>`;
    btn.onclick = () => {
      if(gameState.inBossReward) return;
      playSE('click', 0.5);
      const idx = equipTemp.indexOf(us.id);
      if(idx === -1){
        if(equipTemp.length >= EQUIP_SLOTS){
          messageArea.textContent = `最大${EQUIP_SLOTS}つまで装備できます`;
          setTimeout(()=> messageArea.textContent = `装備スキルを最大${EQUIP_SLOTS}つ選んで「確定」してください`, 900);
          return;
        }
        equipTemp.push(us.id);
        btn.classList.add('chosen');
      } else {
        equipTemp.splice(idx,1);
        btn.classList.remove('chosen');
      }
    };
    wrap.appendChild(btn);
  });

  const confirm = document.createElement('button');
  confirm.textContent = '確定';
  confirm.style.marginLeft = '8px';
  confirm.onclick = () => {
    if(gameState.inBossReward) return;
    playSE('click', 0.5);
    commitEquips();
  };

  skillSelectArea.appendChild(wrap);
  skillSelectArea.appendChild(confirm);
}

function commitEquips(){
  gameState.equippedSkills = equipTemp.map(id => {
    const unlocked = gameState.unlockedSkills.find(u=>u.id===id);
    const def = SKILL_POOL.find(s=>s.id===id);
    return {
      id: def.id,
      level: (unlocked && unlocked.level) ? unlocked.level : 1,
      type: def.type,
      name: def.name,
      desc: def.baseDesc,
      used: false,
      remainingTurns: 0
    };
  });
  equipTemp = [];
  skillSelectArea.innerHTML = '';
  messageArea.textContent = '';
  renderEquipped();
  skillInfo.textContent = gameState.equippedSkills && gameState.equippedSkills.length ? 'Equipped: ' + gameState.equippedSkills.map(s=>s.name+' Lv'+s.level).join(', ') : 'Equipped: —';

  // 装備確定後にバトル開始時パッシブを適用（possession 等）
  applyBattleStartPassives();

  updateUI();
}

/* ---------- apply battle-start passives (possession) ---------- */
function applyBattleStartPassives(){
  if(!gameState.awaitingEquip) return;
  gameState.awaitingEquip = false;

  if(hasEquipped('possession')){
    // possession spec: バトル開始時に左手破壊、閾値/基礎攻防をバトル中×2
    gameState.player.left = 0;
    gameState.playerBattleModifiers.thresholdMultiplier = (gameState.playerBattleModifiers.thresholdMultiplier || 1) * 2;
    gameState.playerBattleModifiers.attackMultiplier = (gameState.playerBattleModifiers.attackMultiplier || 1) * 2;
    gameState.playerBattleModifiers.defenseMultiplier = (gameState.playerBattleModifiers.defenseMultiplier || 1) * 2;
    messageArea.textContent = 'ポゼッションが発動：左手を失い、攻防・閾値が×2に';
    playSE('skill', 0.6);
    flashScreen(.14);
  }

  // commit any other start-of-battle persistent effects if needed

  // ensure engine UI updated
  engine.uiUpdate();
}

/* ---------- rendering ---------- */
function renderEquipped(){
  equippedList.innerHTML = '';
  if(!gameState.equippedSkills || gameState.equippedSkills.length === 0){
    equippedList.textContent = '(None)';
    return;
  }
  gameState.equippedSkills.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'skill-card';
    if(s.type === 'passive' || s.type === 'combo' || s.type === 'event' ){
      card.innerHTML = `<div class="skill-passive">${s.name} Lv${s.level}<div style="font-size:12px;opacity:.85">${s.desc}</div></div>`;
    } else if(s.type === 'active' || s.type === 'turn'){
      const btn = document.createElement('button');
      btn.textContent = `${s.name} Lv${s.level}`;
      btn.disabled = s.used;
      if(s.used) btn.classList.add('used');
      btn.onclick = () => {
        if(gameState.inBossReward) return;
        if(s.used) return;
        playSE('skill', 0.7);
        if(s.id === 'double'){
          s.used = true;
          gameState.doubleMultiplier = 1 + s.level;
          messageArea.textContent = `${s.name} を発動（次の攻撃が×${gameState.doubleMultiplier}）`;
          renderEquipped();
        } else if(s.id === 'heal'){
          gameState.pendingActiveUse = { id: 'heal', idx };
          messageArea.textContent = 'ヒール使用（自傷）：自分の手を選んでください';
        } else if(s.id === 'disrupt'){
          gameState.pendingActiveUse = { id: 'disrupt', idx };
          messageArea.textContent = 'ディスラプト使用：敵の手を選んでください';
        } else if(s.id === 'teamPower'){
          s.used = true;
          const duration = 2 * s.level;
          s.remainingTurns = duration;
          applyTurnBuff('teamPower', s.level, duration);
          messageArea.textContent = `${s.name} を ${duration} ターン有効化しました（味方全体の攻撃 +${s.level}）`;
          renderEquipped();
        } else if(s.type === 'turn'){
          s.used = true;
          const duration = 2 * s.level;
          s.remainingTurns = duration;
          applyTurnBuff(s.id, s.level, duration);
          messageArea.textContent = `${s.name} を ${duration} ターン有効化しました`;
          renderEquipped();
        } else {
          // new actives
          if(s.id === 'overheat'){
            gameState.pendingActiveUse = { id: 'overheat', idx };
            messageArea.textContent = 'オーバーヒート使用：自分の手を選んでください（+3、シールド+Lv）';
          } else if(s.id === 'pumpUp'){
            gameState.pendingActiveUse = { id: 'pumpUp', idx };
            messageArea.textContent = 'パンプアップ使用：自分の手を選んでください（+Lv）';
          } else if(s.id === 'split'){
            gameState.pendingActiveUse = { id: 'split', idx };
            messageArea.textContent = '分割使用：片手のみ生存の時に、その手を選んでください（分割されます）';
          } else {
            messageArea.textContent = 'このタイプのスキルはまだ実装されていません';
          }
        }
      };
      const div = document.createElement('div');
      div.className = 'skill-active';
      if(s.remainingTurns && s.remainingTurns > 0){
        const meta = document.createElement('div');
        meta.style.fontSize = '12px';
        meta.style.opacity = '0.9';
        meta.textContent = `(${s.remainingTurns}ターン)`;
        card.appendChild(meta);
      }
      div.appendChild(btn);
      card.appendChild(div);
    }
    equippedList.appendChild(card);
  });
}

function renderUnlockedList(){
  if(unlockedList) {
    unlockedList.style.display = 'none';
  }
}

/* ---------- enemy skill UI ---------- */
function updateEnemySkillUI(){
  if(!enemySkillArea) return;
  if(!gameState.enemySkills || gameState.enemySkills.length === 0){
    enemySkillArea.textContent = '敵スキル: —';
    return;
  }

  const typeColor = {
    passive: '#ddd',
    active: '#ffd166',
    turn: '#7cc7ff',
    combo: '#d7b3ff',
    event: '#ff9e9e'
  };

  const parts = gameState.enemySkills.map(s => {
    const cd = s.remainingCooldown && s.remainingCooldown > 0 ? ` (CD:${s.remainingCooldown})` : '';
    const color = typeColor[s.type] || '#fff';
    const def = SKILL_POOL.find(x=>x.id===s.id) || {};
    const rar = def.rarity ? ` [${def.rarity.toUpperCase()}]` : '';
    return `<span style="color:${color}; font-weight:700; margin-right:6px">${s.name}${rar} Lv${s.level}${cd}</span>`;
  });

  const buffs = gameState.enemyTurnBuffs.map(tb => {
    if(tb.skillId === 'fortify') return `防御+${tb.payload.value} (${tb.remainingTurns})`;
    if(tb.skillId === 'chain') return `次攻撃+${tb.payload.value} (${tb.remainingTurns})`;
    if(tb.skillId === 'teamPower') return `味方全体+${tb.payload.value} (${tb.remainingTurns})`;
    return '';
  }).filter(Boolean);

  const buffText = buffs.length ? ` | Buffs: ${buffs.join(', ')}` : '';
  enemySkillArea.innerHTML = `敵スキル: ${parts.join(' ')}${buffText}`;
}

/* ---------- UI update ---------- */
function updateBossUI(){
  if(!bossAbilityArea) return;
  if(!gameState.isBoss || !gameState.bossAbility){
    bossAbilityArea.textContent = '';
    return;
  }
  const def = engine.bossRegistry[gameState.bossAbility];
  bossAbilityArea.innerHTML = `<span style="color:#ff5555;font-weight:bold">BOSS能力: ${(def && def.name) ? def.name : gameState.bossAbility}</span><br><small>${(def && def.desc) ? def.desc : ''}</small>`;
}

function updateUI(){
  const pThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.playerThreshold)))
    ? Number(gameState.baseStats.playerThreshold)
    : 5;
  stageInfo.textContent = `Stage ${gameState.stage} ${gameState.isBoss ? 'BOSS' : ''}`;

  let displayPThresh = pThreshold * (gameState.playerBattleModifiers && gameState.playerBattleModifiers.thresholdMultiplier ? gameState.playerBattleModifiers.thresholdMultiplier : 1);
  if(thresholdInfo) thresholdInfo.textContent = `Threshold: ${displayPThresh}`;

  skillInfo.textContent = gameState.equippedSkills && gameState.equippedSkills.length ? 'Equipped: ' + gameState.equippedSkills.map(s=>s.name+' Lv'+s.level).join(', ') : 'Equipped: —';
  updateHand('playerLeft', gameState.player.left);
  updateHand('playerRight', gameState.player.right);
  updateHand('enemyLeft', gameState.enemy.left);
  updateHand('enemyRight', gameState.enemy.right);
  if(gameState.enemyHasThirdHand){
    updateHand('enemyThird', gameState.enemy.third || 0);
  }
  updateEnemySkillUI();
  updateBossUI();

  if(_overlayEl && _overlayEl.dataset.owner && _overlayEl.dataset.hand) {
    refreshOverlayContent(_overlayEl.dataset.owner, _overlayEl.dataset.hand);
  }
}

function updateHand(key, value){
  const el = hands[key];
  const bar = bars[key];
  const v = toNum(value);
  if(el) { el.textContent = v; el.classList.toggle('zero', v === 0); }

  let displayThreshold = 5;
  if(key.startsWith('player')) displayThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.playerThreshold))) ? Number(gameState.baseStats.playerThreshold) : 5;
  else {
    displayThreshold = (gameState.baseStats && Number.isFinite(Number(gameState.baseStats.enemyThreshold))) ? Number(gameState.baseStats.enemyThreshold) : 5;
    displayThreshold *= (gameState.bossEnemyThresholdMultiplier || 1);
  }

  if(key.startsWith('player')){
    displayThreshold *= (gameState.playerBattleModifiers && gameState.playerBattleModifiers.thresholdMultiplier) ? gameState.playerBattleModifiers.thresholdMultiplier : 1;
  }

  if(bar) {
    const pct = displayThreshold > 0 ? Math.min(100, (v / displayThreshold) * 100) : Math.min(100, v * 16);
    bar.style.width = pct + '%';
  }
}

/* ---------- Hover / Overlay ---------- */
function setupHoverHandlers(){
  const mapping = [
    { el: hands.enemyLeft, owner: 'enemy', hand: 'left' },
    { el: hands.enemyRight, owner: 'enemy', hand: 'right' },
    { el: hands.enemyThird, owner: 'enemy', hand: 'third' },
    { el: hands.playerLeft, owner: 'player', hand: 'left' },
    { el: hands.playerRight, owner: 'player', hand: 'right' }
  ];

  mapping.forEach(m => {
    if(!m.el) return;
    m.el.onmouseenter = (e) => { showOverlayFor(m.owner, m.hand, e.pageX, e.pageY); };
    m.el.onmousemove = (e) => { moveOverlay(e.pageX, e.pageY); };
    m.el.onmouseleave = () => { removeOverlay(); };
  });
}

function showOverlayFor(owner, hand, x, y){
  removeOverlay();
  _overlayEl = document.createElement('div');
  _overlayEl.className = 'fd-overlay';
  _overlayEl.style.position = 'absolute';
  _overlayEl.style.pointerEvents = 'none';
  _overlayEl.style.zIndex = 1200;
  _overlayEl.style.background = 'rgba(12,12,12,0.92)';
  _overlayEl.style.color = '#fff';
  _overlayEl.style.padding = '10px 12px';
  _overlayEl.style.borderRadius = '10px';
  _overlayEl.style.boxShadow = '0 8px 22px rgba(0,0,0,0.6)';
  _overlayEl.style.fontSize = '13px';
  _overlayEl.dataset.owner = owner;
  _overlayEl.dataset.hand = hand;

  document.body.appendChild(_overlayEl);
  refreshOverlayContent(owner, hand);
  moveOverlay(x, y);
}

function refreshOverlayContent(owner, hand){
  if(!_overlayEl) return;
  _overlayEl.dataset.owner = owner;
  _overlayEl.dataset.hand = hand;

  const isEnemy = (owner === 'enemy');
  const value = isEnemy ? toNum(gameState.enemy[hand]) : toNum(gameState.player[hand]);
  const attackerIsPlayer = isEnemy ? true : false;
  const destroyThreshold = getDestroyThreshold(attackerIsPlayer);

  const remaining = Number.isFinite(destroyThreshold) ? (destroyThreshold - value) : '—';
  const remText = (value === 0) ? '破壊済み (0)' : (remaining <= 0 ? '次の標準攻撃で破壊可能' : `破壊まであと ${remaining}`);

  let pierceInfo = '';
  if(attackerIsPlayer){
    const pierceLv = getEquippedLevel('pierce') || 0;
    if(pierceLv > 0) pierceInfo = `（プレイヤーのピアス: Lv${pierceLv} が適用）`;
  } else {
    const enemyPierce = (gameState.enemySkills || []).filter(s=>s.id==='pierce').reduce((sum,s)=>sum+(s.level||0),0);
    if(enemyPierce > 0) pierceInfo = `（敵のピアス: Lv${enemyPierce} が適用）`;
  }

  const buffs = [];
  if(isEnemy){
    (gameState.enemyTurnBuffs || []).forEach(tb => {
      if(tb.payload && tb.remainingTurns>0){
        if(tb.payload.type === 'enemyGuardBoost' || tb.payload.type === 'guardBoost') buffs.push(`防御+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'chainBoost') buffs.push(`次攻撃+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'teamPower') buffs.push(`味方全体+${tb.payload.value} (${tb.remainingTurns}ターン)`);
      }
    });
  } else {
    (gameState.turnBuffs || []).forEach(tb => {
      if(tb.payload && tb.remainingTurns>0){
        if(tb.payload.type === 'guardBoost') buffs.push(`防御+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'chainBoost') buffs.push(`次攻撃+${tb.payload.value} (${tb.remainingTurns}ターン)`);
        if(tb.payload.type === 'teamPower') buffs.push(`味方全体+${tb.payload.value} (${tb.remainingTurns}ターン)`);
      }
    });
  }

  let attackerDouble = (attackerIsPlayer ? gameState.doubleMultiplier : gameState.enemyDoubleMultiplier) || 1;
  const attackerDoubleText = attackerDouble > 1 ? `（次の攻撃が×${attackerDouble}）` : '';

  let sampleAtt = 0;
  if(attackerIsPlayer){
    sampleAtt = Math.max(toNum(gameState.player.left), toNum(gameState.player.right)) + computePlayerAttackBonus('left');
  } else {
    const keys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
    const bestKey = keys.reduce((a,b) => (toNum(gameState.enemy[a]) > toNum(gameState.enemy[b]) ? a : b));
    sampleAtt = Math.max(toNum(gameState.enemy[bestKey]), 0) + computeEnemyAttackBonus(bestKey);
  }
  const sampleText = `代表攻撃力目安: ${sampleAtt} ${attackerDoubleText}`;

  let html = `<div style="font-weight:800; margin-bottom:6px">${isEnemy ? '敵' : 'あなた'} — ${hand === 'left' ? '左手' : (hand === 'right' ? '右手' : '第3の手')}</div>`;
  html += `<div>現在値: <b>${value}</b></div>`;
  html += `<div>閾値（想定攻撃元に対して）: <b>${destroyThreshold}</b> ${pierceInfo}</div>`;
  html += `<div style="margin-top:6px; font-weight:700">${remText}</div>`;
  html += `<div style="margin-top:6px; color:#ccc">${sampleText}</div>`;
  if(buffs.length > 0){
    html += `<div style="margin-top:8px; color:#ffd">${buffs.join(' / ')}</div>`;
  }

  const skills = isEnemy ? (gameState.enemySkills || []) : (gameState.equippedSkills || []).filter(s=>s.type==='passive' || s.type==='event' || s.type==='combo');
  if(skills && skills.length > 0){
    const skillNames = skills.map(s => `${s.name} Lv${s.level||1}`);
    html += `<div style="margin-top:8px; font-size:12px; opacity:0.9">関連スキル: ${skillNames.join(' / ')}</div>`;
  }

  _overlayEl.innerHTML = html;
}

function moveOverlay(x, y){
  if(!_overlayEl) return;
  const offset = 12;
  _overlayEl.style.left = (x + offset) + 'px';
  _overlayEl.style.top = (y + offset) + 'px';
}

function removeOverlay(){
  if(_overlayEl){
    _overlayEl.remove();
    _overlayEl = null;
  }
}

/* ---------- skill engine helpers (wrappers for compatibility) ---------- */
function getUnlockedLevel(id){
  const u = (gameState.unlockedSkills || []).find(x=>x.id===id);
  return u ? (u.level || 1) : 0;
}
function hasEquipped(id){
  return (gameState.equippedSkills || []).some(s=>s.id===id);
}
function getEquippedLevel(id){
  const s = (gameState.equippedSkills || []).find(x=>x.id===id);
  return s ? s.level : 0;
}
function applyTurnBuff(skillId, level, duration){
  let payload = {};
  if(skillId === 'fortify') payload = { type:'guardBoost', value: level };
  else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
  else payload = { type: skillId, value: level };
  gameState.turnBuffs.push({ skillId, remainingTurns: duration, payload });
}
function tickTurnBuffs(){
  gameState.turnBuffs.forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
  gameState.turnBuffs = gameState.turnBuffs.filter(tb => tb.remainingTurns > 0);
  (gameState.equippedSkills || []).forEach(s => { if(s.remainingTurns > 0) s.remainingTurns = Math.max(0, s.remainingTurns - 1); });
}
function _applyTurnBuff(skillId, level, duration){ applyTurnBuff(skillId, level, duration); }

/* ---------- enemy turn-buff helpers ---------- */
function applyEnemyTurnBuff(skillId, level, duration){
  let payload = {};
  if(skillId === 'fortify') payload = { type:'enemyGuardBoost', value: level };
  else if(skillId === 'teamPower') payload = { type:'teamPower', value: level };
  else payload = { type: skillId, value: level };
  gameState.enemyTurnBuffs.push({ skillId, remainingTurns: duration, payload });
}
function tickEnemyTurnBuffs(){
  gameState.enemyTurnBuffs.forEach(tb => tb.remainingTurns = Math.max(0, tb.remainingTurns - 1));
  gameState.enemyTurnBuffs = gameState.enemyTurnBuffs.filter(tb => tb.remainingTurns > 0);
  (gameState.enemySkills || []).forEach(s => { if(s.remainingCooldown && s.remainingCooldown > 0) s.remainingCooldown = Math.max(0, s.remainingCooldown - 1); });
}
function _applyEnemyTurnBuff(skillId, level, duration){ applyEnemyTurnBuff(skillId, level, duration); }

/* ---------- compute bonuses (compat wrappers that use engine's methods) ---------- */
function computePlayerAttackBonus(handKey){
  return engine._computePlayerAttackBonus(handKey);
}
function computeEnemyAttackBonus(handKey){
  return engine._computeEnemyAttackBonus(handKey);
}
function computeEnemyAttackReduction(){
  return engine._computeDefenseForTarget(false);
}

/* ---------- apply pending actives ---------- */
function applyPendingActiveOnPlayer(side){
  if(!gameState.pendingActiveUse) return;
  const pending = gameState.pendingActiveUse;
  const sk = gameState.equippedSkills[pending.idx];
  if(!sk || sk.used){ gameState.pendingActiveUse = null; messageArea.textContent = 'そのスキルは使用できません'; return; }

  if(pending.id === 'heal'){
    const amount = 1 + sk.level;
    playSE('skill', 0.7);
    const cur = toNum(gameState.player[side]);
    const newVal = safeDecrease(cur, amount);
    gameState.player[side] = newVal;
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (-${amount})`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `-${amount}`, '#ff9e9e');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  if(pending.id === 'overheat'){
    const amount = 3;
    playSE('skill', 0.8);
    const cur = toNum(gameState.player[side]);
    const newVal = Math.min(HARD_CAP, cur + amount);
    gameState.player[side] = newVal;
    gameState.playerShield = (gameState.playerShield || 0) + (sk.level || 1);
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (+${amount}) — シールド +${sk.level}`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `+${amount}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  if(pending.id === 'pumpUp'){
    const amount = sk.level || 1;
    playSE('skill', 0.7);
    const cur = toNum(gameState.player[side]);
    const newVal = Math.min(HARD_CAP, cur + amount);
    gameState.player[side] = newVal;
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${side} に使用しました (+${amount})`;
    const el = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(el, `+${amount}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  if(pending.id === 'split'){
    const alive = ['left','right'].filter(k => toNum(gameState.player[k]) > 0);
    if(alive.length !== 1){
      messageArea.textContent = '分割は片手のみ生存している時に使用できます';
      gameState.pendingActiveUse = null;
      return;
    }
    if(alive[0] !== side){
      messageArea.textContent = '分割は生存している手を選んでください';
      gameState.pendingActiveUse = null;
      return;
    }
    const val = toNum(gameState.player[side]);
    if(val < 2){
      messageArea.textContent = '分割するには値が2以上必要です';
      gameState.pendingActiveUse = null;
      return;
    }
    playSE('skill', 0.75);
    const half1 = Math.floor(val / 2);
    const half2 = Math.ceil(val / 2);
    const other = side === 'left' ? 'right' : 'left';
    gameState.player[side] = half1;
    gameState.player[other] = half2;
    sk.used = true;
    messageArea.textContent = `${sk.name} を使用：${val} → ${half1} / ${half2}`;
    const elSide = hands[side === 'left' ? 'playerLeft' : 'playerRight'];
    const elOther = hands[other === 'left' ? 'playerLeft' : 'playerRight'];
    showPopupText(elSide, `${half1}`, '#ffd166');
    showPopupText(elOther, `${half2}`, '#ffd166');
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
    return;
  }

  gameState.pendingActiveUse = null;
  messageArea.textContent = 'その操作は無効です';
}

/* ---------- active on enemy ---------- */
function applyPendingActiveOnEnemy(side){
  if(!gameState.pendingActiveUse) return;
  const pending = gameState.pendingActiveUse;
  const sk = gameState.equippedSkills[pending.idx];
  if(!sk || sk.used){ gameState.pendingActiveUse = null; messageArea.textContent = 'そのスキルは使用できません'; return; }

  if(pending.id === 'disrupt'){
    const amount = 1 + sk.level;
    const key = side;
    const el = hands[key === 'left' ? 'enemyLeft' : (key === 'right' ? enemyRight : 'enemyThird')];
    const cur = toNum(gameState.enemy[key]);
    const newVal = safeDecrease(cur, amount);
    gameState.enemy[key] = newVal;
    showPopupText(el, `-${amount}`, '#ff9e9e');
    sk.used = true;
    messageArea.textContent = `${sk.name} を ${key} に使用しました (-${amount})`;
    gameState.pendingActiveUse = null;
    updateUI();
    renderEquipped();
  }
}

/* ---------- player attack handler (wraps engine) ---------- */
function playerAttack(targetSide){
  if(gameState.inBossReward) return;
  if(skillSelectArea && skillSelectArea.children.length > 0){
    messageArea.textContent = 'まず装備を確定してください'; return;
  }
  if(!gameState.playerTurn) return;
  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'heal'){ messageArea.textContent = 'ヒール使用中：自分の手を選んでください'; return; }

  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'disrupt'){
    applyPendingActiveOnEnemy(targetSide);
    return;
  }

  playSE('attack', 0.7);
  const attackerEl = hands[selectedHand === 'left' ? 'playerLeft' : 'playerRight'];
  const targetEl = (targetSide === 'left' ? hands.enemyLeft : (targetSide === 'right' ? hands.enemyRight : hands.enemyThird));
  animateAttack(attackerEl, targetEl);

  // delegate to engine
  const res = engine.playerAttack(selectedHand, targetSide);
  // res may be undefined in some guards
  clearHandSelection();
  gameState.playerTurn = false;
  updateUI();
  flashScreen();

  if(gameState.isBoss && gameState.bossAbility && typeof engine.bossRegistry[gameState.bossAbility] === 'object' && typeof engine.bossRegistry[gameState.bossAbility].onPlayerTurnEnd === 'function'){
    try { engine.bossRegistry[gameState.bossAbility].onPlayerTurnEnd(engine, gameState); } catch(e){}
  }

  if(!checkWinLose()) setTimeout(()=> engine.enemyTurn(), 650);
}

/* ---------- enemy turn ---------- */
/* replaced by engine.enemyTurn */

/* ---------- selection handlers ---------- */
function applyPendingActiveOnPlayerWrapper(side){
  applyPendingActiveOnPlayer(side);
}

function clearHandSelection(){
  selectedHand = null;
  if(hands.playerLeft) hands.playerLeft.classList.remove('selected');
  if(hands.playerRight) hands.playerRight.classList.remove('selected');
}

function selectHand(side){
  if(gameState.inBossReward) return;
  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'heal'){
    applyPendingActiveOnPlayerWrapper(side);
    return;
  }
  if(skillSelectArea && skillSelectArea.children.length > 0){
    messageArea.textContent = 'まず装備を確定してください'; return;
  }
  if(!gameState.playerTurn) return;
  if(toNum(gameState.player[side]) === 0) return;

  playSE('click', 0.5);

  if(gameState.pendingActiveUse && ['heal','overheat','pumpUp','split'].includes(gameState.pendingActiveUse.id)){
    applyPendingActiveOnPlayer(side);
    return;
  }

  if(selectedHand === side){
    selectedHand = null;
    if(hands.playerLeft) hands.playerLeft.classList.remove('selected');
    if(hands.playerRight) hands.playerRight.classList.remove('selected');
    messageArea.textContent = '選択を解除しました';
    return;
  }

  selectedHand = side;
  if(hands.playerLeft) hands.playerLeft.classList.toggle('selected', side === 'left');
  if(hands.playerRight) hands.playerRight.classList.toggle('selected', side === 'right');

  messageArea.textContent = '敵の手を選んで攻撃してください';
}
function clickEnemyHand(side){
  if(gameState.inBossReward) return;
  if(skillSelectArea && skillSelectArea.children.length > 0){ messageArea.textContent = 'まず装備を確定してください'; return; }
  if(!gameState.playerTurn) return;

  if(gameState.pendingActiveUse && gameState.pendingActiveUse.id === 'disrupt'){
    applyPendingActiveOnEnemy(side);
    return;
  }

  if(!selectedHand){ messageArea.textContent = '攻撃する手を選んでください'; return; }
  if(toNum(gameState.enemy[side]) === 0){ messageArea.textContent = 'その敵の手は既に0です'; return; }

  playSE('click', 0.5);
  playerAttack(side);
}

if(hands.playerLeft) hands.playerLeft.onclick = () => selectHand('left');
if(hands.playerRight) hands.playerRight.onclick = () => selectHand('right');
if(hands.enemyLeft) hands.enemyLeft.onclick = () => clickEnemyHand('left');
if(hands.enemyRight) hands.enemyRight.onclick = () => clickEnemyHand('right');
if(hands.enemyThird) hands.enemyThird.onclick = () => clickEnemyHand('third');

/* ---------- check win/lose & reward ---------- */
function checkWinLose(){
  const playerDead = toNum(gameState.player.left) === 0 && toNum(gameState.player.right) === 0;
  const enemyKeys = gameState.enemyHasThirdHand ? ['left','right','third'] : ['left','right'];
  const enemyDead = enemyKeys.every(k => toNum(gameState.enemy[k]) === 0);

  if(enemyDead){
    playSE('victory', 0.8);
    if(gameState.isBoss){
      messageArea.textContent = 'Boss Defeated! 基礎ステータスを1つ選択してください';
      setTimeout(()=> showBossRewardSelection(), 350);
      return true;
    } else {
      messageArea.textContent = 'Victory! スキル報酬を獲得';
      setTimeout(()=> showRewardSelection(), 600);
      return true;
    }
  }
  if(playerDead){
    playSE('lose', 0.8);
    messageArea.textContent = 'Game Over';
    if(gameState.stage > gameState.bestStage){
      gameState.bestStage = gameState.stage;
      saveBest();
    }
    setTimeout(()=> {
      if(bestStageValue) bestStageValue.textContent = gameState.bestStage;
      showTitle();
    }, 1000);
    return true;
  }
  return false;
}

/* ---------- reward / boss reward (same as before) ---------- */
function getSkillWeight(skill){
  const r = skill.rarity || 'common';
  if(r === 'common') return 60;
  if(r === 'rare') return 30;
  if(r === 'epic') return 10;
  return 50;
}
function weightedRandomSkillFromList(list){
  if(!list || list.length === 0) return null;
  const total = list.reduce((sum,s)=>sum+getSkillWeight(s),0);
  let r = Math.random()*total;
  for(const s of list){
    const w = getSkillWeight(s);
    if(r < w) return s;
    r -= w;
  }
  return list[0];
}
function generateBaseStatRewards(){
  const pool = [
    {
      id: 'baseAttack',
      name: '⚔ 基礎攻撃 +1',
      desc: '全ての攻撃に恒久的に +1（ラン内有効）',
      apply: () => { gameState.baseStats.baseAttack = (gameState.baseStats.baseAttack || 0) + 1; }
    },
    {
      id: 'baseDefense',
      name: '🛡 基礎防御 +1',
      desc: '敵の攻撃に対する恒久的な防御 +1（ラン内有効）',
      apply: () => { gameState.baseStats.baseDefense = (gameState.baseStats.baseDefense || 0) + 1; }
    },
    {
      id: 'playerThreshold',
      name: '💎 破壊閾値 +1',
      desc: '指の破壊閾値を +1（プレイヤー側、ラン内有効）',
      apply: () => { gameState.baseStats.playerThreshold = (Number.isFinite(Number(gameState.baseStats.playerThreshold)) ? gameState.baseStats.playerThreshold : 5) + 1; }
    }
  ];

  return pool.sort(() => Math.random() - 0.5).slice(0, 3);
}

function showBaseRewardSelection(rewards){
  skillSelectArea.innerHTML = '';
  messageArea.textContent = 'スキル報酬がありません。基礎能力を強化してください';

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  rewards.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'skill-btn node-btn';
    btn.innerHTML = `<div style="font-weight:700">${r.name}</div><small style="opacity:.9">${r.desc}</small>`;
    btn.onclick = () => {
      playSE('click', 0.6);
      r.apply();
      messageArea.textContent = `${r.name} を獲得しました`;
      skillSelectArea.innerHTML = '';
      updateUI();
      flashScreen(.14);
      setTimeout(()=> {
        gameState.stage++;
        startBattle();
      }, 700);
    };
    wrap.appendChild(btn);
  });

  skillSelectArea.appendChild(wrap);
}

function showRewardSelection(){
  const unlockedIds = (gameState.unlockedSkills || []).map(u=>u.id);
  const notUnlocked = SKILL_POOL.filter(s => !unlockedIds.includes(s.id));
  const picks = [];

  const tempPool = notUnlocked.slice();
  while(picks.length < 3 && tempPool.length > 0){
    const pick = weightedRandomSkillFromList(tempPool);
    if(!pick) break;
    picks.push({ id: pick.id, isNew:true });
    const idx = tempPool.findIndex(x=>x.id===pick.id);
    if(idx!==-1) tempPool.splice(idx,1);
  }

  const getCap = (skillId) => SKILL_LEVEL_CAP[skillId] || MAX_SKILL_LEVEL;

  const upgradeCandidates = (gameState.unlockedSkills || [])
    .filter(u => {
      const cap = getCap(u.id);
      return (u.level || 1) < cap;
    })
    .map(u => ({ id: u.id, level: u.level, isUpgrade:true }));

  while(picks.length < 3 && upgradeCandidates.length > 0){
    const u = upgradeCandidates.shift();
    picks.push({ id: u.id, isUpgrade:true });
  }

  if(picks.length < 3){
    const remainingNotUnlocked = SKILL_POOL.filter(s => !picks.some(p=>p.id===s.id));
    for(const s of remainingNotUnlocked){
      if(picks.length >= 3) break;
      if(!unlockedIds.includes(s.id)) picks.push({ id: s.id, isNew:true });
    }
  }

  if(picks.length === 0){
    const baseRewards = generateBaseStatRewards();
    showBaseRewardSelection(baseRewards);
    return;
  }

  skillSelectArea.innerHTML = '';
  messageArea.textContent = '報酬スキルを1つ選んでください（永久アンロック / アップグレード）';
  const wrap = document.createElement('div'); wrap.className = 'skill-choices';

  picks.forEach(p => {
    const def = SKILL_POOL.find(s=>s.id===p.id);
    if(!def) return;
    const unlockedObj = gameState.unlockedSkills.find(u=>u.id===p.id);
    const label = p.isUpgrade ? `${def.name} を上昇 (現在 Lv${unlockedObj ? unlockedObj.level : 0})` : `${def.name} をアンロック`;
    const btn = document.createElement('button');
    btn.className = 'skill-btn node-btn';
    btn.classList.add('rarity-' + (def.rarity || 'common'));
    btn.innerHTML = `<div style="font-weight:700">${label}</div><small style="opacity:.9">${def.baseDesc}</small><div style="font-size:11px;opacity:.85;margin-top:6px">${(def.rarity||'common').toUpperCase()}</div>`;
    btn.onclick = () => {
      playSE('click', 0.5);
      if(p.isUpgrade && unlockedObj){
        const cap = getCap(def.id);
        unlockedObj.level = Math.min(cap, (unlockedObj.level || 1) + 1);
        messageArea.textContent = `${def.name} を Lv${unlockedObj.level} に強化しました`;
      } else {
        const cap = getCap(def.id);
        if(unlockedObj){
          unlockedObj.level = Math.min(cap, (unlockedObj.level || 1) + 1);
          messageArea.textContent = `${def.name} を Lv${unlockedObj.level} に強化しました`;
        } else {
          gameState.unlockedSkills.push({ id: def.id, level: 1 });
          messageArea.textContent = `${def.name} をアンロックしました！`;
        }
      }
      saveUnlocked();
      skillSelectArea.innerHTML = '';
      flashScreen(.14);
      setTimeout(()=> {
        gameState.stage++;
        startBattle();
      }, 700);
    };
    wrap.appendChild(btn);
  });

  skillSelectArea.appendChild(wrap);
}

/* ---------- boss reward selection (baseStats +1) ---------- */
function showBossRewardSelection(){
  gameState.inBossReward = true;
  gameState.playerTurn = false;

  skillSelectArea.innerHTML = '';
  messageArea.textContent = 'ボス報酬を1つ選んでください（ラン内で恒久）';

  const wrap = document.createElement('div');
  wrap.className = 'skill-choices';

  const options = [
    { key:'playerThreshold', label:`指の閾値 +1 （現在 ${gameState.baseStats.playerThreshold}）` },
    { key:'baseAttack', label:`基礎攻撃力 +1 （現在 ${gameState.baseStats.baseAttack}）` },
    { key:'baseDefense', label:`基礎防御力 +1 （現在 ${gameState.baseStats.baseDefense}）` }
  ];

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'node-btn current';
    btn.textContent = opt.label;
    btn.onclick = () => {
      playSE('click', 0.6);
      if(opt.key === 'playerThreshold'){
        const cur = Number(gameState.baseStats.playerThreshold);
        gameState.baseStats.playerThreshold = Number.isFinite(cur) ? (cur + 1) : 6;
      } else {
        gameState.baseStats[opt.key] = (gameState.baseStats[opt.key] || 0) + 1;
      }
      messageArea.textContent = `${opt.label} を獲得しました`;
      // clear boss temporary effects
      gameState.bossEnemyThresholdMultiplier = 1;
      gameState.bossAbility = null;
      gameState.enemyHasThirdHand = false;
      updateUI();
      gameState.inBossReward = false;
      skillSelectArea.innerHTML = '';
      flashScreen(.18);
      setTimeout(()=> {
        gameState.stage++;
        startBattle();
      }, 700);
    };
    wrap.appendChild(btn);
  });

  skillSelectArea.appendChild(wrap);
}

/* ---------- Hover overlay helpers already defined above ---------- */

/* ---------- start ---------- */
initGame();
engine.startBattle({ stage: gameState.stage, isBoss: gameState.isBoss });

/* expose for debugging */
window.__FD = {
  state: gameState,
  engine,
  saveUnlocked,
  loadUnlocked,
  SKILL_POOL,
  getUnlockedLevel,
  commitEquips: ()=>commitEquips(),
  renderEquipped,
  renderUnlockedList,
  assignEnemySkills,
  showBossRewardSelection,
  updateUI,
  debug_getDestroyThreshold: getDestroyThreshold
};
