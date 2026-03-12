"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { PCDLoader } from "three/examples/jsm/loaders/PCDLoader.js";
import {
  HIGHLIGHT_WORKER_CODE,
  SELECTION_WORKER_CODE,
} from "../lib/workerScripts";
import type {
  HighlightBuffers,
  LassoAction,
  Point2D,
  SelectionComputation,
  ViewerScene,
} from "../types";
import {
  buildFilteredGeometry,
  drawLassoPath,
  fitCameraToGeometry,
  getMvpElements,
  rasterizePolygon,
} from "../lib/viewerUtils";

type SelectionWorkerMessage = {
  mask: Uint8Array;
  selectedCount: number;
};

export function usePCDViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lassoCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoAction, setLassoAction] = useState<LassoAction>("filter");
  const [hasSelection, setHasSelection] = useState(false);

  const lassoPathRef = useRef<Point2D[]>([]);
  const isDrawingRef = useRef(false);
  const marchingOffsetRef = useRef(0);
  const marchingAnimIdRef = useRef(0);

  const originalGeometryRef = useRef<THREE.BufferGeometry | null>(null);
  const selectedMaskRef = useRef<Uint8Array | null>(null);

  const precomputedHighlightRef = useRef<HighlightBuffers | null>(null);
  const highlightReadyRef = useRef<Promise<void> | null>(null);
  const highlightWorkerRef = useRef<Worker | null>(null);

  const lassoActionRef = useRef<LassoAction>("filter");

  const sceneRef = useRef<ViewerScene | null>(null);

  const clearLassoCanvas = useCallback(() => {
    const canvas = lassoCanvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const syncLassoCanvasSize = useCallback(() => {
    if (!containerRef.current || !lassoCanvasRef.current) {
      return;
    }

    lassoCanvasRef.current.width = containerRef.current.clientWidth;
    lassoCanvasRef.current.height = containerRef.current.clientHeight;
  }, []);

  const disposePointCloud = useCallback(() => {
    if (!sceneRef.current?.pointCloud) {
      return;
    }

    const pointCloud = sceneRef.current.pointCloud;
    sceneRef.current.scene.remove(pointCloud);
    pointCloud.geometry.dispose();

    if (Array.isArray(pointCloud.material)) {
      pointCloud.material.forEach((material) => material.dispose());
    } else {
      pointCloud.material.dispose();
    }

    sceneRef.current.pointCloud = null;
  }, []);

  const clearPrecomputed = useCallback(() => {
    if (highlightWorkerRef.current) {
      highlightWorkerRef.current.terminate();
      highlightWorkerRef.current = null;
    }

    precomputedHighlightRef.current = null;
    highlightReadyRef.current = null;
  }, []);

  const applyPointCloudGeometry = useCallback(
    (geometry: THREE.BufferGeometry, useVertexColors: boolean) => {
      if (!sceneRef.current?.pointCloud) {
        return;
      }

      const pointCloud = sceneRef.current.pointCloud;
      pointCloud.geometry.dispose();
      pointCloud.geometry = geometry;

      const material = pointCloud.material as THREE.PointsMaterial;
      material.vertexColors = useVertexColors;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    },
    [],
  );

  const enterLassoMode = useCallback((action: LassoAction) => {
    lassoActionRef.current = action;
    setLassoAction(action);
    setLassoMode(true);

    if (sceneRef.current) {
      sceneRef.current.controls.enabled = false;
    }
  }, []);

  const exitLassoMode = useCallback(() => {
    setLassoMode(false);

    if (sceneRef.current) {
      sceneRef.current.controls.enabled = true;
    }

    cancelAnimationFrame(marchingAnimIdRef.current);
    clearLassoCanvas();
  }, [clearLassoCanvas]);

  const toggleFilterMode = useCallback(() => {
    if (lassoMode && lassoAction === "filter") {
      exitLassoMode();
      return;
    }

    enterLassoMode("filter");
  }, [enterLassoMode, exitLassoMode, lassoAction, lassoMode]);

  const toggleHighlightMode = useCallback(() => {
    if (lassoMode && lassoAction === "highlight") {
      exitLassoMode();
      return;
    }

    enterLassoMode("highlight");
  }, [enterLassoMode, exitLassoMode, lassoAction, lassoMode]);

  const resetSelection = useCallback(() => {
    if (!sceneRef.current?.pointCloud || !originalGeometryRef.current) {
      return;
    }

    applyPointCloudGeometry(originalGeometryRef.current.clone(), false);
    selectedMaskRef.current = null;
    clearPrecomputed();
    clearLassoCanvas();
    setHasSelection(false);
  }, [applyPointCloudGeometry, clearLassoCanvas, clearPrecomputed]);

  const computeSelection =
    useCallback(async (): Promise<SelectionComputation | null> => {
      if (!sceneRef.current?.pointCloud) {
        return null;
      }

      const { camera, renderer, pointCloud } = sceneRef.current;
      const polygon = lassoPathRef.current;

      if (polygon.length < 3) {
        return null;
      }

      const sourceGeometry = originalGeometryRef.current ?? pointCloud.geometry;

      if (!originalGeometryRef.current) {
        originalGeometryRef.current = pointCloud.geometry.clone();
      }

      const srcArray = sourceGeometry.attributes.position.array as Float32Array;
      const count = sourceGeometry.attributes.position.count;
      const width =
        renderer.domElement.clientWidth || renderer.domElement.width;
      const height =
        renderer.domElement.clientHeight || renderer.domElement.height;
      const bitmap = rasterizePolygon(polygon, width, height);
      const mvp = getMvpElements(camera, pointCloud);
      const workerCount = Math.min(navigator.hardwareConcurrency || 4, 4);
      const chunkSize = Math.ceil(count / workerCount);
      const workerUrl = URL.createObjectURL(
        new Blob([SELECTION_WORKER_CODE], {
          type: "application/javascript",
        }),
      );

      try {
        const workerPromises: Promise<SelectionWorkerMessage>[] = [];

        for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
          const start = workerIndex * chunkSize;
          const end = Math.min(start + chunkSize, count);

          if (start >= count) {
            break;
          }

          const chunkPositions = srcArray.slice(start * 3, end * 3);
          const bitmapCopy = new Uint8Array(bitmap);

          workerPromises.push(
            new Promise((resolve, reject) => {
              const worker = new Worker(workerUrl);

              worker.onmessage = (
                event: MessageEvent<SelectionWorkerMessage>,
              ) => {
                resolve(event.data);
                worker.terminate();
              };

              worker.onerror = () => {
                worker.terminate();
                reject(new Error("Selection worker failed"));
              };

              worker.postMessage(
                {
                  positions: chunkPositions,
                  mvp,
                  bitmap: bitmapCopy,
                  bmpW: width,
                  bmpH: height,
                },
                [chunkPositions.buffer, bitmapCopy.buffer],
              );
            }),
          );
        }

        const workerResults = await Promise.all(workerPromises);
        const fullMask = new Uint8Array(count);
        let totalSelected = 0;

        for (
          let workerIndex = 0;
          workerIndex < workerResults.length;
          workerIndex += 1
        ) {
          fullMask.set(
            workerResults[workerIndex].mask,
            workerIndex * chunkSize,
          );
          totalSelected += workerResults[workerIndex].selectedCount;
        }

        return {
          count,
          sourceGeometry,
          srcArray,
          fullMask,
          totalSelected,
        };
      } finally {
        URL.revokeObjectURL(workerUrl);
      }
    }, []);

  const runHighlightWorker = useCallback(
    async (
      positionsSource: Float32Array,
      maskSource: Uint8Array,
      count: number,
    ): Promise<HighlightBuffers> => {
      const positions = new Float32Array(positionsSource);
      const mask = new Uint8Array(maskSource);
      const workerUrl = URL.createObjectURL(
        new Blob([HIGHLIGHT_WORKER_CODE], {
          type: "application/javascript",
        }),
      );

      try {
        return await new Promise<HighlightBuffers>((resolve, reject) => {
          const worker = new Worker(workerUrl);

          worker.onmessage = (event: MessageEvent<HighlightBuffers>) => {
            resolve(event.data);
            worker.terminate();
          };

          worker.onerror = () => {
            worker.terminate();
            reject(new Error("Highlight worker failed"));
          };

          worker.postMessage(
            {
              positions,
              mask,
              count,
            },
            [positions.buffer, mask.buffer],
          );
        });
      } finally {
        URL.revokeObjectURL(workerUrl);
      }
    },
    [],
  );

  const precomputeHighlight = useCallback(
    (positionsSource: Float32Array, maskSource: Uint8Array, count: number) => {
      clearPrecomputed();

      const positions = new Float32Array(positionsSource);
      const mask = new Uint8Array(maskSource);
      const workerUrl = URL.createObjectURL(
        new Blob([HIGHLIGHT_WORKER_CODE], {
          type: "application/javascript",
        }),
      );
      const worker = new Worker(workerUrl);

      highlightWorkerRef.current = worker;
      highlightReadyRef.current = new Promise((resolve) => {
        worker.onmessage = (event: MessageEvent<HighlightBuffers>) => {
          precomputedHighlightRef.current = event.data;
          highlightWorkerRef.current = null;
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          resolve();
        };

        worker.onerror = () => {
          highlightWorkerRef.current = null;
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          resolve();
        };
      });

      worker.postMessage(
        {
          positions,
          mask,
          count,
        },
        [positions.buffer, mask.buffer],
      );
    },
    [clearPrecomputed],
  );

  const applyLassoSelection = useCallback(async () => {
    const computation = await computeSelection();

    if (!computation || computation.totalSelected === 0) {
      return;
    }

    const nextGeometry = buildFilteredGeometry(
      computation.sourceGeometry,
      computation.fullMask,
      computation.totalSelected,
    );

    selectedMaskRef.current = computation.fullMask;
    applyPointCloudGeometry(
      nextGeometry,
      Boolean(nextGeometry.getAttribute("color")),
    );
    setHasSelection(true);
    precomputeHighlight(
      computation.srcArray,
      computation.fullMask,
      computation.count,
    );
  }, [applyPointCloudGeometry, computeSelection, precomputeHighlight]);

  const applyLassoAndHighlight = useCallback(async () => {
    const startedAt = performance.now();
    const computation = await computeSelection();

    if (!computation || computation.totalSelected === 0) {
      if (computation) {
        const elapsedMs = performance.now() - startedAt;
        console.log(
          `[套索选中并上色] points=${computation.count} selected=0 time=${elapsedMs.toFixed(1)}ms`,
        );
      }
      return;
    }

    const highlightBuffers = await runHighlightWorker(
      computation.srcArray,
      computation.fullMask,
      computation.count,
    );
    const nextGeometry = new THREE.BufferGeometry();

    nextGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(highlightBuffers.positions, 3),
    );
    nextGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(highlightBuffers.colors, 3),
    );

    selectedMaskRef.current = computation.fullMask;
    precomputedHighlightRef.current = highlightBuffers;
    highlightReadyRef.current = null;
    applyPointCloudGeometry(nextGeometry, true);
    setHasSelection(true);
    const elapsedMs = performance.now() - startedAt;
    console.log(
      `[套索选中并上色] points=${computation.count} selected=${computation.totalSelected} time=${elapsedMs.toFixed(1)}ms`,
    );
  }, [applyPointCloudGeometry, computeSelection, runHighlightWorker]);

  const highlightSelection = useCallback(async () => {
    if (!sceneRef.current?.pointCloud || !selectedMaskRef.current) {
      return;
    }

    if (!precomputedHighlightRef.current && highlightReadyRef.current) {
      setLoading("计算中...");
      await highlightReadyRef.current;
      setLoading(null);
    }

    if (!precomputedHighlightRef.current) {
      return;
    }

    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        precomputedHighlightRef.current.positions,
        3,
      ),
    );
    nextGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        precomputedHighlightRef.current.colors,
        3,
      ),
    );

    applyPointCloudGeometry(nextGeometry, true);
    setHasSelection(true);
  }, [applyPointCloudGeometry]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    const controls = new TrackballControls(camera, renderer.domElement);
    const preventContextMenu = (event: Event) => event.preventDefault();
    const preventDragStart = (event: Event) => event.preventDefault();

    scene.background = new THREE.Color(0x1a1a2e);
    camera.position.set(0, 0, 5);
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.domElement.style.display = "block";
    container.appendChild(renderer.domElement);

    controls.enabled = true;
    controls.noRotate = false;
    controls.noPan = false;
    controls.noZoom = false;
    controls.rotateSpeed = 3;
    controls.panSpeed = 0.8;
    controls.zoomSpeed = 1.2;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.handleResize();

    renderer.domElement.addEventListener("contextmenu", preventContextMenu);
    renderer.domElement.addEventListener("dragstart", preventDragStart);

    scene.add(new THREE.GridHelper(10, 20, 0x444444, 0x333333));
    scene.add(new THREE.AxesHelper(2));

    sceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      pointCloud: null,
      animationId: 0,
    };

    syncLassoCanvasSize();

    const animate = () => {
      const nextAnimationFrame = requestAnimationFrame(animate);

      if (sceneRef.current) {
        sceneRef.current.animationId = nextAnimationFrame;
      }

      controls.update();
      renderer.render(scene, camera);
    };

    const handleResize = () => {
      const nextWidth = container.clientWidth;
      const nextHeight = container.clientHeight;

      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
      controls.handleResize();
      syncLassoCanvasSize();
    };

    animate();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);

      if (sceneRef.current) {
        cancelAnimationFrame(sceneRef.current.animationId);
      }

      disposePointCloud();
      clearPrecomputed();
      renderer.domElement.removeEventListener(
        "contextmenu",
        preventContextMenu,
      );
      renderer.domElement.removeEventListener("dragstart", preventDragStart);
      controls.dispose();
      renderer.dispose();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [clearPrecomputed, disposePointCloud, syncLassoCanvasSize]);

  useEffect(() => {
    syncLassoCanvasSize();
  }, [syncLassoCanvasSize]);

  const handleFileUpload = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file || !sceneRef.current) {
        return;
      }

      if (!file.name.endsWith(".pcd")) {
        setError("请上传 .pcd 格式的文件");
        return;
      }

      setError(null);
      setLoading("加载中...");
      setFileName(file.name);

      const reader = new FileReader();

      reader.onload = (loadEvent) => {
        const result = loadEvent.target?.result;

        if (!result || !sceneRef.current) {
          return;
        }

        try {
          disposePointCloud();

          if (originalGeometryRef.current) {
            originalGeometryRef.current.dispose();
            originalGeometryRef.current = null;
          }

          selectedMaskRef.current = null;
          clearPrecomputed();
          setHasSelection(false);
          clearLassoCanvas();

          const loader = new PCDLoader();
          const points = loader.parse(result as ArrayBuffer);
          const material = points.material as THREE.PointsMaterial;

          material.size = 0.02;
          material.color.set(0xffffff);
          material.sizeAttenuation = true;

          sceneRef.current.scene.add(points);
          sceneRef.current.pointCloud = points;
          originalGeometryRef.current = points.geometry.clone();
          fitCameraToGeometry(
            sceneRef.current.camera,
            sceneRef.current.controls,
            points.geometry,
          );
          setLoading(null);
        } catch (loadError) {
          setError(`解析 PCD 文件失败: ${String(loadError)}`);
          setLoading(null);
        }
      };

      reader.onerror = () => {
        setError("读取文件失败");
        setLoading(null);
      };

      reader.readAsArrayBuffer(file);
    },
    [clearLassoCanvas, clearPrecomputed, disposePointCloud],
  );

  const redrawLasso = useCallback(
    (canvas: HTMLCanvasElement, closed: boolean) => {
      drawLassoPath({
        canvas,
        path: lassoPathRef.current,
        marchingOffset: marchingOffsetRef.current,
        closed,
      });
    },
    [],
  );

  const startMarchingAnts = useCallback(
    (canvas: HTMLCanvasElement) => {
      cancelAnimationFrame(marchingAnimIdRef.current);

      const tick = () => {
        marchingOffsetRef.current = (marchingOffsetRef.current + 0.4) % 20;
        redrawLasso(canvas, false);
        marchingAnimIdRef.current = requestAnimationFrame(tick);
      };

      marchingAnimIdRef.current = requestAnimationFrame(tick);
    },
    [redrawLasso],
  );

  const stopMarchingAnts = useCallback(() => {
    cancelAnimationFrame(marchingAnimIdRef.current);
  }, []);

  const handleLassoMouseDown = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      if (!lassoMode) {
        return;
      }

      isDrawingRef.current = true;
      marchingOffsetRef.current = 0;

      const rect = event.currentTarget.getBoundingClientRect();
      lassoPathRef.current = [
        {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        },
      ];

      const context = event.currentTarget.getContext("2d");
      context?.clearRect(
        0,
        0,
        event.currentTarget.width,
        event.currentTarget.height,
      );
      startMarchingAnts(event.currentTarget);
    },
    [lassoMode, startMarchingAnts],
  );

  const handleLassoMouseMove = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !lassoMode) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      lassoPathRef.current.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [lassoMode],
  );

  const handleLassoMouseUp = useCallback(async () => {
    if (!isDrawingRef.current) {
      return;
    }

    isDrawingRef.current = false;
    stopMarchingAnts();
    clearLassoCanvas();
    exitLassoMode();
    setError(null);
    setLoading("计算中...");

    try {
      if (lassoActionRef.current === "highlight") {
        await applyLassoAndHighlight();
      } else {
        await applyLassoSelection();
      }
    } catch (selectionError) {
      setError(`套索计算失败: ${String(selectionError)}`);
    } finally {
      setLoading(null);
    }
  }, [
    applyLassoAndHighlight,
    applyLassoSelection,
    clearLassoCanvas,
    exitLassoMode,
    stopMarchingAnts,
  ]);

  return {
    containerRef,
    lassoCanvasRef,
    error,
    fileName,
    handleFileUpload,
    handleLassoMouseDown,
    handleLassoMouseMove,
    handleLassoMouseUp,
    hasSelection,
    highlightSelection,
    lassoAction,
    lassoMode,
    loading,
    resetSelection,
    toggleFilterMode,
    toggleHighlightMode,
  };
}
