// OWNER: UI/UX agent. STUB — replace with the full application shell.
import { Simulation } from '../sim/simulation';
import { SCENARIOS } from '../sim/presets';
import { Renderer, type ViewOptions } from '../render/renderer';

export class App {
  sim: Simulation;
  renderer: Renderer;
  view: ViewOptions = { overlay: 'none', selectedId: -1, hoverId: -1, showVision: true, showTrails: true, showRelations: true, showCamps: true, showLabels: true, brush: null };

  constructor(root: HTMLElement) {
    root.innerHTML = '<canvas id="world" style="width:100vw;height:100vh;display:block"></canvas>';
    const canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas);
    this.sim = Simulation.create({ scenario: SCENARIOS[0] });
    this.renderer.resize();
    this.renderer.camera.fit(this.sim.worldW, this.sim.worldH);
    const loop = (t: number) => {
      this.sim.step();
      this.renderer.render(this.sim, this.view, t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
