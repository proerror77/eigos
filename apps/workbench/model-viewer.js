import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function createViewer(container, onPick) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f3f5f4');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.localClippingEnabled = true;
  container.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7b877f, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(4, 8, 5);
  scene.add(light);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    throw new Error('请使用内嵌资源的 GLB / GLTF 文件');
  });
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2();
  let model,
    box,
    size = 1,
    frame,
    measuring = false,
    points = [];
  const markers = new THREE.Group();
  scene.add(markers);
  const resize = () => {
    const width = container.clientWidth || 600,
      height = container.clientHeight || 500;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  function reset() {
    if (!box) return;
    const center = box.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(size * 1.1, size * 0.8, size * 1.3));
    controls.target.copy(center);
    camera.near = Math.max(size / 10000, 0.0001);
    camera.far = size * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }
  function disposeObject(object) {
    object.traverse((child) => {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  }
  async function load(bytes, name) {
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('模型文件上限为 20 MiB');
    const extension = name.split('.').at(-1).toLowerCase();
    let next;
    if (extension === 'obj') next = new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
    else if (extension === 'stl')
      next = new THREE.Mesh(
        new STLLoader(manager).parse(bytes),
        new THREE.MeshStandardMaterial({ color: 0xc5d4cc, roughness: 0.75, side: THREE.DoubleSide }),
      );
    else if (extension === 'ply') {
      const geometry = new PLYLoader(manager).parse(bytes);
      next = geometry.index
        ? new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ color: 0xc5d4cc, side: THREE.DoubleSide }),
          )
        : new THREE.Points(
            geometry,
            new THREE.PointsMaterial({
              size: 0.01,
              color: 0x315f4f,
              vertexColors: Boolean(geometry.attributes.color),
            }),
          );
    } else if (extension === 'gltf' || extension === 'glb')
      next = (
        await new GLTFLoader(manager).parseAsync(
          extension === 'gltf' ? new TextDecoder().decode(bytes) : bytes,
          '',
        )
      ).scene;
    else throw new Error('支持 GLB、内嵌资源 GLTF、OBJ、STL 和 PLY');
    box = new THREE.Box3().setFromObject(next);
    if (box.isEmpty()) throw new Error('文件没有可显示的几何对象');
    size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
    if (!Number.isFinite(size) || size <= 0) throw new Error('模型边界无效');
    next.traverse((child) => {
      if(child.isMesh){
        for(const old of Array.isArray(child.material)?child.material:[child.material]){if(old){for(const value of Object.values(old))if(value?.isTexture)value.dispose();old.dispose();}}
        child.material = new THREE.MeshStandardMaterial({
          color: 0xc5d4cc,
          roughness: 0.7,
          side: THREE.DoubleSide,
        });
      }
      if (child.isPoints) child.material.size = size / 400;
    });
    if (model) {
      scene.remove(model);
      disposeObject(model);
    }
    model = next;
    scene.add(model);
    disposeObject(markers);markers.clear();
    points = [];
    reset();
  }
  renderer.domElement.addEventListener('click', (event) => {
    if (!model || !measuring) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.params.Points.threshold = size / 100;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(model, true)[0];
    if (!hit) return;
    if (points.length === 2) {
      points = [];
      disposeObject(markers);markers.clear();
    }
    points.push(hit.point.toArray());
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(size / 150, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x173c2d }),
    );
    marker.position.copy(hit.point);
    markers.add(marker);
    const distance =
      points.length === 2 ? new THREE.Vector3(...points[0]).distanceTo(new THREE.Vector3(...points[1])) : 0;
    onPick(
      points.map((point) => [...point]),
      distance,
    );
  });
  function animate() {
    frame = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
  return {
    load,
    reset,
    measure() {
      measuring = true;
      points = [];
      disposeObject(markers);markers.clear();
    },
    section(position) {
      if (!model || !box) return;
      plane.constant = box.min.y + ((position + 1) / 2) * (box.max.y - box.min.y);
      model.traverse((child) => {
        if (child.material) {
          child.material.clippingPlanes = position >= 1 ? [] : [plane];
          child.material.needsUpdate = true;
        }
      });
    },
    sectionState(){if(!model||!box)throw new Error('先加载模型');return [[0,plane.constant,0],plane.normal.toArray()];},
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (model) disposeObject(model);
      disposeObject(markers);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
