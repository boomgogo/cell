// Mouse, touch and keyboard: Pointer Events; the cell steers toward the pointer's
// (or last touch's) screen position; Space splits, W ejects (hold to repeat).
export class Input {
  x = 0;
  y = 0;
  has = false;
  touch = false;
  ejectHeld = false;
  private splitQueued = 0;
  private ejectQueued = 0;
  wheelDelta = 0;

  constructor(surface: HTMLElement) {
    const onPointer = (e: PointerEvent) => {
      this.x = e.clientX;
      this.y = e.clientY;
      this.has = true;
      if (e.pointerType === 'touch') this.touch = true;
    };
    surface.addEventListener('pointermove', onPointer, { passive: true });
    surface.addEventListener('pointerdown', onPointer, { passive: true });
    surface.addEventListener(
      'wheel',
      (e) => {
        this.wheelDelta += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        if (!e.repeat) this.splitQueued++;
        e.preventDefault();
      } else if (e.code === 'KeyW') {
        if (!e.repeat) this.ejectQueued++;
        this.ejectHeld = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyW') this.ejectHeld = false;
    });
    window.addEventListener('blur', () => {
      this.ejectHeld = false;
    });
  }

  queueSplit(): void {
    this.splitQueued++;
  }

  queueEject(): void {
    this.ejectQueued++;
  }

  consumeSplit(): boolean {
    if (this.splitQueued > 0) {
      this.splitQueued--;
      return true;
    }
    return false;
  }

  consumeEject(): boolean {
    if (this.ejectQueued > 0) {
      this.ejectQueued--;
      return true;
    }
    return this.ejectHeld;
  }

  takeWheel(): number {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }
}
