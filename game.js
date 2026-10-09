/* ============================================================================
 * STRIKE PROTOCOL  3D First-Person Shooter (wave survival)
 * Pure HTML / CSS / JS + Three.js (UMD build from CDN)
 *
 * Architecture
 *   Config .............. global tuning constants
 *   Rnd / clamp .......... helpers
 *   AudioManager ......... procedural Web Audio SFX (no external files)
 *   InputManager ......... keyboard / mouse / pointer-lock
 *   CollisionSystem ...... AABB world, swept move+resolve, ray vs AABB
 *   ParticleSystem ....... pooled GPU particles (single draw call)
 *   TracerSystem ......... pooled bullet tracers (single draw call)
 *   Map ................. arena geometry + collision volumes + spawn points
 *   Weapon ............... weapon definitions, fire, reload, view model
 *   Player ............... movement, stamina, health, camera, view model
 *   Enemy / EnemyAI ..... 3 types, idle->chase->attack->die, hit reaction
 *   WaveManager .......... 5 / 8 / 12 ... scaling waves + intermission
 *   UIManager ............ HUD, menus, damage numbers, indicators
 *   Game ................ renderer, lights, update loop, state machine
 * ==========================================================================*/

(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    document.body.innerHTML =
      '<div style="color:#fff;font:16px monospace;padding:40px">' +
      'Failed to load Three.js from CDN. Connect to the internet and reload.</div>';
    return;
  }

  /* ---------------------------------------------------------------- CONFIG */

  const CFG = {
    gravity: 24,
    fov: 75,
    dashSpeed: 27,
    dashTime: 0.18,
    dashCooldown: 1.2,
    leanDistance: 0.62,
    leanMaxRoll: 0.19,
    pickupRange: 2.8,
    adsSensScale: 0.62,
    playerHeight: 1.78,
    playerRadius: 0.42,
    eyeHeight: 1.62,
    stepHeight: 0.46,
    moveSpeed: 5.4,
    sprintMul: 1.62,
    accelGround: 62,
    accelAir: 12,
    friction: 9.5,
    jumpSpeed: 6.6,
    maxHealth: 100,
    staminaMax: 100,
    staminaDrain: 22,
    staminaRegen: 17,
    staminaRegenDelay: 0.9,
    arenaHalf: 32,
    maxAlive: 9,
    spawnInterval: 0.85,
    intermission: 6.0,
    maxParticles: 900,
    maxTracers: 160
  };

  /* -------------------------------------------------------------- HELPERS */

  const clamp = (v, a, b) => {
    if (v !== v) return a;                 // NaN in, safe bound out
    return v < a ? a : v > b ? b : v;
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  /** frame-rate independent smoothing factor */
  const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  /* ============================================================== AUDIO */

  class AudioManager {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.noise = null;
      this.enabled = true;
    }

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);

        // 1s of white noise reused by every noise-based effect
        const len = this.ctx.sampleRate;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      } catch (err) {
        // audio is optional: a blocked/failed context must never stop the game
        this.ctx = null;
        this.enabled = false;
      }
    }

    get t() { return this.ctx ? this.ctx.currentTime : 0; }

    noiseSrc(playbackRate, dur) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.playbackRate.value = playbackRate;
      s.start(this.t);
      s.stop(this.t + dur + 0.05);
      return s;
    }

    env(gain, t0, peak, attack, decay) {
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }

    /* --- weapon fire --------------------------------------------------- */
    shoot(kind) {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      const rifle = kind === 'rifle';
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(rifle ? 1800 : 900, t0);
      f.frequency.exponentialRampToValueAtTime(rifle ? 380 : 160, t0 + (rifle ? 0.16 : 0.28));
      f.Q.value = 0.7;
      const src = this.noiseSrc(rifle ? 1.0 : 0.65, rifle ? 0.2 : 0.34);
      this.env(g, t0, rifle ? 0.55 : 0.8, 0.005, rifle ? 0.15 : 0.3);
      src.connect(f); f.connect(g); g.connect(this.master);

      // low thump body
      const o = this.ctx.createOscillator();
      const og = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(rifle ? 190 : 130, t0);
      o.frequency.exponentialRampToValueAtTime(48, t0 + 0.11);
      this.env(og, t0, rifle ? 0.32 : 0.5, 0.004, 0.11);
      o.connect(og); og.connect(this.master);
      o.start(t0); o.stop(t0 + 0.2);

      // mechanical click
      this.click(t0 + 0.005, 0.12, 2600);
    }

    click(at, vol, freq) {
      if (!this.ctx || !this.enabled) return;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
      const src = this.noiseSrc(1.6, 0.05);
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = freq;
      src.connect(f); f.connect(g); g.connect(this.master);
    }

    dryFire() {
      if (!this.ctx || !this.enabled) return;
      this.click(this.t, 0.22, 3200);
    }

    land() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 420;
      const src = this.noiseSrc(0.5, 0.1);
      this.env(g, t0, 0.18, 0.004, 0.09);
      src.connect(f); f.connect(g); g.connect(this.master);
    }

    reload(stage) {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      if (stage === 'out') { this.click(t0, 0.3, 900); this.tone(t0 + 0.02, 0.16, 180, 90, 0.09, 'square'); }
      else if (stage === 'in') { this.click(t0, 0.34, 700); this.tone(t0 + 0.02, 0.2, 140, 70, 0.1, 'square'); }
      else { this.click(t0, 0.3, 1600); this.tone(t0 + 0.01, 0.14, 420, 260, 0.12, 'square'); }
    }

    tone(at, vol, f0, f1, dur, type) {
      if (!this.ctx || !this.enabled) return;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
      g.gain.setValueAtTime(vol, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(this.master);
      o.start(at); o.stop(at + dur + 0.02);
    }

    hit(head) {
      if (!this.ctx || !this.enabled) return;
      this.tone(this.t, 0.28, head ? 1500 : 900, head ? 700 : 420, 0.07, 'square');
      this.click(this.t, 0.18, 2500);
    }

    impact() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2400;
      const src = this.noiseSrc(1.4, 0.08);
      this.env(g, t0, 0.16, 0.003, 0.07);
      src.connect(f); f.connect(g); g.connect(this.master);
    }

    enemyDeath() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      this.tone(t0, 0.35, 320, 60, 0.42, 'sawtooth');
      this.tone(t0 + 0.05, 0.22, 180, 40, 0.5, 'sine');
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(1600, t0);
      f.frequency.exponentialRampToValueAtTime(200, t0 + 0.4);
      const src = this.noiseSrc(0.8, 0.42);
      this.env(g, t0, 0.3, 0.01, 0.4);
      src.connect(f); f.connect(g); g.connect(this.master);
    }

    enemyShoot() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(700, t0);
      f.frequency.exponentialRampToValueAtTime(200, t0 + 0.14);
      const src = this.noiseSrc(1.1, 0.16);
      this.env(g, t0, 0.3, 0.004, 0.13);
      src.connect(f); f.connect(g); g.connect(this.master);
    }

    playerHurt(pan = 0) {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      let dest = this.master;
      if (typeof this.ctx.createStereoPanner === 'function' && typeof pan === 'number' && Number.isFinite(pan)) {
        try {
          const panner = this.ctx.createStereoPanner();
          panner.pan.value = Math.max(-0.75, Math.min(0.75, pan));
          panner.connect(this.master);
          dest = panner;
        } catch (_) {}
      }
      this.tone(t0, 0.4, 220, 60, 0.3, 'sine');
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      const src = this.noiseSrc(0.5, 0.18);
      this.env(g, t0, 0.34, 0.004, 0.18);
      src.connect(f); f.connect(g); g.connect(dest);
    }

    waveStart(n) {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      this.tone(t0, 0.3, 180, 360, 0.3, 'sawtooth');
      this.tone(t0 + 0.18, 0.32, 240, 480, 0.4, 'sawtooth');
    }

    waveCleared() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => this.tone(t0 + i * 0.11, 0.22, f, f, 0.22, 'triangle'));
    }

    playerDeath() {
      if (!this.ctx || !this.enabled) return;
      const t0 = this.t;
      this.tone(t0, 0.5, 320, 40, 1.1, 'sawtooth');
      const g = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2200, t0);
      f.frequency.exponentialRampToValueAtTime(120, t0 + 0.9);
      const src = this.noiseSrc(0.45, 0.9);
      this.env(g, t0, 0.4, 0.02, 0.85);
      src.connect(f); f.connect(g); g.connect(this.master);
    }
  }

  /* ============================================================== INPUT */

  class InputManager {
    constructor(canvas) {
      this.canvas = canvas;
      this.keys = Object.create(null);
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.buttons = [false, false, false];
      this.locked = false;
      this.sensitivity = 0.0022;
      this.pressed = Object.create(null);   // edge-triggered this frame
      this.onLockChange = null;
      this.onEscape = null;
      this._bind();
    }

    _bind() {
      window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const c = e.code;
        if (c === 'Space' || c.indexOf('Arrow') === 0 || c === 'Tab') e.preventDefault();
        this.keys[c] = true;
        this.pressed[c] = true;
        if (c === 'Escape' && this.onEscape) this.onEscape();
        if (c === 'Tab' && this.onTab) { e.preventDefault(); this.onTab(); }
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      window.addEventListener('blur', () => { this.keys = Object.create(null); this.buttons = [false, false, false]; });

      document.addEventListener('mousemove', (e) => {
        if (!this.locked) return;
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      });
      document.addEventListener('mousedown', (e) => {
        if (e.button < 3) this.buttons[e.button] = true;
      });
      document.addEventListener('mouseup', (e) => { if (e.button < 3) this.buttons[e.button] = false; });
      document.addEventListener('contextmenu', (e) => e.preventDefault());

      document.addEventListener('pointerlockchange', () => {
        this.locked = document.pointerLockElement === this.canvas;
        if (!this.locked) { this.buttons = [false, false, false]; this.keys = Object.create(null); }
        if (this.onLockChange) this.onLockChange(this.locked);
      });
      document.addEventListener('pointerlockerror', () => { this.locked = false; });
    }

    requestLock() {
      if (this.locked || !this.canvas.requestPointerLock) return;
      try {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      } catch (err) {
        // pointer lock can be refused (no user gesture, iframe policy, )
        // the game stays playable with free-look via the mouse-over-canvas path
      }
    }
    releaseLock() { if (document.exitPointerLock) document.exitPointerLock(); }

    down(code) { return !!this.keys[code]; }
    hit(code) { return !!this.pressed[code]; }
    consumeMouse() {
      const dx = this.mouseDX, dy = this.mouseDY;
      this.mouseDX = 0; this.mouseDY = 0;
      return { dx, dy };
    }
    endFrame() { this.pressed = Object.create(null); this.mouseDX = 0; this.mouseDY = 0; }
  }

  /* ========================================================= COLLISION */

  const _tmpV = new THREE.Vector3();

  class Box {
    constructor(minX, minY, minZ, maxX, maxY, maxZ, tag, owner) {
      this.min = new THREE.Vector3(minX, minY, minZ);
      this.max = new THREE.Vector3(maxX, maxY, maxZ);
      this.tag = tag || 'solid';
      // dynamic hitboxes are registered as colliders so bodies push each other,
      // but an entity must never collide with its own boxes
      this.owner = owner || null;
    }
  }

  class CollisionSystem {
    constructor() { this.boxes = []; this.dynamic = []; }
    addBox(b) { this.boxes.push(b); return b; }
    addDynamic(b) { this.dynamic.push(b); }
    removeDynamic(b) { const i = this.dynamic.indexOf(b); if (i >= 0) this.dynamic.splice(i, 1); }
    clearDynamic() { this.dynamic.length = 0; }

    /** all colliders = static + alive dynamic */
    forEach(fn) {
      const s = this.boxes, d = this.dynamic;
      for (let i = 0; i < s.length; i++) fn(s[i]);
      for (let i = 0; i < d.length; i++) fn(d[i]);
    }

    /** AABB overlap test for a vertical cylinder-ish entity (feet pos + radius/height) */
    overlapAt(pos, radius, height, out, self) {
      const minY = pos.y, maxY = pos.y + height;
      let hit = null;
      this.forEach((b) => {
        if (b.owner && b.owner === self) return;
        if (b.max.y <= minY + 0.02 || b.min.y >= maxY - 0.02) return;
        if (b.min.x >= pos.x + radius || b.max.x <= pos.x - radius) return;
        if (b.min.z >= pos.z + radius || b.max.z <= pos.z - radius) return;
        if (!hit) hit = b;
        if (out) out.push(b);
      });
      return hit;
    }

    /**
     * Move an entity along one axis with resolution.
     * stepUp: when blocked horizontally, try lifting the entity onto low ledges.
     * Returns collision flags { hitX, hitY, hitZ, ground, ceiling }
     */
    moveEntity(ent, dx, dy, dz, stepUp) {
      const res = { hitX: false, hitY: false, hitZ: false, ground: false, ceiling: false };
      // a non-finite delta would corrupt the body for every frame afterwards
      if (!isFinite(dx)) dx = 0;
      if (!isFinite(dy)) dy = 0;
      if (!isFinite(dz)) dz = 0;
      const r = ent.radius, h = ent.height, p = ent.position;

      // ---- horizontal, one axis at a time (allows sliding along walls) ----
      for (let a = 0; a < 2; a++) {
        const ax = (a === 0 ? 'x' : 'z');
        const delta = (ax === 'x' ? dx : dz);
        if (delta === 0) continue;
        const sub = Math.max(1, Math.ceil(Math.abs(delta) / 0.18));
        const inc = delta / sub;
        for (let s = 0; s < sub; s++) {
          p[ax] += inc;
          const b = this._firstOverlap(p, r, h, ent);
          if (!b) continue;
          // try step-up on low obstacles
          if (stepUp > 0 && b.max.y - p.y > 0.01 && b.max.y - p.y <= stepUp + 0.03) {
            const savedX = p.x, savedY = p.y, savedZ = p.z;
            p.y = b.max.y + 0.002;
            if (!this._firstOverlap(p, r, h, ent)) continue;   // stepped up cleanly
            p.set(savedX, savedY, savedZ);
          }
          // resolve: push out of the box along this axis
          if (delta > 0) p[ax] = b.min[ax] - r - 0.001;
          else p[ax] = b.max[ax] + r + 0.001;
          if (ax === 'x') res.hitX = true; else res.hitZ = true;
        }
      }

      // ---- vertical ----
      // Only world geometry supports weight. Dynamic hitboxes are used to push
      // bodies apart horizontally; if they could also act as ground, enemies
      // converging on the player would stack into a tower.
      if (dy !== 0) {
        const yBefore = p.y;
        p.y += dy;
        const b = this._firstOverlap(p, r, h, ent, true, true);
        if (b) {
          if (dy < 0) {
            // Land only when the feet actually crossed the top of the box.
            // If the entity is buried deep inside it, snapping to box.max.y
            // would teleport it on top of the box (enemies climbing pillars).
            if (b.max.y - yBefore <= 1.0) { p.y = b.max.y; res.ground = true; }
          } else if (yBefore + h <= b.min.y + 0.02) {
            p.y = b.min.y - h - 0.001;
            res.ceiling = true;
          }
          res.hitY = true;
        }
      }
      return res;
    }

    /**
     * First box overlapping the entity volume.
     * `vertical` (used for the vertical pass) uses a strict test so the feet
     * never sink into the floor; the horizontal pass keeps a small tolerance so
     * the surface you are standing on is not treated as a wall.
     */
    _firstOverlap(p, r, h, self, vertical, staticOnly) {
      let found = null;
      const tol = vertical ? 0 : 0.02;
      const minY = p.y, maxY = p.y + h;
      this.forEach((b) => {
        if (found) return;
        if (b.owner && b.owner === self) return;
        if (staticOnly && b.owner) return;
        if (b.max.y < minY + tol || b.min.y > maxY - tol) return;
        if (b.min.x >= p.x + r || b.max.x <= p.x - r) return;
        if (b.min.z >= p.z + r || b.max.z <= p.z - r) return;
        found = b;
      });
      return found;
    }

    /**
     * Ray vs static world. Returns distance to hit or Infinity.
     * Boxes with tag 'nopierce' (glass-ish decor) are ignored.
     */
    rayWorld(origin, dir, maxDist) {
      let best = maxDist;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.noPierce) continue;
        const t = rayAABB(origin, dir, b.min, b.max, best);
        if (t < best) best = t;
      }
      return best;
    }

    /** true if nothing solid blocks the segment a->b */
    hasLineOfSight(a, b) {
      _tmpV.subVectors(b, a);
      const dist = _tmpV.length();
      if (dist < 0.001) return true;
      _tmpV.multiplyScalar(1 / dist);
      return this.rayWorld(a, _tmpV, dist) >= dist - 0.05;
    }

    /**
     * Lift an entity out of static geometry it was placed inside (spawn safety).
     * Returns true when the position had to be corrected.
     */
    liftOut(pos, radius, height) {
      let top = null;
      this.forEach((b) => {
        if (b.owner) return;                                  // dynamic hitboxes don't block
        if (b.min.x >= pos.x + radius || b.max.x <= pos.x - radius) return;
        if (b.min.z >= pos.z + radius || b.max.z <= pos.z - radius) return;
        if (b.min.y >= pos.y + height - 0.05 || b.max.y <= pos.y) return;
        if (top === null || b.max.y > top) top = b.max.y;
      });
      if (top !== null) { pos.y = top + 0.01; return true; }
      return false;
    }
  }

  /** Slab-method ray/AABB intersection. Returns t along dir, or Infinity. */
  function rayAABB(origin, dir, min, max, maxDist) {
    let tmin = 0, tmax = maxDist;
    // X
    if (Math.abs(dir.x) < 1e-8) {
      if (origin.x < min.x || origin.x > max.x) return Infinity;
    } else {
      const inv = 1 / dir.x;
      let t1 = (min.x - origin.x) * inv, t2 = (max.x - origin.x) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    // Y
    if (Math.abs(dir.y) < 1e-8) {
      if (origin.y < min.y || origin.y > max.y) return Infinity;
    } else {
      const inv = 1 / dir.y;
      let t1 = (min.y - origin.y) * inv, t2 = (max.y - origin.y) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    // Z
    if (Math.abs(dir.z) < 1e-8) {
      if (origin.z < min.z || origin.z > max.z) return Infinity;
    } else {
      const inv = 1 / dir.z;
      let t1 = (min.z - origin.z) * inv, t2 = (max.z - origin.z) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    return tmin;
  }

  /* ======================================================== PARTICLES */

  class ParticleSystem {
    constructor(scene) {
      const max = CFG.maxParticles;
      this.max = max;
      this.count = 0;
      this.pos = new Float32Array(max * 3);
      this.col = new Float32Array(max * 3);
      this.size = new Float32Array(max);
      this.alpha = new Float32Array(max);
      this.vel = new Float32Array(max * 3);
      this.life = new Float32Array(max);
      this.maxLife = new Float32Array(max);
      this.grav = new Float32Array(max);
      this.drag = new Float32Array(max);
      this.active = new Uint8Array(max);
      this.cursor = 0;
      this.liveCount = 0;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
      geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
      geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1));
      geo.setDrawRange(0, 0);

      const mat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: 620 } },
        vertexShader: [
          'attribute vec3 pcolor;',
          'attribute float psize;',
          'attribute float palpha;',
          'varying vec3 vColor;',
          'varying float vAlpha;',
          'uniform float uScale;',
          'void main() {',
          '  vColor = pcolor; vAlpha = palpha;',
          '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
          '  gl_PointSize = max(1.0, psize * (uScale / max(0.1, -mv.z)));',
          '  gl_Position = projectionMatrix * mv;',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec3 vColor;',
          'varying float vAlpha;',
          'void main() {',
          '  vec2 d = gl_PointCoord - vec2(0.5);',
          '  if (dot(d, d) > 0.25) discard;',
          '  gl_FragColor = vec4(vColor, vAlpha);',
          '}'
        ].join('\n'),
        transparent: true,
        depthWrite: false
      });

      this.points = new THREE.Points(geo, mat);
      this.points.frustumCulled = false;
      this.points.renderOrder = 5;
      scene.add(this.points);
      this.geo = geo;
    }

    spawn(x, y, z, vx, vy, vz, life, size, r, g, b, grav, drag) {
      let i = -1;
      for (let k = 0; k < this.max; k++) {
        const c = (this.cursor + k) % this.max;
        if (!this.active[c]) { i = c; break; }
      }
      if (i < 0) { i = this.cursor; }
      this.cursor = (i + 1) % this.max;
      this.active[i] = 1;
      const i3 = i * 3;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
      this.size[i] = size;
      this.alpha[i] = 1;
      this.life[i] = life;
      this.maxLife[i] = life;
      this.grav[i] = grav;
      this.drag[i] = drag;
      return i;
    }

    burst(n, x, y, z, opt) {
      const spread = opt.spread || 3;
      const up = opt.up || 2;
      for (let k = 0; k < n; k++) {
        this.spawn(
          x, y, z,
          rand(-spread, spread), rand(-0.4, up), rand(-spread, spread),
          rand(opt.lifeMin, opt.lifeMax),
          rand(opt.sizeMin, opt.sizeMax),
          opt.color[0], opt.color[1], opt.color[2],
          opt.grav === undefined ? 9 : opt.grav,
          opt.drag === undefined ? 1.5 : opt.drag
        );
      }
    }

    update(dt) {
      let live = 0;
      for (let i = 0; i < this.max; i++) {
        if (!this.active[i]) { this.alpha[i] = 0; continue; }
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.active[i] = 0; this.alpha[i] = 0; continue; }
        live++;
        const i3 = i * 3;
        const dr = Math.max(0, 1 - this.drag[i] * dt);
        this.vel[i3] *= dr;
        this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt;
        this.vel[i3 + 2] *= dr;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (this.pos[i3 + 1] < 0.02) {           // cheap floor bounce
          this.pos[i3 + 1] = 0.02;
          this.vel[i3 + 1] *= -0.28;
        }
        const t = this.life[i] / this.maxLife[i];
        this.alpha[i] = t > 0.75 ? (1 - t) * 4 : t / 0.75;
      }
      this.liveCount = live;
      this.geo.setDrawRange(0, this.max);
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.pcolor.needsUpdate = true;
      this.geo.attributes.psize.needsUpdate = true;
      this.geo.attributes.palpha.needsUpdate = true;
    }

    clear() {
      this.active.fill(0);
      this.alpha.fill(0);
      this.liveCount = 0;
      this.geo.setDrawRange(0, this.max);
      this.geo.attributes.palpha.needsUpdate = true;
    }
  }

  /* ========================================================== TRACERS */

  class TracerSystem {
    constructor(scene) {
      const max = CFG.maxTracers;
      this.max = max;
      this.pos = new Float32Array(max * 6);
      this.col = new Float32Array(max * 6);
      this.life = new Float32Array(max);
      this.maxLife = new Float32Array(max);
      this.base = new Float32Array(max * 6);
      this.cursor = 0;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      this.mesh = new THREE.LineSegments(geo, mat);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 6;
      scene.add(this.mesh);
      this.geo = geo;
      this.clear();
    }

    add(a, b, r, g, bl, life) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const o = i * 6;
      this.pos[o] = a.x; this.pos[o + 1] = a.y; this.pos[o + 2] = a.z;
      this.pos[o + 3] = b.x; this.pos[o + 4] = b.y; this.pos[o + 5] = b.z;
      for (let k = 0; k < 6; k++) this.base[o + k] = this.pos[o + k];
      this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = bl;
      this.col[o + 3] = r * 0.6; this.col[o + 4] = g * 0.6; this.col[o + 5] = bl * 0.6;
      this.life[i] = life;
      this.maxLife[i] = life;
    }

    update(dt) {
      let any = false;
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) continue;
        any = true;
        this.life[i] -= dt;
        const o = i * 6;
        if (this.life[i] <= 0) {
          for (let k = 0; k < 6; k++) this.pos[o + k] = 0;
          this.col[o] = this.col[o + 1] = this.col[o + 2] = 0;
          this.col[o + 3] = this.col[o + 4] = this.col[o + 5] = 0;
          continue;
        }
        const f = this.life[i] / this.maxLife[i];
        // slight shrink toward the impact end
        const cx = this.base[o], cy = this.base[o + 1], cz = this.base[o + 2];
        const ex = lerp(this.base[o], this.base[o + 3], 0.85 * (1 - f));
        const ey = lerp(this.base[o + 1], this.base[o + 4], 0.85 * (1 - f));
        const ez = lerp(this.base[o + 2], this.base[o + 5], 0.85 * (1 - f));
        this.pos[o] = cx; this.pos[o + 1] = cy; this.pos[o + 2] = cz;
        this.pos[o + 3] = ex; this.pos[o + 4] = ey; this.pos[o + 5] = ez;
        this.col[o] = 0.4 * f; this.col[o + 1] = 0.9 * f; this.col[o + 2] = 1.4 * f;
        this.col[o + 3] = 0.2 * f; this.col[o + 4] = 0.4 * f; this.col[o + 5] = 0.7 * f;
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.geo.setDrawRange(0, any ? this.max * 2 : 0);
    }

    clear() {
      this.life.fill(0);
      this.pos.fill(0);
      this.col.fill(0);
      this.base.fill(0);
      this.cursor = 0;
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }

  /* ================================================================ MAP */

  function makeGridTexture() {
    const s = 256;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.fillStyle = '#2c3138';
    g.fillRect(0, 0, s, s);
    // subtle noise patches
    for (let i = 0; i < 240; i++) {
      g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.035).toFixed(3) + ')';
      g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 26, 2 + Math.random() * 26);
    }
    g.strokeStyle = '#1d2228';
    g.lineWidth = 3;
    g.strokeRect(0, 0, s, s);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(s / 2, 0); g.lineTo(s / 2, s);
    g.moveTo(0, s / 2); g.lineTo(s, s / 2);
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 16);
    return tex;
  }

  function makePanelTexture(base, stripe) {
    const w = 128, h = 128;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 140; i++) {
      g.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.12).toFixed(3) + ')';
      g.fillRect(Math.random() * w, Math.random() * h, 3 + Math.random() * 20, 2 + Math.random() * 8);
    }
    g.fillStyle = stripe;
    for (let i = 0; i < 8; i++) g.fillRect(0, i * 16 + 4, w, 5);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 4;
    g.strokeRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /* ================================================================ MAP */

  /* deterministic RNG so a given stage always builds the same layout */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* shared geometry / material cache: built once, reused by every layout */
  const GEO = Object.create(null);
  const MAT = Object.create(null);
  function shared(obj, key, make) {
    if (!obj[key]) obj[key] = make();
    return obj[key];
  }
  const boxGeo = (w, h, d) => shared(GEO, 'b' + w + '_' + h + '_' + d, () => new THREE.BoxGeometry(w, h, d));
  const cylGeo = (rt, rb, h, s) => shared(GEO, 'c' + rt + '_' + rb + '_' + h + '_' + (s || 10),
    () => new THREE.CylinderGeometry(rt, rb, h, s || 10));
  const lamMat = (key, opts) => shared(MAT, key, () => new THREE.MeshLambertMaterial(opts));

  function arenaMaterials() {
    return {
      floor: lamMat('floor', { map: makeGridTexture() }),
      concrete: lamMat('concrete', { color: 0x6b7280 }),
      concreteDark: lamMat('concreteDark', { color: 0x4a525e }),
      wall: lamMat('wall', { color: 0x39424e }),
      wallTrim: lamMat('wallTrim', { color: 0x232a33 }),
      crate: lamMat('crate', { color: 0x8a6a3c }),
      crateDark: lamMat('crateDark', { color: 0x6b5230 }),
      wood: lamMat('wood', { color: 0x7d5a34 }),
      metal: lamMat('metal', { color: 0x707a86 }),
      metalDark: lamMat('metalDark', { color: 0x3d454f }),
      rust: lamMat('rust', { color: 0x7a4a2c }),
      barrelRed: lamMat('barrelRed', { color: 0x9c3b2e }),
      barrelBlue: lamMat('barrelBlue', { color: 0x2f5d8f }),
      barrelGreen: lamMat('barrelGreen', { color: 0x3f6b3a }),
      container: lamMat('container', { map: makePanelTexture('#8a4a2b', 'rgba(0,0,0,0.16)') }),
      containerBlue: lamMat('containerBlue', { map: makePanelTexture('#46586a', 'rgba(255,255,255,0.05)') }),
      hazard: lamMat('hazard', { color: 0xd8a326 }),
      dark: lamMat('dark', { color: 0x1b212a }),
      accent: new THREE.MeshBasicMaterial({ color: 0x2fa8ff }),
      lampOn: new THREE.MeshBasicMaterial({ color: 0xffdcae }),
      rebar: lamMat('rebar', { color: 0x55504a }),
      debris: lamMat('debris', { color: 0x5c6470 })
    };
  }

  /* ================================================================ ARENA
   * Multi-zone combat arenas. Five predefined layouts; each stage picks one.
   * Every prop is built from several primitives (never a lone cube) and owns
   * its own colliders, so cover stays consistent across layouts.
   * ==================================================================== */

  class Arena {
    constructor(scene, collision, game) {
      this.scene = scene;
      this.collision = collision;
      this.game = game || null;
      this.group = new THREE.Group();
      scene.add(this.group);

      this.spawnPoints = [];
      this.lootSpots = [];
      this.lamps = [];
      this.animated = [];
      this.mat = arenaMaterials();
      this.layoutIndex = -1;
      this.layoutName = '';
      this.mood = 'normal';
      this._t = 0;
      this.rng = Math.random;

      this._buildSky();
      this.applyLayout(0, 1);
    }

    /* ------------------------------------------------------------------ */
    /* geometry helpers                                                   */
    /* ------------------------------------------------------------------ */

    /** axis-aligned solid; ry in {0,90,180,270} is supported for the collider */
    solid(sx, sy, sz, x, y, z, material, opts) {
      const o = opts || {};
      const mesh = new THREE.Mesh(boxGeo(sx, sy, sz), material);
      mesh.position.set(x, y, z);
      if (o.ry) mesh.rotation.y = o.ry * Math.PI / 180;
      mesh.receiveShadow = true;
      if (o.cast) mesh.castShadow = true;
      this.group.add(mesh);
      if (o.collide !== false) {
        const ry = ((o.ry || 0) % 180 + 180) % 180;
        const half = ry === 90 ? [sz / 2, sx / 2] : [sx / 2, sz / 2];
        this.collision.addBox(new Box(
          x - half[0], y - sy / 2, z - half[1],
          x + half[0], y + sy / 2, z + half[1], o.tag
        ));
      }
      return mesh;
    }

    /** non-colliding detail mesh */
    detail(sx, sy, sz, x, y, z, material, ry) {
      const mesh = new THREE.Mesh(boxGeo(sx, sy, sz), material);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry * Math.PI / 180;
      this.group.add(mesh);
      return mesh;
    }

    detailCyl(rt, rb, h, x, y, z, material, seg) {
      const mesh = new THREE.Mesh(cylGeo(rt, rb, h, seg || 10), material);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      return mesh;
    }

    /* ------------------------------------------------------------------ */
    /* props                                                               */
    /* ------------------------------------------------------------------ */

    /** crate: body + 4 corner braces + lid rim + cross brace */
    crate(x, z, s, ry, dark) {
      const body = dark ? this.mat.crateDark : this.mat.crate;
      const m = this.mat.metalDark;
      this.solid(s, s, s, x, s / 2, z, body, { cast: true, ry: ry, tag: 'crate' });
      const t = s * 0.09;
      for (let i = 0; i < 4; i++) {
        const a = (i * 90 + (ry || 0)) * Math.PI / 180;
        const dx = Math.cos(a) * s / 2, dz = Math.sin(a) * s / 2;
        this.detail(t * 2, s + 0.02, t * 2, x + dx, s / 2, z + dz, m, ry);
      }
      this.detail(s * 1.02, t, s * 1.02, x, s - t / 2, z, m, ry);          // lid rim
      this.detail(s * 1.02, t * 0.7, s * 0.22, x, s * 0.55, z, m, ry);   // cross brace
    }

    /** stack of 2-3 crates with small offsets */
    crateStack(x, z, ry, rng) {
      const n = 2 + ((rng() * 2) | 0);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const s = 1.7 + rng() * 0.5;
        this.crate(x + (rng() - 0.5) * 0.35, z + (rng() - 0.5) * 0.35, s, (ry || 0) + i * 15, i % 2 === 1);
        y += s;
      }
      return y;
    }

    /** barrel: cylinder + 2 hoops + top/bottom rims + lid */
    barrel(x, z, matKey) {
      const m = matKey ? this.mat[matKey] : this.mat.rust;
      const r = 0.42, h = 1.15;
      this.detailCyl(r, r, h, x, h / 2, z, m, 12);
      this.detailCyl(r * 1.06, r * 1.06, 0.09, x, h * 0.34, z, this.mat.metalDark, 12);
      this.detailCyl(r * 1.06, r * 1.06, 0.09, x, h * 0.68, z, this.mat.metalDark, 12);
      this.detailCyl(r * 0.96, r * 0.96, 0.06, x, h + 0.02, z, this.mat.metal, 12);   // lid
      this.detail(0.12, 0.05, 0.12, x, h + 0.06, z, this.mat.dark);
      this.collision.addBox(new Box(x - r * 0.85, 0, z - r * 0.85, x + r * 0.85, h, z + r * 0.85, 'barrel'));
    }

    barrelCluster(x, z, rng) {
      const n = 3 + ((rng() * 3) | 0);
      const keys = ['barrelRed', 'barrelBlue', 'barrelGreen', 'rust'];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng();
        this.barrel(x + Math.cos(a) * 0.55, z + Math.sin(a) * 0.55, keys[(rng() * keys.length) | 0]);
      }
      this.barrel(x, z, keys[(rng() * keys.length) | 0]);
    }

    /** shipping container: body + door end + ribs + corner posts + roof edge */
    container(x, z, ry, blue) {
      const L = 12.5, H = 2.7, D = 3.1;
      const body = blue ? this.mat.containerBlue : this.mat.container;
      const post = this.mat.metalDark;
      this.solid(L, H, D, x, H / 2, z, body, { cast: true, ry: ry, tag: 'container' });
      // vertical ribs along both long sides
      for (let i = 0; i <= 8; i++) {
        const px = -L / 2 + (L / 8) * i;
        const ox = Math.cos(ry * Math.PI / 180) * px, oz = -Math.sin(ry * Math.PI / 180) * px;
        this.detail(0.16, H * 0.94, D + 0.08, x + ox, H / 2, z + oz, post, ry);
      }
      // corner posts
      const cs = [[-L / 2, -D / 2], [-L / 2, D / 2], [L / 2, -D / 2], [L / 2, D / 2]];
      for (let i = 0; i < 4; i++) {
        const px = cs[i][0], pz = cs[i][1];
        const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
        this.detail(0.34, H + 0.06, 0.34, x + px * c - pz * s2, H / 2, z + px * s2 + pz * c, post, ry);
      }
      // roof edge + door end with handle bars
      this.detail(L * 1.01, 0.12, D * 1.02, x, H, z, post, ry);
      const dx = (L / 2 + 0.04) * (Math.cos(ry * Math.PI / 180) || 1);
      const dz = -(L / 2 + 0.04) * (Math.sin(ry * Math.PI / 180) || 0);
      this.detail(0.1, H * 0.86, D * 0.86, x + dx, H / 2, z + dz, this.mat.metal, ry);
      for (let i = 0; i < 2; i++) {
        const off = (i - 0.5) * 0.5;
        this.detail(0.12, 0.7, 0.1,
          x + dx * 1.02 + off * (Math.cos(ry * Math.PI / 180) ? 0 : 1),
          H * 0.5,
          z + dz * 1.02 + off * (Math.sin(ry * Math.PI / 180) ? 1 : 0), this.mat.metalDark, ry);
      }
    }

    /** warehouse rack: 4 posts + 3 shelves + boxes */
    shelf(x, z, ry, rng) {
      const W = 4.4, H = 4.2, D = 1.3;
      this.solid(W, 0.12, D, x, 0.06, z, this.mat.metalDark, { ry: ry });   // collider base
      this.collision.addBox(new Box(
        x - (ry % 180 === 90 ? D / 2 : W / 2), 0, z - (ry % 180 === 90 ? W / 2 : D / 2),
        x + (ry % 180 === 90 ? D / 2 : W / 2), H, z + (ry % 180 === 90 ? W / 2 : D / 2), 'rack'));
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      for (let i = 0; i < 4; i++) {
        const px = (i < 2 ? -1 : 1) * W / 2, pz = (i % 2 ? 1 : -1) * D / 2;
        this.detail(0.16, H, 0.16, x + px * c - pz * s2, H / 2, z + px * s2 + pz * c, this.mat.metal);
      }
      for (let s = 1; s <= 3; s++) {
        this.detail(W, 0.1, D, x, s * (H / 3.4), z, this.mat.metal, ry);
        const boxes = 1 + ((rng() * 2) | 0);
        for (let b = 0; b < boxes; b++) {
          const px = (rng() - 0.5) * (W - 1);
          const bx = x + px * c, bz = z + px * s2;
          this.detail(0.7, 0.55, 0.7, bx, s * (H / 3.4) + 0.32, bz, rng() < 0.5 ? this.mat.wood : this.mat.crateDark, ry);
        }
      }
    }

    /** jersey barrier: base + tapered body + top cap */
    barricade(x, z, ry) {
      this.solid(2.4, 0.28, 1.0, x, 0.14, z, this.mat.concreteDark, { ry: ry, tag: 'low' });
      this.solid(2.1, 0.72, 0.72, x, 0.62, z, this.mat.concrete, { ry: ry, tag: 'low', cast: true });
      this.solid(2.2, 0.16, 0.42, x, 1.04, z, this.mat.concreteDark, { ry: ry, collide: false });
      this.detail(2.0, 0.2, 0.1, x, 0.78, z, this.mat.hazard, ry);
    }

    barricadeLine(x, z, ry, n) {
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 2.5;
        const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
        this.barricade(x + off * c, z + off * s2, ry);
      }
    }

    /** concrete pillar with base + capital + rebar */
    pillar(x, z, h) {
      this.solid(1.9, 0.4, 1.9, x, 0.2, z, this.mat.concreteDark, { collide: false });
      this.solid(1.7, h, 1.7, x, h / 2 + 0.2, z, this.mat.concrete, { cast: true, tag: 'wall' });
      this.solid(2.1, 0.36, 2.1, x, h + 0.34, z, this.mat.concreteDark, { collide: false });
      for (let i = 0; i < 3; i++) {
        this.detailCyl(0.05, 0.05, 0.5, x - 0.5 + i * 0.5, h + 0.7, z, this.mat.rebar, 6);
      }
    }

    /** broken wall: uneven chunks with gaps + exposed rebar */
    ruinWall(x, z, ry, len, rng) {
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      let px = -len / 2;
      while (px < len / 2 - 0.6) {
        const w = 0.9 + rng() * 1.6;
        const gap = rng() < 0.25;
        const h = gap ? 0.5 + rng() * 0.6 : 1.6 + rng() * 2.4;
        const cx = x + px * c, cz = z + px * s2;
        this.solid(w, h, 0.85, cx, h / 2, cz, rng() < 0.4 ? this.mat.concreteDark : this.mat.concrete,
          { ry: ry, cast: true, tag: 'wall' });
        if (!gap && rng() < 0.5) {
          this.detail(w * 0.8, 0.16, 0.95, cx, h + 0.08, cz, this.mat.rebar, ry);
        }
        if (gap) {
          // rubble spilling through the breach
          for (let i = 0; i < 4; i++) {
            const t = (rng() - 0.5) * w;
            this.rubble(cx + t * c + (rng() - 0.5) * 1.1, cz + t * s2 + (rng() - 0.5) * 1.1, rng);
          }
        }
        px += w + 0.1 + rng() * 0.35;
      }
    }

    /** scattered debris chunks (mostly decorative) */
    rubble(x, z, rng) {
      const n = 2 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const s = 0.2 + rng() * 0.5;
        const m = this.detail(s, s * (0.4 + rng() * 0.6), s * (0.6 + rng() * 0.7),
          x + (rng() - 0.5) * 2.4, s * 0.3, z + (rng() - 0.5) * 2.4,
          rng() < 0.5 ? this.mat.concreteDark : this.mat.debris);
        m.rotation.set(rng() * 0.4, rng() * 3, rng() * 0.4);
      }
      if (rng() < 0.5) this.detailCyl(0.05, 0.05, 0.9, x + (rng() - 0.5) * 2, 0.45, z + (rng() - 0.5) * 2, this.mat.rebar, 6)
        .rotation.z = 0.8 + rng() * 0.5;
    }

    /** horizontal pipe run with flanges and brackets */
    pipe(x, y, z, len, ry) {
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      const p = this.detailCyl(0.26, 0.26, len, x, y, z, this.mat.metal, 12);
      p.rotation.z = Math.PI / 2;
      p.rotation.y = -ry * Math.PI / 180;
      for (let i = 0; i < 3; i++) {
        const px = (i - 1) * len * 0.32;
        const f = this.detailCyl(0.34, 0.34, 0.12, x + px * c, y, z + px * s2, this.mat.metalDark, 12);
        f.rotation.z = Math.PI / 2;
        f.rotation.y = -ry * Math.PI / 180;
      }
      for (let i = 0; i < 2; i++) {
        const px = (i - 0.5) * len * 0.7;
        this.detail(0.14, 1.4, 0.14, x + px * c, y - 0.7, z + px * s2, this.mat.metalDark);
      }
      // collider: axis-aligned box along whichever axis the pipe runs
      const halfX = Math.abs(c) * len / 2 + 0.35;
      const halfZ = Math.abs(s2) * len / 2 + 0.35;
      this.collision.addBox(new Box(x - halfX, y - 0.3, z - halfZ, x + halfX, y + 0.3, z + halfZ, 'pipe'));
    }

    /** chain-link fence: posts + rails + translucent panel */
    fence(x, z, ry, len) {
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      const panel = new THREE.Mesh(boxGeo(len, 2.1, 0.06),
        new THREE.MeshLambertMaterial({ color: 0x8b98a8, transparent: true, opacity: 0.28 }));
      panel.position.set(x, 1.05, z);
      panel.rotation.y = ry * Math.PI / 180;
      this.group.add(panel);
      for (let i = 0; i <= 3; i++) {
        const px = (i / 3 - 0.5) * len;
        this.detailCyl(0.09, 0.09, 2.3, x + px * c, 1.15, z + px * s2, this.mat.metalDark, 8);
      }
      this.detail(len, 0.09, 0.09, x, 2.2, z, this.mat.metal, ry);
      this.collision.addBox(new Box(
        Math.min(x - len / 2, x + len / 2), 0, z - 0.16,
        Math.max(x - len / 2, x + len / 2), 2.2, z + 0.16, 'fence'));
    }

    /** lamp post with arm, glowing head and a real point light */
    lamp(x, z, h, color) {
      const c = color === undefined ? 0xffd9a0 : color;
      this.detailCyl(0.13, 0.17, h, x, h / 2, z, this.mat.metalDark, 8);
      this.detail(0.16, 0.16, 0.7, x, h - 0.1, z - 0.35, this.mat.metalDark);
      const head = new THREE.Mesh(boxGeo(0.5, 0.16, 0.34), this.mat.lampOn);
      head.position.set(x, h - 0.22, z - 0.68);
      this.group.add(head);
      const hood = this.detail(0.62, 0.1, 0.44, x, h - 0.13, z - 0.68, this.mat.metalDark);
      hood.renderOrder = -1;
      const light = new THREE.PointLight(c, 0.85, 16, 2);
      light.position.set(x, h - 0.45, z - 0.68);
      this.group.add(light);
      this.lamps.push({ light: light, base: 0.85, phase: Math.random() * 6 });
      return light;
    }

    /** hanging warehouse lamp (from the ceiling beams) */
    hangLamp(x, y, z, color) {
      this.detailCyl(0.04, 0.04, 1.2, x, y + 0.6, z, this.mat.metalDark, 6);
      const shade = this.detailCyl(0.62, 0.24, 0.42, x, y, z, this.mat.metalDark, 12);
      shade.castShadow = false;
      const bulb = new THREE.Mesh(boxGeo(0.5, 0.08, 0.5), this.mat.lampOn);
      bulb.position.set(x, y - 0.2, z);
      this.group.add(bulb);
      const light = new THREE.PointLight(color === undefined ? 0xffcf90 : color, 1.1, 15, 2);
      light.position.set(x, y - 0.35, z);
      this.group.add(light);
      this.lamps.push({ light: light, base: 1.1, phase: Math.random() * 6 });
    }

    /** warning sign: post + striped plate */
    sign(x, z, ry, color) {
      this.detailCyl(0.07, 0.07, 2.2, x, 1.1, z, this.mat.metalDark, 6);
      const plate = this.detail(1.5, 0.75, 0.08, x, 2.0, z, color || this.mat.hazard, ry);
      plate.castShadow = true;
      for (let i = 0; i < 3; i++) {
        this.detail(1.52, 0.12, 0.1, x, 1.78 + i * 0.22, z, this.mat.dark, ry);
      }
    }

    /** raised platform with edge trim and stairs on all four sides */
    platform(cx, cz, w, d, h, trimColor) {
      this.solid(w, h, d, cx, h / 2, cz, this.mat.concrete, { cast: true });
      const trim = new THREE.Mesh(boxGeo(w + 0.16, 0.1, d + 0.16),
        trimColor === undefined ? this.mat.accent : trimColor);
      trim.position.set(cx, h + 0.03, cz);
      this.group.add(trim);

      // one staircase per side, each step `stepH*(s+1)` tall, outermost first
      const steps = Math.max(4, Math.round(h / 0.2));
      const stepH = h / steps, stepD = 0.6, stairW = 2.8;
      for (let s = 0; s < steps; s++) {
        const sh = stepH * (s + 1);
        const len = stepD * (s + 1);
        for (let side = 0; side < 4; side++) {
          const alongZ = side >= 2;                       // stairs on +/-Z faces
          const edge = (alongZ ? d : w) / 2;
          const dir = (side % 2 === 0) ? 1 : -1;
          const off = dir * (edge + len / 2 - 0.3);
          const px = alongZ ? cx : cx + off;
          const pz = alongZ ? cz + off : cz;
          const dims = alongZ ? [stairW, sh, len] : [len, sh, stairW];
          this.solid(dims[0], dims[1], dims[2], px, sh / 2, pz, this.mat.metal, { tag: 'stair' });
          // side rails so the staircase reads as a structure
          if (s % 2 === 0) {
            for (let r = -1; r <= 1; r += 2) {
              const rx = alongZ ? px + r * (stairW / 2) : px;
              const rz = alongZ ? pz : pz + r * (stairW / 2);
              this.detail(0.09, 0.9, 0.09, rx, sh + 0.45, rz, this.mat.metalDark);
            }
          }
        }
      }
      return h;
    }

    /** ramp: staircase of thin steps (keeps collision axis aligned) + rails */
    ramp(x, z, ry, len, h) {
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      const steps = Math.max(3, Math.round(h / 0.22));
      const stepD = len / steps;
      for (let s = 0; s < steps; s++) {
        const sh = (h / steps) * (s + 1);
        const px = x - (len / 2 - stepD * (s + 0.5)) * c;
        const pz = z - (len / 2 - stepD * (s + 0.5)) * s2;
        this.solid(3.0, sh, stepD, px, sh / 2, pz, this.mat.metal, { ry: ry, tag: 'stair' });
      }
      for (let side = -1; side <= 1; side += 2) {
        for (let s = 0; s <= steps; s += 2) {
          const px = x - (len / 2 - stepD * s) * c + side * 1.6 * -s2;
          const pz = z - (len / 2 - stepD * s) * s2 + side * 1.6 * c;
          this.detail(0.1, 0.9, 0.1, px, (h / steps) * s + 0.45, pz, this.mat.metalDark);
        }
      }
    }

    /** elevated walkway with support posts and railings */
    balcony(x, z, w, d, h, ry) {
      this.solid(w, 0.35, d, x, h, z, this.mat.metalDark, { cast: true, ry: ry });
      const posts = Math.max(2, Math.round(w / 3));
      for (let i = 0; i <= posts; i++) {
        const px = x + (i / posts - 0.5) * (w - 0.6);
        this.detail(0.22, h, 0.22, px, h / 2, z, this.mat.metalDark);
      }
      // railings on both long edges
      for (let side = -1; side <= 1; side += 2) {
        this.detail(w, 0.09, 0.09, x, h + 0.95, z + side * (d / 2 - 0.1), this.mat.metal, ry);
        this.detail(w, 0.07, 0.07, x, h + 0.55, z + side * (d / 2 - 0.1), this.mat.metal, ry);
        for (let i = 0; i <= posts * 2; i++) {
          const px = x + (i / (posts * 2) - 0.5) * (w - 0.4);
          this.detail(0.08, 1.0, 0.08, px, h + 0.5, z + side * (d / 2 - 0.1), this.mat.metalDark);
        }
      }
    }

    /** supply corner: lockers + ammo crates + med kit + loot spots */
    supply(x, z, ry) {
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      for (let i = 0; i < 3; i++) {
        const px = x + ((i - 1) * 1.4) * c, pz = z + ((i - 1) * 1.4) * s2;
        this.solid(1.2, 2.0, 0.7, px, 1.0, pz, this.mat.metalDark, { cast: true, ry: ry, tag: 'locker' });
        this.detail(0.9, 0.06, 0.06, px, 1.4, pz + 0.37 * (c ? 1 : 0), this.mat.metal);
        this.detail(0.2, 0.2, 0.08, px + 0.35 * (c ? 0 : 1), 1.0, pz + 0.37 * (c ? 1 : 0), this.mat.accent);
      }
      this.crate(x - 2.2 * c, z - 2.2 * s2, 1.6, ry + 20, false);
      this.crate(x - 2.4 * c + 1.3 * s2, z - 2.4 * s2 - 1.3 * c, 1.3, ry - 15, true);
      this.barrel(x + 2.4 * c, z + 2.4 * s2, 'barrelGreen');
      this.sign(x, z + 2.6, ry, this.mat.hazard);
      // three loot spots around the station
      this.lootSpots.push(new THREE.Vector3(x - 3.4 * c - 1.6 * s2, 0, z - 3.4 * s2 - 1.6 * c));
      this.lootSpots.push(new THREE.Vector3(x + 1.4 * c + 3.0 * s2, 0, z + 1.4 * s2 + 3.0 * c));
      this.lootSpots.push(new THREE.Vector3(x + 3.6 * c - 2.2 * s2, 0, z + 3.6 * s2 + 2.2 * c));
      return this.lootSpots.length;
    }

    /* ------------------------------------------------------------------ */
    /* zones                                                               */
    /* ------------------------------------------------------------------ */

    zoneCentral(cx, cz, opts) {
      const o = opts || {};
      const rng = this.rng;
      if (o.platform !== false) this.platform(cx, cz, 12, 12, 1.1);
      this.barricadeLine(cx - 5, cz + 6.5, 0, 2);
      this.barricadeLine(cx + 6, cz - 6.5, 0, 2);
      this.barrelCluster(cx + 7.5, cz + 7.5, rng);
      this.crate(cx - 7.5, cz - 7.5, 1.8, 15, false);
      this.crateStack(cx + 7.2, cz - 7.6, 0, rng);
      this.lamp(cx - 8, cz + 8, 5.4);
      this.lamp(cx + 8, cz - 8, 5.4);
      this.spawnPoints.push(new THREE.Vector3(cx, o.platform === false ? 0 : 1.2, cz));
    }

    zoneWarehouse(cx, cz, ry, rows) {
      const rng = this.rng;
      const n = rows || 3;
      for (let r = 0; r < n; r++) {
        const off = (r - (n - 1) / 2) * 7.5;
        const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
        const x = cx + off * c, z = cz + off * s2;
        if (r % 2 === 0) this.container(x, z, ry + 90, (r + this.layoutIndex) % 2 === 0);
        else this.shelf(x, z, ry, rng);
      }
      // back wall of the warehouse + hanging lamps
      const c = Math.cos(ry * Math.PI / 180), s2 = Math.sin(ry * Math.PI / 180);
      const wx = cx + 12 * s2, wz = cz - 12 * c;
      for (let i = 0; i < 4; i++) {
        const px = cx + (i - 1.5) * 6 * c + 9 * s2, pz = cz + (i - 1.5) * 6 * s2 - 9 * c;
        this.hangLamp(px, 4.6, pz);
      }
      this.detail(26, 0.4, 0.5, wx, 5.2, wz, this.mat.metalDark, ry);
      this.crateStack(cx + 6 * s2 - 4 * c, cz - 6 * c - 4 * s2, ry, rng);
      this.barrelCluster(cx - 6 * s2 + 3 * c, cz + 6 * c + 3 * s2, rng);
      this.fence(cx + 10 * s2, cz - 10 * c, ry + 90, 12);
      this.sign(cx + 10 * s2 - 6 * c, cz - 10 * c - 6 * s2, ry, this.mat.hazard);
      this.spawnPoints.push(new THREE.Vector3(cx, 0, cz));
      this.spawnPoints.push(new THREE.Vector3(wx - 4 * c, 0, wz + 4 * s2));
    }

    zoneRuins(cx, cz, rng) {
      this.ruinWall(cx - 7, cz - 6, 0, 13, rng);
      this.ruinWall(cx + 8, cz + 5, 90, 12, rng);
      this.ruinWall(cx, cz + 9, 0, 10, rng);
      for (let i = 0; i < 4; i++) {
        this.solid(2 + rng() * 1.6, 0.9 + rng() * 0.9, 1.6 + rng(),
          cx + (rng() - 0.5) * 14, (0.9 + rng() * 0.9) / 2, cz + (rng() - 0.5) * 14,
          this.mat.concrete, { ry: (rng() * 90) | 0, cast: true, tag: 'low' });
      }
      for (let i = 0; i < 5; i++) this.rubble(cx + (rng() - 0.5) * 20, cz + (rng() - 0.5) * 20, rng);
      this.pipe(cx, 5.4, cz - 9, 14, 0);
      this.barrelCluster(cx + 6, cz - 6, rng);
      this.crateStack(cx - 6, cz + 7, 30, rng);
      this.spawnPoints.push(new THREE.Vector3(cx, 0, cz - 3));
      this.spawnPoints.push(new THREE.Vector3(cx + 5, 0, cz + 4));
    }

    zoneElevated(cx, cz) {
      const h = this.platform(cx, cz, 9, 9, 2.4);
      this.ramp(cx, cz + 9.5, 0, 7, h);
      const balY = 3.2;
      this.balcony(cx + 9.5, cz, 12, 3.4, balY, 0);
      this.ramp(cx + 11, cz + 4.5, 90, 7, 3.2);
      this.barricade(cx - 3, cz - 3, 45);
      this.crate(cx + 2.6, cz + 2.6, 1.6, 20, true);
      this.lamp(cx - 7, cz + 7, 5.6);
      this.spawnPoints.push(new THREE.Vector3(cx, h, cz));
      this.spawnPoints.push(new THREE.Vector3(cx + 9.5, balY + 0.2, cz));   // balcony deck
      this.lootSpots.push(new THREE.Vector3(cx + 9.5, 0, cz));
    }

    zoneSupply(cx, cz, ry) { this.supply(cx, cz, ry); }

    /* ------------------------------------------------------------------ */
    /* layouts                                                             */
    /* ------------------------------------------------------------------ */

    applyLayout(index, seed) {
      index = ((index % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length;
      this._clear();
      this.layoutIndex = index;
      this.layoutName = LAYOUTS[index].name;
      this.rng = mulberry32((seed || 1) * 7919 + index * 104729 + 17);
      this._shell();
      LAYOUTS[index].build(this);
      this._buildSpawnPoints(index);
      this.setMood('normal');
      return this.layoutName;
    }

    _clear() {
      const keep = [];
      for (let i = this.group.children.length - 1; i >= 0; i--) {
        const child = this.group.children[i];
        if (child === this.sky) { keep.push(child); continue; }
        if (child.isLight) child.intensity = 0;
        this.group.remove(child);
      }
      for (let i = 0; i < keep.length; i++) this.group.add(keep[i]);
      this.collision.boxes.length = 0;                  // the arena owns every static box
      this.spawnPoints.length = 0;
      this.lootSpots.length = 0;
      this.lamps.length = 0;
      this.animated.length = 0;
    }

    /** floor, outer walls, sky  identical for every layout */
    _shell() {
      const H = CFG.arenaHalf, W = 10;
      const floor = new THREE.Mesh(boxGeo(H * 2, 1, H * 2), this.mat.floor);
      floor.position.set(0, -0.5, 0);
      floor.receiveShadow = true;
      this.group.add(floor);
      this.collision.addBox(new Box(-H, -4, -H, H, 0, H, 'floor'));

      this.solid(H * 2 + 2, W, 1.2, 0, W / 2, -H - 0.6, this.mat.wall, { tag: 'wall' });
      this.solid(H * 2 + 2, W, 1.2, 0, W / 2, H + 0.6, this.mat.wall, { tag: 'wall' });
      this.solid(1.2, W, H * 2, -H - 0.6, W / 2, 0, this.mat.wall, { tag: 'wall' });
      this.solid(1.2, W, H * 2, H + 0.6, W / 2, 0, this.mat.wall, { tag: 'wall' });
      // trim + buttresses break up the flat walls
      this.solid(H * 2 + 2, 0.55, 1.5, 0, 3.4, -H - 0.6, this.mat.wallTrim, { collide: false });
      this.solid(H * 2 + 2, 0.55, 1.5, 0, 3.4, H + 0.6, this.mat.wallTrim, { collide: false });
      this.solid(1.5, 0.55, H * 2, -H - 0.6, 3.4, 0, this.mat.wallTrim, { collide: false });
      this.solid(1.5, 0.55, H * 2, H + 0.6, 3.4, 0, this.mat.wallTrim, { collide: false });
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        this.solid(1.0, W, 1.6, i * 12, W / 2, -H - 0.5, this.mat.concreteDark, { collide: false });
        this.solid(1.0, W, 1.6, i * 12, W / 2, H + 0.5, this.mat.concreteDark, { collide: false });
      }
      // hazard stripe band along the wall bases
      for (let i = -3; i <= 3; i++) {
        this.detail(3.6, 0.28, 0.1, i * 8, 0.5, -H + 0.02, this.mat.hazard);
        this.detail(3.6, 0.28, 0.1, i * 8, 0.5, H - 0.02, this.mat.hazard);
      }
    }

    _buildSky() {
      const skyGeo = new THREE.SphereGeometry(190, 20, 12);
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x0a1830) },
          bottom: { value: new THREE.Color(0x3d4c5e) },
          horizon: { value: new THREE.Color(0x8fa3b8) }
        },
        vertexShader: [
          'varying vec3 vPos;',
          'void main() {',
          '  vPos = position;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 top; uniform vec3 bottom; uniform vec3 horizon;',
          'varying vec3 vPos;',
          'void main() {',
          '  float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);',
          '  vec3 c = mix(bottom, horizon, smoothstep(0.35, 0.5, h));',
          '  c = mix(c, top, smoothstep(0.5, 0.85, h));',
          '  gl_FragColor = vec4(c, 1.0);',
          '}'
        ].join('\n')
      });
      this.sky = new THREE.Mesh(skyGeo, skyMat);
      this.group.add(this.sky);
    }

    /**
     * 20+ validated spawn points per layout: never inside geometry, never
     * stacked on top of each other, never in the player's start pocket.
     */
    _buildSpawnPoints(layoutIndex) {
      const H = CFG.arenaHalf;
      const valid = (v) => {
        if (Math.abs(v.x) > H - 3 || Math.abs(v.z) > H - 3) return false;
        const hits = [];
        this.collision.overlapAt(v, 0.8, 1.9, hits, null);
        for (let i = 0; i < hits.length; i++) if (!hits[i].owner) return false;
        if (Math.hypot(v.x - 0, v.z - 22) < 11) return false;   // player spawn pocket
        return true;
      };

      // zone points are hand-placed: re-validate them so a prop tweak can
      // never leave a spawn buried inside geometry
      const zonePts = [];
      for (let i = 0; i < this.spawnPoints.length; i++) {
        if (valid(this.spawnPoints[i])) zonePts.push(this.spawnPoints[i]);
      }
      this.spawnPoints = zonePts;

      const pts = [];
      const ok = (v) => {
        if (!valid(v)) return false;
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].distanceToSquared(v) < 36) return false;   // >= 6m apart
        }
        return true;
      };
      const want = clamp(24 - zonePts.length, 8, 22);           // 15-25 total per layout
      let guard = 0;
      while (pts.length < want && guard++ < 1200) {
        const v = new THREE.Vector3(rand(-H + 4, H - 4), 0, rand(-H + 4, H - 4));
        if (ok(v)) pts.push(v);
      }
      this.spawnPoints = pts.concat(this.spawnPoints);
    }

    /* ------------------------------------------------------------------ */
    /* lighting mood                                                        */
    /* ------------------------------------------------------------------ */

    /** 'normal' | 'dim' | 'boss'  per-layout ambience + dramatic boss lighting */
    setMood(mood) {
      this.mood = mood;
      const g = this.game;
      const L = LAYOUTS[this.layoutIndex] || LAYOUTS[0];
      const fog = this.scene.fog;
      const amb = g && g.ambient;
      const hemi = g && g.hemi;
      if (mood === 'boss') {
        if (fog) { fog.color.setHex(0x2a1030); fog.near = 22; fog.far = 78; }
        if (g && g.sun) { g.sun.intensity = 0.34; g.sun.color.setHex(0xffb0d0); }
        if (amb) { amb.intensity = 0.10; amb.color.setHex(0x4a2340); }
        if (hemi) { hemi.intensity = 0.14; hemi.color.setHex(0x7a4a86); }
        for (let i = 0; i < this.lamps.length; i++) {
          this.lamps[i].light.color.setHex(0xff4fd0);
          this.lamps[i].base = 0.55;
        }
      } else {
        if (fog) { fog.color.setHex(L.fog); fog.near = L.fogNear; fog.far = L.fogFar; }
        if (g && g.sun) { g.sun.intensity = L.sun; g.sun.color.setHex(0xffe0b0); }
        if (amb) { amb.intensity = L.amb; amb.color.setHex(L.ambColor); }
        if (hemi) { hemi.intensity = L.hemi; hemi.color.setHex(0x8fb2d6); }
        for (let i = 0; i < this.lamps.length; i++) {
          this.lamps[i].light.color.setHex(L.lampColor);
          this.lamps[i].base = L.lampPower;
        }
      }
    }

    update(dt) {
      this._t += dt;
      for (let i = 0; i < this.lamps.length; i++) {
        const l = this.lamps[i];
        l.light.intensity = l.base * (0.92 + Math.sin(this._t * 2.1 + l.phase) * 0.08);
      }
    }

    reset() { /* layouts are rebuilt per stage by applyLayout */ }
  }

  /* predefined arena layouts: each mixes 3-5 zones */
  const LAYOUTS = [
    {
      id: 'warehouse', name: 'WAREHOUSE YARD',
      fog: 0x161d28, fogNear: 26, fogFar: 88, sun: 0.52, amb: 0.13, ambColor: 0x3d4c60, hemi: 0.22, lampColor: 0xffcf90, lampPower: 1.0,
      build(a) {
        a.zoneCentral(0, 0);
        a.zoneWarehouse(-18, -14, 0, 3);
        a.zoneSupply(19, 17, 45);
        a.container(20, -6, 0, false);
        a.barricadeLine(6, 16, 90, 3);
        a.pipe(10, 4.2, -20, 16, 0);
        a.pillar(24, 24, 6.5); a.pillar(-24, 24, 6.5); a.pillar(24, -24, 6.5); a.pillar(-24, -24, 6.5);
      }
    },
    {
      id: 'ruins', name: 'COLLAPSED WORKS',
      fog: 0x28323f, fogNear: 34, fogFar: 116, sun: 0.62, amb: 0.15, ambColor: 0x51637a, hemi: 0.26, lampColor: 0xffe0b0, lampPower: 0.7,
      build(a) {
        a.zoneCentral(4, 4);
        a.zoneRuins(-16, -16, a.rng);
        a.zoneElevated(17, 13);
        a.ruinWall(0, -24, 0, 16, a.rng);
        a.ruinWall(-26, 6, 90, 14, a.rng);
        a.barricadeLine(-4, -10, 0, 3);
        a.lamp(-8, 10, 5.4); a.lamp(12, -6, 5.4);
        a.pillar(-26, -24, 6.5); a.pillar(26, 24, 6.5);
      }
    },
    {
      id: 'yard', name: 'CONTAINER YARD',
      fog: 0x1a2430, fogNear: 28, fogFar: 96, sun: 0.62, amb: 0.15, ambColor: 0x44546a, hemi: 0.26, lampColor: 0xffd9a0, lampPower: 0.9,
      build(a) {
        a.zoneCentral(0, 0, { platform: false });
        a.container(-16, -12, 0, false);
        a.container(16, -12, 0, true);
        a.container(-16, 14, 90, true);
        a.container(16, 14, 90, false);
        a.container(0, -20, 0, true);
        a.shelf(-8, 8, 0, a.rng);
        a.shelf(8, 8, 0, a.rng);
        a.barricadeLine(0, 20, 0, 4);
        a.barrelCluster(-24, 0, a.rng);
        a.barrelCluster(24, 0, a.rng);
        a.supply(0, 25, 180);
        a.lamp(-22, 20, 5.6); a.lamp(22, -20, 5.6);
        a.fence(-24, -24, 45, 10); a.fence(24, 24, 45, 10);
      }
    },
    {
      id: 'foundry', name: 'FOUNDRY',
      fog: 0x241a16, fogNear: 24, fogFar: 84, sun: 0.5, amb: 0.14, ambColor: 0x5a4238, hemi: 0.2, lampColor: 0xff9a4a, lampPower: 1.25,
      build(a) {
        a.zoneCentral(0, 0);
        a.balcony(-20, 0, 16, 4, 3.6, 0);
        a.ramp(-20, 5.5, 0, 8, 3.6);
        a.ramp(-20, -5.5, 180, 8, 3.6);
        a.pipe(0, 5.6, -12, 20, 0);
        a.pipe(0, 4.4, 12, 20, 0);
        a.pipe(-12, 5.0, 0, 18, 90);
        for (let i = 0; i < 4; i++) {
          a.barrelCluster(-10 + i * 7, -20, a.rng);
          a.barrelCluster(-10 + i * 7, 20, a.rng);
        }
        a.solid(6, 4.5, 6, 14, 2.25, -6, a.mat.concreteDark, { cast: true, tag: 'machine' });
        a.detail(5, 0.6, 5, 14, 4.8, -6, a.mat.metal);
        a.detailCyl(1.1, 1.1, 2.4, 14, 6.2, -6, a.mat.rust, 12);
        a.sign(6, -6, 0, a.mat.hazard);
        a.supply(-24, 22, 90);
        a.lamp(-10, 0, 5.8, 0xff9a4a);
        a.lamp(10, 0, 5.8, 0xff9a4a);
      }
    },
    {
      id: 'mixed', name: 'MIXED COMPLEX',
      fog: 0x1c2532, fogNear: 28, fogFar: 100, sun: 0.66, amb: 0.16, ambColor: 0x4a5a70, hemi: 0.28, lampColor: 0xffdcae, lampPower: 0.95,
      build(a) {
        a.zoneCentral(-4, -2);
        a.zoneWarehouse(18, -18, 45, 2);
        a.zoneRuins(-18, 16, a.rng);
        a.zoneElevated(18, 16);
        a.container(-6, -22, 0, false);
        a.barricadeLine(0, 8, 0, 2);
        a.barrelCluster(-24, -8, a.rng);
        a.supply(-24, 24, 0);
        a.lamp(-8, -12, 5.4);
        a.pillar(0, -14, 6.5);
      }
    }
  ];

  /* ============================================================ WEAPONS */

  /* ---------------------------------------------------------------------
   * STAT PIPELINE
   *   final = type.base    rarity    weapon mods    player buffs
   * Every source is a plain sparse modifier { mul:{stat:f}, add:{stat:v} }
   * and a single generic resolver applies them, so new stats / buffs /
   * modifiers never need a special case anywhere else.
   * ------------------------------------------------------------------- */

  const WEAPON_STAT_FIELDS = [
    'damage', 'fireRate', 'pellets', 'magazine', 'reserve', 'reloadTime',
    'spread', 'moveSpread', 'range', 'headMul', 'critChance', 'critDamage', 'lifesteal',
    'recoilMul', 'moveSpeed', 'adsTime', 'adsTimeMul', 'adsFov', 'zoom',
    'adsSpread', 'adsMove', 'adsRecoil', 'pelletDamage'
  ];

  /* ------------------------------- ammo -------------------------------- */

  const AMMO_TYPES = {
    '9mm': { id: '9mm', name: '9MM', start: 180, color: 0xd8c26a },
    '5.56': { id: '5.56', name: '5.56', start: 120, color: 0x8fdc5a },
    '7.62': { id: '7.62', name: '7.62', start: 60, color: 0xd8a24a },
    '12ga': { id: '12ga', name: 'SHELLS', start: 32, color: 0xff6a6a },
    '.50': { id: '.50', name: '.50 BMG', start: 24, color: 0xc07aff },
    'rocket': { id: 'rocket', name: 'ROCKETS', start: 8, color: 0xff8a3a }
  };
  const AMMO_IDS = Object.keys(AMMO_TYPES);

  /* ------------------------------- optics ------------------------------- */

  const OPTICS = {
    iron: { id: 'iron', name: 'IRON SIGHT', zoom: 1, adsTimeMul: 1, reticle: 'iron', mul: {} },
    reddot: { id: 'reddot', name: 'RED DOT', zoom: 1.2, adsTimeMul: 1.05, reticle: 'dot', mul: { adsSpread: 0.95 } },
    holo: { id: 'holo', name: 'HOLO', zoom: 1.45, adsTimeMul: 1.08, reticle: 'holo', mul: {} },
    scope2: { id: 'scope2', name: '2x SCOPE', zoom: 2.0, adsTimeMul: 0.92, reticle: 'cross', mul: {} },
    scope4: { id: 'scope4', name: '4x SCOPE', zoom: 4.0, adsTimeMul: 0.82, reticle: 'cross', mul: {} },
    scope8: { id: 'scope8', name: '8x SNIPER', zoom: 8.0, adsTimeMul: 0.72, reticle: 'cross', mul: {} }
  };

  /* ----------------------------- magazines ------------------------------ */

  const MAGAZINES = {
    standard: { id: 'standard', name: 'STANDARD MAG', mul: {}, add: {} },
    extended: { id: 'extended', name: 'EXTENDED MAG', mul: { magazine: 1.25, reserve: 1.25 }, add: { reloadTime: 0.22 } },
    quick: { id: 'quick', name: 'QUICK MAG', mul: { magazine: 0.9 }, add: { reloadTime: -0.35 } },
    drum: { id: 'drum', name: 'DRUM MAG', mul: { magazine: 1.55, moveSpeed: 0.85 }, add: { reloadTime: 0.45 } },
    hvel: { id: 'hvel', name: 'HIGH VELOCITY MAG', mul: { magazine: 1.05, range: 1.18 }, add: {} }
  };

  /* ---------------------------- attachments ----------------------------- */

  const ATTACHMENTS = {
    optic: {
      none: { id: 'none', name: 'NO OPTIC', optic: 'iron', mul: {} },
      reddot: { id: 'reddot', name: 'RED DOT SIGHT', optic: 'reddot', mul: { adsTimeMul: 0.95, adsSpread: 0.9 } },
      holo: { id: 'holo', name: 'HOLOGRAPHIC SIGHT', optic: 'holo', mul: { adsTimeMul: 0.92 } },
      scope2: { id: 'scope2', name: '2x OPTIC', optic: 'scope2', mul: {} },
      scope4: { id: 'scope4', name: '4x OPTIC', optic: 'scope4', mul: {} },
      scope8: { id: 'scope8', name: '8x SNIPER OPTIC', optic: 'scope8', mul: {} }
    },
    muzzle: {
      none: { id: 'none', name: 'STANDARD MUZZLE', mul: {} },
      compensator: { id: 'compensator', name: 'COMPENSATOR', mul: { recoilMul: 0.8 }, flashScale: 0.7 },
      brake: { id: 'brake', name: 'MUZZLE BRAKE', mul: { recoilMul: 0.7, adsTimeMul: 1.05 }, flashScale: 0.9 },
      suppressor: { id: 'suppressor', name: 'SUPPRESSOR', mul: { recoilMul: 0.95, damage: 0.95 }, flashScale: 0.25 }
    },
    grip: {
      none: { id: 'none', name: 'STANDARD GRIP', mul: {} },
      vertical: { id: 'vertical', name: 'VERTICAL GRIP', mul: { recoilMul: 0.85 } },
      angled: { id: 'angled', name: 'ANGLED GRIP', mul: { adsTimeMul: 0.9, adsMove: 1.05 } }
    }
  };
  const ATTACH_SLOTS = ['optic', 'muzzle', 'grip'];

  /** combine a list of {mul,add} modifiers into one (multiplicative + additive) */
  function combineMods(list) {
    const mul = {}, add = {};
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m) continue;
      if (m.mul) for (const k in m.mul) mul[k] = (mul[k] === undefined ? 1 : mul[k]) * m.mul[k];
      if (m.add) for (const k in m.add) add[k] = (add[k] === undefined ? 0 : add[k]) + m.add[k];
    }
    return { mul: mul, add: add };
  }

  /** keep only the stat keys a weapon actually cares about */
  function restrictMods(mods, fields) {
    const mul = {}, add = {};
    for (let i = 0; i < fields.length; i++) {
      const k = fields[i];
      if (mods.mul[k] !== undefined) mul[k] = mods.mul[k];
      if (mods.add[k] !== undefined) add[k] = mods.add[k];
    }
    return { mul: mul, add: add };
  }

  /** base  (mul) + (add) over the union of every stat key involved.
   *  A stat that only ever appears as a ratio (e.g. a weapon's move-speed
   *  penalty) has an implicit base of 1; an additive-only stat bases at 0. */
  function resolveStats(base, mods) {
    const out = {};
    const keys = Object.create(null);
    for (const k in base) keys[k] = 1;
    if (mods && mods.mul) for (const k in mods.mul) keys[k] = 1;
    if (mods && mods.add) for (const k in mods.add) keys[k] = 1;
    for (const k in keys) {
      const m = mods && mods.mul && mods.mul[k] !== undefined ? mods.mul[k] : 1;
      const a = mods && mods.add && mods.add[k] !== undefined ? mods.add[k] : 0;
      let b = base[k];
      if (b === undefined) b = (m !== 1) ? 1 : 0;
      out[k] = b * m + a;
    }
    return out;
  }

  /* ------------------------------- rarity ------------------------------- */

  const RARITIES = [
    { id: 'common',    name: 'COMMON',    color: 0x9fb0c0, css: '#9fb0c0', weight: 62,   mul: { damage: 1.0,  magazine: 1.0 },  add: {}, mods: 0 },
    { id: 'uncommon',  name: 'UNCOMMON',  color: 0x5fd35f, css: '#5fd35f', weight: 24,   mul: { damage: 1.12, magazine: 1.05 }, add: {}, mods: 1 },
    { id: 'rare',      name: 'RARE',      color: 0x4aa8ff, css: '#4aa8ff', weight: 9,    mul: { damage: 1.28, magazine: 1.12, fireRate: 1.05 }, add: {}, mods: 2 },
    { id: 'epic',      name: 'EPIC',      color: 0xb46bff, css: '#b46bff', weight: 3.6,  mul: { damage: 1.48, magazine: 1.2, fireRate: 1.1 },  add: {}, mods: 3 },
    { id: 'legendary', name: 'LEGENDARY', color: 0xffa22e, css: '#ffa22e', weight: 1.2,  mul: { damage: 1.75, magazine: 1.3, fireRate: 1.15 }, add: { critDamage: 0.25 }, mods: 4 },
    { id: 'mythic',    name: 'MYTHIC',    color: 0xff4d6d, css: '#ff4d6d', weight: 0.2,  mul: { damage: 2.15, magazine: 1.45, fireRate: 1.25 }, add: { critChance: 0.1, critDamage: 0.5 }, mods: 5 }
  ];
  const RARITY_BY_ID = {};
  for (let i = 0; i < RARITIES.length; i++) RARITY_BY_ID[RARITIES[i].id] = RARITIES[i];

  /* --------------------------- weapon modifiers ------------------------- */

  const WEAPON_MODS = [
    { id: 'rapid', name: 'Rapid', desc: '+20% Fire Rate', mul: { fireRate: 1.20 } },
    { id: 'heavy', name: 'Heavy', desc: '+25% Damage, -10% Move Speed', mul: { damage: 1.25, moveSpeed: 0.90 } },
    { id: 'tactical', name: 'Tactical', desc: '+20% Reload Speed', mul: { reloadTime: 1 / 1.2 } },
    { id: 'extended', name: 'Extended', desc: '+25% Magazine', mul: { magazine: 1.25, reserve: 1.25 } },
    { id: 'vampiric', name: 'Vampiric', desc: '+5% Lifesteal', add: { lifesteal: 0.05 } },
    { id: 'precision', name: 'Precision', desc: '-30% Spread', mul: { spread: 0.70, moveSpread: 0.70 } },
    { id: 'destructive', name: 'Destructive', desc: '+15% Critical Damage', add: { critDamage: 0.15 } },
    { id: 'reckless', name: 'Reckless', desc: '+18% Damage, +20% Recoil', mul: { damage: 1.18, recoilMul: 1.2 } },
    { id: 'stabilized', name: 'Stabilized', desc: '-25% Recoil, +10% Range', mul: { recoilMul: 0.75, range: 1.1 } },
    { id: 'savage', name: 'Savage', desc: '+12% Headshot Damage', mul: { headMul: 1.12 } },
    { id: 'hollow', name: 'Hollow Point', desc: '+10% Fire Rate, -10% Damage', mul: { fireRate: 1.10, damage: 0.90 } },
    { id: 'brass', name: 'Brass', desc: '+30% Reserve Ammo', mul: { reserve: 1.30 } }
  ];
  const MOD_BY_ID = {};
  for (let i = 0; i < WEAPON_MODS.length; i++) MOD_BY_ID[WEAPON_MODS[i].id] = WEAPON_MODS[i];

  /* ------------------------------- player buffs -------------------------- */

  const BUFFS = [
    { id: 'berserker', name: 'Berserker', desc: '+20% Weapon Damage', mul: { damage: 1.20 } },
    { id: 'quickhands', name: 'Quick Hands', desc: '-25% Reload Time', mul: { reloadTime: 0.75 } },
    { id: 'vitality', name: 'Vitality', desc: '+30 Max HP', add: { maxHealth: 30 } },
    { id: 'gunslinger', name: 'Gunslinger', desc: '+15% Fire Rate', mul: { fireRate: 1.15 } },
    { id: 'speeddemon', name: 'Speed Demon', desc: '+20% Movement Speed', mul: { moveSpeed: 1.20 } },
    { id: 'ammohoarder', name: 'Ammo Hoarder', desc: '+25% Magazine Size', mul: { magazine: 1.25 } },
    { id: 'lucky', name: 'Lucky', desc: '+25% Loot Rarity Chance', add: { lootLuck: 0.25 } },
    { id: 'executioner', name: 'Executioner', desc: '+15% Critical Damage', add: { critDamage: 0.15 } },
    { id: 'deadeye', name: 'Dead Eye', desc: '+10% Headshot Damage', mul: { headMul: 1.10 } },
    { id: 'marathon', name: 'Marathon', desc: '+25 Stamina, +15% Stamina Regen', add: { staminaMax: 25, staminaRegen: 3 } }
  ];
  const BUFF_BY_ID = {};
  for (let i = 0; i < BUFFS.length; i++) BUFF_BY_ID[BUFFS[i].id] = BUFFS[i];

  /* boss-only reward cards */
  const BOSS_BUFFS = [
    { id: 'overkill', name: 'Overkill', desc: '+30% Weapon Damage', mul: { damage: 1.30 } },
    { id: 'secondwind', name: 'Second Wind', desc: 'Heal 50% HP now, +15 Max HP', add: { maxHealth: 15 }, heal: 0.5 },
    { id: 'ammocache', name: 'Ammo Cache', desc: 'Refill all ammo + 50% reserve', refill: 0.5 },
    { id: 'loadout', name: 'Field Loadout', desc: '+1 random weapon slot filled', slot: true },
    { id: 'titanblood', name: 'Titan Blood', desc: '+40% Max HP', add: { maxHealth: 40 } }
  ];
  const BOSS_BUFF_BY_ID = {};
  for (let i = 0; i < BOSS_BUFFS.length; i++) BOSS_BUFF_BY_ID[BOSS_BUFFS[i].id] = BOSS_BUFFS[i];

  const PLAYER_BASE = {
    moveSpeed: CFG.moveSpeed,
    maxHealth: CFG.maxHealth,
    staminaMax: CFG.staminaMax,
    staminaRegen: CFG.staminaRegen,
    lootLuck: 0,
    damageReduction: 1        // 1.0 = none; Guardian / buffs multiply this
  };

  /* --------------------------- weapon archetypes ---------------------------
   * Every weapon is described by data only:
   *   stats   -> the stat pipeline resolves them (rarity x mods x mag x atts)
   *   model   -> a list of primitives assembled by Weapon._buildModel()
   *   ammo    -> which ammo pool it consumes
   *   optic   -> its default sight (attachments can override)
   * --------------------------------------------------------------------- */

  // material keys used by the model parts
  const P_BODY = 0, P_METAL = 1, P_DARK = 2, P_WOOD = 3, P_ACCENT = 4, P_MAG = 5, P_GLASS = 6;

  const WEAPON_TYPES = {

    /* ------------------------------ AR ---------------------------------- */
    ar15: {
      id: 'ar15', name: 'AR-15', family: 'ar', weight: 26, ammo: '5.56',
      damage: 25, pellets: 1, fireRate: 11.5, magazine: 30, reserve: 240,
      reloadTime: 1.85, spread: 0.004, moveSpread: 0.020, range: 220, headMul: 2.0,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1,
      adsTime: 0.22, adsFov: 52, zoom: 1, adsSpread: 0.4, adsMove: 0.6, adsRecoil: 0.8,
      auto: true, sound: 'rifle', tracer: [0.55, 0.85, 1.0], optic: 'iron',
      recoil: { pitch: 0.030, yaw: 0.010, kick: 0.085, shake: 0.16 }, recoilImpulse: 5.2,
      muzzleZ: -1.08,
      model: [
        [P_BODY, 0.09, 0.11, 0.52, 0, 0, -0.14],
        [P_METAL, 0.06, 0.07, 0.42, 0, 0.015, -0.52],
        [P_DARK, 0.045, 0.045, 0.36, 0, 0.012, -0.84],
        [P_DARK, 0.075, 0.075, 0.07, 0, 0.012, -1.04],
        [P_MAG, 0.07, 0.2, 0.1, 0, -0.13, 0.02],
        [P_DARK, 0.075, 0.13, 0.24, 0, -0.11, 0.2],
        [P_WOOD, 0.05, 0.1, 0.08, 0, -0.12, -0.3],
        [P_DARK, 0.03, 0.03, 0.09, 0.055, 0.055, -0.3],
        [P_DARK, 0.012, 0.05, 0.012, -0.035, 0.09, -0.5],
        [P_DARK, 0.012, 0.05, 0.012, 0.035, 0.09, -0.5],
        [P_METAL, 0.05, 0.03, 0.12, 0, -0.02, -0.72]
      ]
    },
    ak: {
      id: 'ak', name: 'AK-47', family: 'ar', weight: 20, ammo: '7.62',
      damage: 34, pellets: 1, fireRate: 9.2, magazine: 30, reserve: 210,
      reloadTime: 2.15, spread: 0.007, moveSpread: 0.024, range: 240, headMul: 1.9,
      critChance: 0.03, critDamage: 0.6, lifesteal: 0, recoilMul: 1, moveSpeed: 1,
      adsTime: 0.26, adsFov: 54, zoom: 1, adsSpread: 0.5, adsMove: 0.58, adsRecoil: 0.85,
      auto: true, sound: 'rifle', tracer: [1.0, 0.75, 0.35], optic: 'iron',
      recoil: { pitch: 0.052, yaw: 0.018, kick: 0.14, shake: 0.3 }, recoilImpulse: 8.4,
      muzzleZ: -1.1,
      model: [
        [P_WOOD, 0.09, 0.12, 0.5, 0, 0, -0.14],
        [P_METAL, 0.06, 0.07, 0.44, 0, 0.015, -0.54],
        [P_DARK, 0.05, 0.05, 0.34, 0, 0.012, -0.86],
        [P_METAL, 0.07, 0.07, 0.08, 0, 0.012, -1.06],
        [P_WOOD, 0.08, 0.2, 0.12, 0, -0.14, 0.02, 0.18],
        [P_WOOD, 0.08, 0.14, 0.28, 0, -0.1, 0.22],
        [P_WOOD, 0.05, 0.11, 0.09, 0, -0.13, -0.3],
        [P_DARK, 0.014, 0.055, 0.014, -0.035, 0.09, -0.52],
        [P_ACCENT, 0.09, 0.03, 0.14, 0, 0.075, -0.1]
      ]
    },
    m4: {
      id: 'm4', name: 'M4 CARBINE', family: 'ar', weight: 22, ammo: '5.56',
      damage: 24, pellets: 1, fireRate: 13.5, magazine: 30, reserve: 240,
      reloadTime: 1.7, spread: 0.0032, moveSpread: 0.018, range: 230, headMul: 2.0,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1.02,
      adsTime: 0.18, adsFov: 50, zoom: 1, adsSpread: 0.35, adsMove: 0.62, adsRecoil: 0.78,
      auto: true, sound: 'rifle', tracer: [0.6, 0.95, 0.7], optic: 'iron',
      recoil: { pitch: 0.023, yaw: 0.008, kick: 0.07, shake: 0.12 }, recoilImpulse: 4.4,
      muzzleZ: -1.06,
      model: [
        [P_BODY, 0.085, 0.10, 0.5, 0, 0, -0.14],
        [P_DARK, 0.055, 0.065, 0.4, 0, 0.012, -0.5],
        [P_DARK, 0.042, 0.042, 0.36, 0, 0.01, -0.84],
        [P_METAL, 0.07, 0.07, 0.1, 0, 0.01, -1.0],
        [P_MAG, 0.065, 0.19, 0.09, 0, -0.13, 0.0],
        [P_DARK, 0.07, 0.12, 0.22, 0, -0.1, 0.2],
        [P_DARK, 0.05, 0.1, 0.08, 0, -0.12, -0.3],
        [P_METAL, 0.04, 0.05, 0.26, 0, 0.09, -0.28],
        [P_DARK, 0.014, 0.04, 0.014, -0.03, 0.085, -0.48],
        [P_DARK, 0.014, 0.04, 0.014, 0.03, 0.085, -0.48]
      ]
    },

    /* ------------------------------ SMG --------------------------------- */
    mp5: {
      id: 'mp5', name: 'MP5', family: 'smg', weight: 20, ammo: '9mm',
      damage: 20, pellets: 1, fireRate: 13, magazine: 30, reserve: 270,
      reloadTime: 1.55, spread: 0.009, moveSpread: 0.014, range: 130, headMul: 1.8,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1.06,
      adsTime: 0.19, adsFov: 54, zoom: 1, adsSpread: 0.42, adsMove: 0.68, adsRecoil: 0.85,
      auto: true, sound: 'rifle', tracer: [1.0, 0.9, 0.5], optic: 'iron',
      recoil: { pitch: 0.024, yaw: 0.012, kick: 0.07, shake: 0.13 }, recoilImpulse: 4.8,
      muzzleZ: -0.92,
      model: [
        [P_BODY, 0.075, 0.09, 0.36, 0, 0, -0.1],
        [P_DARK, 0.05, 0.055, 0.22, 0, 0.012, -0.4],
        [P_DARK, 0.032, 0.032, 0.26, 0, 0.01, -0.66],
        [P_MAG, 0.06, 0.24, 0.085, 0, -0.14, -0.02],
        [P_DARK, 0.055, 0.1, 0.18, 0, -0.1, 0.16],
        [P_DARK, 0.045, 0.09, 0.075, 0, -0.12, -0.22],
        [P_METAL, 0.03, 0.035, 0.12, 0, 0.07, -0.18],
        [P_DARK, 0.012, 0.035, 0.012, -0.026, 0.078, -0.3]
      ]
    },
    vector: {
      id: 'vector', name: 'VECTOR', family: 'smg', weight: 15, ammo: '9mm',
      damage: 13, pellets: 1, fireRate: 22, magazine: 25, reserve: 300,
      reloadTime: 1.7, spread: 0.011, moveSpread: 0.015, range: 120, headMul: 1.7,
      critChance: 0.05, critDamage: 0.55, lifesteal: 0, recoilMul: 1, moveSpeed: 1.05,
      adsTime: 0.17, adsFov: 56, zoom: 1, adsSpread: 0.5, adsMove: 0.7, adsRecoil: 0.9,
      auto: true, sound: 'rifle', tracer: [1.0, 0.95, 0.6], optic: 'iron',
      recoil: { pitch: 0.016, yaw: 0.010, kick: 0.05, shake: 0.09 }, recoilImpulse: 3.4,
      muzzleZ: -0.9,
      model: [
        [P_DARK, 0.08, 0.1, 0.34, 0, 0, -0.08],
        [P_ACCENT, 0.085, 0.035, 0.3, 0, 0.06, -0.08],
        [P_DARK, 0.036, 0.036, 0.24, 0, 0.005, -0.44],
        [P_MAG, 0.05, 0.2, 0.07, 0, -0.13, -0.02],
        [P_DARK, 0.05, 0.09, 0.2, 0, -0.1, 0.16],
        [P_METAL, 0.04, 0.06, 0.22, 0, 0.02, -0.4],
        [P_DARK, 0.045, 0.09, 0.075, 0, -0.12, -0.2],
        [P_ACCENT, 0.02, 0.05, 0.14, 0.03, -0.02, -0.3]
      ]
    },
    p90: {
      id: 'p90', name: 'P90', family: 'smg', weight: 15, ammo: '5.56',
      damage: 19, pellets: 1, fireRate: 14.5, magazine: 50, reserve: 320,
      reloadTime: 2.0, spread: 0.010, moveSpread: 0.013, range: 140, headMul: 1.8,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1.04,
      adsTime: 0.21, adsFov: 55, zoom: 1, adsSpread: 0.44, adsMove: 0.68, adsRecoil: 0.86,
      auto: true, sound: 'rifle', tracer: [0.9, 0.95, 0.6], optic: 'iron',
      recoil: { pitch: 0.020, yaw: 0.011, kick: 0.06, shake: 0.11 }, recoilImpulse: 4.2,
      muzzleZ: -0.86,
      model: [
        [P_BODY, 0.085, 0.13, 0.3, 0, 0.01, -0.06],
        [P_DARK, 0.05, 0.06, 0.3, 0, -0.02, -0.36],
        [P_DARK, 0.035, 0.035, 0.2, 0, -0.02, -0.6],
        [P_MAG, 0.07, 0.1, 0.34, 0, -0.11, -0.06],
        [P_DARK, 0.06, 0.1, 0.2, 0, -0.09, 0.18],
        [P_ACCENT, 0.03, 0.045, 0.16, 0.05, 0.02, -0.24],
        [P_DARK, 0.045, 0.09, 0.075, 0, -0.12, -0.2]
      ]
    },

    /* ---------------------------- shotgun ------------------------------- */
    pump: {
      id: 'pump', name: 'PUMP SHOTGUN', family: 'shotgun', weight: 22, ammo: '12ga',
      damage: 17, pellets: 9, fireRate: 1.25, magazine: 6, reserve: 48,
      reloadTime: 2.9, spread: 0.058, moveSpread: 0.016, range: 60, headMul: 1.5,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1,
      adsTime: 0.26, adsFov: 58, zoom: 1, adsSpread: 0.72, adsMove: 0.6, adsRecoil: 0.9,
      auto: false, sound: 'shotgun', tracer: [1.0, 0.72, 0.32], optic: 'iron',
      recoil: { pitch: 0.135, yaw: 0.028, kick: 0.26, shake: 0.62 }, recoilImpulse: 10.5,
      muzzleZ: -0.9,
      model: [
        [P_WOOD, 0.1, 0.13, 0.4, 0, 0, -0.08],
        [P_DARK, 0.06, 0.07, 0.46, 0, 0.025, -0.52],
        [P_DARK, 0.045, 0.05, 0.36, 0, 0.025, -0.86],
        [P_WOOD, 0.075, 0.07, 0.2, 0, -0.04, -0.66],
        [P_WOOD, 0.09, 0.11, 0.26, 0, -0.1, 0.22],
        [P_WOOD, 0.055, 0.12, 0.1, 0, -0.12, -0.18],
        [P_METAL, 0.04, 0.05, 0.3, 0, -0.03, -0.3],
        [P_DARK, 0.014, 0.04, 0.014, 0.03, 0.1, -0.5]
      ]
    },
    tacshot: {
      id: 'tacshot', name: 'TACTICAL SHOTGUN', family: 'shotgun', weight: 18, ammo: '12ga',
      damage: 12, pellets: 8, fireRate: 2.6, magazine: 9, reserve: 72,
      reloadTime: 2.2, spread: 0.05, moveSpread: 0.014, range: 70, headMul: 1.6,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 1.02,
      adsTime: 0.2, adsFov: 56, zoom: 1, adsSpread: 0.7, adsMove: 0.65, adsRecoil: 0.9,
      auto: false, sound: 'shotgun', tracer: [1.0, 0.8, 0.4], optic: 'reddot',
      recoil: { pitch: 0.088, yaw: 0.02, kick: 0.17, shake: 0.4 }, recoilImpulse: 7.4,
      muzzleZ: -0.84,
      model: [
        [P_BODY, 0.085, 0.1, 0.42, 0, 0, -0.1],
        [P_DARK, 0.055, 0.06, 0.36, 0, 0.015, -0.48],
        [P_DARK, 0.05, 0.05, 0.28, 0, 0.015, -0.78],
        [P_METAL, 0.03, 0.04, 0.12, 0, 0.09, -0.34],
        [P_DARK, 0.07, 0.12, 0.24, 0, -0.1, 0.2],
        [P_DARK, 0.05, 0.1, 0.085, 0, -0.12, -0.2],
        [P_GLASS, 0.02, 0.02, 0.02, 0.035, 0.115, -0.34]
      ]
    },
    dblbarrel: {
      id: 'dblbarrel', name: 'DOUBLE BARREL', family: 'shotgun', weight: 10, ammo: '12ga',
      damage: 21, pellets: 10, fireRate: 0.75, magazine: 2, reserve: 24,
      reloadTime: 3.4, spread: 0.055, moveSpread: 0.018, range: 58, headMul: 1.4,
      critChance: 0.08, critDamage: 0.7, lifesteal: 0, recoilMul: 1, moveSpeed: 1,
      adsTime: 0.28, adsFov: 58, zoom: 1, adsSpread: 0.75, adsMove: 0.58, adsRecoil: 0.95,
      auto: false, sound: 'shotgun', tracer: [1.0, 0.65, 0.25], optic: 'iron',
      recoil: { pitch: 0.185, yaw: 0.034, kick: 0.36, shake: 0.95 }, recoilImpulse: 13.5,
      muzzleZ: -0.88,
      model: [
        [P_WOOD, 0.1, 0.12, 0.36, 0, 0, -0.06],
        [P_METAL, 0.075, 0.085, 0.5, 0, 0.02, -0.46],
        [P_DARK, 0.028, 0.028, 0.42, -0.032, 0.02, -0.5],
        [P_DARK, 0.028, 0.028, 0.42, 0.032, 0.02, -0.5],
        [P_WOOD, 0.095, 0.12, 0.3, 0, -0.1, 0.2],
        [P_WOOD, 0.055, 0.11, 0.09, 0, -0.12, -0.16],
        [P_METAL, 0.05, 0.05, 0.1, 0, 0.02, -0.74]
      ]
    },

    /* ------------------------------ DMR --------------------------------- */
    m14: {
      id: 'm14', name: 'M14 EBR', family: 'dmr', weight: 14, ammo: '7.62',
      damage: 62, pellets: 1, fireRate: 3.4, magazine: 20, reserve: 140,
      reloadTime: 2.2, spread: 0.0016, moveSpread: 0.045, range: 300, headMul: 2.4,
      critChance: 0, critDamage: 0.65, lifesteal: 0, recoilMul: 1, moveSpeed: 0.98,
      adsTime: 0.3, adsFov: 34, zoom: 2, adsSpread: 0.18, adsMove: 0.5, adsRecoil: 0.7,
      auto: false, sound: 'rifle', tracer: [0.75, 0.95, 1.0], optic: 'scope2',
      recoil: { pitch: 0.095, yaw: 0.014, kick: 0.2, shake: 0.4 }, recoilImpulse: 11.5,
      muzzleZ: -1.28,
      model: [
        [P_BODY, 0.085, 0.11, 0.56, 0, 0, -0.14],
        [P_METAL, 0.05, 0.06, 0.5, 0, 0.02, -0.56],
        [P_DARK, 0.036, 0.036, 0.44, 0, 0.02, -1.0],
        [P_DARK, 0.055, 0.055, 0.08, 0, 0.02, -1.24],
        [P_MAG, 0.055, 0.16, 0.085, 0, -0.13, -0.02],
        [P_DARK, 0.07, 0.14, 0.28, 0, -0.1, 0.24],
        [P_DARK, 0.045, 0.1, 0.08, 0, -0.12, -0.32],
        [P_METAL, 0.055, 0.055, 0.3, 0, 0.1, -0.34],
        [P_GLASS, 0.04, 0.04, 0.02, 0, 0.1, -0.48]
      ]
    },
    scarh: {
      id: 'scarh', name: 'SCAR-H DMR', family: 'dmr', weight: 13, ammo: '7.62',
      damage: 88, pellets: 1, fireRate: 2.6, magazine: 10, reserve: 80,
      reloadTime: 2.5, spread: 0.0012, moveSpread: 0.055, range: 330, headMul: 2.6,
      critChance: 0.05, critDamage: 0.7, lifesteal: 0, recoilMul: 1, moveSpeed: 0.96,
      adsTime: 0.32, adsFov: 28, zoom: 4, adsSpread: 0.12, adsMove: 0.45, adsRecoil: 0.65,
      auto: false, sound: 'rifle', tracer: [1.0, 0.8, 0.4], optic: 'scope4',
      recoil: { pitch: 0.115, yaw: 0.016, kick: 0.26, shake: 0.5 }, recoilImpulse: 13,
      muzzleZ: -1.34,
      model: [
        [P_BODY, 0.1, 0.13, 0.6, 0, 0, -0.16],
        [P_METAL, 0.06, 0.07, 0.5, 0, 0.03, -0.6],
        [P_DARK, 0.045, 0.045, 0.5, 0, 0.03, -1.06],
        [P_DARK, 0.07, 0.07, 0.1, 0, 0.03, -1.34],
        [P_MAG, 0.06, 0.17, 0.09, 0, -0.15, -0.02],
        [P_DARK, 0.08, 0.16, 0.3, 0, -0.11, 0.26],
        [P_DARK, 0.05, 0.11, 0.085, 0, -0.13, -0.34],
        [P_METAL, 0.06, 0.06, 0.34, 0, 0.12, -0.4],
        [P_GLASS, 0.05, 0.05, 0.02, 0, 0.12, -0.56],
        [P_METAL, 0.03, 0.03, 0.26, 0, -0.05, -0.7]
      ]
    },

    /* ---------------------------- sniper -------------------------------- */
    boltsnipe: {
      id: 'boltsnipe', name: 'BOLT SNIPER', family: 'sniper', weight: 10, ammo: '.50',
      damage: 175, pellets: 1, fireRate: 0.85, magazine: 5, reserve: 45,
      reloadTime: 3.6, spread: 0.0004, moveSpread: 0.07, range: 420, headMul: 2.8,
      critChance: 0.1, critDamage: 0.9, lifesteal: 0, recoilMul: 1, moveSpeed: 0.9,
      adsTime: 0.42, adsFov: 16, zoom: 8, adsSpread: 0.06, adsMove: 0.36, adsRecoil: 0.5,
      auto: false, sound: 'rifle', tracer: [0.85, 1.0, 0.9], optic: 'scope8',
      recoil: { pitch: 0.185, yaw: 0.02, kick: 0.34, shake: 0.75 }, recoilImpulse: 16,
      muzzleZ: -1.6,
      model: [
        [P_WOOD, 0.09, 0.11, 0.6, 0, 0, -0.14],
        [P_DARK, 0.04, 0.04, 0.72, 0, 0.02, -0.78],
        [P_DARK, 0.055, 0.055, 0.12, 0, 0.02, -1.5],
        [P_METAL, 0.05, 0.05, 0.34, 0, 0.12, -0.36],
        [P_GLASS, 0.06, 0.06, 0.02, 0, 0.12, -0.52],
        [P_METAL, 0.03, 0.03, 0.08, 0, 0.12, 0.0],
        [P_MAG, 0.045, 0.12, 0.07, 0, -0.12, -0.06],
        [P_WOOD, 0.085, 0.15, 0.34, 0, -0.1, 0.28],
        [P_DARK, 0.045, 0.1, 0.08, 0, -0.12, -0.3],
        [P_METAL, 0.02, 0.16, 0.02, -0.05, -0.16, -0.6],
        [P_METAL, 0.02, 0.16, 0.02, 0.05, -0.16, -0.6]
      ]
    },
    heavysniper: {
      id: 'heavysniper', name: 'HEAVY SNIPER', family: 'sniper', weight: 7, ammo: '.50',
      damage: 260, pellets: 1, fireRate: 0.55, magazine: 4, reserve: 32,
      reloadTime: 4.2, spread: 0.0003, moveSpread: 0.09, range: 460, headMul: 3.0,
      critChance: 0.15, critDamage: 1.0, lifesteal: 0, recoilMul: 1, moveSpeed: 0.84,
      adsTime: 0.5, adsFov: 12, zoom: 8, adsSpread: 0.05, adsMove: 0.3, adsRecoil: 0.45,
      auto: false, sound: 'shotgun', tracer: [1.0, 0.75, 0.35], optic: 'scope8',
      recoil: { pitch: 0.235, yaw: 0.026, kick: 0.44, shake: 1.0 }, recoilImpulse: 18.5,
      muzzleZ: -1.7,
      model: [
        [P_BODY, 0.11, 0.14, 0.66, 0, 0, -0.16],
        [P_METAL, 0.07, 0.08, 0.66, 0, 0.03, -0.7],
        [P_DARK, 0.055, 0.055, 0.6, 0, 0.03, -1.2],
        [P_DARK, 0.08, 0.08, 0.14, 0, 0.03, -1.64],
        [P_METAL, 0.07, 0.07, 0.42, 0, 0.16, -0.4],
        [P_GLASS, 0.075, 0.075, 0.025, 0, 0.16, -0.6],
        [P_ACCENT, 0.06, 0.05, 0.1, 0, 0.15, -0.1],
        [P_MAG, 0.06, 0.15, 0.1, 0, -0.15, -0.04],
        [P_DARK, 0.1, 0.18, 0.32, 0, -0.11, 0.3],
        [P_DARK, 0.05, 0.11, 0.09, 0, -0.13, -0.32],
        [P_METAL, 0.025, 0.2, 0.025, -0.07, -0.2, -0.66],
        [P_METAL, 0.025, 0.2, 0.025, 0.07, -0.2, -0.66]
      ]
    },

    /* --------------------------- explosive ------------------------------ */
    rocket: {
      id: 'rocket', name: 'ROCKET LAUNCHER', family: 'rocket', weight: 6, ammo: 'rocket',
      damage: 130, pellets: 1, fireRate: 0.8, magazine: 4, reserve: 16,
      reloadTime: 3.1, spread: 0.001, moveSpread: 0.03, range: 140, headMul: 1.0,
      critChance: 0, critDamage: 0.5, lifesteal: 0, recoilMul: 1, moveSpeed: 0.92,
      adsTime: 0.34, adsFov: 60, zoom: 1, adsSpread: 0.9, adsMove: 0.5, adsRecoil: 1,
      auto: false, sound: 'shotgun', tracer: [1.0, 0.6, 0.2], optic: 'iron',
      recoil: { pitch: 0.24, yaw: 0.03, kick: 0.42, shake: 0.95 }, recoilImpulse: 17,
      projectile: { speed: 30, radius: 0.32, splash: 6.2, splashDamage: 95 },
      muzzleZ: -1.32,
      model: [
        [P_METAL, 0.15, 0.15, 0.78, 0, 0.02, -0.4],
        [P_DARK, 0.17, 0.17, 0.1, 0, 0.02, -0.76],
        [P_DARK, 0.17, 0.17, 0.1, 0, 0.02, -0.05],
        [P_WOOD, 0.1, 0.12, 0.3, 0, -0.02, 0.28],
        [P_DARK, 0.06, 0.13, 0.1, 0, -0.12, 0.02],
        [P_METAL, 0.03, 0.05, 0.24, 0, 0.12, -0.2],
        [P_ACCENT, 0.03, 0.04, 0.05, 0, 0.13, 0.04],
        [P_DARK, 0.02, 0.06, 0.02, 0, 0.11, -0.36]
      ]
    }
  };

  // stage gating for loot (stage 1 keeps the two classic archetypes available)
  const TYPE_UNLOCK_STAGE = {
    ar15: 1, pump: 1, tacshot: 1,
    ak: 2, mp5: 2, m4: 2, dblbarrel: 3,
    vector: 3, p90: 3, m14: 4,
    scarh: 5, boltsnipe: 6, heavysniper: 7, rocket: 5
  };

  /* View-model materials are cached per rarity so 15 weapon types share a tiny
   * material set instead of allocating one per weapon runtime. */
  const _weaponMats = Object.create(null);
  function weaponMaterials(rarity) {
    const key = rarity.id;
    if (_weaponMats[key]) return _weaponMats[key];
    const set = [];
    set[P_BODY] = lamMat('wm.body.' + key, {
      color: rarity.color, emissive: rarity.id === 'common' ? 0x000000 : 0x0a1a26
    });
    set[P_METAL] = lamMat('wm.metal', { color: 0x7c8794 });
    set[P_DARK] = lamMat('wm.dark', { color: 0x272c33 });
    set[P_WOOD] = lamMat('wm.wood', { color: 0x6b4a2c });
    set[P_ACCENT] = lamMat('wm.accent', { color: 0x2f9fe0, emissive: 0x0a2a44 });
    set[P_MAG] = lamMat('wm.mag', { color: 0x353b44 });
    set[P_GLASS] = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.35 });
    _weaponMats[key] = set;
    return set;
  }

  /** modifier pools by weapon family */
  const FAMILY_MOD_POOL = {
    ar: ['rapid', 'heavy', 'tactical', 'extended', 'vampiric', 'precision', 'destructive', 'reckless', 'stabilized', 'savage', 'brass'],
    smg: ['rapid', 'tactical', 'extended', 'vampiric', 'precision', 'destructive', 'hollow', 'brass'],
    shotgun: ['heavy', 'extended', 'tactical', 'vampiric', 'destructive', 'savage', 'brass'],
    dmr: ['heavy', 'destructive', 'precision', 'savage', 'stabilized', 'reckless', 'tactical'],
    sniper: ['heavy', 'destructive', 'precision', 'savage', 'stabilized', 'brass'],
    rocket: ['heavy', 'extended', 'vampiric', 'destructive', 'brass']
  };
  /* ------------------------------- armor -------------------------------
   * Three slots, the same rarity curve as weapons, and modifiers resolved
   * through the same generic pipeline.
   * ------------------------------------------------------------------- */

  const ARMOR_SLOTS = ['helmet', 'body', 'boots'];

  const ARMOR_KINDS = {
    helmet: {
      id: 'helmet', name: 'HELMET', slot: 'helmet',
      armor: 22, armorMul: { helmet: 1 },
      color: 0x4c5866
    },
    vest: {
      id: 'vest', name: 'BODY ARMOR', slot: 'body',
      armor: 55, armorMul: { body: 1 },
      color: 0x3d4a3a
    },
    boots: {
      id: 'boots', name: 'BOOTS', slot: 'boots',
      armor: 25, armorMul: { boots: 1 },
      color: 0x4a3f2e
    }
  };
  const ARMOR_KIND_LIST = Object.keys(ARMOR_KINDS);

  /** rarity -> armor scaling and modifier rolls for armour pieces */
  function armorRarityStats(rarityId) {
    const r = RARITY_BY_ID[rarityId] || RARITIES[0];
    const idx = RARITIES.indexOf(r);
    return {
      armorMul: 1 + idx * 0.85,
      reduction: 0.06 + idx * 0.045,
      headshot: 0.05 + idx * 0.035,
      moveSpeed: 1 + idx * 0.02,
      dashCd: 1 - idx * 0.045,
      modCount: Math.min(3, idx)
    };
  }

  const ARMOR_MODS = [
    { id: 'plated', name: 'PLATED', desc: '+30% Armor', mul: { helmetArmor: 1.3, bodyArmor: 1.3, bootsArmor: 1.3 } },
    { id: 'reinforced', name: 'REINFORCED', desc: '+6% Damage Reduction', mul: { damageReduction: 1.06 } },
    { id: 'lightweight', name: 'LIGHTWEIGHT', desc: '+8% Move Speed', mul: { moveSpeed: 1.08 } },
    { id: 'swiftstep', name: 'SWIFTSTEP', desc: '-15% Dash Cooldown', mul: { dashCooldown: 0.85 } },
    { id: 'ballistic', name: 'BALLISTIC', desc: '-8% Headshot Damage', mul: { headshotReduction: 0.92 } }
  ];
  const ARMOR_MOD_BY_ID = {};
  for (let i = 0; i < ARMOR_MODS.length; i++) ARMOR_MOD_BY_ID[ARMOR_MODS[i].id] = ARMOR_MODS[i];

  class ArmorInstance {
    constructor(kindId, rarityId, modIds) {
      this.uid = _uid++;
      this.kindId = kindId;
      this.rarityId = rarityId;
      this.modIds = (modIds || []).slice();
      const kind = ARMOR_KINDS[kindId];
      const rs = armorRarityStats(rarityId);
      this.armor = Math.round(kind.armor * rs.armorMul);

      const mods = [];
      for (let i = 0; i < this.modIds.length; i++) {
        const m = ARMOR_MOD_BY_ID[this.modIds[i]];
        if (m) mods.push(m);
      }
      const combined = combineMods(mods);
      this.mods = { mul: combined.mul, add: combined.add };
      // the kind contributes its own pool, the rarity its stat curve
      const kindMul = kind.armorMul || {};
      for (const k in kindMul) {
        this.mods.mul[k] = (this.mods.mul[k] || 1) * kindMul[k];
      }
      if (kind.slot === 'helmet') {
        this.mods.mul.headshotReduction = (this.mods.mul.headshotReduction || 1) * (1 - rs.headshot);
      } else if (kind.slot === 'body') {
        this.mods.mul.damageReduction = (this.mods.mul.damageReduction || 1) * (1 + rs.reduction);
      } else {
        this.mods.mul.moveSpeed = (this.mods.mul.moveSpeed || 1) * rs.moveSpeed;
        this.mods.mul.dashCooldown = (this.mods.mul.dashCooldown || 1) * rs.dashCd;
      }
    }
    get kind() { return ARMOR_KINDS[this.kindId]; }
    get rarity() { return RARITY_BY_ID[this.rarityId]; }
    get slot() { return this.kind.slot; }
    get displayName() { return this.rarity.name + ' ' + this.kind.name; }
    summary() {
      const out = ['Armor: +' + this.armor];
      if (this.kind.slot === 'body') out.push('Damage Reduction: ' + Math.round(this.reduction('damageReduction') * 100) + '%');
      if (this.kind.slot === 'helmet') out.push('Headshot Reduction: ' + Math.round(this.reduction('headshotReduction') * 100) + '%');
      if (this.kind.slot === 'boots') out.push('Move Speed: +' + Math.round((this.moveSpeed() - 1) * 100) + '%');
      return out;
    }
    reduction(key) {
      const k = this.kind.slot === 'body' ? 'damageReduction' : 'headshotReduction';
      void key;
      return 1 - (this.mods.mul[k] === undefined ? 1 : this.mods.mul[k]);
    }
    moveSpeed() { return this.mods.mul.moveSpeed === undefined ? 1 : this.mods.mul.moveSpeed; }
  }

  /* combined player modifiers, safe during construction (player not assigned yet) */
  function playerMods(game) {
    return game.player ? game.player.mods : combineMods([]);
  }

  /* --------------------------- weapon instance --------------------------
   * Holds everything that must survive a drop / pickup round trip:
   * type, rarity, modifier ids, live ammo and the derived stats.
   * ------------------------------------------------------------------- */

  let _uid = 1;
  class WeaponInstance {
    constructor(typeId, rarityId, modIds, magFrac, magId, atts) {
      this.uid = _uid++;
      this.typeId = typeId;
      this.rarityId = rarityId;
      this.modIds = (modIds || []).slice();
      this.magId = magId || 'standard';
      this.atts = atts || { optic: 'none', muzzle: 'none', grip: 'none' };
      this.mag = 0;         // filled by refresh()
      this.reserve = 0;     // rounds left in the spare magazine (backup ammo)
      this.stats = null;
      this.refreshStats();
      const full = Math.round(this.stats.magazine);
      this.mag = magFrac === undefined ? full : Math.max(1, Math.round(full * magFrac));
      this.reserve = Math.round(this.stats.reserve);
    }

    get type() { return WEAPON_TYPES[this.typeId]; }
    get rarity() { return RARITY_BY_ID[this.rarityId]; }
    get mods() { return this.modIds.map((id) => MOD_BY_ID[id]).filter(Boolean); }
    get ammoId() { return this.type.ammo; }
    get ammo() { return AMMO_TYPES[this.type.ammo]; }
    get magazine() { return MAGAZINES[this.magId] || MAGAZINES.standard; }
    get attachments() {
      const out = {};
      for (let i = 0; i < ATTACH_SLOTS.length; i++) {
        const s = ATTACH_SLOTS[i];
        out[s] = ATTACHMENTS[s][this.atts[s]] || ATTACHMENTS[s].none;
      }
      return out;
    }
    /** the optic actually in use: an attachment overrides the weapon default */
    get optic() {
      const a = ATTACHMENTS.optic[this.atts.optic];
      if (a && a.id !== 'none') return OPTICS[a.optic];
      return OPTICS[this.type.optic] || OPTICS.iron;
    }
    get displayName() {
      return this.rarity.name + ' ' + this.type.name;
    }

    /** rarity + weapon mods + magazine + attachments (player buffs come later) */
    refreshStats() {
      const parts = [{ mul: this.rarity.mul }, { add: this.rarity.add }];
      for (let i = 0; i < this.modIds.length; i++) {
        const m = MOD_BY_ID[this.modIds[i]];
        if (m) parts.push(m);
      }
      parts.push(this.magazine);
      const atts = this.attachments;
      for (let i = 0; i < ATTACH_SLOTS.length; i++) parts.push(atts[ATTACH_SLOTS[i]]);
      const mods = combineMods(parts);
      const st = resolveStats(this.type, mods);
      // zoom comes from whichever is stronger: the gun's own optics or an
      // attached one, then modifiers scale it
      const opticZoom = this.optic.zoom || 1;
      st.zoom = Math.max(this.type.zoom || 1, opticZoom) * (mods.mul.zoom === undefined ? 1 : mods.mul.zoom);
      st.magazine = Math.max(1, Math.round(st.magazine));
      st.reserve = Math.max(0, Math.round(st.reserve));
      st.reloadTime = Math.max(0.15, st.reloadTime);
      st.damage = Math.max(0.5, st.damage);
      st.fireRate = Math.max(0.2, st.fireRate);
      st.spread = Math.max(0, st.spread);
      st.moveSpeed = st.moveSpeed === undefined ? 1 : st.moveSpeed;
      st.recoilMul = st.recoilMul === undefined ? 1 : st.recoilMul;
      st.adsTimeMul = st.adsTimeMul === undefined ? 1 : st.adsTimeMul;
      st.adsFov = clamp(st.adsFov === undefined ? 55 : st.adsFov, 8, 80);
      st.adsSpread = st.adsSpread === undefined ? 0.4 : st.adsSpread;
      st.adsMove = st.adsMove === undefined ? 0.6 : st.adsMove;
      st.adsRecoil = st.adsRecoil === undefined ? 0.85 : st.adsRecoil;
      st.zoom = st.zoom === undefined ? 1 : Math.max(1, st.zoom);
      this.stats = st;
      return st;
    }

    /** final numbers for gameplay: instance stats + the holder's buffs */
    effectiveStats(playerMods) {
      const pm = restrictMods(playerMods, WEAPON_STAT_FIELDS);
      const out = resolveStats(this.stats, pm);
      out.magazine = Math.max(1, Math.round(out.magazine));
      out.reserve = Math.max(0, Math.round(out.reserve));
      out.reloadTime = Math.max(0.15, out.reloadTime);
      out.moveSpeed = this.stats.moveSpeed === undefined ? 1 : out.moveSpeed;
      out.recoilMul = this.stats.recoilMul === undefined ? 1 : out.recoilMul;
      out.adsTimeMul = this.stats.adsTimeMul === undefined ? 1 : out.adsTimeMul;
      out.adsFov = clamp(out.adsFov, 8, 80);
      out.adsSpread = clamp(out.adsSpread, BUILD_CAPS.adsSpread, 3);
      out.adsMove = clamp(out.adsMove, 0.15, 1);
      out.adsRecoil = out.adsRecoil === undefined ? 0.85 : out.adsRecoil;
      out.zoom = Math.max(1, out.zoom);
      // global damage / fire-rate ceilings (build balance, not per-weapon)
      out.damage = clamp(out.damage, 0.5, this.type.damage * BUILD_CAPS.damage);
      out.fireRate = clamp(out.fireRate, 0.2, this.type.fireRate * BUILD_CAPS.fireRate);
      return out;
    }

    /** human readable attachment summary for the pickup / inventory UI */
    attachmentList() {
      const out = [];
      for (let i = 0; i < ATTACH_SLOTS.length; i++) {
        const s = ATTACH_SLOTS[i];
        const a = this.attachments[s];
        if (a && a.id !== 'none') out.push({ slot: s, name: a.name });
      }
      return out;
    }

    refill(fraction) {
      const st = this.stats;
      this.mag = st.magazine;
      this.reserve = fraction === undefined
        ? st.reserve
        : Math.max(this.reserve, Math.round(st.reserve * fraction));
    }
  }


  /* ---- runtime weapon: view model + firing, bound to a WeaponInstance ---- */
  class Weapon {
    constructor(inst, camera, scene, game) {
      this.inst = inst;
      this.camera = camera;
      this.scene = scene;
      this.game = game;
      this.cooldown = 0;
      this.reloading = false;
      this.reloadT = 0;
      this.shotsFired = 0;
      this.shotsHit = 0;

      this.kick = 0;          // 0..1 view-model recoil
      this.kickVel = 0;       // spring velocity
      this.rotKick = 0;
      this.swayX = 0; this.swayY = 0; this.swayZ = 0;
      this.bobT = 0;
      this.switching = 0;
      this.sprintAmt = 0;
      this.airAmt = 0;
      this.reloadPhase = 0;
      this.magMesh = null;
      this.magHomeY = 0;

      this.group = new THREE.Group();
      this.group.renderOrder = 10;
      camera.add(this.group);

      this.stats = inst.effectiveStats(playerMods(game));
      this._buildModel();
      this._buildFlash();
    }

    /** weapon archetype: model shape, sound, tracer, fire mode */
    get def() { return this.inst.type; }
    get rarity() { return this.inst.rarity; }

    // live ammo lives on the instance so a drop / pickup keeps it
    get mag() { return this.inst.mag; }
    set mag(v) { this.inst.mag = v; }
    get reserve() { return this.inst.reserve; }
    set reserve(v) { this.inst.reserve = v; }

    /** re-resolve stats after buffs / rarity change and clamp the magazine */
    refreshStats() {
      this.stats = this.inst.effectiveStats(playerMods(this.game));
      if (this.inst.mag > this.stats.magazine) this.inst.mag = this.stats.magazine;
      if (this.reloading) this.reloadT = Math.min(this.reloadT, this.stats.reloadTime);
      return this.stats;
    }

    /** swap in a different instance (pickup / drop / inventory swap) */
    setInstance(inst) {
      const changedType = !this.inst || this.inst.typeId !== inst.typeId;
      this.inst = inst;
      this.reloading = false;
      this.reloadT = 0;
      this.cooldown = 0;
      this.refreshStats();
      if (changedType) this._rebuildModel();
      return this;
    }

    _mat(color, emissive) {
      return new THREE.MeshLambertMaterial({
        color: color,
        emissive: emissive === undefined ? 0x000000 : emissive
      });
    }

    _rebuildModel() {
      // drop the old view model (dispose geometries/materials) and rebuild
      while (this.model.children.length) {
        const child = this.model.children.pop();
        if (child.geometry) child.geometry.dispose();
        if (child.material && child.material.dispose) child.material.dispose();
      }
      this.muzzleLocal = new THREE.Vector3();
      this._buildModel();
      this.flash.position.copy(this.muzzleLocal);
      this.flashLight.position.copy(this.muzzleLocal);
    }

    /** build the view model from the weapon's primitive list (data driven) */
    _buildModel() {
      const def = this.def;
      const g = this.group;
      // the gun lives in its own node so it can be scaled and pushed away from
      // the eye without distorting the animation pivots in `group`
      this.model = new THREE.Group();
      this.model.position.set(0, 0, -0.3);
      this.model.scale.setScalar(0.62);
      g.add(this.model);

      // shared materials: one set per rarity bucket, reused across weapons
      const mats = weaponMaterials(this.rarity);

      this.magMesh = null;
      const parts = def.model;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const m = new THREE.Mesh(boxGeo(p[1], p[2], p[3]), mats[p[0]]);
        m.position.set(p[4], p[5], p[6]);
        if (p[7]) m.rotation.x = p[7];
        m.frustumCulled = false;
        this.model.add(m);
        if (p[0] === P_MAG) { this.magMesh = m; this.magHomeY = p[5]; }
      }
      this.muzzleLocal = new THREE.Vector3(0, 0.012, def.muzzleZ);

      /* ---- aiming reference point (model space) ----
       * the ADS pose is derived from this so the sight, not the muzzle, is what
       * lands on the camera axis */
      const opt = this.inst.optic;
      if (opt.id !== 'iron') {
        const tube = opt.zoom >= 4 ? 0.34 : 0.24;
        this.addPart(mats[P_DARK], 0.055, 0.055, tube, 0, 0.12, -0.3);
        this.addPart(mats[P_GLASS], 0.045, 0.045, 0.02, 0, 0.12, -0.3 - tube / 2);
        this.addPart(mats[P_ACCENT], 0.03, 0.02, 0.04, 0, 0.09, -0.3 + tube / 2);
        this.sightY = 0.12;                     // scope tube sits higher
      } else {
        this.addPart(mats[P_DARK], 0.012, 0.05, 0.012, -0.035, 0.09, -0.5);
        this.addPart(mats[P_DARK], 0.012, 0.05, 0.012, 0.035, 0.09, -0.5);
        this.sightY = 0.09;                     // rear sight height
      }

      /* ---- poses ---------------------------------------------------
       * HIP: gun rests low-right, muzzle angled across the view.
       * ADS: computed so the SIGHT sits exactly on the camera axis, which
       *       makes the muzzle collinear with the crosshair too. */
      this.modelScale = 0.62;
      this.modelZ = -0.3;
      this.hipPos = new THREE.Vector3(0.19, -0.15, -0.22);
      this.hipRot = new THREE.Euler(0, 0.045, 0);
      this.adsPos = new THREE.Vector3(
        0,                                   // centred horizontally
        -(this.modelZ * 0) - this.modelScale * this.sightY,   // sight lands on axis
        -0.12                                // receiver just in front of the eye
      );
      this.adsRot = new THREE.Euler(0, 0, 0);
      // keep the old names as aliases so nothing else has to change
      this.basePos = this.hipPos;
      this.baseRot = this.hipRot;
      this.group.position.copy(this.hipPos);
      this.group.rotation.copy(this.hipRot);
      g.visible = false;
    }

    /** small helper used by the model builder for the optic / extras */
    addPart(mat, w, h, d, x, y, z) {
      const m = new THREE.Mesh(boxGeo(w, h, d), mat);
      m.position.set(x, y, z);
      m.frustumCulled = false;
      this.model.add(m);
      return m;
    }

    _buildFlash() {
      const geo = new THREE.ConeGeometry(0.09, 0.3, 6, 1, true);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, -0.12);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffdd88,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.flash = new THREE.Mesh(geo, mat);
      this.flash.frustumCulled = false;
      this.flash.position.copy(this.muzzleLocal);
      this.flash.visible = false;
      // parented to the scaled model node, so undo the scale for the flash size
      this.flash.scale.setScalar(1 / this.model.scale.x);
      this.model.add(this.flash);

      this.flashLight = new THREE.PointLight(0xffc060, 0, 6, 2);
      this.flashLight.position.copy(this.muzzleLocal);
      this.model.add(this.flashLight);
      this.flashT = 0;
    }

    get canFire() {
      return !this.reloading && this.cooldown <= 0 && this.mag > 0 && this.switching <= 0;
    }

    startReload(audio) {
      // a reload is possible when either the spare magazine or the ammo pool
      // has rounds left for this weapon's calibre
      const pool = this.game.player.ammoPool(this.inst.ammoId);
      if (this.reloading || this.mag >= this.stats.magazine) return false;
      if (this.reserve <= 0 && pool <= 0) return false;
      this.reloading = true;
      this.reloadT = this.stats.reloadTime;
      this._reloadStage = 0;
      if (audio) audio.reload('out');
      return true;
    }

    /** pull from the weapon's own ammo pool first, then the spare magazine */
    _finishReload() {
      const cap = this.stats.magazine;
      const need = cap - this.mag;
      if (need <= 0) { this.reloading = false; return; }
      const pool = this.game.player.ammoPool(this.inst.ammoId);
      const fromPool = Math.min(need, pool);
      this.game.player.setAmmo(this.inst.ammoId, pool - fromPool);
      const fromSpare = Math.min(need - fromPool, this.reserve);
      this.reserve -= fromSpare;
      this.mag += fromPool + fromSpare;
      if (this.mag > cap) this.mag = cap;
      this.reloading = false;
      if (this.mag === 0) this.game.ui.showAmmoEmpty(this.inst.ammo);
    }

    cancelReload() { this.reloading = false; this.reloadT = 0; }

    /**
     * Hitscan fire. Enemy hitboxes are axis-aligned world boxes supplied by the game.
     */
    fire(game) {
      if (this.reloading) return false;
      if (this.mag <= 0) { game.audio.dryFire(); this.cooldown = 0.25; return false; }
      if (this.switching > 0) return false;

      const def = this.def;
      const st = this.stats;
      const cam = this.camera;
      // Hitscan is traced from the eye, not the muzzle: otherwise cover you are
      // peeking over (the muzzle sits lower) would eat shots the crosshair clears.
      const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);

      // spread grows with movement / airborne state; ADS really tightens it
      const moving = Math.min(1, game.player.planarSpeed / 6);
      const adsK = lerp(1, st.adsSpread, game.player.adsAmt);      // 1 hip -> adsSpread aimed
      const spread = (st.spread + st.moveSpread * moving + (game.player.grounded ? 0 : st.spread * 3.5)) * adsK;

      this.mag--;
      this.shotsFired++;
      this.cooldown = 1 / st.fireRate;
      game.audio.shoot(def.sound);
      this._flash();

      const muzzle = this.muzzleWorld();

      /* ---- projectile weapons (rocket launcher) skip the hitscan path ---- */
      if (def.projectile) {
        const pcfg = def.projectile;
        const rMul0 = st.recoilMul === undefined ? 1 : st.recoilMul;
        // launch from just in front of the eye (crosshair stays truthful) but
        // spawn the rocket at the muzzle so it reads as coming out of the tube
        game.projectiles.spawn(origin.clone().addScaledVector(dir, 0.7), dir, pcfg);
        game.tracers.add(muzzle, origin.clone().addScaledVector(dir, 3), 1, 0.6, 0.2, 0.08);
        this.kickVel += 17 * rMul0;
        game.addRecoil(def.recoil.pitch * rMul0, def.recoil.yaw * rMul0);
        game.addShake(def.recoil.shake * rMul0);
        game.particles.burst(12, muzzle.x, muzzle.y, muzzle.z, {
          spread: 1.2, up: 1.2, lifeMin: 0.08, lifeMax: 0.25,
          sizeMin: 0.03, sizeMax: 0.08, color: [1.0, 0.6, 0.2], grav: 1, drag: 3
        });
        game.stats.shots++;
        return true;
      }

      // view-model + camera recoil (recoilMul comes from weapon modifiers).
      // an impulse into the spring: fast weapons snap, heavy ones wallow.
      const rMul = (st.recoilMul === undefined ? 1 : st.recoilMul) * lerp(1, st.adsRecoil, game.player.adsAmt);
      const kickImpulse = (def.recoilImpulse || 6) * rMul;
      this.kickVel += kickImpulse;
      game.addRecoil(def.recoil.pitch * rMul, def.recoil.yaw * rMul);
      game.addShake(def.recoil.shake * rMul);
      game.particles.burst(def.id === 'shotgun' ? 10 : 4,
        origin.x + dir.x * 0.5, origin.y + dir.y * 0.5 - 0.05, origin.z + dir.z * 0.5,
        { spread: 1.4, up: 1.0, lifeMin: 0.05, lifeMax: 0.14, sizeMin: 0.02, sizeMax: 0.05,
          color: [1.0, 0.8, 0.4], grav: 0, drag: 6 });

      for (let p = 0; p < st.pellets; p++) {
        const d = dir.clone();
        if (spread > 0) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * spread;
          // build an orthonormal basis around the aim direction
          const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const right = new THREE.Vector3().crossVectors(d, up).normalize();
          const realUp = new THREE.Vector3().crossVectors(right, d).normalize();
          d.addScaledVector(right, Math.cos(a) * r);
          d.addScaledVector(realUp, Math.sin(a) * r);
          d.normalize();
        }
        this._trace(game, origin, d, st, muzzle);
      }

      game.stats.shots++;
      return true;
    }

    _trace(game, origin, dir, st, muzzle) {
      const worldT = game.collision.rayWorld(origin, dir, st.range);
      let hitT = worldT;
      let victim = null;
      let head = false;

      const enemies = game.enemies;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        // an enemy materialising (mesh still scaled up) must not be shootable
        if (!e.alive || e.spawnT < 1) continue;
        // broad distance reject
        if (e.position.distanceToSquared(origin) > st.range * st.range) continue;
        // body and head are tested independently: a shot aimed at the head can
        // miss the body box entirely (it is smaller and sits higher)
        const th = rayAABB(origin, dir, e.hitBody.min, e.hitBody.max, hitT);
        const hh = rayAABB(origin, dir, e.hitHead.min, e.hitHead.max, hitT);
        if (th < hitT || hh < hitT) {
          if (hh <= th) { hitT = hh; victim = e; head = true; }
          else { hitT = th; victim = e; head = false; }
        }
      }

      const end = origin.clone().addScaledVector(dir, hitT);
      // tracer is drawn from the muzzle for looks, the damage comes from the eye ray
      const isFire = !!(game.build && game.build.perk && game.build.perk.id === 'fireman' && game.build.perkState && game.build.perkState.burning > 0);
      if (isFire) {
        game.tracers.add(muzzle, end, 1.0, 0.35, 0.05, 0.085);
      } else {
        const tr = this.def.tracer;
        game.tracers.add(muzzle, end, tr[0], tr[1], tr[2], 0.075);
      }

      if (victim) {
        let dmg = st.damage * (head ? st.headMul : 1);
        let crit = false;
        if (st.critChance > 0 && Math.random() < st.critChance) {
          dmg *= 1 + st.critDamage;
          crit = true;
        }
        // Predator: back hits hit harder
        dmg *= game.build.backstabMultiplier(victim, dir);
        victim.takeDamage(dmg, dir, head, game);
        // Fire Man: the round burns
        const b = game.build.perkState;
        if (b && game.build.perk.id === 'fireman' && b.burning > 0) {
          game.burnTargets(Math.max(4, dmg * 0.05), 3);
          game.particles.burst(8, end.x, end.y, end.z, {
            spread: 1.4, up: 1.2, lifeMin: 0.15, lifeMax: 0.38,
            sizeMin: 0.03, sizeMax: 0.08, color: [1.0, 0.5, 0.1], grav: -1.5, drag: 2
          });
        }
        // lifesteal from weapon modifiers
        if (st.lifesteal > 0) game.player.heal(dmg * st.lifesteal);
        this.shotsHit++;
        game.stats.hits++;
        if (head) game.stats.headshots++;
        game.audio.hit(head || crit);
        game.ui.showHitmarker(head || crit, victim.hp <= 0);
        game.ui.showDamageNumber(end, Math.round(dmg), head, crit);
      } else if (hitT < st.range) {
        game.particles.burst(5, end.x, end.y, end.z, {
          spread: 1.8, up: 1.6, lifeMin: 0.12, lifeMax: 0.32,
          sizeMin: 0.012, sizeMax: 0.03, color: [0.9, 0.75, 0.5], grav: 12, drag: 2
        });
        game.particles.burst(3, end.x, end.y, end.z, {
          spread: 0.7, up: 0.9, lifeMin: 0.2, lifeMax: 0.5,
          sizeMin: 0.05, sizeMax: 0.11, color: [0.35, 0.33, 0.3], grav: 0.4, drag: 2.6
        });
        game.audio.impact();
      }
    }

    muzzleWorld() {
      this.model.updateMatrixWorld(true);
      return this.model.localToWorld(this.muzzleLocal.clone());
    }

    _flash() {
      this.flashT = 0.055;
      this.flash.visible = true;
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.rotation.y = rand(-0.35, 0.35);
      this.flash.scale.setScalar(rand(0.75, 1.35));
      const isFire = !!(this.game.build && this.game.build.perk && this.game.build.perk.id === 'fireman' && this.game.build.perkState && this.game.build.perkState.burning > 0);
      if (isFire) {
        this.flash.material.color.setHex(0xff3300);
        this.flashLight.color.setHex(0xff4400);
        this.flashLight.intensity = 3.6;
        const mw = this.muzzleWorld();
        this.game.particles.burst(6, mw.x, mw.y, mw.z, {
          spread: 0.8, up: 0.8, lifeMin: 0.06, lifeMax: 0.18,
          sizeMin: 0.03, sizeMax: 0.08, color: [1.0, 0.45, 0.05], grav: -1, drag: 2
        });
      } else {
        this.flash.material.color.setHex(0xffdd88);
        this.flashLight.color.setHex(0xffc060);
        this.flashLight.intensity = 2.4;
      }
    }

    update(dt, game) {
      if (this.cooldown > 0) this.cooldown -= dt;
      if (this.switching > 0) this.switching = Math.max(0, this.switching - dt);

      // reload timeline with audio cues
      this.reloadPhase = 0;
      if (this.reloading) {
        this.reloadT -= dt;
        const p = 1 - this.reloadT / this.stats.reloadTime;
        this.reloadPhase = p;
        if (this._reloadStage === 0 && p > 0.45) { this._reloadStage = 1; game.audio.reload('in'); }
        else if (this._reloadStage === 1 && p > 0.85) { this._reloadStage = 2; game.audio.reload('done'); }
        if (this.reloadT <= 0) this._finishReload();
      }

      /* ---- recoil: spring, not a teleport. Heavy weapons settle slower ---- */
      const stiff = (this.def.family === 'sniper' || this.def.family === 'rocket') ? 34 : 52;
      this.kickVel -= this.kick * stiff * dt;                 // spring back to 0
      this.kickVel -= this.kickVel * damp(15, dt);            // damping
      this.kick += this.kickVel * dt;
      this.kick = clamp(this.kick, -0.35, 2.2);
      this.rotKick = lerp(this.rotKick || 0, clamp(this.kick * 0.5, -0.3, 1.1), damp(18, dt));

      // muzzle flash fade
      if (this.flashT > 0) {
        this.flashT -= dt;
        this.flashLight.intensity = Math.max(0, this.flashT / 0.055) * 2.4;
        if (this.flashT <= 0) { this.flash.visible = false; this.flashLight.intensity = 0; }
      }

      if (!this.group.visible) return;

      const player = game.player;
      const t = game.time;

      /* ---- idle breathing: never fully still ---- */
      const breathe = player.planarSpeed < 0.5 && player.grounded ? 1 : 0.35;
      let sx = Math.sin(t * 1.15) * 0.006 * breathe + Math.sin(t * 0.63) * 0.004 * breathe;
      let sy = Math.cos(t * 0.9) * 0.005 * breathe;
      let sz = Math.sin(t * 0.8 + 1.3) * 0.004 * breathe;
      let rollIdle = Math.sin(t * 0.72) * 0.012 * breathe;

      // mouse sway
      sx += clamp(player.lookDX, -0.05, 0.05);
      sy += clamp(player.lookDY, -0.05, 0.05);

      /* ---- walk / sprint bob ---- */
      const sp = player.planarSpeed;
      const sprintBlend = damp(9, dt) * (player.sprinting ? 1 : 0);
      this.sprintAmt = lerp(this.sprintAmt || 0, player.sprinting ? 1 : 0, damp(8, dt));
      if (player.grounded && sp > 0.5) {
        const rate = player.sprinting ? 12.5 : 9.0;
        this.bobT += dt * rate * (0.5 + sp * 0.11);
        const amp = clamp(sp / 8, 0, 1) * (player.sprinting ? 0.030 : 0.019);
        sx += Math.sin(this.bobT) * amp * 1.5;
        sy += Math.abs(Math.sin(this.bobT * 2)) * amp;
        sz += Math.cos(this.bobT * 2) * amp * 0.8;
        rollIdle += Math.sin(this.bobT) * amp * 1.1;
      } else {
        this.bobT = lerp(this.bobT, 0, damp(7, dt));
      }

      const k = damp(15, dt);
      this.swayX = lerp(this.swayX, sx, k);
      this.swayY = lerp(this.swayY, sy, k);
      this.swayZ = lerp(this.swayZ || 0, sz, k);

      /* ---- airborne: weapon floats up on the rise, drops on the fall ---- */
      const airBlend = player.grounded ? 0 : 1;
      this.airAmt = lerp(this.airAmt || 0, airBlend, damp(7, dt));
      const vy = clamp(player.velocity.y, -12, 12);
      const airPitch = clamp(-vy * 0.012, -0.16, 0.12);
      const airY = clamp(vy * 0.004, -0.05, 0.05);

      /* ---- landing dip (driven by the camera spring) ---- */
      const dip = clamp(player.camDip, -0.26, 0.12);

      /* ---- reload stages ---- */
      let rlPos = 0, rlRot = 0, rlRoll = 0, magDrop = 0;
      if (this.reloading) {
        const p = this.reloadPhase;
        if (p < 0.22) {                       // tilt down, present the mag
          const k = p / 0.22;
          rlPos = k * 0.05; rlRot = k * 0.55; rlRoll = k * 0.18;
        } else if (p < 0.5) {                 // mag out
          const k = (p - 0.22) / 0.28;
          rlPos = 0.05 - k * 0.02; rlRot = 0.55; rlRoll = 0.18; magDrop = k;
        } else if (p < 0.74) {                // mag in + seat
          const k = (p - 0.5) / 0.24;
          rlPos = lerp(0.03, 0.05, k); rlRot = lerp(0.62, 0.5, k); rlRoll = lerp(0.18, 0.12, k);
          magDrop = 1 - k;
        } else if (p < 0.88) {                // charging tug
          const k = (p - 0.74) / 0.14;
          rlPos = lerp(0.05, 0.06, k); rlRot = lerp(0.5, 0.62, k); rlRoll = lerp(0.12, 0.2, k);
          magDrop = 0;
        } else {                               // return to ready
          const k = (p - 0.88) / 0.12;
          rlPos = (1 - k) * 0.06; rlRot = (1 - k) * 0.62; rlRoll = (1 - k) * 0.2;
        }
      }
      if (this.magMesh) {
        const hidden = magDrop > 0.02 ? -magDrop * 0.42 : 0;
        this.magMesh.position.y = this.magHomeY + hidden;
        this.magMesh.visible = magDrop < 0.98;
      }

      /* ================================================================
       * LAYERED VIEW-MODEL TRANSFORM
       * The pose is composed in a fixed order so no two effects ever add up
       * on top of each other:
       *
       *   base   = lerp(HIP_POSE, ADS_POSE, ads)      <- ADS is the base layer
       *   + bob       * (1 - ads)                     movement animation
       *   + sprint    * (1 - ads)                     sprint pose is released on ADS
       *   + recoil                                     always applied
       *   + lean      * (0.35 + 0.65*(1 - ads))       lean follows the camera
       *   + reload                                    tilts the gun for the mag
       * ============================================================== */
      const ads = clamp(player.adsAmt, 0, 1);
      const freeHand = 1 - ads;                       // suppressed while aiming

      const kickBack = Math.max(0, this.kick) * this.def.recoil.kick;
      const rotBack = this.rotKick;
      const leanAmt = player.leanAmt;

      // ---- layer 1: base pose (hip <-> ads) ----
      const bx = lerp(this.hipPos.x, this.adsPos.x, ads);
      const by = lerp(this.hipPos.y, this.adsPos.y, ads);
      const bz = lerp(this.hipPos.z, this.adsPos.z, ads);
      const brx = lerp(this.hipRot.x, this.adsRot.x, ads);
      const bry = lerp(this.hipRot.y, this.adsRot.y, ads);
      const brz = lerp(this.hipRot.z, this.adsRot.z, ads);

      // ---- layer 2: movement bob (walk / sprint), off while aiming ----
      const bkx = this.swayX * (0.25 + 0.75 * freeHand);
      const bky = this.swayY * (0.25 + 0.75 * freeHand);
      const bkz = this.swayZ * freeHand;
      const bRoll = rollIdle * freeHand;

      // ---- layer 3: sprint pose, fully released while aiming ----
      const sA = this.sprintAmt * freeHand;
      const spx = -sA * 0.055;      // lowered
      const spy = -sA * 0.02;
      const spz = sA * 0.03;
      const spPitch = -sA * 0.34;   // canted inwards
      const spYaw = sA * 0.12;
      const spRoll = -sA * 0.28;

      // ---- layer 4: lean (small while aiming, the camera does the work) ----
      const lScale = 0.35 + 0.65 * freeHand;
      const leanY = -leanAmt * 0.16 * lScale;
      const leanRoll = -leanAmt * 0.10 * lScale;

      // ---- layer 5: airborne + landing ----
      const airY2 = airY * freeHand;
      const airP = airPitch * freeHand;
      const dipY = -dip * 0.9 * freeHand;

      // ---- layer 6: reload (tilt the whole gun, drop the magazine) ----
      const rlScale = 1 - ads * 0.8;                // almost off while aiming
      const rlx = rlRoll * 0.5 * rlScale;
      const rly = -rlPos * rlScale;
      const rlz = rlPos * 0.25 * rlScale;
      const rlPitch = rlRot * rlScale;

      this.group.position.set(
        bx + bkx + spx + leanY * 0.35 + rlx + kickBack * 0 + this.rotKick * 0.0,
        by + bky + spy + rly + airY2 + dipY,
        bz + bkz + spz + rlz + kickBack
      );
      this.group.rotation.set(
        brx + bRoll * 0 + spPitch + rlPitch + airP - rotBack * 0.55 - Math.max(0, this.kick) * 0.05,
        bry + bky * 1.5 + spYaw + leanY,
        brz + bRoll + spRoll + leanRoll + rlRoll * 0.5 + rotBack * 0.06
      );
    }

    reset() {
      this.inst.refill();
      this.reloading = false;
      this.reloadT = 0;
      this.cooldown = 0;
      this.kick = 0;
      this.shotsFired = 0;
      this.shotsHit = 0;
      this.group.visible = false;
      this.flash.visible = false;
      this.flashLight.intensity = 0;
    }

    refill() {
      this.inst.refill();
      this.reloading = false;
      this.reloadT = 0;
    }

    dispose() {
      if (!this.group) return;
      this.camera.remove(this.group);
      while (this.model.children.length) {
        const c = this.model.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material && c.material.dispose) c.material.dispose();
      }
      this.group = null;
    }
  }

  /* ======================================================= LOOT & PICKUPS */

  /** weighted pick from an array using a weight accessor */
  function weightedPick(list, weightOf) {
    let total = 0;
    for (let i = 0; i < list.length; i++) total += Math.max(0, weightOf(list[i], i));
    if (total <= 0) return list[0];
    let roll = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      roll -= Math.max(0, weightOf(list[i], i));
      if (roll <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /** which modifiers make sense for each weapon family */
  const TYPE_MOD_POOL = FAMILY_MOD_POOL;

  class LootSystem {
    constructor(game) {
      this.game = game;
      this.dropChance = 0.15;        // base chance an enemy drops a weapon
      this.armorChance = 0.13;
      this.ammoChance = 0.30;
    }

    /** stage + luck shift the weight curve towards the higher rarities */
    rollRarity(stage, luck) {
      const boost = 1 + (stage - 1) * 0.17 + (luck || 0);
      return weightedPick(RARITIES, (r, i) => r.weight * Math.pow(boost, i));
    }

    rollType(stage) {
      const avail = Object.keys(TYPE_UNLOCK_STAGE)
        .filter((id) => stage >= TYPE_UNLOCK_STAGE[id])
        .map((id) => WEAPON_TYPES[id]);
      return weightedPick(avail, (t) => t.weight || 10);
    }

    rollMods(rarity, typeId, count) {
      const pool = (FAMILY_MOD_POOL[WEAPON_TYPES[typeId].family] || []).map((id) => MOD_BY_ID[id]).filter(Boolean);
      const out = [];
      const want = Math.min(count, pool.length);
      const available = pool.slice();
      while (out.length < want && available.length) {
        // higher-tier mods are rarer within a weapon too
        const pick = weightedPick(available, (m) => {
          const heavy = m.mul && (m.mul.damage || 1) > 1.1 ? 0.6 : 1;
          const rate = m.mul && (m.mul.fireRate || 1) > 1.1 ? 0.8 : 1;
          return heavy * rate;
        });
        out.push(pick.id);
        available.splice(available.indexOf(pick), 1);
      }
      return out;
    }

    /** magazine + attachment rolls for a freshly rolled weapon */
    rollMagazine(rarity, typeId) {
      const t = WEAPON_TYPES[typeId];
      const score = RARITIES.indexOf(rarity) / (RARITIES.length - 1);
      // shotguns keep tube/box mags, snipers keep small ones
      if (t.family === 'shotgun') return score > 0.7 ? 'extended' : 'standard';
      if (t.family === 'sniper') return score > 0.8 ? 'quick' : 'standard';
      return weightedPick(Object.keys(MAGAZINES), (id) => {
        const w = {
          standard: 58, extended: 22 + score * 14, quick: 8 + score * 8,
          drum: 3 + score * 12, hvel: 5 + score * 8
        };
        return w[id] || 1;
      });
    }

    rollAttachments(rarity, typeId) {
      const t = WEAPON_TYPES[typeId];
      const score = RARITIES.indexOf(rarity) / (RARITIES.length - 1);
      const atts = { optic: 'none', muzzle: 'none', grip: 'none' };
      // the gun keeps its own optic unless an optic attachment rolls
      const opticPool = Object.keys(ATTACHMENTS.optic).filter((k) => k !== 'none');
      if (Math.random() < 0.25 + score * 0.5) {
        atts.optic = weightedPick(opticPool, (k) => {
          const o = OPTICS[ATTACHMENTS.optic[k].optic];
          if (!o) return 1;
          if (t.family === 'sniper') return o.zoom >= 4 ? 14 : 2;
          if (t.family === 'ar' || t.family === 'dmr') return o.zoom >= 4 ? 8 : (o.zoom >= 2 ? 6 : 10);
          return o.zoom >= 2 ? 3 : 9;
        });
      }
      if (Math.random() < 0.18 + score * 0.35) {
        atts.muzzle = weightedPick(['compensator', 'brake', 'suppressor'], (k) =>
          k === 'compensator' ? 10 : k === 'brake' ? 6 : (t.family === 'sniper' ? 8 : 3));
      }
      if (Math.random() < 0.16 + score * 0.3) {
        atts.grip = weightedPick(['vertical', 'angled'], (k) => (k === 'vertical' ? 10 : 7));
      }
      return atts;
    }

    /** build a full weapon instance from the weighted rolls */
    create(stage, luck, forcedRarityId, ammoFrac) {
      const type = this.rollType(stage);
      const rarity = forcedRarityId ? RARITY_BY_ID[forcedRarityId] : this.rollRarity(stage, luck);
      const mods = this.rollMods(rarity, type.id, rarity.mods);
      const magId = this.rollMagazine(rarity, type.id);
      const atts = this.rollAttachments(rarity, type.id);
      return new WeaponInstance(type.id, rarity.id, mods, ammoFrac, magId, atts);
    }

    /* ------------------------------ armour ------------------------------ */

    rollArmorKind() {
      return weightedPick(ARMOR_KIND_LIST, (k) => (k === 'helmet' ? 30 : k === 'vest' ? 42 : 28));
    }

    rollArmorMods(rarity, count) {
      const pool = ARMOR_MODS.map((m) => m.id);
      const out = [];
      while (out.length < Math.min(count, 3) && pool.length) {
        const pick = weightedPick(pool, () => 1);
        out.push(pick);
        pool.splice(pool.indexOf(pick), 1);
      }
      return out;
    }

    createArmor(stage, luck, forcedRarityId) {
      const kindId = this.rollArmorKind();
      const rarity = forcedRarityId ? RARITY_BY_ID[forcedRarityId] : this.rollRarity(stage, luck);
      const rs = armorRarityStats(rarity.id);
      return new ArmorInstance(kindId, rarity.id, this.rollArmorMods(rarity, rs.modCount));
    }

    rollAmmoType(stage) {
      const unlocked = AMMO_IDS.filter((id) => {
        if (id === 'rocket') return stage >= 5;
        if (id === '.50') return stage >= 6;
        if (id === '7.62') return stage >= 2;
        return true;
      });
      return weightedPick(unlocked, (id) => {
        const w = { '9mm': 30, '5.56': 28, '7.62': 16, '12ga': 18, '.50': 6, rocket: 4 };
        return w[id] || 5;
      });
    }

    /** chance an enemy drops a weapon at all */
    shouldDrop(enemy) {
      let chance = this.dropChance;
      if (enemy.type.mode === 'melee' && enemy.type.key !== 'grunt') chance += 0.12;
      if (enemy.type.key === 'tank' || enemy.type.key === 'heavy') chance += 0.2;
      if (enemy.type.key === 'boss') return true;         // bosses always drop
      return Math.random() < chance;
    }

    /** what a kill drops: 'weapon' | 'armor' | 'ammo' | null */
    rollDrop(enemy, stage, luck) {
      void stage;
      if (enemy.type.key === 'boss') {
        const r = Math.random();
        return r < 0.5 ? 'weapon' : (r < 0.78 ? 'armor' : 'ammo');
      }
      if (this.shouldDrop(enemy)) return 'weapon';
      const heavyBonus = (enemy.type.key === 'tank' || enemy.type.key === 'heavy') ? 0.15 : 0;
      if (Math.random() < this.armorChance + heavyBonus + (luck || 0) * 0.2) return 'armor';
      if (Math.random() < this.ammoChance) return 'ammo';
      return null;
    }
  }

  /* --------------------------- world pickup --------------------------- */

  const _pickupMatCache = Object.create(null);
  function pickupMaterial(color, emissive) {
    const key = color + '|' + emissive;
    if (!_pickupMatCache[key]) {
      _pickupMatCache[key] = new THREE.MeshLambertMaterial({ color: color, emissive: emissive });
    }
    return _pickupMatCache[key];
  }

  /* A pickup holds one of three things: a weapon instance, an armour piece or
   * an ammo box. The visual + prompt are driven by `kind`. */
  class Pickup {
    constructor(payload, pos, game, drop) {
      this.kind = payload.kind || 'weapon';
      this.inst = payload.inst;                 // WeaponInstance | ArmorInstance | null
      this.ammoId = payload.ammoId || null;
      this.amount = payload.amount || 0;
      this.game = game;
      this.position = pos.clone();
      this.taken = false;
      this.age = 0;
      this.spawnPop = 0;
      this.flying = 0;            // >0 while it flies into the player
      this.flyFrom = new THREE.Vector3();
      this.groundY = pos.y;
      // a dropped item arcs out of the corpse before settling
      this.dropVel = drop ? 3.4 + Math.random() * 1.6 : 0;
      this.dropSpin = drop ? rand(6, 12) : 0;
      this.spin = 0;
      this.highlight = 0;

      const rar = this.rarity();
      const g = new THREE.Group();
      g.position.copy(this.position);

      const bodyMat = pickupMaterial(rar.color, rar.id === 'common' ? 0x000000 : 0x101c26);
      const dark = pickupMaterial(0x24282e, 0x000000);
      const add = (sx, sy, sz, x, y, z, mat) => {
        const m = new THREE.Mesh(boxGeo(sx, sy, sz), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        g.add(m);
        return m;
      };

      if (this.kind === 'weapon') {
        // compact silhouette from the weapon's own primitive list
        const parts = this.inst.type.model;
        for (let i = 0; i < parts.length; i += 2) {
          const p = parts[i];
          if (p[0] === P_MAG) continue;                  // skip the magazine part
          const shrink = 0.85;
          add(p[1] * shrink, p[2] * shrink, p[3], p[4], p[5], p[6], p[0] === P_WOOD ? bodyMat : dark);
        }
        add(0.16, 0.03, 0.3, 0, 0.09, 0, bodyMat);      // rarity spine
      } else if (this.kind === 'armor') {
        const slot = this.inst.slot;
        if (slot === 'helmet') {
          add(0.26, 0.22, 0.28, 0, 0.06, 0, bodyMat);
          add(0.28, 0.05, 0.3, 0, -0.05, 0, dark);
          add(0.1, 0.06, 0.02, 0, 0.02, -0.15, dark);
        } else if (slot === 'body') {
          add(0.3, 0.34, 0.16, 0, 0.02, 0, bodyMat);
          add(0.22, 0.1, 0.18, 0, 0.2, 0, dark);
          add(0.26, 0.06, 0.17, 0, -0.14, 0, dark);
        } else {
          add(0.13, 0.12, 0.3, -0.07, -0.02, 0, bodyMat);
          add(0.13, 0.12, 0.3, 0.07, -0.02, 0, bodyMat);
          add(0.26, 0.06, 0.32, 0, 0.05, 0, dark);
        }
      } else {
        // ammo box
        add(0.3, 0.18, 0.2, 0, 0, 0, bodyMat);
        add(0.32, 0.05, 0.22, 0, 0.06, 0, dark);
        add(0.06, 0.06, 0.22, 0.1, 0.1, 0, dark);
        add(0.06, 0.06, 0.22, -0.1, 0.1, 0, dark);
      }
      g.scale.setScalar(1.3);

      // rarity ring on the ground + glow for anything above common
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.56, 20),
        new THREE.MeshBasicMaterial({
          color: rar.color, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(ring);
      this.ring = ring;

      if (rar.id !== 'common') {
        const light = new THREE.PointLight(rar.color, 0.85, 5.5, 2);
        light.position.y = 0.5;
        g.add(light);
        this.light = light;
      }
      // slim vertical wisp so rare drops read from across the arena
      const beamH = rar.id === 'common' ? 0.35 : 0.85;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.13, beamH, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: rar.color, transparent: true, opacity: rar.id === 'common' ? 0.07 : 0.11,
          depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
        })
      );
      beam.position.y = beamH / 2 + 0.1;
      g.add(beam);
      this.beam = beam;

      this.mesh = g;
      g.scale.setScalar(0.01);
      game.scene.add(g);
    }

    rarity() {
      if (this.kind === 'weapon') return this.inst.rarity;
      if (this.kind === 'armor') return this.inst.rarity;
      return { id: 'ammo', name: 'AMMO', color: 0xd8c26a, css: '#d8c26a' };
    }

    /** label + detail lines for the pickup prompt */
    info() {
      if (this.kind === 'weapon') {
        const inst = this.inst;
        const st = inst.stats;
        const lines = [
          ['Damage', st.damage.toFixed(0)],
          ['Fire Rate', st.fireRate.toFixed(1)],
          ['Magazine', st.magazine + ' (' + inst.magazine.name + ')'],
          ['Reload', st.reloadTime.toFixed(2) + 's'],
          ['Ammo', inst.ammo.name]
        ];
        return { title: inst.displayName, color: inst.rarity.css, lines: lines, mods: inst.mods, atts: inst.attachmentList() };
      }
      if (this.kind === 'armor') {
        return { title: this.inst.displayName, color: this.inst.rarity.css, lines: this.inst.summary(), mods: [], atts: [] };
      }
      const a = AMMO_TYPES[this.ammoId];
      return {
        title: a.name + ' x' + this.amount, color: '#d8c26a',
        lines: [['Amount', '+' + this.amount], ['Reserve', this.game.player.ammoPool(this.ammoId)]],
        mods: [], atts: []
      };
    }

    update(dt, targeted) {
      this.age += dt;
      this.spawnPop = Math.min(1, this.spawnPop + dt * 3.4);
      const pop = 1 - Math.pow(1 - this.spawnPop, 3);

      /* ---- loot drop: arcs out of the corpse, then settles ---- */
      let y = this.groundY + 0.55;
      if (this.dropVel > 0.01) {
        this.dropVel -= 15 * dt;
        y = this.groundY + 0.55 + Math.max(0, this.dropVel) * 0.14;
        this.spin += this.dropSpin * dt;
        if (this.dropVel <= 0.01) { this.dropVel = 0; this.spin = 0; }
      }

      /* ---- picked up: fly into the player and shrink away ---- */
      if (this.flying > 0) {
        this.flying -= dt;
        const k = clamp(1 - this.flying / 0.18, 0, 1);
        this.mesh.position.lerpVectors(this.flyFrom, this.game.camera.position, k * k);
        this.mesh.scale.setScalar(Math.max(0.02, pop * (1 - k)));
        this.mesh.rotation.y += dt * 14;
        if (this.flying <= 0) this.dispose();
        return;
      }

      /* ---- idle: float + slow spin, brighter while the player looks at it ---- */
      this.highlight = lerp(this.highlight, targeted ? 1 : 0, damp(11, dt));
      const hover = Math.sin(this.age * 2.2) * 0.09 + this.highlight * 0.05;
      this.mesh.scale.setScalar(pop * 1.3 * (1 + this.highlight * 0.15));
      this.mesh.position.set(this.position.x, y + hover, this.position.z);
      this.mesh.rotation.y += dt * (1.25 + this.highlight * 2.2);
      this.ring.rotation.z += dt * 0.7;
      this.ring.scale.setScalar(0.9 + Math.sin(this.age * 3) * 0.08 + this.highlight * 0.22);
      this.ring.material.opacity = 0.55 + this.highlight * 0.4;
      if (this.light) this.light.intensity = (0.7 + Math.sin(this.age * 4) * 0.2) * (1 + this.highlight * 1.1);
      if (this.beam) {
        const rar0 = this.rarity();
        const base = rar0.id === 'common' ? 0.05 : 0.09;
        this.beam.material.opacity = base + Math.sin(this.age * 2.6) * 0.02 + this.highlight * 0.14;
        this.beam.scale.set(1 + this.highlight * 0.5, 1 + this.highlight * 0.6, 1 + this.highlight * 0.5);
      }
    }

    /** remove from the world and release per-pickup geometries
     *  (materials are shared through the pickupMaterial cache) */
    dispose() {
      if (this.taken) return;
      this.taken = true;
      this.game.scene.remove(this.mesh);
      this.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.mesh = null;
    }

    take() {
      if (this.taken) return;
      const rar = this.rarity();
      this.game.particles.burst(12, this.position.x, this.position.y + 0.6, this.position.z, {
        spread: 1.4, up: 2.2, lifeMin: 0.15, lifeMax: 0.4,
        sizeMin: 0.02, sizeMax: 0.06,
        color: [(rar.color >> 16 & 255) / 255, (rar.color >> 8 & 255) / 255, (rar.color & 255) / 255],
        grav: 2, drag: 2.4
      });
      // arc into the player instead of blinking out of existence
      this.flyFrom.copy(this.mesh.position);
      this.flying = 0.18;
      this.ring.visible = false;
      if (this.beam) this.beam.visible = false;
    }
  }

  /* ===================================================== PROJECTILES */

  /** pooled rockets / explosive rounds (used by the rocket launcher) */
  class ProjectileSystem {
    constructor(game) {
      this.game = game;
      this.max = 16;
      this.list = [];
      const geo = new THREE.CylinderGeometry(0.09, 0.11, 0.42, 8);
      geo.rotateX(Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb04a });
      const trailMat = new THREE.MeshBasicMaterial({
        color: 0xff7a2a, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      for (let i = 0; i < this.max; i++) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(geo, mat);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 8), mat);
        tip.rotation.x = -Math.PI / 2;
        tip.position.z = -0.3;
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), trailMat);
        glow.position.z = 0.18;
        g.add(body); g.add(tip); g.add(glow);
        const light = new THREE.PointLight(0xff8030, 1.4, 6, 2);
        g.add(light);
        g.visible = false;
        game.scene.add(g);
        this.list.push({
          mesh: g, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
          life: 0, cfg: null, light: light, trailT: 0
        });
      }
    }

    spawn(origin, dir, cfg) {
      for (let i = 0; i < this.max; i++) {
        const p = this.list[i];
        if (p.active) continue;
        p.active = true;
        p.pos.copy(origin);
        p.vel.copy(dir).multiplyScalar(cfg.speed);
        p.life = 6;
        p.cfg = cfg;
        p.mesh.visible = true;
        p.mesh.position.copy(origin);
        p.trailT = 0;
        return p;
      }
      return null;
    }

    update(dt) {
      const game = this.game;
      for (let i = 0; i < this.max; i++) {
        const p = this.list[i];
        if (!p.active) continue;
        p.life -= dt;
        const step = p.vel.clone().multiplyScalar(dt);
        const dist = step.length();

        // world hit along this step
        const worldT = game.collision.rayWorld(p.pos, p.vel.clone().normalize(), dist + p.cfg.radius);
        let hitT = worldT, victim = null, head = false;

        for (let e = 0; e < game.enemies.length; e++) {
          const en = game.enemies[e];
          if (!en.alive || en.spawnT < 1) continue;
          const th = rayAABB(p.pos, p.vel.clone().normalize(), en.hitBody.min, en.hitBody.max, hitT);
          const hh = rayAABB(p.pos, p.vel.clone().normalize(), en.hitHead.min, en.hitHead.max, hitT);
          if (hh < hitT) { hitT = hh; victim = en; head = true; }
          else if (th < hitT) { hitT = th; victim = en; head = false; }
        }

        p.pos.addScaledVector(p.vel.clone().normalize(), Math.min(hitT, dist));
        p.mesh.position.copy(p.pos);
        p.mesh.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
        p.trailT -= dt;
        if (p.trailT <= 0) {
          p.trailT = 0.02;
          game.particles.burst(1, p.pos.x, p.pos.y, p.pos.z, {
            spread: 0.3, up: 0.3, lifeMin: 0.12, lifeMax: 0.3,
            sizeMin: 0.05, sizeMax: 0.1, color: [1.0, 0.55, 0.2], grav: 0, drag: 3
          });
        }

        if (victim || hitT <= dist + p.cfg.radius || p.life <= 0) {
          const at = victim ? p.pos.clone() : p.pos.clone();
          if (victim) {
            game.audio.impact();
            game.tracers.add(p.pos, at, 1, 0.6, 0.2, 0.1);
          }
          this._explode(p.pos, p.cfg, victim, head, game);
          this._recycle(p);
        }
      }
    }

    _explode(at, cfg, directVictim, head, game) {
      const dmg = cfg.splashDamage;
      game.particles.burst(30, at.x, at.y + 0.2, at.z, {
        spread: cfg.splash * 0.9, up: 2.4, lifeMin: 0.2, lifeMax: 0.7,
        sizeMin: 0.05, sizeMax: 0.16, color: [1.0, 0.6, 0.2], grav: 5, drag: 1.8
      });
      game.particles.burst(14, at.x, at.y + 0.2, at.z, {
        spread: cfg.splash * 0.5, up: 1.4, lifeMin: 0.3, lifeMax: 0.9,
        sizeMin: 0.1, sizeMax: 0.22, color: [0.25, 0.22, 0.2], grav: 0.6, drag: 2.2
      });
      game.addShake(0.55);
      game.audio.tone(game.audio.t, 0.34, 150, 40, 0.4, 'sawtooth');

      // splash damage falls off with distance
      for (let i = 0; i < game.enemies.length; i++) {
        const e = game.enemies[i];
        if (!e.alive || e.spawnT < 1) continue;
        const d = e.position.distanceTo(at);
        if (d > cfg.splash) continue;
        const k = 1 - d / cfg.splash;
        const dir = new THREE.Vector3().subVectors(e.position, at).normalize();
        e.takeDamage(dmg * k * k, dir, false, game);
        e.knock.addScaledVector(dir, 2.2 * k);          // blast push
      }
      // the player is not immune to its own rockets
      const pl = game.player;
      const pd = pl.position.distanceTo(at);
      if (pd < cfg.splash && pl.alive) {
        const dir = new THREE.Vector3().subVectors(pl.position, at).normalize();
        pl.damage(dmg * 0.28 * (1 - pd / cfg.splash), at, false, { type: 'rocket_splash', sourcePosition: at });
        pl.knockFromBlast = dir.multiplyScalar(4 * (1 - pd / cfg.splash));
      }
    }

    _recycle(p) {
      p.active = false;
      p.mesh.visible = false;
      p.light.intensity = 0;
    }

    clear() { for (let i = 0; i < this.max; i++) this._recycle(this.list[i]); }
  }

  /* ====================================================================
   * BUILD SYSTEM  TRAILS (passive, max 3) + PERKS (one active, F key)
   *
   * Both feed the SAME stat pipeline the game already uses: a trail or perk
   * returns a { mul, add } modifier, `combineMods` folds them into the player's
   * modifier set, and `resolveStats` applies it to player and weapon stats.
   * Nothing writes damage/speed directly.
   * ==================================================================== */

  /* ------------------------------- caps ------------------------------- */
  const BUILD_CAPS = {
    moveSpeed: 2.1,          // total movement multiplier ceiling
    damage: 4.0,             // total weapon damage multiplier ceiling
    fireRate: 2.6,
    adsSpread: 0.12,         // ADS can never widen the cone
    damageReduction: 0.80,   // armor + guardian together
    healPerSec: 40,
    dogtag: 10,
    heat: 100,
    trails: 3
  };

  /* =============================== TRAILS ============================== */
  /* Each trail keeps its own runtime state in `player.trailState[i]` and
   * exposes `update(dt, ctx)` plus `mods(ctx)`. ctx = { player, game, dt } */

  const TRAILS = [
    {
      id: 'impatient', name: 'IMPATIENT', glyph: '⚡', rarity: 'common',
      desc: 'Move continuously to gain speed (+5% base, up to +15%).',
      init: () => ({ t: 0, bonus: 0 }),
      update: (s, dt, ctx) => {
        const p = ctx.player;
        const moving = p.grounded && p.planarSpeed > 0.6;
        s.t = moving ? s.t + dt : 0;
        const ramp = clamp(s.t / 6, 0, 1);
        s.bonus = 0.05 + ramp * 0.10;
        return s.t > 1.5;
      },
      mods: (s) => ({ mul: { moveSpeed: 1 + s.bonus } }),
      status: (s) => ({ text: 'SPEED +' + Math.round(s.bonus * 100) + '%', on: s.t > 1.5 })
    },
    {
      id: 'survival', name: 'SURVIVAL', glyph: '❤', rarity: 'common',
      desc: 'Take no damage for 10s to heal 8% max HP.',
      init: () => ({ t: 0, healT: 0 }),
      update: (s, dt, ctx) => {
        const p = ctx.player;
        s.t += dt;
        if (s.t >= 10) {
          s.t -= 10;
          if (ctx.build && ctx.build.survivalBlocked()) return true;
          const heal = Math.min(p.maxHealth - p.health, p.maxHealth * 0.08);
          if (heal > 0) {
            p.heal(heal);
            ctx.game.ui.showBuffToast('SURVIVAL', '+' + Math.round(heal) + ' HP');
          }
          s.healT = 1.2;
        }
        if (s.healT > 0) s.healT -= dt;
        return true;
      },
      onDamage: () => { /* handled by TrailSystem: resets the timer */ },
      mods: () => ({ mul: {} }),
      status: (s) => ({ text: s.t >= 8 ? 'HEALING' : Math.ceil(10 - s.t) + 's', on: s.t >= 8 })
    },
    {
      id: 'hunter', name: 'HUNTER', glyph: '🎯', rarity: 'rare',
      desc: 'More enemies alive = more damage (+5% to +30%).',
      init: () => ({ bonus: 0 }),
      update: (s, dt, ctx) => {
        const n = ctx.game.aliveEnemyCount();
        s.bonus = n <= 3 ? 0.05 : n <= 6 ? 0.10 : n <= 10 ? 0.20 : 0.30;
        return n > 3;
      },
      mods: (s, ctx, syn) => ({ mul: { damage: 1 + Math.min(syn.hunterCap, s.bonus + (syn.bloodlustBonus || 0)) } }),
      status: (s) => ({ text: '+' + Math.round(s.bonus * 100) + '% DAMAGE', on: s.bonus > 0.06 })
    },
    {
      id: 'berserker', name: 'BERSERKER', glyph: '🦓', rarity: 'rare',
      desc: 'Lower HP = more damage (up to +50% at 20% HP).',
      init: () => ({ bonus: 0 }),
      update: (s, dt, ctx) => {
        const miss = 1 - clamp(ctx.player.health / ctx.player.maxHealth, 0, 1);
        s.bonus = miss <= 0.5 ? miss * 0.4 : 0.20 + (miss - 0.5) * 0.6;
        return miss > 0.25;
      },
      mods: (s) => ({ mul: { damage: 1 + s.bonus } }),
      status: (s) => ({ text: '+' + Math.round(s.bonus * 100) + '% DAMAGE', on: s.bonus > 0.08 })
    },
    {
      id: 'scavenger', name: 'SCAVENGER', glyph: '🧰', rarity: 'uncommon',
      desc: 'Kills can drop extra ammo, armour or attachments.',
      init: () => ({ drops: 0 }),
      update: (s) => true,
      onKill: (s, enemy, game) => {
        s.drops++;
        game.scavengerDrop(enemy);
      },
      mods: () => ({ mul: {} }),
      status: (s) => ({ text: s.drops + ' LOOTED', on: s.drops > 0 })
    },
    {
      id: 'momentum', name: 'MOMENTUM', glyph: '💨', rarity: 'uncommon',
      desc: 'Dashing grants +15% fire rate and +10% speed for 3s (3 stacks).',
      init: () => ({ stacks: 0, t: 0 }),
      update: (s, dt, ctx) => {
        if (s.t > 0) s.t -= dt;
        else s.stacks = 0;
        return s.stacks > 0;
      },
      onDash: (s, ctx) => {
        s.stacks = Math.min(3, s.stacks + 1);
        s.t = 3;
      },
      mods: (s) => ({ mul: { fireRate: 1 + s.stacks * 0.15, moveSpeed: 1 + s.stacks * 0.10 } }),
      status: (s) => ({ text: 'x' + s.stacks + ' FIRE RATE', on: s.stacks > 0 })
    },
    {
      id: 'bloodlust', name: 'BLOODLUST', glyph: '🧨', rarity: 'rare',
      desc: 'Each kill grants +3% damage (5 stacks, decays if you stop killing).',
      init: () => ({ stacks: 0, t: 0 }),
      update: (s, dt) => {
        if (s.t > 0) { s.t -= dt; if (s.t <= 0) s.stacks = 0; }
        return s.stacks > 0;
      },
      onKill: (s) => { s.stacks = Math.min(5, s.stacks + 1); s.t = 5; },
      mods: (s) => ({ mul: { damage: 1 + s.stacks * 0.03 } }),
      status: (s) => ({ text: '+' + (s.stacks * 3) + '% DAMAGE', on: s.stacks > 0 })
    },
    {
      id: 'guardian', name: 'GUARDIAN', glyph: '🛡', rarity: 'uncommon',
      desc: 'Standing still grants +20% damage reduction.',
      init: () => ({ still: 0, on: false }),
      update: (s, dt, ctx) => {
        const p = ctx.player;
        s.on = p.grounded && p.planarSpeed < 0.6 && p.alive;
        s.still = s.on ? s.still + dt : 0;
        return s.on;
      },
      mods: (s) => (s.on ? { mul: { damageReduction: 1.20 } } : { mul: {} }),
      status: (s) => ({ text: '+20% ARMOR', on: s.on })
    },
    {
      id: 'predator', name: 'PREDATOR', glyph: '🐺', rarity: 'epic',
      desc: 'Hitting enemies from behind deals +35% damage.',
      init: () => ({ hits: 0 }),
      update: (s) => true,
      mods: () => ({ mul: {} }),
      status: (s) => ({ text: s.hits + ' BACKSTABS', on: s.hits > 0 })
    },
    {
      id: 'adrenaline', name: 'ADRENALINE', glyph: '⚡', rarity: 'rare',
      desc: 'Below 40% HP: +20% movement speed and +15% fire rate.',
      init: () => ({ on: false }),
      update: (s, dt, ctx) => {
        const p = ctx.player;
        s.on = p.health < p.maxHealth * 0.4;
        return s.on;
      },
      mods: (s) => (s.on ? { mul: { moveSpeed: 1.20, fireRate: 1.15 } } : { mul: {} }),
      status: (s) => ({ text: '+20% SPD +15% RATE', on: s.on })
    },
    {
      id: 'tactician', name: 'TACTICIAN', glyph: '🎯', rarity: 'epic',
      desc: 'While aiming: +10% damage and +10% accuracy.',
      init: () => ({ on: false, dashBonus: 0 }),
      update: (s, dt, ctx) => {
        s.on = ctx.player.adsAmt > 0.5;
        if (s.dashBonus > 0) s.dashBonus -= dt;
        return s.on || s.dashBonus > 0;
      },
      onDash: (s) => { s.dashBonus = 1.2; },
      mods: (s) => (s.on
        ? { mul: { damage: 1.10, adsSpread: 0.90 } }
        : (s.dashBonus > 0 ? { mul: { damage: 1.05, adsSpread: 0.95 } } : { mul: {} })),
      status: (s) => ({ text: s.on ? '+10% DMG +10% ACC' : 'AIM READY', on: s.on })
    }
  ];
  const TRAIL_BY_ID = {};
  for (let i = 0; i < TRAILS.length; i++) TRAIL_BY_ID[TRAILS[i].id] = TRAILS[i];

  /* ============================== SYNERGY ============================== */
  /* Small, bounded set. Each returns extra modifiers / overrides. */
  const SYNERGIES = [
    { id: 'impatient_momentum', a: 'impatient', b: 'momentum', name: 'MOMENTUM SURGE', desc: 'Dash while sprinting: +25% movement speed for 3s.' },
    { id: 'survival_guardian', a: 'survival', b: 'guardian', name: 'BULWARK', desc: 'Healing while standing still is 50% faster.' },
    { id: 'hunter_bloodlust', a: 'hunter', b: 'bloodlust', name: 'PACK HUNT', desc: 'Hunter + Bloodlust stack, capped at +60% damage.' },
    { id: 'fireman_survival', a: 'fireman', b: 'survival', name: 'FLAMMABLE', desc: 'Survival cannot heal you while Fire Man heat is above 80%.' },
    { id: 'samurai_impatient', a: 'samurai', b: 'impatient', name: 'RELENTLESS', desc: 'Dogtag speed stacks cap at 6 instead of 10.' },
    { id: 'phantom_momentum', a: 'phantom', b: 'momentum', name: 'GHOSTSTEP', desc: 'Phantom lasts +0.8s and its dash buff lasts longer.' },
    { id: 'medic_survival', a: 'medic', b: 'survival', name: 'SUSTAIN', desc: 'All healing is capped at 12 HP/s while both are equipped.' }
  ];

  /* =============================== PERKS =============================== */
  /* One active perk, bound to F. Every perk owns its runtime state in
   * `player.perk` (heat, dogtags, mask, timers) so it can be reset on restart
   * and asserted for finiteness in the tests.                                */

  const PERK_CD = { fireman: 0.8, samurai: 1.5, executioner: 14, phantom: 16, medic: 15, gravity: 13, engineer: 18 };

  const SAMURAI_RECOVERY_DURATIONS = [
    1.50, // 0 dogtags: slowest (rate ~0.67/s)
    1.35, // 1 dogtag:  slow (~0.74/s)
    1.20, // 2 dogtags: slow (~0.83/s)
    0.85, // 3 dogtags: faster (~1.18/s)
    0.70, // 4 dogtags: progressively faster (~1.43/s)
    0.55, // 5 dogtags (~1.82/s)
    0.42, // 6 dogtags (~2.38/s)
    0.30, // 7 dogtags (~3.33/s)
    0.20, // 8 dogtags (~5.00/s)
    0.10  // 9 dogtags (~10.00/s)
          // 10 dogtags: instant (0.0s / Infinity)
  ];

  function getSamuraiRecoveryRate(dogtags) {
    const d = Math.max(0, Math.min(10, Math.floor(dogtags || 0)));
    if (d >= 10) return Infinity;
    const dur = SAMURAI_RECOVERY_DURATIONS[d] !== undefined ? SAMURAI_RECOVERY_DURATIONS[d] : 1.50;
    return 1 / dur;
  }

  const PERKS = [
    {
      id: 'fireman', name: 'FIRE MAN', glyph: '🔥', rarity: 'rare',
      desc: 'Hold F to ignite: bullets burn, but HEAT reaching 100% kills you.',
      cd: PERK_CD.fireman,
      onEquip: (p) => { p.heat = 0; p.burning = 0; },
      update: (p, dt, g) => {
        if (p.burning > 0) {
          p.heat = Math.min(BUILD_CAPS.heat, p.heat + 12 * dt);
          p.burning -= dt;
          p.auraT = (p.auraT || 0) - dt;
          if (p.auraT <= 0) {                       // throttled fire aura
            p.auraT = 0.06;
            const pl = g.player;
            g.particles.burst(2, pl.position.x + rand(-0.3, 0.3), pl.position.y + 0.8 + rand(0, 1),
              pl.position.z + rand(-0.3, 0.3), {
                spread: 0.4, up: 1.1, lifeMin: 0.18, lifeMax: 0.45,
                sizeMin: 0.05, sizeMax: 0.13,
                color: [1.0, 0.45 + Math.random() * 0.3, 0.1], grav: -1.2, drag: 1.4
              });
          }
          if (p.heat >= BUILD_CAPS.heat) {          // OVERHEAT: hard game over
            p.heat = BUILD_CAPS.heat;
            if (g.perkVisuals) g.perkVisuals.onOverheat();
            g.audio.tone(g.audio.t, 0.5, 90, 30, 0.9, 'sawtooth');
            g.addShake(1.0);
            g.particles.burst(60, g.player.position.x, g.player.position.y + 1,
              g.player.position.z, {
                spread: 3, up: 3, lifeMin: 0.3, lifeMax: 1.0,
                sizeMin: 0.06, sizeMax: 0.22, color: [1.0, 0.5, 0.1], grav: 4, drag: 1.4
              });
            g.player.damage(99999, null, false);
            g.ui.showBuffToast('OVERHEAT', 'GAME OVER');
          }
          if (p.heat > 80) p.warned = true;
        } else {
          p.heat = Math.max(0, p.heat - 8 * dt);
        }
        return p.burning > 0;
      },
      /* called by Weapon.fire when the perk is burning */
      onShot: (p, g, dmgMul) => {
        const st = g.player.weapon.stats;
        const burn = Math.max(4, st.damage * dmgMul * 0.05);
        g.burnTargets(burn, 3);
      },
      status: (p) => ({
        label: p.heat >= 92 ? 'CRITICAL OVERHEAT' : (p.burning > 0 ? 'FIRE MODE' : 'FIRE MAN'),
        bar: p.heat / BUILD_CAPS.heat,
        text: Math.round(p.heat) + '%',
        warn: p.heat > 80,
        critical: p.heat >= 92
      })
    },
    {
      id: 'samurai', name: 'SAMURAI', glyph: '⚔', rarity: 'rare',
      desc: 'F slashes with a katana. Recovery scales with dogtags (instant at 10). Hold F to spend one on a heal.',
      cd: PERK_CD.samurai,
      onEquip: (p) => {
        p.slashRecovery = 1.0;
        p.slash = 0;
        p.healT = 0;
        p.healCd = 0;
      },
      update: (p, dt, g) => {
        if (p.slash > 0) p.slash -= dt;
        if (p.slashRecovery < 1) {
          const rate = getSamuraiRecoveryRate(p.dogtags);
          if (rate === Infinity || (p.dogtags || 0) >= 10) {
            p.slashRecovery = 1.0;
          } else {
            p.slashRecovery = Math.min(1, p.slashRecovery + dt * rate);
          }
        }
        return p.slash > 0 || p.healT > 0 || p.slashRecovery < 1;
      },
      status: (p) => {
        const rec = p.slashRecovery !== undefined ? p.slashRecovery : 1;
        if (rec < 1) {
          return {
            label: 'SLASH RECOVERY',
            text: Math.round(rec * 100) + '%',
            bar: rec,
            warn: rec < 0.5
          };
        }
        return {
          label: 'SLASH READY',
          text: (p.dogtags || 0) + ' DOGTAGS',
          bar: (p.dogtags || 0) / 10
        };
      }
    },
    {
      id: 'executioner', name: 'EXECUTIONER', glyph: '🎭', rarity: 'epic',
      desc: 'F toggles tracking mask. Damage taken reduces durability. At 0%, mask shatters and repairs to 50%.',
      cd: PERK_CD.executioner,
      onEquip: (p) => {
        p.mask = 100;
        p.maskState = 'OFF';
        p.maskActive = 0;
        p.maskBroken = false;
        p.damageBonus = 0;
        p.brokenTimer = 0;
      },
      update: (p, dt, g) => {
        const state = p.maskState || 'OFF';
        if (state === 'EQUIPPED') {
          p.maskActive = 1;
          p.maskBroken = false;
          g.updateEnemyMarkers(true);
        } else {
          p.maskActive = 0;
          g.clearEnemyMarkers();
        }

        if (state === 'BROKEN') {
          p.maskBroken = true;
          p.brokenTimer = (p.brokenTimer || 0) - dt;
          if (p.brokenTimer <= 0) {
            p.maskState = 'REPAIRING';
            p.brokenTimer = 0;
            if (g.perkVisuals) g.perkVisuals.onMaskRepairStarted();
          }
        } else if (state === 'REPAIRING') {
          p.maskBroken = true;
          // Repairing: durability climbs from 0% toward 100% (6.25% per second)
          p.mask = Math.min(100, (p.mask || 0) + dt * 6.25);
          if (p.mask >= 50) {
            p.maskState = 'READY';
            p.maskBroken = false;
            if (g.perkVisuals) g.perkVisuals.onMaskReady();
          }
        } else if (state === 'READY') {
          p.maskBroken = false;
          if (p.mask < 100) p.mask = Math.min(100, p.mask + dt * 6.25);
        }

        return state === 'EQUIPPED' || state === 'BROKEN' || state === 'REPAIRING';
      },
      onDamaged: (p, amount, g) => {
        if (p.maskState === 'EQUIPPED') {
          const loss = Math.max(10, Math.round(amount * 0.8));
          p.mask = Math.max(0, p.mask - loss);
          if (p.mask <= 0) {
            // FORCED MASK BREAK:
            p.mask = 0;
            p.maskState = 'BROKEN';
            p.maskActive = 0;
            p.maskBroken = true;
            p.brokenTimer = 1.4;
            p.damageBonus = 0;
            p.dogtags = 0;
            g.clearEnemyMarkers();
            if (g.perkVisuals) g.perkVisuals.onMaskBroken();
            g.audio.tone(g.audio.t, 0.45, 260, 50, 0.5, 'square');
          } else {
            if (g.perkVisuals) g.perkVisuals.onPlayerDamaged(amount);
          }
        }
      },
      status: (p) => {
        const state = p.maskState || 'OFF';
        if (state === 'EQUIPPED') {
          const dur = Math.round(p.mask);
          const bonus = (p.damageBonus || 0) * 4;
          return {
            label: 'MASK EQUIPPED',
            text: dur + '%' + (bonus > 0 ? ' (+' + bonus + '% DMG)' : ''),
            bar: p.mask / 100,
            warn: p.mask < 35,
            critical: p.mask < 20
          };
        } else if (state === 'BROKEN') {
          return {
            label: 'TAKE OFF MASK',
            text: 'BROKEN',
            bar: 0,
            warn: true,
            critical: true
          };
        } else if (state === 'REPAIRING') {
          return {
            label: 'MASK REPAIRING',
            text: Math.round(p.mask) + '%',
            bar: p.mask / 50,
            warn: true
          };
        } else if (state === 'READY') {
          return {
            label: 'MASK READY',
            text: Math.round(p.mask) + '%',
            bar: p.mask / 100,
            warn: false
          };
        } else { // 'OFF'
          return {
            label: 'MASK OFF',
            text: Math.round(p.mask) + '%',
            bar: p.mask / 100,
            warn: false
          };
        }
      }
    },
    {
      id: 'phantom', name: 'PHANTOM', glyph: '👻', rarity: 'epic',
      desc: 'F becomes untouchable: +35% speed, +30% damage, harder to spot, -50% armour.',
      cd: PERK_CD.phantom,
      update: (p, dt, g) => {
        if (p.active > 0) {
          p.active -= dt;
          p.trailT = (p.trailT || 0) - dt;
          if (p.trailT <= 0) {                        // afterimages
            p.trailT = 0.05;
            g.spawnAfterimage();
          }
        }
        return p.active > 0;
      },
      status: (p) => ({ label: 'PHANTOM', text: p.active > 0 ? p.active.toFixed(1) + 's' : 'READY', bar: p.active / 3.8 })
    },
    {
      id: 'medic', name: 'MEDIC', glyph: '✚', rarity: 'rare',
      desc: 'F drops a healing field: 4 HP/s for 5s while you stand in it.',
      cd: PERK_CD.medic,
      update: (p, dt, g) => {
        if (p.fieldT > 0) {
          p.fieldT -= dt;
          p.tick = (p.tick || 0) - dt;
          const inField = g.player.position.distanceTo(p.fieldPos) < 3.2;
          if (p.tick <= 0) {
            p.tick = 0.25;
            g.particles.burst(3, p.fieldPos.x + rand(-2.6, 2.6), 0.25, p.fieldPos.z + rand(-2.6, 2.6), {
              spread: 0.3, up: 1.4, lifeMin: 0.3, lifeMax: 0.7,
              sizeMin: 0.04, sizeMax: 0.09, color: [0.35, 1.0, 0.55], grav: -0.6, drag: 1.6
            });
          }
          if (inField) g.healPlayer(4 * 0.25, dt);   // capped healing path
        }
        return p.fieldT > 0;
      },
      status: (p) => ({ label: 'MEDIC', text: p.fieldT > 0 ? p.fieldT.toFixed(1) + 's' : 'READY', bar: p.fieldT / 5 })
    },
    {
      id: 'gravity', name: 'GRAVITY', glyph: '🕳', rarity: 'epic',
      desc: 'F pulses a gravity well: enemies are dragged in, slowed, then burst.',
      cd: PERK_CD.gravity,
      update: (p, dt, g) => {
        if (p.pulseT > 0) {
          p.pulseT -= dt;
          g.gravityPulse(dt, p.pulsePos, p.pulseT);
        }
        return p.pulseT > 0;
      },
      status: (p) => ({ label: 'GRAVITY', text: p.pulseT > 0 ? p.pulseT.toFixed(1) + 's' : 'READY', bar: p.pulseT / 1.6 })
    },
    {
      id: 'engineer', name: 'ENGINEER', glyph: '🤖', rarity: 'legendary',
      desc: 'F deploys an automated turret that picks the nearest target for 15s.',
      cd: PERK_CD.engineer,
      update: (p, dt, g) => (p.turret ? g.updateTurret(p.turret, dt) : false),
      status: (p) => ({
        label: 'TURRET',
        text: p.turret ? Math.ceil(p.turret.life) + 's' : 'READY',
        bar: p.turret ? p.turret.life / 15 : 0
      })
    }
  ];
  const PERK_BY_ID = {};
  for (let i = 0; i < PERKS.length; i++) PERK_BY_ID[PERKS[i].id] = PERKS[i];

  /* ======================= TRAIL / PERK MANAGER ========================= */

  class BuildSystem {
    constructor(game) {
      this.game = game;
      this.player = game.player;
      this.trails = [null, null, null];          // trail defs
      this.trailState = [null, null, null];       // runtime state per slot
      this.perk = null;                          // perk def
      this.perkState = null;                     // runtime state
      this._modTimer = 0;
      this._sig = '';
      this._statusDirty = true;
    }

    /* ---------------------------- trails ---------------------------- */

    hasTrail(id) { return this.trails.indexOf(TRAIL_BY_ID[id]) >= 0; }
    trailCount() { return this.trails.filter(Boolean).length; }

    equipTrail(id, slot) {
      const def = TRAIL_BY_ID[id];
      if (!def) return false;
      let target;
      const existing = this.trails.indexOf(def);
      if (slot !== undefined && slot >= 0 && slot < this.trails.length) target = slot;
      else if (existing >= 0) target = existing;      // already owned: never duplicate
      else target = this.trails.indexOf(null);        // first free slot
      if (target < 0) target = 0;                     // full: replace the first slot
      if (this.trails[target] === def) {
        this.game.ui.showBuffToast('TRAIL ACTIVE', def.name + ' is already equipped');
        return true;
      }
      if (existing >= 0) this.trailState[existing] = null;   // moved, not duplicated
      const replaced = this.trails[target];
      this.trails[target] = def;
      this.trailState[target] = def.init();
      this.game.ui.showBuffToast('TRAIL EQUIPPED', def.name + (replaced ? ' - replaced ' + replaced.name : ''));
      this._syncSynergies();
      this.apply();
      return true;
    }

    removeTrail(slot) {
      if (!this.trails[slot]) return false;
      const name = this.trails[slot].name;
      this.trails[slot] = null;
      this.trailState[slot] = null;
      this.game.ui.showBuffToast('TRAIL REMOVED', name);
      this._syncSynergies();
      this.apply();
      return true;
    }

    /* ----------------------------- perk ----------------------------- */

    equipPerk(id) {
      const def = PERK_BY_ID[id];
      if (!def) return false;
      const replaced = this.perk ? this.perk.name : null;
      this.perk = def;
      this.perkState = {
        heat: 0, burning: 0, dogtags: 0,
        mask: 100, maskState: 'OFF', maskActive: 0, maskBroken: false, damageBonus: 0, brokenTimer: 0,
        slashRecovery: 1.0, slash: 0,
        repairT: 0, active: 0, healT: 0, healCd: 0, warned: false,
        auraT: 0, beep: 0, tick: 0, trailT: 0, shakeT: 0,
        fieldT: 0, fieldPos: new THREE.Vector3(),
        pulseT: 0, pulsePos: new THREE.Vector3(), turret: null, cd: 0, ticks: 0
      };
      if (def.onEquip) def.onEquip(this.perkState, this.game);
      this._syncSynergies();
      this.game.ui.showBuffToast('PERK EQUIPPED', def.name + (replaced ? '...' + replaced : ''));
      this.game.ui.updatePerkHud();
      if (this.game.perkVisuals) this.game.perkVisuals.onPerkChanged(def);
      return true;
    }

    removePerk() {
      if (!this.perk) return false;
      const name = this.perk.name;
      if (this.perkState && this.perkState.turret) this.game.removeTurret(this.perkState.turret);
      this.perk = null;
      this.perkState = null;
      this._syncSynergies();
      this.game.ui.showBuffToast('PERK REMOVED', name);
      this.game.ui.updatePerkHud();
      if (this.game.perkVisuals) this.game.perkVisuals.onPerkChanged(null);
      return true;
    }

    /* --------------------------- synergy ---------------------------- */

    synergyList() {
      const ids = this.trails.filter(Boolean).map(t => t.id);
      const out = [];
      if (this.perk) ids.push(this.perk.id);
      for (let i = 0; i < SYNERGIES.length; i++) {
        const s = SYNERGIES[i];
        if (ids.indexOf(s.a) >= 0 && ids.indexOf(s.b) >= 0) out.push(s);
      }
      return out;
    }

    hasSynergy(id) {
      if (this._synFlags) return !!this._synFlags[id];
      return this.synergyList().some(s => s.id === id);
    }

    /** live perk readout for the HUD */
    perkStatus() {
      const s = this.perkState;
      if (!s || !this.perk || !this.perk.status) return { label: '', text: 'READY', bar: 0, warn: false };
      const st = this.perk.status(s);
      let text = st.text, bar = st.bar;
      if (s.cd > 0 && (this.perk.id !== 'fireman' || s.burning <= 0)) {
        text = s.cd.toFixed(1) + 's';
        bar = 1 - s.cd / Math.max(0.1, this.perk.cd);
      }
      return { label: st.label, text: text, bar: bar, warn: !!st.warn, critical: !!st.critical };
    }

    _refreshTrailStatus() {
      this.game.ui._refreshTrailStatus();
    }

    /** dogtag ceiling: relentless synergy trims samurai's stacking */
    dogtagCap() {
      return this.hasSynergy('samurai_impatient') ? 6 : BUILD_CAPS.dogtag;
    }

    /** samurai: dogtags become movement speed */
    dogtagMoveBonus() {
      const s = this.perkState;
      if (!s || this.perk.id !== 'samurai') return 1;
      return 1 + Math.min(s.dogtags, this.dogtagCap()) * 0.03;
    }

    /** executioner: dogtags become damage ONLY when mask is EQUIPPED */
    dogtagDamageBonus() {
      const s = this.perkState;
      if (!s || this.perk.id !== 'executioner' || s.maskState !== 'EQUIPPED') return 1;
      const bonus = s.damageBonus || 0;
      return 1 + Math.min(bonus, this.dogtagCap()) * 0.04;
    }

    /** phantom trades half of your armour pool for mobility */
    armorEffectiveness() {
      const s = this.perkState;
      if (s && this.perk && this.perk.id === 'phantom' && s.active > 0) return 0.5;
      return 1;
    }

    /** fire man + survival: survival cannot save you from an overheat */
    survivalBlocked() {
      const s = this.perkState;
      return !!(this.hasSynergy('fireman_survival') && s && this.perk.id === 'fireman' && s.heat > 80);
    }

    /** cached synergy flags: trails change rarely, perks on equip */
    _syncSynergies() {
      const ids = this.trails.filter(Boolean).map(t => t.id);
      if (this.perk) ids.push(this.perk.id);
      this._synFlags = Object.create(null);
      for (let i = 0; i < SYNERGIES.length; i++) {
        const s = SYNERGIES[i];
        if (ids.indexOf(s.a) >= 0 && ids.indexOf(s.b) >= 0) this._synFlags[s.id] = true;
      }
      this._hasImpatientMomentum = !!this._synFlags.impatient_momentum;
    }

    /* --------------------------- runtime ---------------------------- */

    update(dt) {
      const p = this.player, g = this.game;
      const ctx = { player: p, game: g, dt: dt, build: this };
      // synergies are computed once per tick (they drive the caps below)
      const syn = {
        hunterCap: this.hasSynergy('hunter_bloodlust') ? 0.60 : 1,
        bloodlustBonus: 0
      };
      const bl = this.trailState[this.trails.indexOf(TRAIL_BY_ID.bloodlust)];
      if (bl && this.hasTrail('bloodlust')) syn.bloodlustBonus = bl.stacks * 0.03;

      let mods = [];
      for (let i = 0; i < this.trails.length; i++) {
        const def = this.trails[i], s = this.trailState[i];
        if (!def || !s) continue;
        if (def.update) def.update(s, dt, ctx);
        if (def.mods) mods.push(def.mods(s, ctx, syn));
      }
      // synergy-only bonuses (impatient+momentum surge, samurai dogtags, executioner dogtags)
      if (this._hasImpatientMomentum && this.momentumSurge > 0) {
        mods.push({ mul: { moveSpeed: 1.25 } });
        this.momentumSurge -= dt;
      }
      const dogMove = this.dogtagMoveBonus();
      const dogDmg = this.dogtagDamageBonus();
      if (dogMove !== 1) mods.push({ mul: { moveSpeed: dogMove } });
      if (dogDmg !== 1) mods.push({ mul: { damage: dogDmg } });
      if (this.perk && this.perk.id === 'phantom' && this.perkState.active > 0) {
        mods.push({ mul: { moveSpeed: 1.35, damage: 1.30 } });
      }
      this.mods = combineMods(mods);
      // recompute player stats a few times a second (or immediately when dirty)
      this._modTimer -= dt;
      if (this._modTimer <= 0) { this._modTimer = 0.12; this.apply(); }

      // perk
      const ps = this.perkState;
      if (ps && this.perk) {
        if (ps.cd > 0) ps.cd -= dt;
        if (this.perk.update) this.perk.update(ps, dt, g);
        ps.ticks++;
        // HUD numbers (heat / dogtags / mask / timers) refresh ~8x a second
        this._hudT = (this._hudT || 0) - dt;
        if (this._hudT <= 0) { this._hudT = 0.12; this.game.ui.updatePerkHud(); this._refreshTrailStatus(); }
      }
      this._statusDirty = true;
    }

    /** push the collected trail modifiers into the player's stat pipeline */
    apply() {
      const p = this.player;
      p.buildMods = this.mods;
      p.refreshStats();
      this.game.ui.updateTrailHud();
      this.game.ui.updatePerkHud();
    }

    /* ------------------------ event hooks -------------------------- */

    onKill(enemy) {
      for (let i = 0; i < this.trails.length; i++) {
        const def = this.trails[i], s = this.trailState[i];
        if (def && def.onKill) def.onKill(s, enemy, this.game);
      }
      const ps = this.perkState;
      if (this.perk && ps) {
        if (this.perk.id === 'samurai') {
          ps.dogtags = Math.min(this.dogtagCap(), ps.dogtags + 1);
        } else if (this.perk.id === 'executioner' && ps.maskState === 'EQUIPPED') {
          ps.dogtags = Math.min(this.dogtagCap(), ps.dogtags + 1);
          ps.damageBonus = Math.min(this.dogtagCap(), (ps.damageBonus || 0) + 1);
        }
      }
      this.apply();
    }

    onDash() {
      for (let i = 0; i < this.trails.length; i++) {
        const def = this.trails[i], s = this.trailState[i];
        if (def && def.onDash) def.onDash(s, { player: this.player, game: this.game });
      }
      if (this.hasSynergy('impatient_momentum')) this.momentumSurge = 3;
      this.apply();
    }

    onDamaged(amount) {
      for (let i = 0; i < this.trails.length; i++) {
        const def = this.trails[i], s = this.trailState[i];
        if (def && def.onDamage) def.onDamage(s, amount, this.game);
        if (def && def.id === 'survival' && s) s.t = 0;   // damage resets the heal timer
      }
      if (this.perk && this.perkState && this.perk.onDamaged) this.perk.onDamaged(this.perkState, amount, this.game);
    }

    /** back-attack bonus for Predator; returns a multiplier */
    backstabMultiplier(enemy, dir) {
      if (!this.hasTrail('predator')) return 1;
      const s = this.trailState[this.trails.indexOf(TRAIL_BY_ID.predator)];
      const fwd = new THREE.Vector3(-Math.sin(enemy.yaw), 0, -Math.cos(enemy.yaw));
      const dot = dir.x * fwd.x + dir.z * fwd.z;
      if (dot < -0.35) { s.hits++; return 1.35; }
      return 1;
    }

    reset() {
      if (this.perkState && this.perkState.turret) this.game.removeTurret(this.perkState.turret);
      this.trails = [null, null, null];
      this.trailState = [null, null, null];
      this.perk = null;
      this.perkState = null;
      this.mods = combineMods([]);
      this.momentumSurge = 0;
      this.player.buildMods = this.mods;
      this.player.refreshStats();
      this.game.ui.updateTrailHud();
      this.game.ui.updatePerkHud();
      this.game.clearEnemyMarkers();
    }
  }
  /* ============================================================= PLAYER */

  class Player {
    constructor(game) {
      this.game = game;
      this.camera = game.camera;
      this.position = new THREE.Vector3(0, 0, 22);
      this.velocity = new THREE.Vector3();
      this.radius = CFG.playerRadius;
      this.height = CFG.playerHeight;
      this.grounded = false;
      this.planarSpeed = 0;

      this.yaw = 0;                  // forward = -Z, so the player looks at the arena centre
      this.pitch = 0;
      this.lookDX = 0;
      this.lookDY = 0;
      this.pitchVel = 0;
      this.yawVel = 0;
      this.recoilPitch = 0;
      this.recoilYaw = 0;

      // ---- camera feel state ----
      this.camBobT = 0;
      this.camBobY = 0;
      this.camBobX = 0;
      this.camDip = 0;            // landing compression (smoothed value)
      this.camDipImpulse = 0;     // raw landing impulse that decays to rest
      this.camKick = 0;           // recoil punch along the view axis (smoothed)
      this.camKickImpulse = 0;
      this.camRoll = 0;
      this.camDamageRoll = 0;     // temporary directional damage flinch roll
      this.camDamagePitch = 0;    // temporary directional damage flinch pitch
      this.fov = CFG.fov;
      this.fovTarget = CFG.fov;
      this.lastGrounded = true;
      this.fallSpeed = 0;
      this.landImpact = 0;        // 0..1, drives weapon dip + shake

      this.health = CFG.maxHealth;
      this.stamina = CFG.staminaMax;
      this.staminaLock = 0;
      this.sprinting = false;
      this.alive = true;
      this.deathT = 0;
      this.invuln = 0;

      this.hitBody = new Box(-0.4, 0, -0.4, 0.4, 1.5, 0.4, 'player', this);
      this.hitHead = new Box(-0.18, 1.5, -0.18, 0.18, 1.78, 0.18, 'player', this);
      this._syncHitboxes();

      // ---- inventory: 3 weapon slots (instance data + view-model runtime) ----
      this.slotCount = 3;
      this.slots = new Array(this.slotCount).fill(null);      // WeaponInstance | null
      this.weapons = new Array(this.slotCount).fill(null);    // Weapon runtime  | null
      this.current = 0;

      // ---- roguelite buffs + derived stats ----
      this.buffs = [];              // [{ id, count }] - buffs stack, count is shown in the UI
      this.mods = combineMods([]);  // combined player modifiers
      this.stats = resolveStats(PLAYER_BASE, this.mods);
      this.maxHealth = this.stats.maxHealth;
      this.health = this.maxHealth;
      this.stamina = this.stats.staminaMax;
      this.staminaLock = 0;
      this.sprinting = false;
      this.alive = true;
      this.deathT = 0;
      this.invuln = 0;

      // ---- ammo pools (one per ammo type) ----
      this.ammo = {};
      for (let i = 0; i < AMMO_IDS.length; i++) this.ammo[AMMO_IDS[i]] = AMMO_TYPES[AMMO_IDS[i]].start;

      // ---- armour: 3 slots + aggregate stats ----
      this.armorSlots = ARMOR_SLOTS;
      this.armor = { helmet: null, body: null, boots: null };
      this.armorStats = { helmet: 0, body: 0, boots: 0, damageReduction: 0, headshotReduction: 0, moveSpeed: 1, dashCd: 1 };

      // ---- tactical movement: dash / lean / ads ----
      this.dashT = 0;            // remaining dash time
      this.dashCd = 0;           // cooldown remaining
      this.dashDir = new THREE.Vector3(0, 0, -1);
      this.dashTrailT = 0;
      this.lean = 0;             // -1 left, +1 right
      this.leanAmt = 0;          // smoothed lean offset
      this.eConsumed = false;    // an E press already used for a pickup
      this.pickupTarget = null;
      this.ads = false;
      this.adsAmt = 0;           // 0 hip, 1 fully aimed
      this.adsToggle = false;    // tap-toggle for touch / no-RMB users
      this.scoped = false;       // fully through an optic

      this.fireHeld = false;
      this.wasFiring = false;
      this.dynamicAdded = false;

      this._equipDefaultLoadout();
      this.refreshArmor();
    }

    _equipDefaultLoadout() {
      for (let i = 0; i < this.slotCount; i++) this._clearSlot(i);
      this._equip(0, new WeaponInstance('ar15', 'common', []));
      this._equip(1, new WeaponInstance('pump', 'common', []));
      this.weapons[0].group.visible = true;
      this.current = 0;
    }

    get weapon() { return this.weapons[this.current] || null; }
    get instance() { return this.slots[this.current] || null; }

    /* ----------------------------- ammo ------------------------------- */

    ammoPool(id) { return this.ammo[id] || 0; }
    setAmmo(id, n) { this.ammo[id] = Math.max(0, Math.round(n)); }
    addAmmo(id, n) { this.setAmmo(id, this.ammoPool(id) + n); }

    /* ---------------------------- armor ------------------------------- */

    armorFor(slot) { return this.armor[slot]; }
    armorValue() {
      return (this.armorStats.helmet || 0) + (this.armorStats.body || 0) + (this.armorStats.boots || 0);
    }
    /** armour + trail/buff reduction, capped globally */
    damageReduction() {
      const trail = (this.stats.damageReduction === undefined ? 1 : this.stats.damageReduction) - 1;
      return clamp((this.armorStats.damageReduction || 0) + trail, 0, BUILD_CAPS.damageReduction);
    }
    headshotReduction() { return clamp(this.armorStats.headshotReduction || 0, 0, 0.75); }

    /** phantom halves how much armour soaks while it is active */
    armorPool() { return this.armorValue() * this.game.build.armorEffectiveness(); }

    /** recompute the aggregate armor stats (armor pool, reduction, boot speed) */
    refreshArmor() {
      const s = { helmet: 0, body: 0, boots: 0, damageReduction: 0, headshotReduction: 0, moveSpeed: 1, dashCd: 1 };
      const parts = [];
      for (let i = 0; i < this.armorSlots.length; i++) {
        const slot = this.armorSlots[i];
        const inst = this.armor[slot];
        if (!inst) continue;
        s[slot] = inst.armor;                 // each piece carries its own pool
        parts.push(inst.mods);
      }
      const m = combineMods(parts);
      s.damageReduction = (m.mul.damageReduction || 1) - 1;
      s.headshotReduction = 1 - (m.mul.headshotReduction || 1);
      s.moveSpeed = m.mul.moveSpeed === undefined ? 1 : m.mul.moveSpeed;
      s.dashCd = m.mul.dashCooldown === undefined ? 1 : m.mul.dashCooldown;
      this.armorStats = s;
      return s;
    }

    /** weapon-induced movement penalty (Heavy) folded into the player speed */
    moveSpeed() {
      const w = this.weapon;
      const wMul = w ? (w.stats.moveSpeed === undefined ? 1 : w.stats.moveSpeed) : 1;
      const ads = lerp(1, w ? w.stats.adsMove : 0.6, this.adsAmt);
      // global speed ceiling so a stacked build can never trivialise the game
      return clamp(this.stats.moveSpeed * wMul * (this.armorStats ? this.armorStats.moveSpeed : 1) * ads,
        1, CFG.moveSpeed * BUILD_CAPS.moveSpeed);
    }

    /** dash cooldown after boots */
    dashCooldown() {
      const boot = this.armorStats ? this.armorStats.dashCd : 1;
      return CFG.dashCooldown / (boot > 0 ? boot : 1);
    }

    /* ------------------------- stats / buffs ------------------------- */

    /** recompute every derived stat from base + stacked buffs (+ held weapon) */
    refreshStats() {
      // a buff taken twice contributes its modifier twice, so stacking is
      // multiplicative for ratios and additive for flat bonuses
      const parts = [];
      for (let i = 0; i < this.buffs.length; i++) {
        const b = this.buffs[i];
        if (!b.def) continue;
        const times = Math.max(1, b.count || 1);
        for (let k = 0; k < times; k++) parts.push(b.def);
      }
      // trails fold in through the same pipeline
      if (this.buildMods) parts.push(this.buildMods);
      this.mods = combineMods(parts);
      this.stats = resolveStats(PLAYER_BASE, this.mods);
      const newMax = this.stats.maxHealth;
      // Vitality-style max-HP buffs also top the player up by the amount gained
      if (newMax > this.maxHealth) this.health += newMax - this.maxHealth;
      this.maxHealth = newMax;
      this.health = Math.min(this.health, this.maxHealth);
      this.stamina = Math.min(this.stamina, this.stats.staminaMax);
      for (let i = 0; i < this.weapons.length; i++) {
        if (this.weapons[i]) this.weapons[i].refreshStats();
      }
      return this.stats;
    }

    addBuff(id, def) {
      const found = this.buffs.find((b) => b.id === id);
      if (found) found.count++;
      else this.buffs.push({ id: id, count: 1, def: def || BUFF_BY_ID[id] || BOSS_BUFF_BY_ID[id] });
      this.refreshStats();
      this.game.ui.showBuffGained(def || BUFF_BY_ID[id]);
      return this.buffs;
    }

    heal(amount) {
      if (!this.alive || amount <= 0 || !isFinite(amount)) return;
      const before = this.health;
      this.health = Math.min(this.maxHealth, this.health + amount);
      const gained = Math.round(this.health - before);
      if (gained >= 3) this.game.ui.showDamageNumber(this.camera.position.clone(), gained, false, false, '#8dffa8');
    }

    /* --------------------------- inventory --------------------------- */

    _equip(slotIndex, instance) {
      if (!instance) { this._clearSlot(slotIndex); return null; }
      const prev = this.weapons[slotIndex];
      if (!prev) {
        const w = new Weapon(instance, this.camera, this.game.scene, this.game);
        this.weapons[slotIndex] = w;
      } else {
        prev.setInstance(instance);
      }
      this.slots[slotIndex] = instance;
      return this.weapons[slotIndex];
    }

    _clearSlot(slotIndex) {
      const w = this.weapons[slotIndex];
      if (w) w.dispose();
      this.weapons[slotIndex] = null;
      this.slots[slotIndex] = null;
      // never leave `current` pointing at an empty slot
      if (slotIndex === this.current) {
        const next = this.firstFilledSlot();
        this.current = next >= 0 ? next : 0;
        const nw = this.weapon;
        if (nw) {
          nw.group.visible = true;
          nw.switching = 0.2;
        }
      }
    }

    /** put an instance into a slot; when the slot is taken the old one drops */
    _equipAndDropOld(slotIndex, instance, dropPos) {
      const old = this.slots[slotIndex];
      if (old && dropPos) this.game.spawnPickup(old, dropPos);
      this._equip(slotIndex, instance);
      return old;
    }

    /** free slot, or -1 when the inventory is full */
    freeSlot() {
      for (let i = 0; i < this.slotCount; i++) if (!this.slots[i]) return i;
      return -1;
    }

    /** first slot that actually holds a weapon, or -1 */
    firstFilledSlot() {
      for (let i = 0; i < this.slotCount; i++) if (this.slots[i]) return i;
      return -1;
    }

    /** highest rarity in the inventory (for the "you have better" hint) */
    bestRarityIndex() {
      let best = -1, bestW = -1;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (!s) continue;
        const w = s.rarity.weight;
        if (w > bestW) { bestW = w; best = i; }
      }
      return best;
    }

    switchTo(index) {
      if (index === this.current || index < 0 || index >= this.slotCount) return;
      if (!this.slots[index]) {                 // empty slot: refuse (UI shows EMPTY)
        this.game.audio.dryFire();
        return;
      }
      const cur = this.weapon;
      if (cur && cur.switching > 0) return;
      if (cur) {
        cur.group.visible = false;
        cur.cancelReload();
      }
      this.current = index;
      const w = this.weapon;
      w.group.visible = true;
      w.switching = 0.3;
      this.game.audio.click(this.game.audio.t, 0.2, 1800);
      this.game.ui.flashWeapon();
    }

    /** G: drop the held weapon into the world */
    dropCurrent() {
      const inst = this.slots[this.current];
      if (!inst) { this.game.audio.dryFire(); return null; }
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
      fwd.normalize();
      const at = this.position.clone().addScaledVector(fwd, 1.1);
      this.game.collision.liftOut(at, 0.3, 0.9);
      const pickup = this.game.spawnPickup(inst, at);
      this._clearSlot(this.current);
      // auto-switch to the first weapon still in the inventory
      const next = this.firstFilledSlot();
      if (next >= 0) {
        this.current = next;
        const w = this.weapon;
        w.group.visible = true;
        w.switching = 0.25;
      }
      this.game.ui.flashWeapon();
      this.game.ui.showBanner('DROPPED', false, 0.9);
      return pickup;
    }

    /** E: take a pickup into the inventory (weapon, armour or ammo) */
    pickup(pickup) {
      if (!pickup || pickup.taken) return false;

      if (pickup.kind === 'ammo') {
        this.addAmmo(pickup.ammoId, pickup.amount);
        pickup.take();
        this.game.ui.showBanner('+' + pickup.amount + ' ' + AMMO_TYPES[pickup.ammoId].name, false, 1.1);
        this.game.audio.tone(this.game.audio.t, 0.2, 420, 700, 0.14, 'triangle');
        return true;
      }

      if (pickup.kind === 'armor') {
        const inst = pickup.inst;
        const slot = inst.slot;
        const prev = this.armor[slot];
        if (prev) this.game.spawnArmorPickup(prev, this.position.clone().addScaledVector(
          new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), 0.9), true);
        this.armor[slot] = inst;
        this.refreshArmor();
        pickup.take();
        this.game.ui.flashArmor(slot);
        this.game.ui.showBanner('EQUIPPED ' + inst.rarity.name + ' ' + inst.kind.name, false, 1.2);
        this.game.audio.tone(this.game.audio.t, 0.24, 340, 620, 0.2, 'triangle');
        return true;
      }

      let slot = this.freeSlot();
      if (slot < 0) slot = this.current;      // full -> swap with what is held
      const dropped = this._equipAndDropOld(slot, pickup.inst,
        slot === this.current ? this.position.clone().addScaledVector(
          new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), 0.9) : null);
      pickup.take();
      if (slot !== this.current) this.switchTo(slot);
      else { const w = this.weapon; w.group.visible = true; w.switching = 0.25; }
      this.refreshStats();
      this.game.ui.flashWeapon();
      this.game.ui.showBanner((dropped ? 'SWAPPED FOR ' : 'PICKED UP ') + pickup.inst.rarity.name, false, 1.1);
      this.game.audio.tone(this.game.audio.t, 0.22, 520, 880, 0.14, 'triangle');
      return true;
    }

    _syncHitboxes() {
      const p = this.position;
      this.hitBody.min.set(p.x - 0.4, p.y, p.z - 0.4);
      this.hitBody.max.set(p.x + 0.4, p.y + 1.5, p.z + 0.4);
      this.hitHead.min.set(p.x - 0.18, p.y + 1.5, p.z - 0.18);
      this.hitHead.max.set(p.x + 0.18, p.y + 1.78, p.z + 0.18);
    }

    addRecoil(pitch, yaw) {
      // muzzle climbs: positive pitch looks up, so the impulse is added
      this.pitchVel += pitch * 15;
      this.yawVel += (Math.random() - 0.5) * 2 * yaw * 9;
      // the camera also gets pushed back along its own axis (view-model punch)
      this.camKickImpulse = Math.min(1.4, this.camKickImpulse + pitch * 9);
    }

    /* ------------------------ tactical movement ------------------------ */

    /** CTRL or Q-less dash: burst of speed in the input (or facing) direction */
    tryDash(fx, fz) {
      if (this.dashCd > 0 || this.dashT > 0 || !this.alive) return false;
      const dir = this.dashDir;
      if (fx !== 0 || fz !== 0) {
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        dir.set(fx * cos - fz * sin, 0, -fx * sin - fz * cos);
      } else {
        dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      }
      if (dir.lengthSq() < 0.001) dir.set(0, 0, -1);
      dir.normalize();
      this.dashT = CFG.dashTime;
      this.dashCd = this.dashCooldown();
      this.dashTrailT = 0;
      this.game.build.onDash();
      this.game.addShake(0.12);
      this.game.audio.tone(this.game.audio.t, 0.16, 320, 140, 0.16, 'sawtooth');
      return true;
    }

    /** ADS spread multiplier: aiming really tightens the cone */
    currentSpreadBonus() {
      const base = 1;
      const adsMul = lerp(1, this.weapon ? this.weapon.stats.adsSpread : 0.4, this.adsAmt);
      return base * adsMul;
    }

    /**
     * Damage intake: armour soaks damage first (helmet cuts headshots, vest cuts
     * body damage), the remainder goes into health.
     */
    damage(amount, sourcePos, isHead, options = null) {
      if (!this.alive || this.invuln > 0) return;
      let dmg = amount;
      const armorHit = { amount: 0, broke: false, head: !!isHead };

      // armour pool: total of all pieces (phantom halves it)
      let pool = this.armorPool();
      if (pool > 0) {
        const reduction = isHead ? this.headshotReduction() : this.damageReduction();
        dmg = dmg * (1 - reduction);
        // soak what the armour can take
        const soak = Math.min(pool, dmg);
        armorHit.amount = soak;
        this.absorbArmor(soak);
        dmg -= soak;
      }

      this.health = Math.max(0, this.health - dmg);
      this.game.build.onDamaged(amount);
      if (this.game.perkVisuals) this.game.perkVisuals.onPlayerDamaged(amount);

      let audioPan = 0;
      if (sourcePos && this.camera) {
        const pPos = this.position;
        const dx = sourcePos.x - pPos.x;
        const dy = sourcePos.y - pPos.y;
        const dz = sourcePos.z - pPos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > 0.05) {
          const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
          const nx = dx * invLen;
          const ny = dy * invLen;
          const nz = dz * invLen;

          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
          const hitRight = nx * right.x + ny * right.y + nz * right.z;
          const hitFwd = nx * fwd.x + ny * fwd.y + nz * fwd.z;

          if (Number.isFinite(hitRight)) {
            audioPan = clamp(hitRight * 0.75, -0.75, 0.75);

            // Camera damage impulse:
            // Damage from LEFT (hitRight < 0): tiny camera impulse RIGHT (+roll)
            // Damage from RIGHT (hitRight > 0): tiny camera impulse LEFT (-roll)
            // normal: ~0.5–1° (0.012 rad), heavy: ~1.5° (0.026 rad), boss: ~2° (0.035 rad)
            let mag = 0.012;
            const isBoss = options && (options.isBoss || options.type === 'boss_slam' || options.type === 'boss_attack');
            if (isBoss) mag = 0.035;
            else if (amount >= 30) mag = 0.026;

            const rollImp = -hitRight * mag;
            const pitchImp = (hitFwd > 0 ? 0.4 : -0.4) * mag;
            this.camDamageRoll = clamp((this.camDamageRoll || 0) + rollImp, -0.055, 0.055);
            this.camDamagePitch = clamp((this.camDamagePitch || 0) + pitchImp, -0.045, 0.045);
          }
        }
      }

      this.game.audio.playerHurt(audioPan);
      this.game.ui.showDamage(amount);
      this.game.ui.showArmorHit(armorHit);
      this.game.addShake(0.22 + amount * 0.01);
      if (sourcePos) {
        this.game.ui.showDirectionalDamage(sourcePos, this.camera, amount, {
          head: !!isHead,
          isCrit: !!isHead,
          isBoss: options && (options.isBoss || options.type === 'boss_slam' || options.type === 'boss_attack'),
          type: options ? options.type : null
        });
      }
      if (isHead) this.game.addShake(0.28);
      if (this.health <= 0) this.die();
    }

    /** drain armour across pieces (helmet first on head hits) and flag breaks */
    absorbArmor(soak) {
      if (soak <= 0) return;
      let left = soak;
      const order = this.armorLastHead ? ['helmet', 'body', 'boots'] : ['body', 'helmet', 'boots'];
      for (let i = 0; i < order.length && left > 0; i++) {
        const inst = this.armor[order[i]];
        if (!inst) continue;
        const take = Math.min(inst.armor, left);
        inst.armor -= take;
        left -= take;
        if (inst.armor <= 0) {
          this.armor[order[i]] = null;
          this.game.ui.showArmorBroken(inst);
        }
      }
      this.refreshArmor();
    }

    die() {
      if (!this.alive) return;
      this.alive = false;
      this.deathT = 0;
      this.camDamageRoll = 0;
      this.camDamagePitch = 0;
      this.velocity.set(0, 0, 0);
      const w = this.weapon;
      if (w) w.group.visible = false;
      this.game.audio.playerDeath();
      this.game.onPlayerDeath();
    }

    respawn() {
      this.alive = true;
      this.buffs = [];
      this.mods = combineMods([]);
      this.stats = resolveStats(PLAYER_BASE, this.mods);
      this.maxHealth = this.stats.maxHealth;
      this.health = this.maxHealth;
      this.stamina = this.stats.staminaMax;
      // armour and ammo pools start fresh on a new run
      this.armor.helmet = null; this.armor.body = null; this.armor.boots = null;
      this.refreshArmor();
      this.ammo = {};
      for (let i = 0; i < AMMO_IDS.length; i++) this.ammo[AMMO_IDS[i]] = AMMO_TYPES[AMMO_IDS[i]].start;
      this.ads = false; this.adsToggle = false; this.adsAmt = 0;
      this.lean = 0; this.leanAmt = 0;
      this.dashT = 0; this.dashCd = 0;
      if (this.game && this.game.build) this.game.build.reset();
      this.position.set(0, 0, 22);
      this.game.collision.liftOut(this.position, this.radius, this.height);
      this.velocity.set(0, 0, 0);
      this.yaw = 0;
      this.pitch = 0;
      this.pitchVel = 0; this.yawVel = 0;
      this.recoilPitch = 0; this.recoilYaw = 0;
      this.grounded = false;
      this.deathT = 0;
      this.invuln = 1.5;
      this.camDip = 0; this.camDipImpulse = 0; this.camKick = 0; this.camKickImpulse = 0;
      this.camBobY = 0; this.camBobX = 0; this.camBobT = 0; this.landImpact = 0;
      this.camRoll = 0; this.camDamageRoll = 0; this.camDamagePitch = 0;
      this.fov = CFG.fov; this.fovTarget = CFG.fov;
      this.fallSpeed = 0;
      this._equipDefaultLoadout();
    }

    update(dt, input) {
      const game = this.game;

      // ---------------- tactical inputs (dash / lean / ads) ----------------
      this.ads = (input.buttons[2] || this.adsToggle) && this.alive && !!this.weapon;
      let fx = 0, fz = 0;
      if (input.down('KeyW')) fz += 1;
      if (input.down('KeyS')) fz -= 1;
      if (input.down('KeyA')) fx -= 1;
      if (input.down('KeyD')) fx += 1;
      const len = Math.hypot(fx, fz);
      if (len > 0) { fx /= len; fz /= len; }

      /* ---- input priority: E picks up loot when something is in range,
       * otherwise E leans right. Both never happen at the same time, and a
       * hold that performed a pickup never turns into a lean. ---- */
      if (!input.down('KeyE')) this.eConsumed = false;
      this.pickupTarget = game.nearestPickup(this.position, CFG.pickupRange, this.yaw);
      const pickUpPressed = input.hit('KeyE') && !!this.pickupTarget && !this.eConsumed;
      const leanR = (input.down('KeyE') && !this.eConsumed && !this.pickupTarget) ? 1 : 0;
      const leanL = input.down('KeyQ') ? 1 : 0;
      this.lean = leanR - leanL;

      // ---------------- look ----------------
      const m = input.consumeMouse();
      const sens = input.sensitivity * lerp(1, CFG.adsSensScale, this.adsAmt);
      const mdx = m.dx * sens, mdy = m.dy * sens;
      this.yaw -= mdx;
      this.pitch = clamp(this.pitch - mdy, -1.45, 1.45);
      const kLook = damp(12, dt);
      this.lookDX = lerp(this.lookDX, clamp(-mdx * 7, -0.06, 0.06), kLook);
      this.lookDY = lerp(this.lookDY, clamp(-mdy * 7, -0.06, 0.06), kLook);

      // recoil: impulse kick, then recover back to the pre-shot aim
      const pitch0 = this.pitch, yaw0 = this.yaw;
      this.pitch += this.pitchVel * dt;
      this.yaw += this.yawVel * dt;
      // remember exactly how far recoil moved the aim so it can be unwound
      this.recoilPitch += this.pitch - pitch0;
      this.recoilYaw += this.yaw - yaw0;
      this.pitchVel -= this.pitchVel * damp(17, dt);
      this.yawVel -= this.yawVel * damp(17, dt);
      this.pitch = clamp(this.pitch, -1.5, 1.5);
      // unwind pending recoil: slowly while the trigger is held (so sustained fire
      // walks the aim up), fast once it is released (so the aim snaps back)
      if (this.recoilPitch !== 0 || this.recoilYaw !== 0) {
        const back = Math.min(1, dt * (input.buttons[0] ? 1.2 : 3.4));
        this.pitch -= this.recoilPitch * back;
        this.yaw -= this.recoilYaw * back;
        this.recoilPitch -= this.recoilPitch * back;
        this.recoilYaw -= this.recoilYaw * back;
      }

      if (!this.alive) { this._deathCam(dt); return; }

      if (this.invuln > 0) this.invuln -= dt;

      // ---------------- movement input ----------------
      const wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
      // aiming cancels the sprint: the weapon must never sit in both poses
      this.sprinting = wantSprint && len > 0 && this.stamina > 0.5 && fz > 0.2 &&
        this.grounded && this.adsAmt < 0.35;
      const staminaMax = this.stats.staminaMax;

      if (this.sprinting) {
        this.stamina = Math.max(0, this.stamina - CFG.staminaDrain * dt);
        this.staminaLock = CFG.staminaRegenDelay;
        if (this.stamina <= 0) this.sprinting = false;
      } else {
        if (this.staminaLock > 0) this.staminaLock -= dt;
        else this.stamina = Math.min(staminaMax, this.stamina + this.stats.staminaRegen * dt);
      }

      let speed = this.moveSpeed();
      if (this.sprinting) speed *= CFG.sprintMul;
      if (!this.grounded) speed *= 0.92;
      const curWeapon = this.weapon;
      if (curWeapon && curWeapon.reloading) speed *= 0.94;

      // world-space wish direction from yaw
      // camera forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const wx = fx * cos - fz * sin;
      const wz = -fx * sin - fz * cos;

      /* ---- dash: overrides normal acceleration for a short burst ---- */
      if (this.dashCd > 0) this.dashCd = Math.max(0, this.dashCd - dt);
      if (input.hit('ControlLeft') || input.hit('ControlRight')) this.tryDash(fx, fz);
      if (this.dashT > 0) {
        this.dashT = Math.max(0, this.dashT - dt);
        // ease out across the dash so it feels like a burst, not a teleport
        const k = CFG.dashTime > 0 ? this.dashT / CFG.dashTime : 0;
        const boost = CFG.dashSpeed * (0.55 + k * 0.45);
        this.velocity.x = this.dashDir.x * boost;
        this.velocity.z = this.dashDir.z * boost;
        this.dashTrailT -= dt;
        if (this.dashTrailT <= 0) {
          this.dashTrailT = 0.02;
          game.particles.burst(1, this.position.x, this.position.y + 0.9, this.position.z, {
            spread: 0.35, up: 0.2, lifeMin: 0.12, lifeMax: 0.28,
            sizeMin: 0.05, sizeMax: 0.12, color: [0.5, 0.8, 1.0], grav: 0, drag: 3
          });
        }
      }

      const accel = this.grounded ? CFG.accelGround : CFG.accelAir;
      const targetX = wx * speed, targetZ = wz * speed;
      if (this.dashT > 0) {
        // dash owns the velocity this frame
      } else if (len > 0) {
        this.velocity.x += (targetX - this.velocity.x) * damp(accel, dt);
        this.velocity.z += (targetZ - this.velocity.z) * damp(accel, dt);
      } else {
        this.velocity.x -= this.velocity.x * damp(CFG.friction, dt);
        this.velocity.z -= this.velocity.z * damp(CFG.friction, dt);
      }

      // jump + gravity
      if (input.hit('Space') && this.grounded) {
        this.velocity.y = CFG.jumpSpeed;
        this.grounded = false;
      }
      this.velocity.y -= CFG.gravity * dt;
      if (this.velocity.y < -60) this.velocity.y = -60;

      // ---------------- collide & integrate ----------------
      if (!isFinite(this.velocity.x) || !isFinite(this.velocity.z) || !isFinite(this.velocity.y)) {
        this.velocity.set(0, 0, 0);
      }
      const res = game.collision.moveEntity(
        this, this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt,
        this.grounded ? CFG.stepHeight : 0);   // no ledge climbing in mid-air
      if (res.ground) {
        this.velocity.y = 0;
        if (!this.grounded) {
          // ---- landing: dip the camera, dip the weapon, tiny shake ----
          const impact = clamp(this.fallSpeed / 14, 0, 1);
          this.camDipImpulse = Math.min(1, this.camDipImpulse + 0.35 + impact * 0.9);
          this.landImpact = Math.max(this.landImpact, impact);
          game.audio.land();
          if (impact > 0.35) game.addShake(impact * 0.22);
        }
        this.grounded = true;
      } else if (res.ceiling) {
        this.velocity.y = Math.min(0, this.velocity.y);
        this.grounded = false;
      } else {
        if (this.grounded) this.fallSpeed = Math.max(this.fallSpeed, 0.5);
        this.grounded = false;
      }
      this.lastGrounded = this.grounded;
      this.fallSpeed = this.grounded ? 0 : this.fallSpeed;
      if (!this.grounded) this.fallSpeed = Math.max(this.fallSpeed, Math.max(0, -this.velocity.y));
      if (res.hitX) this.velocity.x = 0;
      if (res.hitZ) this.velocity.z = 0;
      if (this.position.y < -6) { this.position.set(0, 0.1, 22); this.velocity.set(0, 0, 0); }

      this.planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);

      // ---------------- weapons ----------------
      // refresh the camera transform so hitscan rays use this frame's aim
      this._updateCamera(dt);

      if (input.hit('Digit1')) this.switchTo(0);
      if (input.hit('Digit2')) this.switchTo(1);
      if (input.hit('Digit3')) this.switchTo(2);
      if (input.hit('KeyR') && this.weapon) this.weapon.startReload(game.audio);
      // perk ability (F): only while actually playing, never in menus
      if (input.hit('KeyF') && game.canUsePerk()) game.activatePerk();
      if (input.down('KeyF') && game.canUsePerk()) game.holdPerk(dt);
      if (!input.down('KeyF')) game.releasePerk();

      // loot interaction: E is consumed here, so lean right cannot also trigger
      if (pickUpPressed) {
        this.pickup(this.pickupTarget);
        this.eConsumed = true;      // the rest of this hold must not lean
      }
      if (input.hit('KeyG')) this.dropCurrent();

      this.fireHeld = input.buttons[0] || false;
      const w = this.weapon;
      if (w) {
        const trigger = w.def.auto ? this.fireHeld : (this.fireHeld && !this.wasFiring);
        if (trigger && !w.reloading) {
          if (w.mag <= 0) {
            if (w.cooldown <= 0) { game.audio.dryFire(); w.cooldown = 0.28; }
            w.startReload(game.audio);
          } else if (w.canFire) {
            w.fire(game);
          }
        }
      }
      this.wasFiring = this.fireHeld;

      // register hitboxes with the collision system once per frame
      this._syncHitboxes();
      if (!this.dynamicAdded) {
        game.collision.addDynamic(this.hitBody);
        game.collision.addDynamic(this.hitHead);
        this.dynamicAdded = true;
      }
    }

    _updateCamera(dt) {
      const cam = this.camera;
      const game = this.game;
      const shake = game.shakeOffset;

      /* ---- head bob: vertical + lateral, amplitude scales with speed ---- */
      const speed = this.planarSpeed;
      const moving = this.grounded && speed > 0.4;
      const bobRate = this.sprinting ? 11.5 : 8.2;
      if (moving) this.camBobT += dt * bobRate * (0.55 + speed * 0.13);
      const bobAmp = moving ? clamp(speed / 8, 0, 1) * (this.sprinting ? 0.085 : 0.05) : 0;
      const kBob = damp(moving ? 14 : 7, dt);
      this.camBobY = lerp(this.camBobY, Math.abs(Math.sin(this.camBobT)) * bobAmp * 2 - bobAmp * 0.6, kBob);
      this.camBobX = lerp(this.camBobX, Math.sin(this.camBobT * 0.5) * bobAmp * 1.7, kBob);

      /* ---- landing dip: an impulse that relaxes back to rest.
       *      (no stiff spring: an explicit spring blows up at large dt) ---- */
      this.camDipImpulse = Math.max(0, this.camDipImpulse - dt * 2.4);
      const dipTarget = -this.camDipImpulse * 0.17;
      this.camDip = lerp(this.camDip, dipTarget, damp(20, dt));
      this.landImpact = Math.max(0, this.landImpact - dt * 3.4);

      /* ---- recoil kick: same impulse pattern along the view axis ---- */
      this.camKickImpulse = Math.max(0, this.camKickImpulse - dt * 7.5);
      const kickTarget = this.camKickImpulse * 0.16;
      this.camKick = lerp(this.camKick, kickTarget, damp(22, dt));

      /* ---- airborne: camera drifts up slightly while rising, drops while falling ---- */
      const air = this.grounded ? 0 : clamp(-this.velocity.y * 0.012, -0.09, 0.05);

      /* ---- ADS: raise the weapon, tighten the FOV, zoom through the optic ---- */
      const w = this.weapon;
      const adsTime = w ? Math.max(0.08, w.stats.adsTime * w.stats.adsTimeMul) : 0.2;
      const adsWant = (this.ads && !!w) ? 1 : 0;
      // scoped weapons hold the aim slightly longer past full ADS
      this.scoped = w && this.adsAmt > 0.85 && (w.inst.optic.zoom >= 4);
      this.adsAmt = lerp(this.adsAmt, adsWant, damp(1 / Math.max(0.06, adsTime), dt));
      if (!isFinite(this.adsAmt)) this.adsAmt = 0;

      /* ---- lean: offset the camera sideways, collision aware ---- */
      this.leanAmt = lerp(this.leanAmt, this.lean, damp(11, dt));
      if (!isFinite(this.leanAmt)) this.leanAmt = 0;

      /* ---- dash FOV punch ---- */
      const dashPunch = this.dashT > 0 ? 14 : 0;

      /* ---- FOV: sprint widens, ADS narrows, scope zooms ---- */
      let fovTarget = CFG.fov + (this.sprinting ? 9 : 0) + (speed > 7 ? 2 : 0) + dashPunch;
      if (w && this.adsAmt > 0) {
        const hipToAds = lerp(CFG.fov, w.stats.adsFov, this.adsAmt);
        const zoom = 1 + (Math.max(1, w.stats.zoom) - 1) * this.adsAmt;
        fovTarget = lerp(fovTarget, hipToAds / zoom, this.adsAmt);
      }
      this.fov = lerp(this.fov, clamp(fovTarget, 8, 100), damp(adsWant ? 14 : 9, dt));
      if (Math.abs(cam.fov - this.fov) > 0.01) {
        cam.fov = this.fov;
        cam.updateProjectionMatrix();
      }

      cam.rotation.order = 'YXZ';
      cam.rotation.y = this.yaw;
      cam.rotation.x = this.pitch;
      cam.rotation.z = this.camRoll;

      // camera-local basis for the positional offsets
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const fwdX = -sy * cp, fwdY = sp, fwdZ = -cy * cp;      // -Z rotated by yaw/pitch
      const rightX = cy, rightZ = sy;

      /* ---- lean collision: do not push the camera through a wall ---- */
      let leanOffset = this.leanAmt * CFG.leanDistance;
      if (leanOffset !== 0) {
        const probeX = this.position.x + rightX * leanOffset;
        const probeZ = this.position.z + rightZ * leanOffset;
        const hits = [];
        game.collision.overlapAt(
          new THREE.Vector3(probeX, this.position.y + 1.0, probeZ), 0.12, 1.1, hits, this);
        let blocked = false;
        for (let i = 0; i < hits.length; i++) if (!hits[i].owner) { blocked = true; break; }
        if (blocked) leanOffset *= 0.15;    // hug the cover instead of clipping in
      }

      cam.position.set(
        this.position.x + rightX * (this.camBobX + leanOffset) + this.lookDX + shake.x - fwdX * this.camKick,
        this.position.y + CFG.eyeHeight + this.camBobY - this.camDip + air + this.lookDY + shake.y,
        this.position.z + rightZ * (this.camBobX + leanOffset) + shake.z - fwdZ * this.camKick
      );

      // roll from strafe + lean tilt + a touch of recoil roll
      const strafe = this.velocity.x * rightX + this.velocity.z * rightZ;
      const leanRoll = -this.leanAmt * CFG.leanMaxRoll;
      const targetRoll = clamp(-strafe * 0.006, -0.055, 0.055) + this.camKick * 0.05 + leanRoll;
      this.camRoll = lerp(this.camRoll, targetRoll, damp(9, dt));
      this.camDamageRoll = lerp(this.camDamageRoll || 0, 0, damp(14, dt));
      this.camDamagePitch = lerp(this.camDamagePitch || 0, 0, damp(14, dt));
      // belt and braces: one bad frame must never permanently poison the camera
      if (!isFinite(this.camRoll)) this.camRoll = 0;
      if (!isFinite(this.camDamageRoll)) this.camDamageRoll = 0;
      if (!isFinite(this.camDamagePitch)) this.camDamagePitch = 0;
      if (!isFinite(this.camDip) || !isFinite(this.camKick) || !isFinite(this.camBobX) || !isFinite(this.camBobY)) {
        this.camDip = 0; this.camKick = 0; this.camBobX = 0; this.camBobY = 0;
      }
      cam.rotation.x = this.pitch + this.camDamagePitch;
      cam.rotation.z = this.camRoll + this.camDamageRoll;
      cam.updateMatrixWorld(true);
    }

    _deathCam(dt) {
      this.deathT += dt;
      const cam = this.camera;
      const t = Math.min(1, this.deathT / 1.1);
      const fall = Math.sin(t * Math.PI * 0.5);
      const shake = this.game.shakeOffset;
      cam.position.set(
        this.position.x + this.camBobX * 0.4 + shake.x,
        this.position.y + CFG.eyeHeight - fall * 0.8 + this.camBobY * 0.4 + shake.y,
        this.position.z + shake.z
      );
      cam.rotation.order = 'YXZ';
      cam.rotation.y = this.yaw;
      cam.rotation.x = this.pitch - fall * 0.8;
      cam.rotation.z = fall * 0.4;
      if (Math.abs(cam.fov - CFG.fov) > 0.01) {
        cam.fov = lerp(cam.fov, CFG.fov, damp(4, dt));
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld(true);
    }
  }

  /* ======================================================= ENEMY TYPES */

  const ENEMY_TYPES = {
    grunt: {
      key: 'grunt', name: 'GRUNT',
      hp: 70, damage: 11, speed: 4.3, radius: 0.42, height: 1.72,
      detect: 34, attackRange: 1.95, attackCooldown: 1.05,
      mode: 'melee', color: 0x4f7d3a, armor: 0x2b3f22, eye: 0xff4b3a,
      score: 1, jump: 0.6, width: 1.0
    },
    soldier: {
      key: 'soldier', name: 'SOLDIER',
      hp: 125, damage: 8, speed: 2.85, radius: 0.44, height: 1.8,
      detect: 44, attackRange: 34, attackCooldown: 0.95, burst: 3, burstGap: 0.16,
      accuracy: 0.055, mode: 'ranged', color: 0x2f5d8f, armor: 0x1d3550, eye: 0x4bd6ff,
      score: 1, jump: 0.25, width: 1.0
    },
    tank: {
      key: 'tank', name: 'TANK',
      hp: 340, damage: 30, speed: 1.75, radius: 0.72, height: 2.5,
      detect: 38, attackRange: 2.7, attackCooldown: 1.9,
      mode: 'melee', color: 0x8a3a2a, armor: 0x4a1f16, eye: 0xffd23a,
      score: 2, jump: 0, width: 1.25
    },
    boss: {
      key: 'boss', name: 'STAGE TITAN',
      hp: 2400, damage: 34, speed: 2.7, radius: 1.05, height: 3.6,
      detect: 70, attackRange: 30, attackCooldown: 1.5, burst: 5, burstGap: 0.12,
      accuracy: 0.06, mode: 'boss', color: 0x6b2f8f, armor: 0x2a1038, eye: 0xff2bd6,
      score: 10, jump: 0, width: 1.9, boss: true, slamRange: 4.6, slamDamage: 42,
      chargeSpeed: 4.6, volleyDamage: 15
    },
    /* --------------------- varied roster --------------------- */
    scout: {
      key: 'scout', name: 'SCOUT',
      hp: 48, damage: 8, speed: 5.5, radius: 0.36, height: 1.62,
      detect: 40, attackRange: 1.7, attackCooldown: 0.8,
      mode: 'melee', color: 0x9fbf4a, armor: 0x3d5220, eye: 0xffe14a,
      score: 1, jump: 0.8, width: 0.86, thin: true
    },
    assault: {
      key: 'assault', name: 'ASSAULT',
      hp: 110, damage: 6, speed: 3.2, radius: 0.42, height: 1.76,
      detect: 42, attackRange: 30, attackCooldown: 1.5, burst: 3, burstGap: 0.2,
      accuracy: 0.075, aimDelay: 0.5, bloom: 0.03, reloadDown: 1.6,
      mode: 'ranged', color: 0x3f7a5c, armor: 0x23402f, eye: 0x7dff9c,
      score: 2, jump: 0.2, width: 0.95
    },
    gunner: {
      // NERFED: less damage, worse accuracy, telegraphed aim, bloom, reload downtime
      key: 'gunner', name: 'GUNNER',
      hp: 130, damage: 5, speed: 2.6, radius: 0.44, height: 1.8,
      detect: 38, attackRange: 30, attackCooldown: 2.0, burst: 3, burstGap: 0.22,
      accuracy: 0.085, aimDelay: 0.65, bloom: 0.035, reloadDown: 2.4,
      mode: 'ranged', color: 0x2f5d8f, armor: 0x1d3550, eye: 0x4bd6ff,
      score: 2, jump: 0.25, width: 1.0
    },
    heavy: {
      key: 'heavy', name: 'HEAVY',
      hp: 520, damage: 22, speed: 1.85, radius: 0.82, height: 2.75,
      detect: 34, attackRange: 12, attackCooldown: 2.2, burst: 6, burstGap: 0.14,
      accuracy: 0.075, aimDelay: 0.55, mode: 'ranged', color: 0x8a3a2a, armor: 0x4a1f16,
      eye: 0xffd23a, score: 3, jump: 0, width: 1.35, shotgun: true
    },
    sniper: {
      key: 'sniper', name: 'SNIPER',
      hp: 95, damage: 26, speed: 2.0, radius: 0.42, height: 1.82,
      detect: 70, attackRange: 70, attackCooldown: 3.0,
      accuracy: 0.028, aimDelay: 1.35, mode: 'ranged', color: 0x5b4a7a, armor: 0x2c2440,
      eye: 0xc07aff, score: 3, jump: 0, width: 0.92, laser: true, scope: true
    },
    exploder: {
      key: 'exploder', name: 'EXPLODER',
      hp: 70, damage: 46, speed: 4.2, radius: 0.46, height: 1.7,
      detect: 60, attackRange: 2.6, attackCooldown: 3,
      mode: 'exploder', color: 0xd8a326, armor: 0x6b4a10, eye: 0xff4b3a,
      score: 2, jump: 0, width: 1.05, fuse: 1.1, blastRadius: 4.6, glow: true
    }
  };

  class Enemy {
    constructor(type, pos, waveScale, game) {
      this.type = type;
      this.game = game;
      this.maxHp = Math.round(type.hp * waveScale.hp);
      this.hp = this.maxHp;
      this.damage = type.damage * waveScale.dmg;
      this.speed = type.speed * waveScale.speed;
      this.alive = true;
      this.dead = false;
      this.removeMe = false;

      this.position = pos.clone();
      // never spawn embedded in level geometry
      game.collision.liftOut(this.position, type.radius, type.height);
      this.velocity = new THREE.Vector3();
      this.yaw = Math.random() * Math.PI * 2;
      this.radius = type.radius;
      this.height = type.height;
      this.grounded = false;

      this.state = 'idle';
      this.stateT = 0;
      this.attackCd = rand(0.2, type.attackCooldown);
      this.burstLeft = 0;
      this.burstT = 0;
      this.windup = 0;
      this.strafe = Math.random() < 0.5 ? 1 : -1;
      this.strafeT = rand(1, 2.4);
            this.flashT = 0;
      this.flinch = 0;
      this.flinchDir = new THREE.Vector3(0, 0, 1);
      this.muzzleT = 0;
      this.burnT = 0;
      this.burnDps = 0;
      this.burnTick = 0;
      this.slowT = 0;
      this.muzzleFlash = null;
      this.shotRecoil = 0;
      this.animT = 0;
      this.deathT = 0;
      this.knock = new THREE.Vector3();
      this.legPhase = Math.random() * 6;
      this.spawnT = 0;
      this.canSee = false;
      this.losT = 0;
      this.stuckT = 0;
      this.toP = new THREE.Vector3();
      this.tmp = new THREE.Vector3();
      this.phase = 'advance';     // boss attack pattern phase
      this.phaseT = 0;
      this.shotsLeft = 0;
      this.shotT = 0;

      this.hitBody = new Box(-0.4, 0, -0.4, 0.4, 1.3, 0.4, 'enemy', this);
      this.hitHead = new Box(-0.19, 1.3, -0.19, 0.19, 1.62, 0.19, 'enemy', this);

      this._build();
      game.collision.addDynamic(this.hitBody);
      game.collision.addDynamic(this.hitHead);
    }

    /* -------- procedural body -------- */
    _build() {
      const t = this.type;
      const g = new THREE.Group();
      const bodyMat = new THREE.MeshLambertMaterial({ color: t.color, emissive: 0x000000 });
      const armorMat = new THREE.MeshLambertMaterial({ color: t.armor, emissive: 0x000000 });
      const glowMat = new THREE.MeshBasicMaterial({ color: t.eye });
      this.bodyMat = bodyMat;
      this.armorMat = armorMat;

      const w = t.width || 1.0;
      const s = t.height / 1.78;

      this.root = new THREE.Group();
      this.body = new THREE.Group();
      this.root.add(this.body);
      g.add(this.root);

      const part = (parent, sx, sy, sz, x, y, z, mat) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
        m.position.set(x, y, z);
        m.castShadow = true;
        parent.add(m);
        return m;
      };

      // torso + armor plate
      part(this.body, 0.52 * w, 0.56 * s, 0.32 * w, 0, 1.02 * s, 0, bodyMat);
      part(this.body, 0.6 * w, 0.3 * s, 0.1, 0, 1.06 * s, -0.17 * w, armorMat);
      // pelvis
      part(this.body, 0.44 * w, 0.2 * s, 0.3 * w, 0, 0.66 * s, 0, armorMat);
      // head
      this.head = new THREE.Group();
      this.head.position.set(0, 1.34 * s, 0);
      this.body.add(this.head);
      const hm = part(this.head, 0.3 * w, 0.3 * s, 0.32 * w, 0, 0.02, 0, bodyMat);
      part(this.head, 0.22 * w, 0.07, 0.02, 0, 0.03, -0.17 * w, glowMat);
      // shoulders
      part(this.body, 0.16 * w, 0.3 * s, 0.3 * w, -0.34 * w, 1.06 * s, 0, armorMat);
      part(this.body, 0.16 * w, 0.3 * s, 0.3 * w, 0.34 * w, 1.06 * s, 0, armorMat);

      // arms (pivot at shoulder so they can swing)
      this.armL = new THREE.Group();
      this.armL.position.set(-0.36 * w, 1.18 * s, 0);
      this.body.add(this.armL);
      part(this.armL, 0.14 * w, 0.42 * s, 0.14 * w, 0, -0.2 * s, 0, bodyMat);

      this.armR = new THREE.Group();
      this.armR.position.set(0.36 * w, 1.18 * s, 0);
      this.body.add(this.armR);
      part(this.armR, 0.14 * w, 0.42 * s, 0.14 * w, 0, -0.2 * s, 0, bodyMat);

      // legs
      this.legL = new THREE.Group();
      this.legL.position.set(-0.16 * w, 0.62 * s, 0);
      this.body.add(this.legL);
      part(this.legL, 0.17 * w, 0.62 * s, 0.2 * w, 0, -0.3 * s, 0, armorMat);

      this.legR = new THREE.Group();
      this.legR.position.set(0.16 * w, 0.62 * s, 0);
      this.body.add(this.legR);
      part(this.legR, 0.17 * w, 0.62 * s, 0.2 * w, 0, -0.3 * s, 0, armorMat);

      // weapon
      if (this.type.mode === 'ranged') {
        part(this.armR, 0.08, 0.09, 0.62, 0, -0.34 * s, -0.34, armorMat);
        part(this.armR, 0.06, 0.06, 0.3, 0, -0.34 * s, -0.72, armorMat);
        this.muzzleLocal = new THREE.Vector3(0, -0.34 * s, -0.9);
      } else if (this.type.key === 'tank') {
        part(this.armR, 0.3, 0.3, 0.4, 0, -0.26 * s, -0.2, armorMat);
        part(this.armL, 0.28, 0.28, 0.36, 0, -0.26 * s, -0.18, armorMat);
        this.muzzleLocal = new THREE.Vector3(0, -0.26 * s, -0.42);
      } else {
        part(this.armR, 0.13, 0.16, 0.3, 0, -0.34 * s, -0.14, armorMat);
        this.muzzleLocal = new THREE.Vector3(0, -0.4 * s, -0.3);
      }

      // muzzle flash sprite (hidden until the enemy actually shoots)
      const mGeo = new THREE.ConeGeometry(0.13, 0.34, 6, 1, true);
      mGeo.rotateX(-Math.PI / 2);
      mGeo.translate(0, 0, -0.16);
      this.muzzleFlash = new THREE.Mesh(mGeo, new THREE.MeshBasicMaterial({
        color: 0xfff0b0, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      }));
      this.muzzleFlash.position.copy(this.muzzleLocal);
      this.muzzleFlash.visible = false;
      this.armR.add(this.muzzleFlash);

      // health pip bar (billboard-ish, cheap)
      const barBg = new THREE.Mesh(
        new THREE.PlaneGeometry(0.72, 0.07),
        new THREE.MeshBasicMaterial({ color: 0x1a1a1a, depthTest: false, transparent: true })
      );
      const barFg = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 0.05),
        new THREE.MeshBasicMaterial({ color: this.type.key === 'tank' ? 0xff6a3a : 0x8cff5a, depthTest: false, transparent: true })
      );
      barBg.position.set(0, this.type.height + 0.32, 0);
      barFg.position.set(0, this.type.height + 0.32, 0.001);
      barBg.renderOrder = 20; barFg.renderOrder = 21;
      this.hpBarBg = barBg; this.hpBarFg = barFg;
      this.hpBarGroup = new THREE.Group();
      this.hpBarGroup.add(barBg); this.hpBarGroup.add(barFg);
      this.root.add(this.hpBarGroup);

      // exploders carry a pulsing core light: the visible "get away" tell
      if (this.type.glow) {
        this.glowLight = new THREE.PointLight(0xff8a1a, 0.7, 5.5, 2);
        this.glowLight.position.set(0, 0.9 * s, 0);
        this.body.add(this.glowLight);
        this.glowCore = new THREE.Mesh(
          new THREE.SphereGeometry(0.15 * w, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffc24a })
        );
        this.glowCore.position.set(0, 1.0 * s, -0.16 * w);
        this.body.add(this.glowCore);
      }
      // snipers carry a scope tube so the silhouette reads at distance
      if (this.type.scope) {
        part(this.head, 0.09, 0.09, 0.26, 0, 0.14, 0.02, armorMat);
        part(this.head, 0.13, 0.13, 0.03, 0, 0.14, -0.11,
          new THREE.MeshBasicMaterial({ color: 0xc07aff }));
      }
      // heavies lug a drum-fed shotgun
      if (this.type.shotgun) {
        part(this.armR, 0.09, 0.1, 0.52, 0, -0.3 * s, -0.34, armorMat);
        part(this.armR, 0.15, 0.17, 0.12, 0, -0.3 * s, -0.08, bodyMat);
      }

      this.mesh = g;
      this.mesh.position.copy(this.position);
      this.mesh.scale.setScalar(0.01);
    }

    get eyeY() { return this.position.y + this.type.height * 0.86; }
    get chestY() { return this.position.y + this.type.height * 0.6; }

    worldMuzzle(out) {
      this.armR.updateMatrixWorld(true);
      return out.copy(this.muzzleLocal).applyMatrix4(this.armR.matrixWorld);
    }

    /* -------- damage -------- */
    takeDamage(amount, dir, head, game) {
      if (!this.alive) return;
      this.hp -= amount;
      this.flashT = 0.11;
      this.strafeT = Math.min(this.strafeT, 0.25);

      const hitPos = new THREE.Vector3(
        this.position.x, head ? this.eyeY : this.chestY, this.position.z
      );
      game.particles.burst(head ? 14 : 8, hitPos.x, hitPos.y, hitPos.z, {
        spread: head ? 3.2 : 2.1, up: 2.4,
        lifeMin: 0.18, lifeMax: 0.5,
        sizeMin: 0.03, sizeMax: 0.085,
        color: [0.72, 0.05, 0.07], grav: 11, drag: 1.6
      });
      game.particles.burst(4, hitPos.x, hitPos.y, hitPos.z, {
        spread: 2.4, up: 2, lifeMin: 0.08, lifeMax: 0.2,
        sizeMin: 0.02, sizeMax: 0.05, color: [1.0, 0.35, 0.25], grav: 4, drag: 3
      });

      if (this.state === 'idle') this.state = 'chase';

      // hit reaction: flash + a flinch away from the bullet
      this.flinch = Math.min(1, this.flinch + (head ? 0.85 : 0.55));
      this.flinchDir.set(dir.x, 0, dir.z);
      if (this.flinchDir.lengthSq() < 0.0001) this.flinchDir.set(0, 0, 1);
      this.flinchDir.normalize();

      // knockback (bosses barely react)
      const kMul = this.type.boss ? 0.18 : 1;
      this.knock.addScaledVector(dir, (head ? 2.4 : 1.1) * kMul);

      if (this.hp <= 0) this.die(game);
    }

    die(game) {
      if (!this.alive) return;
      this.alive = false;
      this.dead = true;
      this.deathT = 0;
      // every corpse topples a slightly different way
      const lean = rand(0.75, 1.25);
      this.deathAxis = {
        x: (Math.PI / 2) * 0.92 * (Math.random() < 0.35 ? -lean : lean),
        y: rand(-0.35, 0.35),
        z: rand(-0.45, 0.45)
      };
      this.velDying = new THREE.Vector3(this.knock.x, Math.abs(this.knock.y) + 1.4, this.knock.z).multiplyScalar(0.45);
      this.hpBarGroup.visible = false;
      game.audio.enemyDeath();
      game.stats.kills++;
      game.onEnemyKilled(this);
      const p = this.position;
      game.particles.burst(26, p.x, this.chestY, p.z, {
        spread: 3.4, up: 3.2, lifeMin: 0.3, lifeMax: 0.85,
        sizeMin: 0.04, sizeMax: 0.1, color: [0.65, 0.06, 0.08], grav: 12, drag: 1.4
      });
      game.particles.burst(10, p.x, this.chestY, p.z, {
        spread: 2.2, up: 2.4, lifeMin: 0.25, lifeMax: 0.6,
        sizeMin: 0.02, sizeMax: 0.06, color: [1.0, 0.55, 0.2], grav: 6, drag: 2
      });
    }

    update(dt, game) {
      if (this.dead) { this._updateDead(dt, game); this._updateShockwaves(dt); return; }
      this._updateShockwaves(dt);

      // boss entrance: animation only, no AI, no physics (for everybody)
      if (this.frozen) {
        this.velocity.set(0, 0, 0);
        this._animate(dt, game);
        return;
      }

      this.stateT += dt;
      this.spawnT = Math.min(1, this.spawnT + dt * 3.2);

      const player = game.player;
      const t = this.type;

      // ---------- perception ----------
      const toPlayer = this.toP.subVectors(player.position, this.position);
      const dist = Math.hypot(toPlayer.x, toPlayer.z);
      const canTarget = player.alive;
      this.losT -= dt;
      if (this.losT <= 0) {
        this.losT = 0.12 + Math.random() * 0.08;
        const eye = this.tmp.set(this.position.x, this.eyeY, this.position.z);
        const tgt = new THREE.Vector3(player.position.x, player.position.y + 1.2, player.position.z);
        this.canSee = canTarget && dist < t.detect && game.collision.hasLineOfSight(eye, tgt);
      }
      if (!canTarget && this.state !== 'idle') this.state = 'idle';

      if (t.mode === 'boss') {
        this._bossThink(dt, game, dist, toPlayer, canTarget);
      } else if (t.mode === 'exploder') {
        this._exploderThink(dt, game, dist, toPlayer, canTarget);
      } else {
        switch (this.state) {
          case 'idle': this._idle(dt, game); break;
          case 'chase': this._chase(dt, game, dist, toPlayer); break;
          case 'attack': this._attack(dt, game, dist, toPlayer); break;
        }
        // snipers telegraph the shot with a laser before firing
        if (t.laser) this._sniperLaser(dt, game, dist, canTarget);
      }

      /* ---- burn damage over time (fire man): plain numbers, no timers ---- */
      if (this.burnT > 0) {
        this.burnT -= dt;
        this.burnFxT = (this.burnFxT || 0) - dt;
        if (this.burnFxT <= 0) {
          this.burnFxT = 0.08;
          game.particles.burst(1, this.position.x + rand(-0.25, 0.25), this.position.y + rand(0.3, 1.2), this.position.z + rand(-0.25, 0.25), {
            spread: 0.25, up: 1.5, lifeMin: 0.25, lifeMax: 0.55,
            sizeMin: 0.03, sizeMax: 0.08, color: [1.0, 0.45 + Math.random() * 0.35, 0.08], grav: -2.2, drag: 1.2
          });
        }
        this.burnTick -= dt;
        if (this.burnTick <= 0) {
          this.burnTick = 0.5;
          const dps = this.burnDps || 0;
          this.hp -= dps * 0.5;
          game.particles.burst(2, this.position.x, this.position.y + 0.9, this.position.z, {
            spread: 0.35, up: 1.2, lifeMin: 0.2, lifeMax: 0.45,
            sizeMin: 0.04, sizeMax: 0.1, color: [1.0, 0.5, 0.12], grav: -1.6, drag: 1.4
          });
          if (this.hp <= 0) this.die(game);
        }
      }
      // crowd-control slow (gravity pulse)
      if (this.slowT > 0) { this.slowT -= dt; }

      // ---------- physics ----------
      this.knock.multiplyScalar(Math.max(0, 1 - 7 * dt));
      const vx = this.velocity.x + this.knock.x;
      const vz = this.velocity.z + this.knock.z;
      const vy = this.velocity.y - CFG.gravity * dt;
      const res = game.collision.moveEntity(this, vx * dt, vy * dt, vz * dt,
        this.grounded ? (t.jump > 0 ? 0.4 : 0.2) : 0);
      this.velocity.y = vy;                     // keep gravity applied every frame
      if (res.ground) { this.velocity.y = 0; this.grounded = true; }
      else if (res.ceiling) { this.velocity.y = Math.min(0, this.velocity.y); this.grounded = false; }
      else this.grounded = false;
      if (res.hitX) { this.velocity.x = 0; this.stuckT = (this.stuckT || 0) + dt; }
      if (res.hitZ) { this.velocity.z = 0; this.stuckT = (this.stuckT || 0) + dt; }
      if (!res.hitX && !res.hitZ) this.stuckT = 0;
      this.position.y = Math.max(this.position.y, 0);

      // ---------- animation ----------
      this._animate(dt, game);
      this._updateHitboxes();
    }

    /* ---------------- boss pattern ----------------
     * advance (charge) -> volley (burst) -> slam (close range shockwave)
     * Enrages as its health drops: faster charges, bigger bursts.           */
    _bossThink(dt, game, dist, toPlayer, canTarget) {
      const t = this.type;
      const player = game.player;
      const phase = this.phase || 'advance';
      this.phase = phase;
      this.phaseT += dt;
      const enrage = 1 - clamp(this.hp / this.maxHp, 0, 1);        // 0 -> 1 as it dies

      if (phase === 'advance') {
        if (canTarget && dist > t.attackRange) {
          const inv = 1 / (dist || 1);
          const charge = t.chargeSpeed * (1 + enrage * 0.45);
          this.velocity.x = lerp(this.velocity.x, toPlayer.x * inv * charge, damp(6, dt));
          this.velocity.z = lerp(this.velocity.z, toPlayer.z * inv * charge, damp(6, dt));
          this.faceTarget(toPlayer.x, toPlayer.z, dt, 6);
        } else {
          this.velocity.x *= Math.max(0, 1 - 6 * dt);
          this.velocity.z *= Math.max(0, 1 - 6 * dt);
          if (canTarget) {
            this.faceTarget(toPlayer.x, toPlayer.z, dt, 10);
            this._setPhase('volley');
            this.shotsLeft = 5 + Math.round(enrage * 3);
            this.shotT = 0;
          }
        }
      } else if (phase === 'volley') {
        this.velocity.x *= Math.max(0, 1 - 8 * dt);
        this.velocity.z *= Math.max(0, 1 - 8 * dt);
        this.faceTarget(toPlayer.x, toPlayer.z, dt, 9);
        this.shotT -= dt;
        if (this.shotT <= 0 && this.shotsLeft > 0 && canTarget) {
          this.shotsLeft--;
          this.shotT = t.burstGap;
          this._bossShot(game, player, t.volleyDamage * (1 + enrage * 0.3), 0.055);
        }
        if (this.shotsLeft <= 0) {
          if (dist < t.slamRange) this._setPhase('slam');
          else { this._setPhase('advance'); }
        }
      } else if (phase === 'slam') {
        this.velocity.x *= Math.max(0, 1 - 10 * dt);
        this.velocity.z *= Math.max(0, 1 - 10 * dt);
        this.faceTarget(toPlayer.x, toPlayer.z, dt, 12);
        if (this.phaseT > 0.55) {
          // shockwave hits anything close, plus a ring of debris
          const p = this.position;
          this._updateShockwaves(dt);
          game.particles.burst(26, p.x, p.y + 0.2, p.z, {
            spread: 4.2, up: 1.6, lifeMin: 0.2, lifeMax: 0.55,
            sizeMin: 0.03, sizeMax: 0.08, color: [0.85, 0.35, 1.0], grav: 7, drag: 2.2
          });
          game.addShake(0.45);
          game.audio.tone(game.audio.t, 0.3, 160, 50, 0.35, 'sawtooth');
          if (player.alive && dist < t.slamRange + 0.8) {
            player.damage(t.slamDamage * (1 + enrage * 0.4), this.position, false, { type: 'boss_slam', isBoss: true });
          }
          this._setPhase('advance');
        }
      }

      /* ---- enrage: below 40% HP the titan burns hotter and moves quicker ---- */
      if (enrage > 0.6) {
        this.enraged = true;
        this.auraT = (this.auraT || 0) - dt;
        if (this.auraT <= 0) {
          this.auraT = 0.09;
          game.particles.burst(2, this.position.x, this.position.y + 1.2, this.position.z, {
            spread: 0.9, up: 1.6, lifeMin: 0.3, lifeMax: 0.8,
            sizeMin: 0.05, sizeMax: 0.14, color: [1.0, 0.2, 0.55], grav: -1.5, drag: 1.5
          });
        }
      }

      // arms: raise while volleying, slam downward during the slam wind-up
      if (phase === 'volley') {
        this.armR.rotation.x = lerp(this.armR.rotation.x, -1.45, damp(10, dt));
        this.armL.rotation.x = lerp(this.armL.rotation.x, -1.1, damp(10, dt));
      } else if (phase === 'slam') {
        this.armR.rotation.x = -2.4 * clamp(this.phaseT / 0.5, 0, 1);
        this.armL.rotation.x = this.armR.rotation.x;
      } else {
        this.armR.rotation.x = lerp(this.armR.rotation.x, -0.5, damp(6, dt));
      }
    }

    _setPhase(p) {
      this.phase = p;
      this.phaseT = 0;
      if (p === 'slam') this._spawnShockwave();
    }

    /** expanding ground ring that sells the slam impact */
    _spawnShockwave() {
      const game = this.game;
      if (!this.shockwaves) this.shockwaves = [];
      const geo = shared(GEO, 'shock', () => new THREE.RingGeometry(0.6, 1.0, 24));
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff4fd0, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(this.position.x, this.position.y + 0.08, this.position.z);
      game.scene.add(mesh);
      this.shockwaves.push({ mesh: mesh, mat: mat, t: 0 });
    }

    _updateShockwaves(dt) {
      if (!this.shockwaves) return;
      for (let i = this.shockwaves.length - 1; i >= 0; i--) {
        const s = this.shockwaves[i];
        s.t += dt;
        const k = s.t / 0.55;
        s.mesh.scale.setScalar(0.6 + k * 5.2);
        s.mat.opacity = Math.max(0, 0.8 * (1 - k));
        if (k >= 1) {
          this.game.scene.remove(s.mesh);
          s.mat.dispose();
          this.shockwaves.splice(i, 1);
        }
      }
    }

    _bossShot(game, player, damage, spread) {
      const muzzle = this.worldMuzzle(this.tmp);
      const origin = muzzle.clone();
      const target = new THREE.Vector3(
        player.position.x, player.position.y + 1.1, player.position.z);
      const dist = origin.distanceTo(target);
      // bloom from sustained fire widens the cone for the rest of the burst
      const spreadNow = spread * (1 + (this.bloom || 0));
      target.x += rand(-spreadNow, spreadNow) * dist * 0.55;
      target.y += rand(-spreadNow, spreadNow) * dist * 0.35;
      target.z += rand(-spreadNow, spreadNow) * dist * 0.55;
      const dir = target.sub(origin).normalize();
      const hitT = game.collision.rayWorld(origin, dir, 90);
      const end = origin.clone().addScaledVector(dir, hitT);
      game.tracers.add(origin, end, 1.0, 0.25, 0.9, 0.09);
      game.audio.enemyShoot();
      this.muzzleT = 0.05;                 // visible muzzle flash on the enemy
      this.shotRecoil = 1;
      game.particles.burst(6, origin.x, origin.y, origin.z, {
        spread: 1.3, up: 1.1, lifeMin: 0.05, lifeMax: 0.14,
        sizeMin: 0.02, sizeMax: 0.07, color: [1.0, 0.4, 0.9], grav: 0, drag: 5
      });
      const tb = rayAABB(origin, dir, player.hitHead.min, player.hitHead.max, hitT);
      const tbd = rayAABB(origin, dir, player.hitBody.min, player.hitBody.max, hitT);
      if (tb < hitT) player.damage(damage * 1.5, this.position, true, { type: 'boss_attack', isBoss: true });
      else if (tbd < hitT) player.damage(damage, this.position, false, { type: 'boss_attack', isBoss: true });
      else if (hitT < 90) {
        game.particles.burst(4, end.x, end.y, end.z, {
          spread: 1.4, up: 1.4, lifeMin: 0.1, lifeMax: 0.3,
          sizeMin: 0.015, sizeMax: 0.04, color: [0.8, 0.4, 1.0], grav: 9, drag: 2.4
        });
      }
    }

    /* ---------------- exploder: beelines, beeps, detonates ---------------- */
    _exploderThink(dt, game, dist, toPlayer, canTarget) {
      const t = this.type;
      const player = game.player;
      if (!canTarget) { this.state = 'idle'; this.velocity.x *= 0.9; this.velocity.z *= 0.9; return; }
      if (this.state === 'idle') this.state = 'chase';

      const inv = 1 / (dist || 1);
      const sp = this.speed * (this.fuse > 0 ? 1.25 : 1);
      this.velocity.x = lerp(this.velocity.x, toPlayer.x * inv * sp, damp(7, dt));
      this.velocity.z = lerp(this.velocity.z, toPlayer.z * inv * sp, damp(7, dt));
      this.faceTarget(toPlayer.x, toPlayer.z, dt, 10);

      /* the fuse only arms on contact and then always runs out */
      if (this.fuse > 0) {
        const urgency = 1 + (1 - dist / Math.max(1, t.detect)) * 2;
        this.beep = (this.beep || 0) - dt * urgency * 3.2;
        if (this.beep <= 0) {
          this.beep = 0.32;
          game.audio.tone(game.audio.t, 0.12, 900 + (1 - this.fuse / t.fuse) * 500, 500, 0.08, 'square');
          if (this.glowLight) this.glowLight.intensity = 1.6 + Math.sin(this.fuse * 30) * 0.8;
        }
        this.fuse -= dt;
        if (this.fuse <= 0) this._explode(game, player);
      } else if (dist < t.attackRange) {
        this.fuse = t.fuse;                       // contact: start burning
        this.beep = 0;
        if (this.glowLight) this.glowLight.intensity = 1.6;
      }
    }

    _explode(game, player) {
      const t = this.type;
      const p = this.position;
      game.particles.burst(34, p.x, p.y + 0.4, p.z, {
        spread: t.blastRadius, up: 2.4, lifeMin: 0.2, lifeMax: 0.7,
        sizeMin: 0.05, sizeMax: 0.16, color: [1.0, 0.6, 0.15], grav: 5, drag: 1.8
      });
      game.addShake(0.5);
      game.audio.tone(game.audio.t, 0.3, 150, 40, 0.4, 'sawtooth');
      if (player.alive) {
        const d = player.position.distanceTo(p);
        if (d < t.blastRadius) {
          player.damage(t.damage * (1 - d / t.blastRadius), p, false, { type: 'exploder', sourcePosition: p, isExplosion: true });
        }
      }
      this.hp = 0;
      this.die(game);
    }

    /* ---------------- sniper telegraph ---------------- */
    _sniperLaser(dt, game, dist, canTarget) {
      const t = this.type;
      if (!this.laser) {
        const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
        geo.translate(0, 0.5, 0);
        this.laser = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xff3b6a, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false
        }));
        this.laser.frustumCulled = false;
        this.mesh.add(this.laser);
      }
      // the laser is up while the shot is being lined up
      const charging = canTarget && this.state === 'attack' && dist < t.attackRange && dist > 12;
      this.laser.visible = charging;
      if (!charging) return;
      const origin = this.worldMuzzle(new THREE.Vector3());
      const target = game.camera.position;
      const dir = target.clone().sub(origin);
      const len = dir.length();
      dir.normalize();
      this.laser.position.copy(origin);
      this.laser.scale.set(1, len, 1);
      this.laser.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.laser.material.opacity = 0.25 + 0.5 * clamp(1 - this.stateT / Math.max(0.1, t.aimDelay), 0, 1);
    }

    _idle(dt, game) {
      // idle scan: slowly rotate and look around
      this.yaw += Math.sin(this.stateT * 0.8 + this.legPhase) * dt * 0.5;
      const player = game.player;
      if (this.canSee && player.alive) this._toChase();
      else this.velocity.x = this.velocity.z = 0;
    }

    _toChase() { this.state = 'chase'; this.stateT = 0; }

    _chase(dt, game, dist, toPlayer) {
      const t = this.type;
      const player = game.player;
      if (!player.alive) { this.state = 'idle'; return; }
      if (!this.canSee && this.stateT > 3.5) { this.state = 'idle'; this.stateT = 0; return; }

      const desired = dist;
      let move = true;
      if (t.mode === 'ranged') {
        move = dist > t.attackRange * 0.55;
        // strafe while keeping a firing distance
        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeT = rand(1.2, 2.6); this.strafe = -this.strafe; }
      } else {
        move = dist > t.attackRange * 0.8;
      }

      let dirX = 0, dirZ = 0;
      if (move) {
        const inv = 1 / (dist || 1);
        dirX = toPlayer.x * inv; dirZ = toPlayer.z * inv;
        if (t.mode === 'ranged' && dist < t.attackRange * 0.55) {
          // back off
          dirX = -dirX; dirZ = -dirZ;
        } else if (t.mode === 'ranged') {
          const bx = dirX, bz = dirZ;
          dirX = bx - bz * this.strafe * 0.6;
          dirZ = bz + bx * this.strafe * 0.6;
        }
      } else if (t.mode === 'ranged' && dist < t.attackRange) {
        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeT = rand(1.2, 2.6); this.strafe = -this.strafe; }
        const inv = 1 / (dist || 1);
        dirX = -toPlayer.z * inv * this.strafe;
        dirZ = toPlayer.x * inv * this.strafe;
      }

      // unstick: if blocked for too long, pick a new sidestep
      if (this.stuckT > 0.55) {
        this.stuckT = 0;
        this.strafe = Math.random() < 0.5 ? 1 : -1;
        const a = Math.random() * Math.PI * 2;
        this.velocity.x = Math.cos(a) * this.speed;
        this.velocity.z = Math.sin(a) * this.speed;
        this.stateT = Math.min(this.stateT, 1.2);
      }

      const sp = (move ? this.speed : (dirX || dirZ ? this.speed * 0.5 : 0)) * (this.slowT > 0 ? 0.35 : 1);
      const target = this.tmp.set(dirX, 0, dirZ).normalize().multiplyScalar(sp);
      this.velocity.x = lerp(this.velocity.x, target.x, damp(9, dt));
      this.velocity.z = lerp(this.velocity.z, target.z, damp(9, dt));

      // face the player
      this.faceTarget(toPlayer.x, toPlayer.z, dt, 8);

      // jump small ledges
      if (this.grounded && this.velocity.y <= 0 && (this.stuckT > 0.1) && t.jump > 0 && Math.random() < dt * 3.5) {
        this.velocity.y = 5.4;
      }

      this.attackCd -= dt;

      /* ranged units telegraph before firing, and reposition when the player
       * is behind cover instead of emptying a magazine into a wall */
      if (t.mode === 'ranged') {
        this.reloading = this.reloading > 0 ? this.reloading - dt : 0;
        if (!this.canSee && dist < t.attackRange) {
          // no line of sight: close the distance or slide along
          this.repositionT = (this.repositionT || 0) - dt;
          if (this.repositionT <= 0) {
            this.repositionT = 0.9 + Math.random() * 0.6;
            const a = Math.atan2(toPlayer.z, toPlayer.x) + (Math.random() < 0.5 ? 1.15 : -1.15);
            this.moveTarget = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
          }
          const mv = this.moveTarget || this.tmp;
          this.velocity.x = lerp(this.velocity.x, mv.x * this.speed * 0.9, damp(6, dt));
          this.velocity.z = lerp(this.velocity.z, mv.z * this.speed * 0.9, damp(6, dt));
          if (this.reloading <= 0) this.attackCd = Math.max(this.attackCd, 0.4);
          return;
        }
        if (this.reloading > 0) return;               // magazine change downtime
      }

      if (dist < t.attackRange && this.attackCd <= 0 && this.canSee) {
        this.state = 'attack';
        this.stateT = 0;
        this.burstLeft = t.burst || 1;
        this.burstT = 0;
        // aim delay: the gunner must line the shot up before firing
        this.windup = t.mode === 'melee' ? 0.32 : (t.aimDelay || 0.2);
        this.bloom = 0;
        this.velocity.x = this.velocity.z = 0;
      }
    }

    _attack(dt, game, dist, toPlayer) {
      const t = this.type;
      const player = game.player;
      this.velocity.x *= Math.max(0, 1 - 6 * dt);
      this.velocity.z *= Math.max(0, 1 - 6 * dt);
      this.faceTarget(toPlayer.x, toPlayer.z, dt, 12);

      if (this.windup > 0) {
        this.windup -= dt;
        if (this.windup <= 0) this._doAttack(game, dist);
        return;
      }

      if (t.mode === 'ranged') {
        this.burstT -= dt;
        if (this.burstLeft > 0 && this.burstT <= 0) {
          this._shoot(game);
          this.burstLeft--;
          this.burstT = t.burstGap;
          // sustained fire blooms: later rounds in a burst are less accurate
          this.bloom = Math.min(1, (this.bloom || 0) + (t.bloom || 0.02));
        }
        if (this.burstLeft <= 0) {
          this.state = 'chase';
          this.stateT = 0;
          this.attackCd = t.attackCooldown;
          // reload downtime keeps gunners from being a constant stream of fire
          if (t.reloadDown) this.reloading = t.reloadDown;
          this.bloom = 0;
        }
      } else {
        // melee swing completes, then brief recovery
        if (this.stateT > 0.45) {
          this.state = 'chase';
          this.stateT = 0;
          this.attackCd = t.attackCooldown;
        }
      }
    }

    _doAttack(game, dist) {
      const t = this.type;
      if (t.mode === 'melee') {
        // melee: instant damage if still in range
        if (dist < t.attackRange + 0.4 && game.player.alive) {
          game.player.damage(this.damage, this.position, false, { type: 'melee', source: this });
        }
        const p = this.position;
        game.particles.burst(6, p.x, this.chestY, p.z - Math.cos(this.yaw) * 0.6, {
          spread: 1.4, up: 1.2, lifeMin: 0.1, lifeMax: 0.25,
          sizeMin: 0.02, sizeMax: 0.05, color: [0.8, 0.5, 0.3], grav: 6, drag: 3
        });
      } else {
        this.burstLeft = t.burst;
        this.burstT = 0;
      }
    }

    _shoot(game) {
      const t = this.type;
      const player = game.player;
      if (!player.alive) return;

      const muzzle = this.worldMuzzle(new THREE.Vector3());
      const origin = muzzle.clone();
      const target = new THREE.Vector3(
        player.position.x,
        player.position.y + 1.1,
        player.position.z
      );
      const dist = origin.distanceTo(target);
      // accuracy: random spread that grows slightly with distance
      const acc = t.accuracy * (1 + dist * 0.006);
      target.x += rand(-acc, acc) * dist * 0.55;
      target.y += rand(-acc, acc) * dist * 0.35;
      target.z += rand(-acc, acc) * dist * 0.55;

      const dir = target.sub(origin).normalize();
      const worldT = game.collision.rayWorld(origin, dir, 90);
      let hitT = worldT;
      let hitPlayer = false;
      let head = false;
      const tb = rayAABB(origin, dir, player.hitHead.min, player.hitHead.max, hitT);
      const tbd = rayAABB(origin, dir, player.hitBody.min, player.hitBody.max, hitT);
      if (tb < hitT) { hitT = tb; hitPlayer = true; head = true; }
      else if (tbd < hitT) { hitT = tbd; hitPlayer = true; head = false; }

      const end = origin.clone().addScaledVector(dir, hitT);
      game.tracers.add(origin, end, 1.0, 0.45, 0.3, 0.06);
      game.audio.enemyShoot();
      this.muzzleT = 0.05;
      this.shotRecoil = 1;
      game.particles.burst(5, origin.x, origin.y, origin.z, {
        spread: 1.1, up: 1.0, lifeMin: 0.05, lifeMax: 0.13,
        sizeMin: 0.02, sizeMax: 0.06, color: [1.0, 0.7, 0.3], grav: 0, drag: 5
      });

      if (hitPlayer) {
        player.damage(this.damage * (head ? 1.8 : 1), this.position, head, { type: 'bullet', source: this });
        game.particles.burst(6, end.x, end.y, end.z, {
          spread: 1.6, up: 1.6, lifeMin: 0.12, lifeMax: 0.35,
          sizeMin: 0.02, sizeMax: 0.05, color: [0.8, 0.1, 0.1], grav: 9, drag: 2
        });
      } else if (hitT < 90) {
        game.particles.burst(3, end.x, end.y, end.z, {
          spread: 1.2, up: 1.2, lifeMin: 0.1, lifeMax: 0.28,
          sizeMin: 0.015, sizeMax: 0.035, color: [0.9, 0.7, 0.4], grav: 10, drag: 2.4
        });
      }
    }

    faceTarget(tx, tz, dt, rate) {
      // the mesh's local -Z axis points forward, so yaw = atan2(-dx, -dz)
      const want = Math.atan2(-(tx - this.position.x), -(tz - this.position.z));
      let d = want - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * damp(rate, dt);
    }

    _animate(dt, game) {
      const t = this.type;
      const s = t.height / 1.78;
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const boss = !!t.boss;
      this.animT = (this.animT || 0) + dt;

      /* ---- walk cycle: legs, arms, body bob + forward lean ---- */
      const strideRate = boss ? 1.5 + speed * 1.15 : 2.2 + speed * 2.1;
      this.legPhase += dt * strideRate;
      const swing = clamp(speed / Math.max(0.5, this.speed), 0, 1.4);
      const amp = (boss ? 0.72 : 0.55) * swing;
      const bob = Math.abs(Math.sin(this.legPhase)) * (boss ? 0.09 : 0.045) * swing;

      this.legL.rotation.x = Math.sin(this.legPhase) * amp;
      this.legR.rotation.x = -Math.sin(this.legPhase) * amp;
      this.armL.rotation.x = -Math.sin(this.legPhase) * amp * (boss ? 0.4 : 0.8);

      /* ---- idle: breathing + weight shift so nobody stands like a statue ---- */
      const idle = swing < 0.12;
      const breatheRate = boss ? 1.5 : 2.3;
      const breathe = Math.sin(this.animT * breatheRate) * (idle ? 1 : 0.35);
      const sway = Math.sin(this.animT * 0.6 + this.legPhase) * (idle ? 1 : 0.3);
      this.body.position.y = breathe * (boss ? 0.07 : 0.022) - bob;
      this.body.rotation.z = sway * (idle ? 0.035 : 0.02) + this.flinch * 0.25;
      this.body.rotation.x = swing * 0.10 + this.flinch * -0.3;

      /* ---- attack poses: anticipation -> strike -> recovery ---- */
      if (this.state === 'attack' && !boss) {
        if (t.mode === 'ranged') {
          const p = clamp(this.stateT / 0.45, 0, 1);
          const recoil = Math.max(0, this.shotRecoil || 0);
          this.armR.rotation.x = -1.35 - recoil * 0.5 + Math.sin(game.time * 22) * 0.04;
          this.armL.rotation.x = -0.9;
          this.body.rotation.x += -recoil * 0.1;
        } else {
          // wind up (0 - 0.22) then swing through (0.22 - 0.34) then settle
          const p = this.stateT;
          let swingX;
          if (p < 0.22) swingX = -2.2 * (p / 0.22);
          else if (p < 0.36) swingX = lerp(-2.2, 0.9, (p - 0.22) / 0.14);
          else swingX = lerp(0.9, -0.35, clamp((p - 0.36) / 0.2, 0, 1));
          this.armR.rotation.x = swingX;
          this.armL.rotation.x = swingX * 0.55;
          this.body.rotation.x += (p < 0.22 ? -0.12 : 0.16) * (1 - Math.abs(p - 0.3));
        }
      } else if (t.mode === 'ranged') {
        this.armR.rotation.x = lerp(this.armR.rotation.x, -1.25, damp(8, dt));
        this.armL.rotation.x = lerp(this.armL.rotation.x, -0.75, damp(8, dt));
      } else {
        this.armR.rotation.x = lerp(this.armR.rotation.x, -0.35, damp(6, dt));
      }
      if (this.shotRecoil) this.shotRecoil = Math.max(0, this.shotRecoil - dt * 5);

      /* ---- head: track the player, idle scanning when unaware ---- */
      if (this.state !== 'idle') {
        const dy = game.player.position.y - this.position.y;
        this.head.rotation.x = clamp(-dy * 0.12, -0.4, 0.4);
      } else {
        this.head.rotation.y = Math.sin(this.animT * 0.5) * 0.5;
      }

      /* ---- hit flinch: lean away from the incoming round ---- */
      if (this.flinch > 0) {
        this.flinch = Math.max(0, this.flinch - dt * 5.5);
        this.mesh.position.x += this.flinchDir.x * this.flinch * 0.09;
        this.mesh.position.z += this.flinchDir.z * this.flinch * 0.09;
      }

      this.mesh.position.set(this.position.x, this.position.y, this.position.z);
      this.mesh.rotation.y = this.yaw;
      const sc = this.spawnT < 1 ? this.spawnT * this.spawnT : 1;
      this.mesh.scale.setScalar(sc);

      // hit flash
      if (this.flashT > 0) {
        this.flashT -= dt;
        const k = Math.max(0, this.flashT / 0.11);
        this.bodyMat.emissive.setRGB(k, k * 0.55, k * 0.5);
        this.armorMat.emissive.setRGB(k, k * 0.4, k * 0.35);
      } else {
        this.bodyMat.emissive.setRGB(0, 0, 0);
        this.armorMat.emissive.setRGB(0, 0, 0);
      }

      // health bar (bosses use the dedicated UI bar instead)
      if (boss) {
        this.hpBarGroup.visible = false;
      } else if (this.canSee || this.hp < this.maxHp) {
        this.hpBarGroup.visible = true;
        this.hpBarGroup.lookAt(game.camera.position);
        const f = clamp(this.hp / this.maxHp, 0, 1);
        this.hpBarFg.scale.x = Math.max(0.001, f);
        this.hpBarFg.position.x = -(1 - f) * 0.35;
      } else {
        this.hpBarGroup.visible = false;
      }

      // enemy muzzle flash
      if (this.muzzleT > 0) {
        this.muzzleT -= dt;
        const f = Math.max(0, this.muzzleT / 0.05);
        this.muzzleFlash.visible = f > 0.05;
        this.muzzleFlash.scale.setScalar(0.6 + f * 0.8);
      } else if (this.muzzleFlash.visible) {
        this.muzzleFlash.visible = false;
      }
    }

    _updateHitboxes() {
      const p = this.position;
      const s = this.type.height / 1.78;
      const halfW = this.radius * 0.95;
      this.hitBody.min.set(p.x - halfW, p.y, p.z - halfW);
      this.hitBody.max.set(p.x + halfW, p.y + 1.34 * s, p.z + halfW);
      const hw = halfW * 0.55;
      this.hitHead.min.set(p.x - hw, p.y + 1.3 * s, p.z - hw);
      this.hitHead.max.set(p.x + hw, p.y + 1.66 * s, p.z + hw);
    }

    _updateDead(dt, game) {
      this.deathT += dt;
      const t = this.deathT;
      const boss = !!this.type.boss;
      /* death reads in three beats:
       *   0.00-0.18  hit reaction (jerk back along the bullet)
       *   0.18-0.95  collapse (fall over a per-enemy axis)
       *   0.95-2.70  sink + shrink out                                   */
      if (this.muzzleFlash) this.muzzleFlash.visible = false;

      if (t < 0.18) {
        const k = 1 - t / 0.18;
        this.mesh.rotation.y = this.yaw;
        this.mesh.position.set(
          this.position.x + this.flinchDir.x * k * 0.3,
          this.position.y + k * 0.07,
          this.position.z + this.flinchDir.z * k * 0.3
        );
        this.root.rotation.set(k * -0.28, 0, k * 0.2);
        return;
      }

      const fallT = clamp((t - 0.18) / (boss ? 1.05 : 0.72), 0, 1);
      const fall = Math.sin(fallT * Math.PI * 0.5);
      const ax = this.deathAxis;
      this.mesh.rotation.y = this.yaw;
      this.root.rotation.x = fall * ax.x;
      this.root.rotation.z = fall * ax.z;
      this.root.rotation.y = fall * ax.y;
      this.root.position.y = -fall * 0.12;
      this.body.rotation.set(0, 0, 0);
      this.body.position.y = 0;

      // slide from the knockback impulse, then settle
      this.velDying.y -= 16 * dt;
      game.collision.moveEntity(this, this.velDying.x * dt, this.velDying.y * dt, this.velDying.z * dt, 0);
      this.velDying.x *= Math.max(0, 1 - 5 * dt);
      this.velDying.z *= Math.max(0, 1 - 5 * dt);
      this.mesh.position.set(this.position.x, this.position.y, this.position.z);

      // sink + shrink away
      const fadeStart = boss ? 2.3 : 1.7;
      if (t > fadeStart) {
        const k = clamp(1 - (t - fadeStart) / (boss ? 1.3 : 1.0), 0, 1);
        this.mesh.scale.setScalar(Math.max(0.001, k * k));
      }
      if (t > (boss ? 3.8 : 2.7)) this.removeMe = true;
    }

    dispose(game) {
      game.collision.removeDynamic(this.hitBody);
      game.collision.removeDynamic(this.hitHead);
      game.scene.remove(this.mesh);
      this.bodyMat.dispose();
      this.armorMat.dispose();
      this.hpBarBg.material.dispose();
      this.hpBarFg.material.dispose();
      if (this.muzzleFlash) this.muzzleFlash.material.dispose();
      if (this.shockwaves) {
        for (let i = 0; i < this.shockwaves.length; i++) {
          game.scene.remove(this.shockwaves[i].mesh);
          this.shockwaves[i].mat.dispose();
        }
        this.shockwaves.length = 0;
      }
    }
  }

  /* ======================================================= WAVE MANAGER */

  class WaveManager {
    constructor(game) {
      this.game = game;
      this.reset();
    }

    reset() {
      this.wave = 0;                  // wave == stage number
      this.queue = [];
      this.spawnT = 0;
      this.state = 'idle';            // idle | intermission | spawning | fighting | cleared
      this.timer = 0;
      this.totalThisWave = 0;
      this.bossStage = false;
      this.bossSpawned = false;
    }

    /** boss every 5th stage */
    isBossStage(n) { return (n || this.wave || 1) % 5 === 0; }

    composition(n) {
      const boss = this.isBossStage(n);
      let grunt, soldier, tank;
      if (n === 1) { grunt = 5; soldier = 0; tank = 0; }
      else if (n === 2) { grunt = 5; soldier = 3; tank = 0; }
      else if (n === 3) { grunt = 5; soldier = 5; tank = 2; }
      else {
        const total = 12 + (n - 3) * 3;
        grunt = Math.round(total * 0.38);
        soldier = Math.round(total * 0.42);
        tank = total - grunt - soldier;
      }
      const list = [];
      if (boss) list.push('boss');               // boss first, escorts after
      for (let i = 0; i < grunt; i++) list.push('grunt');
      for (let i = 0; i < soldier; i++) list.push('soldier');
      for (let i = 0; i < tank; i++) list.push('tank');

      /* from stage 4 the roster opens up: scouts rush, gunners hold angles,
       * heavies bring the shotguns, snipers and exploders join later */
      if (n >= 4) {
        const extra = { scout: 1 + Math.floor((n - 3) / 2), gunner: 1, exploder: n >= 6 ? 1 : 0 };
        if (n >= 5) extra.sniper = 1;
        if (n >= 7) extra.heavy = 1;
        for (const k in extra) for (let i = 0; i < extra[k]; i++) list.push(k);
      }
      return list;
    }

    /** +20% enemy stats per stage, +4% speed (capped) */
    scaling(n) {
      const k = 1 + (n - 1) * 0.2;
      return {
        hp: k,
        dmg: k,
        speed: Math.min(1.35, 1 + (n - 1) * 0.04)
      };
    }

    startIntermission(first) {
      this.state = 'intermission';
      this.timer = first ? 2.2 : CFG.intermission;
      if (!first) this.game.ui.showIntermission(this.timer);
    }

    startWave() {
      const game = this.game;
      this.wave++;
      // each stage gets a fresh arena layout + fresh spawn point placement
      game.arena.applyLayout(game.pickLayoutIndex(), this.wave);
      if (this.wave > 1) game.arena.setMood('normal');
      this.bossStage = this.isBossStage(this.wave);
      this.bossSpawned = false;
      const list = this.composition(this.wave);
      // shuffle the escort, then always lead with the boss so it shows up
      // immediately instead of waiting behind a full spawn queue
      for (let i = list.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      }
      const bi = list.indexOf('boss');
      if (bi > 0) { list.splice(bi, 1); list.unshift('boss'); }
      this.queue = list;
      this.totalThisWave = list.length;
      this.state = 'spawning';
      this.spawnT = 0;
      // resupply between stages so a long run stays playable
      if (this.wave > 1) {
        for (let i = 0; i < game.player.weapons.length; i++) {
          if (game.player.weapons[i]) game.player.weapons[i].refill();
        }
        game.player.heal(25);
      }
      game.ui.showBanner(this.bossStage ? 'STAGE ' + this.wave + '  BOSS' : 'STAGE ' + this.wave);
      game.ui.hideIntermission();
      game.ui.showLayoutName(game.arena.layoutName);
      game.audio.waveStart(this.wave);
      game.ui.updateWave(this.wave);
    }

    update(dt) {
      const game = this.game;
      if (this.state === 'intermission') {
        this.timer -= dt;
        this.game.ui.updateIntermission(this.timer);
        if (this.timer <= 0) this.startWave();
        return;
      }
      if (this.state === 'idle' || this.state === 'cleared') return;

      if (this.state === 'spawning') {
        this.spawnT -= dt;
        const aliveCount = game.aliveEnemyCount();
        if (this.spawnT <= 0 && this.queue.length && aliveCount < CFG.maxAlive) {
          this.spawnT = CFG.spawnInterval;
          this._spawnOne();
        }
        if (!this.queue.length) this.state = 'fighting';
      }

      if (this.state === 'fighting' && game.aliveEnemyCount() === 0) {
        this.state = 'cleared';
        game.ui.updateEnemies(0);
        game.onStageCleared(this.bossStage);
      }
    }

    _spawnOne() {
      const key = this.queue.shift();
      const type = ENEMY_TYPES[key];
      if (!type) return;
      const game = this.game;

      // find a spot that is actually free (never inside a wall / container) and
      // never right on top of the player
      const pos = this._findSpawnPos(type);
      if (!pos) {                       // nowhere valid right now: retry shortly
        this.queue.unshift(key);
        this.spawnT = 1.0;
        return;
      }

      const scale = this.scaling(this.wave);
      const e = new Enemy(type, pos, scale, this.game);
      this.game.addEnemy(e);
      if (type.boss) {
        this.bossSpawned = true;
        e.groundY = e.position.y;
        e.spawnT = 0;                       // the intro sequence drives its entrance
        this.game.startBossIntro(e);
      }

      // spawn effect
      this.game.particles.burst(14, pos.x, pos.y + 1, pos.z, {
        spread: 1.6, up: 2.6, lifeMin: 0.25, lifeMax: 0.6,
        sizeMin: 0.03, sizeMax: 0.08, color: [0.2, 0.8, 1.0], grav: -2, drag: 2
      });
      this.game.ui.updateEnemies(this.game.aliveEnemyCount() + this.queue.length);
    }

    _findSpawnPos(type) {
      const game = this.game;
      const arena = game.arena;
      const r = type.radius, h = type.height;
      let bestD = -1, fallback = null;

      for (let i = 0; i < 16; i++) {
        const p = arena.spawnPoints[(Math.random() * arena.spawnPoints.length) | 0];
        const test = new THREE.Vector3(p.x + rand(-1.1, 1.1), p.y + 0.05, p.z + rand(-1.1, 1.1));
        const inside = game.collision.liftOut(test, r, h);   // true => was embedded
        const d = test.distanceTo(game.player.position);
        if (inside) continue;
        if (d > bestD && d > 13) return test;
        if (d > 9 && !fallback) fallback = test.clone();
      }
      if (fallback) return fallback;

      // last resort: any free spot on the arena floor
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2, rad = rand(15, CFG.arenaHalf - 4);
        const test = new THREE.Vector3(Math.cos(a) * rad, 0.05, Math.sin(a) * rad);
        if (test.distanceTo(game.player.position) < 10) continue;
        if (!game.collision.liftOut(test, r, h)) return test;
      }
      return null;
    }
  }

  /* ============================================== DIRECTIONAL DAMAGE SYSTEM */

  class DirectionalDamageSystem {
    constructor(game, container) {
      this.game = game;
      this.container = container;
      this.poolSize = 6;
      this.maxActive = 4;
      this.pool = [];
      this._initPool();
    }

    _initPool() {
      if (!this.container) return;
      this.container.innerHTML = '';
      this.pool = [];
      for (let i = 0; i < this.poolSize; i++) {
        const el = document.createElement('div');
        el.className = 'dir-indicator';
        el.setAttribute('data-index', String(i));
        el.innerHTML = '<svg viewBox="0 0 52 28" class="dir-svg" aria-hidden="true"><path class="dir-wedge" d="M 6 23 L 26 7 L 46 23 L 26 15 Z" /></svg>';
        el.style.display = 'none';
        el.style.opacity = '0';
        this.container.appendChild(el);

        this.pool.push({
          id: i,
          el: el,
          active: false,
          worldPos: new THREE.Vector3(),
          amount: 0,
          baseScale: 1.0,
          intensity: 1.0,
          elapsed: 0,
          duration: 0.65,
          angle: 0,
          isCrit: false,
          isBoss: false
        });
      }
    }

    showDamage(amount, sourcePosition, options = {}) {
      if (!sourcePosition || typeof sourcePosition.x !== 'number') return null;
      if (!Number.isFinite(sourcePosition.x) || !Number.isFinite(sourcePosition.y) || !Number.isFinite(sourcePosition.z)) return null;

      const player = this.game.player;
      if (!player || !player.camera) return null;

      const pPos = player.position || player.camera.position;
      const dx = sourcePosition.x - pPos.x;
      const dz = sourcePosition.z - pPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 0.05) return null; // self-damage or at player position

      const camera = player.camera;
      const currentAngle = this.calculateAngle(sourcePosition, camera, pPos);
      if (!Number.isFinite(currentAngle)) return null;

      const isCrit = !!(options && (options.head || options.isCrit));
      const isBoss = !!(options && (options.isBoss || options.type === 'boss_slam' || options.type === 'boss_attack'));

      // Intensity scaling based on damage (Requirement 4)
      let dmgScale = 1.0;
      if (amount <= 10) {
        dmgScale = 0.85;
      } else if (amount <= 30) {
        dmgScale = 1.0;
      } else {
        dmgScale = Math.min(1.25, 1.0 + (amount - 30) * 0.007);
      }
      if (isBoss) dmgScale *= 1.15;
      dmgScale = Math.max(0.75, Math.min(1.35, dmgScale));

      // Low HP intensity bump (Requirement 15)
      let hpMod = 1.0;
      if (player.maxHealth > 0) {
        const hpPct = player.health / player.maxHealth;
        if (hpPct < 0.25) hpMod = 1.20;
        else if (hpPct < 0.50) hpMod = 1.10;
      }

      const baseIntensity = Math.min(1.4, dmgScale * hpMod);

      // Check merging: repeated hits from same direction (~28 deg / 0.48 rad)
      for (let i = 0; i < this.pool.length; i++) {
        const item = this.pool[i];
        if (item.active) {
          const diff = Math.atan2(Math.sin(currentAngle - item.angle), Math.cos(currentAngle - item.angle));
          if (Math.abs(diff) < 0.48) {
            item.worldPos.copy(sourcePosition);
            item.elapsed = 0;
            item.intensity = Math.min(1.4, Math.max(item.intensity, baseIntensity) + 0.12);
            if (isCrit) item.isCrit = true;
            if (isBoss) item.isBoss = true;
            item.el.className = 'dir-indicator' + (item.isCrit ? ' crit' : '') + (item.isBoss ? ' boss' : '');
            this._renderIndicator(item, camera, pPos);
            return item;
          }
        }
      }

      // Find slot (max 4 active)
      const activeList = this.pool.filter(item => item.active);
      let target = null;
      if (activeList.length < this.maxActive) {
        target = this.pool.find(item => !item.active);
      }
      if (!target && activeList.length > 0) {
        target = activeList.reduce((oldest, item) => item.elapsed > oldest.elapsed ? item : oldest, activeList[0]);
      }
      if (!target) return null;

      target.active = true;
      target.worldPos.copy(sourcePosition);
      target.amount = amount;
      target.baseScale = dmgScale;
      target.intensity = baseIntensity;
      target.elapsed = 0;
      target.duration = 0.65;
      target.angle = currentAngle;
      target.isCrit = isCrit;
      target.isBoss = isBoss;

      target.el.className = 'dir-indicator' + (isCrit ? ' crit' : '') + (isBoss ? ' boss' : '');
      target.el.style.display = 'block';

      this._renderIndicator(target, camera, pPos);
      return target;
    }

    calculateAngle(sourcePosition, camera, playerPos) {
      const pPos = playerPos || (this.game.player ? this.game.player.position : camera.position);
      const dir = new THREE.Vector3().subVectors(sourcePosition, pPos);
      const len = dir.length();
      if (len < 1e-4) return 0;
      dir.multiplyScalar(1 / len);

      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

      let x = dir.dot(right);
      let y = dir.dot(fwd);

      if (Math.hypot(x, y) < 0.05) {
        const fwdH = new THREE.Vector3(fwd.x, 0, fwd.z);
        const rightH = new THREE.Vector3(right.x, 0, right.z);
        const dirH = new THREE.Vector3(dir.x, 0, dir.z);
        if (fwdH.lengthSq() > 1e-4 && rightH.lengthSq() > 1e-4 && dirH.lengthSq() > 1e-4) {
          fwdH.normalize();
          rightH.normalize();
          dirH.normalize();
          x = dirH.dot(rightH);
          y = dirH.dot(fwdH);
        }
      }

      if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
      const angle = Math.atan2(x, y);
      return Number.isFinite(angle) ? angle : 0;
    }

    update(dt) {
      const player = this.game.player;
      if (!player || !player.camera) return;
      const camera = player.camera;
      const pPos = player.position || camera.position;

      for (let i = 0; i < this.pool.length; i++) {
        const item = this.pool[i];
        if (!item.active) continue;

        item.elapsed += dt;
        if (item.elapsed >= item.duration) {
          item.active = false;
          item.el.style.display = 'none';
          item.el.style.opacity = '0';
          continue;
        }

        this._renderIndicator(item, camera, pPos);
      }
    }

    _renderIndicator(item, camera, pPos) {
      const angle = this.calculateAngle(item.worldPos, camera, pPos);
      item.angle = angle;

      const W = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1280;
      const H = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 720;

      const radiusX = Math.max(80, W * 0.43);
      const radiusY = Math.max(80, H * 0.41);

      const screenX = Math.sin(angle) * radiusX;
      const screenY = -Math.cos(angle) * radiusY;

      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;

      const progress = Math.min(1.0, Math.max(0, item.elapsed / item.duration));

      let punchScale = 1.0;
      if (progress <= 0.15) {
        punchScale = 1.0 + (progress / 0.15) * 0.12;
      } else if (progress <= 0.38) {
        punchScale = 1.12 - ((progress - 0.15) / 0.23) * 0.12;
      } else {
        punchScale = 1.0;
      }

      let opacityProgress = 1.0;
      if (progress <= 0.20) {
        opacityProgress = 1.0;
      } else {
        const fadeFrac = (progress - 0.20) / 0.80;
        opacityProgress = Math.pow(Math.max(0, 1.0 - fadeFrac), 1.35);
      }

      let alpha = 0.70 * opacityProgress * item.intensity;

      const p = this.game.player;
      let scopeScale = 1.0;
      if (p) {
        if (p.scoped) {
          alpha *= 0.65;
          scopeScale = 0.82;
        } else if (p.adsAmt > 0.05) {
          const k = Math.min(1, p.adsAmt);
          alpha *= lerp(1.0, 0.85, k);
          scopeScale = lerp(1.0, 0.90, k);
        }
      }

      alpha = Math.max(0, Math.min(0.85, alpha));
      const totalScale = item.baseScale * punchScale * scopeScale;
      const rotDeg = angle * (180 / Math.PI);

      item.el.style.transform = `translate(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px) rotate(${rotDeg.toFixed(1)}deg) scale(${totalScale.toFixed(2)})`;
      item.el.style.opacity = alpha.toFixed(3);
    }

    showVignette(amount = 20) {
      const v = (this.game.ui && this.game.ui.el) ? this.game.ui.el.vignette : document.getElementById('damage-vignette');
      if (!v) return;
      v.classList.remove('hit');
      void v.offsetWidth;
      v.classList.add('hit');
    }

    hide() {
      this.reset();
    }

    reset() {
      for (let i = 0; i < this.pool.length; i++) {
        const item = this.pool[i];
        item.active = false;
        item.elapsed = 0;
        if (item.el) {
          item.el.style.display = 'none';
          item.el.style.opacity = '0';
        }
      }
    }

    cleanup() {
      this.reset();
      if (this.container) {
        this.container.innerHTML = '';
      }
      this.pool = [];
    }
  }

  /* ============================================== PERK VISUAL FEEDBACK SYSTEM */

  class PerkVisualSystem {
    constructor(game) {
      this.game = game;
      this.scene = game.scene;
      this.camera = game.camera;

      this._initDOM();
      this._initFireMan();
      this._initKatana();
      this._initMedicField();
      this._initGravitySingularity();

      this._lastMask = 100;
      this._maskBrokenPrev = false;
      this._phantomPrev = false;
      this._origWeaponMats = new Map();
      this.spectralMat = new THREE.MeshStandardMaterial({
        color: 0x6644ff,
        roughness: 0.35,
        metalness: 0.5,
        emissive: 0x331188,
        transparent: true,
        opacity: 0.65
      });
      this._toastTimer = 0;
    }

    _initDOM() {
      const $ = (id) => document.getElementById(id);
      let v = $('perk-vignette');
      if (!v && this.game.ui && this.game.ui.el && this.game.ui.el.hud) {
        v = document.createElement('div');
        v.id = 'perk-vignette';
        v.className = 'perk-vignette';
        this.game.ui.el.hud.appendChild(v);
      }
      this.vignetteEl = v;

      let ev = $('executioner-visor');
      if (!ev && this.game.ui && this.game.ui.el && this.game.ui.el.hud) {
        ev = document.createElement('div');
        ev.id = 'executioner-visor';
        ev.className = 'executioner-visor hidden';
        ev.innerHTML = '<div class="visor-frame">' +
          '<div class="visor-bracket vb-tl"></div><div class="visor-bracket vb-tr"></div>' +
          '<div class="visor-bracket vb-bl"></div><div class="visor-bracket vb-br"></div>' +
          '<div class="visor-header"><span class="vh-tag">EXECUTIONER OPTICS</span><span id="visor-durability-text" class="vh-dur">MASK: 100%</span></div>' +
          '<div class="visor-bar"><div id="visor-durability-fill" style="width:100%"></div></div>' +
          '<div id="visor-repair-box" class="visor-repair hidden">REPAIRING OPTICS: <b id="visor-repair-time">22s</b></div>' +
          '<div id="visor-cracks" class="visor-cracks"></div>' +
          '</div><div class="visor-scanlines"></div>';
        this.game.ui.el.hud.appendChild(ev);
      }
      this.visorEl = ev;
      this.visorDurText = $('visor-durability-text');
      this.visorDurFill = $('visor-durability-fill');
      this.visorRepairBox = $('visor-repair-box');
      this.visorRepairTime = $('visor-repair-time');
      this.visorCracks = $('visor-cracks');

      let at = $('perk-action-toast');
      if (!at && this.game.ui && this.game.ui.el && this.game.ui.el.hud) {
        at = document.createElement('div');
        at.id = 'perk-action-toast';
        at.className = 'perk-action-toast hidden';
        this.game.ui.el.hud.appendChild(at);
      }
      this.actionToastEl = at;

      let mbo = $('mask-break-overlay');
      if (!mbo && this.game.ui && this.game.ui.el && this.game.ui.el.hud) {
        mbo = document.createElement('div');
        mbo.id = 'mask-break-overlay';
        mbo.className = 'mask-break-overlay hidden';
        mbo.innerHTML = '<div class="mbo-darkness"></div><div class="mbo-glitch-lines"></div>' +
          '<div class="mbo-content"><div class="mbo-icon">⚠</div><div class="mbo-title">TAKE OFF MASK</div>' +
          '<div class="mbo-sub">OPTICAL COMPONENT SHATTERED // SYSTEM CRITICAL</div></div>';
        this.game.ui.el.hud.appendChild(mbo);
      }
      this.maskBreakOverlay = mbo;
    }

    _initFireMan() {
      this.fireLight = new THREE.PointLight(0xff5511, 0, 3.5, 2);
      this.camera.add(this.fireLight);
      this.fireLight.position.set(0.18, -0.15, -0.32);
      this._fireEmberT = 0;
    }

    _initKatana() {
      this.katanaGroup = new THREE.Group();
      this.katanaGroup.renderOrder = 14;
      this.camera.add(this.katanaGroup);

      // Curved steel katana blade
      const bladeGeo = boxGeo(0.016, 0.045, 0.74);
      const bladeMat = new THREE.MeshStandardMaterial({
        color: 0xecf0f5,
        metalness: 0.88,
        roughness: 0.16,
        emissive: 0x223344
      });
      this.katanaBlade = new THREE.Mesh(bladeGeo, bladeMat);
      this.katanaBlade.position.set(0, 0, -0.37);
      this.katanaBlade.rotation.x = -0.05;

      // Habaki
      const habakiMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.25 });
      const habaki = new THREE.Mesh(boxGeo(0.022, 0.052, 0.04), habakiMat);
      habaki.position.set(0, 0, -0.02);

      // Tsuba
      const tsubaMat = new THREE.MeshStandardMaterial({ color: 0x181a20, metalness: 0.7, roughness: 0.4 });
      const tsuba = new THREE.Mesh(cylGeo(0.055, 0.055, 0.008, 12), tsubaMat);
      tsuba.rotation.x = Math.PI / 2;

      // Tsuka
      const tsukaMat = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.8 });
      const tsuka = new THREE.Mesh(boxGeo(0.02, 0.038, 0.24), tsukaMat);
      tsuka.position.set(0, 0, 0.12);

      // Kashira
      const kashira = new THREE.Mesh(boxGeo(0.022, 0.04, 0.02), habakiMat);
      kashira.position.set(0, 0, 0.24);

      this.katanaGroup.add(this.katanaBlade);
      this.katanaGroup.add(habaki);
      this.katanaGroup.add(tsuba);
      this.katanaGroup.add(tsuka);
      this.katanaGroup.add(kashira);

      // Slash arc trail ribbon
      const arcGeo = new THREE.RingGeometry(0.55, 0.82, 32, 1, 0, Math.PI * 0.75);
      const arcMat = new THREE.MeshBasicMaterial({
        color: 0x88e0ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      this.slashArc = new THREE.Mesh(arcGeo, arcMat);
      this.slashArc.position.set(0, 0, -0.45);
      this.slashArc.visible = false;
      this.katanaGroup.add(this.slashArc);

      // 2 ghost afterimages
      this.katanaGhosts = [];
      for (let i = 0; i < 2; i++) {
        const gm = new THREE.Mesh(bladeGeo, new THREE.MeshBasicMaterial({
          color: 0x66ccff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        }));
        gm.position.set(0, 0, -0.37);
        gm.visible = false;
        this.katanaGroup.add(gm);
        this.katanaGhosts.push(gm);
      }

      this.katanaGroup.visible = false;
      this.katanaGroup.position.set(0, -1, 0);
    }

    _initMedicField() {
      this.medicGroup = new THREE.Group();
      this.medicGroup.renderOrder = 4;

      const baseMesh = new THREE.Mesh(cylGeo(0.24, 0.3, 0.35, 10), lamMat('med.base', { color: 0x2e4033 }));
      baseMesh.position.y = 0.175;

      const crossMesh1 = new THREE.Mesh(boxGeo(0.18, 0.05, 0.04), new THREE.MeshBasicMaterial({ color: 0x4dff9b }));
      crossMesh1.position.set(0, 0.22, 0.16);
      const crossMesh2 = new THREE.Mesh(boxGeo(0.05, 0.18, 0.04), new THREE.MeshBasicMaterial({ color: 0x4dff9b }));
      crossMesh2.position.set(0, 0.22, 0.16);

      const antenna = new THREE.Mesh(cylGeo(0.02, 0.03, 0.45, 6), lamMat('med.ant', { color: 0x5a7362 }));
      antenna.position.set(0, 0.45, 0);

      const bulb = new THREE.Mesh(cylGeo(0.06, 0.06, 0.06, 8), new THREE.MeshBasicMaterial({ color: 0x55ffaa }));
      bulb.position.set(0, 0.68, 0);

      this.medicGroup.add(baseMesh);
      this.medicGroup.add(crossMesh1);
      this.medicGroup.add(crossMesh2);
      this.medicGroup.add(antenna);
      this.medicGroup.add(bulb);

      // Boundary ring at 3.2m radius
      const ringGeo = new THREE.RingGeometry(3.1, 3.25, 48);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x3df58b,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      this.medicRing = new THREE.Mesh(ringGeo, ringMat);
      this.medicRing.position.y = 0.03;
      this.medicGroup.add(this.medicRing);

      // Inner field disk
      const diskGeo = new THREE.CircleGeometry(3.08, 36);
      diskGeo.rotateX(-Math.PI / 2);
      const diskMat = new THREE.MeshBasicMaterial({
        color: 0x22cc66,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      this.medicDisk = new THREE.Mesh(diskGeo, diskMat);
      this.medicDisk.position.y = 0.02;
      this.medicGroup.add(this.medicDisk);

      this.medicGroup.visible = false;
      this.scene.add(this.medicGroup);
      this._medicNaniteT = 0;
    }

    _initGravitySingularity() {
      this.gravityGroup = new THREE.Group();
      this.gravityGroup.renderOrder = 4;

      const sphereGeo = new THREE.SphereGeometry(0.38, 16, 12);
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x05020c,
        roughness: 0.95,
        emissive: 0x220544
      });
      this.gravityCore = new THREE.Mesh(sphereGeo, coreMat);
      this.gravityCore.position.y = 0.8;
      this.gravityGroup.add(this.gravityCore);

      const torusGeo = new THREE.TorusGeometry(0.72, 0.045, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xa844ff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending
      });
      this.gravRing1 = new THREE.Mesh(torusGeo, ringMat);
      this.gravRing1.position.y = 0.8;
      this.gravRing1.rotation.x = 0.65;
      this.gravityGroup.add(this.gravRing1);

      const gravRing2Mat = new THREE.MeshBasicMaterial({
        color: 0x6633ff,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending
      });
      this.gravRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.035, 8, 32), gravRing2Mat);
      this.gravRing2.position.y = 0.8;
      this.gravRing2.rotation.x = -0.55;
      this.gravRing2.rotation.y = 0.45;
      this.gravityGroup.add(this.gravRing2);

      const vortexGeo = new THREE.RingGeometry(0.4, 3.2, 32);
      vortexGeo.rotateX(-Math.PI / 2);
      const vortexMat = new THREE.MeshBasicMaterial({
        color: 0x7722dd,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      this.gravVortex = new THREE.Mesh(vortexGeo, vortexMat);
      this.gravVortex.position.y = 0.03;
      this.gravityGroup.add(this.gravVortex);

      const blastGeo = new THREE.RingGeometry(0.1, 0.5, 36);
      blastGeo.rotateX(-Math.PI / 2);
      const blastMat = new THREE.MeshBasicMaterial({
        color: 0xd988ff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      this.gravBlast = new THREE.Mesh(blastGeo, blastMat);
      this.gravBlast.position.y = 0.06;
      this.gravityGroup.add(this.gravBlast);

      this.gravityGroup.visible = false;
      this.scene.add(this.gravityGroup);
      this._gravPullT = 0;
      this._gravBlastT = 0;
    }

    update(dt) {
      const g = this.game;
      const b = g.build;
      const def = b ? b.perk : null;
      const s = b ? b.perkState : null;

      if (this._toastTimer > 0) {
        this._toastTimer -= dt;
        if (this._toastTimer <= 0 && this.actionToastEl) {
          this.actionToastEl.classList.add('hidden');
        }
      }

      // 1. FIRE MAN
      if (def && def.id === 'fireman' && s) {
        const isBurning = s.burning > 0;
        const heat = s.heat || 0;
        if (isBurning) {
          this.fireLight.intensity = (0.55 + Math.random() * 0.35) * Math.min(1, s.burning / 1.5);
          this._fireEmberT -= dt;
          if (this._fireEmberT <= 0) {
            this._fireEmberT = 0.05;
            const w = g.player.weapon;
            if (w && w.model) {
              const mw = w.muzzleWorld();
              g.particles.burst(1, mw.x + rand(-0.05, 0.05), mw.y + rand(-0.05, 0.05), mw.z + rand(-0.05, 0.05), {
                spread: 0.12, up: 0.9, lifeMin: 0.12, lifeMax: 0.35,
                sizeMin: 0.02, sizeMax: 0.05, color: [1.0, 0.45 + Math.random() * 0.3, 0.05], grav: -1.6, drag: 1.2
              });
            }
          }
        } else {
          this.fireLight.intensity = Math.max(0, this.fireLight.intensity - dt * 3);
        }

        if (this.vignetteEl) {
          if (isBurning || heat > 20) {
            let cls = 'perk-vignette fire-mode';
            if (heat >= 92) cls += ' critical';
            else if (heat >= 80) cls += ' warn';
            if (this.vignetteEl.className !== cls) this.vignetteEl.className = cls;
          } else if (this.vignetteEl.classList.contains('fire-mode')) {
            this.vignetteEl.className = 'perk-vignette';
          }
        }
      } else {
        if (this.fireLight.intensity > 0) this.fireLight.intensity = Math.max(0, this.fireLight.intensity - dt * 4);
        if (this.vignetteEl && this.vignetteEl.classList.contains('fire-mode')) {
          this.vignetteEl.className = 'perk-vignette';
        }
      }

      // 2. SAMURAI
      if (def && def.id === 'samurai' && s && s.slash > 0) {
        this.katanaGroup.visible = true;
        const p = clamp(1 - (s.slash / 0.34), 0, 1);
        const w = g.player.weapon;
        if (w && w.group) {
          w.group.position.y -= 0.38 * Math.sin(p * Math.PI);
        }

        if (p < 0.16) {
          const k = p / 0.16;
          this.katanaGroup.position.set(lerp(0.35, 0.26, k), lerp(-0.2, 0.14, k), lerp(-0.4, -0.26, k));
          this.katanaGroup.rotation.set(lerp(0.2, 0.5, k), lerp(-0.8, -0.6, k), lerp(0.5, 0.9, k));
          this.slashArc.visible = false;
          for (let i = 0; i < this.katanaGhosts.length; i++) this.katanaGhosts[i].visible = false;
        } else if (p <= 0.64) {
          const k = (p - 0.16) / 0.48;
          this.katanaGroup.position.set(lerp(0.26, -0.32, k), lerp(0.14, -0.22, k), lerp(-0.26, -0.32, k));
          this.katanaGroup.rotation.set(lerp(0.5, -0.75, k), lerp(-0.6, 0.75, k), lerp(0.9, -1.55, k));
          this.slashArc.visible = true;
          this.slashArc.material.opacity = Math.sin(k * Math.PI) * 0.85;
          this.slashArc.rotation.z = lerp(0.4, -1.2, k);
          for (let i = 0; i < this.katanaGhosts.length; i++) {
            const gm = this.katanaGhosts[i];
            gm.visible = true;
            const gk = Math.max(0, k - (i + 1) * 0.1);
            gm.material.opacity = Math.sin(gk * Math.PI) * 0.35;
          }
        } else {
          const k = (p - 0.64) / 0.36;
          this.katanaGroup.position.set(lerp(-0.32, -0.15, k), lerp(-0.22, -0.65, k), lerp(-0.32, -0.25, k));
          this.katanaGroup.rotation.set(lerp(-0.75, 0, k), lerp(0.75, 0.2, k), lerp(-1.55, -0.4, k));
          this.slashArc.visible = false;
          for (let i = 0; i < this.katanaGhosts.length; i++) this.katanaGhosts[i].visible = false;
        }
      } else {
        if (this.katanaGroup.visible) {
          this.katanaGroup.visible = false;
          this.katanaGroup.position.set(0, -1, 0);
          this.slashArc.visible = false;
          for (let i = 0; i < this.katanaGhosts.length; i++) this.katanaGhosts[i].visible = false;
        }
      }

      // 3. EXECUTIONER
      if (def && def.id === 'executioner' && s) {
        const state = s.maskState || (s.maskActive > 0 ? 'EQUIPPED' : 'OFF');
        const dur = clamp(s.mask !== undefined ? s.mask : 100, 0, 100);

        if (state === 'EQUIPPED') {
          if (this.visorEl) this.visorEl.classList.remove('hidden');
          if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
          const bonus = (s.damageBonus || 0) * 4;
          if (this.visorDurText) this.visorDurText.textContent = 'MASK: ' + Math.round(dur) + '%' + (bonus > 0 ? ' (+' + bonus + '% DMG)' : '');
          if (this.visorDurFill) {
            this.visorDurFill.style.width = dur + '%';
            this.visorDurFill.style.background = dur > 70 ? 'linear-gradient(90deg, #55ffbb, #33bbff)' :
              (dur > 30 ? 'linear-gradient(90deg, #ffb347, #ff8833)' : 'linear-gradient(90deg, #ff2233, #ff6644)');
          }
          if (this.visorCracks) {
            if (dur < 35) this.visorCracks.className = 'visor-cracks crack-3';
            else if (dur < 65) this.visorCracks.className = 'visor-cracks crack-2';
            else if (dur < 90) this.visorCracks.className = 'visor-cracks crack-1';
            else this.visorCracks.className = 'visor-cracks';
          }
          if (this.visorRepairBox) this.visorRepairBox.classList.add('hidden');
        } else if (state === 'BROKEN') {
          if (this.visorEl) this.visorEl.classList.add('hidden');
          if (this.maskBreakOverlay) this.maskBreakOverlay.classList.remove('hidden');
        } else if (state === 'REPAIRING') {
          if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
          if (this.visorEl) this.visorEl.classList.add('hidden');
        } else if (state === 'READY') {
          if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
          if (this.visorEl) this.visorEl.classList.add('hidden');
        } else { // 'OFF'
          if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
          if (this.visorEl) this.visorEl.classList.add('hidden');
        }
      } else {
        if (this.visorEl && !this.visorEl.classList.contains('hidden')) {
          this.visorEl.classList.add('hidden');
        }
        if (this.maskBreakOverlay && !this.maskBreakOverlay.classList.contains('hidden')) {
          this.maskBreakOverlay.classList.add('hidden');
        }
      }

      // 4. PHANTOM
      const phantomActive = def && def.id === 'phantom' && s && s.active > 0;
      if (phantomActive) {
        if (this.vignetteEl && !this.vignetteEl.classList.contains('phantom-spectral')) {
          this.vignetteEl.className = 'perk-vignette phantom-spectral';
        }
        const w = g.player.weapon;
        if (w && w.model) {
          w.model.traverse((o) => {
            if (o.isMesh && o.material !== this.spectralMat && o.material !== w.flash.material) {
              if (!this._origWeaponMats.has(o)) this._origWeaponMats.set(o, o.material);
              o.material = this.spectralMat;
            }
          });
        }
      } else {
        if (this.vignetteEl && this.vignetteEl.classList.contains('phantom-spectral')) {
          this.vignetteEl.className = 'perk-vignette';
          const pl = g.player.position;
          g.particles.burst(18, pl.x, pl.y + 1, pl.z, {
            spread: 1.8, up: 1.2, lifeMin: 0.2, lifeMax: 0.5,
            sizeMin: 0.04, sizeMax: 0.1, color: [0.5, 0.4, 0.95], grav: -0.5, drag: 2
          });
        }
        if (this._origWeaponMats.size > 0) {
          this._origWeaponMats.forEach((mat, mesh) => { mesh.material = mat; });
          this._origWeaponMats.clear();
        }
      }

      // 5. MEDIC
      if (def && def.id === 'medic' && s && s.fieldT > 0) {
        this.medicGroup.visible = true;
        this.medicGroup.position.copy(s.fieldPos);
        this.medicDisk.rotation.z += dt * 0.4;
        const pulse = 0.8 + Math.sin(g.time * 4) * 0.15;
        this.medicRing.material.opacity = pulse;

        this._medicNaniteT -= dt;
        if (this._medicNaniteT <= 0) {
          this._medicNaniteT = 0.12;
          const r = rand(0.4, 2.9);
          const a = Math.random() * Math.PI * 2;
          g.particles.burst(2, s.fieldPos.x + Math.cos(a) * r, 0.1, s.fieldPos.z + Math.sin(a) * r, {
            spread: 0.2, up: 1.8, lifeMin: 0.35, lifeMax: 0.75,
            sizeMin: 0.03, sizeMax: 0.08, color: [0.35, 1.0, 0.6], grav: -1.2, drag: 1.5
          });
        }

        const inside = g.player.position.distanceTo(s.fieldPos) < 3.2;
        if (this.vignetteEl) {
          if (inside && !this.vignetteEl.classList.contains('medic-heal') && !this.vignetteEl.classList.contains('fire-mode') && !phantomActive) {
            this.vignetteEl.className = 'perk-vignette medic-heal';
          } else if (!inside && this.vignetteEl.classList.contains('medic-heal')) {
            this.vignetteEl.className = 'perk-vignette';
          }
        }
      } else {
        if (this.medicGroup.visible) {
          this.medicGroup.visible = false;
          const mp = this.medicGroup.position;
          g.particles.burst(14, mp.x, 0.4, mp.z, {
            spread: 1.4, up: 0.8, lifeMin: 0.2, lifeMax: 0.45,
            sizeMin: 0.04, sizeMax: 0.09, color: [0.4, 0.9, 0.6], grav: 1.5, drag: 2
          });
        }
        if (this.vignetteEl && this.vignetteEl.classList.contains('medic-heal')) {
          this.vignetteEl.className = 'perk-vignette';
        }
      }

      // 6. GRAVITY
      if (def && def.id === 'gravity' && s && s.pulseT > 0) {
        this.gravityGroup.visible = true;
        this.gravityGroup.position.copy(s.pulsePos);
        const spinSpeed = 8 + (1 - s.pulseT / 1.6) * 18;
        this.gravRing1.rotation.z += dt * spinSpeed;
        this.gravRing2.rotation.z -= dt * spinSpeed * 0.8;
        this.gravVortex.rotation.z += dt * spinSpeed * 0.5;

        this._gravPullT -= dt;
        if (this._gravPullT <= 0) {
          this._gravPullT = 0.06;
          const a = Math.random() * Math.PI * 2;
          const r = rand(2.5, 4.5);
          const px = s.pulsePos.x + Math.cos(a) * r;
          const pz = s.pulsePos.z + Math.sin(a) * r;
          const dirX = (s.pulsePos.x - px) * 2;
          const dirZ = (s.pulsePos.z - pz) * 2;
          g.particles.spawn(px, 0.4 + rand(0, 1.2), pz, dirX, 0.2, dirZ, 0.4, 0.06, 0.65, 0.25, 1.0, -1, 1.4);
        }
      } else if (this._gravBlastT > 0) {
        this._gravBlastT -= dt;
        const p = clamp(1 - (this._gravBlastT / 0.25), 0, 1);
        const curR = lerp(0.2, 9.0, p);
        this.gravBlast.scale.set(curR, curR, 1);
        this.gravBlast.material.opacity = (1 - p) * 0.95;
        if (this._gravBlastT <= 0) {
          this.gravityGroup.visible = false;
          this.gravBlast.material.opacity = 0;
        }
      } else {
        if (this.gravityGroup.visible && s && s.pulseT <= 0) {
          this.gravityGroup.visible = false;
        }
      }
    }

    onActivate(perkId, s) {
      if (perkId === 'fireman') {
        this.showActionToast('FIRE MODE', 'INCENDIARY ROUNDS ENGAGED', '#ff7722');
      } else if (perkId === 'samurai') {
        this.startKatanaSlash();
      } else if (perkId === 'executioner') {
        this.showActionToast('EXECUTIONER OPTICS', 'THERMAL TRACKING ONLINE', '#ff4455');
        if (this.visorEl) this.visorEl.classList.remove('hidden');
      } else if (perkId === 'phantom') {
        this.showActionToast('PHANTOM SHIFT', 'ETHEREAL UNTOUCHABLE', '#8855ff');
        if (this.vignetteEl) this.vignetteEl.className = 'perk-vignette phantom-spectral';
      } else if (perkId === 'medic') {
        this.showActionToast('MEDIC BEACON', 'HEALING ZONE DEPLOYED (3.2m)', '#4dff9b');
        this.medicGroup.visible = true;
        if (s && s.fieldPos) this.medicGroup.position.copy(s.fieldPos);
      } else if (perkId === 'gravity') {
        this.showActionToast('SINGULARITY PULSE', 'GRAVITY VORTEX ENGAGED', '#aa33ff');
        this.gravityGroup.visible = true;
        if (s && s.pulsePos) this.gravityGroup.position.copy(s.pulsePos);
      } else if (perkId === 'engineer') {
        this.showActionToast('SENTRY DEPLOYED', 'AUTOMATED TURRET ACTIVE', '#46a9ff');
      }
    }

    startKatanaSlash() {
      this.katanaGroup.visible = true;
    }

    onSlashHit(enemy, dir) {
      if (enemy && enemy.alive) {
        enemy.knock.addScaledVector(dir, 4.5);
      }
    }

    onSoulHeal(remainingDogtags) {
      this.showActionToast('+15 HP', 'SOUL HEAL (' + remainingDogtags + ' DOGTAGS)', '#55ff99');
      if (this.vignetteEl) {
        this.vignetteEl.classList.add('heal-pulse');
        setTimeout(() => { if (this.vignetteEl) this.vignetteEl.classList.remove('heal-pulse'); }, 400);
      }
      const pl = this.game.player.position;
      this.game.particles.burst(18, pl.x, 0.2, pl.z, {
        spread: 1.8, up: 1.4, lifeMin: 0.2, lifeMax: 0.55,
        sizeMin: 0.04, sizeMax: 0.09, color: [0.35, 1.0, 0.55], grav: -0.8, drag: 1.6
      });
    }

    onMaskToggled(equipped) {
      if (equipped) {
        if (this.visorEl) this.visorEl.classList.remove('hidden');
        if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
        this.showActionToast('EXECUTIONER OPTICS', 'THERMAL TRACKING ONLINE', '#ff4455');
      } else {
        if (this.visorEl) this.visorEl.classList.add('hidden');
        if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
        this.showActionToast('MASK REMOVED', 'OPTICS OFFLINE', '#8899aa');
      }
    }

    onMaskBroken() {
      if (this.visorEl) this.visorEl.classList.add('hidden');
      if (this.maskBreakOverlay) this.maskBreakOverlay.classList.remove('hidden');
    }

    onMaskRepairStarted() {
      if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
      this.showActionToast('MASK REPAIRING', 'REGENERATING OPTICS (50% REQ)', '#ffaa33');
    }

    onMaskReady() {
      if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
      this.showActionToast('MASK READY', 'PRESS F TO EQUIP', '#4dff9b');
    }

    onPlayerDamaged(amount) {
      const s = this.game.build ? this.game.build.perkState : null;
      if (s && (s.maskState === 'EQUIPPED' || s.maskActive > 0) && this.visorEl) {
        this.visorEl.classList.add('hit-glitch');
        setTimeout(() => { if (this.visorEl) this.visorEl.classList.remove('hit-glitch'); }, 180);
      }
    }

    onOverheat() {
      if (this.vignetteEl) {
        this.vignetteEl.className = 'perk-vignette overheat-flash';
      }
    }

    onGravityBurst(pos) {
      this._gravBlastT = 0.25;
      this.gravBlast.material.opacity = 0.95;
      this.gravBlast.scale.set(0.1, 0.1, 1);
    }

    onPerkChanged(newDef) {
      this.reset();
    }

    showActionToast(title, sub, color) {
      if (!this.actionToastEl) return;
      this.actionToastEl.innerHTML = '<span style="color:' + (color || '#46a9ff') + '">' + title + '</span>' + (sub ? ' <i>// ' + sub + '</i>' : '');
      this.actionToastEl.classList.remove('hidden');
      this._toastTimer = 1.1;
    }

    reset() {
      if (this.katanaGroup) {
        this.katanaGroup.visible = false;
        this.katanaGroup.position.set(0, -1, 0);
      }
      if (this.fireLight) this.fireLight.intensity = 0;
      if (this.medicGroup) this.medicGroup.visible = false;
      if (this.gravityGroup) this.gravityGroup.visible = false;
      if (this.visorEl) this.visorEl.classList.add('hidden');
      if (this.maskBreakOverlay) this.maskBreakOverlay.classList.add('hidden');
      if (this.vignetteEl) this.vignetteEl.className = 'perk-vignette';
      if (this.actionToastEl) this.actionToastEl.classList.add('hidden');
      if (this._origWeaponMats && this._origWeaponMats.size > 0) {
        this._origWeaponMats.forEach((mat, mesh) => { mesh.material = mat; });
        this._origWeaponMats.clear();
      }
      this._gravBlastT = 0;
    }

    dispose() {
      this.reset();
      if (this.katanaGroup) this.camera.remove(this.katanaGroup);
      if (this.fireLight) this.camera.remove(this.fireLight);
      if (this.medicGroup) this.scene.remove(this.medicGroup);
      if (this.gravityGroup) this.scene.remove(this.gravityGroup);
    }
  }

  /* ========================================================== UI MANAGER */

  class UIManager {
    constructor(game) {
      this.game = game;
      const $ = (id) => document.getElementById(id);
      this.el = {
        hud: $('hud'),
        hpFill: $('hp-fill'), hpText: $('hp-text'), stamina: $('stamina-fill'),
        wave: $('wave-value'), enemies: $('enemy-value'), kills: $('kills-value'),
        layoutName: $('layout-name'),
        weaponName: $('weapon-name'), ammoMag: $('ammo-mag'), ammoReserve: $('ammo-reserve'),
        weaponMods: $('weapon-mods'),
        ammoType: $('ammo-type'),
        reloadHint: $('reload-hint'),
        slots: Array.prototype.slice.call(document.querySelectorAll('#weapon-slots .slot')),
        hitmarker: $('hitmarker'),
        vignette: $('damage-vignette'),
        lowHp: $('low-hp-pulse'),
        damageDirectionLayer: $('damage-direction-layer'),
        dirDmg: $('directional-damage'),
        banner: $('wave-banner'),
        intermission: $('intermission'),
        dmgNums: $('damage-numbers'),
        crosshair: $('crosshair'),
        pickupPrompt: $('pickup-prompt'),
        bossBar: $('boss-bar'),
        bossName: $('boss-name'),
        bossFill: $('boss-fill'),
        bossText: $('boss-text'),
        rewardScreen: $('reward-screen'),
        rewardTitle: $('reward-title'),
        rewardCards: $('reward-cards'),
      buffToast: $('buff-toast'),
      buffList: $('buff-list'),
      trailList: $('trail-list'),
      perkHud: $('perk-hud'),
      synergyList: $('synergy-list'),
      invBuild: $('inv-build'),
        dash: $('dash-status'),
        armor_helmet: $('armor-helmet'),
        armor_body: $('armor-body'),
        armor_boots: $('armor-boots'),
        armorTotal: $('armor-total'),
        armorFlash: $('armor-flash'),
        scope: $('scope-overlay'),
        inventory: $('inventory'),
        invArmor: $('inv-armor'),
        invWeapons: $('inv-weapons'),
        invAmmo: $('inv-ammo'),
        menuMain: $('menu-main'),
        menuControls: $('menu-controls'),
        menuPause: $('menu-pause'),
        menuOver: $('menu-gameover'),
        menuLoading: $('menu-loading'),
        loadingStatus: $('loading-status'),
        rsWave: $('rs-wave'), rsKills: $('rs-kills'), rsAcc: $('rs-acc')
      };
      this.hitmarkerT = 0;
      this.dmgNumCount = 0;
      this._slotActive = -1;
      this._slotSig = '';
      this._weaponFlashT = 0;
      this._vignetteT = 0;
      this._rewardOptions = null;
      this._rewardPick = null;
      this._bossRef = null;
      this._promptRef = null;
      this.directionalDamage = new DirectionalDamageSystem(this.game, this.el.damageDirectionLayer || this.el.dirDmg);
    }

    showScreen(name) {
      const e = this.el;
      e.menuMain.classList.toggle('hidden', name !== 'main');
      e.menuControls.classList.toggle('hidden', name !== 'controls');
      e.menuPause.classList.toggle('hidden', name !== 'pause');
      e.menuOver.classList.toggle('hidden', name !== 'gameover');
      e.hud.classList.toggle('hidden', name !== null);
    }

    hideLoading() { this.el.menuLoading.classList.add('hidden'); }

    flashWeapon() { this._weaponFlashT = 0.18; }

    /* ---------------- new HUD: dash / armour / scope / inventory ---------------- */

    updateDash(player) {
      const el = this.el.dash;
      if (!el) return;
      const cd = player.dashCd;
      const total = player.dashCooldown();
      if (cd <= 0.01) {
        el.classList.remove('cooling');
        el.classList.add('ready');
        el.innerHTML = 'DASH <b>READY</b>';
      } else {
        el.classList.add('cooling');
        el.classList.remove('ready');
        el.innerHTML = 'DASH <b>' + cd.toFixed(1) + 's</b>';
        el.style.setProperty('--p', ((1 - cd / Math.max(0.01, total)) * 100).toFixed(0) + '%');
      }
    }

    updateArmor(player) {
      const p = player;
      for (let i = 0; i < p.armorSlots.length; i++) {
        const slot = p.armorSlots[i];
        const inst = p.armor[slot];
        const el = this.el['armor_' + slot];
        if (!el) continue;
        const key = inst ? inst.armor + inst.rarityId : 'none';
        if (el.dataset.v === key) continue;
        el.dataset.v = key;
        el.classList.toggle('empty', !inst);
        el.style.borderColor = inst ? inst.rarity.css : '';
        el.style.color = inst ? inst.rarity.css : '';
        el.innerHTML = '<i>' + slot.charAt(0).toUpperCase() + '</i><b>' + (inst ? Math.round(inst.armor) : '--') + '</b>';
      }
      if (this.el.armorTotal) {
        const tot = Math.round(p.armorValue());
        this.el.armorTotal.textContent = tot > 0 ? 'ARMOR ' + tot : '';
      }
    }

    flashArmor(slot) {
      const el = this.el['armor_' + slot];
      if (!el) return;
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }

    showArmorHit(info) {
      const el = this.el.armorFlash;
      if (!el) return;
      el.classList.remove('on');
      void el.offsetWidth;
      el.style.setProperty('--c', info.head ? 'rgba(255,190,90,' : 'rgba(120,190,255,');
      el.classList.add('on');
    }

    showArmorBroken() {
      this.game.audio.tone(this.game.audio.t, 0.26, 180, 60, 0.32, 'square');
      this.showBanner('ARMOR BROKEN', false, 1.2);
    }

    showAmmoEmpty(ammo) {
      this.showBanner('OUT OF ' + ammo.name, false, 1.1);
      this.game.audio.dryFire();
    }

    updateScope(player) {
      const el = this.el.scope;
      if (!el) return;
      const w = player.weapon;
      const scoped = !!(w && player.scoped && player.adsAmt > 0.6);
      if (scoped !== this._scopeOn) {
        this._scopeOn = scoped;
        el.classList.toggle('hidden', !scoped);
        if (scoped) {
          const o = w.inst.optic;
          el.innerHTML = '<div class="scope-mask"></div>' +
            '<div class="scope-reticle r-' + o.reticle + '"></div>' +
            '<div class="scope-info">' + o.name + ' &nbsp;' + o.zoom.toFixed(1) + 'x</div>';
        }
      }
      if (scoped) el.style.opacity = String(clamp((player.adsAmt - 0.6) / 0.4, 0, 1));
    }

    /* ---------------- inventory (TAB) ---------------- */

    /** crosshair swaps to a tight dot while aiming; hidden when scoped */
    updateAdsHint(player) {
      const el = this.el.crosshair;
      if (!el) return;
      const scoped = player.scoped && player.adsAmt > 0.5;
      el.classList.toggle('ads', player.adsAmt > 0.6);
      el.classList.toggle('scoped', scoped);
    }

    /* ---------------- build HUD (trails + perk) ---------------- */

    /** compact trail chips: name + the live number it currently gives */
    updateTrailHud() {
      const b = this.game.build, el = this.el.trailList;
      if (!el) return;
      const sig = b.trails.map((t) => t ? t.id : '-').join('|');
      if (sig !== this._trailSig) {
        this._trailSig = sig;
        el.innerHTML = b.trails.map((t, i) => t
          ? '<div class="trail-chip" data-i="' + i + '"><i>' + t.glyph + '</i><b>' + t.name + '</b><span></span></div>'
          : '<div class="trail-chip empty"><i></i><b>EMPTY</b><span></span></div>'
        ).join('');
        if (this.el.synergyList) {
          const syn = b.synergyList();
          this.el.synergyList.innerHTML = syn.length
            ? syn.map(s => '<span class="syn-chip" title="' + s.desc + '"> ' + s.name + '</span>').join('')
            : '';
        }
      }
      this._refreshTrailStatus();
    }

    /** only the numbers change here, so no DOM churn per frame */
    _refreshTrailStatus() {
      const b = this.game.build, el = this.el.trailList;
      if (!el || !el.children.length) return;
      for (let i = 0; i < el.children.length; i++) {
        const def = b.trails[i], st = b.trailState[i];
        const span = el.children[i].lastChild;
        if (!def || !st || !def.status) { if (span) span.textContent = ''; continue; }
        const s = def.status(st);
        if (span.textContent !== s.text) span.textContent = s.text;
        el.children[i].classList.toggle('active', !!s.on);
      }
    }

    updatePerkHud() {
      const b = this.game.build, el = this.el.perkHud;
      if (!el) return;
      if (!b.perk) { el.classList.add('hidden'); el.innerHTML = ''; return; }
      el.classList.remove('hidden');
      const s = b.perkStatus();
      const isCritical = !!(s.critical || (b.perk.id === 'fireman' && b.perkState && b.perkState.heat >= 92));
      const isPhantom = !!(b.perk.id === 'phantom' && b.perkState && b.perkState.active > 0);
      let cls = 'perk-hud';
      if (isCritical) cls += ' critical';
      else if (s.warn) cls += ' warn';
      if (isPhantom) cls += ' phantom-active';
      el.className = cls;
      el.innerHTML = '<div class="perk-row"><i>' + b.perk.glyph + '</i><b>' + b.perk.name + '</b>' +
        '<span>' + (s.label ? s.label + '  ' : '') + s.text + '</span></div>' +
        '<div class="perk-bar"><div style="width:' + Math.round(clamp(s.bar, 0, 1) * 100) + '%"></div></div>';
    }

    /** small toast, throttled so a perk cannot spam it every frame */
    showBuffToast(title, sub) {
      const t = this.el.buffToast;
      if (!t) return;
      const now = performance.now();
      if (now - (this._toastT || 0) < 260) return;
      this._toastT = now;
      t.innerHTML = '<b>' + title + '</b><span>' + (sub || '') + '</span>';
      t.classList.remove('show');
      void t.offsetWidth;
      t.classList.add('show');
    }

    toggleInventory() {
      const open = !this.inventoryOpen;
      if (open) this.renderInventory();
      this.el.inventory.classList.toggle('hidden', !open);
      return open;
    }

    hideInventory() { if (this.el.inventory) this.el.inventory.classList.add('hidden'); }
    get inventoryOpen() { return this.el.inventory && !this.el.inventory.classList.contains('hidden'); }

    renderInventory() {
      const p = this.game.player;
      const armorRows = p.armorSlots.map((slot) => {
        const inst = p.armor[slot];
        if (!inst) return '<div class="inv-row empty"><b>' + slot.toUpperCase() + '</b><span>empty</span></div>';
        return '<div class="inv-row"><b style="color:' + inst.rarity.css + '">' + inst.rarity.name + '</b>' +
          '<span>' + inst.kind.name + '  +' + inst.armor + ' armor</span></div>';
      }).join('');
      const weaponRows = p.slots.map((s, i) => {
        if (!s) return '<div class="inv-row empty"><b>' + (i + 1) + '</b><span>empty</span></div>';
        const atts = s.attachmentList().map((a) => a.name).join(', ') || '';
        return '<div class="inv-row' + (i === p.current ? ' active' : '') + '">' +
          '<b style="color:' + s.rarity.css + '">' + (i + 1) + '. ' + s.rarity.name + '</b>' +
          '<span>' + s.type.name + '  ' + s.mag + '/' + s.stats.magazine + '  ' + s.magazine.name + '</span>' +
          '<em>' + atts + '</em></div>';
      }).join('');
      const ammoRows = AMMO_IDS.map((id) =>
        '<div class="inv-ammo"><b>' + AMMO_TYPES[id].name + '</b><span>' + p.ammoPool(id) + '</span></div>').join('');
      this.el.invArmor.innerHTML = armorRows;
      this.el.invWeapons.innerHTML = weaponRows;
      this.el.invAmmo.innerHTML = ammoRows;
      if (this.el.invBuild) this.renderBuildSummary();
    }

    /** BUILD block: perk + trails + the gear they modify */
    renderBuildSummary() {
      const g = this.game, b = g.build, p = g.player;
      const s = b.perkStatus();
      const perkRow = b.perk
        ? '<div class="build-row"><i>' + b.perk.glyph + '</i><b>' + b.perk.name + '</b>' +
          '<span>' + b.perk.desc + '</span><em>' + (s.label ? s.label + '  ' : '') + s.text + '</em></div>'
        : '<div class="build-row empty"><i></i><b>NO PERK</b><span>Press F once you pick one</span></div>';
      const trailRows = b.trails.map((t, i) => {
        if (!t) return '<div class="build-row empty"><i>' + (i + 1) + '</i><b>EMPTY</b><span></span></div>';
        const st = b.trailState[i];
        const live = t.status ? t.status(st) : null;
        return '<div class="build-row"><i>' + t.glyph + '</i><b style="color:' + RARITY_BY_ID[t.rarity].css + '">' + t.name + '</b>' +
          '<span>' + t.desc + '</span><em>' + (live && live.on ? live.text : 'inactive') + '</em></div>';
      }).join('');
      const syn = b.synergyList();
      const w = p.weapon ? p.weapon.inst : null;
      const vest = p.armor.body;
      this.el.invBuild.innerHTML =
        '<h3 class="inv-head">BUILD</h3>' +
        '<div class="build-perk">' + perkRow + '</div>' +
        '<h3 class="inv-head">TRAILS</h3>' + trailRows +
        (syn.length ? '<div class="build-syn">' + syn.map(x =>
          '<div class="syn-row"> ' + x.name + '  ' + x.desc + '</div>').join('') + '</div>' : '') +
        '<h3 class="inv-head">GEAR</h3>' +
        (w ? '<div class="build-row"><i></i><b style="color:' + w.rarity.css + '">' + w.displayName + '</b>' +
          '<span>' + w.mag + '/' + w.stats.magazine + '  ' + w.ammo.name + '</span></div>' : '') +
        (vest ? '<div class="build-row"><i></i><b style="color:' + vest.rarity.css + '">' + vest.displayName + '</b>' +
          '<span>+' + vest.armor + ' armour</span></div>' : '');
    }

    update(dt) {
      const g = this.game;
      const p = g.player;
      this.updateDash(p);
      this.updateArmor(p);
      this.updateScope(p);
      this.updateAdsHint(p);

      // health / stamina (max HP grows with buffs)
      const hpF = clamp(p.health / p.maxHealth, 0, 1);
      this.el.hpFill.style.width = (hpF * 100).toFixed(1) + '%';
      this.el.hpText.textContent = Math.ceil(p.health) + ' / ' + Math.round(p.maxHealth);
      this.el.stamina.style.width = clamp(p.stamina / p.stats.staminaMax, 0, 1) * 100 + '%';
      this.el.lowHp.style.opacity = hpF < 0.35 ? String(0.25 + Math.sin(g.time * 5) * 0.15) : '0';

      // weapon / ammo
      const w = p.weapon;
      const inst = p.instance;
      // slot row: [1] name / [2] name / [3] EMPTY, rarity coloured
      const sig = p.slots.map((s) => s ? s.uid + ':' + (s === p.slots[p.current] ? '*' : '') : '-').join(',') + '|' + p.current;
      if (sig !== this._slotSig) {
        this._slotSig = sig;
        for (let i = 0; i < this.el.slots.length; i++) {
          const el = this.el.slots[i];
          const s = p.slots[i];
          el.classList.toggle('active', i === p.current);
          el.classList.toggle('empty', !s);
          const label = el.querySelector('span');
          if (label) {
            label.textContent = s ? s.type.name : 'EMPTY';
            label.style.color = s ? s.rarity.css : '';
          }
        }
      }
      if (w && inst) {
        this.el.weaponName.textContent = inst.rarity.name + ' ' + inst.type.name;
        this.el.weaponName.style.color = inst.rarity.css;
        this.el.ammoMag.textContent = w.mag;
        this.el.ammoMag.classList.toggle('low', w.mag <= Math.ceil(w.stats.magazine * 0.25));
        // reserve shows the matching ammo pool, not a spare magazine
        this.el.ammoReserve.textContent = p.ammoPool(inst.ammoId);
        this.el.ammoType && (this.el.ammoType.textContent = inst.ammo.name);
      } else {
        this.el.weaponName.textContent = 'UNARMED';
        this.el.weaponName.style.color = '';
        this.el.ammoMag.textContent = '--';
        this.el.ammoReserve.textContent = '--';
        this.el.ammoMag.classList.remove('low');
      }
      this.el.reloadHint.classList.toggle('hidden', !(w && w.reloading));

      // modifier chips under the weapon name
      if (inst) {
        const chipSig = inst.modIds.join(',');
        if (chipSig !== this._chipSig) {
          this._chipSig = chipSig;
          this.el.weaponMods.innerHTML = inst.mods
            .map((m) => '<span class="mod-chip" title="' + m.desc + '">' + m.name + '</span>').join('');
        }
      } else if (this._chipSig !== '') {
        this._chipSig = '';
        this.el.weaponMods.innerHTML = '';
      }

      // crosshair spread feedback
      const spread = 6 + (p.planarSpeed * 0.9) + (w ? w.kick * 7 : 0);
      this.el.crosshair.style.width = (18 + spread) + 'px';
      this.el.crosshair.style.height = (18 + spread) + 'px';

      // stats
      this.el.wave.textContent = g.waveManager.wave || 1;
      this.el.enemies.textContent = g.aliveEnemyCount() + g.waveManager.queue.length;
      this.el.kills.textContent = g.stats.kills;

      // boss health bar
      if (this._bossRef) {
        const b = this._bossRef;
        if (!b.alive) this.hideBossBar();
        else {
          const f = clamp(b.hp / b.maxHp, 0, 1);
          this.el.bossFill.style.width = (f * 100).toFixed(1) + '%';
          this.el.bossText.textContent = Math.ceil(b.hp) + ' / ' + b.maxHp;
        }
      }

      // damage vignette fade
      if (this._vignetteT > 0) {
        this._vignetteT -= dt;
        if (this._vignetteT <= 0 && this.el.vignette) this.el.vignette.style.opacity = '0';
      }
      if (this.directionalDamage) {
        this.directionalDamage.update(dt);
      }

      if (this._weaponFlashT > 0) {
        this._weaponFlashT -= dt;
        if (this._weaponFlashT <= 0) this.el.weaponName.style.color = inst ? inst.rarity.css : '';
      }

      // cap damage-number DOM churn
      while (this.dmgNumCount > 26) {
        const first = this.el.dmgNums.firstChild;
        if (!first) break;
        this.el.dmgNums.removeChild(first);
        this.dmgNumCount--;
      }
    }

    /* ---------------- pickup prompt ---------------- */

    updatePickupPrompt(pickup) {
      if (!pickup) { this.hidePickupPrompt(); return; }
      if (this._promptRef === pickup) return;
      this._promptRef = pickup;
      const info = pickup.info();
      const lines = info.lines.map((l) =>
        '<span>' + l[0] + ': <b>' + l[1] + '</b></span>').join('');
      const mods = info.mods.map((m) => '<span class="pp-mod">' + m.name + '  ' + m.desc + '</span>').join('');
      const atts = info.atts.map((a) => '<span class="pp-att">' + a.slot.toUpperCase() + ': ' + a.name + '</span>').join('');
      // armour comparison against what is worn
      let compare = '';
      if (pickup.kind === 'armor') {
        const p = this.game.player;
        const cur = p.armorFor(pickup.inst.slot);
        if (cur) {
          const d = pickup.inst.armor - cur.armor;
          compare = '<div class="pp-compare">CURRENT ' + cur.armor +
            ' &nbsp;&rarr;&nbsp; GROUND ' + pickup.inst.armor +
            ' &nbsp;<b class="' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? ' +' : ' ') + d + '</b></div>';
        }
      }
      this.el.pickupPrompt.innerHTML =
        '<div class="pp-key">[E] PICK UP</div>' +
        '<div class="pp-name" style="color:' + info.color + '">' + info.title + '</div>' +
        '<div class="pp-stats">' + lines + '</div>' +
        compare +
        (atts ? '<div class="pp-mods">' + atts + '</div>' : '') +
        (mods ? '<div class="pp-mods">' + mods + '</div>' : '');
      this.el.pickupPrompt.classList.remove('hidden');
    }

    hidePickupPrompt() {
      if (!this._promptRef) return;
      this._promptRef = null;
      this.el.pickupPrompt.classList.add('hidden');
      this.el.pickupPrompt.innerHTML = '';
    }

    /* ---------------- boss bar ---------------- */

    showBossBar(enemy) {
      this._bossRef = enemy;
      this.el.bossBar.classList.remove('hidden');
      this.el.bossName.textContent = enemy.type.name;
      this.el.bossFill.style.width = '100%';
      this.el.bossText.textContent = enemy.hp + ' / ' + enemy.maxHp;
    }

    hideBossBar() {
      this._bossRef = null;
      if (this.el.bossBar) this.el.bossBar.classList.add('hidden');
    }

    /* ---------------- reward screen ---------------- */

    showReward(title, options, onPick) {
      this._rewardOptions = options;
      this._rewardPick = onPick;
      this.el.rewardTitle.textContent = title;
      this.el.rewardCards.innerHTML = '';
      const kindLabel = { buff: 'BUFF', trail: 'TRAIL', perk: 'PERK' };
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const kind = o.kind || 'buff';
        const def = o.def || o;
        const card = document.createElement('div');
        card.className = 'reward-card k-' + kind;
        const glyph = def.glyph || (kind === 'trail' ? '' : '');
        const badge = kind === 'trail' ? (b => '<em class="rc-badge" style="color:' + b.css + '">' + b.name + '</em>')(RARITY_BY_ID[def.rarity] || RARITIES[0])
          : kind === 'perk' ? '<em class="rc-badge perk">' + kindLabel.perk + '</em>'
            : '<em class="rc-badge buff">' + kindLabel.buff + '</em>';
        const swapNote = kind === 'trail'
          ? (this.game.build.trailCount() >= BUILD_CAPS.trails ? '<div class="rc-swap">replaces a trail</div>' : '')
          : kind === 'perk' && this.game.build.perk
            ? '<div class="rc-swap">replaces ' + this.game.build.perk.name + '</div>' : '';
        card.innerHTML = '<div class="rc-key">' + (i + 1) + '</div>' + badge +
          '<div class="rc-name">' + glyph + ' ' + def.name + '</div>' +
          '<div class="rc-desc">' + def.desc + '</div>' + swapNote;
        card.addEventListener('click', () => this.chooseReward(i));
        this.el.rewardCards.appendChild(card);
      }
      this.el.rewardScreen.classList.remove('hidden');
    }

    chooseReward(i) {
      if (!this._rewardOptions || i < 0 || i >= this._rewardOptions.length) return;
      const def = this._rewardOptions[i];
      const cb = this._rewardPick;
      this._rewardOptions = null;
      this._rewardPick = null;
      this.hideReward();
      if (cb) cb(def);
    }

    hideReward() {
      if (this.el.rewardScreen) this.el.rewardScreen.classList.add('hidden');
    }

    /** toast + persistent buff list */
    showBuffGained(buff) {
      if (!buff) return;
      const t = this.el.buffToast;
      t.innerHTML = '<b>' + buff.name + '</b><span>' + buff.desc + '</span>';
      t.classList.remove('show');
      void t.offsetWidth;
      t.classList.add('show');
      const p = this.game.player;
      this.el.buffList.innerHTML = p.buffs.map((b) =>
        '<span class="buff-chip' + (b.count > 1 ? ' x' + b.count : '') + '" title="' + b.def.desc + '">' +
        b.def.name + '</span>').join('');
      setTimeout(() => { if (t.innerHTML.indexOf(buff.name) >= 0) t.classList.remove('show'); }, 2200);
    }

    showHitmarker(head, kill) {
      const h = this.el.hitmarker;
      h.classList.remove('show', 'kill');
      void h.offsetWidth;             // restart animation
      if (kill) h.classList.add('kill');
      h.classList.add('show');
    }

    showDamage(amount = 20) {
      const v = this.el.vignette;
      if (v) {
        v.classList.remove('hit');
        void v.offsetWidth;
        v.classList.add('hit');
      }
      this._vignetteT = 0.50;
    }

    showDirectionalDamage(sourcePos, camera, amount = 20, options = {}) {
      if (this.directionalDamage) {
        this.directionalDamage.showDamage(amount, sourcePos, options);
      }
    }

showDamageNumber(worldPos, amount, head, crit, color) {
      const g = this.game;
      const v = worldPos.clone().project(g.camera);
      if (v.z > 1) return;                     // behind camera
      const x = (v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      const d = document.createElement('div');
      d.className = 'dmg-num' + (head ? ' head' : '') + (crit ? ' crit' : '');
      d.textContent = String(amount);
      if (color) d.style.color = color;
      d.style.left = (x + rand(-16, 16)) + 'px';
      d.style.top = y + 'px';
      this.el.dmgNums.appendChild(d);
      this.dmgNumCount++;
      setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); this.dmgNumCount--; }, 900);
    }

showBanner(text, cleared, duration) {
      const b = this.el.banner;
      b.textContent = text;
      b.classList.toggle('cleared', !!cleared);
      b.classList.remove('show');
      void b.offsetWidth;
      b.classList.add('show');
      if (duration) {
        clearTimeout(this._bannerT);
        this._bannerT = setTimeout(() => b.classList.remove('show'), duration * 1000);
      }
    }

    showIntermission(seconds) {
      this.el.intermission.classList.add('show');
      this.updateIntermission(seconds);
    }
    hideIntermission() { this.el.intermission.classList.remove('show'); }
    updateIntermission(t) {
      this.el.intermission.textContent = 'NEXT STAGE IN ' + Math.max(0, Math.ceil(t));
    }

    updateWave(n) { this.el.wave.textContent = n; }
    updateEnemies(n) { this.el.enemies.textContent = n; }

    /** arena name under the stage counter, so a new layout is announced */
    showLayoutName(name) {
      const el = this.el.layoutName;
      if (!el || !name) return;
      el.textContent = name;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }

    showGameOver(stage, kills, accuracy) {
      this.el.rsWave.textContent = stage;
      this.el.rsKills.textContent = kills;
      this.el.rsAcc.textContent = Math.round(accuracy * 100) + '%';
      this.hideBossBar();
      this.hideReward();
      this.hidePickupPrompt();
      this.showScreen('gameover');
    }
  }

  /* =============================================================== GAME */

  class Game {
    constructor() {
      this.canvas = document.getElementById('game-canvas');
      this.state = 'menu';            // menu | controls | playing | paused | dead | gameover
      this.time = 0;
      this.shake = 0;
      this.shakeOffset = new THREE.Vector3();
      this.enemies = [];
      this.pickups = [];
      this.loot = new LootSystem(this);
      this.stats = { kills: 0, shots: 0, hits: 0, headshots: 0 };
      this.pendingGameOver = 0;
      this.boss = null;
      this.pendingReward = null;

      this._initRenderer();
      this._initScene();

      this.audio = new AudioManager();
      this.input = new InputManager(this.canvas);
      this.collision = new CollisionSystem();
      this.particles = new ParticleSystem(this.scene);
      this.tracers = new TracerSystem(this.scene);
      this.projectiles = new ProjectileSystem(this);

      this.arena = new Arena(this.scene, this.collision, this);
      this.player = new Player(this);
      this.build = new BuildSystem(this);
      this.afterimages = [];          // phantom ghost trails (pooled, capped)
      this.enemyMarkers = [];         // executioner target markers (pooled DOM)
      this.scene.add(this.camera);

      this.waveManager = new WaveManager(this);
      this.ui = new UIManager(this);
      this.perkVisuals = new PerkVisualSystem(this);

      this._bindUI();
      this._bindResize();

      this.ui.showScreen('main');
      this.ui.hideLoading();
      this.lastTime = performance.now();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    /* ---------------- setup ---------------- */

    _initRenderer() {
      const renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0a0e14, 1);
      this.renderer = renderer;
    }

    _initScene() {
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0x1d2733, 30, 100);

      this.camera = new THREE.PerspectiveCamera(CFG.fov, window.innerWidth / window.innerHeight, 0.05, 400);

      const hemi = new THREE.HemisphereLight(0x8fb2d6, 0x23241f, 0.26);
      this.scene.add(hemi);
      this.hemi = hemi;

      const ambient = new THREE.AmbientLight(0x46566a, 0.15);
      this.scene.add(ambient);
      this.ambient = ambient;

      const sun = new THREE.DirectionalLight(0xffe0b0, 0.6);
      sun.position.set(26, 38, 18);
      sun.castShadow = true;
      sun.shadow.mapSize.width = 2048;
      sun.shadow.mapSize.height = 2048;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 130;
      const s = 42;
      sun.shadow.camera.left = -s;
      sun.shadow.camera.right = s;
      sun.shadow.camera.top = s;
      sun.shadow.camera.bottom = -s;
      sun.shadow.bias = -0.0012;
      this.scene.add(sun);
      this.sun = sun;

      // subtle cool fill from the opposite side
      const fill = new THREE.DirectionalLight(0x5f93c4, 0.12);
      fill.position.set(-22, 16, -20);
      this.scene.add(fill);
    }

    _bindResize() {
      const onResize = () => {
        const w = window.innerWidth, h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(w, h, false);
      };
      window.addEventListener('resize', onResize);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    }

    _bindUI() {
      const on = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      };
      on('btn-start', () => this.startGame());
      on('btn-controls', () => {
        this._controlsFrom = 'main';
        this.state = 'controls';
        this.ui.showScreen('controls');
      });
      on('btn-controls-back', () => {
        const back = this._controlsFrom === 'paused' ? 'pause' : 'main';
        this._controlsFrom = null;
        this.state = back;
        this.ui.showScreen(back);
      });
      on('btn-resume', () => this.resume());
      on('btn-pause-controls', () => { this._controlsFrom = 'paused'; this.state = 'controls'; this.ui.showScreen('controls'); });
      on('btn-quit', () => this.quitToMenu());
      on('btn-restart', () => this.startGame());
      on('btn-gameover-menu', () => this.quitToMenu());

      // click the canvas to (re)lock the pointer while playing
      this.canvas.addEventListener('mousedown', () => {
        if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
      });

      this.input.onEscape = () => {
        if (this.ui.inventoryOpen) { this.ui.hideInventory(); this.state = 'playing'; this.input.requestLock(); return; }
        if (this.state === 'playing') this.pause();
        else if (this.state === 'paused') this.resume();
        else if (this.state === 'controls') {
          const back = this._controlsFrom === 'paused' ? 'pause' : 'main';
          this.state = back;
          this.ui.showScreen(back);
        }
      };
      this.input.onTab = () => {
        if (this.state !== 'playing' && !this.ui.inventoryOpen) return;
        const open = this.ui.toggleInventory();
        if (open) { this.state = 'inventory'; this.input.releaseLock(); }
        else { this.state = 'playing'; this.input.requestLock(); }
      };
      this.input.onLockChange = (locked) => {
        if (!locked && this.state === 'playing') this.pause();
      };
    }

    /* ---------------- state transitions ---------------- */

    startGame() {
      this.audio.init();
      this.reset();
      this.state = 'playing';
      this.ui.showScreen(null);
      this.input.requestLock();
      // short countdown before the first wave
      this.waveManager.startIntermission(true);
      this.ui.showBanner('GET READY');
    }

    reset() {
      for (let i = 0; i < this.enemies.length; i++) this.enemies[i].dispose(this);
      this.enemies.length = 0;
      for (let i = 0; i < this.pickups.length; i++) this.pickups[i].dispose();
      this.pickups.length = 0;
      this.boss = null;
      this.pendingReward = null;
      this._lastLayout = -1;
      this.arena.applyLayout(this.pickLayoutIndex(), 1);
      this.collision.clearDynamic();
      this.particles.clear();
      this.tracers.clear();
      this.projectiles.clear();
      for (let i = this.afterimages.length - 1; i >= 0; i--) {
        const a = this.afterimages[i];
        this.scene.remove(a.mesh);
        a.mesh.material.dispose();
      }
      this.afterimages.length = 0;
      this.player.respawn();
      // respawn re-registers the player hitboxes
      this.collision.addDynamic(this.player.hitBody);
      this.collision.addDynamic(this.player.hitHead);
      this.player.dynamicAdded = true;
      this.waveManager.reset();
      this.stats.kills = 0;
      this.stats.shots = 0;
      this.stats.hits = 0;
      this.stats.headshots = 0;
      this.shake = 0;
      this.shakeOffset.set(0, 0, 0);
      this.pendingGameOver = 0;
      this.slowmo = 0;
      this.bossIntro = null;
      this.ui.hideBossBar();
      this.ui.hideReward();
      this.ui.hidePickupPrompt();
      this.ui.updateWave(1);
      this.ui.updateEnemies(0);
      this.ui.hideIntermission();
      this.ui.el.kills.textContent = '0';
      this.ui.el.dmgNums.innerHTML = '';
      this.ui.dmgNumCount = 0;
      if (this.ui && this.ui.directionalDamage) this.ui.directionalDamage.reset();
      if (this.perkVisuals) this.perkVisuals.reset();
      this._healToken = 0;
    }

    pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this.input.releaseLock();
      this.ui.showScreen('pause');
    }

    resume() {
      if (this.state !== 'paused') return;
      this.state = 'playing';
      this.ui.showScreen(null);
      this.audio.init();
      this.input.requestLock();
    }

    quitToMenu() {
      this.state = 'menu';
      this.input.releaseLock();
      this.reset();
      this.ui.showScreen('main');
    }

    onPlayerDeath() {
      this.pendingGameOver = 2.6;
      if (this.perkVisuals) this.perkVisuals.reset();
    }

    /* ================= build system (trails + perk) ================= */

    /** perks only fire while the game is actually being played */
    canUsePerk() {
      return this.state === 'playing' && !this.ui.inventoryOpen && this.build.perk !== null;
    }

    activatePerk() {
      const b = this.build, def = b.perk, s = b.perkState;
      if (!def || !s || !this.player.alive) return false;

      if (def.id === 'executioner') {
        return this._toggleExecutionerMask();
      }

      if (def.id === 'samurai') {
        const rec = s.slashRecovery !== undefined ? s.slashRecovery : 1;
        if (rec < 1) return false;
        this._samuraiSlash();
        this.ui.updatePerkHud();
        return true;
      }

      if (s.cd > 0) return false;
      s.cd = def.cd;
      switch (def.id) {
        case 'fireman':
          s.burning = Math.max(s.burning, 2.5);
          this.audio.tone(this.audio.t, 0.16, 320, 620, 0.14, 'sawtooth');
          break;
        case 'phantom':
          s.active = b.hasSynergy('phantom_momentum') ? 3.8 : 3.0;
          this.audio.tone(this.audio.t, 0.3, 500, 200, 0.3, 'sine');
          break;
        case 'medic':
          s.fieldPos.copy(this.player.position);
          s.fieldT = 5;
          this.audio.tone(this.audio.t, 0.24, 380, 620, 0.24, 'sine');
          break;
        case 'gravity':
          s.pulsePos.copy(this.player.position);
          s.pulseT = 1.6;
          this._pulseBoom = true;
          this.audio.tone(this.audio.t, 0.35, 200, 70, 0.35, 'sine');
          break;
        case 'engineer':
          if (s.turret) this.removeTurret(s.turret);
          s.turret = this.spawnTurret(this.player.position);
          this.audio.tone(this.audio.t, 0.22, 420, 640, 0.22, 'square');
          break;
      }
      this.ui.showBuffToast(def.name, def.desc);
      if (this.perkVisuals) this.perkVisuals.onActivate(def.id, s);
      return true;
    }

    _toggleExecutionerMask() {
      const b = this.build, s = b.perkState;
      if (!s) return false;
      const state = s.maskState || 'OFF';

      if (state === 'BROKEN' || state === 'REPAIRING') {
        this.audio.dryFire();
        if (this.perkVisuals) {
          this.perkVisuals.showActionToast(
            state === 'BROKEN' ? 'TAKE OFF MASK' : 'MASK REPAIRING',
            state === 'BROKEN' ? 'MASK SHATTERED' : Math.round(s.mask) + '% (NEEDS 50%)',
            '#ff3344'
          );
        }
        return false;
      }

      if (state === 'EQUIPPED') {
        // Manual unequip:
        s.maskState = 'OFF';
        s.maskActive = 0;
        s.damageBonus = 0;
        this.clearEnemyMarkers();
        this.audio.tone(this.audio.t, 0.18, 420, 180, 0.18, 'triangle');
        if (this.perkVisuals) this.perkVisuals.onMaskToggled(false);
        this.ui.updatePerkHud();
        b.apply();
        return true;
      }

      // state is 'OFF' or 'READY':
      if (s.mask < 50 && (s.maskBroken || state === 'REPAIRING')) {
        this.audio.dryFire();
        return false;
      }

      // Manual equip:
      s.maskState = 'EQUIPPED';
      s.maskActive = 1;
      s.damageBonus = 0; // Starts fresh, do not restore previous bonus
      this.audio.tone(this.audio.t, 0.2, 180, 420, 0.2, 'triangle');
      if (this.perkVisuals) this.perkVisuals.onMaskToggled(true);
      this.ui.updatePerkHud();
      b.apply();
      return true;
    }

    /** F held: fire man keeps burning, samurai spends a dogtag to heal
     *  (one dogtag per hold, not one per frame) */
    holdPerk(dt) {
      const b = this.build, def = b.perk, s = b.perkState;
      if (!def || !s) return false;
      if (s.healCd > 0) s.healCd -= dt;
      if (def.id === 'fireman' && s.burning <= 0 && s.cd <= 0) this.activatePerk();
      else if (def.id === 'samurai' && s.slash <= 0 && s.dogtags > 0 && s.healCd <= 0) {
        s.healT = 0.5;
        s.healCd = 0.7;                     // rate limit: one heal per hold
        s.dogtags--;
        this.healPlayer(15, dt);
        this.audio.tone(this.audio.t, 0.2, 500, 760, 0.2, 'sine');
        if (this.perkVisuals) this.perkVisuals.onSoulHeal(s.dogtags);
      }
      return true;
    }

    releasePerk() {
      const s = this.build.perkState;
      if (s && s.healT > 0) s.healT = 0;
    }

    /** All healing goes through one capped path (token bucket refilled by dt),
     *  so no combination of perks can create infinite sustain. A single large
     *  heal may borrow against the bucket, sustained spam cannot. */
    healPlayer(amount, dt) {
      if (!isFinite(amount) || amount <= 0) return 0;
      const cap = this.build.hasSynergy('medic_survival') ? 12 : BUILD_CAPS.healPerSec;
      const step = (dt || 1 / 60);
      this._healToken = Math.min(cap, (this._healToken || 0) + cap * step);
      this._healToken -= amount;
      if (this._healToken < -cap * 0.5) return 0;      // too far in debt: refuse
      this.player.heal(amount);
      return amount;
    }

    /* ---------------- perk abilities ---------------- */

    _samuraiSlash() {
      const s = this.build.perkState;
      const w = this.player.weapon;
      const st = w ? w.stats : { damage: 40 };
      s.slash = 0.34;
      if ((s.dogtags || 0) >= 10) {
        s.slashRecovery = 1.0;
      } else {
        s.slashRecovery = 0.0;
      }
      if (this.perkVisuals) this.perkVisuals.startKatanaSlash();
      this.audio.tone(this.audio.t, 0.14, 900, 260, 0.14, 'triangle');
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const origin = this.player.position.clone();
      origin.y += 1.1;
      let hitAny = false;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.alive || e.spawnT < 1) continue;
        const to = new THREE.Vector3(e.position.x, e.chestY, e.position.z).sub(origin);
        const d = to.length();
        if (d > 3.4 || d < 0.1) continue;
        to.multiplyScalar(1 / d);
        if (to.dot(dir) < 0.55) continue;                  // 3m cone in front
        hitAny = true;
        e.takeDamage(st.damage * 1.8, to, false, this);
        if (this.perkVisuals) this.perkVisuals.onSlashHit(e, to);
        this.particles.burst(14, e.position.x, e.chestY, e.position.z, {
          spread: 1.8, up: 1.6, lifeMin: 0.15, lifeMax: 0.38,
          sizeMin: 0.03, sizeMax: 0.07, color: [1.0, 0.95, 0.8], grav: 4, drag: 2
        });
      }
      if (hitAny) this.addShake(0.18);
    }

    /** fire man: burning refreshes duration but never stacks */
    burnTargets(dps, duration) {
      const list = this.enemies;
      let burned = 0;
      for (let i = 0; i < list.length && burned < 24; i++) {
        const e = list[i];
        if (!e.alive || e.spawnT < 1) continue;
        if (e.burnT > 0) { e.burnT = Math.max(e.burnT, duration); continue; }
        e.burnT = duration;
        e.burnDps = dps;
        e.burnTick = 0;
        burned++;
      }
    }

    spawnAfterimage() {
      const src = this.player.weapon;
      if (!src || this.afterimages.length >= 4 || !src.model.children.length) return;
      const first = src.model.children[0];
      const m = new THREE.Mesh(first.geometry,
        new THREE.MeshBasicMaterial({ color: 0x7f5fff, transparent: true, opacity: 0.22, depthWrite: false }));
      m.scale.copy(src.model.scale);
      m.position.copy(this.camera.position);
      m.quaternion.copy(this.camera.quaternion);
      m.renderOrder = 8;
      this.scene.add(m);
      this.afterimages.push({ mesh: m, t: 0.45 });
    }

    updateAfterimages(dt) {
      for (let i = this.afterimages.length - 1; i >= 0; i--) {
        const a = this.afterimages[i];
        a.t -= dt;
        if (a.t <= 0) {
          this.scene.remove(a.mesh);
          a.mesh.material.dispose();
          this.afterimages.splice(i, 1);
        } else {
          a.mesh.material.opacity = (a.t / 0.45) * 0.22;
        }
      }
    }

    /* ---------------- executioner tracking ---------------- */

    updateEnemyMarkers(on) {
      const pool = this.enemyMarkers;
      if (!on) { this.clearEnemyMarkers(); return; }
      const cam = this.camera;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      let n = 0;
      for (let i = 0; i < this.enemies.length && n < 8; i++) {
        const e = this.enemies[i];
        if (!e.alive || e.spawnT < 1) continue;
        const v = new THREE.Vector3(e.position.x, e.position.y + e.type.height + 0.5, e.position.z);
        const rel = v.clone().sub(cam.position);
        const dist = rel.length();
        rel.multiplyScalar(1 / Math.max(0.01, dist));
        const p = v.clone().project(cam);
        if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
        if (rel.dot(fwd) < 0 && dist > 5) continue;
        let el = pool[n];
        if (!el) {
          el = document.createElement('div');
          el.className = 'enemy-marker';
          this.ui.el.hud.appendChild(el);
          pool[n] = el;
        }
        el.style.display = 'flex';
        el.style.left = ((p.x * 0.5 + 0.5) * window.innerWidth) + 'px';
        el.style.top = ((-p.y * 0.5 + 0.5) * window.innerHeight) + 'px';
        const typeStr = e.type.boss ? 'BOSS' : (e.type.key ? e.type.key.toUpperCase() : 'HOSTILE');
        el.innerHTML = '<div class="em-reticle"><span class="em-diamond">◆</span></div>' +
          '<div class="em-meta"><span class="em-type">' + typeStr + '</span><span class="em-dist">' + Math.round(dist) + 'm</span></div>';
        n++;
      }
      for (let i = n; i < pool.length; i++) pool[i].style.display = 'none';
    }

    clearEnemyMarkers() {
      for (let i = 0; i < this.enemyMarkers.length; i++) this.enemyMarkers[i].style.display = 'none';
    }

    /* ---------------- gravity pulse ---------------- */

    gravityPulse(dt, pos, remaining) {
      const pull = clamp(remaining / 1.6, 0, 1);
      const radius = 2 + (1 - pull) * 7;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.alive || e.spawnT < 1) continue;
        const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d > radius || d < 0.05) continue;
        e.velocity.x += (dx / d) * 15 * dt * pull;
        e.velocity.z += (dz / d) * 15 * dt * pull;
        e.slowT = 0.5;                                    // slowed while held
      }
      this._pulseT = (this._pulseT || 0) - dt;
      if (this._pulseT <= 0) {
        this._pulseT = 0.08;
        this.particles.burst(4, pos.x + rand(-3, 3), 0.6, pos.z + rand(-3, 3), {
          spread: 0.4, up: -0.6, lifeMin: 0.25, lifeMax: 0.5,
          sizeMin: 0.05, sizeMax: 0.12, color: [0.45, 0.2, 0.9], grav: -3, drag: 1.6
        });
      }
      if (remaining <= 0.001 && this._pulseBoom !== false) {
        this._pulseBoom = false;
        if (this.perkVisuals) this.perkVisuals.onGravityBurst(pos);
        for (let i = 0; i < this.enemies.length; i++) {
          const e = this.enemies[i];
          if (!e.alive || e.spawnT < 1) continue;
          const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
          const d = Math.hypot(dx, dz);
          if (d > 9) continue;
          const dir = new THREE.Vector3(dx, 0, dz).normalize();
          e.takeDamage(34 * (1 - d / 9), dir, false, this);
          e.knock.addScaledVector(dir, 9 * (1 - d / 9));
        }
        this.addShake(0.4);
        this.audio.tone(this.audio.t, 0.3, 120, 40, 0.35, 'sine');
        this.particles.burst(28, pos.x, 0.6, pos.z, {
          spread: 8, up: 2.2, lifeMin: 0.2, lifeMax: 0.6,
          sizeMin: 0.05, sizeMax: 0.14, color: [0.5, 0.25, 1.0], grav: 2, drag: 1.6
        });
      }
    }

    /* ---------------- engineer turret ---------------- */

    spawnTurret(pos) {
      const g = new THREE.Group();
      const base = new THREE.Mesh(cylGeo(0.28, 0.34, 0.2, 8), lamMat('tr.base', { color: 0x4a5361 }));
      base.position.y = 0.1;
      const body = new THREE.Mesh(boxGeo(0.34, 0.26, 0.4), lamMat('tr.body', { color: 0x6b7482 }));
      body.position.y = 0.33;
      const barrel = new THREE.Mesh(boxGeo(0.09, 0.09, 0.5), lamMat('tr.barrel', { color: 0x2a3038 }));
      barrel.position.set(0, 0.36, -0.32);
      const led = new THREE.Mesh(boxGeo(0.06, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: 0x4dff9b }));
      led.position.set(0, 0.5, 0.12);
      g.add(base); g.add(body); g.add(barrel); g.add(led);

      // Tripod legs
      const legMat = lamMat('tr.legs', { color: 0x333b47 });
      for (let a = 0; a < 3; a++) {
        const leg = new THREE.Mesh(boxGeo(0.05, 0.05, 0.38), legMat);
        leg.position.set(Math.cos(a * 2.09) * 0.22, 0.06, Math.sin(a * 2.09) * 0.22);
        leg.rotation.y = a * 2.09;
        leg.rotation.x = 0.45;
        g.add(leg);
      }

      // Turret muzzle flash cone
      const flashGeo = new THREE.ConeGeometry(0.08, 0.25, 6, 1, true);
      flashGeo.rotateX(-Math.PI / 2);
      flashGeo.translate(0, 0, -0.15);
      const flashMat = new THREE.MeshBasicMaterial({
        color: 0xffdd88,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const tFlash = new THREE.Mesh(flashGeo, flashMat);
      tFlash.position.set(0, 0, -0.28);
      tFlash.visible = false;
      barrel.add(tFlash);

      g.position.set(pos.x, pos.y, pos.z);
      g.scale.set(0.1, 0.1, 0.1);
      g.updateMatrixWorld(true);
      this.scene.add(g);
      this.audio.tone(this.audio.t, 0.15, 200, 480, 0.2, 'sawtooth');
      this.particles.burst(8, pos.x, pos.y + 0.1, pos.z, {
        spread: 0.6, up: 0.8, lifeMin: 0.1, lifeMax: 0.25,
        sizeMin: 0.02, sizeMax: 0.05, color: [0.9, 0.8, 0.4], grav: 3, drag: 2
      });

      return {
        mesh: g,
        barrel: barrel,
        led: led,
        flash: tFlash,
        flashT: 0,
        deployT: 0.35,
        baseYaw: this.player.yaw,
        life: 15,
        cd: 0
      };
    }

    updateTurret(t, dt) {
      if (!t.mesh) return false;
      t.life -= dt;
      if (t.life <= 0) { this.removeTurret(t); return false; }
      t.cd -= dt;

      // Deploy animation
      if (t.deployT > 0) {
        t.deployT -= dt;
        const p = clamp(1 - t.deployT / 0.35, 0.1, 1);
        t.mesh.scale.set(1, p, 1);
      } else if (t.mesh.scale.y < 0.99) {
        t.mesh.scale.set(1, 1, 1);
      }

      // Flash fade
      if (t.flashT > 0) {
        t.flashT -= dt;
        t.flash.material.opacity = Math.max(0, t.flashT / 0.055);
        if (t.flashT <= 0) t.flash.visible = false;
      }

      // Barrel recoil spring return
      t.barrel.position.z = lerp(t.barrel.position.z, -0.32, damp(18, dt));

      const st = this.player.weapon ? this.player.weapon.stats : { damage: 14 };
      let best = null, bestD = 18;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!e.alive || e.spawnT < 1) continue;
        const d = e.position.distanceTo(t.mesh.position);
        if (d < bestD) { bestD = d; best = e; }
      }

      if (!best) {
        // Idle scan sweep
        t.led.material.color.setHex(0x4dff9b);
        t.mesh.rotation.y = lerp(t.mesh.rotation.y, (t.baseYaw || 0) + Math.sin(this.time * 2.2) * 0.75, damp(4, dt));
        return true;
      }

      // Target acquired: alert red LED & smooth tracking
      t.led.material.color.setHex(0xff3333);
      const dx = best.position.x - t.mesh.position.x, dz = best.position.z - t.mesh.position.z;
      t.mesh.rotation.y = lerp(t.mesh.rotation.y, Math.atan2(dx, dz), damp(11, dt));

      if (t.cd <= 0) {
        t.cd = 0.45;
        t.barrel.position.z = -0.22; // recoil kickback
        t.flash.visible = true;
        t.flash.material.opacity = 1;
        t.flashT = 0.055;

        t.mesh.updateMatrixWorld(true);
        const muzzle = new THREE.Vector3(0, 0.36, -0.55).applyMatrix4(t.mesh.matrixWorld);
        const dir = new THREE.Vector3(dx, best.chestY - muzzle.y, dz).normalize();
        this.tracers.add(muzzle, new THREE.Vector3(best.position.x, best.chestY, best.position.z), 1, 0.8, 0.3, 0.06);
        this.particles.burst(3, muzzle.x, muzzle.y, muzzle.z, {
          spread: 0.3, up: 0.5, lifeMin: 0.08, lifeMax: 0.2,
          sizeMin: 0.02, sizeMax: 0.05, color: [0.8, 0.7, 0.6], grav: 1, drag: 2
        });
        best.takeDamage(st.damage * 0.8, dir, false, this);
        this.audio.enemyShoot();
      }
      return true;
    }

    removeTurret(t) {
      if (!t.mesh) return;
      this.particles.burst(16, t.mesh.position.x, t.mesh.position.y + 0.3, t.mesh.position.z, {
        spread: 1.4, up: 1.4, lifeMin: 0.2, lifeMax: 0.5,
        sizeMin: 0.03, sizeMax: 0.08, color: [0.35, 0.8, 1.0], grav: 3, drag: 2
      });
      this.audio.tone(this.audio.t, 0.25, 420, 100, 0.25, 'sawtooth');
      this.scene.remove(t.mesh);
      t.led.material.dispose();
      if (t.flash && t.flash.material) t.flash.material.dispose();
      t.mesh = null;
    }

    /* ---------------- scavenger extra drops ---------------- */

    scavengerDrop(enemy) {
      const r = Math.random();
      const stage = Math.max(1, this.waveManager.wave);
      const at = enemy.position.clone();
      at.y += 0.2;
      if (r < 0.55) {
        const ammoId = this.loot.rollAmmoType(stage);
        const amount = Math.round(this.player.ammoPool(ammoId) * 0.4) + 20;
        this.spawnAmmoPickup(ammoId, amount, at, true);
      } else if (r < 0.85) {
        this.spawnArmorPickup(this.loot.createArmor(stage, this.player.stats.lootLuck), at, true);
      } else {
        const inst = this.loot.create(stage, this.player.stats.lootLuck + 0.2);
        if (inst.atts.optic === 'none' && Math.random() < 0.6) { inst.atts.optic = 'reddot'; inst.refreshStats(); }
        this.spawnPickup(inst, at, true);
      }
    }

    /* ---------------- loot ---------------- */

    /** put a weapon instance into the world as a pickup */
    spawnPickup(inst, pos, drop) {
      const p = new Pickup({ kind: 'weapon', inst: inst }, pos, this, !!drop);
      this.pickups.push(p);
      return p;
    }

    spawnArmorPickup(inst, pos, drop) {
      const p = new Pickup({ kind: 'armor', inst: inst }, pos, this, !!drop);
      this.pickups.push(p);
      return p;
    }

    spawnAmmoPickup(ammoId, amount, pos, drop) {
      const p = new Pickup({ kind: 'ammo', ammoId: ammoId, amount: amount }, pos, this, !!drop);
      this.pickups.push(p);
      return p;
    }

    /**
     * Pickup the player is aiming at: closest within range that is roughly in
     * front of the camera, falling back to the nearest one in range.
     */
    nearestPickup(fromPos, maxDist, yaw) {
      const cam = this.camera;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const eye = cam.position;
      let best = null, bestScore = -Infinity, nearest = null, nearestD = Infinity;
      for (let i = 0; i < this.pickups.length; i++) {
        const p = this.pickups[i];
        if (p.taken) continue;
        const to = new THREE.Vector3(p.position.x - eye.x, p.position.y + 0.5 - eye.y, p.position.z - eye.z);
        const d = to.length();
        if (d > maxDist) continue;
        if (d < nearestD) { nearestD = d; nearest = p; }
        const dot = to.multiplyScalar(1 / (d || 1)).dot(fwd);
        if (dot > 0.55) {
          const score = dot * 2 - d * 0.1;
          if (score > bestScore) { bestScore = score; best = p; }
        }
      }
      return best || nearest;
    }

    onEnemyKilled(enemy) {
      const stage = Math.max(1, this.waveManager.wave);
      const player = this.player;

      // heavies occasionally drop a health boost
      if ((enemy.type.key === 'tank' || enemy.type.key === 'heavy') && player.health < player.maxHealth * 0.7) {
        player.heal(30);
      }

      /* weighted loot: weapon / armour / ammo, each with rarity + attachments */
      const cat = this.loot.rollDrop(enemy, stage, player.stats.lootLuck);
      const at = enemy.position.clone();
      at.y += 0.2;
      if (cat === 'weapon') {
        const forced = enemy.type.boss ? (Math.random() < 0.35 ? 'mythic' : 'legendary') : null;
        this.spawnPickup(this.loot.create(stage, player.stats.lootLuck, forced), at, true);
      } else if (cat === 'armor') {
        const forced = enemy.type.boss ? (Math.random() < 0.5 ? 'legendary' : 'epic') : null;
        this.spawnArmorPickup(this.loot.createArmor(stage, player.stats.lootLuck, forced), at, true);
      } else       if (cat === 'ammo') {
        const ammoId = this.loot.rollAmmoType(stage);
        const amount = Math.round(AMMO_TYPES[ammoId].start * 0.35);
        this.spawnAmmoPickup(ammoId, amount, at, true);
      }

      // build system: bloodlust / scavenger / samurai+executioner dogtags
      this.build.onKill(enemy);


      if (enemy.type.boss) {
        this.boss = null;
        this.ui.hideBossBar();
        this.ui.showBanner('BOSS DEFEATED', true, 2.6);
        this.audio.waveCleared();        this.addShake(0.8);
      }
      this.ui.updateEnemies(this.aliveEnemyCount() + this.waveManager.queue.length);
    }

    /* ---------------- stage flow ---------------- */

    /** every enemy of the stage is dead -> reward screen, then the next stage */
    onStageCleared(bossStage) {
      if (this.state === 'reward') return;
      this.audio.waveCleared();
      this.ui.showBanner(bossStage ? 'STAGE ' + this.waveManager.wave + ' CLEARED' : 'STAGE CLEARED', true, 2.0);
      // combat eases into a slow-motion beat before the cards come in
      this.slowmo = 0.55;
      this.pendingReward = { boss: !!bossStage };
      this.state = 'reward';
      this.input.releaseLock();
      this._offerReward(!!bossStage);
    }

    /** 3 random reward cards; player picks one (click or 1/2/3)
     *  the pool mixes stage buffs with trails and the active perk */
    _offerReward(boss) {
      const b = this.build;
      const options = [];
      const bag = [];

      // buffs (always available)
      const buffs = boss ? BOSS_BUFFS.concat(BUFFS.slice(0, 4)) : BUFFS.slice();
      for (const x of buffs) bag.push({ kind: 'buff', def: x, w: boss && BOSS_BUFF_BY_ID[x.id] ? 6 : 2 });

      // trails: always offered (a full build still shows swaps), never duplicated
      for (const t of TRAILS) {
        if (b.hasTrail(t.id)) continue;
        bag.push({ kind: 'trail', def: t, w: t.rarity === 'legendary' ? 1 : t.rarity === 'epic' ? 2.4 : 3.4 });
      }
      // perks: always in the pool so the player can swap their ability
      for (const p of PERKS) {
        if (b.perk && b.perk.id === p.id) continue;
        bag.push({ kind: 'perk', def: p, w: p.rarity === 'legendary' ? 2.2 : 3 });
      }

      for (let i = 0; i < 3 && bag.length; i++) {
        const pick = weightedPick(bag, (o) => o.w);
        bag.splice(bag.indexOf(pick), 1);
        options.push(pick);
      }
      this.ui.showReward(boss ? 'BOSS REWARD' : 'STAGE CLEARED', options, (opt) => {
        this._applyReward(opt);
      });
    }

    _applyReward(opt) {
      const kind = opt.kind || 'buff';
      const def = opt.def;
      this.ui.hideReward();
      if (kind === 'trail') {
        // fill a free slot, otherwise replace the oldest one
        const free = this.build.trails.indexOf(null);
        this.build.equipTrail(def.id, free >= 0 ? free : 0);
      } else if (kind === 'perk') {
        this.build.equipPerk(def.id);
      } else {
        this.player.addBuff(def.id, def);
        if (def.heal) this.player.heal(this.player.maxHealth * def.heal);
        if (def.refill !== undefined) {
          for (let i = 0; i < this.player.weapons.length; i++) {
            const w = this.player.weapons[i];
            if (w) w.inst.refill(def.refill);
          }
        }
        if (def.slot) {
          // fill the first empty slot with a stage-appropriate weapon
          const slot = this.player.freeSlot();
          if (slot >= 0) {
            const inst = this.loot.create(Math.max(1, this.waveManager.wave),
              this.player.stats.lootLuck, null, 1);
            this.player._equip(slot, inst);
            if (slot === this.player.current) this.player.weapon.group.visible = true;
          }
        }
      }
      this.audio.waveCleared();
      this.state = 'playing';
      this.input.requestLock();
      this.waveManager.startIntermission(false);
      this.ui.showIntermission(CFG.intermission);
    }

    /**
     * Boss entrance: the arena dims, the titan rises, the camera shakes, then
     * combat starts. Combat is frozen while this runs.
     */
    startBossIntro(boss) {
      this.bossIntro = { t: 0, dur: 3.4, boss: boss, phase: 0 };
      this.arena.setMood('boss');
      this.addShake(0.5);
      this.ui.showBanner('STAGE ' + this.waveManager.wave + '  TITAN INCOMING', false, 2.2);
      this.audio.waveStart(this.waveManager.wave);
    }

    _updateBossIntro(dt) {
      const b = this.bossIntro;
      if (!b) return;
      b.t += dt;
      const k = clamp(b.t / b.dur, 0, 1);

      /* phase 0: the titan climbs out of the floor */
      if (b.phase === 0) {
        const rise = clamp(b.t / 1.25, 0, 1);
        const e = 1 - Math.pow(1 - rise, 3);
        b.boss.mesh.scale.setScalar(b.boss.spawnT * (0.35 + e * 0.65) * (1 + Math.sin(rise * Math.PI) * 0.12));
        b.boss.position.y = b.boss.groundY !== undefined ? b.boss.groundY : b.boss.position.y;
        if (rise >= 1) {
          b.phase = 1;
          b.boss.spawnT = 1;
          this.addShake(0.7);
          this.audio.tone(this.audio.t, 0.4, 90, 40, 0.7, 'sawtooth');
          this.particles.burst(40, b.boss.position.x, b.boss.position.y + 0.4, b.boss.position.z, {
            spread: 3.4, up: 3.4, lifeMin: 0.3, lifeMax: 0.9,
            sizeMin: 0.05, sizeMax: 0.16, color: [1.0, 0.25, 0.7], grav: 3, drag: 1.6
          });
        }
      }
      /* phase 1: roar + camera push, health bar slams in */
      else if (b.phase === 1 && b.t > 1.9) {
        b.phase = 2;
        this.ui.showBossBar(b.boss);
        this.ui.showBanner('COMBAT START', false, 1.4);
      }

      if (k >= 1) {
        b.boss.spawnT = 1;
        this.bossIntro = null;
        this.arena.setMood('normal');
        b.boss.invulnT = 0;
      }
    }

    addEnemy(e) {
      this.enemies.push(e);
      this.scene.add(e.mesh);
      if (e.type.boss) this.boss = e;
    }

    /** random arena layout, never the same one twice in a row */
    pickLayoutIndex() {
      const n = LAYOUTS.length;
      let i = (Math.random() * n) | 0;
      if (n > 1 && i === this._lastLayout) i = (i + 1) % n;
      this._lastLayout = i;
      return i;
    }

    aliveEnemyCount() {
      let n = 0;
      for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i].alive) n++;
      return n;
    }

    addRecoil(pitch, yaw) { this.player.addRecoil(pitch, yaw); }

    addShake(amount) {
      this.shake = Math.min(1.1, this.shake + amount);
    }

    /* ---------------- main loop ---------------- */

    _loop(now) {
      requestAnimationFrame(this._loop);
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (dt > 0.1) dt = 0.1;          // guard against tab-switch spikes
      if (dt <= 0) dt = 1 / 60;

      if (this.state === 'playing' || this.state === 'dead') {
        this.time += dt;
        this._update(dt);
      } else if (this.state === 'reward') {
        // reward screen: 1 / 2 / 3 also pick a card
        this.arena.update(dt);
        if (this.input.hit('Digit1')) this.ui.chooseReward(0);
        if (this.input.hit('Digit2')) this.ui.chooseReward(1);
        if (this.input.hit('Digit3')) this.ui.chooseReward(2);
      } else {
        // keep the scene alive behind menus (slow orbit-less idle update)
        this.arena.update(dt);
        if (this.state === 'paused') {
          this.particles.update(0);
          this.tracers.update(0);
        }
      }
      this.input.endFrame();
      this.renderer.render(this.scene, this.camera);
    }

    _update(dt) {
      /* ---- global time scale: stage-clear slow motion + boss intro beat ---- */
      let scale = 1;
      if (this.slowmo > 0) { this.slowmo -= dt; scale = 0.35; }
      if (this.bossIntro) scale = Math.min(scale, 0.75);
      const gdt = dt * scale;

      // the boss entrance runs on unscaled time so it can never stall
      if (this.bossIntro) this._updateBossIntro(dt);

      // ---- player ----
      this.player.update(gdt, this.input);

      // ---- weapons view model ----
      for (let i = 0; i < this.player.weapons.length; i++) {
        const w = this.player.weapons[i];
        if (w) w.update(gdt, this);
      }

      // ---- enemies ----
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        // during the boss intro the titan's escorts hold their pose
        e.frozen = !!this.bossIntro;
        e.update(gdt, this);
        if (e.removeMe) {
          e.dispose(this);
          this.enemies.splice(i, 1);
        }
      }
      // ---- ground loot ----
      const aimTarget = this.player.pickupTarget || this.nearestPickup(this.player.position, CFG.pickupRange, this.player.yaw);
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const p = this.pickups[i];
        if (p.taken && !p.flying) { this.pickups.splice(i, 1); continue; }
        p.update(dt, p === aimTarget);
        if (p.taken && p.flying <= 0) this.pickups.splice(i, 1);
      }
      this.ui.updatePickupPrompt(aimTarget);

      // ---- build system (trails + perk) ----
      this.build.update(gdt);
      this.updateAfterimages(dt);
      if (this.perkVisuals) this.perkVisuals.update(gdt);

      // ---- waves ----
      this.waveManager.update(gdt);

      // ---- particles / tracers / projectiles ----
      this.particles.update(gdt);
      this.tracers.update(gdt);
      this.projectiles.update(gdt);
      this.arena.update(dt);

      // ---- camera shake ----
      if (this.shake > 0) {
        this.shake = Math.max(0, this.shake - dt * 2.6);
        const k = this.shake * this.shake;
        this.shakeOffset.set(rand(-1, 1) * 0.09 * k, rand(-1, 1) * 0.09 * k, rand(-1, 1) * 0.05 * k);
      } else {
        this.shakeOffset.set(0, 0, 0);
      }

      // ---- HUD ----
      this.ui.update(dt);

      // ---- death -> game over ----
      if (this.pendingGameOver > 0) {
        this.pendingGameOver -= dt;
        if (this.pendingGameOver <= 0) {
          this.state = 'gameover';
          this.input.releaseLock();
          const acc = this.stats.shots > 0 ? this.stats.hits / this.stats.shots : 0;
          this.ui.showGameOver(this.waveManager.wave, this.stats.kills, acc);        }
      }
    }
  }

  /* ------------------------------------------------------------- boot */

  // exposed for tooling / debugging
  window.StrikeProtocol = {
    Game: Game,
    WEAPON_TYPES: WEAPON_TYPES,
    ENEMY_TYPES: ENEMY_TYPES,
    RARITIES: RARITIES,
    WEAPON_MODS: WEAPON_MODS,
    BUFFS: BUFFS,
    BOSS_BUFFS: BOSS_BUFFS,
    WeaponInstance: WeaponInstance,
    ArmorInstance: ArmorInstance,
    TRAILS: TRAILS,
    TRAIL_BY_ID: TRAIL_BY_ID,
    PERKS: PERKS,
    PERK_BY_ID: PERK_BY_ID,
    SYNERGIES: SYNERGIES,
    BUILD_CAPS: BUILD_CAPS,
    LootSystem: LootSystem,
    AMMO_TYPES: AMMO_TYPES,
    OPTICS: OPTICS,
    MAGAZINES: MAGAZINES,
    ATTACHMENTS: ATTACHMENTS,
    ARMOR_KINDS: ARMOR_KINDS,
    resolveStats: resolveStats,
    combineMods: combineMods,
    DirectionalDamageSystem: DirectionalDamageSystem,
    PerkVisualSystem: PerkVisualSystem,
    getSamuraiRecoveryRate: getSamuraiRecoveryRate,
    SAMURAI_RECOVERY_DURATIONS: SAMURAI_RECOVERY_DURATIONS
  };

  window.addEventListener('DOMContentLoaded', () => {
    // the DOM is ready because the script is at the end of <body>, but be safe
    try {
      window.__game = new Game();
    } catch (err) {
      console.error(err);
      const s = document.getElementById('loading-status');
      if (s) s.textContent = 'Error: ' + err.message;
    }
  });
})();
