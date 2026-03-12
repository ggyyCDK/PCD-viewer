import type {
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  WebGLRenderer,
} from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

export type LassoAction = "filter" | "highlight";

export type Point2D = {
  x: number;
  y: number;
};

export type HighlightBuffers = {
  positions: Float32Array;
  colors: Float32Array;
};

export type ViewerScene = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: TrackballControls;
  pointCloud: Points | null;
  animationId: number;
};

export type SelectionComputation = {
  count: number;
  sourceGeometry: BufferGeometry;
  srcArray: Float32Array;
  fullMask: Uint8Array;
  totalSelected: number;
};
