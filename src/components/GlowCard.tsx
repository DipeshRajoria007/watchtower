import { useRef, useState, type ReactNode } from 'react';

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  glowColor?: string;
}

/**
 * A card with mouse-tracking border glow effect.
 */
export function GlowCard({ children, className = '', glowColor = 'rgba(94,234,212,0.12)' }: GlowCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [glowPos, setGlowPos] = useState({ x: 0, y: 0 });
  const [hovering, setHovering] = useState(false);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setGlowPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={className}
      style={{
        position: 'relative',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'linear-gradient(145deg, #0F0F11 0%, #0D0D0F 50%, #0B0B0D 100%)',
        border: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Mouse-tracking glow */}
      <div
        style={{
          position: 'absolute',
          pointerEvents: 'none',
          left: glowPos.x - 150,
          top: glowPos.y - 150,
          width: 300,
          height: 300,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${glowColor}, transparent 70%)`,
          opacity: hovering ? 0.6 : 0,
          transition: 'opacity 0.3s ease',
        }}
      />

      {/* Top shimmer line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 16,
          right: 16,
          height: 1,
          pointerEvents: 'none',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.04) 50%, transparent)',
        }}
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 10 }}>{children}</div>
    </div>
  );
}
