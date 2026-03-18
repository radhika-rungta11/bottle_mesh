import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

let scene;
let camera;
let renderer;
let orbitControls;
let originalMesh;
let simplifiedMesh;
let wireframe;
let loader;
let exporter;

function log(msg) {
    const debugEl = document.getElementById('debugStatus');
    const timestamp = new Date().toLocaleTimeString([], {
        hour12: false,
        minute: "2-digit",
        second: "2-digit"
    });
    debugEl.innerText = `[${timestamp}] ${msg}\n` + debugEl.innerText;
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    camera = new THREE.PerspectiveCamera(
        45,
        window.innerWidth / window.innerHeight,
        0.01,
        1000
    );
    camera.position.set(3, 3, 3);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const light1 = new THREE.DirectionalLight(0xffffff, 0.7);
    light1.position.set(5, 10, 5);
    scene.add(light1);

    loader = new OBJLoader();
    exporter = new OBJExporter();

    document.getElementById('fileInput').addEventListener('change', handleFileUpload);

    const updateMesh = () => {
        const radial = parseInt(document.getElementById('ratioSlider').value, 10);
        const slices = parseInt(document.getElementById('sliceSlider').value, 10);

        document.getElementById('ratioDisplay').textContent = `${radial} faces`;
        document.getElementById('sliceDisplay').textContent = `${slices}`;

        fitProfiledCylinder(radial, slices);
    };

    document.getElementById('ratioSlider').addEventListener('change', updateMesh);
    document.getElementById('sliceSlider').addEventListener('change', updateMesh);

    document.getElementById('wireframeToggle').addEventListener('change', (e) => {
        if (wireframe) {
            wireframe.visible = e.target.checked;
        }
    });

    document.getElementById('silhouetteMode').addEventListener('change', (e) => {
        if (!simplifiedMesh) return;

        if (e.target.checked) {
            simplifiedMesh.material.color.setHex(0x000000);
            scene.background.setHex(0xffffff);
        } else {
            simplifiedMesh.material.color.setHex(0xcccccc);
            scene.background.setHex(0x020617);
        }
    });

    document.getElementById('downloadBtn').addEventListener('click', downloadMesh);

    window.addEventListener('resize', onWindowResize);

    animate();
}

function animate() {
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    showLoading(true, "Analyzing Taper Profile...");

    const url = URL.createObjectURL(file);

    loader.load(url, (object) => {
        const geometries = [];

        object.traverse((child) => {
            if (child.isMesh) {
                const geometry = child.geometry.clone();
                child.updateMatrixWorld();
                geometry.applyMatrix4(child.matrixWorld);
                geometries.push(geometry);
            }
        });

        const merged = BufferGeometryUtils.mergeBufferGeometries(geometries);
        originalMesh = new THREE.Mesh(merged);

        fitProfiledCylinder(32, 24);
        document.getElementById('controls').classList.remove('hidden');
        showLoading(false);

        URL.revokeObjectURL(url);
    });
}

function fitProfiledCylinder(radialSegments, verticalSlices) {
    if (!originalMesh) return;

    const geometry = originalMesh.geometry;
    const positions = geometry.attributes.position.array;

    const box = new THREE.Box3().setFromObject(originalMesh);
    const center = box.getCenter(new THREE.Vector3());

    const minY = box.min.y;
    const maxY = box.max.y;
    const height = maxY - minY;

    const slicePoints = [];
    slicePoints.push(new THREE.Vector2(0, minY - center.y));

    const sliceThickness = height / verticalSlices;

    for (let s = 0; s <= verticalSlices; s++) {
        const currentY = minY + (s * sliceThickness);
        const layerRadii = [];

        for (let i = 0; i < positions.length; i += 15) {
            const px = positions[i];
            const py = positions[i + 1];
            const pz = positions[i + 2];

            if (Math.abs(py - currentY) < sliceThickness * 0.8) {
                const dx = px - center.x;
                const dz = pz - center.z;
                const radius = Math.sqrt(dx * dx + dz * dz);
                layerRadii.push(radius);
            }
        }

        let sliceRadius;

        if (layerRadii.length > 0) {
            layerRadii.sort((a, b) => a - b);
            sliceRadius = layerRadii[Math.floor(layerRadii.length * 0.75)];
        } else {
            sliceRadius = slicePoints.length > 1
                ? slicePoints[slicePoints.length - 1].x
                : 0.5;
        }

        slicePoints.push(new THREE.Vector2(sliceRadius, currentY - center.y));
    }

    slicePoints.push(new THREE.Vector2(0, maxY - center.y));

    const latheGeometry = new THREE.LatheGeometry(slicePoints, radialSegments);
    latheGeometry.translate(center.x, center.y, center.z);

    if (simplifiedMesh) {
        scene.remove(simplifiedMesh);
    }

    simplifiedMesh = new THREE.Mesh(
        latheGeometry,
        new THREE.MeshStandardMaterial({
            color: 0xcccccc,
            roughness: 0.5,
            side: THREE.FrontSide
        })
    );
    scene.add(simplifiedMesh);

    if (wireframe) {
        scene.remove(wireframe);
    }

    wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(latheGeometry),
        new THREE.LineBasicMaterial({
            color: 0x60a5fa,
            transparent: true,
            opacity: 0.3
        })
    );

    scene.add(wireframe);
    wireframe.visible = document.getElementById('wireframeToggle').checked;

    orbitControls.target.copy(center);
    log(`Sealed mesh with ${verticalSlices} slices and caps.`);
}

function showLoading(show, text) {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

function downloadMesh() {
    if (!simplifiedMesh) return;

    const result = exporter.parse(simplifiedMesh);
    const blob = new Blob([result], { type: 'text/plain' });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'optimized_can.obj';
    link.click();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

window.onload = init;