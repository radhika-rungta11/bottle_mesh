import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

let scene;
let camera;
let renderer;
let orbitControls;

let objLoader;
let gltfExporter;

let originalReferenceMesh = null;
let optimizedGeometryBase = null;
let processedAssetGroup = null;
let bodyTexture = null;

function log(msg) {
    const debugEl = document.getElementById('debugStatus');
    const timestamp = new Date().toLocaleTimeString([], {
        hour12: false,
        minute: '2-digit',
        second: '2-digit'
    });
    debugEl.innerText = `[${timestamp}] ${msg}\n` + debugEl.innerText;
}

function showLoading(show, text = 'Processing...') {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
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

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
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

    bindUI();
    animate();

    window.addEventListener('resize', onWindowResize);
}

function bindUI() {
    document.getElementById('optimizedObjInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        loadOBJFile(file, 'optimized');
    });

    document.getElementById('originalObjInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        loadOBJFile(file, 'original');
    });

    document.getElementById('labelTextureInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        loadLabelTexture(file);
    });

    document.getElementById('topRegionSlider').addEventListener('input', () => {
        document.getElementById('topRegionDisplay').textContent =
            `${document.getElementById('topRegionSlider').value}%`;
    });

    document.getElementById('bottomRegionSlider').addEventListener('input', () => {
        document.getElementById('bottomRegionDisplay').textContent =
            `${document.getElementById('bottomRegionSlider').value}%`;
    });

    document.getElementById('topRegionSlider').addEventListener('change', rebuildProcessedAsset);
    document.getElementById('bottomRegionSlider').addEventListener('change', rebuildProcessedAsset);
    document.getElementById('capColorInput').addEventListener('input', rebuildProcessedAsset);

    document.getElementById('showReference').addEventListener('change', (e) => {
        if (originalReferenceMesh) {
            originalReferenceMesh.visible = e.target.checked;
        }
    });

    document.getElementById('rebuildBtn').addEventListener('click', rebuildProcessedAsset);
    document.getElementById('exportGlbBtn').addEventListener('click', exportGLB);
}

function animate() {
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

function loadOBJFile(file, kind) {
    const url = URL.createObjectURL(file);
    showLoading(true, `Loading ${kind} OBJ...`);

    objLoader.load(
        url,
        (object) => {
            try {
                const mergedGeometry = collectMergedGeometry(object);

                if (!mergedGeometry) {
                    log(`No mesh geometry found in ${file.name}`);
                    showLoading(false);
                    URL.revokeObjectURL(url);
                    return;
                }

                mergedGeometry.computeBoundingBox();
                mergedGeometry.computeVertexNormals();

                if (kind === 'original') {
                    setOriginalReference(mergedGeometry);
                    log(`Loaded original OBJ: ${file.name}`);
                } else {
                    optimizedGeometryBase = mergedGeometry;
                    document.getElementById('controls').classList.remove('hidden');
                    rebuildProcessedAsset();
                    log(`Loaded optimized OBJ: ${file.name}`);
                }

                showLoading(false);
                URL.revokeObjectURL(url);
            } catch (error) {
                console.error(error);
                log(`Error while processing ${file.name}`);
                showLoading(false);
                URL.revokeObjectURL(url);
            }
        },
        undefined,
        (error) => {
            console.error(error);
            log(`Failed to load ${file.name}`);
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

function setOriginalReference(geometry) {
    if (originalReferenceMesh) {
        scene.remove(originalReferenceMesh);
    }

    const material = new THREE.MeshBasicMaterial({
        color: 0x60a5fa,
        wireframe: true,
        transparent: true,
        opacity: 0.35,
        depthWrite: false
    });

    originalReferenceMesh = new THREE.Mesh(geometry, material);
    originalReferenceMesh.visible = document.getElementById('showReference').checked;
    originalReferenceMesh.name = 'Original_Reference';

    scene.add(originalReferenceMesh);

    if (!processedAssetGroup) {
        frameObject(originalReferenceMesh);
    }
}

function loadLabelTexture(file) {
    const url = URL.createObjectURL(file);
    const textureLoader = new THREE.TextureLoader();

    showLoading(true, 'Loading body label texture...');

    textureLoader.load(
        
        url,
        (texture) => {
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            // texture.flipY = false;

            if ('colorSpace' in texture) {
                texture.colorSpace = THREE.SRGBColorSpace;
            } else {
                texture.encoding = THREE.sRGBEncoding;
            }

            texture.needsUpdate = true;
            bodyTexture = texture;

            log(`Loaded label texture: ${file.name}`);
            showLoading(false);
            URL.revokeObjectURL(url);

            rebuildProcessedAsset();
        },
        undefined,
        (error) => {
            console.error(error);
            log(`Failed to load label texture: ${file.name}`);
            showLoading(false);
            URL.revokeObjectURL(url);
        }
    );
}

function rebuildProcessedAsset() {
    if (!optimizedGeometryBase) {
        log('Upload the optimized OBJ first.');
        return;
    }

    if (processedAssetGroup) {
        scene.remove(processedAssetGroup);
    }

    const geometry = optimizedGeometryBase.clone();
    geometry.computeBoundingBox();

    const box = geometry.boundingBox.clone();
    const totalHeight = Math.max(box.max.y - box.min.y, 0.0001);

    const topPercent = parseFloat(document.getElementById('topRegionSlider').value) / 100;
    const bottomPercent = parseFloat(document.getElementById('bottomRegionSlider').value) / 100;

    const bodyMinY = box.min.y + totalHeight * bottomPercent;
    const bodyMaxY = box.max.y - totalHeight * topPercent;

    const split = splitGeometryIntoRegions(geometry, box, bodyMinY, bodyMaxY);

    processedAssetGroup = new THREE.Group();
    processedAssetGroup.name = 'Processed_Textured_Asset';

    if (split.body.positions.length > 0) {
        const bodyGeometry = buildGeometryFromArrays(split.body);

        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: bodyTexture ? 0xffffff : 0xd4d4d8,
            map: bodyTexture || null,
            roughness: 0.62,
            metalness: 0.06
        });

        const bodyMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
        bodyMesh.name = 'Bottle_Body';
        processedAssetGroup.add(bodyMesh);
    }

    if (split.cap.positions.length > 0) {
        const capGeometry = buildGeometryFromArrays(split.cap);

        const capMaterial = new THREE.MeshStandardMaterial({
            color: new THREE.Color(document.getElementById('capColorInput').value),
            roughness: 0.75,
            metalness: 0.03
        });

        const capMesh = new THREE.Mesh(capGeometry, capMaterial);
        capMesh.name = 'Bottle_Cap';
        processedAssetGroup.add(capMesh);
    }

    scene.add(processedAssetGroup);
    frameObject(processedAssetGroup);

    const bodyTriangleCount = split.body.positions.length / 9;
    const capTriangleCount = split.cap.positions.length / 9;

    log(
        `Rebuilt textured asset | body triangles: ${bodyTriangleCount} | cap/top-bottom triangles: ${capTriangleCount}`
    );
}

function splitGeometryIntoRegions(geometry, box, bodyMinY, bodyMaxY) {
    const positionArray = geometry.attributes.position.array;
    const normalArray = geometry.attributes.normal.array;

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

    for (let i = 0; i < positionArray.length; i += 9) {
        const p0 = new THREE.Vector3(positionArray[i], positionArray[i + 1], positionArray[i + 2]);
        const p1 = new THREE.Vector3(positionArray[i + 3], positionArray[i + 4], positionArray[i + 5]);
        const p2 = new THREE.Vector3(positionArray[i + 6], positionArray[i + 7], positionArray[i + 8]);

        const centroidY = (p0.y + p1.y + p2.y) / 3;

        const n0 = [normalArray[i], normalArray[i + 1], normalArray[i + 2]];
        const n1 = [normalArray[i + 3], normalArray[i + 4], normalArray[i + 5]];
        const n2 = [normalArray[i + 6], normalArray[i + 7], normalArray[i + 8]];

        if (centroidY >= bodyMinY && centroidY <= bodyMaxY) {
            const uvSet = makeCylinderTriangleUVs(
                p0,
                p1,
                p2,
                centerX,
                centerZ,
                bodyMinY,
                bodyHeight
            );

            pushVertex(body, p0, n0, uvSet[0]);
            pushVertex(body, p1, n1, uvSet[1]);
            pushVertex(body, p2, n2, uvSet[2]);
        } else {
            const uvSet = makePlanarTriangleUVs(p0, p1, p2, box);

            pushVertex(cap, p0, n0, uvSet[0]);
            pushVertex(cap, p1, n1, uvSet[1]);
            pushVertex(cap, p2, n2, uvSet[2]);
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
    if (!processedAssetGroup) {
        log('Nothing to export. Upload the optimized OBJ first.');
        return;
    }

    showLoading(true, 'Exporting GLB...');

    try {
        gltfExporter.parse(
            processedAssetGroup,
            (result) => {
                let blob;

                if (result instanceof ArrayBuffer) {
                    blob = new Blob([result], { type: 'model/gltf-binary' });
                    downloadBlob(blob, 'optimized_textured.glb');
                    log('Exported optimized_textured.glb');
                } else {
                    const json = JSON.stringify(result, null, 2);
                    blob = new Blob([json], { type: 'application/json' });
                    downloadBlob(blob, 'optimized_textured.gltf');
                    log('Exporter returned JSON instead of binary, so exported optimized_textured.gltf');
                }

                showLoading(false);
            },
            (error) => {
                console.error(error);
                log('GLB export failed.');
                showLoading(false);
            },
            {
                binary: true,
                onlyVisible: true,
                embedImages: true
            }
        );
    } catch (error) {
        console.error(error);
        showLoading(false);
        log('GLB export failed.');
    }
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();

    URL.revokeObjectURL(url);
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

window.onload = init;