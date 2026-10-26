import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Project } from '@shortstudio/schema';

export type Look = Project['look'];

/**
 * Per-shot post chain: scene -> depth of field (focus follows the actors) -> bloom. The result is a linear
 * texture; the Studio converts to display colour once, at the end, after any dissolve.
 */
export class PostChain {
  private composer: EffectComposer;
  private bokeh?: BokehPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number, look: Look) {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.composer.renderToScreen = false;
    this.composer.addPass(new RenderPass(scene, camera));
    if (look.dof) {
      this.bokeh = new BokehPass(scene, camera, { focus: 10, aperture: look.dof.aperture, maxblur: look.dof.maxBlur });
      this.composer.addPass(this.bokeh);
    }
    if (look.bloom) {
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), look.bloom.strength, look.bloom.radius, look.bloom.threshold));
    }
  }

  /** Render and return the finished linear texture. `focus` is the distance to keep sharp. */
  render(focus: number): THREE.Texture {
    if (this.bokeh) (this.bokeh.uniforms as Record<string, { value: number }>).focus!.value = focus;
    this.composer.render(0);
    return this.composer.readBuffer.texture;
  }

  dispose(): void {
    this.composer.dispose();
  }
}
