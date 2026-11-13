/**
 * PerfKit
 * Small helpers that cut rendering cost without changing how a scene looks.
 *
 * ParticleField replaces dozens of individual THREE.Sprite objects (one draw
 * call each) with a single THREE.Points cloud. Size and opacity still vary per
 * particle, so the visual result matches the sprites it replaces - it just
 * arrives in one draw call instead of N.
 *
 * attachAdaptiveResolution keeps the full pixel ratio on machines that can
 * afford it, and steps down only when frames are consistently slow.
 */

import * as THREE from 'three';

const PARTICLE_VERTEX = `
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    gl_PointSize = aSize * uScale / max( 0.001, -mvPosition.z );
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAGMENT = `
  uniform sampler2D uMap;
  varying float vAlpha;

  void main() {
    vec4 texel = texture2D( uMap, gl_PointCoord );
    float alpha = texel.a * vAlpha;
    if ( alpha < 0.004 ) discard;
    gl_FragColor = vec4( texel.rgb, alpha );
  }
`;

const _scratchSize = new THREE.Vector2();

/**
 * Pixels covered by one world unit at one unit of depth, for the given camera.
 * This is what makes gl_PointSize track the sprite scale it replaces.
 */
function pixelsPerUnitAtUnitDepth(camera, renderer) {
  renderer.getDrawingBufferSize(_scratchSize);
  const fov = (camera.fov * Math.PI) / 180;
  return _scratchSize.y / (2 * Math.tan(fov / 2));
}

export class ParticleField {
  /**
   * @param {THREE.Texture} texture   sprite texture (usually a soft radial dot)
   * @param {number} count            particle count
   * @param {object} [options]
   * @param {number} [options.size]   world-space size applied to every particle
   * @param {number} [options.blending]
   * @param {number} [options.renderOrder]
   */
  constructor(texture, count, options = {}) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.alphas = new Float32Array(count);
    this.sizes.fill(options.size != null ? options.size : 0.3);
    this.alphas.fill(1);

    this.geometry = new THREE.BufferGeometry();
    this._positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this._sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    this._alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this._positionAttr);
    this.geometry.setAttribute('aSize', this._sizeAttr);
    this.geometry.setAttribute('aAlpha', this._alphaAttr);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uScale: { value: 400 }
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: options.blending != null ? options.blending : THREE.AdditiveBlending
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    // Particle positions move every frame, so the cached bounds would be wrong.
    this.mesh.frustumCulled = false;
    if (options.renderOrder != null) this.mesh.renderOrder = options.renderOrder;
  }

  setPosition(index, x, y, z) {
    const o = index * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
  }

  setSize(index, size) {
    this.sizes[index] = size;
  }

  setAlpha(index, alpha) {
    this.alphas[index] = alpha;
  }

  /** Push the CPU-side arrays to the GPU and refresh the projection scale. */
  commit(camera, renderer) {
    if (camera && renderer) {
      this.material.uniforms.uScale.value = pixelsPerUnitAtUnitDepth(camera, renderer);
    }
    this._positionAttr.needsUpdate = true;
    this._sizeAttr.needsUpdate = true;
    this._alphaAttr.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Watch frame timing and lower the renderer's pixel ratio when the machine
 * cannot hold a smooth frame. Never raises it again, so it cannot oscillate.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} [options]
 * @param {number} [options.max] highest pixel ratio to use
 * @param {number} [options.slowFrameMs] frame time counted as "struggling"
 * @param {number} [options.patience] consecutive slow frames before stepping down
 * @returns {{sample: Function, ratio: Function, dispose: Function}}
 */
export function attachAdaptiveResolution(renderer, options = {}) {
  const max = options.max != null ? options.max : Math.min(window.devicePixelRatio || 1, 2);
  const slowFrameMs = options.slowFrameMs != null ? options.slowFrameMs : 24;
  const patience = options.patience != null ? options.patience : 50;

  // 1.5x and 1.25x are visually close to 2x but cost 44% and 39% of the
  // fragments respectively.
  const steps = [max];
  if (max > 1.6) steps.push(1.5);
  if (max > 1.2) steps.push(Math.max(1, Math.min(1.25, max)));

  let level = 0;
  let slowFrames = 0;
  let last = performance.now();
  let settled = false;

  renderer.setPixelRatio(steps[0]);

  function apply() {
    renderer.setPixelRatio(steps[level]);
    renderer.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight, false);
    settled = true;
  }

  function sample() {
    const now = performance.now();
    const delta = now - last;
    last = now;
    // Ignore background tabs, stalls, and the very first frames after a resize.
    if (delta <= 0 || delta > 250) return;
    if (delta > slowFrameMs) {
      slowFrames += 1;
      if (slowFrames >= patience && level < steps.length - 1) {
        level += 1;
        slowFrames = 0;
        apply();
      }
    } else {
      slowFrames = Math.max(0, slowFrames - 2);
    }
  }

  return {
    sample,
    ratio: () => steps[level],
    stepped: () => settled
  };
}
