import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';

let scene;
let camera;
let renderer;
let orbitControls;

let objLoader;
let gltfExporter;
let usdzLoader;

let optimizedGeometryBase = null;
let processedAssetGroup = null;

let originalUsdWireframe = null;
let sourceUsdTexture = null;

function log(msg) {
    const debugEl = document.getElementById('debugStatus');
    if (!debugEl) {
        console.log(msg);
        return;
    }

    const timestamp = new Date().toLocaleTimeString([], {
        hour12: false,
        minute: '2-digit',
        second: '2-digit'
    });

    debugEl.innerText = `[${timestamp}] ${msg}\n` + debugEl.innerText;
}

function showLoading(show, text = 'Processing...') {
    const loadingEl = document.getElementById('loading');
    const loadingTextEl = document.getElementById('loadingText');

    if (loadingTextEl) {
        loadingTextEl.textContent = text;
    }

    if (loadingEl) {
        loadingEl.style.display = show ? 'flex' : 'none';
    }
}

function setControlsVisible() {
    const controls = document.getElementById('controls');
    if (controls) {
        controls.classList.remove('hidden');
    }
}

function setButtonState(hasOptimizedObj, hasProcessedAsset = false) {
    const rebuildBtn = document.getElementById('rebuildBtn');
    const exportGlbBtn = document.getElementById('exportGlbBtn');

    if (rebuildBtn) {
        rebuildBtn.disabled = !hasOptimizedObj;
        rebuildBtn.style.opacity = hasOptimizedObj ? '1' : '0.5';
        rebuildBtn.style.cursor = hasOptimizedObj ? 'pointer' : 'not-allowed';
    }

    if (exportGlbBtn) {
        exportGlbBtn.disabled = !hasProcessedAsset;
        exportGlbBtn.style.opacity = hasProcessedAsset ? '1' : '0.5';
        exportGlbBtn.style.cursor = hasProcessedAsset ? 'pointer' : 'not-allowed';
    }
}

function updateSliderDisplays() {
    const topRegionSlider = document.getElementById('topRegionSlider');
    const bottomRegionSlider = document.getElementById('bottomRegionSlider');
    const topRegionDisplay = document.getElementById('topRegionDisplay');
    const bottomRegionDisplay = document.getElementById('bottomRegionDisplay');

    if (topRegionSlider && topRegionDisplay) {
        topRegionDisplay.textContent = `${topRegionSlider.value}%`;
    }

    if (bottomRegionSlider && bottomRegionDisplay) {
        bottomRegionDisplay.textContent = `${bottomRegionSlider.value}%`;
    }
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        0.01,
        2000
    );
    camera.position.set(3, 3, 3);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    if ('outputColorSpace' in renderer) {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else {
        renderer.outputEncoding = THREE.sRGBEncoding;
    }

    renderer.domElement.style.position = 'fixed';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.zIndex = '0';

    document.body.appendChild(renderer.domElement);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(5, 10, 6);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-5, 3, -4);
    scene.add(fillLight);

    objLoader = new OBJLoader();
    gltfExporter = new GLTFExporter();
    usdzLoader = new USDZLoader();

    bindUI();
    updateSliderDisplays();
    setControlsVisible();
    setButtonState(false, false);

    animate();
    window.addEventListener('resize', onWindowResize);

    log('Ready. Upload the optimized OBJ first. Then upload the original USDZ. Rebuild and export.');
}

function bindUI() {
    const optimizedObjInput = document.getElementById('optimizedObjInput');
    const originalUsdInput = document.getElementById('originalUsdInput');
    const topRegionSlider = document.getElementById('topRegionSlider');
    const bottomRegionSlider = document.getElementById('bottomRegionSlider');
    const capColorInput = document.getElementById('capColorInput');
    const showReference = document.getElementById('showReference');
    const rebuildBtn = document.getElementById('rebuildBtn');
    const exportGlbBtn = document.getElementById('exportGlbBtn');

    if (!optimizedObjInput) log('Missing HTML element: #optimizedObjInput');
    if (!originalUsdInput) log('Missing HTML element: #originalUsdInput');
    if (!topRegionSlider) log('Missing HTML element: #topRegionSlider');
    if (!bottomRegionSlider) log('Missing HTML element: #bottomRegionSlider');
    if (!capColorInput) log('Missing HTML element: #capColorInput');
    if (!showReference) log('Missing HTML element: #showReference');
    if (!rebuildBtn) log('Missing HTML element: #rebuildBtn');
    if (!exportGlbBtn) log('Missing HTML element: #exportGlbBtn');

    if (optimizedObjInput) {
        optimizedObjInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            loadOptimizedOBJ(file);
        });
    }

    if (originalUsdInput) {
        originalUsdInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            loadUSDFile(file);
        });
    }

    if (topRegionSlider) {
        topRegionSlider.addEventListener('input', updateSliderDisplays);
        topRegionSlider.addEventListener('change', () => {
            if (optimizedGeometryBase) {
                rebuildProcessedAsset();
            }
        });
    }

    if (bottomRegionSlider) {
        bottomRegionSlider.addEventListener('input', updateSliderDisplays);
        bottomRegionSlider.addEventListener('change', () => {
            if (optimizedGeometryBase) {
                rebuildProcessedAsset();
            }
        });
    }

    if (capColorInput) {
        capColorInput.addEventListener('input', () => {
            if (optimizedGeometryBase) {
                rebuildProcessedAsset();
            }
        });
    }

    if (showReference) {
        showReference.addEventListener('change', (e) => {
            if (originalUsdWireframe) {
                originalUsdWireframe.visible = e.target.checked;
            }
        });
    }

    if (rebuildBtn) {
        rebuildBtn.addEventListener('click', () => {
            if (!optimizedGeometryBase) {
                log('Upload the optimized OBJ first.');
                return;
            }
            rebuildProcessedAsset();
        });
    }

    if (exportGlbBtn) {
        exportGlbBtn.addEventListener('click', () => {
            exportGLB();
        });
    }
}

function animate() {
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

function loadOptimizedOBJ(file) {
    const fileName = file.name.toLowerCase();

    if (!fileName.endsWith('.obj')) {
        alert('Please upload an OBJ file.');
        log(`Rejected file: ${file.name}. Expected .obj`);
        return;
    }

    const url = URL.createObjectURL(file);
    showLoading(true, 'Loading optimized OBJ...');
    setButtonState(false, false);

    objLoader.load(
        url,
        (object) => {
            try {
                const mergedGeometry = collectMergedGeometry(object);

                if (!mergedGeometry) {
                    log(`No mesh geometry found in ${file.name}`);
                    optimizedGeometryBase = null;
                    showLoading(false);
                    setButtonState(false, false);
                    URL.revokeObjectURL(url);
                    return;
                }

                mergedGeometry.computeBoundingBox();
                mergedGeometry.computeVertexNormals();

                optimizedGeometryBase = mergedGeometry;

                log(`Loaded optimized OBJ: ${file.name}`);
                showLoading(false);
                URL.revokeObjectURL(url);

                rebuildProcessedAsset();
            } catch (error) {
                console.error(error);
                optimizedGeometryBase = null;
                log(`Error while processing ${file.name}: ${error.message}`);
                showLoading(false);
                setButtonState(false, false);
                URL.revokeObjectURL(url);
            }
        },
        undefined,
        (error) => {
            console.error(error);
            optimizedGeometryBase = null;
            log(`Failed to load optimized OBJ: ${file.name}`);
            showLoading(false);
            setButtonState(false, false);
            URL.revokeObjectURL(url);
        }
    );
}

function loadUSDFile(file) {
    const fileName = file.name.toLowerCase();

    if (!fileName.endsWith('.usdz')) {
        alert('Please upload a .usdz file only.');
        log(`Rejected file: ${file.name}. This page currently supports USDZ only.`);
        return;
    }

    const url = URL.createObjectURL(file);
    showLoading(true, 'Loading original USDZ...');

    usdzLoader.load(
        url,
        async (usdObject) => {
            try {
                const root = usdObject?.scene || usdObject;

                if (!root) {
                    throw new Error('USDZ loaded but no scene/object was returned.');
                }

                setOriginalUsdReference(root);

                const extractedTexture = extractTextureFromUSD(root);

                if (extractedTexture) {
                    const exportableTexture = await makeExportableTexture(extractedTexture);

                    if (exportableTexture) {
                        sourceUsdTexture = exportableTexture;
                        log(`USDZ texture extracted and prepared successfully from ${file.name}`);
                    } else {
                        sourceUsdTexture = null;
                        log(`A texture was found in ${file.name}, but it could not be prepared for export.`);
                    }
                } else {
                    sourceUsdTexture = null;
                    log(`USDZ loaded, but no usable texture map was found in ${file.name}`);
                }

                showLoading(false);
                URL.revokeObjectURL(url);

                if (optimizedGeometryBase) {
                    rebuildProcessedAsset();
                }
            } catch (error) {
                console.error(error);
                sourceUsdTexture = null;
                log(`Error while processing USDZ: ${error.message}`);
                showLoading(false);
                URL.revokeObjectURL(url);
            }
        },
        undefined,
        (error) => {
            console.error(error);
            sourceUsdTexture = null;
            log(`Failed to load USDZ: ${file.name}`);
            showLoading(false);
            URL.revokeObjectURL(url);
        }
    );
}

function collectMergedGeometry(object) {
    const geometries = [];

    object.updateMatrixWorld(true);

    object.traverse((child) => {
        if (child.isMesh && child.geometry) {
            let geometry = child.geometry.clone();
            geometry.applyMatrix4(child.matrixWorld);

            if (geometry.index) {
                geometry = geometry.toNonIndexed();
            }

            if (!geometry.attributes.normal) {
                geometry.computeVertexNormals();
            }

            geometries.push(geometry);
        }
    });

    if (geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    if (BufferGeometryUtils.mergeGeometries) {
        return BufferGeometryUtils.mergeGeometries(geometries, false);
    }

    if (BufferGeometryUtils.mergeBufferGeometries) {
        return BufferGeometryUtils.mergeBufferGeometries(geometries, false);
    }

    throw new Error('No merge geometry function available in BufferGeometryUtils.');
}

function clearProcessedAsset() {
    if (!processedAssetGroup) return;

    scene.remove(processedAssetGroup);

    processedAssetGroup.traverse((child) => {
        if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();

            if (Array.isArray(child.material)) {
                child.material.forEach((mat) => mat.dispose && mat.dispose());
            } else if (child.material) {
                child.material.dispose && child.material.dispose();
            }
        }
    });

    processedAssetGroup = null;
}

function setOriginalUsdReference(root) {
    if (originalUsdWireframe) {
        scene.remove(originalUsdWireframe);

        if (originalUsdWireframe.geometry) {
            originalUsdWireframe.geometry.dispose();
        }

        if (originalUsdWireframe.material) {
            originalUsdWireframe.material.dispose();
        }

        originalUsdWireframe = null;
    }

    const mergedGeometry = collectMergedGeometry(root);

    if (!mergedGeometry) {
        log('USDZ reference loaded, but no mesh geometry was found for wireframe preview.');
        return;
    }

    const material = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        wireframe: true,
        transparent: true,
        opacity: 0.35,
        depthWrite: false
    });

    originalUsdWireframe = new THREE.Mesh(mergedGeometry, material);
    originalUsdWireframe.name = 'Original_USDZ_Reference';
    originalUsdWireframe.visible = document.getElementById('showReference')?.checked ?? true;

    scene.add(originalUsdWireframe);

    if (!processedAssetGroup) {
        frameObject(originalUsdWireframe);
    }
}

function extractTextureFromUSD(root) {
    let foundTexture = null;
    let foundFrom = '';

    root.traverse((child) => {
        if (foundTexture || !child.isMesh || !child.material) return;

        const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];

        for (const material of materials) {
            if (!material) continue;

            const candidates = [
                ['map', material.map],
                ['emissiveMap', material.emissiveMap],
                ['specularColorMap', material.specularColorMap],
                ['metalnessMap', material.metalnessMap],
                ['roughnessMap', material.roughnessMap]
            ];
             for (const [slotName, tex] of candidates) {
                if (tex && tex.image) {
                    foundTexture = tex;
                    foundFrom = `${child.name || 'unnamed-mesh'} -> ${material.name || material.type} -> ${slotName}`;
                    break;
                }
            }

            if (foundTexture) break;
        }
    });

    if (foundTexture) {
        const img = foundTexture.image;
        const w = img?.naturalWidth || img?.videoWidth || img?.width || '?';
        const h = img?.naturalHeight || img?.videoHeight || img?.height || '?';
        log(`Found texture in USDZ: ${foundFrom} (${w}x${h})`);
        return foundTexture;
    }

    log('No usable bitmap texture was found inside the USDZ materials.');
    return null;

} 
async function makeExportableTexture(texture) {
    if (!texture || !texture.image) {
        return null;
    }

    const image = texture.image;
    const width = image.naturalWidth || image.videoWidth || image.width;
    const height = image.naturalHeight || image.videoHeight || image.height;

    if (!width || !height) {
        log('Texture was found, but its image has no valid size.');
        return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        log('Failed to create canvas context for texture conversion.');
        return null;
    }

    try {
        ctx.drawImage(image, 0, 0, width, height);
    } catch (error) {
        console.error(error);
        log(`Failed to draw USDZ texture onto canvas: ${error.message}`);
        return null;
    }

    const safeTexture = new THREE.CanvasTexture(canvas);
    safeTexture.wrapS = texture.wrapS ?? THREE.RepeatWrapping;
    safeTexture.wrapT = texture.wrapT ?? THREE.ClampToEdgeWrapping;
    safeTexture.flipY = texture.flipY;
    safeTexture.needsUpdate = true;

    if ('colorSpace' in safeTexture) {
        safeTexture.colorSpace = THREE.SRGBColorSpace;
    } else {
        safeTexture.encoding = THREE.sRGBEncoding;
    }

    log(`Prepared texture for GLB export (${width}x${height}).`);
    return safeTexture;
}
function rebuildProcessedAsset() {
    if (!optimizedGeometryBase) {
        log('Upload the optimized OBJ first.');
        setButtonState(false, false);
        return;
    }

    clearProcessedAsset();

    const topRegionSlider = document.getElementById('topRegionSlider');
    const bottomRegionSlider = document.getElementById('bottomRegionSlider');
    const capColorInput = document.getElementById('capColorInput');

    if (!topRegionSlider || !bottomRegionSlider || !capColorInput) {
        log('Missing one or more UI inputs needed for rebuild.');
        setButtonState(true, false);
        return;
    }

    const geometry = optimizedGeometryBase.clone();
    geometry.computeBoundingBox();

    const box = geometry.boundingBox.clone();
    const totalHeight = Math.max(box.max.y - box.min.y, 0.0001);

    const topPercent = parseFloat(topRegionSlider.value) / 100;
    const bottomPercent = parseFloat(bottomRegionSlider.value) / 100;

    const bodyMinY = box.min.y + totalHeight * bottomPercent;
    const bodyMaxY = box.max.y - totalHeight * topPercent;

    const split = splitGeometryIntoRegions(geometry, box, bodyMinY, bodyMaxY);

    processedAssetGroup = new THREE.Group();
    processedAssetGroup.name = 'Processed_Textured_Asset';

    if (split.body.positions.length > 0) {
        const bodyGeometry = buildGeometryFromArrays(split.body);

        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: sourceUsdTexture ? 0xffffff : 0xd4d4d8,
            map: sourceUsdTexture || null,
            roughness: 0.62,
            metalness: 0.06
        });

        if (sourceUsdTexture) {
            sourceUsdTexture.needsUpdate = true;
        }

        const bodyMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
        bodyMesh.name = 'Bottle_Body';
        processedAssetGroup.add(bodyMesh);
    }

    if (split.cap.positions.length > 0) {
        const capGeometry = buildGeometryFromArrays(split.cap);

        const capMaterial = new THREE.MeshStandardMaterial({
            color: new THREE.Color(capColorInput.value),
            roughness: 0.75,
            metalness: 0.03
        });

        const capMesh = new THREE.Mesh(capGeometry, capMaterial);
        capMesh.name = 'Bottle_Cap';
        processedAssetGroup.add(capMesh);
    }

    if (processedAssetGroup.children.length === 0) {
        log('Rebuild finished, but no output meshes were generated.');
        setButtonState(true, false);
        return;
    }

    scene.add(processedAssetGroup);
    frameObject(processedAssetGroup);

    const bodyTriangleCount = split.body.positions.length / 9;
    const capTriangleCount = split.cap.positions.length / 9;

    log(
        `Rebuilt textured asset | body triangles: ${bodyTriangleCount} | cap/top-bottom triangles: ${capTriangleCount} | texture: ${sourceUsdTexture ? 'USDZ texture applied' : 'no USDZ texture found'}`
    );

    setButtonState(true, true);
}

function splitGeometryIntoRegions(geometry, box, bodyMinY, bodyMaxY) {
    const positionArray = geometry.attributes.position.array;
    const normalArray = geometry.attributes.normal.array;
    const uvArray = geometry.attributes.uv ? geometry.attributes.uv.array : null;

    const centerX = (box.min.x + box.max.x) * 0.5;
    const centerZ = (box.min.z + box.max.z) * 0.5;
    const bodyHeight = Math.max(bodyMaxY - bodyMinY, 0.0001);

    const body = {
        positions: [],
        normals: [],
        uvs: []
    };

    const cap = {
        positions: [],
        normals: [],
        uvs: []
    };

    for (let i = 0, uvIndex = 0; i < positionArray.length; i += 9, uvIndex += 6) {
        const p0 = new THREE.Vector3(positionArray[i], positionArray[i + 1], positionArray[i + 2]);
        const p1 = new THREE.Vector3(positionArray[i + 3], positionArray[i + 4], positionArray[i + 5]);
        const p2 = new THREE.Vector3(positionArray[i + 6], positionArray[i + 7], positionArray[i + 8]);

        const centroidY = (p0.y + p1.y + p2.y) / 3;

        const n0 = [normalArray[i], normalArray[i + 1], normalArray[i + 2]];
        const n1 = [normalArray[i + 3], normalArray[i + 4], normalArray[i + 5]];
        const n2 = [normalArray[i + 6], normalArray[i + 7], normalArray[i + 8]];

        let uv0;
        let uv1;
        let uv2;

        if (uvArray) {
            uv0 = [uvArray[uvIndex], uvArray[uvIndex + 1]];
            uv1 = [uvArray[uvIndex + 2], uvArray[uvIndex + 3]];
            uv2 = [uvArray[uvIndex + 4], uvArray[uvIndex + 5]];
        } else if (centroidY >= bodyMinY && centroidY <= bodyMaxY) {
            const uvSet = makeCylinderTriangleUVs(
                p0,
                p1,
                p2,
                centerX,
                centerZ,
                bodyMinY,
                bodyHeight
            );
            uv0 = uvSet[0];
            uv1 = uvSet[1];
            uv2 = uvSet[2];
        } else {
            const uvSet = makePlanarTriangleUVs(p0, p1, p2, box);
            uv0 = uvSet[0];
            uv1 = uvSet[1];
            uv2 = uvSet[2];
        }

        if (centroidY >= bodyMinY && centroidY <= bodyMaxY) {
            pushVertex(body, p0, n0, uv0);
            pushVertex(body, p1, n1, uv1);
            pushVertex(body, p2, n2, uv2);
        } else {
            pushVertex(cap, p0, n0, uv0);
            pushVertex(cap, p1, n1, uv1);
            pushVertex(cap, p2, n2, uv2);
        }
    }

    return { body, cap };
}

function pushVertex(target, position, normal, uv) {
    target.positions.push(position.x, position.y, position.z);
    target.normals.push(normal[0], normal[1], normal[2]);
    target.uvs.push(uv[0], uv[1]);
}

function makeCylinderTriangleUVs(p0, p1, p2, centerX, centerZ, bodyMinY, bodyHeight) {
    const uv0 = cylinderUV(p0, centerX, centerZ, bodyMinY, bodyHeight);
    const uv1 = cylinderUV(p1, centerX, centerZ, bodyMinY, bodyHeight);
    const uv2 = cylinderUV(p2, centerX, centerZ, bodyMinY, bodyHeight);

    const uValues = [uv0[0], uv1[0], uv2[0]];
    const minU = Math.min(...uValues);
    const maxU = Math.max(...uValues);

    if (maxU - minU > 0.5) {
        if (uv0[0] < 0.5) uv0[0] += 1.0;
        if (uv1[0] < 0.5) uv1[0] += 1.0;
        if (uv2[0] < 0.5) uv2[0] += 1.0;
    }

    return [uv0, uv1, uv2];
}

function cylinderUV(point, centerX, centerZ, bodyMinY, bodyHeight) {
    let u = Math.atan2(point.z - centerZ, point.x - centerX) / (Math.PI * 2.0);

    if (u < 0) {
        u += 1.0;
    }

    const v = THREE.MathUtils.clamp((point.y - bodyMinY) / bodyHeight, 0, 1);

    return [u, v];
}

function makePlanarTriangleUVs(p0, p1, p2, box) {
    return [
        planarUV(p0, box),
        planarUV(p1, box),
        planarUV(p2, box)
    ];
}

function planarUV(point, box) {
    const width = Math.max(box.max.x - box.min.x, 0.0001);
    const depth = Math.max(box.max.z - box.min.z, 0.0001);

    const u = (point.x - box.min.x) / width;
    const v = (point.z - box.min.z) / depth;

    return [u, v];
}

function buildGeometryFromArrays(data) {
    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(data.positions, 3)
    );

    geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(data.normals, 3)
    );

    geometry.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(data.uvs, 2)
    );

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}

function exportGLB() {
    if (!processedAssetGroup || processedAssetGroup.children.length === 0) {
        alert('Nothing to export yet. First upload OBJ and rebuild the textured asset.');
        console.log('Export blocked: no processed asset found.');
        return;
    }

    console.log('Starting GLB export...', processedAssetGroup);
    showLoading(true, 'Exporting GLB...');

    try {
        const exportRoot = processedAssetGroup.clone(true);
        exportRoot.updateMatrixWorld(true);

        gltfExporter.parse(
            exportRoot,
            (result) => {
                try {
                    const blob = new Blob(
                        [result],
                        { type: 'model/gltf-binary' }
                    );

                    const fileName = 'optimized_textured.glb';
                    downloadBlob(blob, fileName);

                    console.log('Export finished:', fileName, 'size:', blob.size);
                    log(`Exported ${fileName} successfully`);
                    alert(`Exported ${fileName}`);
                } catch (err) {
                    console.error('Download failed:', err);
                    alert('Export created data, but download failed. Check console.');
                } finally {
                    showLoading(false);
                }
            },
            (error) => {
                console.error('GLTFExporter error:', error);
                alert('GLB export failed. Check console.');
                showLoading(false);
            },
            {
                binary: true,
                onlyVisible: true
            }
        );
    } catch (error) {
        console.error('Export exception:', error);
        alert(`GLB export failed: ${error.message}`);
        showLoading(false);
    }
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function frameObject(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const fitHeightDistance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    const distance = fitHeightDistance * 1.7;

    camera.near = Math.max(maxDim / 1000, 0.001);
    camera.far = Math.max(maxDim * 100, 10);
    camera.updateProjectionMatrix();

    camera.position.set(
        center.x + distance * 0.7,
        center.y + distance * 0.4,
        center.z + distance * 0.7
    );

    orbitControls.target.copy(center);
    orbitControls.update();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('DOMContentLoaded', init);