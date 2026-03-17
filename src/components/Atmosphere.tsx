import { useEffect, useRef, useState } from 'react';

/**
 * Noise grain overlay — uses a tiny canvas to generate film-grain texture
 */
export function NoiseOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = 256;
    canvas.height = 256;

    const imageData = ctx.createImageData(256, 256);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 12;
    }
    ctx.putImageData(imageData, 0, 0);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 50,
        opacity: 0.4,
        mixBlendMode: 'overlay',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/**
 * Scanline overlay — faint horizontal lines for CRT/control-room feel
 */
export function Scanlines() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: `repeating-linear-gradient(
          0deg,
          transparent,
          transparent 2px,
          rgba(255,255,255,0.008) 2px,
          rgba(255,255,255,0.008) 4px
        )`,
        opacity: 0.6,
      }}
    />
  );
}

/**
 * Ambient floating glow orbs with breathing animation
 */
export function AmbientOrbs() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* Primary teal orb — top right */}
      <div
        style={{
          position: 'absolute',
          top: -20,
          right: -20,
          width: 500,
          height: 500,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(94,234,212,0.035) 0%, transparent 70%)',
          animation: 'orbBreathe 8s ease-in-out infinite',
        }}
      />
      {/* Secondary warm orb — bottom left */}
      <div
        style={{
          position: 'absolute',
          bottom: -128,
          left: -128,
          width: 400,
          height: 400,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(212,149,107,0.025) 0%, transparent 70%)',
          animation: 'orbBreathe 12s ease-in-out infinite reverse',
        }}
      />
      {/* Tiny accent spark — center */}
      <div
        style={{
          position: 'absolute',
          top: '33%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(94,234,212,0.02) 0%, transparent 60%)',
          animation: 'orbDrift 16s ease-in-out infinite',
        }}
      />
    </div>
  );
}

/**
 * Vignette — darkened edges for focus
 */
export function Vignette() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: 'radial-gradient(ellipse 75% 65% at 50% 50%, transparent 50%, rgba(0,0,0,0.4) 100%)',
      }}
    />
  );
}

/**
 * Mouse-following glow that attaches to the main content area
 */
export function MouseGlow() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;

    const handleMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      setVisible(true);
    };
    const handleLeave = () => setVisible(false);

    el.addEventListener('mousemove', handleMove);
    el.addEventListener('mouseleave', handleLeave);
    return () => {
      el.removeEventListener('mousemove', handleMove);
      el.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          left: pos.x - 300,
          top: pos.y - 300,
          background: 'radial-gradient(circle, rgba(94,234,212,0.03) 0%, transparent 60%)',
          opacity: visible ? 1 : 0,
          transition: 'left 0.8s ease-out, top 0.8s ease-out, opacity 0.7s ease',
        }}
      />
    </div>
  );
}

/**
 * Injects the keyframe animations into the document
 */
export function AtmosphereStyles() {
  return (
    <style>{`
      @keyframes orbBreathe {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.15); opacity: 0.6; }
      }
      @keyframes orbDrift {
        0%, 100% { transform: translate(-50%, 0); }
        33% { transform: translate(-40%, 15px); }
        66% { transform: translate(-60%, -10px); }
      }
      @keyframes pulseGlow {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      @keyframes shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
    `}</style>
  );
}
