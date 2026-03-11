"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";

import * as THREE from "three";

import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

import { PCDLoader } from "three/examples/jsm/loaders/PCDLoader.js";

const SELECTION_WORKER_CODE = `

self.onmessage = function(e) {

var d = e.data;

var positions = d.positions; 

var m = d.mvp; 

var bitmap = d.bitmap; 

var bmpW = d.bmpW; 

var bmpH = d.bmpH; 

var halfW = bmpW * 0.5; 

var halfH = bmpH * 0.5; 

var count = (positions.length / 3) | 0; 

var mask = new Uint8Array(count); 

var selectedCount = 0; 

var m0 = m[0], m1 = m[1], m3 = m[3],

m4 = m[4], m5 = m[5], m7 = m[7],

m8 = m[8], m9 = m[9], m11 = m[11],

m12 = m[12], m13 = m[13], m15 = m[15];

for (var i = 0; i < count; i++) {

var i3 = i * 3;

var x = positions[i3]; 

var y = positions[i3 + 1]; 

var z = positions[i3 + 2]; 

var clipW = m3 * x + m7 * y + m11 * z + m15;

if (clipW <= 0) continue; 

var invW = 1 / clipW; 

var px = ((m0 * x + m4 * y + m8 * z + m12) * invW + 1) * halfW; 

var py = (-(m1 * x + m5 * y + m9 * z + m13) * invW + 1) * halfH; 

var ix = px | 0; 

var iy = py | 0;

if (ix >= 0 && ix < bmpW && iy >= 0 && iy < bmpH && bitmap[iy * bmpW + ix]) {

mask[i] = 1; 

selectedCount++;

}

}

self.postMessage(

{ mask: mask, selectedCount: selectedCount },

[mask.buffer]

);

};

`;

const HIGHLIGHT_WORKER_CODE = `

self.onmessage = function(e) {

var positions = e.data.positions; 

var mask = e.data.mask; 

var count = e.data.count; 

var colors = new Float32Array(count * 3); 

for (var i = 0; i < count; i++) {

var i3 = i * 3;

if (mask[i]) {

colors[i3] = 0.56;

colors[i3 + 1] = 0.93;

colors[i3 + 2] = 0.56;

} else {

colors[i3] = 1.0;

colors[i3 + 1] = 1.0;

colors[i3 + 2] = 1.0;

}

}

self.postMessage(

{ positions: positions, colors: colors },

[positions.buffer, colors.buffer]

);

};

`;

export default function PCDViewer() {

    

    const containerRef = useRef<HTMLDivElement | null>(null); 

    const lassoCanvasRef = useRef<HTMLCanvasElement | null>(null); 

    

    const [loading, setLoading] = useState<string | null>(null); 

    const [error, setError] = useState<string | null>(null); 

    const [fileName, setFileName] = useState<string | null>(null); 

    const [lassoMode, setLassoMode] = useState(false); 

    const [lassoAction, setLassoAction] = useState<"filter" | "highlight">("filter"); 

    const [hasSelection, setHasSelection] = useState(false); 

    

    const lassoPathRef = useRef<{ x: number; y: number }[]>([]); 

    const isDrawingRef = useRef(false); 

    const marchingOffsetRef = useRef(0); 

    const marchingAnimIdRef = useRef(0); 

    

    const originalGeometryRef = useRef<THREE.BufferGeometry | null>(null); 

    const selectedMaskRef = useRef<Uint8Array | null>(null); 

    

    

    

    const precomputedHighlightRef = useRef<{

        positions: Float32Array; 

        colors: Float32Array; 

    } | null>(null);

    const highlightReadyRef = useRef<Promise<void> | null>(null); 

    const highlightWorkerRef = useRef<Worker | null>(null); 

    

    

    

    const lassoActionRef = useRef<"filter" | "highlight">("filter");

    

    

    const sceneRef = useRef<{

        scene: THREE.Scene; 

        camera: THREE.PerspectiveCamera; 

        renderer: THREE.WebGLRenderer; 

        controls: TrackballControls; 

        pointCloud: THREE.Points | null; 

        animationId: number; 

    } | null>(null);

    const enterLassoMode = useCallback((action: "filter" | "highlight") => {

        lassoActionRef.current = action;
        setLassoAction(action);

        setLassoMode(true);

        

        if (sceneRef.current) sceneRef.current.controls.enabled = false;

    }, []);

    const exitLassoMode = useCallback(() => {
    
    setLassoMode(false);
    
    if (sceneRef.current) sceneRef.current.controls.enabled = true;
    
    
    
    cancelAnimationFrame(marchingAnimIdRef.current);
    
    if (lassoCanvasRef.current) {
    
    const ctx = lassoCanvasRef.current.getContext("2d");
    
    ctx?.clearRect(
    
    0,
    
    0,
    
    lassoCanvasRef.current.width,
    
    lassoCanvasRef.current.height
    
    );
    
    }
    
    }, []);
    
    const clearPrecomputed = useCallback(() => {
    
    if (highlightWorkerRef.current) {
    
    highlightWorkerRef.current.terminate();
    
    highlightWorkerRef.current = null;
    
    }
    
    precomputedHighlightRef.current = null;
    
    highlightReadyRef.current = null;
    
    }, []);
    
    const resetSelection = useCallback(() => {

        if (!sceneRef.current?.pointCloud || !originalGeometryRef.current) return;

        const pointCloud = sceneRef.current.pointCloud;

        

        pointCloud.geometry.dispose();

        pointCloud.geometry = originalGeometryRef.current.clone();

        selectedMaskRef.current = null;

        clearPrecomputed();

        

        const mat = pointCloud.material as THREE.PointsMaterial;

        mat.vertexColors = false; 

        mat.color.set(0xffffff); 

        mat.needsUpdate = true; 

        setHasSelection(false);

        

        if (lassoCanvasRef.current) {

            const ctx = lassoCanvasRef.current.getContext("2d");

            ctx?.clearRect(

                0,

                0,

                lassoCanvasRef.current.width,

                lassoCanvasRef.current.height

            );

        }

    }, [clearPrecomputed]);

    const rasterizePolygon = useCallback(

        (polygon: { x: number; y: number }[], w: number, h: number) => {

            

            const offscreen = document.createElement("canvas");

            offscreen.width = w;

            offscreen.height = h;

            const ctx = offscreen.getContext("2d")!;

            

            ctx.fillStyle = "#fff";

            ctx.beginPath();

            ctx.moveTo(polygon[0].x, polygon[0].y);

            for (let i = 1; i < polygon.length; i++)

                ctx.lineTo(polygon[i].x, polygon[i].y);

            ctx.closePath();

            ctx.fill();

            

            const rgba = ctx.getImageData(0, 0, w, h).data;

            const bitmap = new Uint8Array(w * h);

            for (let i = 0; i < bitmap.length; i++)

                bitmap[i] = rgba[i * 4 + 3] > 0 ? 1 : 0; 

            return bitmap;

        },

        []

    );

    const applyLassoSelection = useCallback(async () => {

        if (!sceneRef.current?.pointCloud) return;

        const { camera, renderer, pointCloud } = sceneRef.current;

        const polygon = lassoPathRef.current;

        if (polygon.length < 3) return;

        const sourceGeometry = originalGeometryRef.current || pointCloud.geometry;

        

        if (!originalGeometryRef.current) {

            originalGeometryRef.current = pointCloud.geometry.clone();

        }

        

        const srcArray = sourceGeometry.attributes.position.array as Float32Array;

        const count = sourceGeometry.attributes.position.count; 

        const canvasEl = renderer.domElement;

        const width = canvasEl.clientWidth;

        const height = canvasEl.clientHeight;

        const t0 = performance.now(); 

        

        const bitmap = rasterizePolygon(polygon, width, height);

        

        

        

        const mvpMatrix = new THREE.Matrix4();

        mvpMatrix.multiplyMatrices(

            camera.projectionMatrix, 

            camera.matrixWorldInverse 

        );

        mvpMatrix.multiply(pointCloud.matrixWorld); 

        const mvpArr = Array.from(mvpMatrix.elements); 

        

        

        const workerCount = Math.min(navigator.hardwareConcurrency || 4, 4); 

        const chunkSize = Math.ceil(count / workerCount); 

        

        const blob = new Blob([SELECTION_WORKER_CODE], {

            type: "application/javascript",

        });

        const workerUrl = URL.createObjectURL(blob);

        const promises: Promise<{

            mask: Uint8Array;

            selectedCount: number;

        }>[] = [];

        for (let w = 0; w < workerCount; w++) {

            const start = w * chunkSize;

            const end = Math.min(start + chunkSize, count);

            if (start >= count) break;

            

            const chunkPositions = srcArray.slice(start * 3, end * 3);

            const bitmapCopy = new Uint8Array(bitmap); 

            promises.push(

                new Promise((resolve) => {

                    const worker = new Worker(workerUrl);

                    worker.onmessage = (ev) => {

                        resolve(ev.data);

                        worker.terminate(); 

                    };

                    

                    worker.postMessage(

                        {

                            positions: chunkPositions,

                            mvp: mvpArr,

                            bitmap: bitmapCopy,

                            bmpW: width,

                            bmpH: height,

                        },

                        [chunkPositions.buffer, bitmapCopy.buffer] 

                    );

                })

            );

        }

        

        const results = await Promise.all(promises);

        URL.revokeObjectURL(workerUrl); 

        

        const fullMask = new Uint8Array(count);

        let totalSelected = 0;

        for (let w = 0; w < results.length; w++) {

            fullMask.set(results[w].mask, w * chunkSize); 

            totalSelected += results[w].selectedCount;

        }

        console.log(

            `[Lasso] ${count.toLocaleString()} pts → ${totalSelected.toLocaleString()} selected in ${(

                performance.now() - t0

            ).toFixed(0)}ms`

        );

        if (totalSelected === 0) return;

        selectedMaskRef.current = fullMask;

        

        const selectedPositions = new Float32Array(totalSelected * 3);

        let idx = 0;

        for (let i = 0; i < count; i++) {

            if (fullMask[i]) {

                const i3 = i * 3;

                selectedPositions[idx++] = srcArray[i3]; 

                selectedPositions[idx++] = srcArray[i3 + 1]; 

                selectedPositions[idx++] = srcArray[i3 + 2]; 

            }

        }

        

        const newGeometry = new THREE.BufferGeometry();

        newGeometry.setAttribute(

            "position",

            new THREE.Float32BufferAttribute(selectedPositions, 3) 

        );

        

        const colors = sourceGeometry.attributes.color;

        if (colors) {

            const srcColors = colors.array as Float32Array;

            const selectedColors = new Float32Array(totalSelected * 3);

            let cidx = 0;

            for (let i = 0; i < count; i++) {

                if (fullMask[i]) {

                    const i3 = i * 3;

                    selectedColors[cidx++] = srcColors[i3];

                    selectedColors[cidx++] = srcColors[i3 + 1];

                    selectedColors[cidx++] = srcColors[i3 + 2];

                }

            }

            newGeometry.setAttribute(

                "color",

                new THREE.Float32BufferAttribute(selectedColors, 3)

            );

        }

        

        pointCloud.geometry.dispose();

        pointCloud.geometry = newGeometry;

        setHasSelection(true);

        

        

        clearPrecomputed();

        const capturedSrcArray = srcArray;

        const capturedMask = fullMask;

        const capturedCount = count;

        setTimeout(() => {

            

            const posCopy = new Float32Array(capturedSrcArray);

            const maskCopy = new Uint8Array(capturedMask);

            

            const hlBlob = new Blob([HIGHLIGHT_WORKER_CODE], {

                type: "application/javascript",

            });

            const hlUrl = URL.createObjectURL(hlBlob);

            const hlWorker = new Worker(hlUrl);

            highlightWorkerRef.current = hlWorker;

            

            highlightReadyRef.current = new Promise((resolve) => {

                hlWorker.onmessage = (ev) => {

                    precomputedHighlightRef.current = {

                        positions: ev.data.positions, 

                        colors: ev.data.colors, 

                    };

                    highlightWorkerRef.current = null;

                    hlWorker.terminate();

                    URL.revokeObjectURL(hlUrl);

                    resolve();

                };

            });

            hlWorker.postMessage(

                { positions: posCopy, mask: maskCopy, count: capturedCount },

                [posCopy.buffer, maskCopy.buffer]

            );

        }, 0); 

    }, [rasterizePolygon, clearPrecomputed]);

    const applyLassoAndHighlight = useCallback(async () => {

        if (!sceneRef.current?.pointCloud) return;

        const { camera, renderer, pointCloud } = sceneRef.current;

        const polygon = lassoPathRef.current;

        if (polygon.length < 3) return;

        const sourceGeometry = originalGeometryRef.current || pointCloud.geometry;

        if (!originalGeometryRef.current) {

            originalGeometryRef.current = pointCloud.geometry.clone();

        }

        const srcArray = sourceGeometry.attributes.position.array as Float32Array;

        const count = sourceGeometry.attributes.position.count;

        const canvasEl = renderer.domElement;

        const width = canvasEl.clientWidth;

        const height = canvasEl.clientHeight;

        const t0 = performance.now();

        

        const bitmap = rasterizePolygon(polygon, width, height);

        

        const mvpMatrix = new THREE.Matrix4();

        mvpMatrix.multiplyMatrices(

            camera.projectionMatrix,

            camera.matrixWorldInverse

        );

        mvpMatrix.multiply(pointCloud.matrixWorld);

        const mvpArr = Array.from(mvpMatrix.elements);

        

        const workerCount = Math.min(navigator.hardwareConcurrency || 4, 4);

        const chunkSize = Math.ceil(count / workerCount);

        const blob = new Blob([SELECTION_WORKER_CODE], {

            type: "application/javascript",

        });

        const workerUrl = URL.createObjectURL(blob);

        const promises: Promise<{ mask: Uint8Array; selectedCount: number }>[] = [];

        for (let w = 0; w < workerCount; w++) {

            const start = w * chunkSize;

            const end = Math.min(start + chunkSize, count);

            if (start >= count) break;

            const chunkPositions = srcArray.slice(start * 3, end * 3);

            const bitmapCopy = new Uint8Array(bitmap);

            promises.push(

                new Promise((resolve) => {

                    const worker = new Worker(workerUrl);

                    worker.onmessage = (ev) => {

                        resolve(ev.data);

                        worker.terminate();

                    };

                    worker.postMessage(

                        {

                            positions: chunkPositions,

                            mvp: mvpArr,

                            bitmap: bitmapCopy,

                            bmpW: width,

                            bmpH: height,

                        },

                        [chunkPositions.buffer, bitmapCopy.buffer]

                    );

                })

            );

        }

        const results = await Promise.all(promises);

        URL.revokeObjectURL(workerUrl);

        const fullMask = new Uint8Array(count);

        let totalSelected = 0;

        for (let w = 0; w < results.length; w++) {

            fullMask.set(results[w].mask, w * chunkSize);

            totalSelected += results[w].selectedCount;

        }

        if (totalSelected === 0) {

            console.log(

                `[套索选中并上色] ${count.toLocaleString()} pts → 0 selected in ${(

                    performance.now() - t0

                ).toFixed(0)}ms`

            );

            return;

        }

        selectedMaskRef.current = fullMask;

        

        const posCopy = new Float32Array(srcArray);

        const maskCopy = new Uint8Array(fullMask);

        const hlBlob = new Blob([HIGHLIGHT_WORKER_CODE], {

            type: "application/javascript",

        });

        const hlUrl = URL.createObjectURL(hlBlob);

        

        const { positions, colors } = await new Promise<{

            positions: Float32Array;

            colors: Float32Array;

        }>((resolve) => {

            const worker = new Worker(hlUrl);

            worker.onmessage = (ev) => {

                resolve(ev.data);

                worker.terminate();

                URL.revokeObjectURL(hlUrl);

            };

            worker.postMessage({ positions: posCopy, mask: maskCopy, count }, [

                posCopy.buffer,

                maskCopy.buffer,

            ]);

        });

        

        const newGeometry = new THREE.BufferGeometry();

        newGeometry.setAttribute(

            "position",

            new THREE.Float32BufferAttribute(positions, 3) 

        );

        newGeometry.setAttribute(

            "color",

            new THREE.Float32BufferAttribute(colors, 3) 

        );

        

        pointCloud.geometry.dispose();

        pointCloud.geometry = newGeometry;

        

        const mat = pointCloud.material as THREE.PointsMaterial;

        mat.vertexColors = true; 

        mat.color.set(0xffffff); 

        mat.needsUpdate = true; 

        setHasSelection(true);

        

        precomputedHighlightRef.current = { positions, colors };

        console.log(

            `[套索选中并上色] ${count.toLocaleString()} pts → ${totalSelected.toLocaleString()} selected & colored in ${(

                performance.now() - t0

            ).toFixed(0)}ms`

        );

    }, [rasterizePolygon]);

    const highlightSelection = useCallback(async () => {

        if (!sceneRef.current?.pointCloud || !selectedMaskRef.current) return;

        

        if (!precomputedHighlightRef.current && highlightReadyRef.current) {

            setLoading("计算中...");

            await highlightReadyRef.current;

            setLoading(null);

        }

        if (!precomputedHighlightRef.current) return;

        

        const { positions, colors } = precomputedHighlightRef.current;

        const pointCloud = sceneRef.current.pointCloud;

        

        const newGeometry = new THREE.BufferGeometry();

        newGeometry.setAttribute(

            "position",

            new THREE.Float32BufferAttribute(positions, 3)

        );

        newGeometry.setAttribute(

            "color",

            new THREE.Float32BufferAttribute(colors, 3)

        );

        pointCloud.geometry.dispose();

        pointCloud.geometry = newGeometry;

        

        const mat = pointCloud.material as THREE.PointsMaterial;

        mat.vertexColors = true;

        mat.color.set(0xffffff);

        mat.needsUpdate = true;

        setHasSelection(true);

    }, []);

    useEffect(() => {

        if (!containerRef.current) return;

        const container = containerRef.current;

        const width = container.clientWidth;

        const height = container.clientHeight;

        

        const scene = new THREE.Scene();

        scene.background = new THREE.Color(0x1a1a2e); 

        

        

        

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);

        camera.position.set(0, 0, 5); 

        

        const renderer = new THREE.WebGLRenderer({ antialias: true }); 

        renderer.setSize(width, height);

        renderer.setPixelRatio(window.devicePixelRatio); 

        container.appendChild(renderer.domElement); 

        

        const controls = new TrackballControls(camera, renderer.domElement);

        controls.rotateSpeed = 3.0; 

        controls.panSpeed = 0.8; 

        controls.zoomSpeed = 1.2; 

        

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

        

        

        function animate() {

            const id = requestAnimationFrame(animate);

            if (sceneRef.current) sceneRef.current.animationId = id;

            controls.update(); 

            renderer.render(scene, camera); 

        }

        animate();

        

        function onResize() {

            if (!container) return;

            const w = container.clientWidth;

            const h = container.clientHeight;

            camera.aspect = w / h;

            camera.updateProjectionMatrix();

            renderer.setSize(w, h);

            if (lassoCanvasRef.current) {

                lassoCanvasRef.current.width = w;

                lassoCanvasRef.current.height = h;

            }

        }

        window.addEventListener("resize", onResize);

        

        return () => {

            window.removeEventListener("resize", onResize);

            if (sceneRef.current) cancelAnimationFrame(sceneRef.current.animationId);

            renderer.dispose(); 

            controls.dispose(); 

            container.removeChild(renderer.domElement); 

        };

    }, []);

    const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    
    const file = e.target.files?.[0];
    
    if (!file || !sceneRef.current) return;
    
    if (!file.name.endsWith(".pcd")) {
    
    setError("请上传 .pcd 格式的文件");
    
    return;
    
    }
    
    setLoading("加载中...");
    
    setError(null);
    
    setFileName(file.name);
    
    
    
    const reader = new FileReader();
    
    reader.onload = (event) => {
    
    const data = event.target?.result;
    
    if (!data || !sceneRef.current) return;
    
    const { scene, camera } = sceneRef.current;
    
    
    
    if (sceneRef.current.pointCloud) {
    
    scene.remove(sceneRef.current.pointCloud);
    
    sceneRef.current.pointCloud.geometry.dispose();
    
    if (sceneRef.current.pointCloud.material instanceof THREE.Material)
    
    sceneRef.current.pointCloud.material.dispose();
    
    }
    
    if (originalGeometryRef.current) {
    
    originalGeometryRef.current.dispose();
    
    originalGeometryRef.current = null;
    
    }
    
    selectedMaskRef.current = null;
    
    clearPrecomputed();
    
    setHasSelection(false);
    
    try {
    
    
    
    const loader = new PCDLoader();
    
    const points = loader.parse(data as ArrayBuffer);
    
    const material = points.material as THREE.PointsMaterial;
    
    material.size = 0.02; 
    
    material.color.set(0xffffff); 
    
    material.sizeAttenuation = true; 
    
    
    
    scene.add(points);
    
    sceneRef.current.pointCloud = points;
    
    originalGeometryRef.current = points.geometry.clone(); 
    
    
    
    const geometry = points.geometry;
    
    geometry.computeBoundingBox();
    
    const bbox = geometry.boundingBox!;
    
    const center = new THREE.Vector3();
    
    bbox.getCenter(center); 
    
    const size = new THREE.Vector3();
    
    bbox.getSize(size); 
    
    const maxDim = Math.max(size.x, size.y, size.z); 
    
    
    
    camera.position.set(
    
    center.x + maxDim,
    
    center.y + maxDim * 0.5,
    
    center.z + maxDim
    
    );
    
    camera.lookAt(center); 
    
    sceneRef.current.controls.target.copy(center); 
    
    sceneRef.current.controls.update();
    
    setLoading(null);
    
    } catch (err) {
    
    setError(`解析 PCD 文件失败: ${String(err)}`);
    
    setLoading(null);
    
    }
    
    };
    
    reader.onerror = () => {
    
    setError("读取文件失败");
    
    setLoading(null);
    
    };
    
    reader.readAsArrayBuffer(file);
    
    };
    
    const drawLassoPath = useCallback(

        (canvas: HTMLCanvasElement, closed: boolean) => {

            const ctx = canvas.getContext("2d");

            if (!ctx) return;

            const path = lassoPathRef.current;

            if (path.length < 2) return;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            

            ctx.beginPath();

            ctx.moveTo(path[0].x, path[0].y);

            for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);

            if (closed) ctx.closePath();

            ctx.fillStyle = "rgba(0, 200, 255, 0.08)"; 

            ctx.fill();

            ctx.strokeStyle = "rgba(0, 200, 255, 0.25)"; 

            ctx.lineWidth = 6;

            ctx.lineJoin = "round";

            ctx.lineCap = "round";

            ctx.stroke();

            

            ctx.beginPath();

            ctx.moveTo(path[0].x, path[0].y);

            for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);

            if (closed) ctx.closePath();

            ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";

            ctx.lineWidth = 1.5;

            ctx.setLineDash([]); 

            ctx.stroke();

            

            ctx.beginPath();

            ctx.moveTo(path[0].x, path[0].y);

            for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);

            if (closed) ctx.closePath();

            ctx.strokeStyle = "rgba(0, 200, 255, 0.9)";

            ctx.lineWidth = 1.5;

            ctx.setLineDash([6, 4]); 

            ctx.lineDashOffset = -marchingOffsetRef.current; 

            ctx.stroke();

            ctx.setLineDash([]); 

            

            const nodeInterval = Math.max(1, Math.floor(path.length / 20)); 

            for (let i = 0; i < path.length; i += nodeInterval) {

                const p = path[i];

                

                ctx.beginPath();

                ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);

                ctx.fillStyle = "rgba(0, 0, 0, 0.5)";

                ctx.fill();

                ctx.strokeStyle = "rgba(0, 200, 255, 0.9)";

                ctx.lineWidth = 1.5;

                ctx.stroke();

                

                ctx.beginPath();

                ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);

                ctx.fillStyle = "#fff";

                ctx.fill();

            }

            

            if (path.length > 0) {

                const s = path[0];

                ctx.beginPath();

                ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);

                ctx.fillStyle = "rgba(0, 200, 255, 0.3)";

                ctx.fill();

                ctx.strokeStyle = "#00c8ff";

                ctx.lineWidth = 2;

                ctx.stroke();

                ctx.beginPath();

                ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);

                ctx.fillStyle = "#fff";

                ctx.fill();

            }

        },

        []

    );

    const startMarchingAnts = useCallback(
    
    (canvas: HTMLCanvasElement) => {
    
    cancelAnimationFrame(marchingAnimIdRef.current);
    
    const tick = () => {
    
    marchingOffsetRef.current = (marchingOffsetRef.current + 0.4) % 20; 
    
    drawLassoPath(canvas, false); 
    
    marchingAnimIdRef.current = requestAnimationFrame(tick);
    
    };
    
    marchingAnimIdRef.current = requestAnimationFrame(tick);
    
    },
    
    [drawLassoPath]
    
    );
    
    const stopMarchingAnts = useCallback(() => {
    
    cancelAnimationFrame(marchingAnimIdRef.current);
    
    }, []);
    
    const handleLassoMouseDown = useCallback(
    
    (e: MouseEvent<HTMLCanvasElement>) => {
    
    if (!lassoMode) return;
    
    isDrawingRef.current = true;
    
    const rect = e.currentTarget.getBoundingClientRect();
    
    lassoPathRef.current = [
    
    { x: e.clientX - rect.left, y: e.clientY - rect.top },
    
    ];
    
    marchingOffsetRef.current = 0;
    
    const ctx = e.currentTarget.getContext("2d");
    
    if (ctx)
    
    ctx.clearRect(0, 0, e.currentTarget.width, e.currentTarget.height);
    
    startMarchingAnts(e.currentTarget);
    
    },
    
    [lassoMode, startMarchingAnts]
    
    );
    
    const handleLassoMouseMove = useCallback(
    
    (e: MouseEvent<HTMLCanvasElement>) => {
    
    if (!isDrawingRef.current || !lassoMode) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    
    lassoPathRef.current.push({
    
    x: e.clientX - rect.left,
    
    y: e.clientY - rect.top,
    
    });
    
    },
    
    [lassoMode]
    
    );
    
    const handleLassoMouseUp = useCallback(async () => {

        if (!isDrawingRef.current) return;

        isDrawingRef.current = false;

        stopMarchingAnts();

        if (lassoCanvasRef.current) {

            const ctx = lassoCanvasRef.current.getContext("2d");

            ctx?.clearRect(

                0,

                0,

                lassoCanvasRef.current.width,

                lassoCanvasRef.current.height

            );

        }

        exitLassoMode();

        setLoading("计算中...");

        if (lassoActionRef.current === "highlight") {

            await applyLassoAndHighlight();

        } else {

            await applyLassoSelection();

        }

        setLoading(null);

    }, [

        applyLassoSelection,

        applyLassoAndHighlight,

        stopMarchingAnts,

        exitLassoMode,

    ]);

    useEffect(() => {
        if (!containerRef.current || !lassoCanvasRef.current) return;

        lassoCanvasRef.current.width = containerRef.current.clientWidth;
        lassoCanvasRef.current.height = containerRef.current.clientHeight;
    });

    return (
        <div
            style={{
                position: "relative",
                width: "100vw",
                height: "100vh",
                overflow: "hidden",
                background: "#1a1a2e",
            }}
        >
            <div
                ref={containerRef}
                style={{
                    position: "absolute",
                    inset: 0,
                }}
            />

            
            <canvas
                ref={lassoCanvasRef}
                onMouseDown={handleLassoMouseDown}
                onMouseMove={handleLassoMouseMove}
                onMouseUp={handleLassoMouseUp}
                onMouseLeave={handleLassoMouseUp}
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    zIndex: 2,
                    pointerEvents: lassoMode ? "auto" : "none",
                    cursor: lassoMode ? "crosshair" : "default",
                }}
            />

            <div
                style={{
                    position: "absolute",
                    top: 16,
                    left: 16,
                    zIndex: 3,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    alignItems: "center",
                }}
            >
                <label
                    style={{
                        padding: "8px 20px",
                        background: "rgba(99, 102, 241, 0.9)",
                        color: "#fff",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 500,
                        backdropFilter: "blur(8px)",
                    }}
                >
                    选择 PCD 文件
                    <input
                        type="file"
                        accept=".pcd"
                        onChange={handleFileUpload}
                        style={{ display: "none" }}
                    />
                </label>

                <button
                    type="button"
                    onClick={() =>
                        lassoMode ? exitLassoMode() : enterLassoMode("filter")
                    }
                    style={{
                        padding: "8px 20px",
                        background:
                            lassoMode && lassoAction === "filter"
                                ? "rgba(239, 68, 68, 0.9)"
                                : "rgba(99, 102, 241, 0.9)",
                        color: "#fff",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 500,
                        border: "none",
                        backdropFilter: "blur(8px)",
                    }}
                >
                    {lassoMode && lassoAction === "filter"
                        ? "退出套索"
                        : "套索选择"}
                </button>

                <button
                    type="button"
                    onClick={() =>
                        lassoMode ? exitLassoMode() : enterLassoMode("highlight")
                    }
                    style={{
                        padding: "8px 20px",
                        background:
                            lassoMode && lassoAction === "highlight"
                                ? "rgba(239, 68, 68, 0.9)"
                                : "rgba(245, 158, 11, 0.9)",
                        color: "#fff",
                        borderRadius: 8,
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 500,
                        border: "none",
                        backdropFilter: "blur(8px)",
                    }}
                >
                    {lassoMode && lassoAction === "highlight"
                        ? "退出套索"
                        : "套索选中并上色"}
                </button>

                {hasSelection && (
                    <button
                        type="button"
                        onClick={highlightSelection}
                        style={{
                            padding: "8px 20px",
                            background: "rgba(144, 238, 144, 0.9)",
                            color: "#1a1a2e",
                            borderRadius: 8,
                            cursor: "pointer",
                            fontSize: 14,
                            fontWeight: 500,
                            border: "none",
                            backdropFilter: "blur(8px)",
                        }}
                    >
                        标记上色
                    </button>
                )}

                {hasSelection && (
                    <button
                        type="button"
                        onClick={resetSelection}
                        style={{
                            padding: "8px 20px",
                            background: "rgba(34, 197, 94, 0.9)",
                            color: "#fff",
                            borderRadius: 8,
                            cursor: "pointer",
                            fontSize: 14,
                            fontWeight: 500,
                            border: "none",
                            backdropFilter: "blur(8px)",
                        }}
                    >
                        重置选区
                    </button>
                )}

                {fileName && (
                    <span
                        style={{
                            color: "#e0e0e0",
                            fontSize: 13,
                            background: "rgba(0,0,0,0.5)",
                            padding: "6px 12px",
                            borderRadius: 6,
                        }}
                    >
                        {fileName}
                    </span>
                )}
            </div>

            {lassoMode && (
                <div
                    style={{
                        position: "absolute",
                        top: 64,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 3,
                        color: "#fff",
                        fontSize: 14,
                        background: "rgba(239, 68, 68, 0.8)",
                        padding: "8px 20px",
                        borderRadius: 8,
                        backdropFilter: "blur(8px)",
                    }}
                >
                    套索模式：在画面上拖拽绘制选区
                </div>
            )}

            {loading && (
                <div
                    style={{
                        position: "absolute",
                        top: "50%",
                        left: "50%",
                        transform: "translate(-50%, -50%)",
                        zIndex: 3,
                        color: "#fff",
                        fontSize: 18,
                        background: "rgba(0,0,0,0.7)",
                        padding: "16px 32px",
                        borderRadius: 12,
                    }}
                >
                    {loading}
                </div>
            )}

            {error && (
                <div
                    style={{
                        position: "absolute",
                        bottom: 20,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 3,
                        color: "#ff6b6b",
                        fontSize: 14,
                        background: "rgba(0,0,0,0.7)",
                        padding: "10px 20px",
                        borderRadius: 8,
                    }}
                >
                    {error}
                </div>
            )}

            <div
                style={{
                    position: "absolute",
                    right: 16,
                    bottom: 16,
                    zIndex: 3,
                    color: "rgba(255,255,255,0.65)",
                    fontSize: 12,
                    textAlign: "right",
                    lineHeight: 1.8,
                }}
            >
                <div>左键拖拽：旋转</div>
                <div>右键拖拽：平移</div>
                <div>滚轮：缩放</div>
            </div>
        </div>
    );
}
