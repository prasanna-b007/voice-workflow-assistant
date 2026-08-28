import { motion, useScroll, useTransform, useMotionValue, useSpring } from "framer-motion";
import { useRef, useEffect, useCallback } from "react";
import {
  Mic,
  MonitorPlay,
  BellRing,
  Keyboard,
  Download,
  Play,
  Activity,
  AudioLines,
  Command,
  Zap,
  ArrowRight,
  Shield,
  Cpu,
  Sparkles
} from "lucide-react";

/* ────────────────────────────────────────────
   Download Helper 
   ──────────────────────────────────────────── */
const handleDownloadClick = () => {
  fetch("https://github.com/Pranesh-I/voice-workflow-assistant/releases/download/v1.0/Nova_0.1.0_x64-setup.exe", { method: "HEAD" })
    .catch(() => console.warn("Installer not found. Check release tag name."));
};

/* ────────────────────────────────────────────
   Animated Particle Background (Glowing Dots + Lines)
   ──────────────────────────────────────────── */
function ParticleBackground() {
  const canvasRef = useRef(null);
  const mouse = useRef({ x: null, y: null, radius: 150 });
  const particles = useRef([]);
  const raf = useRef(null);
  const dims = useRef({ w: 0, h: 0 });

  // Brand-aligned color palette (indigo ↔ violet ↔ lavender ↔ teal accents)
  const COLORS = useRef([
    { r: 79, g: 70, b: 229 },  // #4F46E5 – indigo
    { r: 99, g: 102, b: 241 }, // #6366F1 – indigo-light
    { r: 139, g: 92, b: 246 }, // #8B5CF6 – violet
    { r: 167, g: 139, b: 250 },// #A78BFA – lavender
  ]);

  const LINE_COLOR = 'rgba(99, 102, 241, ';

  const createParticle = useCallback((w, h) => {
    const c = COLORS.current[Math.floor(Math.random() * COLORS.current.length)];
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      size: Math.random() * 2 + 0.5,
      density: (Math.random() * 30) + 5,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      alpha: Math.random() * 0.5 + 0.2,
      color: c,
      colorStr: `rgb(${c.r}, ${c.g}, ${c.b})`,
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    const dpr = window.devicePixelRatio || 1;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    const resize = () => {
      dims.current.w = window.innerWidth;
      dims.current.h = document.documentElement.scrollHeight;
      canvas.width = dims.current.w * dpr;
      canvas.height = dims.current.h * dpr;
      canvas.style.width = dims.current.w + 'px';
      canvas.style.height = dims.current.h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Init particles
    const count = Math.min(Math.floor(dims.current.w / 12), 100);
    particles.current = Array.from({ length: count }, () =>
      createParticle(dims.current.w, dims.current.h)
    );

    const onMouse = (e) => {
      mouse.current.x = e.clientX;
      mouse.current.y = e.clientY + window.scrollY;
    };
    const onLeave = () => {
      mouse.current.x = null;
      mouse.current.y = null;
    };

    const connectParticles = () => {
      const pts = particles.current;
      for (let a = 0; a < pts.length; a++) {
        for (let b = a + 1; b < pts.length; b++) {
          const dx = pts[a].x - pts[b].x;
          const dy = pts[a].y - pts[b].y;
          const distSq = dx * dx + dy * dy;
          if (distSq < 18000) {
            const opacity = (1 - (distSq / 18000)) * 0.2;
            ctx.beginPath();
            ctx.strokeStyle = LINE_COLOR + opacity + ')';
            ctx.lineWidth = 0.8;
            ctx.moveTo(pts[a].x, pts[a].y);
            ctx.lineTo(pts[b].x, pts[b].y);
            ctx.stroke();
          }
        }
      }
    };

    const drawBg = () => {
      const { w, h } = dims.current;
      ctx.clearRect(0, 0, w, h);

      // Subtle radial gradient background tint
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      gradient.addColorStop(0, 'rgba(139, 92, 246, 0.03)');
      gradient.addColorStop(1, 'rgba(61, 220, 255, 0.01)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    };

    const animate = () => {
      const { w, h } = dims.current;
      drawBg();

      const mx = mouse.current.x;
      const my = mouse.current.y;
      const mRadius = mouse.current.radius;

      particles.current.forEach((p) => {
        // Movement
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;

        // Mouse repulsion
        if (mx != null && my != null) {
          const dx = mx - p.x;
          const dy = my - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < mRadius && dist > 0) {
            const force = (mRadius - dist) / mRadius;
            p.x -= (dx / dist) * force * p.density * 0.08;
            p.y -= (dy / dist) * force * p.density * 0.08;
          }
        }

        // Draw glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.shadowBlur = 12;
        ctx.shadowColor = p.colorStr;
        ctx.fillStyle = p.colorStr;
        ctx.globalAlpha = p.alpha;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      });

      connectParticles();
      raf.current = requestAnimationFrame(animate);
    };

    animate();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouse);
    document.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, [createParticle]);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[-1]" style={{ opacity: 0.7 }} />;
}

/* ────────────────────────────────────────────
   Plexus Constellation Network (SkillMatchPro-style)
   ──────────────────────────────────────────── */
function PlexusNetwork() {
  const canvasRef = useRef(null);
  const mouse = useRef({ x: -1000, y: -1000 });
  const particles = useRef([]);
  const raf = useRef(null);

  const initParticles = useCallback((w, h) => {
    // Dense particle count for a rich constellation feel
    const count = Math.min(220, Math.floor((w * h) / 6000));
    particles.current = Array.from({ length: count }, () => {
      const isStar = Math.random() < 0.12; // 12% are bright "star" nodes
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: isStar ? Math.random() * 3 + 2.5 : Math.random() * 2 + 1,
        opacity: isStar ? Math.random() * 0.4 + 0.5 : Math.random() * 0.3 + 0.2,
        isStar,
        // Color variation: mix of violet & teal tones
        hue: isStar ? (Math.random() > 0.5 ? 0 : 1) : Math.floor(Math.random() * 3), // 0=violet, 1=teal, 2=lavender
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: Math.random() * 0.01 + 0.005,
        connections: 0,
      };
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w = window.innerWidth;
    let h = document.documentElement.scrollHeight;

    const resize = () => {
      w = window.innerWidth;
      h = document.documentElement.scrollHeight;
      canvas.width = w;
      canvas.height = h;
      if (particles.current.length === 0) initParticles(w, h);
    };
    resize();

    const onMouse = (e) => {
      mouse.current.x = e.clientX;
      mouse.current.y = e.clientY + window.scrollY;
    };
    const onLeave = () => { mouse.current.x = -1000; mouse.current.y = -1000; };

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouse);
    document.addEventListener("mouseleave", onLeave);

    // Color palette matching the brand
    const colors = [
      [139, 92, 246],  // violet
      [61, 220, 255],  // teal/cyan
      [196, 181, 253], // lavender
    ];

    let frame = 0;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const mx = mouse.current.x;
      const my = mouse.current.y;
      const INTERACT_RADIUS = 180;
      const LINE_DIST = 180;
      const MOUSE_LINE_DIST = 250;

      frame++;

      // Reset connection counts
      particles.current.forEach(p => { p.connections = 0; });

      // Draw connection lines first (behind nodes)
      for (let i = 0; i < particles.current.length; i++) {
        for (let j = i + 1; j < particles.current.length; j++) {
          const a = particles.current[i];
          const b = particles.current[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < LINE_DIST) {
            const alpha = 0.25 * (1 - dist / LINE_DIST);
            // Gradient line color based on node types
            const cA = colors[a.hue] || colors[0];
            const cB = colors[b.hue] || colors[0];
            const midR = (cA[0] + cB[0]) / 2;
            const midG = (cA[1] + cB[1]) / 2;
            const midB = (cA[2] + cB[2]) / 2;

            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(${midR}, ${midG}, ${midB}, ${alpha})`;
            ctx.lineWidth = a.isStar || b.isStar ? 1 : 0.6;
            ctx.stroke();

            a.connections++;
            b.connections++;
          }
        }
      }

      // Draw mouse attraction lines
      particles.current.forEach((p) => {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_LINE_DIST && dist > 0) {
          const alpha = 0.35 * (1 - dist / MOUSE_LINE_DIST);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mx, my);
          ctx.strokeStyle = `rgba(61, 220, 255, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      });

      // Update & draw particles
      particles.current.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -50) p.x = w + 50;
        if (p.x > w + 50) p.x = -50;
        if (p.y < -50) p.y = h + 50;
        if (p.y > h + 50) p.y = -50;

        // Mouse repulsion
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < INTERACT_RADIUS && dist > 0) {
          const force = (INTERACT_RADIUS - dist) / INTERACT_RADIUS;
          const angle = Math.atan2(dy, dx);
          p.x += Math.cos(angle) * force * 2;
          p.y += Math.sin(angle) * force * 2;
        }

        // Pulsing opacity for stars
        const pulse = p.isStar ? Math.sin(frame * p.pulseSpeed + p.pulsePhase) * 0.2 + 0.8 : 1;
        const finalOpacity = p.opacity * pulse;
        const c = colors[p.hue] || colors[0];

        // Draw outer glow for star nodes & highly-connected nodes
        if (p.isStar || p.connections > 4) {
          const glowRadius = p.isStar ? p.r * 4 : p.r * 3;
          const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
          gradient.addColorStop(0, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${finalOpacity * 0.3})`);
          gradient.addColorStop(1, `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0)`);
          ctx.beginPath();
          ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
          ctx.fillStyle = gradient;
          ctx.fill();
        }

        // Draw the node
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${finalOpacity})`;
        ctx.fill();

        // Bright center dot for star nodes
        if (p.isStar) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 0.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${finalOpacity * 0.8})`;
          ctx.fill();
        }
      });

      raf.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouse);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, [initParticles]);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[1]" />;
}

/* ────────────────────────────────────────────
   Floating Geometric Shapes (diamonds, hexagons, triangles)
   ──────────────────────────────────────────── */
function FloatingGeometrics() {
  const shapes = [
    // Hexagons
    { type: "hexagon", size: 60, x: "8%", y: "15%", rotate: 30, delay: 0, duration: 18, opacity: 0.08 },
    { type: "hexagon", size: 90, x: "85%", y: "8%", rotate: -15, delay: 2, duration: 22, opacity: 0.06 },
    { type: "hexagon", size: 45, x: "75%", y: "35%", rotate: 45, delay: 4, duration: 16, opacity: 0.07 },
    { type: "hexagon", size: 70, x: "15%", y: "55%", rotate: 60, delay: 1, duration: 20, opacity: 0.05 },
    { type: "hexagon", size: 55, x: "92%", y: "60%", rotate: 10, delay: 3, duration: 24, opacity: 0.06 },
    { type: "hexagon", size: 80, x: "50%", y: "80%", rotate: -30, delay: 5, duration: 19, opacity: 0.04 },
    // Diamonds
    { type: "diamond", size: 35, x: "20%", y: "25%", rotate: 45, delay: 1.5, duration: 15, opacity: 0.1 },
    { type: "diamond", size: 25, x: "65%", y: "12%", rotate: 30, delay: 3.5, duration: 17, opacity: 0.08 },
    { type: "diamond", size: 40, x: "90%", y: "40%", rotate: 20, delay: 0.5, duration: 21, opacity: 0.07 },
    { type: "diamond", size: 30, x: "5%", y: "70%", rotate: 60, delay: 2.5, duration: 14, opacity: 0.09 },
    { type: "diamond", size: 20, x: "45%", y: "45%", rotate: 15, delay: 4.5, duration: 18, opacity: 0.06 },
    // Triangles
    { type: "triangle", size: 50, x: "35%", y: "10%", rotate: 0, delay: 2, duration: 20, opacity: 0.06 },
    { type: "triangle", size: 40, x: "70%", y: "55%", rotate: 180, delay: 0, duration: 16, opacity: 0.07 },
    { type: "triangle", size: 35, x: "12%", y: "85%", rotate: 90, delay: 3, duration: 22, opacity: 0.05 },
    { type: "triangle", size: 55, x: "80%", y: "75%", rotate: -45, delay: 1, duration: 19, opacity: 0.04 },
    // Circles (dot clusters)
    { type: "circle", size: 8, x: "25%", y: "20%", rotate: 0, delay: 0, duration: 12, opacity: 0.15 },
    { type: "circle", size: 6, x: "55%", y: "30%", rotate: 0, delay: 1, duration: 10, opacity: 0.12 },
    { type: "circle", size: 10, x: "40%", y: "65%", rotate: 0, delay: 2, duration: 14, opacity: 0.1 },
    { type: "circle", size: 5, x: "88%", y: "25%", rotate: 0, delay: 0.5, duration: 11, opacity: 0.18 },
    { type: "circle", size: 7, x: "10%", y: "45%", rotate: 0, delay: 3, duration: 13, opacity: 0.14 },
  ];

  const renderShape = (shape) => {
    const baseStyle = "absolute pointer-events-none";
    
    if (shape.type === "hexagon") {
      return (
        <svg width={shape.size} height={shape.size} viewBox="0 0 100 100" className={baseStyle}>
          <polygon 
            points="50,2 95,25 95,75 50,98 5,75 5,25" 
            fill="none" 
            stroke="url(#hexGrad)" 
            strokeWidth="1.5"
            opacity={shape.opacity}
          />
          <defs>
            <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#3DDCFF" />
            </linearGradient>
          </defs>
        </svg>
      );
    }
    
    if (shape.type === "diamond") {
      return (
        <svg width={shape.size} height={shape.size} viewBox="0 0 100 100" className={baseStyle}>
          <polygon 
            points="50,5 95,50 50,95 5,50"
            fill="none"
            stroke="url(#diamondGrad)"
            strokeWidth="1.5"
            opacity={shape.opacity}
          />
          <defs>
            <linearGradient id="diamondGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3DDCFF" />
              <stop offset="100%" stopColor="#C4B5FD" />
            </linearGradient>
          </defs>
        </svg>
      );
    }
    
    if (shape.type === "triangle") {
      return (
        <svg width={shape.size} height={shape.size} viewBox="0 0 100 100" className={baseStyle}>
          <polygon
            points="50,8 95,92 5,92"
            fill="none"
            stroke="url(#triGrad)"
            strokeWidth="1.5"
            opacity={shape.opacity}
          />
          <defs>
            <linearGradient id="triGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#8B5CF6" />
              <stop offset="50%" stopColor="#3DDCFF" />
              <stop offset="100%" stopColor="#C4B5FD" />
            </linearGradient>
          </defs>
        </svg>
      );
    }
    
    if (shape.type === "circle") {
      return (
        <div 
          className={baseStyle} 
          style={{
            width: shape.size,
            height: shape.size,
            borderRadius: "50%",
            background: `radial-gradient(circle, rgba(139,92,246,${shape.opacity}) 0%, rgba(61,220,255,${shape.opacity * 0.5}) 100%)`,
            boxShadow: `0 0 ${shape.size * 2}px rgba(139,92,246,${shape.opacity * 0.5})`,
          }}
        />
      );
    }
    return null;
  };

  return (
    <div className="fixed inset-0 pointer-events-none z-[2] overflow-hidden">
      {shapes.map((shape, i) => (
        <motion.div
          key={i}
          initial={{ 
            x: shape.x, 
            y: shape.y, 
            rotate: shape.rotate, 
            opacity: 0 
          }}
          animate={{ 
            y: [shape.y, `calc(${shape.y} - 30px)`, shape.y],
            rotate: [shape.rotate, shape.rotate + 15, shape.rotate - 10, shape.rotate],
            opacity: [0, 1, 1, 0],
          }}
          transition={{ 
            duration: shape.duration, 
            repeat: Infinity, 
            delay: shape.delay,
            ease: "easeInOut" 
          }}
          style={{ left: shape.x, top: shape.y }}
          className="absolute"
        >
          {renderShape(shape)}
        </motion.div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────
   Subtle Grid Mesh Overlay
   ──────────────────────────────────────────── */
function GridMesh() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w, h;

    const resize = () => {
      w = window.innerWidth;
      h = document.documentElement.scrollHeight;
      canvas.width = w;
      canvas.height = h;
      drawGrid();
    };

    const drawGrid = () => {
      ctx.clearRect(0, 0, w, h);
      const CELL = 80;

      // Draw vertical lines
      for (let x = 0; x <= w; x += CELL) {
        // Fade lines near edges for a vignette effect
        const edgeFade = Math.min(x / (w * 0.15), (w - x) / (w * 0.15), 1);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.strokeStyle = `rgba(139, 92, 246, ${0.025 * edgeFade})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Draw horizontal lines
      for (let y = 0; y <= h; y += CELL) {
        const edgeFade = Math.min(y / (h * 0.1), (h - y) / (h * 0.1), 1);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.strokeStyle = `rgba(61, 220, 255, ${0.02 * edgeFade})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // Draw small dots at intersections
      for (let x = 0; x <= w; x += CELL) {
        for (let y = 0; y <= h; y += CELL) {
          const edgeFadeX = Math.min(x / (w * 0.2), (w - x) / (w * 0.2), 1);
          const edgeFadeY = Math.min(y / (h * 0.1), (h - y) / (h * 0.1), 1);
          const dot = edgeFadeX * edgeFadeY;
          if (dot > 0.1) {
            ctx.beginPath();
            ctx.arc(x, y, 1.2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(139, 92, 246, ${0.08 * dot})`;
            ctx.fill();
          }
        }
      }
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[0]" />;
}

/* ────────────────────────────────────────────
   Large Gradient Orbs (ambient background)
   ──────────────────────────────────────────── */
function GradientOrbs() {
  return (
    <div className="fixed inset-0 pointer-events-none z-[0] overflow-hidden">
      {/* Top-right teal orb */}
      <motion.div
        animate={{ 
          x: [0, 50, -30, 0], 
          y: [0, -40, 20, 0],
          scale: [1, 1.1, 0.95, 1],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        className="absolute -top-[200px] -right-[200px] w-[600px] h-[600px] rounded-full opacity-30"
        style={{ background: "radial-gradient(circle, rgba(61,220,255,0.15) 0%, rgba(61,220,255,0.05) 40%, transparent 70%)" }}
      />
      {/* Center violet orb */}
      <motion.div
        animate={{ 
          x: [-20, 30, -10, -20], 
          y: [0, 30, -20, 0],
          scale: [1, 0.9, 1.05, 1],
        }}
        transition={{ duration: 25, repeat: Infinity, ease: "easeInOut", delay: 3 }}
        className="absolute top-[30%] left-[30%] w-[500px] h-[500px] rounded-full opacity-20"
        style={{ background: "radial-gradient(circle, rgba(139,92,246,0.18) 0%, rgba(139,92,246,0.05) 40%, transparent 70%)" }}
      />
      {/* Bottom-left lavender orb */}
      <motion.div
        animate={{ 
          x: [0, -40, 20, 0], 
          y: [0, 30, -30, 0],
          scale: [1, 1.08, 0.92, 1],
        }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut", delay: 7 }}
        className="absolute -bottom-[100px] -left-[150px] w-[500px] h-[500px] rounded-full opacity-25"
        style={{ background: "radial-gradient(circle, rgba(196,181,253,0.15) 0%, rgba(139,92,246,0.05) 40%, transparent 70%)" }}
      />
      {/* Mid-right accent orb */}
      <motion.div
        animate={{ 
          x: [10, -20, 30, 10], 
          y: [-15, 25, -10, -15],
          scale: [0.95, 1.05, 1, 0.95],
        }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut", delay: 5 }}
        className="absolute top-[60%] right-[5%] w-[400px] h-[400px] rounded-full opacity-15"
        style={{ background: "radial-gradient(circle, rgba(61,220,255,0.12) 0%, rgba(139,92,246,0.06) 40%, transparent 70%)" }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────
   Constellation Divider (decorative section separator)
   ──────────────────────────────────────────── */
function ConstellationDivider({ flip = false }) {
  // Seeded rather than Math.random(): the divider is decorative, but calling an
  // impure function during render makes the output flicker on every re-render.
  const seeded = (n) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };

  const dots = Array.from({ length: 12 }, (_, i) => ({
    x: 5 + (i * 90 / 11),
    size: seeded(i) > 0.7 ? 3 : 1.5,
    isBright: seeded(i + 100) > 0.6,
    connects: seeded(i + 200) > 0.3,
  }));

  return (
    <div className={`w-full max-w-4xl mx-auto py-8 relative z-20 ${flip ? "rotate-180" : ""}`}>
      <svg width="100%" height="40" viewBox="0 0 100 40" preserveAspectRatio="none" className="overflow-visible">
        {/* Main gradient line */}
        <line x1="5" y1="20" x2="95" y2="20" stroke="url(#divGrad)" strokeWidth="0.3" opacity="0.4" />
        {/* Constellation dots along the line */}
        {dots.map((d, i) => (
          <g key={i}>
            <circle cx={d.x} cy={20} r={d.size * 0.4} fill={d.isBright ? "#3DDCFF" : "#8B5CF6"} opacity={d.isBright ? 0.6 : 0.3}>
              <animate attributeName="opacity" values={d.isBright ? "0.3;0.8;0.3" : "0.2;0.4;0.2"} dur={`${3 + i * 0.5}s`} repeatCount="indefinite" />
            </circle>
            {d.isBright && (
              <circle cx={d.x} cy={20} r={d.size * 1.5} fill={d.isBright ? "#3DDCFF" : "#8B5CF6"} opacity="0.08">
                <animate attributeName="r" values={`${d.size};${d.size * 2.5};${d.size}`} dur={`${4 + i * 0.3}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.08;0.2;0.08" dur={`${4 + i * 0.3}s`} repeatCount="indefinite" />
              </circle>
            )}
            {/* Connection lines between some dots */}
            {i < dots.length - 1 && d.connects && (
              <line 
                x1={d.x} y1={20} 
                x2={dots[i + 1].x} y2={20} 
                stroke={i % 2 === 0 ? "#8B5CF6" : "#3DDCFF"} 
                strokeWidth="0.2" 
                opacity="0.15" 
              />
            )}
          </g>
        ))}
        <defs>
          <linearGradient id="divGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="30%" stopColor="#8B5CF6" />
            <stop offset="50%" stopColor="#3DDCFF" />
            <stop offset="70%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function SignalRings() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
       {[1, 2, 3].map((i) => (
         <motion.div
           key={i}
           className="absolute rounded-full border border-energy-teal/10"
           initial={{ width: 150, height: 150, opacity: 0 }}
           animate={{ width: 1000, height: 1000, opacity: [0, 0.4, 0] }}
           transition={{ duration: 6, repeat: Infinity, delay: i * 2, ease: "linear" }}
         />
       ))}
    </div>
  );
}

/* ────────────────────────────────────────────
   Navbar
   ──────────────────────────────────────────── */
function Navbar() {
  return (
    <motion.nav 
      initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
      className="fixed top-0 left-0 right-0 z-50 px-6 py-6 pointer-events-none"
    >
       <div className="max-w-7xl mx-auto flex items-center justify-between pointer-events-auto">
          <div className="flex items-center gap-3 group">
             <div className="w-9 h-9 rounded-full glass-blur flex items-center justify-center premium-shadow group-hover:scale-110 transition-transform duration-500">
               <img src="/image.png" alt="Sonix" className="w-6 h-6 object-contain drop-shadow-sm group-hover:scale-110 transition-transform duration-500" />
             </div>
             <span className="text-transparent bg-clip-text bg-gradient-to-r from-energy-teal via-energy-violet to-energy-teal font-extrabold text-[18px] tracking-tight bg-[length:200%_auto] animate-gradient">Sonix</span>
          </div>
          <div className="glass-blur px-8 py-3 rounded-full hidden md:flex items-center gap-10 text-[13px] font-semibold text-graphite-light premium-shadow hover:shadow-lg hover:bg-white/70 transition-all duration-500">
             <a href="#problem" className="relative hover:text-energy-violet transition-colors duration-300 after:absolute after:bottom-[-6px] after:left-0 after:w-0 after:h-[2px] after:bg-energy-violet after:rounded-full hover:after:w-full after:transition-all after:duration-300">Vision</a>
             <a href="#features" className="relative hover:text-energy-violet transition-colors duration-300 after:absolute after:bottom-[-6px] after:left-0 after:w-0 after:h-[2px] after:bg-energy-violet after:rounded-full hover:after:w-full after:transition-all after:duration-300">Architecture</a>
             <a href="#download" className="relative hover:text-energy-teal transition-colors duration-300 after:absolute after:bottom-[-6px] after:left-0 after:w-0 after:h-[2px] after:bg-energy-teal after:rounded-full hover:after:w-full after:transition-all after:duration-300">Download</a>
          </div>
       </div>
    </motion.nav>
  );
}

/* ────────────────────────────────────────────
   Hero Section
   ──────────────────────────────────────────── */
function Hero() {
  const { scrollY } = useScroll();
  const yLogos = useTransform(scrollY, [0, 500], [0, 80]);
  const scaleLogos = useTransform(scrollY, [0, 500], [1, 0.9]);

  return (
    <>
    {/* Screen 1: The Logo Entrance */}
    <section className="relative min-h-[100svh] flex flex-col items-center justify-center px-6 max-w-5xl mx-auto w-full z-20">
      {/* Background Energy Radial Fog */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120vw] h-[120vw] max-w-[1400px] max-h-[1400px] energy-bloom pointer-events-none -z-10 opacity-70" />
      <SignalRings />

      <motion.div 
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        style={{ y: yLogos, scale: scaleLogos }}
        className="relative z-20 flex flex-col items-center justify-center cursor-default shrink-0 mt-32"
      >
         {/* Futuristic Glowing Pulse Logo - High Effort Environment */}
         <div className="relative flex items-center justify-center group">
            {/* Orbital Rings Layer */}
            <motion.div 
               animate={{ rotate: 360 }}
               transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
               className="absolute w-[300px] h-[300px] rounded-full border border-black/[0.03] -z-10 group-hover:border-energy-teal/10 transition-colors duration-700"
            />
            <motion.div 
               animate={{ rotate: -360 }}
               transition={{ duration: 35, repeat: Infinity, ease: "linear" }}
               className="absolute w-[450px] h-[450px] rounded-full border border-black/[0.01] -z-10 group-hover:border-energy-violet/5 transition-colors duration-700"
            />
            
            <div className="absolute w-32 h-32 bg-white rounded-full blur-2xl opacity-60 animate-pulse-slow mix-blend-overlay group-hover:scale-150 transition-transform duration-1000" />
            
            {/* Massive deep radial glow behind the emblem */}
            <div className="absolute w-64 h-64 rounded-full bg-gradient-to-tr from-energy-teal to-energy-violet blur-[50px] opacity-20 animate-pulse-slow group-hover:opacity-50 transition-opacity duration-1000" />
            
            {/* Inner dynamic ring with reactive scaling */}
            <motion.div 
               whileHover={{ scale: 1.4, opacity: 0.8 }}
               className="absolute w-[120px] h-[120px] rounded-full border-[0.5px] border-energy-teal/30 opacity-0 group-hover:opacity-100 transition-all duration-1000" 
            />
            
            <div className="w-32 h-32 sm:w-[160px] sm:h-[160px] rounded-[40px] glass-blur flex items-center justify-center border-white/60 shadow-[0_20px_60px_rgba(0,0,0,0.08)] relative z-10 bg-white/60 group-hover:scale-[1.1] group-hover:shadow-[0_30px_100px_rgba(139,92,246,0.35)] group-hover:border-energy-teal/30 group-hover:-translate-y-4 transition-all duration-1000 ease-[0.16,1,0.3,1] backdrop-blur-3xl overflow-hidden">
               {/* Internal glowing sweep for the advanced finish */}
               <div className="absolute inset-0 bg-gradient-to-tr from-energy-teal/0 via-energy-violet/20 to-energy-teal/0 opacity-0 group-hover:opacity-100 transition-opacity duration-1000 blur-2xl z-0" />
               <img src="/image.png" alt="Sonix Logo" className="w-24 h-24 sm:w-32 sm:h-32 object-contain mix-blend-multiply drop-shadow-[0_12px_24px_rgba(61,220,255,0.2)] group-hover:scale-105 group-hover:rotate-3 transition-all duration-1000 ease-[0.16,1,0.3,1] relative z-10" />
            </div>
         </div>
         
         {/* Cinematic Premium Product Title directly below the logo */}
         <div className="mt-10 sm:mt-14 relative flex flex-col items-center group cursor-default">
            {/* Ambient deep sweep glow behind the text */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[150%] h-[150%] bg-gradient-to-r from-energy-teal/0 via-energy-violet/20 to-energy-teal/0 blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none" />
            
            <motion.h2 
               initial={{ tracking: "0.1em", opacity: 0 }}
               whileInView={{ tracking: "-0.04em", opacity: 1 }}
               transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
               className="text-7xl sm:text-8xl md:text-[110px] font-display font-black text-graphite-dark group-hover:scale-[1.02] group-hover:drop-shadow-[0_10px_40px_rgba(139,92,246,0.3)] transition-all duration-1000 leading-none text-center mix-blend-multiply"
            >
               Sonix <span className="text-transparent bg-clip-text bg-gradient-to-r from-energy-teal via-energy-violet to-energy-teal animate-gradient bg-[length:300%_auto]">Voice</span>
            </motion.h2>
            
            <div className="mt-3 sm:mt-5 text-sm sm:text-lg font-bold tracking-[0.3em] sm:tracking-[0.4em] text-graphite-light/70 uppercase relative px-4">
               <span className="group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-energy-violet group-hover:to-energy-teal transition-all duration-700">
                 Assistant
               </span>
               {/* Growing underline on hover */}
               <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-0 h-[2px] bg-gradient-to-r from-transparent via-energy-teal to-transparent group-hover:w-[150%] transition-all duration-1000 opacity-50" />
            </div>
         </div>
      </motion.div>
      
      {/* Scroll Indicator */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2, duration: 1.5 }}
        className="absolute bottom-12 left-1/2 -translate-x-1/2 w-[1px] h-16 bg-gradient-to-b from-energy-violet to-transparent opacity-60 hidden sm:block"
      />
    </section>

    {/* Screen 2: The Pitch */}
    <section className="relative min-h-[70svh] flex flex-col items-center justify-center pt-20 pb-32 px-6 max-w-5xl mx-auto w-full z-20">
      <motion.div 
        initial={{ opacity: 0, y: 50, filter: "blur(10px)" }}
        whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        className="text-center relative z-20 flex flex-col items-center max-w-3xl mx-auto"
      >
         <motion.div
           initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }}
           className="inline-flex items-center gap-2 px-5 py-1.5 rounded-full glass-blur border-energy-teal/20 text-xs font-bold text-energy-teal tracking-wide shadow-sm mb-6 cursor-default hover:border-energy-teal/40 hover:bg-white/80 transition-all duration-300 uppercase"
         >
           <Sparkles size={14} className="text-energy-teal" /> AI-POWERED WORKFLOW
         </motion.div>
         <motion.h1 
           initial={{ letterSpacing: "0.08em", opacity: 0, y: 30 }}
           whileInView={{ letterSpacing: "-0.05em", opacity: 1, y: 0 }}
           transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
           className="text-6xl sm:text-7xl md:text-[96px] font-black leading-[0.95] text-graphite-dark mb-8 cursor-default group"
         >
            Your voice is the <br className="hidden sm:block"/>
            <span className="text-gradient hover:brightness-125 transition-all duration-500 block sm:inline mt-2 sm:mt-0">ultimate shortcut.</span>
         </motion.h1>
         
         <p className="text-xl sm:text-2xl text-graphite-light max-w-2xl leading-relaxed mb-10 font-medium cursor-default hover:text-graphite-dark hover:tracking-[0.01em] transition-all duration-500">
            Control apps, reminders, and tasks instantly using natural speech. A futuristic companion that just works.
         </p>
         
         <div className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full px-4">
            <a 
              href="https://github.com/Pranesh-I/voice-workflow-assistant/releases/download/v1.0/Nova_0.1.0_x64-setup.exe"
              download
              onClick={handleDownloadClick}
              className="btn-primary group relative overflow-hidden py-3 px-8 text-[15px]"
            >
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-500 rounded-[inherit]" />
              <Download size={18} className="relative z-10 group-hover:-translate-y-0.5 group-hover:scale-110 transition-transform duration-300" /> 
              <span className="relative z-10 group-hover:text-energy-teal transition-colors duration-300">Download for Windows</span>
            </a>
            <a href="#how-it-works" className="group text-graphite font-semibold text-[15px] flex items-center gap-2 transition-all duration-300 hover:text-energy-violet bg-white/40 hover:bg-white/60 border border-white/50 hover:border-energy-violet/30 px-6 py-3 rounded-full shadow-sm hover:shadow-lg backdrop-blur-md">
              Watch how it works <Play size={16} className="ml-1 opacity-70 group-hover:translate-x-1 group-hover:opacity-100 group-hover:text-energy-teal transition-all duration-300"/>
            </a>
         </div>
      </motion.div>
    </section>
    </>
  );
}

/* ────────────────────────────────────────────
   Section 2 — Problem Experience Layer
   ──────────────────────────────────────────── */
function ProblemSection() {
  const statements = [
    "Switching apps breaks focus.",
    "Typing interrupts thinking.",
    "Reminders get forgotten."
  ];

  return (
    <section id="problem" className="py-20 px-6 max-w-4xl mx-auto relative w-full flex flex-col items-center z-20">
       <div className="absolute inset-0 bg-gradient-to-b from-transparent via-mist-fog/80 to-transparent -z-10 blur-3xl rounded-full opacity-60 pointer-events-none" />
       
       <div className="absolute -left-[50%] top-1/4 -z-10 text-[180px] font-bold text-black/[0.015] pointer-events-none whitespace-nowrap hidden lg:block tracking-tighter">
         VOICE AUTOMATION
       </div>

       <div className="flex flex-col gap-10 sm:gap-14 w-full">
         {statements.map((stmt, i) => (
           <motion.div 
             key={i}
             initial={{ opacity: 0, filter: "blur(20px)", y: 60, x: i % 2 === 0 ? -80 : 80, rotateY: i % 2 === 0 ? -20 : 20 }}
             whileInView={{ opacity: 1, filter: "blur(0px)", y: 0, x: 0, rotateY: 0 }}
             viewport={{ once: true, margin: "-100px" }}
             transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
             className={`cursor-default hover:scale-[1.02] hover:-translate-y-1 transition-all duration-500 text-3xl sm:text-4xl lg:text-[56px] font-semibold tracking-[-0.04em] text-graphite-dark/90 ${i === 1 ? 'text-center sm:text-right text-transparent bg-clip-text bg-gradient-to-r from-energy-violet to-energy-teal' : 'text-center sm:text-left hover:text-graphite-dark/100'}`}
           >
             {stmt}
           </motion.div>
         ))}
       </div>
    </section>
  );
}

/* ────────────────────────────────────────────
   Section 3 — Assistant Activation Layer
   ──────────────────────────────────────────── */
function ActivationLayer() {
  const commands = [
    "“Open YouTube”",
    "“Remind me at 6 PM”",
    "“Start focus mode”",
    "“Launch VS Code”"
  ];

  return (
    <section id="how-it-works" className="py-24 px-6 max-w-5xl mx-auto w-full relative z-20">
       <div className="text-center mb-20 relative">
         <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-32 bg-energy-teal/5 blur-[60px] -z-10" />
         <motion.h2 
           initial={{ opacity: 0, filter: "blur(12px)", y: 20 }} 
           whileInView={{ opacity: 1, filter: "blur(0px)", y: 0 }} 
           viewport={{ once: true }} 
           transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }} 
           className="text-4xl sm:text-[48px] font-bold tracking-[-0.03em] text-graphite-dark cursor-default hover:scale-[1.02] hover:-translate-y-1 transition-all duration-500"
         >
           The calm <span className="text-gradient hover:brightness-125 transition-all duration-500">invisible helper.</span>
         </motion.h2>
       </div>
       
       <div className="flex flex-col gap-5 items-center relative">
         {/* Glowing cursor pulse indicator */}
         <div className="absolute left-1/2 -translate-x-1/2 -top-10 w-1.5 h-8 rounded-full bg-energy-teal shadow-[0_0_20px_#00d2ff] animate-pulse" />
         <div className="absolute left-1/2 -translate-x-1/2 top-[-16px] bottom-0 w-[1px] bg-gradient-to-b from-energy-teal via-energy-violet/30 to-transparent -z-10 opacity-60" />

         {commands.map((cmd, i) => (
            <motion.div 
               key={i}
               initial={{ opacity: 0, scale: 0.8, y: 40, rotateX: -60, filter: "blur(10px)" }}
               whileInView={{ opacity: 1, scale: 1, y: 0, rotateX: 0, filter: "blur(0px)" }}
               whileHover={{ scale: 1.05, rotateX: 5, rotateY: 2, y: -5 }}
               viewport={{ once: true, margin: "-100px" }}
               transition={{ duration: 1, delay: i * 0.12, ease: [0.16, 1, 0.3, 1] }}
               className="relative overflow-hidden glass-blur bg-white/70 px-8 sm:px-10 py-6 rounded-3xl w-full max-w-lg flex items-center justify-between group glow-hover premium-shadow cursor-default perspective-1000"
            >
               {/* Hover sweeper line */}
               <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-energy-teal to-energy-violet opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
               <div className="absolute inset-0 bg-gradient-to-r from-energy-teal/5 to-transparent opacity-0 group-hover:opacity-100 -translate-x-full group-hover:translate-x-0 transition-all duration-700 ease-out z-0" />

               <span className="text-lg sm:text-2xl font-semibold text-graphite-dark tracking-tight relative z-10 group-hover:text-energy-violet transition-colors duration-300">{cmd}</span>
               
               <div className="w-10 h-10 flex items-center justify-center rounded-full bg-mist-bg opacity-0 group-hover:opacity-100 transition-all duration-500 shadow-sm border border-energy-teal/20 group-hover:scale-110 group-hover:-translate-y-1 relative z-10 bg-white">
                 <ArrowRight size={18} className="text-energy-teal" />
               </div>
            </motion.div>
         ))}
       </div>
    </section>
  );
}

/* ────────────────────────────────────────────
   Section 4 — Feature Flow Strip
   ──────────────────────────────────────────── */
function FeatureFlow() {
  const features = [
    { title: "Voice Recognition", desc: "Whisper or speak naturally. Intelligent intent mapping parses complex linguistic structures.", icon: Mic },
    { title: "Smart Reminders", desc: "Temporal context is automatically scheduled without lifting a finger.", icon: BellRing },
    { title: "Instant Automation", desc: "Complex multi-application workflows triggered seamlessly from a single sentence.", icon: Activity },
    { title: "Your Voice is the Shortcut", desc: "Forget hotkeys and menus. Summon actions instantly without ever touching your keyboard.", icon: Command },
  ];

  return (
    <section id="features" className="py-24 px-6 w-full relative z-20 overflow-hidden">
      <div className="absolute right-[-10%] top-1/4 -z-10 text-[180px] font-bold text-black/[0.015] pointer-events-none whitespace-nowrap hidden lg:block tracking-tighter mix-blend-multiply">
         CORE LOGIC
      </div>

      <div className="max-w-7xl mx-auto relative pt-10">
         <div className="absolute top-[30px] left-[10%] right-[10%] h-[1px] bg-gradient-to-r from-transparent via-energy-violet/20 to-transparent hidden md:block" />

         <div className="flex flex-col md:flex-row items-start justify-between gap-8 sm:gap-12 relative">
            {features.map((f, i) => (
              <motion.div 
                key={i}
                initial={{ opacity: 0, scale: 0.6, rotateZ: i % 2 === 0 ? -5 : 5 }}
                whileInView={{ opacity: 1, scale: 1, rotateZ: 0 }}
                viewport={{ once: true, margin: "-120px" }}
                transition={{ 
                  duration: 1.2, 
                  delay: i * 0.1, 
                  type: "spring",
                  bounce: 0.4
                }}
                className="flex flex-col items-center md:items-start text-center md:text-left flex-1 group cursor-default"
              >
                 <div className="w-20 h-20 rounded-[28px] glass-blur bg-white/80 flex items-center justify-center border-white mb-8 relative group-hover:scale-110 group-hover:-translate-y-2 group-hover:shadow-[0_24px_48px_-12px_rgba(139,92,246,0.3)] transition-all duration-500">
                    <div className="absolute inset-0 rounded-[28px] bg-gradient-to-br from-energy-teal/20 to-energy-violet/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
                    <f.icon size={28} className="text-energy-violet relative z-10 group-hover:text-energy-teal transition-colors duration-500" />
                 </div>
                 <h3 className="text-2xl font-bold text-graphite-dark tracking-tight mb-3 group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-energy-teal group-hover:to-energy-violet transition-colors duration-500">{f.title}</h3>
                 <p className="text-graphite-light text-base leading-relaxed font-medium group-hover:text-graphite-dark transition-colors duration-300">{f.desc}</p>
              </motion.div>
            ))}
         </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────
   Section 5 — Lightweight Desktop Performance
   ──────────────────────────────────────────── */


/* ────────────────────────────────────────────
   Section 6 — Download Experience Panel
   ──────────────────────────────────────────── */
function DownloadPanel() {
  return (
    <section id="download" className="py-24 px-6 max-w-4xl mx-auto w-full relative z-20">
       <motion.div 
         initial={{ opacity: 0, scale: 1.2, filter: "blur(30px)" }}
         whileInView={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
         viewport={{ once: true }}
         transition={{ 
           duration: 1.5, 
           ease: [0.16, 1, 0.3, 1]
         }}
         className="p-12 sm:p-20 rounded-[48px] premium-shadow text-center relative overflow-hidden group bg-white/60 backdrop-blur-3xl border border-white hover:shadow-[0_40px_100px_-20px_rgba(61,220,255,0.15),0_30px_60px_-15px_rgba(139,92,246,0.1)] hover:border-energy-teal/20 transition-all duration-700"
       >
          <div className="absolute inset-0 bg-gradient-to-tr from-energy-teal/15 via-transparent to-energy-violet/15 opacity-50 group-hover:opacity-100 transition-opacity duration-1000" />
          <div className="absolute -top-20 -right-20 w-60 h-60 bg-energy-teal/10 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
          <div className="absolute -bottom-20 -left-20 w-60 h-60 bg-energy-violet/10 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
          
          <h2 className="text-4xl sm:text-5xl lg:text-[64px] font-bold text-graphite-dark tracking-tight relative z-10 mb-10 leading-[1.05] cursor-default group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-energy-teal group-hover:via-graphite-dark group-hover:to-energy-violet transition-all duration-700">
            Bring intelligence <br/>to your desktop.
          </h2>
          
          <a
            href="https://github.com/Pranesh-I/voice-workflow-assistant/releases/download/v1.0/Nova_0.1.0_x64-setup.exe"
            download
            className="btn-primary inline-flex mx-auto relative z-10 text-lg px-12 py-5 group"
            onClick={handleDownloadClick}
          >
            <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-500 rounded-[inherit]" />
            <Download size={20} className="mr-2 group-hover:-translate-y-1 group-hover:scale-110 transition-transform duration-300 relative z-10"/> 
            <span className="relative z-10">Download Desktop App</span>
          </a>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-6 sm:gap-10 text-[15px] font-semibold text-graphite-light relative z-10">
            <span className="cursor-default hover:text-energy-teal hover:scale-110 hover:-translate-y-0.5 transition-all duration-300 flex items-center gap-2"><Zap size={14} className="text-energy-teal" /> Lightweight</span>
            <span className="w-1 h-1 rounded-full bg-graphite-light/30" />
            <span className="cursor-default hover:text-energy-violet hover:scale-110 hover:-translate-y-0.5 transition-all duration-300 flex items-center gap-2"><Cpu size={14} className="text-energy-violet" /> Fast execution</span>
            <span className="w-1 h-1 rounded-full bg-graphite-light/30" />
            <span className="cursor-default hover:text-energy-teal hover:scale-110 hover:-translate-y-0.5 transition-all duration-300 flex items-center gap-2"><Shield size={14} className="text-energy-teal" /> Runs locally</span>
          </div>
       </motion.div>
    </section>
  );
}

/* ────────────────────────────────────────────
   Footer
   ──────────────────────────────────────────── */
function Footer() {
  return (
    <footer className="py-12 px-6 border-t border-black/[0.03] flex flex-col md:flex-row items-center justify-between gap-6 max-w-7xl mx-auto w-full text-sm font-medium text-graphite-light relative z-20">
       <div className="flex items-center gap-3 group cursor-default">
         <img src="/image.png" alt="Sonix Logo" className="w-5 h-5 object-contain group-hover:scale-125 group-hover:rotate-12 transition-all duration-500" />
         <span className="tracking-wide text-[16px] font-bold text-transparent bg-clip-text bg-gradient-to-r from-energy-teal to-energy-violet group-hover:from-energy-violet group-hover:to-energy-teal transition-all duration-700">Sonix Virtual Assistant</span>
       </div>
       <div className="flex items-center gap-8">
         <a href="https://github.com/Pranesh-I/voice-workflow-assistant" target="_blank" rel="noopener noreferrer" className="relative hover:text-energy-violet transition-colors duration-300 after:absolute after:bottom-[-4px] after:left-0 after:w-0 after:h-[2px] after:bg-energy-violet after:rounded-full hover:after:w-full after:transition-all after:duration-300 hover:scale-105">
            GitHub
         </a>
         <span className="opacity-60 cursor-default hover:opacity-100 hover:text-energy-teal transition-all duration-300">Crafted by Presadors</span>
       </div>
    </footer>
  );
}

/* ────────────────────────────────────────────
   Dynamic Mouse Light (High Effort)
   ──────────────────────────────────────────── */
function MouseFollower() {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springConfig = { damping: 40, stiffness: 200 };
  const springX = useSpring(mouseX, springConfig);
  const springY = useSpring(mouseY, springConfig);

  useEffect(() => {
    const handleMouseMove = (e) => {
      mouseX.set(e.clientX);
      mouseY.set(e.clientY);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [mouseX, mouseY]);

  return (
    <motion.div
      style={{
        x: springX,
        y: springY,
        translateX: "-50%",
        translateY: "-50%",
      }}
      className="fixed top-0 left-0 w-[600px] h-[600px] bg-gradient-to-r from-energy-teal/10 to-energy-violet/10 rounded-full blur-[120px] pointer-events-none z-0 opacity-40 mix-blend-soft-light"
    />
  );
}

/* ────────────────────────────────────────────
   Main Application
   ──────────────────────────────────────────── */
export default function App() {
  return (
    <div className="relative min-h-screen selection:bg-energy-teal/20 selection:text-graphite-dark overflow-x-hidden">
       {/* Global Light Layer Elements */}
       <div className="noise-overlay" />
       
       {/* Layer -1: Animated particle background (deepest) */}
       <ParticleBackground />
       
       {/* Layer 0: Grid mesh */}
       <GridMesh />
       
       {/* Layer 0: Ambient gradient orbs */}
       <GradientOrbs />
       
       {/* Global High Effort Mouse Bloom */}
       <MouseFollower />
       
       {/* Layer 1: Plexus Constellation Network */}
       <PlexusNetwork />
       
       {/* Layer 2: Floating geometric shapes */}
       <FloatingGeometrics />
       
       <Navbar />
       <main className="relative z-10 flex flex-col items-center">
         <Hero />
         <ConstellationDivider />
         <ProblemSection />
         <ActivationLayer />
         <FeatureFlow />
         <ConstellationDivider flip />
         <DownloadPanel />
       </main>
       <Footer />
    </div>
  );
}
