import type { ReactNode, SVGProps } from "react";

/**
 * Inline SVG icon set. Every icon inherits its size (1em) and colour
 * (currentColor) from the surrounding text, so each one drops into the exact
 * spot its old unicode glyph occupied. All paths are drawn locally — no icon
 * font, no CDN, nothing fetched at runtime.
 */

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  children?: ReactNode;
};

export function IconSound({ muted = false, ...props }: IconProps & { muted?: boolean }) {
  return <Base {...props}><path d="M11 5 6 9H3v6h3l5 4Z" />{muted ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8" /><path d="M18 5a10 10 0 0 1 0 14" /></>}</Base>;
}

function Base({ size = "1em", className, children, ...rest }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="15 18 9 12 15 6" />
    </Base>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="9 18 15 12 9 6" />
    </Base>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Base>
  );
}

export function IconChevronUp(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="18 15 12 9 6 15" />
    </Base>
  );
}

export function IconPlus(props: IconProps) {
  return <Base {...props}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Base>;
}

export function IconMinus(props: IconProps) {
  return <Base {...props}><line x1="5" y1="12" x2="19" y2="12" /></Base>;
}

export function IconMenu(props: IconProps) {
  return <Base {...props}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></Base>;
}

export function IconDot(props: IconProps) {
  return <Base {...props}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></Base>;
}

export function IconFile(props: IconProps) {
  return <Base {...props}><path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M8 13h8M8 17h6" /></Base>;
}

export function IconLink(props: IconProps) {
  return <Base {...props}><path d="m10 13.5 4-4" /><path d="M7.5 17.5H6a4 4 0 0 1 0-8h3" /><path d="M16.5 6.5H18a4 4 0 0 1 0 8h-3" /></Base>;
}

export function IconUnlink(props: IconProps) {
  return <Base {...props}><path d="m9 15 6-6" /><path d="M7.5 17.5H6a4 4 0 0 1-2.4-7.2M16.5 6.5H18a4 4 0 0 1 2.4 7.2" /><path d="M8 8h2M14 16h2" /></Base>;
}

export function IconSync(props: IconProps) {
  return <Base {...props}><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18.5 7L20 8.5M4 15.5 5.5 17A7 7 0 0 0 17.9 15" /></Base>;
}

export function IconSkipBack(props: IconProps) {
  return <Base {...props}><line x1="6" y1="5" x2="6" y2="19" /><path d="m18 6-7 6 7 6Z" /></Base>;
}

export function IconSkipForward(props: IconProps) {
  return <Base {...props}><line x1="18" y1="5" x2="18" y2="19" /><path d="m6 6 7 6-7 6Z" /></Base>;
}

export function IconClose(props: IconProps) {
  return (
    <Base {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Base>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Base>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Base>
  );
}

export function IconRotate(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Base>
  );
}

export function IconExpand(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </Base>
  );
}

export function IconCompress(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
    </Base>
  );
}

export function IconFolder(props: IconProps) {
  return <Base {...props}><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" /></Base>;
}

export function IconSearch(props: IconProps) {
  return <Base {...props}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></Base>;
}

export function IconSliders(props: IconProps) {
  return <Base {...props}><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="18" r="2" /></Base>;
}

export function IconTarget(props: IconProps) {
  return <Base {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></Base>;
}

export function IconEye(props: IconProps) {
  return <Base {...props}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></Base>;
}

export function IconEyeOff(props: IconProps) {
  return <Base {...props}><path d="m3 3 18 18" /><path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17.5 17.5 0 0 1-3.1 3.8M6.2 6.8C3.8 8.5 2.5 12 2.5 12s3.5 6 9.5 6a9.7 9.7 0 0 0 3-.5" /></Base>;
}

export function IconLock(props: IconProps) {
  return <Base {...props}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Base>;
}

export function IconUnlock(props: IconProps) {
  return <Base {...props}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7-2.6" /></Base>;
}

export function IconHand(props: IconProps) {
  return <Base {...props}><path d="M7 11V6a1.5 1.5 0 0 1 3 0v4V4.5a1.5 1.5 0 0 1 3 0V10V5.5a1.5 1.5 0 0 1 3 0V11V8a1.5 1.5 0 0 1 3 0v6.5A5.5 5.5 0 0 1 13.5 20H12a5 5 0 0 1-4.1-2.15L5 13.5a1.5 1.5 0 0 1 2-2.25Z" /></Base>;
}

export function IconMessage(props: IconProps) {
  return <Base {...props}><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4.5 3V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="M8 10h.01M12 10h.01M16 10h.01" /></Base>;
}

export function IconUsers(props: IconProps) {
  return <Base {...props}><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.9M16.5 13a4.5 4.5 0 0 1 4 4" /></Base>;
}

export function IconAlert(props: IconProps) {
  return <Base {...props}><path d="m12 3 9 16H3Z" /><path d="M12 9v4M12 17h.01" /></Base>;
}

function Solid({
  size = "1em",
  className,
  points,
  ...rest
}: IconProps & { points: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <polygon points={points} />
    </svg>
  );
}

/** Play-triangle used for the lobby tiles. */
export function IconPlay(props: IconProps) {
  return <Solid points="7 4 20 12 7 20" {...props} />;
}

export function IconPause(props: IconProps) {
  return <Base {...props}><line x1="8" y1="5" x2="8" y2="19" /><line x1="16" y1="5" x2="16" y2="19" /></Base>;
}

/** Five-point rarity star. Colour comes from the surrounding text. */
export function IconStar(props: IconProps) {
  return (
    <Solid
      points="12 2.6 14.9 8.7 21.7 9.5 16.7 14.2 18.1 21 12 17.6 5.9 21 7.3 14.2 2.3 9.5 9.1 8.7"
      {...props}
    />
  );
}

/** A row of N rarity stars. */
export function Stars({ n, className }: { n: number; className?: string }) {
  return (
    <span className={className ? `stars ${className}` : "stars"} aria-hidden="true">
      {Array.from({ length: Math.max(0, n) }, (_, i) => (
        <IconStar key={i} />
      ))}
    </span>
  );
}

/**
 * The lobby's decorative △ × + ○ strip as real shapes rather than a text
 * run. Pure decoration (the parent is aria-hidden).
 */
export function DecoShapes() {
  return (
    <span className="deco-shapes" aria-hidden="true">
      <Base size="0.9em">
        <polygon points="12 5 20 19 4 19" />
      </Base>
      <Base size="0.9em">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </Base>
      <Base size="0.9em">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </Base>
      <Base size="0.9em">
        <circle cx="12" cy="12" r="8" />
      </Base>
    </span>
  );
}
