// Minimal typings for the parts of MindAR's image-tracking API we use.

export interface ControllerOptions {
  inputWidth: number;
  inputHeight: number;
  onUpdate?: (event: ControllerEvent) => void;
  debugMode?: boolean;
  maxTrack?: number;
  warmupTolerance?: number | null;
  missTolerance?: number | null;
  filterMinCF?: number | null;
  filterBeta?: number | null;
}

export type ControllerEvent =
  | { type: "updateMatrix"; targetIndex: number; worldMatrix: number[] | null }
  | { type: "processDone" };

export class Controller {
  constructor(options: ControllerOptions);
  inputWidth: number;
  inputHeight: number;
  /** Camera intrinsics K (3x3). Read by addImageTargetsFromBuffer(), so set it before. */
  projectionTransform: number[][];
  projectionMatrix: number[];
  _glProjectionMatrix(args: {
    projectionTransform: number[][];
    width: number;
    height: number;
    near: number;
    far: number;
  }): number[];
  addImageTargetsFromBuffer(buffer: ArrayBuffer): { dimensions: [number, number][] };
  getProjectionMatrix(): number[];
  dummyRun(input: HTMLCanvasElement | HTMLVideoElement): void;
  processVideo(input: HTMLCanvasElement | HTMLVideoElement): void;
  stopProcessVideo(): void;
  dispose(): void;
}

export class Compiler {
  compileImageTargets(
    images: (HTMLImageElement | HTMLCanvasElement | ImageBitmap)[],
    progress: (percent: number) => void,
  ): Promise<unknown>;
  exportData(): Uint8Array;
  importData(buffer: ArrayBuffer): { targetImage: { width: number; height: number } }[];
}
