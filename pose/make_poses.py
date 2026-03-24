import json

def parse_cameras_txt(path):
    cameras = {}
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            camera_id = int(parts[0])
            model = parts[1]
            width = int(parts[2])
            height = int(parts[3])
            params = list(map(float, parts[4:]))

            cameras[camera_id] = {
                "model": model,
                "width": width,
                "height": height,
                "params": params
            }
    return cameras


def parse_images_txt(path):
    frames = []
    with open(path, "r") as f:
        lines = [line.strip() for line in f if line.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]

        if line.startswith("#"):
            i += 1
            continue

        parts = line.split()
        if len(parts) < 10:
            i += 1
            continue

        image_id = int(parts[0])
        qw, qx, qy, qz = map(float, parts[1:5])
        tx, ty, tz = map(float, parts[5:8])
        camera_id = int(parts[8])
        image_name = parts[9]

        frames.append({
            "image_id": image_id,
            "file_path": image_name,
            "qvec": [qw, qx, qy, qz],
            "tvec": [tx, ty, tz],
            "camera_id": camera_id
        })

        # skip the next line because it is POINTS2D
        i += 2

    return frames


def main():
    cameras = parse_cameras_txt("cameras.txt")
    frames = parse_images_txt("images.txt")

    output = {
        "cameras": cameras,
        "frames": frames
    }

    with open("poses.json", "w") as f:
        json.dump(output, f, indent=2)

    print("poses.json created successfully")


if __name__ == "__main__":
    main()