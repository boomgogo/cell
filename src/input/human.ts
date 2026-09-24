import type { Camera } from '../render/camera.ts';
import type { Controller } from '../sim/controller.ts';
import type { Organism } from '../sim/organism.ts';
import type { World } from '../sim/world.ts';
import type { Input } from './input.ts';

/** Turns pointer + keys into the organism's intent, through the same interface NPCs use. */
export class HumanController implements Controller {
  private readonly input: Input;
  private readonly camera: Camera;

  constructor(input: Input, camera: Camera) {
    this.input = input;
    this.camera = camera;
  }

  update(_world: World, org: Organism): void {
    if (this.input.has) this.camera.toWorld(this.input.x, this.input.y, org.target);
    else org.center(org.target);
    if (this.input.consumeSplit()) org.wantSplit = true;
    if (this.input.consumeEject()) org.wantEject = true;
  }
}
