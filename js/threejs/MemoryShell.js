import * as THREE from 'three';

/**
 * MemoryShell: a hall-shaped (two straight walls, a flared neck, a round end)
 * shell of shelves and glowing memory orbs. Replaces createStarfield().
 *
 * Cost: 2 orb draw calls (instanced billboards, one fragment shader),
 * 1 shelf draw call, 1 star draw call. Zero lights, zero textures.
 *
 *   const shell = new MemoryShell({ halfWidth: 90, zOpen: 100, zEnd: -230 });
 *   scene.add(shell.group);
 *   // in your render loop:  shell.update(clock.getElapsedTime());
 */
const PALETTE = [0xffe14d, 0xffc21a, 0x7fc4ff, 0x3f7bff, 0xff7b7b, 0xff3b3b, 0xc79bff, 0x8a3fff,
  0x9dffb8, 0x3fe07a, 0xffa6e0, 0xff4fb8, 0x4ff0ff, 0xc6ff4f, 0xffa24f].map(c => {
  const k = new THREE.Color(c); // shader writes raw values, so undo colour-management's sRGB->linear
  if (THREE.ColorManagement && THREE.ColorManagement.enabled) k.convertLinearToSRGB();
  return k.multiplyScalar(0.94); // a touch under full so the hall's own orbs stay the focus
});

const ORB_VERT = /* glsl */`
  attribute vec3 aCenter; attribute vec3 aColor; attribute vec4 aParams; // size, phase, bright, pathS
  attribute vec2 aNormal; // inward wall normal under this orb
  uniform float uTime, uH;
  uniform vec3 uGrazing; // fade start, fade end, floor
  varying vec2 vUv; varying vec3 vColor; varying float vBright; varying float vPhase; varying float vDist;
  void main(){
    vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
    vDist = -mv.z;
    mv.xy += position.xy * aParams.x * 1.8;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy; vColor = aColor; vPhase = aParams.y;
    // upper shelves recede into the dark instead of cluttering the whole frame
    float tall = mix(1.0, 0.34, smoothstep(uH * 0.62, uH * 1.0, aCenter.y));
    float deep = mix(1.0, 0.38, smoothstep(190.0, 580.0, vDist));
    // Where the wall turns away (the flare into the round room) a whole stretch of
    // shelf lands on a few pixels and the additive billboards burn to white. Fade
    // an orb by how glancing its patch of wall is seen, so that band reads at the
    // brightness of the wall beside it. A wall seen head on is untouched.
    vec2 eyeDir = normalize(cameraPosition.xz - aCenter.xz);
    float facing = abs(dot(eyeDir, aNormal));
    float edge = mix(uGrazing.z, 1.0, smoothstep(uGrazing.x, uGrazing.y, facing));
    vBright = aParams.z * tall * deep * edge * (0.82 + 0.18 * sin(aParams.w * 0.045 - uTime * 0.9 + aParams.y * 6.0));
  }`;

const ORB_FRAG = /* glsl */`
  uniform float uTime;
  varying vec2 vUv; varying vec3 vColor; varying float vBright; varying float vPhase; varying float vDist;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main(){
    float cr = length(vUv) / 0.5556;
    if (cr > 1.8) discard;
    vec3 col;
    float pulse = pow(max(0.0, sin(uTime * 0.35 + vPhase * 60.0)), 48.0);   // occasional memory flash
    if (cr < 1.0) {
      vec3 n = vec3(vUv / 0.5556, sqrt(1.0 - cr * cr));
      vec3 L = normalize(vec3(-0.4, 0.6, 0.7));
      float diff = max(dot(n, L), 0.0);
      float fres = pow(1.0 - n.z, 2.2);
      float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
      float ang = atan(n.y, n.x);
      float sw  = 0.5 + 0.5 * sin(ang * 3.0 + cr * 7.0 - uTime * 0.6 + vPhase * 6.0);
      float sw2 = 0.5 + 0.5 * sin(ang * 5.0 - cr * 11.0 + uTime * 0.45 + vPhase * 9.0);
      vec3 hot = mix(vColor, vec3(1.0, 0.95, 0.8), 0.45);
      vec3 inner = mix(vColor * vColor, vColor, 0.35 + 0.5 * diff);
      inner += hot * (0.22 * sw + 0.14 * sw2) * (1.0 - cr * 0.6);
      vec2 sp = floor((n.xy + uTime * 0.05) * 9.0);
      inner += hot * step(0.93, h(sp + vPhase * 10.0)) * (0.5 + 0.5 * sin(uTime * 3.0 + h(sp) * 6.28)) * 0.5;
      col = inner + vColor * fres * 0.75 + hot * pow(fres, 3.0) * 0.45 + vec3(spec * 0.7)
          + vec3(smoothstep(0.93, 1.0, cr) * 0.18);
    } else {
      col = vColor * exp(-(cr - 1.0) * 4.5) * 0.2 * (1.0 - smoothstep(1.1, 1.6, cr));
    }
    col += vColor * exp(-cr * 1.6) * 0.08;
    col *= 1.0 + pulse * 0.5;
    gl_FragColor = vec4(col * vBright, 1.0);
  }`;

function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export class MemoryShell {
  constructor({ halfWidth = 90, zOpen = 100, zEnd = -230, rows = 11, rowH = 7.5, yBase = 2,
                spacing = 6.0, seed = 7, palette = PALETTE, shelfColor = 0xf79c00, backLayer = false,
                orbBright = 0.88, shelfGlow = 0.74, endRadius = halfWidth, flare = 20 } = {}) {
    this.group = new THREE.Group();
    this.uniforms = { uTime: { value: 0 }, uH: { value: 1 }, uGrazing: { value: new THREE.Vector3(0.12, 0.6, 0.16) } };
    this.zc = zEnd + halfWidth;
    // The end of the hall can open out wider than the straight walls: wall -> fillet
    // -> round room centred on zc. At endRadius === halfWidth the fillet has no
    // length and this reduces to the plain stadium the shell used to be.
    this.W = halfWidth;
    this.R = Math.max(endRadius, halfWidth);
    this.f = Math.max(flare, 0.1);
    this.fx = this.W + this.f;
    this.fz = this.zc + Math.sqrt(Math.max((this.R + this.f) ** 2 - this.fx ** 2, 0));
    this.Tx = -this.R * this.fx / (this.R + this.f);
    this.Tz = this.zc + this.R * (this.fz - this.zc) / (this.R + this.f);
    this.thetaL = Math.atan2(this.Tz - this.zc, this.Tx); // where the left fillet meets the round room
    this.aEnd = Math.atan2(this.zc - this.fz, this.fx);   // how far each fillet sweeps
    this.straightLen = zOpen - this.fz;
    this.filletLen = this.f * -this.aEnd;
    this.arcLen = this.R * (3 * Math.PI - 2 * this.thetaL);
    this.L = 2 * this.straightLen + 2 * this.filletLen + this.arcLen;
    Object.assign(this, { zOpen, rows, rowH, yBase, spacing, palette, shelfGlow });
    this.H = yBase + (rows + 1) * rowH;
    this.uniforms.uH.value = this.H;
    this.rand = rng(seed);

    this.group.add(this._shelves(shelfColor));
    this.group.add(this._orbLayer({ offset: 1.6, spacing, yShift: 0, size: [1.6, 2.3], bright: orbBright, empty: 0.2 }));
    if (backLayer) this.group.add(this._orbLayer({ offset: -26, spacing: spacing * 1.5, yShift: rowH * 0.5, size: [3.4, 4.6], bright: orbBright * 0.25, empty: 0.15 }));
    this.group.add(this._sky(), this._backboard(), this._stars(), this._dust());
  }

  // Point + inward normal at arc-length s: left wall -> left fillet -> round room
  // -> right fillet -> right wall.
  _sample(s) {
    const { W, R, f, zOpen, zc, fx, fz, aEnd, thetaL, straightLen, filletLen, arcLen } = this;
    s = ((s % this.L) + this.L) % this.L;
    if (s < straightLen) return { x: -W, z: zOpen - s, nx: 1, nz: 0 };
    s -= straightLen;
    if (s < filletLen) {
      const a = aEnd * (s / filletLen);
      return { x: -fx + f * Math.cos(a), z: fz + f * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) };
    }
    s -= filletLen;
    if (s < arcLen) {
      const th = thetaL + s / R;
      return { x: R * Math.cos(th), z: zc + R * Math.sin(th), nx: -Math.cos(th), nz: -Math.sin(th) };
    }
    s -= arcLen;
    if (s < filletLen) {
      const a = aEnd * ((filletLen - s) / filletLen);
      return { x: fx - f * Math.cos(a), z: fz + f * Math.sin(a), nx: -Math.cos(a), nz: Math.sin(a) };
    }
    s -= filletLen;
    return { x: W, z: fz + s, nx: -1, nz: 0 };
  }

  _orbLayer({ offset, spacing, yShift, size, bright, empty }) {
    // Irregular walk instead of a fixed grid: each row starts at its own offset and
    // steps by a random amount, so gaps and clusters fall where they fall rather
    // than lining up into a lattice.
    const max = Math.ceil(this.L / (spacing * 0.6) + 2) * this.rows;
    const center = new Float32Array(max * 3), color = new Float32Array(max * 3), params = new Float32Array(max * 4), normals = new Float32Array(max * 2);
    let n = 0; const r = this.rand;
    for (let row = 0; row < this.rows; row++) {
      let s = r() * spacing;
      while (s < this.L && n < max) {
        if (r() >= empty) {
          const rad = size[0] + r() * (size[1] - size[0]);
          // Nudge along the wall and off the shelf line, never enough to leave it
          const at = (s + (r() - 0.5) * spacing * 0.34 + this.L) % this.L;
          const yJit = (r() - 0.5) * 0.55;
          const p = this._sample(at);
          center.set([p.x + p.nx * (offset + (r() - 0.5) * 0.4),
            this.yBase + row * this.rowH + yShift + rad + 0.3 + yJit,
            p.z + p.nz * offset], n * 3);
          const col = this.palette[(r() * this.palette.length) | 0]; color.set([col.r, col.g, col.b], n * 3);
          params.set([rad, r(), bright * (0.8 + r() * 0.4), at], n * 4);
          normals.set([p.nx, p.nz], n * 2); n++;
        }
        s += spacing * (0.72 + r() * 0.85);
      }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.copy(new THREE.PlaneGeometry(2, 2));
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center.slice(0, n * 3), 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color.slice(0, n * 3), 3));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(params.slice(0, n * 4), 4));
    g.setAttribute('aNormal', new THREE.InstancedBufferAttribute(normals.slice(0, n * 2), 2));
    g.instanceCount = n;
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; return mesh;
  }

  _shelves(hex) {
    const step = 2, segs = Math.ceil(this.L / step), depth = 2.4, pos = [], col = [], idx = [];
    const front = new THREE.Color(hex).multiplyScalar(this.shelfGlow), back = front.clone().multiplyScalar(0.12);
    for (let row = 0; row < this.rows; row++) {
      const y = this.yBase + row * this.rowH, base = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const p = this._sample(Math.min(i * step, this.L - 0.001));
        pos.push(p.x, y, p.z, p.x + p.nx * depth, y, p.z + p.nz * depth);
        col.push(back.r, back.g, back.b, front.r, front.g, front.b);
        if (i < segs) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.frustumCulled = false; return mesh;
  }

  _stars(count = 700) {
    const p = new Float32Array(count * 3), r = this.rand;
    for (let i = 0; i < count; i++) {
      const u = r() * Math.PI * 2, v = Math.acos(r() * 0.9 + 0.1), d = 650;
      p.set([d * Math.sin(v) * Math.cos(u), d * Math.cos(v), this.zc + d * Math.sin(v) * Math.sin(u)], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbcc8ff, size: 1.6, sizeAttenuation: false,
      transparent: true, opacity: 0.7, depthWrite: false, fog: false }));
    pts.frustumCulled = false; return pts;
  }

  _backboard() { // faint glowing wall panel behind each shelf row
    const step = 3, segs = Math.ceil(this.L / step), pos = [], col = [], idx = [];
    const lo = new THREE.Color(0x1c0d38).multiplyScalar(0.7), hi = new THREE.Color(0x03010a);
    for (let row = 0; row < this.rows; row++) {
      const y0 = this.yBase + row * this.rowH, y1 = y0 + this.rowH, base = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const p = this._sample(Math.min(i * step, this.L - 0.001));
        pos.push(p.x, y0, p.z, p.x, y1, p.z);
        col.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b);
        if (i < segs) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.frustumCulled = false; return m;
  }

  _dust(count = 220) { // drifting motes
    const p = new Float32Array(count * 3), sd = new Float32Array(count), r = this.rand;
    for (let i = 0; i < count; i++) {
      p.set([(r() * 2 - 1) * this.W, r() * this.H, this.zc - this.W + r() * (this.zOpen - this.zc + this.W)], i * 3);
      sd[i] = r();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    const m = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, uH: { value: this.H } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSeed; uniform float uTime, uH; varying float vA;
        void main(){ vec3 p = position;
          p.y = mod(p.y + uTime * (0.6 + aSeed * 1.4), uH);
          p.x += sin(uTime * 0.2 + aSeed * 40.0) * 3.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (0.8 + aSeed * 1.2) * 200.0 / -mv.z;
          vA = 0.15 + 0.3 * aSeed; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard; gl_FragColor = vec4(vec3(1.0, 0.82, 0.6) * (1.0 - d * d) * vA, 1.0); }` });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; return pts;
  }

  _sky() { // soft violet nebula dome
    const m = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; varying vec3 vD; void main(){
          float up = clamp(vD.y, 0.0, 1.0);
          vec3 c = mix(vec3(0.07, 0.03, 0.16), vec3(0.0, 0.01, 0.05), pow(up, 0.5));
          float n = sin(vD.x * 4.0 + sin(vD.z * 5.0 + uTime * 0.02) * 2.0) * sin(vD.z * 3.0 + vD.y * 6.0);
          c += vec3(0.10, 0.04, 0.22) * smoothstep(0.1, 0.9, n) * (1.0 - up) * 0.8;
          c += vec3(0.02, 0.05, 0.14) * smoothstep(0.3, 1.0, -n) * 0.6;
          gl_FragColor = vec4(c, 1.0); }` });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), m);
    mesh.position.z = this.zc; mesh.renderOrder = -10; mesh.frustumCulled = false; return mesh;
  }

  update(t) { this.uniforms.uTime.value = t; }

  dispose() {
    this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.group.removeFromParent();
  }
}
