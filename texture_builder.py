import os
import json
import math
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image


# ============================================================
# Config
# ============================================================
BASE_DIR = Path(__file__).resolve().parent
MESH_PATH = BASE_DIR / "bottle_uv.obj"
POSES_PATH = BASE_DIR / "pose" / "poses.json"
IMAGES_DIR = BASE_DIR / "images"
OUTPUT_DIR = BASE_DIR / "output"

TEXTURE_SIZE = 4096
MIN_VIEWS_PER_VERTEX = 1
DEBUG_DRAW_VERTEX_POINTS = False


# ============================================================
# Utility helpers
# ============================================================
def ensure_output_dir(path: Path) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < 1e-12:
        return v
    return v / n


def to_homogeneous(points: np.ndarray) -> np.ndarray:
    ones = np.ones((points.shape[0], 1), dtype=np.float64)
    return np.concatenate([points, ones], axis=1)


def sample_bilinear(image_np: np.ndarray, x: float, y: float):
    """
    Bilinear RGB sampling from image at floating pixel coords.
    Returns None if sampling is outside the valid image area.
    """
    h, w = image_np.shape[:2]

    if x < 0 or x >= w - 1 or y < 0 or y >= h - 1:
        return None

    x0 = int(np.floor(x))
    y0 = int(np.floor(y))
    x1 = x0 + 1
    y1 = y0 + 1

    dx = x - x0
    dy = y - y0

    c00 = image_np[y0, x0].astype(np.float64)
    c10 = image_np[y0, x1].astype(np.float64)
    c01 = image_np[y1, x0].astype(np.float64)
    c11 = image_np[y1, x1].astype(np.float64)

    c0 = c00 * (1.0 - dx) + c10 * dx
    c1 = c01 * (1.0 - dx) + c11 * dx
    c = c0 * (1.0 - dy) + c1 * dy

    return np.clip(c, 0, 255).astype(np.uint8)


def barycentric_2d(p, a, b, c):
    """
    Return barycentric coordinates for point p inside triangle abc in 2D.
    """
    denom = ((b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]))
    if abs(denom) < 1e-12:
        return None

    w1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / denom
    w2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / denom
    w3 = 1.0 - w1 - w2
    return w1, w2, w3


def point_in_triangle_bary(w):
    if w is None:
        return False
    w1, w2, w3 = w
    eps = -1e-5
    return w1 >= eps and w2 >= eps and w3 >= eps


# ============================================================
# Pose loading
# ============================================================
def qvec_to_rotmat(qvec):
    qvec = np.asarray(qvec, dtype=np.float64).reshape(4)
    qw, qx, qy, qz = qvec
    return np.array([
        [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
        [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
        [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy],
    ], dtype=np.float64)


def build_K_from_dict(d):
    if d is None or not isinstance(d, dict):
        return None

    # Case 1: direct 3x3 matrix
    if "K" in d:
        return np.array(d["K"], dtype=np.float64).reshape(3, 3)

    # Case 2: standard fx/fy/cx/cy style
    fx = d.get("fx", d.get("fl_x"))
    fy = d.get("fy", d.get("fl_y", fx))
    cx = d.get("cx")
    cy = d.get("cy")

    w = d.get("w", d.get("width"))
    h = d.get("h", d.get("height"))

    if cx is None and w is not None:
        cx = float(w) / 2.0
    if cy is None and h is not None:
        cy = float(h) / 2.0

    if fx is None and "camera_angle_x" in d and w is not None:
        fx = 0.5 * float(w) / math.tan(0.5 * float(d["camera_angle_x"]))
    if fy is None and "camera_angle_y" in d and h is not None:
        fy = 0.5 * float(h) / math.tan(0.5 * float(d["camera_angle_y"]))
    if fy is None and fx is not None:
        fy = fx

    if None not in [fx, fy, cx, cy]:
        return np.array(
            [[float(fx), 0.0, float(cx)], [0.0, float(fy), float(cy)], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )

    # Case 3: COLMAP camera entry with model + params
    model = d.get("model")
    params = d.get("params")

    if model is not None and params is not None:
        params = list(map(float, params))

        if model in ["SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL", "SIMPLE_RADIAL_FISHEYE", "RADIAL_FISHEYE"]:
            f, cx, cy = params[:3]
            fx, fy = f, f
        elif model in ["PINHOLE", "OPENCV", "FULL_OPENCV", "OPENCV_FISHEYE"]:
            fx, fy, cx, cy = params[:4]
        else:
            return None

        return np.array(
            [[float(fx), 0.0, float(cx)], [0.0, float(fy), float(cy)], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )

    return None


def load_poses(poses_path: Path):
    with open(poses_path, "r") as f:
        data = json.load(f)

    # Get frames
    if isinstance(data, dict):
        if "frames" in data:
            frames = data["frames"]
        elif "images" in data:
            frames = data["images"]
        else:
            raise ValueError("Unsupported poses.json format: expected 'frames' or 'images'")
    elif isinstance(data, list):
        frames = data
        data = {}
    else:
        raise ValueError("Unsupported poses.json format")

    # 1) Global/default intrinsics
    global_K = build_K_from_dict(data)

    if global_K is None:
        for key in ["intrinsics", "camera", "camera_intrinsics", "camera_params"]:
            if key in data:
                global_K = build_K_from_dict(data[key])
                if global_K is not None:
                    break

    # 2) Camera-id based intrinsics
    camera_K_by_id = {}
    if "cameras" in data:
        cameras = data["cameras"]

        if isinstance(cameras, dict):
            iterable = cameras.items()
        elif isinstance(cameras, list):
            iterable = enumerate(cameras)
        else:
            iterable = []

        for cam_key, cam_val in iterable:
            if not isinstance(cam_val, dict):
                continue
            K_cam = build_K_from_dict(cam_val)
            if K_cam is None:
                continue
            cam_id = str(cam_val.get("id", cam_key))
            camera_K_by_id[cam_id] = K_cam

    parsed = []

    for frame in frames:
        image_name = (
            frame.get("image")
            or frame.get("image_name")
            or frame.get("file_path")
            or frame.get("path")
            or frame.get("name")
        )
        if image_name is None:
            raise ValueError("Could not find image filename in one pose entry")

        # Intrinsics priority: frame-specific -> camera_id -> global
        K = build_K_from_dict(frame)
        if K is None and "camera_id" in frame:
            K = camera_K_by_id.get(str(frame["camera_id"]))
        if K is None:
            K = global_K
        if K is None:
            raise ValueError(
                f"Could not find intrinsics for {image_name}. "
                f"Checked frame fields, camera_id, and global/top-level camera data."
            )

        # Extrinsics
        if "W2C" in frame:
            W2C = np.array(frame["W2C"], dtype=np.float64).reshape(4, 4)
        elif "world_to_camera" in frame:
            W2C = np.array(frame["world_to_camera"], dtype=np.float64).reshape(4, 4)
        elif "transform_matrix" in frame:
            C2W = np.array(frame["transform_matrix"], dtype=np.float64).reshape(4, 4)
            W2C = np.linalg.inv(C2W)
        elif "C2W" in frame:
            C2W = np.array(frame["C2W"], dtype=np.float64).reshape(4, 4)
            W2C = np.linalg.inv(C2W)
        elif "qvec" in frame and "tvec" in frame:
            R = qvec_to_rotmat(frame["qvec"])
            t = np.array(frame["tvec"], dtype=np.float64).reshape(3)
            W2C = np.eye(4, dtype=np.float64)
            W2C[:3, :3] = R
            W2C[:3, 3] = t
        elif "R" in frame and "t" in frame:
            R = np.array(frame["R"], dtype=np.float64).reshape(3, 3)
            t = np.array(frame["t"], dtype=np.float64).reshape(3)
            W2C = np.eye(4, dtype=np.float64)
            W2C[:3, :3] = R
            W2C[:3, 3] = t
        else:
            raise ValueError(f"Could not find camera pose for {image_name}")

        parsed.append({"image_path": image_name, "K": K, "W2C": W2C})

    return parsed


# ============================================================
# Mesh + normals
# ============================================================
def load_mesh(mesh_path: Path) -> trimesh.Trimesh:
    mesh = trimesh.load(mesh_path, force="mesh")

    if not isinstance(mesh, trimesh.Trimesh):
        raise ValueError("Loaded geometry is not a mesh")

    if mesh.visual.uv is None or len(mesh.visual.uv) == 0:
        raise ValueError("Mesh has no UV coordinates")

    return mesh


def compute_vertex_normals(mesh: trimesh.Trimesh) -> np.ndarray:
    return np.array(mesh.vertex_normals, dtype=np.float64)


def compute_camera_center(W2C: np.ndarray) -> np.ndarray:
    C2W = np.linalg.inv(W2C)
    return C2W[:3, 3]


# ============================================================
# Projection
# ============================================================
def project_points(points_world: np.ndarray, K: np.ndarray, W2C: np.ndarray):
    """
    Project Nx3 points into one camera.
    Returns:
      pixels Nx2
      depth  Nx1
      cam_pts Nx3
    """
    pts_h = to_homogeneous(points_world)
    cam_h = (W2C @ pts_h.T).T
    cam_pts = cam_h[:, :3]

    z = cam_pts[:, 2].copy()
    valid = z > 1e-8

    pixels = np.full((points_world.shape[0], 2), np.nan, dtype=np.float64)

    cam_xyz = cam_pts[valid]
    proj = (K @ cam_xyz.T).T
    proj_xy = proj[:, :2] / proj[:, 2:3]

    pixels[valid] = proj_xy
    return pixels, z, cam_pts


def score_view_for_vertex(vertex, normal, pixel_xy, z, camera_center, img_w, img_h):
    """
    Higher score = better view.
    Combines:
    - in front of camera
    - facing camera
    - near image center
    """
    if z <= 1e-8:
        return -1e18

    x, y = pixel_xy
    if not (0 <= x < img_w and 0 <= y < img_h):
        return -1e18

    view_dir = normalize(camera_center - vertex)
    facing = float(np.dot(normalize(normal), view_dir))

    if facing <= 0.05:
        return -1e18

    cx = img_w * 0.5
    cy = img_h * 0.5
    dist_center = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    max_dist = math.sqrt(cx ** 2 + cy ** 2)
    center_score = 1.0 - (dist_center / max_dist)

    return facing * 0.75 + center_score * 0.25


# ============================================================
# Vertex color estimation
# ============================================================

def estimate_vertex_colors(mesh: trimesh.Trimesh, poses, images_dir: Path) -> np.ndarray:
    vertices = np.array(mesh.vertices, dtype=np.float64)
    normals = compute_vertex_normals(mesh)

    vertex_colors_accum = [[] for _ in range(len(vertices))]

    for pose in poses:
        image_rel = pose["image_path"]
        image_path = images_dir / os.path.basename(image_rel)

        if not image_path.exists():
            alt_path = BASE_DIR / image_rel
            if alt_path.exists():
                image_path = alt_path

        if not image_path.exists():
            print(f"[WARN] Missing image: {image_rel}")
            continue

        img = Image.open(image_path).convert("RGB")
        img_np = np.array(img)
        h, w = img_np.shape[:2]

        K = pose["K"]
        W2C = pose["W2C"]

        camera_center = compute_camera_center(W2C)
        pixels, depth, _ = project_points(vertices, K, W2C)

        for i in range(len(vertices)):
            score = score_view_for_vertex(
                vertex=vertices[i],
                normal=normals[i],
                pixel_xy=pixels[i],
                z=depth[i],
                camera_center=camera_center,
                img_w=w,
                img_h=h,
            )

            if score < -1e10:
                continue

            x, y = pixels[i]
            color = sample_bilinear(img_np, x, y)
            if color is None:
                continue

            vertex_colors_accum[i].append((score, color))

    vertex_colors = np.zeros((len(vertices), 3), dtype=np.uint8)

    for i, entries in enumerate(vertex_colors_accum):
        if len(entries) < MIN_VIEWS_PER_VERTEX:
            vertex_colors[i] = np.array([180, 180, 180], dtype=np.uint8)
            continue

        best_idx = int(np.argmax([e[0] for e in entries]))
        vertex_colors[i] = np.array(entries[best_idx][1], dtype=np.uint8)

    return vertex_colors




# ============================================================
# Bake vertex colors into UV texture
# ============================================================
def bake_texture_from_vertex_colors(mesh: trimesh.Trimesh, vertex_colors: np.ndarray, texture_size: int):
    uv = np.array(mesh.visual.uv, dtype=np.float64)
    faces = np.array(mesh.faces, dtype=np.int32)

    if uv.shape[0] != len(mesh.vertices):
        raise ValueError(
            f"UV count ({uv.shape[0]}) != vertex count ({len(mesh.vertices)}). "
            "This simple baker assumes one UV per vertex."
        )

    # Use float accumulation to avoid uint8 overflow during rasterization.
    tex_accum = np.zeros((texture_size, texture_size, 3), dtype=np.float64)
    weight = np.zeros((texture_size, texture_size), dtype=np.float64)

    for face in faces:
        i0, i1, i2 = face
        uv0 = uv[i0]
        uv1 = uv[i1]
        uv2 = uv[i2]

        c0 = vertex_colors[i0].astype(np.float64)
        c1 = vertex_colors[i1].astype(np.float64)
        c2 = vertex_colors[i2].astype(np.float64)

        p0 = np.array([uv0[0] * (texture_size - 1), (1.0 - uv0[1]) * (texture_size - 1)])
        p1 = np.array([uv1[0] * (texture_size - 1), (1.0 - uv1[1]) * (texture_size - 1)])
        p2 = np.array([uv2[0] * (texture_size - 1), (1.0 - uv2[1]) * (texture_size - 1)])

        min_x = max(int(np.floor(min(p0[0], p1[0], p2[0]))), 0)
        max_x = min(int(np.ceil(max(p0[0], p1[0], p2[0]))), texture_size - 1)
        min_y = max(int(np.floor(min(p0[1], p1[1], p2[1]))), 0)
        max_y = min(int(np.ceil(max(p0[1], p1[1], p2[1]))), texture_size - 1)

        if min_x > max_x or min_y > max_y:
            continue

        for ty in range(min_y, max_y + 1):
            for tx in range(min_x, max_x + 1):
                p = np.array([tx + 0.5, ty + 0.5], dtype=np.float64)
                bary = barycentric_2d(p, p0, p1, p2)
                if not point_in_triangle_bary(bary):
                    continue

                w0, w1, w2 = bary
                color = c0 * w0 + c1 * w1 + c2 * w2

                tex_accum[ty, tx] += np.clip(color, 0, 255)
                weight[ty, tx] += 1.0

    filled = weight > 0
    tex_out = np.zeros_like(tex_accum, dtype=np.uint8)
    tex_out[filled] = np.clip(tex_accum[filled] / weight[filled][:, None], 0, 255).astype(np.uint8)
    tex_out = fill_holes_simple(tex_out, filled)
    return tex_out


def fill_holes_simple(tex: np.ndarray, mask_filled: np.ndarray, iterations: int = 8) -> np.ndarray:
    """
    Very simple inpainting-like pass for empty pixels.
    """
    result = tex.copy()
    filled = mask_filled.copy()

    h, w = filled.shape

    for _ in range(iterations):
        changed = False
        new_result = result.copy()
        new_filled = filled.copy()

        for y in range(h):
            for x in range(w):
                if filled[y, x]:
                    continue

                neighbors = []
                for yy in range(max(0, y - 1), min(h, y + 2)):
                    for xx in range(max(0, x - 1), min(w, x + 2)):
                        if filled[yy, xx]:
                            neighbors.append(result[yy, xx].astype(np.float64))

                if neighbors:
                    avg = np.mean(neighbors, axis=0)
                    new_result[y, x] = np.clip(avg, 0, 255).astype(np.uint8)
                    new_filled[y, x] = True
                    changed = True

        result = new_result
        filled = new_filled

        if not changed:
            break

    return result


# ============================================================
# Save outputs
# ============================================================
def save_texture_png(texture_np: np.ndarray, path: Path):
    img = Image.fromarray(texture_np, mode="RGB")
    img.save(path)
    print(f"[OK] Saved texture: {path}")


def save_textured_obj(mesh: trimesh.Trimesh, texture_png_path: Path, out_obj_path: Path):
    uv = np.array(mesh.visual.uv, dtype=np.float64)
    normals = np.array(mesh.vertex_normals, dtype=np.float64)
    faces = np.array(mesh.faces, dtype=np.int32)

    if uv.shape[0] != len(mesh.vertices):
        raise ValueError(
            f"UV count ({uv.shape[0]}) != vertex count ({len(mesh.vertices)}). "
            "This exporter assumes one UV per vertex."
        )

    mtl_path = out_obj_path.with_name("material.mtl")

    with open(mtl_path, "w") as f:
        f.write("newmtl material_0\n")
        f.write("Ka 1.000000 1.000000 1.000000\n")
        f.write("Kd 1.000000 1.000000 1.000000\n")
        f.write("Ks 0.000000 0.000000 0.000000\n")
        f.write("d 1.0\n")
        f.write("illum 2\n")
        f.write(f"map_Kd {texture_png_path.name}\n")

    with open(out_obj_path, "w") as f:
        f.write(f"mtllib {mtl_path.name}\n")
        f.write("usemtl material_0\n")

        for v in mesh.vertices:
            f.write(f"v {v[0]} {v[1]} {v[2]}\n")

        for vt in uv:
            f.write(f"vt {vt[0]} {vt[1]}\n")

        for vn in normals:
            f.write(f"vn {vn[0]} {vn[1]} {vn[2]}\n")

        for face in faces:
            a, b, c = face + 1
            f.write(f"f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}\n")

    print(f"[OK] Saved textured OBJ: {out_obj_path}")
    print(f"[OK] Saved material: {mtl_path}")

# ============================================================
# Main
# ============================================================
def main():
    ensure_output_dir(OUTPUT_DIR)

    print("[1/5] Loading mesh...")
    mesh = load_mesh(MESH_PATH)

    print("[2/5] Loading poses...")
    poses = load_poses(POSES_PATH)

    print("[3/5] Estimating vertex colors from photos...")
    vertex_colors = estimate_vertex_colors(mesh, poses, IMAGES_DIR)

    print("[4/5] Baking UV texture...")
    texture_np = bake_texture_from_vertex_colors(mesh, vertex_colors, TEXTURE_SIZE)

    texture_path = OUTPUT_DIR / "texture.png"
    obj_path = OUTPUT_DIR / "textured.obj"

    print("[5/5] Saving outputs...")
    save_texture_png(texture_np, texture_path)
    save_textured_obj(mesh, texture_path, obj_path)

    print("\nDone.")
    print("Generated:")
    print(f"  {texture_path}")
    print(f"  {obj_path}")
    print(f"  {OUTPUT_DIR / 'textured.mtl'}  [created automatically with OBJ export]")


if __name__ == "__main__":
    main()