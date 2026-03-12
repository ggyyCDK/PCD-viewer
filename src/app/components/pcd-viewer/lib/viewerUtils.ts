import * as THREE from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import type { Point2D } from "../types";

export function rasterizePolygon(
  polygon: Point2D[],
  width: number,
  height: number,
): Uint8Array {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;

  const context = offscreen.getContext("2d");
  if (!context) {
    return new Uint8Array(width * height);
  }

  context.fillStyle = "#fff";
  context.beginPath();
  context.moveTo(polygon[0].x, polygon[0].y);

  for (let index = 1; index < polygon.length; index += 1) {
    context.lineTo(polygon[index].x, polygon[index].y);
  }

  context.closePath();
  context.fill();

  const rgba = context.getImageData(0, 0, width, height).data;
  const bitmap = new Uint8Array(width * height);

  for (let index = 0; index < bitmap.length; index += 1) {
    bitmap[index] = rgba[index * 4 + 3] > 0 ? 1 : 0;
  }

  return bitmap;
}

export function getMvpElements(
  camera: THREE.PerspectiveCamera,
  pointCloud: THREE.Points,
): number[] {
  const mvpMatrix = new THREE.Matrix4();
  mvpMatrix.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  mvpMatrix.multiply(pointCloud.matrixWorld);
  return Array.from(mvpMatrix.elements);
}

export function buildFilteredGeometry(
  sourceGeometry: THREE.BufferGeometry,
  selectionMask: Uint8Array,
  totalSelected: number,
): THREE.BufferGeometry {
  const sourcePositions = sourceGeometry.attributes.position
    .array as Float32Array;
  const nextGeometry = new THREE.BufferGeometry();
  const selectedPositions = new Float32Array(totalSelected * 3);

  let positionIndex = 0;

  for (let pointIndex = 0; pointIndex < selectionMask.length; pointIndex += 1) {
    if (!selectionMask[pointIndex]) {
      continue;
    }

    const sourceIndex = pointIndex * 3;
    selectedPositions[positionIndex++] = sourcePositions[sourceIndex];
    selectedPositions[positionIndex++] = sourcePositions[sourceIndex + 1];
    selectedPositions[positionIndex++] = sourcePositions[sourceIndex + 2];
  }

  nextGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(selectedPositions, 3),
  );

  const sourceColors = sourceGeometry.attributes.color;

  if (!sourceColors) {
    return nextGeometry;
  }

  const nextColors = new Float32Array(totalSelected * 3);
  const colorArray = sourceColors.array as Float32Array;
  let colorIndex = 0;

  for (let pointIndex = 0; pointIndex < selectionMask.length; pointIndex += 1) {
    if (!selectionMask[pointIndex]) {
      continue;
    }

    const sourceIndex = pointIndex * 3;
    nextColors[colorIndex++] = colorArray[sourceIndex];
    nextColors[colorIndex++] = colorArray[sourceIndex + 1];
    nextColors[colorIndex++] = colorArray[sourceIndex + 2];
  }

  nextGeometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(nextColors, 3),
  );

  return nextGeometry;
}

export function fitCameraToGeometry(
  camera: THREE.PerspectiveCamera,
  controls: TrackballControls,
  geometry: THREE.BufferGeometry,
): void {
  geometry.computeBoundingBox();

  const boundingBox = geometry.boundingBox;
  if (!boundingBox) {
    return;
  }

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();

  boundingBox.getCenter(center);
  boundingBox.getSize(size);

  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  camera.position.set(
    center.x + maxDimension,
    center.y + maxDimension * 0.5,
    center.z + maxDimension,
  );
  camera.lookAt(center);
  controls.target.copy(center);
  controls.update();
}

export function drawLassoPath(options: {
  canvas: HTMLCanvasElement;
  path: Point2D[];
  marchingOffset: number;
  closed: boolean;
}): void {
  const { canvas, path, marchingOffset, closed } = options;
  const context = canvas.getContext("2d");

  if (!context || path.length < 2) {
    return;
  }

  const tracePath = () => {
    context.beginPath();
    context.moveTo(path[0].x, path[0].y);

    for (let index = 1; index < path.length; index += 1) {
      context.lineTo(path[index].x, path[index].y);
    }

    if (closed) {
      context.closePath();
    }
  };

  context.clearRect(0, 0, canvas.width, canvas.height);

  tracePath();
  context.fillStyle = "rgba(0, 200, 255, 0.08)";
  context.fill();
  context.strokeStyle = "rgba(0, 200, 255, 0.25)";
  context.lineWidth = 6;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  tracePath();
  context.strokeStyle = "rgba(255, 255, 255, 0.6)";
  context.lineWidth = 1.5;
  context.setLineDash([]);
  context.stroke();

  tracePath();
  context.strokeStyle = "rgba(0, 200, 255, 0.9)";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.lineDashOffset = -marchingOffset;
  context.stroke();
  context.setLineDash([]);

  const nodeInterval = Math.max(1, Math.floor(path.length / 20));

  for (let index = 0; index < path.length; index += nodeInterval) {
    const point = path[index];

    context.beginPath();
    context.arc(point.x, point.y, 4, 0, Math.PI * 2);
    context.fillStyle = "rgba(0, 0, 0, 0.5)";
    context.fill();
    context.strokeStyle = "rgba(0, 200, 255, 0.9)";
    context.lineWidth = 1.5;
    context.stroke();

    context.beginPath();
    context.arc(point.x, point.y, 1.5, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();
  }

  const start = path[0];
  context.beginPath();
  context.arc(start.x, start.y, 5, 0, Math.PI * 2);
  context.fillStyle = "rgba(0, 200, 255, 0.3)";
  context.fill();
  context.strokeStyle = "#00c8ff";
  context.lineWidth = 2;
  context.stroke();
  context.beginPath();
  context.arc(start.x, start.y, 2, 0, Math.PI * 2);
  context.fillStyle = "#fff";
  context.fill();
}
