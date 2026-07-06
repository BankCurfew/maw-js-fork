import { useEffect, useRef } from "react";
import * as THREE from "three";

export function UniverseBg() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const w = el.clientWidth;
    const h = el.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020208);

    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 500);
    camera.position.set(0, 2, 20);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(1); // Cap at 1x for performance
    el.appendChild(renderer.domElement);

    // Stars — reduced count, bigger size to compensate no bloom
    const starCount = 1200;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 120;
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 70;
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.08, transparent: true, opacity: 0.6,
      sizeAttenuation: true,
    });
    scene.add(new THREE.Points(starGeo, starMat));

    // Wireframe globe
    const globeGeo = new THREE.SphereGeometry(12, 24, 16); // Lower segments
    const globeWire = new THREE.WireframeGeometry(globeGeo);
    const globeMat = new THREE.LineBasicMaterial({
      color: 0x6a5acd, opacity: 0.04, transparent: true,
    });
    const globe = new THREE.LineSegments(globeWire, globeMat);
    scene.add(globe);

    // Nebula particles (colored clusters) — fewer particles
    const nebulaColors = [0x26c6da, 0x7e57c2, 0xffa726, 0x4caf50, 0xef5350];
    nebulaColors.forEach((color, ci) => {
      const count = 40;
      const pos = new Float32Array(count * 3);
      const angle = (ci / nebulaColors.length) * Math.PI * 2;
      const cx = Math.cos(angle) * 8;
      const cz = Math.sin(angle) * 8;
      for (let i = 0; i < count; i++) {
        pos[i * 3] = cx + (Math.random() - 0.5) * 6;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 4;
        pos[i * 3 + 2] = cz + (Math.random() - 0.5) * 6;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color, size: 0.12, transparent: true, opacity: 0.2,
        sizeAttenuation: true,
      });
      scene.add(new THREE.Points(geo, mat));
    });

    let time = 0;
    let frame = 0;
    let lastRender = 0;
    const interval = 1000 / 24; // 24fps cap

    function animate(now: number) {
      frame = requestAnimationFrame(animate);
      if (now - lastRender < interval) return;
      lastRender = now;

      time += 0.003;
      globe.rotation.y = time * 0.3;
      globe.rotation.x = time * 0.1;
      camera.position.x = Math.sin(time * 0.15) * 1.5;
      camera.position.y = 2 + Math.sin(time * 0.2) * 0.5;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(animate);

    function onResize() {
      const nw = el!.clientWidth;
      const nh = el!.clientHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={containerRef} className="fixed inset-0 z-0" />;
}
