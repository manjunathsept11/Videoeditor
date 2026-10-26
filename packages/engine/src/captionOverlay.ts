import * as THREE from 'three';
import type { ActiveCaption } from './captions';

const FONT = '"IPAGothic", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", Arial, sans-serif';

/**
 * Caption strip for the lower 30% of the frame: bold white text, thick black stroke, centred.
 * Textures are cached per (line, active word) so a frame never re-rasterizes text it has drawn before.
 */
export class CaptionOverlay {
  private cache = new Map<string, THREE.CanvasTexture>();
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private stripHeight: number;

  constructor(private width: number, private height: number, private highlight?: string) {
    this.stripHeight = Math.round(height * 0.3);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: { uTex: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv; void main(){ gl_FragColor = texture2D(uTex, vUv);\n#include <colorspace_fragment>\n}',
    });
    // lower 30% of the screen: NDC y from -1 to -0.4
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.6).translate(0, -0.7, 0), this.material);
    this.scene.add(quad);
  }

  /** Texture for the active caption, or null when nothing is on screen. */
  textureFor(active: ActiveCaption | null): THREE.CanvasTexture | null {
    if (!active) return null;
    const word = this.highlight ? active.word : -1;
    const key = `${active.line.text}|${word}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = this.draw(active.line.words.map((w) => w.text), word);
      this.cache.set(key, tex);
    }
    return tex;
  }

  render(renderer: THREE.WebGLRenderer, active: ActiveCaption | null): void {
    const tex = this.textureFor(active);
    if (!tex) return;
    this.material.uniforms.uTex!.value = tex;
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prev;
  }

  private draw(words: string[], activeWord: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.stripHeight;
    const g = c.getContext('2d')!;
    const text = words.join(' ');

    let size = this.height * 0.046;
    const font = (s: number) => `800 ${s}px ${FONT}`;
    g.font = font(size);
    while (g.measureText(text).width > this.width * 0.9 && size > 12) {
      size -= 2;
      g.font = font(size);
    }
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.lineJoin = 'round';
    g.lineWidth = size * 0.2;
    g.strokeStyle = '#000000';
    const y = this.stripHeight * 0.42;
    const total = g.measureText(text).width;
    let x = (this.width - total) / 2;
    g.strokeText(text, x, y);
    words.forEach((w, i) => {
      g.fillStyle = i === activeWord && this.highlight ? this.highlight : '#ffffff';
      g.fillText(w, x, y);
      x += g.measureText(w + ' ').width;
    });

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
