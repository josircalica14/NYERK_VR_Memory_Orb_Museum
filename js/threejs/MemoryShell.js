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
    // A slow, per-orb hover so a wall of them is alive rather than a pattern. The
    // phase attribute is already there, so this costs the vertex shader nothing.
    vec3 c = aCenter;
    c.y += sin(uTime * 0.55 + aParams.y * 31.4) * 0.16;
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
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
      // A wider, softer halo: the old falloff died within a tenth of the rim, which
      // left every orb looking cut out of the dark instead of glowing in it.
      col = vColor * exp(-(cr - 1.0) * 2.6) * 0.26 * (1.0 - smoothstep(1.15, 1.8, cr));
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
                orbBright = 0.88, shelfGlow = 0.74, endRadius = halfWidth, flare = 20,
                cornerRadius = 32 } = {}) {
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
    // The end wall behind the spawn closes the loop: without it the two straight
    // walls stop at zOpen and the hall opens onto the sky at the player's back.
    // Each end of it is turned by a quarter-circle fillet, so the hall does not
    // close on two hard 90 degree mitres.
    this.cornerR = Math.min(cornerRadius, this.W * 0.5);
    this.cornerLen = Math.PI * 0.5 * this.cornerR;
    this.wallLen = this.straightLen - this.cornerR;
    this.backLen = 2 * (this.W - this.cornerR);
    this.L = 2 * this.wallLen + 2 * this.cornerLen + 2 * this.filletLen + this.arcLen + this.backLen;
    Object.assign(this, { zOpen, rows, rowH, yBase, spacing, palette, shelfGlow });
    this.H = yBase + (rows + 1) * rowH;
    this.uniforms.uH.value = this.H;
    this.rand = rng(seed);

    this.group.add(this._ground(), this._baseGlow(), this._shelves(shelfColor));
    this.group.add(this._orbLayer({ offset: 1.6, spacing, yShift: 0, size: [1.6, 2.3], bright: orbBright, empty: 0.2 }));
    if (backLayer) this.group.add(this._orbLayer({ offset: -26, spacing: spacing * 1.5, yShift: rowH * 0.5, size: [3.4, 4.6], bright: orbBright * 0.25, empty: 0.15 }));
    this.group.add(this._sky(), this._backboard(), this._stars(), this._dust());
  }

  // Point + inward normal at arc-length s: left wall -> left fillet -> round room
  // -> right fillet -> right wall -> end wall, so the loop closes.
  _sample(s) {
    const { W, R, f, zOpen, zc, fx, fz, aEnd, thetaL, filletLen, arcLen } = this;
    const { cornerR, cornerLen, wallLen, backLen } = this;
    s = ((s % this.L) + this.L) % this.L;
    // Left wall, from just behind the end wall's corner down to the neck flare.
    if (s < wallLen) return { x: -W, z: zOpen - cornerR - s, nx: 1, nz: 0 };
    s -= wallLen;
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
    // Right wall, back up to the end wall's corner.
    if (s < wallLen) return { x: W, z: fz + s, nx: -1, nz: 0 };
    s -= wallLen;
    // Quarter turn into the end wall, from the right wall round to (W - R, zOpen).
    if (s < cornerLen) {
      const th = Math.PI * 0.5 * (s / cornerLen);
      const cx0 = W - cornerR, cz0 = zOpen - cornerR;
      return { x: cx0 + cornerR * Math.cos(th), z: cz0 + cornerR * Math.sin(th),
        nx: -Math.cos(th), nz: -Math.sin(th) };
    }
    s -= cornerLen;
    // End wall, running between the two corner fillets. Its normal faces back into
    // the hall, so orbs on it are lit like any other wall.
    if (s < backLen) return { x: (W - cornerR) - s, z: zOpen, nx: 0, nz: -1 };
    s -= backLen;
    // Closing quarter turn, from the end wall back round onto the left wall:
    // th runs pi/2 -> pi so the arc meets both walls travelling the same way.
    const th = Math.PI * 0.5 * (1 + s / cornerLen);
    const cx0 = -W + cornerR, cz0 = zOpen - cornerR;
    return { x: cx0 + cornerR * Math.cos(th), z: cz0 + cornerR * Math.sin(th),
      nx: -Math.cos(th), nz: -Math.sin(th) };
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

  // Floor that reaches the walls. The walkway in the middle is the museum's own (16
  // units wide, stopping short of the closed end), so without this the shelving hangs
  // over nothing and the end wall has no ground under it.
  //
  // One fan from every wall sample to the ring centre: the hall is star-shaped about
  // that point (the corridor and the round room both see it unobstructed), so the fan
  // tiles the interior with no overlap at the corners. An inward-offset strip folds on
  // itself wherever the offset is wider than the corner radius, which is what left
  // black wedges on the floor at the end wall.
  _ground(y = 0.02) {
    const step = 3, segs = Math.ceil(this.L / step), pos = [], col = [], uv = [], idx = [];
    const tile = 1 / 64; // world units -> texture repeats
    // Three rings, not two: the light near the shelves dies within ~25 units of the
    // wall, and a single gradient out to the middle of the hall would be nearly black
    // by the time it reached the walkway.
    const atWall = new THREE.Color(0x6b3cb2), shoulder = new THREE.Color(0x3c2066), centre = new THREE.Color(0x331a58);
    const push = (x, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); uv.push(x * tile, z * tile); return pos.length / 3 - 1; };
    const mid = push(0, this.zc, centre);
    const skip = 25; // inward from the wall, short of the 32-unit corner radius
    const inner = [], outer = [];
    for (let i = 0; i < segs; i++) {
      const p = this._sample(Math.min(i * step, this.L - 0.001));
      outer.push(push(p.x + p.nx * 0.35, p.z + p.nz * 0.35, atWall));
      inner.push(push(p.x + p.nx * skip, p.z + p.nz * skip, shoulder));
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      idx.push(mid, inner[i], inner[j]);
      idx.push(inner[i], outer[i], inner[j], outer[i], outer[j], inner[j]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    // Unlit, with a tiled mottle: the floor is the largest flat surface in frame and
    // a single vertex gradient across it reads as empty colour. One 128px texture
    // sampled per pixel, no lights, no extra draw call.
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, map: this._groundTexture(),
      side: THREE.DoubleSide, fog: false }));
    m.frustumCulled = false; return m;
  }

  // A near-white mottle: the mesh's vertex colours carry the floor's colour, and a map
  // multiply on top of them means a dark texture would darken it twice (which is how
  // the floor first came out black). This only varies brightness.
  _groundTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), r = rng(11);
    g.fillStyle = '#e9e2f4'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 46; i++) {
      const x = r() * 128, y = r() * 128, rad = 14 + r() * 46;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const tint = r() < 0.5 ? '255, 255, 255' : '126, 96, 178';
      grd.addColorStop(0, `rgba(${tint}, ${0.10 + r() * 0.16})`);
      grd.addColorStop(1, `rgba(${tint}, 0)`);
      g.fillStyle = grd; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // The shelf glow landing on the floor at the foot of each wall: a narrow additive
  // strip, so the rows read as standing on the ground rather than floating in front
  // of the sky.
  _baseGlow(width = 6.5, y = 0.05) {
    const step = 3, segs = Math.ceil(this.L / step), pos = [], col = [], idx = [];
    const hot = new THREE.Color(0x6a4ab6), cold = new THREE.Color(0x120a28);
    for (let i = 0; i <= segs; i++) {
      const p = this._sample(Math.min(i * step, this.L - 0.001));
      pos.push(p.x + p.nx * 0.2, y, p.z + p.nz * 0.2, p.x + p.nx * width, y, p.z + p.nz * width);
      col.push(hot.r, hot.g, hot.b, cold.r, cold.g, cold.b);
      if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    m.frustumCulled = false; return m;
  }

  _shelves(hex) {
    const step = 2, segs = Math.ceil(this.L / step), depth = 2.4, lipH = 0.62, pos = [], col = [], idx = [];
    const front = new THREE.Color(hex).multiplyScalar(this.shelfGlow), back = front.clone().multiplyScalar(0.12);
    // The lip is the board's thickness: a flat quad seen from the corridor is a line,
    // and a line has no depth. Three vertices per sample - wall edge, front edge, and
    // the front edge dropped by the board's thickness - cost two triangles more per
    // segment than the old single quad.
    const lip = front.clone().multiplyScalar(0.34);
    for (let row = 0; row < this.rows; row++) {
      const y = this.yBase + row * this.rowH, base = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const p = this._sample(Math.min(i * step, this.L - 0.001));
        const fx = p.x + p.nx * depth, fz = p.z + p.nz * depth;
        pos.push(p.x, y, p.z, fx, y, fz, fx, y - lipH, fz);
        col.push(back.r, back.g, back.b, front.r, front.g, front.b, lip.r, lip.g, lip.b);
        if (i < segs) {
          const a = base + i * 3; // this sample, next sample is a + 3
          idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);            // shelf top
          idx.push(a + 1, a + 2, a + 4, a + 2, a + 5, a + 4);        // front lip
        }
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
    const p = new Float32Array(count * 3), sd = new Float32Array(count * 2), r = this.rand;
    for (let i = 0; i < count; i++) {
      const u = r() * Math.PI * 2, v = Math.acos(r() * 0.9 + 0.1), d = 650;
      p.set([d * Math.sin(v) * Math.cos(u), d * Math.cos(v), this.zc + d * Math.sin(v) * Math.sin(u)], i * 3);
      sd[i * 2] = r();                 // phase
      sd[i * 2 + 1] = 0.6 + r() * 1.3; // size and brightness
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aStar', new THREE.BufferAttribute(sd, 2));
    // A slow twinkle: the sky was static, and a static field of points behind a
    // moving camera reads as dust on the lens. Same points, same draw call.
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, fog: false,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec2 aStar; uniform float uTime; varying float vA;
        void main(){
          vA = (0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (0.5 + aStar.x * 0.9) + aStar.x * 40.0), 2.0)) * aStar.y;
          gl_PointSize = aStar.y * 2.2;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vA; void main(){
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(vec3(0.74, 0.78, 1.0) * (1.0 - d * d) * vA * 0.9, 1.0); }` });
    const pts = new THREE.Points(g, m);
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
          // The shelf walls end around 45 degrees up; above them the dome was pure
          // black, which read as a hole rather than a ceiling. A wide violet band
          // just over the wall tops makes the hall feel lit from inside.
          c += vec3(0.13, 0.05, 0.30) * exp(-abs(vD.y - 0.46) * 3.2) * 0.5;
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
